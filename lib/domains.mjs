// בדיקת חיבור דומיין מותאם. שתי בדיקות אמיתיות, ללא סימולציה:
//  1. בעלות: רשומת TXT ב-_bsverify.<host> עם הערך bs-verify=<token> (רק מי ששולט ב-DNS של הדומיין יכול להוסיף אותה).
//  2. ניתוב: בקשת HTTPS אל https://<host>/api/public/domain-ping מחזירה חותמת HMAC שרק האתר שלנו מסוגל להפיק עבור ה-host הזה.
// הבדיקות מוזרקות (resolver / fetch) כדי שאפשר לבדוק את הלוגיקה בלי רשת; מול DNS ו-TLS אמיתיים הן לא נבדקו בסביבת הפיתוח.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';

export const pingMark = (pepper, host) => createHmac('sha256', pepper).update('domping:' + host).digest('hex').slice(0, 32);
export const normalizeHost = (h) => String(h || '').toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');

// כתובות שאסור לפנות אליהן מהשרת (מניעת SSRF אל רשת פנימית / metadata)
export function isPublicIp(ip) {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;     // CGNAT
    if (a === 169 && b === 254) return false;               // link-local / metadata
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && (b === 168 || (b === 0 && ip.split('.')[2] === '0'))) return false;
    if (a === 198 && (b === 18 || b === 19)) return false;
    return true;
  }
  if (v === 6) {
    const x = ip.toLowerCase();
    if (x === '::' || x === '::1') return false;
    if (x.startsWith('fe8') || x.startsWith('fe9') || x.startsWith('fea') || x.startsWith('feb')) return false;   // link-local
    if (x.startsWith('fc') || x.startsWith('fd')) return false;                                                     // unique local
    const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(x); if (m) return isPublicIp(m[1]);
    return true;
  }
  return false;
}

const dnsCode = (e) => (e && (e.code === 'ENOTFOUND' || e.code === 'ENODATA' || e.code === 'NXDOMAIN') ? 'missing' : 'error');

export async function checkDomain({ hostname, token, pepper, resolver, fetchImpl = fetch, timeoutMs = 6000 }) {
  // 1. בעלות
  let txt;
  try { txt = (await resolver.resolveTxt('_bsverify.' + hostname)).map((parts) => parts.join('')); }
  catch (e) { return { txt_ok: false, routed: false, error: dnsCode(e) === 'missing' ? 'txt_missing' : 'dns_error' }; }
  const want = Buffer.from('bs-verify=' + token);
  const txtOk = txt.some((v) => { const b = Buffer.from(v.trim()); return b.length === want.length && timingSafeEqual(b, want); });
  if (!txtOk) return { txt_ok: false, routed: false, error: txt.length ? 'txt_mismatch' : 'txt_missing' };

  // 2. ניתוב. לא פונים לכתובות פנימיות; אין מעקב אחרי הפניות; התוכן לא מוחזר למשתמש, רק תוצאה בוליאנית.
  let addrs = [];
  try { addrs = [...(await resolver.resolve4(hostname).catch(() => [])), ...(await resolver.resolve6(hostname).catch(() => []))]; } catch { addrs = []; }
  if (!addrs.length) return { txt_ok: true, routed: false, error: 'not_routed' };
  if (addrs.some((a) => !isPublicIp(a))) return { txt_ok: true, routed: false, error: 'private_address' };
  try {
    const res = await fetchImpl(`https://${hostname}/api/public/domain-ping?h=${encodeURIComponent(hostname)}`, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs), headers: { Accept: 'application/json' } });
    if (res.status !== 200) return { txt_ok: true, routed: false, error: 'not_routed' };
    const j = await res.json().catch(() => null);
    const ok = j && j.ok === true && typeof j.mark === 'string' && j.mark.length === 32 && timingSafeEqual(Buffer.from(j.mark), Buffer.from(pingMark(pepper, hostname)));
    return { txt_ok: true, routed: !!ok, error: ok ? null : 'not_routed' };
  } catch (e) {
    const m = String((e && (e.cause && e.cause.code || e.code || e.name)) || '');
    return { txt_ok: true, routed: false, error: /CERT|TLS|SSL|SELF_SIGNED|UNABLE_TO_VERIFY/i.test(m) ? 'tls_error' : /Timeout|ABORT/i.test(m) ? 'timeout' : 'not_routed' };
  }
}
