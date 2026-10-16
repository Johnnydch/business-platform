#!/usr/bin/env node
// אימות סביבת staging אמיתית (Netlify + Supabase). מריצים רק אחרי שהסביבה הוקמה לפי docs/STAGING_CHECKLIST.md.
// כל הסודות מגיעים ממשתני סביבה במחשב שלכם (לא בצ'אט, לא בקבצים). בדיקות שחסרים להן משתנים מסומנות SKIP ולא PASS.
//   STAGING_URL=https://<site>.netlify.app            חובה
//   SUPABASE_URL, SUPABASE_ANON_KEY                    לבדיקת בידוד ב-JWT ישיר
//   OWNER_A_EMAIL/OWNER_A_PASSWORD, OWNER_B_EMAIL/OWNER_B_PASSWORD  שני בעלי עסקים נפרדים
//   DEMO_SLUG (ברירת מחדל demo-barbershop)             עסק הדגמה להזמנות/מקביליות (נמחק בתחזוקה)
//   SUPER_EMAIL/SUPER_PASSWORD/SUPER_TOTP_SECRET       לבדיקת MFA של Super (אופציונלי)
import { createHmac } from 'node:crypto';
const base = (process.env.STAGING_URL || '').replace(/\/$/, ''); if (!/^https:\/\//.test(base) && process.env.STAGING_ALLOW_HTTP !== '1') { console.error('STAGING_URL חייב להיות כתובת https'); process.exit(2); }
const E = process.env, rows = []; const rec = (area, name, status, note = '') => { rows.push({ area, name, status, note }); console.log(`${status.padEnd(4)} [${area}] ${name}${note ? ' — ' + note : ''}`); };
const check = async (area, name, fn) => { try { const r = await fn(); rec(area, name, r === 'skip' ? 'SKIP' : 'PASS', r === 'skip' ? 'חסרים משתני סביבה' : ''); } catch (e) { rec(area, name, 'FAIL', String(e.message).slice(0, 200)); } };
const ok = (c, m) => { if (!c) throw new Error(m); };
const req = async (path, { method = 'GET', body, cookie, headers = {}, origin = base } = {}) => {
  const r = await fetch(base + path, { method, redirect: 'manual', headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(method !== 'GET' ? { origin } : {}), ...(cookie ? { cookie } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, headers: r.headers, setCookie: r.headers.getSetCookie ? r.headers.getSetCookie() : [] };
};
const jar = (sc) => sc.map((c) => c.split(';')[0]).join('; ');
const totp = (secret, t = Date.now()) => { const a = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; let bits = ''; for (const ch of secret) bits += a.indexOf(ch).toString(2).padStart(5, '0'); const k = Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2))); const c = Buffer.alloc(8); c.writeBigUInt64BE(BigInt(Math.floor(t / 30000))); const h = createHmac('sha1', k).update(c).digest(); const o = h[19] & 15; return String(((h.readUInt32BE(o) & 0x7fffffff) % 1e6)).padStart(6, '0'); };

/* ---- Netlify: כתובות, כותרות, Origin ---- */
await check('netlify', 'GET /api/health = 200 {ok:true}', async () => { const r = await req('/api/health'); ok(r.status === 200 && r.json && r.json.ok === true, 'status ' + r.status); });
await check('netlify', 'כותרות אבטחה בעמוד הבית ובניהול', async () => {
  for (const p of ['/', '/admin']) { const h = (await req(p)).headers; for (const k of ['content-security-policy', 'x-content-type-options', 'x-frame-options', 'referrer-policy', 'strict-transport-security']) ok(h.get(k), `${p} חסרה ${k}`); }
  ok(/script-src 'self'/.test((await req('/')).headers.get('content-security-policy')), 'CSP לא כולל script-src self');
});
await check('netlify', '/admin ו-/m/* ללא מטמון וללא אינדוקס', async () => { for (const p of ['/admin', '/m/x']) { const h = (await req(p)).headers; ok(/no-store/.test(h.get('cache-control') || ''), p + ' cache'); ok(/noindex/.test(h.get('x-robots-tag') || ''), p + ' robots'); } });
await check('netlify', 'נתיבים יפים: /b/<slug>, /l/<slug>, /m/<token> מחזירים 200 (rewrite)', async () => { for (const p of ['/b/' + (E.DEMO_SLUG || 'demo-barbershop'), '/l/demo-home-services', '/m/not-a-token']) { const r = await fetch(base + p); ok(r.status === 200, p + ' → ' + r.status); } });
await check('netlify', 'Origin זר נדחה בכתיבה ציבורית וב-admin', async () => { for (const p of ['/api/public/lead', '/api/admin/login']) { const r = await req(p, { method: 'POST', body: {}, origin: 'https://evil.example' }); ok(r.status === 403, `${p} → ${r.status}`); } });
await check('netlify', 'אתר המותג: 5 תבניות, מחירי טיוטה מסומנים כל עוד לא אושרו', async () => { const r = await req('/api/public/brand'); ok(r.json.templates.length === 5, 'templates ' + r.json.templates.length); });

