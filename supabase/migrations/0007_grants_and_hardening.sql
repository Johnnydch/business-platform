-- =====================================================================
-- 0007 · הרשאות. עיקרון: anon לא רואה כלום. הדפדפן אינו מחזיק מפתח עם גישה לנתוני דיירים.
--   anon          – אין גישה לטבלאות ואין EXECUTE על שום פונקציה
--   authenticated – Owner/Super Admin, מוגבל ב-RLS ובהרשאות עמודה
--   service_role  – שרת בלבד (Netlify Functions); קורא ל-RPC הציבוריים
-- =====================================================================
-- איפוס: ב-Supabase ברירות המחדל נותנות הרשאות רחבות ל-anon/authenticated
revoke all on all tables    in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke all on all functions in schema public from public, anon, authenticated;
revoke all on all functions in schema app    from public, anon, authenticated;
-- חשוב: ב-Postgres ברירת המחדל היא EXECUTE ל-PUBLIC על כל פונקציה חדשה, ו-ALTER DEFAULT PRIVILEGES ... IN SCHEMA אינו מבטל אותה.
-- ביטול גלובלי (ל-role שמריץ את המיגרציות). בנוסף, כל מיגרציה שמוסיפה פונקציה ב-public חייבת לבצע REVOKE/GRANT מפורש, ובדיקת ה-ACL ב-CI אוכפת זאת.
alter default privileges revoke execute on functions from public;
alter default privileges in schema public revoke all on tables    from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;
alter default privileges in schema app    revoke execute on functions from public, anon, authenticated;

grant usage on schema public to anon, authenticated, service_role;
grant usage on schema app    to authenticated;

-- טבלאות: קריאה לפי RLS
grant select on public.templates, public.businesses, public.platform_users, public.staff, public.services,
                public.working_hours, public.blocks, public.customers, public.appointments, public.leads to authenticated;
grant insert, update, delete on public.staff, public.services, public.working_hours, public.blocks to authenticated;
grant usage, select on all sequences in schema public to authenticated;
-- הרשאות עמודה: Owner לא יכול לשנות slug/active/template/מזהים, ולא לגעת בשדות האסימון של תור
grant update (name, phone, address, slot_step, min_notice_min, max_days_ahead, cancel_cutoff_hours) on public.businesses to authenticated;
grant update (status, notes, cancelled_at) on public.appointments to authenticated;
grant update (status) on public.leads to authenticated;

-- פונקציות עזר ל-RLS ול-RPC מסוג INVOKER (פונקציות טהורות)
grant execute on all functions in schema app to authenticated;
-- פונקציות מנוע מסוג DEFINER: אינן נגישות ישירות ל-authenticated (נקראות רק מתוך RPC שמאמת הרשאה)
revoke execute on function app.create_appointment(uuid,bigint,bigint,date,int,text,text,text,text,text) from authenticated;
revoke execute on function app.slots_for(uuid,bigint,date,int,bigint,boolean) from authenticated;
revoke execute on function app.token_find(text,text) from authenticated;
revoke execute on function app.token_limited(text) from authenticated;
revoke execute on function app.rl_hit(text,int,int) from authenticated;
revoke execute on function app.rl_count(text,int) from authenticated;
revoke execute on function app.biz_by_slug(text) from authenticated;
revoke execute on function app.public_staff(uuid) from authenticated;

-- RPC: ציבוריים ומנהליים → service_role בלבד
grant execute on function
  public.rpc_rate_count(text,int), public.rpc_rate_record(text,int), public.rpc_rate_hit(text,int,int),
  public.rpc_public_businesses(), public.rpc_public_business(text), public.rpc_public_days(text,bigint,bigint),
  public.rpc_public_slots(text,bigint,bigint,date), public.rpc_public_book(jsonb,text,text),
  public.rpc_public_token_get(text,text), public.rpc_public_token_staff(text,text), public.rpc_public_token_slots(text,text,bigint,date),
  public.rpc_public_token_days(text,text,bigint), public.rpc_public_token_cancel(text,text), public.rpc_public_token_reschedule(text,text,jsonb),
  public.rpc_public_submit_lead(jsonb,text,text),
  public.rpc_admin_export_business(uuid), public.rpc_admin_import_business(jsonb,text)
to service_role;

-- RPC: Owner / Super Admin (JWT של Supabase Auth)
grant execute on function
  public.rpc_me(), public.rpc_templates(),
  public.rpc_owner_shop_get(uuid,jsonb), public.rpc_owner_shop_update(uuid,jsonb),
  public.rpc_owner_staff_list(uuid,jsonb), public.rpc_owner_staff_create(uuid,jsonb), public.rpc_owner_staff_update(uuid,jsonb),
  public.rpc_owner_services_list(uuid,jsonb), public.rpc_owner_service_create(uuid,jsonb), public.rpc_owner_service_update(uuid,jsonb),
  public.rpc_owner_appointments(uuid,jsonb), public.rpc_owner_availability(uuid,jsonb), public.rpc_owner_appointment_create(uuid,jsonb),
  public.rpc_owner_appointment_status(uuid,jsonb), public.rpc_owner_blocks(uuid,jsonb), public.rpc_owner_block_create(uuid,jsonb),
  public.rpc_owner_block_delete(uuid,jsonb), public.rpc_owner_customers(uuid,jsonb), public.rpc_owner_dashboard(uuid,jsonb),
  public.rpc_owner_leads(uuid,jsonb), public.rpc_owner_lead_status(uuid,jsonb),
  public.rpc_super_businesses(), public.rpc_super_create_business(jsonb), public.rpc_super_set_active(uuid,jsonb),
  public.rpc_super_owner_ids(uuid), public.rpc_super_delete_business(uuid,jsonb), public.rpc_super_attach_owner(uuid,jsonb)
to authenticated;

notify pgrst, 'reload schema';
