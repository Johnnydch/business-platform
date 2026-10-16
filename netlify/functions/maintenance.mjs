// Netlify Scheduled Function – ניקוי תקופתי. לא נבדק על Netlify אמיתי (ראו docs/DEPLOYMENT.md).
import { loadConfig } from '../../lib/config.mjs';
import { createRest } from '../../lib/clients/supabase-rest.mjs';
import { runMaintenance } from '../../lib/maintenance.mjs';

export default async () => {
  const c = loadConfig(process.env);
  const out = await runMaintenance(createRest({ url: c.supabaseUrl, anonKey: c.anonKey, serviceKey: c.serviceKey }));
  console.log('[maintenance]', JSON.stringify(out));
};
export const config = { schedule: '@hourly' };
