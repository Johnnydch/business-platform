-- =====================================================================
-- 0010 · אבטחה: MFA נאכף ב-JWT במסד, אימות חוזר לפעולות רגישות, יומן ביקורת, הקמת מנהל ראשון, ניהול בעלים
--
-- MFA: Supabase Auth (GoTrue) מנפיק JWT עם הטענה aal ('aal1' אחרי סיסמה, 'aal2' אחרי TOTP) והטענה amr (שיטות וחותמות זמן).
--   • Super Admin: כל הסמכויות (RLS ו-RPC) דורשות aal2. סשן aal1 מקבל 'mfa_required'.
--   • פעולות רוחביות הרסניות/רגישות (מחיקת עסק, שיוך/הסרה/איפוס בעלים) דורשות גם אימות TOTP טרי (15 דקות): 'mfa_stale'.
--   • Owner: MFA אופציונלי; אם רשם גורם אימות מאומת, ה-DB דורש aal2 גם ממנו (מדיניות RLS מתעלמת מסשן aal1).
--   התלות בטבלת auth.mfa_factors היא של Supabase (קריאה מתוך פונקציית SECURITY DEFINER). לא נבדקה מול Supabase אמיתי.
-- יומן ביקורת: append-only, ללא PII (נאכף ב-CHECK על מפתחות), נכתב ע"י טריגרים (כל נתיב קוד) וקריאות מפורשות.
-- =====================================================================

-- ---------- MFA ----------
create function app.aal2() returns boolean language sql stable as
$$ select coalesce(auth.jwt() ->> 'aal', '') = 'aal2' $$;

create function app.has_verified_mfa() returns boolean language sql stable security definer set search_path = public, pg_temp as
$$ select exists (select 1 from auth.mfa_factors where user_id = auth.uid() and status = 'verified') $$;

-- Super Admin: פעיל + aal2. (משמש את מדיניות ה-RLS: סשן aal1 של Super Admin לא רואה כלום.)
create or replace function app.is_super() returns boolean language sql stable security definer set search_path = public, pg_temp as
$$ select app.aal2() and exists (select 1 from platform_users where user_id = auth.uid() and role = 'super_admin' and active) $$;

-- Owner: העסק שלו; אם רשם MFA – נדרש aal2
create or replace function app.my_business() returns uuid language sql stable security definer set search_path = public, pg_temp as
$$ select pu.business_id from platform_users pu join businesses b on b.id = pu.business_id
   where pu.user_id = auth.uid() and pu.role = 'owner' and pu.active and b.active
     and (app.aal2() or not app.has_verified_mfa()) $$;

-- שגיאה מובחנת ('mfa_required') במקום 'forbidden' כשהמשתמש מוסמך אך הסשן אינו aal2
create function app.mfa_gate() returns void language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not app.aal2() and exists (select 1 from platform_users pu where pu.user_id = auth.uid() and pu.active
        and (pu.role = 'super_admin' or app.has_verified_mfa())) then
    raise exception 'mfa_required' using errcode = '42501';
  end if;
end $$;

create or replace function app.resolve_business(p_business uuid) returns uuid
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare b uuid;
begin
  if app.is_super() then
    if p_business is null or not exists (select 1 from businesses where id = p_business) then
      raise exception 'business_required' using errcode = '22023';
    end if;
    return p_business;
  end if;
  b := app.my_business();
  if b is null then
    perform app.mfa_gate();
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return b;
end $$;

create or replace function app.require_super() returns void language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if app.is_super() then return; end if;
  perform app.mfa_gate();
  raise exception 'forbidden' using errcode = '42501';
end $$;

-- אימות TOTP טרי (חותמת הזמן ב-amr של ה-JWT): לפעולות רגישות. הלקוח מבצע אימות מחדש ומקבל JWT חדש.
create function app.require_fresh_mfa(p_minutes int default 15) returns void language plpgsql stable as $$
begin
  perform app.require_super();
  if not exists (select 1 from jsonb_array_elements(case when jsonb_typeof(auth.jwt() -> 'amr') = 'array' then auth.jwt() -> 'amr' else '[]'::jsonb end) a
                 where a ->> 'method' = 'totp' and (a ->> 'timestamp')::numeric >= extract(epoch from app.now_utc()) - p_minutes * 60) then
    raise exception 'mfa_stale' using errcode = '42501';
  end if;
end $$;

