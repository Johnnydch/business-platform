import { openWizard, domainPanel } from './wizard.js';
import { brandView } from './brandadmin.js';
import { applyTheme, applyBrand, hoursEditor, labelsOf, fmtRange, h, mount, api, icon, spinner, toast, modal, confirmBox, slotGrid, fmtTime, parseTime, fmtDateLong, fmtDateMid, fmtDateShort, fmtPrice, fmtPhone, todayLocal, addDays, STATUS, WEEKDAYS, normalizePhone } from './common.js';

const root = document.getElementById('app');
const S = { user: null, shop: null, shopId: null, shops: [], tab: null, cal: { date: todayLocal(), barber: 'all' } };
const isSuper = () => S.user && S.user.role === 'super_admin';
const withShop = (path) => (isSuper() && S.shopId ? path + (path.includes('?') ? '&' : '?') + 'shop_id=' + S.shopId : path);
const A = (path, opts) => api(withShop(path), opts);
const guard = (fn) => async (...a) => { try { return await fn(...a); } catch (e) { if (e.status === 401) return boot(); toast(e.message, 'err'); } };

const store = { get: (k) => { try { return sessionStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { sessionStorage.setItem(k, v); } catch { /* ignore */ } } };

/* ---------- עזרי טפסים ---------- */
const formField = (label, input, key) => h('div', { class: 'field' }, h('label', null, label), input, h('div', { class: 'errmsg', 'data-err': key }));
function setErrors(scope, fields) {
  scope.querySelectorAll('[data-err]').forEach((e) => { e.textContent = ''; });
  scope.querySelectorAll('.inp.err').forEach((e) => e.classList.remove('err'));
  for (const [k, v] of Object.entries(fields || {})) {
    const e = scope.querySelector(`[data-err="${k}"]`); if (e) e.textContent = v;
    const i = scope.querySelector(`[name="${k}"]`); if (i) i.classList.add('err');
  }
}
const inp = (name, attrs = {}) => h('input', { class: 'inp', name, ...attrs });
const sel = (name, options, value, attrs = {}) => h('select', { class: 'inp', name, ...attrs }, options.map(([v, t]) => h('option', { value: v, selected: String(v) === String(value) }, t)));

/* ---------- כניסה ---------- */
function loginView() {
  const form = h('form', { novalidate: true, onsubmit: async (e) => {
    e.preventDefault(); setErrors(form, {});
    const btn = form.querySelector('button'); btn.disabled = true;
    try {
      const r = await api('/api/admin/login', { method: 'POST', body: { email: form.email.value, password: form.password.value } });
      if (r.mfa === 'enroll') return mfaEnrollView(); if (r.mfa === 'verify') return mfaVerifyView();
      await boot();
    }
    catch (err) { btn.disabled = false; form.querySelector('[data-err="form"]').textContent = err.message; }
  } },
    formField('אימייל', inp('email', { type: 'email', autocomplete: 'username', dir: 'ltr', required: true }), 'email'),
    formField('סיסמה', inp('password', { type: 'password', autocomplete: 'current-password', dir: 'ltr', required: true }), 'password'),
    h('div', { class: 'errmsg', 'data-err': 'form' }),
    h('button', { class: 'btn primary block', type: 'submit' }, 'כניסה'));
  mount(root, h('div', { class: 'wrap login' }, h('header', { class: 'brand' }, h('div', { class: 'mark' }, 'Barbershop'), h('h1', null, 'כניסת צוות'), h('div', { class: 'orn' }, h('i'))), h('div', { class: 'card gold' }, form), h('p', { class: 'center muted' }, h('a', { href: '/' }, 'לדף ההזמנות'))));
}

/* ---------- אימות דו-שלבי (TOTP) ---------- */
// Super Admin חייב להגדיר ולאמת TOTP לפני שהשרת/מסד מאפשרים כל פעולה. Owner יכול להפעיל אותו אופציונלית בהגדרות.
const brandHead = (t) => h('header', { class: 'brand' }, h('div', { class: 'mark' }, 'Barbershop'), h('h1', null, t), h('div', { class: 'orn' }, h('i')));
const codeInput = () => inp('code', { inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 7, dir: 'ltr', placeholder: '000000', required: true, 'aria-label': 'קוד אימות בן 6 ספרות' });
async function mfaEnrollView() {
  mount(root, h('div', { class: 'wrap login' }, brandHead('הגדרת אימות דו-שלבי'), spinner()));
  let e;
  try { e = await api('/api/admin/mfa/enroll', { method: 'POST', body: {} }); }
  catch (err) {
    if (err.code === 'mfa_already_enrolled') return mfaVerifyView();
    if (err.status === 401) return loginView();
    return mount(root, h('div', { class: 'wrap login' }, brandHead('הגדרת אימות דו-שלבי'), h('div', { class: 'notice bad' }, err.message)));
  }
  const code = codeInput();
  const form = h('form', { novalidate: true, onsubmit: async (ev) => {
    ev.preventDefault(); setErrors(form, {}); const btn = form.querySelector('button'); btn.disabled = true;
    try { await api('/api/admin/mfa/enroll/verify', { method: 'POST', body: { factor_id: e.factor_id, code: code.value } }); await boot(); }
    catch (er) { btn.disabled = false; setErrors(form, { code: er.message }); }
  } },
    h('ol', { class: 'steps' },
      h('li', null, 'התקינו אפליקציית אימות (Google Authenticator, Microsoft Authenticator, Authy או מנהל הסיסמאות שלכם).'),
      h('li', null, 'סרקו את קוד ה-QR, או הזינו ידנית את המפתח שמתחתיו.'),
      h('li', null, 'הזינו כאן את הקוד בן 6 הספרות שהאפליקציה מציגה.')),
    h('img', { class: 'qr', src: e.qr_code, alt: 'קוד QR להגדרת אפליקציית אימות', width: 200, height: 200 }),
    h('div', { class: 'secret ltr', 'aria-label': 'מפתח להזנה ידנית' }, e.secret),
    formField('קוד אימות', code, 'code'),
    h('button', { class: 'btn primary block', type: 'submit' }, 'אימות והפעלה'));
  mount(root, h('div', { class: 'wrap login' }, brandHead('הגדרת אימות דו-שלבי'), h('div', { class: 'card gold' }, form),
    h('p', { class: 'center muted' }, h('button', { class: 'btn ghost sm', type: 'button', onclick: logout }, 'יציאה'))));
}
function mfaVerifyView() {
  const code = codeInput();
  const form = h('form', { novalidate: true, onsubmit: async (ev) => {
    ev.preventDefault(); setErrors(form, {}); const btn = form.querySelector('button'); btn.disabled = true;
    try { await api('/api/admin/mfa/verify', { method: 'POST', body: { code: code.value } }); await boot(); }
    catch (er) { btn.disabled = false; setErrors(form, { code: er.message }); }
  } }, h('p', { class: 'muted' }, 'הזינו את הקוד בן 6 הספרות מאפליקציית האימות.'), formField('קוד אימות', code, 'code'), h('button', { class: 'btn primary block', type: 'submit' }, 'אימות'));
  mount(root, h('div', { class: 'wrap login' }, brandHead('אימות דו-שלבי'), h('div', { class: 'card gold' }, form),
    h('p', { class: 'center muted' }, h('button', { class: 'btn ghost sm', type: 'button', onclick: logout }, 'יציאה'))));
  code.focus();
}
async function logout() { try { await api('/api/admin/logout', { method: 'POST' }); } catch { /* ignore */ } S.user = null; S.tab = null; loginView(); }
// אימות חוזר לפעולה רגישה: השרת מחזיר mfa_stale; מבקשים קוד TOTP טרי ומנסים שוב פעם אחת
function askTotp() {
  return new Promise((resolve, reject) => {
    const code = codeInput(); let done = false;
    const form = h('form', { novalidate: true, onsubmit: async (ev) => {
      ev.preventDefault(); setErrors(form, {}); const btn = form.querySelector('button[type=submit]'); btn.disabled = true;
      try { await api('/api/admin/mfa/verify', { method: 'POST', body: { code: code.value } }); done = true; m.close(); resolve(); }
      catch (er) { btn.disabled = false; setErrors(form, { code: er.message }); }
    } }, h('p', { class: 'muted' }, 'זו פעולה רגישה. הזינו קוד חדש מאפליקציית האימות כדי להמשיך.'), formField('קוד אימות', code, 'code'),
      h('div', { class: 'acts' }, h('button', { class: 'btn primary', type: 'submit' }, 'אימות והמשך'), h('button', { class: 'btn ghost', type: 'button', onclick: () => m.close() }, 'ביטול')));
    const m = modal('אימות נוסף נדרש', form, { onClose: () => { if (!done) reject(Object.assign(new Error('הפעולה בוטלה'), { cancelled: true })); } });
  });
}
async function sensitive(path, opts) {
  try { return await api(path, opts); }
  catch (e) { if (e.code === 'mfa_stale') { await askTotp(); return api(path, opts); } throw e; }
}
// הפעלת MFA ע"י Owner (אופציונלי)
async function enableMfaModal() {
  let e; try { e = await api('/api/admin/mfa/enroll', { method: 'POST', body: {} }); } catch (er) { toast(er.message, 'err'); return; }
  const code = codeInput();
  const form = h('form', { novalidate: true, onsubmit: async (ev) => {
    ev.preventDefault(); setErrors(form, {});
    try { await api('/api/admin/mfa/enroll/verify', { method: 'POST', body: { factor_id: e.factor_id, code: code.value } }); m.close(); toast('האימות הדו-שלבי הופעל', 'ok'); go('settings'); }
    catch (er) { setErrors(form, { code: er.message }); }
  } }, h('img', { class: 'qr', src: e.qr_code, alt: 'קוד QR להגדרת אפליקציית אימות', width: 180, height: 180 }), h('div', { class: 'secret ltr' }, e.secret),
    formField('קוד אימות', code, 'code'), h('div', { class: 'acts' }, h('button', { class: 'btn primary', type: 'submit' }, 'אימות והפעלה'), h('button', { class: 'btn ghost', type: 'button', onclick: () => m.close() }, 'ביטול')));
  const m = modal('הפעלת אימות דו-שלבי', form);
}

/* ---------- מבנה ראשי ---------- */
// הלשוניות תלויות בסוג התבנית: תבניות הזמנות (booking) מקבלות יומן וצוות; תבניות לידים/קטלוג – פניות, שירותים והגדרות.
const T = () => labelsOf({ labels: S.labels });
const tabsFor = () => {
  const L = T();
  const booking = [['dashboard', 'סקירה', 'chart'], ['calendar', L.calendar, 'cal'], ['team', L.staff_many, L.staff_icon], ['services', L.service_many, 'tag'], ['customers', L.customers, 'users'], ['leads', L.leads_tab, 'mail'], ['audit', 'יומן פעולות', 'shield'], ['settings', 'הגדרות', 'gear']];
  const leadsOnly = [['leads', L.leads_tab, 'mail'], ['services', L.service_many, 'tag'], ['audit', 'יומן פעולות', 'shield'], ['settings', 'הגדרות', 'gear']];
  return (isSuper() ? [['platform', 'פלטפורמה', 'shield'], ['brand', 'מותג', 'tag']] : []).concat(S.kind && S.kind !== 'booking' ? leadsOnly : booking);
};
const defaultTab = () => (S.kind && S.kind !== 'booking' ? 'leads' : 'dashboard');
const VIEWS = { dashboard: dashboardView, calendar: calendarView, team: teamView, services: servicesView, customers: customersView, leads: leadsView, settings: settingsView, audit: auditView, platform: platformView, brand: (host) => brandView(host, { formField, setErrors, inp, sensitive }) };
let viewHost, navHost;
function renderTabs() {
  navHost.replaceChildren(...tabsFor().map(([k, label, ic]) => h('button', { type: 'button', 'data-tab': k, class: k === S.tab ? 'on' : '', 'aria-current': k === S.tab ? 'page' : null, onclick: () => go(k) }, icon(ic), label)));
}
// מנהל-על: סוג התבנית והתוויות של העסק הנבחר
async function syncShop() {
  const sh = (await A('/api/admin/shop')).shop;
  const changed = S.kind !== sh.kind;
  S.kind = sh.kind; S.labels = sh.labels;
  if (changed) { if (!tabsFor().some((t) => t[0] === S.tab)) S.tab = defaultTab(); renderTabs(); }
}

async function boot() {
  let me;
  try { me = await api('/api/admin/me'); S.user = me.user; S.shop = me.shop; S.mfa = me.mfa; }
  catch { return loginView(); }
  if (me.mfa && me.mfa.needs_verification) return me.mfa.enrolled ? mfaVerifyView() : mfaEnrollView();
  if (isSuper()) {
    await refreshShops();
    const saved = store.get('bs_shop');
    S.shopId = S.shops.some((s) => s.id === saved) ? saved : null;
    S.tab = S.tab || 'platform';
  } else {
    S.kind = me.shop && me.shop.kind; S.labels = me.shop && me.shop.labels;
    if (me.shop && me.shop.theme) { await applyTheme(me.shop.theme); applyBrand(me.shop.brand); }
    S.tab = S.tab && S.tab !== 'platform' && tabsFor().some((t) => t[0] === S.tab) ? S.tab : defaultTab();
  }
  layout();
}
async function refreshShops() { S.shops = (await api('/api/super/shops')).shops; }

function layout() {
  viewHost = h('main', { class: 'wrap wide view page', id: 'view' });
  navHost = h('nav', { class: 'tabs', 'aria-label': 'ניווט' });
  const title = isSuper() ? 'Super Admin' : (S.shop ? S.shop.name : 'ניהול');
  mount(root,
    h('div', { class: 'topbar' }, h('div', { class: 'wrap wide in' }, h('div', { class: 'ttl' }, title),
      isSuper() && h('select', { class: 'inp', 'aria-label': 'בחירת עסק', onchange: (e) => { S.shopId = e.target.value || null; store.set('bs_shop', S.shopId || ''); go(S.tab === 'platform' ? 'calendar' : S.tab); } },
        [h('option', { value: '' }, 'בחרו עסק…')].concat(S.shops.map((s) => h('option', { value: s.id, selected: s.id === S.shopId }, s.name)))))),
    viewHost,
    navHost);
  renderTabs();
  go(S.tab);
}

async function go(tab) {
  S.tab = tab;
  document.querySelectorAll('.tabs button').forEach((b) => { const on = b.dataset.tab === tab; b.classList.toggle('on', on); if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
  document.querySelector('.topbar select') && (document.querySelector('.topbar select').value = S.shopId || '');
  window.scrollTo({ top: 0 });
  if (tab !== 'platform' && tab !== 'brand' && tab !== 'audit' && isSuper() && !S.shopId) {
    mount(viewHost, h('div', { class: 'empty' }, 'בחרו עסק בתפריט העליון כדי לנהל אותו.'), isSuper() && h('p', { class: 'center' }, h('button', { class: 'btn', type: 'button', onclick: () => go('platform') }, 'לרשימת העסקים')));
    return;
  }
  mount(viewHost, spinner());
  try { if (isSuper() && tab !== 'platform' && tab !== 'brand' && !(tab === 'audit' && !S.shopId)) { await syncShop(); tab = S.tab; } await VIEWS[tab](viewHost); } catch (e) { if (e.status === 401) return boot(); mount(viewHost, h('div', { class: 'notice bad' }, e.message)); }
}

/* ---------- סקירה ---------- */
async function dashboardView(host) {
  const [d, shop] = await Promise.all([A('/api/admin/dashboard'), A('/api/admin/shop')]);
  const link = `${location.origin}/b/${shop.shop.slug}`;
  const stat = (n, l) => h('div', { class: 'stat' }, h('div', { class: 'n' }, n), h('div', { class: 'l' }, l));
  mount(host, h('h2', null, 'סקירה'),
    (!d.has_barbers || !d.has_services) && h('div', { class: 'notice warn' }, 'כדי להתחיל לקבל הזמנות יש להגדיר ', !d.has_barbers ? `לפחות ${T().staff_one} אחד (לשונית "${T().staff_many}")` : null, !d.has_barbers && !d.has_services ? ' ו' : null, !d.has_services ? `לפחות ${T().service_one} אחד (לשונית "${T().service_many}")` : null, '.'),
    h('div', { class: 'stats' }, stat(d.today, `${T().appt_many} היום`), stat(d.remaining_today, 'נותרו להיום'), stat(d.tomorrow, `${T().appt_many} מחר`), stat(d.next7, 'ב-7 הימים הקרובים'),
      stat(fmtPrice(d.revenue_today).replace('ללא עלות', '₪0'), `סכום ${T().appt_many} היום`), stat(d.cancelled7, 'ביטולים ב-7 ימים'), stat(d.customers, 'לקוחות במאגר'), stat(d.new_leads, 'פניות חדשות')),
    h('div', { class: 'card' }, h('strong', null, 'קישור הזמנה ללקוחות'),
      h('div', { class: 'linkbox' }, h('input', { class: 'inp', readonly: true, value: link, 'aria-label': 'קישור הזמנה', onfocus: (e) => e.target.select() }),
        h('button', { class: 'btn sm', type: 'button', onclick: async () => { try { await navigator.clipboard.writeText(link); toast('הקישור הועתק', 'ok'); } catch { toast('סמנו והעתיקו את הקישור', 'info'); } } }, icon('copy', 18), 'העתקה'))),
    h('h2', { class: 'h-step' }, `ה${T().appt_many} הקרובים`),
    d.upcoming.length ? h('div', { class: 'list' }, d.upcoming.map((a) => apptItem(a))) : h('div', { class: 'empty' }, `אין ${T().appt_many} קרובים.`));
}
const apptItem = (a) => h('button', { class: 'item', type: 'button', style: null, onclick: () => apptModal(a) },
  h('div', { class: 'grow' }, h('div', { class: 't' }, `${fmtTime(a.start_min)} · ${a.first_name} ${a.last_name}`), h('div', { class: 'd' }, `${fmtDateMid(a.date)} · ${a.service_name} · ${a.barber_name}`)),
  h('span', { class: 'pill ' + (a.status === 'confirmed' ? 'ok' : 'gold') }, STATUS[a.status]));

/* ---------- יומן ---------- */
const PX = 64;
function nowMin() { const p = {}; for (const x of new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date())) p[x.type] = x.value; return Number(p.hour) * 60 + Number(p.minute); }

async function calendarView(host) {
  const date = S.cal.date;
  const [shopR, barbersR, apptsR, blocksR] = await Promise.all([A('/api/admin/shop'), A('/api/admin/barbers'), A(`/api/admin/appointments?from=${date}&to=${date}`), A(`/api/admin/blocks?from=${date}&to=${date}`)]);
  const step = shopR.shop.slot_step;
  const activeBarbers = barbersR.barbers.filter((b) => b.active);
  const shown = S.cal.barber === 'all' ? activeBarbers : activeBarbers.filter((b) => String(b.id) === String(S.cal.barber));
  const wd = new Date(date + 'T12:00:00').getDay();
  const reload = () => go('calendar');

  let lo = 24 * 60, hi = 0;
  shown.forEach((b) => { const w = b.hours.find((x) => x.weekday === wd); if (w) { lo = Math.min(lo, w.start_min); hi = Math.max(hi, w.end_min); } });
  apptsR.appointments.forEach((a) => { lo = Math.min(lo, a.start_min); hi = Math.max(hi, a.end_min); });
  blocksR.blocks.forEach((k) => { lo = Math.min(lo, k.start_min); hi = Math.max(hi, k.end_min); });
  if (hi <= lo) { lo = 9 * 60; hi = 18 * 60; }
  const startMin = Math.floor(lo / 60) * 60, endMin = Math.min(1440, Math.ceil(hi / 60) * 60), H = ((endMin - startMin) / 60) * PX;
  const place = (el, s, e) => { el.style.top = ((s - startMin) * PX) / 60 + 'px'; el.style.height = Math.max(22, ((e - s) * PX) / 60 - 2) + 'px'; return el; };

  const cols = shown.map((b) => {
    const col = h('div', { class: 'col' }); col.style.height = H + 'px';
    const w = b.hours.find((x) => x.weekday === wd);
    const off = (s, e) => { const o = h('div', { class: 'off' }); o.style.top = ((s - startMin) * PX) / 60 + 'px'; o.style.height = ((e - s) * PX) / 60 + 'px'; col.append(o); };
    if (!w) off(startMin, endMin); else { if (w.start_min > startMin) off(startMin, w.start_min); if (w.end_min < endMin) off(w.end_min, endMin); }
    apptsR.appointments.filter((a) => a.barber_id === b.id).forEach((a) => {
      const el = h('div', { class: 'appt ' + a.status, role: 'button', tabindex: '0', onclick: (ev) => { ev.stopPropagation(); apptModal(a, reload); }, onkeydown: (ev) => { if (ev.key === 'Enter') apptModal(a, reload); } },
        h('b', null, `${a.first_name} ${a.last_name}`), `${fmtTime(a.start_min)} · ${a.service_name}`);
      col.append(place(el, a.start_min, a.end_min));
    });
    blocksR.blocks.filter((k) => k.barber_id === b.id || k.barber_id === null).forEach((k) => {
      const el = h('div', { class: 'block', role: 'button', tabindex: '0', onclick: (ev) => { ev.stopPropagation(); blockModal(k, reload); } }, `חסום${k.note ? ': ' + k.note : ''}`);
      col.append(place(el, k.start_min, k.end_min));
    });
    col.addEventListener('click', (ev) => {
      if (ev.target !== col) return;
      const m = Math.max(startMin, startMin + Math.floor(((ev.offsetY / PX) * 60) / step) * step);
      newApptModal({ barberId: b.id, date, start: m }, reload);
    });
    return h('div', { class: 'colw' }, h('div', { class: 'chead' }, b.name), col);
  });
  const hours = h('div', { class: 'hours' }, h('div', { class: 'sp' }), Array.from({ length: (endMin - startMin) / 60 }, (_, i) => h('div', null, fmtTime(startMin + i * 60))));
  const cal = h('div', { class: 'cal', role: 'region', 'aria-label': T().calendar }, hours, cols.length ? cols : h('div', { class: 'empty grow' }, `אין ${T().staff_many} פעילים. הוסיפו בלשונית "${T().staff_many}".`));
  if (date === todayLocal()) {
    const nm = nowMin();
    if (nm >= startMin && nm <= endMin && cols.length) cols.forEach((c) => { const line = h('div', { class: 'now' }); line.style.top = ((nm - startMin) * PX) / 60 + 'px'; c.querySelector('.col').append(line); });
  }
  const setDate = (d) => { if (d) { S.cal.date = d; reload(); } };
  mount(host,
    h('h2', null, 'יומן', h('button', { class: 'btn sm', type: 'button', onclick: () => blockModal(null, reload, { date }) }, 'חסימת זמן')),
    h('div', { class: 'calbar' },
      h('button', { class: 'btn sm', type: 'button', 'aria-label': 'יום קודם', onclick: () => setDate(addDays(date, -1)) }, '→'),
      h('div', { class: 'dt' }, fmtDateMid(date)),
      h('button', { class: 'btn sm', type: 'button', 'aria-label': 'יום הבא', onclick: () => setDate(addDays(date, 1)) }, '←'),
      h('button', { class: 'btn sm', type: 'button', onclick: () => setDate(todayLocal()) }, 'היום'),
      h('input', { class: 'inp', type: 'date', value: date, 'aria-label': 'בחירת תאריך', style: null, onchange: (e) => setDate(e.target.value) })),
    h('div', { class: 'chips' }, [['all', T().all_staff]].concat(activeBarbers.map((b) => [String(b.id), b.name])).map(([v, t]) =>
      h('button', { class: 'chip' + (String(S.cal.barber) === v ? ' on' : ''), type: 'button', onclick: () => { S.cal.barber = v; reload(); } }, t))),
    cal, h('p', { class: 'hint' }, 'לחיצה על משבצת פנויה פותחת תור חדש. אזורים מקווקווים הם מחוץ לשעות העבודה.'),
    h('button', { class: 'fab', type: 'button', 'aria-label': 'תור חדש', onclick: () => newApptModal({ date }, reload) }, icon('plus')));
}

function apptModal(a, reload) {
  const done = () => { m.close(); if (reload) reload(); else go(S.tab); };
  const setStatus = (status, msg) => guard(async () => { await A(`/api/admin/appointments/${a.id}`, { method: 'PATCH', body: { status } }); toast(msg, 'ok'); done(); });
  const wa = `https://wa.me/972${a.phone.slice(1)}`;
  const m = modal('פרטי תור', h('div', null,
    h('div', { class: 'kv' }, [['לקוח', `${a.first_name} ${a.last_name}`], ['נייד', h('a', { class: 'ltr', href: `tel:${a.phone}` }, fmtPhone(a.phone))], ['שירות', `${a.service_name} · ${fmtPrice(a.price_ils)}`], [T().staff_one, a.barber_name],
      ['מועד', `${fmtDateMid(a.date)}, ${fmtRange(a.start_min, a.end_min)}`], ['סטטוס', STATUS[a.status]], ['מקור', a.source === 'online' ? 'הזמנה אונליין' : 'נוסף ע"י העסק'], a.notes ? ['הערות', a.notes] : null]
      .filter(Boolean).flatMap(([k, v]) => [h('div', { class: 'k' }, k), h('div', { class: 'v' }, v)])),
    h('div', { class: 'acts' },
      a.status === 'confirmed' && h('button', { class: 'btn primary', type: 'button', onclick: setStatus('completed', 'התור סומן כהושלם') }, 'סימון כהושלם'),
      a.status === 'confirmed' && h('button', { class: 'btn', type: 'button', onclick: setStatus('no_show', 'התור סומן כ"לא הגיע"') }, 'לא הגיע'),
      a.status !== 'cancelled' && h('button', { class: 'btn danger', type: 'button', onclick: guard(async () => { if (await confirmBox('לבטל את התור?', `התור של ${a.first_name} ${a.last_name} ישוחרר. הלקוח לא יקבל הודעה אוטומטית.`, 'ביטול התור', true)) setStatus('cancelled', 'התור בוטל')(); }) }, 'ביטול תור'),
      a.status === 'cancelled' && h('button', { class: 'btn', type: 'button', onclick: setStatus('confirmed', 'התור שוחזר') }, 'שחזור תור'),
      h('a', { class: 'btn ghost', href: wa, target: '_blank', rel: 'noopener noreferrer' }, 'WhatsApp ללקוח'))));
}

async function newApptModal(pre, reload) {
  const [bR, sR] = await Promise.all([A('/api/admin/barbers'), A('/api/admin/services')]);
  const barbers = bR.barbers.filter((b) => b.active), services = sR.services.filter((s) => s.active);
  if (!barbers.length || !services.length) { toast(`יש להגדיר ${T().staff_one} ו${T().service_one} לפני הוספת ${T().appt_many}`, 'err'); return; }
  const P = { time: pre.start ?? null, slots: null };
  const form = h('form', { novalidate: true });
  const fBarber = sel('barber_id', barbers.map((b) => [b.id, b.name]), pre.barberId || barbers[0].id);
  const fService = sel('service_id', services.map((s) => [s.id, `${s.name} (${s.duration_min} דק')`]), services[0].id);
  const fDate = inp('date', { type: 'date', value: pre.date || todayLocal() });
  const slotsHost = h('div');
  const paint = () => {
    if (!P.slots) { slotsHost.replaceChildren(spinner()); return; }
    slotsHost.replaceChildren(slotGrid(P.slots, P.time, (t) => { P.time = t; paint(); }));
  };
  const loadSlots = guard(async () => {
    P.slots = null; paint();
    const r = await A(`/api/admin/availability?barber_id=${fBarber.value}&service_id=${fService.value}&date=${fDate.value}`);
    P.slots = r.slots; if (!P.slots.includes(P.time)) P.time = null; paint();
  });
  [fBarber, fService, fDate].forEach((el) => el.addEventListener('change', loadSlots));
  const first = inp('first_name', { autocomplete: 'off', maxlength: 40 }), last = inp('last_name', { autocomplete: 'off', maxlength: 40 });
  const phone = inp('phone', { type: 'tel', inputmode: 'tel', dir: 'ltr', placeholder: '050-0000000', autocomplete: 'off' });
  const notes = inp('notes', { maxlength: 300 });
  const submit = h('button', { class: 'btn primary', type: 'submit' }, 'שמירת התור');
  form.append(formField(T().staff_one, fBarber, 'barber_id'), formField(T().service_one, fService, 'service_id'), formField('תאריך', fDate, 'date'),
    h('div', { class: 'field' }, h('label', null, 'שעה'), slotsHost, h('div', { class: 'errmsg', 'data-err': 'time' })),
    h('div', { class: 'row2' }, formField('שם פרטי', first, 'first_name'), formField('שם משפחה', last, 'last_name')),
    formField('נייד', phone, 'phone'), formField('הערות (אופציונלי)', notes, 'notes'),
    h('div', { class: 'acts' }, submit, h('button', { class: 'btn ghost', type: 'button', onclick: () => m.close() }, 'ביטול')));
  const m = modal('תור חדש', form);
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault(); setErrors(form, {});
    if (P.time === null) { setErrors(form, { time: 'יש לבחור שעה' }); return; }
    if (!normalizePhone(phone.value)) { setErrors(form, { phone: 'מספר נייד ישראלי לא תקין' }); return; }
    submit.disabled = true;
    try {
      await A('/api/admin/appointments', { method: 'POST', body: { barber_id: Number(fBarber.value), service_id: Number(fService.value), date: fDate.value, start_min: P.time, first_name: first.value, last_name: last.value, phone: phone.value, notes: notes.value } });
      m.close(); toast('התור נוסף', 'ok'); if (reload) reload();
    } catch (e) {
      submit.disabled = false;
      if (e.fields) setErrors(form, e.fields); else toast(e.message, 'err');
      if (e.code === 'slot_taken') loadSlots();
    }
  });
  loadSlots();
}