/* ---- Supabase: כניסה, MFA, רענון, יציאה ---- */
async function login(email, password) { const r = await req('/api/admin/login', { method: 'POST', body: { email, password } }); return r; }
await check('auth', 'כניסת בעלים: עוגיות HttpOnly+Secure+SameSite; /me; רענון בלי bs_at; יציאה מבטלת', async () => {
  if (!E.OWNER_A_EMAIL) return 'skip';
  const r = await login(E.OWNER_A_EMAIL, E.OWNER_A_PASSWORD); ok(r.status === 200, 'login ' + r.status);
  ok(r.setCookie.length >= 2 && r.setCookie.every((c) => /HttpOnly/i.test(c) && /Secure/i.test(c) && /SameSite=(Strict|Lax)/i.test(c)), 'דגלי עוגיה: ' + r.setCookie.map((c) => c.split(';').slice(1).join(';')).join(' | '));
  let cookie = jar(r.setCookie); ok((await req('/api/admin/me', { cookie })).status === 200, 'me');
  const onlyRt = cookie.split('; ').filter((c) => c.startsWith('bs_rt=')).join('; '); const rf = await req('/api/admin/me', { cookie: onlyRt }); ok(rf.status === 200, 'refresh via bs_rt ' + rf.status);
  cookie = jar([...r.setCookie, ...rf.setCookie]); const lo = await req('/api/admin/logout', { method: 'POST', body: {}, cookie }); ok(lo.status === 200, 'logout');
  ok((await req('/api/admin/me', { cookie })).status === 401, 'אחרי יציאה ה-cookie הישן עדיין עובד');
});
await check('auth', 'Super: כניסה מחייבת MFA; בלי קוד אין גישה לנתוני פלטפורמה; קוד נכון נותן גישה', async () => {
  if (!E.SUPER_EMAIL || !E.SUPER_TOTP_SECRET) return 'skip';
  const r = await login(E.SUPER_EMAIL, E.SUPER_PASSWORD); ok(r.status === 200, 'login ' + r.status); let cookie = jar(r.setCookie);
  ok((await req('/api/super/shops', { cookie })).status === 403, 'נתוני פלטפורמה נחשפו לפני MFA');
  const v = await req('/api/admin/mfa/verify', { method: 'POST', body: { code: totp(E.SUPER_TOTP_SECRET) }, cookie }); ok(v.status === 200, 'verify ' + v.status);
  cookie = jar([...r.setCookie, ...v.setCookie]); ok((await req('/api/super/shops', { cookie })).status === 200, 'אין גישה אחרי MFA');
});

