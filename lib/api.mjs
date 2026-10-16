// נתב ה-API. אגנוסטי לפלטפורמה: מקבל בקשה פשוטה ומחזיר תגובה פשוטה (Netlify Function / שרת פיתוח / בדיקות).
// עקרונות:
//  • נתונים נגישים רק דרך RPC. פעולות לקוח (ללא חשבון) – בשרת עם service_role. פעולות מנהל – עם ה-JWT של המשתמש, כך ש-RLS אוכף.
//  • מפתח ה-service_role לעולם לא מגיע לדפדפן. הדפדפן אינו מחזיק אף מפתח Supabase; הסשן ב-HttpOnly cookies.
//  • IP ונייד מגובבים (HMAC עם סוד שרת) לפני שהם נכנסים לטבלת הגבלת הקצב.
import { createHmac } from 'node:crypto';
import { AppError } from './errors.mjs';
import { RpcError } from './clients/supabase-rest.mjs';
import { AuthError } from './clients/supabase-auth.mjs';
import { passwordProblem, cleanEmail } from './password.mjs';
import * as defaultNotify from './notify.mjs';
import dnsPromises from 'node:dns/promises';
import { checkDomain, pingMark, normalizeHost } from './domains.mjs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BODY = 64 * 1024;
const SESSION_SECONDS = 12 * 3600;
const WIN = 15 * 60;

