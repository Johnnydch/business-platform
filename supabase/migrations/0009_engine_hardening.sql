-- =====================================================================
-- 0009 · הקשחת מנוע ההזמנות
--   1. נעילות מתואמות (סדר קבוע: idem → נייד → עסק(shared) → איש צוות), משותפות להזמנה, שינוי מועד,
--      שינוי שעות, חסימות והחזרת תור מבוטל. חסימה כלל-עסקית לוקחת נעילת עסק בלעדית.
--   2. מכסת תורים לנייד נאכפת תחת נעילה לפי עסק+נייד (לא רק לפי איש צוות).
--   3. זמינות לפי זמן מוחלט (UTC) – כולל התראה מינימלית אחרי חצות ושעון קיץ (שעות שאינן קיימות מסוננות).
--   4. מדיניות שינוי זמינות: תורים קיימים לעולם לא משתנים אוטומטית; הבעלים מקבל רשימה מדויקת של התורים המושפעים.
--   5. החזרת מבוטל→מאושר נבדקת גם מול חסימות (מול תורים – אילוץ המסד).
--   6. הגנה מפני יצירה כפולה: מפתח אידמפוטנטיות מהלקוח; נשמר hash בלבד; הקישור האישי נגזר ממנו,
--      כך שניסיון חוזר מחזיר את אותו קישור בלי לשמור טוקן גולמי במסד.
-- =====================================================================

-- ---------- 1. נעילות ----------
create function app.lock_biz_shared(p_biz uuid) returns void language sql volatile as
$$ select pg_advisory_xact_lock_shared(hashtextextended('biz:' || p_biz::text, 0)) $$;
create function app.lock_biz_excl(p_biz uuid) returns void language sql volatile as
$$ select pg_advisory_xact_lock(hashtextextended('biz:' || p_biz::text, 0)) $$;
create function app.lock_staff(p_staff bigint) returns void language sql volatile as
$$ select pg_advisory_xact_lock(hashtextextended('appt:' || p_staff::text, 0)) $$;
create function app.lock_phone(p_biz uuid, p_phone text) returns void language sql volatile as
$$ select pg_advisory_xact_lock(hashtextextended('phone:' || p_biz::text || ':' || p_phone, 0)) $$;
-- שני אנשי צוות: תמיד בסדר עולה, למניעת קיפאון (deadlock)
create function app.lock_staff2(p_a bigint, p_b bigint) returns void language plpgsql volatile as $$
begin
  perform app.lock_staff(least(p_a, p_b));
  if p_a <> p_b then perform app.lock_staff(greatest(p_a, p_b)); end if;
end $$;
grant execute on function app.lock_biz_shared(uuid), app.lock_biz_excl(uuid), app.lock_staff(bigint),
  app.lock_phone(uuid,text), app.lock_staff2(bigint,bigint) to authenticated;

-- ---------- אידמפוטנטיות ----------
alter table public.appointments add column idem_key_hash text check (idem_key_hash is null or idem_key_hash ~ '^[0-9a-f]{64}$');
alter table public.appointments add column idem_fp       text check (idem_fp is null or idem_fp ~ '^[0-9a-f]{64}$');
create unique index appointments_idem_uq on public.appointments (business_id, idem_key_hash) where idem_key_hash is not null;
-- הערה: הדפדפן לא נהנה מהעמודות האלה (grant update מוגבל לעמודות אחרות; select לפי RLS של העסק).
create function app.idem_token(p_key text) returns text language sql immutable as
$$ select translate(encode(extensions.digest('tok:' || p_key, 'sha256'), 'base64'), E'+/=\n', '-_') $$;   -- 43 תווים כמו app.new_token()

-- ---------- 3. זמינות במדויק לפי זמן מוחלט ----------
create or replace function app.slots_for(p_biz uuid, p_staff bigint, p_date date, p_dur int,
                                         p_exclude bigint default 0, p_ignore_limits boolean default false)
