-- =====================================================================
-- 0004 · RPC לבעל עסק (Owner) ול-Super Admin. EXECUTE: authenticated (JWT של Supabase Auth).
-- פעולות CRUD פשוטות הן SECURITY INVOKER ולכן ה-RLS אוכף הפרדה בין עסקים.
-- פעולות המנוע (יצירת תור, זמינות) הן SECURITY DEFINER עם resolve_business מפורש.
-- חתימה אחידה: (p_business uuid, p jsonb). ל-Owner הפרמטר p_business מתעלמים (תמיד העסק שלו).
-- =====================================================================

create function public.rpc_me() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare pu platform_users; b businesses; t templates;
begin
  select * into pu from platform_users where user_id = auth.uid() and active;
  if pu.user_id is null then raise exception 'forbidden' using errcode = '42501'; end if;
  if pu.role = 'owner' then
    select * into b from businesses where id = pu.business_id;
    if not b.active then raise exception 'shop_disabled' using errcode = '42501'; end if;
    select * into t from templates where key = b.template;
  end if;
  return app.ok(jsonb_build_object(
    'user', jsonb_build_object('id', pu.user_id, 'email', auth.jwt() ->> 'email', 'role', case pu.role when 'owner' then 'shop_owner' else pu.role end,
                               'shop_id', pu.business_id),
    'shop', case when b.id is null then null else jsonb_build_object('id', b.id, 'name', b.name, 'slug', b.slug, 'template', b.template,
              'kind', t.kind, 'theme', t.theme, 'labels', t.labels) end));
end $$;

create function public.rpc_templates() returns jsonb
language sql stable set search_path = public, pg_temp as
$$ select app.ok(jsonb_build_object('templates', coalesce((select jsonb_agg(to_jsonb(t) order by t.sort, t.key) from templates t), '[]'))) $$;

-- ---------- הגדרות עסק ----------
create function public.rpc_owner_shop_get(p_business uuid, p jsonb default '{}') returns jsonb
language plpgsql stable set search_path = public, pg_temp as $$
declare b businesses; t templates; biz uuid := app.resolve_business(p_business);
begin
  select * into b from businesses where businesses.id = biz;
  select * into t from templates where key = b.template;
  return app.ok(jsonb_build_object('shop', jsonb_build_object('id', b.id, 'slug', b.slug, 'name', b.name, 'phone', b.phone,
     'address', b.address, 'active', b.active, 'template', b.template, 'kind', t.kind, 'labels', t.labels, 'slot_step', b.slot_step, 'min_notice_min', b.min_notice_min,
     'max_days_ahead', b.max_days_ahead, 'cancel_cutoff_hours', b.cancel_cutoff_hours)));
end $$;

create function public.rpc_owner_shop_update(p_business uuid, p jsonb) returns jsonb
language plpgsql volatile set search_path = public, pg_temp as $$
declare biz uuid := app.resolve_business(p_business); f jsonb := '{}'; nm text; ph text; ad text; ss bigint; nt bigint; ah bigint; cf bigint;
begin
  nm := app.clean_text(app.jtext(p, 'name'), 2, 60);
  ph := nullif(btrim(coalesce(app.jtext(p, 'phone'), '')), '');
  ad := case when coalesce(app.jtext(p, 'address'), '') = '' then null else app.clean_text(app.jtext(p, 'address'), 2, 120) end;
  ss := app.jint(p, 'slot_step', 5, 60); nt := app.jint(p, 'min_notice_min', 0, 1440);
  ah := app.jint(p, 'max_days_ahead', 1, 180); cf := app.jint(p, 'cancel_cutoff_hours', 0, 72);
  if nm is null then f := f || '{"name":"שם העסק: 2–60 תווים"}'; end if;
  if ph is not null and ph !~ '^[0-9+() \-]{7,20}$' then f := f || '{"phone":"מספר טלפון לא תקין"}'; end if;
  if coalesce(app.jtext(p, 'address'), '') <> '' and ad is null then f := f || '{"address":"כתובת: 2–120 תווים"}'; end if;
  if ss is null or ss not in (5,10,15,20,30,60) then f := f || '{"slot_step":"ערך לא תקין"}'; end if;
  if nt is null then f := f || '{"min_notice_min":"ערך לא תקין"}'; end if;
  if ah is null then f := f || '{"max_days_ahead":"ערך בין 1 ל-180"}'; end if;
  if cf is null then f := f || '{"cancel_cutoff_hours":"ערך בין 0 ל-72"}'; end if;
  if f <> '{}' then return app.err(400, 'validation', 'נא לתקן את השדות המסומנים', f); end if;
  update businesses set name = nm, phone = ph, address = ad, slot_step = ss, min_notice_min = nt, max_days_ahead = ah,
         cancel_cutoff_hours = cf where businesses.id = biz;
  return app.ok('{}');
