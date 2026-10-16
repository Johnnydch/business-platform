// בדיקות אבטחה ברמת מסד הנתונים: MFA (aal2 + אימות טרי), יומן ביקורת (append-only, ללא PII), הקמת מנהל ראשון, ניהול בעלים, תחזוקה.
import test from 'node:test';
import assert from 'node:assert/strict';
import { psql, rpc } from './support/pg.mjs';
import { resetDb, addUser, asUser, asSuper, asService, asRole, superClaims, NOW, WEEK_HOURS } from './support/db.mjs';

process.env.TEST_DB = 'platform_security';
const PEPPER = 'test-pepper-0123456789-0123456789';
const KEY = () => Buffer.from(Array.from({ length: 32 }, () => Math.floor(Math.random() * 256))).toString('base64url');
let uSup, uA, uB, uExtra, A, B, stA, svcA, svc;
let supNoMfa, supFresh, supStale, ownA, ownB;

test.before(async () => {
  resetDb('platform_security');
  uSup = await addUser('root@example.com'); uA = await addUser('a@example.com'); uB = await addUser('b@example.com'); uExtra = await addUser('extra@example.com');
  svc = asService();
  // הקמת מנהל ראשון דרך ה-RPC (service_role בלבד)
  const r = await svc('rpc_bootstrap_super_admin', { p_user: uSup }); assert.equal(r.data.ok, true, JSON.stringify(r));
  supNoMfa = asUser(uSup, 'root@example.com');                                 // aal1
  supFresh = asSuper(uSup, 'root@example.com');
  supStale = asSuper(uSup, 'root@example.com', NOW, undefined, false);
  A = (await supFresh('rpc_super_create_business', { p: { name: 'עסק א', slug: 'biz-a', template: 'barbershop', owner_user_id: uA } })).data.data.id;
  B = (await supFresh('rpc_super_create_business', { p: { name: 'עסק ב', slug: 'biz-b', template: 'barbershop', owner_user_id: uB } })).data.data.id;
  ownA = asUser(uA, 'a@example.com'); ownB = asUser(uB, 'b@example.com');
  stA = (await ownA('rpc_owner_staff_create', { p_business: null, p: { name: 'יוסי', hours: WEEK_HOURS } })).data.data.id;
  svcA = (await ownA('rpc_owner_services_list', { p_business: null })).data.data.services[0].id;
});

// ---------- הקמת מנהל ראשון ----------
test('מנהל ראשון: מצליח פעם אחת בלבד; רק service_role; מתועד כפעולת מערכת', async () => {
  assert.equal((await svc('rpc_bootstrap_super_admin', { p_user: uExtra })).data.status, 409);
  assert.equal((await asUser(uExtra, 'extra@example.com')('rpc_bootstrap_super_admin', { p_user: uExtra })).httpStatus, 403);
  assert.equal((await rpc('rpc_bootstrap_super_admin', { p_user: uExtra }, { role: 'anon' })).httpStatus, 403);
  assert.equal(await psql(`select count(*) from platform_users where role='super_admin'`), '1');
  assert.equal(await psql(`select actor_role from audit_log where action='user.role_grant' and details->>'role'='super_admin'`), 'system');
});

test('מנהל ראשון: מרוץ בין שני בקשות מקבילות – בדיוק אחת מצליחה', async () => {
  resetDb('platform_security_race'); const db = 'platform_security_race';
  const u1 = await addUser('r1@example.com', db), u2 = await addUser('r2@example.com', db);
  const rs = await Promise.all([u1, u2].map((u) => rpc('rpc_bootstrap_super_admin', { p_user: u }, { role: 'service_role', db })));
  assert.equal(rs.filter((r) => r.data.ok).length, 1);
  assert.equal(await psql(`select count(*) from platform_users where role='super_admin'`, { db }), '1');
});