function blockModal(k, reload, pre = {}) {
  if (k) { // צפייה / מחיקה
    const m = modal('חסימת זמן', h('div', null, h('div', { class: 'kv' }, [[T().staff_one, k.barber_name || T().all_staff], ['תאריך', fmtDateMid(k.date)], ['שעות', `${fmtRange(k.start_min, k.end_min)}`], k.note ? ['הערה', k.note] : null].filter(Boolean).flatMap(([a, b]) => [h('div', { class: 'k' }, a), h('div', { class: 'v' }, b)])),
      h('div', { class: 'acts' }, h('button', { class: 'btn danger', type: 'button', onclick: guard(async () => { await A(`/api/admin/blocks/${k.id}`, { method: 'DELETE' }); m.close(); toast('החסימה הוסרה', 'ok'); reload && reload(); }) }, 'הסרת החסימה'),
        h('button', { class: 'btn ghost', type: 'button', onclick: () => m.close() }, 'סגירה'))));
    return;
  }
  guard(async () => {
    const bR = await A('/api/admin/barbers');
    const form = h('form', { novalidate: true });
    const fB = sel('barber_id', [['', T().all_staff]].concat(bR.barbers.filter((b) => b.active).map((b) => [b.id, b.name])), '');
    const fD = inp('date', { type: 'date', value: pre.date || todayLocal() });
    const fS = inp('start', { type: 'time', value: '09:00', dir: 'ltr' }), fE = inp('end', { type: 'time', value: '10:00', dir: 'ltr' });
    const fN = inp('note', { maxlength: 120, placeholder: 'למשל: חופשה, הפסקה' });
    form.append(formField(T().staff_one, fB, 'barber_id'), formField('תאריך', fD, 'date'), h('div', { class: 'row2' }, formField('משעה', fS, 'start'), formField('עד שעה', fE, 'end')), formField('הערה', fN, 'note'),
      h('div', { class: 'acts' }, h('button', { class: 'btn primary', type: 'submit' }, 'חסימה'), h('button', { class: 'btn ghost', type: 'button', onclick: () => m.close() }, 'ביטול')));
    const m = modal('חסימת זמן ביומן', form);
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault(); setErrors(form, {});
      const st = parseTime(fS.value), en = parseTime(fE.value);
      if (st === null || en === null || en <= st) { setErrors(form, { end: 'שעת הסיום חייבת להיות אחרי שעת ההתחלה' }); return; }
      try {
        const r = await A('/api/admin/blocks', { method: 'POST', body: { barber_id: fB.value ? Number(fB.value) : null, date: fD.value, start_min: st, end_min: en, note: fN.value } });
        m.close(); toast(r.conflicts ? `נחסם. שימו לב: ${r.conflicts} תורים קיימים חופפים לחסימה` : 'הזמן נחסם', r.conflicts ? 'info' : 'ok'); reload && reload();
      } catch (e) { toast(e.message, 'err'); }
    });
  })();
}

