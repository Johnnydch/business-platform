# רשימת פעולות לפתיחת staging (מצדכם, בחשבונות שלכם)

**כללי ברזל:** מפתחות שרת נשארים בשרת. אין להדביק סודות בצ'אט. את הסודות מזינים רק בטרמינל שלכם ובהגדרות Netlify/Supabase. המערכת לא מוכרזת כמוכנה לייצור לפני שכל בדיקות הענן בסעיף 8 עברו.

## 1. Supabase (פרויקט staging נפרד מכל פרויקט אמיתי)
1. צרו פרויקט חדש. שמרו (אצלכם בלבד): Project URL, anon/publishable key, service_role/secret key.
2. הריצו את `supabase/migrations/0001` … `0015` לפי הסדר (SQL Editor או `supabase db push`). **לא** את `supabase/tests/support/*`.
3. Authentication ← Sign In / Providers: **כבו הרשמה עצמית**. Multi-Factor: ודאו ש-**TOTP** מופעל (enroll + verify).
4. ודאו שמשתמשים שנוצרים דרך admin API נוצרים מאושרים (email confirmed) – אם דרוש, כבו את אישור האימייל בפרויקט staging.

## 2. Netlify
1. אתר חדש מהריפו (Publish: `public`, Functions: `netlify/functions` – כבר ב-`netlify.toml`).
2. משתני סביבה (סמנו Secret): `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `RATE_LIMIT_PEPPER` (≥32 תווים אקראיים שתיצרו), `ALLOWED_ORIGINS` = `https://<שם-האתר>.netlify.app` (Origin מדויק, בלי נתיב), אופציונלי `PUBLIC_BASE_URL`.
3. פרסו. ודאו בלוח Netlify שה-Scheduled Function `maintenance` מופיעה.

## 3. Super Admin ראשון (טרמינל שלכם)
`SUPABASE_URL=… SUPABASE_ANON_KEY=… SUPABASE_SERVICE_ROLE_KEY=… node scripts/bootstrap-super-admin.mjs --email <האימייל שלכם>` (הסיסמה נקראת בהקלדה מוסתרת). אחר כך היכנסו ל-`/admin` והגדירו TOTP באפליקציית אימות.

## 4. הדגמות
`SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… node scripts/seed-demos.mjs` – יוצר 5 עסקי הדגמה.

## 5. שני עסקי בדיקה (לבדיקת בידוד)
דרך האשף ב-`/admin` ← פלטפורמה: צרו עסק A ועסק B (תבניות כלשהן) עם שני אימיילי בדיקה ושתי סיסמאות זמניות. שמרו את ה-slug של A.

## 6. הרצת אימות אוטומטי (טרמינל שלכם)
```
STAGING_URL=https://<site>.netlify.app \
SUPABASE_URL=… SUPABASE_ANON_KEY=… \
OWNER_A_EMAIL=… OWNER_A_PASSWORD=… OWNER_B_EMAIL=… OWNER_B_PASSWORD=… OWNER_A_LEAD_SLUG=<slug של A אם תבנית פניות> \
SUPER_EMAIL=… SUPER_PASSWORD=… SUPER_TOTP_SECRET=… \
node scripts/staging-verify.mjs
node scripts/shoot-demos.mjs https://<site>.netlify.app docs/screenshots-staging
```
הסקריפט מכסה: כניסה/MFA/רענון/יציאה, בידוד בין עסקים כולל קריאות JWT ישירות ל-REST, הזמנה/שינוי/ביטול, מקביליות, הגבלת קצב, ניתוב פניות לבעלים הנכון, כותרות אבטחה, עוגיות (HttpOnly/Secure/SameSite), Origin זר. השני בודק RTL ואי-גלילה אופקית בנייד ובדסקטופ בכל 5 התבניות. SKIP אינו הצלחה.

## 7. דומיין מותאם (אופציונלי, אם יש לכם דומיין לבדיקה)
הוסיפו אותו בהגדרות העסק ← "דומיין מותאם"; הוסיפו אצל ספק ה-DNS את רשומות ה-TXT וה-CNAME שמוצגות; הוסיפו Domain alias ב-Netlify; לחצו "בדיקת חיבור". המצב "פעיל" חייב להופיע רק אחרי ששתי הבדיקות עברו.

## 8. מה נשאר לא מאומת עד שתריצו (ולא יוצג כמוכן)
| נושא | למה לא נבדק כאן |
|---|---|
| GoTrue אמיתי: aal2 ב-JWT, רענון, חסימת משתמש | נבדק מול GoTrue מדומה עם TOTP אמיתי (RFC 6238) |
| `context.ip` של Netlify והגבלת קצב לפיו | אין Netlify |
| כותרות Netlify, rewrites, Scheduled Function | אין Netlify |
| טעינת גופני Google ב-CSP | אין גישת רשת לגופנים |
| DNS ו-TLS אמיתיים לדומיין מותאם | הבדיקה נבדקה עם resolver/fetch מוזרקים |
| שליחת SMS/WhatsApp | כבוי: אין ספק. האתר מציין זאת, והקישור האישי מוצג בלי הודעה |
| PostgREST אמיתי (קוד שגיאה, מגבלות גודל) | נבדק מול Postgres דרך מתאם psql |

דווחו לי את תוצאת `staging-verify` (ללא סודות) ואתקן כל כשל.
