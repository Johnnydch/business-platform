// בדיקות שכבת מסד הנתונים על Postgres 16 אמיתי: סכמה, RLS, הרשאות, מנוע הזמנות, מקביליות, אסימונים, הגבלת קצב.
import test from 'node:test';
import assert from 'node:assert/strict';
import { psql } from './support/pg.mjs';
import { resetDb, asRole, addUser, asUser, asSuper, superClaims, asService, NOW, WEEK_HOURS } from './support/db.mjs';

import { randomBytes } from 'node:crypto';
const K = () => randomBytes(32).toString('base64url');
const IP = (n) => 'a'.repeat(60) + String(1000 + n);   // IP מגובב (דמה)
const PEPPER = 'test-pepper-0123456789-0123456789';
let ipN = 0;
let sup, ownA, ownB, svc, pub, uSup, uA, uB, uStranger, A, B, sA, sB, vA, vB, stA, stA2, stB;

const book = (over = {}, ip = IP(ipN++)) => pub('rpc_public_book', {
  p: { slug: 'shop-a', service_id: vA, barber_id: stA, date: '2026-10-18', start_min: 600, first_name: 'דני', last_name: 'כהן', phone: '054-123 4567', idempotency_key: K(), ...over },
  p_ip_hash: ip, p_pepper: PEPPER });

test.before(async () => {
  resetDb('platform_test');
  await psql(`insert into templates (key, name, kind, status, theme, labels, default_services, sort) values ('future-template', 'בקרוב', 'booking', 'planned', 'default', '{}', '[]', 99)`, { db: 'platform_test' });   // תבנית שטרם מומשה: חייבת להידחות ביצירת עסק
  uSup = await addUser('root@example.com'); uA = await addUser('a@example.com'); uB = await addUser('b@example.com'); uStranger = await addUser('x@example.com');
  await psql(`insert into platform_users (user_id, role) values ('${uSup}', 'super_admin')`);
  sup = asSuper(uSup, 'root@example.com'); ownA = asUser(uA, 'a@example.com'); ownB = asUser(uB, 'b@example.com'); pub = asService(); svc = pub;
  let r = await sup('rpc_super_create_business', { p: { name: 'מספרה א', slug: 'shop-a', template: 'barbershop', owner_user_id: uA } });
  assert.equal(r.data.ok, true, JSON.stringify(r)); A = r.data.data.id;
  r = await sup('rpc_super_create_business', { p: { name: 'מספרה ב', slug: 'shop-b', template: 'barbershop', owner_user_id: uB } });
  B = r.data.data.id;
  stA = (await ownA('rpc_owner_staff_create', { p_business: null, p: { name: 'יוסי', hours: WEEK_HOURS } })).data.data.id;
  stA2 = (await ownA('rpc_owner_staff_create', { p_business: null, p: { name: 'משה', hours: WEEK_HOURS } })).data.data.id;
  stB = (await ownB('rpc_owner_staff_create', { p_business: null, p: { name: 'בני', hours: WEEK_HOURS } })).data.data.id;
  vA = (await ownA('rpc_owner_services_list', { p_business: null })).data.data.services[0].id;
  vB = (await ownB('rpc_owner_services_list', { p_business: null })).data.data.services[0].id;
});

test('יצירת עסק: Super Admin בלבד; שירותי ברירת מחדל מהתבנית; slug כפול נדחה; תבנית לא זמינה נדחית', async () => {
  const names = (await ownA('rpc_owner_services_list', { p_business: null })).data.data.services.map((s) => s.name);
  assert.deepEqual(names, ['תספורת', 'זקן', 'תספורת + זקן']);
  let r = await ownA('rpc_super_create_business', { p: { name: 'האקר', slug: 'hack-shop', template: 'barbershop', owner_user_id: uStranger } });
  assert.equal(r.httpStatus, 403);
  r = await sup('rpc_super_create_business', { p: { name: 'כפול', slug: 'shop-a', template: 'barbershop', owner_user_id: uStranger } });
  assert.equal(r.data.status, 409);
  r = await sup('rpc_super_create_business', { p: { name: 'קוסמטיקה', slug: 'cosm-1', template: 'future-template', owner_user_id: uStranger } });
  assert.equal(r.data.status, 400); assert.ok(r.data.error.fields.template);
});

