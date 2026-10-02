// المخزون: الأرصدة والدفعات، التنبيهات، التحويل، الجرد، التالف، بطاقة الصنف، المخزون الافتتاحي.
import { canAddStock, addStockModal } from './addstock.js';
import { h, clear, get, api, submitter, toast, run, M, Q, inp, sel, field, num, table, badge, STATUS, itemPicker, warehouseSelect, pageHead, can, askReason, today, lookup, modal, download } from '../lib.js';

export async function balances({ el, q, isCurrent }) {
  pageHead('رصيد المخزون', can('reports.export') ? h('button', { class: 'btn', onclick: () => download(`/reports/stock/export?format=xlsx&by=${by.value}&warehouse_id=${wh.value}`, 'stock.xlsx') }, 'تصدير Excel') : null,
    h('button', { class: 'btn', onclick: () => window.print() }, 'طباعة'),
    canAddStock() ? h('button', { class: 'btn ok', onclick: () => addStockModal(null, () => load()) }, '+ إضافة رصيد') : null);
  const wh = await warehouseSelect(q.warehouse_id || '', {}, { all: true });
  const by = sel([{ value: 'item', label: 'حسب الصنف' }, { value: 'batch', label: 'حسب التشغيلة' }], q.by || 'item');
  const state = sel([{ value: '', label: 'كل الحالات' }, { value: 'صالح', label: 'صالح' }, { value: 'منتهي', label: 'منتهي' }, { value: 'معزول', label: 'معزول' }, { value: 'قيد الفحص', label: 'قيد الفحص' }], '');
  const body = h('div');
  const load = async () => {
    const r = await get('/reports/stock', { warehouse_id: wh.value, by: by.value, state: by.value === 'batch' ? state.value : '' });
    if (!isCurrent()) return;
    const cols = r.columns.map((c) => (c.key === 'name' && by.value === 'item' ? { ...c, render: (row) => h('a', { href: `#/item-card?item=${row.item_id}` }, row.name) } : c));
    if (by.value === 'batch' && can('stock.batch.change')) cols.push({ key: 'act', label: '', render: (row) => h('button', { class: 'btn small', onclick: () => batchStatus(row, load) }, 'تغيير الحالة') });
    else if (by.value === 'batch' && can('sale_returns.inspect')) cols.push({ key: 'act', label: '', render: (row) => (row.state === 'قيد الفحص' ? h('button', { class: 'btn small', onclick: () => batchStatus(row, load) }, 'نتيجة الفحص') : '') });
    body.replaceChildren(table({ columns: cols, rows: r.rows, totals: r.totals }));
  };
  by.addEventListener('change', () => { state.disabled = by.value !== 'batch'; });
  state.disabled = by.value !== 'batch';
  el.append(h('form', { class: 'row card filters', style: { padding: '12px' }, onsubmit: (e) => { e.preventDefault(); load(); } }, field('المستودع', wh), field('العرض', by), field('الحالة', state), h('button', { class: 'btn primary' }, 'عرض')), body);
  await load();
}

async function batchStatus(row, done) {
  const to = sel([{ value: 'ok', label: 'صالح للبيع' }, { value: 'isolated', label: 'معزول' }, { value: 'damaged', label: 'تالف (خسارة)' }], 'isolated');
  const qn = inp({ type: 'number', value: row.qty });
  const reason = h('textarea', { placeholder: 'السبب (مطلوب)' });
  const m = modal(`تغيير حالة التشغيلة ${row.batch_no || row.batch_id} — ${row.name}`, h('div', { class: 'grid' }, field('الحالة الجديدة', to), field('الكمية', qn), field('السبب', reason)),
    [{ label: 'تنفيذ', class: 'primary', onClick: async () => !!(await run(() => api('POST', `/batches/${row.batch_id}/status`, { to_status: to.value, qty: num(qn.value), reason: reason.value }), 'تم')) }]);
  if (await m.done) done();
}

