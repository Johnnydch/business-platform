// בדיקות שכבת ה-API מקצה לקצה: נתב → RPC על Postgres אמיתי. (Auth מדומה; ראו test/support/adapters.mjs)
import test from 'node:test';
import assert from 'node:assert/strict';
import { psql } from './support/pg.mjs';
import { resetDb, WEEK_HOURS } from './support/db.mjs';
import { pgRest, fakeAuth, client, totp } from './support/adapters.mjs';
import { createApi } from '../lib/api.mjs';

const DB = 'platform_api';
const config = { pepper: 'test-pepper-0123456789-0123456789', publicBaseUrl: 'https://app.test', allowedOrigins: ['https://app.test'], cookieSecure: true };
const quiet = { error() {}, log() {} };
let rest, auth, api, anon, su, oa, ob, A, B, stA, stA2, stB, vA, vB, tokenUrl, token;
const ROOT = 'root@example.com', PW = 'SuperSecret-123';

test.before(async () => {
  process.env.TEST_DB = DB; resetDb(DB);
  await psql(`insert into templates (key, name, kind, status, theme, labels, default_services, sort) values ('future-template', 'בקרוב', 'booking', 'planned', 'default', '{}', '[]', 99)`, { db: DB });  // תבנית שטרם מומשה: חייבת להידחות ביצירת עסק
  rest = pgRest({ db: DB }); auth = fakeAuth({ db: DB });
  api = createApi({ rest, auth, config, log: quiet });
  const uRoot = await auth.addUser(ROOT, PW);
  await psql(`insert into platform_users (user_id, role) values ('${uRoot}', 'super_admin')`, { db: DB });
  anon = client(api); su = client(api); oa = client(api); ob = client(api);
  await loginSuper(su);
});

// כניסת Super Admin: סיסמה → הקמת TOTP (פעם ראשונה) או אימות → סשן aal2. "אפליקציית האימות" מחשבת TOTP אמיתי מהסוד.
let rootSecret = null;
async function loginSuper(c) {
  let r = await c.post('/api/admin/login', { email: ROOT, password: PW });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  if (!rootSecret) {
    assert.equal(r.body.mfa, 'enroll');
    const e = await c.post('/api/admin/mfa/enroll', {}); assert.equal(e.status, 200, JSON.stringify(e.body)); rootSecret = e.body.secret;
    r = await c.post('/api/admin/mfa/enroll/verify', { factor_id: e.body.factor_id, code: totp(rootSecret) });
  } else {
    assert.equal(r.body.mfa, 'verify');
    r = await c.post('/api/admin/mfa/verify', { code: totp(rootSecret) });
  }
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r;
}

test('Super Admin יוצר עסקים דרך ה-API (Auth + RPC), כולל שירותי ברירת מחדל', async () => {
  let r = await su.post('/api/super/shops', { name: 'מספרה א', slug: 'shop-a', owner_email: 'a@example.com', owner_password: 'OwnerPass-123' });
  assert.equal(r.status, 201, JSON.stringify(r.body)); A = r.body.id;
  r = await su.post('/api/super/shops', { name: 'מספרה ב', slug: 'shop-b', owner_email: 'b@example.com', owner_password: 'OwnerPass-456' });
  B = r.body.id;
  assert.equal((await oa.post('/api/admin/login', { email: 'a@example.com', password: 'OwnerPass-123' })).status, 200);
  assert.equal((await ob.post('/api/admin/login', { email: 'b@example.com', password: 'OwnerPass-456' })).status, 200);
  stA = (await oa.post('/api/admin/barbers', { name: 'יוסי', hours: WEEK_HOURS })).body.id;
  stA2 = (await oa.post('/api/admin/barbers', { name: 'משה', hours: WEEK_HOURS })).body.id;
  stB = (await ob.post('/api/admin/barbers', { name: 'בני', hours: WEEK_HOURS })).body.id;
  vA = (await oa.get('/api/admin/services')).body.services[0].id; vB = (await ob.get('/api/admin/services')).body.services[0].id;
  assert.equal((await oa.get('/api/admin/services')).body.services.length, 3);
});

test('יצירת עסק: כפילויות נדחות ואין חשבון Auth יתום (פעולת פיצוי)', async () => {
  const before = auth.users.size;
  let r = await su.post('/api/super/shops', { name: 'כפול', slug: 'shop-a', owner_email: 'dup-slug@example.com', owner_password: 'OwnerPass-123' });
  assert.equal(r.status, 409); assert.ok(r.body.error.fields.slug);
  assert.equal(auth.users.size, before, 'orphan auth user left behind');
  r = await su.post('/api/super/shops', { name: 'כפול 2', slug: 'shop-new', owner_email: 'a@example.com', owner_password: 'OwnerPass-123' });
  assert.equal(r.status, 409); assert.ok(r.body.error.fields.owner_email);
  r = await su.post('/api/super/shops', { name: 'x', slug: 'Bad Slug', owner_email: 'nope', owner_password: 'short' });
  assert.equal(r.status, 400); assert.ok(r.body.error.fields.owner_email && r.body.error.fields.owner_password);
  r = await su.post('/api/super/shops', { name: 'תבנית', slug: 'cosm-1', template: 'future-template', owner_email: 'cosm@example.com', owner_password: 'OwnerPass-123' });
  assert.equal(r.status, 400); assert.ok(r.body.error.fields.template);
  assert.equal(auth.users.size, before, 'orphan auth user after template rejection');
  r = await oa.post('/api/super/shops', { name: 'האקר', slug: 'hack-shop', owner_email: 'h@example.com', owner_password: 'OwnerPass-123' });
  assert.equal(r.status, 403); assert.ok(!auth.users.has('h@example.com'), 'owner must not be able to create auth users');
  r = await oa.post('/api/super/shops/' + A + '/owners', { owner_email: 'h2@example.com', owner_password: 'OwnerPass-123' });
  assert.equal(r.status, 403); assert.ok(!auth.users.has('h2@example.com'));
});