test('זמינות אמיתית: ערב שישי ללא שעות, שבת סגור, ראשון 09:00–17:30, עבר ריק, אופק הזמנה', async () => {
  const slots = (d, st = stA) => pub('rpc_public_slots', { p_slug: 'shop-a', p_staff: st, p_service: vA, p_date: d }).then((r) => r.data.data.slots);
  assert.deepEqual(await slots('2026-10-16'), []);
  assert.deepEqual(await slots('2026-10-17'), []);
  const sun = await slots('2026-10-18');
  assert.equal(sun[0], 540); assert.equal(sun.at(-1), 1050);
  assert.deepEqual(await slots('2026-10-15'), []);
  assert.deepEqual(await slots('2026-12-30'), []);                     // מעבר ל-max_days_ahead (30)
  const days = (await pub('rpc_public_days', { p_slug: 'shop-a', p_staff: stA, p_service: vA })).data.data.days;
  assert.equal(days.length, 31); assert.equal(days[0].available, false); assert.equal(days[2].available, true);
  // זמן התראה מינימלי: ביום ראשון 08:50 מקומי (05:50Z) עם notice=30 → השעה הראשונה 09:30 (570)
  const r = await pub('rpc_public_slots', { p_slug: 'shop-a', p_staff: stA, p_service: vA, p_date: '2026-10-18' });
  assert.ok(r.data.ok);
});

test('זמן התראה מינימלי נאכף ביום עצמו', async () => {
  const { rpc } = await import('./support/pg.mjs');
  const r = await rpc('rpc_public_slots', { p_slug: 'shop-a', p_staff: stA, p_service: vA, p_date: '2026-10-18' }, { now: '2026-10-18T05:50:00Z' });   // 08:50 מקומי
  assert.equal(r.data.data.slots[0], 570);
});

let token;
test('הזמנה ללא חשבון: ולידציה בצד DB, הצלחה, האסימון נשמר כ-hash בלבד', async () => {
  let r = await book({ phone: '123' });
  assert.equal(r.data.status, 400); assert.ok(r.data.error.fields.phone);
  r = await book({ first_name: '', last_name: '1' });
  assert.ok(r.data.error.fields.first_name && r.data.error.fields.last_name);
  r = await book({ barber_id: 999999 });
  assert.equal(r.data.ok, false);
  r = await book({ barber_id: stB });                               // איש צוות של עסק אחר
  assert.equal(r.data.ok, false); assert.equal(r.data.status, 400);
  r = await book();
  assert.equal(r.data.ok, true, JSON.stringify(r.data));
  assert.equal(r.data.data.barber_name, 'יוסי'); assert.equal(r.data.data.start_min, 600);
  token = r.data.data.token; assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  const stored = await psql(`select token_hash from appointments where token_hash is not null limit 1`);
  assert.notEqual(stored, token); assert.match(stored, /^[0-9a-f]{64}$/);
  assert.equal(await psql(`select count(*) from appointments where token_hash = '${token}'`), '0');
  // הטוקן לא מופיע בשום עמודה בטבלה
  assert.equal(await psql(`select count(*) from appointments a where a::text like '%${token}%'`), '0');
});

test('מניעת חפיפות: אותה שעה, חפיפה חלקית, ספר אחר מותר', async () => {
  let r = await book({ first_name: 'רון', last_name: 'לוי', phone: '052-7654321' });
  assert.equal(r.data.status, 409); assert.equal(r.data.error.code, 'slot_taken');
  r = await book({ start_min: 615, first_name: 'רון', last_name: 'לוי', phone: '052-7654321' });
  assert.equal(r.data.status, 409);
  r = await book({ barber_id: stA2, first_name: 'רון', last_name: 'לוי', phone: '052-7654321' });
  assert.equal(r.data.ok, true);
});

test('מקביליות: 8 סשנים אמיתיים לאותה שעה → בדיוק אחד מצליח', async () => {
  const rs = await Promise.all([...Array(8).keys()].map((n) =>
    book({ date: '2026-10-19', start_min: 720, phone: `0501234${String(500 + n)}`.slice(0, 10), first_name: 'לקוח', last_name: 'מקביל' })));
  assert.equal(rs.filter((r) => r.data.ok).length, 1, JSON.stringify(rs.map((r) => r.data.status || 201)));
  assert.equal(rs.filter((r) => r.data.status === 409).length, 7);
  assert.equal(await psql(`select count(*) from appointments where date='2026-10-19' and start_min=720 and staff_id=${stA}`), '1');
});

