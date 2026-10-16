// העברת עסק בודד בין שני פרויקטים, עם הקפאת כתיבה ואימות נתונים לפני פתיחה מחדש.
// סדר הפעולות (כל שלב מוצג ב-log):
//  1. הקפאת כתיבה במקור (נאכף ב-DB; קריאה נשארת פתוחה)  2. טביעת אצבע של המקור  3. ייצוא
//  4. ייבוא קפוא ליעד (אטומי: העסק לא מקבל כתיבה)         5. טביעת אצבע של היעד והשוואה (ספירות + hash של תוכן, כולל טוקנים אישיים)
//  6. רק אם זהה ו-release=true: שחרור היעד. המקור נשאר קפוא עד שהצוות משבית/מוחק אותו ידנית.
// לא מועברים: חשבונות Auth, סיסמאות, מפתחות, דומיינים.
export function diffFingerprints(a, b) {
  const out = [];
  for (const sec of ['counts', 'hashes']) for (const k of new Set([...Object.keys(a[sec]), ...Object.keys(b[sec])])) if (a[sec][k] !== b[sec][k]) out.push(`${sec}.${k}: ${a[sec][k]} ≠ ${b[sec][k]}`);
  return out;
}
const must = (env, what) => { if (!env || env.ok === false) throw new Error(`${what}: ${JSON.stringify(env && env.error)}`); return env.data ?? env; };

export async function migrateBusiness({ src, dst, bizId, newSlug = null, release = false, dryRun = false, log = () => {} }) {
  if (dryRun) { const exp = must(await src.service('rpc_admin_export_business', { p_business: bizId }), 'export'); log('dry-run: יוצא בלבד'); return { exported: exp, dryRun: true }; }
  must(await src.service('rpc_admin_set_freeze', { p_business: bizId, p_frozen: true }), 'freeze source'); log('המקור הוקפא לכתיבה');
  const fpSrc = must(await src.service('rpc_admin_business_fingerprint', { p_business: bizId }), 'fingerprint source');
  const exp = must(await src.service('rpc_admin_export_business', { p_business: bizId }), 'export'); log('יוצא');
  // ייצוא אחרי ההקפאה: כל כתיבה שהייתה בדרך כבר נכנסה לפני טביעת האצבע (ההקפאה מתבצעת לפניה)
  const imp = must(await dst.service('rpc_admin_import_business_frozen', { p: exp, p_new_slug: newSlug }), 'import'); log('יובא ליעד (קפוא)');
  const fpDst = must(await dst.service('rpc_admin_business_fingerprint', { p_business: imp.business_id }), 'fingerprint dest');
  const diffs = diffFingerprints(fpSrc, fpDst);
  if (diffs.length) return { ok: false, business_id: imp.business_id, slug: imp.slug, diffs, released: false, sourceFrozen: true };
  if (release) { must(await dst.service('rpc_admin_set_freeze', { p_business: imp.business_id, p_frozen: false }), 'release dest'); log('היעד שוחרר'); }
  return { ok: true, business_id: imp.business_id, slug: imp.slug, diffs: [], released: release, sourceFrozen: true, counts: fpDst.counts };
}