returns int[] language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare b businesses%rowtype; today date; wh working_hours%rowtype; earliest timestamptz; res int[];
begin
  select * into b from businesses where id = p_biz;
  if not found then return '{}'; end if;
  today := app.local_date(b.timezone);
  if p_date < today then return '{}'; end if;
  if not p_ignore_limits and (p_date - today) > b.max_days_ahead then return '{}'; end if;
  select * into wh from working_hours where staff_id = p_staff and business_id = p_biz and weekday = extract(dow from p_date)::int;
  if not found then return '{}'; end if;
  -- התראה מינימלית: זמן התחלה מוחלט מול עכשיו (לא "דקות ביום"), ולכן נכון גם אחרי חצות ובימי מעבר שעון
  earliest := case when p_ignore_limits then null else app.now_utc() + make_interval(mins => b.min_notice_min) end;
  select coalesce(array_agg(g order by g), '{}') into res
  from generate_series(wh.start_min, wh.end_min - p_dur, b.slot_step) g
  where (earliest is null or app.local_ts(p_date, g, b.timezone) >= earliest)
    -- שעה מקומית שלא קיימת (קפיצת שעון קדימה) – מסוננת: ההמרה חזרה לא מחזירה את אותה שעה
    and (app.local_ts(p_date, g, b.timezone) at time zone b.timezone) = p_date::timestamp + make_interval(mins => g)
    and not exists (select 1 from appointments a
                    where a.staff_id = p_staff and a.date = p_date and a.status <> 'cancelled'
                      and a.id <> p_exclude and a.start_min < g + p_dur and a.end_min > g)
    and not exists (select 1 from blocks k
                    where k.business_id = p_biz and k.date = p_date and (k.staff_id = p_staff or k.staff_id is null)
                      and k.start_min < g + p_dur and k.end_min > g);
  return res;
end $$;

-- ---------- 2+6. יצירת תור ----------
drop function app.create_appointment(uuid,bigint,bigint,date,int,text,text,text,text,text);
create function app.create_appointment(p_biz uuid, p_staff bigint, p_service bigint, p_date date, p_start int,
                                       p_first text, p_last text, p_phone text, p_source text,
                                       p_notes text default null, p_idem text default null)
returns jsonb language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare b businesses%rowtype; st staff%rowtype; sv services%rowtype; cu bigint; tok text; endm int;
        up int; newid bigint; kh text; fp text; ex appointments%rowtype;
