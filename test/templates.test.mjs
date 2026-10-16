// חמש התבניות: שלמות הקטלוג, עיצוב ייעודי, יצירת עסק מכל תבנית, התמדה אמיתית (תור/פנייה) וביודד בין עסקים,
// שדות פנייה ייעודיים (מילון סגור), וייבוא של מפתחות תבנית ישנים. הרצה מול Postgres אמיתי.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { psql, rpc } from './support/pg.mjs';
import { resetDb, WEEK_HOURS } from './support/db.mjs';
import { pgRest, fakeAuth, client, totp } from './support/adapters.mjs';
import { createApi } from '../lib/api.mjs';
import { DEFAULT_LABELS } from '../public/js/common.js';

const DB = 'platform_templates';
const config = { pepper: 'test-pepper-0123456789-0123456789', publicBaseUrl: 'https://app.test', allowedOrigins: ['https://app.test'], cookieSecure: true };
const quiet = { error() {}, log() {} };
const KEYS = ['barbershop', 'cosmetics', 'detailing', 'home-services', 'studio-services'];
const BOOKING = ['barbershop', 'cosmetics', 'detailing'], LEADS = ['home-services', 'studio-services'];
const PW = 'OwnerPass-123';
let auth, api, su, rows;
const shops = {};     // key → { id, slug, owner, c }

