import { execFileSync } from 'node:child_process';
import { psql, rpc } from './pg.mjs';

export const NOW = '2026-10-16T18:30:00Z';   // 21:30 שעון ישראל (UTC+3), יום שישי

export function resetDb(name) {
  execFileSync('scripts/db-reset-local.sh', [name], { stdio: 'pipe', env: process.env });
}

// SQL ישיר תחת רול (כמו PostgREST) – לבדיקת RLS והרשאות
export async function asRole(role, claims, sql, opts = {}) {
  const wrapped = `begin;\nset local role ${role};\ndo $$ begin perform set_config('request.jwt.claims', '${JSON.stringify({ role, ...(claims || {}) })}', true);${opts.now ? ` perform set_config('app.test_now','${opts.now}',true);` : ''} end $$;\n${sql};\ncommit;`;
  try { const o = await psql(wrapped, opts); return { ok: true, out: o.split('\n').filter((l) => l !== '').pop() ?? '' }; }
  catch (e) { const m = /ERROR:\s+(\w{5})/.exec(e.stderr || ''); return { ok: false, sqlstate: m ? m[1] : 'XX000', message: e.stderr }; }
}

export async function addUser(email, db) {
  return (await psql(`insert into auth.users (email) values ('${email}') returning id`, { db })).split('\n')[0];
}

export const asUser = (uid, email, now = NOW, db, extra = {}) => (name, args = {}) =>
  rpc(name, args, { role: 'authenticated', claims: { sub: uid, email, ...extra }, now, db });
// Super Admin אחרי MFA: aal2 + חותמת TOTP טרייה (כמו JWT שהנפיק GoTrue אחרי אימות). fresh=false → חותמת ישנה (חצי שעה)
export const superClaims = (now = NOW, fresh = true) => {
  const t = Math.floor(Date.parse(now) / 1000) - (fresh ? 60 : 1800);
  return { aal: 'aal2', amr: [{ method: 'totp', timestamp: t }, { method: 'password', timestamp: t - 5 }] };
};
export const asSuper = (uid, email, now = NOW, db, fresh = true) => asUser(uid, email, now, db, superClaims(now, fresh));
export const asService = (now = NOW, db) => (name, args = {}) => rpc(name, args, { role: 'service_role', now, db });

export const WEEK_HOURS = [0, 1, 2, 3, 4].map((weekday) => ({ weekday, start_min: 540, end_min: 1080 })).concat([{ weekday: 5, start_min: 480, end_min: 840 }]);