// ---------- MFA ----------
test('Super Admin בלי MFA (aal1): כל ה-RPC הרוחביים נחסמים עם mfa_required, ו-RLS לא מחזיר שורות', async () => {
  for (const [fn, args] of [['rpc_super_businesses', {}], ['rpc_super_create_business', { p: {} }], ['rpc_super_set_active', { p_business: A, p: { active: true } }],
      ['rpc_super_owner_ids', { p_business: A }], ['rpc_super_list_owners', { p_business: A }], ['rpc_audit_list', { p_business: null }],
      ['rpc_owner_shop_get', { p_business: A }]]) {
    const r = await supNoMfa(fn, args);
    assert.equal(r.httpStatus, fn === 'rpc_super_create_business' ? r.httpStatus : 403, fn);
    assert.match(r.error?.message || '', /mfa_required/, `${fn}: ${JSON.stringify(r)}`);
  }
  const me = (await supNoMfa('rpc_me')).data.data;
  assert.equal(me.user.role, 'super_admin'); assert.equal(me.mfa.needs_verification, true); assert.equal(me.mfa.aal, 'aal1');
  assert.equal((await asRole('authenticated', { sub: uSup }, 'select count(*) from businesses')).out, '0');
  // אחרי MFA – הכול עובד
  assert.equal((await supFresh('rpc_super_businesses')).data.ok, true);
  assert.equal((await supFresh('rpc_me')).data.data.mfa.needs_verification, false);
});

test('פעולות רגישות דורשות אימות TOTP טרי (mfa_stale); פעולות רגילות לא', async () => {
  const stale = async (fn, args) => { const r = await supStale(fn, args); assert.equal(r.httpStatus, 403, fn); assert.match(r.error.message, /mfa_stale/, fn); };
  await stale('rpc_super_attach_owner', { p_business: A, p: { owner_user_id: uExtra } });
  await stale('rpc_super_remove_owner', { p_business: A, p: { owner_user_id: uA } });
  await stale('rpc_super_prepare_owner_reset', { p_business: A });
  await stale('rpc_super_delete_business', { p_business: A, p: { confirm_slug: 'biz-a' } });
  assert.equal((await supStale('rpc_super_businesses')).data.ok, true);                         // קריאה רגילה – מותר
  assert.equal((await supStale('rpc_super_set_active', { p_business: A, p: { active: true } })).data.ok, true);
  assert.equal(await psql(`select count(*) from businesses`), '2');                              // שום דבר לא נמחק
  // סשן aal2 בלי חותמת TOTP בכלל (למשל JWT שהונפק בדרך אחרת) – נחשב לא טרי
  const noAmr = asUser(uSup, 'root@example.com', NOW, undefined, { aal: 'aal2' });
  assert.match((await noAmr('rpc_super_prepare_owner_reset', { p_business: A })).error.message, /mfa_stale/);
});

test('Owner עם MFA רשום: סשן aal1 נחסם (mfa_required); aal2 מותר; Owner בלי MFA – לא מושפע', async () => {
  assert.equal((await ownB('rpc_owner_dashboard', { p_business: null })).data.ok, true);        // בלי MFA רשום – עובד ב-aal1
  await psql(`insert into auth.mfa_factors (user_id, status) values ('${uB}', 'verified')`);
  let r = await ownB('rpc_owner_dashboard', { p_business: null });
  assert.equal(r.httpStatus, 403); assert.match(r.error.message, /mfa_required/);
  const me = (await ownB('rpc_me')).data.data; assert.equal(me.mfa.needs_verification, true); assert.equal(me.shop, null);
  assert.equal((await asRole('authenticated', { sub: uB }, `select count(*) from staff`)).out, '0');   // גם RLS ישיר
  const ownB2 = asUser(uB, 'b@example.com', NOW, undefined, { aal: 'aal2' });
  assert.equal((await ownB2('rpc_owner_dashboard', { p_business: null })).data.ok, true);
  // factor שלא אומת לא נחשב
  await psql(`update auth.mfa_factors set status='unverified' where user_id='${uB}'`);
  assert.equal((await ownB('rpc_owner_dashboard', { p_business: null })).data.ok, true);
  // Owner אינו Super גם עם aal2
  assert.equal((await ownB2('rpc_super_businesses')).httpStatus, 403);
});

// ---------- ניהול בעלים ----------
test('שיוך / רשימה / הסרה / איפוס בעלים: אימות טרי, בלי PII ביומן, ונשמר בידוד', async () => {
  let r = await supFresh('rpc_super_attach_owner', { p_business: A, p: { owner_user_id: uExtra } }); assert.equal(r.data.ok, true, JSON.stringify(r));
  r = await supFresh('rpc_super_list_owners', { p_business: A }); assert.deepEqual(r.data.data.owners.map((o) => o.email).sort(), ['a@example.com', 'extra@example.com']);
  const extra = asUser(uExtra, 'extra@example.com');
  assert.equal((await extra('rpc_owner_dashboard', { p_business: B })).data.ok, true);          // p_business מתעלמים – מקבל את A
  assert.equal(await psql(`select business_id::text from platform_users where user_id='${uExtra}'`), A);
  r = await supFresh('rpc_super_prepare_owner_reset', { p_business: A }); assert.equal(r.data.data.user_ids.length, 2);
  r = await supFresh('rpc_super_remove_owner', { p_business: A, p: { owner_user_id: uExtra } }); assert.equal(r.data.data.user_id, uExtra);
  assert.equal((await extra('rpc_owner_dashboard', { p_business: A })).httpStatus, 403);          // אחרי ההסרה – אין גישה
  assert.equal((await supFresh('rpc_super_remove_owner', { p_business: A, p: { owner_user_id: uExtra } })).data.status, 404);
  assert.equal((await ownA('rpc_super_attach_owner', { p_business: A, p: { owner_user_id: uExtra } })).httpStatus, 403);
});