end $$;

-- ---------- צוות ושעות עבודה ----------
create function app.parse_hours(p_hours jsonb) returns jsonb language plpgsql immutable as $$
declare h jsonb; wd bigint; st bigint; en bigint; seen int[] := '{}';
begin
  if p_hours is null or jsonb_typeof(p_hours) <> 'array' or jsonb_array_length(p_hours) > 7 then return null; end if;
  for h in select * from jsonb_array_elements(p_hours) loop
    wd := app.jint(h, 'weekday', 0, 6); st := app.jint(h, 'start_min', 0, 1439); en := app.jint(h, 'end_min', 1, 1440);
    if wd is null or st is null or en is null or en <= st or wd = any (seen) then return null; end if;
    seen := seen || wd::int;
  end loop;
  return p_hours;
end $$;

create function app.write_hours(p_biz uuid, p_staff bigint, p_hours jsonb) returns void language plpgsql volatile as $$
begin
  delete from working_hours where staff_id = p_staff and business_id = p_biz;
  insert into working_hours (staff_id, business_id, weekday, start_min, end_min)
    select p_staff, p_biz, (h ->> 'weekday')::int, (h ->> 'start_min')::int, (h ->> 'end_min')::int from jsonb_array_elements(p_hours) h;
end $$;

create function public.rpc_owner_staff_list(p_business uuid, p jsonb default '{}') returns jsonb
language plpgsql stable set search_path = public, pg_temp as $$
declare biz uuid := app.resolve_business(p_business);
begin
  return app.ok(jsonb_build_object('barbers', coalesce((
    select jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name, 'active', s.active, 'hours', coalesce((
        select jsonb_agg(jsonb_build_object('weekday', w.weekday, 'start_min', w.start_min, 'end_min', w.end_min) order by w.weekday)
        from working_hours w where w.staff_id = s.id), '[]')) order by s.sort, s.id)
    from staff s where s.business_id = biz), '[]')));
end $$;

create function public.rpc_owner_staff_create(p_business uuid, p jsonb) returns jsonb
language plpgsql volatile set search_path = public, pg_temp as $$
declare biz uuid := app.resolve_business(p_business); nm text; hrs jsonb; sid bigint; mx int;
begin
  nm := app.clean_text(app.jtext(p, 'name'), 2, 40);
  if nm is null then return app.err(400, 'validation', 'נא להזין שם (2–40 תווים)', '{"name":"שם לא תקין"}'); end if;
  hrs := app.parse_hours(coalesce(p -> 'hours', '[]'));
  if hrs is null then return app.err(400, 'invalid_request', 'שעות עבודה לא תקינות'); end if;
  select coalesce(max(sort), 0) into mx from staff where business_id = biz;
  insert into staff (business_id, name, sort) values (biz, nm, mx + 1) returning staff.id into sid;
  perform app.write_hours(biz, sid, hrs);
  return jsonb_build_object('ok', true, 'status', 201, 'data', jsonb_build_object('id', sid));
end $$;

