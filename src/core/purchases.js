'use strict';
// المشتريات ومرتجعاتها. في النسخة الأولى اعتماد الفاتورة والاستلام عملية واحدة بعد التأكد من الاستلام الفعلي.
const { fail } = require('../lib/errors');
const { toMinor, fromMinor, fromQty, mulDiv, distribute } = require('../lib/money');
const { checkDate, addDays } = require('../lib/dates');
const ledger = require('./ledger');
const inv = require('./inventory');
const D = require('./docs');
const P = require('./payments');

function buildPurchase(ctx, input) {
  const date = checkDate(input.date || ctx.today());
  const party = ctx.db.prepare('SELECT * FROM parties WHERE id=?').get(input.party_id);
  if (!party || !party.is_supplier) fail('VALIDATION', 'حدد المورد');
  if (!party.active) fail('INACTIVE', `المورد ${party.name} موقوف`);
  const warehouseId = Number(input.warehouse_id || ctx.db.prepare("SELECT id FROM warehouses WHERE kind='main' AND active=1 ORDER BY id LIMIT 1").get().id);
  const wh = ctx.db.prepare('SELECT * FROM warehouses WHERE id=?').get(warehouseId);
  if (!wh || !wh.active) fail('VALIDATION', 'المستودع غير صحيح');
  if (!Array.isArray(input.lines) || !input.lines.length) fail('VALIDATION', 'أضف بندًا واحدًا على الأقل');
  const prepared = input.lines.map((l, i) => {
    const item = D.getItem(ctx, l.item_id);
    if (!item.active) fail('INACTIVE', `الصنف ${item.name} موقوف`);
    const unit = D.getUnit(ctx, item, l.unit_id);
    if (!unit.for_purchase) fail('INVALID_UNIT', `الوحدة ${unit.name} غير متاحة للشراء`);
    const { qty, base } = D.toBaseQty(item, unit, l.qty, `البند ${i + 1}`);
    const price = toMinor(l.price ?? 0, `سعر البند ${i + 1}`);
    if (price < 0) fail('VALIDATION', 'السعر لا يكون سالبًا');
    const expiry = l.expiry_date ? checkDate(l.expiry_date, `تاريخ انتهاء البند ${i + 1}`) : null;
    const prod = l.prod_date ? checkDate(l.prod_date, `تاريخ إنتاج البند ${i + 1}`) : null;
    if (prod && expiry && prod > expiry) fail('VALIDATION', `تاريخ الإنتاج بعد تاريخ الانتهاء في البند ${i + 1}`);
    return {
      item, unit, qty, base, price, tax_rate_bp: D.itemTaxBp(ctx, item, l.tax_rate_pct), ...D.parseLineMoney(l, i),
      batch_no: l.batch_no ? String(l.batch_no).trim() : null, prod_date: prod, expiry_date: expiry, po_line_id: l.po_line_id ? Number(l.po_line_id) : null,
    };
  });
  const { toBp } = require('../lib/money');
  const opts = {
    invoiceDiscountBp: input.invoice_discount_pct != null && input.invoice_discount_pct !== '' ? toBp(input.invoice_discount_pct) : null,
    invoiceDiscountAmount: input.invoice_discount_amount != null && input.invoice_discount_amount !== '' ? toMinor(input.invoice_discount_amount) : null,
    pricesIncludeTax: !!Number(input.prices_include_tax || 0),
  };
  const { lines, totals } = D.priceLines(prepared, opts);
  const extras = (input.extra_costs || []).filter((e) => e && e.amount != null && e.amount !== '' && Number(e.amount) !== 0).map((e, i) => {
    const amount = toMinor(e.amount, `التكلفة الإضافية ${i + 1}`);
    if (amount < 0) fail('VALIDATION', 'التكلفة الإضافية لا تكون سالبة');
    return { description: e.description || 'تكلفة إضافية', amount, cash_account_id: e.cash_account_id || null };
  });
  const extraTotal = extras.reduce((s, e) => s + e.amount, 0);
  const basis = input.extra_cost_basis || ctx.setting('extra_cost_basis') || 'value';
  const shares = distribute(extraTotal, lines.map((l) => (basis === 'qty' ? l.base : l.net)));
  const recoverable = ctx.setting('tax_recoverable') !== '0';
  lines.forEach((l, i) => {
    l.extra_cost = shares[i];
    l.cost = l.net + l.extra_cost + (recoverable ? 0 : l.tax);
  });
  const extrasToSupplier = extras.filter((e) => !e.cash_account_id).reduce((s, e) => s + e.amount, 0);
  return {
    date, party, warehouseId, lines, totals, extras, extraTotal, basis, recoverable, opts,
    total: totals.total + extrasToSupplier,
  };
}