test('מקביליות חופפת (שעות שונות שחופפות): לא נוצרים שני תורים חופפים', async () => {
  const starts = [780, 795, 810, 765, 780, 795];   // שירות 30 ד' – כולם חופפים זה לזה בצורה שרשרתית
  const rs = await Promise.all(starts.map((s, n) => book({ date: '2026-10-19', start_min: s, phone: `0502345${String(600 + n)}`.slice(0, 10), first_name: 'לקוח', last_name: 'חופף' })));
  const rows = (await psql(`select start_min||'-'||end_min from appointments where date='2026-10-19' and staff_id=${stA} and status<>'cancelled' order by start_min`)).split('\n');
  for (let i = 1; i < rows.length; i++) {
    const [, pe] = rows[i - 1].split('-').map(Number); const [cs] = rows[i].split('-').map(Number);
    assert.ok(cs >= pe, 'overlap: ' + rows.join(','));
  }
  assert.ok(rs.some((r) => r.data.ok));
});

test('אילוץ DB עצמאי: גם הכנסה ישירה מעקפת הלוגיקה נדחית (exclusion + FK מורכב)', async () => {
  const bad = await psql(`insert into appointments (business_id, staff_id, service_id, customer_id, date, start_min, end_min, service_name, first_name, last_name)
    select business_id, staff_id, service_id, customer_id, date, start_min + 10, end_min + 10, 'x', 'a', 'b' from appointments where staff_id = ${stA} and date='2026-10-18' and start_min=600`).catch((e) => e);
  assert.match(String(bad.stderr), /23P01/);                          // exclusion_violation
  const cross = await psql(`insert into appointments (business_id, staff_id, service_id, customer_id, date, start_min, end_min, service_name, first_name, last_name)
    select '${B}', staff_id, ${vB}, customer_id, '2026-11-01', 600, 630, 'x', 'a', 'b' from appointments where staff_id = ${stA} limit 1`).catch((e) => e);
  assert.match(String(cross.stderr), /23503/);                        // foreign_key_violation
});

test('RLS: Owner רואה רק את העסק שלו; Super Admin רואה הכול; anon לא רואה כלום', async () => {
  const count = async (role, claims, table) => (await asRole(role, claims, `select count(*) from ${table}`)).out;
  const total = Number(await psql('select count(*) from appointments'));
  assert.ok(total >= 3);
  const ca = { sub: uA }, cb = { sub: uB }, cs = { sub: uSup, ...superClaims() };
  assert.equal(Number(await count('authenticated', ca, 'appointments')), total);        // כל התורים שייכים ל-A
  assert.equal(await count('authenticated', cb, 'appointments'), '0');
  assert.equal(await count('authenticated', cb, 'customers'), '0');
  assert.equal(await count('authenticated', cb, 'staff where business_id = \'' + A + '\''), '0');
  assert.equal(await count('authenticated', ca, 'businesses'), '1');
  assert.equal(await count('authenticated', cs, 'businesses'), '2');
  assert.equal(Number(await count('authenticated', cs, 'appointments')), total);
  assert.equal(await count('authenticated', { sub: uSup }, 'businesses'), '0');        // Super Admin בסשן aal1 (בלי MFA) לא רואה דבר
  for (const t of ['businesses', 'staff', 'services', 'appointments', 'customers', 'leads', 'platform_users', 'rate_limits', 'templates', 'blocks', 'working_hours']) {
    const r = await asRole('anon', null, `select count(*) from ${t}`);
    assert.equal(r.sqlstate, '42501', `anon should not read ${t}`);
  }
  // משתמש מאומת ללא תפקיד פלטפורמה: אפס נתונים
  assert.equal(await count('authenticated', { sub: uStranger }, 'appointments'), '0');
  assert.equal(await count('authenticated', { sub: uStranger }, 'staff'), '0');
  // rate_limits מוגן גם מ-authenticated
  assert.equal((await asRole('authenticated', ca, 'select count(*) from rate_limits')).sqlstate, '42501');
});

