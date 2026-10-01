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
  ['password', Admin.password, null],
];

const NAV = [
  ['', [['dashboard', 'لوحة الإدارة']]],
  ['المبيعات', [['pos', 'نقطة البيع'], ['sales', 'فواتير البيع'], ['sale-returns', 'مرتجعات المبيعات'], ['sessions', 'الورديات']]],
  ['المشتريات', [['purchase-order', 'طلب شراء جديد'], ['purchase-orders', 'طلبات الشراء'], ['purchase', 'فاتورة شراء جديدة'], ['purchases', 'فواتير الشراء']]],
  ['المخزون', [['stock', 'رصيد المخزون'], ['alerts', 'تنبيهات المخزون'], ['transfer', 'تحويل / تسليم عهدة'], ['transfers', 'سجل التحويلات'], ['counts', 'الجرد'], ['damage', 'تسجيل تالف'], ['item-card', 'بطاقة صنف']]],
  ['المالية', [['receipt', 'سند قبض'], ['payment', 'سند صرف'], ['expenses', 'المصروفات'], ['cash', 'الصناديق والبنوك'], ['cash-transfer', 'تحويل نقدي / توريد'], ['cash-docs', 'سجل السندات']]],
  ['المناديب', [['reps', 'المناديب والعهد'], ['commissions', 'العمولات']]],
  ['البيانات الأساسية', [['items', 'الأصناف والباركود'], ['parties', 'العملاء والموردون'], ['warehouses', 'الفروع والمستودعات والحسابات'], ['categories', 'التصنيفات']]],
  ['المراجعة', [['reports', 'التقارير'], ['import', 'الاستيراد'], ['backup', 'النسخ الاحتياطي'], ['audit', 'سجل التدقيق']]],
  ['الإدارة', [['settings', 'الإعدادات'], ['users', 'المستخدمون والأدوار'], ['opening', 'الأرصدة الافتتاحية'], ['period', 'إقفال الفترات']]],
];

function routePerm(name) { const r = ROUTES.find((x) => x[0] === name); return r ? r[2] : null; }
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
  for (const [group, items] of NAV) {
    const vis = items.filter(([r]) => allowed(r));
    if (!vis.length) continue;
    if (group) side.appendChild(h('div', { class: 'nav-group' }, group));
    for (const [r, label] of vis) side.appendChild(h('a', { class: 'nav', href: '#/' + r, 'data-route': r, onclick: () => side.classList.remove('open') }, label));
  }
  const sessionBadge = h('span', { class: 'who' });
  if (state.session) sessionBadge.append(h('a', { href: '#/sessions', class: 'badge ok' }, 'وردية مفتوحة ' + state.session.number));
  const top = h('header', { class: 'top' },
    h('button', { class: 'btn small menu-btn', 'aria-label': 'القائمة', onclick: () => side.classList.toggle('open') }, '☰'),
    h('div', { class: 'title' }, ''), sessionBadge,
    h('span', { class: 'who' }, state.me.full_name),
    h('a', { class: 'btn small', href: '#/password' }, 'كلمة المرور'),
    h('button', { class: 'btn small', onclick: async () => { await api('POST', '/auth/logout', {}); loginView(); } }, 'خروج'));
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
  document.querySelectorAll('.side a.nav').forEach((a) => a.classList.toggle('active', a.dataset.route === name));
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
  return me;
}

async function boot() {
  try {
    await refreshMe();
  } catch (e) {
    if (e.status === 401) return loginView();
    clear(app).appendChild(h('div', { class: 'boot' }, 'تعذر الاتصال بالخادم: ' + e.message));
    return;
  }
  state.cache.clear();
  layout();
  if (state.me.must_change_password) { location.hash = '#/password'; toast('يرجى تغيير كلمة المرور المؤقتة'); }
  await route();
}

window.addEventListener('hashchange', route);
window.addEventListener('auth-required', () => { if (state.me) { state.me = null; loginView('انتهت الجلسة؛ سجّل الدخول مجددًا'); } });
window.addEventListener('session-changed', async () => { await refreshMe(); layout(); route(); });
boot();