test.before(async () => {
  process.env.TEST_DB = DB; resetDb(DB);
  auth = fakeAuth({ db: DB }); api = createApi({ rest: pgRest({ db: DB }), auth, config, log: quiet });
  const uRoot = await auth.addUser('root@example.com', 'SuperSecret-123');
  await psql(`insert into platform_users (user_id, role) values ('${uRoot}', 'super_admin')`, { db: DB });
  su = client(api);
  let r = await su.post('/api/admin/login', { email: 'root@example.com', password: 'SuperSecret-123' });
  const e = await su.post('/api/admin/mfa/enroll', {}); r = await su.post('/api/admin/mfa/enroll/verify', { factor_id: e.body.factor_id, code: totp(e.body.secret) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  rows = JSON.parse(await psql(`select coalesce(jsonb_agg(to_jsonb(t) order by sort), '[]') from templates t`, { db: DB }));
});

test('קטלוג: בדיוק חמש תבניות, כולן available, מפתחות ישנים הוסרו', () => {
  assert.deepEqual(rows.map((t) => t.key).sort(), [...KEYS].sort());
  for (const t of rows) assert.equal(t.status, 'available', t.key);
  assert.ok(!rows.some((t) => ['landing-leads', 'service-catalog'].includes(t.key)));
});

test('כל תבנית: ערכת עיצוב משלה קיימת ומגדירה את כל המשתנים; ערכות שונות זו מזו', () => {
  const need = ['--bg', '--surface', '--surface-2', '--line', '--accent-rgb', '--gold', '--gold-hi', '--gold-grad', '--on-accent', '--text', '--muted', '--radius', '--font', '--font-display'];
  const accents = new Set(), bgs = new Set();
  for (const t of rows) {
    assert.match(t.theme, /^[a-z0-9-]{1,40}$/);
    const f = `public/themes/${t.theme}.css`;
    assert.ok(existsSync(f), `${t.key}: ${f} חסר`);
    const css = readFileSync(f, 'utf8');
    for (const v of need) assert.match(css, new RegExp(`${v}\\s*:`), `${t.key}: ${v} לא מוגדר`);
    accents.add(/--accent-rgb:\s*([^;]+);/.exec(css)[1].trim()); bgs.add(/--bg:\s*([^;]+);/.exec(css)[1].trim());
  }
  assert.equal(new Set(rows.map((t) => t.theme)).size, 5);
  assert.equal(accents.size, 5, 'צבע מבטא ייחודי לכל תבנית'); assert.equal(bgs.size, 5, 'רקע ייחודי לכל תבנית');
});

test('[רגרסיה] ערכת העיצוב נטענת אחרי app.css בכל דף, אחרת ההתאמות המבניות שלה נדרסות', () => {
  for (const f of ['book', 'lead', 'manage', 'admin', 'index']) {
    const html = readFileSync(`public/${f}.html`, 'utf8');
    assert.ok(html.indexOf('/css/app.css') > 0 && html.indexOf('id="theme-css"') > html.indexOf('/css/app.css'), f);
  }
});

test('תוויות: לכל תבנית כל מפתחות החובה לפי סוגה, וללא טקסט של מספרה בתבניות האחרות', () => {
  const bookingKeys = ['brand', 'staff_one', 'staff_many', 'pick_staff', 'service_one', 'service_many', 'pick_service', 'appt_one', 'appt_many', 'book_cta', 'done_title', 'done_sub', 'no_staff_slots', 'add_staff', 'all_staff', 'calendar', 'customers', 'leads_tab', 'empty_unbooked', 'manage_title', 'book_title', 'staff_icon'];
  const leadKeys = ['brand', 'service_one', 'service_many', 'catalog_title', 'tagline', 'lead_title', 'lead_cta', 'lead_done_title', 'lead_done_sub', 'msg_label', 'msg_placeholder', 'service_pick_label', 'leads_tab', 'leads_title', 'extra'];
  for (const t of rows) {
    for (const k of t.kind === 'booking' ? bookingKeys : leadKeys) { assert.ok(typeof t.labels[k] === 'string' && t.labels[k].length, `${t.key}.labels.${k}`); assert.ok(k in DEFAULT_LABELS || k === 'brand', `${k} חסר ב-DEFAULT_LABELS`); }
    if (t.key !== 'barbershop') for (const v of Object.values(t.labels)) assert.ok(!/(^|[\s"])(ספר|ספרים|מספרה|תספורת)($|[\s".,?])/.test(v), `${t.key}: טקסט של מספרה: ${v}`);
  }
  assert.equal(new Set(rows.filter((t) => t.kind === 'booking').map((t) => t.labels.staff_one)).size, 3);
  assert.deepEqual(rows.filter((t) => t.kind !== 'booking').map((t) => t.labels.extra).sort(), ['home', 'studio']);
});

test('שירותי ברירת מחדל: תקינים לטווחי המסד ולא ריקים; תיאור/קהל/יכולות קיימים לאתר המכירה', () => {
  for (const t of rows) {
    assert.ok(t.default_services.length >= 3, t.key);
    for (const s of t.default_services) { assert.ok(s.duration_min >= 5 && s.duration_min <= 480, `${t.key}/${s.name}`); assert.ok(s.price_ils >= 0); }
    assert.ok(t.tagline && t.description && t.audience && t.features.length >= 3, `${t.key}: שדות שיווק חסרים`);
  }
});

test('יצירת עסק מכל תבנית דרך ה-API: שירותי ברירת המחדל של התבנית נזרעים, והבעלים רואה את התבנית שלו', async () => {
  for (const key of KEYS) {
    const owner = `${key.split('-')[0]}@example.com`, slug = `demo-${key}`;
    const r = await su.post('/api/super/shops', { name: `עסק ${key}`, slug, template: key, owner_email: owner, owner_password: PW });
    assert.equal(r.status, 201, `${key}: ${JSON.stringify(r.body)}`);
    const c = client(api); assert.equal((await c.post('/api/admin/login', { email: owner, password: PW })).status, 200);
    const me = await c.get('/api/admin/me');
    assert.equal(me.body.shop.template, key); assert.equal(me.body.shop.theme, rows.find((t) => t.key === key).theme);
    const svc = (await c.get('/api/admin/services')).body.services;
    assert.equal(svc.length, rows.find((t) => t.key === key).default_services.length, key);
    shops[key] = { id: r.body.id, slug, owner, c };
  }
});

test('תבניות הזמנה: תור נשמר אצל הבעלים של אותו עסק בלבד; מונחי התבנית מגיעים מה-API הציבורי', async () => {
  for (const key of BOOKING) {
    const s = shops[key]; const t = rows.find((x) => x.key === key);
    const st = (await s.c.post('/api/admin/barbers', { name: `${t.labels.staff_one} א`, hours: WEEK_HOURS })).body.id;
    const pub = client(api);
    const shop = (await pub.get(`/api/public/shops/${s.slug}`)).body;
    assert.equal(shop.shop.labels.staff_one, t.labels.staff_one); assert.equal(shop.shop.theme, t.theme);
    const svc = shop.services[0];
    const day = (await pub.get(`/api/public/days?slug=${s.slug}&barber_id=${st}&service_id=${svc.id}`)).body.days.find((d) => d.available).date;
    const slot = (await pub.get(`/api/public/slots?slug=${s.slug}&barber_id=${st}&service_id=${svc.id}&date=${day}`)).body.slots[0];
    const phone = '052' + String(1234000 + KEYS.indexOf(key) * 17);
    const book = await pub.post('/api/public/book', { slug: s.slug, service_id: svc.id, barber_id: st, date: day, start_min: slot, first_name: 'דנה', last_name: 'כהן', phone, idempotency_key: `k-${key}-` + 'x'.repeat(24) });
    assert.equal(book.status, 201, `${key}: ${JSON.stringify(book.body)}`);
    const mine = (await s.c.get(`/api/admin/appointments?from=${day}&to=${day}`)).body.appointments;
    assert.equal(mine.length, 1, key); assert.equal(mine[0].first_name, 'דנה');
    for (const other of KEYS.filter((k) => k !== key)) {
      const o = (await shops[other].c.get(`/api/admin/appointments?from=${day}&to=${day}`)).body.appointments;
      assert.ok(!o.some((a) => a.first_name === 'דנה' && a.service_name === svc.name && a.start_min === slot && other !== key && a.id === mine[0].id), `${key} → ${other}: דליפה`);
    }
  }
});

const lead = (c, slug, extra = {}) => c.post('/api/public/lead', { slug, name: 'יעל לוי', phone: '0527654321', ...extra });
test('פניות בעלי מקצוע: עיר ודחיפות נשמרות ומוצגות לבעלים בלבד; שדות לא מוכרים ונפסלים', async () => {
  const s = shops['home-services']; const pub = client(api);
  let r = await lead(pub, s.slug, { message: 'נזילה', city: 'חיפה', urgency: 'today', budget: 'gt10k', is_admin: true, meta: { x: 1 } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const l = (await s.c.get('/api/admin/leads')).body.leads[0];
  assert.deepEqual(l.meta, { city: 'חיפה', urgency: 'today' }, 'מפתחות מחוץ למילון של התבנית לא נשמרים');
  r = await lead(pub, s.slug, { phone: '0521112223', urgency: 'yesterday', city: 'תל אביב' });
  assert.equal(r.status, 200);
  assert.deepEqual((await s.c.get('/api/admin/leads')).body.leads[0].meta, { city: 'תל אביב' }, 'ערך דחיפות לא חוקי נזרק');
  r = await lead(pub, s.slug, { phone: '0521112224', city: '<b>x</b>' });
  assert.equal(r.status, 400); assert.ok(r.body.error.fields.city);
  assert.equal((await shops['studio-services'].c.get('/api/admin/leads')).body.leads.length, 0, 'פנייה לא דלפה לעסק אחר');
});

test('בקשות הצעת מחיר: תקציב ולוח זמנים נשמרים; עיר אינה חלק מהתבנית הזו', async () => {
  const s = shops['studio-services']; const pub = client(api);
  const r = await lead(pub, s.slug, { message: 'צילום מוצרים', budget: '3-10k', timeframe: 'month', city: 'חיפה', urgency: 'today' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual((await s.c.get('/api/admin/leads')).body.leads[0].meta, { budget: '3-10k', timeframe: 'month' });
  assert.equal((await lead(pub, s.slug, { phone: '0521112225', budget: 'a lot' })).status, 200);
  assert.deepEqual((await s.c.get('/api/admin/leads')).body.leads[0].meta, {});
});

test('תבנית שאינה תבנית הזמנה: אין יומן; ניסיון הזמנה נכשל ולא יוצר תור', async () => {
  const s = shops['home-services']; const pub = client(api);
  const sv = (await pub.get(`/api/public/shops/${s.slug}`)).body;
  assert.equal(sv.barbers.length, 0);
  const r = await pub.post('/api/public/book', { slug: s.slug, service_id: sv.services[0].id, barber_id: 1, date: '2026-10-20', start_min: 600, first_name: 'דנה', last_name: 'כהן', phone: '0521234567', idempotency_key: 'z'.repeat(30) });
  assert.ok(r.status >= 400 && r.status < 500, String(r.status));
  assert.equal(JSON.parse(await psql(`select count(*) from appointments where business_id = '${s.id}'`, { db: DB })), 0);
});

test('ייצוא/ייבוא: meta של פניות עובר; מפתח תבנית ישן (landing-leads/service-catalog) ממופה לחדש', async () => {
  const s = shops['studio-services'];
  const ex = await rpc('rpc_admin_export_business', { p_business: s.id }, { role: 'service_role', db: DB });
  assert.equal(ex.httpStatus, 200); const data = ex.data.data || ex.data;
  const doc = JSON.parse(JSON.stringify(data));
  doc.business.template = 'service-catalog';
  const im = await rpc('rpc_admin_import_business', { p: doc, p_new_slug: 'imported-studio' }, { role: 'service_role', db: DB });
  assert.equal(im.httpStatus, 200, JSON.stringify(im));
  const row = JSON.parse(await psql(`select jsonb_build_object('t', template, 'm', (select meta from leads where business_id = b.id order by id limit 1)) from businesses b where slug = 'imported-studio'`, { db: DB }));
  assert.equal(row.t, 'studio-services'); assert.deepEqual(row.m, { budget: '3-10k', timeframe: 'month' });
});
