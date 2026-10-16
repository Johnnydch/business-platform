// לקוח PostgREST מינימלי (ללא תלויות). כל הגישה לנתונים עוברת דרך RPC.
//   service(name, args)         – מפתח service_role. לשימוש שרת בלבד, רק עבור RPC ציבוריים/מנהליים.
//   user(token, name, args)     – JWT של משתמש Supabase Auth + מפתח anon: כאן RLS אוכף הפרדת עסקים.
export class RpcError extends Error {
  constructor(status, body) {
    super(body && body.message ? body.message : `rpc failed (${status})`);
    this.status = status; this.code = body && body.code; this.body = body;
  }
}

export function createRest({ url, anonKey, serviceKey, fetchImpl = fetch, timeoutMs = 10_000 }) {
  async function call(name, args, token) {
    if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error('bad rpc name');
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
    if (token) { headers.apikey = anonKey; headers.Authorization = `Bearer ${token}`; }
    else {
      headers.apikey = serviceKey;
      if (!serviceKey.startsWith('sb_')) headers.Authorization = `Bearer ${serviceKey}`;   // מפתחות חדשים (sb_secret_) – ללא Authorization
    }
    const res = await fetchImpl(`${url}/rest/v1/rpc/${name}`, { method: 'POST', headers, body: JSON.stringify(args || {}), signal: AbortSignal.timeout(timeoutMs) });
    const text = await res.text();
    let body = null; try { body = text ? JSON.parse(text) : null; } catch { body = { message: text.slice(0, 200) }; }
    if (!res.ok) throw new RpcError(res.status, body);
    return body;
  }
  return { service: (name, args) => call(name, args, null), user: (token, name, args) => call(name, args, token) };
}
