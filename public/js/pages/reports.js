// التقارير: عرض، تصفية، تصدير Excel/CSV، وطباعة (PDF من نافذة الطباعة).
import { h, get, M, inp, sel, field, table, pageHead, can, today, monthStart, download, lookup, qs, partySelect, branchFilter } from '../lib.js';

const TABS = [
  ['sales', 'المبيعات', 'reports.sales'], ['profit', 'الأرباح', 'profit.view'], ['purchases', 'المشتريات', 'reports.purchases'], ['aging', 'أعمار الديون', null],
  ['stock', 'المخزون', 'reports.stock'], ['expenses', 'المصروفات', 'reports.finance'], ['cash', 'الصناديق والبنوك', 'cash.view'], ['reps', 'المناديب', 'reps.view'],
  ['statement', 'كشف حساب', 'parties.view'], ['tax', 'الضريبة', 'reports.finance'],
  ['trial-balance', 'ميزان المراجعة', 'reports.finance'], ['ledger', 'دفتر الأستاذ', 'reports.finance'], ['balance-sheet', 'المركز المالي', 'reports.finance'],
];

export async function render({ el, q, isCurrent }) {
  pageHead('التقارير');
  const tabs = TABS.filter(([, , p]) => !p || can(p) || (p === null));
  const tab = q.tab && tabs.find((t) => t[0] === q.tab) ? q.tab : tabs[0][0];
  el.append(h('div', { class: 'tabs' }, tabs.map(([k, label]) => h('a', { href: `#/reports?tab=${k}`, class: k === tab ? 'active' : '' }, label))));
  const from = inp({ type: 'date', value: q.from || monthStart() });
  const to = inp({ type: 'date', value: q.to || today() });
  const extra = [];
  const params = () => {
    const p = { from: from.value, to: to.value };
    for (const [k, e] of extra) p[k] = e.value;
    return p;
  };
  const body = h('div');
  if (tab === 'sales') {
    const group = sel([{ value: 'item', label: 'حسب الصنف' }, { value: 'customer', label: 'حسب العميل' }, { value: 'rep', label: 'حسب المندوب' }, { value: 'day', label: 'حسب اليوم' },
      { value: 'category', label: 'حسب التصنيف' }, { value: 'warehouse', label: 'حسب المستودع' }], q.group || 'item');
    extra.push(['group', group]);
  }
  if (tab === 'purchases') extra.push(['group', sel([{ value: 'supplier', label: 'حسب المورد' }, { value: 'item', label: 'حسب الصنف' }], 'supplier')]);
  if (tab === 'aging') extra.push(['account', sel([{ value: 'AR', label: 'ديون العملاء' }, { value: 'AP', label: 'مستحقات الموردين' }], q.account || 'AR')]);
  if (tab === 'stock') {
    const whs = await lookup('warehouses');
    extra.push(['warehouse_id', sel([{ value: '', label: 'كل المستودعات' }, ...whs.map((w) => ({ value: w.id, label: w.name }))], '')], ['by', sel([{ value: 'item', label: 'حسب الصنف' }, { value: 'batch', label: 'حسب الدفعة' }], 'item')]);
  }
  if (tab === 'ledger') {
    const accs = (await get('/accounts')).all;
    extra.push(['account', sel(accs.map((a) => ({ value: a.code, label: a.name })), q.account || 'CASH')]);
  }
  if (tab === 'balance-sheet') extra.push(['as_of', inp({ type: 'date', value: q.as_of || today() })]);
  if (tab === 'cash') {
    const cash = await lookup('cash');
    extra.push(['cash_account_id', sel([{ value: '', label: 'ملخص الحسابات' }, ...cash.map((c) => ({ value: c.id, label: c.name }))], q.id || '')]);
  }
  if (tab === 'statement') {
    const kind = sel([{ value: 'AR', label: 'عميل' }, { value: 'AP', label: 'مورد' }], q.account || 'AR');
    const wrap = h('div', { class: 'field' });
    const setParty = async () => { const s = await partySelect(kind.value === 'AR' ? 'customer' : 'supplier', q.party || ''); wrap.replaceChildren(h('label', null, 'الطرف'), s); extra[1] = ['party_id', s]; };
    extra.push(['account', kind], ['party_id', { value: '' }]);
    kind.addEventListener('change', setParty);
    await setParty();
    extra.push(['_wrap', { value: undefined, el: wrap }]);
  }
  if (!['statement', 'aging', 'reps', 'cash'].includes(tab)) { const b = await branchFilter(q.branch_id); if (b) extra.push(['branch_id', b]); }
  if (tab === 'sales') extra[0][1].append(new Option('حسب الفرع', 'branch'));
  const noDates = ['aging', 'stock', 'balance-sheet'].includes(tab);
  const load = async () => {
    const p = params();
    delete p._wrap;
    if (noDates) { delete p.from; delete p.to; }
    if (tab === 'statement' && !p.party_id) { body.replaceChildren(h('div', { class: 'empty' }, 'اختر الطرف')); return; }
    const url = { profit: '/reports/profit', tax: '/reports/tax', 'balance-sheet': '/reports/balance-sheet' }[tab] || `/reports/${tab}`;
    const r = await get(url, p);
    if (!isCurrent()) return;
    if (tab === 'balance-sheet') return body.replaceChildren(balanceView(r));
    if (tab === 'trial-balance' && !r.balanced) body.before(h('div', { class: 'note bad' }, 'تنبيه: الميزان غير متوازن'));
    if (tab === 'profit') return body.replaceChildren(profitView(r));
    if (tab === 'tax') return body.replaceChildren(h('div', { class: 'card', style: { maxWidth: '480px' } }, lines([['ضريبة المبيعات المستحقة', r.output_tax], ['ضريبة المشتريات القابلة للاسترداد', r.input_tax], ['الصافي المستحق', r.net_due]]),
      h('p', { class: 'small muted' }, 'معالجة الضريبة وإقرارها تحدد بالتنسيق مع محاسب المؤسسة وفق بلد التشغيل.')));
    const exp = can('reports.export') ? [
      h('button', { class: 'btn', onclick: () => download(`/reports/${tab}/export${qs({ ...p, format: 'xlsx' })}`, `${tab}.xlsx`) }, 'Excel'),
      h('button', { class: 'btn', onclick: () => download(`/reports/${tab}/export${qs({ ...p, format: 'csv' })}`, `${tab}.csv`) }, 'CSV')] : [];
    body.replaceChildren(h('div', { class: 'actions', style: { marginBottom: '10px' } }, h('b', { style: { flex: 1 } }, r.title), ...exp, h('button', { class: 'btn', onclick: () => window.print() }, 'طباعة / PDF')),
      r.opening !== undefined ? h('div', { class: 'note' }, 'رصيد أول المدة: ', M(r.opening), ' — رصيد آخر المدة: ', M(r.closing)) : '',
      table({ columns: r.columns, rows: r.rows, totals: r.totals }),
      r.by_payment && r.by_payment.length ? h('div', { class: 'card', style: { marginTop: '12px', maxWidth: '480px' } }, h('h3', null, 'السداد على فواتير الفترة حسب الحساب'), lines(r.by_payment.map((x) => [x.name, x.amount]))) : '');
  };
  const fields = [];
  if (!noDates) fields.push(field('من', from), field('إلى', to));
  for (const [k, e] of extra) {
    if (k === '_wrap') fields.push(e.el);
    else if (k === 'party_id') continue;
    else fields.push(field({ as_of: 'حتى تاريخ', group: 'التجميع', account: 'الحساب', warehouse_id: 'المستودع', by: 'العرض', cash_account_id: 'الحساب', branch_id: 'الفرع' }[k] || k, e));
  }
  el.append(h('form', { class: 'row card', style: { padding: '12px' }, onsubmit: (e) => { e.preventDefault(); load(); } }, ...fields, h('button', { class: 'btn primary' }, 'عرض')), body);
  await load();
}

