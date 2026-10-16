import { demoBanner, applyTheme, applyBrand, labelsOf, fmtRange, h, mount, api, icon, spinner, toast, slotGrid, dayStrip, fmtTime, fmtDateLong, fmtDateMid, fmtPrice, normalizePhone, validName } from './common.js';

const root = document.getElementById('app');
const slug = decodeURIComponent(location.pathname.split('/')[2] || '');
const S = { shop: null, services: [], barbers: [], service: null, barber: null, days: null, date: null, slots: null, time: null, step: 1, busy: false, form: { first_name: '', last_name: '', phone: '' }, errors: {} };
const L = (k) => labelsOf(S.shop)[k];
const steps = () => [L('service_one'), L('staff_one'), 'מועד', 'פרטים'];

function shell(...kids) {
  return h('div', { class: 'wrap page' },
    h('header', { class: 'brand' }, h('div', { class: 'mark' }, L('brand')), h('h1', null, S.shop.name),
      S.shop.address && h('div', { class: 'addr' }, S.shop.address), h('div', { class: 'orn' }, h('i'))),
    demoBanner(S.shop), ...kids);
}
function stepper() {
  return h('ol', { class: 'steps', 'aria-label': 'שלבי הזמנה' }, steps().map((t, i) =>
    h('li', { class: i + 1 < S.step ? 'done' : i + 1 === S.step ? 'on' : '', 'aria-current': i + 1 === S.step ? 'step' : null }, t)));
}
const backBtn = (to) => h('button', { class: 'link back', type: 'button', onclick: () => { S.step = to; render(); } }, '→ חזרה');

function render() {
  window.scrollTo({ top: 0 });
  if (S.step === 1) return mount(root, shell(stepper(), viewService()));
  if (S.step === 2) return mount(root, shell(stepper(), backBtn(1), viewBarber()));
  if (S.step === 3) return mount(root, shell(stepper(), backBtn(2), viewWhen()));
  if (S.step === 4) return mount(root, shell(stepper(), backBtn(3), viewDetails()));
}

function viewService() {
  if (!S.services.length || !S.barbers.length) {
    return h('div', { class: 'empty' }, L('empty_unbooked'), S.shop.phone ? h('div', null, 'ניתן ליצור קשר: ', h('a', { href: `tel:${S.shop.phone}`, class: 'ltr' }, S.shop.phone)) : null);
  }
  return h('div', null, h('h2', { class: 'h-step' }, L('pick_service')),
    S.services.map((s) => h('button', { class: 'pick' + (S.service && S.service.id === s.id ? ' sel' : ''), type: 'button', onclick: () => { S.service = s; S.date = S.time = S.days = S.slots = null; S.step = 2; render(); } },
      h('div', { class: 'grow' }, h('div', { class: 't' }, s.name), h('div', { class: 'd' }, `${s.duration_min} דקות`)),
      h('div', { class: 'price' }, fmtPrice(s.price_ils)))));
}

function viewBarber() {
  return h('div', null, h('h2', { class: 'h-step' }, L('pick_staff')),
    S.barbers.map((b) => h('button', { class: 'pick' + (S.barber && S.barber.id === b.id ? ' sel' : ''), type: 'button', onclick: () => { S.barber = b; S.date = S.time = S.days = S.slots = null; S.step = 3; render(); } },
      h('div', { class: 'avatar', 'aria-hidden': 'true' }, b.name.trim()[0]), h('div', { class: 'grow' }, h('div', { class: 't' }, b.name)), icon('chevron', 20))));
}

