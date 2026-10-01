// سجل المستندات، عرض المستند وإجراءاته، مرتجع المبيعات، والطباعة.
import { h, clear, dt, N, state, get, api, submitter, toast, run, M, Q, money, qty, inp, sel, field, num, table, badge, STATUS, PAY_STATUS, pageHead, can, askReason, today, monthStart, cashSelect, partySelect, modal } from '../lib.js';

const TYPE_TITLES = {
  sale: 'فواتير البيع', sale_return: 'مرتجعات المبيعات', purchase: 'فواتير الشراء', transfer: 'سجل التحويلات', 'receipt,payment,cash_transfer': 'سجل السندات',
  expense: 'المصروفات', purchase_order: 'طلبات الشراء',
};

export async function list({ el, q, isCurrent }, type) {
  const head = pageHead(TYPE_TITLES[type] || 'المستندات',
    type === 'sale' && can('sales.create') ? h('a', { class: 'btn primary', href: '#/pos' }, 'فاتورة جديدة') : null,
    type === 'purchase' && can('purchases.create') ? h('a', { class: 'btn primary', href: '#/purchase' }, 'فاتورة شراء جديدة') : null,
    type === 'purchase_order' && can('purchases.create') ? h('a', { class: 'btn primary', href: '#/purchase-order' }, 'طلب شراء جديد') : null,
    type.includes('receipt') && can('cash.receipt') ? h('a', { class: 'btn', href: '#/receipt' }, 'سند قبض') : null,
    type.includes('receipt') && can('cash.payment') ? h('a', { class: 'btn', href: '#/payment' }, 'سند صرف') : null);
  const qIn = inp({ placeholder: 'رقم المستند أو الطرف', value: q.q || '' });
  const from = inp({ type: 'date', value: q.from || monthStart() });
  const to = inp({ type: 'date', value: q.to || today() });
  const status = sel([{ value: '', label: 'كل الحالات' }, { value: 'draft', label: 'مسودة' }, { value: 'approved', label: 'معتمد' }, { value: 'reversed', label: 'ملغي' }], q.status || '');
  const types = type.split(',');
  const typeSel = types.length > 1 ? sel([{ value: type, label: 'الكل' }, ...types.map((t) => ({ value: t, label: { receipt: 'قبض', payment: 'صرف', cash_transfer: 'تحويل نقدي' }[t] || t }))], q.type || type) : null;
  const body = h('div');
  let offset = 0;
  const load = async () => {
    const r = await get('/docs', { type: typeSel ? typeSel.value : type, q: qIn.value, from: from.value, to: to.value, status: status.value, limit: 100, offset });
    if (!isCurrent()) return;
    const cols = [
      { key: 'number', label: 'الرقم', render: (d) => h('a', { href: '#/doc/' + d.id }, d.number) }, { key: 'date', label: 'التاريخ' },
      types.length > 1 ? { key: 'label', label: 'النوع' } : null,
      { key: 'party_name', label: 'الطرف' }, type === 'purchase' ? { key: 'supplier_invoice_no', label: 'رقم فاتورة المورد' } : null,
      type === 'sale' ? { key: 'rep_name', label: 'المندوب' } : null,
      { key: 'total', label: 'الإجمالي', type: 'money' },
      ['sale', 'purchase'].includes(type) ? { key: 'open_amount', label: 'المتبقي', type: 'money' } : null,
      type === 'purchase_order' ? { key: 'po', label: 'الاستلام', render: (d) => poBadge(d.data?.po_state) } : null,
      { key: 'status', label: 'الحالة', render: (d) => [badge(STATUS, d.status), ' ', d.payment_status && d.status === 'approved' ? badge(PAY_STATUS, d.payment_status) : ''] },
      { key: 'created_by_name', label: 'بواسطة' },
    ].filter(Boolean);
    body.replaceChildren(table({ columns: cols, rows: r.rows, onRow: (d) => { location.hash = '#/doc/' + d.id; } }),
      h('div', { class: 'row', style: { marginTop: '8px' } }, h('span', { class: 'muted' }, `${r.total} مستند`),
        offset > 0 ? h('button', { class: 'btn small', onclick: () => { offset -= 100; load(); } }, 'السابق') : null,
        offset + 100 < r.total ? h('button', { class: 'btn small', onclick: () => { offset += 100; load(); } }, 'التالي') : null));
  };
  el.append(head || '', h('form', { class: 'row card', style: { padding: '12px' }, onsubmit: (e) => { e.preventDefault(); offset = 0; load(); } },
    field('بحث', qIn), field('من', from), field('إلى', to), field('الحالة', status), typeSel ? field('النوع', typeSel) : null, h('button', { class: 'btn primary' }, 'عرض')), body);
  await load();
}

