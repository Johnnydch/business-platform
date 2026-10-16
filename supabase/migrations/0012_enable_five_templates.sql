-- =====================================================================
-- 0012 · הפעלת התבניות שמומשו ונבדקו: קוסמטיקה, דיטיילינג, בעלי מקצוע, נותני שירות.
-- מומשו: ערכת עיצוב ייעודית (public/themes), תוויות תחום, עמוד ציבורי, ניהול והתמדה אמיתית (תורים / פניות עם שדות ייעודיים).
-- בדיקות: test/templates.test.mjs (DB + API) ו-scripts/e2e-browser.mjs (נייד, RTL). סטטוס ההכנה לפיילוט: docs/TEMPLATES.md.
-- =====================================================================
update public.templates set status = 'available' where key in ('barbershop', 'cosmetics', 'detailing', 'home-services', 'studio-services');