test('התחברות: עוגיות HttpOnly/Strict/Secure, ללא טוקנים בגוף התגובה, תפקיד נכון', async () => {
  const c = client(api);
  const r = await c.post('/api/admin/login', { email: 'a@example.com', password: 'OwnerPass-123' });
  assert.equal(r.body.role, 'shop_owner');
  assert.equal(r.cookies.length, 2);
  for (const ck of r.cookies) assert.match(ck, /HttpOnly; SameSite=Strict/), assert.match(ck, /Secure/);
  assert.ok(!JSON.stringify(r.body).includes('t.'), 'tokens must not be in body');
  assert.equal((await c.get('/api/admin/me')).body.shop.slug, 'shop-a');
  assert.equal((await su.get('/api/admin/me')).body.user.role, 'super_admin');
});

test('התחברות: סיסמה שגויה, הגבלת קצב לפי אימייל ולפי IP, משתמש ללא תפקיד', async () => {
  const c = client(api);
  for (let i = 0; i < 5; i++) assert.equal((await c.post('/api/admin/login', { email: 'a@example.com', password: 'wrong-pass' })).status, 401);
  assert.equal((await c.post('/api/admin/login', { email: 'a@example.com', password: 'OwnerPass-123' })).status, 429);   // גם סיסמה נכונה חסומה
  assert.equal((await c.post('/api/admin/login', { email: 'nobody@example.com', password: 'x' }, { ip: '203.0.113.50' })).status, 401);
  // IP: 10 כשלונות עם אימיילים שונים
  let last; for (let i = 0; i < 12; i++) last = await c.post('/api/admin/login', { email: `u${i}@example.com`, password: 'x' }, { ip: '203.0.113.60' });
  assert.equal(last.status, 429);
  // משתמש Auth תקין שאינו מנהל פלטפורמה: אין סשן
  await auth.addUser('stranger@example.com', 'StrangerPass-1');
  const s = client(api); const r = await s.post('/api/admin/login', { email: 'stranger@example.com', password: 'StrangerPass-1' });
  assert.equal(r.status, 403); assert.equal(r.cookies.length, 0);
  // הספירה נשמרת במסד (משותפת) ואינה מכילה אימייל/IP גולמי
  const keys = await psql(`select string_agg(key, '|') from rate_limits where key like 'login:%'`, { db: DB });
  assert.ok(!keys.includes('example.com') && !keys.includes('203.0.113'));
});

test('רענון סשן אוטומטי כשה-access token פג; ביטול סשן מנותק', async () => {
  const c = client(api);
  await c.post('/api/admin/login', { email: 'b@example.com', password: 'OwnerPass-456' });
  delete c.jar.bs_at;                                                  // הדפדפן זרק cookie שפג
  const r = await c.get('/api/admin/me');
  assert.equal(r.status, 200); assert.ok(r.cookies.some((x) => x.startsWith('bs_at=')), 'new access cookie');
  c.jar.bs_at = 't.' + Buffer.from(JSON.stringify({ sub: 'x', email: 'e', exp: 1 })).toString('base64url');   // JWT פג שנשלח לשרת
  assert.equal((await c.get('/api/admin/me')).status, 200);
  const rt = c.jar.bs_rt; await c.post('/api/admin/logout', {});
  assert.equal(c.jar.bs_at, undefined); assert.equal((await c.get('/api/admin/me')).status, 401);
  c.jar.bs_rt = rt; assert.equal((await c.get('/api/admin/me')).status, 401);   // refresh token ישן (כבר נוצל) לא עובד
  assert.equal((await client(api).get('/api/admin/me')).status, 401);
});