/** التحقق من ربط فاتورة الشراء بطلب الشراء */
function checkPoLink(ctx, input, b) {
  if (!input.po_id) {
    if (b.lines.some((l) => l.po_line_id)) fail('VALIDATION', 'بنود طلب الشراء تحتاج تحديد الطلب');
    return null;
  }
  const po = D.loadDoc(ctx, input.po_id, 'purchase_order');
  if (po.status !== 'approved') fail('INVALID_STATE', 'طلب الشراء غير معتمد');
  if (D.docData(po).po_state === 'closed') fail('INVALID_STATE', 'طلب الشراء مغلق');
  if (po.party_id !== b.party.id) fail('VALIDATION', 'المورد يختلف عن مورد طلب الشراء');
  const poLines = D.docLines(ctx, po.id);
  for (const l of b.lines) {
    if (!l.po_line_id) continue;
    const pl = poLines.find((x) => x.id === l.po_line_id);
    if (!pl || pl.item_id !== l.item.id) fail('VALIDATION', `البند ${l.item.name} لا يطابق بنود طلب الشراء`);
  }
  return po;
}

function storePurchase(ctx, input, existing) {
  const b = buildPurchase(ctx, input);
  const po = checkPoLink(ctx, input, b);
  const fields = {
    date: b.date, party_id: b.party.id, warehouse_id: b.warehouseId, supplier_invoice_no: input.supplier_invoice_no ? String(input.supplier_invoice_no).trim() : null,
    ledger_account: 'AP', ledger_side: 'C', subtotal: b.totals.subtotal, discount: b.totals.discount, net: b.totals.net, tax: b.totals.tax,
    extra_cost: b.extraTotal, total: b.total, cost: b.lines.reduce((s, l) => s + l.cost, 0), prices_include_tax: b.opts.pricesIncludeTax ? 1 : 0,
    invoice_discount_bp: b.opts.invoiceDiscountBp, invoice_discount_amount: b.opts.invoiceDiscountAmount, notes: input.notes || null,
    due_date: input.due_date ? checkDate(input.due_date, 'تاريخ الاستحقاق') : addDays(b.date, b.party.payment_terms_days || 0),
    data: { extras: b.extras, extra_cost_basis: b.basis, tax_recoverable: b.recoverable, payment: input.payment || null },
    ref_doc_id: po ? po.id : null,
  };
  let doc;
  if (existing) {
    D.updateDoc(ctx, existing.id, fields);
    ctx.db.prepare('DELETE FROM doc_lines WHERE doc_id=?').run(existing.id);
    doc = D.getDocRow(ctx, existing.id);
  } else doc = D.insertDoc(ctx, 'purchase', fields);
  b.lines.forEach((l, i) => {
    D.insertLine(ctx, doc.id, {
      line_no: i + 1, item_id: l.item.id, item_name: l.item.name, unit_id: l.unit.id, unit_name: l.unit.name, factor: l.unit.factor,
      qty: l.qty, base_qty: l.base, price: l.price, value: l.value, line_discount: l.line_discount, doc_discount: l.doc_discount, net: l.net,
      tax_rate_bp: l.tax_rate_bp, tax: l.tax, total: l.total, extra_cost: l.extra_cost, cost: l.cost, batch_no: l.batch_no,
      prod_date: l.prod_date, expiry_date: l.expiry_date, ref_line_id: l.po_line_id || null,
    });
  });
  return D.getDocRow(ctx, doc.id);
}

