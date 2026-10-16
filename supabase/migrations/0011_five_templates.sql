-- =====================================================================
-- 0011 · חמש התבניות: קטלוג, תוויות לפי תחום, שדות פנייה ייעודיים.
-- כל התבניות נוצרות כ-'planned'. מעבר ל-'available' נעשה רק במיגרציה 0012, אחרי שהמימוש והבדיקות קיימים.
-- =====================================================================
alter table public.templates
  add column tagline     text,                              -- משפט קצר לאתר המכירה
  add column description text,
  add column audience    text,
  add column features    jsonb not null default '[]';

-- מפתחות ישנים → חדשים (עסקים קיימים עוברים; אין מחיקת נתונים)
insert into public.templates (key, name, kind, status, theme, labels, default_services, sort, tagline, description, audience, features) values
('barbershop', 'מספרות וברברשופ', 'booking', 'planned', 'barbershop-gold', '{"staff_icon": "scissors", "all_staff": "כל הספרים", "brand": "Barbershop", "business": "מספרה", "staff_one": "ספר", "staff_many": "ספרים", "pick_staff": "אצל מי תרצו להסתפר?", "service_one": "שירות", "service_many": "שירותים", "pick_service": "איזה שירות תרצו?", "appt_one": "תור", "appt_many": "תורים", "book_cta": "אישור הזמנת תור", "done_title": "התור נקבע בהצלחה", "done_sub": "נשמח לראות אתכם.", "no_staff_slots": "אין כרגע שעות פנויות אצל ספר זה. נסו ספר אחר או חזרו מאוחר יותר.", "add_staff": "הוספת ספר", "calendar": "יומן", "customers": "לקוחות", "leads_tab": "פניות", "empty_unbooked": "הזמנת תורים אונליין עדיין לא הופעלה בעסק זה.", "manage_title": "התור שלי", "book_title": "הזמנת תור"}'::jsonb, '[{"name": "תספורת", "duration_min": 30, "price_ils": 70}, {"name": "זקן", "duration_min": 20, "price_ils": 40}, {"name": "תספורת + זקן", "duration_min": 45, "price_ils": 100}]'::jsonb, 10, 'מספרה שהלקוחות מזמינים אליה תור בלי להתקשר', 'מערכת הזמנת תורים למספרה: בחירת שירות וספר, שעות פנויות בזמן אמת, ויומן לבעל העסק. בעיצוב שחור-זהב.', 'מספרות, ברברשופ וסלוני גברים', '["הזמנת תור אונליין ללא חשבון", "יומן ספרים ושעות עבודה", "תזכורות וקישור אישי לשינוי וביטול", "ניהול שירותים ומחירים"]'::jsonb),
('cosmetics', 'קוסמטיקה, ציפורניים וריסים', 'booking', 'planned', 'cosmetics-blush', '{"staff_icon": "sparkle", "all_staff": "כל המטפלות", "brand": "Beauty Studio", "business": "סטודיו", "staff_one": "מטפלת", "staff_many": "מטפלות", "pick_staff": "אצל מי תרצו להיות מטופלות?", "service_one": "טיפול", "service_many": "טיפולים", "pick_service": "איזה טיפול תרצו?", "appt_one": "טיפול", "appt_many": "טיפולים", "book_cta": "אישור הזמנת הטיפול", "done_title": "הטיפול נקבע", "done_sub": "מצפות לראות אתכן.", "no_staff_slots": "אין כרגע מועדים פנויים אצל מטפלת זו. נסו מטפלת אחרת או חזרו מאוחר יותר.", "add_staff": "הוספת מטפלת", "calendar": "יומן טיפולים", "customers": "לקוחות", "leads_tab": "פניות", "empty_unbooked": "הזמנת טיפולים אונליין עדיין לא הופעלה בסטודיו זה.", "manage_title": "הטיפול שלי", "book_title": "הזמנת טיפול"}'::jsonb, '[{"name": "לק ג׳ל", "duration_min": 60, "price_ils": 130}, {"name": "בנייה בג׳ל", "duration_min": 90, "price_ils": 220}, {"name": "הרמת ריסים", "duration_min": 60, "price_ils": 250}, {"name": "הדבקת ריסים", "duration_min": 120, "price_ils": 320}, {"name": "טיפול פנים", "duration_min": 60, "price_ils": 260}]'::jsonb, 20, 'יומן טיפולים אלגנטי ללקוחות שאוהבות לקבוע מהנייד', 'מערכת הזמנת טיפולים לסטודיו ליופי: ציפורניים, ריסים וקוסמטיקה. כל מטפלת עם יומן משלה, ומשך טיפול לכל שירות.', 'קוסמטיקאיות, מניקוריסטיות, מעצבות ריסים וסטודיו ליופי', '["הזמנת טיפולים אונליין, ללא חשבון", "מטפלות ושעות עבודה נפרדות", "משך טיפול לכל שירות, כולל טיפולים ארוכים", "קישור אישי לשינוי וביטול"]'::jsonb),
('detailing', 'דיטיילינג ושטיפת רכב', 'booking', 'planned', 'detailing-graphite', '{"staff_icon": "car", "all_staff": "כל התחנות", "brand": "Auto Detailing", "business": "מכון טיפולי רכב", "staff_one": "תחנה", "staff_many": "תחנות עבודה", "pick_staff": "באיזו תחנה?", "service_one": "חבילה", "service_many": "חבילות טיפול", "pick_service": "איזו חבילה תרצו?", "appt_one": "תור", "appt_many": "תורים", "book_cta": "אישור הזמנת התור", "done_title": "התור לרכב נקבע", "done_sub": "ניפגש במכון.", "no_staff_slots": "אין כרגע שעות פנויות בתחנה זו. נסו תחנה אחרת או חזרו מאוחר יותר.", "add_staff": "הוספת תחנה", "calendar": "יומן תחנות", "customers": "לקוחות", "leads_tab": "פניות", "empty_unbooked": "הזמנת תורים אונליין עדיין לא הופעלה במכון זה.", "manage_title": "התור שלי", "book_title": "הזמנת תור לרכב"}'::jsonb, '[{"name": "שטיפה חיצונית", "duration_min": 45, "price_ils": 90}, {"name": "שטיפה פנים וחוץ", "duration_min": 90, "price_ils": 180}, {"name": "ניקוי פנים מעמיק", "duration_min": 180, "price_ils": 450}, {"name": "פוליש", "duration_min": 240, "price_ils": 900}, {"name": "ציפוי קרמי", "duration_min": 480, "price_ils": 2800}]'::jsonb, 30, 'חבילות טיפול, תחנות עבודה ויומן שמונע חפיפות', 'מערכת הזמנת תורים למכון טיפולי רכב: חבילות עם משך זמן, ותחנות עבודה שבהן כל תחנה תפוסה לאורך כל הטיפול.', 'דיטיילינג, שטיפות רכב, ציפוי קרמי וטיפולי פוליש', '["חבילות טיפול עם משך ומחיר", "תחנות עבודה: כל תחנה עם יומן משלה", "טיפולים ארוכים חוסמים את התחנה לכל משכם", "קישור אישי לשינוי וביטול"]'::jsonb),
('home-services', 'בעלי מקצוע ושירותי בית', 'leads', 'planned', 'home-orange', '{"brand": "שירותי בית", "business": "עסק", "service_one": "שירות", "service_many": "שירותים", "catalog_title": "במה נוכל לעזור", "tagline": "הגעה מהירה, מחיר הוגן ועבודה מסודרת.", "lead_title": "השאירו פרטים ונחזור אליכם", "lead_cta": "שליחת בקשה", "lead_done_title": "קיבלנו את הפנייה", "lead_done_sub": "נחזור אליכם בהקדם.", "msg_label": "תארו את התקלה או העבודה", "msg_placeholder": "למשל: נזילה מתחת לכיור במטבח", "service_pick_label": "סוג העבודה", "leads_tab": "פניות", "leads_title": "פניות לקוחות", "extra": "home", "calendar": "", "customers": "", "book_title": "יצירת קשר"}'::jsonb, '[{"name": "בדיקה והערכת מחיר", "duration_min": 30, "price_ils": 0}, {"name": "תיקון תקלה דחופה", "duration_min": 60, "price_ils": 250}, {"name": "התקנה", "duration_min": 90, "price_ils": 350}, {"name": "עבודה לפי שעה", "duration_min": 60, "price_ils": 180}]'::jsonb, 40, 'דף נחיתה שמביא פניות: אינסטלציה, חשמל, מיזוג ועוד', 'דף נחיתה לבעל מקצוע: שירותים, אזור שירות וטופס פנייה שכולל עיר ודחיפות. הפניות נשמרות ומופיעות אצל בעל העסק.', 'אינסטלטורים, חשמלאים, טכנאי מיזוג, שיפוצניקים ונגרים', '["דף נחיתה מותאם לנייד", "טופס פנייה עם עיר ודחיפות", "ניהול פניות והתקשרות/WhatsApp בלחיצה", "קטלוג שירותים ומחירים"]'::jsonb),
('studio-services', 'נותני שירות וסטודיואים', 'catalog', 'planned', 'studio-paper', '{"brand": "Studio", "business": "סטודיו", "service_one": "שירות", "service_many": "שירותים", "catalog_title": "השירותים", "tagline": "נשמח לשמוע על הפרויקט שלכם.", "lead_title": "בקשת הצעת מחיר", "lead_cta": "שליחת בקשה", "lead_done_title": "הבקשה התקבלה", "lead_done_sub": "נחזור אליכם עם הצעה.", "msg_label": "ספרו לנו על הפרויקט", "msg_placeholder": "מה תרצו לקבל, ולאיזה מטרה?", "service_pick_label": "השירות המבוקש", "leads_tab": "בקשות הצעה", "leads_title": "בקשות להצעת מחיר", "extra": "studio", "calendar": "", "customers": "", "book_title": "הצעת מחיר"}'::jsonb, '[{"name": "פגישת היכרות", "duration_min": 30, "price_ils": 0}, {"name": "חבילת בסיס", "duration_min": 30, "price_ils": 1500}, {"name": "חבילה מורחבת", "duration_min": 30, "price_ils": 3500}, {"name": "פרויקט בהתאמה אישית", "duration_min": 30, "price_ils": 0}]'::jsonb, 50, 'קטלוג שירותים ובקשת הצעת מחיר מסודרת', 'קטלוג שירותים ובקשת הצעת מחיר: הלקוח בוחר שירות, מציין תקציב ולוח זמנים, והבקשה נשמרת אצל בעל העסק.', 'צלמים, מעצבים, מאמנים, מטפלים, סטודיואים ויועצים', '["קטלוג שירותים", "בקשת הצעת מחיר עם תקציב ולוח זמנים", "ניהול הבקשות בלשונית ייעודית", "עיצוב נקי שמתאים לתיק עבודות"]'::jsonb)
on conflict (key) do update set name = excluded.name, kind = excluded.kind, theme = excluded.theme, labels = excluded.labels,
  default_services = excluded.default_services, sort = excluded.sort, tagline = excluded.tagline, description = excluded.description,
  audience = excluded.audience, features = excluded.features;