const body = (o = {}) => ({ slug: 'shop-a', service_id: vA, barber_id: stA, date: '2026-10-18', start_min: 600, first_name: 'דני', last_name: 'כהן', phone: '054-123 4567', idempotency_key: Buffer.from(Array.from({ length: 32 }, () => Math.floor(Math.random() * 256))).toString('base64url'), ...o });
test('הזמנה ללא חשבון דרך ה-API: ולידציה, פיתיון, Origin/Content-Type, הצלחה עם קישור אישי', async () => {
  const c = client(api);
  let r = await c.get('/api/public/shops/shop-a');
  assert.equal(r.body.shop.template, 'barbershop'); assert.equal(r.body.shop.theme, 'barbershop-gold'); assert.equal(r.body.shop.labels.staff_one, 'ספר');
  assert.equal(r.body.barbers.length, 2); assert.equal(r.body.services.length, 3);
  assert.equal((await c.get('/api/public/shops')).body.shops.length, 2);
  r = await c.get(`/api/public/days?slug=shop-a&barber_id=${stA}&service_id=${vA}`); assert.equal(r.body.days.length, 31);
  r = await c.get(`/api/public/slots?slug=shop-a&barber_id=${stA}&service_id=${vA}&date=2026-10-18`); assert.equal(r.body.slots[0], 540);
  assert.equal((await c.get(`/api/public/slots?slug=shop-a&barber_id=abc&service_id=${vA}&date=2026-10-18`)).status, 400);
  assert.equal((await c.get(`/api/public/slots?slug=shop-a&barber_id=${stA}&service_id=${vA}&date=2026-13-45`)).status, 400);
  assert.equal((await c.get('/api/public/shops/does-not-exist')).status, 404);
  r = await c.post('/api/public/book', body({ phone: '123' })); assert.equal(r.status, 400); assert.ok(r.body.error.fields.phone);
  r = await c.post('/api/public/book', body({ first_name: '', last_name: '1' })); assert.ok(r.body.error.fields.first_name && r.body.error.fields.last_name);
  r = await c.post('/api/public/book', body({ website: 'http://spam' })); assert.equal(r.status, 400);
  r = await c.call('POST', '/api/public/book', body(), { headers: { 'content-type': 'text/plain' } }); assert.equal(r.status, 415);
  r = await c.call('POST', '/api/public/book', body(), { headers: { origin: 'https://evil.example' } }); assert.equal(r.status, 403);
  r = await c.post('/api/public/book', body());
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.appointment.barber_name, 'יוסי'); assert.equal(r.body.appointment.first_name, 'דני'); assert.equal(r.body.notification.sent, false);
  tokenUrl = r.body.manage_url; token = tokenUrl.split('/m/')[1];
  assert.match(tokenUrl, /^https:\/\/app\.test\/m\/[A-Za-z0-9_-]{43}$/); assert.equal(token.length, 43);
  assert.ok(!JSON.stringify(r.body).includes('token_hash'));
});

test('כפילויות דרך ה-API: אותה שעה, חפיפה, והזמנות מקבילות', async () => {
  const c = client(api);
  const o = { first_name: 'רון', last_name: 'לוי', phone: '052-7654321' };
  assert.equal((await c.post('/api/public/book', body(o))).status, 409);
  assert.equal((await c.post('/api/public/book', body({ ...o, start_min: 615 }))).status, 409);
  assert.equal((await c.post('/api/public/book', body({ ...o, barber_id: stA2 }))).status, 201);
  const rs = await Promise.all([0, 1, 2, 3, 4, 5].map((n) => c.post('/api/public/book', body({ date: '2026-10-19', start_min: 720, phone: `0501234${500 + n}`.slice(0, 10) }))));
  assert.equal(rs.filter((r) => r.status === 201).length, 1); assert.equal(rs.filter((r) => r.status === 409).length, 5);
});

test('קישור אישי דרך ה-API: צפייה, שינוי, ביטול, ניחוש מוגבל בקצב', async () => {
  const c = client(api); const m = `/api/public/manage/${token}`;
  let r = await c.get(m); assert.equal(r.body.appointment.phone_masked, '•••••4567'); assert.ok(!JSON.stringify(r.body).includes('0541234567'));
  assert.equal((await c.get(`${m}/barbers`)).body.barbers.length, 2);
  assert.equal((await c.get(`${m}/days?barber_id=${stA}`)).body.days.length, 31);
  assert.ok((await c.get(`${m}/slots?barber_id=${stA}&date=2026-10-18`)).body.slots.includes(600));
  assert.equal((await c.post(`${m}/reschedule`, { barber_id: stA, date: '2026-10-20', start_min: 660 })).status, 200);
  assert.equal((await c.post(`${m}/reschedule`, { barber_id: stB, date: '2026-10-20', start_min: 690 })).status, 400);   // צוות של עסק אחר
  assert.equal((await c.post(`${m}/cancel`, {})).status, 200);
  assert.equal((await c.post(`${m}/cancel`, {})).status, 409);
  const fake = '/api/public/manage/' + 'A'.repeat(43); let last;
  for (let i = 0; i < 11; i++) last = await c.get(fake, { ip: '198.51.100.9' });
  assert.equal(last.status, 429);
});

test('פניות (לידים) דרך ה-API ו-Owner רואה אותן', async () => {
  const c = client(api);
  let r = await c.post('/api/public/lead', { slug: 'shop-a', name: 'מיכל כהן', phone: '052-1234567', message: 'מעוניינת' }); assert.equal(r.status, 200);
  assert.equal((await c.post('/api/public/lead', { slug: 'shop-a', name: 'בוט', phone: '052-1234567', website: 'x' })).status, 400);
  assert.equal((await c.post('/api/public/lead', { slug: 'shop-a', name: 'מיכל', phone: 'abc' })).status, 400);
  const leads = (await oa.get('/api/admin/leads')).body.leads; assert.equal(leads.length, 1); assert.equal(leads[0].phone, '0521234567');
  assert.equal((await ob.get('/api/admin/leads')).body.leads.length, 0);
  assert.equal((await oa.patch(`/api/admin/leads/${leads[0].id}`, { status: 'contacted' })).status, 200);
  assert.equal((await ob.patch(`/api/admin/leads/${leads[0].id}`, { status: 'closed' })).status, 404);
});