function viewWhen() {
  const box = h('div', null, h('h2', { class: 'h-step' }, 'מתי נוח לכם?'),
    h('p', { class: 'sub' }, `${S.service.name} · ${S.barber.name} · ${S.service.duration_min} דקות`));
  const daysHost = h('div', null, spinner()), slotsHost = h('div', null);
  box.append(daysHost, slotsHost);
  const nextBtn = h('button', { class: 'btn primary block', type: 'button', onclick: () => { S.step = 4; render(); } });
  const updateNext = () => {
    nextBtn.disabled = S.time === null;
    nextBtn.textContent = S.time === null ? 'בחרו שעה להמשך' : `המשך – ${fmtDateMid(S.date)} בשעה ${fmtTime(S.time)}`;
  };
  updateNext();
  const dock = h('div', { class: 'dock' }, h('div', { class: 'wrap' }, nextBtn));
  box.append(dock);

  const paintSlots = () => {
    if (!S.date) { slotsHost.replaceChildren(h('div', { class: 'empty' }, 'בחרו תאריך כדי לראות שעות פנויות')); return; }
    if (!S.slots) { slotsHost.replaceChildren(spinner()); return; }
    slotsHost.replaceChildren(h('div', { class: 'grp' }, fmtDateLong(S.date)), slotGrid(S.slots, S.time, (m) => { S.time = m; paintSlots(); updateNext(); }));
  };
  const loadSlots = async () => {
    S.slots = null; paintSlots();
    try { S.slots = (await api(`/api/public/slots?slug=${slug}&barber_id=${S.barber.id}&service_id=${S.service.id}&date=${S.date}`)).slots; }
    catch (e) { toast(e.message, 'err'); S.slots = []; }
    paintSlots();
  };
  const paintDays = () => {
    daysHost.replaceChildren(dayStrip(S.days, S.date, (d) => { S.date = d; S.time = null; paintDays(); loadSlots(); }));
    const sel = daysHost.querySelector('.day.sel'); if (sel) sel.scrollIntoView({ inline: 'center', block: 'nearest' });
  };
  (async () => {
    try {
      if (!S.days) S.days = (await api(`/api/public/days?slug=${slug}&barber_id=${S.barber.id}&service_id=${S.service.id}`)).days;
    } catch (e) { daysHost.replaceChildren(h('div', { class: 'notice bad' }, e.message)); return; }
    if (!S.days.some((d) => d.available)) { daysHost.replaceChildren(h('div', { class: 'empty' }, L('no_staff_slots'))); return; }
    paintDays();
    if (S.date) loadSlots(); else paintSlots();
  })();
  return box;
}

function viewDetails() {
  const F = S.form;
  const inputs = {};
  const field = (key, label, attrs) => {
    const inp = h('input', { class: 'inp' + (S.errors[key] ? ' err' : ''), id: 'f-' + key, name: key, value: F[key], required: true, 'aria-required': 'true', 'aria-invalid': S.errors[key] ? 'true' : null, ...attrs,
      oninput: (e) => { F[key] = e.target.value; } });
    inputs[key] = inp;
    return h('div', { class: 'field' }, h('label', { for: 'f-' + key }, label, ' ', h('b', null, '*')), inp, h('div', { class: 'errmsg', id: 'e-' + key }, S.errors[key] || ''));
  };
  const summary = h('div', { class: 'card gold sum' },
    [[L('service_one'), S.service.name], [L('staff_one'), S.barber.name], ['תאריך', fmtDateMid(S.date)], ['שעה', fmtTime(S.time)], ['מחיר', fmtPrice(S.service.price_ils)]]
      .map(([k, v]) => h('div', { class: 'r' }, h('span', { class: 'k' }, k), h('span', { class: 'v' }, v))));
  const btn = h('button', { class: 'btn primary block', type: 'submit' }, L('book_cta'));
  const form = h('form', { novalidate: true, autocomplete: 'on', onsubmit: submit },
    h('h2', { class: 'h-step' }, 'כמעט סיימנו'), summary,
    h('div', { class: 'row2' }, field('first_name', 'שם פרטי', { autocomplete: 'given-name', maxlength: 40 }), field('last_name', 'שם משפחה', { autocomplete: 'family-name', maxlength: 40 })),
    field('phone', 'מספר נייד', { type: 'tel', inputmode: 'tel', autocomplete: 'tel', dir: 'ltr', placeholder: '050-0000000', maxlength: 20 }),
    h('div', { class: 'trap', 'aria-hidden': 'true' }, h('label', null, 'אל תמלאו שדה זה', h('input', { type: 'text', name: 'website', tabindex: '-1', autocomplete: 'off', id: 'f-website' }))),
    h('div', { class: 'notice' }, 'לא נדרש חשבון, מייל או סיסמה. הפרטים משמשים רק לניהול התור שלכם בעסק.'),
    h('div', { class: 'dock' }, h('div', { class: 'wrap' }, btn)));

  async function submit(ev) {
    ev.preventDefault();
    if (S.busy) return;
    const errs = {};
    if (!validName(F.first_name)) errs.first_name = 'נא להזין שם פרטי תקין';
    if (!validName(F.last_name)) errs.last_name = 'נא להזין שם משפחה תקין';
    const phone = normalizePhone(F.phone);
    if (!phone) errs.phone = 'נא להזין מספר נייד ישראלי תקין (למשל 054-1234567)';
    S.errors = errs;
    if (Object.keys(errs).length) { render(); const k = Object.keys(errs)[0]; const el = document.getElementById('f-' + k); if (el) el.focus(); return; }
    S.busy = true; btn.disabled = true; btn.textContent = 'שומרים…';
    try {
      const website = form.querySelector('#f-website').value;
      const idempotency_key = idemKey([slug, S.service.id, S.barber.id, S.date, S.time, F.first_name.trim(), F.last_name.trim(), phone].join('|'));
      const out = await api('/api/public/book', { method: 'POST', body: { slug, service_id: S.service.id, barber_id: S.barber.id, date: S.date, start_min: S.time, first_name: F.first_name.trim(), last_name: F.last_name.trim(), phone, website, idempotency_key } });
      S.busy = false; showConfirmation(out);
    } catch (e) {
      S.busy = false;
      if (e.code === 'slot_taken') { toast(e.message, 'err'); S.time = null; S.slots = null; S.step = 3; render(); return; }
      if (e.fields) { S.errors = e.fields; render(); return; }
      toast(e.message, 'err'); btn.disabled = false; btn.textContent = L('book_cta');
    }
  }
  return form;
}

