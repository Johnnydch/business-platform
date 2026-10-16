-- =====================================================================
-- 0003 · RPC ציבוריים (לקוחות ללא חשבון). EXECUTE: service_role בלבד.
-- נקראים רק מפונקציות Netlify בצד השרת, שמעבירות IP מגובב. הדפדפן לעולם לא קורא להם ישירות.
-- שגיאות עסקיות מוחזרות כמעטפת (לא נזרקות) כדי שמוני הקצב לא יתגלגלו אחורה.
-- =====================================================================

-- ---------- הגבלת קצב כללית (גם להתחברות מנהלים) ----------
create function public.rpc_rate_count(p_key text, p_window_s int) returns int
language sql stable security definer set search_path = public, pg_temp as
$$ select app.rl_count(p_key, p_window_s) $$;

create function public.rpc_rate_record(p_key text, p_window_s int) returns void
language sql volatile security definer set search_path = public, pg_temp as
$$ select app.rl_hit(p_key, 2147483647, p_window_s) $$;

create function public.rpc_rate_hit(p_key text, p_max int, p_window_s int) returns boolean
language sql volatile security definer set search_path = public, pg_temp as
$$ select app.rl_hit(p_key, p_max, p_window_s) $$;

-- ---------- עזרים ----------
create function app.biz_by_slug(p_slug text) returns businesses
language sql stable security definer set search_path = public, pg_temp as
$$ select * from businesses where slug = p_slug and active $$;

create function app.limited() returns jsonb language sql immutable as
$$ select app.err(429, 'rate_limited', 'בוצעו יותר מדי ניסיונות. נסו שוב בעוד מספר דקות.') $$;

create function app.public_staff(p_biz uuid) returns jsonb language sql stable security definer set search_path = public, pg_temp as
$$ select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name) order by s.sort, s.id), '[]')
   from staff s where s.business_id = p_biz and s.active and exists (select 1 from working_hours w where w.staff_id = s.id) $$;

-- ---------- קריאה ----------
create function public.rpc_public_businesses() returns jsonb
language sql stable security definer set search_path = public, pg_temp as
$$ select app.ok(jsonb_build_object('shops', coalesce(
     (select jsonb_agg(jsonb_build_object('slug', b.slug, 'name', b.name, 'address', b.address, 'template', b.template) order by b.name)
      from businesses b join templates t on t.key = b.template
      where b.active and t.kind = 'booking'), '[]'))) $$;

create function public.rpc_public_business(p_slug text) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare b businesses; t templates;
begin
  b := app.biz_by_slug(p_slug);
  if b.id is null then return app.err(404, 'shop_not_found', 'העסק לא נמצא'); end if;
  select * into t from templates where key = b.template;
  return app.ok(jsonb_build_object(
    'shop', jsonb_build_object('name', b.name, 'phone', b.phone, 'address', b.address, 'max_days_ahead', b.max_days_ahead,
                               'template', t.key, 'theme', t.theme, 'labels', t.labels),
    'services', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name, 'duration_min', s.duration_min, 'price_ils', s.price_ils) order by s.id)
                          from services s where s.business_id = b.id and s.active), '[]'),
    'barbers', app.public_staff(b.id)));
end $$;

create function public.rpc_public_days(p_slug text, p_staff bigint, p_service bigint) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare b businesses; st staff; sv services; today date; days jsonb := '[]'; d date;
begin
  b := app.biz_by_slug(p_slug);
  if b.id is null then return app.err(404, 'shop_not_found', 'העסק לא נמצא'); end if;
  select * into st from staff where id = p_staff and business_id = b.id and active;
  select * into sv from services where id = p_service and business_id = b.id and active;
  if st.id is null or sv.id is null then return app.err(404, 'not_found', 'איש הצוות או השירות לא נמצאו'); end if;
  today := app.local_date(b.timezone);
  for i in 0..b.max_days_ahead loop
    d := today + i;
    days := days || jsonb_build_object('date', d, 'available', cardinality(app.slots_for(b.id, st.id, d, sv.duration_min)) > 0);
  end loop;
  return app.ok(jsonb_build_object('days', days));
end $$;

