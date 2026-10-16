// אשף הקמת עסק (Super Admin). 8 שלבים, טיוטה נשמרת בשרת (גרסה אופטימית), רשימת חוסרים מה-DB, ופרסום אטומי.
// אין "חיבור דומיין" מדומה: הסטטוס מגיע מבדיקת DNS/HTTPS אמיתית בשרת, ומוצג כמו שהוא.
import { h, mount, api, toast, modal, confirmBox, spinner, applyTheme, applyBrand, hoursEditor, labelsOf, fmtPrice, fmtPhone } from './common.js';

const STEPS = ['תבנית ומסלול', 'פרטי העסק', 'מיתוג', 'שירותים ומחירים', 'צוות ושעות', 'תצוגה מקדימה', 'דומיין', 'פרסום'];
const TRACKS = [['managed', 'מנוהל – אנחנו מארחים ומתפעלים'], ['one_time', 'חד-פעמי – קוד והתקנה בחשבונות הלקוח']];
const DOMAIN_ERR = { txt_missing: 'רשומת ה-TXT עדיין לא נמצאה ב-DNS', txt_mismatch: 'נמצאה רשומת TXT אך הערך שונה', dns_error: 'שגיאת DNS זמנית, נסו שוב', not_routed: 'הדומיין עדיין לא מצביע לאתר', private_address: 'הדומיין מצביע לכתובת פנימית', tls_error: 'שגיאת תעודת HTTPS בדומיין', timeout: 'האתר בדומיין לא ענה בזמן', domain_taken: 'הדומיין כבר מחובר לעסק אחר' };
const DOMAIN_STATUS = { pending: ['ממתין להגדרת DNS', ''], verified: ['הבעלות אומתה – ממתין לניתוב', ''], active: ['פעיל', 'ok'], failed: ['נכשל', 'bad'] };