const LINE_COLS = {
  default: [
    { key: 'item_name', label: 'الصنف' }, { key: 'unit_name', label: 'الوحدة' }, { key: 'qty', label: 'الكمية', type: 'qty' }, { key: 'price', label: 'السعر', type: 'money' },
    { key: 'value', label: 'القيمة', type: 'money' }, { key: 'disc', label: 'الخصم', type: 'money', render: (l) => M((l.line_discount || 0) + (l.doc_discount || 0)) },
    { key: 'net', label: 'الصافي', type: 'money' }, { key: 'tax_rate_bp', label: 'ض%', render: (l) => l.tax_rate_bp }, { key: 'tax', label: 'الضريبة', type: 'money' },
    { key: 'total', label: 'الإجمالي', type: 'money' },
  ],
};

export async function view({ el, params }) {
  const d = await get('/docs/' + params[0]);
  pageHead(`${d.label} ${d.number}`);
  const actions = h('div', { class: 'actions', style: { marginBottom: '14px' } });
  const A = (label, fn, cls = '') => actions.append(h('button', { class: 'btn ' + cls, onclick: fn }, label));
  const L = (label, href, cls = '') => actions.append(h('a', { class: 'btn ' + cls, href }, label));
  const reload = () => { location.hash = '#/doc/' + d.id + '?t=' + Date.now(); };
  const reverse = (url, title) => A(title, async () => {
    const reason = await askReason(title);
    if (!reason) return;
    await run(() => api('POST', url, { reason }), 'تم');
    reload();
  }, 'danger');

  if (d.status === 'approved' && ['sale', 'sale_return', 'receipt', 'payment', 'purchase'].includes(d.type) && can('sales.print')) {
    A('طباعة A4', () => printDoc(d.id, 'a4'));
    if (['sale', 'sale_return', 'receipt'].includes(d.type)) A('إيصال حراري', () => printDoc(d.id, 'thermal'));
  }
  if (d.type === 'sale') {
    if (d.status === 'draft') {
      A('اعتماد', async () => { const send = submitter(); if (await run(() => send('POST', `/sales/${d.id}/approve`, {}), 'تم الاعتماد')) reload(); }, 'ok');
      draftCancel(d, A, reload);
    }
    if (d.status === 'approved') {
      if (can('sale_returns.create')) L('مرتجع', `#/return/${d.id}`);
      if (d.open_amount > 0 && can('cash.receipt') && d.party_id) L('تحصيل', `#/receipt?party=${d.party_id}&doc=${d.id}`, 'primary');
      if (can('sales.reverse')) reverse(`/sales/${d.id}/reverse`, 'إلغاء الفاتورة');
    }
  }
  if (d.type === 'sale_return' && d.status === 'draft' && can('sale_returns.approve')) {
    A('اعتماد المرتجع', async () => {
      const refund = d.open_amount > 0 ? await refundChoice() : null;
      if (refund === false) return;
      const send = submitter();
      if (await run(() => send('POST', `/sale-returns/${d.id}/approve`, { refund }), 'تم الاعتماد')) reload();
    }, 'ok');
    draftCancel(d, A, reload);
  }
  if (d.type === 'sale_return' && d.status === 'approved' && d.open_amount > 0 && can('cash.payment') && d.party_id) L('رد المبلغ للعميل', `#/payment?party=${d.party_id}&doc=${d.id}&account=AR`);
  if (d.type === 'purchase') {
    if (d.status === 'draft') {
      if (can('purchases.create')) L('تعديل', `#/purchase/${d.id}`);
      if (can('purchases.approve')) A('اعتماد الاستلام والفاتورة', async () => {
        const send = submitter();
        let r = await api('POST', `/purchases/${d.id}/approve`, {}).catch(async (e) => {
          if (e.code === 'DUPLICATE_SUPPLIER_INVOICE' && can('purchases.duplicate.override')) {
            const reason = await askReason('رقم فاتورة المورد مكرر', e.message + ' — اكتب سبب القبول');
            if (reason) return run(() => send('POST', `/purchases/${d.id}/approve`, { duplicate_reason: reason }));
            return null;
          }
          toast(e.message, 'bad'); return null;
        });
        if (r) { toast('تم الاعتماد', 'ok'); reload(); }
      }, 'ok');
      draftCancel(d, A, reload);
    }
    if (d.status === 'approved') {
      if (can('purchase_returns.create')) L('مرتجع للمورد', `#/purchase-return/${d.id}`);
      if (d.open_amount > 0 && can('cash.payment')) L('سداد', `#/payment?party=${d.party_id}&doc=${d.id}`, 'primary');
      if (can('purchases.reverse')) reverse(`/purchases/${d.id}/reverse`, 'إلغاء الفاتورة');
    }
  }
  if (d.type === 'purchase_order') {
    if (d.status === 'draft' && can('purchases.create')) L('تعديل', `#/purchase-order/${d.id}`);
    if (d.status === 'draft' && can('purchases.approve')) A('اعتماد الطلب', async () => { if (await run(() => api('POST', `/purchase-orders/${d.id}/approve`, {}), 'اعتُمد')) reload(); }, 'ok');
    if (d.status === 'draft') draftCancel(d, A, reload);
    if (d.status === 'approved' && ['open', 'partial'].includes(d.data?.po_state)) {
      if (can('purchases.create')) L('استلام (فاتورة شراء)', `#/purchase?po=${d.id}`, 'primary');
      if (can('purchases.approve')) A('إغلاق الطلب', async () => { const rs = await askReason('إغلاق طلب الشراء بما تبقى منه'); if (rs && await run(() => api('POST', `/purchase-orders/${d.id}/close`, { reason: rs }), 'أُغلق الطلب')) reload(); }, 'danger');
    }
  }
  if (d.type === 'purchase_return' && d.status === 'approved' && d.open_amount > 0 && can('cash.receipt')) L('استرداد من المورد', `#/receipt?party=${d.party_id}&doc=${d.id}&account=AP`);
  if (['receipt', 'payment', 'cash_transfer'].includes(d.type) && d.status === 'approved' && can('docs.reverse')) reverse(`/cash-docs/${d.id}/reverse`, 'إلغاء السند');
  if (d.type === 'expense') {
    if (d.status === 'draft' && can('expenses.approve')) A('اعتماد', async () => { if (await run(() => api('POST', `/expenses/${d.id}/approve`, {}), 'تم الاعتماد')) reload(); }, 'ok');
    if (d.status === 'draft') draftCancel(d, A, reload);
    if (d.status === 'approved' && d.open_amount > 0 && can('cash.payment')) A('دفع', async () => {
      const acc = await cashSelect('', {});
      const m = modal('دفع المصروف', field('من حساب', acc), [{ label: 'دفع', class: 'primary', onClick: async () => !!(await run(() => submitter()('POST', `/expenses/${d.id}/pay`, { cash_account_id: Number(acc.value) }), 'تم الدفع')) }]);
      if (await m.done) reload();
    }, 'primary');
    if (d.status === 'approved' && can('docs.reverse')) reverse(`/expenses/${d.id}/reverse`, 'إلغاء المصروف');
  }
  if (d.type === 'transfer' && d.status === 'approved' && d.data?.transit === 'in_transit' && can('stock.transfer')) A('استلام التحويل', async () => {
    const rows = d.lines.map((l) => ({ l, i: inp({ type: 'number', value: l.qty, style: { width: '90px' } }) }));
    const reason = inp({ placeholder: 'سبب النقص إن وجد' });
    const m = modal('استلام التحويل في ' + d.to_warehouse_name, h('div', null, table({ columns: [{ key: 'n', label: 'الصنف', render: (r) => r.l.item_name }, { key: 'u', label: 'الوحدة', render: (r) => r.l.unit_name },
      { key: 's', label: 'المرسل', render: (r) => Q(r.l.qty) }, { key: 'r', label: 'المستلم فعليًا', render: (r) => r.i }], rows }), h('div', { style: { marginTop: '8px' } }, field('السبب', reason))),
    [{ label: 'تأكيد الاستلام', class: 'primary', onClick: async () => !!(await run(() => api('POST', `/transfers/${d.id}/receive`, { received: rows.map((r) => ({ line_id: r.l.id, qty: num(r.i.value) })), reason: reason.value || null }), 'تم الاستلام')) }]);
    if (await m.done) reload();
  }, 'ok');
  if (d.type === 'transfer' && d.status === 'approved' && can('docs.reverse')) reverse(`/transfers/${d.id}/reverse`, 'إلغاء التحويل');
  if (d.type === 'stock_count') L('فتح الجرد', `#/count/${d.id}`, 'primary');
  if (d.type === 'damage' && d.status === 'draft' && can('stock.damage.approve')) A('اعتماد التالف', async () => { if (await run(() => api('POST', `/damages/${d.id}/approve`, {}), 'تم')) reload(); }, 'ok');
  if (d.type === 'commission') L('صفحة العمولات', `#/commissions?rep=${d.rep_id}`);

  const info = [
    ['الرقم', d.number], ['التاريخ', d.date], ['الحالة', badge(STATUS, d.status)],
    d.party_name ? ['الطرف', d.party_id ? h('a', { href: '#/party/' + d.party_id }, d.party_name) : d.party_name] : null,
    d.branch_name && (state.branchesCount || 1) > 1 ? ['الفرع', d.branch_name] : null,
    d.warehouse_name ? ['المستودع', d.warehouse_name] : null, d.to_warehouse_name ? ['إلى مستودع', d.to_warehouse_name] : null,
    d.cash_account_name ? ['الحساب', d.cash_account_name] : null, d.to_cash_account_name ? ['إلى حساب', d.to_cash_account_name] : null,
    d.rep_name ? ['المندوب', d.rep_name] : null, d.supplier_invoice_no ? ['رقم فاتورة المورد', d.supplier_invoice_no] : null,
    d.type === 'transfer' && d.data?.transit ? ['حالة النقل', { in_transit: h('span', { class: 'badge warn' }, 'بالطريق'), received: h('span', { class: 'badge ok' }, 'مستلم'), cancelled: h('span', { class: 'badge bad' }, 'ملغي') }[d.data.transit]] : null,
    d.data?.shortages ? ['نقص الاستلام', d.data.shortages.join('، ')] : null,
    d.ref_doc_id ? ['المستند الأصلي', h('a', { href: '#/doc/' + d.ref_doc_id }, d.ref_doc_number)] : null,
    d.due_date ? ['الاستحقاق', d.due_date] : null, d.expense_category_name ? ['التصنيف', d.expense_category_name] : null,
    d.type === 'purchase_order' ? ['حالة الاستلام', poBadge(d.data?.po_state)] : null,
    d.data?.closed_reason ? ['سبب الإغلاق', d.data.closed_reason] : null,
    d.payment_status ? ['السداد', badge(PAY_STATUS, d.payment_status)] : null,
    ['أنشأه', d.created_by_name], d.approved_by_name ? ['اعتمده', [d.approved_by_name, ' ', dt(d.approved_at)]] : null,
    d.reason ? ['السبب', d.reason] : null, d.notes ? ['ملاحظات', d.notes] : null, d.print_count ? ['مرات الطباعة', d.print_count] : null,
  ].filter(Boolean);

  const parts = [actions, h('div', { class: 'card' }, h('div', { class: 'doc-head' }, info.map(([k, v]) => h('div', null, h('b', null, k), v))))];
  if (d.lines.length) parts.push(h('div', { class: 'card' }, h('h3', null, 'البنود'), linesTable(d)));
  if (d.items) {
    parts.push(h('div', { class: 'card' }, h('h3', null, 'عناصر العمولة'), table({ columns: [
      { key: 'date', label: 'التاريخ' }, { key: 'source_number', label: 'السند' }, { key: 'target_number', label: 'الفاتورة/المرتجع' },
      { key: 'kind', label: 'النوع', render: (r) => (r.kind === 'collection' ? 'تحصيل' : 'تصحيح') }, { key: 'base', label: 'الأساس قبل الضريبة', type: 'money' },
      { key: 'rate_bp', label: 'النسبة %' }, { key: 'amount', label: 'العمولة', type: 'money' }], rows: d.items })));
  }
  const totalsRows = [['قيمة البنود', d.subtotal], ['الخصم', d.discount], ['الصافي', d.net], ['الضريبة', d.tax], ['تكاليف تابعة', d.extra_cost], ['الإجمالي', d.total],
    d.cost != null && can('cost.view') && ['sale', 'sale_return', 'purchase', 'transfer', 'damage', 'stock_count', 'purchase_return'].includes(d.type) ? ['التكلفة', d.cost] : null,
    d.open_amount != null ? ['المتبقي', d.open_amount] : null].filter((x) => x && x[1]);
  if (totalsRows.length) parts.push(h('div', { class: 'card', style: { maxWidth: '420px' } }, h('div', { class: 'total-box' }, totalsRows.map(([k, v]) => h('div', { class: 'line' }, h('span', null, k), M(v))))));
  if (d.allocations.length) {
    parts.push(h('div', { class: 'card' }, h('h3', null, 'التخصيصات والسداد'), table({ columns: [
      { key: 'date', label: 'التاريخ' }, { key: 'source_number', label: 'من', render: (a) => h('a', { href: '#/doc/' + a.source_doc_id }, a.source_number) },
      { key: 'target_number', label: 'على', render: (a) => h('a', { href: '#/doc/' + a.target_doc_id }, a.target_number) }, { key: 'amount', label: 'المبلغ', type: 'money' },
      { key: 'reversed', label: '', render: (a) => (a.reversed ? h('span', { class: 'badge bad' }, 'ملغي') : '') }], rows: d.allocations })));
  }
  if (d.related.length) parts.push(h('div', { class: 'card' }, h('h3', null, 'مستندات مرتبطة'), table({ columns: [
    { key: 'number', label: 'الرقم', render: (r) => h('a', { href: '#/doc/' + r.id }, r.number) }, { key: 'date', label: 'التاريخ' }, { key: 'type', label: 'النوع', render: (r) => (state.meta?.doc_labels?.[r.type] || r.type) },
    { key: 'total', label: 'المبلغ', type: 'money' }, { key: 'status', label: 'الحالة', render: (r) => badge(STATUS, r.status) }], rows: d.related })));
  if (d.attachments.length) parts.push(h('div', { class: 'card' }, h('h3', null, 'المرفقات'), d.attachments.map((a) => h('div', null, h('a', { href: `/api/attachments/${a.id}` }, a.file_name), ' ', h('span', { class: 'muted small' }, Math.round(a.size / 1024) + ' ك.ب')))));
  el.append(...parts);
}