/* ---- בידוד בין עסקים, כולל קריאות JWT ישירות ל-Supabase ---- */
async function jwt(email, password) { const r = await fetch(E.SUPABASE_URL + '/auth/v1/token?grant_type=password', { method: 'POST', headers: { apikey: E.SUPABASE_ANON_KEY, 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) }); const j = await r.json(); ok(j.access_token, 'no token'); return j.access_token; }
const rpc = async (name, token, args) => { const r = await fetch(`${E.SUPABASE_URL}/rest/v1/rpc/${name}`, { method: 'POST', headers: { apikey: E.SUPABASE_ANON_KEY, authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify(args) }); return { status: r.status, json: await r.json().catch(() => null) }; };
await check('isolation', 'בעל עסק A לא רואה עסק B: דרך ה-API ובקריאת RPC ישירה עם JWT', async () => {
  if (!(E.OWNER_A_EMAIL && E.OWNER_B_EMAIL && E.SUPABASE_URL && E.SUPABASE_ANON_KEY)) return 'skip';
  const a = await jwt(E.OWNER_A_EMAIL, E.OWNER_A_PASSWORD), b = await jwt(E.OWNER_B_EMAIL, E.OWNER_B_PASSWORD);
  const ma = (await rpc('rpc_owner_shop_get', a, { p_business: null })).json, mb = (await rpc('rpc_owner_shop_get', b, { p_business: null })).json;
  const ida = ma.data.shop.id, idb = mb.data.shop.id; ok(ida !== idb, 'אותו עסק לשני הבעלים');
  const cross = await rpc('rpc_owner_shop_get', a, { p_business: idb }); ok(!(cross.json && cross.json.ok && cross.json.data.shop.id === idb), 'A קרא את B דרך p_business');
  const cust = await rpc('rpc_owner_customers_list', a, { p_business: idb, p: {} }).catch(() => ({ json: null })); ok(!(cust.json && cust.json.ok && (cust.json.data.customers || []).length && cust.json.data.customers.some((c) => c.business_id === idb)), 'דליפת לקוחות');
  for (const t of ['businesses', 'customers', 'appointments', 'leads', 'brand_leads', 'brand_settings', 'business_drafts']) { const r = await fetch(`${E.SUPABASE_URL}/rest/v1/${t}?select=*&limit=1`, { headers: { apikey: E.SUPABASE_ANON_KEY, authorization: 'Bearer ' + a } }); ok(r.status >= 400 || (await r.json()).length === 0, `גישה ישירה לטבלה ${t}`); }
});

/* ---- הזמנה, ביטול, שינוי, מקביליות, הגבלת קצב (על עסק הדגמה) ---- */
const slug = E.DEMO_SLUG || 'demo-barbershop';
let shop, svc, staff, date, slots;
await check('booking', 'הזמנה על עסק הדגמה, קישור אישי, שינוי ביטול', async () => {
  shop = (await req('/api/public/shops/' + slug)).json; ok(shop && shop.services, 'אין עסק הדגמה — הריצו scripts/seed-demos.mjs');
  svc = shop.services[0]; staff = shop.barbers[0];
  const days = (await req(`/api/public/days?slug=${slug}&barber_id=${staff.id}&service_id=${svc.id}`)).json; date = (days.days || days).find((d) => d.available !== false && (d.date || d)).date || days.days[0];
  slots = (await req(`/api/public/slots?slug=${slug}&barber_id=${staff.id}&service_id=${svc.id}&date=${date}`)).json.slots; ok(slots.length >= 3, 'אין מספיק שעות פנויות');
  const key = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
  const b = await req('/api/public/book', { method: 'POST', body: { slug, service_id: svc.id, barber_id: staff.id, date, start_min: slots[0].start_min ?? slots[0], first_name: 'בדיקה', last_name: 'אוטומטית', phone: '0501234567', idempotency_key: key() } }); ok(b.status === 201, 'book ' + b.status + JSON.stringify(b.json));
  const token = b.json.manage_url.split('/m/')[1];
  const g = await req('/api/public/manage/' + token); ok(g.status === 200, 'manage get');
  const rs = await req(`/api/public/manage/${token}/reschedule`, { method: 'POST', body: { barber_id: staff.id, date, start_min: slots[1].start_min ?? slots[1] } }); ok(rs.status === 200, 'reschedule ' + rs.status);
  const cn = await req(`/api/public/manage/${token}/cancel`, { method: 'POST', body: {} }); ok(cn.status === 200, 'cancel ' + cn.status);
});
await check('booking', 'מקביליות: 5 בקשות במקביל לאותה שעה = בדיוק הזמנה אחת', async () => {
  if (!slots) return 'skip'; const st = slots[2].start_min ?? slots[2];
  const k = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
  const rs = await Promise.all([...Array(5)].map((_, i) => req('/api/public/book', { method: 'POST', body: { slug, service_id: svc.id, barber_id: staff.id, date, start_min: st, first_name: ['אבי', 'בני', 'גדי', 'דני', 'הדר'][i], last_name: 'בדיקה', phone: `05012345${60 + i}`, idempotency_key: k() } })));
  const won = rs.filter((r) => r.status === 201); ok(won.length === 1, `${won.length} הזמנות הצליחו: ` + rs.map((r) => r.status).join(','));
  await req(`/api/public/manage/${won[0].json.manage_url.split('/m/')[1]}/cancel`, { method: 'POST', body: {} });
});
await check('booking', 'הגבלת קצב: פניות חוזרות מ-IP אחד מקבלות 429', async () => {
  let got = 0; for (let i = 0; i < 20 && !got; i++) { const r = await req('/api/public/lead', { method: 'POST', body: { slug: 'demo-home-services', name: 'בדיקת קצב', phone: `05299900${String(i).padStart(2, '0')}` } }); if (r.status === 429) got = i + 1; }
  ok(got > 0, 'לא התקבל 429 אחרי 20 בקשות');
});
await check('leads', 'פנייה לעסק מגיעה רק לבעלים הנכון (עסק A), לא ל-B', async () => {
  if (!(E.OWNER_A_EMAIL && E.OWNER_A_LEAD_SLUG)) return 'skip';
  const name = 'ניתוב ' + [...Array(8)].map(() => 'אבגדהוזחטיכלמנסעפצקרשת'[Math.floor(Math.random() * 22)]).join(''); const p = await req('/api/public/lead', { method: 'POST', body: { slug: E.OWNER_A_LEAD_SLUG, name, phone: '0537771234' } }); ok(p.status === 200, 'lead ' + p.status);
  const ca = jar((await login(E.OWNER_A_EMAIL, E.OWNER_A_PASSWORD)).setCookie); const la = (await req('/api/admin/leads', { cookie: ca })).json; ok(JSON.stringify(la).includes(name), 'הפנייה לא הגיעה לבעלים');
  if (E.OWNER_B_EMAIL) { const cb = jar((await login(E.OWNER_B_EMAIL, E.OWNER_B_PASSWORD)).setCookie); ok(!JSON.stringify((await req('/api/admin/leads', { cookie: cb })).json).includes(name), 'הפנייה דלפה לבעלים אחר'); }
});
console.log('\nסיכום:', ['PASS', 'FAIL', 'SKIP'].map((s) => `${s}=${rows.filter((r) => r.status === s).length}`).join(' '));
console.log('חשוב: SKIP אינו הצלחה. בדיקות דפדפן (נייד/RTL ל-5 התבניות) מורצות בנפרד: scripts/e2e-templates.mjs <STAGING_URL> <outDir> (דורש משתמשי בעלים/הדגמה בסביבה).');
process.exit(rows.some((r) => r.status === 'FAIL') ? 1 : 0);
