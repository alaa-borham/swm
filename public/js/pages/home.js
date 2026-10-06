// الصفحة الرئيسية: ترحيب، ملخص اليوم، أزرار كبيرة للعمليات اليومية حسب الصلاحيات، وشريط الرصيد.
import { icon as svgIcon } from '../icons.js';
import { h, get, money, state, can, dt, pageHead } from '../lib.js';

const ROLE_NAMES = { admin: 'المدير', cashier: 'الكاشير', purchasing: 'المشتريات', storekeeper: 'أمين المستودع', accountant: 'المحاسب', rep: 'المندوب' };

export async function render({ el, isCurrent }) {
  pageHead('الرئيسية');
  const s = state.settings || {};
  const me = state.me || {};
  const isRep = !!state.rep && !can('parties.all');
  const sum = await get('/home').catch(() => ({}));
  if (!isCurrent()) return;

  const hour = new Date().getHours();
  const greet = hour < 12 ? 'صباح الخير' : 'مساء الخير';
  const dateStr = new Date().toLocaleDateString('ar-SA-u-ca-gregory', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const role = (me.roles || []).map((r) => ROLE_NAMES[r] || r).join('، ');

  // الترحيب
  const hero = h('div', { class: 'home-hero' },
    h('div', { class: 'home-hero-text' },
      h('div', { class: 'home-greet' }, `${greet}، ${me.full_name || me.username || ''}`),
      h('div', { class: 'home-sub' }, dateStr, role ? ` · ${role}` : '', isRep && state.rep?.name ? ` · ${state.rep.name}` : '')),
    s.org_logo_url ? h('img', { class: 'home-logo', src: s.org_logo_url, alt: '' }) : h('div', { class: 'home-org' }, s.org_name || ''));

  // ملخص اليوم
  const stat = (label, value, href, ic) => h(href ? 'a' : 'div', { class: 'home-stat', href: href || null },
    h('span', { class: 'ic' }, svgIcon(ic, 20)), h('span', { class: 'k' }, label), h('span', { class: 'v' }, value));
  const stats = [];
  if (sum.sales_today !== undefined) stats.push(stat(`مبيعات اليوم (${sum.sales_count || 0})`, money(sum.sales_today), '#/sales', 'sales'));
  if (sum.collections_today !== undefined) stats.push(stat('تحصيلات اليوم', money(sum.collections_today), can('cash.view') ? '#/cash-docs?type=receipt' : null, 'in'));
  if (sum.drafts) stats.push(stat('مسودات بانتظارك', String(sum.drafts), '#/sales?status=draft', 'clipboard'));
  if (sum.stock_items !== undefined) stats.push(stat('أصناف في عهدتك', String(sum.stock_items), '#/stock', 'boxes'));

  // الأزرار الكبيرة (حسب الصلاحيات)
  const tiles = [
    ['sales.create', '#/pos', 'sales', 'فاتورة بيع جديدة', 'c1'],
    ['purchases.create', '#/purchase', 'purchases', 'فاتورة شراء جديدة', 'c2'],
    ['cash.receipt', '#/receipt', 'in', 'تحصيل من عميل', 'c3'],
    ['parties.manage', '#/parties?type=customer&new=customer', 'user', 'عميل جديد', 'c4'],
    ['stock.view', '#/stock', 'boxes', isRep ? 'بضاعتي' : 'رصيد المخزون', 'c5'],
    ['stock.transfer', '#/transfer', 'truck', 'تحويل / تسليم مندوب', 'c6'],
    ['sale_returns.create', '#/sales?type=sale_return', 'ret', 'المرتجعات', 'c7'],
    ['items.view', '#/items', 'barcode', 'الأصناف', 'c8'],
  ].filter(([p]) => can(p));
  const { canAddStock, addStockModal } = await import('./addstock.js');
  const tileEls = tiles.map(([, href, ic, label, c], i) => h('a', { class: `home-tile ${c}${i === 0 ? ' main' : ''}`, href }, h('span', { class: 'ic' }, svgIcon(ic, 30)), h('span', { class: 't' }, label)));
  if (canAddStock()) tileEls.push(h('button', { type: 'button', class: 'home-tile c9', onclick: () => addStockModal(null, () => {}) }, h('span', { class: 'ic' }, svgIcon('plus', 30)), h('span', { class: 't' }, 'إضافة رصيد')));

  // روابط سريعة
  const links = [
    ['sales.view', '#/sales', 'list', 'عرض الفواتير السابقة', 'فواتير البيع والمسودات'],
    ['purchases.view', '#/purchases', 'invoice', 'فواتير الشراء', 'المشتريات من الموردين'],
    ['parties.view', '#/parties?type=customer', 'users', 'العملاء', 'الأرصدة وكشوف الحساب'],
    ['dashboard.view', '#/dashboard', 'chart', 'لوحة الإدارة والتقارير', 'المبيعات والأرباح والتنبيهات'],
    ['backup.manage', '#/backup', 'save', 'النسخ الاحتياطي', 'نسخ واسترجاع البيانات'],
    ['settings.manage', '#/settings', 'settings', 'الإعدادات', 'بيانات المؤسسة والضرائب والخصم'],
  ].filter(([p]) => can(p));
  const linkEls = links.map(([, href, ic, label, sub]) => h('a', { class: 'home-link', href },
    h('span', { class: 'ic' }, svgIcon(ic, 22)), h('span', { class: 'tx' }, h('b', null, label), h('small', null, sub)), h('span', { class: 'chev', 'aria-hidden': 'true' }, '‹')));

  // آخر نسخة احتياطية (للمدير)
  let backupNote = null;
  if (can('backup.manage')) {
    const list = await get('/backups').catch(() => []);
    const last = list[0];
    backupNote = h('div', { class: 'home-backup' }, svgIcon('save', 18), h('span', null, 'آخر نسخة احتياطية: ', last ? dt(last.created_at) : 'لا توجد'));
  }

  // شريط الرصيد
  const balanceBar = sum.balance ? h('a', { class: 'home-balance', href: can('cash.view') ? '#/cash' : null },
    h('span', null, svgIcon('card', 20), ' ', sum.balance.label), h('b', null, money(sum.balance.value))) : null;

  el.append(h('div', { class: 'home' }, hero, balanceBar,
    stats.length ? h('div', { class: 'home-stats' }, stats) : null,
    h('div', { class: 'home-tiles' }, tileEls),
    linkEls.length ? h('div', { class: 'home-links' }, linkEls) : null,
    backupNote));
}