function draftCancel(d, A, reload) {
  A('إلغاء المسودة', async () => {
    const reason = await askReason('إلغاء المسودة');
    if (reason && await run(() => api('POST', `/docs/${d.id}/cancel`, { reason }), 'أُلغيت المسودة')) reload();
  }, 'danger');
}

function linesTable(d) {
  const t = d.type;
  let cols;
  if (t === 'purchase_order') {
    cols = [{ key: 'item_name', label: 'الصنف' }, { key: 'unit_name', label: 'الوحدة' }, { key: 'qty', label: 'المطلوب', type: 'qty' },
      { key: 'received_qty', label: 'المستلم', render: (l) => Q((l.received_qty || 0) / (l.factor || 1) / 1000) }, { key: 'price', label: 'السعر', type: 'money' }, { key: 'total', label: 'الإجمالي', type: 'money' }];
  } else if (['sale', 'purchase', 'sale_return', 'purchase_return'].includes(t)) {
    cols = [...LINE_COLS.default];
    if (t === 'purchase') cols.splice(2, 0, { key: 'batch_no', label: 'الدفعة' }, { key: 'expiry_date', label: 'الانتهاء' });
    if (t === 'purchase' && can('cost.view')) cols.push({ key: 'extra_cost', label: 'تكاليف تابعة', type: 'money' }, { key: 'cost', label: 'التكلفة النهائية', type: 'money' });
    if (t === 'sale_return') cols.push({ key: 'condition', label: 'الحالة', render: (l) => ({ ok: 'صالح', pending: 'قيد الفحص', isolated: 'معزول', damaged: 'تالف' }[l.condition] || '') });
    if (t === 'sale' && can('cost.view')) cols.push({ key: 'cost', label: 'التكلفة', type: 'money' });
  } else if (t === 'stock_count') {
    cols = [{ key: 'item_name', label: 'الصنف' }, { key: 'batch_no', label: 'الدفعة' }, { key: 'expiry_date', label: 'الانتهاء' }, { key: 'system_qty', label: 'المرجعي', type: 'qty' },
      { key: 'counted_qty', label: 'المعدود', type: 'qty' }, { key: 'base_qty', label: 'الفرق', type: 'qty' }];
    if (can('cost.view')) cols.push({ key: 'amount', label: 'قيمة التسوية', type: 'money' });
  } else if (['expense'].includes(t)) {
    cols = [{ key: 'description', label: 'البيان' }, { key: 'amount', label: 'المبلغ', type: 'money' }, { key: 'tax', label: 'الضريبة', type: 'money' }, { key: 'total', label: 'الإجمالي', type: 'money' }];
  } else {
    cols = [{ key: 'item_name', label: 'الصنف' }, { key: 'unit_name', label: 'الوحدة' }, { key: 'qty', label: 'الكمية', type: 'qty' }, { key: 'batch_no', label: 'الدفعة' }, { key: 'expiry_date', label: 'الانتهاء' }];
    if (can('cost.view')) cols.push({ key: 'cost', label: 'التكلفة', type: 'money' });
    if (t === 'damage' || t === 'batch_status') cols.push({ key: 'description', label: 'السبب' });
  }
  return table({ columns: cols, rows: d.lines });
}