create function public.rpc_owner_staff_update(p_business uuid, p jsonb) returns jsonb
language plpgsql volatile set search_path = public, pg_temp as $$
declare biz uuid := app.resolve_business(p_business); sid bigint := app.jint(p, 'id', 1, 1000000000); nm text; hrs jsonb; n int;
begin
  nm := app.clean_text(app.jtext(p, 'name'), 2, 40);
  if nm is null then return app.err(400, 'validation', 'שם לא תקין', '{"name":"שם לא תקין"}'); end if;
  if p ? 'hours' then
    hrs := app.parse_hours(p -> 'hours');
    if hrs is null then return app.err(400, 'invalid_request', 'שעות עבודה לא תקינות'); end if;
  end if;
  update staff set name = nm, active = coalesce((p ->> 'active')::boolean, true) where staff.id = sid and business_id = biz;
  get diagnostics n = row_count;
  if n = 0 then return app.err(404, 'not_found', 'איש הצוות לא נמצא'); end if;
  if hrs is not null then perform app.write_hours(biz, sid, hrs); end if;
  return app.ok('{}');
end $$;

-- ---------- שירותים ----------
create function app.parse_service(p jsonb, out nm text, out dur bigint, out price bigint, out f jsonb) language plpgsql immutable as $$
begin
  f := '{}';
  nm := app.clean_text(app.jtext(p, 'name'), 2, 60); dur := app.jint(p, 'duration_min', 5, 480); price := app.jint(p, 'price_ils', 0, 100000);
  if nm is null then f := f || '{"name":"שם שירות: 2–60 תווים"}'; end if;
  if dur is null then f := f || '{"duration_min":"משך בדקות (5–480)"}'; end if;
  if price is null then f := f || '{"price_ils":"מחיר בשקלים (0–100000)"}'; end if;
end $$;

create function public.rpc_owner_services_list(p_business uuid, p jsonb default '{}') returns jsonb
language plpgsql stable set search_path = public, pg_temp as $$
declare biz uuid := app.resolve_business(p_business);
begin
  return app.ok(jsonb_build_object('services', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name,
     'duration_min', s.duration_min, 'price_ils', s.price_ils, 'active', s.active) order by s.id) from services s where s.business_id = biz), '[]')));
end $$;

create function public.rpc_owner_service_create(p_business uuid, p jsonb) returns jsonb
language plpgsql volatile set search_path = public, pg_temp as $$
declare biz uuid := app.resolve_business(p_business); v record; sid bigint;
begin
  select * into v from app.parse_service(p);
  if v.f <> '{}' then return app.err(400, 'validation', 'נא לתקן את השדות המסומנים', v.f); end if;
  insert into services (business_id, name, duration_min, price_ils) values (biz, v.nm, v.dur, v.price) returning services.id into sid;
  return jsonb_build_object('ok', true, 'status', 201, 'data', jsonb_build_object('id', sid));
end $$;

create function public.rpc_owner_service_update(p_business uuid, p jsonb) returns jsonb
language plpgsql volatile set search_path = public, pg_temp as $$
declare biz uuid := app.resolve_business(p_business); sid bigint := app.jint(p, 'id', 1, 1000000000); v record; n int;
begin
  select * into v from app.parse_service(p);
  if v.f <> '{}' then return app.err(400, 'validation', 'נא לתקן את השדות המסומנים', v.f); end if;
  update services set name = v.nm, duration_min = v.dur, price_ils = v.price, active = coalesce((p ->> 'active')::boolean, true)
   where services.id = sid and business_id = biz;
  get diagnostics n = row_count;
  if n = 0 then return app.err(404, 'not_found', 'השירות לא נמצא'); end if;
  return app.ok('{}');
end $$;

-- ---------- יומן ----------
create function app.appt_json(a appointments, staff_name text, phone text) returns jsonb language sql immutable as
$$ select jsonb_build_object('id', a.id, 'barber_id', a.staff_id, 'barber_name', staff_name, 'service_id', a.service_id,
     'service_name', a.service_name, 'price_ils', a.price_ils, 'date', a.date, 'start_min', a.start_min, 'end_min', a.end_min,
     'status', a.status, 'source', a.source, 'first_name', a.first_name, 'last_name', a.last_name, 'phone', phone,
     'notes', a.notes, 'created_at', a.created_at) $$;