update public.businesses set template = 'home-services' where template = 'landing-leads';
update public.businesses set template = 'studio-services' where template = 'service-catalog';
delete from public.templates where key in ('landing-leads', 'service-catalog');
-- status של 'barbershop' נשאר כפי שהוא (available); שאר התבניות נשארות planned עד 0012.

-- ---------- שדות פנייה ייעודיים (מילון סגור לפי תבנית) ----------
alter table public.leads add column meta jsonb not null default '{}'
  check (jsonb_typeof(meta) = 'object' and pg_column_size(meta) < 400);

create or replace function app.lead_meta(p_template text, p jsonb) returns jsonb
language plpgsql immutable set search_path = public, pg_temp as $$
declare m jsonb := '{}'; v text;
begin
  if p_template = 'home-services' then
    v := app.clean_text(app.jtext(p, 'city'), 2, 40);
    if v is not null then m := m || jsonb_build_object('city', v); end if;
    v := app.jtext(p, 'urgency');
    if v in ('today', 'week', 'flexible') then m := m || jsonb_build_object('urgency', v); end if;
  elsif p_template = 'studio-services' then
    v := app.jtext(p, 'budget');
    if v in ('lt1k', '1-3k', '3-10k', 'gt10k', 'unknown') then m := m || jsonb_build_object('budget', v); end if;
    v := app.jtext(p, 'timeframe');
    if v in ('asap', 'month', 'flexible') then m := m || jsonb_build_object('timeframe', v); end if;
  end if;
  return m;