test('הפרדת עסקים דרך ה-API: Owner לא רואה/משנה עסק אחר, shop_id מתעלמים, /api/super אסור', async () => {
  let r = await oa.get('/api/admin/appointments?from=2026-10-18&to=2026-10-25'); assert.ok(r.body.appointments.length >= 2);
  const a = r.body.appointments[0];
  assert.equal((await ob.get('/api/admin/appointments?from=2026-10-18&to=2026-10-25')).body.appointments.length, 0);
  assert.equal((await ob.get(`/api/admin/appointments?from=2026-10-18&to=2026-10-25&shop_id=${A}`)).body.appointments.length, 0);
  assert.equal((await ob.patch(`/api/admin/appointments/${a.id}`, { status: 'cancelled' })).status, 404);
  assert.equal((await ob.put(`/api/admin/barbers/${stA}`, { name: 'האקר' })).status, 404);
  assert.equal((await ob.put(`/api/admin/services/${vA}`, { name: 'האקר', duration_min: 30, price_ils: 1 })).status, 404);
  assert.equal((await ob.get(`/api/admin/shop?shop_id=${A}`)).body.shop.slug, 'shop-b');
  assert.equal((await ob.get('/api/super/shops')).status, 403);
  assert.equal((await ob.patch(`/api/super/shops/${A}`, { active: false })).status, 403);
  assert.equal((await ob.post(`/api/super/shops/${A}/reset-owner`, { password: 'HackedPass-1' })).status, 403);
  assert.equal((await ob.post(`/api/super/shops/${A}/delete`, { confirm_slug: 'shop-a' })).status, 403);
  assert.equal((await ob.post('/api/admin/appointments', { barber_id: stA, service_id: vB, date: '2026-10-21', start_min: 600, first_name: 'אבי', last_name: 'כהן', phone: '0521112233' })).status, 400);   // צוות של עסק אחר
  assert.equal((await anon.get('/api/admin/me')).status, 401);
  assert.equal((await anon.get('/api/admin/dashboard')).status, 401);
  assert.equal((await anon.get('/api/super/shops')).status, 401);
  // Super Admin חייב לציין עסק, ואז פועל עליו
  assert.equal((await su.get('/api/admin/barbers')).status, 400);
  assert.equal((await su.get(`/api/admin/barbers?shop_id=${A}`)).body.barbers.length, 2);
  assert.equal((await su.get('/api/super/shops')).body.shops.length, 2);
});

test('יומן Owner: תור ידני, סטטוסים, חסימות, לקוחות, לוח בקרה, הגדרות', async () => {
  let r = await oa.post('/api/admin/blocks', { barber_id: stA, date: '2026-10-22', start_min: 540, end_min: 720, note: 'חופשה' }); assert.equal(r.status, 201);
  assert.equal((await anon.get(`/api/public/slots?slug=shop-a&barber_id=${stA}&service_id=${vA}&date=2026-10-22`)).body.slots[0], 720);
  r = await oa.post('/api/admin/appointments', { barber_id: stA, service_id: vA, date: '2026-10-22', start_min: 720, first_name: 'שחר', last_name: 'מזרחי', phone: '0521112233' }); assert.equal(r.status, 201);
  assert.equal((await oa.patch(`/api/admin/appointments/${r.body.id}`, { status: 'completed' })).status, 200);
  assert.equal((await oa.patch(`/api/admin/appointments/${r.body.id}`, { status: 'bogus' })).status, 400);
  assert.equal((await oa.get('/api/admin/customers?q=שחר')).body.customers.length, 1);
  assert.equal((await oa.get('/api/admin/dashboard')).status, 200);
  assert.equal((await oa.put('/api/admin/shop', { name: 'מספרה א', phone: '03-1234567', address: 'רחוב 1', slot_step: 15, min_notice_min: 30, max_days_ahead: 30, cancel_cutoff_hours: 2 })).status, 200);
  assert.equal((await oa.put('/api/admin/shop', { name: '', slot_step: 7 })).status, 400);
  assert.equal((await oa.get('/api/admin/system')).body.database.type, 'Supabase Postgres');
});