create function public.rpc_public_slots(p_slug text, p_staff bigint, p_service bigint, p_date date) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare b businesses; st staff; sv services;
begin
  b := app.biz_by_slug(p_slug);
  if b.id is null then return app.err(404, 'shop_not_found', 'העסק לא נמצא'); end if;
  select * into st from staff where id = p_staff and business_id = b.id and active;
  select * into sv from services where id = p_service and business_id = b.id and active;
  if st.id is null or sv.id is null then return app.err(404, 'not_found', 'איש הצוות או השירות לא נמצאו'); end if;
  return app.ok(jsonb_build_object('date', p_date, 'slots', to_jsonb(app.slots_for(b.id, st.id, p_date, sv.duration_min))));
end $$;

-- ---------- הזמנה ----------
-- p: slug, service_id, barber_id, date, start_min, first_name, last_name, phone
-- p_ip_hash: SHA-256 של ה-IP (מחושב בשרת). p_pepper: סוד שרת לגיבוב מפתחות הקצב.
create function public.rpc_public_book(p jsonb, p_ip_hash text, p_pepper text) returns jsonb
language plpgsql volatile security definer set search_path = public, extensions, pg_temp as $$
declare first text; last text; phone text; fields jsonb := '{}'; b businesses; svc bigint; stf bigint; startm int; d date;
        pk text; r jsonb;
begin
  first := app.clean_name(app.jtext(p, 'first_name'));
  last  := app.clean_name(app.jtext(p, 'last_name'));
  phone := app.normalize_phone(app.jtext(p, 'phone'));
  if first is null then fields := fields || '{"first_name":"נא להזין שם פרטי תקין"}'; end if;
  if last  is null then fields := fields || '{"last_name":"נא להזין שם משפחה תקין"}'; end if;
  if phone is null then fields := fields || '{"phone":"נא להזין מספר נייד ישראלי תקין (למשל 054-1234567)"}'; end if;
  if fields <> '{}' then return app.err(400, 'validation', 'נא לתקן את השדות המסומנים', fields); end if;

  svc := app.jint(p, 'service_id', 1, 1000000000); stf := app.jint(p, 'barber_id', 1, 1000000000);
  startm := app.jint(p, 'start_min', 0, 1439); d := app.jdate(p, 'date');
  if svc is null or stf is null or startm is null or d is null then
    return app.err(400, 'invalid_request', 'פרטי התור חסרים או לא תקינים');
  end if;
  b := app.biz_by_slug(app.jtext(p, 'slug'));
  if b.id is null then return app.err(404, 'shop_not_found', 'העסק לא נמצא'); end if;

  -- הגבלת קצב משותפת: IP+עסק, IP גלובלי, עסק כולו, נייד+עסק (נייד מגובב עם סוד שרת)
  pk := encode(hmac(phone, p_pepper, 'sha256'), 'hex');
  if not app.rl_hit('book:ip:' || b.id || ':' || p_ip_hash, 10, 3600)
     or not app.rl_hit('book:ipall:' || p_ip_hash, 30, 3600)
     or not app.rl_hit('book:biz:' || b.id, 200, 3600)
     or not app.rl_hit('book:phone:' || b.id || ':' || pk, 4, 3600) then
    return app.limited();
  end if;

  return app.create_appointment(b.id, stf, svc, d, startm, first, last, phone, 'online');
end $$;

-- ---------- ניהול תור באמצעות קישור אישי ----------
create function app.token_find(p_token text, p_ip text) returns appointments
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare a appointments;
begin
  if p_token ~ '^[A-Za-z0-9_-]{43}$' then
    select * into a from appointments where token_hash = app.hash_token(p_token) and token_expires_at > app.now_utc();
  end if;
  if a.id is null then perform app.rl_hit('tokfail:' || p_ip, 2147483647, 600); end if;   -- ניחוש כושל נספר
  return a;
end $$;

create function app.token_limited(p_ip text) returns boolean language sql stable security definer set search_path = public, pg_temp as
$$ select app.rl_count('tokfail:' || p_ip, 600) >= 10 $$;

