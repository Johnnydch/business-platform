-- 0015: הקפאת כתיבה לעסק (בזמן הגירה) ואימות נתונים לפני פתיחה מחדש.
-- הקפאה נאכפת ב-DB ע"י triggers על כל טבלאות הנתונים (הזמנה, ביטול, שינוי, פנייה, עריכת שירותים/צוות/חסימות) – לא תלוי בנתיב שממנו הגיעה הכתיבה.
-- קריאה נשארת פתוחה. מחיקה (מחיקת עסק אחרי העברה) לא נחסמת.
alter table public.businesses add column frozen_at timestamptz;

create function app.trg_frozen_guard() returns trigger language plpgsql as $$
begin
  if exists (select 1 from businesses where id = new.business_id and frozen_at is not null) then
    raise exception 'business_frozen' using errcode = '55000';
  end if;
  return new;
end $$;
do $$ declare t text; begin
  foreach t in array array['appointments', 'blocks', 'customers', 'leads', 'services', 'staff', 'working_hours'] loop
    execute format('create trigger %I before insert or update on public.%I for each row execute function app.trg_frozen_guard()', t || '_frozen_guard', t);
  end loop;
end $$;
revoke all on function app.trg_frozen_guard() from public, anon, authenticated;

create or replace function public.rpc_public_business(p_slug text) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare b businesses; t templates;
begin
  b := app.biz_by_slug(p_slug);
  if b.id is null then return app.err(404, 'shop_not_found', 'העסק לא נמצא'); end if;
  select * into t from templates where key = b.template;
  return app.ok(jsonb_build_object(
    'shop', jsonb_build_object('name', b.name, 'phone', b.phone, 'address', b.address, 'max_days_ahead', b.max_days_ahead,
                               'template', t.key, 'theme', t.theme, 'labels', t.labels, 'brand', b.brand, 'is_demo', b.is_demo, 'frozen', b.frozen_at is not null),
    'services', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name, 'duration_min', s.duration_min, 'price_ils', s.price_ils) order by s.id)
                          from services s where s.business_id = b.id and s.active), '[]'),
    'barbers', app.public_staff(b.id)));
end $$;


CREATE OR REPLACE FUNCTION public.rpc_super_businesses()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  perform app.require_super();
  return app.ok(jsonb_build_object('shops', coalesce((
    select jsonb_agg(jsonb_build_object('id', b.id, 'slug', b.slug, 'name', b.name, 'template', b.template, 'kind', (select t.kind from templates t where t.key = b.template), 'phone', b.phone,
       'address', b.address, 'active', b.active, 'track', b.track, 'frozen', b.frozen_at is not null, 'domains', coalesce((select jsonb_agg(jsonb_build_object('hostname', d.hostname, 'status', d.status) order by d.id) from business_domains d where d.business_id = b.id), '[]'), 'created_at', b.created_at,
       'owner_emails', (select string_agg(u.email, ', ') from platform_users pu join auth.users u on u.id = pu.user_id where pu.business_id = b.id),
       'barbers',   (select count(*) from staff s where s.business_id = b.id and s.active),
       'services',  (select count(*) from services v where v.business_id = b.id and v.active),
       'customers', (select count(*) from customers c where c.business_id = b.id),
       'upcoming',  (select count(*) from appointments a where a.business_id = b.id and a.status = 'confirmed' and a.date >= app.local_date(b.timezone)))
       order by b.created_at desc) from businesses b), '[]')));
end $function$;

-- הקפאה/שחרור: Super Admin עם אימות טרי (UI), ו-service_role (סקריפט הגירה)
create function public.rpc_super_set_freeze(p_business uuid, p jsonb) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare fr boolean := (p ->> 'frozen') = 'true';
begin
  perform app.require_fresh_mfa(15);
  update businesses set frozen_at = case when fr then coalesce(frozen_at, now()) else null end where id = p_business;
  if not found then return app.err(404, 'not_found', 'העסק לא נמצא'); end if;
  perform app.audit('business.freeze', p_business, 'business', p_business::text, jsonb_build_object('frozen', fr));
  return app.ok(jsonb_build_object('frozen', fr));
end $$;

create function public.rpc_admin_set_freeze(p_business uuid, p_frozen boolean) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
begin
  perform set_config('app.actor', 'system', true);
  update businesses set frozen_at = case when p_frozen then coalesce(frozen_at, now()) else null end where id = p_business;
  if not found then return app.err(404, 'not_found', 'העסק לא נמצא'); end if;
  perform app.audit('business.freeze', p_business, 'business', p_business::text, jsonb_build_object('frozen', p_frozen));
  return app.ok(jsonb_build_object('frozen', p_frozen));
end $$;