create function public.rpc_owner_appointments(p_business uuid, p jsonb) returns jsonb
language plpgsql stable set search_path = public, pg_temp as $$
declare biz uuid := app.resolve_business(p_business); f date := app.jdate(p, 'from'); t date := coalesce(app.jdate(p, 'to'), app.jdate(p, 'from'));
        sid bigint := app.jint(p, 'barber_id', 1, 1000000000); withc boolean := coalesce(p ->> 'cancelled', '') in ('1', 'true');
begin
  if f is null or t is null or t < f or (t - f) > 62 then return app.err(400, 'invalid_request', 'טווח תאריכים לא תקין'); end if;
  return app.ok(jsonb_build_object('appointments', coalesce((
    select jsonb_agg(app.appt_json(a, s.name, c.phone) order by a.date, a.start_min)
    from appointments a join staff s on s.id = a.staff_id join customers c on c.id = a.customer_id
    where a.business_id = biz and a.date between f and t and (sid is null or a.staff_id = sid) and (withc or a.status <> 'cancelled')), '[]')));
end $$;

create function public.rpc_owner_availability(p_business uuid, p jsonb) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare biz uuid := app.resolve_business(p_business); st staff; sv services; d date := app.jdate(p, 'date');
begin
  select * into st from staff where staff.id = app.jint(p, 'barber_id', 1, 1000000000) and business_id = biz;
  select * into sv from services where services.id = app.jint(p, 'service_id', 1, 1000000000) and business_id = biz;
  if st.id is null or sv.id is null or d is null then return app.err(400, 'invalid_request', 'בקשה לא תקינה'); end if;
  return app.ok(jsonb_build_object('slots', to_jsonb(app.slots_for(biz, st.id, d, sv.duration_min, 0, true))));
end $$;

create function public.rpc_owner_appointment_create(p_business uuid, p jsonb) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare biz uuid := app.resolve_business(p_business); f jsonb := '{}'; fn text; ln text; ph text; sid bigint; svc bigint; sm int; d date;
        nt text := app.clean_text(app.jtext(p, 'notes'), 1, 300); r jsonb;
begin
  fn := app.clean_name(app.jtext(p, 'first_name')); ln := app.clean_name(app.jtext(p, 'last_name')); ph := app.normalize_phone(app.jtext(p, 'phone'));
  if fn is null then f := f || '{"first_name":"שם פרטי לא תקין"}'; end if;
  if ln is null then f := f || '{"last_name":"שם משפחה לא תקין"}'; end if;
  if ph is null then f := f || '{"phone":"מספר נייד ישראלי לא תקין"}'; end if;
  if f <> '{}' then return app.err(400, 'validation', 'נא לתקן את השדות המסומנים', f); end if;
  sid := app.jint(p, 'barber_id', 1, 1000000000); svc := app.jint(p, 'service_id', 1, 1000000000);
  sm := app.jint(p, 'start_min', 0, 1439); d := app.jdate(p, 'date');
  if sid is null or svc is null or sm is null or d is null then return app.err(400, 'invalid_request', 'פרטי התור חסרים'); end if;
  r := app.create_appointment(biz, sid, svc, d, sm, fn, ln, ph, 'owner', nt);
  if (r ->> 'ok')::boolean then
    return jsonb_build_object('ok', true, 'status', 201, 'data', jsonb_build_object('id', r -> 'data' -> 'id'));   -- ללא טוקן
  end if;
  return r;
end $$;

