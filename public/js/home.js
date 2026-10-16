// אתר המכירות של המותג: קטלוג התבניות, מסלולים (מנוהל / חד-פעמי), תוספות, וטופס התעניינות.
// אין כאן המלצות, לקוחות או נתוני הצלחה. מחירים מוצגים כ"טיוטה" עד שאושרו. הדגמות הן עסקי הדגמה סינתטיים בלבד.
import { h, mount, api, spinner, toast, fmtPrice, normalizePhone, validName, resolveCustomHost } from './common.js';

const root = document.getElementById('app');
mount(root, spinner());
const KINDS = [['all', 'הכול'], ['booking', 'הזמנת תורים'], ['leads', 'קבלת פניות והצעות']];
const F = { name: '', phone: '', email: '', business_name: '', template: '', track: 'undecided', message: '', addons: new Set() };
let kind = 'all';

const priceLine = (p, track, approved) => {
  if (!p) return null;
  const draft = approved ? null : h('span', { class: 'pill', title: 'המחיר טרם אושר' }, 'טיוטה');
  if (track === 'managed') return h('div', { class: 'price-line' }, 'מנוהל: הקמה ', h('b', null, fmtPrice(p.managed.setup)), ' + ', h('b', null, fmtPrice(p.managed.monthly)), ' לחודש ', draft);
  return h('div', { class: 'price-line' }, 'חד-פעמי: ', h('b', null, fmtPrice(p.one_time.setup)), ' ', draft);
};

