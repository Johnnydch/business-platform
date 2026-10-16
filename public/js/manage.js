import { applyTheme, applyBrand, labelsOf, fmtRange, h, mount, api, icon, spinner, toast, confirmBox, modal, slotGrid, dayStrip, fmtTime, fmtDateLong, fmtDateMid, fmtPrice, STATUS } from './common.js';

const root = document.getElementById('app');
const token = location.pathname.split('/')[2] || '';
const base = `/api/public/manage/${encodeURIComponent(token)}`;
let info = null;

const header = (name, title) => h('header', { class: 'brand' }, h('div', { class: 'mark' }, name || 'Booking'), h('h1', null, title || 'ההזמנה שלי'), h('div', { class: 'orn' }, h('i')));

async function load() {
  mount(root, h('div', { class: 'wrap' }, spinner()));
  try { info = await api(base); } catch (e) {
    mount(root, h('div', { class: 'wrap' }, header(), h('div', { class: 'notice bad' }, e.status === 404 ? 'הקישור אינו תקף או שפג תוקפו. אם הזמנתם תור, פנו לעסק.' : e.message),
      h('p', { class: 'center' }, h('a', { href: '/' }, 'לדף הראשי'))));
    return;
  }
  await applyTheme(info.shop.theme); applyBrand(info.shop.brand); view();
}

function view() {
  const a = info.appointment, shop = info.shop; const L = labelsOf(shop);
  const pillClass = a.status === 'confirmed' ? 'ok' : a.status === 'completed' ? 'gold' : 'bad';
  const blockedMsg = a.status !== 'confirmed' ? null
    : info.uses_left <= 0 ? 'הגעתם למספר השינויים המרבי בקישור זה. ליצירת שינוי נוסף פנו לעסק.'
    : !info.can_modify ? `לא ניתן לשנות או לבטל פחות מ-${info.cutoff_hours} שעות לפני התור. לשינוי פנו לעסק.` : null;
  mount(root, h('div', { class: 'wrap page' }, header(shop.name, L.manage_title),
    h('div', { class: 'card gold sum' },
      h('div', { class: 'r' }, h('span', { class: 'k' }, 'סטטוס'), h('span', { class: 'pill ' + pillClass }, STATUS[a.status] || a.status)),
      [['שם', a.first_name], ['נייד', `${a.phone_masked}`], [L.staff_one, a.barber_name], [L.service_one, a.service_name], ['תאריך', fmtDateLong(a.date)], ['שעה', `${fmtRange(a.start_min, a.end_min)}`], ['מחיר', fmtPrice(a.price_ils)], shop.address ? ['כתובת', shop.address] : null]
        .filter(Boolean).map(([k, v]) => h('div', { class: 'r' }, h('span', { class: 'k' }, k), h('span', { class: 'v' }, v)))),
    blockedMsg && h('div', { class: 'notice warn' }, blockedMsg, shop.phone ? h('span', null, ' ', h('a', { class: 'ltr', href: `tel:${shop.phone}` }, shop.phone)) : null),
    a.status === 'cancelled' && h('div', { class: 'notice' }, `${L.appt_one === 'תור' ? 'התור' : 'ה' + L.appt_one} בוטל.`),
    a.status === 'confirmed' && info.can_modify && info.uses_left > 0 && h('div', { class: 'list' },
      h('button', { class: 'btn primary block', type: 'button', onclick: reschedule }, `שינוי מועד ה${L.appt_one}`),
      h('button', { class: 'btn danger block', type: 'button', onclick: cancel }, `ביטול ה${L.appt_one}`)),
    h('p', { class: 'center muted' }, h('a', { href: `/b/${shop.slug}` }, L.book_title))));
}

async function cancel() {
  if (!(await confirmBox(`לבטל את ה${labelsOf(info.shop).appt_one}?`, 'ההזמנה תשוחרר ולא ניתן יהיה לשחזר אותה מהקישור. ניתן להזמין מחדש בכל עת.', 'כן, לבטל', true))) return;
  try { await api(`${base}/cancel`, { method: 'POST' }); toast('התור בוטל', 'ok'); await load(); } catch (e) { toast(e.message, 'err'); await load(); }
}

async function reschedule() {
  let barbers = [];
  try { barbers = (await api(`${base}/barbers`)).barbers; } catch (e) { toast(e.message, 'err'); return; }
  const P = { barber: barbers.find((b) => b.id === info.appointment.barber_id) || barbers[0], days: null, date: null, slots: null, time: null };
  const body = h('div');
  const saveBtn = h('button', { class: 'btn primary', type: 'button', disabled: true }, 'אישור המועד החדש');
  const m = modal('שינוי מועד', h('div', null, body, h('div', { class: 'acts' }, saveBtn, h('button', { class: 'btn ghost', type: 'button', onclick: () => m.close() }, 'סגירה'))));
  const slotsHost = h('div'), daysHost = h('div', null, spinner());
  const sel = h('select', { class: 'inp', 'aria-label': labelsOf(info.shop).staff_one, onchange: (e) => { P.barber = barbers.find((b) => String(b.id) === e.target.value); P.days = null; P.date = P.time = P.slots = null; loadDays(); } },
    barbers.map((b) => h('option', { value: b.id, selected: b.id === P.barber.id }, b.name)));
  body.append(h('div', { class: 'field' }, h('label', null, labelsOf(info.shop).staff_one), sel), daysHost, slotsHost);
  const upd = () => { saveBtn.disabled = P.time === null; };
  const paintSlots = () => {
    if (!P.date) { slotsHost.replaceChildren(); return; }
    if (!P.slots) { slotsHost.replaceChildren(spinner()); return; }
    slotsHost.replaceChildren(h('div', { class: 'grp' }, fmtDateMid(P.date)), slotGrid(P.slots, P.time, (t) => { P.time = t; paintSlots(); upd(); }));
  };
  async function loadSlots() {
    P.slots = null; paintSlots();
    try { P.slots = (await api(`${base}/slots?barber_id=${P.barber.id}&date=${P.date}`)).slots; } catch (e) { toast(e.message, 'err'); P.slots = []; }
    paintSlots();
  }
  const paintDays = () => daysHost.replaceChildren(dayStrip(P.days, P.date, (d) => { P.date = d; P.time = null; paintDays(); upd(); loadSlots(); }));
  async function loadDays() {
    daysHost.replaceChildren(spinner()); slotsHost.replaceChildren(); upd();
    try { P.days = (await api(`${base}/days?barber_id=${P.barber.id}`)).days; } catch (e) { daysHost.replaceChildren(h('div', { class: 'notice bad' }, e.message)); return; }
    if (!P.days.some((d) => d.available)) { daysHost.replaceChildren(h('div', { class: 'empty' }, 'אין שעות פנויות אצל ספר זה.')); return; }
    paintDays();
  }
  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true;
    try {
      await api(`${base}/reschedule`, { method: 'POST', body: { barber_id: P.barber.id, date: P.date, start_min: P.time } });
      m.close(); toast('מועד התור עודכן', 'ok'); await load();
    } catch (e) {
      toast(e.message, 'err');
      if (e.code === 'slot_taken') { P.time = null; loadSlots(); } else if (['too_late', 'token_limit', 'not_active'].includes(e.code)) { m.close(); await load(); }
      upd();
    }
  });
  loadDays();
}

load();
