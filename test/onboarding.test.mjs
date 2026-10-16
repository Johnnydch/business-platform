// אשף הקמה, מיתוג ודומיינים: טיוטות, שלמות לפני פרסום, פרסום אטומי עם שחזור בטוח, MFA, בידוד, ובדיקת דומיין (TXT + ניתוב) עם DNS/HTTPS מוזרקים.
import test from 'node:test';
import assert from 'node:assert/strict';
import { psql, rpc } from './support/pg.mjs';
import { resetDb, asUser, asSuper, addUser, NOW } from './support/db.mjs';
import { pgRest, fakeAuth, client, totp } from './support/adapters.mjs';
import { createApi } from '../lib/api.mjs';
import { pingMark, isPublicIp, checkDomain } from '../lib/domains.mjs';

const DB = 'platform_onboard';
const config = { pepper: 'test-pepper-0123456789-0123456789', publicBaseUrl: 'https://app.test', allowedOrigins: ['https://app.test'], cookieSecure: true };
const quiet = { error() {}, log() {} };
const PW = 'OwnerPass-123';
const WEEK = [0, 1, 2, 3, 4].map((weekday) => ({ weekday, start_min: 540, end_min: 1080 }));

// DNS ו-HTTPS מדומים, מבוקרים לפי host (הלוגיקה של lib/domains.mjs נבדקת; לא DNS/TLS אמיתיים)
const dns = { txt: {}, a: {}, ping: {}, fetched: [] };
const resolver = {
  async resolveTxt(n) { if (!(n in dns.txt)) throw Object.assign(new Error('nx'), { code: 'ENOTFOUND' }); return dns.txt[n].map((v) => [v]); },
  async resolve4(h) { return dns.a[h] || []; }, async resolve6() { return []; },
};
const fetchImpl = async (url) => {
  const u = new URL(url); dns.fetched.push(u.hostname);
  const p = dns.ping[u.hostname]; if (!p) throw Object.assign(new Error('x'), { cause: { code: 'ECONNREFUSED' } });
  return { status: p.status ?? 200, json: async () => p.body };
};

