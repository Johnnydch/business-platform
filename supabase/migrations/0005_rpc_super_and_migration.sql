-- =====================================================================
-- 0005 · Super Admin + ייצוא/ייבוא נתוני עסק (מסירה והגירה בין מסלולים)
-- =====================================================================
create function app.require_super() returns void language plpgsql stable as $$
begin
  if not app.is_super() then raise exception 'forbidden' using errcode = '42501'; end if;
end $$;

create function public.rpc_super_businesses() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform app.require_super();
  return app.ok(jsonb_build_object('shops', coalesce((
    select jsonb_agg(jsonb_build_object('id', b.id, 'slug', b.slug, 'name', b.name, 'template', b.template, 'kind', (select t.kind from templates t where t.key = b.template), 'phone', b.phone,
       'address', b.address, 'active', b.active, 'created_at', b.created_at,
       'owner_emails', (select string_agg(u.email, ', ') from platform_users pu join auth.users u on u.id = pu.user_id where pu.business_id = b.id),
       'barbers',   (select count(*) from staff s where s.business_id = b.id and s.active),
       'services',  (select count(*) from services v where v.business_id = b.id and v.active),
       'customers', (select count(*) from customers c where c.business_id = b.id),
       'upcoming',  (select count(*) from appointments a where a.business_id = b.id and a.status = 'confirmed' and a.date >= app.local_date(b.timezone)))
       order by b.created_at desc) from businesses b), '[]')));
end $$;

-- יצירת עסק + שיוך Owner שכבר נוצר ב-Supabase Auth (בצד השרת, עם מפתח service)
create function public.rpc_super_create_business(p jsonb) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare nm text; sl text; tp text; uid uuid; f jsonb := '{}'; bid uuid; t templates; svc jsonb;
begin
  perform app.require_super();
  nm := app.clean_text(app.jtext(p, 'name'), 2, 60);
  sl := lower(btrim(coalesce(app.jtext(p, 'slug'), '')));
  tp := coalesce(app.jtext(p, 'template'), 'barbershop');
  begin uid := (app.jtext(p, 'owner_user_id'))::uuid; exception when others then uid := null; end;
  if nm is null then f := f || '{"name":"שם העסק: 2–60 תווים"}'; end if;
  if sl !~ '^[a-z0-9]+(-[a-z0-9]+)*$' or char_length(sl) not between 3 and 40 then f := f || '{"slug":"כתובת באנגלית (a-z, 0-9, מקף), 3–40 תווים"}'; end if;
  select * into t from templates where key = tp and status = 'available';
  if t.key is null then f := f || '{"template":"תבנית לא זמינה"}'; end if;
  if uid is null or not exists (select 1 from auth.users where id = uid) then f := f || '{"owner_email":"חשבון הבעלים לא נמצא"}';
  elsif exists (select 1 from platform_users where user_id = uid) then f := f || '{"owner_email":"החשבון כבר משויך לעסק"}'; end if;
  if f <> '{}' then return app.err(400, 'validation', 'נא לתקן את השדות המסומנים', f); end if;
  if exists (select 1 from businesses where slug = sl) then
    return app.err(409, 'duplicate', 'הנתונים כבר קיימים במערכת', '{"slug":"הכתובת כבר תפוסה"}');
  end if;
  insert into businesses (slug, name, template) values (sl, nm, t.key) returning id into bid;
  insert into platform_users (user_id, role, business_id) values (uid, 'owner', bid);
  for svc in select * from jsonb_array_elements(t.default_services) loop
    insert into services (business_id, name, duration_min, price_ils)
      values (bid, svc ->> 'name', (svc ->> 'duration_min')::int, (svc ->> 'price_ils')::int);
  end loop;
  return jsonb_build_object('ok', true, 'status', 201, 'data', jsonb_build_object('id', bid));
end $$;

-- שיוך Owner (שנוצר בנפרד ב-Auth) לעסק קיים – למשל אחרי ייבוא נתונים בסביבת היעד
create function public.rpc_super_attach_owner(p_business uuid, p jsonb) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare uid uuid;
begin
  perform app.require_super();
  begin uid := (app.jtext(p, 'owner_user_id'))::uuid; exception when others then uid := null; end;
  if not exists (select 1 from businesses where id = p_business) then return app.err(404, 'not_found', 'העסק לא נמצא'); end if;
  if uid is null or not exists (select 1 from auth.users where id = uid) then
    return app.err(400, 'validation', 'נא לתקן את השדות המסומנים', '{"owner_email":"חשבון הבעלים לא נמצא"}');
  end if;
  if exists (select 1 from platform_users where user_id = uid) then
    return app.err(400, 'validation', 'נא לתקן את השדות המסומנים', '{"owner_email":"החשבון כבר משויך לעסק"}');
  end if;
  insert into platform_users (user_id, role, business_id) values (uid, 'owner', p_business);
  return app.ok('{}');
end $$;

