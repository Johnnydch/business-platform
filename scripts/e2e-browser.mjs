// בדיקת דפדפן אמיתית (Chromium/Playwright) מול scripts/dev-local.mjs: זרימת לקוח, כניסת בעלים ו-Super Admin, פניות.
// שימוש: node scripts/e2e-browser.mjs http://localhost:3111 <outDir>
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { totp } from '../test/support/adapters.mjs';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { chromium } = require('/home/claude/.npm-global/lib/node_modules/playwright');
const [base = 'http://localhost:3111', out = '.'] = process.argv.slice(2);

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' }).catch(() => chromium.launch());
const ctx = await browser.newContext({ viewport: { width: 390, height: 800 }, deviceScaleFactor: 2, locale: 'he-IL', timezoneId: 'Asia/Jerusalem' });
const page = await ctx.newPage();
const errors = []; page.on('pageerror', (e) => errors.push(String(e))); page.on('console', (m) => { if (m.type() === 'error' && !/fonts\.g|ERR_|Failed to load resource/.test(m.text())) errors.push(m.text()); });
const noHScroll = async (name) => assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `horizontal scroll on ${name}`);
const stateDir = process.env.DEV_STATE_DIR || '/tmp';
const noHScrollOn = async (pg, name) => {
  const ok = await pg.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
  if (!ok) console.error('sw', await pg.evaluate(() => [document.documentElement.scrollWidth, innerWidth, ...[...document.querySelectorAll('body *')].filter((e) => e.scrollWidth > e.clientWidth + 1 && e.clientWidth > 0).slice(0, 5).map((e) => e.tagName + '.' + e.className + ':' + e.scrollWidth + '/' + e.clientWidth)].join(' ')));
  if (!ok) console.error('overflowing:', await pg.evaluate(() => [...document.querySelectorAll('body *')].filter((e) => !e.closest('.steps') && e.getBoundingClientRect().right > innerWidth + 1).slice(0, 6).map((e) => e.tagName + '.' + e.className + ' ' + Math.round(e.getBoundingClientRect().right)).join(' | ')));
  assert.equal(ok, true, `horizontal scroll on ${name}`);
};
page.context().on('response', async (r) => { if (process.env.E2E_DEBUG && r.url().includes('/api/super/drafts') && r.status() >= 400) console.error('HTTP', r.status(), r.url().split('/').slice(-2).join('/'), (await r.text().catch(() => '')).slice(0, 300)); });
const shot = (n) => page.screenshot({ path: `${out}/${n}.png` });

/* --- לקוח: הזמנה ללא חשבון --- */
await page.goto(`${base}/b/gold`); await page.waitForSelector('.pick');
assert.equal(await page.evaluate(() => [document.documentElement.dir, getComputedStyle(document.body).backgroundColor]).then((x) => x.join()), 'rtl,rgb(10, 10, 11)');
await noHScroll('service step'); await shot('c1-service');
await page.click('.pick >> nth=2'); await page.click('.pick >> nth=0');
await page.waitForSelector('.day:not([disabled])'); await page.click('.day:not([disabled]) >> nth=1');
await page.waitForSelector('.time'); await page.click('.time >> nth=3'); await noHScroll('slots'); await shot('c2-slots');
await page.click('.dock button'); await page.waitForSelector('#f-first_name');
assert.equal(await page.locator('form input:not([name=website])').count(), 3, 'exactly 3 customer fields');
await page.fill('#f-first_name', 'רון'); await page.fill('#f-last_name', 'לוי'); await page.fill('#f-phone', '123');
await page.click('button[type=submit]'); assert.ok(await page.locator('.errmsg', { hasText: 'מספר נייד ישראלי' }).count()); await shot('c3-invalid');
await page.fill('#f-phone', '052-7654321'); await page.click('button[type=submit]');
await page.waitForSelector('.okmark'); await noHScroll('confirmation'); await shot('c4-confirmed');
const confirmText = await page.locator('.sum').first().innerText();
for (const w of ['יוסי', 'תספורת + זקן']) assert.ok(confirmText.includes(w), 'confirmation missing ' + w);
const manage = await page.inputValue('.linkbox input');
/* --- לקוח: ניהול תור בקישור אישי --- */
await page.goto(manage); await page.waitForSelector('.sum'); await noHScroll('manage'); await shot('c5-manage');
assert.ok((await page.locator('.sum').innerText()).includes('•••••4321'));
await page.click('text=ביטול התור'); await page.click('.modal .btn.danger, [role=dialog] .btn.danger').catch(async () => { await page.click('text=כן, לבטל'); });
await page.waitForSelector('text=התור בוטל');