end $$;
revoke all on function app.lead_meta(text, jsonb) from public;

create or replace function public.rpc_public_submit_lead(p jsonb, p_ip_hash text, p_pepper text) returns jsonb
language plpgsql volatile security definer set search_path = public, extensions, pg_temp as $$
declare b businesses; nm text; ph text; msg text; fields jsonb := '{}'; svc bigint;
begin
  nm := app.clean_name(app.jtext(p, 'name'));
  ph := app.normalize_phone(app.jtext(p, 'phone'));
  msg := app.clean_text(app.jtext(p, 'message'), 1, 500);
  if nm is null then fields := fields || '{"name":"נא להזין שם תקין"}'; end if;
  if ph is null then fields := fields || '{"phone":"נא להזין מספר נייד ישראלי תקין (למשל 054-1234567)"}'; end if;
  if app.jtext(p, 'message') is not null and msg is null then fields := fields || '{"message":"הודעה: עד 500 תווים, ללא תווי HTML"}'; end if;
  if app.jtext(p, 'city') is not null and app.clean_text(app.jtext(p, 'city'), 2, 40) is null then fields := fields || '{"city":"עיר: 2–40 תווים"}'; end if;
  if fields <> '{}' then return app.err(400, 'validation', 'נא לתקן את השדות המסומנים', fields); end if;
  b := app.biz_by_slug(app.jtext(p, 'slug'));
  if b.id is null then return app.err(404, 'shop_not_found', 'העסק לא נמצא'); end if;
  if not app.rl_hit('lead:ip:' || b.id || ':' || p_ip_hash, 5, 3600)
     or not app.rl_hit('lead:ipall:' || p_ip_hash, 15, 3600)
     or not app.rl_hit('lead:biz:' || b.id, 100, 3600)
     or not app.rl_hit('lead:phone:' || b.id || ':' || encode(hmac(ph, p_pepper, 'sha256'), 'hex'), 3, 3600) then
    return app.limited();
  end if;
  svc := app.jint(p, 'service_id', 1, 1000000000);
  if svc is not null and not exists (select 1 from services where id = svc and business_id = b.id and active) then svc := null; end if;
  insert into leads (business_id, name, phone, message, service_id, source, meta) values (b.id, nm, ph, msg, svc, 'web', app.lead_meta(b.template, p));
  return app.ok('{}');