export async function alerts({ el }) {
  pageHead('تنبيهات المخزون والصلاحية');
  const a = await get('/reports/alerts');
  const sec = (title, cols, rows, kind = '') => h('div', { class: 'card' }, h('h3', null, title, ' ', h('span', { class: 'badge ' + kind }, rows.length)), table({ columns: cols, rows, empty: 'لا يوجد' }));
  el.append(
    sec('أصناف وصلت حد إعادة الطلب', [{ key: 'code', label: 'الكود' }, { key: 'name', label: 'الصنف' }, { key: 'sellable', label: 'الصالح', type: 'qty' }, { key: 'reorder_level', label: 'حد الطلب', type: 'qty' }, { key: 'base_unit', label: 'الوحدة' }], a.low_stock, 'bad'),
    sec('قريبة الانتهاء', [{ key: 'name', label: 'الصنف' }, { key: 'warehouse', label: 'المستودع' }, { key: 'batch_no', label: 'رقم التشغيلة' }, { key: 'expiry_date', label: 'الانتهاء' }, { key: 'days_left', label: 'أيام متبقية' }, { key: 'qty', label: 'الكمية', type: 'qty' }], a.near_expiry, 'warn'),
    sec('منتهية (لا تُباع)', [{ key: 'name', label: 'الصنف' }, { key: 'warehouse', label: 'المستودع' }, { key: 'batch_no', label: 'رقم التشغيلة' }, { key: 'expiry_date', label: 'الانتهاء' }, { key: 'qty', label: 'الكمية', type: 'qty' }, can('cost.view') ? { key: 'cost', label: 'القيمة', type: 'money' } : null].filter(Boolean), a.expired, 'bad'),
    sec('تحويلات بالطريق (بانتظار الاستلام)', [{ key: 'number', label: 'التحويل', render: (r) => h('a', { href: '#/doc/' + r.id }, r.number) }, { key: 'date', label: 'التاريخ' },
      { key: 'from_name', label: 'من' }, { key: 'to_name', label: 'إلى' }, can('cost.view') ? { key: 'cost', label: 'القيمة', type: 'money' } : null].filter(Boolean), a.in_transit, 'warn'),
    sec('معزولة أو قيد الفحص', [{ key: 'name', label: 'الصنف' }, { key: 'warehouse', label: 'المستودع' }, { key: 'batch_no', label: 'رقم التشغيلة' }, { key: 'status', label: 'الحالة', render: (r) => (r.status === 'pending' ? 'قيد الفحص' : 'معزول') }, { key: 'qty', label: 'الكمية', type: 'qty' }], a.isolated));
}

