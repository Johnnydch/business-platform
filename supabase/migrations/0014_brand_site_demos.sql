-- 0014: אתר המכירות של המותג (קטלוג, מחירי טיוטה, תוספות, לידים של המותג) ועסקי הדגמה.
-- הלידים של המותג נפרדים לחלוטין מפניות של עסקים (leads): טבלה אחרת, גישה רק ל-Super Admin.
-- עסקי הדגמה (is_demo): נתונים סינתטיים, ללא בעלים וללא דומיין, נמחקים מנתוני תפעול בתחזוקה.

-- ---------- עסקי הדגמה ----------
alter table public.businesses add column is_demo boolean not null default false;
alter table public.businesses add constraint businesses_demo_slug check (not is_demo or slug like 'demo-%');

-- דומיין מותאם לעסק הדגמה אסור (הדגמה לא מקבלת כתובת משלה)
create function app.trg_no_demo_domain() returns trigger language plpgsql as $$
begin
  if exists (select 1 from businesses where id = new.business_id and is_demo) then
    raise exception 'demo_no_domain' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger business_domains_no_demo before insert or update of business_id on public.business_domains for each row execute function app.trg_no_demo_domain();

-- עסק הדגמה אינו יכול לקבל בעלים (אין חשבון אמיתי שמנהל אותו)
create function app.trg_no_demo_owner() returns trigger language plpgsql as $$
begin
  if new.business_id is not null and exists (select 1 from businesses where id = new.business_id and is_demo) then
    raise exception 'demo_no_owner' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger platform_users_no_demo_owner before insert or update of business_id on public.platform_users for each row execute function app.trg_no_demo_owner();

create or replace function public.rpc_public_business(p_slug text) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare b businesses; t templates;
begin
  b := app.biz_by_slug(p_slug);
  if b.id is null then return app.err(404, 'shop_not_found', 'העסק לא נמצא'); end if;
  select * into t from templates where key = b.template;
  return app.ok(jsonb_build_object(
    'shop', jsonb_build_object('name', b.name, 'phone', b.phone, 'address', b.address, 'max_days_ahead', b.max_days_ahead,
                               'template', t.key, 'theme', t.theme, 'labels', t.labels, 'brand', b.brand, 'is_demo', b.is_demo),
    'services', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name, 'duration_min', s.duration_min, 'price_ils', s.price_ils) order by s.id)
                          from services s where s.business_id = b.id and s.active), '[]'),
    'barbers', app.public_staff(b.id)));
end $$;

-- יצירת עסק הדגמה מברירות המחדל של התבנית (service_role בלבד; אידמפוטנטי). אין בעלים, אין טלפון אמיתי.
create function public.rpc_admin_seed_demo(p_template text) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare t templates; bid uuid; sl text; el jsonb; nm text; sid bigint; ord int := 0; nme text;
begin
  perform set_config('app.actor', 'system', true);
  select * into t from templates where key = p_template and status = 'available';
  if t.key is null then return app.err(404, 'not_found', 'התבנית לא נמצאה'); end if;
  sl := 'demo-' || t.key;
  select id into bid from businesses where slug = sl;
  if bid is not null then return app.ok(jsonb_build_object('business_id', bid, 'slug', sl, 'created', false)); end if;
  nme := 'הדגמה · ' || t.name;
  insert into businesses (slug, name, template, phone, address, track, is_demo) values (sl, nme, t.key, null, null, 'managed', true) returning id into bid;
  for el in select * from jsonb_array_elements(t.default_services) loop
    insert into services (business_id, name, duration_min, price_ils) values (bid, el ->> 'name', (el ->> 'duration_min')::int, (el ->> 'price_ils')::int);
  end loop;
  if t.kind = 'booking' then
    for nm in select jsonb_array_elements_text(coalesce(t.defaults -> 'staff', '[]')) loop
      ord := ord + 1;
      insert into staff (business_id, name, sort) values (bid, nm, ord) returning id into sid;
      perform app.write_hours(bid, sid, coalesce(t.defaults -> 'hours', '[]'));
    end loop;
  end if;
  perform app.audit('demo.seed', bid, 'business', bid::text, jsonb_build_object('template', t.key));
  return app.ok(jsonb_build_object('business_id', bid, 'slug', sl, 'created', true));