// מפתח בקשה: נשאר זהה בניסיון חוזר של אותה הזמנה (למשל אחרי תקלת רשת), ומתחלף כשהפרטים משתנים – כך שהשרת לא ייצור תור כפול
let _idem = { fp: null, key: null };
function idemKey(fp) {
  if (_idem.fp !== fp) {
    const b = new Uint8Array(32); crypto.getRandomValues(b);
    _idem = { fp, key: btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') };
  }
  return _idem.key;
}

function showConfirmation(out) {
  const a = out.appointment;
  window.scrollTo({ top: 0 });
  const linkInp = h('input', { class: 'inp', readonly: true, value: out.manage_url, 'aria-label': 'קישור אישי לניהול התור', onfocus: (e) => e.target.select() });
  const copy = h('button', { class: 'btn sm', type: 'button', onclick: async () => {
    try { await navigator.clipboard.writeText(out.manage_url); toast('הקישור הועתק', 'ok'); } catch { linkInp.select(); toast('סמנו והעתיקו את הקישור', 'info'); }
  } }, icon('copy', 18), 'העתקה');
  const sent = out.notification && out.notification.sent;
  mount(root, h('div', { class: 'wrap page' },
    h('header', { class: 'brand' }, h('div', { class: 'mark' }, a.shop_name)),
    h('div', { class: 'center' }, h('div', { class: 'okmark' }, icon('check')), h('h1', { class: 'gold' }, L('done_title')), h('p', { class: 'sub' }, `${a.first_name}, ${L('done_sub')}`)),
    h('div', { class: 'card gold sum' }, [[L('staff_one'), a.barber_name], [L('service_one'), a.service_name], ['תאריך', fmtDateLong(a.date)], ['שעה', `${fmtRange(a.start_min, a.end_min)}`]]
      .map(([k, v]) => h('div', { class: 'r' }, h('span', { class: 'k' }, k), h('span', { class: 'v' }, v)))),
    h('div', { class: 'card' }, h('strong', null, 'שמרו את הקישור האישי'),
      h('p', { class: 'muted' }, `דרכו תוכלו לשנות או לבטל את ${L('appt_one') === 'תור' ? 'התור' : 'ה' + L('appt_one')} בלי חשבון. הקישור אישי – אל תשתפו אותו.`),
      h('div', { class: 'linkbox' }, linkInp, copy),
      h('p', { class: 'hint' }, h('a', { href: out.manage_url }, 'מעבר לניהול ההזמנה'))),
    !sent && h('div', { class: 'notice warn' }, 'הודעת אישור ב-SMS/WhatsApp לא נשלחה – שירות ההודעות טרם חובר. שמרו את הקישור האישי: הוא מאפשר לשנות או לבטל בלי חשבון.'),
    h('button', { class: 'btn ghost block', type: 'button', onclick: () => location.reload() }, 'הזמנה נוספת')));
}

(async () => {
  mount(root, h('div', { class: 'wrap' }, spinner()));
  try {
    const d = await api(`/api/public/shops/${encodeURIComponent(slug)}`);
    S.shop = d.shop; S.services = d.services; S.barbers = d.barbers; await applyTheme(d.shop.theme); applyBrand(d.shop.brand);
    if (d.shop.frozen) { mount(root, h('div', { class: 'wrap page' }, h('header', { class: 'brand' }, h('h1', null, d.shop.name)), h('div', { class: 'notice warn', role: 'status', 'data-frozen': '1' }, 'העסק בתחזוקה זמנית ואינו מקבל הזמנות כרגע. נסו שוב מאוחר יותר.'))); return; }
    document.title = `${L('book_title')} – ${d.shop.name}`;
    render();
  } catch (e) {
    mount(root, h('div', { class: 'wrap' }, h('header', { class: 'brand' }, h('div', { class: 'mark' }, 'Booking')),
      h('div', { class: 'empty' }, e.status === 404 ? 'העסק לא נמצא או שאינו פעיל.' : e.message), h('p', { class: 'center' }, h('a', { href: '/' }, 'לרשימת העסקים'))));
  }
})();