async function refundChoice() {
  const acc = await cashSelect('', {}, () => true, { empty: '— يبقى رصيدًا للعميل —' });
  const m = modal('رد قيمة المرتجع', h('div', null, h('p', null, 'المبلغ الذي يتجاوز مديونية الفاتورة يبقى رصيدًا للعميل أو يُرد نقدًا بسند صرف.'), field('رد من حساب', acc)),
    [{ label: 'متابعة', class: 'primary', onClick: () => (acc.value ? { cash_account_id: Number(acc.value) } : null) }]);
  const v = await m.done;
  return v === undefined ? false : v;
}

// ===================== مرتجع المبيعات =====================
export async function saleReturn({ el, params }) {
  const sale = await get('/docs/' + params[0]);
  const lines = await get(`/sales/${params[0]}/returnable`);
  pageHead(`مرتجع من الفاتورة ${sale.number}`);
  const rows = lines.map((l) => ({ l, q: inp({ type: 'number', placeholder: '0', style: { width: '90px' } }), c: sel([{ value: 'ok', label: 'صالح' }, { value: 'pending', label: 'قيد الفحص' }, { value: 'isolated', label: 'معزول' }, { value: 'damaged', label: 'تالف' }], 'ok') }));
  const reason = h('textarea', { placeholder: 'سبب المرتجع (مطلوب)' });
  // العميل النقدي يُرد له المبلغ نقدًا؛ العميل المسجل يمكن أن يبقى المبلغ رصيدًا له
  const refund = await cashSelect(state.session?.cash_account_id || '', {}, () => true, sale.party_id ? { empty: '— يبقى رصيدًا للعميل —' } : {});
  const send = submitter();
  el.append(
    h('div', { class: 'note' }, 'تُحسب قيمة المرتجع من سعر البند وخصمه وضريبته الأصلية، وتعود الكمية الصالحة فقط للرصيد القابل للبيع.'),
    h('div', { class: 'card' }, h('div', { class: 'table-wrap' }, h('table', null,
      h('thead', null, h('tr', null, ['الصنف', 'الوحدة', 'الكمية المباعة', 'القابل للإرجاع', 'السعر', 'كمية المرتجع', 'حالة الفحص'].map((x) => h('th', null, x)))),
      h('tbody', null, rows.map(({ l, q, c }) => h('tr', null, h('td', null, l.item_name), h('td', null, l.unit_name), h('td', null, Q(l.qty)), h('td', null, Q(l.returnable_qty)),
        h('td', null, M(l.price)), h('td', null, l.returnable_qty > 0 ? q : '—'), h('td', null, c))))))),
    h('div', { class: 'card' }, h('div', { class: 'grid wide' }, field('السبب', reason, { req: true }), field('رد المبلغ من', refund)),
      h('div', { class: 'actions', style: { marginTop: '12px' } },
        h('button', { class: 'btn ok', onclick: async () => {
          const body = {
            sale_id: sale.id, reason: reason.value, refund: refund.value ? { cash_account_id: Number(refund.value) } : null,
            lines: rows.filter((r) => num(r.q.value) > 0).map((r) => ({ line_id: r.l.id, qty: num(r.q.value), condition: r.c.value })),
          };
          if (!body.lines.length) return toast('أدخل كمية مرتجع', 'bad');
          const d = await run(() => send('POST', '/sale-returns', body), 'تم حفظ المرتجع');
          if (d) location.hash = '#/doc/' + d.id;
        } }, can('sale_returns.approve') ? 'اعتماد المرتجع' : 'حفظ للمراجعة والاعتماد'))));
}

