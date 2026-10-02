// البيانات الأساسية: الأصناف والوحدات والباركود، العملاء والموردون، المستودعات والحسابات، التصنيفات.
import { h, clear, state, get, api, submitter, toast, run, M, inp, sel, field, num, table, pageHead, can, lookup, invalidate, today, download } from '../lib.js';

// ===================== الأصناف =====================
export async function items({ el, q, isCurrent }) {
  pageHead('الأصناف والباركود', can('items.manage') ? h('a', { class: 'btn primary', href: '#/item' }, 'صنف جديد') : null);
  const qIn = inp({ placeholder: 'الاسم أو الكود أو الباركود', value: q.q || '' });
  const active = sel([{ value: '1', label: 'النشطة' }, { value: '0', label: 'الموقوفة' }, { value: '', label: 'الكل' }], '1');
  const body = h('div');
  const load = async () => {
    const r = await get('/items', { q: qIn.value, active: active.value, limit: 500 });
    if (!isCurrent()) return;
    body.replaceChildren(table({ columns: [
      { key: 'code', label: 'الكود' }, { key: 'name', label: 'الاسم' }, { key: 'category_name', label: 'التصنيف' }, { key: 'base_unit', label: 'وحدة المنتج' },
      { key: 'units', label: 'الوحدات والأسعار', render: (it) => it.units.map((u) => h('div', { class: 'small' }, `${u.name}${u.is_base ? '' : ' = ' + u.factor + ' ' + it.base_unit}: `, M(u.sell_price), u.barcode ? h('span', { class: 'muted' }, ' · ' + u.barcode) : '')) },
      { key: 'tax_rate_bp', label: 'ضريبة %', render: (it) => (it.tax_rate_bp == null ? 'الافتراضية' : it.tax_rate_bp) },
      { key: 'active', label: 'الحالة', render: (it) => (it.active ? h('span', { class: 'badge ok' }, 'نشط') : h('span', { class: 'badge bad' }, 'موقوف')) },
      { key: 'a', label: '', render: (it) => [h('a', { class: 'btn small', href: `#/item-card?item=${it.id}` }, 'بطاقة'), ' ', can('items.manage') ? h('a', { class: 'btn small', href: '#/item/' + it.id }, 'تعديل') : null] }],
    rows: r.rows }), h('div', { class: 'muted small', style: { marginTop: '6px' } }, `${r.total} صنف`));
  };
  el.append(h('form', { class: 'row card filters', style: { padding: '12px' }, onsubmit: (e) => { e.preventDefault(); load(); } }, field('بحث', qIn), field('الحالة', active), h('button', { class: 'btn primary' }, 'بحث')), body);
  await load();
}