/* ---------- ספרים ---------- */
const DEFAULT_HOURS = { 0: [540, 1140], 1: [540, 1140], 2: [540, 1140], 3: [540, 1140], 4: [540, 1140], 5: [480, 840] };
async function teamView(host) {
  const { barbers } = await A('/api/admin/barbers');
  mount(host, h('h2', null, T().staff_many, h('button', { class: 'btn primary sm', type: 'button', onclick: () => barberModal(null) }, '+ ' + T().add_staff)),
    barbers.length ? h('div', { class: 'list' }, barbers.map((b) => h('button', { class: 'item' + (b.active ? '' : ' off'), type: 'button', onclick: () => barberModal(b) },
      h('div', { class: 'avatar' }, b.name.trim()[0]),
      h('div', { class: 'grow' }, h('div', { class: 't' }, b.name), h('div', { class: 'd' }, b.hours.length ? `עובד ${b.hours.length} ימים בשבוע` : 'לא הוגדרו שעות עבודה – לא יופיע להזמנות')),
      h('span', { class: 'pill ' + (b.active ? 'ok' : '') }, b.active ? 'פעיל' : 'מושבת'))))
      : h('div', { class: 'empty' }, `עדיין לא הוגדרו ${T().staff_many}. הוסיפו כדי לפתוח את היומן להזמנות.`));
}
function barberModal(b) {
  const form = h('form', { novalidate: true });
  const name = inp('name', { value: b ? b.name : '', maxlength: 40, autocomplete: 'off' });
  const active = h('input', { type: 'checkbox', checked: b ? b.active : true });
  const ed = hoursEditor(b ? b.hours : Object.entries(DEFAULT_HOURS).map(([wd, [st, en]]) => ({ weekday: Number(wd), start_min: st, end_min: en })));
  form.append(formField(`שם ה${T().staff_one}`, name, 'name'), b && h('label', { class: 'chk' }, active, 'פעיל (מופיע להזמנות אונליין)'),
    h('div', { class: 'field' }, h('label', null, 'שעות עבודה שבועיות'), ed.el, h('div', { class: 'errmsg', 'data-err': 'hours' })),
    h('div', { class: 'acts' }, h('button', { class: 'btn primary', type: 'submit' }, b ? 'שמירה' : T().add_staff), h('button', { class: 'btn ghost', type: 'button', onclick: () => m.close() }, 'ביטול')));
  const m = modal(b ? `עריכת ${T().staff_one}` : T().add_staff, form);
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault(); setErrors(form, {});
    const rd = ed.read(); if (rd.error) { setErrors(form, { hours: rd.error }); return; }
    const hours = rd.hours;
    try {
      let res = null;
      if (b) res = await A(`/api/admin/barbers/${b.id}`, { method: 'PUT', body: { name: name.value, active: active.checked, hours } });
      else await A('/api/admin/barbers', { method: 'POST', body: { name: name.value, hours } });
      m.close(); toast('נשמר', 'ok'); go('team');
      if (res && res.affected_appointments && res.affected_appointments.length) affectedModal(res.affected_appointments);
    } catch (e) { if (e.fields) setErrors(form, e.fields); else toast(e.message, 'err'); }
  });
}

