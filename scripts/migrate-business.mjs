#!/usr/bin/env node
// העברת נתוני עסק בודד בין שני פרויקטי Supabase (מסלול מנוהל <-> מסלול רכישה חד-פעמית), עם הקפאת כתיבה ואימות לפני פתיחה.
// מעביר נתוני עסק בלבד: שירותים, צוות, שעות, חסימות, לקוחות, תורים (כולל token_hash), פניות. לא מעביר חשבונות Auth, סיסמאות, מפתחות, דומיינים.
// שימוש:
//   node scripts/migrate-business.mjs --business-id <uuid> [--new-slug gold2] [--release] [--dry-run] [--out export.json]
// בלי --release היעד נשאר קפוא אחרי אימות מוצלח (שחרור ידני: מסך "פלטפורמה" ← שחרור הקפאה). המקור נשאר קפוא תמיד.
// משתנים: SRC_SUPABASE_URL, SRC_SERVICE_ROLE_KEY, DST_SUPABASE_URL, DST_SERVICE_ROLE_KEY
import { writeFileSync, chmodSync } from 'node:fs';
import { createRest } from '../lib/clients/supabase-rest.mjs';
import { migrateBusiness } from '../lib/migrate.mjs';

const a = process.argv.slice(2);
const arg = (k) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };
const flag = (k) => a.includes(k);
const bizId = arg('--business-id'), newSlug = arg('--new-slug'), dry = flag('--dry-run'), release = flag('--release');
if (!bizId || !/^[0-9a-f-]{36}$/i.test(bizId)) { console.error('חובה: --business-id (UUID)'); process.exit(2); }
const need = (k) => { const v = process.env[k]; if (!v) { console.error('חסר משתנה: ' + k); process.exit(2); } return v; };
const src = createRest({ url: need('SRC_SUPABASE_URL'), anonKey: 'unused', serviceKey: need('SRC_SERVICE_ROLE_KEY') });
const dst = dry ? null : createRest({ url: need('DST_SUPABASE_URL'), anonKey: 'unused', serviceKey: need('DST_SERVICE_ROLE_KEY') });
try {
  const r = await migrateBusiness({ src, dst, bizId, newSlug, release, dryRun: dry, log: (m) => console.log('•', m) });
  if (r.dryRun) {
    const out = arg('--out'); if (out) { writeFileSync(out, JSON.stringify(r.exported), { mode: 0o600 }); try { chmodSync(out, 0o600); } catch {} console.log(`יוצא ל-${out} (הרשאות 600; מכיל נתוני לקוחות – אל תשמרו בגיט ומחקו אחרי ההעברה)`); }
    process.exit(0);
  }
  if (!r.ok) { console.error('האימות נכשל. היעד והמקור נשארים קפואים. הבדלים:\n' + r.diffs.join('\n')); process.exit(1); }
  console.log('האימות עבר (ספירות ו-hash זהים).', JSON.stringify(r.counts));
  console.log(r.released ? 'היעד שוחרר.' : 'היעד עדיין קפוא: שייכו Owner, בדקו קישור אישי אחד, ואז שחררו.');
  console.log('המקור נשאר קפוא. אחרי תקופת הסתמכות: השבתה/מחיקה (docs/HANDOVER.md).');
} catch (e) { console.error('ההעברה נכשלה:', e.message); process.exit(1); }