create function public.rpc_owner_appointment_status(p_business uuid, p jsonb) returns jsonb
language plpgsql volatile set search_path = public, pg_temp as $$
declare biz uuid := app.resolve_business(p_business); aid bigint := app.jint(p, 'id', 1, 1000000000); st text := app.jtext(p, 'status'); n int;
begin
  if st is null or st not in ('confirmed','cancelled','completed','no_show') then return app.err(400, 'invalid_request', 'סטטוס לא תקין'); end if;
  begin
    -- החזרת תור מבוטל לפעילות נבדקת מול אילוץ אי-החפיפה של מסד הנתונים
    update appointments set status = st, cancelled_at = case when st = 'cancelled' then now() else null end
     where appointments.id = aid and business_id = biz;
  exception when exclusion_violation then
    return app.slot_taken();
  end;
  get diagnostics n = row_count;
  if n = 0 then return app.err(404, 'not_found', 'התור לא נמצא'); end if;
  return app.ok('{}');
end $$;

-- ---------- חסימות ----------
create function public.rpc_owner_blocks(p_business uuid, p jsonb) returns jsonb
language plpgsql stable set search_path = public, pg_temp as $$
declare biz uuid := app.resolve_business(p_business); f date := app.jdate(p, 'from'); t date := coalesce(app.jdate(p, 'to'), app.jdate(p, 'from'));
begin
  if f is null or t is null or t < f or (t - f) > 62 then return app.err(400, 'invalid_request', 'טווח תאריכים לא תקין'); end if;
  return app.ok(jsonb_build_object('blocks', coalesce((select jsonb_agg(jsonb_build_object('id', k.id, 'barber_id', k.staff_id,
      'barber_name', s.name, 'date', k.date, 'start_min', k.start_min, 'end_min', k.end_min, 'note', k.note) order by k.date, k.start_min)
    from blocks k left join staff s on s.id = k.staff_id where k.business_id = biz and k.date between f and t), '[]')));
end $$;

create function public.rpc_owner_block_create(p_business uuid, p jsonb) returns jsonb
language plpgsql volatile set search_path = public, pg_temp as $$
declare biz uuid := app.resolve_business(p_business); sid bigint := app.jint(p, 'barber_id', 1, 1000000000);
        st int := app.jint(p, 'start_min', 0, 1439); en int := app.jint(p, 'end_min', 1, 1440); d date := app.jdate(p, 'date');
        nt text := app.clean_text(app.jtext(p, 'note'), 1, 120); bid bigint; conflicts int;
begin
  if (p ->> 'barber_id') is not null and p ->> 'barber_id' <> '' and (sid is null or not exists (select 1 from staff where staff.id = sid and business_id = biz))
     or st is null or en is null or en <= st or d is null then
    return app.err(400, 'invalid_request', 'פרטי החסימה לא תקינים');
  end if;
  insert into blocks (business_id, staff_id, date, start_min, end_min, note) values (biz, sid, d, st, en, nt) returning blocks.id into bid;
  select count(*) into conflicts from appointments a
   where a.business_id = biz and a.date = d and a.status = 'confirmed' and a.start_min < en and a.end_min > st and (sid is null or a.staff_id = sid);
  return jsonb_build_object('ok', true, 'status', 201, 'data', jsonb_build_object('id', bid, 'conflicts', conflicts));
end $$;

create function public.rpc_owner_block_delete(p_business uuid, p jsonb) returns jsonb
language plpgsql volatile set search_path = public, pg_temp as $$
declare biz uuid := app.resolve_business(p_business); n int;
begin
  delete from blocks where blocks.id = app.jint(p, 'id', 1, 1000000000) and business_id = biz;
  get diagnostics n = row_count;
  if n = 0 then return app.err(404, 'not_found', 'החסימה לא נמצאה'); end if;
  return app.ok('{}');
end $$;