export async function itemForm({ el, params }) {
  const it = params[0] ? await get('/items/' + params[0]) : null;
  pageHead(it ? `تعديل الصنف ${it.name}` : 'صنف جديد');
  const cats = await lookup('categories');
  const f = {
    code: inp({ value: it?.code || '', placeholder: 'تلقائي إن تُرك فارغًا' }), name: inp({ value: it?.name || '' }),
    category_id: sel([{ value: '', label: '—' }, ...cats.map((c) => ({ value: c.id, label: c.name }))], it?.category_id || ''),
    brand: inp({ value: it?.brand || '' }), description: inp({ value: it?.description || '' }),
    base_unit: inp({ value: it?.base_unit || 'حبة' }),
    qty_decimals: sel([{ value: 0, label: 'عدد صحيح (حبة)' }, { value: 1, label: 'منزلة عشرية' }, { value: 2, label: 'منزلتان' }, { value: 3, label: '3 منازل (وزن)' }], it?.qty_decimals ?? 0),
    track_expiry: h('input', { type: 'checkbox', checked: it ? !!it.track_expiry : true }),
    reorder_level: inp({ type: 'number', value: it?.reorder_level ?? '' }), expiry_alert_days: inp({ type: 'number', value: it?.expiry_alert_days ?? '' }),
    min_price: inp({ type: 'number', value: it?.min_price ?? '', placeholder: 'لوحدة المنتج قبل الضريبة' }), max_discount_pct: inp({ type: 'number', value: it?.max_discount_bp ?? '' }),
    tax_rate_pct: inp({ type: 'number', value: it?.tax_rate_bp ?? '', placeholder: 'فارغ = الإعداد العام' }),
    active: h('input', { type: 'checkbox', checked: it ? !!it.active : true }),
  };
  const units = it ? it.units.map((u) => ({ ...u })) : [{ is_base: 1, name: '', factor: 1, barcode: '', sell_price: '', for_sale: 1, for_purchase: 1, active: 1 }];
  const ubody = h('tbody');
  const drawUnits = () => {
    clear(ubody);
    units.forEach((u, i) => {
      const s = (k, cb) => (e) => { u[k] = cb ? e.target.checked : e.target.value; };
      ubody.append(h('tr', null,
        h('td', null, u.is_base ? h('b', null, f.base_unit.value || 'وحدة المنتج') : inp({ value: u.name, oninput: s('name'), placeholder: 'كرتون' })),
        h('td', null, u.is_base ? '1' : inp({ type: 'number', value: u.factor, oninput: s('factor'), style: { width: '90px' } })),
        h('td', null, inp({ value: u.barcode || '', oninput: s('barcode') })),
        h('td', null, inp({ type: 'number', value: u.sell_price, oninput: s('sell_price'), style: { width: '100px' } })),
        h('td', null, h('input', { type: 'checkbox', checked: !!u.for_sale, onchange: s('for_sale', 1) })),
        h('td', null, h('input', { type: 'checkbox', checked: !!u.for_purchase, onchange: s('for_purchase', 1) })),
        h('td', null, u.is_base ? '' : h('input', { type: 'checkbox', checked: !!u.active, onchange: s('active', 1) })),
        h('td', null, !u.is_base && !u.id ? h('button', { class: 'btn small danger', onclick: () => { units.splice(i, 1); drawUnits(); } }, '×') : '')));
    });
  };
  f.base_unit.addEventListener('input', drawUnits);
  const send = submitter();
  const save = async () => {
    const base = units.find((u) => u.is_base);
    const body = {
      code: f.code.value || null, name: f.name.value, category_id: f.category_id.value ? Number(f.category_id.value) : null, brand: f.brand.value, description: f.description.value,
      base_unit: f.base_unit.value, qty_decimals: Number(f.qty_decimals.value), track_expiry: f.track_expiry.checked ? 1 : 0, reorder_level: f.reorder_level.value,
      expiry_alert_days: f.expiry_alert_days.value, min_price: f.min_price.value, max_discount_pct: f.max_discount_pct.value, tax_rate_pct: f.tax_rate_pct.value, active: f.active.checked ? 1 : 0,
    };
    if (it) {
      body.units = units.map((u) => ({ id: u.id, is_base: u.is_base, name: u.is_base ? f.base_unit.value : u.name, factor: u.factor, barcode: u.barcode || null, sell_price: num(u.sell_price) ?? 0, for_sale: u.for_sale ? 1 : 0, for_purchase: u.for_purchase ? 1 : 0, active: u.active ? 1 : 0 }));
    } else {
      body.barcode = base.barcode || null; body.sell_price = num(base.sell_price) ?? 0;
      body.units = units.filter((u) => !u.is_base).map((u) => ({ name: u.name, factor: num(u.factor), barcode: u.barcode || null, sell_price: num(u.sell_price) ?? 0, for_sale: u.for_sale ? 1 : 0, for_purchase: u.for_purchase ? 1 : 0 }));
    }
    const r = await run(() => (it ? api('PUT', '/items/' + it.id, body) : send('POST', '/items', body)), 'تم الحفظ');
    if (r) location.hash = '#/items?q=' + encodeURIComponent(r.code);
  };
  el.append(
    h('div', { class: 'card' }, h('div', { class: 'grid' },
      field('الاسم', f.name, { req: true }), field('الكود', f.code), field('التصنيف', f.category_id), field('العلامة', f.brand), field('الوصف', f.description),
      field('وحدة المنتج (لحساب المخزون)', f.base_unit, { req: true }), field('دقة الكمية', f.qty_decimals), field('حد إعادة الطلب (بوحدة المنتج)', f.reorder_level),
      field('تنبيه الصلاحية (أيام)', f.expiry_alert_days), field('ضريبة الصنف %', f.tax_rate_pct),
      can('cost.view') ? field('أدنى سعر بيع', f.min_price) : null, field('حد الخصم %', f.max_discount_pct)),
    h('div', { class: 'row', style: { marginTop: '10px' } }, h('label', { class: 'check' }, f.track_expiry, 'إلزام تتبع الدفعات وتاريخ الانتهاء'), h('label', { class: 'check' }, f.active, 'نشط'))),
    h('div', { class: 'card' }, h('h3', null, 'الوحدات والباركود والأسعار'),
      h('div', { class: 'table-wrap' }, h('table', null, h('thead', null, h('tr', null, ['الوحدة', 'المعامل (كم وحدة أساس)', 'الباركود', 'سعر البيع', 'للبيع', 'للشراء', 'نشطة', ''].map((x) => h('th', null, x)))), ubody)),
      h('button', { class: 'btn small', style: { marginTop: '8px' }, onclick: () => { units.push({ name: '', factor: '', barcode: '', sell_price: '', for_sale: 1, for_purchase: 1, active: 1 }); drawUnits(); } }, '+ وحدة'),
      h('p', { class: 'small muted' }, 'مثال: وحدة المنتج "حبة"، والكرتون معامله 12. تغيير الاسم أو السعر أو المعامل لا يغيّر المستندات التاريخية.')),
    h('button', { class: 'btn ok', onclick: save }, 'حفظ'));
  drawUnits();
}

