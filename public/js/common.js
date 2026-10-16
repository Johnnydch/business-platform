// כלי עזר משותפים: בניית DOM בטוחה (ללא innerHTML עם נתוני משתמש), קריאות API, תבניות תצוגה.
export const $ = (s, r = document) => r.querySelector(s);

export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'value') el.value = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  const add = (c) => {
    if (c === null || c === undefined || c === false) return;
    if (Array.isArray(c)) c.forEach(add);
    else el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  };
  kids.forEach(add);
  return el;
}
// ערכת נושא לפי תבנית העסק (קובץ /themes/<theme>.css). שם הערכה מאומת כדי שלא ניתן יהיה להצביע על נתיב אחר.
// מחזיר Promise שמסתיים אחרי טעינת ה-CSS (עם תקרת זמן), כדי שהעמוד לא יבהב בערכה הלא נכונה.
export function applyTheme(theme) {
  if (!/^[a-z0-9-]{1,40}$/.test(theme || '')) return Promise.resolve();
  document.documentElement.dataset.theme = theme;
  const l = document.getElementById('theme-css');
  const href = `/themes/${theme}.css`;
  if (!l || l.getAttribute('href') === href) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => { clearTimeout(t); resolve(); };
    const t = setTimeout(done, 2500);
    l.addEventListener('load', done, { once: true }); l.addEventListener('error', done, { once: true });
    l.setAttribute('href', href);
  });
}
// תוויות לפי תבנית, עם ברירות מחדל ניטרליות. כל טקסט שתלוי בתחום (ספר/מטפלת/תחנה, תור/טיפול) עובר דרכן.
export const DEFAULT_LABELS = {
  brand: 'Booking', business: 'עסק', staff_one: 'איש צוות', staff_many: 'צוות', pick_staff: 'עם מי תרצו לקבוע?',
  service_one: 'שירות', service_many: 'שירותים', pick_service: 'איזה שירות תרצו?', appt_one: 'תור', appt_many: 'תורים',
  book_cta: 'אישור הזמנת תור', done_title: 'התור נקבע בהצלחה', done_sub: 'נשמח לראות אתכם.',
  no_staff_slots: 'אין כרגע שעות פנויות. נסו אפשרות אחרת או חזרו מאוחר יותר.', add_staff: 'הוספת איש צוות', staff_icon: 'scissors', all_staff: 'כל הצוות', calendar: 'יומן',
  customers: 'לקוחות', leads_tab: 'פניות', leads_title: 'פניות', empty_unbooked: 'הזמנת תורים אונליין עדיין לא הופעלה בעסק זה.',
  manage_title: 'התור שלי', book_title: 'הזמנת תור', catalog_title: 'השירותים שלנו', tagline: '', lead_title: 'השאירו פרטים ונחזור אליכם',
  lead_cta: 'שליחת פנייה', lead_done_title: 'תודה! קיבלנו את הפנייה', lead_done_sub: 'ניצור איתכם קשר בהקדם.', msg_label: 'הודעה (אופציונלי)',
  msg_placeholder: '', service_pick_label: 'שירות מבוקש', extra: '',
};
export const labelsOf = (shop) => ({ ...DEFAULT_LABELS, ...((shop && shop.labels) || {}) });
export const mount = (root, ...kids) => { root.replaceChildren(...kids.flat().filter(Boolean)); };