create function app.can_modify(a appointments, b businesses) returns boolean language sql stable as
$$ select a.status = 'confirmed' and a.token_uses < 5
          and floor(extract(epoch from (app.local_ts(a.date, a.start_min, b.timezone) - app.now_utc())) / 60) >= b.cancel_cutoff_hours * 60 $$;

create function public.rpc_public_token_get(p_token text, p_ip_hash text) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare a appointments; b businesses; sname text; cphone text; tlabels jsonb; ttheme text;
begin
  if app.token_limited(p_ip_hash) then return app.limited(); end if;
  a := app.token_find(p_token, p_ip_hash);
  if a.id is null then return app.err(404, 'invalid_link', 'הקישור אינו תקף או שפג תוקפו'); end if;
  select * into b from businesses where id = a.business_id;
  select labels, theme into tlabels, ttheme from templates where key = b.template;
  select name into sname from staff where id = a.staff_id;
  select phone into cphone from customers where id = a.customer_id;
  return app.ok(jsonb_build_object(
    'appointment', jsonb_build_object('status', a.status, 'date', a.date, 'start_min', a.start_min, 'end_min', a.end_min,
        'barber_id', a.staff_id, 'barber_name', sname, 'service_name', a.service_name, 'price_ils', a.price_ils,
        'first_name', a.first_name, 'phone_masked', '•••••' || right(cphone, 4)),
    'shop', jsonb_build_object('name', b.name, 'phone', b.phone, 'address', b.address, 'slug', b.slug, 'labels', tlabels, 'theme', ttheme),
    'can_modify', app.can_modify(a, b), 'cutoff_hours', b.cancel_cutoff_hours, 'uses_left', greatest(0, 5 - a.token_uses)));
end $$;

create function public.rpc_public_token_staff(p_token text, p_ip_hash text) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare a appointments;
begin
  if app.token_limited(p_ip_hash) then return app.limited(); end if;
  a := app.token_find(p_token, p_ip_hash);
  if a.id is null then return app.err(404, 'invalid_link', 'הקישור אינו תקף או שפג תוקפו'); end if;
  return app.ok(jsonb_build_object('barbers', app.public_staff(a.business_id)));
end $$;

create function public.rpc_public_token_slots(p_token text, p_ip_hash text, p_staff bigint, p_date date) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare a appointments; b businesses; st staff;
begin
  if app.token_limited(p_ip_hash) then return app.limited(); end if;
  a := app.token_find(p_token, p_ip_hash);
  if a.id is null then return app.err(404, 'invalid_link', 'הקישור אינו תקף או שפג תוקפו'); end if;
  select * into st from staff where id = p_staff and business_id = a.business_id and active;
  if st.id is null then return app.err(404, 'not_found', 'איש הצוות לא נמצא'); end if;
  return app.ok(jsonb_build_object('date', p_date,
      'slots', to_jsonb(app.slots_for(a.business_id, st.id, p_date, a.end_min - a.start_min, a.id))));
end $$;

create function public.rpc_public_token_days(p_token text, p_ip_hash text, p_staff bigint) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare a appointments; b businesses; days jsonb := '[]'; d date;
begin
  if app.token_limited(p_ip_hash) then return app.limited(); end if;
  a := app.token_find(p_token, p_ip_hash);
  if a.id is null then return app.err(404, 'invalid_link', 'הקישור אינו תקף או שפג תוקפו'); end if;
  select * into b from businesses where id = a.business_id;
  for i in 0..b.max_days_ahead loop
    d := app.local_date(b.timezone) + i;
    days := days || jsonb_build_object('date', d, 'available',
        cardinality(app.slots_for(a.business_id, p_staff, d, a.end_min - a.start_min, a.id)) > 0);
  end loop;
  return app.ok(jsonb_build_object('days', days));
end $$;

create function app.assert_modifiable(a appointments, b businesses) returns jsonb language plpgsql stable as $$
begin
  if a.status <> 'confirmed' then return app.err(409, 'not_active', 'התור כבר אינו פעיל'); end if;
  if a.token_uses >= 5 then return app.err(429, 'token_limit', 'הגעתם למספר השינויים המרבי לקישור זה. ניתן ליצור קשר עם העסק.'); end if;
  if not app.can_modify(a, b) then
    return app.err(409, 'too_late', format('לא ניתן לשנות או לבטל תור פחות מ-%s שעות לפני מועדו. נא ליצור קשר עם העסק%s.',
        b.cancel_cutoff_hours, coalesce(' (' || b.phone || ')', '')));
  end if;
  return null;
