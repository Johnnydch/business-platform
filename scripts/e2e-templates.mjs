// בדיקת דפדפן לכל חמש התבניות מול scripts/dev-local.mjs: עיצוב ייעודי, RTL, מובייל ודסקטופ, מצבי טעינה/שגיאה/ריק,
// והתמדה אמיתית (תור או פנייה) כולל הצגתה אצל הבעלים הנכון. שימוש: node scripts/e2e-templates.mjs http://localhost:3111 <outDir>
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require('/home/claude/.npm-global/lib/node_modules/playwright');
const [base = 'http://localhost:3111', out = '.'] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' }).catch(() => chromium.launch());
const errors = [];
const newPage = async (w, h) => {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: w < 600 ? 2 : 1, locale: 'he-IL', timezoneId: 'Asia/Jerusalem' });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(String(e)));
  p.on('console', (m) => { if (m.type() === 'error' && !/fonts\.g|ERR_|Failed to load resource/.test(m.text())) errors.push(m.text()); });
  return p;
};
const noH = async (p, n) => assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'horizontal scroll: ' + n);
const bg = (p) => p.evaluate(() => getComputedStyle(document.body).backgroundColor);

const T = [
  { key: 'barbershop', slug: 'gold', kind: 'booking', theme: 'barbershop-gold', owner: 'o@example.com', words: { staff: 'ספר', cta: 'אישור הזמנת תור', done: 'התור נקבע בהצלחה' } },
  { key: 'cosmetics', slug: 'glow', kind: 'booking', theme: 'cosmetics-blush', owner: 'c@example.com', words: { staff: 'מטפלת', cta: 'אישור הזמנת הטיפול', done: 'הטיפול נקבע' } },
  { key: 'detailing', slug: 'pitstop', kind: 'booking', theme: 'detailing-graphite', owner: 'd@example.com', words: { staff: 'תחנה', cta: 'אישור הזמנת התור', done: 'התור לרכב נקבע' } },
  { key: 'home-services', slug: 'fixit', kind: 'leads', theme: 'home-orange', owner: 'h@example.com', words: { cta: 'שליחת בקשה', done: 'קיבלנו את הפנייה', tab: 'פניות' }, extra: { city: 'חיפה', urgencyText: 'דחוף – היום' } },
  { key: 'studio-services', slug: 'leads-demo', kind: 'catalog', theme: 'studio-paper', owner: 'l@example.com', words: { cta: 'שליחת בקשה', done: 'הבקשה התקבלה', tab: 'בקשות הצעה' }, extra: { budgetText: '₪3,000–10,000' } },
];
const backgrounds = new Set();
let n = 0;
for (const t of T) {
  const mob = await newPage(390, 844), desk = await newPage(1280, 800);
  const url = t.kind === 'booking' ? `${base}/b/${t.slug}` : `${base}/l/${t.slug}`;
  await mob.goto(url); await mob.waitForSelector(t.kind === 'booking' ? '.pick' : '#lead-form');
  assert.equal(await mob.evaluate(() => document.documentElement.dir), 'rtl');
  assert.equal(await mob.evaluate(() => document.documentElement.dataset.theme), t.theme, t.key + ': theme');
  assert.ok((await mob.getAttribute('#theme-css', 'href')).endsWith(`/${t.theme}.css`));
  backgrounds.add(await bg(mob));
  await noH(mob, t.key + ' mobile');
  await mob.screenshot({ path: `${out}/${t.key}-mobile-1.png` });
  await desk.goto(url); await desk.waitForSelector(t.kind === 'booking' ? '.pick' : '#lead-form'); await noH(desk, t.key + ' desktop');
  await desk.screenshot({ path: `${out}/${t.key}-desktop.png` });
  const phone = '05' + String(2000000 + (++n) * 1111).padStart(8, '0');

  if (t.kind === 'booking') {
    const stepText = await mob.locator('.steps').innerText();
    assert.ok(stepText.includes(t.words.staff), t.key + ': stepper uses staff label');
    await mob.click('.pick >> nth=0'); await mob.click('.pick >> nth=0');
    await mob.waitForSelector('.day:not([disabled])'); await mob.click('.day:not([disabled]) >> nth=2');
    await mob.waitForSelector('.time'); await mob.click('.time >> nth=2'); await noH(mob, t.key + ' slots'); await mob.screenshot({ path: `${out}/${t.key}-mobile-2-slots.png` });
    await mob.click('.dock button'); await mob.waitForSelector('#f-first_name');
    assert.equal(await mob.locator('button[type=submit]').innerText(), t.words.cta);
    await mob.fill('#f-first_name', 'דנה'); await mob.fill('#f-last_name', 'כהן'); await mob.fill('#f-phone', phone);
    await mob.screenshot({ path: `${out}/${t.key}-mobile-3-details.png` });
    await mob.click('button[type=submit]'); await mob.waitForSelector('.okmark');
    assert.ok((await mob.locator('h1.gold').innerText()).includes(t.words.done));
    await noH(mob, t.key + ' confirmation'); await mob.screenshot({ path: `${out}/${t.key}-mobile-4-done.png` });
    const link = await mob.inputValue('.linkbox input');
    await mob.goto(link); await mob.waitForSelector('.sum'); await noH(mob, t.key + ' manage'); await mob.screenshot({ path: `${out}/${t.key}-mobile-5-manage.png` });
  } else {
    await mob.fill('#f-name', 'יעל לוי'); await mob.fill('#f-phone', phone);
    if (t.key === 'home-services') {
      await mob.fill('#f-city', t.extra.city); await mob.click(`button.chip:has-text("${t.extra.urgencyText}")`);
      await mob.fill('#f-message', 'נזילה מתחת לכיור');
    } else {
      await mob.click(`button.chip:has-text("${t.extra.budgetText}")`); await mob.click('button.chip:has-text("תוך חודש")'); await mob.fill('#f-message', 'צילום למיתוג של עסק חדש');
    }
    await mob.screenshot({ path: `${out}/${t.key}-mobile-2-filled.png` });
    assert.equal(await mob.locator('button[type=submit]').innerText(), t.words.cta);
    await mob.click('button[type=submit]'); await mob.waitForSelector('.okmark, h1.gold');
    assert.ok((await mob.locator('h1.gold').innerText()).includes(t.words.done)); await noH(mob, t.key + ' done'); await mob.screenshot({ path: `${out}/${t.key}-mobile-3-done.png` });
  }

  /* הבעלים הנכון רואה את הנתון, בלשוניות ובמונחים של התבנית */
  const adm = await newPage(390, 844);
  await adm.goto(`${base}/admin`); await adm.waitForSelector('input[type=email], input[name=email]');
  await adm.fill('input[type=email], input[name=email]', t.owner); await adm.fill('input[type=password]', 'OwnerPass-123'); await adm.click('button[type=submit]');
  await adm.waitForSelector('nav.tabs');
  const tabs = await adm.locator('nav.tabs button').allInnerTexts();
  if (t.kind === 'booking') {
    assert.ok(tabs.some((x) => x.includes(t.words.staff === 'ספר' ? 'ספרים' : t.words.staff === 'מטפלת' ? 'מטפלות' : 'תחנות')), t.key + ' tabs: ' + tabs.join('|'));
    await adm.click('nav.tabs [data-tab=dashboard]'); await adm.waitForSelector('.stats'); await noH(adm, t.key + ' admin');
    await adm.screenshot({ path: `${out}/${t.key}-admin-mobile.png` });
    await adm.click('nav.tabs [data-tab=customers]'); await adm.waitForSelector('.list .item, .empty');
    assert.ok((await adm.locator('main').innerText()).includes('דנה כהן'), t.key + ': booked customer visible to owner');
  } else {
    assert.ok(tabs.some((x) => x.includes(t.words.tab)), t.key + ' tabs: ' + tabs.join('|'));
    await adm.waitForSelector('.card'); const txt = await adm.locator('main').innerText();
    assert.ok(txt.includes('יעל לוי'), t.key + ': lead visible to owner');
    for (const w of Object.values(t.extra)) assert.ok(txt.includes(w), t.key + ': lead meta shown: ' + w);
    await noH(adm, t.key + ' admin'); await adm.screenshot({ path: `${out}/${t.key}-admin-mobile.png` });
  }
  await mob.context().close(); await desk.context().close(); await adm.context().close();
}
assert.equal(backgrounds.size, 5, 'כל תבנית עם רקע ייחודי: ' + [...backgrounds].join(' | '));

/* מצבי שגיאה וריק */
const ep = await newPage(390, 844);
await ep.goto(`${base}/b/no-such-shop`); await ep.waitForSelector('.empty'); assert.ok((await ep.locator('.empty').innerText()).includes('לא נמצא'));
await ep.goto(`${base}/l/no-such-shop`); await ep.waitForSelector('.empty'); assert.ok((await ep.locator('.empty').innerText()).includes('לא נמצא'));
await ep.screenshot({ path: `${out}/state-not-found.png` });
assert.deepEqual(errors, [], 'console/page errors: ' + errors.join('\n'));
await browser.close();
console.log('TEMPLATES E2E OK');