const ICONS = {
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  chevron: '<path d="M9 5l7 7-7 7"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="M3.5 7l8.5 6 8.5-6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  home: '<path d="M4 11l8-7 8 7v9a1 1 0 01-1 1h-4v-6H9v6H5a1 1 0 01-1-1z"/>',
  cal: '<rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
  scissors: '<circle cx="6.5" cy="6.5" r="2.5"/><circle cx="6.5" cy="17.5" r="2.5"/><path d="M8.7 7.8L20 18M8.7 16.2L20 6"/>',
  tag: '<path d="M3.5 12.5V4.5a1 1 0 011-1h8l8 8-9 9z"/><circle cx="8.5" cy="8.5" r="1.3"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.5-3.6 3.2-5.5 6.5-5.5s6 1.9 6.5 5.5M16 4.8a3.5 3.5 0 010 6.4M18.5 14.8c1.8.7 2.8 2.3 3 5.2"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M5.5 18.5l1.7-1.7M16.8 7.2l1.7-1.7"/>',
  shield: '<path d="M12 3l8 3v6c0 4.5-3.2 7.8-8 9-4.8-1.2-8-4.5-8-9V6z"/>',
  copy: '<rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M15.5 8.5v-2a2 2 0 00-2-2h-7a2 2 0 00-2 2v7a2 2 0 002 2h2"/>',
  sparkle: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M18.5 15.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z"/>',
  car: '<path d="M4 15v-3l2-5h12l2 5v3"/><path d="M3 15h18v3H3z"/><circle cx="7.5" cy="18" r="1.6"/><circle cx="16.5" cy="18" r="1.6"/>',
  chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  phone: '<path d="M6.5 3.5h3l1.5 4-2 1.5a11 11 0 006 6l1.5-2 4 1.5v3a2 2 0 01-2 2A16 16 0 014.5 5.5a2 2 0 012-2z"/>',
};
export function icon(name, size) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor');
  s.setAttribute('stroke-width', '1.8'); s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round');
  s.setAttribute('aria-hidden', 'true');
  if (size) { s.setAttribute('width', size); s.setAttribute('height', size); }
  s.innerHTML = ICONS[name] || ''; // קבוע פנימי בלבד, לא קלט משתמש
  return s;
}

export async function api(path, { method = 'GET', body } = {}) {
  const init = { method, credentials: 'same-origin', headers: {} };
  if (method !== 'GET') { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body || {}); }
  let res;
  try { res = await fetch(path, init); } catch { const e = new Error('אין חיבור לשרת. בדקו את הרשת ונסו שוב.'); e.status = 0; throw e; }
  let data = null;
  try { data = await res.json(); } catch { /* ריק */ }
  if (!res.ok) {
    const e = new Error((data && data.error && data.error.message) || 'אירעה שגיאה. נסו שוב.');
    e.status = res.status; e.code = data && data.error && data.error.code; e.fields = data && data.error && data.error.fields;
    throw e;
  }
  return data;
}

