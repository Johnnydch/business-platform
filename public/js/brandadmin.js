// ניהול המותג (Super Admin בלבד): שם המותג, מחירים (טיוטה עד אישור), תוספות, ולידים של המותג.
// הלידים כאן הם של אתר המכירות בלבד; פניות של לקוחות עסקים נמצאות אצל הבעלים של כל עסק.
import { h, mount, api, toast, confirmBox, fmtPrice, fmtPhone } from './common.js';

const LEAD_STATUS = { new: 'חדש', contacted: 'נוצר קשר', won: 'נסגר', lost: 'לא רלוונטי' };
const TRACK = { managed: 'מנוהל', one_time: 'חד-פעמי', undecided: 'טרם הוחלט' };

export async function brandView(host, { formField, setErrors, inp, sensitive }) {
  const [B, L] = await Promise.all([api('/api/super/brand'), api('/api/super/brand-leads')]);
  const num = (name, v, label) => h('input', { class: 'inp', type: 'number', min: 0, max: 1000000, dir: 'ltr', name, value: v == null ? '' : v, 'aria-label': label });
  const f = h('form', { novalidate: true });
  const F = { brand_name: inp('brand_name', { value: B.brand_name, maxlength: 40 }), tagline: inp('tagline', { value: B.tagline, maxlength: 120 }),
    contact_phone: inp('contact_phone', { value: B.contact_phone || '', type: 'tel', dir: 'ltr' }), contact_email: inp('contact_email', { value: B.contact_email || '', type: 'email', dir: 'ltr' }) };
  const priceRows = B.templates.map((t) => {
    const p = B.prices[t.key] || {}; const m = p.managed || {}, o = p.one_time || {};
    const e = { ms: num('ms', m.setup, `${t.name}: הקמה מנוהל`), mm: num('mm', m.monthly, `${t.name}: חודשי מנוהל`), os: num('os', o.setup, `${t.name}: חד-פעמי`) };
    return { t, e, el: h('div', { class: 'card' }, h('strong', null, t.name), h('div', { class: 'row2' }, formField('מנוהל · הקמה (₪)', e.ms, 'p'), formField('מנוהל · חודשי (₪)', e.mm, 'p')), formField('חד-פעמי · הקמה (₪)', e.os, 'p')) };
  });
  const addons = B.addons.map((a) => ({ ...a }));
  const addonHost = h('div');
  const paintAddons = () => addonHost.replaceChildren(...addons.map((a, i) => h('div', { class: 'card' },
    h('div', { class: 'row2' }, formField('מפתח (אנגלית)', inp('k', { value: a.key, dir: 'ltr', maxlength: 24, oninput: (e) => { a.key = e.target.value; } }), 'k'), formField('שם', inp('n', { value: a.name, maxlength: 60, oninput: (e) => { a.name = e.target.value; } }), 'n')),
    formField('תיאור', inp('d', { value: a.description || '', maxlength: 160, oninput: (e) => { a.description = e.target.value; } }), 'd'),
    formField('מחיר (₪; ריק = לפי הצעה)', h('input', { class: 'inp', type: 'number', min: 0, dir: 'ltr', value: a.price_ils == null ? '' : a.price_ils, oninput: (e) => { a.price_ils = e.target.value === '' ? null : Number(e.target.value); } }), 'p'),
    h('button', { class: 'btn sm danger', type: 'button', onclick: () => { addons.splice(i, 1); paintAddons(); } }, 'הסרה'))));
  paintAddons();
  const collect = (approve) => ({
    brand_name: F.brand_name.value, tagline: F.tagline.value, contact_phone: F.contact_phone.value, contact_email: F.contact_email.value,
    prices: Object.fromEntries(priceRows.map(({ t, e }) => [t.key, { managed: { setup: e.ms.value === '' ? null : Number(e.ms.value), monthly: e.mm.value === '' ? null : Number(e.mm.value) }, one_time: { setup: e.os.value === '' ? null : Number(e.os.value) } }])),
    addons: addons.map((a) => ({ key: a.key, name: a.name, description: a.description || '', price_ils: a.price_ils == null ? null : a.price_ils })), approve: approve || undefined });
  const ctx = { formField, setErrors, inp, sensitive };
  const doSave = async (approve) => {
    setErrors(f, {});
    try { await sensitive('/api/super/brand', { method: 'PUT', body: collect(approve) }); toast(approve ? 'המחירים אושרו' : 'נשמר', 'ok'); brandView(host, ctx); }
    catch (er) { if (er.cancelled) return; if (er.fields) { setErrors(f, er.fields); toast('יש לתקן את השדות המסומנים', 'err'); } else toast(er.message, 'err'); }
  };
  f.append(formField('שם המותג (זמני, ניתן לשינוי)', F.brand_name, 'brand_name'), formField('משפט תיאור', F.tagline, 'tagline'),
    formField('טלפון ליצירת קשר (אופציונלי)', F.contact_phone, 'contact_phone'), formField('אימייל ליצירת קשר (אופציונלי)', F.contact_email, 'contact_email'),
    h('h3', null, 'מחירים'), h('p', { class: 'hint' }, 'כל שינוי במחירים או בתוספות מחזיר אותם למצב "טיוטה". באתר הציבורי מוצגת תווית "טיוטה – טרם אושר" עד לאישור.'),
    priceRows.map((r) => r.el), h('div', { class: 'errmsg', 'data-err': 'prices' }),
    h('h3', null, 'תוספות'), addonHost, h('div', { class: 'errmsg', 'data-err': 'addons' }),
    addons.length < 12 && h('button', { class: 'btn sm', type: 'button', onclick: () => { addons.push({ key: '', name: '', description: '', price_ils: null }); paintAddons(); } }, '+ תוספת'),
    h('div', { class: 'acts' }, h('button', { class: 'btn primary', type: 'submit' }, 'שמירה (כטיוטה)'),
      h('button', { class: 'btn', type: 'button', onclick: async () => { if (await confirmBox('לאשר את המחירים?', 'המחירים יוצגו באתר כמחירים מאושרים (דורש אימות TOTP טרי).', 'אישור')) doSave(true); } }, 'שמירה ואישור מחירים')));
  f.addEventListener('submit', (ev) => { ev.preventDefault(); doSave(false); });

  const leadItems = L.leads.map((l) => {
    const st = h('select', { class: 'inp', 'aria-label': 'סטטוס', onchange: async (e) => { try { await api(`/api/super/brand-leads/${l.id}`, { method: 'PATCH', body: { status: e.target.value } }); toast('עודכן', 'ok'); } catch (er) { toast(er.message, 'err'); } } },
      Object.entries(LEAD_STATUS).map(([v, t]) => h('option', { value: v, selected: v === l.status }, t)));
    const nt = h('input', { class: 'inp', maxlength: 300, value: l.note || '', placeholder: 'הערה פנימית', 'aria-label': 'הערה', onchange: async (e) => { try { await api(`/api/super/brand-leads/${l.id}`, { method: 'PATCH', body: { note: e.target.value } }); toast('נשמר', 'ok'); } catch (er) { toast(er.message, 'err'); } } });
    return h('div', { class: 'card', 'data-brand-lead': l.id },
      h('div', { class: 'item' }, h('div', { class: 'grow' }, h('div', { class: 't' }, l.name, l.business_name ? ` · ${l.business_name}` : ''), h('div', { class: 'd ltr' }, fmtPhone(l.phone), l.email ? ` · ${l.email}` : ''),
        h('div', { class: 'd' }, `${l.template || 'ללא תבנית'} · ${TRACK[l.track]} · ${new Date(l.created_at).toLocaleDateString('he-IL')}`), l.addons.length ? h('div', { class: 'd' }, 'תוספות: ' + l.addons.join(', ')) : null,
        l.message ? h('p', null, l.message) : null)), st, nt);
  });
  mount(host, h('h2', null, 'מותג ואתר מכירות'), h('div', { class: 'card' }, f),
    h('h2', null, `פניות מהאתר (${L.leads.length})`), L.leads.length ? h('div', { class: 'list' }, leadItems) : h('div', { class: 'empty' }, 'עדיין לא התקבלו פניות.'),
    h('p', { class: 'hint' }, `מחירים: ${B.prices_approved ? 'מאושרים' : 'טיוטה (טרם אושרו)'}. פניות אלה נפרדות מפניות הלקוחות של עסקים.`),
    B.prices_approved && h('button', { class: 'btn sm', type: 'button', onclick: async () => { try { await api('/api/super/brand/unapprove', { method: 'POST', body: {} }); brandView(host, ctx); } catch (er) { toast(er.message, 'err'); } } }, 'החזרה למצב טיוטה'));
}
