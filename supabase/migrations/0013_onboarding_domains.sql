-- =====================================================================
-- 0013 · אשף הקמת עסק: מיתוג, טיפוסי פעולה (managed / one_time), טיוטות, פרסום אטומי, ודומיינים מותאמים.
-- עקרונות:
--  • טיוטות ופרסום: Super Admin בלבד (aal2); פרסום דורש אימות TOTP טרי. הסיסמה הזמנית אינה נשמרת בטיוטה.
--  • פרסום יוצר עסק + בעלים + שירותים + צוות + שעות בטרנזקציה אחת; כשל = שום דבר לא נוצר.
--  • דומיין: ההוכחה לבעלות היא רשומת TXT אמיתית, והניתוב נבדק בבקשת HTTPS אמיתית. אין סטטוס מדומה.
--  • דומיין אינו מעניק הרשאות: הוא רק ממפה host → slug ציבורי; כל הגישה נשארת דרך אותם RPC ציבוריים.
-- =====================================================================

-- ---------- מיתוג וטיפוס פעולה ----------
alter table public.businesses
  add column brand jsonb not null default '{}' check (jsonb_typeof(brand) = 'object' and pg_column_size(brand) < 300),
  add column track text  not null default 'managed' check (track in ('managed', 'one_time'));

-- הבעלים עורך מיתוג (tagline/accent) בלבד; track נשאר בשליטת הפלטפורמה
grant update (brand) on public.businesses to authenticated;

create function app.parse_brand(p jsonb) returns jsonb language plpgsql immutable as $$
declare b jsonb := '{}'; e jsonb := '{}'; tg text; ac text;
begin
  if p is null or jsonb_typeof(p) <> 'object' then return jsonb_build_object('brand', b, 'errors', e); end if;
  if coalesce(app.jtext(p, 'tagline'), '') <> '' then
    tg := app.clean_text(app.jtext(p, 'tagline'), 2, 80);
    if tg is null then e := e || '{"tagline":"משפט פתיחה: 2–80 תווים, ללא HTML"}'; else b := b || jsonb_build_object('tagline', tg); end if;
  end if;
  ac := lower(coalesce(app.jtext(p, 'accent'), ''));
  if ac <> '' then
    if ac !~ '^#[0-9a-f]{6}$' then e := e || '{"accent":"צבע בפורמט #rrggbb"}'; else b := b || jsonb_build_object('accent', ac); end if;
  end if;
  return jsonb_build_object('brand', b, 'errors', e);
end $$;
revoke all on function app.parse_brand(jsonb) from public;
grant execute on function app.parse_brand(jsonb) to authenticated, service_role;   -- נקראת מ-rpc_owner_shop_update (INVOKER); פונקציה טהורה

-- ברירות מחדל לאשף, לפי תבנית (שמות צוות ושעות עבודה; לתבניות לידים אין צוות)
alter table public.templates add column defaults jsonb not null default '{}';
update public.templates set defaults = jsonb_build_object('staff', '["ספר 1"]'::jsonb, 'hours', '[{"weekday":0,"start_min":540,"end_min":1080},{"weekday":1,"start_min":540,"end_min":1080},{"weekday":2,"start_min":540,"end_min":1080},{"weekday":3,"start_min":540,"end_min":1080},{"weekday":4,"start_min":540,"end_min":1080},{"weekday":5,"start_min":480,"end_min":840}]'::jsonb) where key = 'barbershop';
update public.templates set defaults = jsonb_build_object('staff', '["מטפלת 1"]'::jsonb, 'hours', '[{"weekday":0,"start_min":540,"end_min":1080},{"weekday":1,"start_min":540,"end_min":1080},{"weekday":2,"start_min":540,"end_min":1080},{"weekday":3,"start_min":540,"end_min":1080},{"weekday":4,"start_min":540,"end_min":1080},{"weekday":5,"start_min":480,"end_min":840}]'::jsonb) where key = 'cosmetics';
update public.templates set defaults = jsonb_build_object('staff', '["תחנה 1","תחנה 2"]'::jsonb, 'hours', '[{"weekday":0,"start_min":540,"end_min":1080},{"weekday":1,"start_min":540,"end_min":1080},{"weekday":2,"start_min":540,"end_min":1080},{"weekday":3,"start_min":540,"end_min":1080},{"weekday":4,"start_min":540,"end_min":1080},{"weekday":5,"start_min":480,"end_min":840}]'::jsonb) where key = 'detailing';

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
              'kind', t.kind, 'theme', t.theme, 'labels', t.labels, 'brand', b.brand, 'track', b.track) end));
end $$;