// ===================== الأطراف =====================
export async function parties({ el, q, isCurrent }) {
  const title = q.type === 'supplier' ? 'الموردون' : q.type === 'customer' ? 'العملاء' : 'العملاء والموردون';
  const head = pageHead(title,
    can('parties.manage') && q.type !== 'customer' ? h('button', { class: 'btn primary', onclick: () => partyForm(null, 'supplier') }, '+ مورد جديد') : null,
    can('parties.manage') && q.type !== 'supplier' ? h('button', { class: q.type === 'customer' ? 'btn primary' : 'btn', onclick: () => partyForm(null, 'customer') }, '+ عميل جديد') : null);
  if (head) el.append(head);
  if (q.new && can('parties.manage')) setTimeout(() => partyForm(null, q.new), 50);
  const qIn = inp({ placeholder: 'الاسم أو الهاتف', value: q.q || '' });
  const type = sel([{ value: '', label: 'الكل' }, { value: 'customer', label: 'العملاء' }, { value: 'supplier', label: 'الموردون' }], q.type || '');
  const body = h('div');
  const load = async () => {
    const r = await get('/parties', { q: qIn.value, type: type.value, limit: 500 });
    if (!isCurrent()) return;
    pageHead(type.value === 'supplier' ? 'الموردون' : type.value === 'customer' ? 'العملاء' : 'العملاء والموردون');
    body.replaceChildren(table({ columns: [
      { key: 'name', label: 'الاسم', render: (p) => h('a', { href: '#/party/' + p.id }, p.name) }, { key: 'phone', label: 'الهاتف' },
      { key: 't', label: 'النوع', render: (p) => [p.is_customer ? h('span', { class: 'badge' }, 'عميل') : '', ' ', p.is_supplier ? h('span', { class: 'badge warn' }, 'مورد') : ''] },
      { key: 'rep_name', label: 'المندوب' }, { key: 'credit_limit', label: 'الحد الائتماني', type: 'money' }, { key: 'ar_balance', label: 'عليه (عميل)', type: 'money' },
      { key: 'ap_balance', label: 'له (مورد)', type: 'money' }, { key: 'active', label: '', render: (p) => (p.active ? '' : h('span', { class: 'badge bad' }, 'موقوف')) }],
    rows: r.rows, onRow: (p) => { location.hash = '#/party/' + p.id; } }));
  };
  el.append(h('form', { class: 'row card filters', style: { padding: '12px' }, onsubmit: (e) => { e.preventDefault(); load(); } }, field('بحث', qIn), field('النوع', type), h('button', { class: 'btn primary' }, 'بحث')), body);
  await load();
}