end $$;

-- ---------- הגדרות המותג (שורה אחת) ----------
create table public.brand_settings (
  id smallint primary key check (id = 1),
  brand_name text not null default 'שם מותג זמני',
  tagline text not null default 'מערכת תורים ופניות לעסקים קטנים',
  contact_phone text,
  contact_email text,
  prices jsonb not null default '{}',          -- { "<template>": { "managed": {"setup": n, "monthly": n}, "one_time": {"setup": n} } }
  prices_approved boolean not null default false,
  addons jsonb not null default '[]',          -- [{ "key", "name", "description", "price_ils" }]
  inclusions jsonb not null default '{}',      -- { "managed": [..], "one_time": [..] }
  updated_at timestamptz not null default now(),
  constraint brand_prices_size check (pg_column_size(prices) < 8000 and pg_column_size(addons) < 8000 and pg_column_size(inclusions) < 8000)
);
alter table public.brand_settings enable row level security;
revoke all on public.brand_settings from public, anon, authenticated;

insert into public.brand_settings (id, prices, addons, inclusions) values (1,
  (select jsonb_object_agg(key, jsonb_build_object('managed', jsonb_build_object('setup', 1500, 'monthly', 149), 'one_time', jsonb_build_object('setup', 4500)))
     from public.templates where status = 'available'),
  '[{"key":"domain","name":"חיבור דומיין מותאם","description":"הגדרת DNS ובדיקת חיבור","price_ils":300},
    {"key":"branding","name":"התאמת מיתוג","description":"צבע מבטא ומשפט פתיחה בדף העסק","price_ils":0},
    {"key":"import","name":"העברת נתונים קיימים","description":"ייבוא שירותים, לקוחות ותורים מרשימה קיימת (בהתאם למבנה הנתונים)","price_ils":600},
    {"key":"messaging","name":"חיבור ספק הודעות (SMS/WhatsApp)","description":"אינו פעיל כרגע: דורש חשבון אצל ספק הודעות; ללא ספק מחובר לא נשלחות הודעות","price_ils":null}]',
  '{"managed":["אירוח ותפעול על ידינו","הקמת העסק, השירותים והצוות","גיבוי ומעקב תפעולי","עדכוני מערכת"],
    "one_time":["קוד המערכת והתקנה בחשבונות Supabase ו-Netlify של הלקוח","מסמך העברה והוראות הפעלה","ייצוא וייבוא נתוני העסק","תחזוקה ועדכונים רק בהסכמה נפרדת"]}');