// תורים קיימים אינם משתנים אוטומטית כששעות העבודה משתנות או שהעובד מושבת; מציגים לבעל העסק מה דורש טיפול ידני
function affectedModal(list) {
  const body = h('div', null,
    h('p', { class: 'muted' }, 'ההזמנות הבאות נשארו מאושרות, אך כבר אינן בשעות העבודה הנוכחיות. צרו קשר עם הלקוחות, או בטלו/הזיזו אותן ביומן.'),
    h('div', { class: 'list' }, list.map((a) => h('div', { class: 'row' }, h('div', { class: 'grow' }, h('div', { class: 't' }, `${a.first_name} ${a.last_name}`), h('div', { class: 'd' }, `${fmtDateMid(a.date)} · ${fmtRange(a.start_min, a.end_min)} · ${a.service_name}`))))),
    h('div', { class: 'acts' }, h('button', { class: 'btn gold', type: 'button', onclick: () => mm.close() }, 'הבנתי')));
  const mm = modal(`${list.length} ${T().appt_many} דורשים טיפול`, body);
}

/* ---------- שירותים ---------- */
async function servicesView(host) {
  const { services } = await A('/api/admin/services');
  mount(host, h('h2', null, 'שירותים', h('button', { class: 'btn primary sm', type: 'button', onclick: () => serviceModal(null) }, '+ שירות חדש')),
    services.length ? h('div', { class: 'list' }, services.map((s) => h('button', { class: 'item' + (s.active ? '' : ' off'), type: 'button', onclick: () => serviceModal(s) },
      h('div', { class: 'grow' }, h('div', { class: 't' }, s.name), h('div', { class: 'd' }, `${s.duration_min} דקות`)), h('div', { class: 'gold' }, fmtPrice(s.price_ils)), h('span', { class: 'pill ' + (s.active ? 'ok' : '') }, s.active ? 'פעיל' : 'מושבת'))))
      : h('div', { class: 'empty' }, 'עדיין לא הוגדרו שירותים (למשל תספורת, זקן, תספורת + זקן).'));
}
function serviceModal(s) {
  const form = h('form', { novalidate: true });
  const name = inp('name', { value: s ? s.name : '', maxlength: 60, placeholder: 'למשל: תספורת + זקן' });
  const dur = inp('duration_min', { type: 'number', inputmode: 'numeric', min: 5, max: 480, step: 5, value: s ? s.duration_min : '', placeholder: '30' });
  const price = inp('price_ils', { type: 'number', inputmode: 'numeric', min: 0, value: s ? s.price_ils : '', placeholder: '0' });
  const active = h('input', { type: 'checkbox', checked: s ? s.active : true });
  form.append(formField('שם השירות', name, 'name'), h('div', { class: 'row2' }, formField('משך (דקות)', dur, 'duration_min'), formField('מחיר (₪)', price, 'price_ils')),
    s && h('label', { class: 'chk' }, active, 'שירות פעיל (מופיע להזמנות)'),
    h('div', { class: 'acts' }, h('button', { class: 'btn primary', type: 'submit' }, s ? 'שמירה' : 'הוספה'), h('button', { class: 'btn ghost', type: 'button', onclick: () => m.close() }, 'ביטול')));
  const m = modal(s ? 'עריכת שירות' : 'שירות חדש', form);
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault(); setErrors(form, {});
    const body = { name: name.value, duration_min: dur.value, price_ils: price.value, active: active.checked };
    try {
      if (s) await A(`/api/admin/services/${s.id}`, { method: 'PUT', body }); else await A('/api/admin/services', { method: 'POST', body });
      m.close(); toast('נשמר', 'ok'); go('services');
    } catch (e) { if (e.fields) setErrors(form, e.fields); else toast(e.message, 'err'); }
  });
}

