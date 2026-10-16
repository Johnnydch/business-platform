-- =====================================================================
-- 0001 · ליבת הפלטפורמה: עסקים, משתמשי ניהול, קטלוג תבניות, הגבלת קצב משותפת
-- יעד: Supabase (Postgres 15+). כל הטבלאות מוגנות ב-RLS.
-- =====================================================================
create schema if not exists app;          -- פונקציות עזר פנימיות – לא נחשפות ל-PostgREST
create schema if not exists extensions;   -- קיים ב-Supabase
create extension if not exists pgcrypto   with schema extensions;
create extension if not exists btree_gist with schema extensions;

-- ---------- קטלוג תבניות ----------
create table public.templates (
  key              text primary key check (key ~ '^[a-z][a-z0-9-]{1,30}$'),
  name             text   not null,
  kind             text   not null check (kind in ('booking','leads','catalog')),
  status           text   not null default 'planned' check (status in ('available','planned')),
  theme            text   not null default 'default',
  labels           jsonb  not null default '{}',   -- תוויות ממשק (ספר/קוסמטיקאית/צוות וכו')
  default_services jsonb  not null default '[]',   -- שירותי ברירת מחדל לעסק חדש
  sort             int    not null default 0
);

-- ---------- עסקים (דיירים) ----------
create table public.businesses (
  id                  uuid primary key default gen_random_uuid(),
  slug                text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and char_length(slug) between 3 and 40),
  name                text not null check (char_length(name) between 2 and 60),
  template            text not null references public.templates(key),
  phone               text check (phone is null or phone ~ '^[0-9+() \-]{7,20}$'),
  address             text check (address is null or char_length(address) between 2 and 120),
  timezone            text not null default 'Asia/Jerusalem',
  active              boolean not null default true,
  slot_step           int not null default 15 check (slot_step in (5,10,15,20,30,60)),
  min_notice_min      int not null default 30  check (min_notice_min between 0 and 1440),
  max_days_ahead      int not null default 30  check (max_days_ahead between 1 and 180),
  cancel_cutoff_hours int not null default 2   check (cancel_cutoff_hours between 0 and 72),
  created_at          timestamptz not null default now()
);

-- ---------- משתמשי ניהול (Super Admin / Owner). לקוחות אינם משתמשים. ----------
create table public.platform_users (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  role        text not null check (role in ('super_admin','owner')),
  business_id uuid references public.businesses(id) on delete cascade,
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  check ((role = 'super_admin' and business_id is null) or (role = 'owner' and business_id is not null))
);
create index on public.platform_users (business_id);

-- ---------- הגבלת קצב משותפת (חלון קבוע, אטומית; מפתחות מגובבים – ללא IP/נייד גולמי) ----------
create table public.rate_limits (
  key        text        not null,
  bucket     bigint      not null,
  n          int         not null default 0,
  expires_at timestamptz not null,
  primary key (key, bucket)
);
create index on public.rate_limits (expires_at);

-- ---------- תוצאות אחידות ל-RPC: שגיאות עסקיות מוחזרות (לא נזרקות) כדי שמוני הקצב יישמרו ----------
create function app.ok(d jsonb default '{}'::jsonb) returns jsonb language sql immutable as
$$ select jsonb_build_object('ok', true, 'data', d) $$;

create function app.err(p_status int, p_code text, p_msg text, p_fields jsonb default null) returns jsonb
language sql immutable as
$$ select jsonb_build_object('ok', false, 'status', p_status,
     'error', jsonb_strip_nulls(jsonb_build_object('code', p_code, 'message', p_msg, 'fields', p_fields))) $$;

-- ---------- זמן (ניתן להחלפה בבדיקות בלבד דרך קובץ בדיקה נפרד) ----------
create function app.now_utc() returns timestamptz language sql stable as $$ select now() $$;
create function app.local_date(tz text) returns date language sql stable as
$$ select (app.now_utc() at time zone tz)::date $$;
create function app.local_min(tz text) returns int language sql stable as
$$ select (extract(hour from (app.now_utc() at time zone tz)) * 60 + extract(minute from (app.now_utc() at time zone tz)))::int $$;
create function app.local_ts(d date, m int, tz text) returns timestamptz language sql stable as
$$ select (d::timestamp + make_interval(mins => m)) at time zone tz $$;

-- ---------- ולידציה (מקור אמת יחיד, בצד מסד הנתונים) ----------
-- נייד ישראלי: 05X-XXXXXXX / +972 5X-XXXXXXX. מחזיר 05XXXXXXXX או NULL.
create function app.normalize_phone(raw text) returns text language plpgsql immutable as $$
declare s text;
begin
  if raw is null then return null; end if;
  s := regexp_replace(btrim(raw), '[\s\-().]', '', 'g');
  if s like '+972%' then s := substr(s, 5);
  elsif s like '00972%' then s := substr(s, 6);
  elsif s like '972%' then s := substr(s, 4);
  elsif s not like '0%' then return null; end if;
  if s not like '0%' then s := '0' || s; end if;
  if s !~ '^05[0-9]{8}$' then return null; end if;
  if substr(s, 4) ~ '^([0-9])\1{6}$' then return null; end if;   -- 7 ספרות זהות = פיקטיבי
  return s;
end $$;