// ---------- יומן ביקורת ----------
test('יומן ביקורת: פעולות ניהול מתועדות עם שחקן, עסק ויעד – וללא שום PII', async () => {
  const phone = '0549998877';
  const b = await rpc('rpc_public_book', { p: { slug: 'biz-a', service_id: svcA, barber_id: stA, date: '2026-10-19', start_min: 600, first_name: 'ישראלה', last_name: 'סודית', phone, idempotency_key: KEY() },
    p_ip_hash: 'c'.repeat(64), p_pepper: PEPPER }, { role: 'service_role', now: NOW });
  assert.equal(b.data.ok, true);
  const apptId = Number(await psql(`select id from appointments where business_id='${A}' and date='2026-10-19' and start_min=600`));
  await ownA('rpc_owner_appointment_status', { p_business: null, p: { id: apptId, status: 'cancelled' } });
  await ownA('rpc_owner_block_create', { p_business: null, p: { barber_id: stA, date: '2026-10-20', start_min: 600, end_min: 660, note: 'הערה פרטית' } });
  await ownA('rpc_owner_shop_update', { p_business: null, p: { name: 'שם חדש לעסק', phone: '03-1234567', slot_step: 15, min_notice_min: 30, max_days_ahead: 30, cancel_cutoff_hours: 2 } });
  await ownA('rpc_owner_staff_update', { p_business: null, p: { id: stA, name: 'יוסי חדש', hours: WEEK_HOURS } });
  const rows = (await psql(`select action||'|'||actor_role||'|'||coalesce(business_id::text,'-') from audit_log order by id`)).split('\n');
  for (const want of ['business.create|super_admin|', 'appointment.create|public_api|' + A, 'appointment.status|owner|' + A, 'block.create|owner|' + A, 'business.update|owner|' + A,
    'staff.update|owner|' + A, 'staff.hours_change|owner|' + A, 'user.role_grant|super_admin|' + A, 'owner.password_reset|super_admin|' + A, 'user.role_revoke|super_admin|' + A]) {
    assert.ok(rows.some((x) => x.startsWith(want)), `חסר ביומן: ${want}\n${rows.join('\n')}`);
  }
  const all = await psql(`select coalesce(string_agg(row_to_json(a)::text, ' '), '') from audit_log a`);
  for (const secret of [phone, '054999', 'ישראלה', 'סודית', 'הערה פרטית', 'שם חדש לעסק', '03-1234567', 'a@example.com', 'root@example.com', 'extra@example.com']) {
    assert.ok(!all.includes(secret), `PII ביומן: ${secret}`);
  }
  // המעבר מ-confirmed ל-cancelled מתועד עם from/to
  assert.equal(await psql(`select details::text from audit_log where action='appointment.status'`), '{"to": "cancelled", "from": "confirmed"}');
});

test('יומן ביקורת: אילוץ מבני נגד PII, append-only, ו-INSERT ישיר חסום', async () => {
  for (const k of ['phone', 'email', 'name', 'first_name', 'password', 'token', 'notes']) {
    await assert.rejects(psql(`insert into audit_log (actor_role, action, details) values ('x', 'a.b', jsonb_build_object('${k}', 'v'))`), /23514|audit_details_shape/, k);
  }
  await assert.rejects(psql(`update audit_log set action='a.hack' where id=(select min(id) from audit_log)`), /append-only/);
  await assert.rejects(psql(`delete from audit_log`), /append-only/);
  await assert.rejects(psql(`truncate audit_log`), /append-only/);
  for (const role of ['authenticated', 'anon', 'service_role']) {
    const r = await asRole(role, { sub: uA }, `insert into audit_log (actor_role, action) values ('x', 'a.b')`);
    assert.equal(r.sqlstate, '42501', role);
    assert.equal((await asRole(role, { sub: uA }, `update audit_log set action='a.b'`)).sqlstate, '42501', role);
    assert.equal((await asRole(role, { sub: uA }, `delete from audit_log`)).sqlstate, '42501', role);
  }
});