/* ---------- לקוחות ---------- */
async function customersView(host) {
  const list = h('div', { class: 'list' });
  const q = h('input', { class: 'inp', type: 'search', placeholder: 'חיפוש לפי שם או נייד', 'aria-label': 'חיפוש לקוחות' });
  mount(host, h('h2', null, 'לקוחות'), h('div', { class: 'field' }, q), list);
  const load = guard(async () => {
    const { customers } = await A('/api/admin/customers?q=' + encodeURIComponent(q.value));
    list.replaceChildren(...(customers.length ? customers.map((c) => h('div', { class: 'item' },
      h('div', { class: 'avatar' }, c.first_name[0]),
      h('div', { class: 'grow' }, h('div', { class: 't' }, `${c.first_name} ${c.last_name}`), h('div', { class: 'd' }, `${c.visits} ${T().appt_many}${c.last_date ? ' · אחרון: ' + fmtDateShort(c.last_date) : ''}${c.no_shows ? ' · לא הגיע ' + c.no_shows : ''}`)),
      h('a', { class: 'btn sm ltr', href: `tel:${c.phone}` }, icon('phone', 16), fmtPhone(c.phone)))) : [h('div', { class: 'empty' }, q.value ? 'לא נמצאו לקוחות.' : 'עדיין אין לקוחות. הם יתווספו אוטומטית עם כל הזמנה.')]));
  });
  let t; q.addEventListener('input', () => { clearTimeout(t); t = setTimeout(load, 300); });
  load();
}

