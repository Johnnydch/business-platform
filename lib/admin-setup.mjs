// הקמת מנהל הפלטפורמה הראשון. רץ בשרת/במחשב המפעיל עם מפתח service_role; לעולם לא בדפדפן.
// הסיסמה אינה עוברת בארגומנטים או בצ'אט (ראו scripts/bootstrap-super-admin.mjs). אימות דו-שלבי (TOTP) נרשם בכניסה הראשונה לממשק.
import { cleanEmail } from './password.mjs';

export function superPasswordProblem(pw) {
  if (typeof pw !== 'string' || pw.length < 14) return 'סיסמת מנהל פלטפורמה: לפחות 14 תווים';
  if (pw.length > 200) return 'הסיסמה ארוכה מדי';
  if (new Set(pw).size < 6) return 'הסיסמה חלשה מדי';
  return null;
}

export async function bootstrapSuperAdmin({ rest, auth, email, password }) {
  const e = cleanEmail(email); if (!e) throw new Error('אימייל לא תקין');
  const problem = superPasswordProblem(password); if (problem) throw new Error(problem);
  let user;
  try { user = await auth.admin.createUser(e, password); }
  catch (err) { throw new Error(`יצירת המשתמש ב-Auth נכשלה: ${err.message}`); }
  let r;
  try { r = await rest.service('rpc_bootstrap_super_admin', { p_user: user.id }); }
  catch (err) { await auth.admin.deleteUser(user.id).catch(() => {}); throw new Error(`הקמת המנהל נכשלה: ${err.message}`); }
  if (!r || !r.ok) {
    await auth.admin.deleteUser(user.id).catch(() => {});                         // פיצוי: לא משאירים חשבון Auth יתום
    throw new Error(`${(r && r.error && r.error.message) || 'שגיאה'} (${(r && r.error && r.error.code) || '?'})`);
  }
  return { userId: user.id, email: e };
}