/* --- בעל עסק --- */
await page.goto(`${base}/admin`); await page.waitForSelector('form'); await shot('a0-login');
await page.fill('input[name=email]', 'o@example.com'); await page.fill('input[name=password]', 'OwnerPass-123'); await page.click('button[type=submit]');
await page.waitForSelector('.stats'); await noHScroll('owner dashboard'); await shot('a1-dashboard');
for (const t of ['calendar', 'team', 'services', 'customers', 'leads', 'settings']) { await page.click(`.tabs button[data-tab=${t}]`); await page.waitForTimeout(500); await noHScroll('owner ' + t); }
await page.click('.tabs button[data-tab=customers]'); await page.waitForSelector('.item'); assert.ok((await page.locator('.item').first().innerText()).includes('רון'));
await shot('a2-customers');
await page.click('.tabs button[data-tab=leads]'); await shot('a3-leads-empty');

/* --- דף לידים (תבנית קטלוג שירותים, ערכת נושא אחרת) --- */
const p2 = await (await browser.newContext({ viewport: { width: 390, height: 800 }, deviceScaleFactor: 2 })).newPage();
await p2.goto(`${base}/l/leads-demo`); await p2.waitForSelector('form');
assert.equal(await p2.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgb(244, 239, 231)', 'default theme applied');
await p2.screenshot({ path: `${out}/l1-lead.png` });
await p2.fill('#f-name', 'מיכל כהן'); await p2.fill('#f-phone', '052-1234567'); await p2.fill('#f-message', 'מעוניינת בחבילה'); await p2.click('button[type=submit]');
await p2.waitForSelector('text=הבקשה התקבלה'); await p2.screenshot({ path: `${out}/l2-thanks.png` });
const lo = await (await browser.newContext({ viewport: { width: 390, height: 800 }, deviceScaleFactor: 2 })).newPage();
await lo.goto(`${base}/admin`); await lo.fill('input[name=email]', 'l@example.com'); await lo.fill('input[name=password]', 'OwnerPass-123'); await lo.click('button[type=submit]');
await lo.waitForSelector('.tabs'); assert.deepEqual(await lo.locator('.tabs button').allInnerTexts(), ['בקשות הצעה', 'שירותים', 'יומן פעולות', 'הגדרות']);
await lo.waitForSelector('.card'); assert.ok((await lo.locator('.card').first().innerText()).includes('מיכל כהן')); await lo.screenshot({ path: `${out}/a4-leads-owner.png` });

/* --- Super Admin: הקמת MFA (משתמש חדש ללא MFA), כולל חסימת נתוני פלטפורמה עד האימות --- */
const mkctx = async () => { const c = await browser.newContext({ viewport: { width: 390, height: 800 }, deviceScaleFactor: 2 }); c.on('response', async (r) => { if (process.env.E2E_DEBUG && r.url().includes('/api/super/drafts') && r.status() >= 400) console.error('HTTP', r.status(), r.url().split('/').slice(-2).join('/'), (await r.text().catch(() => '')).slice(0, 300)); }); return c.newPage(); };
const np = await mkctx();
await np.goto(`${base}/admin`); await np.fill('input[name=email]', 'newadmin@example.com'); await np.fill('input[name=password]', 'NewAdmin-Pass-12345'); await np.click('button[type=submit]');
await np.waitForSelector('.qr'); await noHScrollOn(np, 'mfa enroll');
const newSecret = (await np.locator('.secret').innerText()).trim(); assert.match(newSecret, /^[A-Z2-7]{32}$/);
assert.equal(await np.evaluate(async () => (await fetch('/api/super/shops', { credentials: 'same-origin' })).status), 403, 'Super בלי MFA לא רואה נתוני פלטפורמה');
await np.screenshot({ path: `${out}/m1-mfa-enroll.png` });
await np.fill('input[name=code]', '000000'); await np.click('button[type=submit]'); await np.waitForSelector('text=שגוי');
await np.fill('input[name=code]', totp(newSecret)); await np.click('button[type=submit]');
await np.waitForSelector('text=עסקים בפלטפורמה'); await np.close();

/* --- Super Admin: כניסה עם MFA קיים --- */
const rootSecret = readFileSync(join(stateDir, 'dev-root-totp-secret.txt'), 'utf8').trim();
const sp = await mkctx();
await sp.goto(`${base}/admin`); await sp.fill('input[name=email]', 'root@example.com'); await sp.fill('input[name=password]', 'SuperSecret-123'); await sp.click('button[type=submit]');
await sp.waitForSelector('input[name=code]'); await sp.screenshot({ path: `${out}/m2-mfa-verify.png` });
await sp.fill('input[name=code]', '123456'); await sp.click('button[type=submit]'); await sp.waitForSelector('text=שגוי');
await sp.fill('input[name=code]', totp(rootSecret)); await sp.click('button[type=submit]');
await sp.waitForFunction(() => document.querySelectorAll('.card:has(.item .d.ltr)').length === 10); assert.equal(await sp.locator('.card:has(.item .d.ltr)').count(), 10, '5 עסקים + 5 הדגמות'); await sp.screenshot({ path: `${out}/s1-platform.png` });
// ניהול בעלים
await sp.locator('button:has-text("בעלי העסק")').first().click(); await sp.waitForSelector('.modal .t.ltr'); assert.ok((await sp.locator('.modal').innerText()).includes('@example.com'));
await sp.screenshot({ path: `${out}/s3-owners.png` }); await sp.keyboard.press('Escape');
// יומן ביקורת: בלי PII
await sp.click('.tabs button[data-tab=audit]'); await sp.waitForSelector('text=עסק נוצר'); await sp.screenshot({ path: `${out}/s4-audit.png` });
const auditText = await sp.locator('#view').innerText();
for (const pii of ['@example.com', '052-1234567', 'מיכל', 'רון']) assert.ok(!auditText.includes(pii), 'PII ביומן: ' + pii);
await sp.click('.tabs button[data-tab=platform]');
await sp.click('text=+ עסק חדש'); await sp.waitForSelector('select[name=template]');
assert.deepEqual(await sp.locator('select[name=template] option').allInnerTexts(), ['מספרות וברברשופ', 'קוסמטיקה, ציפורניים וריסים', 'דיטיילינג ושטיפת רכב', 'בעלי מקצוע ושירותי בית', 'נותני שירות וסטודיואים']);   // קוסמטיקה/דיטיילינג עדיין לא זמינות
await sp.screenshot({ path: `${out}/s2-newshop.png` });

/* --- אשף הקמה: טיוטה, שמירה והמשך, חסימת פרסום חסר, פרסום, ודומיין עם סטטוס אמיתי --- */
await sp.click('button:has-text("יצירת טיוטה")'); await sp.waitForSelector('.wizhead'); await noHScrollOn(sp, 'wizard step1');
await sp.click('button:has-text("המשך")'); await sp.waitForSelector('input[name="business.name"]');
await sp.fill('input[name="business.name"]', 'מספרת האשף'); await sp.click('button:has-text("חזרה")'); await sp.click('button:has-text("יציאה")');
await sp.waitForSelector('[data-drafts] >> text=מספרת האשף');                       // הטיוטה נשמרה ונראית ברשימה
await sp.click('[data-drafts] button:has-text("המשך")'); await sp.waitForSelector('.wizhead');
await sp.click('.steps button:has-text("2.")'); assert.equal(await sp.inputValue('input[name="business.name"]'), 'מספרת האשף', 'draft resumed');
await sp.screenshot({ path: `${out}/w1-details.png` });
await sp.click('.steps button:has-text("8.")'); await sp.waitForSelector('.notice.bad');   // חוסרים: אין פרסום
assert.equal(await sp.locator('button:has-text("פרסום העסק")').isDisabled(), true, 'publish blocked while incomplete');
await sp.screenshot({ path: `${out}/w2-incomplete.png` });
await sp.click('.steps button:has-text("2.")');
await sp.fill('input[name="business.slug"]', 'wizard-demo'); await sp.fill('input[name="business.phone"]', '052-1112233'); await sp.fill('input[name="owner.email"]', 'wiz-owner@example.com');
await sp.click('.steps button:has-text("3.")'); await sp.fill('input[name="brand.tagline"]', 'תספורת מדויקת'); await sp.fill('input[name="domain.hostname"]', '').catch(() => {});
await sp.evaluate(() => { const c = document.querySelector('input[type=color]'); c.value = '#3a7bd5'; c.dispatchEvent(new Event('input', { bubbles: true })); });
await sp.screenshot({ path: `${out}/w3-brand.png` });
await sp.click('.steps button:has-text("4.")'); await sp.waitForSelector('.wrow'); await noHScrollOn(sp, 'wizard services');
await sp.click('.steps button:has-text("5.")'); await sp.waitForSelector('.hrs'); await sp.waitForTimeout(400); await noHScrollOn(sp, 'wizard staff'); await sp.screenshot({ path: `${out}/w4-staff.png` });
await sp.click('.steps button:has-text("6.")'); await sp.waitForSelector('.previewbox'); await sp.screenshot({ path: `${out}/w5-preview.png` });
await sp.click('.steps button:has-text("7.")'); await sp.fill('input[name="domain.hostname"]', 'book.wizard-demo.example');
await sp.click('.steps button:has-text("8.")'); await sp.waitForSelector('.notice.ok');
await sp.fill('input[name=owner_password]', 'WizardPass-12345'); await sp.click('button:has-text("פרסום העסק")');
await sp.waitForSelector('input[name=code], :text("העסק פורסם")');
if (await sp.locator('input[name=code]').count()) { await sp.fill('input[name=code]', totp(rootSecret)); await sp.click('.modal button[type=submit]'); }
await sp.waitForSelector('text=העסק פורסם'); await sp.waitForSelector('[data-domain="book.wizard-demo.example"]');
assert.ok((await sp.locator('[data-domain]').innerText()).includes('_bsverify.book.wizard-demo.example'), 'DNS instructions shown');
await sp.click('[data-domain] button:has-text("בדיקת חיבור")'); await sp.waitForSelector('[data-domain] .notice.bad');          // אין DNS אמיתי: חייב להישאר "ממתין" עם שגיאה אמיתית
const dtxt = await sp.locator('[data-domain]').innerText(); assert.ok(dtxt.includes('ממתין') && !dtxt.includes('פעיל'), 'domain must not be simulated as active');
await sp.screenshot({ path: `${out}/w6-published-domain.png` });
await sp.click('button:has-text("סיום")'); await sp.waitForSelector('text=wizard-demo');
assert.equal(await sp.evaluate(() => document.documentElement.style.getPropertyValue('--gold')), '', 'brand preview must not leak into admin chrome');
const pub = await mkctx(); await pub.goto(`${base}/b/wizard-demo`); await pub.waitForSelector('.pick'); assert.ok(await pub.locator('h1', { hasText: 'מספרת האשף' }).count()); await pub.close();


/* --- אתר המותג: קטלוג, סינון, הדגמה, ליד; ניהול מותג ב-Super (שם, מחיר טיוטה, אישור, ליד נפרד) --- */
const bp = await mkctx(); await bp.goto(`${base}/`); await bp.waitForSelector('.tpl'); await noHScrollOn(bp, 'brand home');
assert.equal(await bp.locator('.tpl').count(), 5); assert.ok((await bp.locator('.notice.warn').innerText()).includes('טיוטה'));
assert.ok(await bp.locator('.price-line .pill', { hasText: 'טיוטה' }).count() >= 5, 'prices flagged as draft');
await bp.screenshot({ path: `${out}/b1-brand-mobile.png`, fullPage: true });
await bp.click('.chip:has-text("הזמנת תורים")'); assert.equal(await bp.locator('.tpl').count(), 3);
await bp.click('.chip:has-text("קבלת פניות")'); assert.equal(await bp.locator('.tpl').count(), 2); await bp.click('.chip:has-text("הכול")');
const demoHref = await bp.getAttribute('.tpl[data-template="cosmetics"] a:has-text("להדגמה")', 'href'); assert.equal(demoHref, '/b/demo-cosmetics');
await bp.click('.tpl[data-template="cosmetics"] button:has-text("מתעניינים")'); assert.equal(await bp.inputValue('#f-template'), 'cosmetics');
await bp.fill('#f-name', 'נועה כהן'); await bp.fill('#f-phone', '12'); await bp.click('button[type=submit]'); assert.ok(await bp.locator('.errmsg', { hasText: 'מספר נייד' }).count());
await bp.fill('#f-phone', '053-5551234'); await bp.click('.chip:has-text("מנוהל")'); await bp.fill('#f-business_name', 'סלון נועה'); await bp.click('button[type=submit]'); await bp.waitForSelector('#brand-thanks');
await bp.screenshot({ path: `${out}/b2-brand-thanks.png` });
const dp = await mkctx(); await dp.goto(`${base}${demoHref}`); await dp.waitForSelector('.pick'); assert.ok(await dp.locator('[data-demo]').count(), 'demo banner'); await dp.screenshot({ path: `${out}/b3-demo.png` }); await dp.close();
const dl = await mkctx(); await dl.goto(`${base}/l/demo-home-services`); await dl.waitForSelector('form'); assert.ok(await dl.locator('[data-demo]').count(), 'demo banner (leads)'); await dl.close();
const bd = await browser.newContext({ viewport: { width: 1280, height: 900 } }).then((c) => c.newPage()); await bd.goto(`${base}/`); await bd.waitForSelector('.tpl'); await bd.screenshot({ path: `${out}/b4-brand-desktop.png`, fullPage: true }); await bd.close();
// Super: ניהול מותג
await sp.click('.tabs button[data-tab=brand]'); await sp.waitForSelector('text=פניות מהאתר'); await noHScrollOn(sp, 'brand admin');
assert.ok((await sp.locator('[data-brand-lead]').first().innerText()).includes('נועה כהן'), 'brand lead visible to super');
await sp.fill('input[name=brand_name]', 'סטודיו שמש'); await sp.locator('form button[type=submit]').click(); await sp.waitForSelector('text=נשמר');
await sp.screenshot({ path: `${out}/b5-brand-admin.png`, fullPage: true });
await bp.reload(); await bp.waitForSelector('#brand-name'); assert.equal(await bp.innerText('#brand-name'), 'סטודיו שמש', 'brand name editable');
await sp.click('button:has-text("שמירה ואישור מחירים")'); await sp.click('.modal .btn.primary, [role=dialog] .btn.primary');
await sp.waitForSelector('input[name=code], :text("המחירים אושרו")');
if (await sp.locator('input[name=code]').count()) { await sp.fill('input[name=code]', totp(rootSecret)); await sp.click('.modal button[type=submit]'); }
await sp.waitForSelector('text=מחירים: מאושרים');
await bp.reload(); await bp.waitForSelector('.tpl'); assert.equal(await bp.locator('.notice.warn').count(), 0, 'draft notice removed after approval');
// בעל עסק לא רואה לשונית מותג
assert.equal(await lo.locator('.tabs button[data-tab=brand]').count(), 0);
assert.deepEqual(errors, [], 'browser errors: ' + errors.join(' | '));
console.log('E2E OK');
await browser.close();
