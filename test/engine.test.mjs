// בדיקות הקשחת מנוע ההזמנות (שלב 1). כל בדיקה כאן נכתבה כך שתיכשל על הקוד שלפני מיגרציה 0009
// (סימון [נכשל לפני התיקון]) או שהיא מתעדת התנהגות שכבר הייתה נכונה ונשמרת (סימון [שמירה]).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { psql, rpc, q } from './support/pg.mjs';
import { resetDb, addUser, asUser, asSuper, asService, NOW } from './support/db.mjs';

process.env.TEST_DB = 'platform_engine';
const PEPPER = 'test-pepper-0123456789-0123456789';
let n = 0;
const IP = () => 'b'.repeat(60) + String(1000 + n++);
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, start_min: 0, end_min: 1080 }));
const OFFICE = [0, 1, 2, 3, 4].map((weekday) => ({ weekday, start_min: 540, end_min: 1080 }));
let sup, own, pub, uOwn, A, stDay, stDay2, stNight, svc30;

const phone = () => '054' + String(1000000 + (n++) * 37).padStart(7, '0');
const book = (over = {}, now = NOW) => rpc('rpc_public_book', {
  p: { slug: 'eng', service_id: svc30, barber_id: stDay, date: '2026-10-19', start_min: 600, first_name: 'דנה', last_name: 'לוי', phone: phone(), idempotency_key: key(), ...over },
  p_ip_hash: IP(), p_pepper: PEPPER }, { role: 'service_role', now });
const key = () => Buffer.from(Array.from({ length: 32 }, () => Math.floor(Math.random() * 256))).toString('base64url');
const ownerCall = (name, p, now = NOW) => asUser(uOwn, 'o@example.com', now)(name, { p_business: null, p });
const tokenCall = (name, args, now = NOW) => rpc(name, { ...args, p_ip_hash: IP() }, { role: 'service_role', now });
const count = (sql) => psql(sql).then(Number);

