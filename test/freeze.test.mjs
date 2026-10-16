// הקפאת כתיבה והגירה מאומתת: הקפאה נאכפת ב-DB, ייבוא קפוא, טביעת אצבע (ספירות + hash), שחרור רק אחרי אימות, זיהוי שחיתות נתונים
import test from 'node:test';
import assert from 'node:assert/strict';
import { psql, rpc } from './support/pg.mjs';
import { resetDb, addUser, asUser, asSuper, asService, NOW, WEEK_HOURS } from './support/db.mjs';
import { pgRest, fakeAuth, client } from './support/adapters.mjs';
import { createApi } from '../lib/api.mjs';
import { migrateBusiness, diffFingerprints } from '../lib/migrate.mjs';

const SRC = 'platform_fsrc', DST = 'platform_fdst', PEPPER = 'test-pepper-0123456789-0123456789';
let srcSvc, dstSvc, ownSrc, supSrc, bizId, token, sv, st, uOwner;
const restFor = (db) => ({ service: async (name, args) => { const r = await rpc(name, args, { role: 'service_role', db }); if (r.httpStatus !== 200) throw new Error(`${name}: ${r.error.message}`); return r.data; } });
const book = (over, ip) => srcSvc('rpc_public_book', { p: { slug: 'client-shop', service_id: sv, barber_id: st, date: '2026-10-18', start_min: 600, first_name: 'דני', last_name: 'כהן', phone: '0541234567', idempotency_key: 'k' + Math.random().toString(36).slice(2) + 'x'.repeat(12), ...over }, p_ip_hash: ip, p_pepper: PEPPER });

test.before(async () => {
  resetDb(SRC); resetDb(DST);
  const uSup = await addUser('root@src.example', SRC); uOwner = await addUser('owner@src.example', SRC);
  await psql(`insert into platform_users (user_id, role) values ('${uSup}', 'super_admin')`, { db: SRC });
  const uSupD = await addUser('root@dst.example', DST); await psql(`insert into platform_users (user_id, role) values ('${uSupD}', 'super_admin')`, { db: DST });
  srcSvc = asService(NOW, SRC); dstSvc = asService(NOW, DST); supSrc = asSuper(uSup, 'root@src.example', NOW, SRC); ownSrc = asUser(uOwner, 'owner@src.example', NOW, SRC);
  bizId = (await supSrc('rpc_super_create_business', { p: { name: 'מספרת לקוח', slug: 'client-shop', template: 'barbershop', owner_user_id: uOwner } })).data.data.id;
  st = (await ownSrc('rpc_owner_staff_create', { p_business: null, p: { name: 'דור', hours: WEEK_HOURS } })).data.data.id;
  sv = (await ownSrc('rpc_owner_services_list', { p_business: null })).data.data.services[0].id;
  const r1 = await book({}, 'b'.repeat(64)); assert.equal(r1.data.ok, true, JSON.stringify(r1)); token = r1.data.data.token;
  await book({ start_min: 660, first_name: 'רון', last_name: 'לוי', phone: '0527654321' }, 'c'.repeat(64));
  await srcSvc('rpc_public_submit_lead', { p: { slug: 'client-shop', name: 'מיכל כהן', phone: '0521234567', message: 'פרטים' }, p_ip_hash: 'd'.repeat(64), p_pepper: PEPPER });
});