test('RLS: כתיבה חוצת-עסקים נחסמת (insert/update/delete ישיר כ-Owner של עסק אחר)', async () => {
  const cb = { sub: uB };
  let r = await asRole('authenticated', cb, `insert into staff (business_id, name) values ('${A}', 'פולש')`);
  assert.equal(r.sqlstate, '42501');                                                      // RLS with-check
  r = await asRole('authenticated', cb, `with u as (update appointments set status = 'cancelled' where business_id = '${A}' returning 1) select count(*) from u`);
  assert.equal(r.out, '0');
  r = await asRole('authenticated', cb, `with d as (delete from staff where business_id = '${A}' returning 1) select count(*) from d`);
  assert.equal(r.out, '0');
  assert.equal(await psql(`select count(*) from staff where business_id = '${A}'`), '2');
  // Owner לא יכול לשייך שירות לצוות של עסק אחר (FK מורכב + RLS)
  r = await asRole('authenticated', cb, `insert into working_hours (staff_id, business_id, weekday, start_min, end_min) values (${stA}, '${B}', 1, 540, 600)`);
  assert.equal(r.ok, false);
});

test('הרשאות עמודה: Owner לא משנה slug/active/template ולא שדות אסימון', async () => {
  const ca = { sub: uA };
  for (const sql of [`update businesses set slug = 'stolen' where id = '${A}'`, `update businesses set active = false where id = '${A}'`,
    `update businesses set template = 'cosmetics' where id = '${A}'`, `update appointments set token_hash = repeat('a', 64)`,
    `update appointments set business_id = '${B}'`, `update appointments set token_uses = 0`, `delete from appointments`, `delete from businesses`,
    `update platform_users set role = 'super_admin'`, `insert into platform_users (user_id, role) values ('${uStranger}', 'super_admin')`,
    `insert into appointments (business_id, staff_id, service_id, customer_id, date, start_min, end_min, service_name, first_name, last_name) values ('${A}', 1, 1, 1, '2026-11-01', 600, 630, 'x', 'a', 'b')`]) {
    const r = await asRole('authenticated', ca, sql);
    assert.equal(r.sqlstate, '42501', sql);
  }
  assert.equal((await asRole('authenticated', ca, `update businesses set name = 'שם חדש' where id = '${A}'`)).ok, true);
});

test('הרשאות פונקציות: anon/authenticated לא קוראים ל-RPC ציבוריים/מנוע; service_role לא קורא ל-RPC מנהלים בלי JWT', async () => {
  const call = (role, claims, name, args = '') => asRole(role, claims, `select public.${name}(${args})`);
  assert.equal((await call('anon', null, 'rpc_public_businesses')).sqlstate, '42501');
  assert.equal((await call('anon', null, 'rpc_me')).sqlstate, '42501');
  assert.equal((await call('authenticated', { sub: uA }, 'rpc_public_businesses')).sqlstate, '42501');
  assert.equal((await call('authenticated', { sub: uA }, 'rpc_admin_export_business', `'${A}'`)).sqlstate, '42501');
  assert.equal((await call('authenticated', { sub: uA }, 'rpc_rate_hit', `'k', 1, 60`)).sqlstate, '42501');
  assert.equal((await asRole('authenticated', { sub: uA }, `select app.create_appointment('${A}', ${stA}, ${vA}, '2026-11-02', 600, 'אאא', 'בבב', '0541112222', 'owner')`)).sqlstate, '42501');
  assert.equal((await asRole('authenticated', { sub: uA }, `select app.slots_for('${B}', ${stB}, '2026-11-02', 30)`)).sqlstate, '42501');
  assert.equal((await asRole('anon', null, `select app.my_business()`)).sqlstate, '42501');
  // service_role ללא JWT של משתמש: אין זהות → forbidden
  assert.equal((await call('service_role', null, 'rpc_owner_dashboard', 'null')).sqlstate, '42501');
});

