-- =====================================================================
-- 0002 · טבלאות דיירים + RLS + מנוע הזמנות
-- עיקרון: כל שורה שייכת ל-business_id. מפתחות זרים מורכבים (id, business_id)
-- מונעים התייחסות בין עסקים גם אם יש באג בקוד האפליקציה.
-- =====================================================================

create table public.staff (               -- אנשי צוות (ברברשופ: "ספרים")
  id          bigint generated always as identity primary key,
  business_id uuid not null references public.businesses(id) on delete cascade,
  name        text not null check (char_length(name) between 2 and 40),
  active      boolean not null default true,
  sort        int not null default 0,
  unique (id, business_id)
);
create index on public.staff (business_id);

create table public.services (
  id           bigint generated always as identity primary key,
  business_id  uuid not null references public.businesses(id) on delete cascade,
  name         text not null check (char_length(name) between 2 and 60),
  duration_min int  not null check (duration_min between 5 and 480),
  price_ils    int  not null default 0 check (price_ils between 0 and 100000),
  active       boolean not null default true,
  unique (id, business_id)
);
create index on public.services (business_id);

create table public.working_hours (
  staff_id    bigint not null,
  business_id uuid   not null,
  weekday     int    not null check (weekday between 0 and 6),   -- 0 = ראשון
  start_min   int    not null check (start_min >= 0),
  end_min     int    not null check (end_min <= 1440),
  primary key (staff_id, weekday),
  check (end_min > start_min),
  foreign key (staff_id, business_id) references public.staff(id, business_id) on delete cascade
);
create index on public.working_hours (business_id);

create table public.blocks (              -- חסימות יומן (staff_id NULL = כל העסק)
  id          bigint generated always as identity primary key,
  business_id uuid   not null references public.businesses(id) on delete cascade,
  staff_id    bigint,
  date        date   not null,
  start_min   int    not null check (start_min >= 0),
  end_min     int    not null check (end_min <= 1440),
  note        text   check (note is null or char_length(note) <= 120),
  check (end_min > start_min),
  foreign key (staff_id, business_id) references public.staff(id, business_id) on delete cascade
);
create index on public.blocks (business_id, date);

create table public.customers (
  id          bigint generated always as identity primary key,
  business_id uuid not null references public.businesses(id) on delete cascade,
  first_name  text not null,
  last_name   text not null,
  phone       text not null check (phone ~ '^05[0-9]{8}$'),      -- נייד ישראלי מנורמל
  created_at  timestamptz not null default now(),
  unique (business_id, phone),
  unique (id, business_id)
);

create table public.appointments (
  id               bigint generated always as identity primary key,
  business_id      uuid   not null references public.businesses(id) on delete cascade,
  staff_id         bigint not null,
  service_id       bigint not null,
  customer_id      bigint not null,
  date             date   not null,
  start_min        int    not null check (start_min between 0 and 1439),
  end_min          int    not null check (end_min between 1 and 1440),
  service_name     text   not null,
  price_ils        int    not null default 0,
  first_name       text   not null,
  last_name        text   not null,
  status           text   not null default 'confirmed' check (status in ('confirmed','cancelled','completed','no_show')),
  source           text   not null default 'online' check (source in ('online','owner')),
  token_hash       text   unique check (token_hash is null or token_hash ~ '^[0-9a-f]{64}$'),   -- SHA-256 בלבד
  token_expires_at timestamptz,
  token_uses       int    not null default 0,
  notes            text   check (notes is null or char_length(notes) <= 300),
  created_at       timestamptz not null default now(),
  cancelled_at     timestamptz,
  check (end_min > start_min),
  foreign key (staff_id,    business_id) references public.staff(id, business_id),
  foreign key (service_id,  business_id) references public.services(id, business_id),
  foreign key (customer_id, business_id) references public.customers(id, business_id),
  -- הגנת-קצה מפני חפיפה: אותו איש צוות, אותו יום, טווחי דקות חופפים (תור לא מבוטל).
  -- פועל גם תחת בקשות מקבילות לחלוטין, בלי תלות בקוד האפליקציה.
  constraint appointments_no_overlap exclude using gist (
    staff_id with =, date with =, int4range(start_min, end_min) with &&
  ) where (status <> 'cancelled')
);
create index on public.appointments (business_id, date);
create index on public.appointments (customer_id);

create table public.leads (               -- פניות (דפי נחיתה, קטלוג שירותים)
  id          bigint generated always as identity primary key,
  business_id uuid not null references public.businesses(id) on delete cascade,
  name        text not null,
  phone       text not null check (phone ~ '^05[0-9]{8}$'),
  message     text check (message is null or char_length(message) <= 500),
  service_id  bigint,
  source      text not null default 'web',
  status      text not null default 'new' check (status in ('new','contacted','closed')),
  created_at  timestamptz not null default now(),
  foreign key (service_id, business_id) references public.services(id, business_id)
);
create index on public.leads (business_id, created_at desc);

-- ---------- RLS ----------
alter table public.staff         enable row level security;
alter table public.services      enable row level security;
alter table public.working_hours enable row level security;
alter table public.blocks        enable row level security;
alter table public.customers     enable row level security;
alter table public.appointments  enable row level security;
alter table public.leads         enable row level security;

-- CRUD מלא לנתוני התצורה של העסק; Super Admin רואה הכול
create policy staff_all    on public.staff         for all to authenticated
  using (business_id = (select app.my_business()) or (select app.is_super()))
  with check (business_id = (select app.my_business()) or (select app.is_super()));
create policy services_all on public.services      for all to authenticated
  using (business_id = (select app.my_business()) or (select app.is_super()))
  with check (business_id = (select app.my_business()) or (select app.is_super()));