// ===================== طلبات الشراء والاستلام الجزئي =====================
function poState(ctx, poId) {
  const lines = D.docLines(ctx, poId);
  if (lines.every((l) => l.received_qty >= l.base_qty)) return 'received';
  if (lines.some((l) => l.received_qty > 0)) return 'partial';
  return 'open';
}

function setPoState(ctx, po, state) {
  const data = D.docData(po);
  if (data.po_state === 'closed' && state !== 'closed') return;
  data.po_state = state;
  D.updateDoc(ctx, po.id, { data });
}

/** تحديث الكميات المستلمة على طلب الشراء عند اعتماد أو إلغاء فاتورة الشراء المرتبطة */
function applyPoReceipt(ctx, purchase, sign) {
  if (!purchase.ref_doc_id) return;
  const po = D.getDocRow(ctx, purchase.ref_doc_id);
  if (!po || po.type !== 'purchase_order') return;
  for (const l of D.docLines(ctx, purchase.id)) {
    if (!l.ref_line_id) continue;
    const pl = ctx.db.prepare('SELECT * FROM doc_lines WHERE id=?').get(l.ref_line_id);
    if (sign > 0 && pl.received_qty + l.base_qty > pl.base_qty) {
      fail('OVER_RECEIPT', `الكمية المستلمة من ${pl.item_name} تتجاوز المتبقي في طلب الشراء (${fromQty(mulDiv(pl.base_qty - pl.received_qty, 1000, pl.factor))} ${pl.unit_name})`, 409);
    }
    ctx.db.prepare('UPDATE doc_lines SET received_qty=received_qty+? WHERE id=?').run(sign * l.base_qty, pl.id);
  }
  setPoState(ctx, po, poState(ctx, po.id));
}

function storePo(ctx, input, existing) {
  const b = buildPurchase(ctx, { ...input, extra_costs: [] });
  const fields = {
    date: b.date, party_id: b.party.id, warehouse_id: b.warehouseId, subtotal: b.totals.subtotal, discount: b.totals.discount, net: b.totals.net,
    tax: b.totals.tax, total: b.totals.total, prices_include_tax: b.opts.pricesIncludeTax ? 1 : 0, invoice_discount_bp: b.opts.invoiceDiscountBp,
    invoice_discount_amount: b.opts.invoiceDiscountAmount, notes: input.notes || null,
    due_date: input.expected_date ? checkDate(input.expected_date, 'تاريخ التوريد المتوقع') : null, data: { po_state: 'draft' },
  };
  let doc;
  if (existing) {
    D.updateDoc(ctx, existing.id, fields);
    ctx.db.prepare('DELETE FROM doc_lines WHERE doc_id=?').run(existing.id);
    doc = D.getDocRow(ctx, existing.id);
  } else doc = D.insertDoc(ctx, 'purchase_order', fields);
  b.lines.forEach((l, i) => D.insertLine(ctx, doc.id, {
    line_no: i + 1, item_id: l.item.id, item_name: l.item.name, unit_id: l.unit.id, unit_name: l.unit.name, factor: l.unit.factor,
    qty: l.qty, base_qty: l.base, price: l.price, value: l.value, line_discount: l.line_discount, doc_discount: l.doc_discount, net: l.net,
    tax_rate_bp: l.tax_rate_bp, tax: l.tax, total: l.total,
  }));
  return D.getDocRow(ctx, doc.id);
}

/** طلب الشراء لا يؤثر في المخزون أو الحسابات؛ الاستلام الفعلي يتم بفواتير شراء مرتبطة به (جزئية أو كاملة) */
function createPurchaseOrder(ctx, input) {
  ctx.require('purchases.create');
  return ctx.tx(() => {
    const doc = storePo(ctx, input);
    ctx.audit('purchase_order.draft', { entity: 'doc', entity_id: doc.id, doc_number: doc.number });
    if (input.approve) approvePoInTx(ctx, doc);
    return D.fullDoc(ctx, doc.id);
  });
}