// ===================== الطباعة =====================
export async function printDoc(id, format = 'a4') {
  try {
    const d = await get('/docs/' + id);
    const p = await api('POST', `/docs/${id}/print`, {});
    const s = state.settings;
    // رمز الفاتورة الضريبية المبسطة
    let qrImg = null;
    if (s.einvoice_qr && ['sale', 'sale_return'].includes(d.type)) {
      try {
        const q = await get(`/docs/${id}/qr`);
        qrImg = h('img', { src: 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(q.svg), alt: 'QR', style: { width: format === 'thermal' ? '36mm' : '32mm', height: 'auto', display: 'block', margin: '8px auto' } });
      } catch (e) { toast('تعذر إنشاء رمز الفاتورة: ' + e.message, 'bad'); }
    }
    d._qr = qrImg;
    const area = document.querySelector('.print-area') || document.body.appendChild(h('div', { class: 'print-area' }));
    clear(area);
    area.append(format === 'thermal' ? thermal(d, s, p.copy) : a4(d, s, p.copy));
    document.body.classList.add('printing');
    const page = h('style', null, format === 'thermal' ? `@page { size: ${s.receipt_width_mm || 80}mm auto; margin: 2mm; }` : '@page { size: A4; margin: 10mm; }');
    document.head.appendChild(page);
    const done = () => { document.body.classList.remove('printing'); clear(area); page.remove(); window.removeEventListener('afterprint', done); };
    window.addEventListener('afterprint', done);
    setTimeout(() => window.print(), 50);
  } catch (e) { toast(e.message, 'bad'); }
}

