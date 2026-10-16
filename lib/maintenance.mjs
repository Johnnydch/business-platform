// תחזוקה תקופתית: מחיקת מוני הגבלת קצב שפגו ורשומות ביקורת ישנות (מעל 400 יום). רץ כ-Netlify Scheduled Function או ידנית.
export async function runMaintenance(rest) {
  const env = await rest.service('rpc_maintenance_cleanup', {});
  if (!env || !env.ok) throw new Error('maintenance failed: ' + JSON.stringify(env && env.error));
  return env.data;
}