function updatePurchaseOrder(ctx, id, input) {
  ctx.require('purchases.create');
  return ctx.tx(() => {
    const ex = D.loadDoc(ctx, id, 'purchase_order');
    if (ex.status !== 'draft') fail('INVALID_STATE', 'لا يُعدل طلب الشراء بعد اعتماده');
    const doc = storePo(ctx, input, ex);
    if (input.approve) approvePoInTx(ctx, doc);
    return D.fullDoc(ctx, id);
  });
}

function approvePoInTx(ctx, doc) {
  ctx.require('purchases.approve');
  if (doc.status !== 'draft') fail('INVALID_STATE', 'طلب الشراء ليس مسودة');
  D.markApproved(ctx, doc);
  setPoState(ctx, D.getDocRow(ctx, doc.id), 'open');
  ctx.audit('purchase_order.approve', { entity: 'doc', entity_id: doc.id, doc_number: doc.number });
}

function approvePurchaseOrder(ctx, id) {
  return ctx.tx(() => { approvePoInTx(ctx, D.loadDoc(ctx, id, 'purchase_order')); return D.fullDoc(ctx, id); });
}

/** إغلاق طلب الشراء بما تبقى منه (لن يُورد) */
function closePurchaseOrder(ctx, id, reason) {
  ctx.require('purchases.approve');
  return ctx.tx(() => {
    const po = D.loadDoc(ctx, id, 'purchase_order');
    if (po.status !== 'approved') fail('INVALID_STATE', 'طلب الشراء غير معتمد');
    const r = ctx.requireReason(reason, 'إغلاق طلب الشراء');
    const data = D.docData(po);
    data.po_state = 'closed';
    data.closed_reason = r;
    D.updateDoc(ctx, id, { data });
    ctx.audit('purchase_order.close', { entity: 'doc', entity_id: id, doc_number: po.number, reason: r });
    return D.fullDoc(ctx, id);
  });
}

/** البنود المتبقية للاستلام من طلب شراء (لتعبئة فاتورة الاستلام) */
function poRemaining(ctx, id) {
  ctx.require('purchases.view');
  const po = D.loadDoc(ctx, id, 'purchase_order');
  return {
    po: D.present(po),
    lines: D.docLines(ctx, id).map((l) => ({
      po_line_id: l.id, item_id: l.item_id, item_name: l.item_name, unit_id: l.unit_id, unit_name: l.unit_name, price: fromMinor(l.price),
      tax_rate_pct: l.tax_rate_bp / 100, ordered: fromQty(l.qty), received: fromQty(mulDiv(l.received_qty, 1000, l.factor)),
      remaining: fromQty(mulDiv(Math.max(0, l.base_qty - l.received_qty), 1000, l.factor)),
    })),
  };
}

function createPurchase(ctx, input) {
  ctx.require('purchases.create');
  return ctx.tx(() => {
    const doc = storePurchase(ctx, input);
    ctx.audit('purchase.draft', { entity: 'doc', entity_id: doc.id, doc_number: doc.number });
    if (input.approve) approveInTx(ctx, doc, input);
    return D.fullDoc(ctx, doc.id);
  });
}

function updatePurchase(ctx, id, input) {
  ctx.require('purchases.create');
  return ctx.tx(() => {
    const ex = D.loadDoc(ctx, id, 'purchase');
    if (ex.status !== 'draft') fail('INVALID_STATE', 'لا يمكن تعديل فاتورة معتمدة؛ استخدم المرتجع أو مستند تصحيح');
    const doc = storePurchase(ctx, input, ex);
    ctx.audit('purchase.draft_update', { entity: 'doc', entity_id: doc.id, doc_number: doc.number });
    if (input.approve) approveInTx(ctx, doc, input);
    return D.fullDoc(ctx, doc.id);
  });
}

function approvePurchase(ctx, id, input = {}) {
  return ctx.tx(() => {
    const doc = D.loadDoc(ctx, id, 'purchase');
    approveInTx(ctx, doc, input);
    return D.fullDoc(ctx, id);
  });
}