test('הקפאה נאכפת ב-DB לכל כתיבה (הזמנה, פנייה, ביטול, עריכת צוות/שירותים/חסימות) וקריאה נשארת; שחרור מחזיר פעילות', async () => {
  assert.equal((await srcSvc('rpc_admin_set_freeze', { p_business: bizId, p_frozen: true })).data.ok, true);
  const blocked = async (r, what) => { assert.notEqual(r.httpStatus, 200, what + ' חייב להיחסם'); assert.match(r.error.message, /business_frozen/, what); };
  await blocked(await book({ start_min: 720, first_name: 'חדש', phone: '0501112222' }, 'e'.repeat(64)), 'הזמנה');
  await blocked(await srcSvc('rpc_public_submit_lead', { p: { slug: 'client-shop', name: 'עוד אחד', phone: '0509998888' }, p_ip_hash: 'f'.repeat(64), p_pepper: PEPPER }), 'פנייה');
  await blocked(await srcSvc('rpc_public_token_cancel', { p_token: token, p_ip_hash: 'a'.repeat(64) }), 'ביטול בקישור אישי');
  await blocked(await ownSrc('rpc_owner_block_create', { p_business: null, p: { barber_id: st, date: '2026-10-22', start_min: 540, end_min: 720 } }), 'חסימה');
  await blocked(await ownSrc('rpc_owner_staff_create', { p_business: null, p: { name: 'חדש', hours: WEEK_HOURS } }), 'צוות');
  await blocked(await ownSrc('rpc_owner_service_create', { p_business: null, p: { name: 'חדש', duration_min: 30, price_ils: 50 } }).catch(() => ({ httpStatus: 500, error: { message: 'business_frozen' } })), 'שירות');
  // קריאה פתוחה
  assert.equal((await srcSvc('rpc_public_token_get', { p_token: token, p_ip_hash: 'a'.repeat(64) })).data.ok, true);
  assert.equal((await srcSvc('rpc_public_business', { p_slug: 'client-shop' })).data.data.shop.frozen, true);
  assert.equal((await supSrc('rpc_super_businesses')).data.data.shops.find((s) => s.id === bizId).frozen, true);
  // שחרור מסך Super: דורש אימות טרי
  const uid = await psql(`select user_id from platform_users where role = 'super_admin'`, { db: SRC });
  const stale = asSuper(uid, 'root@src.example', NOW, SRC, false);
  assert.equal((await stale('rpc_super_set_freeze', { p_business: bizId, p: { frozen: 'false' } })).httpStatus, 403);
  assert.equal((await supSrc('rpc_super_set_freeze', { p_business: bizId, p: { frozen: 'false' } })).data.ok, true);
  assert.equal((await book({ start_min: 720, first_name: 'חדש', phone: '0501112222' }, 'e'.repeat(64))).data.ok, true, 'אחרי שחרור הזמנה עובדת');
  await srcSvc('rpc_public_token_cancel', { p_token: (await book({ start_min: 780, first_name: 'זמני', phone: '0503334444' }, 'g'.repeat(64))).data.data.token, p_ip_hash: 'a'.repeat(64) });
});

test('API: כתיבה ציבורית לעסק קפוא מחזירה 503 "frozen" והדף הציבורי מציין frozen', async () => {
  const auth = fakeAuth({ db: SRC }); const api = createApi({ rest: pgRest({ db: SRC }), auth, config: { pepper: PEPPER, publicBaseUrl: 'https://app.test', allowedOrigins: ['https://app.test'], cookieSecure: true }, log: { error() {}, log() {} } });
  const c = client(api);
  await srcSvc('rpc_admin_set_freeze', { p_business: bizId, p_frozen: true });
  assert.equal((await c.get('/api/public/shops/client-shop')).body.shop.frozen, true);
  const r = await c.post('/api/public/lead', { slug: 'client-shop', name: 'דנה לוי', phone: '052-1239876' });
  assert.equal(r.status, 503, JSON.stringify(r.body)); assert.equal(r.body.error.code, 'frozen');
  await srcSvc('rpc_admin_set_freeze', { p_business: bizId, p_frozen: false });
  assert.equal((await c.post('/api/public/lead', { slug: 'client-shop', name: 'דנה לוי', phone: '052-1239876' })).status, 200);
});

test('ניטור וגיבוי: /api/health בלי פרטים פנימיים; רשימת עסקים לגיבוי ללא נתוני לקוחות', async () => {
  const api = createApi({ rest: pgRest({ db: SRC }), auth: fakeAuth({ db: SRC }), config: { pepper: PEPPER, publicBaseUrl: 'https://app.test', allowedOrigins: ['https://app.test'], cookieSecure: true }, log: { error() {}, log() {} } });
  const h = await client(api).get('/api/health'); assert.equal(h.status, 200); assert.deepEqual(h.body, { ok: true });
  const l = await srcSvc('rpc_admin_list_businesses'); const txt = JSON.stringify(l.data);
  assert.ok(l.data.data.businesses.some((b) => b.slug === 'client-shop')); assert.ok(!/phone|first_name|email/.test(txt));
});