/* ---------- הגדרות ---------- */
async function settingsView(host) {
  const [{ shop }, sys] = await Promise.all([A('/api/admin/shop'), api('/api/admin/system')]);
  const f = h('form', { novalidate: true });
  const F = { name: inp('name', { value: shop.name, maxlength: 60 }), phone: inp('phone', { value: shop.phone || '', type: 'tel', dir: 'ltr' }), address: inp('address', { value: shop.address || '', maxlength: 120 }),
    slot_step: sel('slot_step', [5, 10, 15, 20, 30, 60].map((n) => [n, `${n} דקות`]), shop.slot_step), min_notice_min: inp('min_notice_min', { type: 'number', min: 0, max: 1440, value: shop.min_notice_min }),
    max_days_ahead: inp('max_days_ahead', { type: 'number', min: 1, max: 180, value: shop.max_days_ahead }), cancel_cutoff_hours: inp('cancel_cutoff_hours', { type: 'number', min: 0, max: 72, value: shop.cancel_cutoff_hours }) };
  const br = shop.brand || {};
  const tg = inp('tagline', { value: br.tagline || '', maxlength: 80 }), ac = h('input', { type: 'color', class: 'inp', name: 'accent', value: br.accent || '#c9a24b', 'aria-label': 'צבע מבטא' });
  let accentOn = !!br.accent; ac.addEventListener('input', () => { accentOn = true; applyBrand({ accent: ac.value }); });
  const accReset = h('button', { class: 'btn sm ghost', type: 'button', onclick: () => { accentOn = false; applyBrand(null); } }, 'ברירת מחדל');
  f.append(formField('שם העסק', F.name, 'name'), formField('טלפון העסק', F.phone, 'phone'), formField('כתובת', F.address, 'address'),
    formField('משפט קצר מתחת לשם (עד 80 תווים)', tg, 'brand.tagline'), formField('צבע מבטא', h('div', { class: 'row' }, ac, accReset), 'brand.accent'),
    formField('מרווח בין שעות פנויות', F.slot_step, 'slot_step'), formField('זמן הודעה מראש מינימלי (דקות)', F.min_notice_min, 'min_notice_min'),
    formField('כמה ימים קדימה אפשר להזמין', F.max_days_ahead, 'max_days_ahead'), formField('ביטול/שינוי עצמי עד כמה שעות לפני התור', F.cancel_cutoff_hours, 'cancel_cutoff_hours'),
    h('button', { class: 'btn primary block', type: 'submit' }, 'שמירת הגדרות'));
  f.addEventListener('submit', async (ev) => {
    ev.preventDefault(); setErrors(f, {});
    try { await A('/api/admin/shop', { method: 'PUT', body: { ...Object.fromEntries(Object.entries(F).map(([k, el]) => [k, el.value])), brand: { tagline: tg.value.trim() || undefined, accent: accentOn ? ac.value : undefined } } }); toast('ההגדרות נשמרו', 'ok'); }
    catch (e) { if (e.fields) setErrors(f, e.fields); else toast(e.message, 'err'); }
  });
  const pw = h('form', { novalidate: true });
  const cur = inp('current', { type: 'password', autocomplete: 'current-password', dir: 'ltr' }), nxt = inp('next', { type: 'password', autocomplete: 'new-password', dir: 'ltr' });
  pw.append(formField('סיסמה נוכחית', cur, 'current'), formField('סיסמה חדשה (לפחות 10 תווים)', nxt, 'next'), h('button', { class: 'btn block', type: 'submit' }, 'החלפת סיסמה'));
  pw.addEventListener('submit', async (ev) => {
    ev.preventDefault(); setErrors(pw, {});
    try { await api('/api/admin/password', { method: 'POST', body: { current: cur.value, next: nxt.value } }); cur.value = nxt.value = ''; toast('הסיסמה הוחלפה', 'ok'); }
    catch (e) { setErrors(pw, { next: e.message }); }
  });
  const row = (k, v, ok) => h('div', { class: 'r' }, h('span', null, k), h('span', { class: ok === undefined ? '' : ok ? 'pill ok' : 'pill bad' }, v));
  mount(host, h('h2', null, 'הגדרות'),
    h('div', { class: 'card' }, f), h('h2', { class: 'h-step' }, ' '),
    h('div', { class: 'card' }, h('strong', null, 'דומיין מותאם'), h('p', { class: 'hint' }, 'הסטטוס מתעדכן רק לפי בדיקת DNS ו-HTTPS אמיתית.'), domainPanel((await api(withShop('/api/admin/domains'))).domains, isSuper() ? S.shopId : null, { platformHost: location.hostname })), h('h2', { class: 'h-step' }, ' '),
    h('div', { class: 'card sys' }, h('strong', null, 'מצב המערכת'),
      row('מסד נתונים', sys.database.type, true), row('שמירת הזמנות ותורים', 'פעיל', true), row('מניעת הזמנות כפולות', 'פעיל', true), row('הגבלת קצב', `פעיל (${sys.rate_limit.type})`, true),
      row('הודעות SMS', sys.notifications.sms ? 'מחובר' : 'לא מחובר', sys.notifications.sms), row('הודעות WhatsApp', sys.notifications.whatsapp ? 'מחובר' : 'לא מחובר', sys.notifications.whatsapp),
      row('חיבור למסד הנתונים', sys.database.connected ? 'מחובר' : 'לא מחובר', sys.database.connected), h('p', { class: 'hint' }, 'הודעות אישור ללקוחות יישלחו רק לאחר חיבור שירות הודעות. עד אז הלקוח מקבל מסך אישור וקישור אישי.')),
    h('h2', { class: 'h-step' }, ' '), h('div', { class: 'card' }, h('strong', null, 'החלפת סיסמה'), h('div', { class: 'field' }), pw),
    h('h2', { class: 'h-step' }, ' '), h('div', { class: 'card' }, h('strong', null, 'אימות דו-שלבי'),
      S.mfa && S.mfa.enrolled ? h('p', { class: 'muted' }, h('span', { class: 'pill ok' }, 'פעיל'), ' הכניסה לחשבון דורשת קוד מאפליקציית האימות.')
        : h('div', null, h('p', { class: 'muted' }, 'מומלץ להוסיף שכבת הגנה: קוד חד-פעמי מאפליקציית אימות בכל כניסה.'), h('button', { class: 'btn', type: 'button', onclick: enableMfaModal }, 'הפעלת אימות דו-שלבי'))),
    h('p', null, h('button', { class: 'btn danger block', type: 'button', onclick: logout }, 'התנתקות')));
}

