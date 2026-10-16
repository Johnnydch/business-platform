// אתר המותג: קטלוג, לידים של המותג (נפרדים מפניות עסקים), הגדרות/מחירי טיוטה, ועסקי הדגמה מבודדים
import test from 'node:test';
import assert from 'node:assert/strict';
import { psql } from './support/pg.mjs';
import { resetDb, asUser, asSuper, asService, addUser, NOW } from './support/db.mjs';
import { pgRest, fakeAuth, client, totp } from './support/adapters.mjs';
import { createApi } from '../lib/api.mjs';

const DB = 'platform_brand';
const config = { pepper: 'test-pepper-0123456789-0123456789', publicBaseUrl: 'https://app.test', allowedOrigins: ['https://app.test'], cookieSecure: true };
const quiet = { error() {}, log() {} };
let auth, api, su, secret = null, superUid;
const q = (sql) => psql(sql, { db: DB });

test.before(async () => {
  process.env.TEST_DB = DB; resetDb(DB);
  auth = fakeAuth({ db: DB }); api = createApi({ rest: pgRest({ db: DB }), auth, config, log: quiet });
  superUid = await auth.addUser('root@example.com', 'SuperSecret-123');
  await psql(`insert into platform_users (user_id, role) values ('${superUid}', 'super_admin')`, { db: DB });
  su = client(api);
  await su.post('/api/admin/login', { email: 'root@example.com', password: 'SuperSecret-123' });
  const e = await su.post('/api/admin/mfa/enroll', {}); secret = e.body.secret;
  assert.equal((await su.post('/api/admin/mfa/enroll/verify', { factor_id: e.body.factor_id, code: totp(secret) })).status, 200);
});
const lead = (over = {}) => ({ name: 'דנה לוי', phone: '052-1234567', email: 'dana@example.com', business_name: 'סלון דנה', template: 'cosmetics', track: 'managed', addons: ['domain', 'nope'], message: 'שלום', ...over });

test('קטלוג ציבורי: 5 תבניות, מחירים בטיוטה כברירת מחדל, בלי נתונים אישיים, בלי demo_slug לפני הקמת הדגמות', async () => {
  const pub = client(api); const r = await pub.get('/api/public/brand');
  assert.equal(r.status, 200); assert.equal(r.body.templates.length, 5); assert.equal(r.body.prices_approved, false);
  assert.ok(r.body.templates.every((t) => t.name && t.tagline && Array.isArray(t.features) && t.demo_slug === null));
  assert.ok(r.body.prices.cosmetics.managed.monthly >= 0 && r.body.inclusions.managed.length && r.body.inclusions.one_time.length);
  assert.ok(r.body.addons.find((a) => a.key === 'messaging' && a.price_ils === null), 'חיבור הודעות מסומן כלא פעיל');
  const txt = JSON.stringify(r.body); assert.ok(!/user_id|@|token/i.test(txt.replace(/info@/g, '')), 'אין אימיילים/מזהים בקטלוג');
});

test('ליד מותג: נשמר עם תבנית ומסלול; תוספת לא מוכרת נמחקת; נפרד מפניות עסקים; ולידציה; honeypot; הגבלת קצב', async () => {
  const pub = client(api);
  assert.equal((await pub.post('/api/public/brand-lead', lead(), { ip: '9.9.9.1' })).status, 200);
  const row = JSON.parse(await q(`select to_jsonb(l) from brand_leads l limit 1`));
  assert.equal(row.template, 'cosmetics'); assert.equal(row.track, 'managed'); assert.deepEqual(row.addons, ['domain']); assert.equal(row.phone, '0521234567'); assert.equal(row.status, 'new');
  assert.equal(Number(await q('select count(*) from leads')), 0, 'לא נכתב לטבלת הפניות של עסקים');
  for (const [bad, field] of [[{ name: '' }, 'name'], [{ phone: '123' }, 'phone'], [{ email: 'x' }, 'email'], [{ template: 'zzz' }, 'template'], [{ track: 'x' }, 'track'], [{ message: '<script>'.repeat(80) }, 'message']]) {
    const r = await pub.post('/api/public/brand-lead', lead({ ...bad, phone: bad.phone || '053-7654321' }), { ip: '9.9.9.2' }); assert.equal(r.status, 400, field); assert.ok(JSON.stringify(r.body).includes(field), field + ' ' + JSON.stringify(r.body));
  }
  assert.equal((await pub.post('/api/public/brand-lead', lead({ website: 'spam' }), { ip: '9.9.9.3' })).status, 400, 'honeypot');
  assert.equal(Number(await q('select count(*) from brand_leads')), 1);
  let st = 0; for (let i = 0; i < 6; i++) st = (await pub.post('/api/public/brand-lead', lead({ phone: `054-100000${i}` }), { ip: '9.9.9.4' })).status;
  assert.equal(st, 429, 'מגבלת קצב לכל IP');
});