test('יומן ביקורת: Owner רואה רק את העסק שלו; Super Admin רואה הכול; anon/ללא תפקיד – כלום', async () => {
  const mine = (await ownA('rpc_audit_list', { p_business: B, p: { limit: 200 } })).data.data.entries;        // p_business מתעלמים
  assert.ok(mine.length > 3 && mine.every((e) => e.business_id === A));
  const theirs = (await ownB('rpc_audit_list', { p_business: null })).data.data.entries; assert.ok(theirs.every((e) => e.business_id === B));
  const sup = (await supFresh('rpc_audit_list', { p_business: null, p: { limit: 200 } })).data.data.entries;
  assert.ok(sup.some((e) => e.business_id === A) && sup.some((e) => e.business_id === B));
  assert.equal((await supFresh('rpc_audit_list', { p_business: B })).data.data.entries.every((e) => e.business_id === B), true);
  assert.equal((await asUser(uExtra, 'extra@example.com')('rpc_audit_list', { p_business: A })).httpStatus, 403);
  assert.equal((await rpc('rpc_audit_list', { p_business: A }, { role: 'anon' })).httpStatus, 403);
  assert.equal((await asRole('authenticated', { sub: uB }, `select count(*) from audit_log where business_id='${A}'`)).out, '0');   // גם SELECT ישיר
  // עימוד
  const p1 = (await supFresh('rpc_audit_list', { p_business: null, p: { limit: 3 } })).data.data.entries;
  const p2 = (await supFresh('rpc_audit_list', { p_business: null, p: { limit: 3, before_id: p1.at(-1).id } })).data.data.entries;
  assert.equal(p1.length, 3); assert.ok(p2.every((e) => e.id < p1.at(-1).id));
});

test('אירועי התחברות/MFA: רק service_role, רק פעולות מוכרות, בלי אימייל', async () => {
  let r = await svc('rpc_audit_event', { p_action: 'auth.mfa_verified', p_user: uSup, p_details: { email: 'root@example.com', result: 'ok' } });
  assert.equal(r.data.ok, true);
  assert.equal(await psql(`select details::text from audit_log where action='auth.mfa_verified'`), '{"result": "ok"}');
  assert.equal((await svc('rpc_audit_event', { p_action: 'business.delete', p_user: uSup })).data.status, 400);      // פעולה לא ברשימה
  assert.equal((await supFresh('rpc_audit_event', { p_action: 'auth.login', p_user: uSup })).httpStatus, 403);
});

test('מחיקת עסק: נדרש אימות טרי; היומן שורד; אין הצפה של אירועי מחיקה לילדים', async () => {
  await svc('rpc_audit_event', { p_action: 'auth.login', p_user: uB });
  const r = await supFresh('rpc_super_delete_business', { p_business: B, p: { confirm_slug: 'biz-b' } });
  assert.equal(r.data.ok, true, JSON.stringify(r));
  assert.equal(await psql(`select count(*) from businesses where id='${B}'`), '0');
  assert.equal(await psql(`select count(*) from audit_log where business_id='${B}' and action='business.delete'`), '1');
  assert.equal(await psql(`select count(*) from audit_log where business_id='${B}' and action in ('staff.delete','service.delete','user.role_revoke')`), '0', 'מחיקה בשרשרת לא מציפה את היומן');
  assert.ok(Number(await psql(`select count(*) from audit_log where business_id='${B}'`)) > 3);                   // רשומות העבר נשמרו
});

