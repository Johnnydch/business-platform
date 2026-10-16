// Netlify Function (v2, Request/Response). כל /api/* מנותב לכאן (ראו netlify.toml).
// חשוב: לא נבדק מול Netlify אמיתי בסביבת הפיתוח הזו – ראו docs/DEPLOYMENT.md.
import { createApiFromEnv } from '../../lib/bootstrap.mjs';

let api, initError;
try { api = createApiFromEnv(process.env); } catch (e) { initError = e; console.error('[config]', e.message); }

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });

export default async (request, context) => {
  if (!api) return json(500, { error: { code: 'server_misconfigured', message: 'השירות אינו מוגדר כראוי. נא לפנות למנהל הפלטפורמה.' } });   // נכשל סגור; הפרטים רק בלוג
  const url = new URL(request.url);
  const headers = {}; request.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
  const body = request.method === 'GET' || request.method === 'HEAD' ? '' : await request.text();
  const ip = (context && context.ip) || headers['x-nf-client-connection-ip'] || 'unknown';
  const out = await api.handle({ method: request.method, pathname: url.pathname, query: url.searchParams, headers, body, ip, https: url.protocol === 'https:' });
  const h = new Headers({ 'Content-Type': 'application/json; charset=utf-8', ...out.headers });
  for (const ck of out.cookies) h.append('Set-Cookie', ck);
  return new Response(JSON.stringify(out.body ?? null), { status: out.status, headers: h });
};

export const config = { path: '/api/*' };
