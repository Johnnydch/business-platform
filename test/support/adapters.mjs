// מתאמי בדיקה לשכבת ה-API:
//  • pgRest  – אותה ממשק כמו lib/clients/supabase-rest.mjs, אבל מריץ את ה-RPC על Postgres אמיתי (psql, role/claims כמו PostgREST).
//  • fakeAuth – תחליף מפורש ל-Supabase Auth (GoTrue): לא נבדק כאן GoTrue עצמו, רק האינטגרציה שלנו מולו.
import { rpc, psql } from './pg.mjs';
import { RpcError } from '../../lib/clients/supabase-rest.mjs';
import { AuthError } from '../../lib/clients/supabase-auth.mjs';
import { randomUUID, randomBytes, createHmac } from 'node:crypto';

export const FAKE_NOW = '2026-10-16T18:30:00Z';
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const unb64 = (s) => JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));

export function pgRest({ db, now = FAKE_NOW, calls = [] } = {}) {
  const run = async (role, claims, name, args) => {
    calls.push({ role, name });
    const r = await rpc(name, args, { role, claims, now, db });
    if (r.httpStatus !== 200) throw new RpcError(r.httpStatus, { code: r.error.code, message: r.error.message });
    return r.data;
  };
  return {
    calls,
    service: (name, args) => run('service_role', null, name, args),
    user: (token, name, args) => {
      let claims;
      try { claims = unb64(String(token).replace(/^t\./, '')); } catch { throw new RpcError(401, { code: 'PGRST301', message: 'JWT invalid' }); }
      if (!String(token).startsWith('t.') || claims.exp * 1000 < (now ? Date.parse(now) : Date.now())) throw new RpcError(401, { code: 'PGRST301', message: 'JWT expired' });
      return run('authenticated', { sub: claims.sub, email: claims.email, aal: claims.aal, amr: claims.amr }, name, args);
    },
  };
}

// TOTP לפי RFC 6238 (HMAC-SHA1, 30 שניות, 6 ספרות) – כמו אפליקציית אימות אמיתית. משמש גם את ה-fakeAuth וגם את הבדיקות ("הטלפון").
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const b32encode = (buf) => { let bits = '', out = ''; for (const b of buf) bits += b.toString(2).padStart(8, '0'); for (let i = 0; i < bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)]; return out; };
const b32decode = (s) => { let bits = ''; for (const c of s) bits += B32.indexOf(c).toString(2).padStart(5, '0'); const out = []; for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2)); return Buffer.from(out); };
export function totp(secret, atMs = Date.now()) {
  const ctr = Buffer.alloc(8); ctr.writeBigUInt64BE(BigInt(Math.floor(atMs / 30000)));
  const h = createHmac('sha1', b32decode(secret)).update(ctr).digest(); const o = h[19] & 15;
  return String(((h[o] & 0x7f) << 24 | h[o + 1] << 16 | h[o + 2] << 8 | h[o + 3]) % 1000000).padStart(6, '0');
}