test('Owner: p_business מתעלמים; כל פעולות ה-Owner פועלות רק על העסק שלו', async () => {
  let r = await ownB('rpc_owner_appointments', { p_business: A, p: { from: '2026-10-18', to: '2026-10-25' } });   // מנסה לצפות ב-A
  assert.equal(r.data.data.appointments.length, 0);
  r = await ownA('rpc_owner_appointments', { p_business: B, p: { from: '2026-10-18', to: '2026-10-25' } });        // A מבקש B → מקבל A
  assert.ok(r.data.data.appointments.length >= 3);
  assert.ok(r.data.data.appointments.every((a) => a.barber_id === stA || a.barber_id === stA2));
  // עדכון סטטוס של תור בעסק אחר
  const aid = r.data.data.appointments[0].id;
  r = await ownB('rpc_owner_appointment_status', { p_business: A, p: { id: aid, status: 'cancelled' } });
  assert.equal(r.data.status, 404);
  r = await ownB('rpc_owner_staff_update', { p_business: A, p: { id: stA, name: 'האקר' } });
  assert.equal(r.data.status, 404);
  r = await ownB('rpc_owner_shop_get', { p_business: A });
  assert.equal(r.data.data.shop.slug, 'shop-b');
  // Super Admin חייב לציין עסק
  r = await sup('rpc_owner_shop_get', { p_business: null }); assert.equal(r.httpStatus, 400);
  r = await sup('rpc_owner_shop_get', { p_business: A }); assert.equal(r.data.data.shop.slug, 'shop-a');
  // זהות ללא תפקיד
  r = await asUser(uStranger, 'x@example.com')('rpc_owner_dashboard', { p_business: A }); assert.equal(r.httpStatus, 403);
  // יצירת תור ידני ע"י Owner: צוות של עסק אחר נדחה
  r = await ownA('rpc_owner_appointment_create', { p_business: null, p: { barber_id: stB, service_id: vA, date: '2026-10-21', start_min: 600, first_name: 'אבי', last_name: 'כהן', phone: '0521112233' } });
  assert.equal(r.data.ok, false);
  r = await ownA('rpc_owner_appointment_create', { p_business: null, p: { barber_id: stA, service_id: vB, date: '2026-10-21', start_min: 600, first_name: 'אבי', last_name: 'כהן', phone: '0521112233' } });
  assert.equal(r.data.ok, false);
  r = await ownA('rpc_owner_appointment_create', { p_business: null, p: { barber_id: stA, service_id: vA, date: '2026-10-21', start_min: 600, first_name: 'אבי', last_name: 'כהן', phone: '0521112233', notes: 'ללא טוקן' } });
  assert.equal(r.data.status, 201); assert.equal(r.data.data.token, undefined);
});

test('יומן Owner: שם, נייד ופרטי תור; לקוחות; לוח בקרה', async () => {
  let r = await ownA('rpc_owner_appointments', { p_business: null, p: { from: '2026-10-18', to: '2026-10-18' } });
  const a = r.data.data.appointments.find((x) => x.start_min === 600 && x.barber_id === stA);
  assert.equal(a.first_name, 'דני'); assert.equal(a.phone, '0541234567'); assert.equal(a.service_name, 'תספורת');
  r = await ownA('rpc_owner_customers', { p_business: null, p: { q: 'דני' } }); assert.equal(r.data.data.customers.length, 1);
  assert.equal((await ownB('rpc_owner_customers', { p_business: null, p: { q: 'דני' } })).data.data.customers.length, 0);
  r = await ownA('rpc_owner_dashboard', { p_business: null }); assert.equal(r.data.ok, true); assert.ok(r.data.data.next7 >= 3);
});

test('החזרת תור מבוטל לפעילות נחסמת כשיש חפיפה (אילוץ DB)', async () => {
  const mk = (st, ph) => ownA('rpc_owner_appointment_create', { p_business: null, p: { barber_id: stA2, service_id: vA, date: '2026-10-26', start_min: st, first_name: 'בדיקה', last_name: 'חפיפה', phone: ph } });
  const a = await mk(600, '0531000001'); assert.equal(a.data.status, 201);
  assert.equal((await ownA('rpc_owner_appointment_status', { p_business: null, p: { id: a.data.data.id, status: 'cancelled' } })).data.ok, true);
  const b = await mk(615, '0531000002'); assert.equal(b.data.status, 201);
  const r = await ownA('rpc_owner_appointment_status', { p_business: null, p: { id: a.data.data.id, status: 'confirmed' } });
  assert.equal(r.data.status, 409); assert.equal(r.data.error.code, 'slot_taken');
});

