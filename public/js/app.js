// تشغيل الواجهة: الدخول، التخطيط، القائمة، والتوجيه.
import { h, clear, state, api, get, toast, can, inp, field } from './lib.js';
import * as Dash from './pages/dashboard.js';
import * as Pos from './pages/pos.js';
import * as Docs from './pages/docs.js';
import * as Purchases from './pages/purchases.js';
import * as Cash from './pages/cash.js';
import * as Stock from './pages/stock.js';
import * as Reps from './pages/reps.js';
import * as Masters from './pages/masters.js';
import * as Reports from './pages/reports.js';
import * as Admin from './pages/admin.js';
import * as Offline from './offline.js';
import { table, badge, M, dt, run, confirmBox } from './lib.js';

const app = document.getElementById('app');

// المسارات: [المسار, الدالة, الصلاحية]
const ROUTES = [
  ['dashboard', Dash.render, 'dashboard.view'],
  ['pos', Pos.render, 'sales.create'],
  ['sales', (c) => Docs.list(c, 'sale'), 'sales.view'],
  ['sale-returns', (c) => Docs.list(c, 'sale_return'), 'sales.view'],
  ['doc', Docs.view, null],
  ['return', Docs.saleReturn, 'sale_returns.create'],
  ['purchase-return', Purchases.purchaseReturn, 'purchase_returns.create'],
  ['purchases', (c) => Docs.list(c, 'purchase'), 'purchases.view'],
  ['purchase', Purchases.form, 'purchases.create'],
  ['purchase-order', Purchases.orderForm, 'purchases.create'],
  ['purchase-orders', (c) => Docs.list(c, 'purchase_order'), 'purchases.view'],
  ['receipt', (c) => Cash.cashDoc(c, 'receipt'), 'cash.receipt'],
  ['payment', (c) => Cash.cashDoc(c, 'payment'), 'cash.payment'],
  ['cash-docs', (c) => Docs.list(c, 'receipt,payment,cash_transfer'), 'cash.view'],
  ['cash', Cash.accounts, 'cash.view'],
  ['cash-transfer', Cash.transfer, 'cash.transfer'],
  ['journal', Cash.journal, 'journal.manual'],
  ['sessions', Cash.sessions, 'sessions.own'],
  ['expenses', Cash.expenses, 'expenses.create'],
  ['expense', Cash.expenseForm, 'expenses.create'],
  ['stock', Stock.balances, 'stock.view'],
  ['alerts', Stock.alerts, 'stock.view'],
  ['transfer', Stock.transfer, 'stock.transfer'],
  ['transfers', (c) => Docs.list(c, 'transfer'), 'stock.view'],
  ['counts', Stock.counts, 'stock.view'],
  ['count', Stock.count, 'stock.view'],
  ['damage', Stock.damage, 'stock.damage'],
  ['item-card', Stock.itemCard, 'stock.view'],
  ['opening-stock', Stock.openingStock, 'opening.manage'],
  ['reps', Reps.list, 'reps.view'],
  ['rep', Reps.view, 'reps.view'],
  ['commissions', Reps.commissions, 'commissions.manage'],
  ['items', Masters.items, 'items.view'],
  ['item', Masters.itemForm, 'items.manage'],
  ['parties', Masters.parties, 'parties.view'],
  ['party', Masters.party, 'parties.view'],
  ['warehouses', Masters.warehouses, 'warehouses.manage'],
  ['categories', Masters.categories, 'items.manage'],
  ['reports', Reports.render, null],
  ['settings', Admin.settings, 'settings.manage'],
  ['users', Admin.users, 'users.manage'],
  ['audit', Admin.audit, 'audit.view'],
  ['backup', Admin.backup, 'backup.manage'],
  ['import', Admin.importPage, 'import.manage'],
  ['opening', Admin.opening, 'opening.manage'],
  ['period', Admin.period, 'period.lock'],
  ['whatsapp', Admin.whatsapp, 'messages.view'],
  ['password', Admin.password, null],
  ['offline-queue', queuePage, 'sales.create'],
];

