-- =====================================================================
-- 0006 · קטלוג תבניות (תצורה, לא נתוני לקוחות). status='available' רק לתבנית שמומשה ונבדקה.
-- =====================================================================
insert into public.templates (key, name, kind, status, theme, labels, default_services, sort) values
('barbershop', 'ברברשופ', 'booking', 'available', 'barbershop-gold',
  '{"business":"מספרה","staff_one":"ספר","staff_many":"ספרים","pick_staff":"אצל מי תרצו להסתפר?","brand":"Barbershop"}',
  '[{"name":"תספורת","duration_min":30,"price_ils":70},{"name":"זקן","duration_min":20,"price_ils":40},{"name":"תספורת + זקן","duration_min":45,"price_ils":100}]', 10),
('cosmetics', 'קוסמטיקה', 'booking', 'planned', 'cosmetics',
  '{"business":"קליניקה","staff_one":"קוסמטיקאית","staff_many":"קוסמטיקאיות","pick_staff":"אצל מי תרצו להיות מטופלות?","brand":"Cosmetics"}',
  '[{"name":"טיפול פנים","duration_min":60,"price_ils":250},{"name":"הסרת שיער","duration_min":30,"price_ils":150}]', 20),
('detailing', 'דיטיילינג', 'booking', 'planned', 'detailing',
  '{"business":"סטודיו","staff_one":"איש צוות","staff_many":"צוות","pick_staff":"עם מי תרצו לעבוד?","brand":"Detailing"}',
  '[{"name":"שטיפה מפורטת","duration_min":120,"price_ils":350},{"name":"פוליש וציפוי","duration_min":300,"price_ils":1800}]', 30),
('landing-leads', 'דף נחיתה ללידים', 'leads', 'planned', 'default',
  '{"business":"עסק","brand":"Leads"}', '[]', 40),
('service-catalog', 'קטלוג שירותים', 'catalog', 'planned', 'default',
  '{"business":"עסק","brand":"Services"}', '[]', 50)
on conflict (key) do update set name = excluded.name, kind = excluded.kind, theme = excluded.theme,
  labels = excluded.labels, default_services = excluded.default_services, sort = excluded.sort;
-- status נשמר במכוון ללא עדכון ב-upsert: סימון "available" נעשה במיגרציה נפרדת, רק אחרי מימוש ובדיקה.