/** نموذج الطرف. kind يحدد النوع الافتراضي للجديد، وonSaved يُستدعى بدل الانتقال لصفحة الطرف */
export async function partyForm(p, kind = 'customer', onSaved) {
  const reps = await lookup('reps');
  const f = {
    name: inp({ value: p?.name || '' }), phone: inp({ value: p?.phone || '' }), address: inp({ value: p?.address || '' }), tax_number: inp({ value: p?.tax_number || '' }),
    is_customer: h('input', { type: 'checkbox', checked: p ? !!p.is_customer : kind === 'customer' }), is_supplier: h('input', { type: 'checkbox', checked: p ? !!p.is_supplier : kind === 'supplier' }), whatsapp_opt_in: h('input', { type: 'checkbox', checked: !!p?.whatsapp_opt_in }),
    credit_limit: inp({ type: 'number', value: p?.credit_limit ?? '', placeholder: 'فارغ = بلا حد' }), payment_terms_days: inp({ type: 'number', value: p?.payment_terms_days ?? 0 }),
    rep_id: sel([{ value: '', label: '—' }, ...reps.map((r) => ({ value: r.id, label: r.name }))], p?.rep_id || ''), notes: inp({ value: p?.notes || '' }),
    active: h('input', { type: 'checkbox', checked: p ? !!p.active : true }),
  };
  const { modal } = await import('../lib.js');
  const m = modal(p ? 'تعديل ' + p.name : kind === 'supplier' ? 'مورد جديد' : 'عميل جديد', h('div', null, h('div', { class: 'grid' },
    field('الاسم', f.name, { req: true }), field('الهاتف', f.phone), field('العنوان', f.address), field('الرقم الضريبي', f.tax_number),
    field('الحد الائتماني', f.credit_limit), field('مدة السداد (يوم)', f.payment_terms_days), field('المندوب المسؤول', f.rep_id), field('ملاحظات', f.notes)),
  h('div', { class: 'row', style: { marginTop: '10px' } }, h('label', { class: 'check' }, f.is_customer, 'عميل'), h('label', { class: 'check' }, f.is_supplier, 'مورد'), h('label', { class: 'check' }, f.active, 'نشط'), h('label', { class: 'check' }, f.whatsapp_opt_in, 'وافق على استلام رسائل واتساب')),
  h('p', { class: 'small muted' }, 'يمكن أن يكون الطرف عميلاً وموردًا معًا؛ يُعرض الحسابان منفصلين دون دمج تلقائي.')),
  [{ label: 'حفظ', class: 'primary', onClick: async () => {
    const body = { name: f.name.value, phone: f.phone.value, address: f.address.value, tax_number: f.tax_number.value, is_customer: f.is_customer.checked ? 1 : 0, is_supplier: f.is_supplier.checked ? 1 : 0, whatsapp_opt_in: f.whatsapp_opt_in.checked ? 1 : 0,
      credit_limit: f.credit_limit.value, payment_terms_days: num(f.payment_terms_days.value) || 0, rep_id: f.rep_id.value ? Number(f.rep_id.value) : null, notes: f.notes.value, active: f.active.checked ? 1 : 0 };
    const r = await run(() => (p ? api('PUT', '/parties/' + p.id, body) : api('POST', '/parties', body)), 'تم الحفظ');
    if (!r) return false;
    invalidate('customers', 'suppliers');
    if (onSaved) onSaved(r); else location.hash = '#/party/' + r.id + '?t=' + Date.now();
    return true;
  } }]);
  return m.done;
}