/* ---------- פלטפורמה (Super Admin) ---------- */
async function platformView(host) {
  await refreshShops();
  const drafts = (await api('/api/super/drafts').catch(() => ({ drafts: [] }))).drafts.filter((d) => d.status === 'draft');
  mount(host, drafts.length ? h('div', { class: 'card', 'data-drafts': '1' }, h('strong', null, 'טיוטות הקמה'),
      drafts.map((d) => h('div', { class: 'item' }, h('div', { class: 'grow' }, h('div', { class: 't' }, d.name || 'ללא שם'), h('div', { class: 'd' }, `${d.template} · שלב ${d.step}/8`)),
        h('button', { class: 'btn sm primary', type: 'button', onclick: () => openNewShop(d.id) }, 'המשך'),
        h('button', { class: 'btn sm danger', type: 'button', onclick: guard(async () => { if (!(await confirmBox('למחוק את הטיוטה?', 'לא נוצר עסק. הפעולה אינה הפיכה.', 'מחיקה', true))) return; await api(`/api/super/drafts/${d.id}`, { method: 'DELETE' }); go('platform'); }) }, 'מחיקה')))) : null,
    h('h2', null, 'עסקים בפלטפורמה', h('button', { class: 'btn primary sm', type: 'button', onclick: newShopModal }, '+ עסק חדש')),
    S.shops.length ? h('div', { class: 'list' }, S.shops.map((s) => h('div', { class: 'card' + (s.active ? '' : ' off') },
      h('div', { class: 'item', style: null }, h('div', { class: 'grow' }, h('div', { class: 't' }, s.name), h('div', { class: 'd ltr' }, `/${s.kind === 'booking' ? 'b' : 'l'}/${s.slug}`), h('div', { class: 'd' }, `${s.template} · ${s.owner_emails || 'ללא בעלים'}`)),
        h('span', { class: 'pill ' + (s.active ? 'ok' : 'bad') }, s.active ? 'פעילה' : 'מושבתת'), s.frozen && h('span', { class: 'pill bad', 'data-frozen': '1' }, 'מוקפא')),
      h('p', { class: 'muted' }, `${s.barbers} אנשי צוות · ${s.services} שירותים · ${s.customers} לקוחות · ${s.upcoming} תורים עתידיים`),
      h('div', { class: 'acts' }, h('button', { class: 'btn sm primary', type: 'button', onclick: () => { S.shopId = s.id; S.kind = s.kind; S.labels = null; store.set('bs_shop', s.id); S.tab = s.kind === 'booking' ? 'calendar' : 'leads'; layout(); } }, 'ניהול העסק'),
        h('a', { class: 'btn sm', href: `/${s.kind === 'booking' ? 'b' : 'l'}/${s.slug}`, target: '_blank', rel: 'noopener' }, s.kind === 'booking' ? 'דף הזמנה' : 'דף ציבורי'),
        h('button', { class: 'btn sm', type: 'button', onclick: () => ownersModal(s) }, 'בעלי העסק'),
        h('button', { class: 'btn sm' + (s.frozen ? ' primary' : ''), type: 'button', onclick: guard(async () => {
          if (!s.frozen && !(await confirmBox('להקפיא כתיבה לעסק?', 'הזמנות, ביטולים, פניות ועריכות ייחסמו עד לשחרור. קריאה נשארת פתוחה. מיועד לזמן הגירה.', 'הקפאה', true))) return;
          await sensitive(`/api/super/shops/${s.id}/freeze`, { method: 'POST', body: { frozen: !s.frozen } }); toast(s.frozen ? 'שוחרר' : 'הוקפא', 'ok'); go('platform');
        }) }, s.frozen ? 'שחרור הקפאה' : 'הקפאת כתיבה'),
        h('button', { class: 'btn sm danger', type: 'button', onclick: () => deleteShopModal(s) }, 'מחיקה'),
        h('button', { class: 'btn sm ' + (s.active ? 'danger' : ''), type: 'button', onclick: guard(async () => {
          if (s.active && !(await confirmBox('להשבית את העסק?', 'דף ההזמנות יוסתר ובעלי העסק ינותקו. הנתונים נשמרים וניתן להפעיל מחדש.', 'השבתה', true))) return;
          await api(`/api/super/shops/${s.id}`, { method: 'PATCH', body: { active: !s.active } }); toast('עודכן', 'ok'); go('platform');
        }) }, s.active ? 'השבתה' : 'הפעלה'))))) : h('div', { class: 'empty' }, 'עדיין אין עסקים. צרו את העסק הראשון.'));
}
function openNewShop(draftId) {
  const host = document.getElementById('view') || viewHost;
  openWizard({ host, sensitive, formField, setErrors, inp, sel, platformHost: location.hostname,
    onExit: () => go('platform'), onDone: async (id) => { await refreshShops(); S.shopId = id; go('platform'); } }, draftId);
}
const newShopModal = () => openNewShop();
function askText(title, label, attrs = {}) {
  return new Promise((resolve) => {
    const i = inp('v', attrs); let done = false;
    const f = h('form', { novalidate: true, onsubmit: (ev) => { ev.preventDefault(); done = true; m.close(); resolve(i.value); } }, formField(label, i, 'v'),
      h('div', { class: 'acts' }, h('button', { class: 'btn primary', type: 'submit' }, 'אישור'), h('button', { class: 'btn ghost', type: 'button', onclick: () => m.close() }, 'ביטול')));
    const m = modal(title, f, { onClose: () => { if (!done) resolve(null); } });
  });
}
// ניהול בעלי עסק: רשימה, שיוך בעלים חדש (חשבון + שיוך אטומי), איפוס סיסמה, הסרה. פעולות רגישות דורשות אימות TOTP טרי.
async function ownersModal(s) {
  let owners;
  try { owners = (await api(`/api/super/shops/${s.id}/owners`)).owners; } catch (e) { toast(e.message, 'err'); return; }
  const m = modal(`בעלי "${s.name}"`, h('div'));
  const body = m.box.lastChild;
  const act = (fn) => async () => { try { await fn(); m.close(); ownersModal(s); } catch (e) { if (!e.cancelled) toast(e.message, 'err'); } };
  const em = inp('owner_email', { type: 'email', dir: 'ltr', autocomplete: 'off' }), pw = inp('owner_password', { type: 'text', dir: 'ltr', autocomplete: 'off', placeholder: 'לפחות 10 תווים' });
  const add = h('form', { novalidate: true, onsubmit: async (ev) => {
    ev.preventDefault(); setErrors(add, {});
    try { await sensitive(`/api/super/shops/${s.id}/owners`, { method: 'POST', body: { owner_email: em.value, owner_password: pw.value } }); toast('הבעלים נוסף', 'ok'); m.close(); ownersModal(s); }
    catch (e) { if (e.cancelled) return; if (e.fields) setErrors(add, e.fields); else toast(e.message, 'err'); }
  } }, h('strong', null, 'הוספת בעלים'), formField('אימייל', em, 'owner_email'), formField('סיסמה זמנית (למסור בערוץ מאובטח; מומלץ להחליף בכניסה ראשונה)', pw, 'owner_password'),
    h('button', { class: 'btn primary', type: 'submit' }, 'הוספה'));
  body.replaceChildren(
    owners.length ? h('div', { class: 'list' }, owners.map((o) => h('div', { class: 'card' }, h('div', { class: 'item' }, h('div', { class: 'grow' }, h('div', { class: 't ltr' }, o.email), h('div', { class: 'd' }, o.mfa ? 'אימות דו-שלבי: פעיל' : 'אימות דו-שלבי: לא הוגדר')),
      h('div', { class: 'acts' },
        h('button', { class: 'btn sm', type: 'button', onclick: async () => {
          const p = await askText('איפוס סיסמה', 'סיסמה חדשה (לפחות 10 תווים)', { type: 'text', dir: 'ltr', autocomplete: 'off' }); if (!p) return;
          try { await sensitive(`/api/super/shops/${s.id}/reset-owner`, { method: 'POST', body: { password: p, owner_user_id: o.user_id } }); toast('הסיסמה אופסה', 'ok'); } catch (e) { if (!e.cancelled) toast(e.message, 'err'); }
        } }, 'איפוס סיסמה'),
        h('button', { class: 'btn sm danger', type: 'button', onclick: act(async () => { if (!(await confirmBox('להסיר את הבעלים?', `${o.email} יימחק מהמערכת ולא יוכל להיכנס.`, 'הסרה', true))) throw Object.assign(new Error(), { cancelled: true }); await sensitive(`/api/super/shops/${s.id}/owners/${o.user_id}`, { method: 'DELETE' }); toast('הבעלים הוסר', 'ok'); }) }, 'הסרה')))))) : h('div', { class: 'empty' }, 'לעסק אין בעלים. הוסיפו בעלים כדי שיוכלו להיכנס.'),
    h('div', { class: 'card' }, add));
}