end $$;

create or replace function public.rpc_owner_leads(p_business uuid, p jsonb default '{}') returns jsonb
language plpgsql stable set search_path = public, pg_temp as $$
declare biz uuid := app.resolve_business(p_business);
begin
  return app.ok(jsonb_build_object('leads', coalesce((
    select jsonb_agg(jsonb_build_object('id', l.id, 'name', l.name, 'phone', l.phone, 'message', l.message, 'service_name', s.name,
        'source', l.source, 'status', l.status, 'created_at', l.created_at, 'meta', l.meta) order by l.created_at desc)
    from (select * from leads where business_id = biz order by created_at desc limit 200) l left join services s on s.id = l.service_id), '[]')));
end $$;

-- ייבוא עסק: תומך ב-meta של פניות ובמפתחות תבנית ישנים
create or replace function public.rpc_admin_import_business(p jsonb, p_new_slug text default null) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare bj jsonb := p -> 'business'; bid uuid; sl text; r jsonb; smap jsonb := '{}'; vmap jsonb := '{}'; cmap jsonb := '{}'; nid bigint;
        counts jsonb;
begin
  if p ->> 'format' is distinct from 'platform-business-export' or (p ->> 'version') is distinct from '1' then
    return app.err(400, 'invalid_export', 'קובץ ייצוא לא תקין או בגרסה לא נתמכת');
  end if;
  sl := coalesce(p_new_slug, bj ->> 'slug');
  if exists (select 1 from businesses where slug = sl) then
    return app.err(409, 'duplicate', 'הכתובת כבר תפוסה בסביבת היעד', '{"slug":"הכתובת כבר תפוסה"}');
  end if;
  bj := jsonb_set(bj, '{template}', to_jsonb(case bj ->> 'template' when 'landing-leads' then 'home-services' when 'service-catalog' then 'studio-services' else bj ->> 'template' end));   -- מפתחות תבנית ישנים
  if not exists (select 1 from templates where key = bj ->> 'template') then
    return app.err(400, 'invalid_export', 'התבנית אינה קיימת בסביבת היעד');
  end if;
  insert into businesses (slug, name, template, phone, address, timezone, slot_step, min_notice_min, max_days_ahead, cancel_cutoff_hours)
  values (sl, bj ->> 'name', bj ->> 'template', bj ->> 'phone', bj ->> 'address', coalesce(bj ->> 'timezone', 'Asia/Jerusalem'),
          (bj ->> 'slot_step')::int, (bj ->> 'min_notice_min')::int, (bj ->> 'max_days_ahead')::int, (bj ->> 'cancel_cutoff_hours')::int)
  returning id into bid;

  for r in select * from jsonb_array_elements(coalesce(p -> 'staff', '[]')) loop
    insert into staff (business_id, name, active, sort) values (bid, r ->> 'name', (r ->> 'active')::boolean, (r ->> 'sort')::int) returning id into nid;
    smap := smap || jsonb_build_object(r ->> 'id', nid);
  end loop;
  for r in select * from jsonb_array_elements(coalesce(p -> 'services', '[]')) loop
    insert into services (business_id, name, duration_min, price_ils, active)
      values (bid, r ->> 'name', (r ->> 'duration_min')::int, (r ->> 'price_ils')::int, (r ->> 'active')::boolean) returning id into nid;
    vmap := vmap || jsonb_build_object(r ->> 'id', nid);
  end loop;
  for r in select * from jsonb_array_elements(coalesce(p -> 'working_hours', '[]')) loop
    insert into working_hours (staff_id, business_id, weekday, start_min, end_min)
      values ((smap ->> (r ->> 'staff_id'))::bigint, bid, (r ->> 'weekday')::int, (r ->> 'start_min')::int, (r ->> 'end_min')::int);
  end loop;
  for r in select * from jsonb_array_elements(coalesce(p -> 'blocks', '[]')) loop
    insert into blocks (business_id, staff_id, date, start_min, end_min, note)
      values (bid, (smap ->> (r ->> 'staff_id'))::bigint, (r ->> 'date')::date, (r ->> 'start_min')::int, (r ->> 'end_min')::int, r ->> 'note');
  end loop;
  for r in select * from jsonb_array_elements(coalesce(p -> 'customers', '[]')) loop
    insert into customers (business_id, first_name, last_name, phone, created_at)
      values (bid, r ->> 'first_name', r ->> 'last_name', r ->> 'phone', (r ->> 'created_at')::timestamptz) returning id into nid;
    cmap := cmap || jsonb_build_object(r ->> 'id', nid);
  end loop;
  for r in select * from jsonb_array_elements(coalesce(p -> 'appointments', '[]')) loop
    insert into appointments (business_id, staff_id, service_id, customer_id, date, start_min, end_min, service_name, price_ils, first_name,
        last_name, status, source, token_hash, token_expires_at, token_uses, notes, created_at, cancelled_at)
    values (bid, (smap ->> (r ->> 'staff_id'))::bigint, (vmap ->> (r ->> 'service_id'))::bigint, (cmap ->> (r ->> 'customer_id'))::bigint,
        (r ->> 'date')::date, (r ->> 'start_min')::int, (r ->> 'end_min')::int, r ->> 'service_name', (r ->> 'price_ils')::int,
        r ->> 'first_name', r ->> 'last_name', r ->> 'status', r ->> 'source', r ->> 'token_hash', (r ->> 'token_expires_at')::timestamptz,
        (r ->> 'token_uses')::int, r ->> 'notes', (r ->> 'created_at')::timestamptz, (r ->> 'cancelled_at')::timestamptz);
  end loop;
  for r in select * from jsonb_array_elements(coalesce(p -> 'leads', '[]')) loop
    insert into leads (business_id, name, phone, message, service_id, source, status, created_at, meta)
      values (bid, r ->> 'name', r ->> 'phone', r ->> 'message', (vmap ->> (r ->> 'service_id'))::bigint, r ->> 'source', r ->> 'status', (r ->> 'created_at')::timestamptz, coalesce(r -> 'meta', '{}'));
  end loop;
  counts := jsonb_build_object('staff', (select count(*) from staff where business_id = bid), 'services', (select count(*) from services where business_id = bid),
      'customers', (select count(*) from customers where business_id = bid), 'appointments', (select count(*) from appointments where business_id = bid),
      'leads', (select count(*) from leads where business_id = bid));
  return app.ok(jsonb_build_object('business_id', bid, 'slug', sl, 'counts', counts));
end $$;