export async function party({ el, params, q }) {
  const p = await get('/parties/' + params[0]);
  pageHead(p.name, can('parties.manage') ? h('button', { class: 'btn', onclick: () => partyForm(p) }, 'تعديل') : null,
    p.is_customer && can('cash.receipt') ? h('a', { class: 'btn primary', href: `#/receipt?party=${p.id}` }, 'سند قبض') : null,
    p.is_supplier && can('cash.payment') ? h('a', { class: 'btn', href: `#/payment?party=${p.id}` }, 'سند صرف') : null,
    p.is_customer && can('sales.create') ? h('a', { class: 'btn', href: `#/pos?party=${p.id}` }, 'بيع') : null);
  const account = sel([...(p.is_customer ? [{ value: 'AR', label: 'حساب العميل' }] : []), ...(p.is_supplier ? [{ value: 'AP', label: 'حساب المورد' }] : [])], q.account || (p.is_customer ? 'AR' : 'AP'));
  const from = inp({ type: 'date', value: '' });
  const to = inp({ type: 'date', value: today() });
  const body = h('div');
  const load = async () => {
    const r = await get('/reports/statement', { party_id: p.id, account: account.value, from: from.value, to: to.value });
    body.replaceChildren(
      h('div', { class: 'note' + (r.matches ? '' : ' bad') }, 'رصيد أول المدة: ', M(r.opening), ' — رصيد آخر المدة: ', M(r.closing), r.matches ? ' — مطابق لإجمالي الحساب' : ' — غير مطابق!'),
      table({ columns: r.columns, rows: r.rows }),
      h('h3', null, 'المستندات المفتوحة'),
      table({ columns: [{ key: 'number', label: 'المستند', render: (d) => h('a', { href: '#/doc/' + d.id }, d.number) }, { key: 'label', label: 'النوع' }, { key: 'date', label: 'التاريخ' },
        { key: 'due_date', label: 'الاستحقاق' }, { key: 'total', label: 'الإجمالي', type: 'money' }, { key: 'open_amount', label: 'المتبقي/غير المخصص', type: 'money' }], rows: r.open_docs, empty: 'لا توجد مستندات مفتوحة' }),
      can('reports.export') ? h('button', { class: 'btn', style: { marginTop: '10px' }, onclick: () => download(`/reports/statement/export?format=xlsx&party_id=${p.id}&account=${account.value}&from=${from.value}&to=${to.value}`, `statement-${p.id}.xlsx`) }, 'تصدير Excel') : null);
  };
  el.append(h('div', { class: 'card' }, h('div', { class: 'doc-head' },
    h('div', null, h('b', null, 'الهاتف'), p.phone || '—'), h('div', null, h('b', null, 'العنوان'), p.address || '—'), h('div', null, h('b', null, 'الحد الائتماني'), p.credit_limit == null ? 'بلا حد' : M(p.credit_limit)),
    h('div', null, h('b', null, 'مدة السداد'), `${p.payment_terms_days} يوم`), h('div', null, h('b', null, 'المندوب'), p.rep_name || '—'),
    p.is_customer ? h('div', null, h('b', null, 'رصيد العميل (عليه)'), M(p.ar_balance)) : null, p.is_supplier ? h('div', null, h('b', null, 'رصيد المورد (له)'), M(p.ap_balance)) : null)),
  h('form', { class: 'row card filters', style: { padding: '12px' }, onsubmit: (e) => { e.preventDefault(); load(); } }, field('الحساب', account), field('من', from), field('إلى', to), h('button', { class: 'btn primary' }, 'كشف الحساب')), body);
  await load();
}

