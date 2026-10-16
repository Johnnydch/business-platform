-- בדיקות בלבד: מאפשר להקפיא את "עכשיו" דרך GUC. אינו חלק מהמיגרציות ולא נפרס.
create or replace function app.now_utc() returns timestamptz language sql stable as
$$ select coalesce(nullif(current_setting('app.test_now', true), '')::timestamptz, now()) $$;