const lines = (rows) => h('div', { class: 'total-box' }, rows.map(([k, v]) => h('div', { class: 'line' }, h('span', null, k), M(v))));

function profitView(r) {
  return h('div', { class: 'grid wide' },
    h('div', { class: 'card' }, h('h3', null, `قائمة الأرباح من ${r.from} إلى ${r.to}`),
      lines([['المبيعات قبل الضريبة', r.sales], ['المرتجعات', -r.returns], ['صافي المبيعات', r.net_sales], ['تكلفة البضاعة المباعة', -r.cogs], ['مجمل الربح', r.gross_profit],
        ['المصروفات المعتمدة', -r.expenses], ['العمولات المعتمدة', -r.commissions], ['خسائر الجرد والتالف', -r.inventory_losses], ['زيادات الجرد', r.inventory_gains],
        ['فروق الصندوق والعهد', -r.cash_differences], ['فروق مرتجع المشتريات', r.other_income]]),
      h('div', { class: 'total-box' }, h('div', { class: 'line grand' }, h('span', null, 'صافي الربح التشغيلي'), M(r.operating_profit))),
      h('p', { class: 'small muted' }, `هامش مجمل الربح: ${r.gross_margin}% — الأرباح محسوبة من التكاليف التاريخية للدفعات المصروفة.`),
      h('button', { class: 'btn', onclick: () => window.print() }, 'طباعة / PDF')),
    h('div', { class: 'card' }, h('h3', null, 'المصروفات حسب التصنيف'), table({ columns: [{ key: 'name', label: 'التصنيف' }, { key: 'amount', label: 'المبلغ', type: 'money' }], rows: r.expenses_by_category, empty: 'لا مصروفات' })));
}

function balanceView(r) {
  const block = (title, rows, total) => h('div', { class: 'card' }, h('h3', null, title), lines(rows.map((x) => [x.name, x.amount])),
    total != null ? h('div', { class: 'total-box' }, h('div', { class: 'line grand' }, h('span', null, 'الإجمالي'), M(total))) : null);
  const sum = (a) => a.reduce((s, x) => s + x.amount, 0);
  return h('div', null,
    h('div', { class: 'note' + (r.balanced ? '' : ' bad') }, `المركز المالي في ${r.as_of} — `, r.balanced ? 'متوازن: الأصول = الالتزامات + حقوق الملكية' : 'غير متوازن'),
    h('div', { class: 'grid wide' }, block('الأصول', r.assets, r.total_assets),
      h('div', null, block('الالتزامات', r.liabilities, sum(r.liabilities)), block('حقوق الملكية', r.equity, sum(r.equity)),
        h('div', { class: 'card' }, h('div', { class: 'total-box' }, h('div', { class: 'line grand' }, h('span', null, 'الالتزامات + حقوق الملكية'), M(r.total_liabilities_equity)))))),
    h('p', { class: 'small muted' }, 'القوائم الرسمية تُعتمد بالتنسيق مع محاسب المؤسسة؛ يمكن إضافة الأصول الثابتة ورأس المال والالتزامات الأخرى بقيود يدوية.'),
    h('button', { class: 'btn', onclick: () => window.print() }, 'طباعة / PDF'));
}