end $$;

create function public.rpc_public_token_cancel(p_token text, p_ip_hash text) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare a appointments; b businesses; e jsonb;
begin
  if app.token_limited(p_ip_hash) then return app.limited(); end if;
  a := app.token_find(p_token, p_ip_hash);
  if a.id is null then return app.err(404, 'invalid_link', 'הקישור אינו תקף או שפג תוקפו'); end if;
  select * into a from appointments where id = a.id for update;     -- קריאה חוזרת תחת נעילה
  select * into b from businesses where id = a.business_id;
  e := app.assert_modifiable(a, b);
  if e is not null then return e; end if;
  update appointments set status = 'cancelled', cancelled_at = now(), token_uses = token_uses + 1 where id = a.id;
  return app.ok('{}');
end $$;

create function public.rpc_public_token_reschedule(p_token text, p_ip_hash text, p jsonb) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare a appointments; b businesses; e jsonb; st staff; stf bigint; startm int; d date; endm int; dur int;
begin
  if app.token_limited(p_ip_hash) then return app.limited(); end if;
  a := app.token_find(p_token, p_ip_hash);
  if a.id is null then return app.err(404, 'invalid_link', 'הקישור אינו תקף או שפג תוקפו'); end if;
  stf := app.jint(p, 'barber_id', 1, 1000000000); startm := app.jint(p, 'start_min', 0, 1439); d := app.jdate(p, 'date');
  if stf is null or startm is null or d is null then return app.err(400, 'invalid_request', 'פרטי התור החדשים אינם תקינים'); end if;

  perform pg_advisory_xact_lock(hashtextextended('appt:' || stf::text, 0));       -- יעד
  select * into a from appointments where id = a.id for update;
  select * into b from businesses where id = a.business_id;
  e := app.assert_modifiable(a, b);
  if e is not null then return e; end if;
  select * into st from staff where id = stf and business_id = a.business_id and active;
  if st.id is null then return app.err(400, 'barber_unavailable', 'איש הצוות שנבחר אינו זמין'); end if;
  dur := a.end_min - a.start_min; endm := startm + dur;
  if not (startm = any (app.slots_for(a.business_id, stf, d, dur, a.id))) then return app.slot_taken(); end if;
  begin
    update appointments set staff_id = stf, date = d, start_min = startm, end_min = endm, token_uses = token_uses + 1,
        token_expires_at = app.local_ts(d, startm + 120, b.timezone) where id = a.id;
  exception when exclusion_violation then
    return app.slot_taken();
  end;
  return app.ok(jsonb_build_object('barber_name', st.name, 'date', d, 'start_min', startm, 'end_min', endm));
end $$;

-- ---------- פניות (דפי נחיתה וקטלוג שירותים) ----------
create function public.rpc_public_submit_lead(p jsonb, p_ip_hash text, p_pepper text) returns jsonb
language plpgsql volatile security definer set search_path = public, extensions, pg_temp as $$
declare b businesses; nm text; ph text; msg text; fields jsonb := '{}'; svc bigint;
begin
  nm := app.clean_name(app.jtext(p, 'name'));
  ph := app.normalize_phone(app.jtext(p, 'phone'));
  msg := app.clean_text(app.jtext(p, 'message'), 1, 500);
  if nm is null then fields := fields || '{"name":"נא להזין שם תקין"}'; end if;
  if ph is null then fields := fields || '{"phone":"נא להזין מספר נייד ישראלי תקין (למשל 054-1234567)"}'; end if;
  if app.jtext(p, 'message') is not null and msg is null then fields := fields || '{"message":"הודעה: עד 500 תווים, ללא תווי HTML"}'; end if;
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
  insert into leads (business_id, name, phone, message, service_id, source) values (b.id, nm, ph, msg, svc, 'web');
  return app.ok('{}');
end $$;
