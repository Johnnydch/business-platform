-- שחזור מינימלי של מה ש-Supabase מספק (לבדיקות מקומיות בלבד – לא להריץ ב-Supabase אמיתי):
-- רולים anon/authenticated/service_role, סכמת auth.users ו-auth.uid()/auth.jwt() באותה סמנטיקה של PostgREST.
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end $$;
create schema if not exists auth;
create table if not exists auth.users (id uuid primary key default gen_random_uuid(), email text unique, created_at timestamptz default now());
create table if not exists auth.mfa_factors (id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id) on delete cascade,
  factor_type text not null default 'totp', status text not null default 'unverified', created_at timestamptz default now());
create or replace function auth.jwt() returns jsonb language sql stable as
$$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
create or replace function auth.uid() returns uuid language sql stable as
$$ select nullif(auth.jwt() ->> 'sub', '')::uuid $$;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid(), auth.jwt() to anon, authenticated, service_role;
