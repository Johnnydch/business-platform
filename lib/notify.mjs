// שכבת הודעות. אין ספק SMS/WhatsApp מחובר, ולכן לא נשלחת שום הודעה ולא מוצג שהתבצעה שליחה.
// לאחר חיבור ספק (למשל Twilio / WhatsApp Cloud API) – לממש כאן את השליחה ולהחזיר configured:true.
export function status() { return { sms: false, whatsapp: false, configured: false }; }
export async function sendBookingConfirmation() {
  if (!status().configured) return { sent: false, reason: 'provider_not_configured' };
  return { sent: false, reason: 'not_implemented' };
}