test('חסימות יומן: חוסמות זמינות; חסימה כללית; מחיקה', async () => {
  let r = await ownA('rpc_owner_block_create', { p_business: null, p: { barber_id: stA, date: '2026-10-22', start_min: 540, end_min: 720, note: 'חופשה' } });
  assert.equal(r.data.status, 201);
  r = await pub('rpc_public_slots', { p_slug: 'shop-a', p_staff: stA, p_service: vA, p_date: '2026-10-22' });
  assert.equal(r.data.data.slots[0], 720);
  r = await ownA('rpc_owner_block_create', { p_business: null, p: { barber_id: stB, date: '2026-10-22', start_min: 540, end_min: 720 } });
  assert.equal(r.data.ok, false);                                                      // צוות של עסק אחר
  const bid = (await ownA('rpc_owner_blocks', { p_business: null, p: { from: '2026-10-22' } })).data.data.blocks[0].id;
  assert.equal((await ownB('rpc_owner_block_delete', { p_business: null, p: { id: bid } })).data.status, 404);
  assert.equal((await ownA('rpc_owner_block_delete', { p_business: null, p: { id: bid } })).data.ok, true);
});

test('קישור אישי: צפייה (נייד מוסתר), שינוי מועד, ביטול, שחרור שעה', async () => {
  const get = (t = token, ip = IP(900)) => pub('rpc_public_token_get', { p_token: t, p_ip_hash: ip });
  let r = await get();
  assert.equal(r.data.ok, true); assert.equal(r.data.data.appointment.phone_masked, '•••••4567'); assert.equal(r.data.data.can_modify, true);
  assert.ok(!JSON.stringify(r.data).includes('0541234567'));
  const resched = (b) => pub('rpc_public_token_reschedule', { p_token: token, p_ip_hash: IP(901), p: b });
  r = await resched({ barber_id: stA, date: '2026-10-18', start_min: 600 }); assert.equal(r.data.ok, true);        // אותה שעה – מוחרג מעצמו
  r = await resched({ barber_id: stB, date: '2026-10-20', start_min: 660 }); assert.equal(r.data.ok, false);       // צוות של עסק אחר
  r = await resched({ barber_id: stA, date: '2026-10-20', start_min: 660 }); assert.equal(r.data.ok, true);
  r = await pub('rpc_public_slots', { p_slug: 'shop-a', p_staff: stA, p_service: vA, p_date: '2026-10-18' });
  assert.ok(r.data.data.slots.includes(600));
  r = await pub('rpc_public_token_cancel', { p_token: token, p_ip_hash: IP(902) }); assert.equal(r.data.ok, true);
  r = await pub('rpc_public_token_cancel', { p_token: token, p_ip_hash: IP(902) }); assert.equal(r.data.status, 409);
  r = await pub('rpc_public_slots', { p_slug: 'shop-a', p_staff: stA, p_service: vA, p_date: '2026-10-20' });
  assert.ok(r.data.data.slots.includes(660));
});