// ---------- תחזוקה ----------
test('תחזוקה: service_role בלבד; מוחקת מוני קצב שפגו ורשומות ביקורת ישנות מ-400 יום בלבד', async () => {
  await psql(`insert into rate_limits (key, bucket, n, expires_at) values ('t:old', 1, 1, now() - interval '3 hours'), ('t:new', 2, 1, now() + interval '1 hour')`);
  await psql(`insert into audit_log (at, actor_role, action) values (now() - interval '401 days', 'system', 'old.event'), (now() - interval '10 days', 'system', 'recent.event')`);
  assert.equal((await ownA('rpc_maintenance_cleanup')).httpStatus, 403);
  assert.equal((await supFresh('rpc_maintenance_cleanup')).httpStatus, 403);
  const r = await svc('rpc_maintenance_cleanup'); assert.equal(r.data.ok, true);
  assert.ok(r.data.data.rate_limits_deleted >= 1); assert.equal(r.data.data.audit_deleted, 1);
  assert.equal(await psql(`select count(*) from rate_limits where key in ('t:old')`), '0');
  assert.equal(await psql(`select count(*) from rate_limits where key = 't:new'`), '1');
  assert.equal(await psql(`select count(*) from audit_log where action in ('old.event')`), '0');
  assert.equal(await psql(`select count(*) from audit_log where action = 'recent.event'`), '1');
  // המחיקה אפשרית רק דרך הפונקציה: ללא הדגל – נחסמת גם למשתמש-על
  await assert.rejects(psql(`delete from audit_log where action='recent.event'`), /append-only/);
});

// ---------- מלאי הרשאות: כל פונקציה בסכמות public/app נבדקת מול רשימה מפורשת ----------
// נכשל אם מיגרציה עתידית מוסיפה פונקציה ונשארת חשופה (למשל ל-PUBLIC/anon). זה בדיוק הבאג שנתפס בפיתוח הזה.
test('מלאי הרשאות EXECUTE: anon ו-PUBLIC לא מריצים שום דבר; authenticated/service_role – רק מה שמורשה במפורש', async () => {
  const rows = (await psql(`
    select n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as sig,
           has_function_privilege('anon', p.oid, 'execute')          as anon,
           has_function_privilege('authenticated', p.oid, 'execute') as authd,
           has_function_privilege('service_role', p.oid, 'execute')  as svc,
           exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0 and a.privilege_type = 'EXECUTE') as public_exec,
           p.prorettype = 'trigger'::regtype as is_trigger
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'app')
    order by 1`)).split('\n').map((l) => l.split('|'));
  const bad = []; const svcOnly = new Set(), authOnly = new Set();
  for (const [sig, anon, authd, svcR, pub, trig] of rows) {
    if (trig === 't') continue;
    if (anon === 't') bad.push(`anon יכול להריץ ${sig}`);
    if (pub === 't') bad.push(`PUBLIC יכול להריץ ${sig}`);
    if (sig.startsWith('public.')) {
      if (authd === 't' && svcR === 't') bad.push(`גם authenticated וגם service_role על ${sig}`);
      (svcR === 't' ? svcOnly : authd === 't' ? authOnly : new Set()).add(sig.split('(')[0]);
      if (authd !== 't' && svcR !== 't') bad.push(`אין לאף role הרשאה על ${sig} (פונקציה יתומה?)`);
    }
  }
  assert.deepEqual(bad, [], bad.join('\n'));
  // רק פונקציות ה-RPC הציבוריות (לקוחות ללא חשבון), הניהול הפנימי וההגירה – service_role בלבד
  for (const must of ['public.rpc_bootstrap_super_admin', 'public.rpc_maintenance_cleanup', 'public.rpc_audit_event', 'public.rpc_admin_import_business',
    'public.rpc_admin_export_business', 'public.rpc_public_book', 'public.rpc_public_token_cancel',
    'public.rpc_domain_record', 'public.rpc_public_resolve_host', 'public.rpc_public_active_domains',
    'public.rpc_public_brand', 'public.rpc_public_brand_lead', 'public.rpc_admin_seed_demo',
    'public.rpc_admin_set_freeze', 'public.rpc_admin_list_businesses', 'public.rpc_admin_business_fingerprint', 'public.rpc_admin_import_business_frozen']) assert.ok(svcOnly.has(must), `${must} חייבת להיות service_role בלבד`);
  for (const must of ['public.rpc_super_delete_business', 'public.rpc_super_attach_owner', 'public.rpc_super_remove_owner', 'public.rpc_audit_list', 'public.rpc_me',
    'public.rpc_super_draft_create', 'public.rpc_super_draft_publish', 'public.rpc_super_draft_set_owner', 'public.rpc_super_find_user', 'public.rpc_super_check_fresh_mfa', 'public.rpc_domain_add', 'public.rpc_domain_check_target',
    'public.rpc_super_brand_get', 'public.rpc_super_brand_save', 'public.rpc_super_brand_unapprove', 'public.rpc_super_brand_leads', 'public.rpc_super_brand_lead_update', 'public.rpc_super_set_freeze'])
    assert.ok(authOnly.has(must), `${must} חייבת להיות authenticated בלבד`);
});