begin
  -- סדר נעילות קבוע: idem → נייד → עסק (shared) → איש צוות
  if p_idem is not null then
    kh := app.hash_token(p_idem);
    perform pg_advisory_xact_lock(hashtextextended('idem:' || p_biz::text || ':' || kh, 0));
  end if;
  if p_source = 'online' then perform app.lock_phone(p_biz, p_phone); end if;
  perform app.lock_biz_shared(p_biz);
  perform app.lock_staff(p_staff);

  select * into b from businesses where id = p_biz and active;
  if not found then return app.err(404, 'shop_not_found', 'העסק לא נמצא'); end if;

  -- ניסיון חוזר של אותה בקשה (למשל אחרי תקלת רשת): מחזירים את אותו תור ואת אותו קישור, בלי ליצור כפילות
  if kh is not null then
    fp := app.hash_token(concat_ws('|', p_staff, p_service, p_date, p_start, p_phone));
    select * into ex from appointments where business_id = p_biz and idem_key_hash = kh;
    if found then
      if ex.idem_fp is distinct from fp then
        return app.err(409, 'idempotency_conflict', 'מפתח הבקשה כבר שימש לבקשה אחרת. נא לרענן את הדף ולנסות שוב.');
      end if;
      if ex.status = 'cancelled' then
        return app.err(409, 'already_processed', 'הבקשה כבר טופלה והתור בוטל. נא להזמין תור חדש.');
      end if;
      return app.ok(jsonb_build_object('id', ex.id, 'token', app.idem_token(p_idem), 'replayed', true, 'shop_name', b.name,
          'barber_name', (select name from staff where id = ex.staff_id), 'service_name', ex.service_name,
          'first_name', ex.first_name, 'price_ils', ex.price_ils, 'date', ex.date, 'start_min', ex.start_min,
          'end_min', ex.end_min, 'duration_min', ex.end_min - ex.start_min));
    end if;
  end if;

  select * into st from staff where id = p_staff and business_id = p_biz and active;
  if not found then return app.err(400, 'barber_unavailable', 'איש הצוות שנבחר אינו זמין'); end if;
  select * into sv from services where id = p_service and business_id = p_biz and active;
  if not found then return app.err(400, 'service_unavailable', 'השירות שנבחר אינו זמין'); end if;

  if not (p_start = any (app.slots_for(p_biz, p_staff, p_date, sv.duration_min, 0, p_source = 'owner'))) then
    return app.slot_taken();
  end if;

  if p_source = 'online' then
    select count(*) into up from appointments a join customers c on c.id = a.customer_id
     where a.business_id = p_biz and c.phone = p_phone and a.status = 'confirmed'
       and app.local_ts(a.date, a.start_min, b.timezone) >= app.now_utc();
    if up >= 3 then
      return app.err(429, 'too_many_active', 'למספר הנייד הזה כבר קיימים מספר תורים עתידיים. ניתן לבטל תור קיים או ליצור קשר עם העסק.');
    end if;
  end if;

  insert into customers (business_id, first_name, last_name, phone) values (p_biz, p_first, p_last, p_phone)
    on conflict (business_id, phone) do nothing;
  select id into cu from customers where business_id = p_biz and phone = p_phone;

  endm := p_start + sv.duration_min;
  tok := case when p_source <> 'online' then null when p_idem is not null then app.idem_token(p_idem) else app.new_token() end;
  begin
    insert into appointments (business_id, staff_id, service_id, customer_id, date, start_min, end_min, service_name,
                              price_ils, first_name, last_name, status, source, token_hash, token_expires_at, notes,
                              idem_key_hash, idem_fp)
    values (p_biz, p_staff, p_service, cu, p_date, p_start, endm, sv.name, sv.price_ils, p_first, p_last, 'confirmed', p_source,
            case when tok is not null then app.hash_token(tok) end,
            case when tok is not null then app.local_ts(p_date, p_start + 120, b.timezone) end,   -- תקף עד שעתיים אחרי התור (זמן מוחלט)
            p_notes, kh, fp)
    returning id into newid;
  exception when exclusion_violation or unique_violation then
    return app.slot_taken();
  end;
  return app.ok(jsonb_build_object('id', newid, 'token', tok, 'shop_name', b.name, 'barber_name', st.name,
      'service_name', sv.name, 'first_name', p_first, 'price_ils', sv.price_ils, 'date', p_date, 'start_min', p_start,
      'end_min', endm, 'duration_min', sv.duration_min));
end $$;
revoke execute on function app.create_appointment(uuid,bigint,bigint,date,int,text,text,text,text,text,text) from public, anon, authenticated;

-- ---------- RPC ציבורי להזמנה: דורש מפתח אידמפוטנטיות ----------
create or replace function public.rpc_public_book(p jsonb, p_ip_hash text, p_pepper text) returns jsonb
language plpgsql volatile security definer set search_path = public, extensions, pg_temp as $$
declare first text; last text; phone text; fields jsonb := '{}'; b businesses; svc bigint; stf bigint; startm int; d date;
        pk text; idem text := app.jtext(p, 'idempotency_key');