-- ---------- לקוחות ----------
create function public.rpc_owner_customers(p_business uuid, p jsonb) returns jsonb
language plpgsql stable set search_path = public, pg_temp as $$
declare biz uuid := app.resolve_business(p_business); q text := left(btrim(coalesce(app.jtext(p, 'q'), '')), 40); lk text;
begin
  lk := '%' || replace(replace(replace(q, '\', '\\'), '%', '\%'), '_', '\_') || '%';
  return app.ok(jsonb_build_object('customers', coalesce((
    select jsonb_agg(x order by (x ->> 'id')::bigint desc) from (
      select jsonb_build_object('id', c.id, 'first_name', c.first_name, 'last_name', c.last_name, 'phone', c.phone, 'created_at', c.created_at,
        'visits', (select count(*) from appointments a where a.customer_id = c.id and a.status in ('confirmed','completed')),
        'no_shows', (select count(*) from appointments a where a.customer_id = c.id and a.status = 'no_show'),
        'last_date', (select max(a.date) from appointments a where a.customer_id = c.id and a.status in ('confirmed','completed'))) as x
      from customers c where c.business_id = biz and (q = '' or c.first_name ilike lk or c.last_name ilike lk or c.phone ilike lk)
      order by c.id desc limit 200) s), '[]')));
end $$;

-- ---------- סקירה ----------
create function public.rpc_owner_dashboard(p_business uuid, p jsonb default '{}') returns jsonb
language plpgsql stable set search_path = public, pg_temp as $$
declare biz uuid := app.resolve_business(p_business); b businesses; today date; nowmin int; up jsonb;
begin
  select * into b from businesses where businesses.id = biz;
  today := app.local_date(b.timezone); nowmin := app.local_min(b.timezone);
  select coalesce(jsonb_agg(app.appt_json(a, s.name, c.phone) order by a.date, a.start_min), '[]') into up from (
    select * from appointments a where a.business_id = biz and a.status = 'confirmed' and (a.date > today or (a.date = today and a.start_min >= nowmin))
    order by a.date, a.start_min limit 6) a join staff s on s.id = a.staff_id join customers c on c.id = a.customer_id;
  return app.ok(jsonb_build_object(
    'today',           (select count(*) from appointments where business_id = biz and date = today and status in ('confirmed','completed')),
    'remaining_today', (select count(*) from appointments where business_id = biz and date = today and status = 'confirmed' and start_min >= nowmin),
    'tomorrow',        (select count(*) from appointments where business_id = biz and date = today + 1 and status in ('confirmed','completed')),
    'next7',           (select count(*) from appointments where business_id = biz and date between today and today + 6 and status in ('confirmed','completed')),
    'cancelled7',      (select count(*) from appointments where business_id = biz and status = 'cancelled' and cancelled_at >= now() - interval '7 days'),
    'revenue_today',   (select coalesce(sum(price_ils), 0) from appointments where business_id = biz and date = today and status in ('confirmed','completed')),
    'customers',       (select count(*) from customers where business_id = biz),
    'new_leads',       (select count(*) from leads where business_id = biz and status = 'new'),
    'has_barbers',     exists (select 1 from staff where business_id = biz and active),
    'has_services',    exists (select 1 from services where business_id = biz and active),
    'upcoming', up));
end $$;

-- ---------- פניות ----------
create function public.rpc_owner_leads(p_business uuid, p jsonb default '{}') returns jsonb
language plpgsql stable set search_path = public, pg_temp as $$
declare biz uuid := app.resolve_business(p_business);
begin
  return app.ok(jsonb_build_object('leads', coalesce((
    select jsonb_agg(jsonb_build_object('id', l.id, 'name', l.name, 'phone', l.phone, 'message', l.message, 'service_name', s.name,
        'source', l.source, 'status', l.status, 'created_at', l.created_at) order by l.created_at desc)
    from (select * from leads where business_id = biz order by created_at desc limit 200) l left join services s on s.id = l.service_id), '[]')));
end $$;

create function public.rpc_owner_lead_status(p_business uuid, p jsonb) returns jsonb
language plpgsql volatile set search_path = public, pg_temp as $$
declare biz uuid := app.resolve_business(p_business); st text := app.jtext(p, 'status'); n int;
begin
  if st is null or st not in ('new','contacted','closed') then return app.err(400, 'invalid_request', 'סטטוס לא תקין'); end if;
  update leads set status = st where leads.id = app.jint(p, 'id', 1, 1000000000) and business_id = biz;
  get diagnostics n = row_count;
  if n = 0 then return app.err(404, 'not_found', 'הפנייה לא נמצאה'); end if;
  return app.ok('{}');
end $$;