-- ---------- לידים של המותג (נפרד מפניות עסקים) ----------
create table public.brand_leads (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  name text not null check (char_length(name) between 2 and 60),
  phone text not null check (phone ~ '^05[0-9]{8}$'),
  email text check (email is null or (char_length(email) <= 120 and email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]{2,}$')),
  business_name text check (business_name is null or char_length(business_name) between 2 and 80),
  template text,
  track text not null default 'undecided' check (track in ('managed', 'one_time', 'undecided')),
  addons text[] not null default '{}' check (cardinality(addons) <= 10),
  message text check (message is null or char_length(message) <= 500),
  status text not null default 'new' check (status in ('new', 'contacted', 'won', 'lost')),
  note text check (note is null or char_length(note) <= 300)
);
alter table public.brand_leads enable row level security;
revoke all on public.brand_leads from public, anon, authenticated;
create index brand_leads_created on public.brand_leads (created_at desc);

-- ---------- RPC ציבורי: קטלוג המותג (service_role בלבד, דרך ה-API) ----------
create function public.rpc_public_brand() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare s brand_settings;
begin
  select * into s from brand_settings where id = 1;
  return app.ok(jsonb_build_object(
    'brand', jsonb_build_object('name', s.brand_name, 'tagline', s.tagline, 'phone', s.contact_phone, 'email', s.contact_email),
    'prices', s.prices, 'prices_approved', s.prices_approved, 'addons', s.addons, 'inclusions', s.inclusions,
    'templates', coalesce((select jsonb_agg(jsonb_build_object('key', t.key, 'name', t.name, 'kind', t.kind, 'theme', t.theme, 'tagline', t.tagline,
        'description', t.description, 'audience', t.audience, 'features', t.features,
        'demo_slug', (select b.slug from businesses b where b.is_demo and b.template = t.key and b.active limit 1)) order by t.sort, t.key)
      from templates t where t.status = 'available'), '[]')));
end $$;

create function public.rpc_public_brand_lead(p jsonb, p_ip_hash text, p_pepper text) returns jsonb
language plpgsql volatile security definer set search_path = public, extensions, pg_temp as $$
declare nm text; ph text; em text := nullif(btrim(coalesce(app.jtext(p, 'email'), '')), ''); bn text; msg text; tpl text := app.jtext(p, 'template'); tk text := coalesce(app.jtext(p, 'track'), 'undecided');
        fields jsonb := '{}'; ad text[] := '{}'; k text;
begin
  nm := app.clean_name(app.jtext(p, 'name'));
  ph := app.normalize_phone(app.jtext(p, 'phone'));
  bn := app.clean_text(app.jtext(p, 'business_name'), 2, 80);
  msg := app.clean_text(app.jtext(p, 'message'), 1, 500);
  if nm is null then fields := fields || '{"name":"נא להזין שם תקין"}'; end if;
  if ph is null then fields := fields || '{"phone":"נא להזין מספר נייד ישראלי תקין (למשל 054-1234567)"}'; end if;
  if em is not null and (char_length(em) > 120 or em !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]{2,}$') then fields := fields || '{"email":"כתובת אימייל לא תקינה"}'; end if;
  if app.jtext(p, 'business_name') is not null and bn is null then fields := fields || '{"business_name":"שם העסק: 2–80 תווים"}'; end if;
  if app.jtext(p, 'message') is not null and msg is null then fields := fields || '{"message":"הודעה: עד 500 תווים, ללא תווי HTML"}'; end if;
  if tk not in ('managed', 'one_time', 'undecided') then fields := fields || '{"track":"מסלול לא תקין"}'; end if;
  if tpl is not null and not exists (select 1 from templates where key = tpl and status = 'available') then fields := fields || '{"template":"תבנית לא תקינה"}'; end if;
  if jsonb_typeof(p -> 'addons') = 'array' then
    for k in select jsonb_array_elements_text(p -> 'addons') loop
      if exists (select 1 from brand_settings s, jsonb_array_elements(s.addons) a where a ->> 'key' = k) and not (k = any (ad)) then ad := ad || k; end if;
    end loop;
  end if;
  if fields <> '{}' then return app.err(400, 'validation', 'נא לתקן את השדות המסומנים', fields); end if;
  if not app.rl_hit('brandlead:ip:' || p_ip_hash, 5, 3600)
     or not app.rl_hit('brandlead:all', 200, 3600)
     or not app.rl_hit('brandlead:phone:' || encode(hmac(ph, p_pepper, 'sha256'), 'hex'), 3, 3600) then
    return app.limited();
  end if;
  insert into brand_leads (name, phone, email, business_name, template, track, addons, message) values (nm, ph, em, bn, tpl, tk, ad, msg);
  return app.ok('{}');
end $$;

-- ---------- RPC ל-Super Admin ----------
create function public.rpc_super_brand_get() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare s brand_settings;
begin
  perform app.require_super();
  select * into s from brand_settings where id = 1;
  return app.ok(jsonb_build_object('brand_name', s.brand_name, 'tagline', s.tagline, 'contact_phone', s.contact_phone, 'contact_email', s.contact_email,
    'prices', s.prices, 'prices_approved', s.prices_approved, 'addons', s.addons, 'inclusions', s.inclusions, 'updated_at', s.updated_at,
    'templates', (select coalesce(jsonb_agg(jsonb_build_object('key', t.key, 'name', t.name) order by t.sort, t.key), '[]') from templates t where t.status = 'available')));
end $$;

-- שמירה: שם מותג, פרטי קשר, מחירים, תוספות. כל שינוי במחירים/תוספות מבטל אישור קודם; אישור (approve) דורש אימות MFA טרי.
create function public.rpc_super_brand_save(p jsonb) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare s brand_settings; nm text; tg text; ph text; em text; pr jsonb; ad jsonb := null; el jsonb; k text; v jsonb; n int; fields jsonb := '{}'; price_changed boolean := false; approve boolean := (p ->> 'approve') = 'true';
begin
  perform app.require_super();
  select * into s from brand_settings where id = 1 for update;
  nm := s.brand_name; tg := s.tagline; ph := s.contact_phone; em := s.contact_email; pr := s.prices;
  if p ? 'brand_name' then nm := app.clean_text(p ->> 'brand_name', 2, 40); if nm is null then fields := fields || '{"brand_name":"שם המותג: 2–40 תווים"}'; end if; end if;
  if p ? 'tagline' then tg := app.clean_text(p ->> 'tagline', 2, 120); if tg is null then fields := fields || '{"tagline":"משפט: 2–120 תווים"}'; end if; end if;
  if p ? 'contact_phone' then
    if coalesce(p ->> 'contact_phone', '') = '' then ph := null; else ph := app.normalize_phone(p ->> 'contact_phone'); if ph is null then fields := fields || '{"contact_phone":"טלפון לא תקין"}'; end if; end if;
  end if;
  if p ? 'contact_email' then
    if coalesce(p ->> 'contact_email', '') = '' then em := null;
    elsif (p ->> 'contact_email') ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]{2,}$' and char_length(p ->> 'contact_email') <= 120 then em := p ->> 'contact_email';
    else fields := fields || '{"contact_email":"אימייל לא תקין"}'; end if;
  end if;
  if p ? 'prices' then
    if jsonb_typeof(p -> 'prices') <> 'object' then fields := fields || '{"prices":"מבנה מחירים לא תקין"}';
    else
      pr := '{}';
      for k, v in select * from jsonb_each(p -> 'prices') loop
        if not exists (select 1 from templates where key = k and status = 'available') then continue; end if;
        pr := pr || jsonb_build_object(k, jsonb_build_object(
          'managed', jsonb_build_object('setup', app.jint(v -> 'managed', 'setup', 0, 1000000), 'monthly', app.jint(v -> 'managed', 'monthly', 0, 1000000)),
          'one_time', jsonb_build_object('setup', app.jint(v -> 'one_time', 'setup', 0, 1000000))));
      end loop;
      price_changed := pr is distinct from s.prices;
    end if;
  end if;
  if p ? 'addons' then
    if jsonb_typeof(p -> 'addons') <> 'array' or jsonb_array_length(p -> 'addons') > 12 then fields := fields || '{"addons":"עד 12 תוספות"}';
    else
      ad := '[]'; n := 0;
      for el in select * from jsonb_array_elements(p -> 'addons') loop
        n := n + 1;
        if app.clean_text(el ->> 'name', 2, 60) is null or coalesce(el ->> 'key', '') !~ '^[a-z0-9_-]{2,24}$' then fields := fields || jsonb_build_object('addons.' || n, 'תוספת: מפתח באנגלית ושם 2–60 תווים'); continue; end if;
        ad := ad || jsonb_build_array(jsonb_build_object('key', el ->> 'key', 'name', app.clean_text(el ->> 'name', 2, 60), 'description', coalesce(app.clean_text(el ->> 'description', 1, 160), ''),
                                                           'price_ils', app.jint(el, 'price_ils', 0, 1000000)));
      end loop;
    end if;
  end if;
  if fields <> '{}' then return app.err(400, 'validation', 'נא לתקן את השדות המסומנים', fields); end if;
  if approve then perform app.require_fresh_mfa(15); end if;
  update brand_settings set brand_name = nm, tagline = tg, contact_phone = ph, contact_email = em, prices = pr, addons = coalesce(ad, addons), updated_at = now(),
    prices_approved = case when approve then true when price_changed or ad is not null then false else prices_approved end where id = 1;
  perform app.audit('brand.save', null, 'brand', '1', jsonb_build_object('approved', approve, 'prices_changed', price_changed));
  return app.ok('{}');
