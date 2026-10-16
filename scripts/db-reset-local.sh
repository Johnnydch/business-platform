#!/usr/bin/env bash
# בונה מסד Postgres מקומי נקי לבדיקות: shim של Supabase + כל המיגרציות + עוגן-זמן לבדיקות.
# שימוש: PGHOST=... PGPORT=... PGUSER=... scripts/db-reset-local.sh [dbname]
set -euo pipefail
DB="${1:-platform_test}"
cd "$(dirname "$0")/.."
psql -v ON_ERROR_STOP=1 -q -d postgres -c "drop database if exists $DB with (force)" -c "create database $DB"
run() { psql -v ON_ERROR_STOP=1 -q -d "$DB" -f "$1" >/dev/null; }
run supabase/tests/support/00_supabase_shim.sql
for f in supabase/migrations/*.sql; do
  if [ -n "${SKIP_MIGRATION:-}" ] && [[ "$f" == *"$SKIP_MIGRATION"* ]]; then echo "skip $f"; continue; fi
  echo "apply $f"; run "$f"
done
run supabase/tests/support/10_test_now.sql
echo "ready: $DB"