// ===================== التحويل =====================
export async function transfer({ el, q }) {
  pageHead('تحويل بين المستودعات / تسليم عهدة مندوب');
  // تسليم بضاعة لمندوب: ?rep=ID يختار مستودع المندوب كوجهة
  let toId = q.to || '';
  if (q.rep) { try { toId = (await get('/reps/' + q.rep)).warehouse_id || toId; } catch { /* تجاهل */ } }
  const from = await warehouseSelect(q.from || '');
  const to = await warehouseSelect(toId, {}, { any: true });
  if (from.value && from.value === to.value && from.options.length > 1) from.selectedIndex = from.selectedIndex === 0 ? 1 : 0;
  const notes = inp({ placeholder: 'ملاحظات' });
  const transit = h('input', { type: 'checkbox' });
  // قائمة أصناف المستودع المصدر: اختر ما يُحوَّل وعدّل الكمية والوحدة
  const allItems = new Map(((await get('/items', { limit: 5000, active: 1 })).rows || []).map((it) => [it.id, it]));
  let rows = [];
  const picked = new Map(); // item_id → { qty, unit_id }
  const filterIn = inp({ placeholder: 'بحث في أصناف المستودع بالاسم أو الكود' });
  const tbody = h('tbody');
  const countBox = h('span', { class: 'muted small' });
  const factorOf = (it, unitId) => (it.units.find((u) => u.id === unitId)?.factor || 1);
  const draw = () => {
    clear(tbody);
    const f = filterIn.value.trim();
    const list = rows.filter((r) => !f || r.name.includes(f) || String(r.code).includes(f));
    for (const r of list) {
      const it = allItems.get(r.item_id);
      if (!it) continue;
      const p = picked.get(r.item_id);
      const units = it.units.filter((u) => u.active);
      const chk = h('input', { type: 'checkbox', checked: !!p, onchange: (e) => {
        if (e.target.checked) picked.set(r.item_id, { qty: '', unit_id: it.units.find((u) => u.is_base).id }); else picked.delete(r.item_id);
        draw(); if (e.target.checked) tbody.querySelector(`[data-q="${r.item_id}"]`)?.focus();
      } });
      const qtyIn = inp({ type: 'number', value: p?.qty ?? '', placeholder: '0', style: { width: '90px' }, oninput: (e) => {
        const cur = picked.get(r.item_id) || { unit_id: it.units.find((u) => u.is_base).id };
        if (e.target.value === '' || Number(e.target.value) === 0) { cur.qty = e.target.value; picked.set(r.item_id, cur); } else picked.set(r.item_id, { ...cur, qty: e.target.value });
        chk.checked = true; summary();
      } });
      qtyIn.dataset.q = r.item_id;
      const unitSel = sel(units.map((u) => ({ value: u.id, label: u.name + (u.is_base ? '' : ` (${u.factor} ${it.base_unit})`) })), p?.unit_id || it.units.find((u) => u.is_base).id, { onchange: (e) => {
        const cur = picked.get(r.item_id) || { qty: '' };
        picked.set(r.item_id, { ...cur, unit_id: Number(e.target.value) }); chk.checked = true; summary();
      } });
      tbody.append(h('tr', { class: p ? 'sel' : null }, h('td', null, chk), h('td', null, r.name, h('div', { class: 'small muted' }, r.code)),
        h('td', null, Q(r.sellable), ' ', r.base_unit), h('td', null, unitSel), h('td', null, qtyIn),
        h('td', null, h('button', { type: 'button', class: 'btn small', title: 'تحويل كامل الكمية المتاحة', onclick: () => { picked.set(r.item_id, { qty: r.sellable, unit_id: it.units.find((u) => u.is_base).id }); draw(); } }, 'الكل'))));
    }
    if (!tbody.children.length) tbody.append(h('tr', null, h('td', { colspan: 6, class: 'empty' }, rows.length ? 'لا نتائج للبحث' : 'لا توجد أصناف لها رصيد صالح في هذا المستودع')));
    summary();
  };
  const summary = () => {
    const n = [...picked.values()].filter((p) => Number(p.qty) > 0).length;
    countBox.textContent = n ? `${n} صنف محدد للتحويل` : '';
  };
  const loadRows = async () => {
    picked.clear();
    const r = await get('/reports/stock', { warehouse_id: from.value });
    rows = (r.rows || []).filter((x) => x.item_id && x.sellable > 0);
    draw();
  };
  from.addEventListener('change', loadRows);
  filterIn.addEventListener('input', draw);
  const send = submitter();
  el.append(h('div', { class: 'note' }, 'اختر المستودع المصدر فتظهر أصنافه المتاحة. حدد الأصناف واكتب الكمية (أو «الكل»). يُصرف بالأقرب انتهاءً ويدخل الوجهة بنفس الدفعات والتكلفة، ولا يُعد بيعًا.'),
    h('div', { class: 'card' }, h('div', { class: 'grid' }, field('من مستودع', from, { req: true }), field('إلى مستودع', to, { req: true }), field('ملاحظات', notes)),
      h('label', { class: 'check', style: { marginTop: '10px' } }, transit, 'نقل على مراحل: تبقى البضاعة "بالطريق" غير متاحة في الطرفين حتى تستلمها الوجهة')),
    h('div', { class: 'card' }, h('div', { class: 'row', style: { alignItems: 'center' } }, h('div', { style: { flex: 1 } }, filterIn), countBox),
      h('div', { class: 'table-wrap', style: { marginTop: '10px' } }, h('table', null, h('thead', null, h('tr', null, ['', 'الصنف', 'المتاح', 'الوحدة', 'الكمية المحوّلة', ''].map((x) => h('th', null, x)))), tbody))),
    h('button', { class: 'btn ok', onclick: async () => {
      if (from.value === to.value) return toast('المستودع المصدر والوجهة متطابقان', 'bad');
      const lines = [];
      for (const [itemId, p] of picked) {
        const q = num(p.qty);
        if (!(q > 0)) continue;
        const it = allItems.get(itemId);
        const r = rows.find((x) => x.item_id === itemId);
        if (r && q * factorOf(it, p.unit_id) > r.sellable + 1e-9) return toast(`الكمية المطلوبة من ${it.name} أكبر من المتاح (${r.sellable} ${it.base_unit})`, 'bad');
        lines.push({ item_id: itemId, unit_id: p.unit_id, qty: q });
      }
      if (!lines.length) return toast('حدد صنفًا واكتب الكمية', 'bad');
      const d = await run(() => send('POST', '/transfers', { from_warehouse_id: Number(from.value), to_warehouse_id: Number(to.value), in_transit: transit.checked, notes: notes.value || null, lines }), 'تم التحويل');
      if (d) location.hash = '#/doc/' + d.id;
    } }, 'اعتماد التحويل'));
  await loadRows();
}