end $$;

-- ביטול אישור מחירים (חזרה למצב "טיוטה")
create function public.rpc_super_brand_unapprove() returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
begin
  perform app.require_super();
  update brand_settings set prices_approved = false, updated_at = now() where id = 1;
  perform app.audit('brand.unapprove', null, 'brand', '1', '{}');
  return app.ok('{}');
end $$;

create function public.rpc_super_brand_leads(p jsonb default '{}') returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform app.require_super();
  return app.ok(jsonb_build_object('leads', coalesce((
    select jsonb_agg(jsonb_build_object('id', l.id, 'created_at', l.created_at, 'name', l.name, 'phone', l.phone, 'email', l.email, 'business_name', l.business_name,
        'template', l.template, 'track', l.track, 'addons', l.addons, 'message', l.message, 'status', l.status, 'note', l.note) order by l.created_at desc)
    from (select * from brand_leads order by created_at desc limit 300) l), '[]')));
end $$;

create function public.rpc_super_brand_lead_update(p jsonb) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare lid bigint := app.jint(p, 'id', 1, 1000000000000); st text := app.jtext(p, 'status'); nt text;
begin
  perform app.require_super();
  if lid is null or not exists (select 1 from brand_leads where brand_leads.id = lid) then return app.err(404, 'not_found', 'הליד לא נמצא'); end if;
  if st is not null and st not in ('new', 'contacted', 'won', 'lost') then return app.err(400, 'validation', 'סטטוס לא תקין', '{"status":"סטטוס לא תקין"}'); end if;
  if p ? 'note' then
    nt := app.clean_text(p ->> 'note', 1, 300);
    if coalesce(p ->> 'note', '') <> '' and nt is null then return app.err(400, 'validation', 'הערה: עד 300 תווים', '{"note":"הערה: עד 300 תווים"}'); end if;
    update brand_leads set note = nt where brand_leads.id = lid;
  end if;
  if st is not null then update brand_leads set status = st where brand_leads.id = lid; end if;
  perform app.audit('brand_lead.update', null, 'brand_lead', lid::text, jsonb_build_object('status', st));
  return app.ok('{}');