/* ctx: { host, sensitive, formField, setErrors, inp, sel, onDone, onExit, platformHost } */
export async function openWizard(ctx, draftId) {
  const { host, sensitive, formField, setErrors, inp, sel } = ctx;
  const root = h('div', { class: 'wiz' });
  const themeLink = document.getElementById('theme-css'), origHref = themeLink && themeLink.getAttribute('href'), origData = document.documentElement.dataset.theme || '';
  const restore = () => { applyBrand(null); if (themeLink && origHref) { themeLink.setAttribute('href', origHref); document.documentElement.dataset.theme = origData; } };
  const _exit = ctx.onExit, _done = ctx.onDone; ctx = { ...ctx, onExit: () => { restore(); _exit(); }, onDone: (id) => { restore(); _done(id); } };
  mount(host, root, spinner());
  let templates;
  try { templates = (await api('/api/admin/templates')).templates.filter((t) => t.status === 'available'); } catch (e) { toast(e.message, 'err'); return ctx.onExit(); }
  let D = draftId ? (await api(`/api/super/drafts/${draftId}`).catch((e) => { toast(e.message, 'err'); return null; })) : null;
  if (draftId && !D) return ctx.onExit();
  let step = D ? D.step : 1, dirty = false, domainRes = null;
  const tpl = () => templates.find((t) => t.key === D.template) || templates[0];
  const isBooking = () => tpl().kind === 'booking';
  const steps = () => STEPS.map((n, i) => [i + 1, n]).filter(([i]) => isBooking() || i !== 5);
  const data = () => D.data;

  async function persist(extra = {}) {
    const body = { version: D.version, step, data: D.data, track: D.track, ...extra };
    try { await api(`/api/super/drafts/${D.id}`, { method: 'PUT', body }); D = await api(`/api/super/drafts/${D.id}`); dirty = false; }
    catch (e) {
      if (e.code === 'conflict') { toast('הטיוטה עודכנה במקום אחר – נטענה הגרסה העדכנית', 'err'); D = await api(`/api/super/drafts/${D.id}`); render(); }
      throw e;
    }
  }
  const mark = () => { dirty = true; };
  const text = (path, label, attrs = {}) => {
    const [a, b] = path.split('.');
    const i = inp(path, { value: (data()[a] || {})[b] || '', oninput: (e) => { data()[a] = { ...(data()[a] || {}), [b]: e.target.value }; mark(); }, ...attrs });
    return formField(label, i, path);
  };
  const showProblems = (scope) => { if (scope) setErrors(scope, D.problems || {}); };

  function header() {
    return h('div', { class: 'wizhead' },
      h('div', { class: 'row' }, h('strong', null, 'עסק חדש'), h('span', { class: 'pill' }, tpl().name), h('button', { class: 'btn sm ghost', type: 'button', onclick: exit }, 'יציאה (הטיוטה נשמרת)')),
      h('ol', { class: 'steps', 'aria-label': 'שלבי ההקמה' }, steps().map(([i, n]) => h('li', { class: i === step ? 'on' : i < step ? 'done' : '', 'aria-current': i === step ? 'step' : null },
        h('button', { type: 'button', class: 'linkish', onclick: () => go(i) }, `${i}. ${n}`)))));
  }
  let pending = Promise.resolve();
  async function exit() { await pending; if (dirty) { try { await persist(); } catch { /* יישאר במקום */ return; } } ctx.onExit(); }
  function go(n) { pending = pending.then(() => goNow(n)); return pending; }
  async function goNow(n) {
    try { if (dirty) await persist(); if (!isBooking() && n === 5) n = step < 5 ? 6 : 4; step = n; render(); } catch (e) { if (e.code !== 'conflict') toast(e.message, 'err'); }
  }
  const nav = (nextLabel = 'המשך') => h('div', { class: 'acts' },
    step > 1 && h('button', { class: 'btn ghost', type: 'button', onclick: () => go(step === 6 && !isBooking() ? 4 : step - 1 === 5 && !isBooking() ? 4 : step - 1) }, 'חזרה'),
    step < 8 && h('button', { class: 'btn primary', type: 'button', onclick: () => go(step + 1) }, nextLabel));

  /* --- 1: תבנית ומסלול --- */
  function s1() {
    const t = sel('template', templates.map((x) => [x.key, x.name]), D.template, { onchange: async (e) => {
      if (e.target.value === D.template) return;
      if (!(await confirmBox('החלפת תבנית', 'השירותים והצוות יוחלפו בברירות המחדל של התבנית החדשה. פרטי העסק נשמרים.', 'החלפה'))) { e.target.value = D.template; return; }
      try { await persist({ template: e.target.value }); render(); } catch (er) { toast(er.message, 'err'); e.target.value = D.template; }
    } });
    const tk = sel('track', TRACKS, D.track, { onchange: (e) => { D.track = e.target.value; mark(); } });
    const T = tpl();
    return h('div', null, formField('סוג תבנית', t, 'template'), h('p', { class: 'hint' }, T.tagline || ''), T.audience && h('p', { class: 'muted' }, 'מתאים ל: ' + T.audience),
      formField('מסלול', tk, 'track'), h('p', { class: 'hint' }, 'המסלול נשמר בעסק ואינו ניתן לשינוי על ידי בעל העסק.'));
  }

  /* --- 2: פרטים --- */
  const s2 = () => h('div', null, text('business.name', 'שם העסק', { maxlength: 60 }), text('business.slug', 'כתובת הדף (אנגלית, מקפים)', { dir: 'ltr', autocapitalize: 'none', placeholder: 'my-business' }),
    text('business.phone', 'טלפון העסק', { type: 'tel', dir: 'ltr' }), text('business.address', 'כתובת (אופציונלי)'),
    text('owner.email', 'אימייל בעל העסק (יהיה שם המשתמש שלו)', { type: 'email', dir: 'ltr' }),
    h('p', { class: 'hint' }, 'הסיסמה הזמנית תוגדר רק בשלב הפרסום. לא נוצר חשבון לפני כן.'));

  /* --- 3: מיתוג --- */
  function s3() {
    const color = h('input', { type: 'color', class: 'inp', value: (data().brand || {}).accent || '#c9a24b', 'aria-label': 'צבע מבטא', oninput: (e) => { data().brand = { ...(data().brand || {}), accent: e.target.value }; mark(); applyBrand(data().brand); } });
    const clear = h('button', { class: 'btn sm ghost', type: 'button', onclick: () => { const b = { ...(data().brand || {}) }; delete b.accent; data().brand = b; mark(); applyBrand(null); render(); } }, 'ברירת מחדל של התבנית');
    return h('div', null, text('brand.tagline', 'משפט קצר מתחת לשם (עד 80 תווים, אופציונלי)', { maxlength: 80 }),
      formField('צבע מבטא (אופציונלי)', h('div', { class: 'row' }, color, clear), 'brand.accent'), h('p', { class: 'hint' }, 'הצבע מחליף את צבע המבטא של התבנית בלבד; הרקע והגופן נשארים כמו בתבנית.'));
  }

  /* --- 4: שירותים --- */
  function s4() {
    const L = labelsOf(tpl());
    const list = data().services || [];
    const rows = list.map((s, i) => h('div', { class: 'item wrow' },
      h('input', { class: 'inp', 'aria-label': 'שם', value: s.name, maxlength: 60, oninput: (e) => { s.name = e.target.value; mark(); } }),
      isBooking() && h('input', { class: 'inp', 'aria-label': 'משך בדקות', type: 'number', min: 5, max: 480, value: s.duration_min, dir: 'ltr', oninput: (e) => { s.duration_min = Number(e.target.value); mark(); } }),
      h('input', { class: 'inp', 'aria-label': 'מחיר ₪', type: 'number', min: 0, max: 100000, value: s.price_ils, dir: 'ltr', oninput: (e) => { s.price_ils = Number(e.target.value); mark(); } }),
      h('button', { class: 'btn sm danger', type: 'button', 'aria-label': 'הסרה', onclick: () => { list.splice(i, 1); mark(); render(); } }, '✕')));
    return h('div', null, h('p', { class: 'hint' }, `ברירות המחדל לקוחות מהתבנית וניתנות לעריכה. ${isBooking() ? 'שם · משך (דקות) · מחיר (₪).' : 'שם · מחיר (₪, 0 = לפי הצעה).'}`),
      h('div', { class: 'list' }, rows), h('div', { class: 'errmsg', 'data-err': 'services' }),
      list.length < 30 && h('button', { class: 'btn sm', type: 'button', onclick: () => { list.push({ name: '', duration_min: isBooking() ? 30 : 30, price_ils: 0 }); data().services = list; mark(); render(); } }, `+ ${L.add_service || 'הוספת שירות'}`));
  }

  /* --- 5: צוות --- */
  let editors = [];
  function s5() {
    const L = labelsOf(tpl());
    const list = data().staff || [];
    editors = [];
    return h('div', null, h('p', { class: 'hint' }, `${L.staff_many}: שם ושעות עבודה שבועיות. לקוחות יוכלו להזמין רק בשעות אלה.`),
      list.map((st, i) => { const ed = hoursEditor(st.hours); editors[i] = ed;
        return h('div', { class: 'card' }, h('div', { class: 'row' }, h('input', { class: 'inp', 'aria-label': 'שם', value: st.name, maxlength: 40, oninput: (e) => { st.name = e.target.value; mark(); } }),
          h('button', { class: 'btn sm danger', type: 'button', onclick: () => { collectHours(); list.splice(i, 1); mark(); render(); } }, 'הסרה')), ed.el); }),
      h('div', { class: 'errmsg', 'data-err': 'staff' }),
      list.length < 20 && h('button', { class: 'btn sm', type: 'button', onclick: () => { collectHours(); list.push({ name: '', hours: [1, 2, 3, 4].map((w) => ({ weekday: w, start_min: 540, end_min: 1080 })) }); data().staff = list; mark(); render(); } }, `+ ${L.add_staff}`));
  }
  function collectHours() {
    const list = data().staff || [];
    editors.forEach((ed, i) => { const r = ed.read(); if (r.hours && list[i]) { list[i].hours = r.hours; mark(); } });
  }

  /* --- 6: תצוגה מקדימה (אותה תבנית, אותו מיתוג, נתוני הטיוטה) --- */
  async function s6() {
    await applyTheme(tpl().theme); applyBrand(data().brand);
    const L = labelsOf(tpl()), b = data().business || {}, br = data().brand || {};
    return h('div', { class: 'previewbox', 'aria-label': 'תצוגה מקדימה' },
      h('header', { class: 'brand' }, h('div', { class: 'mark' }, L.brand), h('h1', null, b.name || 'שם העסק'), (br.tagline || L.tagline) && h('p', { class: 'tagline' }, br.tagline || L.tagline),
        b.address && h('div', { class: 'addr' }, b.address), h('div', { class: 'orn' }, h('i'))),
      h('div', { class: 'list' }, (data().services || []).map((s) => h('div', { class: 'item' }, h('div', { class: 'grow' }, h('div', { class: 't' }, s.name || '—'), isBooking() && h('div', { class: 'd' }, `${s.duration_min} דק׳`)), h('div', { class: 'price' }, s.price_ils ? fmtPrice(s.price_ils) : 'לפי הצעה')))),
      isBooking() && h('p', { class: 'muted' }, `${(data().staff || []).length} ${L.staff_many} · ${(data().staff || []).reduce((n, x) => n + x.hours.length, 0)} משמרות שבועיות`),
      b.phone && h('p', { class: 'center' }, h('span', { class: 'btn callnow ltr' }, 'התקשרו · ' + fmtPhone(b.phone))),
      h('p', { class: 'hint' }, 'זו הדמיה בלבד; לא נוצר שום דבר עד שלב הפרסום.'));
  }

  /* --- 7: דומיין (אופציונלי; הוראות ממשיכות גם אחרי הפרסום) --- */
  function s7() {
    return h('div', null, text('domain.hostname', 'דומיין מותאם (אופציונלי, למשל book.example.com)', { dir: 'ltr', autocapitalize: 'none' }),
      h('p', { class: 'hint' }, 'הדומיין נרשם כממתין בלבד. אין חיבור מדומה: לאחר הפרסום מוצגות רשומות ה-DNS הנדרשות, והסטטוס מתעדכן רק לפי בדיקה אמיתית. אפשר לדלג ולחבר מאוחר יותר.'));
  }

  /* --- 8: פרסום --- */
  function problemsList() {
    const p = D.problems || {};
    const ks = Object.keys(p);
    return ks.length ? h('div', { class: 'notice bad', role: 'alert' }, h('strong', null, 'יש להשלים לפני פרסום:'), h('ul', null, ks.map((k) => h('li', null, p[k]))))
      : h('div', { class: 'notice ok' }, 'כל הנתונים החובה הושלמו. אפשר לפרסם.');
  }
  function s8() {
    const pw = inp('owner_password', { type: 'text', dir: 'ltr', autocomplete: 'off', placeholder: D.owner_ready ? 'נוצר בניסיון קודם – אין צורך בסיסמה' : 'לפחות 10 תווים', disabled: D.owner_ready });
    const btn = h('button', { class: 'btn primary block', type: 'button', disabled: Object.keys(D.problems || {}).length > 0, onclick: async () => {
      btn.disabled = true;
      try {
        const out = await sensitive(`/api/super/drafts/${D.id}/publish`, { method: 'POST', body: { owner_password: pw.value || undefined } });
        D = await api(`/api/super/drafts/${D.id}`); D._biz = out.business_id; D._pw = pw.value; render();
      } catch (e) { btn.disabled = false; if (e.cancelled) return; if (e.fields) { toast('יש להשלים את הפריטים המסומנים', 'err'); D = await api(`/api/super/drafts/${D.id}`); render(); } else toast(e.message, 'err'); }
    } }, 'פרסום העסק');
    return h('div', null, problemsList(), formField('סיסמה זמנית לבעל העסק', pw, 'owner_password'),
      h('p', { class: 'hint' }, 'הפרסום דורש אימות TOTP טרי. הסיסמה לא נשמרת בטיוטה; מסרו אותה לבעל העסק בערוץ מאובטח.'), btn);
  }
  async function donePanel() {
    const dn = (data().domain || {}).hostname;
    let doms = [];
    if (D.business_id) doms = (await api(`/api/admin/domains?shop_id=${D.business_id}`).catch(() => ({ domains: [] }))).domains;
    const kind = isBooking() ? 'b' : 'l';
    return h('div', null, h('div', { class: 'notice ok' }, 'העסק פורסם.'),
      h('p', null, 'כתובת: ', h('a', { class: 'ltr', href: `/${kind}/${data().business.slug}`, target: '_blank', rel: 'noopener' }, `/${kind}/${data().business.slug}`)),
      dn && domainPanel(doms, D.business_id, ctx),
      h('div', { class: 'acts' }, h('button', { class: 'btn primary', type: 'button', onclick: () => ctx.onDone(D.business_id) }, 'סיום')));
  }

  async function render() {
    const body = h('div', { class: 'wizbody' });
    mount(root, header(), body, spinner());
    let content;
    if (D.status !== 'draft' && D.status !== 'published') { toast('הטיוטה נסגרה', 'err'); return ctx.onExit(); }
    if (D.status === 'published') content = await donePanel();
    else {
      // רענון רשימת החוסרים מהשרת לפני שלב התצוגה/הפרסום
      if (step >= 6 && dirty) { try { await persist(); } catch { /* יוצג שוב */ } }
      content = step === 1 ? s1() : step === 2 ? s2() : step === 3 ? s3() : step === 4 ? s4() : step === 5 ? s5() : step === 6 ? await s6() : step === 7 ? s7() : s8();
    }
    mount(root, header(), body);
    body.append(content);
    if (D.status === 'draft') { if (step !== 6) { await applyTheme(tpl().theme); applyBrand(data().brand); } body.append(nav(step === 7 ? 'לשלב הפרסום' : 'המשך')); if (step < 8) showProblems(body); }
  }

  if (!D) {
    const t0 = sel('template', templates.map((x) => [x.key, x.name]), templates[0].key), k0 = sel('track', TRACKS, 'managed');
    const form = h('form', { novalidate: true, onsubmit: async (ev) => { ev.preventDefault(); try { D = await api('/api/super/drafts', { method: 'POST', body: { template: t0.value, track: k0.value } }); D = await api(`/api/super/drafts/${D.id}`); step = 1; mount(host, root); render(); } catch (e) { toast(e.message, 'err'); } } },
      h('h2', null, 'עסק חדש'), formField('סוג תבנית', t0, 'template'), formField('מסלול', k0, 'track'),
      h('div', { class: 'acts' }, h('button', { class: 'btn primary', type: 'submit' }, 'יצירת טיוטה'), h('button', { class: 'btn ghost', type: 'button', onclick: ctx.onExit }, 'ביטול')));
    mount(host, form);
  } else { mount(host, root); render(); }
}