/* ---------- פניות ---------- */
const LEAD_STATUS = { new: 'חדשה', contacted: 'נוצר קשר', closed: 'נסגרה' };
const fmtDateTime = (iso) => new Intl.DateTimeFormat('he-IL', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Jerusalem' }).format(new Date(iso));
const META_LABEL = { urgency: { today: 'דחוף – היום', week: 'במהלך השבוע', flexible: 'גמיש' }, budget: { lt1k: 'עד \u2066₪1,000\u2069', '1-3k': '\u2066₪1,000–3,000\u2069', '3-10k': '\u2066₪3,000–10,000\u2069', gt10k: 'מעל \u2066₪10,000\u2069', unknown: 'תקציב לא ידוע' }, timeframe: { asap: 'בהקדם', month: 'תוך חודש', flexible: 'לו"ז גמיש' } };
function metaChips(m) {
  if (!m) return null;
  const items = [m.city && `עיר: ${m.city}`, m.urgency && META_LABEL.urgency[m.urgency], m.budget && META_LABEL.budget[m.budget], m.timeframe && META_LABEL.timeframe[m.timeframe]].filter(Boolean);
  return items.length ? h('div', { class: 'chips meta' }, items.map((t) => h('span', { class: 'pill gold' }, t))) : null;
}
async function leadsView(host) {
  const { leads } = await A('/api/admin/leads');
  mount(host, h('h2', null, T().leads_title),
    leads.length ? h('div', { class: 'list' }, leads.map((l) => h('div', { class: 'card' + (l.status === 'closed' ? ' off' : '') },
      h('div', { class: 'item', style: null }, h('div', { class: 'avatar' }, l.name[0]),
        h('div', { class: 'grow' }, h('div', { class: 't' }, l.name), h('div', { class: 'd' }, `${fmtDateTime(l.created_at)}${l.service_name ? ' · ' + l.service_name : ''}`)),
        h('span', { class: 'pill ' + (l.status === 'new' ? 'gold' : l.status === 'contacted' ? 'ok' : 'bad') }, LEAD_STATUS[l.status])),
      metaChips(l.meta),
      l.message && h('p', { class: 'muted' }, l.message),
      h('div', { class: 'acts' },
        h('a', { class: 'btn sm ltr', href: `tel:${l.phone}` }, icon('phone', 16), fmtPhone(l.phone)),
        h('a', { class: 'btn sm', href: `https://wa.me/972${l.phone.slice(1)}`, target: '_blank', rel: 'noopener' }, 'WhatsApp'),
        Object.entries(LEAD_STATUS).filter(([k]) => k !== l.status).map(([k, t]) => h('button', { class: 'btn sm', type: 'button', onclick: guard(async () => { await A(`/api/admin/leads/${l.id}`, { method: 'PATCH', body: { status: k } }); go('leads'); }) }, t)))))) 
      : h('div', { class: 'empty' }, 'עדיין לא התקבלו פניות. הן יופיעו כאן כשלקוחות ישאירו פרטים בדף הציבורי.'));
}

/* ---------- יומן פעולות (ביקורת) ---------- */
const AUDIT_LABEL = {
  'business.create': 'עסק נוצר', 'business.update': 'הגדרות העסק עודכנו', 'business.activate': 'העסק הופעל', 'business.deactivate': 'העסק הושבת', 'business.delete': 'העסק נמחק',
  'user.role_grant': 'הרשאת גישה נוספה', 'user.role_update': 'הרשאת גישה שונתה', 'user.role_revoke': 'הרשאת גישה הוסרה', 'owner.password_reset': 'סיסמת בעלים אופסה',
  'staff.create': 'איש צוות נוסף', 'staff.update': 'איש צוות עודכן', 'staff.delete': 'איש צוות נמחק', 'staff.hours_change': 'שעות עבודה עודכנו',
  'service.create': 'שירות נוסף', 'service.update': 'שירות עודכן', 'service.delete': 'שירות נמחק', 'block.create': 'זמן נחסם', 'block.delete': 'חסימה הוסרה',
  'appointment.create': 'תור נוצר', 'appointment.status': 'סטטוס תור שונה', 'appointment.move': 'תור הועבר', 'lead.create': 'פנייה התקבלה', 'lead.status': 'סטטוס פנייה שונה',
  'auth.login': 'כניסה', 'auth.mfa_enrolled': 'אימות דו-שלבי הופעל', 'auth.mfa_verified': 'אימות דו-שלבי', 'auth.mfa_failed': 'ניסיון אימות דו-שלבי כושל',
};
const ACTOR = { super_admin: 'מנהל פלטפורמה', owner: 'בעל עסק', public_api: 'לקוח / מערכת', system: 'מערכת', unknown: '—' };
function auditDetail(e) {
  const d = e.details || {};
  if (e.action === 'appointment.status') return `${STATUS[d.from] || d.from} ← ${STATUS[d.to] || d.to}`;
  if (e.action === 'appointment.move') return `${d.from_date} ← ${d.to_date}`;
  if (e.action === 'appointment.create') return d.source === 'online' ? 'הזמנה אונליין' : 'נוסף ע"י העסק';
  if (Array.isArray(d.changed)) return `שדות: ${d.changed.join(', ')}`;
  return d.slug || d.role || '';
}
async function auditView(host) {
  const rows = []; let more = true;
  const list = h('div', { class: 'list' });
  const moreBtn = h('button', { class: 'btn block', type: 'button', onclick: () => load() }, 'טעינת רשומות נוספות');
  async function load() {
    const q = rows.length ? `&before_id=${rows[rows.length - 1].id}` : '';
    const r = await A(`/api/admin/audit?limit=50${q}`);
    rows.push(...r.entries); more = r.entries.length === 50;
    list.replaceChildren(...rows.map((e) => h('div', { class: 'card' }, h('div', { class: 'item' }, h('div', { class: 'grow' },
      h('div', { class: 't' }, AUDIT_LABEL[e.action] || e.action), h('div', { class: 'd' }, `${fmtDateTime(e.at)} · ${ACTOR[e.actor_role] || e.actor_role}${auditDetail(e) ? ' · ' + auditDetail(e) : ''}`))))));
    moreBtn.hidden = !more;
    if (!rows.length) list.replaceChildren(h('div', { class: 'empty' }, 'אין עדיין רשומות.'));
  }
  mount(host, h('h2', null, 'יומן פעולות'), h('p', { class: 'muted' }, 'תיעוד פעולות ניהול משמעותיות: מי, מה ומתי. היומן אינו כולל שמות, טלפונים או פרטים אישיים של לקוחות, ואי אפשר לערוך או למחוק אותו.'), list, moreBtn);
  await load();
}

/* ---------- מחיקת עסק (לאחר הגירה) ---------- */
function deleteShopModal(s) {
  const slug = inp('confirm_slug', { dir: 'ltr', autocomplete: 'off', placeholder: s.slug });
  const form = h('form', { novalidate: true },
    h('p', { class: 'muted' }, 'המחיקה סופית: כל נתוני העסק (תורים, לקוחות, פניות) וחשבונות הבעלים יימחקו. מומלץ לייצא את הנתונים לפני כן (ראו docs/HANDOVER.md).'),
    formField(`להקלדת הכתובת "${s.slug}" לאישור`, slug, 'confirm_slug'),
    h('div', { class: 'acts' }, h('button', { class: 'btn danger', type: 'submit' }, 'מחיקה לצמיתות'), h('button', { class: 'btn ghost', type: 'button', onclick: () => m.close() }, 'ביטול')));
  const m = modal(`מחיקת "${s.name}"`, form);
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault(); setErrors(form, {});
    try { await sensitive(`/api/super/shops/${s.id}/delete`, { method: 'POST', body: { confirm_slug: slug.value } }); m.close(); if (S.shopId === s.id) { S.shopId = null; store.set('bs_shop', ''); } toast('העסק נמחק', 'ok'); go('platform'); }
    catch (e) { setErrors(form, { confirm_slug: e.message }); }
  });
}

boot();