end $$;

-- ---------- תחזוקה: ניקוי נתוני תפעול בעסקי הדגמה + הדגמות ישנות של לידים ----------
create or replace function public.rpc_maintenance_cleanup() returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare rl int; au int; da int; dl int;
begin
  delete from rate_limits where expires_at < now() - interval '1 hour'; get diagnostics rl = row_count;
  perform set_config('app.audit_purge', 'on', true);
  delete from audit_log where at < now() - interval '400 days'; get diagnostics au = row_count;
  delete from appointments where created_at < now() - interval '1 day' and business_id in (select id from businesses where is_demo); get diagnostics da = row_count;
  delete from leads where created_at < now() - interval '1 day' and business_id in (select id from businesses where is_demo); get diagnostics dl = row_count;
  delete from customers where business_id in (select id from businesses where is_demo) and not exists (select 1 from appointments a where a.customer_id = customers.id);
  return app.ok(jsonb_build_object('rate_limits_deleted', rl, 'audit_deleted', au, 'demo_appointments_deleted', da, 'demo_leads_deleted', dl));
end $$;

-- ---------- הרשאות ----------
revoke all on function app.trg_no_demo_domain(), app.trg_no_demo_owner() from public, anon, authenticated;
revoke all on function public.rpc_admin_seed_demo(text), public.rpc_public_brand(), public.rpc_public_brand_lead(jsonb,text,text), public.rpc_super_brand_get(),
  public.rpc_super_brand_save(jsonb), public.rpc_super_brand_unapprove(), public.rpc_super_brand_leads(jsonb), public.rpc_super_brand_lead_update(jsonb)
from public, anon, authenticated, service_role;
grant execute on function public.rpc_admin_seed_demo(text), public.rpc_public_brand(), public.rpc_public_brand_lead(jsonb,text,text) to service_role;
grant execute on function public.rpc_super_brand_get(), public.rpc_super_brand_save(jsonb), public.rpc_super_brand_unapprove(), public.rpc_super_brand_leads(jsonb),
  public.rpc_super_brand_lead_update(jsonb) to authenticated;
