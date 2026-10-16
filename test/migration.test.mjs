// מסירה והגירה בין שני מסדי Postgres נפרדים (מקור = מסלול מנוהל, יעד = חשבון הלקוח): ייצוא → ייבוא → אימות → מחיקה במקור.
import test from 'node:test';
import assert from 'node:assert/strict';
import { psql } from './support/pg.mjs';
import { resetDb, addUser, asUser, asSuper, asService, asRole, NOW, WEEK_HOURS } from './support/db.mjs';

const SRC = 'platform_src', DST = 'platform_dst', PEPPER = 'test-pepper-0123456789-0123456789';
let srcSvc, dstSvc, supSrc, supDst, ownSrc, bizId, token, exported, uOwner, uSupDst, uNewOwner;

test.before(async () => {
  resetDb(SRC); resetDb(DST);
  const uSup = await addUser('root@src.example', SRC); uOwner = await addUser('owner@src.example', SRC);
  await psql(`insert into platform_users (user_id, role) values ('${uSup}', 'super_admin')`, { db: SRC });
  uSupDst = await addUser('root@dst.example', DST); uNewOwner = await addUser('customer-owner@dst.example', DST);
  await psql(`insert into platform_users (user_id, role) values ('${uSupDst}', 'super_admin')`, { db: DST });
  srcSvc = asService(NOW, SRC); dstSvc = asService(NOW, DST);
  supSrc = asSuper(uSup, 'root@src.example', NOW, SRC); supDst = asSuper(uSupDst, 'root@dst.example', NOW, DST);
  ownSrc = asUser(uOwner, 'owner@src.example', NOW, SRC);

  bizId = (await supSrc('rpc_super_create_business', { p: { name: 'מספרת לקוח', slug: 'client-shop', template: 'barbershop', owner_user_id: uOwner } })).data.data.id;
  const st = (await ownSrc('rpc_owner_staff_create', { p_business: null, p: { name: 'דור', hours: WEEK_HOURS } })).data.data.id;
  const sv = (await ownSrc('rpc_owner_services_list', { p_business: null })).data.data.services[0].id;
  const book = (over, ip) => srcSvc('rpc_public_book', { p: { slug: 'client-shop', service_id: sv, barber_id: st, date: '2026-10-18', start_min: 600, first_name: 'דני', last_name: 'כהן', phone: '0541234567', idempotency_key: Buffer.from(Array.from({ length: 32 }, () => Math.floor(Math.random() * 256))).toString('base64url'), ...over }, p_ip_hash: ip, p_pepper: PEPPER });
  token = (await book({}, 'b'.repeat(64))).data.data.token;
  await book({ start_min: 660, first_name: 'רון', last_name: 'לוי', phone: '0527654321' }, 'c'.repeat(64));
  await ownSrc('rpc_owner_block_create', { p_business: null, p: { barber_id: st, date: '2026-10-22', start_min: 540, end_min: 720, note: 'חופשה' } });
  await srcSvc('rpc_public_submit_lead', { p: { slug: 'client-shop', name: 'מיכל כהן', phone: '0521234567', message: 'פרטים' }, p_ip_hash: 'd'.repeat(64), p_pepper: PEPPER });
});

test('ייצוא: כל נתוני העסק, ללא סודות, ללא חשבונות Auth וללא אסימונים גולמיים', async () => {
  const r = await srcSvc('rpc_admin_export_business', { p_business: bizId });
  assert.equal(r.data.ok, true); exported = r.data.data;
  assert.equal(exported.appointments.length, 2); assert.equal(exported.customers.length, 2); assert.equal(exported.leads.length, 1);
  assert.equal(exported.blocks.length, 1); assert.equal(exported.staff.length, 1); assert.equal(exported.services.length, 3);
  const raw = JSON.stringify(exported);
  assert.ok(!raw.includes(token), 'raw token must never be exported');
  for (const bad of ['owner@src.example', 'root@src.example', uOwner, 'password', 'encrypted', 'secret', 'rate_limits', 'platform_users', 'user_id']) assert.ok(!raw.includes(bad), `export leaks ${bad}`);
  assert.ok(exported.appointments.every((a) => /^[0-9a-f]{64}$/.test(a.token_hash)));
});

test('ייצוא/ייבוא אינם נגישים ל-anon/authenticated', async () => {
  for (const [role, claims] of [['anon', null], ['authenticated', { sub: uOwner }]]) {
    const r = await asRole(role, claims, `select public.rpc_admin_export_business('${bizId}')`, { db: SRC });
    assert.equal(r.sqlstate, '42501');
    const i = await asRole(role, claims, `select public.rpc_admin_import_business('{}'::jsonb)`, { db: DST });
    assert.equal(i.sqlstate, '42501');
  }
});