-- ---------- rpc_me: כולל מצב MFA ----------
create or replace function public.rpc_me() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare pu platform_users; b businesses; t templates; enrolled boolean := app.has_verified_mfa(); needs boolean;
begin
  select * into pu from platform_users where user_id = auth.uid() and active;
  if pu.user_id is null then raise exception 'forbidden' using errcode = '42501'; end if;
  needs := not app.aal2() and (pu.role = 'super_admin' or enrolled);
  if pu.role = 'owner' and not needs then
    select * into b from businesses where id = pu.business_id;
    if not b.active then raise exception 'shop_disabled' using errcode = '42501'; end if;
    select * into t from templates where key = b.template;
  end if;
  return app.ok(jsonb_build_object(
    'user', jsonb_build_object('id', pu.user_id, 'email', auth.jwt() ->> 'email', 'role', case pu.role when 'owner' then 'shop_owner' else pu.role end,
                               'shop_id', case when needs then null else pu.business_id end),
    'mfa', jsonb_build_object('aal', coalesce(auth.jwt() ->> 'aal', 'aal1'), 'enrolled', enrolled, 'needs_verification', needs,
                              'required', pu.role = 'super_admin'),
    'shop', case when b.id is null then null else jsonb_build_object('id', b.id, 'name', b.name, 'slug', b.slug, 'template', b.template,
              'kind', t.kind, 'theme', t.theme, 'labels', t.labels) end));
end $$;

-- ---------- יומן ביקורת ----------
create table public.audit_log (
  id            bigint generated always as identity primary key,
  at            timestamptz not null default now(),
  actor_user_id uuid,
  actor_role    text not null,
  business_id   uuid,                         -- ללא FK: הרשומות שורדות מחיקת עסק
  action        text not null check (action ~ '^[a-z_]+\.[a-z_]+$'),
  target_type   text,
  target_id     text,
  details       jsonb not null default '{}',
  -- אין PII ביומן: לא שמות, טלפונים, אימיילים, הערות, אסימונים. נאכף במבנה, לא רק בקוד.
  constraint audit_details_shape check (
    jsonb_typeof(details) = 'object' and pg_column_size(details) < 2048
    and not (details ?| array['phone','email','first_name','last_name','name','password','token','token_hash','notes','message','note','address','ip']))
);
create index audit_log_biz_idx on public.audit_log (business_id, id desc);
create index audit_log_at_idx  on public.audit_log (at);
alter table public.audit_log enable row level security;
create policy audit_read on public.audit_log for select to authenticated
  using ((select app.is_super()) or business_id = (select app.my_business()));
revoke all on public.audit_log from public, anon, authenticated, service_role;
grant select on public.audit_log to authenticated;

create function app.audit_immutable() returns trigger language plpgsql as $$
begin
  if TG_OP = 'DELETE' and current_setting('app.audit_purge', true) = 'on' then return OLD; end if;
  raise exception 'audit_log is append-only' using errcode = '42501';
end $$;
create trigger audit_log_immutable before update or delete on public.audit_log for each row execute function app.audit_immutable();
create trigger audit_log_no_truncate before truncate on public.audit_log for each statement execute function app.audit_immutable();

create function app.actor_role() returns text language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(nullif(current_setting('app.actor', true), ''),
    (select case pu.role when 'owner' then 'owner' else 'super_admin' end from platform_users pu where pu.user_id = auth.uid() and pu.active),
    case when coalesce(auth.jwt() ->> 'role', '') = 'service_role' then 'public_api' else 'unknown' end) $$;

create function app.audit(p_action text, p_biz uuid, p_type text, p_target text, p_details jsonb default '{}', p_actor uuid default null)
returns void language sql volatile security definer set search_path = public, pg_temp as $$
  insert into audit_log (actor_user_id, actor_role, business_id, action, target_type, target_id, details)
  values (coalesce(p_actor, auth.uid()),
          case when p_actor is not null then coalesce((select case pu.role when 'owner' then 'owner' else 'super_admin' end from platform_users pu where pu.user_id = p_actor), 'unknown')
               else app.actor_role() end,
          p_biz, p_action, p_type, p_target, coalesce(p_details, '{}')) $$;
grant execute on function app.audit(text,uuid,text,text,jsonb,uuid) to authenticated;   -- נקראת מתוך RPC מסוג INVOKER; סכמת app אינה חשופה ל-PostgREST

-- ---------- טריגרים: כל שינוי בטבלאות המרכזיות מתועד, בלי ערכים אישיים ----------
create function app.trg_audit() returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare r jsonb := to_jsonb(coalesce(NEW, OLD)); o jsonb := case when TG_OP = 'UPDATE' then to_jsonb(OLD) end;
        act text; d jsonb := '{}'; ch text[]; biz uuid := nullif(r ->> 'business_id', '')::uuid; tid text := r ->> 'id';