create or replace function public.rpc_public_business(p_slug text) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare b businesses; t templates;
begin
  b := app.biz_by_slug(p_slug);
  if b.id is null then return app.err(404, 'shop_not_found', 'העסק לא נמצא'); end if;
  select * into t from templates where key = b.template;
  return app.ok(jsonb_build_object(
    'shop', jsonb_build_object('name', b.name, 'phone', b.phone, 'address', b.address, 'max_days_ahead', b.max_days_ahead,
                               'template', t.key, 'theme', t.theme, 'labels', t.labels, 'brand', b.brand),
    'services', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name, 'duration_min', s.duration_min, 'price_ils', s.price_ils) order by s.id)
                          from services s where s.business_id = b.id and s.active), '[]'),
    'barbers', app.public_staff(b.id)));
end $$;

create or replace function public.rpc_owner_shop_get(p_business uuid, p jsonb default '{}') returns jsonb
language plpgsql stable set search_path = public, pg_temp as $$
declare b businesses; t templates; biz uuid := app.resolve_business(p_business);
begin
  select * into b from businesses where businesses.id = biz;
  select * into t from templates where key = b.template;
  return app.ok(jsonb_build_object('shop', jsonb_build_object('id', b.id, 'slug', b.slug, 'name', b.name, 'phone', b.phone,
     'address', b.address, 'active', b.active, 'template', b.template, 'kind', t.kind, 'labels', t.labels, 'theme', t.theme, 'brand', b.brand, 'track', b.track, 'slot_step', b.slot_step, 'min_notice_min', b.min_notice_min,
     'max_days_ahead', b.max_days_ahead, 'cancel_cutoff_hours', b.cancel_cutoff_hours)));
end $$;

create or replace function public.rpc_owner_shop_update(p_business uuid, p jsonb) returns jsonb
language plpgsql volatile set search_path = public, pg_temp as $$
declare biz uuid := app.resolve_business(p_business); f jsonb := '{}'; br jsonb; brand_new jsonb; nm text; ph text; ad text; ss bigint; nt bigint; ah bigint; cf bigint;
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
  br := app.parse_brand(p -> 'brand');
  if br -> 'errors' <> '{}' then f := f || (select coalesce(jsonb_object_agg('brand.' || k, v), '{}') from jsonb_each(br -> 'errors') e(k, v)); end if;
  if f <> '{}' then return app.err(400, 'validation', 'נא לתקן את השדות המסומנים', f); end if;
  update businesses set name = nm, phone = ph, address = ad, slot_step = ss, min_notice_min = nt, max_days_ahead = ah,
         cancel_cutoff_hours = cf, brand = case when p ? 'brand' then br -> 'brand' else brand end where businesses.id = biz;
  return app.ok('{}');
end $$;