function a4(d, s, copy) {
  const isItems = d.lines.some((l) => l.item_name);
  return h('div', { class: 'print-a4' },
    h('div', { class: 'head' },
      h('div', null, h('h1', null, s.org_name), d.branch_name && (d.branch_address || d.branch_phone) ? h('div', null, d.branch_name) : null, h('div', null, d.branch_address || s.org_address), h('div', null, d.branch_phone || s.org_phone), s.org_tax_number ? h('div', null, 'الرقم الضريبي: ', s.org_tax_number) : null),
      h('div', { style: { textAlign: 'left' } }, h('h1', null, s.einvoice_qr && d.type === 'sale' ? 'فاتورة ضريبية مبسطة' : d.label), h('div', null, 'رقم: ', N(d.number)), h('div', null, 'التاريخ: ', N(d.date)),
        d.due_date ? h('div', null, 'الاستحقاق: ', N(d.due_date)) : null, copy ? h('div', { class: 'copy-mark' }, 'نسخة') : null)),
    d.party_name ? h('p', null, h('b', null, 'العميل/المورد: '), d.party_name) : null,
    d.ref_doc_number ? h('p', null, 'مرجع: ', d.ref_doc_number) : null,
    isItems ? h('table', null, h('thead', null, h('tr', null, ['#', 'الصنف', 'الوحدة', 'الكمية', 'السعر', 'الخصم', 'الضريبة', 'الإجمالي'].map((x) => h('th', null, x)))),
      h('tbody', null, d.lines.map((l, i) => h('tr', null, h('td', null, i + 1), h('td', null, l.item_name), h('td', null, l.unit_name), h('td', null, qty(l.qty)),
        h('td', null, money(l.price)), h('td', null, money((l.line_discount || 0) + (l.doc_discount || 0))), h('td', null, money(l.tax)), h('td', null, money(l.total)))))) : null,
    h('table', { style: { width: '320px', marginTop: '12px', marginRight: 'auto' } }, h('tbody', null,
      [['الإجمالي قبل الخصم', d.subtotal], ['الخصم', d.discount], ['الصافي', d.net], ['الضريبة', d.tax], ['الإجمالي', d.total],
        ['المدفوع', d.open_amount != null ? d.total - d.open_amount : null], ['المتبقي', d.open_amount]].filter(([k, v]) => v != null && (v !== 0 || k === 'الإجمالي' || k === 'المتبقي')).map(([k, v]) => h('tr', null, h('td', null, k), h('td', null, money(v)))))),
    d._qr || null,
    h('p', { style: { marginTop: '24px', textAlign: 'center' } }, s.invoice_footer || ''));
}

