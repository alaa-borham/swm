// فاتورة الشراء والاستلام، ومرتجع المشتريات.
import { h, clear, state, get, api, submitter, toast, run, M, Q, inp, sel, field, num, itemPicker, partySelect, warehouseSelect, cashSelect, pageHead, can, askReason, today } from '../lib.js';

export async function form({ el, params }) {
  const editing = params[0] ? await get('/docs/' + params[0]) : null;
  if (editing && editing.status !== 'draft') { location.hash = '#/doc/' + editing.id; return; }
  pageHead(editing ? `تعديل مسودة ${editing.number}` : 'فاتورة شراء واستلام');
  const data = editing?.data || {};
  const supplier = await partySelect('supplier', editing?.party_id || '');
  const invNo = inp({ value: editing?.supplier_invoice_no || '' });
  const date = inp({ type: 'date', value: editing?.date || today() });
  const due = inp({ type: 'date', value: editing?.due_date || '' });
  const wh = await warehouseSelect(editing?.warehouse_id || '');
  const notes = inp({ value: editing?.notes || '' });
  const invDisc = inp({ type: 'number', placeholder: 'مبلغ', value: editing?.invoice_discount_amount || '' });
  const basis = sel([{ value: 'value', label: 'بنسبة قيمة البند' }, { value: 'qty', label: 'بنسبة الكمية' }], data.extra_cost_basis || 'value');
  const payAmt = inp({ type: 'number', placeholder: '0', value: data.payment?.amount || '' });
  const payAcc = await cashSelect(data.payment?.cash_account_id || '', {});
  const cart = [];
  const extras = (data.extras || []).map((e) => ({ description: e.description, amount: e.amount / 10 ** (state.settings.money_decimals ?? 2) || '', cash_account_id: e.cash_account_id || '' }));
  if (editing) {
    for (const l of editing.lines) {
      const item = await get('/items/' + l.item_id);
      cart.push({ item, unit_id: l.unit_id, qty: l.qty, price: l.price, discount_amount: l.line_discount || '', tax: l.tax_rate_bp, batch_no: l.batch_no || '', prod_date: l.prod_date || '', expiry_date: l.expiry_date || '' });
    }
  }
  const tbody = h('tbody');
  const extrasBox = h('div');
  const summary = h('div', { class: 'total-box' });
  const picker = itemPicker({ placeholder: 'أضف صنفًا بالاسم أو الباركود', onPick: (it) => {
    const pu = it.units.find((u) => u.id === it.selected_unit_id && u.for_purchase) || it.units.find((u) => u.for_purchase) || it.units[0];
    cart.push({ item: it, unit_id: pu.id, qty: 1, price: '', discount_amount: '', tax: it.tax_rate_bp ?? '', batch_no: '', prod_date: '', expiry_date: '' });
    draw();
  } });

  function draw() {
    clear(tbody);
    let sub = 0;
    cart.forEach((l, i) => {
      const units = l.item.units.filter((u) => u.for_purchase && u.active);
      const set = (k) => (e) => { l[k] = e.target.value; if (['qty', 'price', 'discount_amount'].includes(k)) totalsOnly(); };
      const value = (num(l.qty) || 0) * (num(l.price) || 0) - (num(l.discount_amount) || 0);
      sub += value;
      tbody.append(h('tr', null,
        h('td', null, l.item.name),
        h('td', null, sel(units.map((u) => ({ value: u.id, label: `${u.name}${u.factor !== 1 ? ' (' + u.factor + ' ' + l.item.base_unit + ')' : ''}` })), l.unit_id, { onchange: (e) => { l.unit_id = Number(e.target.value); } })),
        h('td', null, inp({ type: 'number', value: l.qty, style: { width: '80px' }, oninput: set('qty') })),
        h('td', null, inp({ type: 'number', value: l.price, style: { width: '90px' }, oninput: set('price'), placeholder: 'تكلفة الوحدة' })),
        h('td', null, inp({ type: 'number', value: l.discount_amount, style: { width: '80px' }, oninput: set('discount_amount') })),
        h('td', null, inp({ type: 'number', value: l.tax, style: { width: '60px' }, oninput: set('tax'), placeholder: '%' })),
        h('td', null, inp({ value: l.batch_no, style: { width: '100px' }, oninput: set('batch_no') })),
        h('td', null, inp({ type: 'date', value: l.prod_date, oninput: set('prod_date') })),
        h('td', null, inp({ type: 'date', value: l.expiry_date, oninput: set('expiry_date'), required: l.item.track_expiry ? true : null, title: l.item.track_expiry ? 'مطلوب' : '' })),
        h('td', null, h('button', { class: 'btn small danger', onclick: () => { cart.splice(i, 1); draw(); } }, '×'))));
    });
    if (!cart.length) tbody.append(h('tr', null, h('td', { colspan: 10, class: 'empty' }, 'أضف الأصناف المستلمة فعليًا')));
    drawExtras();
    totalsOnly();
  }
  function totalsOnly() {
    const sub = cart.reduce((s, l) => s + (num(l.qty) || 0) * (num(l.price) || 0) - (num(l.discount_amount) || 0), 0);
    const ex = extras.reduce((s, e) => s + (num(e.amount) || 0), 0);
    clear(summary).append(h('div', { class: 'line' }, h('span', null, 'قيمة البنود بعد خصم البند (تقريبي قبل الضريبة)'), M(sub - (num(invDisc.value) || 0))),
      h('div', { class: 'line' }, h('span', null, 'تكاليف تابعة توزع على المخزون'), M(ex)),
      h('div', { class: 'small muted' }, 'الإجمالي النهائي مع الضريبة والتوزيع يظهر بعد الحفظ'));
  }
  function drawExtras() {
    clear(extrasBox);
    extras.forEach((e, i) => {
      extrasBox.append(h('div', { class: 'row', style: { marginBottom: '6px' } },
        field('البيان', inp({ value: e.description, oninput: (x) => { e.description = x.target.value; } })),
        field('المبلغ', inp({ type: 'number', value: e.amount, oninput: (x) => { e.amount = x.target.value; totalsOnly(); } })),
        field('دُفع من (اختياري)', cashSelectSync(e)),
        h('button', { class: 'btn small danger', onclick: () => { extras.splice(i, 1); drawExtras(); totalsOnly(); } }, '×')));
    });
  }
  const cashList = await get('/cash-accounts');
  const cashSelectSync = (e) => sel([{ value: '', label: 'على فاتورة المورد' }, ...cashList.filter((c) => c.active).map((c) => ({ value: c.id, label: c.name }))], e.cash_account_id, { onchange: (x) => { e.cash_account_id = x.target.value; } });

  const send = submitter();
  const save = async (approve) => {
    if (!supplier.value) return toast('اختر المورد', 'bad');
    if (!cart.length) return toast('أضف بندًا', 'bad');
    const body = {
      party_id: Number(supplier.value), supplier_invoice_no: invNo.value || null, date: date.value, due_date: due.value || null, warehouse_id: Number(wh.value),
      notes: notes.value || null, invoice_discount_amount: invDisc.value || null, extra_cost_basis: basis.value,
      extra_costs: extras.filter((e) => num(e.amount)).map((e) => ({ description: e.description || 'تكلفة إضافية', amount: num(e.amount), cash_account_id: e.cash_account_id ? Number(e.cash_account_id) : null })),
      payment: num(payAmt.value) ? { amount: num(payAmt.value), cash_account_id: Number(payAcc.value) } : null,
      lines: cart.map((l) => ({ item_id: l.item.id, unit_id: l.unit_id, qty: num(l.qty), price: num(l.price) ?? 0, discount_amount: l.discount_amount || null,
        tax_rate_pct: l.tax === '' || l.tax == null ? null : num(l.tax), batch_no: l.batch_no || null, prod_date: l.prod_date || null, expiry_date: l.expiry_date || null })),
    };
    let doc;
    try {
      doc = editing ? await send('PUT', `/purchases/${editing.id}`, { ...body, approve: false }) : await send('POST', '/purchases', { ...body, approve: false });
    } catch (e) { return toast(e.message, 'bad'); }
    if (approve) {
      try { await api('POST', `/purchases/${doc.id}/approve`, {}); }
      catch (e) {
        if (e.code === 'DUPLICATE_SUPPLIER_INVOICE' && can('purchases.duplicate.override')) {
          const reason = await askReason('رقم فاتورة المورد مكرر', e.message);
          if (reason) await run(() => api('POST', `/purchases/${doc.id}/approve`, { duplicate_reason: reason }));
        } else toast(`حُفظت المسودة ${doc.number} ولم تُعتمد: ${e.message}`, 'bad');
        location.hash = '#/doc/' + doc.id;
        return;
      }
      toast(`تم اعتماد ${doc.number} واستلام البضاعة`, 'ok');
    } else toast(`حُفظت المسودة ${doc.number}`, 'ok');
    location.hash = '#/doc/' + doc.id;
  };

  el.append(
    h('div', { class: 'card' }, h('div', { class: 'grid' },
      field('المورد', supplier, { req: true }), field('رقم فاتورة المورد', invNo), field('التاريخ', date, { req: true }), field('الاستحقاق', due),
      field('مستودع الاستلام', wh, { req: true }), field('ملاحظات', notes))),
    h('div', { class: 'card' }, picker.el, h('div', { class: 'table-wrap', style: { marginTop: '10px' } }, h('table', null,
      h('thead', null, h('tr', null, ['الصنف', 'الوحدة', 'الكمية', 'تكلفة الوحدة', 'خصم', 'ضريبة %', 'الدفعة', 'الإنتاج', 'الانتهاء', ''].map((x) => h('th', null, x)))), tbody))),
    h('div', { class: 'grid wide' },
      h('div', { class: 'card' }, h('h3', null, 'تكاليف الشراء التابعة (نقل، تحميل…)'), extrasBox,
        h('div', { class: 'row' }, field('أساس التوزيع', basis), h('button', { class: 'btn small', onclick: () => { extras.push({ description: '', amount: '', cash_account_id: '' }); drawExtras(); } }, '+ تكلفة'))),
      h('div', { class: 'card' }, h('h3', null, 'الخصم والسداد'), h('div', { class: 'row' }, field('خصم على الفاتورة', invDisc)),
        h('div', { class: 'row', style: { marginTop: '8px' } }, field('دفعة عند الاستلام', payAmt), field('من حساب', payAcc)), h('div', { style: { marginTop: '10px' } }, summary))),
    h('div', { class: 'actions' },
      can('purchases.approve') ? h('button', { class: 'btn ok', onclick: () => save(true) }, 'اعتماد الاستلام والفاتورة') : null,
      h('button', { class: 'btn', onclick: () => save(false) }, 'حفظ مسودة')),
    h('p', { class: 'small muted' }, 'المسودة لا تؤثر في المخزون أو الحسابات. عند الاعتماد يُثبت الاستلام مرة واحدة ويزداد المخزون وتُثبت تكلفة الدفعات ومستحق المورد.'));
  invDisc.addEventListener('input', totalsOnly);
  draw();
}