/* פאנל דומיין: רשומות DNS מדויקות, סטטוס אמיתי, כפתור בדיקה. משמש גם באשף וגם בהגדרות הבעלים. */
export function domainPanel(domains, businessId, ctx) {
  const wrap = h('div', { class: 'domains' });
  const q = businessId ? `?shop_id=${businessId}` : '';
  const paint = (list) => wrap.replaceChildren(
    ...list.map((d) => {
      const [label, cls] = DOMAIN_STATUS[d.status] || [d.status, ''];
      const copy = (v) => h('button', { class: 'btn sm ghost', type: 'button', onclick: () => navigator.clipboard && navigator.clipboard.writeText(v).then(() => toast('הועתק', 'ok')) }, 'העתקה');
      return h('div', { class: 'card', 'data-domain': d.hostname },
        h('div', { class: 'row' }, h('strong', { class: 'ltr' }, d.hostname), h('span', { class: 'pill ' + cls }, label)),
        d.status !== 'active' && h('div', null,
          h('p', { class: 'hint' }, 'הוסיפו אצל ספק ה-DNS של הדומיין (שתי הרשומות נדרשות):'),
          h('div', { class: 'dns' }, h('div', null, '1. TXT · שם: ', h('code', { class: 'ltr' }, d.txt_name), ' · ערך: ', h('code', { class: 'ltr' }, d.txt_value), copy(d.txt_value)),
            h('div', null, '2. CNAME (או ALIAS/ANAME בדומיין ראשי) · שם: ', h('code', { class: 'ltr' }, d.hostname), ' · יעד: ', h('code', { class: 'ltr' }, (ctx && ctx.platformHost) || location.hostname))),
          h('p', { class: 'hint' }, 'שינויי DNS יכולים להימשך דקות עד שעות. התעודה (HTTPS) מוגדרת באירוח אחרי שה-DNS מצביע.')),
        d.last_error && d.status !== 'active' && h('div', { class: 'notice bad', role: 'status' }, DOMAIN_ERR[d.last_error] || d.last_error),
        d.last_check_at && h('p', { class: 'muted' }, 'נבדק לאחרונה: ' + new Date(d.last_check_at).toLocaleString('he-IL')),
        h('div', { class: 'acts' }, h('button', { class: 'btn sm primary', type: 'button', onclick: async (ev) => {
          ev.target.disabled = true;
          try { await api(`/api/admin/domains/${d.id}/check${q}`, { method: 'POST', body: {} }); paint((await api(`/api/admin/domains${q}`)).domains); }
          catch (e) { toast(e.message, 'err'); ev.target.disabled = false; }
        } }, 'בדיקת חיבור'),
        h('button', { class: 'btn sm danger', type: 'button', onclick: async () => { if (!(await confirmBox('הסרת דומיין?', d.hostname, 'הסרה', true))) return; try { await api(`/api/admin/domains/${d.id}${q}`, { method: 'DELETE' }); paint((await api(`/api/admin/domains${q}`)).domains); } catch (e) { toast(e.message, 'err'); } } }, 'הסרה')));
    }),
    list.length < 3 && (() => { const i = h('input', { class: 'inp', dir: 'ltr', placeholder: 'book.example.com', 'aria-label': 'דומיין חדש', autocapitalize: 'none' });
      return h('form', { class: 'row', novalidate: true, onsubmit: async (ev) => { ev.preventDefault(); try { await api(`/api/admin/domains${q}`, { method: 'POST', body: { hostname: i.value } }); paint((await api(`/api/admin/domains${q}`)).domains); } catch (e) { toast(e.fields ? Object.values(e.fields)[0] : e.message, 'err'); } } }, i, h('button', { class: 'btn sm', type: 'submit' }, '+ הוספת דומיין')); })());
  paint(domains);
  return wrap;
}