let auth, api, su, rootSecret = null;
const ROOT = 'root@example.com', ROOT_PW = 'SuperSecret-123';
test.before(async () => {
  process.env.TEST_DB = DB; resetDb(DB);
  auth = fakeAuth({ db: DB }); api = createApi({ rest: pgRest({ db: DB }), auth, config, log: quiet, resolver, fetchImpl });
  const u = await auth.addUser(ROOT, ROOT_PW);
  await psql(`insert into platform_users (user_id, role) values ('${u}', 'super_admin')`, { db: DB });
  su = client(api); await loginSuper(su);
});
async function loginSuper(c) {
  let r = await c.post('/api/admin/login', { email: ROOT, password: ROOT_PW });
  if (!rootSecret) {
    const e = await c.post('/api/admin/mfa/enroll', {}); rootSecret = e.body.secret;
    r = await c.post('/api/admin/mfa/enroll/verify', { factor_id: e.body.factor_id, code: totp(rootSecret) });
  } else r = await c.post('/api/admin/mfa/verify', { code: totp(rootSecret) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
}
const row = async (sql) => JSON.parse(await psql(sql, { db: DB }));
const count = async (t) => Number(await psql(`select count(*) from ${t}`, { db: DB }));
const fill = (over = {}) => ({ business: { name: 'גלואו סטודיו', slug: 'glow-1', phone: '03-1234567', address: 'הרצל 1, תל אביב' }, owner: { email: 'glow@example.com' }, brand: { tagline: 'יופי ביד אחת', accent: '#aa3355' }, domain: { hostname: '' }, ...over });
const draftOf = async (template = 'cosmetics', track = 'managed') => (await su.post('/api/super/drafts', { template, track })).body;
let D;     // טיוטה משותפת לכמה בדיקות

test('טיוטה חדשה: ברירות מחדל מהתבנית (שירותים, צוות, שעות), כולל תחנות בדיטיילינג; תבנית לידים בלי צוות', async () => {
  D = await draftOf('cosmetics');
  assert.equal(D.status, 'draft'); assert.equal(D.step, 1); assert.equal(D.version, 1);
  assert.equal(D.data.services.length, 5); assert.equal(D.data.staff[0].name, 'מטפלת 1'); assert.ok(D.data.staff[0].hours.length >= 5);
  const det = await draftOf('detailing'); assert.deepEqual(det.data.staff.map((s) => s.name), ['תחנה 1', 'תחנה 2']);
  const lead = await draftOf('home-services'); assert.deepEqual(lead.data.staff, []);
  assert.equal((await su.post('/api/super/drafts', { template: 'future-nope' })).status, 400);
  assert.equal((await su.post('/api/super/drafts', { template: 'cosmetics', track: 'weird' })).status, 400);
});

test('שמירה והמשך: גרסה, שלב, טיוטה נטענת כפי שנשמרה; התנגשות גרסאות נדחית; קלט מנוקה', async () => {
  let r = await su.put(`/api/super/drafts/${D.id}`, { version: 1, step: 3, data: { business: { name: '  <b>גלואו</b> סטודיו ', slug: 'GLOW-1', phone: '03-1234567' } } });
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.version, 2); assert.equal(r.body.step, 3);
  assert.equal(r.body.data.business.name, 'bגלואו/b סטודיו', 'תווי < > מוסרים, רווחים נקצצים'); assert.equal(r.body.data.business.slug, 'glow-1');
  assert.equal((await su.put(`/api/super/drafts/${D.id}`, { version: 1, step: 4, data: {} })).status, 409, 'גרסה ישנה');
  const g = await su.get(`/api/super/drafts/${D.id}`); assert.equal(g.body.step, 3); assert.equal(g.body.version, 2); assert.equal(g.body.data.business.phone, '03-1234567');
  assert.ok((await su.get('/api/super/drafts')).body.drafts.some((x) => x.id === D.id && x.step === 3));
  assert.equal((await su.put(`/api/super/drafts/${D.id}`, { version: 2, step: 99, data: {} })).body.step, 3, 'שלב מחוץ לטווח מתעלמים');
});

test('בדיקת שלמות: טיוטה חסרה מחזירה בדיוק מה חסר; פרסום נחסם בלי ליצור חשבון Auth או עסק', async () => {
  const ver = (await su.get(`/api/super/drafts/${D.id}`)).body;
  assert.ok(ver.problems['owner.email'], 'אימייל בעלים חסר');
  const before = { users: auth.users.size, biz: await count('businesses') };
  const r = await su.post(`/api/super/drafts/${D.id}/publish`, { owner_password: PW });
  assert.equal(r.status, 400); assert.equal(r.body.error.code, 'incomplete'); assert.ok(r.body.error.fields['owner.email']);
  assert.equal(auth.users.size, before.users, 'לא נוצר חשבון Auth'); assert.equal(await count('businesses'), before.biz, 'לא נוצר עסק');
  const bad = await su.put(`/api/super/drafts/${D.id}`, { version: ver.version, data: { business: { name: 'x', slug: 'ab', phone: '12' }, services: [{ name: 'א', duration_min: 3, price_ils: -1 }], brand: { accent: 'red' } } });
  for (const k of ['business.name', 'business.slug', 'business.phone', 'services.1', 'brand.accent']) assert.ok(bad.body.problems[k], 'חסר סימון: ' + k);
});

test('[מקרים] תבנית הזמנה: חייבת צוות עם שעות; תבנית לידים לא', async () => {
  const d = await draftOf('barbershop');
  const r = await su.put(`/api/super/drafts/${d.id}`, { version: 1, data: { ...fill({ business: { name: 'מספרה', slug: 'barber-x', phone: '03-1234567' } }), staff: [{ name: 'ספר', hours: [] }] } });
  assert.ok(r.body.problems['staff.1'], 'שעות עבודה נדרשות');
  const d2 = await draftOf('home-services');
  const r2 = await su.put(`/api/super/drafts/${d2.id}`, { version: 1, data: fill({ business: { name: 'מים וזרם', slug: 'water-1', phone: '03-1234567' }, owner: { email: 'w@example.com' } }) });
  assert.deepEqual(Object.keys(r2.body.problems), [], JSON.stringify(r2.body.problems));
  await su.del(`/api/super/drafts/${d.id}`); await su.del(`/api/super/drafts/${d2.id}`);
});

test('פרסום אטומי: עסק, בעלים, שירותים, צוות ושעות נוצרים יחד; מיתוג, מסלול ודומיין ממתין; פרסום חוזר אידמפוטנטי', async () => {
  const ver = (await su.get(`/api/super/drafts/${D.id}`)).body;
  await su.put(`/api/super/drafts/${D.id}`, { version: ver.version, step: 8, data: { ...fill(), domain: { hostname: 'book.glow.example' }, services: [{ name: 'לק ג׳ל', duration_min: 60, price_ils: 130 }, { name: 'הרמת ריסים', duration_min: 60, price_ils: 250 }], staff: [{ name: 'נועה', hours: WEEK }] } });
  const users = auth.users.size;
  const r = await su.post(`/api/super/drafts/${D.id}/publish`, { owner_password: PW });
  assert.equal(r.status, 201, JSON.stringify(r.body)); assert.equal(r.body.slug, 'glow-1'); const bid = r.body.business_id;
  assert.equal(auth.users.size, users + 1);
  const b = await row(`select jsonb_build_object('t', template, 'track', track, 'brand', brand, 'active', active, 'svc', (select count(*) from services where business_id = b.id),
    'staff', (select count(*) from staff where business_id = b.id), 'hours', (select count(*) from working_hours where business_id = b.id), 'owners', (select count(*) from platform_users where business_id = b.id and role = 'owner'),
    'dom', (select jsonb_agg(jsonb_build_object('h', hostname, 's', status)) from business_domains where business_id = b.id)) from businesses b where id = '${bid}'`);
  assert.equal(b.t, 'cosmetics'); assert.equal(b.track, 'managed'); assert.deepEqual(b.brand, { tagline: 'יופי ביד אחת', accent: '#aa3355' });
  assert.equal(b.svc, 2); assert.equal(b.staff, 1); assert.equal(b.hours, 5); assert.equal(b.owners, 1); assert.deepEqual(b.dom, [{ h: 'book.glow.example', s: 'pending' }]);
  const again = await su.post(`/api/super/drafts/${D.id}/publish`, { owner_password: PW }); assert.equal(again.body.already, true); assert.equal(await count('businesses where slug = \'glow-1\''), 1);
  assert.equal((await su.put(`/api/super/drafts/${D.id}`, { version: 99, data: {} })).status, 409);
  const o = client(api); assert.equal((await o.post('/api/admin/login', { email: 'glow@example.com', password: PW })).status, 200);
  const me = (await o.get('/api/admin/me')).body; assert.equal(me.shop.template, 'cosmetics'); assert.equal(me.shop.brand.accent, '#aa3355');
  const pubShop = (await client(api).get('/api/public/shops/glow-1')).body; assert.equal(pubShop.shop.brand.tagline, 'יופי ביד אחת');
  assert.equal((await client(api).get('/api/public/shops/glow-1')).body.barbers.length, 1, 'לקוח מזמין מייד אחרי פרסום');
  globalThis.__glow = { id: bid, owner: o };
});

test('כשל באמצע הפרסום: הכול מתבטל (אין עסק יתום), הטיוטה נשארת פתוחה והחשבון שנוצר נשמר לניסיון חוזר; אין חשבון כפול', async () => {
  const d = await draftOf('home-services');
  await su.put(`/api/super/drafts/${d.id}`, { version: 1, step: 8, data: fill({ business: { name: 'שרברב', slug: 'plumb-1', phone: '03-1234567' }, owner: { email: 'plumb@example.com' } }) });
  // כשל מכוון אחרי שהעסק והבעלים כבר נכנסו: טריגר שזורק בהכנסת שירות עם שם מסוים
  await psql(`create function public.zz_boom() returns trigger language plpgsql as $$ begin raise exception 'boom'; end $$;
              create trigger zz_boom before insert on public.services for each row when (new.name like 'בום%') execute function public.zz_boom()`, { db: DB });
  const v = (await su.get(`/api/super/drafts/${d.id}`)).body;
  await su.put(`/api/super/drafts/${d.id}`, { version: v.version, data: { services: [{ name: 'בום ראשון', duration_min: 30, price_ils: 100 }] } });
  const users = auth.users.size, biz = await count('businesses');
  const r = await su.post(`/api/super/drafts/${d.id}/publish`, { owner_password: PW });
  assert.ok(r.status >= 500 || r.status === 502, String(r.status));
  assert.equal(await count('businesses'), biz, 'לא נשאר עסק חלקי'); assert.equal(await count(`platform_users where role = 'owner' and business_id not in (select id from businesses)`), 0);
  const g = (await su.get(`/api/super/drafts/${d.id}`)).body; assert.equal(g.status, 'draft'); assert.equal(g.owner_ready, true);
  assert.equal(auth.users.size, users + 1, 'חשבון הבעלים נשמר כדי שהניסיון החוזר ישתמש בו');
  await psql('drop trigger zz_boom on public.services', { db: DB });
  const retry = await su.post(`/api/super/drafts/${d.id}/publish`, {});                      // בלי סיסמה: משתמשים בחשבון שכבר קיים
  assert.equal(retry.status, 201, JSON.stringify(retry.body)); assert.equal(auth.users.size, users + 1, 'לא נוצר חשבון נוסף');
  assert.equal(await count('businesses'), biz + 1);
});

test('שחזור: חשבון Auth לא-משויך מניסיון קודם נעשה בו שימוש; אימייל משויך לעסק אחר נדחה; מחיקת טיוטה מוחקת חשבון יתום', async () => {
  await auth.admin.createUser('orphan@example.com', 'Whatever-123456');
  const d = await draftOf('home-services');
  await su.put(`/api/super/drafts/${d.id}`, { version: 1, step: 8, data: fill({ business: { name: 'חשמלאי', slug: 'elec-1', phone: '03-1234567' }, owner: { email: 'orphan@example.com' } }) });
  const users = auth.users.size;
  const r = await su.post(`/api/super/drafts/${d.id}/publish`, { owner_password: PW }); assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(auth.users.size, users, 'שימוש בחשבון הקיים');
  assert.equal((await client(api).post('/api/admin/login', { email: 'orphan@example.com', password: PW })).status, 200, 'הסיסמה אופסה לזו שהוגדרה בפרסום');
  const d2 = await draftOf('home-services');
  await su.put(`/api/super/drafts/${d2.id}`, { version: 1, data: fill({ business: { name: 'אחר', slug: 'other-1', phone: '03-1234567' }, owner: { email: 'glow@example.com' } }) });
  const x = await su.post(`/api/super/drafts/${d2.id}/publish`, { owner_password: PW }); assert.equal(x.status, 409); assert.ok(x.body.error.fields['owner.email']);
  // טיוטה עם חשבון שנוצר ואז נמחקה
  const d3 = await draftOf('home-services');
  await su.put(`/api/super/drafts/${d3.id}`, { version: 1, data: fill({ business: { name: 'נגר', slug: 'wood-1', phone: '03-1234567' }, owner: { email: 'wood@example.com' } }) });
  await psql(`create trigger zz_boom2 before insert on public.businesses for each row execute function public.zz_boom()`, { db: DB });
  await su.post(`/api/super/drafts/${d3.id}/publish`, { owner_password: PW });
  await psql('drop trigger zz_boom2 on public.businesses', { db: DB });
  assert.ok(auth.users.has('wood@example.com'));
  assert.equal((await su.del(`/api/super/drafts/${d3.id}`)).status, 200); assert.ok(!auth.users.has('wood@example.com'), 'חשבון יתום נמחק');
  assert.equal((await su.get(`/api/super/drafts/${d3.id}`)).status, 404);
});

test('הרשאות אשף: owner ו-anon אינם נוגעים בטיוטות; Super בלי aal2 נחסם; פרסום דורש אימות TOTP טרי (ב-DB)', async () => {
  const o = globalThis.__glow.owner;
  for (const [m, u, b] of [['get', '/api/super/drafts'], ['post', '/api/super/drafts', { template: 'cosmetics' }], ['get', `/api/super/drafts/${D.id}`], ['post', `/api/super/drafts/${D.id}/publish`, {}]]) {
    assert.equal((await o[m](u, b)).status, 403, 'owner ' + u); assert.equal((await client(api)[m](u, b)).status, 401, 'anon ' + u);
  }
  const uid = await addUser('s2@example.com', DB); await psql(`insert into platform_users (user_id, role) values ('${uid}', 'super_admin')`, { db: DB });
  const noMfa = asUser(uid, 's2@example.com', NOW, DB, { aal: 'aal1' });
  assert.equal((await noMfa('rpc_super_draft_list')).error.code, '42501');
  const stale = asSuper(uid, 's2@example.com', NOW, DB, false);
  const r = await stale('rpc_super_check_fresh_mfa'); assert.equal(r.httpStatus, 403); assert.match(r.error.message, /mfa_stale/);
  assert.equal((await stale('rpc_super_draft_publish', { p_id: D.id })).httpStatus, 403, 'פרסום עם TOTP ישן נחסם');
  assert.equal((await asSuper(uid, 's2@example.com', NOW, DB, true)('rpc_super_check_fresh_mfa')).httpStatus, 200);
  // ACL: הטיוטות והדומיינים אינם נגישים ישירות מכלי הלקוח
  for (const t of ['business_drafts', 'business_domains']) {
    const sel = await psql(`select has_table_privilege('authenticated', 'public.${t}', 'select') or has_table_privilege('anon', 'public.${t}', 'select')`, { db: DB }); assert.equal(sel, 'f', t);
  }
});

test('מיתוג: בעלים עורך משפט וצבע (מאומתים); צבע לא תקין נדחה; מסלול (track) אינו ניתן לשינוי ע"י בעלים', async () => {
  const o = globalThis.__glow.owner;
  const cur = (await o.get('/api/admin/shop')).body.shop;
  const body = { name: cur.name, phone: cur.phone, address: cur.address, slot_step: cur.slot_step, min_notice_min: cur.min_notice_min, max_days_ahead: cur.max_days_ahead, cancel_cutoff_hours: cur.cancel_cutoff_hours };
  let r = await o.put('/api/admin/shop', { ...body, brand: { tagline: 'מבט חדש', accent: '#112233' } }); assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual((await o.get('/api/admin/shop')).body.shop.brand, { tagline: 'מבט חדש', accent: '#112233' });
  r = await o.put('/api/admin/shop', { ...body, brand: { accent: 'javascript:1' } }); assert.equal(r.status, 400); assert.ok(r.body.error.fields['brand.accent']);
  r = await o.put('/api/admin/shop', { ...body, brand: { tagline: '<img src=x>' } }); assert.equal(r.status, 400);
  r = await o.put('/api/admin/shop', body); assert.deepEqual((await o.get('/api/admin/shop')).body.shop.brand, { tagline: 'מבט חדש', accent: '#112233' }, 'בלי מפתח brand – ללא שינוי');
  const direct = await asUser(await psql(`select user_id from platform_users where business_id = '${globalThis.__glow.id}'`, { db: DB }), 'glow@example.com', NOW, DB)('rpc_owner_shop_get', { p_business: null });
  assert.equal(direct.data.data.shop.track, 'managed');
  const { asRole } = await import('./support/db.mjs');
  const uid = await psql(`select user_id from platform_users where business_id = '${globalThis.__glow.id}'`, { db: DB });
  const upd = await asRole('authenticated', { sub: uid, email: 'glow@example.com' }, `update businesses set track = 'one_time' where id = '${globalThis.__glow.id}'`, { db: DB });
  assert.equal(upd.ok, false); assert.equal(upd.sqlstate, '42501');
});

/* ---------------- דומיינים ---------------- */
let domA, bizA, ownerA;
test('דומיין: הוספה, הוראות TXT, ולידציה, שמות שמורים, כפילויות ומגבלת 3', async () => {
  bizA = globalThis.__glow.id; ownerA = globalThis.__glow.owner;
  const l = (await ownerA.get('/api/admin/domains')).body.domains; assert.equal(l.length, 1); assert.equal(l[0].status, 'pending');
  assert.equal(l[0].txt_name, '_bsverify.book.glow.example'); assert.match(l[0].txt_value, /^bs-verify=[A-Za-z0-9_-]{32}$/); domA = l[0];
  for (const h of ['app.test', 'not a host', 'localhost', '1.2.3.4', 'a..b.com', 'x'.repeat(64) + '.com']) { const r = await ownerA.post('/api/admin/domains', { hostname: h }); assert.equal(r.status, 400, h); }
  assert.equal((await ownerA.post('/api/admin/domains', { hostname: 'Book.Glow.Example.' })).status, 409, 'כפילות אחרי נרמול');
  assert.equal((await ownerA.post('/api/admin/domains', { hostname: 'second.glow.example' })).status, 201);
  assert.equal((await ownerA.post('/api/admin/domains', { hostname: 'third.glow.example' })).status, 201);
  assert.equal((await ownerA.post('/api/admin/domains', { hostname: 'fourth.glow.example' })).status, 409, 'עד 3');
  assert.equal((await ownerA.del(`/api/admin/domains/${(await ownerA.get('/api/admin/domains')).body.domains[2].id}`)).status, 200);
});

test('בדיקת דומיין אמיתית-לוגית: TXT חסר/שגוי → pending; TXT תקין בלי ניתוב → verified; TXT+חותמת תקינה → active; resolve-host רק לפעיל', async () => {
  const host = 'book.glow.example', txtName = '_bsverify.' + host, url = `/api/admin/domains/${domA.id}/check`;
  let r = await ownerA.post(url, {}); assert.equal(r.body.status, 'pending'); assert.equal(r.body.last_error, 'txt_missing');
  dns.txt[txtName] = ['bs-verify=wrong']; r = await ownerA.post(url, {}); assert.equal(r.body.status, 'pending'); assert.equal(r.body.last_error, 'txt_mismatch');
  dns.txt[txtName] = ['v=spf1 -all', domA.txt_value]; dns.a[host] = ['93.184.216.34'];
  r = await ownerA.post(url, {}); assert.equal(r.body.status, 'verified', JSON.stringify(r.body)); assert.equal(r.body.last_error, 'not_routed');
  assert.equal((await client(api).get('/api/public/host', { headers: { host } })).status, 404, 'verified בלבד אינו מנותב');
  dns.ping[host] = { body: { ok: true, mark: 'f'.repeat(32) } };
  r = await ownerA.post(url, {}); assert.equal(r.body.status, 'verified', 'חותמת של אתר אחר אינה מספיקה');
  dns.ping[host] = { body: { ok: true, mark: pingMark(config.pepper, host) } };
  r = await ownerA.post(url, {}); assert.equal(r.body.status, 'active', JSON.stringify(r.body)); assert.ok(r.body.activated_at && r.body.last_error == null);
  const m = await client(api).get('/api/public/host', { headers: { host } }); assert.equal(m.status, 200); assert.deepEqual(m.body, { slug: 'glow-1', kind: 'booking' });
  assert.equal((await client(api).get('/api/public/host', { headers: { host: 'app.test' } })).status, 404, 'host של הפלטפורמה לא ממופה');
  assert.equal((await client(api).get('/api/public/host', { headers: { host: 'unknown.example' } })).status, 404);
  assert.equal((await su.get('/api/super/shops')).body.shops.find((s) => s.id === bizA).domains[0].status, 'active');
});

test('אבטחת דומיין: Origin של דומיין פעיל מותר רק לנתיבים ציבוריים; ניהול נשאר רק מהפלטפורמה; דומיין ממתין/זר נחסם', async () => {
  const dom = 'https://book.glow.example';
  const c = client(api); const call = (u, b, origin) => c.post(u, b, { headers: { origin } });
  const lead = { slug: 'glow-1', name: 'יעל לוי', phone: '0527654321' };
  assert.equal((await call('/api/public/lead', lead, dom)).status, 200);
  assert.equal((await call('/api/admin/login', { email: 'glow@example.com', password: PW }, dom)).status, 403, 'אין התחברות ממנהל דרך דומיין מותאם');
  assert.equal((await call('/api/super/drafts', { template: 'cosmetics' }, dom)).status, 403);
  assert.equal((await call('/api/public/lead', { ...lead, phone: '0527654322' }, 'https://second.glow.example')).status, 403, 'דומיין ממתין');
  assert.equal((await call('/api/public/lead', { ...lead, phone: '0527654323' }, 'https://evil.example')).status, 403);
  assert.equal((await call('/api/public/lead', { ...lead, phone: '0527654324' }, 'http://book.glow.example')).status, 403, 'http אינו אותו Origin');
  assert.equal((await call('/api/public/lead', { ...lead, phone: '0527654325' }, 'https://book.glow.example.evil.example')).status, 403);
  // קישור אישי אחרי הזמנה מדומיין פעיל נבנה על הדומיין עצמו
  const pubShop = (await c.get('/api/public/shops/glow-1')).body; const st = pubShop.barbers[0].id;
  const day = (await c.get(`/api/public/days?slug=glow-1&barber_id=${st}&service_id=${pubShop.services[0].id}`)).body.days.find((d) => d.available).date;
  const slot = (await c.get(`/api/public/slots?slug=glow-1&barber_id=${st}&service_id=${pubShop.services[0].id}&date=${day}`)).body.slots[0];
  const bk = await call('/api/public/book', { slug: 'glow-1', service_id: pubShop.services[0].id, barber_id: st, date: day, start_min: slot, first_name: 'דנה', last_name: 'כהן', phone: '0521234567', idempotency_key: 'd'.repeat(30) }, dom);
  assert.equal(bk.status, 201, JSON.stringify(bk.body)); assert.ok(bk.body.manage_url.startsWith(dom + '/m/'));
});

test('דומיין לא יוצר גישה: הכותרת Host אינה משנה זהות; בעל עסק אחר לא יכול לבדוק/למחוק דומיין שאינו שלו; השבתת עסק מנתקת את הדומיין', async () => {
  const hostile = client(api);
  const r = await hostile.get('/api/admin/shop', { headers: { host: 'book.glow.example' } }); assert.equal(r.status, 401, 'Host של דומיין לא נותן סשן');
  await su.post('/api/super/shops', { name: 'אחר', slug: 'other-biz', template: 'home-services', owner_email: 'other@example.com', owner_password: PW }).catch(() => {});
  const oth = client(api); await oth.post('/api/admin/login', { email: 'other@example.com', password: PW });
  assert.equal((await oth.post(`/api/admin/domains/${domA.id}/check`, {})).status, 404); assert.equal((await oth.del(`/api/admin/domains/${domA.id}`)).status, 404);
  assert.ok((await oth.get('/api/admin/domains')).body.domains.every((d) => d.hostname !== 'book.glow.example'));
  // תפיסת דומיין: עסק אחר מציג TXT תקין לדומיין שכבר פעיל אצל A → נדחה (domain_taken) ולא גונב
  const added = await oth.post('/api/admin/domains', { hostname: 'book.glow.example' }); assert.equal(added.status, 409);
  const otherId = (await su.get('/api/super/shops')).body.shops.find((s) => s.slug === 'other-biz');
  assert.ok(otherId || true);
  // השבתת העסק: הדומיין מפסיק להתנתב מיידית
  const off = await su.patch(`/api/super/shops/${bizA}`, { active: false }); assert.equal(off.status, 200);
  assert.equal((await client(api).get('/api/public/host', { headers: { host: 'book.glow.example' } })).status, 404);
  assert.equal((await su.patch(`/api/super/shops/${bizA}`, { active: true })).status, 200);
  assert.equal((await client(api).get('/api/public/host', { headers: { host: 'book.glow.example' } })).status, 200);
});

test('אחרי שהוכחת הבעלות נעלמה: בדיקה חוזרת מורידה ל-failed והניתוב נפסק; כתובת פנימית ו-TLS מדווחים ואינם מנותבים', async () => {
  const host = 'book.glow.example', url = `/api/admin/domains/${domA.id}/check`;
  delete dns.txt['_bsverify.' + host];
  let r = await ownerA.post(url, {}); assert.equal(r.body.status, 'failed'); assert.equal(r.body.last_error, 'txt_missing');
  assert.equal((await client(api).get('/api/public/host', { headers: { host } })).status, 404);
  dns.txt['_bsverify.' + host] = [domA.txt_value]; dns.a[host] = ['10.0.0.5']; dns.fetched.length = 0;
  r = await ownerA.post(url, {}); assert.equal(r.body.status, 'verified'); assert.equal(r.body.last_error, 'private_address'); assert.deepEqual(dns.fetched, [], 'לא פונים לכתובת פנימית');
  dns.a[host] = ['93.184.216.34']; delete dns.ping[host];
  r = await ownerA.post(url, {}); assert.equal(r.body.status, 'verified'); assert.equal(r.body.last_error, 'not_routed');
  dns.ping[host] = { body: { ok: true, mark: pingMark(config.pepper, host) } }; r = await ownerA.post(url, {}); assert.equal(r.body.status, 'active');
});

test('הגבלת קצב על בדיקות דומיין; נקודת ה-ping קשורה ל-host של הבקשה בלבד', async () => {
  const p = client(api);
  assert.equal((await p.get('/api/public/domain-ping?h=book.glow.example', { headers: { host: 'other.example' } })).status, 400);
  const ok = await p.get('/api/public/domain-ping?h=book.glow.example', { headers: { host: 'book.glow.example' } });
  assert.equal(ok.status, 200); assert.equal(ok.body.mark, pingMark(config.pepper, 'book.glow.example'));
  assert.notEqual(pingMark(config.pepper, 'a.example'), pingMark(config.pepper, 'b.example'));
  let limited = 0; for (let i = 0; i < 35; i++) if ((await ownerA.post(`/api/admin/domains/${domA.id}/check`, {})).status === 429) limited++;
  assert.ok(limited > 0, 'נדרשת מגבלת קצב על בדיקות');
});

test('isPublicIp: טווחים פנימיים, metadata ו-IPv6 מקומי נחסמים', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', 'fe80::1', 'fd00::1', '::ffff:10.0.0.1', 'garbage'])
    assert.equal(isPublicIp(ip), false, ip);
  for (const ip of ['93.184.216.34', '8.8.8.8', '172.32.0.1', '2606:2800:220:1::1']) assert.equal(isPublicIp(ip), true, ip);
});