export async function purchaseReturn({ el, params }) {
  const pur = await get('/docs/' + params[0]);
  pageHead(`مرتجع للمورد من ${pur.number}`);
  const rows = pur.lines.map((l) => ({ l, q: inp({ type: 'number', placeholder: '0', style: { width: '90px' } }) }));
  const reason = h('textarea', { placeholder: 'سبب الإرجاع (مطلوب)' });
  const refund = await cashSelect('', {}, () => true, { empty: '— يُخصم من مستحق المورد —' });
  const send = submitter();
  el.append(
    h('div', { class: 'note' }, 'يُرجع من نفس الدفعة الأصلية وبتكلفتها التاريخية، ولا يتجاوز ما اشتُري بعد المرتجعات السابقة ولا الموجود من الدفعة في موقع الإرجاع.'),
    h('div', { class: 'card' }, h('div', { class: 'table-wrap' }, h('table', null,
      h('thead', null, h('tr', null, ['الصنف', 'الوحدة', 'المشترى', 'المرتجع سابقًا', 'الدفعة', 'السعر', 'كمية الإرجاع'].map((x) => h('th', null, x)))),
      h('tbody', null, rows.map(({ l, q }) => h('tr', null, h('td', null, l.item_name), h('td', null, l.unit_name), h('td', null, Q(l.qty)),
        h('td', null, Q(l.returned_qty / (l.factor || 1))), h('td', null, l.batch_no || ''), h('td', null, M(l.price)), h('td', null, q))))))),
    h('div', { class: 'card' }, h('div', { class: 'grid wide' }, field('السبب', reason, { req: true }), field('استرداد نقدي إلى (إن وُجد رصيد لنا)', refund)),
      h('div', { class: 'actions', style: { marginTop: '12px' } }, h('button', { class: 'btn ok', onclick: async () => {
        const body = { purchase_id: pur.id, reason: reason.value, refund: refund.value ? { cash_account_id: Number(refund.value) } : null,
          lines: rows.filter((r) => num(r.q.value) > 0).map((r) => ({ line_id: r.l.id, qty: num(r.q.value) })) };
        if (!body.lines.length) return toast('أدخل كمية', 'bad');
        const d = await run(() => send('POST', '/purchase-returns', body), 'تم اعتماد مرتجع المشتريات');
        if (d) location.hash = '#/doc/' + d.id;
      } }, 'اعتماد المرتجع'))));
}