/* תבניות תצוגה */
export const fmtTime = (m) => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
// טווח שעות בסדר חזותי קבוע משמאל לימין (מונע היפוך בתוך טקסט RTL)
export const fmtRange = (a, b) => `\u2066${fmtTime(a)}–${fmtTime(b)}\u2069`;
export const parseTime = (s) => { const m = /^(\d{1,2}):(\d{2})$/.exec(s || ''); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
const dateObj = (d) => new Date(d + 'T12:00:00');
export const fmtDateLong = (d) => new Intl.DateTimeFormat('he-IL', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(dateObj(d));
export const fmtDateMid = (d) => new Intl.DateTimeFormat('he-IL', { weekday: 'long', day: 'numeric', month: 'long' }).format(dateObj(d));
export const fmtDateShort = (d) => new Intl.DateTimeFormat('he-IL', { day: 'numeric', month: 'numeric' }).format(dateObj(d));
export const weekdayShort = (d) => new Intl.DateTimeFormat('he-IL', { weekday: 'short' }).format(dateObj(d));
export const dayNum = (d) => String(Number(d.slice(8, 10)));
export const monthShort = (d) => new Intl.DateTimeFormat('he-IL', { month: 'short' }).format(dateObj(d));
export const WEEKDAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
export const fmtPrice = (n) => (n ? `₪${Number(n).toLocaleString('he-IL')}` : 'ללא עלות');
export const fmtPhone = (p) => (/^05\d{8}$/.test(p || '') ? `${p.slice(0, 3)}-${p.slice(3)}` : p || '');
export const todayLocal = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date());
export const addDays = (d, n) => { const x = dateObj(d); x.setDate(x.getDate() + n); return new Intl.DateTimeFormat('en-CA').format(x); };
export const STATUS = { confirmed: 'מאושר', completed: 'הושלם', cancelled: 'בוטל', no_show: 'לא הגיע' };

/* ולידציה בצד לקוח (השרת מאמת שוב) */
export function normalizePhone(raw) {
  let s = String(raw || '').trim().replace(/[\s\-().]/g, '');
  if (s.startsWith('+972')) s = s.slice(4); else if (s.startsWith('00972')) s = s.slice(5); else if (s.startsWith('972')) s = s.slice(3); else if (!s.startsWith('0')) return null;
  if (!s.startsWith('0')) s = '0' + s;
  if (!/^05\d{8}$/.test(s) || /^(\d)\1{6}$/.test(s.slice(3))) return null;
  return s;
}
const NAME_RE = /^[\p{L}\p{M}][\p{L}\p{M}'’״׳" .\-]{0,38}[\p{L}\p{M}]$/u;
export const validName = (v) => NAME_RE.test(String(v || '').trim().replace(/\s+/g, ' '));

/* הודעות ומודאל */
let toastBox;
export function toast(msg, type = 'info') {
  if (!toastBox) { toastBox = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' }); document.body.append(toastBox); }
  const t = h('div', { class: 'toast ' + type }, msg);
  toastBox.append(t);
  setTimeout(() => t.remove(), 4200);
}
export function modal(title, content, { onClose } = {}) {
  const prevFocus = document.activeElement;
  const box = h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title }, h('h3', null, title), content);
  const overlay = h('div', { class: 'overlay' }, box);
  const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); if (prevFocus && prevFocus.focus) prevFocus.focus(); if (onClose) onClose(); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', onKey);
  document.body.append(overlay);
  const first = box.querySelector('input, select, button.btn');
  if (first) first.focus();
  return { close, box };
}
export function confirmBox(title, text, okLabel, danger) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const m = modal(title, h('div', null, h('p', { class: 'muted' }, text),
      h('div', { class: 'acts' },
        h('button', { class: 'btn ' + (danger ? 'danger' : 'primary'), onclick: () => { finish(true); m.close(); } }, okLabel),
        h('button', { class: 'btn ghost', onclick: () => { finish(false); m.close(); } }, 'חזרה'))), { onClose: () => finish(false) });
  });
}
export const spinner = () => h('div', { class: 'spinner', role: 'progressbar', 'aria-label': 'טוען' });

/* בורר שעות: קבוצות בוקר / צהריים / ערב */
export function slotGrid(slots, selected, onPick) {
  if (!slots.length) return h('div', { class: 'empty' }, 'אין שעות פנויות ביום זה. נסו יום אחר.');
  const groups = [['בוקר', (m) => m < 720], ['צהריים', (m) => m >= 720 && m < 1020], ['ערב', (m) => m >= 1020]];
  return h('div', null, groups.map(([name, f]) => {
    const part = slots.filter(f);
    if (!part.length) return null;
    return h('div', null, h('div', { class: 'grp' }, name),
      h('div', { class: 'times' }, part.map((m) => h('button', { type: 'button', class: 'time' + (m === selected ? ' sel' : ''), onclick: () => onPick(m) }, fmtTime(m)))));
  }));
}

/* רצועת ימים */
export function dayStrip(days, selected, onPick) {
  const strip = h('div', { class: 'days', role: 'listbox', 'aria-label': 'בחירת תאריך' }, days.map((d) => h('button', {
    type: 'button', class: 'day' + (d.date === selected ? ' sel' : ''), disabled: !d.available, role: 'option',
    'aria-label': fmtDateMid(d.date) + (d.available ? '' : ' – אין שעות פנויות'), onclick: () => onPick(d.date),
  }, h('div', { class: 'w' }, weekdayShort(d.date)), h('div', { class: 'n' }, dayNum(d.date)), h('div', { class: 'm' }, monthShort(d.date)))));
  return strip;
}