const NAV = [
  ['', [['dashboard', 'لوحة الإدارة']]],
  ['المبيعات', [['pos', 'فاتورة بيع جديدة'], ['sales', 'فواتير البيع'], ['sale-returns', 'مرتجعات المبيعات'], ['sessions', 'الورديات'], ['offline-queue', 'العمليات دون اتصال']]],
  ['المشتريات', [['purchase-order', 'طلب شراء جديد'], ['purchase-orders', 'طلبات الشراء'], ['purchase', 'فاتورة شراء جديدة'], ['purchases', 'فواتير الشراء']]],
  ['المخزون', [['stock', 'رصيد المخزون'], ['alerts', 'تنبيهات المخزون'], ['transfer', 'تحويل / تسليم عهدة'], ['transfers', 'سجل التحويلات'], ['counts', 'الجرد'], ['damage', 'تسجيل تالف'], ['item-card', 'بطاقة صنف']]],
  ['المالية', [['receipt', 'سند قبض'], ['payment', 'سند صرف'], ['expenses', 'المصروفات'], ['cash', 'الصناديق والبنوك'], ['cash-transfer', 'تحويل نقدي / توريد'], ['cash-docs', 'سجل السندات'], ['journal', 'قيد يدوي']]],
  ['المناديب', [['reps', 'المناديب والعهد'], ['commissions', 'العمولات']]],
  ['البيانات الأساسية', [['items', 'الأصناف والباركود'], ['parties?type=customer', 'العملاء'], ['parties?type=supplier', 'الموردون'], ['warehouses', 'الفروع والمستودعات والحسابات'], ['categories', 'التصنيفات']]],
  ['المراجعة', [['reports', 'التقارير'], ['whatsapp', 'رسائل واتساب'], ['import', 'الاستيراد'], ['backup', 'النسخ الاحتياطي'], ['audit', 'سجل التدقيق']]],
  ['الإدارة', [['settings', 'الإعدادات'], ['users', 'المستخدمون والأدوار'], ['opening', 'الأرصدة الافتتاحية'], ['period', 'إقفال الفترات']]],
];

function routePerm(name) { const r = ROUTES.find((x) => x[0] === name.split('?')[0]); return r ? r[2] : null; }
function allowed(name) {
  if (name === 'reports') return ['reports.sales', 'reports.purchases', 'reports.stock', 'reports.finance', 'profit.view', 'reps.view'].some(can);
  const p = routePerm(name);
  return !p || can(p);
}

function loginView(msg) {
  clear(app);
  const u = inp({ autocomplete: 'username', required: true });
  const p = inp({ type: 'password', autocomplete: 'current-password', required: true });
  const err = h('div', { class: 'note bad hidden' });
  const form = h('form', { class: 'card login', onsubmit: async (e) => {
    e.preventDefault();
    err.classList.add('hidden');
    try {
      await api('POST', '/auth/login', { username: u.value, password: p.value });
      await boot();
    } catch (x) { err.textContent = x.message; err.classList.remove('hidden'); p.value = ''; p.focus(); }
  } },
  h('h1', null, 'نظام إدارة المواد الغذائية'),
  msg ? h('div', { class: 'note warn' }, msg) : null, err,
  field('اسم المستخدم', u), h('div', { style: { height: '10px' } }), field('كلمة المرور', p),
  h('div', { style: { height: '14px' } }), h('button', { class: 'btn primary', style: { width: '100%' } }, 'دخول'));
  app.appendChild(form);
  u.focus();
}