-- ---------- דומיינים ----------
create table public.business_domains (
  id                 bigint generated always as identity primary key,
  business_id        uuid not null references public.businesses(id) on delete cascade,
  hostname           text not null check (hostname = lower(hostname) and char_length(hostname) <= 253
                       and hostname ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$'),
  status             text not null default 'pending' check (status in ('pending', 'verified', 'active', 'failed')),
  verification_token text not null default left(app.new_token(), 32),
  last_error         text check (last_error is null or last_error ~ '^[a-z_]{1,40}$'),
  last_check_at      timestamptz,
  verified_at        timestamptz,
  activated_at       timestamptz,
  created_at         timestamptz not null default now(),
  unique (business_id, hostname)
);
create unique index business_domains_live_host on public.business_domains (hostname) where status in ('verified', 'active');
alter table public.business_domains enable row level security;
revoke all on public.business_domains from public, anon, authenticated;

-- ---------- טיוטות ----------
create table public.business_drafts (
  id            uuid primary key default gen_random_uuid(),
  created_by    uuid,
  template      text not null references public.templates(key),
  track         text not null default 'managed' check (track in ('managed', 'one_time')),
  status        text not null default 'draft' check (status in ('draft', 'published', 'discarded')),
  step          int  not null default 1 check (step between 1 and 8),
  version       int  not null default 1,
  data          jsonb not null default '{}' check (jsonb_typeof(data) = 'object' and pg_column_size(data) < 24000),
  owner_user_id uuid,
  business_id   uuid references public.businesses(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
alter table public.business_drafts enable row level security;
revoke all on public.business_drafts from public, anon, authenticated;

-- טקסט לטיוטה: חיתוך והסרת תווי בקרה ו-<>. אימות מלא נעשה בבדיקת השלמות ובפרסום.
create function app.s(v jsonb, k text, n int) returns text language sql immutable as
$$ select left(btrim(regexp_replace(coalesce(v ->> k, ''), '[[:cntrl:]<>]', '', 'g')), n) $$;

create function app.draft_normalize(p jsonb) returns jsonb language plpgsql immutable as $$
declare o jsonb := '{}'; arr jsonb; el jsonb; hs jsonb; h jsonb; n int;
begin
  if jsonb_typeof(p -> 'business') = 'object' then
    o := o || jsonb_build_object('business', jsonb_build_object('name', app.s(p -> 'business', 'name', 60), 'slug', lower(app.s(p -> 'business', 'slug', 40)),
           'phone', app.s(p -> 'business', 'phone', 20), 'address', app.s(p -> 'business', 'address', 120)));
  end if;
  if jsonb_typeof(p -> 'owner') = 'object' then o := o || jsonb_build_object('owner', jsonb_build_object('email', lower(app.s(p -> 'owner', 'email', 254)))); end if;
  if jsonb_typeof(p -> 'brand') = 'object' then o := o || jsonb_build_object('brand', jsonb_build_object('tagline', app.s(p -> 'brand', 'tagline', 80), 'accent', lower(app.s(p -> 'brand', 'accent', 7)))); end if;
  if jsonb_typeof(p -> 'domain') = 'object' then o := o || jsonb_build_object('domain', jsonb_build_object('hostname', lower(app.s(p -> 'domain', 'hostname', 253)))); end if;
  if jsonb_typeof(p -> 'services') = 'array' then
    arr := '[]'; n := 0;
    for el in select * from jsonb_array_elements(p -> 'services') loop
      exit when n >= 30; continue when jsonb_typeof(el) <> 'object'; n := n + 1;
      arr := arr || jsonb_build_array(jsonb_build_object('name', app.s(el, 'name', 60), 'duration_min', coalesce(app.jint(el, 'duration_min', 0, 100000), 0), 'price_ils', coalesce(app.jint(el, 'price_ils', 0, 10000000), 0)));
    end loop;
    o := o || jsonb_build_object('services', arr);
  end if;
  if jsonb_typeof(p -> 'staff') = 'array' then
    arr := '[]'; n := 0;
    for el in select * from jsonb_array_elements(p -> 'staff') loop
      exit when n >= 20; continue when jsonb_typeof(el) <> 'object'; n := n + 1;
      hs := '[]';
      if jsonb_typeof(el -> 'hours') = 'array' then
        for h in select * from jsonb_array_elements(el -> 'hours') loop
          continue when jsonb_typeof(h) <> 'object' or jsonb_array_length(hs) >= 7;
          if app.jint(h, 'weekday', 0, 6) is not null and app.jint(h, 'start_min', 0, 1439) is not null and app.jint(h, 'end_min', 1, 1440) is not null then
            hs := hs || jsonb_build_array(jsonb_build_object('weekday', app.jint(h, 'weekday', 0, 6), 'start_min', app.jint(h, 'start_min', 0, 1439), 'end_min', app.jint(h, 'end_min', 1, 1440)));
          end if;
        end loop;
      end if;
      arr := arr || jsonb_build_array(jsonb_build_object('name', app.s(el, 'name', 40), 'hours', hs));
    end loop;
    o := o || jsonb_build_object('staff', arr);
  end if;
  return o;
end $$;

-- מה חסר לפני פרסום: אובייקט { "<חלק>.<שדה>": הודעה }. ריק = מוכן.
create function app.draft_problems(d public.business_drafts) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare f jsonb := '{}'; t templates; bz jsonb := d.data -> 'business'; v_slug text; el jsonb; i int := 0; br jsonb; hn text;
begin
  select * into t from templates where key = d.template;
  if t.key is null or t.status <> 'available' then f := f || '{"template":"התבנית אינה זמינה"}'; end if;
  if app.clean_text(bz ->> 'name', 2, 60) is null then f := f || '{"business.name":"שם העסק: 2–60 תווים"}'; end if;
  v_slug := coalesce(bz ->> 'slug', '');
  if v_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$' or char_length(v_slug) not between 3 and 40 then f := f || '{"business.slug":"כתובת באנגלית (a-z, 0-9, מקף), 3–40 תווים"}';
  elsif exists (select 1 from businesses b where b.slug = v_slug) then f := f || '{"business.slug":"הכתובת כבר תפוסה"}'; end if;
  if coalesce(bz ->> 'phone', '') !~ '^[0-9+() \-]{7,20}$' then f := f || '{"business.phone":"טלפון העסק נדרש (כך הלקוחות יוכלו ליצור קשר)"}'; end if;
  if coalesce(bz ->> 'address', '') <> '' and app.clean_text(bz ->> 'address', 2, 120) is null then f := f || '{"business.address":"כתובת: 2–120 תווים"}'; end if;
  if coalesce(d.data -> 'owner' ->> 'email', '') !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]{2,}$' then f := f || '{"owner.email":"אימייל הבעלים נדרש"}'; end if;
  br := app.parse_brand(d.data -> 'brand') -> 'errors';
  if br <> '{}' then f := f || (select jsonb_object_agg('brand.' || k, v) from jsonb_each(br) e(k, v)); end if;
  if jsonb_typeof(d.data -> 'services') <> 'array' or jsonb_array_length(d.data -> 'services') = 0 then f := f || '{"services":"נדרש לפחות שירות אחד"}';
  else
    for el in select * from jsonb_array_elements(d.data -> 'services') loop
      i := i + 1;
      if app.clean_text(el ->> 'name', 2, 60) is null or coalesce((el ->> 'duration_min')::int, 0) not between 5 and 480 or coalesce((el ->> 'price_ils')::int, -1) not between 0 and 100000 then
        f := f || jsonb_build_object('services.' || i, 'שירות ' || i || ': שם 2–60 תווים, משך 5–480 דקות, מחיר 0–100000'); end if;
    end loop;
  end if;
  if t.kind = 'booking' then
    i := 0;
    if jsonb_typeof(d.data -> 'staff') <> 'array' or jsonb_array_length(d.data -> 'staff') = 0 then f := f || '{"staff":"נדרש לפחות איש צוות אחד עם שעות עבודה"}';
    else
      for el in select * from jsonb_array_elements(d.data -> 'staff') loop
        i := i + 1;
        if app.clean_text(el ->> 'name', 2, 40) is null or jsonb_array_length(coalesce(el -> 'hours', '[]')) = 0 or app.parse_hours(el -> 'hours') is null then
          f := f || jsonb_build_object('staff.' || i, 'פריט ' || i || ': שם 2–40 תווים ולפחות יום עבודה אחד תקין'); end if;
      end loop;
    end if;
  end if;
  hn := coalesce(d.data -> 'domain' ->> 'hostname', '');
  if hn <> '' and hn !~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$' then f := f || '{"domain.hostname":"שם דומיין לא תקין"}'; end if;
  return f;
end $$;
revoke all on function app.draft_problems(public.business_drafts) from public;

create function app.draft_row(d public.business_drafts) returns jsonb language sql stable as
$$ select jsonb_build_object('id', d.id, 'template', d.template, 'track', d.track, 'status', d.status, 'step', d.step, 'version', d.version, 'data', d.data,
     'owner_ready', d.owner_user_id is not null, 'business_id', d.business_id, 'created_at', d.created_at, 'updated_at', d.updated_at) $$;
revoke all on function app.draft_row(public.business_drafts) from public;

create function public.rpc_super_draft_create(p jsonb) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare t templates; tk text := coalesce(app.jtext(p, 'track'), 'managed'); d business_drafts; st jsonb := '[]'; nm text;
begin
  perform app.require_super();
  select * into t from templates where key = app.jtext(p, 'template') and status = 'available';
  if t.key is null then return app.err(400, 'validation', 'נא לתקן את השדות המסומנים', '{"template":"תבנית לא זמינה"}'); end if;
  if tk not in ('managed', 'one_time') then return app.err(400, 'validation', 'נא לתקן את השדות המסומנים', '{"track":"מסלול לא תקין"}'); end if;
  if t.kind = 'booking' then
    for nm in select jsonb_array_elements_text(coalesce(t.defaults -> 'staff', '[]')) loop
      st := st || jsonb_build_array(jsonb_build_object('name', nm, 'hours', coalesce(t.defaults -> 'hours', '[]')));
    end loop;
  end if;
  insert into business_drafts (created_by, template, track, data)
    values (auth.uid(), t.key, tk, jsonb_build_object('business', jsonb_build_object('name', '', 'slug', '', 'phone', '', 'address', ''), 'owner', jsonb_build_object('email', ''),
      'brand', '{}'::jsonb, 'domain', jsonb_build_object('hostname', ''), 'services', t.default_services, 'staff', st)) returning * into d;
  perform app.audit('draft.create', null, 'draft', d.id::text, jsonb_build_object('template', t.key, 'track', tk));
  return app.ok(app.draft_row(d));
end $$;

create function public.rpc_super_draft_list() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform app.require_super();
  return app.ok(jsonb_build_object('drafts', coalesce((
    select jsonb_agg(jsonb_build_object('id', d.id, 'template', d.template, 'track', d.track, 'status', d.status, 'step', d.step, 'name', d.data -> 'business' ->> 'name',
                                        'business_id', d.business_id, 'updated_at', d.updated_at) order by d.updated_at desc)
    from (select * from business_drafts where status <> 'discarded' order by updated_at desc limit 100) d), '[]')));
end $$;

create function public.rpc_super_draft_get(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare d business_drafts;
begin
  perform app.require_super();
  select * into d from business_drafts where id = p_id and status <> 'discarded';
  if d.id is null then return app.err(404, 'not_found', 'הטיוטה לא נמצאה'); end if;
  return app.ok(app.draft_row(d) || jsonb_build_object('owner_user_id', d.owner_user_id, 'problems', case when d.status = 'draft' then app.draft_problems(d) else '{}'::jsonb end));
end $$;

create function public.rpc_super_draft_save(p_id uuid, p jsonb) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare d business_drafts; t templates; ver bigint := app.jint(p, 'version', 1, 1000000000); stp bigint := app.jint(p, 'step', 1, 8); tk text := app.jtext(p, 'track'); tp text := app.jtext(p, 'template');
        nd jsonb; st jsonb := '[]'; nm text;
begin
  perform app.require_super();
  select * into d from business_drafts where id = p_id for update;
  if d.id is null or d.status = 'discarded' then return app.err(404, 'not_found', 'הטיוטה לא נמצאה'); end if;
  if d.status <> 'draft' then return app.err(409, 'draft_closed', 'הטיוטה כבר פורסמה'); end if;
  if ver is null or ver <> d.version then return app.err(409, 'conflict', 'הטיוטה עודכנה במקום אחר. טענו מחדש כדי להמשיך.'); end if;
  nd := d.data || app.draft_normalize(coalesce(p -> 'data', '{}'));
  if tk is not null then
    if tk not in ('managed', 'one_time') then return app.err(400, 'validation', 'נא לתקן את השדות המסומנים', '{"track":"מסלול לא תקין"}'); end if;
    d.track := tk;
  end if;
  if tp is not null and tp <> d.template then                              -- החלפת תבנית: מאפסים שירותי ברירת מחדל וצוות לפי התבנית החדשה
    select * into t from templates where key = tp and status = 'available';
    if t.key is null then return app.err(400, 'validation', 'נא לתקן את השדות המסומנים', '{"template":"תבנית לא זמינה"}'); end if;
    if t.kind = 'booking' then
      for nm in select jsonb_array_elements_text(coalesce(t.defaults -> 'staff', '[]')) loop
        st := st || jsonb_build_array(jsonb_build_object('name', nm, 'hours', coalesce(t.defaults -> 'hours', '[]')));
      end loop;
    end if;
    nd := nd || jsonb_build_object('services', t.default_services, 'staff', st);
    d.template := t.key;
  end if;
  update business_drafts set data = nd, template = d.template, track = d.track, step = coalesce(stp, step), version = version + 1, updated_at = now()
    where id = d.id returning * into d;
  return app.ok(app.draft_row(d) || jsonb_build_object('problems', app.draft_problems(d)));
end $$;

create function public.rpc_super_draft_discard(p_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare d business_drafts;
begin
  perform app.require_super();
  update business_drafts set status = 'discarded', updated_at = now() where id = p_id and status = 'draft' returning * into d;
  if d.id is null then return app.err(404, 'not_found', 'הטיוטה לא נמצאה'); end if;
  -- חשבון Auth שנוצר עבור הטיוטה ואינו משויך לעסק: מוחזר כדי שה-API ימחק אותו (אין חשבונות יתומים)
  return app.ok(jsonb_build_object('orphan_user_id', case when d.owner_user_id is not null and not exists (select 1 from platform_users where user_id = d.owner_user_id) then d.owner_user_id end));
end $$;

-- בדיקת אימות טרי לפני פעולות שיוצרות חשבון Auth (כדי לא ליצור חשבון ואז להיכשל)
create function public.rpc_super_check_fresh_mfa() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin perform app.require_fresh_mfa(15); return app.ok('{}'); end $$;

-- חיפוש חשבון Auth לפי אימייל (שחזור בטוח אחרי כשל באמצע פרסום): האם קיים והאם כבר משויך
create function public.rpc_super_find_user(p jsonb) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare u uuid;
begin
  perform app.require_super();
  select id into u from auth.users where lower(email) = lower(coalesce(app.jtext(p, 'email'), ''));
  if u is null then return app.ok(jsonb_build_object('exists', false)); end if;
  return app.ok(jsonb_build_object('exists', true, 'user_id', u, 'attached', exists (select 1 from platform_users where user_id = u)));
end $$;

create function public.rpc_super_draft_set_owner(p_id uuid, p jsonb) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare uid uuid; n int;
begin
  perform app.require_fresh_mfa(15);                                     -- שיוך בעלים = פעולה חוצת-עסקים: אימות טרי
  begin uid := (app.jtext(p, 'owner_user_id'))::uuid; exception when others then uid := null; end;
  if uid is null or not exists (select 1 from auth.users where id = uid) then return app.err(400, 'validation', 'חשבון הבעלים לא נמצא'); end if;
  if exists (select 1 from platform_users where user_id = uid) then return app.err(400, 'validation', 'החשבון כבר משויך לעסק'); end if;
  update business_drafts set owner_user_id = uid, updated_at = now() where id = p_id and status = 'draft';
  get diagnostics n = row_count;
  if n = 0 then return app.err(404, 'not_found', 'הטיוטה לא נמצאה'); end if;
  return app.ok('{}');
end $$;

-- פרסום: אטומי. כל התנאים נבדקים בתוך הטרנזקציה; כשל = אין עסק, אין שורות יתומות. חוזר באותה תוצאה אם כבר פורסם.
create function public.rpc_super_draft_publish(p_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare d business_drafts; pr jsonb; bid uuid; bz jsonb; el jsonb; sid bigint; hn text; ord int := 0;
begin
  perform app.require_fresh_mfa(15);
  select * into d from business_drafts where id = p_id for update;
  if d.id is null or d.status = 'discarded' then return app.err(404, 'not_found', 'הטיוטה לא נמצאה'); end if;
  if d.status = 'published' then return app.ok(jsonb_build_object('business_id', d.business_id, 'slug', (select slug from businesses where id = d.business_id), 'already', true)); end if;
  if d.owner_user_id is null then return app.err(400, 'owner_missing', 'חשבון הבעלים טרם נוצר'); end if;
  if not exists (select 1 from auth.users where id = d.owner_user_id) or exists (select 1 from platform_users where user_id = d.owner_user_id) then
    return app.err(400, 'owner_invalid', 'חשבון הבעלים אינו זמין לשיוך', '{"owner.email":"החשבון אינו זמין לשיוך"}');
  end if;
  pr := app.draft_problems(d);
  if pr <> '{}' then return app.err(400, 'incomplete', 'ההקמה לא הושלמה: יש להשלים את הפריטים המסומנים לפני פרסום', pr); end if;
  bz := d.data -> 'business';
  insert into businesses (slug, name, template, phone, address, brand, track)
    values (bz ->> 'slug', bz ->> 'name', d.template, bz ->> 'phone', nullif(bz ->> 'address', ''), (app.parse_brand(d.data -> 'brand')) -> 'brand', d.track) returning id into bid;
  insert into platform_users (user_id, role, business_id) values (d.owner_user_id, 'owner', bid);
  for el in select * from jsonb_array_elements(d.data -> 'services') loop
    insert into services (business_id, name, duration_min, price_ils) values (bid, el ->> 'name', (el ->> 'duration_min')::int, (el ->> 'price_ils')::int);
  end loop;
  if (select kind from templates where key = d.template) = 'booking' then
    for el in select * from jsonb_array_elements(d.data -> 'staff') loop
      ord := ord + 1;
      insert into staff (business_id, name, sort) values (bid, el ->> 'name', ord) returning id into sid;
      perform app.write_hours(bid, sid, el -> 'hours');
    end loop;
  end if;
  hn := coalesce(d.data -> 'domain' ->> 'hostname', '');
  if hn <> '' then insert into business_domains (business_id, hostname) values (bid, hn) on conflict do nothing; end if;
  update business_drafts set status = 'published', business_id = bid, updated_at = now() where id = d.id;
  perform app.audit('draft.publish', bid, 'draft', d.id::text, jsonb_build_object('template', d.template, 'track', d.track));
  return app.ok(jsonb_build_object('business_id', bid, 'slug', bz ->> 'slug', 'already', false));
end $$;

-- ---------- דומיינים: ניהול (בעלים של העסק או Super Admin) ----------
create function app.domain_row(d public.business_domains) returns jsonb language sql stable as
$$ select jsonb_build_object('id', d.id, 'hostname', d.hostname, 'status', d.status, 'txt_name', '_bsverify.' || d.hostname, 'txt_value', 'bs-verify=' || d.verification_token,
     'last_error', d.last_error, 'last_check_at', d.last_check_at, 'verified_at', d.verified_at, 'activated_at', d.activated_at) $$;
revoke all on function app.domain_row(public.business_domains) from public;

create function public.rpc_domain_list(p_business uuid, p jsonb default '{}') returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare biz uuid := app.resolve_business(p_business);
begin
  return app.ok(jsonb_build_object('domains', coalesce((select jsonb_agg(app.domain_row(d) order by d.id) from business_domains d where d.business_id = biz), '[]')));
end $$;

create function public.rpc_domain_add(p_business uuid, p jsonb) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare biz uuid := app.resolve_business(p_business); hn text := lower(regexp_replace(btrim(coalesce(app.jtext(p, 'hostname'), '')), '\.$', '')); d business_domains;
begin
  if hn !~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$' or char_length(hn) > 253 then
    return app.err(400, 'validation', 'נא לתקן את השדות המסומנים', '{"hostname":"שם דומיין לא תקין (למשל book.example.com)"}');
  end if;
  if (select count(*) from business_domains where business_id = biz) >= 3 then return app.err(409, 'limit', 'עד 3 דומיינים לעסק'); end if;
  if exists (select 1 from business_domains where business_id = biz and hostname = hn) then return app.err(409, 'duplicate', 'הדומיין כבר נוסף', '{"hostname":"הדומיין כבר נוסף"}'); end if;
  if exists (select 1 from business_domains where hostname = hn and status in ('verified', 'active')) then
    return app.err(409, 'domain_taken', 'הדומיין כבר מחובר לעסק אחר', '{"hostname":"הדומיין כבר מחובר לעסק אחר"}');
  end if;
  insert into business_domains (business_id, hostname) values (biz, hn) returning * into d;
  perform app.audit('domain.add', biz, 'domain', d.id::text, '{}');
  return app.ok(app.domain_row(d));
end $$;

create function public.rpc_domain_remove(p_business uuid, p jsonb) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare biz uuid := app.resolve_business(p_business); n int;
begin
  delete from business_domains where id = app.jint(p, 'id', 1, 1000000000) and business_id = biz;
  get diagnostics n = row_count;
  if n = 0 then return app.err(404, 'not_found', 'הדומיין לא נמצא'); end if;
  perform app.audit('domain.remove', biz, 'domain', coalesce(app.jtext(p, 'id'), ''), '{}');
  return app.ok('{}');
end $$;

-- פרטי בדיקה (מוגבלת בקצב): מוחזרים רק למי שמורשה לעסק; הבדיקה עצמה (DNS/HTTPS) רצה בשרת
create function public.rpc_domain_check_target(p_business uuid, p jsonb) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare biz uuid := app.resolve_business(p_business); d business_domains;
begin
  select * into d from business_domains where id = app.jint(p, 'id', 1, 1000000000) and business_id = biz;
  if d.id is null then return app.err(404, 'not_found', 'הדומיין לא נמצא'); end if;
  if not app.rl_hit('domcheck:' || biz, 30, 3600) then return app.limited(); end if;
  return app.ok(jsonb_build_object('id', d.id, 'business_id', biz, 'hostname', d.hostname, 'token', d.verification_token, 'status', d.status));
end $$;

-- תוצאת בדיקה (service_role בלבד, נקרא אחרי שה-API בדק DNS ו-HTTPS בפועל)
create function public.rpc_domain_record(p jsonb) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare d business_domains; txt boolean := coalesce((p ->> 'txt_ok')::boolean, false); routed boolean := coalesce((p ->> 'routed')::boolean, false);
        err text := nullif(app.jtext(p, 'error'), ''); old text; ns text;
begin
  select * into d from business_domains where id = app.jint(p, 'id', 1, 1000000000) and business_id = (p ->> 'business_id')::uuid for update;
  if d.id is null then return app.err(404, 'not_found', 'הדומיין לא נמצא'); end if;
  old := d.status;
  if err is not null and err !~ '^[a-z_]{1,40}$' then err := 'check_failed'; end if;
  if not txt then ns := case when old in ('verified', 'active') then 'failed' else old end; err := coalesce(err, 'txt_missing');
  elsif not routed then ns := 'verified'; err := coalesce(err, 'not_routed');
  else ns := 'active'; err := null; end if;
  begin
    update business_domains set status = ns, last_error = err, last_check_at = now(),
        verified_at = case when ns in ('verified', 'active') then coalesce(verified_at, now()) else verified_at end,
        activated_at = case when ns = 'active' then coalesce(activated_at, now()) else null end
      where id = d.id returning * into d;
  exception when unique_violation then
    update business_domains set status = 'failed', last_error = 'domain_taken', last_check_at = now() where id = d.id returning * into d;
  end;
  if d.status is distinct from old then perform app.audit('domain.status', d.business_id, 'domain', d.id::text, jsonb_build_object('from', old, 'to', d.status), null); end if;
  return app.ok(app.domain_row(d));
end $$;

-- ---------- ניתוב לפי דומיין (service_role בלבד): host → slug ציבורי. אין כאן שום הרשאה נוספת ----------
create function public.rpc_public_resolve_host(p_host text) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare b businesses; t templates;
begin
  select b2.* into b from business_domains d join businesses b2 on b2.id = d.business_id
   where d.hostname = lower(btrim(coalesce(p_host, ''))) and d.status = 'active' and b2.active;
  if b.id is null then return app.err(404, 'not_found', 'הדומיין אינו מחובר'); end if;
  select * into t from templates where key = b.template;
  return app.ok(jsonb_build_object('slug', b.slug, 'kind', t.kind));
end $$;

create function public.rpc_public_active_domains() returns jsonb
language sql stable security definer set search_path = public, pg_temp as
$$ select app.ok(jsonb_build_object('hosts', coalesce((select jsonb_agg(d.hostname order by d.hostname)
     from business_domains d join businesses b on b.id = d.business_id where d.status = 'active' and b.active), '[]'))) $$;

create or replace function public.rpc_super_businesses() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform app.require_super();
  return app.ok(jsonb_build_object('shops', coalesce((
    select jsonb_agg(jsonb_build_object('id', b.id, 'slug', b.slug, 'name', b.name, 'template', b.template, 'kind', (select t.kind from templates t where t.key = b.template), 'phone', b.phone,
       'address', b.address, 'active', b.active, 'track', b.track, 'domains', coalesce((select jsonb_agg(jsonb_build_object('hostname', d.hostname, 'status', d.status) order by d.id) from business_domains d where d.business_id = b.id), '[]'), 'created_at', b.created_at,
       'owner_emails', (select string_agg(u.email, ', ') from platform_users pu join auth.users u on u.id = pu.user_id where pu.business_id = b.id),
       'barbers',   (select count(*) from staff s where s.business_id = b.id and s.active),
       'services',  (select count(*) from services v where v.business_id = b.id and v.active),
       'customers', (select count(*) from customers c where c.business_id = b.id),
       'upcoming',  (select count(*) from appointments a where a.business_id = b.id and a.status = 'confirmed' and a.date >= app.local_date(b.timezone)))
       order by b.created_at desc) from businesses b), '[]')));
end $$;

create or replace function public.rpc_admin_export_business(p_business uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare b businesses;
begin
  select * into b from businesses where id = p_business;
  if b.id is null then return app.err(404, 'not_found', 'העסק לא נמצא'); end if;
  return app.ok(jsonb_build_object(
    'format', 'platform-business-export', 'version', 1, 'exported_at', now(),
    'business', jsonb_build_object('slug', b.slug, 'name', b.name, 'template', b.template, 'phone', b.phone, 'address', b.address,
        'timezone', b.timezone, 'slot_step', b.slot_step, 'min_notice_min', b.min_notice_min, 'max_days_ahead', b.max_days_ahead,
        'cancel_cutoff_hours', b.cancel_cutoff_hours, 'brand', b.brand, 'track', b.track),
    'staff',          coalesce((select jsonb_agg(to_jsonb(x) - 'business_id' order by x.id) from staff x where x.business_id = b.id), '[]'),
    'services',       coalesce((select jsonb_agg(to_jsonb(x) - 'business_id' order by x.id) from services x where x.business_id = b.id), '[]'),
    'working_hours',  coalesce((select jsonb_agg(to_jsonb(x) - 'business_id') from working_hours x where x.business_id = b.id), '[]'),
    'blocks',         coalesce((select jsonb_agg(to_jsonb(x) - 'business_id' order by x.id) from blocks x where x.business_id = b.id), '[]'),
    'customers',      coalesce((select jsonb_agg(to_jsonb(x) - 'business_id' order by x.id) from customers x where x.business_id = b.id), '[]'),
    'appointments',   coalesce((select jsonb_agg(to_jsonb(x) - 'business_id' order by x.id) from appointments x where x.business_id = b.id), '[]'),
    'leads',          coalesce((select jsonb_agg(to_jsonb(x) - 'business_id' order by x.id) from leads x where x.business_id = b.id), '[]')));
end $$;

-- ייבוא עסק: כולל brand ו-track
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
  insert into businesses (slug, name, template, phone, address, timezone, slot_step, min_notice_min, max_days_ahead, cancel_cutoff_hours, brand, track)
  values (sl, bj ->> 'name', bj ->> 'template', bj ->> 'phone', bj ->> 'address', coalesce(bj ->> 'timezone', 'Asia/Jerusalem'),
          (bj ->> 'slot_step')::int, (bj ->> 'min_notice_min')::int, (bj ->> 'max_days_ahead')::int, (bj ->> 'cancel_cutoff_hours')::int,
          coalesce(bj -> 'brand', '{}'), coalesce(nullif(bj ->> 'track', ''), 'managed'))
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

-- ---------- הרשאות ----------
revoke all on function
  public.rpc_super_draft_create(jsonb), public.rpc_super_draft_list(), public.rpc_super_draft_get(uuid), public.rpc_super_draft_save(uuid,jsonb),
  public.rpc_super_draft_discard(uuid), public.rpc_super_check_fresh_mfa(), public.rpc_super_find_user(jsonb), public.rpc_super_draft_set_owner(uuid,jsonb), public.rpc_super_draft_publish(uuid),
  public.rpc_domain_list(uuid,jsonb), public.rpc_domain_add(uuid,jsonb), public.rpc_domain_remove(uuid,jsonb), public.rpc_domain_check_target(uuid,jsonb),
  public.rpc_domain_record(jsonb), public.rpc_public_resolve_host(text), public.rpc_public_active_domains()
from public, anon, authenticated, service_role;
grant execute on function
  public.rpc_super_draft_create(jsonb), public.rpc_super_draft_list(), public.rpc_super_draft_get(uuid), public.rpc_super_draft_save(uuid,jsonb),
  public.rpc_super_draft_discard(uuid), public.rpc_super_check_fresh_mfa(), public.rpc_super_find_user(jsonb), public.rpc_super_draft_set_owner(uuid,jsonb), public.rpc_super_draft_publish(uuid),
  public.rpc_domain_list(uuid,jsonb), public.rpc_domain_add(uuid,jsonb), public.rpc_domain_remove(uuid,jsonb), public.rpc_domain_check_target(uuid,jsonb)
to authenticated;
grant execute on function public.rpc_domain_record(jsonb), public.rpc_public_resolve_host(text), public.rpc_public_active_domains() to service_role;