begin
  first := app.clean_name(app.jtext(p, 'first_name'));
  last  := app.clean_name(app.jtext(p, 'last_name'));
  phone := app.normalize_phone(app.jtext(p, 'phone'));
  if first is null then fields := fields || '{"first_name":"נא להזין שם פרטי תקין"}'; end if;
  if last  is null then fields := fields || '{"last_name":"נא להזין שם משפחה תקין"}'; end if;
  if phone is null then fields := fields || '{"phone":"נא להזין מספר נייד ישראלי תקין (למשל 054-1234567)"}'; end if;
  if fields <> '{}' then return app.err(400, 'validation', 'נא לתקן את השדות המסומנים', fields); end if;
  if idem is null or idem !~ '^[A-Za-z0-9_-]{22,128}$' then
    return app.err(400, 'invalid_request', 'בקשה לא תקינה (חסר מפתח בקשה). נא לרענן את הדף.');
  end if;

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

  return app.create_appointment(b.id, stf, svc, d, startm, first, last, phone, 'online', null, idem);
end $$;

-- ---------- שינוי מועד: נעילת מקור ויעד בסדר קבוע ----------
create or replace function public.rpc_public_token_reschedule(p_token text, p_ip_hash text, p jsonb) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare a appointments; b businesses; e jsonb; st staff; stf bigint; startm int; d date; endm int; dur int;
begin
  if app.token_limited(p_ip_hash) then return app.limited(); end if;
  a := app.token_find(p_token, p_ip_hash);
  if a.id is null then return app.err(404, 'invalid_link', 'הקישור אינו תקף או שפג תוקפו'); end if;
  stf := app.jint(p, 'barber_id', 1, 1000000000); startm := app.jint(p, 'start_min', 0, 1439); d := app.jdate(p, 'date');
  if stf is null or startm is null or d is null then return app.err(400, 'invalid_request', 'פרטי התור החדשים אינם תקינים'); end if;

  perform app.lock_biz_shared(a.business_id);
  perform app.lock_staff2(a.staff_id, stf);                                         -- מקור ויעד
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

-- ---------- 4. מדיניות שינוי זמינות ----------
-- תורים עתידיים פעילים שאינם נכנסים עוד לשעות העבודה של איש הצוות (או שהוא הושבת). לא משנה דבר.
create function app.affected_appointments(p_biz uuid, p_staff bigint) returns jsonb language sql stable as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'date', a.date, 'start_min', a.start_min, 'end_min', a.end_min,
                  'first_name', a.first_name, 'last_name', a.last_name, 'service_name', a.service_name) order by a.date, a.start_min), '[]')
  from appointments a join businesses b on b.id = a.business_id
  where a.business_id = p_biz and a.staff_id = p_staff and a.status = 'confirmed'
    and app.local_ts(a.date, a.end_min, b.timezone) > app.now_utc()
    and (not coalesce((select s.active from staff s where s.id = p_staff), false)
         or not exists (select 1 from working_hours w where w.staff_id = p_staff and w.weekday = extract(dow from a.date)::int
                          and w.start_min <= a.start_min and w.end_min >= a.end_min)) $$;
grant execute on function app.affected_appointments(uuid,bigint) to authenticated;

create or replace function public.rpc_owner_staff_update(p_business uuid, p jsonb) returns jsonb
language plpgsql volatile set search_path = public, pg_temp as $$
declare biz uuid := app.resolve_business(p_business); sid bigint := app.jint(p, 'id', 1, 1000000000); nm text; hrs jsonb; n int;
begin
  nm := app.clean_text(app.jtext(p, 'name'), 2, 40);
  if nm is null then return app.err(400, 'validation', 'שם לא תקין', '{"name":"שם לא תקין"}'); end if;
  if p ? 'hours' then
    hrs := app.parse_hours(p -> 'hours');
    if hrs is null then return app.err(400, 'invalid_request', 'שעות עבודה לא תקינות'); end if;
  end if;
  if sid is null then return app.err(404, 'not_found', 'איש הצוות לא נמצא'); end if;
  perform app.lock_biz_shared(biz);
  perform app.lock_staff(sid);
  update staff set name = nm, active = coalesce((p ->> 'active')::boolean, true) where staff.id = sid and business_id = biz;
  get diagnostics n = row_count;
  if n = 0 then return app.err(404, 'not_found', 'איש הצוות לא נמצא'); end if;
  if hrs is not null then perform app.write_hours(biz, sid, hrs); end if;
  -- תורים קיימים אינם משתנים; מחזירים לבעלים את אלה שדורשים טיפול ידני
  return app.ok(jsonb_build_object('affected_appointments', app.affected_appointments(biz, sid)));