// ===================== الجرد =====================
export async function counts({ el, isCurrent }) {
  pageHead('الجرد');
  const wh = await warehouseSelect('');
  const cats = await lookup('categories');
  const cat = sel([{ value: '', label: 'كل الأصناف' }, ...cats.map((c) => ({ value: c.id, label: c.name }))], '');
  const date = inp({ type: 'date', value: today() });
  const body = h('div');
  const send = submitter();
  if (can('stock.count')) {
    el.append(h('div', { class: 'card' }, h('h3', null, 'جرد جديد'), h('div', { class: 'row' }, field('المستودع', wh), field('النطاق', cat), field('التاريخ', date),
      h('button', { class: 'btn primary', onclick: async () => {
        const d = await run(() => send('POST', '/counts', { warehouse_id: Number(wh.value), category_id: cat.value || null, date: date.value }), 'أُنشئ الجرد وحُفظ الرصيد المرجعي');
        if (d) location.hash = '#/count/' + d.id;
      } }, 'إنشاء الجرد')),
    h('p', { class: 'small muted' }, 'يُحفظ رصيد مرجعي لكل دفعة وقت الإنشاء. الحركات التي تحدث أثناء العد لا تُسجل فرقًا وهميًا لأن التسوية = المعدود − المرجعي.')));
  }
  el.append(body);
  const r = await get('/docs', { type: 'stock_count', limit: 100 });
  if (!isCurrent()) return;
  body.append(table({ columns: [{ key: 'number', label: 'الرقم', render: (d) => h('a', { href: '#/count/' + d.id }, d.number) }, { key: 'date', label: 'التاريخ' },
    { key: 'status', label: 'الحالة', render: (d) => badge(STATUS, d.status) }, { key: 'created_by_name', label: 'بواسطة' }], rows: r.rows, onRow: (d) => { location.hash = '#/count/' + d.id; } }));
}