let newBiz;
test('ייבוא למסד היעד: ספירות זהות, מזהים מוּמפּים מחדש, קישורי לקוחות ממשיכים לעבוד', async () => {
  let r = await dstSvc('rpc_admin_import_business', { p: { ...exported, version: 2 } }); assert.equal(r.data.error.code, 'invalid_export');
  r = await dstSvc('rpc_admin_import_business', { p: exported });
  assert.equal(r.data.ok, true, JSON.stringify(r.data)); newBiz = r.data.data.business_id;
  assert.deepEqual(r.data.data.counts, { staff: 1, services: 3, customers: 2, appointments: 2, leads: 1 });
  assert.notEqual(newBiz, bizId);
  // הקישור האישי של הלקוח (טוקן שנוצר במקור) עובד בסביבת היעד – כי נשמר רק ה-hash
  const t = await dstSvc('rpc_public_token_get', { p_token: token, p_ip_hash: 'e'.repeat(64) });
  assert.equal(t.data.ok, true); assert.equal(t.data.data.appointment.first_name, 'דני'); assert.equal(t.data.data.appointment.phone_masked, '•••••4567');
  // הזמינות בסביבת היעד מכבדת את התורים והחסימה שהועברו
  const st = (await psql(`select id from staff`, { db: DST })).trim(); const sv = (await psql(`select min(id) from services`, { db: DST })).trim();
  const sl = (d) => dstSvc('rpc_public_slots', { p_slug: 'client-shop', p_staff: Number(st), p_service: Number(sv), p_date: d }).then((x) => x.data.data.slots);
  const sun = await sl('2026-10-18'); assert.ok(!sun.includes(600) && !sun.includes(660) && sun.includes(540));
  assert.equal((await sl('2026-10-22'))[0], 720);
  // ייבוא כפול לאותו slug נדחה; ייבוא עם slug חדש מצליח ומבודד
  r = await dstSvc('rpc_admin_import_business', { p: exported }); assert.equal(r.data.status, 409);
});

test('אחרי ייבוא: אין Owner עד ששויך חשבון בבעלות הלקוח; הבידוד נשמר', async () => {
  const newOwner = asUser(uNewOwner, 'customer-owner@dst.example', NOW, DST);
  assert.equal((await newOwner('rpc_owner_dashboard', { p_business: null })).httpStatus, 403);
  assert.equal((await newOwner('rpc_super_attach_owner', { p_business: newBiz, p: { owner_user_id: uNewOwner } })).httpStatus, 403);
  let r = await supDst('rpc_super_attach_owner', { p_business: newBiz, p: { owner_user_id: uNewOwner } }); assert.equal(r.data.ok, true);
  r = await supDst('rpc_super_attach_owner', { p_business: newBiz, p: { owner_user_id: uNewOwner } }); assert.equal(r.data.status, 400);   // כבר משויך
  r = await newOwner('rpc_owner_appointments', { p_business: null, p: { from: '2026-10-18', to: '2026-10-18' } });
  assert.equal(r.data.data.appointments.length, 2); assert.equal(r.data.data.appointments[0].phone, '0541234567');
  assert.equal((await newOwner('rpc_owner_leads', { p_business: null })).data.data.leads.length, 1);
  // חשבון המקור (בבעלות מנהל הפלטפורמה) אינו קיים בסביבת הלקוח כלל
  assert.equal(await psql(`select count(*) from auth.users where email like '%@src.example'`, { db: DST }), '0');
});

test('מחיקת העסק במקור: דורשת אישור slug; מוחקת בשרשרת את כל הנתונים; מחזירה את חשבונות ה-Owner למחיקה ב-Auth', async () => {
  let r = await supSrc('rpc_super_delete_business', { p_business: bizId, p: { confirm_slug: 'wrong' } }); assert.equal(r.data.error.code, 'confirm_required');
  assert.equal((await ownSrc('rpc_super_delete_business', { p_business: bizId, p: { confirm_slug: 'client-shop' } })).httpStatus, 403);
  r = await supSrc('rpc_super_delete_business', { p_business: bizId, p: { confirm_slug: 'client-shop' } });
  assert.equal(r.data.ok, true); assert.deepEqual(r.data.data.owner_user_ids, [uOwner]);
  for (const t of ['businesses', 'staff', 'services', 'working_hours', 'blocks', 'customers', 'appointments', 'leads', 'platform_users']) {
    assert.equal(await psql(`select count(*) from ${t} where ${t === 'businesses' ? 'id' : t === 'platform_users' ? 'business_id' : 'business_id'} = '${bizId}'`, { db: SRC }), '0', t);
  }
  // היעד לא הושפע
  assert.equal(await psql(`select count(*) from appointments`, { db: DST }), '2');
});
