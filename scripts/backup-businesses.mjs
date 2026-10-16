#!/usr/bin/env node
// גיבוי לוגי לפי עסק (מסלול מנוהל): כל עסק לקובץ JSON נפרד (הרשאות 600), באותו פורמט של הייצוא להגירה (ניתן לשחזור בייבוא).
//   SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… node scripts/backup-businesses.mjs <outDir>
// הקבצים מכילים נתוני לקוחות אמיתיים: אחסנו מוצפן, מחוץ לגיט, והגבילו גישה. זה משלים (ואינו מחליף) גיבוי המסד של Supabase.
import { mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { createRest } from '../lib/clients/supabase-rest.mjs';
const need = (k) => { const v = process.env[k]; if (!v) { console.error('חסר משתנה סביבה: ' + k); process.exit(2); } return v; };
const dir = process.argv[2]; if (!dir) { console.error('שימוש: backup-businesses.mjs <outDir>'); process.exit(2); }
const rest = createRest({ url: need('SUPABASE_URL').replace(/\/$/, ''), anonKey: 'unused', serviceKey: need('SUPABASE_SERVICE_ROLE_KEY') });
mkdirSync(dir, { recursive: true, mode: 0o700 });
const list = (await rest.service('rpc_admin_list_businesses', {})); const bs = (list.data ?? list).businesses.filter((b) => !b.is_demo);
const stamp = new Date().toISOString().slice(0, 10); let n = 0;
for (const b of bs) {
  const exp = await rest.service('rpc_admin_export_business', { p_business: b.id });
  if (exp && exp.ok === false) { console.error(`נכשל: ${b.slug}`); process.exitCode = 1; continue; }
  const f = join(dir, `${b.slug}-${stamp}.json`); writeFileSync(f, JSON.stringify(exp.data ?? exp), { mode: 0o600 }); try { chmodSync(f, 0o600); } catch {} n++;
}
console.log(`גובו ${n} עסקים ל-${dir}`);