function layout() {
  clear(app);
  const side = h('nav', { class: 'side', 'aria-label': 'القائمة' },
    h('div', { class: 'org' }, state.settings.org_name, h('small', null, state.me.full_name, state.branch ? ' — ' + state.branch.name : '')));
  // مجموعات قابلة للطي؛ تُحفظ المجموعات المفتوحة على الجهاز
  let openGroups;
  try { openGroups = new Set(JSON.parse(localStorage.getItem('frs-nav-open') || '[]')); } catch (_) { openGroups = new Set(); }
  const saveOpen = () => { try { localStorage.setItem('frs-nav-open', JSON.stringify([...openGroups])); } catch (_) { /* ignore */ } };
  for (const [group, items] of NAV) {
    // المندوب يتعامل مع العملاء فقط
    const vis = items.filter(([r]) => allowed(r) && !(state.rep && !can('parties.all') && r === 'parties?type=supplier'));
    if (!vis.length) continue;
    const links = vis.map(([r, label]) => h('a', { class: 'nav', href: '#/' + r, 'data-route': r, onclick: () => side.classList.remove('open') }, label));
    if (!group) { side.append(...links); continue; }
    const body = h('div', { class: 'nav-items', id: 'nav-' + group, role: 'group' }, links);
    const head = h('button', { type: 'button', class: 'nav-group', 'aria-expanded': 'false', 'aria-controls': 'nav-' + group, 'data-group': group },
      h('span', null, group), h('span', { class: 'chev', 'aria-hidden': 'true' }, '‹'));
    const setOpen = (o) => { head.setAttribute('aria-expanded', String(o)); body.classList.toggle('open', o); };
    head.addEventListener('click', () => {
      const o = head.getAttribute('aria-expanded') !== 'true';
      setOpen(o);
      if (o) openGroups.add(group); else openGroups.delete(group);
      saveOpen();
    });
    setOpen(openGroups.has(group));
    side.append(h('div', { class: 'nav-section' }, head, body));
  }
  const net = h('a', { href: '#/offline-queue', class: 'badge hidden' });
  const updateNet = () => {
    const n = Offline.pendingCount();
    net.className = 'badge ' + (navigator.onLine ? (n ? 'warn' : 'hidden') : 'bad');
    net.textContent = navigator.onLine ? `${n} عملية بانتظار الإرسال` : `غير متصل${n ? ` — ${n} بانتظار الإرسال` : ''}`;
  };
  updateNet();
  window.addEventListener('online', updateNet);
  window.addEventListener('offline', updateNet);
  window.addEventListener('queue-changed', updateNet);
  const sessionBadge = h('span', { class: 'who' });
  if (state.session) sessionBadge.append(h('a', { href: '#/sessions', class: 'badge ok' }, 'وردية مفتوحة ' + state.session.number));
  // زر الرجوع: يعود للصفحة السابقة داخل النظام، وإلا للصفحة الرئيسية
  const backBtn = h('button', { class: 'btn small back-btn', 'aria-label': 'رجوع', title: 'رجوع', onclick: () => {
    if (navDepth > 0) { goingBack = true; history.back(); } else location.hash = '#/' + defaultRoute();
  } }, '→ رجوع');
  const syncBack = () => { const r = location.hash.replace(/^#\/?/, ''); backBtn.style.visibility = !r || r === defaultRoute() ? 'hidden' : 'visible'; };
  window.addEventListener('hashchange', syncBack);
  setTimeout(syncBack, 0);
  const top = h('header', { class: 'top' },
    h('button', { class: 'btn small menu-btn', 'aria-label': 'القائمة', onclick: () => side.classList.toggle('open') }, '☰'),
    backBtn,
    h('div', { class: 'title' }, ''), net, sessionBadge,
    h('span', { class: 'who' }, state.me.full_name),
    h('a', { class: 'btn small', href: '#/password' }, 'كلمة المرور'),
    h('button', { class: 'btn small', onclick: async () => {
      if (Offline.pendingCount() && !(await confirmBox('عمليات غير مرسلة', 'توجد مبيعات محفوظة على الجهاز لم تُرسل بعد. ستبقى على الجهاز وتُرسل عند الدخول مجددًا. متابعة الخروج؟'))) return;
      await api('POST', '/auth/logout', {}).catch(() => null); Offline.clearMe(); state.me = null; loginView();
    } }, 'خروج'));
  const content = h('main', { class: 'content', id: 'content' });
  app.appendChild(h('div', { class: 'layout' }, side, h('div', { class: 'main' }, top, content)));
}

let navSeq = 0;
async function route() {
  if (!state.me) return;
  const raw = location.hash.replace(/^#\/?/, '') || defaultRoute();
  const [pathPart, query = ''] = raw.split('?');
  const [name, ...params] = pathPart.split('/');
  const q = Object.fromEntries(new URLSearchParams(query));
  const r = ROUTES.find((x) => x[0] === name);
  document.querySelectorAll('.side a.nav').forEach((a) => a.classList.toggle('active', a.dataset.route === raw || (a.dataset.route === name && !document.querySelector(`.side a.nav[data-route="${CSS.escape(raw)}"]`))));
  // افتح القسم الذي يحتوي الصفحة الحالية
  const act = document.querySelector('.side a.nav.active');
  const sec = act && act.closest('.nav-section');
  if (sec) { sec.querySelector('.nav-group').setAttribute('aria-expanded', 'true'); sec.querySelector('.nav-items').classList.add('open'); }
  const el = document.getElementById('content');
  if (!el) return;
  document.querySelectorAll('.modal-bg').forEach((m) => m.remove());
  clear(el);
  if (!r) { el.appendChild(h('div', { class: 'empty' }, 'الصفحة غير موجودة')); return; }
  if (!allowed(name)) { el.appendChild(h('div', { class: 'note bad' }, 'ليست لديك صلاحية لهذه الصفحة')); return; }
  const seq = ++navSeq;
  try {
    await r[1]({ el, params, q, isCurrent: () => seq === navSeq, refreshMe });
  } catch (e) {
    console.error(e);
    if (seq === navSeq) el.appendChild(h('div', { class: 'note bad' }, e.message || 'تعذر عرض الصفحة'));
  }
}

function defaultRoute() {
  if (can('dashboard.view')) return 'dashboard';
  if (can('sales.create')) return 'pos';
  if (can('purchases.view')) return 'purchases';
  if (can('stock.view')) return 'stock';
  return 'password';
}

async function refreshMe() {
  const me = await get('/auth/me');
  state.me = me.user;
  state.perms = new Set(me.permissions);
  state.settings = me.settings;
  state.session = me.session;
  state.rep = me.rep;
  state.branch = me.branch;
  state.branchesCount = me.branches_count;
  window.__moneyDecimals = me.settings.money_decimals;
  Offline.saveMe(me);
  return me;
}

function applyMe(me) {
  state.me = me.user; state.perms = new Set(me.permissions); state.settings = me.settings; state.session = me.session;
  state.rep = me.rep; state.branch = me.branch; state.branchesCount = me.branches_count;
}

async function boot() {
  try {
    await refreshMe();
  } catch (e) {
    if (e.status === 401) return loginView();
    // دون اتصال: نقطة البيع تعمل بآخر بيانات دخول محفوظة على هذا الجهاز
    const cached = e.code === 'NETWORK' ? Offline.loadMe() : null;
    if (!cached) { clear(app).appendChild(h('div', { class: 'boot' }, 'تعذر الاتصال بالخادم: ' + e.message)); return; }
    applyMe(cached);
    layout();
    toast('تعمل دون اتصال: البيع يُحفظ على الجهاز ويُرسل عند عودة الاتصال');
    if (!location.hash || !location.hash.startsWith('#/pos')) location.hash = '#/pos';
    await route();
    return;
  }
  state.cache.clear();
  layout();
  if (state.me.must_change_password) { location.hash = '#/password'; toast('يرجى تغيير كلمة المرور المؤقتة'); }
  await route();
}

// صفحة العمليات المحفوظة دون اتصال
async function queuePage({ el }) {
  document.querySelector('.top .title').textContent = 'العمليات المحفوظة دون اتصال';
  const draw = () => {
    const q = Offline.queue().slice().reverse();
    const states = { pending: ['بانتظار الإرسال', 'warn'], failed: ['مرفوضة — تحتاج مراجعة', 'bad'], synced: ['أُرسلت', 'ok'] };
    el.replaceChildren(
      h('div', { class: 'note' }, 'المبيعات المحفوظة دون اتصال تُرسل تلقائيًا بنفس معرف العملية فلا تتكرر. يعيد الخادم فحص الرصيد والصلاحيات؛ المرفوضة تبقى هنا حتى تعالجها (مثلًا بتعديل المخزون ثم إعادة المحاولة، أو حذفها بعد إصدار فاتورة بديلة).'),
      h('div', { class: 'actions', style: { marginBottom: '12px' } },
        h('button', { class: 'btn primary', onclick: async () => { await Offline.sync({ includeFailed: true }); draw(); } }, 'إرسال / إعادة المحاولة الآن')),
      table({ columns: [
        { key: 'created_at', label: 'وقت الحفظ', render: (x) => dt(x.created_at) }, { key: 'label', label: 'العملية' }, { key: 'total', label: 'الإجمالي', type: 'money' },
        { key: 'state', label: 'الحالة', render: (x) => badge(states, x.state) },
        { key: 'r', label: 'النتيجة', render: (x) => (x.doc_id ? h('a', { href: '#/doc/' + x.doc_id }, x.number) : x.error || '') },
        { key: 'a', label: '', render: (x) => (x.state === 'failed' ? h('button', { class: 'btn small danger', onclick: async () => {
          if (await confirmBox('حذف عملية مرفوضة', 'ستُحذف هذه الفاتورة من الجهاز نهائيًا ولن تُرسل. تأكد من معالجتها بفاتورة بديلة إن لزم.')) { Offline.removeFromQueue(x.key); draw(); }
        } }, 'حذف') : '') }], rows: q, empty: 'لا توجد عمليات محفوظة' }));
  };
  draw();
  void M; void run;
}

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => null);
Offline.startAutoSync();
// عمق التنقل داخل النظام لزر الرجوع
let navDepth = 0, goingBack = false;
window.addEventListener('hashchange', () => { if (goingBack) { navDepth = Math.max(0, navDepth - 1); goingBack = false; } else navDepth++; });
window.addEventListener('hashchange', route);
window.addEventListener('auth-required', () => { if (state.me) { state.me = null; loginView('انتهت الجلسة؛ سجّل الدخول مجددًا'); } });
window.addEventListener('session-changed', async () => { await refreshMe(); layout(); route(); });
boot();