function approveInTx(ctx, doc, input = {}) {
  ctx.require('purchases.approve');
  if (doc.status !== 'draft') fail('INVALID_STATE', 'الفاتورة ليست مسودة');
  ctx.checkPeriod(doc.date);
  const data = D.docData(doc);
  // رقم فاتورة المورد المكرر يُرفض أو يحال للمراجعة بصلاحية موثقة
  if (doc.supplier_invoice_no) {
    const dup = ctx.db.prepare(`SELECT number FROM docs WHERE type='purchase' AND party_id=? AND supplier_invoice_no=? AND status='approved' AND id<>?`)
      .get(doc.party_id, doc.supplier_invoice_no, doc.id);
    if (dup) {
      if (!input.duplicate_reason) fail('DUPLICATE_SUPPLIER_INVOICE', `رقم فاتورة المورد ${doc.supplier_invoice_no} مسجل مسبقًا في ${dup.number}`, 409);
      ctx.require('purchases.duplicate.override', 'purchase.duplicate_override');
      data.duplicate_reason = ctx.requireReason(input.duplicate_reason, 'قبول رقم مكرر');
    }
  }
  const lines = D.docLines(ctx, doc.id);
  let invTotal = 0;
  for (const l of lines) {
    const item = D.getItem(ctx, l.item_id);
    if (item.track_expiry && !l.expiry_date) fail('EXPIRY_REQUIRED', `تاريخ الانتهاء مطلوب للصنف ${item.name}`);
    const batch = inv.receiveNewBatch(ctx, {
      doc, lineId: l.id, itemId: l.item_id, warehouseId: doc.warehouse_id, qty: l.base_qty, cost: l.cost,
      batchNo: l.batch_no || doc.number, prodDate: l.prod_date, expiryDate: l.expiry_date,
    });
    ctx.db.prepare('UPDATE doc_lines SET batch_id=? WHERE id=?').run(batch.id, l.id);
    invTotal += l.cost;
  }
  const recoverable = data.tax_recoverable !== false;
  const extrasCash = (data.extras || []).filter((e) => e.cash_account_id);
  D.updateDoc(ctx, doc.id, { data });
  D.markApproved(ctx, doc);
  doc = D.getDocRow(ctx, doc.id);
  const jl = [
    { account: 'INVENTORY', warehouse_id: doc.warehouse_id, debit: invTotal },
    { account: 'TAX_IN', debit: recoverable ? doc.tax : 0 },
    { account: 'AP', party_id: doc.party_id, credit: doc.total },
  ];
  for (const e of extrasCash) {
    const acc = P.getCashAccount(ctx, e.cash_account_id);
    if (acc.kind !== 'bank' && P.cashBalance(ctx, acc.id) < e.amount) fail('INSUFFICIENT_CASH', `رصيد ${acc.name} لا يكفي لدفع ${e.description}`, 409);
    jl.push({ account: 'CASH', cash_account_id: acc.id, credit: e.amount });
  }
  ledger.post(ctx, doc, jl, 'فاتورة شراء واستلام');
  const pay = input.payment || data.payment;
  if (pay && pay.amount != null && Number(pay.amount) > 0) {
    P.cashDocInTx(ctx, 'payment', {
      account: 'AP', date: doc.date, party_id: doc.party_id, amount: pay.amount, cash_account_id: pay.cash_account_id, method: pay.method,
      ref_doc_id: doc.id, allocations: [{ doc_id: doc.id, amount: pay.amount }], notes: `سداد ${doc.number}`,
    });
  }
  applyPoReceipt(ctx, doc, 1);
  ctx.audit('purchase.approve', { entity: 'doc', entity_id: doc.id, doc_number: doc.number, reason: data.duplicate_reason || null, after: { total: fromMinor(doc.total), inventory: fromMinor(invTotal) } });
  return doc;
}