function thermal(d, s, copy) {
  return h('div', { class: 'print-thermal', style: { width: `${(s.receipt_width_mm || 80) - 8}mm` } },
    h('div', { class: 'c' }, h('b', null, s.org_name)), h('div', { class: 'c' }, d.branch_phone || s.org_phone || ''),
    s.org_tax_number ? h('div', { class: 'c' }, 'ر.ض: ', s.org_tax_number) : null,
    h('div', { class: 'c' }, d.label, ' ', N(d.number)), h('div', { class: 'c' }, N(d.date), copy ? ' — نسخة' : ''),
    d.party_name ? h('div', null, d.party_name) : null,
    d.lines.some((l) => l.item_name) ? h('table', { style: { width: '100%' } }, h('tbody', null, d.lines.map((l) => [
      h('tr', null, h('td', { colspan: 3 }, l.item_name)),
      h('tr', null, h('td', null, `${qty(l.qty)} ${l.unit_name}`), h('td', null, '× ' + money(l.price)), h('td', { style: { textAlign: 'left' } }, money(l.total)))]))) : null,
    h('div', null, '--------------------------------'),
    d.discount ? h('div', null, 'الخصم: ', money(d.discount)) : null, d.tax ? h('div', null, 'الضريبة: ', money(d.tax)) : null,
    h('div', null, h('b', null, 'الإجمالي: ', money(d.total))),
    d.open_amount != null ? h('div', null, 'المدفوع: ', money(d.total - d.open_amount), ' — المتبقي: ', money(d.open_amount)) : null,
    d._qr || null,
    h('div', { class: 'c', style: { marginTop: '6px' } }, s.invoice_footer || ''));
}
export { partySelect };

function poBadge(st) {
  return badge({ draft: ['مسودة', 'warn'], open: ['مفتوح', ''], partial: ['مستلم جزئيًا', 'warn'], received: ['مستلم بالكامل', 'ok'], closed: ['مغلق', 'bad'] }, st || 'draft');
}
