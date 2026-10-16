// שרת פיתוח מקומי לבדיקה ויזואלית. אותו קוד API כמו ב-Netlify, מול Postgres מקומי אמיתי.
// ⚠ ה-Auth כאן מדומה (test/support/adapters.mjs) – זה אינו Supabase Auth. לא לפריסה.
//   דרישות: Postgres מקומי (PGHOST/PGPORT/PGUSER). שימוש: node scripts/dev-local.mjs [port]
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { psql } from '../test/support/pg.mjs';
import { pgRest, fakeAuth, totp } from '../test/support/adapters.mjs';
import { writeFileSync } from 'node:fs';
import { createApi } from '../lib/api.mjs';
import { WEEK_HOURS } from '../test/support/db.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PUBLIC = join(ROOT, 'public');
const DB = 'platform_dev', port = Number(process.argv[2]) || 3111;
process.env.TEST_DB = DB;
execFileSync(join(ROOT, 'scripts/db-reset-local.sh'), [DB], { stdio: 'inherit' });

const auth = fakeAuth({ db: DB, ttl: 3600, clock: () => Date.now() });
const api = createApi({ rest: pgRest({ db: DB, now: null }), auth, config: { pepper: 'dev-pepper-0123456789-0123456789-xx', publicBaseUrl: `http://localhost:${port}`, allowedOrigins: [`http://localhost:${port}`, `http://127.0.0.1:${port}`], cookieSecure: false } });

// נתוני דמו (פיקטיביים) כדי שיהיה מה לראות
const uRoot = await auth.addUser('root@example.com', 'SuperSecret-123');
await psql(`insert into platform_users (user_id, role) values ('${uRoot}', 'super_admin')`, { db: DB });
const call = async (method, path, body, cookie) => api.handle({ method, pathname: path, query: new URLSearchParams(), ip: '127.0.0.9', https: false, headers: { host: `localhost:${port}`, origin: `http://localhost:${port}`, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body || {}) });
const login = async (e, p) => { const r = await call('POST', '/api/admin/login', { email: e, password: p }); return r.cookies.map((c) => c.split(';')[0]).join('; '); };
const cookiesOf = (r) => r.cookies.map((c) => c.split(';')[0]).join('; ');
// כניסת Super Admin דורשת MFA: מקימים TOTP למשתמש הדמו. הסוד נשמר לקובץ מקומי (פיתוח בלבד) כדי שבדיקת הדפדפן תוכל לחשב קודים.
let su = await login('root@example.com', 'SuperSecret-123');
const enr = await call('POST', '/api/admin/mfa/enroll', {}, su);
const vr = await call('POST', '/api/admin/mfa/enroll/verify', { factor_id: enr.body.factor_id, code: totp(enr.body.secret) }, su);
su = cookiesOf(vr);
writeFileSync(join(process.env.DEV_STATE_DIR || '/tmp', 'dev-root-totp-secret.txt'), enr.body.secret, { mode: 0o600 });
// משתמש Super Admin נוסף ללא MFA – להדגמת מסך ההקמה
const uNew = await auth.addUser('newadmin@example.com', 'NewAdmin-Pass-12345');
await psql(`insert into platform_users (user_id, role) values ('${uNew}', 'super_admin')`, { db: DB });
await call('POST', '/api/super/shops', { name: 'מספרת זהב', slug: 'gold', owner_email: 'o@example.com', owner_password: 'OwnerPass-123' }, su);
// עסקי הדגמה סינתטיים (ללא בעלים וללא נתוני אמת) – אחד לכל תבנית
for (const k of ['barbershop', 'cosmetics', 'detailing', 'home-services', 'studio-services']) await psql(`select public.rpc_admin_seed_demo('${k}')`, { db: DB });
const PW = 'OwnerPass-123';
const mk = (name, slug, template, email) => call('POST', '/api/super/shops', { name, slug, template, owner_email: email, owner_password: PW }, su);
await mk('סטודיו לידים', 'leads-demo', 'studio-services', 'l@example.com');
await mk('גלואו סטודיו', 'glow', 'cosmetics', 'c@example.com');
await mk('פיט סטופ דיטיילינג', 'pitstop', 'detailing', 'd@example.com');
await mk('מים וזרם – שירותי בית', 'fixit', 'home-services', 'h@example.com');
const ow = await login('o@example.com', PW);
for (const n of ['יוסי', 'משה']) await call('POST', '/api/admin/barbers', { name: n, hours: WEEK_HOURS }, ow);
const co = await login('c@example.com', PW);
for (const n of ['נועה', 'מאיה']) await call('POST', '/api/admin/barbers', { name: n, hours: WEEK_HOURS }, co);
const dto = await login('d@example.com', PW);
for (const n of ['תחנה 1', 'תחנה 2']) await call('POST', '/api/admin/barbers', { name: n, hours: WEEK_HOURS }, dto);
console.log('דמו (פיתוח בלבד; Auth מדומה): root@example.com / SuperSecret-123 + TOTP (הסוד בקובץ dev-root-totp-secret.txt) · newadmin@example.com / NewAdmin-Pass-12345 (ללא MFA) · o@example.com / OwnerPass-123 (gold) · l@example.com / OwnerPass-123 (leads-demo)');

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };
const REWRITES = [[/^\/b\/[^/]+\/?$/, '/book.html'], [/^\/l\/[^/]+\/?$/, '/lead.html'], [/^\/m\/[^/]+\/?$/, '/manage.html'], [/^\/admin\/?$/, '/admin.html'], [/^\/$/, '/index.html']];
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  res.setHeader('Content-Security-Policy', CSP);
  if (url.pathname.startsWith('/api/')) {
    const chunks = []; for await (const c of req) chunks.push(c);
    const headers = {}; for (const [k, v] of Object.entries(req.headers)) headers[k.toLowerCase()] = String(v);
    const out = await api.handle({ method: req.method, pathname: url.pathname, query: url.searchParams, headers, body: Buffer.concat(chunks).toString('utf8'), ip: req.socket.remoteAddress, https: false });
    res.writeHead(out.status, { 'Content-Type': 'application/json; charset=utf-8', ...out.headers, ...(out.cookies.length ? { 'Set-Cookie': out.cookies } : {}) });
    return res.end(JSON.stringify(out.body ?? null));
  }
  const rw = REWRITES.find(([re]) => re.test(url.pathname));
  const file = normalize(join(PUBLIC, rw ? rw[1] : url.pathname));
  if (!file.startsWith(PUBLIC + sep)) { res.writeHead(404); return res.end(); }
  try { const data = await readFile(file); res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' }); res.end(data); }
  catch { res.writeHead(404); res.end('לא נמצא'); }
}).listen(port, () => console.log(`http://localhost:${port}`));
