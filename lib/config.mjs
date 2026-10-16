// קונפיגורציה מהסביבה. נכשל סגור: בלי סוד הגבלת קצב או מפתח שרת תקין – אין שירות.
// מפתח ה-service_role נקרא רק כאן ורק בצד השרת; הוא לעולם לא נשלח לדפדפן ואינו נכלל בתגובות.
export function loadConfig(env = process.env) {
  const need = (k) => { const v = (env[k] || '').trim(); if (!v) throw new Error(`חסר משתנה סביבה: ${k}`); return v; };
  const url = need('SUPABASE_URL').replace(/\/$/, '');
  if (!/^https:\/\//.test(url) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(url)) throw new Error('SUPABASE_URL חייב להיות https');
  const anonKey = need('SUPABASE_ANON_KEY'), serviceKey = need('SUPABASE_SERVICE_ROLE_KEY'), pepper = need('RATE_LIMIT_PEPPER');
  if (anonKey === serviceKey) throw new Error('SUPABASE_ANON_KEY ו-SUPABASE_SERVICE_ROLE_KEY חייבים להיות שונים');
  if (pepper.length < 32) throw new Error('RATE_LIMIT_PEPPER חייב להכיל לפחות 32 תווים אקראיים');
  // Origin מאושר במפורש (ללא תווי כללי ובלי הסקה מכותרת Host). משמש לבדיקת CSRF ולבניית הקישורים האישיים.
  const allowedOrigins = need('ALLOWED_ORIGINS').split(',').map((x) => x.trim()).filter(Boolean).map((o) => {
    let u; try { u = new URL(o); } catch { throw new Error(`ALLOWED_ORIGINS: כתובת לא תקינה: ${o}`); }
    if (!/^[a-z0-9.-]+$/i.test(u.hostname)) throw new Error(`ALLOWED_ORIGINS: שם מארח לא תקין (ללא כוכביות): ${o}`);
    const local = u.protocol === 'http:' && /^(localhost|127\.0\.0\.1)$/.test(u.hostname);
    if (u.protocol !== 'https:' && !local) throw new Error(`ALLOWED_ORIGINS: חובה https (או localhost בפיתוח): ${o}`);
    if (u.origin !== o.replace(/\/$/, '')) throw new Error(`ALLOWED_ORIGINS: יש לציין origin בלבד (ללא נתיב/כוכביות): ${o}`);
    return u.origin;
  });
  if (!allowedOrigins.length) throw new Error('ALLOWED_ORIGINS ריק');
  const publicBaseUrl = (env.PUBLIC_BASE_URL || allowedOrigins[0]).replace(/\/$/, '');
  if (!allowedOrigins.includes(publicBaseUrl)) throw new Error('PUBLIC_BASE_URL חייב להופיע ב-ALLOWED_ORIGINS');
  return {
    supabaseUrl: url, anonKey, serviceKey, pepper, allowedOrigins, publicBaseUrl,
    cookieSecure: env.COOKIE_SECURE !== '0',    // ברירת מחדל: Secure. מבטלים רק בפיתוח מקומי (COOKIE_SECURE=0)
  };
}