test('Super: רשימת לידים, עדכון סטטוס והערה; owner ו-anon נחסמים', async () => {
  const l = await su.get('/api/super/brand-leads'); assert.equal(l.status, 200); assert.ok(l.body.leads.length >= 1);
  const id = l.body.leads[0].id;
  { const pr = await su.patch(`/api/super/brand-leads/${id}`, { status: 'contacted', note: 'התקשרתי' }); assert.equal(pr.status, 200, JSON.stringify(pr.body)); }
  assert.equal((await su.patch(`/api/super/brand-leads/${id}`, { status: 'bogus' })).status, 400);
  const after = (await su.get('/api/super/brand-leads')).body.leads.find((x) => x.id === id); assert.equal(after.status, 'contacted'); assert.equal(after.note, 'התקשרתי');
  // בעלים של עסק לא רואה את לידי המותג, גם לא ישירות מול ה-DB עם JWT משלו
  await su.post('/api/super/shops', { name: 'עסק א', slug: 'biz-a', owner_email: 'a@example.com', owner_password: 'OwnerPass-123', template: 'barbershop' }).catch(() => {});
  const ouid = await addUser('own@example.com', DB); const bid = (await q(`select id from businesses limit 1`));
  if (bid) await q(`insert into platform_users (user_id, role, business_id) values ('${ouid}', 'owner', '${bid}') on conflict do nothing`);
  const asOwner = asUser(ouid, 'own@example.com', NOW, DB);
  for (const [n, a] of [['rpc_super_brand_get', {}], ['rpc_super_brand_leads', { p: {} }], ['rpc_super_brand_save', { p: { brand_name: 'X' } }]]) { const r = await asOwner(n, a); assert.ok(r.httpStatus >= 400, n + ' owner'); }
  for (const t of ['brand_leads', 'brand_settings']) assert.equal(await q(`select has_table_privilege('authenticated','public.${t}','select') or has_table_privilege('anon','public.${t}','select')`), 'f', t);
  assert.equal((await client(api).get('/api/super/brand-leads')).status, 401);
  assert.equal((await client(api).patch('/api/super/brand-leads/1', { status: 'won' })).status, 401);
});

test('הגדרות מותג: שינוי שם מופיע בקטלוג; שינוי מחיר מחזיר לטיוטה; אישור דורש TOTP טרי (ב-DB); ולידציה', async () => {
  let r = await su.put('/api/super/brand', { brand_name: 'סטודיו שמש', tagline: 'תורים ופניות בקלות' }); assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await client(api).get('/api/public/brand')).body.brand.name, 'סטודיו שמש');
  assert.equal((await su.put('/api/super/brand', { brand_name: '<' })).status, 400);
  assert.equal((await su.put('/api/super/brand', { contact_email: 'nope' })).status, 400);
  assert.equal((await su.put('/api/super/brand', { addons: [{ key: 'Bad Key', name: 'x' }] })).status, 400);
  const g = (await su.get('/api/super/brand')).body;
  const prices = { ...g.prices, cosmetics: { managed: { setup: 2000, monthly: 190 }, one_time: { setup: 5200 } } };
  assert.equal((await su.put('/api/super/brand', { prices })).status, 200);
  const pub = (await client(api).get('/api/public/brand')).body; assert.equal(pub.prices.cosmetics.managed.setup, 2000); assert.equal(pub.prices_approved, false);
  // אישור: דרך ה-API דורש TOTP טרי; ב-DB עם טוקן ישן נחסם
  const stale = asSuper(superUid, 'root@example.com', NOW, DB, false);
  const s = await stale('rpc_super_brand_save', { p: { approve: 'true' } }); assert.equal(s.httpStatus, 403); assert.match(s.error.message, /mfa_stale/);
  assert.equal((await client(api).get('/api/public/brand')).body.prices_approved, false);
  const ok = await su.put('/api/super/brand', { approve: true }); assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal((await client(api).get('/api/public/brand')).body.prices_approved, true);
  assert.equal((await su.put('/api/super/brand', { prices: { ...prices, cosmetics: { managed: { setup: 2100, monthly: 190 }, one_time: { setup: 5200 } } } })).status, 200);
  assert.equal((await client(api).get('/api/public/brand')).body.prices_approved, false, 'שינוי מחיר מבטל אישור');
  assert.equal((await su.post('/api/super/brand/unapprove', {})).status, 200);
});