export async function count({ el, params }) {
  const d = await get('/docs/' + params[0]);
  pageHead(`الجرد ${d.number} — ${d.warehouse_name}`);
  const inputs = new Map();
  const editable = d.status === 'draft' && can('stock.count');
  const rows = d.lines.map((l) => {
    const i = inp({ type: 'number', value: l.counted_qty ?? '', style: { width: '100px' }, disabled: !editable || null });
    inputs.set(l.id, i);
    return { ...l, input: i };
  });
  const cols = [{ key: 'item_name', label: 'الصنف' }, { key: 'batch_no', label: 'رقم التشغيلة' }, { key: 'expiry_date', label: 'الانتهاء' }, { key: 'unit_name', label: 'الوحدة' },
    { key: 'system_qty', label: 'الرصيد المرجعي', type: 'qty' }, { key: 'c', label: 'المعدود', render: (r) => r.input }];
  if (d.status === 'approved') cols.push({ key: 'base_qty', label: 'الفرق', type: 'qty' }, can('cost.view') ? { key: 'amount', label: 'قيمة التسوية', type: 'money' } : null);
  const save = async () => {
    const counts = [...inputs.entries()].map(([line_id, i]) => ({ line_id, counted_qty: i.value === '' ? null : num(i.value) }));
    return run(() => api('PUT', `/counts/${d.id}`, { counts }), 'حُفظت الكميات');
  };
  el.append(h('div', { class: 'card' }, h('div', { class: 'doc-head' }, h('div', null, h('b', null, 'الحالة'), badge(STATUS, d.status)), h('div', null, h('b', null, 'التاريخ'), d.date),
    h('div', null, h('b', null, 'عدد السطور'), d.lines.length))),
  table({ columns: cols.filter(Boolean), rows }),
  editable ? h('div', { class: 'actions', style: { marginTop: '12px' } },
    h('button', { class: 'btn', onclick: save }, 'حفظ الكميات'),
    can('stock.count.approve') ? h('button', { class: 'btn ok', onclick: async () => {
      if (!(await save())) return;
      const reason = await askReason('اعتماد الجرد', 'ملاحظة/سبب الفروق');
      if (!reason) return;
      if (await run(() => api('POST', `/counts/${d.id}/approve`, { reason }), 'اعتُمد الجرد وسُجلت التسويات')) location.hash = '#/doc/' + d.id;
    } }, 'اعتماد الجرد') : null) : null);
}

// ===================== التالف =====================
export async function damage({ el }) {
  pageHead('تسجيل تالف');
  const wh = await warehouseSelect('');
  const reason = inp({ placeholder: 'سبب التلف (مطلوب)' });
  const body = h('div');
  const lines = new Map();
  const load = async () => {
    const r = await get('/reports/stock', { by: 'batch', warehouse_id: wh.value });
    lines.clear();
    body.replaceChildren(table({ columns: [{ key: 'name', label: 'الصنف' }, { key: 'batch_no', label: 'رقم التشغيلة' }, { key: 'expiry_date', label: 'الانتهاء' }, { key: 'state', label: 'الحالة' },
      { key: 'qty', label: 'الرصيد', type: 'qty' }, { key: 'base_unit', label: 'الوحدة' }, { key: 'x', label: 'كمية التالف', render: (row) => { const i = inp({ type: 'number', style: { width: '90px' } }); lines.set(row.batch_id, i); return i; } }], rows: r.rows }));
  };
  wh.addEventListener('change', load);
  const send = submitter();
  el.append(h('div', { class: 'card' }, h('div', { class: 'row' }, field('المستودع', wh), field('السبب', reason, { req: true }))), body,
    h('button', { class: 'btn ok', style: { marginTop: '12px' }, onclick: async () => {
      const ls = [...lines.entries()].filter(([, i]) => num(i.value) > 0).map(([batch_id, i]) => ({ batch_id, qty: num(i.value) }));
      if (!ls.length) return toast('أدخل كمية', 'bad');
      const d = await run(() => send('POST', '/damages', { warehouse_id: Number(wh.value), reason: reason.value, lines: ls }), can('stock.damage.approve') ? 'اعتُمد التالف' : 'حُفظ للاعتماد');
      if (d) location.hash = '#/doc/' + d.id;
    } }, can('stock.damage.approve') ? 'اعتماد التالف' : 'حفظ للاعتماد'));
  await load();
}

