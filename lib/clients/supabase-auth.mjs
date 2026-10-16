// לקוח Supabase Auth (GoTrue) מינימלי. התחברות/רענון בשם המשתמש; ניהול משתמשים רק עם מפתח service בצד השרת.
export class AuthError extends Error {
  constructor(status, body) { super((body && (body.msg || body.message || body.error_description)) || `auth failed (${status})`); this.status = status; this.code = body && (body.error_code || body.error); }
}

export function createAuth({ url, anonKey, serviceKey, fetchImpl = fetch, timeoutMs = 10_000 }) {
  const base = `${url}/auth/v1`;
  async function req(method, path, { body, token, admin } = {}) {
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
    if (admin) { headers.apikey = serviceKey; if (!serviceKey.startsWith('sb_')) headers.Authorization = `Bearer ${serviceKey}`; }
    else { headers.apikey = anonKey; if (token) headers.Authorization = `Bearer ${token}`; }
    const res = await fetchImpl(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeoutMs) });
    const text = await res.text(); let json = null; try { json = text ? JSON.parse(text) : null; } catch { json = { message: text.slice(0, 200) }; }
    if (!res.ok) throw new AuthError(res.status, json);
    return json;
  }
  const session = (j) => ({ accessToken: j.access_token, refreshToken: j.refresh_token, expiresIn: j.expires_in, userId: j.user && j.user.id, email: j.user && j.user.email });
  return {
    signIn: async (email, password) => session(await req('POST', '/token?grant_type=password', { body: { email, password } })),
    refresh: async (refreshToken) => session(await req('POST', '/token?grant_type=refresh_token', { body: { refresh_token: refreshToken } })),
    signOut: (token) => req('POST', '/logout', { token }),
    changePassword: (token, password) => req('PUT', '/user', { token, body: { password } }),
    // MFA (TOTP) של GoTrue. enroll → challenge → verify מחזיר סשן חדש עם aal2.
    mfa: {
      listFactors: async (token) => ((await req('GET', '/user', { token })).factors || []).map((f) => ({ id: f.id, type: f.factor_type, status: f.status })),
      enroll: async (token, friendlyName) => {
        const j = await req('POST', '/factors', { token, body: { factor_type: 'totp', friendly_name: friendlyName, issuer: 'Business Platform' } });
        return { id: j.id, secret: j.totp && j.totp.secret, uri: j.totp && j.totp.uri, qrCode: j.totp && j.totp.qr_code };
      },
      challenge: async (token, factorId) => (await req('POST', `/factors/${encodeURIComponent(factorId)}/challenge`, { token, body: {} })).id,
      verify: async (token, factorId, challengeId, code) => session(await req('POST', `/factors/${encodeURIComponent(factorId)}/verify`, { token, body: { challenge_id: challengeId, code } })),
      unenroll: (token, factorId) => req('DELETE', `/factors/${encodeURIComponent(factorId)}`, { token }),
    },
    admin: {
      createUser: async (email, password) => { const j = await req('POST', '/admin/users', { admin: true, body: { email, password, email_confirm: true } }); return { id: j.id, email: j.email }; },
      setPassword: (id, password) => req('PUT', `/admin/users/${encodeURIComponent(id)}`, { admin: true, body: { password } }),
      setBanned: (id, banned) => req('PUT', `/admin/users/${encodeURIComponent(id)}`, { admin: true, body: { ban_duration: banned ? '876000h' : 'none' } }),
      deleteUser: (id) => req('DELETE', `/admin/users/${encodeURIComponent(id)}`, { admin: true }),
    },
  };
}