begin
  -- מחיקה בשרשרת (מחיקת עסק): כבר תועדה ברמת העסק. הסימן: העסק האב כבר לא קיים.
  if TG_OP = 'DELETE' and TG_TABLE_NAME <> 'businesses' and biz is not null and not exists (select 1 from businesses where id = biz) then return OLD; end if;
  act := TG_ARGV[0] || '.' || case TG_OP when 'INSERT' then 'create' when 'UPDATE' then 'update' else 'delete' end;
  if TG_OP = 'UPDATE' then
    select array_agg(k order by k) into ch from jsonb_object_keys(r) k where r -> k is distinct from o -> k;
    if ch is null then return NEW; end if;
    d := jsonb_build_object('changed', to_jsonb(ch));
  end if;

  if TG_TABLE_NAME = 'businesses' then
    biz := (r ->> 'id')::uuid;
    if TG_OP = 'INSERT' then d := jsonb_build_object('slug', r ->> 'slug', 'template', r ->> 'template');
    elsif TG_OP = 'DELETE' then d := jsonb_build_object('slug', r ->> 'slug');
    elsif r -> 'active' is distinct from o -> 'active' then act := case when (r ->> 'active')::boolean then 'business.activate' else 'business.deactivate' end; end if;
  elsif TG_TABLE_NAME = 'platform_users' then
    tid := r ->> 'user_id';
    act := case TG_OP when 'INSERT' then 'user.role_grant' when 'UPDATE' then 'user.role_update' else 'user.role_revoke' end;
    d := d || jsonb_build_object('role', r ->> 'role');
  elsif TG_TABLE_NAME = 'appointments' then
    if TG_OP = 'INSERT' then
      d := jsonb_build_object('source', r ->> 'source', 'staff_id', r -> 'staff_id', 'date', r ->> 'date', 'start_min', r -> 'start_min');
    elsif TG_OP = 'UPDATE' then
      if r ->> 'status' is distinct from o ->> 'status' then act := 'appointment.status'; d := jsonb_build_object('from', o ->> 'status', 'to', r ->> 'status');
      elsif ch && array['staff_id','date','start_min','end_min'] then
        act := 'appointment.move'; d := jsonb_build_object('from_date', o ->> 'date', 'from_start', o -> 'start_min', 'to_date', r ->> 'date', 'to_start', r -> 'start_min');
      else return NEW; end if;                                                      -- שינוי טכני בלבד (מונה שימושים וכו')
    else return OLD; end if;
  elsif TG_TABLE_NAME = 'leads' then
    if TG_OP = 'INSERT' then d := jsonb_build_object('source', r ->> 'source');
    elsif TG_OP = 'UPDATE' then
      if r ->> 'status' is distinct from o ->> 'status' then act := 'lead.status'; d := jsonb_build_object('from', o ->> 'status', 'to', r ->> 'status'); else return NEW; end if;
    else return OLD; end if;
  elsif TG_TABLE_NAME = 'blocks' then
    d := jsonb_build_object('date', r ->> 'date', 'staff_id', r -> 'staff_id', 'start_min', r -> 'start_min', 'end_min', r -> 'end_min');
  end if;
  perform app.audit(act, biz, TG_ARGV[0], tid, d);
  return coalesce(NEW, OLD);
end $$;

create trigger audit_businesses    after insert or update or delete on public.businesses     for each row execute function app.trg_audit('business');
create trigger audit_platform_users after insert or update or delete on public.platform_users for each row execute function app.trg_audit('user');
create trigger audit_staff         after insert or update or delete on public.staff          for each row execute function app.trg_audit('staff');
create trigger audit_services      after insert or update or delete on public.services       for each row execute function app.trg_audit('service');
create trigger audit_blocks        after insert or delete          on public.blocks          for each row execute function app.trg_audit('block');
create trigger audit_appointments  after insert or update or delete on public.appointments   for each row execute function app.trg_audit('appointment');
create trigger audit_leads         after insert or update or delete on public.leads          for each row execute function app.trg_audit('lead');

-- שינוי שעות עבודה: אירוע אחד (לא שורה לכל יום)
create or replace function app.write_hours(p_biz uuid, p_staff bigint, p_hours jsonb) returns void language plpgsql volatile as $$
begin
  delete from working_hours where staff_id = p_staff and business_id = p_biz;
  insert into working_hours (staff_id, business_id, weekday, start_min, end_min)
    select p_staff, p_biz, (h ->> 'weekday')::int, (h ->> 'start_min')::int, (h ->> 'end_min')::int from jsonb_array_elements(p_hours) h;
  perform app.audit('staff.hours_change', p_biz, 'staff', p_staff::text, jsonb_build_object('days', jsonb_array_length(p_hours)));
end $$;

-- ---------- קריאת היומן ----------
create function public.rpc_audit_list(p_business uuid, p jsonb default '{}') returns jsonb
language plpgsql stable set search_path = public, pg_temp as $$
declare biz uuid; lim int := coalesce(app.jint(p, 'limit', 1, 200), 50); bef bigint := app.jint(p, 'before_id', 1, 9000000000000000000);
begin
  if app.is_super() then biz := p_business; else biz := app.resolve_business(p_business); end if;     -- Super: ללא עסק = כל הפלטפורמה
  return app.ok(jsonb_build_object('entries', coalesce((
    select jsonb_agg(jsonb_build_object('id', x.id, 'at', x.at, 'actor_role', x.actor_role, 'actor_id', x.actor_user_id, 'business_id', x.business_id,
                     'action', x.action, 'target_type', x.target_type, 'target_id', x.target_id, 'details', x.details) order by x.id desc)
    from (select * from audit_log a where (biz is null or a.business_id = biz) and (bef is null or a.id < bef) order by a.id desc limit lim) x), '[]')));
end $$;

-- אירועי התחברות/MFA מתועדים ע"י השרת (service_role); הפעולה והפרטים ברשימה סגורה
create function public.rpc_audit_event(p_action text, p_user uuid, p_details jsonb default '{}') returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare biz uuid;
begin
  if p_action not in ('auth.login','auth.login_failed','auth.logout','auth.mfa_enrolled','auth.mfa_verified','auth.mfa_failed','auth.password_changed') then
    return app.err(400, 'invalid_request', 'אירוע לא מוכר');
  end if;
  select business_id into biz from platform_users where user_id = p_user;
  perform app.audit(p_action, biz, 'user', p_user::text, coalesce(p_details, '{}') - 'email', p_user);
  return app.ok('{}');
end $$;

-- תחזוקה (service_role): מחיקת מוני קצב שפגו ורשומות ביקורת ישנות (שמירה 400 יום)
create function public.rpc_maintenance_cleanup() returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare rl int; au int;
begin
  delete from rate_limits where expires_at < now() - interval '1 hour'; get diagnostics rl = row_count;
  perform set_config('app.audit_purge', 'on', true);
  delete from audit_log where at < now() - interval '400 days'; get diagnostics au = row_count;
  return app.ok(jsonb_build_object('rate_limits_deleted', rl, 'audit_deleted', au));
end $$;

-- ---------- הקמת מנהל ראשון ----------
-- service_role בלבד. מצליח רק כשאין עדיין Super Admin (נעילה מונעת מרוץ). ה-MFA נרשם בכניסה הראשונה.
create function public.rpc_bootstrap_super_admin(p_user uuid) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
begin
  perform set_config('app.actor', 'system', true);
  perform pg_advisory_xact_lock(hashtextextended('bootstrap-super', 0));
  if exists (select 1 from platform_users where role = 'super_admin') then
    return app.err(409, 'already_bootstrapped', 'כבר קיים מנהל פלטפורמה');
  end if;
  if p_user is null or not exists (select 1 from auth.users where id = p_user) then return app.err(400, 'validation', 'המשתמש לא נמצא'); end if;
  if exists (select 1 from platform_users where user_id = p_user) then return app.err(400, 'validation', 'המשתמש כבר משויך'); end if;
  insert into platform_users (user_id, role) values (p_user, 'super_admin');
  return app.ok('{}');
end $$;

-- ---------- ניהול בעלי עסק (Super Admin; פעולות רגישות דורשות MFA טרי) ----------
create function public.rpc_super_list_owners(p_business uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform app.require_super();
  return app.ok(jsonb_build_object('owners', coalesce((
    select jsonb_agg(jsonb_build_object('user_id', pu.user_id, 'email', u.email, 'active', pu.active,
        'mfa', exists (select 1 from auth.mfa_factors f where f.user_id = pu.user_id and f.status = 'verified')) order by pu.created_at)
    from platform_users pu join auth.users u on u.id = pu.user_id where pu.business_id = p_business and pu.role = 'owner'), '[]')));
end $$;

create or replace function public.rpc_super_attach_owner(p_business uuid, p jsonb) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare uid uuid;
begin
  perform app.require_fresh_mfa();
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

create function public.rpc_super_remove_owner(p_business uuid, p jsonb) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare uid uuid; n int;
begin
  perform app.require_fresh_mfa();
  begin uid := (app.jtext(p, 'owner_user_id'))::uuid; exception when others then uid := null; end;
  delete from platform_users where user_id = uid and business_id = p_business and role = 'owner';
  get diagnostics n = row_count;
  if n = 0 then return app.err(404, 'not_found', 'הבעלים לא נמצא'); end if;
  return app.ok(jsonb_build_object('user_id', uid));      -- השרת מוחק את חשבון ה-Auth
end $$;

-- איפוס סיסמת בעלים: אימות טרי + תיעוד, ואז מחזיר את מזהי המשתמשים לשרת (שמבצע את האיפוס ב-Auth)
create function public.rpc_super_prepare_owner_reset(p_business uuid, p jsonb default '{}') returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare ids jsonb;
begin
  perform app.require_fresh_mfa();
  select coalesce(jsonb_agg(user_id), '[]') into ids from platform_users where business_id = p_business and role = 'owner';
  if jsonb_array_length(ids) = 0 then return app.err(404, 'not_found', 'לא נמצא בעל עסק'); end if;
  perform app.audit('owner.password_reset', p_business, 'business', p_business::text, jsonb_build_object('owners', jsonb_array_length(ids)));
  return app.ok(jsonb_build_object('user_ids', ids));
end $$;

create or replace function public.rpc_super_delete_business(p_business uuid, p jsonb) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare b businesses; owners jsonb;
begin
  perform app.require_fresh_mfa();
  select * into b from businesses where id = p_business;
  if b.id is null then return app.err(404, 'not_found', 'העסק לא נמצא'); end if;
  if app.jtext(p, 'confirm_slug') is distinct from b.slug then return app.err(400, 'confirm_required', 'יש לאשר באמצעות ה-slug של העסק'); end if;
  select coalesce(jsonb_agg(user_id), '[]') into owners from platform_users where business_id = b.id;
  delete from businesses where id = b.id;     -- מוחק בשרשרת את כל נתוני העסק
  return app.ok(jsonb_build_object('owner_user_ids', owners));   -- השרת מוחק אותם מ-Auth
end $$;

-- ---------- הרשאות ----------
-- פונקציות חדשות מקבלות EXECUTE ל-PUBLIC כברירת מחדל (וב-Supabase גם ל-anon/authenticated/service_role): מבטלים ומעניקים במפורש.
revoke all on function public.rpc_audit_list(uuid,jsonb), public.rpc_super_list_owners(uuid), public.rpc_super_remove_owner(uuid,jsonb),
  public.rpc_super_prepare_owner_reset(uuid,jsonb), public.rpc_audit_event(text,uuid,jsonb), public.rpc_maintenance_cleanup(),
  public.rpc_bootstrap_super_admin(uuid) from public, anon, authenticated, service_role;
revoke all on function app.aal2(), app.has_verified_mfa(), app.mfa_gate(), app.actor_role(), app.require_fresh_mfa(int),
  app.audit(text,uuid,text,text,jsonb,uuid), app.trg_audit(), app.audit_immutable(), app.lock_biz_shared(uuid), app.lock_biz_excl(uuid),
  app.lock_staff(bigint), app.lock_phone(uuid,text), app.lock_staff2(bigint,bigint), app.idem_token(text), app.affected_appointments(uuid,bigint)
  from public, anon, authenticated;
grant execute on function app.aal2(), app.has_verified_mfa(), app.mfa_gate(), app.actor_role(), app.require_fresh_mfa(int),
  app.lock_biz_shared(uuid), app.lock_biz_excl(uuid), app.lock_staff(bigint), app.lock_phone(uuid,text), app.lock_staff2(bigint,bigint),
  app.idem_token(text), app.affected_appointments(uuid,bigint), app.audit(text,uuid,text,text,jsonb,uuid) to authenticated;
grant execute on function public.rpc_audit_list(uuid,jsonb), public.rpc_super_list_owners(uuid),
  public.rpc_super_remove_owner(uuid,jsonb), public.rpc_super_prepare_owner_reset(uuid,jsonb) to authenticated;
grant execute on function public.rpc_audit_event(text,uuid,jsonb), public.rpc_maintenance_cleanup(),
  public.rpc_bootstrap_super_admin(uuid) to service_role;
-- rpc_me / rpc_super_attach_owner / rpc_super_delete_business הוחלפו ב-CREATE OR REPLACE ושומרות על ההרשאות הקודמות
notify pgrst, 'reload schema';
