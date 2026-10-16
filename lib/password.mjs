export function passwordProblem(pw) {
  if (typeof pw !== 'string' || pw.length < 10) return 'הסיסמה חייבת להכיל לפחות 10 תווים';
  if (pw.length > 200) return 'הסיסמה ארוכה מדי';
  if (/^(.)\1+$/.test(pw)) return 'הסיסמה חלשה מדי';
  return null;
}
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;
export function cleanEmail(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase();
  return s.length <= 254 && EMAIL_RE.test(s) ? s : null;
}