/* עורך שעות עבודה שבועי (משמש את ניהול הצוות ואת אשף ההקמה). initial: [{weekday,start_min,end_min}] */
export function hoursEditor(initial) {
  const rows = WEEKDAYS.map((day, wd) => {
    const cur = (initial || []).find((x) => x.weekday === wd);
    const on = h('input', { type: 'checkbox', checked: !!cur, 'aria-label': `עובד ביום ${day}` });
    const s = h('input', { class: 'inp', type: 'time', value: fmtTime(cur ? cur.start_min : 540), disabled: !cur, 'aria-label': `התחלה ביום ${day}` });
    const e = h('input', { class: 'inp', type: 'time', value: fmtTime(cur ? cur.end_min : 1080), disabled: !cur, 'aria-label': `סיום ביום ${day}` });
    on.addEventListener('change', () => { s.disabled = e.disabled = !on.checked; });
    return { wd, on, s, e, el: h('div', { class: 'h' }, h('label', { class: 'chk' }, on, day), s, e) };
  });
  return {
    el: h('div', { class: 'hrs' }, rows.map((r) => r.el)),
    // מחזיר { hours } או { error }
    read() {
      const hours = [];
      for (const r of rows) {
        if (!r.on.checked) continue;
        const st = parseTime(r.s.value), en = parseTime(r.e.value);
        if (st === null || en === null || en <= st) return { error: `שעות לא תקינות ביום ${WEEKDAYS[r.wd]}` };
        hours.push({ weekday: r.wd, start_min: st, end_min: en });
      }
      return { hours };
    },
  };
}

/* מיתוג העסק: צבע מבטא שנבחר מחליף את משתני הערכה (אחרי שהערכה נטענה). בהירות הערכה נגזרת מרקע הערכה, והטקסט על הצבע נבחר לפי ניגודיות. */
export function applyBrand(brand) {
  const st = document.documentElement.style;
  const vars = ['--accent-rgb', '--gold', '--gold-hi', '--gold-lo', '--gold-grad', '--on-accent', '--on-accent-2'];
  if (!brand || !/^#[0-9a-f]{6}$/.test(brand.accent || '')) { vars.forEach((v) => st.removeProperty(v)); return; }
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(brand.accent.slice(i, i + 2), 16));
  const mix = (to, k) => [r, g, b].map((c) => Math.round(c + (to - c) * k));
  const hex = (a) => '#' + a.map((v) => v.toString(16).padStart(2, '0')).join('');
  const bg = (getComputedStyle(document.documentElement).getPropertyValue('--bg') || '#000').trim();
  const m = /^#([0-9a-f]{6})$/i.exec(bg); const bl = m ? (parseInt(m[1].slice(0, 2), 16) * 299 + parseInt(m[1].slice(2, 4), 16) * 587 + parseInt(m[1].slice(4, 6), 16) * 114) / 1000 : 0;
  const darkTheme = bl < 128, white = 255, black = 0;
  const hi = darkTheme ? mix(white, 0.35) : mix(black, 0.28), lo = darkTheme ? mix(black, 0.35) : mix(white, 0.45);
  const lum = (r * 299 + g * 587 + b * 114) / 1000;
  st.setProperty('--accent-rgb', `${r}, ${g}, ${b}`); st.setProperty('--gold', brand.accent); st.setProperty('--gold-hi', hex(hi)); st.setProperty('--gold-lo', hex(lo));
  st.setProperty('--gold-grad', `linear-gradient(135deg, ${hex(mix(white, 0.18))} 0%, ${brand.accent} 55%, ${hex(mix(black, 0.22))} 100%)`);
  st.setProperty('--on-accent', lum > 150 ? '#1a1405' : '#ffffff'); st.setProperty('--on-accent-2', lum > 150 ? '#3d2f0b' : '#f3f3f3');
}
// אותו אתר משרת עסקים רבים: הבית מנותב לפי host רק כשהדומיין פעיל. הכתובת נשארת על אותו host.
export async function resolveCustomHost() {
  try { const d = await api('/api/public/host'); return d && d.slug ? d : null; } catch { return null; }
}

// באנר לעסקי הדגמה: נתונים סינתטיים בלבד. עסק הדגמה אינו עסק אמיתי ואינו מתקשר עם איש.
export const demoBanner = (shop) => (shop && shop.is_demo ? h('div', { class: 'notice demo', role: 'note', 'data-demo': '1' }, 'זהו עסק הדגמה עם נתונים לדוגמה בלבד. אין כאן עסק אמיתי, ושום הודעה לא נשלחת.') : null);
