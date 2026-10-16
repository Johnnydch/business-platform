// מתאם בדיקות: מריץ RPC מול Postgres אמיתי באמצעות psql, באותה סמנטיקה ש-PostgREST מפעיל:
//   BEGIN; SET LOCAL ROLE <role>; set_config('request.jwt.claims', <claims>); SELECT fn(named => args); COMMIT
// כל קריאה היא סשן נפרד, ולכן קריאות מקבילות הן בקשות מקבילות אמיתיות. שגיאות מוחזרות כ-SQLSTATE.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';

const DB = () => process.env.TEST_DB || 'platform_test';

function lit(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  const tag = 'q' + randomBytes(6).toString('hex');
  return `$${tag}$${s}$${tag}$`;
}

export function psql(sql, { db = DB() } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn('psql', ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose', '-d', db], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => (code === 0 ? resolve(out.trim()) : reject(Object.assign(new Error(err.trim()), { stderr: err, code }))));
    p.stdin.end(sql);
  });
}

// role: 'service_role' | 'authenticated' | 'anon'; claims: { sub, email } לסשן authenticated; now: ISO להקפאת זמן
export async function rpc(name, args = {}, { role = 'service_role', claims = null, now = null, db } = {}) {
  const named = Object.entries(args).map(([k, v]) => `${k} => ${lit(v)}`).join(', ');
  const sql = `begin;
set local role ${role};
do $$ begin perform set_config('request.jwt.claims', ${lit(claims ? { role, ...claims } : { role })}, true);${now ? ` perform set_config('app.test_now', ${lit(now)}, true);` : ''} end $$;
select to_jsonb(public.${name}(${named}))::text;
commit;`;
  try {
    const out = await psql(sql, { db });
    const line = out.split('\n').filter((l) => l !== '').pop();
    return { httpStatus: 200, data: line ? JSON.parse(line) : null };
  } catch (e) {
    const m = /ERROR:\s+(\w{5})/.exec(e.stderr || '');
    const sqlstate = m ? m[1] : 'XX000';
    const httpStatus = sqlstate === '42501' ? 403 : sqlstate === '22023' ? 400 : sqlstate === '42883' ? 404 : 500;
    return { httpStatus, error: { code: sqlstate, message: (e.stderr || '').trim().split('\n')[0] } };
  }
}

export const sh = (sql, opts) => psql(sql, opts);
export const q = lit;