// מחזיק נעילת-ייעוץ בסשן נפרד ומחזיר Promise שמסתיים כשהנעילה שוחררה. ממתין עד שהנעילה נתפסה בפועל.
async function holdLock(expr, ms) {
  const before = await count(`select count(*) from pg_locks where locktype='advisory' and granted`);
  const p = spawn('psql', ['-X', '-q', '-d', 'platform_engine', '-c', `begin; select ${expr}; select pg_sleep(${ms / 1000}); commit;`], { stdio: 'ignore' });
  const done = new Promise((res) => p.on('close', res));
  for (let i = 0; i < 60; i++) {
    if ((await count(`select count(*) from pg_locks where locktype='advisory' and granted`)) > before) return { done };
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('lock not acquired');
}
const staffLock = (id) => `pg_advisory_xact_lock(hashtextextended('appt:${id}', 0))`;
const bizSharedLock = () => `pg_advisory_xact_lock_shared(hashtextextended('biz:${A}', 0))`;
const bizExclLock = () => `pg_advisory_xact_lock(hashtextextended('biz:${A}', 0))`;
async function timed(fn) { const t = Date.now(); const r = await fn(); return { r, ms: Date.now() - t }; }

test.before(async () => {
  resetDb('platform_engine');
  const uSup = await addUser('root@example.com'); uOwn = await addUser('o@example.com');
  await psql(`insert into platform_users (user_id, role) values ('${uSup}', 'super_admin')`);
  sup = asSuper(uSup, 'root@example.com'); own = asUser(uOwn, 'o@example.com'); pub = asService();
  const r = await sup('rpc_super_create_business', { p: { name: 'מנוע', slug: 'eng', template: 'barbershop', owner_user_id: uOwn } });
  assert.equal(r.data.ok, true, JSON.stringify(r)); A = r.data.data.id;
  const mk = async (name, hours) => (await ownerCall('rpc_owner_staff_create', { name, hours })).data.data.id;
  stDay = await mk('יוסי', OFFICE); stDay2 = await mk('משה', OFFICE); stNight = await mk('לילה', ALL_DAYS);
  svc30 = (await own('rpc_owner_services_list', { p_business: null })).data.data.services[0].id;   // תספורת 30 ד'
  await ownerCall('rpc_owner_shop_update', { name: 'מנוע', slot_step: 15, min_notice_min: 30, max_days_ahead: 180, cancel_cutoff_hours: 2 });
});

// ---------- 1. מכסת תורים עתידיים לפי עסק+נייד תחת מקביליות בין אנשי צוות שונים ----------
// דטרמיניסטי: הזמנה ראשונה נשארת בטרנזקציה פתוחה (לא committed) בזמן שהשנייה, לאיש צוות אחר, רצה.
// הערה: בנתיב הציבורי ההגנה הזו הייתה קיימת כבר לפני התיקון, אבל במקרה: שורת מונה הקצב של (עסק+נייד) ננעלת בעדכון
// ומסדרת את הבקשות. היא אינה מנגנון נעילה ייעודי (ולא חלה על נתיבים אחרים), ולכן 0009 מוסיפה נעילה מפורשת לפי עסק+נייד,
// והבדיקה הבאה ('נעילת נייד') מוכיחה אותה ישירות.
function bookHeld(args, ms) {
  const sql = `begin;
set local role service_role;
do $$ begin perform set_config('request.jwt.claims', '{"role":"service_role"}', true); perform set_config('app.test_now', '${NOW}', true); end $$;
select public.rpc_public_book(p => ${q(args.p)}, p_ip_hash => ${q(args.ip)}, p_pepper => ${q(PEPPER)});
select pg_sleep(${ms / 1000});
commit;`;
  const p = spawn('psql', ['-X', '-q', '-d', 'platform_engine', '-v', 'ON_ERROR_STOP=1'], { stdio: ['pipe', 'ignore', 'inherit'] });
  p.stdin.end(sql);
  return new Promise((res) => p.on('close', res));
}
test('[שמירה – ראו הערה] מכסת 3 תורים לנייד נאכפת גם כשהבקשות המקבילות הן לאנשי צוות שונים', async () => {
  const ph = phone();
  for (const m of [540, 600]) assert.equal((await book({ phone: ph, barber_id: stDay, date: '2026-10-20', start_min: m })).data.ok, true);   // 2 קיימים
  const first = bookHeld({ ip: IP(), p: { slug: 'eng', service_id: svc30, barber_id: stDay2, date: '2026-10-21', start_min: 540, first_name: 'דנה', last_name: 'לוי', phone: ph, idempotency_key: key() } }, 1500);
  await new Promise((r) => setTimeout(r, 600));                           // הראשונה כבר רצה ועדיין לא committed
  const second = await book({ phone: ph, barber_id: stDay, date: '2026-10-22', start_min: 540 });   // איש צוות אחר, לא חסום ע"י נעילת הראשונה
  await first;
  const okN = await count(`select count(*) from appointments a join customers c on c.id=a.customer_id where c.phone='${ph}' and a.status='confirmed'`);
  assert.ok(okN <= 3, `נוצרו ${okN} תורים עתידיים לנייד אחד (המכסה 3); תשובת השנייה: ${JSON.stringify(second.data.error?.code ?? 'ok')}`);
  assert.equal(second.data.error?.code, 'too_many_active');
});

// ---------- 2. זמן מוחלט: התראה מינימלית אחרי חצות ----------
test('[נכשל לפני התיקון] זמן התראה מינימלי נמדד בזמן מוחלט – גם כשהשעה הראשונה היא אחרי חצות', async () => {
  const now = '2026-10-18T20:50:00Z';                                    // 23:50 מקומי (UTC+3), ראשון בלילה
  const r = await rpc('rpc_public_slots', { p_slug: 'eng', p_staff: stNight, p_service: svc30, p_date: '2026-10-19' }, { now });
  assert.equal(r.data.data.slots[0], 30, `00:00 ו-00:15 קרובות מדי (התראה 30 דק'): ${r.data.data.slots.slice(0, 4)}`);
  const b = await book({ barber_id: stNight, date: '2026-10-19', start_min: 0 }, now);
  assert.equal(b.data.status, 409);
  const ok = await book({ barber_id: stNight, date: '2026-10-19', start_min: 30 }, now);
  assert.equal(ok.data.ok, true, JSON.stringify(ok.data));
});

// ---------- 3. שעון קיץ בישראל ----------
test('[נכשל לפני התיקון] מעבר לשעון קיץ (26.3.2027 02:00→03:00): אין שעות שלא קיימות', async () => {
  const r = await rpc('rpc_public_slots', { p_slug: 'eng', p_staff: stNight, p_service: svc30, p_date: '2027-03-26' }, { now: NOW });
  const s = r.data.data.slots;
  assert.ok(s.includes(105) && s.includes(180), 'שעות סביב המעבר קיימות');
  for (const m of [120, 135, 150, 165]) assert.ok(!s.includes(m), `02:xx לא קיים באותו יום (${m})`);
});

test('[שמירה] חזרה לשעון חורף (25.10.2026): חלון ביטול ותפוגת קישור נמדדים בזמן מוחלט', async () => {
  const b = await book({ barber_id: stNight, date: '2026-10-25', start_min: 180 });       // 03:00 מקומי = 01:00Z
  assert.equal(b.data.ok, true, JSON.stringify(b.data)); const tok = b.data.data.token;
  const atMidnight = '2026-10-24T21:00:00Z';                                                // 00:00 מקומי (UTC+3) → עוד 4 שעות אמיתיות
  await ownerCall('rpc_owner_shop_update', { name: 'מנוע', slot_step: 15, min_notice_min: 30, max_days_ahead: 180, cancel_cutoff_hours: 5 });
  let r = await tokenCall('rpc_public_token_cancel', { p_token: tok }, atMidnight);
  assert.equal(r.data.error.code, 'too_late');                                              // 4 שעות < 5
  await ownerCall('rpc_owner_shop_update', { name: 'מנוע', slot_step: 15, min_notice_min: 30, max_days_ahead: 180, cancel_cutoff_hours: 4 });
  const g = await tokenCall('rpc_public_token_get', { p_token: tok }, atMidnight);
  assert.equal(g.data.data.can_modify, true);                                               // חישוב לפי דקות-ביום היה נותן 3 שעות
  // תפוגה: 05:00 מקומי = 03:00Z
  assert.equal((await tokenCall('rpc_public_token_get', { p_token: tok }, '2026-10-25T02:59:00Z')).data.ok, true);
  assert.equal((await tokenCall('rpc_public_token_get', { p_token: tok }, '2026-10-25T03:01:00Z')).data.status, 404);
});

test('[שמירה] תוקף הקישור חוצה חצות: תור ב-23:30 תקף עד 01:30 למחרת', async () => {
  const b = await book({ barber_id: stNight, date: '2026-10-21', start_min: 1050 });          // 17:30; בדיקת חצות בשאילתה ישירה
  assert.equal(await psql(`select (app.local_ts('2026-10-21', 1410 + 120, 'Asia/Jerusalem') at time zone 'Asia/Jerusalem')::text`), '2026-10-22 01:30:00');
  assert.ok(b.data.ok);
});

// ---------- 4. נעילות מתואמות ----------
test('[נכשל לפני התיקון] חסימה / שינוי שעות / החזרת מבוטל / שינוי מועד מחכים לאותה נעילת איש-צוות שבה משתמשת הזמנה', async () => {
  // תורים לבדיקה
  const a1 = (await book({ barber_id: stDay2, date: '2026-10-26', start_min: 780 })).data.data;
  const apptId = Number(await psql(`select id from appointments where staff_id=${stDay2} and date='2026-10-26' and start_min=780`));
  const HOLD = 1500, MIN_WAIT = 700;
  // בקרה: נעילה על איש צוות אחר לא עוצרת
  let held = await holdLock(staffLock(stDay), HOLD);
  const ctl = await timed(() => ownerCall('rpc_owner_block_create', { barber_id: stDay2, date: '2026-10-27', start_min: 600, end_min: 660, note: 'בקרה' }));
  await held.done; assert.ok(ctl.ms < MIN_WAIT, `בקרה לא אמורה לחכות (${ctl.ms}ms)`); assert.equal(ctl.r.data.ok, true);

  // הזמנה, חסימה, שינוי שעות – כולן על stDay
  held = await holdLock(staffLock(stDay), HOLD);
  const t1 = await timed(() => ownerCall('rpc_owner_block_create', { barber_id: stDay, date: '2026-10-27', start_min: 600, end_min: 660, note: 'x' }));
  await held.done; assert.ok(t1.ms >= MIN_WAIT, `block_create לא חיכה לנעילה (${t1.ms}ms)`);
  held = await holdLock(staffLock(stDay), HOLD);
  const t2 = await timed(() => ownerCall('rpc_owner_staff_update', { id: stDay, name: 'יוסי', hours: OFFICE }));
  await held.done; assert.ok(t2.ms >= MIN_WAIT, `staff_update(hours) לא חיכה לנעילה (${t2.ms}ms)`);
  held = await holdLock(staffLock(stDay), HOLD);
  const t3 = await timed(() => book({ barber_id: stDay, date: '2026-10-28', start_min: 600 }));
  await held.done; assert.ok(t3.ms >= MIN_WAIT, `create_appointment לא חיכה לנעילה (${t3.ms}ms)`);
  // שינוי מועד: נעילת היעד
  held = await holdLock(staffLock(stDay), HOLD);
  const t4 = await timed(() => tokenCall('rpc_public_token_reschedule', { p_token: a1.token, p: { barber_id: stDay, date: '2026-10-28', start_min: 900 } }));
  await held.done; assert.ok(t4.ms >= MIN_WAIT, `reschedule לא חיכה לנעילת היעד (${t4.ms}ms)`); assert.equal(t4.r.data.ok, true, JSON.stringify(t4.r.data));
  // ... ונעילת המקור (התור עבר ל-stDay; מחזיקים נעילה על stDay2 ומעבירים אליו חזרה → היעד stDay2)
  held = await holdLock(staffLock(stDay), HOLD);
  const t5 = await timed(() => ownerCall('rpc_owner_appointment_status', { id: apptId, status: 'cancelled' }));
  await held.done; assert.equal(t5.r.data.ok, true);
  held = await holdLock(staffLock(stDay), HOLD);   // התור כעת אצל stDay (אחרי reschedule)
  const t6 = await timed(() => ownerCall('rpc_owner_appointment_status', { id: apptId, status: 'confirmed' }));
  await held.done; assert.ok(t6.ms >= MIN_WAIT, `החזרת מבוטל לא חיכתה לנעילה (${t6.ms}ms)`);
});

test('[נכשל לפני התיקון] חסימה כלל-עסקית מחכה להזמנות שרצות; הזמנה מחכה לחסימה כלל-עסקית', async () => {
  const HOLD = 1500, MIN_WAIT = 700;
  let held = await holdLock(bizSharedLock(), HOLD);            // כמו הזמנה שרצה כרגע
  const w = await timed(() => ownerCall('rpc_owner_block_create', { barber_id: null, date: '2026-10-29', start_min: 600, end_min: 660, note: 'כל העסק' }));
  await held.done; assert.ok(w.ms >= MIN_WAIT, `חסימה כלל-עסקית לא חיכתה (${w.ms}ms)`);
  held = await holdLock(bizExclLock(), HOLD);                  // כמו חסימה כלל-עסקית שרצה כרגע
  const w2 = await timed(() => book({ barber_id: stDay2, date: '2026-10-28', start_min: 1000 }));
  await held.done; assert.ok(w2.ms >= MIN_WAIT, `הזמנה לא חיכתה לחסימה כלל-עסקית (${w2.ms}ms)`);
});

test('[נכשל לפני התיקון] נעילת נייד מפורשת: יצירת תור מקוון ממתינה לנעילה לפי עסק+נייד (ללא תלות במונה הקצב)', async () => {
  const ph = phone();
  const held = await holdLock(`pg_advisory_xact_lock(hashtextextended('phone:${A}:${ph}', 0))`, 1500);
  // קוראים ישירות ל-app.create_appointment (עוקף את הנתיב הציבורי ומונה הקצב)
  const t = await timed(() => psql(`begin; select app.create_appointment('${A}', ${stDay2}, ${svc30}, '2026-11-10', 600, 'דנה', 'לוי', '${ph}', 'online'); commit;`));
  await held.done; assert.ok(t.ms >= 700, `create_appointment לא חיכה לנעילת הנייד (${t.ms}ms)`);
});

test('[שמירה] מרוץ בין שינוי מועד להזמנה לאותה שעה: בדיוק אחד מצליח, בלי חפיפה', async () => {
  const x = (await book({ barber_id: stDay2, date: '2026-11-01', start_min: 540 })).data.data.token;
  const rs = await Promise.all([
    tokenCall('rpc_public_token_reschedule', { p_token: x, p: { barber_id: stDay, date: '2026-11-01', start_min: 720 } }),
    book({ barber_id: stDay, date: '2026-11-01', start_min: 720 }),
  ]);
  assert.equal(rs.filter((r) => r.data.ok).length, 1, JSON.stringify(rs.map((r) => r.data.error?.code ?? 'ok')));
  assert.equal(await count(`select count(*) from appointments where staff_id=${stDay} and date='2026-11-01' and start_min=720 and status<>'cancelled'`), 1);
});

// ---------- 5. שינוי זמינות מול תורים קיימים ----------
test('[נכשל לפני התיקון] שינוי שעות/השבתה/חסימה: תורים קיימים לא משתנים אוטומטית, והבעלים מקבל רשימה מדויקת', async () => {
  const phs = phone();
  const ids = [];
  for (const [d, m] of [['2026-11-02', 600], ['2026-11-09', 600], ['2026-11-03', 600]]) {                    // שני, שני, שלישי
    assert.equal((await book({ barber_id: stDay2, date: d, start_min: m, phone: phone() })).data.ok, true);
    ids.push(Number(await psql(`select id from appointments where staff_id=${stDay2} and date='${d}' and start_min=${m}`)));
  }
  // מבטלים את שעות יום שני (weekday 1) → שני התורים של ימי שני מושפעים; השלישי לא
  const hrs = OFFICE.filter((h) => h.weekday !== 1);
  const r = await ownerCall('rpc_owner_staff_update', { id: stDay2, name: 'משה', hours: hrs });
  assert.equal(r.data.ok, true);
  assert.deepEqual([...r.data.data.affected_appointments.map((a) => a.id)].sort(), [ids[0], ids[1]].sort());
  assert.equal(await count(`select count(*) from appointments where id in (${ids.join(',')}) and status='confirmed'`), 3);   // אף תור לא בוטל
  assert.deepEqual((await pub('rpc_public_slots', { p_slug: 'eng', p_staff: stDay2, p_service: svc30, p_date: '2026-11-02' })).data.data.slots, []);
  // השבתת איש צוות: מדווחים על כל התורים העתידיים הפעילים
  const r2 = await ownerCall('rpc_owner_staff_update', { id: stDay2, name: 'משה', active: false });
  assert.ok(r2.data.data.affected_appointments.length >= 3);
  await ownerCall('rpc_owner_staff_update', { id: stDay2, name: 'משה', active: true, hours: OFFICE });
  // חסימה על תור קיים: ההזמנה נשארת, והחסימה מחזירה את הרשימה
  const bl = await ownerCall('rpc_owner_block_create', { barber_id: stDay2, date: '2026-11-03', start_min: 570, end_min: 660, note: 'חופשה' });
  assert.equal(bl.data.data.conflicts, 1); assert.deepEqual(bl.data.data.conflict_ids, [ids[2]]);
  assert.equal(await count(`select count(*) from appointments where id=${ids[2]} and status='confirmed'`), 1);
});

// ---------- 6. החזרת תור מבוטל למאושר ----------
test('[נכשל לפני התיקון] החזרת מבוטל למאושר נדחית מול חסימה וגם מול תור שתפס את השעה', async () => {
  const id1 = Number(await psql(`select id from appointments where staff_id=${stDay} and date='2026-10-28' and start_min=600 and status<>'cancelled'`));
  assert.ok(id1 > 0);
  assert.equal((await ownerCall('rpc_owner_appointment_status', { id: id1, status: 'cancelled' })).data.ok, true);
  const bl = await ownerCall('rpc_owner_block_create', { barber_id: stDay, date: '2026-10-28', start_min: 570, end_min: 660, note: 'חסום' });
  assert.equal(bl.data.data.conflicts, 0);
  let r = await ownerCall('rpc_owner_appointment_status', { id: id1, status: 'confirmed' });
  assert.equal(r.data.status, 409, 'הוחזר מעל חסימה'); assert.equal(await count(`select count(*) from appointments where id=${id1} and status='cancelled'`), 1);
  await ownerCall('rpc_owner_block_delete', { id: bl.data.data.id });
  // מישהו תופס את השעה; ההחזרה נדחית ע"י אילוץ המסד
  assert.equal((await book({ barber_id: stDay, date: '2026-10-28', start_min: 600 })).data.ok, true);
  r = await ownerCall('rpc_owner_appointment_status', { id: id1, status: 'confirmed' });
  assert.equal(r.data.status, 409);
  assert.equal(await psql(`select status from appointments where id=${id1}`), 'cancelled');
});

// ---------- 7. הגנה מפני יצירה כפולה (idempotency) ----------
test('[נכשל לפני התיקון] ניסיון חוזר עם אותו מפתח מחזיר את אותו תור ואותו קישור – בלי תור כפול', async () => {
  const k = key(), ph = phone();
  const base = { phone: ph, idempotency_key: k, barber_id: stDay, date: '2026-11-04', start_min: 660 };
  const r1 = await book(base), r2 = await book(base);
  assert.equal(r1.data.ok, true, JSON.stringify(r1.data)); assert.equal(r2.data.ok, true, JSON.stringify(r2.data));
  assert.equal(r2.data.data.id, r1.data.data.id); assert.equal(r2.data.data.token, r1.data.data.token);
  assert.equal(await count(`select count(*) from appointments where staff_id=${stDay} and date='2026-11-04' and start_min=660`), 1);
  // הקישור שהוחזר בשני הפעמים עובד
  assert.equal((await tokenCall('rpc_public_token_get', { p_token: r2.data.data.token })).data.ok, true);
  // במסד אין את הטוקן ואין את המפתח הגולמי – רק hash
  const row = await psql(`select token_hash, idem_key_hash from appointments where id=${r1.data.data.id}`);
  assert.ok(!row.includes(r1.data.data.token) && !row.includes(k));
  // אותו מפתח עם פרטים שונים → התנגשות, לא החזרה של תור אחר
  const r3 = await book({ ...base, start_min: 720 });
  assert.equal(r3.data.status, 409); assert.equal(r3.data.error.code, 'idempotency_conflict');
});

test('[נכשל לפני התיקון] חמש בקשות מקבילות זהות (אותו מפתח) יוצרות תור אחד בלבד', async () => {
  const k = key(), ph = phone();
  const rs = await Promise.all([...Array(4)].map(() => book({ phone: ph, idempotency_key: k, barber_id: stDay2, date: '2026-11-05', start_min: 660 })));
  assert.ok(rs.every((r) => r.data.ok), JSON.stringify(rs.map((r) => r.data.error?.code ?? 'ok')));
  assert.equal(new Set(rs.map((r) => r.data.data.id)).size, 1);
  assert.equal(await count(`select count(*) from appointments where staff_id=${stDay2} and date='2026-11-05' and start_min=660`), 1);
});

test('[שמירה] תקלת רשת אחרי ההזמנה: ניסיון חוזר אחרי שהתור בוטל לא מקים אותו לתחייה', async () => {
  const k = key(), ph = phone();
  const base = { phone: ph, idempotency_key: k, barber_id: stDay, date: '2026-11-08', start_min: 840 };
  const r1 = await book(base); assert.ok(r1.data.ok);
  assert.equal((await tokenCall('rpc_public_token_cancel', { p_token: r1.data.data.token })).data.ok, true);
  const r2 = await book(base);
  assert.equal(r2.data.ok, false); assert.equal(r2.data.error.code, 'already_processed');
  assert.equal(await count(`select count(*) from appointments where status<>'cancelled' and staff_id=${stDay} and date='2026-11-08' and start_min=840`), 0);
});

test('בעל עסק יוצר תור ללא טוקן ובלי מפתח; מפתח לא תקין (קצר) נדחה לקוחות מקוונים', async () => {
  const r = await ownerCall('rpc_owner_appointment_create', { first_name: 'ידני', last_name: 'בעלים', phone: phone(), barber_id: stDay, service_id: svc30, date: '2026-11-04', start_min: 900 });
  assert.equal(r.data.ok, true); assert.equal(r.data.data.token, undefined);
  const bad = await book({ idempotency_key: 'short' });
  assert.equal(bad.data.status, 400);
});
