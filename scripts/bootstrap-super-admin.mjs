#!/usr/bin/env node
// הקמת מנהל הפלטפורמה הראשון (פעם אחת לכל פרויקט Supabase).
//   SUPABASE_URL=… SUPABASE_ANON_KEY=… SUPABASE_SERVICE_ROLE_KEY=… node scripts/bootstrap-super-admin.mjs --email you@example.com
// הסיסמה נקראת בהקלדה מוסתרת (טרמינל) או מ-stdin (--password-stdin). לא מתקבלת כארגומנט ולא כמשתנה סביבה, ואינה מודפסת.
import { createRest } from '../lib/clients/supabase-rest.mjs';
import { createAuth } from '../lib/clients/supabase-auth.mjs';
import { bootstrapSuperAdmin } from '../lib/admin-setup.mjs';

const a = process.argv.slice(2);
const email = a[a.indexOf('--email') + 1];
const need = (k) => { const v = process.env[k]; if (!v) { console.error('חסר משתנה סביבה: ' + k); process.exit(2); } return v; };
if (!email || a.indexOf('--email') < 0) { console.error('שימוש: --email <כתובת> [--password-stdin]'); process.exit(2); }
const url = need('SUPABASE_URL').replace(/\/$/, ''), anonKey = need('SUPABASE_ANON_KEY'), serviceKey = need('SUPABASE_SERVICE_ROLE_KEY');
if (anonKey === serviceKey) { console.error('מפתחות anon ו-service_role חייבים להיות שונים'); process.exit(2); }

async function readPassword() {
  if (a.includes('--password-stdin') || !process.stdin.isTTY) { let s = ''; for await (const d of process.stdin) s += d; return s.replace(/\r?\n$/, ''); }
  return new Promise((resolve) => {
    process.stdout.write('סיסמה (לפחות 14 תווים, לא תוצג): '); process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.setEncoding('utf8');
    let s = '';
    process.stdin.on('data', (ch) => {
      for (const c of ch) {
        if (c === '\r' || c === '\n') { process.stdin.setRawMode(false); process.stdin.pause(); process.stdout.write('\n'); return resolve(s); }
        if (c === '\u0003') process.exit(130);
        if (c === '\u007f') s = s.slice(0, -1); else s += c;
      }
    });
  });
}

try {
  const password = await readPassword();
  const r = await bootstrapSuperAdmin({ rest: createRest({ url, anonKey, serviceKey }), auth: createAuth({ url, anonKey, serviceKey }), email, password });
  console.log(`נוצר מנהל פלטפורמה: ${r.email}\nהצעד הבא: התחברו ל-/admin, והגדירו אימות דו-שלבי (חובה) באפליקציית אימות.`);
} catch (e) { console.error('נכשל:', e.message); process.exit(1); }
