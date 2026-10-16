// עמוד ציבורי לתבניות הפניות: "בעלי מקצוע ושירותי בית" (דף נחיתה, עיר ודחיפות) ו"נותני שירות וסטודיואים" (קטלוג, תקציב ולוח זמנים).
// כל הטקסטים מגיעים מתוויות התבנית. הטופס שומר את הפנייה במסד דרך /api/public/lead; אין התחברות ואין שליחת הודעות.
import { demoBanner, applyTheme, applyBrand, labelsOf, h, mount, api, spinner, toast, fmtPrice, normalizePhone, validName, fmtPhone } from './common.js';

const root = document.getElementById('app');
const slug = decodeURIComponent(location.pathname.split('/')[2] || '');
const F = { name: '', phone: '', message: '', service_id: '', city: '', urgency: '', budget: '', timeframe: '' };

const URGENCY = [['today', 'דחוף – היום'], ['week', 'במהלך השבוע'], ['flexible', 'גמיש']];
const BUDGET = [['lt1k', 'עד \u2066₪1,000\u2069'], ['1-3k', '\u2066₪1,000–3,000\u2069'], ['3-10k', '\u2066₪3,000–10,000\u2069'], ['gt10k', 'מעל \u2066₪10,000\u2069'], ['unknown', 'עדיין לא יודעים']];
const TIMEFRAME = [['asap', 'בהקדם'], ['month', 'תוך חודש'], ['flexible', 'גמיש']];

function chips(key, options, label) {
  const host = h('div', { class: 'chips', role: 'radiogroup', 'aria-label': label });
  const paint = () => host.replaceChildren(...options.map(([v, t]) => h('button', { type: 'button', role: 'radio', 'aria-checked': F[key] === v ? 'true' : 'false', class: 'chip' + (F[key] === v ? ' on' : ''), onclick: () => { F[key] = F[key] === v ? '' : v; paint(); } }, t)));
  paint();
  return host;
}