// ===================== بطاقة الصنف =====================
export async function itemCard({ el, q }) {
  pageHead('بطاقة صنف');
  const body = h('div');
  const wh = await warehouseSelect('', {}, { all: true });
  let itemId = q.item ? Number(q.item) : null;
  const label = h('b', null, '');
  const load = async () => {
    if (!itemId) return;
    const r = await get('/reports/item-card', { item_id: itemId, warehouse_id: wh.value });
    label.textContent = r.title;
    body.replaceChildren(h('div', { class: 'note' }, 'رصيد أول المدة: ', Q(r.opening_qty)), table({ columns: r.columns, rows: r.rows }));
  };
  const picker = itemPicker({ onPick: (it) => { itemId = it.id; load(); } });
  el.append(h('div', { class: 'card' }, h('div', { class: 'row' }, h('div', { style: { flex: 2 } }, picker.el), field('المستودع', wh))), h('h3', null, label), body);
  wh.addEventListener('change', load);
  await load();
}

// ===================== المخزون الافتتاحي =====================
export async function openingStock({ el }) {
  pageHead('مخزون افتتاحي');
  const wh = await warehouseSelect('');
  const date = inp({ type: 'date', value: today() });
  const cart = [];
  const tbody = h('tbody');
  const picker = itemPicker({ allowCreate: true, placeholder: 'اضغط هنا لاختيار صنف، أو اكتب الاسم أو الباركود', onPick: (it) => { const bu = it.units.find((u) => u.is_base).id; cart.push({ item: it, unit_id: bu, qty: '', unit_cost: it.quick_cost?.[bu] ?? it.units.find((u) => u.is_base).purchase_price ?? '', batch_no: '', expiry_date: '' }); draw(); } });
  const draw = () => {
    clear(tbody);
    cart.forEach((l, i) => {
      const s = (k) => (e) => { l[k] = e.target.value; };
      tbody.append(h('tr', null, h('td', null, l.item.name), h('td', null, l.item.base_unit),
        h('td', null, inp({ type: 'number', value: l.qty, oninput: s('qty'), style: { width: '90px' } })), h('td', null, inp({ type: 'number', value: l.unit_cost, oninput: s('unit_cost'), style: { width: '90px' } })),
        h('td', null, inp({ value: l.batch_no, oninput: s('batch_no') })), h('td', null, inp({ type: 'date', value: l.expiry_date, oninput: s('expiry_date') })),
        h('td', null, h('button', { class: 'btn small danger', onclick: () => { cart.splice(i, 1); draw(); } }, '×'))));
    });
  };
  const send = submitter();
  el.append(h('div', { class: 'note' }, 'الأرصدة الافتتاحية تُدخل بمستند مؤرخ يمكن تتبعه. يمكن أيضًا الاستيراد من Excel من صفحة الاستيراد.'),
    h('div', { class: 'card' }, h('div', { class: 'row' }, field('المستودع', wh), field('التاريخ', date))),
    h('div', { class: 'card' }, picker.el, h('div', { class: 'table-wrap', style: { marginTop: '10px' } }, h('table', null,
      h('thead', null, h('tr', null, ['الصنف', 'الوحدة', 'الكمية', 'تكلفة الوحدة', 'رقم التشغيلة', 'الانتهاء', ''].map((x) => h('th', null, x)))), tbody))),
    h('button', { class: 'btn ok', onclick: async () => {
      const d = await run(() => send('POST', '/opening-stock', { warehouse_id: Number(wh.value), date: date.value, lines: cart.map((l) => ({ item_id: l.item.id, unit_id: l.unit_id, qty: num(l.qty), unit_cost: num(l.unit_cost), batch_no: l.batch_no || null, expiry_date: l.expiry_date || null })) }), 'تم');
      if (d) location.hash = '#/doc/' + d.id;
    } }, 'اعتماد المخزون الافتتاحي'));
  draw();
  void M;
}