// ===================== المستودعات والحسابات =====================
export async function warehouses({ el }) {
  pageHead('الفروع والمستودعات والصناديق');
  const branches = await lookup('branches', true);
  const whs = await lookup('warehouses', true);
  const cash = await lookup('cash', true);
  const multi = branches.length > 1;
  const brSel = () => sel(branches.filter((b) => b.active).map((b) => ({ value: b.id, label: b.name })), state.branch?.id || branches[0]?.id);
  const reload = (...c) => { invalidate(...c); location.reload(); };
  const whName = inp({ placeholder: 'اسم المستودع' });
  const whBranch = brSel();
  const caName = inp({ placeholder: 'اسم الحساب' });
  const caBranch = brSel();
  const caKind = sel([{ value: 'cash', label: 'صندوق نقدي' }, { value: 'bank', label: 'بنك / شبكة' }], 'cash');
  const toggle = (url, row) => h('button', { class: 'btn small', onclick: async () => { if (await run(() => api('PUT', url, { name: row.name, branch_id: row.branch_id, active: row.active ? 0 : 1 }), 'تم')) reload('warehouses', 'cash', 'branches'); } }, row.active ? 'إيقاف' : 'تفعيل');
  const editWarehouse = async (w) => {
    const { modal } = await import('../lib.js');
    const n = inp({ value: w.name }), br = brSel();
    br.value = String(w.branch_id);
    modal('تعديل المستودع', h('div', { class: 'grid' }, field('الاسم', n, { req: true }), multi ? field('الفرع', br) : null),
      [{ label: 'حفظ', class: 'primary', onClick: async () => {
        const r = await run(() => api('PUT', '/warehouses/' + w.id, { name: n.value, branch_id: Number(br.value), active: w.active }), 'تم الحفظ');
        if (r) reload('warehouses');
        return !!r;
      } }]);
  };
  const deleteWarehouse = async (w) => {
    const { confirmBox } = await import('../lib.js');
    if (!(await confirmBox('حذف المستودع', `حذف "${w.name}" نهائيًا؟ يُسمح بالحذف فقط إذا كان المستودع فارغًا ولم تُسجَّل عليه أي حركة.`))) return;
    if (await run(() => api('DELETE', '/warehouses/' + w.id), 'تم الحذف')) reload('warehouses');
  };
  const editCash = async (c) => {
    const { modal } = await import('../lib.js');
    const n = inp({ value: c.name });
    modal('تعديل الحساب', h('div', { class: 'grid' }, field('الاسم', n, { req: true })), [{ label: 'حفظ', class: 'primary', onClick: async () => {
      const r = await run(() => api('PUT', '/cash-accounts/' + c.id, { name: n.value, active: c.active }), 'تم الحفظ');
      if (r) reload('cash');
      return !!r;
    } }]);
  };
  const deleteCash = async (c) => {
    const { confirmBox } = await import('../lib.js');
    if (!(await confirmBox('حذف الحساب', `حذف "${c.name}" نهائيًا؟ يُسمح بالحذف فقط إذا لم تُسجَّل عليه أي حركة.`))) return;
    if (await run(() => api('DELETE', '/cash-accounts/' + c.id), 'تم الحذف')) reload('cash');
  };
  const editBranch = async (b) => {
    const { modal } = await import('../lib.js');
    const n = inp({ value: b?.name || '' }), a = inp({ value: b?.address || '' }), p = inp({ value: b?.phone || '' });
    modal(b ? 'تعديل الفرع' : 'فرع جديد', h('div', null, h('div', { class: 'grid' }, field('الاسم', n, { req: true }), field('العنوان', a), field('الهاتف', p)),
      b ? null : h('p', { class: 'small muted' }, 'يُنشأ للفرع مستودع وصندوق تلقائيًا. العنوان والهاتف يظهران في فواتير الفرع.')),
    [{ label: 'حفظ', class: 'primary', onClick: async () => {
      const body = { name: n.value, address: a.value, phone: p.value };
      const r = await run(() => (b ? api('PUT', '/branches/' + b.id, body) : api('POST', '/branches', body)), 'تم الحفظ');
      if (r) reload('warehouses', 'cash', 'branches');
      return !!r;
    } }]);
  };
  el.append(
    can('warehouses.manage') && !state.branch ? h('div', { class: 'card' }, h('h3', null, 'الفروع'), table({ columns: [{ key: 'name', label: 'الفرع' }, { key: 'address', label: 'العنوان' }, { key: 'phone', label: 'الهاتف' },
      { key: 'warehouses', label: 'المستودعات', type: 'int' }, { key: 'users', label: 'المستخدمون المقيدون', type: 'int' }, { key: 'active', label: 'الحالة', render: (b) => (b.active ? 'نشط' : 'موقوف') },
      { key: 'a', label: '', render: (b) => [h('button', { class: 'btn small', onclick: () => editBranch(b) }, 'تعديل'), ' ', toggle('/branches/' + b.id, b)] }], rows: branches }),
    h('button', { class: 'btn primary', style: { marginTop: '10px' }, onclick: () => editBranch() }, 'فرع جديد'),
    h('p', { class: 'small muted' }, 'المستخدم المرتبط بفرع (من صفحة المستخدمين) لا يرى ولا يستخدم إلا مستودعات فرعه وصناديقه ومستنداته. المدير والمستخدم غير المرتبط يرون كل الفروع ويمكنهم تصفية التقارير حسب الفرع.')) : null,
    h('div', { class: 'card' }, h('h3', null, 'المستودعات'), table({ columns: [{ key: 'name', label: 'الاسم' }, { key: 'branch_name', label: 'الفرع' }, { key: 'kind', label: 'النوع', render: (w) => (w.kind === 'rep' ? 'مخزون مندوب' : 'مستودع') },
      { key: 'active', label: 'الحالة', render: (w) => (w.active ? 'نشط' : 'موقوف') }, { key: 'a', label: '', render: (w) => (w.kind === 'main' && can('warehouses.manage') ? [h('button', { class: 'btn small', onclick: () => editWarehouse(w) }, 'تعديل'), ' ', toggle('/warehouses/' + w.id, w), ' ', h('button', { class: 'btn small danger', onclick: () => deleteWarehouse(w) }, 'حذف')] : '') }], rows: whs }),
    h('div', { class: 'row', style: { marginTop: '10px' } }, field('مستودع جديد', whName), multi ? field('الفرع', whBranch) : null,
      h('button', { class: 'btn primary', onclick: async () => { if (await run(() => api('POST', '/warehouses', { name: whName.value, branch_id: Number(whBranch.value) }), 'أُضيف')) reload('warehouses'); } }, 'إضافة'))),
    h('div', { class: 'card' }, h('h3', null, 'الصناديق والبنوك وعهد المناديب'), table({ columns: [{ key: 'name', label: 'الاسم' }, { key: 'kind', label: 'النوع', render: (c) => ({ cash: 'صندوق', bank: 'بنك', rep_custody: 'عهدة مندوب' }[c.kind]) },
      multi ? { key: 'branch_id', label: 'الفرع', render: (c) => (branches.find((b) => b.id === c.branch_id) || {}).name || '' } : null,
      { key: 'balance', label: 'الرصيد', type: 'money' }, { key: 'active', label: 'الحالة', render: (c) => (c.active ? 'نشط' : 'موقوف') }, { key: 'a', label: '', render: (c) => (c.kind !== 'rep_custody' ? [h('button', { class: 'btn small', onclick: () => editCash(c) }, 'تعديل'), ' ', toggle('/cash-accounts/' + c.id, c), ' ', h('button', { class: 'btn small danger', onclick: () => deleteCash(c) }, 'حذف')] : '') }].filter(Boolean), rows: cash }),
    h('div', { class: 'row', style: { marginTop: '10px' } }, field('حساب جديد', caName), field('النوع', caKind), multi ? field('الفرع', caBranch) : null,
      h('button', { class: 'btn primary', onclick: async () => { if (await run(() => api('POST', '/cash-accounts', { name: caName.value, kind: caKind.value, branch_id: Number(caBranch.value) }), 'أُضيف')) reload('cash'); } }, 'إضافة'))));
}

