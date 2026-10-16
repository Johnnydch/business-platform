# פלטפורמת תבניות ומערכות לעסקים

קוד משותף + קטלוג תבניות. התבנית הראשונה: מערכת הזמנת תורים לברברשופ (שחור-זהב, עברית, RTL, מובייל).
יעד: Supabase (Postgres + Auth) ו-Netlify (Static + Functions).

- `supabase/migrations/` – סכמה, RLS, מנוע זמינות, RPC (0001–0010)
- `netlify/functions/api.mjs` + `lib/` – שכבת API (המפתח הסודי רק כאן)
- `public/` – ממשק לקוח, בעלים ו-Super Admin
- `scripts/` – פיתוח מקומי, e2e בדפדפן, העברת עסק
- `test/` – בדיקות על Postgres אמיתי
- `docs/` – `DEPLOYMENT.md`, `HANDOVER.md`, `TEMPLATES.md`

הרצת בדיקות: `PGHOST=… PGPORT=… PGUSER=… npm test` (נדרש Postgres 16 מקומי עם הרשאת יצירת DB).

## מצב נוכחי
ראו את הסיכום המלא (נבדק / דורש שירות חיצוני / לא מומש) ב-`docs/STATUS.md`.

## מסמכים וסקריפטים עיקריים
- `docs/STAGING_CHECKLIST.md` – פעולות מצדכם לפתיחת staging; `docs/TEST_REPORT.md` – מקומי מול ענן; `docs/STATUS.md` – מצב ומגבלות; `docs/TEMPLATES.md` – טבלת מוכנות לכל תבנית; `docs/MARKETING.md` – חומרי מוצר; `docs/OPERATIONS.md`, `docs/HANDOVER.md`, `docs/DEPLOYMENT.md`.
- `scripts/staging-verify.mjs` (אימות ענן), `scripts/shoot-demos.mjs`, `scripts/seed-demos.mjs`, `scripts/migrate-business.mjs`, `scripts/backup-businesses.mjs`, `scripts/bootstrap-super-admin.mjs`.