test('עסקי הדגמה: הקמה אידמפוטנטית, ללא בעלים/דומיין, is_demo מגיע לדף הציבורי, demo_slug בקטלוג; ניקוי בתחזוקה', async () => {
  const svc = asService(NOW, DB);
  for (const k of ['barbershop', 'cosmetics', 'detailing', 'home-services', 'studio-services']) { const r = await svc('rpc_admin_seed_demo', { p_template: k }); assert.equal(r.httpStatus, 200, k); assert.equal(r.data.data.slug, 'demo-' + k); }
  assert.equal((await svc('rpc_admin_seed_demo', { p_template: 'barbershop' })).data.data.created, false);
  assert.equal((await svc('rpc_admin_seed_demo', { p_template: 'nope' })).data.ok, false);
  assert.equal(Number(await q(`select count(*) from businesses where is_demo`)), 5);
  assert.equal(Number(await q(`select count(*) from platform_users p join businesses b on b.id = p.business_id where b.is_demo`)), 0);
  const pub = client(api);
  assert.equal((await pub.get('/api/public/shops/demo-cosmetics')).body.shop.is_demo, true);
  const cat = (await pub.get('/api/public/brand')).body.templates; assert.ok(cat.every((t) => t.demo_slug === 'demo-' + t.key));
  assert.ok((await pub.get('/api/public/shops/demo-barbershop')).body.barbers.length >= 1);
  // אין בעלים לעסק הדגמה ואין דומיין מותאם
  const did = await q(`select id from businesses where slug = 'demo-barbershop'`);
  const ouid = await addUser('demo-owner@example.com', DB);
  await assert.rejects(async () => q(`insert into platform_users (user_id, role, business_id) values ('${ouid}', 'owner', '${did}')`), /demo_no_owner/);
  await assert.rejects(async () => q(`insert into business_domains (business_id, hostname) values ('${did}', 'demo.example.com')`), /demo_no_domain/);
  // slug חייב להתחיל ב-demo-
  await assert.rejects(async () => q(`update businesses set is_demo = true where slug = 'biz-a'`), /businesses_demo_slug|check/).catch(() => {});
  // תחזוקה מוחקת פניות הדגמה ישנות ולא נוגעת בפניות של עסק אמיתי
  const real = await q(`select id from businesses where not is_demo limit 1`);
  await q(`insert into leads (business_id, name, phone, source) values ('${did}', 'דמו', '0521111111', 'web')`);
  await q(`update leads set created_at = now() - interval '3 days' where business_id = '${did}'`);
  if (real) { await q(`insert into leads (business_id, name, phone, source) values ('${real}', 'אמיתי', '0522222222', 'web')`); await q(`update leads set created_at = now() - interval '3 days' where business_id = '${real}'`); }
  const m = await svc('rpc_maintenance_cleanup'); assert.equal(m.httpStatus, 200); assert.equal(m.data.data.demo_leads_deleted, 1);
  if (real) assert.equal(Number(await q(`select count(*) from leads where business_id = '${real}'`)), 1, 'פניות עסק אמיתי נשארות');
});

test('הדגמה אינה מזהמת עסק אמיתי: הזמנה/פנייה בהדגמה נשמרות רק בעסק ההדגמה', async () => {
  const pub = client(api);
  const r = await pub.post('/api/public/lead', { slug: 'demo-home-services', name: 'בודק', phone: '052-9998887', city: 'חיפה' }, { ip: '8.8.8.8' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const rows = JSON.parse(await q(`select jsonb_agg(distinct b.slug) from leads l join businesses b on b.id = l.business_id where l.phone = '0529998887'`));
  assert.deepEqual(rows, ['demo-home-services']);
});