export async function categories({ el }) {
  pageHead('التصنيفات');
  const block = async (title, route, cacheName) => {
    const list = await lookup(cacheName, true);
    const name = inp();
    return h('div', { class: 'card' }, h('h3', null, title), table({ columns: [{ key: 'name', label: 'الاسم' }, { key: 'active', label: 'الحالة', render: (c) => (c.active ? 'نشط' : 'موقوف') },
      { key: 'a', label: '', render: (c) => h('button', { class: 'btn small', onclick: async () => { if (await run(() => api('PUT', `/${route}/${c.id}`, { name: c.name, active: c.active ? 0 : 1 }), 'تم')) { invalidate(cacheName); location.reload(); } } }, c.active ? 'إيقاف' : 'تفعيل') }], rows: list }),
    h('div', { class: 'row', style: { marginTop: '10px' } }, field('جديد', name), h('button', { class: 'btn primary', onclick: async () => { if (await run(() => api('POST', '/' + route, { name: name.value }), 'أُضيف')) { invalidate(cacheName); location.reload(); } } }, 'إضافة')));
  };
  el.append(h('div', { class: 'grid wide' }, await block('تصنيفات الأصناف', 'categories', 'categories'), can('expenses.approve') ? await block('تصنيفات المصروفات', 'expense-categories', 'expcats') : ''));
  void toast; void submitter;
}