end $$;

create or replace function public.rpc_owner_block_create(p_business uuid, p jsonb) returns jsonb
language plpgsql volatile set search_path = public, pg_temp as $$
declare biz uuid := app.resolve_business(p_business); sid bigint := app.jint(p, 'barber_id', 1, 1000000000);
        st int := app.jint(p, 'start_min', 0, 1439); en int := app.jint(p, 'end_min', 1, 1440); d date := app.jdate(p, 'date');
        nt text := app.clean_text(app.jtext(p, 'note'), 1, 120); bid bigint; cids jsonb;
begin
  if (p ->> 'barber_id') is not null and p ->> 'barber_id' <> '' and (sid is null or not exists (select 1 from staff where staff.id = sid and business_id = biz))
     or st is null or en is null or en <= st or d is null then
    return app.err(400, 'invalid_request', 'פרטי החסימה לא תקינים');
  end if;
  if sid is null then perform app.lock_biz_excl(biz);                                -- חסימה כלל-עסקית: מחכה לכל ההזמנות שרצות
  else perform app.lock_biz_shared(biz); perform app.lock_staff(sid); end if;
  insert into blocks (business_id, staff_id, date, start_min, end_min, note) values (biz, sid, d, st, en, nt) returning blocks.id into bid;
  -- תורים קיימים שנחסמים אינם מבוטלים אוטומטית; מחזירים רשימה לטיפול הבעלים
  select coalesce(jsonb_agg(a.id order by a.start_min), '[]') into cids from appointments a
   where a.business_id = biz and a.date = d and a.status = 'confirmed' and a.start_min < en and a.end_min > st and (sid is null or a.staff_id = sid);
  return jsonb_build_object('ok', true, 'status', 201, 'data', jsonb_build_object('id', bid, 'conflicts', jsonb_array_length(cids), 'conflict_ids', cids));
end $$;

-- ---------- 5. החזרת מבוטל למאושר ----------
create or replace function public.rpc_owner_appointment_status(p_business uuid, p jsonb) returns jsonb
language plpgsql volatile set search_path = public, pg_temp as $$
declare biz uuid := app.resolve_business(p_business); aid bigint := app.jint(p, 'id', 1, 1000000000); st text := app.jtext(p, 'status');
        cur appointments%rowtype;
begin
  if aid is null or st is null or st not in ('confirmed','cancelled','completed','no_show') then return app.err(400, 'invalid_request', 'סטטוס לא תקין'); end if;
  select * into cur from appointments where appointments.id = aid and business_id = biz;
  if not found then return app.err(404, 'not_found', 'התור לא נמצא'); end if;
  if cur.status = 'cancelled' and st <> 'cancelled' then
    -- החזרה לפעילות תופסת שוב את הזמן: אותן נעילות כמו הזמנה, ובדיקה מול חסימות. מול תורים אחרים – אילוץ אי-החפיפה במסד.
    perform app.lock_biz_shared(biz);
    perform app.lock_staff(cur.staff_id);
    if exists (select 1 from blocks k where k.business_id = biz and k.date = cur.date and (k.staff_id = cur.staff_id or k.staff_id is null)
                 and k.start_min < cur.end_min and k.end_min > cur.start_min) then
      return app.slot_taken();
    end if;
  end if;
  begin
    update appointments set status = st, cancelled_at = case when st = 'cancelled' then now() else null end
     where appointments.id = aid and business_id = biz;
  exception when exclusion_violation then
    return app.slot_taken();
  end;
  return app.ok('{}');
end $$;

notify pgrst, 'reload schema';