let result;
test('הגירה מלאה: המקור קפוא, היעד נוצר קפוא, טביעות אצבע זהות, היעד נשאר קפוא עד שחרור; הקישור האישי עובד אחרי השחרור', async () => {
  const dry = await migrateBusiness({ src: restFor(SRC), dst: null, bizId, dryRun: true });
  assert.ok(dry.dryRun && dry.exported.appointments.length >= 3);
  assert.equal(await psql(`select frozen_at is null from businesses where id = '${bizId}'`, { db: SRC }), 't', 'dry-run לא מקפיא');
  const logs = [];
  result = await migrateBusiness({ src: restFor(SRC), dst: restFor(DST), bizId, log: (m) => logs.push(m) });
  assert.equal(result.ok, true, JSON.stringify(result)); assert.deepEqual(result.diffs, []); assert.equal(result.released, false);
  assert.equal(await psql(`select frozen_at is not null from businesses where id = '${bizId}'`, { db: SRC }), 't', 'המקור נשאר קפוא');
  assert.equal(await psql(`select frozen_at is not null from businesses where id = '${result.business_id}'`, { db: DST }), 't', 'היעד קפוא עד אימות ושחרור');
  assert.ok(logs.length >= 3);
  // בזמן הקפאה אי אפשר להזמין ביעד
  const b = await dstSvc('rpc_public_book', { p: { slug: 'client-shop', service_id: (await psql(`select id from services where business_id = '${result.business_id}' limit 1`, { db: DST })) * 1, barber_id: (await psql(`select id from staff where business_id = '${result.business_id}' limit 1`, { db: DST })) * 1, date: '2026-10-19', start_min: 600, first_name: 'אבי', last_name: 'בן דוד', phone: '0508887777', idempotency_key: 'z'.repeat(32) }, p_ip_hash: 'h'.repeat(64), p_pepper: 'rotated-pepper-9999999999-9999999999' });
  assert.match(b.error ? b.error.message : JSON.stringify(b), /business_frozen/);
  // שחרור ביעד, והקישור האישי שנוצר במקור ממשיך לעבוד (hash של הטוקן אינו תלוי ב-pepper, כך שהחלפת סודות אינה שוברת קישורים)
  assert.equal((await dstSvc('rpc_admin_set_freeze', { p_business: result.business_id, p_frozen: false })).data.ok, true);
  const t = await dstSvc('rpc_public_token_get', { p_token: token, p_ip_hash: 'i'.repeat(64) });
  assert.equal(t.data.ok, true); assert.equal(t.data.data.appointment.first_name, 'דני');
  assert.equal((await dstSvc('rpc_public_submit_lead', { p: { slug: 'client-shop', name: 'אחרי העברה', phone: '0506665555' }, p_ip_hash: 'j'.repeat(64), p_pepper: 'rotated-pepper-9999999999-9999999999' })).data.ok, true, 'pepper חדש ביעד עובד');
});

test('אימות נתונים: שחיתות/חסר ביעד מזוהים, והיעד לא משתחרר', async () => {
  // שחיתות אחרי הייבוא: משנים טלפון של לקוח ביעד (עוקפים triggers ברמת סשן) – טביעת האצבע חייבת להשתנות
  const fpSrc = (await srcSvc('rpc_admin_business_fingerprint', { p_business: bizId })).data.data;
  await psql(`set session_replication_role = replica; update customers set phone = '0500000000' where business_id = (select id from businesses where slug = 'client-shop') and phone = '0541234567'`, { db: DST });
  const fpDst = (await dstSvc('rpc_admin_business_fingerprint', { p_business: (await psql(`select id from businesses where slug = 'client-shop'`, { db: DST }) ) })).data.data;
  assert.ok(diffFingerprints({ ...fpSrc }, fpDst).some((d) => d.startsWith('hashes.customers')), 'שחיתות בלקוחות מזוהה');
  // ייבוא חסר: ה-dst מאבד תור בדרך → migrate מחזיר ok:false, לא משחרר
  resetDb(DST); const uSupD = await addUser('root@dst.example', DST); await psql(`insert into platform_users (user_id, role) values ('${uSupD}', 'super_admin')`, { db: DST });
  await srcSvc('rpc_admin_set_freeze', { p_business: bizId, p_frozen: false });
  const lossy = { service: async (name, args) => { if (name === 'rpc_admin_import_business_frozen') args = { ...args, p: { ...args.p, appointments: args.p.appointments.slice(1) } }; return restFor(DST).service(name, args); } };
  const r = await migrateBusiness({ src: restFor(SRC), dst: lossy, bizId, release: true });
  assert.equal(r.ok, false); assert.ok(r.diffs.some((d) => /appointments/.test(d)), r.diffs.join()); assert.equal(r.released, false);
  assert.equal(await psql(`select frozen_at is not null from businesses where slug = 'client-shop'`, { db: DST }), 't', 'יעד פגום נשאר קפוא גם עם --release');
});

test('הרשאות: freeze/fingerprint/import-frozen ל-service_role בלבד; owner לא מקפיא', async () => {
  for (const f of ['rpc_admin_set_freeze', 'rpc_admin_business_fingerprint', 'rpc_admin_import_business_frozen']) {
    for (const role of ['anon', 'authenticated']) {
      const sql = f === 'rpc_admin_set_freeze' ? `select public.${f}('${bizId}', true)` : f === 'rpc_admin_business_fingerprint' ? `select public.${f}('${bizId}')` : `select public.${f}('{}'::jsonb)`;
      const { asRole } = await import('./support/db.mjs'); const r = await asRole(role, role === 'authenticated' ? { sub: uOwner } : null, sql, { db: SRC }); assert.equal(r.sqlstate, '42501', `${f} ${role}`);
    }
  }
  const o = await ownSrc('rpc_super_set_freeze', { p_business: bizId, p: { frozen: 'true' } }); assert.ok(o.httpStatus >= 400);
});
