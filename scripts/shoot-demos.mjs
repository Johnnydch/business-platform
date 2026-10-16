// צילומי מסך אמיתיים של עסקי ההדגמה ואתר המותג (מובייל ודסקטופ) מול שרת פיתוח/סביבת בדיקה.
// שימוש: node scripts/shoot-demos.mjs http://localhost:3111 docs/screenshots
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
const { chromium } = createRequire(import.meta.url)('/home/claude/.npm-global/lib/node_modules/playwright');
const [base = 'http://localhost:3111', out = 'docs/screenshots'] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' }).catch(() => chromium.launch());
const T = [['barbershop', 'b'], ['cosmetics', 'b'], ['detailing', 'b'], ['home-services', 'l'], ['studio-services', 'l']];
const sizes = { mobile: { width: 390, height: 844 }, desktop: { width: 1280, height: 800 } };
for (const [name, vp] of Object.entries(sizes)) {
  const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: name === 'mobile' ? 2 : 1, locale: 'he-IL' });
  const p = await ctx.newPage();
  await p.goto(`${base}/`); await p.waitForSelector('.tpl'); await p.waitForTimeout(400); await p.screenshot({ path: `${out}/brand-${name}.png`, fullPage: true });
  for (const [key, path] of T) {
    await p.goto(`${base}/${path}/demo-${key}`); await p.waitForSelector(path === 'b' ? '.pick' : 'form'); await p.waitForTimeout(400);
    const m = await p.evaluate(() => ({ dir: document.documentElement.dir, noHScroll: document.documentElement.scrollWidth <= innerWidth, demo: !!document.querySelector('[data-demo]'), h1: !!document.querySelector('h1') }));
    if (m.dir !== 'rtl' || !m.noHScroll || !m.demo || !m.h1) { console.error(`FAIL ${key} ${name}`, JSON.stringify(m)); process.exitCode = 1; } else console.log(`OK   ${key} ${name} (rtl, no h-scroll, demo banner)`);
    await p.screenshot({ path: `${out}/${key}-${name}.png`, fullPage: path === 'l' });
  }
  await ctx.close();
}
await browser.close(); console.log('צולם אל', out);