-- ייבוא שמסיים קפוא (אטומי): העסק החדש לא מקבל כתיבה עד שהנתונים אומתו ושוחרר במפורש
create function public.rpc_admin_import_business_frozen(p jsonb, p_new_slug text default null) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare r jsonb;
begin
  r := public.rpc_admin_import_business(p, p_new_slug);
  if (r ->> 'ok') = 'true' then
    update businesses set frozen_at = now() where id = (r -> 'data' ->> 'business_id')::uuid;
  end if;
  return r;
end $$;

-- טביעת אצבע לאימות העברה: ספירות לפי טבלה/סטטוס + hash של תוכן (טוקנים אישיים, תורים, לקוחות, שירותים). מקור ויעד חייבים להיות זהים.
create function public.rpc_admin_business_fingerprint(p_business uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not exists (select 1 from businesses where id = p_business) then return app.err(404, 'not_found', 'העסק לא נמצא'); end if;
  return app.ok(jsonb_build_object(
    'counts', jsonb_build_object(
      'services', (select count(*) from services where business_id = p_business),
      'staff', (select count(*) from staff where business_id = p_business),
      'working_hours', (select count(*) from working_hours where business_id = p_business),
      'blocks', (select count(*) from blocks where business_id = p_business),
      'customers', (select count(*) from customers where business_id = p_business),
      'appointments', (select count(*) from appointments where business_id = p_business),
      'appointments_confirmed', (select count(*) from appointments where business_id = p_business and status = 'confirmed'),
      'appointments_cancelled', (select count(*) from appointments where business_id = p_business and status = 'cancelled'),
      'leads', (select count(*) from leads where business_id = p_business)),
    'hashes', jsonb_build_object(
      'appointments', coalesce((select md5(string_agg(a.token_hash || '|' || a.date::text || '|' || a.start_min || '|' || a.end_min || '|' || a.status || '|' || a.price_ils, ',' order by a.token_hash)) from appointments a where a.business_id = p_business), ''),
      'customers', coalesce((select md5(string_agg(c.phone || '|' || c.first_name || '|' || c.last_name, ',' order by c.phone)) from customers c where c.business_id = p_business), ''),
      'services', coalesce((select md5(string_agg(s.name || '|' || s.duration_min || '|' || s.price_ils || '|' || s.active, ',' order by s.name, s.duration_min)) from services s where s.business_id = p_business), ''),
      'leads', coalesce((select md5(string_agg(l.phone || '|' || l.name || '|' || l.status, ',' order by l.phone, l.name, l.created_at)) from leads l where l.business_id = p_business), ''))));
end $$;

revoke all on function public.rpc_super_set_freeze(uuid,jsonb), public.rpc_admin_set_freeze(uuid,boolean), public.rpc_admin_import_business_frozen(jsonb,text),
  public.rpc_admin_business_fingerprint(uuid) from public, anon, authenticated, service_role;
grant execute on function public.rpc_super_set_freeze(uuid,jsonb) to authenticated;
grant execute on function public.rpc_admin_set_freeze(uuid,boolean), public.rpc_admin_import_business_frozen(jsonb,text), public.rpc_admin_business_fingerprint(uuid) to service_role;

-- תיקון ניסוחי שיווק לפי מה שמומש בפועל (אין תזכורות אוטומטיות, אין קישור WhatsApp בפניות, אין תיק עבודות)
update public.templates set features = replace(features::text, 'תזכורות וקישור אישי לשינוי וביטול', 'קישור אישי לשינוי וביטול')::jsonb where features::text like '%תזכורות וקישור%';
update public.templates set features = replace(features::text, 'ניהול פניות והתקשרות/WhatsApp בלחיצה', 'ניהול פניות והתקשרות בלחיצה')::jsonb where features::text like '%WhatsApp בלחיצה%';
update public.templates set features = replace(features::text, 'עיצוב נקי שמתאים לתיק עבודות', 'עיצוב נקי ומובחן')::jsonb where features::text like '%תיק עבודות%';

-- רשימת עסקים לתפעול (גיבוי לוגי לפי עסק). service_role בלבד; ללא נתוני לקוחות.
create function public.rpc_admin_list_businesses() returns jsonb
language sql stable security definer set search_path = public, pg_temp as
$$ select app.ok(jsonb_build_object('businesses', coalesce((select jsonb_agg(jsonb_build_object('id', b.id, 'slug', b.slug, 'is_demo', b.is_demo, 'frozen', b.frozen_at is not null) order by b.created_at) from businesses b), '[]'))) $$;
revoke all on function public.rpc_admin_list_businesses() from public, anon, authenticated, service_role;
grant execute on function public.rpc_admin_list_businesses() to service_role;