create policy hours_all    on public.working_hours for all to authenticated
  using (business_id = (select app.my_business()) or (select app.is_super()))
  with check (business_id = (select app.my_business()) or (select app.is_super()));
create policy blocks_all   on public.blocks        for all to authenticated
  using (business_id = (select app.my_business()) or (select app.is_super()))
  with check (business_id = (select app.my_business()) or (select app.is_super()));

-- לקוחות, תורים, פניות: קריאה בלבד + עדכון שדות מוגבלים. יצירה רק דרך RPC (לוגיקה + נעילה).
create policy customers_read on public.customers   for select to authenticated
  using (business_id = (select app.my_business()) or (select app.is_super()));
create policy appts_read     on public.appointments for select to authenticated
  using (business_id = (select app.my_business()) or (select app.is_super()));
create policy appts_update   on public.appointments for update to authenticated
  using (business_id = (select app.my_business()) or (select app.is_super()))
  with check (business_id = (select app.my_business()) or (select app.is_super()));
create policy leads_read     on public.leads        for select to authenticated
  using (business_id = (select app.my_business()) or (select app.is_super()));
create policy leads_update   on public.leads        for update to authenticated
  using (business_id = (select app.my_business()) or (select app.is_super()))
  with check (business_id = (select app.my_business()) or (select app.is_super()));

-- ---------- מנוע הזמינות ----------
-- שעות פנויות אמיתיות: שעות עבודה פחות תורים פעילים ופחות חסימות; מכבד זמן התראה ואופק הזמנה.
create function app.slots_for(p_biz uuid, p_staff bigint, p_date date, p_dur int,
                              p_exclude bigint default 0, p_ignore_limits boolean default false)
returns int[] language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare b businesses%rowtype; today date; nowmin int; wh working_hours%rowtype; earliest int; res int[];
begin
  select * into b from businesses where id = p_biz;
  if not found then return '{}'; end if;
  today := app.local_date(b.timezone); nowmin := app.local_min(b.timezone);
  if p_date < today then return '{}'; end if;
  if not p_ignore_limits and (p_date - today) > b.max_days_ahead then return '{}'; end if;
  select * into wh from working_hours where staff_id = p_staff and business_id = p_biz and weekday = extract(dow from p_date)::int;
  if not found then return '{}'; end if;
  earliest := case when p_ignore_limits then 0 when p_date = today then nowmin + b.min_notice_min else 0 end;
  select coalesce(array_agg(g order by g), '{}') into res
  from generate_series(wh.start_min, wh.end_min - p_dur, b.slot_step) g
  where g >= earliest
    and not exists (select 1 from appointments a
                    where a.staff_id = p_staff and a.date = p_date and a.status <> 'cancelled'
                      and a.id <> p_exclude and a.start_min < g + p_dur and a.end_min > g)
    and not exists (select 1 from blocks k
                    where k.business_id = p_biz and k.date = p_date and (k.staff_id = p_staff or k.staff_id is null)
                      and k.start_min < g + p_dur and k.end_min > g);
  return res;
end $$;

create function app.slot_taken() returns jsonb language sql immutable as
$$ select app.err(409, 'slot_taken', 'השעה שנבחרה כבר אינה פנויה. נא לבחור שעה אחרת.') $$;

-- יצירת תור אטומית. נעילת-ייעוץ לכל איש צוות מסדרת בקשות מקבילות; אילוץ ה-EXCLUDE הוא רשת הביטחון.
-- מחזיר מעטפת {ok,...}; את הטוקן הגולמי מחזירים פעם אחת בלבד (במסד נשמר hash).
create function app.create_appointment(p_biz uuid, p_staff bigint, p_service bigint, p_date date, p_start int,
                                       p_first text, p_last text, p_phone text, p_source text, p_notes text default null)
returns jsonb language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare b businesses%rowtype; st staff%rowtype; sv services%rowtype; cu bigint; tok text; endm int;
        up int; newid bigint;
begin
  select * into b from businesses where id = p_biz and active;
  if not found then return app.err(404, 'shop_not_found', 'העסק לא נמצא'); end if;
  select * into st from staff where id = p_staff and business_id = p_biz and active;
  if not found then return app.err(400, 'barber_unavailable', 'איש הצוות שנבחר אינו זמין'); end if;
  select * into sv from services where id = p_service and business_id = p_biz and active;
  if not found then return app.err(400, 'service_unavailable', 'השירות שנבחר אינו זמין'); end if;

  perform pg_advisory_xact_lock(hashtextextended('appt:' || p_staff::text, 0));

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
  tok := case when p_source = 'online' then app.new_token() end;
  begin
    insert into appointments (business_id, staff_id, service_id, customer_id, date, start_min, end_min, service_name,
                              price_ils, first_name, last_name, status, source, token_hash, token_expires_at, notes)
    values (p_biz, p_staff, p_service, cu, p_date, p_start, endm, sv.name, sv.price_ils, p_first, p_last, 'confirmed', p_source,
            case when tok is not null then app.hash_token(tok) end,
            case when tok is not null then app.local_ts(p_date, p_start + 120, b.timezone) end,   -- תקף עד שעתיים אחרי התור
            p_notes)
    returning id into newid;
  exception when exclusion_violation or unique_violation then
    return app.slot_taken();
  end;
  return app.ok(jsonb_build_object('id', newid, 'token', tok, 'shop_name', b.name, 'barber_name', st.name,
      'service_name', sv.name, 'first_name', p_first, 'price_ils', sv.price_ils, 'date', p_date, 'start_min', p_start,
      'end_min', endm, 'duration_min', sv.duration_min));
end $$;