export function fakeAuth({ db, ttl = 3600, clock = null } = {}) {
  const users = new Map();          // email → { id, password, banned, factors: Map(id → {secret, status}) }
  const refresh = new Map();        // refreshToken → { email, aal, amr }
  const challenges = new Map();     // challengeId → factorId
  const nowSec = () => Math.floor((clock ? clock() : Date.parse(FAKE_NOW)) / 1000);        // אותו שעון קפוא כמו ה-DB (pgRest), כדי שחותמות ה-amr ותוקף ה-JWT עקביים
  const mint = (email, aal = 'aal1', amr = null) => {
    const u = users.get(email); const rt = 'r.' + randomBytes(12).toString('hex');
    const methods = amr || [{ method: 'password', timestamp: nowSec() }];
    refresh.set(rt, { email, aal, amr: methods });
    return { accessToken: 't.' + b64({ sub: u.id, email, exp: nowSec() + ttl, aal, amr: methods }), refreshToken: rt, expiresIn: ttl, userId: u.id, email };
  };
  const byToken = (token) => { const c = unb64(String(token).slice(2)); if (c.exp < nowSec()) throw new AuthError(401, { error_code: 'bad_jwt', msg: 'JWT expired' }); return { c, u: users.get(c.email) }; };
  const api = {
    users, ttl,
    async addUser(email, password) {
      const id = (await psql(`insert into auth.users (email) values ('${email}') returning id`, { db })).split('\n')[0];
      users.set(email, { id, password, banned: false, factors: new Map() }); return id;
    },
    async signIn(email, password) {
      const u = users.get(email);
      if (!u || u.password !== password || u.banned) throw new AuthError(400, { error_code: 'invalid_credentials', msg: 'Invalid login credentials' });
      return mint(email);
    },
    async refresh(rt) {
      const r = refresh.get(rt); const u = r && users.get(r.email);
      if (!u || u.banned) throw new AuthError(400, { error_code: 'refresh_token_not_found', msg: 'Invalid Refresh Token' });
      refresh.delete(rt); return mint(r.email, r.aal, r.amr);                          // כמו GoTrue: רענון שומר על רמת ה-aal ועל ה-amr של הסשן
    },
    async signOut(token) {
      const { c } = byToken(token);
      for (const [rt, r] of refresh) if (r.email === c.email) refresh.delete(rt);
    },
    async changePassword(token, password) { const { c } = byToken(token); users.get(c.email).password = password; },
    mfa: {
      async listFactors(token) { const { u } = byToken(token); return [...u.factors].map(([id, f]) => ({ id, type: 'totp', status: f.status })); },
      async enroll(token, friendlyName) {
        const { u } = byToken(token); const id = randomUUID(); const secret = b32encode(randomBytes(20));
        u.factors.set(id, { secret, status: 'unverified' });
        await psql(`insert into auth.mfa_factors (id, user_id, status) values ('${id}', '${u.id}', 'unverified')`, { db });
        return { id, secret, uri: `otpauth://totp/Platform:${u.id}?secret=${secret}&issuer=Platform`, qrCode: 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>' };
      },
      async challenge(token, factorId) {
        const { u } = byToken(token); if (!u.factors.has(factorId)) throw new AuthError(404, { error_code: 'mfa_factor_not_found', msg: 'MFA factor not found' });
        const id = randomUUID(); challenges.set(id, factorId); return id;
      },
      async verify(token, factorId, challengeId, code) {
        const { c, u } = byToken(token); const f = u.factors.get(factorId);
        if (!f || challenges.get(challengeId) !== factorId) throw new AuthError(404, { error_code: 'mfa_factor_not_found', msg: 'MFA factor not found' });
        challenges.delete(challengeId);
        const t = Date.now(); const ok = [-30000, 0, 30000].some((d) => totp(f.secret, t + d) === String(code));
        if (!ok) throw new AuthError(400, { error_code: 'mfa_verification_failed', msg: 'Invalid TOTP code entered' });
        if (f.status !== 'verified') { f.status = 'verified'; await psql(`update auth.mfa_factors set status = 'verified' where id = '${factorId}'`, { db }); }
        return mint(c.email, 'aal2', [{ method: 'totp', timestamp: nowSec() }, ...(c.amr || [])]);
      },
      async unenroll(token, factorId) {
        const { u } = byToken(token); u.factors.delete(factorId); await psql(`delete from auth.mfa_factors where id = '${factorId}'`, { db });
      },
    },
    admin: {
      async createUser(email, password) {
        if (users.has(email)) throw new AuthError(422, { error_code: 'email_exists', msg: 'A user with this email address has already been registered' });
        return { id: await api.addUser(email, password), email };
      },
      async setPassword(id, password) { for (const u of users.values()) if (u.id === id) u.password = password; },
      async setBanned(id, banned) { for (const u of users.values()) if (u.id === id) u.banned = banned; },
      async deleteUser(id) {
        for (const [e, u] of users) if (u.id === id) users.delete(e);
        await psql(`delete from auth.users where id = '${id}'`, { db });
      },
    },
  };
  return api;
}

// קורא ל-api.handle ומנהל cookie jar כמו דפדפן
export function client(api) {
  const jar = {}; let n = 0;
  async function call(method, url, body, { ip, headers = {}, jarless = false } = {}) {
    const u = new URL(url, 'http://app.test');
    const cookie = jarless ? '' : Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
    const out = await api.handle({
      method, pathname: u.pathname, query: u.searchParams, ip: ip || `10.1.${Math.floor(n / 250)}.${(n++ % 250) + 1}`, https: true,
      headers: { host: 'app.test', 'content-type': 'application/json', ...(method !== 'GET' ? { origin: 'https://app.test' } : {}), ...(cookie ? { cookie } : {}), ...headers },
      body: method === 'GET' || method === 'DELETE' ? '' : JSON.stringify(body || {}),
    });
    for (const sc of out.cookies || []) {
      const [pair, ...attrs] = sc.split('; '); const i = pair.indexOf('='); const k = pair.slice(0, i), v = pair.slice(i + 1);
      if (attrs.some((a) => a === 'Max-Age=0')) delete jar[k]; else jar[k] = v;
    }
    return { status: out.status, body: out.body, cookies: out.cookies || [], headers: out.headers };
  }
  return { call, jar, get: (u, o) => call('GET', u, null, o), post: (u, b, o) => call('POST', u, b, o), put: (u, b, o) => call('PUT', u, b, o),
           patch: (u, b, o) => call('PATCH', u, b, o), del: (u, o) => call('DELETE', u, null, o) };
}
