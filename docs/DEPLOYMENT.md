# הקמה: Supabase + Netlify

> **סטטוס אימות:** כל מה שבמסמך זה נבדק מקומית מול Postgres 16 אמיתי ו-Chromium אמיתי. **לא נבדק מול פרויקט Supabase או אתר Netlify אמיתיים** (לא הייתה גישת רשת). בצעו את "רשימת אימות ראשונה" בסוף לפני שמוסרים ללקוח.

## 1. Supabase
1. צרו פרויקט. רשמו: Project URL, anon key, service_role key (או `sb_publishable_…` / `sb_secret_…`).
2. SQL Editor או `supabase db push`: הריצו לפי הסדר `supabase/migrations/0001` … `0015`. **אל** תריצו את `supabase/tests/support/*` – הם לבדיקות מקומיות בלבד (shim של `auth` ודריסת השעון).
3. Authentication → כבו הרשמה עצמית (Disable signups). משתמשים נוצרים רק דרך השרת (admin API).
4. Super Admin ראשון (פעם אחת): מהמחשב שלכם, עם משתני הסביבה של הפרויקט **בטרמינל בלבד** (לא בצ'אט ולא בקובץ בריפו):
   `node scripts/bootstrap-super-admin.mjs --email you@example.com` – הסיסמה (≥14 תווים) נקראת בהקלדה מוסתרת. הפקודה נכשלת אם כבר קיים מנהל.
   מיד אחר כך היכנסו לאתר: המערכת תחייב **הגדרת אימות דו-שלבי (TOTP)** לפני כל פעולת ניהול. ללא aal2 ה-DB עצמו דוחה פעולות Super Admin.
5. ודאו ש-`anon` נעול: קריאת `rpc/rpc_public_businesses` עם מפתח anon חייבת להיכשל (403/permission denied). הגישה הציבורית עוברת רק דרך פונקציית Netlify עם service_role.
6. ניקוי תקופתי (rate limits ויומן פעולות ישן) רץ כ-Netlify Scheduled Function (`maintenance.mjs`, כל שעה) דרך `rpc_maintenance_cleanup`. *לא נבדק על Netlify אמיתי.* אין צורך ב-pg_cron.
7. הרשאות: המיגרציות מבטלות EXECUTE ל-PUBLIC ול-anon על כל פונקציה; בדיקת מלאי ההרשאות (`test/security.test.mjs`) מוודאת זאת. אחרי כל מיגרציה חדשה הריצו אותה.

## 2. Netlify
1. חברו את הריפו. Publish dir: `public`. Functions: `netlify/functions`. (מוגדר ב-`netlify.toml`.)
2. משתני סביבה (Site settings → Environment variables), סמנו Secret:
   | משתנה | חובה | הערה |
   |---|---|---|
   | `SUPABASE_URL` | כן | https |
   | `SUPABASE_ANON_KEY` | כן | |
   | `SUPABASE_SERVICE_ROLE_KEY` | כן | שרת בלבד. נקרא רק ב-`lib/config.mjs`. אין להגדיר כמשתנה בפריט שנחשף לדפדפן |
   | `RATE_LIMIT_PEPPER` | כן | ≥32 תווים אקראיים. משמש ל-HMAC של IP וטלפון. החלפה מאפסת את המונים (בלבד) |
   | `ALLOWED_ORIGINS` | כן | רשימת Origins מדויקים מופרדים בפסיק (למשל `https://my-site.netlify.app,https://book.example.com`). https או localhost בלבד, בלי wildcard ובלי נתיב. כל בקשת שינוי (POST/PUT/PATCH/DELETE) עם Origin שאינו ברשימה נחסמת 403. אין הסקה מכותרת Host |
   | `PUBLIC_BASE_URL` | לא | בסיס לקישורים אישיים. חייב להופיע ב-`ALLOWED_ORIGINS`; ברירת מחדל: הראשון ברשימה |
   | `COOKIE_SECURE` | לא | ברירת מחדל Secure. `0` רק בפיתוח מקומי |
3. השרת נכשל סגור: חסר משתנה / מפתחות זהים / pepper קצר – אין שירות.

## 3. פיתוח מקומי
`PGHOST=… PGPORT=… PGUSER=… node scripts/dev-local.mjs 3111` – מקים מסד Postgres מקומי, זורע נתוני דמו ומשרת את האתר. Auth שם **מדומה** ואסור לפרוס אותו. SQLite אינו חלק מהפלטפורמה (היה רק בגרסת v0).

## רשימת אימות ראשונה (לא בוצעה)
- [ ] מיגרציות 0001–0015 רצות נקי על Supabase.
- [ ] סקריפט ה-bootstrap, כניסת Super Admin, הגדרת TOTP אמיתי, `aal2` ב-JWT, פעולה רגישה דורשת אימות טרי (15 דק׳).
- [ ] יצירת עסק, כניסת Owner.
- [ ] יומן פעולות נכתב ואינו מכיל פרטים אישיים.
- [ ] בקשת POST עם Origin זר נחסמת.
- [ ] Owner של עסק A לא רואה/משנה נתוני עסק B (גם עם קריאה ישירה ל-REST עם ה-JWT שלו).
- [ ] הזמנה מקבילה לאותו חלון – אחת מצליחה.
- [ ] `context.ip` ב-Netlify Function מחזיר IP אמיתי (הגבלת הקצב תלויה בו).
- [ ] כותרות האבטחה והכתיבה מחדש (`/b/*` וכו') פעילות.
- [ ] Refresh, השבתת משתמש ומחיקת משתמש דרך GoTrue אמיתי.

## אשף הקמה ודומיינים מותאמים (מיגרציות 0011–0013)
- הקמת עסק: פלטפורמה ← "+ עסק חדש" (אשף 8 שלבים, טיוטה נשמרת בשרת). פרסום דורש אימות TOTP טרי, ויוצר עסק + בעלים + שירותים + צוות באופן אטומי. אין פרסום כשחסר שדה חובה.
- דומיין מותאם: משתני סביבה `ALLOWED_ORIGINS` (מארחי הפלטפורמה) ו-`RATE_LIMIT_PEPPER` חייבים להיות מוגדרים. לקוח מוסיף דומיין, מגדיר אצל ספק ה-DNS רשומת TXT (`_bsverify.<host>` = `bs-verify=<token>`) ו-CNAME/ALIAS לאתר, ולוחץ "בדיקת חיבור". הסטטוס "פעיל" נקבע רק אם גם ה-TXT נמצא וגם `https://<host>/api/public/domain-ping` מחזיר חותמת תקפה.
- יש להוסיף את הדומיין גם כ-Domain alias בהגדרות Netlify (תעודת HTTPS נוצרת שם). זה לא נעשה אוטומטית ולא נבדק מול Netlify אמיתי.
- דומיין מותאם משרת רק נתיבי `/api/public/*`; כל ניהול (admin/super) דורש מארח פלטפורמה.

## אתר המותג, הדגמות והקפאה (מיגרציות 0014–0015)
- עמוד הבית (`/`) הוא אתר המכירות. שם המותג, מחירים ותוספות נערכים בלשונית "מותג" (מחירים הם **טיוטה** עד אישור).
- הקמת הדגמות: `SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… node scripts/seed-demos.mjs` (אידמפוטנטי). עסקי הדגמה ללא בעלים/דומיין.
- ניטור: `GET /api/health`. גיבוי לוגי: `scripts/backup-businesses.mjs`. הקפאה/הגירה: HANDOVER.md. תפעול: OPERATIONS.md.
