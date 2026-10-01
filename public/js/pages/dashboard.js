import { h, get, M, money, pageHead, inp, field, today, monthStart, can, Q, branchFilter } from '../lib.js';

export async function render({ el, isCurrent }) {
  pageHead('لوحة الإدارة');
  const from = inp({ type: 'date', value: monthStart() });
  const to = inp({ type: 'date', value: today() });
  const body = h('div');
  const branch = await branchFilter('');
  const load = async () => {
    const d = await get('/reports/dashboard', { from: from.value, to: to.value, branch_id: branch ? branch.value : '' });
    if (!isCurrent()) return;
    body.replaceChildren(view(d));
  };
  el.append(h('form', { class: 'row card', style: { padding: '12px' }, onsubmit: (e) => { e.preventDefault(); load(); } },
    field('من', from), field('إلى', to), branch ? field('الفرع', branch) : null, h('button', { class: 'btn primary' }, 'عرض')), body);
  await load();
}

function kpi(label, value, href, kind = '') {
  return h('a', { class: 'kpi ' + kind, href: href || null }, h('div', { class: 'k' }, label), h('div', { class: 'v' }, typeof value === 'number' ? M(value) : value));
}

function view(d) {
  const r = `from=${d.from}&to=${d.to}`;
  const kp = [kpi('صافي المبيعات', d.net_sales, `#/reports?tab=sales&${r}`)];
  if (d.cogs !== undefined) {
    kp.push(kpi('تكلفة المبيعات', d.cogs, `#/reports?tab=profit&${r}`), kpi('مجمل الربح', d.gross_profit, `#/reports?tab=profit&${r}`, d.gross_profit >= 0 ? 'ok' : 'bad'),
      kpi('المصروفات', d.expenses, `#/reports?tab=expenses&${r}`), kpi('صافي الربح التشغيلي', d.operating_profit, `#/reports?tab=profit&${r}`, d.operating_profit >= 0 ? 'ok' : 'bad'));
  }
  kp.push(kpi('التحصيلات', d.collections, `#/cash-docs?type=receipt&from=${d.from}&to=${d.to}`), kpi('مديونيات العملاء', d.receivables, '#/reports?tab=aging'),
    kpi('مستحقات الموردين', d.payables, '#/reports?tab=aging&account=AP'));
  if (d.stock_value !== undefined) kp.push(kpi('قيمة المخزون الصالح', d.stock_value, '#/stock'), kpi('مخزون منتهٍ/معزول', d.blocked_stock_value, '#/alerts', d.blocked_stock_value > 0 ? 'bad' : ''));
  const a = d.alerts;
  const alerts = h('div', { class: 'kpis' },
    kpi('أصناف ناقصة', String(a.low_stock), '#/alerts', a.low_stock ? 'bad' : ''),
    kpi('قريبة الانتهاء', String(a.near_expiry), '#/alerts', a.near_expiry ? 'bad' : ''),
    kpi('دفعات منتهية', String(a.expired), '#/alerts', a.expired ? 'bad' : ''),
    kpi('معزول/قيد الفحص', String(a.isolated), '#/alerts'),
    kpi('فواتير متأخرة', String(a.overdue_customers), '#/reports?tab=aging', a.overdue_customers ? 'bad' : ''),
    kpi('مستندات مسودة', String(a.drafts), '#/sales?status=draft'),
    kpi('ورديات مفتوحة', String(a.open_sessions), '#/sessions'),
    kpi('فروق ورديات بانتظار الاعتماد', String(a.pending_sessions), '#/sessions', a.pending_sessions ? 'bad' : ''));
  const max = Math.max(1, ...d.daily.map((x) => Math.abs(x.net_sales)));
  const chart = d.daily.length ? h('div', { class: 'bars', role: 'img', 'aria-label': 'صافي المبيعات اليومي' },
    d.daily.map((x) => h('div', { class: 'bar', style: { height: `${Math.max(2, (Math.abs(x.net_sales) / max) * 130)}px` }, 'data-tip': `${x.date}: ${money(x.net_sales)}` }))) : h('div', { class: 'empty' }, 'لا مبيعات في الفترة');
  return h('div', null,
    h('div', { class: 'kpis' }, kp),
    h('h3', null, 'التنبيهات'), alerts,
    h('div', { class: 'grid wide' },
      h('div', { class: 'card' }, h('h3', null, 'صافي المبيعات اليومي'), chart),
      can('cash.view') ? h('div', { class: 'card' }, h('h3', null, 'الصناديق والبنوك'),
        h('table', null, h('tbody', null, d.cash.map((c) => h('tr', null, h('td', null, h('a', { href: `#/cash?id=${c.id}` }, c.name)), h('td', { class: 'n' }, M(c.balance))))))) : null));
}
export { Q };