test('Super Admin: השבתה (ניתוק מיידי + Auth ban), הפעלה, איפוס סיסמה, שינוי סיסמה עצמי, מחיקה', async () => {
  const c = client(api); await c.post('/api/admin/login', { email: 'b@example.com', password: 'OwnerPass-456' });
  assert.equal((await c.get('/api/admin/dashboard')).status, 200);
  assert.equal((await su.patch(`/api/super/shops/${B}`, { active: false })).status, 200);
  assert.equal((await c.get('/api/admin/dashboard')).status, 403);          // JWT קיים – נחסם ב-DB מיידית
  assert.equal((await client(api).post('/api/admin/login', { email: 'b@example.com', password: 'OwnerPass-456' })).status, 401);   // banned
  assert.equal((await anon.get('/api/public/shops/shop-b')).status, 404);
  assert.equal((await su.patch(`/api/super/shops/${B}`, { active: true })).status, 200);
  assert.equal((await c.get('/api/admin/dashboard')).status, 200);
  assert.equal((await su.post(`/api/super/shops/${B}/reset-owner`, { password: 'short' })).status, 400);
  assert.equal((await su.post(`/api/super/shops/${B}/reset-owner`, { password: 'NewOwnerPass-9' })).status, 200);
  assert.equal((await client(api).post('/api/admin/login', { email: 'b@example.com', password: 'NewOwnerPass-9' })).status, 200);
  // שינוי סיסמה עצמי
  assert.equal((await c.post('/api/admin/password', { current: 'wrong', next: 'AnotherPass-77' })).status, 400);
  assert.equal((await c.post('/api/admin/password', { current: 'NewOwnerPass-9', next: 'weak' })).status, 400);
  assert.equal((await c.post('/api/admin/password', { current: 'NewOwnerPass-9', next: 'AnotherPass-77' })).status, 200);
  assert.equal((await client(api).post('/api/admin/login', { email: 'b@example.com', password: 'AnotherPass-77' })).status, 200);
  // מחיקה: דורשת אישור slug, ומוחקת גם את חשבון ה-Auth
  assert.equal((await su.post(`/api/super/shops/${B}/delete`, { confirm_slug: 'nope' })).status, 400);
  assert.equal((await su.post(`/api/super/shops/${B}/delete`, { confirm_slug: 'shop-b' })).status, 200);
  assert.ok(!auth.users.has('b@example.com'));
  assert.equal(await psql(`select count(*) from staff where business_id = '${B}'`, { db: DB }), '0');
});

test('אבטחה: אין מפתחות בצד הלקוח; תגובות לא חושפות סודות; REST משתמש במפתח הנכון לכל סוג קריאה', async () => {
  const { readdirSync, readFileSync, statSync } = await import('node:fs');
  const { join } = await import('node:path');
  const walk = (d) => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
  let found = 0;
  try { for (const f of walk('public')) { found++; const t = readFileSync(f, 'utf8'); assert.ok(!/service_role|SUPABASE_|eyJhbGciOi|sb_secret_|RATE_LIMIT_PEPPER/.test(t), `secret-like token in ${f}`); } } catch (e) { if (e.code !== 'ENOENT') throw e; }
  // לקוח REST: service מול user
  const { createRest } = await import('../lib/clients/supabase-rest.mjs');
  const seen = [];
  const fetchImpl = async (u, o) => { seen.push({ u, h: o.headers, b: o.body }); return new Response('{"ok":true}', { status: 200 }); };
  const r = createRest({ url: 'https://x.supabase.co', anonKey: 'ANON', serviceKey: 'SERVICE', fetchImpl });
  await r.service('rpc_public_businesses', {}); await r.user('USERJWT', 'rpc_me', {});
  assert.equal(seen[0].u, 'https://x.supabase.co/rest/v1/rpc/rpc_public_businesses');
  assert.deepEqual([seen[0].h.apikey, seen[0].h.Authorization], ['SERVICE', 'Bearer SERVICE']);
  assert.deepEqual([seen[1].h.apikey, seen[1].h.Authorization], ['ANON', 'Bearer USERJWT']);          // קריאת משתמש לעולם לא נושאת את מפתח ה-service
  await assert.rejects(() => r.service('x; drop table', {}));
  const rn = createRest({ url: 'https://x.supabase.co', anonKey: 'sb_publishable_a', serviceKey: 'sb_secret_b', fetchImpl });
  await rn.service('rpc_rate_hit', {}); assert.equal(seen[2].h.Authorization, undefined); assert.equal(seen[2].h.apikey, 'sb_secret_b');
});

test('קונפיגורציה: נכשל סגור כשחסר סוד/מפתח או כשהמפתחות זהים', async () => {
  const { loadConfig } = await import('../lib/config.mjs');
  const ok = { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_ANON_KEY: 'a', SUPABASE_SERVICE_ROLE_KEY: 'b', RATE_LIMIT_PEPPER: 'x'.repeat(32), ALLOWED_ORIGINS: 'https://app.example.com' };
  assert.equal(loadConfig(ok).cookieSecure, true);
  assert.equal(loadConfig(ok).publicBaseUrl, 'https://app.example.com');
  for (const bad of ['', 'http://app.example.com', 'https://*.example.com', 'https://app.example.com/path', 'app.example.com', 'https://a.example.com,*']) assert.throws(() => loadConfig({ ...ok, ALLOWED_ORIGINS: bad }), undefined, bad);
  assert.throws(() => loadConfig({ ...ok, PUBLIC_BASE_URL: 'https://other.example.com' }));
  assert.deepEqual(loadConfig({ ...ok, ALLOWED_ORIGINS: 'https://a.example.com, http://localhost:3111' }).allowedOrigins, ['https://a.example.com', 'http://localhost:3111']);
  for (const [k, v] of [['SUPABASE_URL', ''], ['RATE_LIMIT_PEPPER', 'short'], ['SUPABASE_SERVICE_ROLE_KEY', 'a'], ['SUPABASE_URL', 'http://evil.example']]) {
    assert.throws(() => loadConfig({ ...ok, [k]: v }), undefined, k);
  }
  assert.equal(loadConfig({ ...ok, SUPABASE_URL: 'http://127.0.0.1:54321' }).supabaseUrl, 'http://127.0.0.1:54321');
});