function view(d) {
  const draftNotice = d.prices_approved ? null : h('div', { class: 'notice warn', role: 'note' }, 'המחירים באתר הם מחירי טיוטה לדוגמה ועדיין לא אושרו. סכום סופי ייקבע בהצעה מסודרת.');
  const cardsHost = h('div', { class: 'tplgrid' });
  const select = (key) => { F.template = key; paintForm(); document.getElementById('interest').scrollIntoView({ behavior: 'smooth' }); };
  const paintCards = () => cardsHost.replaceChildren(...d.templates.filter((t) => kind === 'all' || (kind === 'booking' ? t.kind === 'booking' : t.kind !== 'booking')).map((t) => h('article', { class: 'card tpl', 'data-template': t.key },
    h('h3', null, t.name), h('p', null, t.tagline), t.audience && h('p', { class: 'muted' }, 'מתאים ל: ' + t.audience),
    h('ul', { class: 'feat' }, (t.features || []).map((x) => h('li', null, x))),
    priceLine(d.prices[t.key], 'managed', d.prices_approved), priceLine(d.prices[t.key], 'one_time', d.prices_approved),
    h('div', { class: 'acts' }, t.demo_slug ? h('a', { class: 'btn sm', href: `/${t.kind === 'booking' ? 'b' : 'l'}/${t.demo_slug}` }, 'להדגמה') : h('span', { class: 'muted' }, 'הדגמה תתווסף'),
      h('button', { class: 'btn sm primary', type: 'button', onclick: () => select(t.key) }, 'מתעניינים בתבנית')))));
  const filtersEl = () => { const n = h('div', { class: 'chips', role: 'tablist', 'aria-label': 'סינון תבניות' }, KINDS.map(([k, t]) => h('button', { type: 'button', role: 'tab', 'aria-selected': k === kind ? 'true' : 'false', class: 'chip' + (k === kind ? ' on' : ''), onclick: () => { kind = k; n.replaceWith(filtersEl()); paintCards(); } }, t))); return n; };
  paintCards();

  const track = (k, title, desc) => h('div', { class: 'card' }, h('h3', null, title), h('p', null, desc), h('ul', { class: 'feat' }, (d.inclusions[k] || []).map((x) => h('li', null, x))));
  const formHost = h('div', { id: 'interest' });
  function paintForm() {
    const field = (key, label, el, req) => h('div', { class: 'field' }, h('label', { for: 'f-' + key }, label, ' ', req ? h('b', null, '*') : null), el, h('div', { class: 'errmsg', id: 'e-' + key }));
    const i = (key, attrs) => h('input', { class: 'inp', id: 'f-' + key, name: key, value: F[key], oninput: (e) => { F[key] = e.target.value; }, ...attrs });
    const tsel = h('select', { class: 'inp', id: 'f-template', onchange: (e) => { F.template = e.target.value; } }, h('option', { value: '' }, 'עדיין לא בטוחים'), d.templates.map((t) => h('option', { value: t.key, selected: t.key === F.template }, t.name)));
    const trk = h('div', { class: 'chips', role: 'radiogroup', 'aria-label': 'מסלול' }, [['managed', 'מנוהל'], ['one_time', 'חד-פעמי'], ['undecided', 'לא יודעים עדיין']].map(([v, t]) => h('button', { type: 'button', role: 'radio', 'aria-checked': F.track === v ? 'true' : 'false', class: 'chip' + (F.track === v ? ' on' : ''), onclick: () => { F.track = v; paintForm(); } }, t)));
    const adds = h('div', { class: 'chips' }, d.addons.map((a) => h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: F.addons.has(a.key), onchange: (e) => { e.target.checked ? F.addons.add(a.key) : F.addons.delete(a.key); } }), ' ' + a.name)));
    const msg = h('textarea', { class: 'inp', id: 'f-message', rows: 3, maxlength: 500, oninput: (e) => { F.message = e.target.value; } }, F.message);
    const btn = h('button', { class: 'btn primary block', type: 'submit' }, 'שלחו פרטים');
    const form = h('form', { novalidate: true, onsubmit: submit },
      h('h2', { class: 'h-step' }, 'השאירו פרטים ונחזור אליכם'),
      field('name', 'שם מלא', i('name', { autocomplete: 'name', maxlength: 60 }), true), field('phone', 'מספר נייד', i('phone', { type: 'tel', dir: 'ltr', autocomplete: 'tel', maxlength: 20, placeholder: '050-0000000' }), true),
      field('email', 'אימייל (אופציונלי)', i('email', { type: 'email', dir: 'ltr', autocomplete: 'email', maxlength: 120 })), field('business_name', 'שם העסק (אופציונלי)', i('business_name', { maxlength: 80 })),
      field('template', 'תבנית', tsel), field('track', 'מסלול', trk), d.addons.length ? field('addons', 'תוספות שמעניינות אתכם', adds) : null, field('message', 'הודעה (אופציונלי)', msg),
      h('div', { class: 'trap', 'aria-hidden': 'true' }, h('label', null, 'אל תמלאו שדה זה', h('input', { type: 'text', name: 'website', tabindex: '-1', autocomplete: 'off', id: 'f-website' }))),
      h('div', { class: 'notice' }, 'הפרטים משמשים ליצירת קשר בנוגע להצעה בלבד. אישור SMS/WhatsApp אינו נשלח כרגע; ניצור קשר בטלפון או במייל.'), btn);
    const setErr = (k, t) => { const e = form.querySelector('#e-' + k); if (e) e.textContent = t || ''; const x = form.querySelector('#f-' + k); if (x) x.classList.toggle('err', !!t); };
    async function submit(ev) {
      ev.preventDefault(); ['name', 'phone', 'email', 'business_name', 'message'].forEach((k) => setErr(k, ''));
      const phone = normalizePhone(F.phone), errs = {};
      if (!validName(F.name)) errs.name = 'נא להזין שם תקין'; if (!phone) errs.phone = 'נא להזין מספר נייד ישראלי תקין (למשל 054-1234567)';
      for (const [k, t] of Object.entries(errs)) setErr(k, t); if (Object.keys(errs).length) { form.querySelector('#f-' + Object.keys(errs)[0]).focus(); return; }
      btn.disabled = true; btn.textContent = 'שולחים…';
      try {
        await api('/api/public/brand-lead', { method: 'POST', body: { name: F.name.trim(), phone, email: F.email.trim() || undefined, business_name: F.business_name.trim() || undefined, template: F.template || undefined, track: F.track, addons: [...F.addons], message: F.message.trim() || undefined, website: form.querySelector('#f-website').value } });
        formHost.replaceChildren(h('div', { class: 'center', id: 'brand-thanks' }, h('h2', { class: 'gold' }, 'תודה, הפרטים התקבלו'), h('p', { class: 'sub' }, 'ניצור איתכם קשר בהקדם.')));
      } catch (e) { btn.disabled = false; btn.textContent = 'שלחו פרטים'; if (e.fields) Object.entries(e.fields).forEach(([k, t]) => setErr(k, t)); else toast(e.message, 'err'); }
    }
    formHost.replaceChildren(form);
  }
  paintForm();
  document.title = d.brand.name;
  mount(root, h('div', { class: 'wrap page' },
    h('header', { class: 'brand' }, h('div', { class: 'mark' }, 'Booking & Leads'), h('h1', { id: 'brand-name' }, d.brand.name), h('p', { class: 'tagline' }, d.brand.tagline), h('div', { class: 'orn' }, h('i'))),
    draftNotice,
    h('section', { 'aria-labelledby': 'cat-h' }, h('h2', { class: 'h-step', id: 'cat-h' }, 'התבניות שלנו'), h('p', { class: 'sub' }, 'כל תבנית היא עסק מוכן: דף ציבורי, ניהול, שירותים והגדרות. אפשר להתנסות בהדגמה שאינה קשורה לעסק אמיתי.'), filtersEl(), cardsHost),
    h('section', null, h('h2', { class: 'h-step' }, 'שני מסלולים'),
      track('managed', 'מסלול מנוהל', 'אנחנו מארחים ומתפעלים את העסק שלכם על התשתית שלנו.'),
      track('one_time', 'מסלול חד-פעמי', 'הקוד וההתקנה נמסרים אליכם ופועלים בחשבונות שלכם.')),
    d.addons.length ? h('section', null, h('h2', { class: 'h-step' }, 'תוספות'), h('div', { class: 'list' }, d.addons.map((a) => h('div', { class: 'item' }, h('div', { class: 'grow' }, h('div', { class: 't' }, a.name), a.description && h('div', { class: 'd' }, a.description)),
      h('div', { class: 'price' }, a.price_ils == null ? 'לפי הצעה' : a.price_ils === 0 ? 'ללא עלות' : fmtPrice(a.price_ils), ' ', d.prices_approved ? null : h('span', { class: 'pill' }, 'טיוטה')))))) : null,
    h('section', null, formHost), h('p', { class: 'center muted' }, h('a', { href: '/admin' }, 'כניסת צוות'))));
}

(async () => {
  const cd = await resolveCustomHost();
  if (cd) { location.replace(`/${cd.kind === 'booking' ? 'b' : 'l'}/${cd.slug}`); return; }
  try { view(await api('/api/public/brand')); } catch (e) { mount(root, h('div', { class: 'wrap' }, h('div', { class: 'notice bad' }, e.message))); }
})();