/** إلغاء فاتورة شراء معتمدة: فقط إذا لم تُستخدم دفعاتها ولم ترتبط بسداد أو مرتجع */
function reversePurchase(ctx, id, reason) {
  ctx.require('purchases.reverse');
  return ctx.tx(() => {
    const doc = D.loadDoc(ctx, id, 'purchase');
    if (doc.status !== 'approved') fail('INVALID_STATE', 'الفاتورة غير معتمدة');
    const r = ctx.requireReason(reason, 'إلغاء فاتورة الشراء');
    ctx.checkPeriod(doc.date);
    ctx.checkPeriod(ctx.today());
    if (ctx.db.prepare('SELECT 1 FROM allocations WHERE target_doc_id=? AND reversed=0').get(id)) {
      fail('HAS_DEPENDENTS', 'الفاتورة مرتبطة بسداد أو مرتجع؛ ألغِ السداد أولاً أو استخدم المرتجع', 409);
    }
    inv.reverseMoves(ctx, doc);
    applyPoReceipt(ctx, doc, -1);
    D.markReversed(ctx, doc, r);
    ledger.reverseEntries(ctx, doc, ctx.today(), 'إلغاء ' + doc.number);
    ctx.audit('purchase.reverse', { entity: 'doc', entity_id: doc.id, doc_number: doc.number, reason: r });
    return D.fullDoc(ctx, id);
  });
}

// ===================== مرتجع المشتريات =====================