// ---------- MFA, בעלים, יומן ביקורת, Origin (שלב 2) ----------
test('Super Admin אחרי סיסמה בלבד (aal1): כל נתיבי הניהול הרוחביים חסומים עם mfa_required', async () => {
  const c = client(api);
  const r = await c.post('/api/admin/login', { email: ROOT, password: PW });
  assert.equal(r.body.mfa, 'verify');
  assert.equal((await c.get('/api/admin/me')).body.mfa.needs_verification, true);
  for (const [m, u] of [['get', '/api/super/shops'], ['get', `/api/super/shops/${A}/owners`], ['get', '/api/admin/audit'], ['get', `/api/admin/shop?shop_id=${A}`], ['get', '/api/admin/templates']]) {
    const x = await c[m](u);
    if (u === '/api/admin/templates') { assert.equal(x.status, 200); continue; }                    // קטלוג תבניות הוא מידע ציבורי-למחצה, לא נתוני דיירים
    assert.equal(x.status, 403, u); assert.equal(x.body.error.code, 'mfa_required', u);
  }
  let x = await c.post('/api/super/shops', { name: 'ללא MFA', slug: 'no-mfa', owner_email: 'nm@example.com', owner_password: 'OwnerPass-123' });
  assert.equal(x.status, 403); assert.equal(x.body.error.code, 'mfa_required'); assert.ok(!auth.users.has('nm@example.com'), 'לא נוצר חשבון Auth');
  // קוד שגוי: 401, ואחרי 5 – נחסם גם הקוד הנכון (הגבלה לפי משתמש), והספירה בטבלה המשותפת בלי מזהה גולמי
  for (let i = 0; i < 5; i++) assert.equal((await c.post('/api/admin/mfa/verify', { code: '000000' }, { ip: '198.51.100.7' })).status, 401);
  assert.equal((await c.post('/api/admin/mfa/verify', { code: totp(rootSecret) }, { ip: '198.51.100.8' })).status, 429);
  const keys = await psql(`select string_agg(key, '|') from rate_limits where key like 'mfa:%'`, { db: DB });
  assert.ok(keys && !keys.includes('198.51.100') && !keys.includes(ROOT));
  assert.equal((await c.get('/api/super/shops')).status, 403);                                      // עדיין aal1
  await psql(`delete from rate_limits where key like 'mfa:%'`, { db: DB });
  assert.equal((await c.post('/api/admin/mfa/verify', { code: 'abc' })).status, 400);
  assert.equal((await c.post('/api/admin/mfa/verify', { code: totp(rootSecret) })).status, 200);
  assert.equal((await c.get('/api/super/shops')).status, 200);                                      // אחרי TOTP תקין – aal2
  // אין טוקנים או סודות בגוף תגובות MFA; ההקמה פעם נוספת נדחית
  assert.equal((await c.post('/api/admin/mfa/enroll', {})).status, 409);
});

test('פעולה רגישה דורשת TOTP טרי: mfa_stale → אימות חוזר → הפעולה מצליחה', async () => {
  const c = client(api); await loginSuper(c);
  // מנפיקים בעלים+עסק זמני למחיקה
  let r = await c.post('/api/super/shops', { name: 'זמני', slug: 'temp-shop', owner_email: 'temp@example.com', owner_password: 'OwnerPass-123' });
  assert.equal(r.status, 201); const tid = r.body.id;
  // סשן aal2 עם חותמת TOTP ישנה (שעה לפני "עכשיו" של המסד) – כמו משתמש שהתחבר לפני זמן רב
  const forged = (ts) => 't.' + Buffer.from(JSON.stringify({ sub: JSON.parse(Buffer.from(c.jar.bs_at.slice(2), 'base64url')).sub, email: ROOT, exp: Math.floor(Date.parse('2026-10-16T18:30:00Z') / 1000) + 3600, aal: 'aal2', amr: [{ method: 'totp', timestamp: ts }] })).toString('base64url');
  c.jar.bs_at = forged(Math.floor(Date.parse('2026-10-16T18:30:00Z') / 1000) - 3600);
  r = await c.post(`/api/super/shops/${tid}/delete`, { confirm_slug: 'temp-shop' });
  assert.equal(r.status, 403); assert.equal(r.body.error.code, 'mfa_stale');
  assert.equal((await psql(`select count(*) from businesses where slug='temp-shop'`, { db: DB })), '1');
  assert.equal((await c.get('/api/super/shops')).status, 200);                                       // קריאה רגילה לא דורשת אימות טרי
  assert.equal((await c.post('/api/admin/mfa/verify', { code: totp(rootSecret) })).status, 200);     // אימות חוזר
  r = await c.post(`/api/super/shops/${tid}/delete`, { confirm_slug: 'temp-shop' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await psql(`select count(*) from businesses where slug='temp-shop'`, { db: DB })), '0');
  assert.ok(!auth.users.has('temp@example.com'), 'חשבון Auth של הבעלים נמחק');
});