-- שם: אותיות עבריות/לטיניות/ערביות, רווח, גרש, מקף, נקודה; 2–40 תווים. ללא תלות ב-locale.
create function app.clean_name(v text) returns text language plpgsql immutable as $$
declare s text;
begin
  if v is null then return null; end if;
  s := regexp_replace(btrim(v), '\s+', ' ', 'g');
  if s ~ '^[A-Za-zÀ-ɏ֐-׿؀-ۿ][A-Za-zÀ-ɏ֐-׿؀-ۿ''’״׳" .\-]{0,38}[A-Za-zÀ-ɏ֐-׿؀-ۿ]$'
  then return s; end if;
  return null;
end $$;

create function app.clean_text(v text, lo int, hi int) returns text language plpgsql immutable as $$
declare s text;
begin
  if v is null then return null; end if;
  s := regexp_replace(btrim(v), '\s+', ' ', 'g');
  if char_length(s) between lo and hi and s !~ '[<>]' then return s; end if;
  return null;
end $$;

-- מספר שלם בטווח מתוך jsonb (מקבל מספר או מחרוזת מספרית); אחרת NULL
create function app.jint(j jsonb, k text, lo bigint, hi bigint) returns bigint language plpgsql immutable as $$
declare t text; n numeric;
begin
  if j is null or not (j ? k) then return null; end if;
  if jsonb_typeof(j -> k) not in ('number','string') then return null; end if;
  t := j ->> k;
  if t !~ '^-?[0-9]{1,15}$' then return null; end if;
  n := t::numeric;
  if n < lo or n > hi then return null; end if;
  return n::bigint;
end $$;

create function app.jtext(j jsonb, k text) returns text language sql immutable as
$$ select case when jsonb_typeof(j -> k) = 'string' then j ->> k else null end $$;

create function app.jdate(j jsonb, k text) returns date language plpgsql immutable as $$
declare t text;
begin
  t := app.jtext(j, k);
  if t is null or t !~ '^\d{4}-\d{2}-\d{2}$' then return null; end if;
  begin return t::date; exception when others then return null; end;
end $$;

-- ---------- אסימונים: אקראי קריפטוגרפי, נשמר רק כ-SHA-256 ----------
create function app.new_token() returns text language sql volatile as
$$ select translate(encode(extensions.gen_random_bytes(32), 'base64'), E'+/=\n', '-_') $$;   -- 43 תווים, 256 ביט
create function app.hash_token(t text) returns text language sql immutable as
$$ select encode(extensions.digest(t, 'sha256'), 'hex') $$;

-- ---------- הגבלת קצב ----------
-- מגדיל מונה בחלון הנוכחי ומחזיר true אם עדיין בתוך המכסה.
create function app.rl_hit(p_key text, p_max int, p_window_s int) returns boolean
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare b bigint := floor(extract(epoch from now()) / p_window_s); v int;
begin
  insert into rate_limits as r (key, bucket, n, expires_at)
    values (p_key, b, 1, to_timestamp((b + 1) * p_window_s))
    on conflict (key, bucket) do update set n = r.n + 1 returning n into v;
  if random() < 0.01 then   -- ניקוי הדרגתי של חלונות שפגו; חלופה: pg_cron
    delete from rate_limits where expires_at < now() - interval '1 hour';
  end if;
  return v <= p_max;
end $$;

create function app.rl_count(p_key text, p_window_s int) returns int
language sql stable security definer set search_path = public, pg_temp as
$$ select coalesce((select n from rate_limits where key = p_key and bucket = floor(extract(epoch from now()) / p_window_s)), 0) $$;

-- ---------- הרשאות: פונקציות עזר ל-RLS ----------
create function app.is_super() returns boolean language sql stable security definer set search_path = public, pg_temp as
$$ select exists (select 1 from platform_users where user_id = auth.uid() and role = 'super_admin' and active) $$;

-- העסק של ה-Owner המחובר; NULL אם אינו Owner פעיל או שהעסק מושבת
create function app.my_business() returns uuid language sql stable security definer set search_path = public, pg_temp as
$$ select pu.business_id from platform_users pu join businesses b on b.id = pu.business_id
   where pu.user_id = auth.uid() and pu.role = 'owner' and pu.active and b.active $$;

-- מזהה העסק לפעולה: Owner – תמיד העסק שלו (פרמטר מתעלמים); Super Admin – חייב לציין עסק.
create function app.resolve_business(p_business uuid) returns uuid
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
  if b is null then raise exception 'forbidden' using errcode = '42501'; end if;
  return b;
end $$;

-- ---------- RLS: קטלוג, עסקים, משתמשי ניהול ----------
alter table public.templates      enable row level security;
alter table public.businesses     enable row level security;
alter table public.platform_users enable row level security;
alter table public.rate_limits    enable row level security;   -- ללא מדיניות: גישה רק דרך פונקציות

create policy templates_read on public.templates for select to authenticated using (true);
create policy businesses_read on public.businesses for select to authenticated
  using (id = (select app.my_business()) or (select app.is_super()));
create policy businesses_owner_update on public.businesses for update to authenticated
  using (id = (select app.my_business())) with check (id = (select app.my_business()));
create policy platform_users_self on public.platform_users for select to authenticated
  using (user_id = auth.uid() or (select app.is_super()));