function createPurchaseReturn(ctx, input) {
  ctx.require('purchase_returns.create');
  return ctx.tx(() => {
    const pur = D.loadDoc(ctx, input.purchase_id, 'purchase');
    if (pur.status !== 'approved') fail('INVALID_STATE', 'المرتجع يكون من فاتورة معتمدة');
    const reason = ctx.requireReason(input.reason, 'مرتجع المشتريات');
    const date = checkDate(input.date || ctx.today());
    ctx.checkPeriod(date);
    if (!Array.isArray(input.lines) || !input.lines.length) fail('VALIDATION', 'اختر بنود المرتجع');
    const orig = D.docLines(ctx, pur.id);
    const doc = D.insertDoc(ctx, 'purchase_return', {
      date, party_id: pur.party_id, warehouse_id: pur.warehouse_id, ref_doc_id: pur.id, ledger_account: 'AP', ledger_side: 'D', reason,
      notes: input.notes || null,
    });
    const recoverable = D.docData(pur).tax_recoverable !== false;
    const totals = { value: 0, discount: 0, net: 0, tax: 0, cost: 0 };
    const perLine = new Map();
    input.lines.forEach((l, i) => {
      const o = orig.find((x) => x.id === Number(l.line_id));
      if (!o) fail('VALIDATION', `البند ${i + 1} لا يتبع الفاتورة الأصلية`);
      const item = D.getItem(ctx, o.item_id);
      const { qty, base } = D.toBaseQty(item, { factor: o.factor }, l.qty, `البند ${i + 1}`);
      const already = (perLine.get(o.id) || 0) + base;
      perLine.set(o.id, already);
      if (already > o.base_qty - o.returned_qty) {
        fail('RETURN_EXCEEDS', `كمية المرتجع للصنف ${o.item_name} تتجاوز ما اشتُري بعد المرتجعات السابقة (${fromQty(mulDiv(o.base_qty - o.returned_qty, 1000, o.factor))})`, 409);
      }
      const batch = ctx.db.prepare('SELECT * FROM batches WHERE id=?').get(o.batch_id);
      // المتاح للإرجاع: كمية نفس الدفعة الموجودة فعليًا في موقع الإرجاع
      const avail = ctx.db.prepare(`SELECT COALESCE(SUM(qty),0) q FROM batches WHERE warehouse_id=? AND (id=? OR origin_batch_id=?) AND status<>'pending'`).get(pur.warehouse_id, batch.id, batch.id).q;
      if (base > avail) {
        fail('RETURN_EXCEEDS_BATCH', `لا يمكن إرجاع ${fromQty(base)} ${item.base_unit} من ${item.name}: الموجود من الدفعة ${batch.batch_no || batch.id} في المستودع ${fromQty(avail)} فقط`, 409, { available: fromQty(avail) });
      }
      const prev = ctx.db.prepare(`SELECT COALESCE(SUM(l.net),0) net, COALESCE(SUM(l.tax),0) tax FROM doc_lines l JOIN docs d ON d.id=l.doc_id
        WHERE l.ref_line_id=? AND d.status='approved'`).get(o.id);
      const last = base === o.base_qty - o.returned_qty;
      const net = last ? o.net - prev.net : mulDiv(o.net, base, o.base_qty);
      const tax = last ? o.tax - prev.tax : mulDiv(o.tax, base, o.base_qty);
      const value = mulDiv(o.value, base, o.base_qty);
      const lineId = D.insertLine(ctx, doc.id, {
        line_no: i + 1, item_id: o.item_id, item_name: o.item_name, unit_id: o.unit_id, unit_name: o.unit_name, factor: o.factor, qty, base_qty: base,
        price: o.price, value, line_discount: value - net > 0 ? value - net : 0, net, tax_rate_bp: o.tax_rate_bp, tax, total: net + tax,
        ref_line_id: o.id, batch_id: batch.id, batch_no: batch.batch_no, expiry_date: batch.expiry_date,
      });
      // صرف من الدفعة الأصلية أولاً ثم من فروعها في نفس المستودع
      let rem = base, cost = 0;
      const rows = ctx.db.prepare(`SELECT * FROM batches WHERE warehouse_id=? AND (id=? OR origin_batch_id=?) AND status<>'pending' AND qty>0
        ORDER BY CASE WHEN id=? THEN 0 ELSE 1 END, id`).all(pur.warehouse_id, batch.id, batch.id, batch.id);
      for (const b of rows) {
        if (rem === 0) break;
        const t = Math.min(rem, b.qty);
        cost += inv.takeFromBatch(ctx, { doc, lineId, batch: b, qty: t }).cost;
        rem -= t;
      }
      ctx.db.prepare('UPDATE doc_lines SET cost=? WHERE id=?').run(cost, lineId);
      ctx.db.prepare('UPDATE doc_lines SET returned_qty=returned_qty+? WHERE id=?').run(base, o.id);
      totals.value += value; totals.net += net; totals.tax += tax; totals.cost += cost;
    });
    const total = totals.net + totals.tax;
    D.updateDoc(ctx, doc.id, { subtotal: totals.value, discount: totals.value - totals.net, net: totals.net, tax: totals.tax, total, cost: totals.cost });
    D.markApproved(ctx, doc);
    const d = D.getDocRow(ctx, doc.id);
    const taxCredit = recoverable ? totals.tax : 0;
    ledger.post(ctx, d, [
      { account: 'AP', party_id: d.party_id, debit: total },
      { account: 'INVENTORY', warehouse_id: d.warehouse_id, credit: totals.cost },
      { account: 'TAX_IN', credit: taxCredit },
      { account: 'PURCHASE_RETURN_DIFF', credit: total - totals.cost - taxCredit },
    ], 'مرتجع مشتريات');
    // يخفض مستحق المورد على الفاتورة الأصلية؛ والباقي رصيد لصالح المؤسسة يُسترد بسند قبض
    const open = D.openAmount(ctx, pur.id);
    const a = Math.min(open, total);
    if (a > 0) D.allocate(ctx, d, pur, a, date);
    const rest = D.openAmount(ctx, d.id);
    if (rest > 0 && input.refund && input.refund.cash_account_id) {
      P.cashDocInTx(ctx, 'receipt', {
        account: 'AP', date, party_id: d.party_id, amount_minor: rest, cash_account_id: input.refund.cash_account_id, ref_doc_id: d.id,
        allocations: [{ doc_id: d.id, amount_minor: rest }], notes: `استرداد ${d.number}`,
      });
    }
    ctx.audit('purchase_return.approve', { entity: 'doc', entity_id: d.id, doc_number: d.number, reason, after: { total: fromMinor(total), cost: fromMinor(totals.cost) } });
    return D.fullDoc(ctx, d.id);
  });
}

module.exports = {
  createPurchase, updatePurchase, approvePurchase, reversePurchase, createPurchaseReturn, createPurchaseOrder, updatePurchaseOrder, approvePurchaseOrder,
  closePurchaseOrder, poRemaining,
};