test('אסימון: תפוגה, מגבלת שימוש, חלון ביטול, פורמט, ניחוש מוגבל בקצב', async () => {
  const mkTok = async (date, st, phone) => (await book({ date, start_min: st, phone, first_name: 'טוקן', last_name: 'בדיקה' })).data.data.token;
  // מגבלת 5 שימושים
  const t1 = await mkTok('2026-10-27', 540, '0541000001');
  for (let i = 0; i < 5; i++) {
    const r = await pub('rpc_public_token_reschedule', { p_token: t1, p_ip_hash: IP(910), p: { barber_id: stA, date: '2026-10-27', start_min: 540 + 30 * ((i % 2) + 1) } });
    assert.equal(r.data.ok, true, 'use ' + i);
  }
  let r = await pub('rpc_public_token_reschedule', { p_token: t1, p_ip_hash: IP(910), p: { barber_id: stA, date: '2026-10-27', start_min: 540 } });
  assert.equal(r.data.error.code, 'token_limit');
  assert.equal((await pub('rpc_public_token_get', { p_token: t1, p_ip_hash: IP(910) })).data.data.uses_left, 0);
  // תפוגה: שעתיים אחרי התור
  const { rpc } = await import('./support/pg.mjs');
  const t2 = await mkTok('2026-10-27', 900, '0541000002');
  r = await rpc('rpc_public_token_get', { p_token: t2, p_ip_hash: IP(911) }, { now: '2026-10-27T13:01:00Z' });   // 15:01 מקומי (UTC+2 אחרי חזרה לשעון חורף ב-25/10); התור 15:00–15:30, תפוגה 17:00
  assert.equal(r.data.ok, true);
  r = await rpc('rpc_public_token_get', { p_token: t2, p_ip_hash: IP(911) }, { now: '2026-10-27T15:05:00Z' });   // 17:05 מקומי – אחרי התפוגה
  assert.equal(r.data.status, 404);
  // חלון ביטול: פחות משעתיים לפני התור
  r = await rpc('rpc_public_token_cancel', { p_token: t2, p_ip_hash: IP(912) }, { now: '2026-10-27T11:30:00Z' }); // 13:30 מקומי, התור 15:00 → 90 דק'
  assert.equal(r.data.error.code, 'too_late');
  assert.equal((await rpc('rpc_public_token_get', { p_token: t2, p_ip_hash: IP(912) }, { now: '2026-10-27T11:30:00Z' })).data.data.can_modify, false);
  // פורמט לא תקין ו-hash ידוע אינם מתקבלים
  assert.equal((await pub('rpc_public_token_get', { p_token: 'short', p_ip_hash: IP(913) })).data.status, 404);
  const h = await psql(`select token_hash from appointments where token_hash is not null limit 1`);
  assert.equal((await pub('rpc_public_token_get', { p_token: h, p_ip_hash: IP(914) })).data.status, 404);      // ה-hash עצמו אינו אסימון
  // ניחוש מוגבל בקצב: 10 כשלונות → 429
  let last;
  for (let i = 0; i < 12; i++) last = await pub('rpc_public_token_get', { p_token: 'A'.repeat(43), p_ip_hash: IP(920) });
  assert.equal(last.data.status, 429);
  assert.equal((await pub('rpc_public_token_get', { p_token: t2, p_ip_hash: IP(920) })).data.status, 429);      // גם אסימון תקין חסום ל-IP הזה
  assert.equal((await pub('rpc_public_token_get', { p_token: t2, p_ip_hash: IP(921) })).data.ok, true);          // IP אחר – תקין
});

test('הגבלת קצב משותפת בהזמנות: לפי IP, לפי נייד, ולפי עסק; הספירה נשמרת גם בדחיות', async () => {
  // לפי IP (עסק A): 10 ניסיונות בשעה, כולל כאלה שנדחו על slot_taken
  const ip = IP(930); const sts = [];
  for (let i = 0; i < 12; i++) sts.push((await book({ date: '2026-10-28', start_min: 540, phone: `05412${String(30000 + i)}`, first_name: 'ספאם', last_name: 'בוט' }, ip)).data.status || 201);
  assert.ok(sts.includes(429), sts.join(','));
  assert.equal(sts.filter((s) => s === 429).length, 2);        // 10 עברו (אחד הצליח, 9 נדחו 409), 2 נחסמו
  // לפי נייד: 4 בשעה
  const ph = '0549990001'; const ps = [];
  for (let i = 0; i < 6; i++) ps.push((await book({ date: '2026-10-29', start_min: 540 + 30 * i, phone: ph }, IP(940 + i))).data.status || 201);
  assert.deepEqual(ps.map((s) => s === 429), [false, false, false, true, true, true].map((x, i) => (i < 3 ? false : x)));
  // הספירה ב-DB (משותפת) ואינה שומרת IP/נייד גולמיים
  const keys = await psql(`select string_agg(key, '|') from rate_limits`);
  assert.ok(!keys.includes('0549990001') && !keys.includes(IP(930).slice(0, 20) + 'x'));
  assert.ok(!/05\d{8}/.test(keys), 'phone leaked in rate_limits keys');
  // מכסת עסק: מקדמים את המונה ל-199 ישירות, ואז שתי הזמנות
  await psql(`insert into rate_limits (key, bucket, n, expires_at) values ('book:biz:${A}', floor(extract(epoch from now())/3600), 199, now() + interval '1 hour')
              on conflict (key, bucket) do update set n = 199`);
  const r1 = await book({ date: '2026-10-30', start_min: 540, phone: '0548880001' }, IP(950));
  const r2 = await book({ date: '2026-10-30', start_min: 600, phone: '0548880002' }, IP(951));
  assert.equal(r1.data.ok, true); assert.equal(r2.data.status, 429);
  // מונים אחרים לא מושפעים: עסק B
  const rb = await pub('rpc_public_book', { p: { slug: 'shop-b', service_id: vB, barber_id: stB, date: '2026-10-30', start_min: 540, first_name: 'אבי', last_name: 'בן', phone: '0547770001', idempotency_key: K() }, p_ip_hash: IP(952), p_pepper: PEPPER });
  assert.equal(rb.data.ok, true);
  await psql(`delete from rate_limits where key = 'book:biz:${A}'`);      // מנקים כדי לא להשפיע על בדיקות הבאות
});