function view(d) {
  const L = labelsOf(d.shop), kind = L.extra;      // 'home' | 'studio'
  const field = (key, label, el, required) => h('div', { class: 'field' }, h('label', { for: 'f-' + key }, label, ' ', required ? h('b', null, '*') : null), el, h('div', { class: 'errmsg', id: 'e-' + key }));
  const inp = (key, attrs) => h('input', { class: 'inp', id: 'f-' + key, name: key, value: F[key], oninput: (e) => { F[key] = e.target.value; }, ...attrs });
  const svcSel = d.services.length ? h('select', { class: 'inp', id: 'f-service_id', onchange: (e) => { F.service_id = e.target.value; } },
    h('option', { value: '' }, 'לא משנה / לא בטוח'), d.services.map((s) => h('option', { value: s.id }, `${s.name}${s.price_ils ? ' · ' + fmtPrice(s.price_ils) : ''}`))) : null;
  const msg = h('textarea', { class: 'inp', id: 'f-message', rows: 4, maxlength: 500, placeholder: L.msg_placeholder, oninput: (e) => { F.message = e.target.value; } });
  const btn = h('button', { class: 'btn primary block', type: 'submit' }, L.lead_cta);
  const form = h('form', { id: 'lead-form', novalidate: true, onsubmit: submit },
    h('h2', { class: 'h-step' }, L.lead_title),
    field('name', 'שם מלא', inp('name', { autocomplete: 'name', maxlength: 40 }), true),
    field('phone', 'מספר נייד', inp('phone', { type: 'tel', inputmode: 'tel', autocomplete: 'tel', dir: 'ltr', placeholder: '050-0000000', maxlength: 20 }), true),
    kind === 'home' && field('city', 'עיר / יישוב', inp('city', { autocomplete: 'address-level2', maxlength: 40 }), false),
    svcSel && field('service_id', L.service_pick_label, svcSel, false),
    kind === 'home' && field('urgency', 'כמה דחוף?', chips('urgency', URGENCY, 'דחיפות'), false),
    kind === 'studio' && field('budget', 'תקציב משוער', chips('budget', BUDGET, 'תקציב'), false),
    kind === 'studio' && field('timeframe', 'לוח זמנים', chips('timeframe', TIMEFRAME, 'לוח זמנים'), false),
    field('message', L.msg_label, msg, false),
    h('div', { class: 'trap', 'aria-hidden': 'true' }, h('label', null, 'אל תמלאו שדה זה', h('input', { type: 'text', name: 'website', tabindex: '-1', autocomplete: 'off', id: 'f-website' }))),
    h('div', { class: 'notice' }, 'לא נדרש חשבון, מייל או סיסמה. הפרטים משמשים רק ליצירת קשר איתכם.'),
    h('div', { class: 'dock' }, h('div', { class: 'wrap' }, btn)));

  const setErr = (k, t) => { const e = form.querySelector('#e-' + k); if (e) e.textContent = t || ''; const i = form.querySelector('#f-' + k); if (i) i.classList.toggle('err', !!t); };
  async function submit(ev) {
    ev.preventDefault();
    const errs = {};
    ['name', 'phone', 'city', 'message'].forEach((k) => setErr(k, ''));
    const phone = normalizePhone(F.phone);
    if (!validName(F.name)) errs.name = 'נא להזין שם תקין';
    if (!phone) errs.phone = 'נא להזין מספר נייד ישראלי תקין (למשל 054-1234567)';
    if (F.city.trim() && F.city.trim().length < 2) errs.city = 'עיר: לפחות 2 תווים';
    for (const [k, t] of Object.entries(errs)) setErr(k, t);
    if (Object.keys(errs).length) { const el = form.querySelector('#f-' + Object.keys(errs)[0]); if (el) el.focus(); return; }
    btn.disabled = true; btn.textContent = 'שולחים…';
    try {
      await api('/api/public/lead', { method: 'POST', body: {
        slug, name: F.name.trim(), phone, message: F.message.trim() || undefined, service_id: F.service_id || undefined,
        city: kind === 'home' ? F.city.trim() || undefined : undefined, urgency: kind === 'home' ? F.urgency || undefined : undefined,
        budget: kind === 'studio' ? F.budget || undefined : undefined, timeframe: kind === 'studio' ? F.timeframe || undefined : undefined,
        website: form.querySelector('#f-website').value } });
      done();
    } catch (e) {
      btn.disabled = false; btn.textContent = L.lead_cta;
      if (e.fields) Object.entries(e.fields).forEach(([k, t]) => setErr(k, t)); else toast(e.message, 'err');
    }
  }
  function done() {
    window.scrollTo({ top: 0 });
    mount(root, h('div', { class: 'wrap page' }, h('header', { class: 'brand' }, h('div', { class: 'mark' }, d.shop.name)),
      h('div', { class: 'center' }, h('h1', { class: 'gold' }, L.lead_done_title), h('p', { class: 'sub' }, L.lead_done_sub)),
      h('div', { class: 'notice' }, 'הפנייה נשמרה אצל העסק. אישור ב-SMS/WhatsApp אינו נשלח כרגע.'),
      d.shop.phone && h('p', { class: 'center' }, 'לפנייה דחופה: ', h('a', { class: 'ltr', href: `tel:${d.shop.phone}` }, fmtPhone(d.shop.phone)))));
  }

  const catalog = d.services.length
    ? h('section', { 'aria-labelledby': 'cat-h' }, h('h2', { class: 'h-step', id: 'cat-h' }, L.catalog_title),
      h('div', { class: 'list' }, d.services.map((s) => h('div', { class: 'item' }, h('div', { class: 'grow' }, h('div', { class: 't' }, s.name), null), h('div', { class: 'price' }, s.price_ils ? fmtPrice(s.price_ils) : 'לפי הצעה')))))
    : h('div', { class: 'empty' }, 'קטלוג השירותים עדיין לא הוגדר. אפשר להשאיר פנייה ונחזור אליכם.');
  const call = d.shop.phone && h('a', { class: 'btn block callnow ltr', href: `tel:${d.shop.phone}` }, 'התקשרו עכשיו · ' + fmtPhone(d.shop.phone));
  mount(root, h('div', { class: 'wrap page' },
    h('header', { class: 'brand' }, h('div', { class: 'mark' }, L.brand), h('h1', null, d.shop.name),
      (((d.shop.brand && d.shop.brand.tagline) || L.tagline)) && h('p', { class: 'tagline' }, (d.shop.brand && d.shop.brand.tagline) || L.tagline), d.shop.address && h('div', { class: 'addr' }, d.shop.address), h('div', { class: 'orn' }, h('i'))),
    demoBanner(d.shop), call, catalog, form));
}

(async () => {
  mount(root, h('div', { class: 'wrap' }, spinner()));
  try {
    const d = await api(`/api/public/shops/${encodeURIComponent(slug)}`);
    await applyTheme(d.shop.theme); applyBrand(d.shop.brand); document.title = d.shop.name;
    if (d.shop.frozen) { mount(root, h('div', { class: 'wrap page' }, h('header', { class: 'brand' }, h('h1', null, d.shop.name)), h('div', { class: 'notice warn', role: 'status', 'data-frozen': '1' }, 'העסק בתחזוקה זמנית ואינו מקבל פניות כרגע. נסו שוב מאוחר יותר.'))); return; }
    view(d);
  } catch (e) {
    mount(root, h('div', { class: 'wrap' }, h('header', { class: 'brand' }, h('div', { class: 'mark' }, 'Contact')), h('div', { class: 'empty' }, e.status === 404 ? 'העמוד לא נמצא או שאינו פעיל.' : e.message)));
  }
})();