test('Owner: MFA אופציונלי – אחרי שהוגדר, כניסה דורשת TOTP וה-DB חוסם aal1', async () => {
  const su2 = client(api); await loginSuper(su2);
  assert.equal((await su2.post('/api/super/shops', { name: 'עסק MFA', slug: 'mfa-shop', owner_email: 'mfa-owner@example.com', owner_password: 'OwnerPass-111' })).status, 201);
  const c = client(api); const email = 'mfa-owner@example.com';
  let r = await c.post('/api/admin/login', { email, password: 'OwnerPass-111' });
  assert.equal(r.body.mfa, null, JSON.stringify(r.body));
  const e = await c.post('/api/admin/mfa/enroll', {}); assert.equal(e.status, 200);
  assert.ok(e.body.secret && e.body.uri.startsWith('otpauth://totp/') && e.body.qr_code);
  assert.equal((await c.post('/api/admin/mfa/enroll/verify', { factor_id: e.body.factor_id, code: '123456' })).status, 401);   // קוד שגוי לא מפעיל
  assert.equal((await c.get('/api/admin/services')).status, 200);                                    // עדיין לא מאומת – עובד כרגיל
  assert.equal((await c.post('/api/admin/mfa/enroll/verify', { factor_id: e.body.factor_id, code: totp(e.body.secret) })).status, 200);
  const d = client(api);
  r = await d.post('/api/admin/login', { email, password: 'OwnerPass-111' });
  assert.equal(r.body.mfa, 'verify');
  r = await d.get('/api/admin/services'); assert.equal(r.status, 403); assert.equal(r.body.error.code, 'mfa_required');
  assert.equal((await d.post('/api/admin/mfa/verify', { code: totp(e.body.secret) })).status, 200);
  assert.equal((await d.get('/api/admin/services')).status, 200);
  assert.equal((await d.get('/api/super/shops')).status, 403);                                       // Owner אינו Super גם עם aal2
  // איפוס לשאר הבדיקות: מסירים את ה-MFA של הבעלים
  await psql(`delete from auth.mfa_factors where user_id = (select id from auth.users where email='${email}')`, { db: DB });
  auth.users.get(email).factors.clear();
});