create function public.rpc_super_set_active(p_business uuid, p jsonb) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare n int;
begin
  perform app.require_super();
  if jsonb_typeof(p -> 'active') <> 'boolean' then return app.err(400, 'invalid_request', 'בקשה לא תקינה'); end if;
  update businesses set active = (p ->> 'active')::boolean where id = p_business;
  get diagnostics n = row_count;
  if n = 0 then return app.err(404, 'not_found', 'העסק לא נמצא'); end if;
  return app.ok('{}');   -- ניתוק מיידי: my_business() מחזיר NULL לעסק מושבת, ולכן ה-JWT הקיים מאבד גישה
end $$;

create function public.rpc_super_owner_ids(p_business uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform app.require_super();
  return app.ok(jsonb_build_object('user_ids', coalesce((select jsonb_agg(user_id) from platform_users where business_id = p_business and role = 'owner'), '[]')));
end $$;

-- מחיקת עסק (לאחר הגירה). דורשת אישור מפורש עם ה-slug.
create function public.rpc_super_delete_business(p_business uuid, p jsonb) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare b businesses; owners jsonb;
begin
  perform app.require_super();
  select * into b from businesses where id = p_business;
  if b.id is null then return app.err(404, 'not_found', 'העסק לא נמצא'); end if;
  if app.jtext(p, 'confirm_slug') is distinct from b.slug then return app.err(400, 'confirm_required', 'יש לאשר באמצעות ה-slug של העסק'); end if;
  select coalesce(jsonb_agg(user_id), '[]') into owners from platform_users where business_id = b.id;
  delete from businesses where id = b.id;     -- מוחק בשרשרת את כל נתוני העסק
  return app.ok(jsonb_build_object('owner_user_ids', owners));   -- השרת מוחק אותם מ-Auth
end $$;

-- ---------- ייצוא נתוני עסק (service_role בלבד) ----------
-- כולל: הגדרות, צוות, שירותים, שעות, חסימות, לקוחות, תורים, פניות.
-- לא כולל: חשבונות Auth, סיסמאות, מפתחות, מוני קצב. ל-hash של אסימוני התורים נשמרים כדי שקישורי הלקוחות ימשיכו לעבוד.
create function public.rpc_admin_export_business(p_business uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare b businesses;
begin
  select * into b from businesses where id = p_business;
  if b.id is null then return app.err(404, 'not_found', 'העסק לא נמצא'); end if;
  return app.ok(jsonb_build_object(
    'format', 'platform-business-export', 'version', 1, 'exported_at', now(),
    'business', jsonb_build_object('slug', b.slug, 'name', b.name, 'template', b.template, 'phone', b.phone, 'address', b.address,
        'timezone', b.timezone, 'slot_step', b.slot_step, 'min_notice_min', b.min_notice_min, 'max_days_ahead', b.max_days_ahead,
        'cancel_cutoff_hours', b.cancel_cutoff_hours),
    'staff',          coalesce((select jsonb_agg(to_jsonb(x) - 'business_id' order by x.id) from staff x where x.business_id = b.id), '[]'),
    'services',       coalesce((select jsonb_agg(to_jsonb(x) - 'business_id' order by x.id) from services x where x.business_id = b.id), '[]'),
    'working_hours',  coalesce((select jsonb_agg(to_jsonb(x) - 'business_id') from working_hours x where x.business_id = b.id), '[]'),
    'blocks',         coalesce((select jsonb_agg(to_jsonb(x) - 'business_id' order by x.id) from blocks x where x.business_id = b.id), '[]'),
    'customers',      coalesce((select jsonb_agg(to_jsonb(x) - 'business_id' order by x.id) from customers x where x.business_id = b.id), '[]'),
    'appointments',   coalesce((select jsonb_agg(to_jsonb(x) - 'business_id' order by x.id) from appointments x where x.business_id = b.id), '[]'),
    'leads',          coalesce((select jsonb_agg(to_jsonb(x) - 'business_id' order by x.id) from leads x where x.business_id = b.id), '[]')));
end $$;

-- ---------- ייבוא נתוני עסק (service_role בלבד) ----------
-- יוצר עסק חדש במסד היעד, ממפה מחדש את כל המזהים. Owner נוצר בנפרד בחשבון ה-Auth של היעד.
create function public.rpc_admin_import_business(p jsonb, p_new_slug text default null) returns jsonb
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
    insert into leads (business_id, name, phone, message, service_id, source, status, created_at)
      values (bid, r ->> 'name', r ->> 'phone', r ->> 'message', (vmap ->> (r ->> 'service_id'))::bigint, r ->> 'source', r ->> 'status', (r ->> 'created_at')::timestamptz);
  end loop;
  counts := jsonb_build_object('staff', (select count(*) from staff where business_id = bid), 'services', (select count(*) from services where business_id = bid),
      'customers', (select count(*) from customers where business_id = bid), 'appointments', (select count(*) from appointments where business_id = bid),
      'leads', (select count(*) from leads where business_id = bid));
  return app.ok(jsonb_build_object('business_id', bid, 'slug', sl, 'counts', counts));
end $$;