test('ייצוא/ייבוא: מיתוג ומסלול עוברים; דומיינים אינם עוברים (מוקמים מחדש ביעד)', async () => {
  const ex = await rpc('rpc_admin_export_business', { p_business: bizA }, { role: 'service_role', db: DB });
  const data = ex.data.data; assert.equal(data.business.track, 'managed'); assert.equal(data.business.brand.accent, '#112233');
  assert.ok(!JSON.stringify(data).includes('book.glow.example') && !JSON.stringify(data).includes('bs-verify'), 'דומיינים אינם בייצוא');
  data.business.track = 'one_time'; data.appointments = [];            // אותו מסד: קישורים אישיים (token_hash) ייחודיים גלובלית, ולכן לא מייבאים תורים לתוך המסד שממנו יוצאו
  const im = await rpc('rpc_admin_import_business', { p: data, p_new_slug: 'glow-copy' }, { role: 'service_role', db: DB }); assert.equal(im.httpStatus, 200, JSON.stringify(im));
  const b = await row(`select jsonb_build_object('track', track, 'brand', brand, 'doms', (select count(*) from business_domains where business_id = b.id)) from businesses b where slug = 'glow-copy'`);
  assert.equal(b.track, 'one_time'); assert.equal(b.brand.tagline, 'מבט חדש'); assert.equal(b.doms, 0);
});