test('שיוך בעלים מהממשק: יצירת חשבון + שיוך אטומי, כניסה, בידוד, הסרה; כשל שיוך לא משאיר חשבון Auth', async () => {
  const c = client(api); await loginSuper(c);
  let r = await c.post('/api/super/shops', { name: 'עסק בעלים', slug: 'owners-shop', owner_email: 'b@example.org', owner_password: 'OwnerPass-456' });
  assert.equal(r.status, 201); const B = r.body.id;
  const before = auth.users.size;
  r = await c.post(`/api/super/shops/${B}/owners`, { owner_email: 'b2@example.com', owner_password: 'OwnerPass-789' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  r = await c.get(`/api/super/shops/${B}/owners`); assert.deepEqual(r.body.owners.map((o) => o.email).sort(), ['b2@example.com', 'b@example.org']);
  const ob2 = client(api);
  assert.equal((await ob2.post('/api/admin/login', { email: 'b2@example.com', password: 'OwnerPass-789' })).status, 200);
  assert.equal((await ob2.get('/api/admin/me')).body.shop.slug, 'owners-shop');
  assert.equal((await ob2.get(`/api/admin/dashboard?shop_id=${A}`)).status, 200);                    // shop_id מתעלמים (מקבל את העסק שלו)                 // shop_id מתעלמים
  // כשל שיוך (עסק שאינו קיים) → החשבון שנוצר נמחק
  r = await c.post('/api/super/shops/00000000-0000-4000-8000-000000000000/owners', { owner_email: 'ghost@example.com', owner_password: 'OwnerPass-789' });
  assert.ok(r.status >= 400 && r.status < 500, JSON.stringify(r.body)); assert.ok(!auth.users.has('ghost@example.com'), 'חשבון יתום');
  assert.equal(auth.users.size, before + 1);
  // אימייל קיים
  r = await c.post(`/api/super/shops/${B}/owners`, { owner_email: 'b2@example.com', owner_password: 'OwnerPass-789' }); assert.equal(r.status, 409);
  // הסרה: חשבון Auth נמחק, ה-JWT הקיים מאבד גישה (אין שורה ב-platform_users)
  const uid = auth.users.get('b2@example.com').id;
  r = await c.del(`/api/super/shops/${B}/owners/${uid}`); assert.equal(r.status, 200);
  assert.ok(!auth.users.has('b2@example.com'));
  assert.equal((await ob2.get('/api/admin/shop')).status, 403);
  assert.equal((await client(api).post('/api/admin/login', { email: 'b2@example.com', password: 'OwnerPass-789' })).status, 401);
  assert.equal((await oa.post(`/api/super/shops/${A}/owners`, { owner_email: 'z@example.com', owner_password: 'OwnerPass-789' })).status, 403);
});

test('יומן ביקורת דרך ה-API: Owner רואה את שלו בלבד, Super רואה הכול, בלי PII', async () => {
  const c = client(api); await loginSuper(c);
  const mine = await oa.get(`/api/admin/audit?shop_id=${B}&limit=200`);
  assert.equal(mine.status, 200); assert.ok(mine.body.entries.length > 3); assert.ok(mine.body.entries.every((e) => e.business_id === A));
  const all = await c.get('/api/admin/audit?limit=200');
  assert.ok(all.body.entries.some((e) => e.business_id === A) && all.body.entries.some((e) => e.business_id === B));
  assert.ok(all.body.entries.some((e) => e.action === 'auth.mfa_enrolled') && all.body.entries.some((e) => e.action === 'auth.login'));
  assert.ok(all.body.entries.some((e) => e.action === 'owner.password_reset'));
  const txt = JSON.stringify(all.body);
  for (const pii of ['054-123', '0541234567', 'דני', 'כהן', '@example.com', 'OwnerPass', 'SuperSecret']) assert.ok(!txt.includes(pii), 'PII ביומן: ' + pii);
  assert.equal((await anon.get('/api/admin/audit')).status, 401);
});

test('Origin מאושר במפורש: בלי Origin או עם Origin זר נחסם; קישור אישי נבנה רק מ-Origin מאושר', async () => {
  const c = client(api);
  const b = body({ date: '2026-10-21', start_min: 600, phone: '0501110001' });
  for (const headers of [{ origin: 'https://evil.example' }, { origin: 'https://app.test.evil.example' }, { origin: 'http://app.test' }, { origin: 'null' }]) {
    assert.equal((await c.call('POST', '/api/public/book', b, { headers })).status, 403, JSON.stringify(headers));
  }
  const noOrigin = await api.handle({ method: 'POST', pathname: '/api/public/book', query: new URLSearchParams(), ip: '10.9.9.9', https: true, headers: { host: 'app.test', 'content-type': 'application/json' }, body: JSON.stringify(b) });
  assert.equal(noOrigin.status, 403);
  // Host מזויף עם Origin מאושר: הקישור עדיין לפי ההגדרות
  const ok = await c.call('POST', '/api/public/book', b, { headers: { host: 'evil.example' } });
  assert.equal(ok.status, 201, JSON.stringify(ok.body)); assert.ok(ok.body.manage_url.startsWith('https://app.test/m/'));
  // GET בלי Origin תקין (דפדפן)
  assert.equal((await c.get('/api/public/shops')).status, 200);
});

test('אין שום סוד/מפתח/טוקן גולמי בגוף תגובות MFA וניהול הבעלים', async () => {
  const c = client(api); const r = await c.post('/api/admin/login', { email: ROOT, password: PW });
  assert.ok(!/t\.[A-Za-z0-9_-]{20,}|r\.[0-9a-f]{20,}/.test(JSON.stringify(r.body)));
});

test('הקמת מנהל ראשון: סיסמה חזקה, פעם אחת בלבד, פיצוי על כשל (אין חשבון Auth יתום)', async () => {
  const { bootstrapSuperAdmin } = await import('../lib/admin-setup.mjs');
  const DB2 = 'platform_api_boot'; process.env.TEST_DB = DB2; resetDb(DB2);
  const rest2 = pgRest({ db: DB2 }), auth2 = fakeAuth({ db: DB2 });
  await assert.rejects(bootstrapSuperAdmin({ rest: rest2, auth: auth2, email: 'x@example.com', password: 'short-pass' }), /14/);
  await assert.rejects(bootstrapSuperAdmin({ rest: rest2, auth: auth2, email: 'bad', password: 'a-long-enough-password-1' }), /אימייל/);
  assert.equal(auth2.users.size, 0);
  const r = await bootstrapSuperAdmin({ rest: rest2, auth: auth2, email: 'Boss@Example.com', password: 'a-long-enough-password-1' });
  assert.equal(r.email, 'boss@example.com');
  assert.equal(await psql(`select role from platform_users`, { db: DB2 }), 'super_admin');
  await assert.rejects(bootstrapSuperAdmin({ rest: rest2, auth: auth2, email: 'second@example.com', password: 'another-long-password-2' }), /already_bootstrapped/);
  assert.equal(auth2.users.size, 1, 'החשבון השני נמחק אחרי הכשל');
  // המנהל החדש נכנס רק עם MFA
  const api2 = createApi({ rest: rest2, auth: auth2, config, log: quiet }); const c = client(api2);
  const l = await c.post('/api/admin/login', { email: 'boss@example.com', password: 'a-long-enough-password-1' });
  assert.equal(l.body.mfa, 'enroll'); assert.equal((await c.get('/api/super/shops')).status, 403);
  process.env.TEST_DB = DB;
});

test('תחזוקה: ניקוי מוני קצב ויומן ישן דרך lib/maintenance', async () => {
  const { runMaintenance } = await import('../lib/maintenance.mjs');
  await psql(`insert into rate_limits (key, bucket, n, expires_at) values ('t:old', 7, 1, now() - interval '3 hours')`, { db: DB });
  const out = await runMaintenance(rest);
  assert.ok(out.rate_limits_deleted >= 1); assert.equal(await psql(`select count(*) from rate_limits where key='t:old'`, { db: DB }), '0');
});