test('מגבלת תורים עתידיים פעילים לאותו נייד', async () => {
  const ph = '0509998877'; const out = [];
  for (let i = 0; i < 4; i++) out.push((await book({ date: '2026-11-02', start_min: 540 + 60 * i, phone: ph, barber_id: stA2 }, IP(960 + i))).data);
  assert.deepEqual(out.map((o) => o.ok || o.error.code), [true, true, true, 'too_many_active']);
});

test('פניות (לידים): ולידציה, שמירה, הגבלת קצב, בידוד בין עסקים, סטטוסים', async () => {
  const lead = (over = {}, ip = IP(970)) => pub('rpc_public_submit_lead', { p: { slug: 'shop-a', name: 'מיכל כהן', phone: '052-1234567', message: 'מעוניינת בפרטים', ...over }, p_ip_hash: ip, p_pepper: PEPPER });
  let r = await lead({ phone: 'abc' }); assert.ok(r.data.error.fields.phone);
  r = await lead({ name: '' }); assert.ok(r.data.error.fields.name);
  r = await lead({ message: '<script>alert(1)</script>' }); assert.ok(r.data.error.fields.message);
  r = await lead({ slug: 'nope' }); assert.equal(r.data.status, 404);
  r = await lead(); assert.equal(r.data.ok, true);
  const la = (await ownA('rpc_owner_leads', { p_business: null })).data.data.leads;
  assert.equal(la.length, 1); assert.equal(la[0].phone, '0521234567'); assert.equal(la[0].status, 'new');
  assert.equal((await ownB('rpc_owner_leads', { p_business: null })).data.data.leads.length, 0);
  assert.equal((await ownB('rpc_owner_lead_status', { p_business: null, p: { id: la[0].id, status: 'closed' } })).data.status, 404);
  assert.equal((await ownA('rpc_owner_lead_status', { p_business: null, p: { id: la[0].id, status: 'contacted' } })).data.ok, true);
  let last; for (let i = 0; i < 7; i++) last = await lead({ phone: `05212${String(34000 + i)}` }, IP(971));
  assert.equal(last.data.status, 429);
  assert.equal((await asRole('anon', null, 'select count(*) from leads')).sqlstate, '42501');
});

test('השבתת עסק: Owner מאבד גישה מיידית (גם עם JWT קיים), והזמנות ציבוריות נחסמות; הפעלה מחדש', async () => {
  assert.equal((await ownB('rpc_owner_dashboard', { p_business: null })).data.ok, true);
  assert.equal((await ownB('rpc_super_set_active', { p_business: B, p: { active: false } })).httpStatus, 403);   // Owner לא יכול
  assert.equal((await sup('rpc_super_set_active', { p_business: B, p: { active: false } })).data.ok, true);
  assert.equal((await ownB('rpc_owner_dashboard', { p_business: null })).httpStatus, 403);
  assert.equal((await ownB('rpc_me')).httpStatus, 403);
  assert.equal((await asRole('authenticated', { sub: uB }, 'select count(*) from staff')).out, '0');                 // גם RLS ישיר
  assert.equal((await pub('rpc_public_business', { p_slug: 'shop-b' })).data.status, 404);
  assert.equal((await pub('rpc_public_businesses')).data.data.shops.length, 1);
  assert.equal((await sup('rpc_super_set_active', { p_business: B, p: { active: true } })).data.ok, true);
  assert.equal((await ownB('rpc_owner_dashboard', { p_business: null })).data.ok, true);
});

test('rpc_me: תפקידים ומיפוי shop_owner', async () => {
  let r = await ownA('rpc_me'); assert.equal(r.data.data.user.role, 'shop_owner'); assert.equal(r.data.data.shop.slug, 'shop-a');
  r = await sup('rpc_me'); assert.equal(r.data.data.user.role, 'super_admin'); assert.equal(r.data.data.shop, null);
  assert.equal((await asUser(uStranger, 'x@example.com')('rpc_me')).httpStatus, 403);
});