export function createApi({ rest, auth, config, notify = defaultNotify, log = console, resolver = dnsPromises, fetchImpl = fetch }) {
  const routes = [];
  const hmac = (scope, v) => createHmac('sha256', config.pepper).update(`${scope}:${v}`).digest('hex');
  const bad = (msg, fields) => new AppError(400, fields ? 'validation' : 'invalid_request', msg, fields);
  const limited = () => new AppError(429, 'rate_limited', 'בוצעו יותר מדי ניסיונות. נסו שוב בעוד מספר דקות.');
  const unauthorized = () => new AppError(401, 'unauthorized', 'נדרשת התחברות');

  function route(method, pattern, handler) {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:([a-zA-Z_]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    routes.push({ method, re, keys, handler });
  }

  /* ---------- קריאות ל-Supabase ---------- */
  function mapRpcError(e) {
    if (e instanceof AppError) return e;
    if (e instanceof RpcError) {
      if (e.status === 401) return unauthorized();
      if (/business_frozen/.test(`${e.message} ${e.code}`)) return new AppError(503, 'frozen', 'העסק בתחזוקה זמנית (העברה). נסו שוב בעוד זמן קצר.');
      if (e.status === 403) {
        if (/mfa_required/.test(e.message)) return new AppError(403, 'mfa_required', 'נדרש אימות דו-שלבי');
        if (/mfa_stale/.test(e.message)) return new AppError(403, 'mfa_stale', 'פעולה רגישה: נדרש אימות דו-שלבי מחדש');
        return new AppError(403, 'forbidden', /shop_disabled/.test(e.message) ? 'העסק אינו פעיל. נא לפנות למנהל הפלטפורמה.' : 'אין הרשאה לפעולה זו');
      }
      if (e.status === 400 && /business_required/.test(e.message)) return new AppError(400, 'shop_required', 'יש לבחור עסק');
      if (e.status === 400 || e.status === 404) return bad('בקשה לא תקינה');
    }
    log.error('[upstream]', e && e.status, e && e.code, e && e.message);
    return new AppError(502, 'upstream_error', 'השירות אינו זמין כרגע. נסו שוב בעוד רגע.');
  }
  const svc = async (name, args) => { try { return await rest.service(name, args); } catch (e) { throw mapRpcError(e); } };

  function unwrap(env) {
    if (!env || typeof env.ok !== 'boolean') throw new AppError(502, 'upstream_error', 'תגובה לא צפויה מהשרת');
    if (env.ok) return { status: env.status || 200, body: env.data };
    throw new AppError(env.status || 400, env.error.code, env.error.message, env.error.fields);
  }
  const pub = async (name, args) => unwrap(await svc(name, args));

  /* ---------- Origin: פלטפורמה (מפורש בהגדרות) + דומיינים מותאמים פעילים, ורק לנתיבים ציבוריים ---------- */
  // דומיין מותאם מקבל הרשאה לבקשות לקוח (/api/public/*) בלבד; ניהול (/api/admin, /api/super) נשאר רק מה-Origin של הפלטפורמה.
  const platformHosts = new Set([...config.allowedOrigins, config.publicBaseUrl].map((o) => new URL(o).hostname));
  let hostsCache = { at: 0, origins: new Set() };
  async function activeOrigins() {
    if (Date.now() - hostsCache.at < 60_000) return hostsCache.origins;
    try {
      const env = await rest.service('rpc_public_active_domains', {});
      hostsCache = { at: Date.now(), origins: new Set(((env && env.data && env.data.hosts) || []).map((h) => 'https://' + h)) };
    } catch (e) { log.error('[domains] active list failed', e && e.message); hostsCache = { at: Date.now() - 45_000, origins: new Set() }; }     // נכשל סגור, ניסיון חוזר בעוד ~15 שניות
    return hostsCache.origins;
  }
  const originOk = async (origin, pathname) => typeof origin === 'string' && (config.allowedOrigins.includes(origin) || (pathname.startsWith('/api/public/') && (await activeOrigins()).has(origin)));

  /* ---------- סשן מנהל (cookies) ---------- */
  const cookieStr = (name, value, maxAge) => `${name}=${value}; Path=/api; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${config.cookieSecure ? '; Secure' : ''}`;
  const setSession = (c, s) => {
    c.setCookies.push(cookieStr('bs_at', s.accessToken, Math.max(60, Math.min(s.expiresIn || 3600, SESSION_SECONDS))));
    c.setCookies.push(cookieStr('bs_rt', s.refreshToken, SESSION_SECONDS));
  };
  const clearSession = (c) => { c.setCookies.push(cookieStr('bs_at', '', 0), cookieStr('bs_rt', '', 0)); };

  async function refreshSession(c) {
    const rt = c.cookies.bs_rt;
    if (!rt || rt.length > 400) throw unauthorized();
    try {
      const s = await auth.refresh(rt);
      setSession(c, s); c.refreshed = true; c.cookies.bs_at = s.accessToken;
      return s.accessToken;
    } catch (e) {
      if (e instanceof AuthError && e.status >= 500) throw mapRpcError(e);
      clearSession(c); throw unauthorized();
    }
  }

  async function usr(c, name, args) {
    let at = c.cookies.bs_at;
    if (!at) at = await refreshSession(c);
    try { return await rest.user(at, name, args); }
    catch (e) {
      if (e instanceof RpcError && e.status === 401 && !c.refreshed) {
        at = await refreshSession(c);
        try { return await rest.user(at, name, args); } catch (e2) { throw mapRpcError(e2); }
      }
      throw mapRpcError(e);
    }
  }
  const adm = async (c, name, args) => unwrap(await usr(c, name, args));
  // פעולה מול Supabase Auth בשם המשתמש, עם רענון אוטומטי של ה-access token
  async function withToken(c, fn) {
    let at = c.cookies.bs_at || (await refreshSession(c));
    try { return await fn(at); }
    catch (e) {
      if (e instanceof AuthError && e.status === 401 && !c.refreshed) { at = await refreshSession(c); return fn(at); }
      throw e;
    }
  }
  // אירוע התחברות/MFA ליומן הביקורת (ללא PII). כשל ביומן אינו מפיל את הפעולה אך נרשם בלוג.
  const auditEvent = async (action, userId, details = {}) => { try { await rest.service('rpc_audit_event', { p_action: action, p_user: userId, p_details: details }); } catch (e) { log.error('[audit] failed', action, e && e.message); } };
  async function requireSuper(c) {
    const me = (await adm(c, 'rpc_me', {})).body;
    if (me.user.role !== 'super_admin') throw new AppError(403, 'forbidden', 'אין הרשאה לפעולה זו');
    if (me.mfa && me.mfa.needs_verification) throw new AppError(403, 'mfa_required', 'נדרש אימות דו-שלבי');
    return me;
  }
  const bizParam = (c) => { const v = c.query.get('shop_id'); return v && UUID_RE.test(v) ? v : null; };

  /* ---------- ולידציה קלה לפני פנייה ל-DB (המקור המחייב הוא ה-DB) ---------- */
  const intq = (v) => { if (!/^\d{1,10}$/.test(String(v ?? ''))) throw bad('בקשה לא תקינה'); return Number(v); };
  const dateq = (v) => { if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v ?? '')) || Number.isNaN(Date.parse(v))) throw bad('תאריך לא תקין'); return v; };
  const slugq = (v) => { if (!/^[a-z0-9-]{1,60}$/.test(String(v ?? ''))) throw new AppError(404, 'shop_not_found', 'העסק לא נמצא'); return v; };

  /* =================== לקוחות (ללא חשבון) =================== */
  route('GET', '/api/public/shops', () => pub('rpc_public_businesses', {}));
  route('GET', '/api/public/shops/:slug', (c) => pub('rpc_public_business', { p_slug: slugq(c.params.slug) }));
  route('GET', '/api/public/days', (c) => pub('rpc_public_days', { p_slug: slugq(c.query.get('slug')), p_staff: intq(c.query.get('barber_id')), p_service: intq(c.query.get('service_id')) }));
  route('GET', '/api/public/slots', (c) => pub('rpc_public_slots', { p_slug: slugq(c.query.get('slug')), p_staff: intq(c.query.get('barber_id')), p_service: intq(c.query.get('service_id')), p_date: dateq(c.query.get('date')) }));

  route('POST', '/api/public/book', async (c) => {
    const b = c.body;
    if (b.website) throw bad('בקשה לא תקינה');                       // שדה פיתיון לבוטים
    const p = { slug: b.slug, service_id: b.service_id, barber_id: b.barber_id, date: b.date, start_min: b.start_min, first_name: b.first_name, last_name: b.last_name, phone: b.phone, idempotency_key: b.idempotency_key };
    const { body: d } = await pub('rpc_public_book', { p, p_ip_hash: c.ipHash, p_pepper: config.pepper });
    const origin = (await originOk(c.req.headers.origin, '/api/public/book')) ? c.req.headers.origin : config.publicBaseUrl;     // הקישור נבנה רק מ-Origin מאושר (פלטפורמה או דומיין פעיל)
    const notification = await notify.sendBookingConfirmation({ phone: b.phone, appointment: d, baseUrl: origin });
    return { status: 201, body: {
      appointment: { shop_name: d.shop_name, barber_name: d.barber_name, service_name: d.service_name, price_ils: d.price_ils, date: d.date,
                     start_min: d.start_min, end_min: d.end_min, duration_min: d.duration_min, first_name: d.first_name },
      manage_url: `${origin}/m/${d.token}`, notification } };
  });

  route('POST', '/api/public/lead', async (c) => {
    const b = c.body;
    if (b.website) throw bad('בקשה לא תקינה');
    return pub('rpc_public_submit_lead', { p: { slug: b.slug, name: b.name, phone: b.phone, message: b.message, service_id: b.service_id, city: b.city, urgency: b.urgency, budget: b.budget, timeframe: b.timeframe }, p_ip_hash: c.ipHash, p_pepper: config.pepper });
  });

  // בדיקת חיות לניטור חיצוני: מוודאת שהאתר והמסד עונים. לא מחזירה פרטים פנימיים.
  route('GET', '/api/health', async () => { try { await svc('rpc_public_brand', {}); return { body: { ok: true } }; } catch { throw new AppError(503, 'unhealthy', 'לא תקין'); } });
  /* =================== אתר המותג: קטלוג ולידים (נפרד מפניות עסקים) =================== */
  route('GET', '/api/public/brand', () => pub('rpc_public_brand', {}));
  route('POST', '/api/public/brand-lead', async (c) => {
    const b = c.body;
    if (b.website) throw bad('בקשה לא תקינה');
    return pub('rpc_public_brand_lead', { p: { name: b.name, phone: b.phone, email: b.email, business_name: b.business_name, template: b.template, track: b.track, addons: Array.isArray(b.addons) ? b.addons.slice(0, 10) : undefined, message: b.message }, p_ip_hash: c.ipHash, p_pepper: config.pepper });
  });

  const tok = (c) => ({ p_token: String(c.params.token).slice(0, 80), p_ip_hash: c.ipHash });
  route('GET', '/api/public/manage/:token', (c) => pub('rpc_public_token_get', tok(c)));
  route('GET', '/api/public/manage/:token/barbers', (c) => pub('rpc_public_token_staff', tok(c)));
  route('GET', '/api/public/manage/:token/slots', (c) => pub('rpc_public_token_slots', { ...tok(c), p_staff: intq(c.query.get('barber_id')), p_date: dateq(c.query.get('date')) }));
  route('GET', '/api/public/manage/:token/days', (c) => pub('rpc_public_token_days', { ...tok(c), p_staff: intq(c.query.get('barber_id')) }));
  route('POST', '/api/public/manage/:token/cancel', (c) => pub('rpc_public_token_cancel', tok(c)));
  route('POST', '/api/public/manage/:token/reschedule', (c) => pub('rpc_public_token_reschedule', { ...tok(c), p: { barber_id: c.body.barber_id, date: c.body.date, start_min: c.body.start_min } }));

  /* =================== התחברות מנהלים (Supabase Auth) =================== */
  route('POST', '/api/admin/login', async (c) => {
    const email = cleanEmail(c.body.email);
    const password = typeof c.body.password === 'string' ? c.body.password.slice(0, 200) : '';
    const keys = [`login:ip:${c.ipHash}`, `login:email:${hmac('email', email || 'x')}`];
    const [ci, ce] = await Promise.all(keys.map((k) => svc('rpc_rate_count', { p_key: k, p_window_s: WIN })));
    if (ci >= 10 || ce >= 5) throw limited();
    const fail = async () => { await Promise.all(keys.map((k) => svc('rpc_rate_record', { p_key: k, p_window_s: WIN }))); throw new AppError(401, 'bad_credentials', 'אימייל או סיסמה שגויים'); };
    if (!email || !password) await fail();
    let s;
    try { s = await auth.signIn(email, password); }
    catch (e) { if (e instanceof AuthError && e.status >= 400 && e.status < 500) await fail(); throw mapRpcError(e); }
    let me;
    try { me = unwrap(await rest.user(s.accessToken, 'rpc_me', {})); }
    catch (e) { auth.signOut(s.accessToken).catch(() => {}); throw mapRpcError(e); }     // משתמש ללא תפקיד / עסק מושבת – לא נפתח סשן
    setSession(c, s);
    const m = me.body.mfa;
    // Super Admin חייב MFA; Owner שרשם MFA חייב לאמת. הסשן (aal1) נפתח רק כדי לבצע את שלב האימות – ה-DB חוסם כל נתון עד aal2.
    if (m.needs_verification) return { body: { ok: true, role: me.body.user.role, mfa: m.enrolled ? 'verify' : 'enroll' } };
    await auditEvent('auth.login', me.body.user.id, { mfa: false });
    return { body: { ok: true, role: me.body.user.role, mfa: null } };
  });

  /* ---------- MFA (TOTP) ---------- */
  const codeOf = (c) => { const code = String(c.body.code || '').replace(/\s/g, ''); if (!/^\d{6}$/.test(code)) throw bad('נא להזין קוד בן 6 ספרות', { code: 'קוד בן 6 ספרות' }); return code; };
  async function mfaGuard(c, userId) {                       // הגבלת ניסיונות: משתמש (5) ו-IP (10) לכל 15 דקות, נספרים כשלונות בלבד
    const keys = [`mfa:user:${hmac('uid', userId)}`, `mfa:ip:${c.ipHash}`];
    const [cu, ci] = await Promise.all(keys.map((k) => svc('rpc_rate_count', { p_key: k, p_window_s: WIN })));
    if (cu >= 5 || ci >= 10) throw limited();
    return async () => { await Promise.all(keys.map((k) => svc('rpc_rate_record', { p_key: k, p_window_s: WIN }))); await auditEvent('auth.mfa_failed', userId); throw new AppError(401, 'bad_code', 'הקוד שגוי או שפג תוקפו', { code: 'הקוד שגוי' }); };
  }
  async function verifyWith(c, userId, factorId, code, evt) {
    const fail = await mfaGuard(c, userId);
    try {
      const s2 = await withToken(c, async (at) => auth.mfa.verify(at, factorId, await auth.mfa.challenge(at, factorId), code));
      setSession(c, s2);
      await auditEvent(evt, userId, {});
      return s2;
    } catch (e) {
      if (e instanceof AuthError && e.status >= 400 && e.status < 500 && e.status !== 401) await fail();
      throw mapRpcError(e);
    }
  }
  route('POST', '/api/admin/mfa/enroll', async (c) => {
    const me = (await adm(c, 'rpc_me', {})).body;
    return withToken(c, async (at) => {
      const factors = await auth.mfa.listFactors(at);
      if (factors.some((f) => f.status === 'verified')) throw new AppError(409, 'mfa_already_enrolled', 'האימות הדו-שלבי כבר הוגדר לחשבון');
      for (const f of factors) await auth.mfa.unenroll(at, f.id).catch(() => {});            // ניסיון קודם שלא הושלם
      const e = await auth.mfa.enroll(at, `totp-${Date.now()}`);
      return { body: { factor_id: e.id, secret: e.secret, uri: e.uri, qr_code: e.qrCode, email: me.user.email } };
    }).catch((e) => { throw e instanceof AuthError ? mapRpcError(e) : e; });
  });
  route('POST', '/api/admin/mfa/enroll/verify', async (c) => {
    const me = (await adm(c, 'rpc_me', {})).body, code = codeOf(c);
    if (!UUID_RE.test(String(c.body.factor_id))) throw bad('בקשה לא תקינה');
    await verifyWith(c, me.user.id, c.body.factor_id, code, 'auth.mfa_enrolled');
    await auditEvent('auth.login', me.user.id, { mfa: true });
    return { body: { ok: true, role: me.user.role } };
  });
  // כניסה (aal1→aal2) וגם אימות חוזר לפעולות רגישות (מרענן את חותמת ה-TOTP ב-JWT)
  route('POST', '/api/admin/mfa/verify', async (c) => {
    const me = (await adm(c, 'rpc_me', {})).body, code = codeOf(c);
    const f = (await withToken(c, (at) => auth.mfa.listFactors(at)).catch((e) => { throw mapRpcError(e); })).find((x) => x.type === 'totp' && x.status === 'verified');
    if (!f) throw new AppError(409, 'mfa_not_enrolled', 'האימות הדו-שלבי טרם הוגדר');
    const wasAal2 = me.mfa.aal === 'aal2';
    await verifyWith(c, me.user.id, f.id, code, 'auth.mfa_verified');
    if (!wasAal2) await auditEvent('auth.login', me.user.id, { mfa: true });
    return { body: { ok: true, role: me.user.role } };
  });

  route('POST', '/api/admin/logout', async (c) => {
    const at = c.cookies.bs_at;
    if (at) auth.signOut(at).catch(() => {});
    clearSession(c);
    return { body: { ok: true } };
  });

  route('GET', '/api/admin/me', (c) => adm(c, 'rpc_me', {}));

  route('POST', '/api/admin/password', async (c) => {
    const next = c.body.next, cur = String(c.body.current || '').slice(0, 200);
    const me = (await adm(c, 'rpc_me', {})).body;
    const problem = passwordProblem(next);
    if (problem) throw bad(problem);
    try { await auth.signIn(me.user.email, cur); }
    catch (e) { if (e instanceof AuthError && e.status >= 400 && e.status < 500) throw new AppError(400, 'bad_password', 'הסיסמה הנוכחית שגויה'); throw mapRpcError(e); }
    let at = c.cookies.bs_at || (await refreshSession(c));
    try { await auth.changePassword(at, next); } catch (e) { throw mapRpcError(e); }
    return { body: { ok: true } };
  });

  route('GET', '/api/admin/system', async (c) => {
    await adm(c, 'rpc_templates', {});     // בדיקת חיבור אמיתית ל-DB: אם נכשלה, השגיאה תוחזר
    return { body: { database: { type: 'Supabase Postgres', connected: true, rls: true, note: 'הפרדת העסקים נאכפת ב-RLS' },
      notifications: notify.status(), rate_limit: { type: 'Postgres (טבלה משותפת)', shared: true }, timezone: 'Asia/Jerusalem' } };
  });

  /* =================== בעל עסק / Super Admin: RPC מבוססי JWT + RLS =================== */
  const owner = (method, pattern, name, mk = () => ({})) =>
    route(method, pattern, (c) => adm(c, name, { p_business: bizParam(c), p: mk(c) }));
  const q = (c) => Object.fromEntries(c.query);
  owner('GET', '/api/admin/shop', 'rpc_owner_shop_get');
  owner('PUT', '/api/admin/shop', 'rpc_owner_shop_update', (c) => c.body);
  owner('GET', '/api/admin/barbers', 'rpc_owner_staff_list');
  owner('POST', '/api/admin/barbers', 'rpc_owner_staff_create', (c) => c.body);
  owner('PUT', '/api/admin/barbers/:id', 'rpc_owner_staff_update', (c) => ({ ...c.body, id: c.params.id }));
  owner('GET', '/api/admin/services', 'rpc_owner_services_list');
  owner('POST', '/api/admin/services', 'rpc_owner_service_create', (c) => c.body);
  owner('PUT', '/api/admin/services/:id', 'rpc_owner_service_update', (c) => ({ ...c.body, id: c.params.id }));
  owner('GET', '/api/admin/appointments', 'rpc_owner_appointments', q);
  owner('GET', '/api/admin/availability', 'rpc_owner_availability', q);
  owner('POST', '/api/admin/appointments', 'rpc_owner_appointment_create', (c) => c.body);
  owner('PATCH', '/api/admin/appointments/:id', 'rpc_owner_appointment_status', (c) => ({ id: c.params.id, status: c.body.status }));
  owner('GET', '/api/admin/blocks', 'rpc_owner_blocks', q);
  owner('POST', '/api/admin/blocks', 'rpc_owner_block_create', (c) => c.body);
  owner('DELETE', '/api/admin/blocks/:id', 'rpc_owner_block_delete', (c) => ({ id: c.params.id }));
  owner('GET', '/api/admin/customers', 'rpc_owner_customers', q);
  owner('GET', '/api/admin/dashboard', 'rpc_owner_dashboard');
  owner('GET', '/api/admin/leads', 'rpc_owner_leads');
  owner('PATCH', '/api/admin/leads/:id', 'rpc_owner_lead_status', (c) => ({ id: c.params.id, status: c.body.status }));
  route('GET', '/api/admin/templates', (c) => adm(c, 'rpc_templates', {}));
  // יומן ביקורת: Owner – העסק שלו; Super Admin – כל הפלטפורמה (או shop_id לסינון)
  owner('GET', '/api/admin/audit', 'rpc_audit_list', (c) => { const o = {}; for (const k of ['limit', 'before_id']) { const v = c.query.get(k); if (/^\d{1,12}$/.test(v || '')) o[k] = Number(v); } return o; });

  /* =================== Super Admin =================== */
  const shopId = (c) => { if (!UUID_RE.test(c.params.id)) throw new AppError(404, 'not_found', 'העסק לא נמצא'); return c.params.id; };
  const ownerIds = async (c, id) => (await adm(c, 'rpc_super_owner_ids', { p_business: id })).body.user_ids;

  route('GET', '/api/super/shops', (c) => adm(c, 'rpc_super_businesses', {}));

  route('POST', '/api/super/shops', async (c) => {
    const b = c.body, fields = {};
    const email = cleanEmail(b.owner_email), pwProblem = passwordProblem(b.owner_password);
    if (!email) fields.owner_email = 'אימייל לא תקין';
    if (pwProblem) fields.owner_password = pwProblem;
    if (Object.keys(fields).length) throw bad('נא לתקן את השדות המסומנים', fields);
    await requireSuper(c);                                              // רק Super Admin אחרי MFA יוצר חשבונות
    let user;
    try { user = await auth.admin.createUser(email, b.owner_password); }
    catch (e) {
      if (e instanceof AuthError && (e.status === 422 || /exists|registered/i.test(`${e.code} ${e.message}`))) throw new AppError(409, 'duplicate', 'הנתונים כבר קיימים במערכת', { owner_email: 'האימייל כבר רשום במערכת' });
      throw mapRpcError(e);
    }
    try { return await adm(c, 'rpc_super_create_business', { p: { name: b.name, slug: b.slug, template: b.template || 'barbershop', owner_user_id: user.id } }); }
    catch (e) { await auth.admin.deleteUser(user.id).catch((x) => log.error('[cleanup] failed to delete orphan auth user', user.id, x && x.message)); throw e; }
  });

  route('POST', '/api/super/shops/:id/freeze', (c) => {
    if (typeof c.body.frozen !== 'boolean') throw bad('בקשה לא תקינה');
    return adm(c, 'rpc_super_set_freeze', { p_business: shopId(c), p: { frozen: c.body.frozen ? 'true' : 'false' } });
  });
  route('PATCH', '/api/super/shops/:id', async (c) => {
    const id = shopId(c);
    if (typeof c.body.active !== 'boolean') throw bad('בקשה לא תקינה');
    const out = await adm(c, 'rpc_super_set_active', { p_business: id, p: { active: c.body.active } });
    // חסימה בצד Auth היא שכבה נוספת (מונעת רענון סשן). הניתוק המיידי מובטח ע"י ה-DB (my_business מחזיר NULL לעסק מושבת).
    try { for (const u of await ownerIds(c, id)) await auth.admin.setBanned(u, !c.body.active); } catch (e) { log.error('[auth] ban toggle failed', e && e.message); }
    return out;
  });

  // איפוס סיסמה: ה-DB דורש MFA טרי ומתעד. אפשר לציין בעלים מסוים (owner_user_id), אחרת כולם.
  route('POST', '/api/super/shops/:id/reset-owner', async (c) => {
    const id = shopId(c), problem = passwordProblem(c.body.password);
    if (problem) throw bad(problem, { password: problem });
    const ids = (await adm(c, 'rpc_super_prepare_owner_reset', { p_business: id, p: {} })).body.user_ids;
    const target = c.body.owner_user_id ? ids.filter((u) => u === c.body.owner_user_id) : ids;
    if (!target.length) throw new AppError(404, 'not_found', 'לא נמצא בעל עסק');
    try { for (const u of target) await auth.admin.setPassword(u, c.body.password); } catch (e) { throw mapRpcError(e); }
    return { body: { ok: true } };
  });

  route('GET', '/api/super/shops/:id/owners', (c) => adm(c, 'rpc_super_list_owners', { p_business: shopId(c) }));
  // שיוך בעלים חדש מהממשק: יצירת חשבון Auth + שיוך אטומי (אם השיוך נכשל – החשבון נמחק)
  route('POST', '/api/super/shops/:id/owners', async (c) => {
    const id = shopId(c), fields = {};
    const email = cleanEmail(c.body.owner_email), pwProblem = passwordProblem(c.body.owner_password);
    if (!email) fields.owner_email = 'אימייל לא תקין';
    if (pwProblem) fields.owner_password = pwProblem;
    if (Object.keys(fields).length) throw bad('נא לתקן את השדות המסומנים', fields);
    await requireSuper(c);
    let user;
    try { user = await auth.admin.createUser(email, c.body.owner_password); }
    catch (e) {
      if (e instanceof AuthError && (e.status === 422 || /exists|registered/i.test(`${e.code} ${e.message}`))) throw new AppError(409, 'duplicate', 'הנתונים כבר קיימים במערכת', { owner_email: 'האימייל כבר רשום במערכת' });
      throw mapRpcError(e);
    }
    try { const out = await adm(c, 'rpc_super_attach_owner', { p_business: id, p: { owner_user_id: user.id } }); return { status: 201, body: out.body }; }
    catch (e) { await auth.admin.deleteUser(user.id).catch((x) => log.error('[cleanup] failed to delete orphan auth user', user.id, x && x.message)); throw e; }
  });
  route('DELETE', '/api/super/shops/:id/owners/:uid', async (c) => {
    const id = shopId(c); if (!UUID_RE.test(c.params.uid)) throw new AppError(404, 'not_found', 'הבעלים לא נמצא');
    const out = await adm(c, 'rpc_super_remove_owner', { p_business: id, p: { owner_user_id: c.params.uid } });
    await auth.admin.deleteUser(out.body.user_id).catch((x) => log.error('[auth] delete owner failed', out.body.user_id, x && x.message));
    return { body: { ok: true } };
  });

  route('POST', '/api/super/shops/:id/delete', async (c) => {
    const id = shopId(c);
    const out = await adm(c, 'rpc_super_delete_business', { p_business: id, p: { confirm_slug: c.body.confirm_slug } });
    for (const u of out.body.owner_user_ids) await auth.admin.deleteUser(u).catch((x) => log.error('[auth] delete owner failed', u, x && x.message));
    return { body: { ok: true } };
  });

  /* =================== אשף הקמת עסק (Super Admin; ה-DB אוכף aal2, ופרסום דורש אימות טרי) =================== */
  const draftId = (c) => { if (!UUID_RE.test(c.params.id)) throw new AppError(404, 'not_found', 'הטיוטה לא נמצאה'); return c.params.id; };
  const dupEmail = (e) => e instanceof AuthError && (e.status === 422 || /exists|registered/i.test(`${e.code} ${e.message}`));
  route('GET', '/api/super/drafts', (c) => adm(c, 'rpc_super_draft_list', {}));
  route('POST', '/api/super/drafts', async (c) => { const out = await adm(c, 'rpc_super_draft_create', { p: { template: c.body.template, track: c.body.track } }); return { status: 201, body: out.body }; });
  route('GET', '/api/super/drafts/:id', (c) => adm(c, 'rpc_super_draft_get', { p_id: draftId(c) }));
  route('PUT', '/api/super/drafts/:id', (c) => adm(c, 'rpc_super_draft_save', { p_id: draftId(c), p: { version: c.body.version, step: c.body.step, data: c.body.data, track: c.body.track, template: c.body.template } }));
  route('DELETE', '/api/super/drafts/:id', async (c) => {
    const out = await adm(c, 'rpc_super_draft_discard', { p_id: draftId(c) });
    if (out.body.orphan_user_id) await auth.admin.deleteUser(out.body.orphan_user_id).catch((x) => log.error('[cleanup] failed to delete draft owner', out.body.orphan_user_id, x && x.message));
    return { body: { ok: true } };
  });
  // פרסום. סדר הפעולות מבטיח שאין חשבון Auth יתום וש-retry בטוח:
  //  1) אימות טרי ובדיקת שלמות – לפני שנוצר משהו  2) חשבון Auth (או שחזור חשבון לא-משויך מניסיון קודם)  3) קישור לטיוטה  4) פרסום אטומי ב-DB
  route('POST', '/api/super/drafts/:id/publish', async (c) => {
    const id = draftId(c);
    await adm(c, 'rpc_super_check_fresh_mfa', {});
    const d = (await adm(c, 'rpc_super_draft_get', { p_id: id })).body;
    if (d.status === 'published') return { body: { business_id: d.business_id, already: true } };
    if (Object.keys(d.problems).length) throw new AppError(400, 'incomplete', 'ההקמה לא הושלמה: יש להשלים את הפריטים המסומנים לפני פרסום', d.problems);
    let ownerId = d.owner_user_id, created = false;
    if (!ownerId) {
      const problem = passwordProblem(c.body.owner_password);
      if (problem) throw bad(problem, { owner_password: problem });
      const email = d.data.owner.email;
      const found = (await adm(c, 'rpc_super_find_user', { p: { email } })).body;
      if (found.exists && found.attached) throw new AppError(409, 'duplicate', 'הנתונים כבר קיימים במערכת', { 'owner.email': 'האימייל כבר רשום במערכת' });
      if (found.exists) { ownerId = found.user_id; try { await auth.admin.setPassword(ownerId, c.body.owner_password); } catch (e) { throw mapRpcError(e); } }   // שחזור: חשבון שנוצר בניסיון קודם ואינו משויך לאיש
      else {
        try { ownerId = (await auth.admin.createUser(email, c.body.owner_password)).id; created = true; }
        catch (e) { if (dupEmail(e)) throw new AppError(409, 'duplicate', 'הנתונים כבר קיימים במערכת', { 'owner.email': 'האימייל כבר רשום במערכת' }); throw mapRpcError(e); }
      }
      try { await adm(c, 'rpc_super_draft_set_owner', { p_id: id, p: { owner_user_id: ownerId } }); }
      catch (e) { if (created) await auth.admin.deleteUser(ownerId).catch((x) => log.error('[cleanup] failed to delete orphan auth user', ownerId, x && x.message)); throw e; }
    }
    const out = await adm(c, 'rpc_super_draft_publish', { p_id: id });      // אטומי. אם נכשל, החשבון נשאר מקושר לטיוטה וה-retry ישתמש בו
    return { status: 201, body: out.body };
  });

  route('GET', '/api/super/brand', (c) => adm(c, 'rpc_super_brand_get', {}));
  route('PUT', '/api/super/brand', (c) => adm(c, 'rpc_super_brand_save', { p: { brand_name: c.body.brand_name, tagline: c.body.tagline, contact_phone: c.body.contact_phone, contact_email: c.body.contact_email, prices: c.body.prices, addons: c.body.addons, approve: c.body.approve === true ? 'true' : undefined } }));
  route('POST', '/api/super/brand/unapprove', (c) => adm(c, 'rpc_super_brand_unapprove', {}));
  route('GET', '/api/super/brand-leads', (c) => adm(c, 'rpc_super_brand_leads', { p: {} }));
  route('PATCH', '/api/super/brand-leads/:id', (c) => adm(c, 'rpc_super_brand_lead_update', { p: { id: Number(c.params.id), status: c.body.status, note: c.body.note } }));

  /* =================== דומיינים מותאמים =================== */
  route('GET', '/api/admin/domains', (c) => adm(c, 'rpc_domain_list', { p_business: bizParam(c), p: {} }));
  route('POST', '/api/admin/domains', async (c) => {
    const hn = normalizeHost(c.body.hostname);
    if (platformHosts.has(hn)) throw bad('שם הדומיין שמור לפלטפורמה', { hostname: 'שם הדומיין שמור לפלטפורמה' });
    const out = await adm(c, 'rpc_domain_add', { p_business: bizParam(c), p: { hostname: hn } });
    return { status: 201, body: out.body };
  });
  route('DELETE', '/api/admin/domains/:id', async (c) => { const out = await adm(c, 'rpc_domain_remove', { p_business: bizParam(c), p: { id: c.params.id } }); hostsCache.at = 0; return out; });
  // בדיקה אמיתית: DNS (TXT) ואז HTTPS לאתר שלנו. התוצאה נרשמת ב-DB; הסטטוס נגזר ממנה בלבד.
  route('POST', '/api/admin/domains/:id/check', async (c) => {
    const t = (await adm(c, 'rpc_domain_check_target', { p_business: bizParam(c), p: { id: c.params.id } })).body;
    const r = await checkDomain({ hostname: t.hostname, token: t.token, pepper: config.pepper, resolver, fetchImpl });
    const rec = await pub('rpc_domain_record', { p: { id: t.id, business_id: t.business_id, txt_ok: r.txt_ok, routed: r.routed, error: r.error } });
    hostsCache.at = 0;
    return rec;
  });
  // ניתוב לפי host (ללא פרמטרים מהמשתמש): מחזיר רק slug וסוג, ורק לדומיין פעיל של עסק פעיל. אינו מעניק שום הרשאה.
  route('GET', '/api/public/host', (c) => {
    const host = normalizeHost(c.req.headers.host);
    if (!host || platformHosts.has(host)) throw new AppError(404, 'not_found', 'הדומיין אינו מחובר');
    return pub('rpc_public_resolve_host', { p_host: host });
  });
  // נקודת ההוכחה לניתוב: חותמת HMAC ל-host הזה בלבד. רק אתר שמחזיק את הסוד שלנו מסוגל להפיק אותה.
  route('GET', '/api/public/domain-ping', (c) => {
    const h = normalizeHost(c.query.get('h'));
    if (!h || h !== normalizeHost(c.req.headers.host)) throw bad('בקשה לא תקינה');
    return { body: { ok: true, mark: pingMark(config.pepper, h) } };
  });

  /* =================== מנגנון הבקשות =================== */
  function parseCookies(h) {
    const out = {};
    for (const part of String(h || '').split(';')) { const i = part.indexOf('='); if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim(); }
    return out;
  }


  async function handle(req) {
    const c = { req, query: req.query, params: {}, body: {}, ip: req.ip || 'unknown', setCookies: [], cookies: parseCookies(req.headers.cookie), refreshed: false };
    c.ipHash = hmac('ip', c.ip);
    const baseHeaders = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
    const finish = (status, body) => ({ status, headers: baseHeaders, cookies: c.setCookies, body });
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        // כל בקשת שינוי חייבת לבוא מ-Origin שאושר במפורש בהגדרות (דפדפנים תמיד שולחים Origin בבקשות כאלה). אין הסקה מכותרת Host.
        if (!(await originOk(req.headers.origin, req.pathname))) throw new AppError(403, 'bad_origin', 'בקשה נחסמה');
        if (!String(req.headers['content-type'] || '').startsWith('application/json')) throw new AppError(415, 'bad_content_type', 'סוג תוכן לא נתמך');
      }
      let matched = null, pathMatched = false;
      for (const r of routes) {
        const m = r.re.exec(req.pathname);
        if (!m) continue;
        pathMatched = true;
        if (r.method !== req.method) continue;
        matched = r;
        r.keys.forEach((k, i) => { try { c.params[k] = decodeURIComponent(m[i + 1]); } catch { c.params[k] = ''; } });
        break;
      }
      if (!matched) throw pathMatched ? new AppError(405, 'method_not_allowed', 'שיטה לא נתמכת') : new AppError(404, 'not_found', 'לא נמצא');
      if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'DELETE') {
        const raw = req.body || '';
        if (raw.length > MAX_BODY) throw new AppError(413, 'too_large', 'הבקשה גדולה מדי');
        if (raw) { try { const v = JSON.parse(raw); c.body = v && typeof v === 'object' && !Array.isArray(v) ? v : {}; } catch { throw bad('גוף הבקשה אינו JSON תקין'); } }
      }
      const out = await matched.handler(c);
      return finish(out.status || 200, out.body);
    } catch (e) {
      const err = e instanceof AppError ? e : (() => { log.error('[error]', e); return new AppError(500, 'server_error', 'אירעה שגיאה בשרת. נסו שוב.'); })();
      return finish(err.status, { error: { code: err.code, message: err.message, fields: err.fields } });
    }
  }
  return { handle };
}
