'use strict';
// المبيعات ومرتجعاتها. اعتماد البيع عملية واحدة ذرية: الفاتورة + صرف الدفعات + التكلفة + المستحقات + السداد.
const { fail } = require('../lib/errors');
const { toMinor, fromMinor, fromQty, mulDiv, fromBp } = require('../lib/money');
const { checkDate, addDays } = require('../lib/dates');
const ledger = require('./ledger');
const inv = require('./inventory');
const D = require('./docs');
const P = require('./payments');

function defaultWarehouse(ctx) {
  if (ctx.repScope) {
    const rep = ctx.db.prepare('SELECT warehouse_id FROM reps WHERE id=?').get(ctx.repScope);
    return rep.warehouse_id;
  }
  const s = P.openSessionFor(ctx, ctx.userId);
  if (s && s.warehouse_id) return s.warehouse_id;
  return ctx.db.prepare("SELECT id FROM warehouses WHERE kind='main' AND active=1 ORDER BY id LIMIT 1").get().id;
}

/** بناء وتسعير بنود البيع من المدخلات */
function buildLines(ctx, linesInput, opts) {
  if (!Array.isArray(linesInput) || !linesInput.length) fail('VALIDATION', 'أضف بندًا واحدًا على الأقل');
  const prepared = linesInput.map((l, i) => {
    const item = D.getItem(ctx, l.item_id);
    if (!item.active) fail('INACTIVE', `الصنف ${item.name} موقوف`);
    const unit = D.getUnit(ctx, item, l.unit_id);
    if (!unit.active || !unit.for_sale) fail('INVALID_UNIT', `الوحدة ${unit.name} غير متاحة للبيع`);
    const { qty, base } = D.toBaseQty(item, unit, l.qty, `البند ${i + 1}`);
    const price = l.price != null && l.price !== '' ? toMinor(l.price, `سعر البند ${i + 1}`) : unit.sell_price;
    if (price < 0) fail('VALIDATION', 'السعر لا يكون سالبًا');
    return {
      item, unit, qty, base, price, list_price: unit.sell_price, tax_rate_bp: D.itemTaxBp(ctx, item), ...D.parseLineMoney(l, i),
    };
  });
  const priced = D.priceLines(prepared, opts);
  return priced;
}

function invoiceOpts(ctx, input) {
  const { toBp } = require('../lib/money');
  return {
    invoiceDiscountBp: input.invoice_discount_pct != null && input.invoice_discount_pct !== '' ? toBp(input.invoice_discount_pct, 'خصم الفاتورة') : null,
    invoiceDiscountAmount: input.invoice_discount_amount != null && input.invoice_discount_amount !== '' ? toMinor(input.invoice_discount_amount, 'خصم الفاتورة') : null,
    pricesIncludeTax: input.prices_include_tax != null ? !!Number(input.prices_include_tax) : ctx.setting('prices_include_tax') === '1',
  };
}

function storeDraft(ctx, input, existing) {
  const date = checkDate(input.date || ctx.today());
  const warehouseId = Number(input.warehouse_id || defaultWarehouse(ctx));
  const wh = ctx.db.prepare('SELECT * FROM warehouses WHERE id=?').get(warehouseId);
  if (!wh || !wh.active) fail('VALIDATION', 'المستودع غير صحيح');
  let party = null;
  if (input.party_id) {
    party = ctx.db.prepare('SELECT * FROM parties WHERE id=?').get(input.party_id);
    if (!party || !party.is_customer) fail('VALIDATION', 'العميل غير صحيح');
    if (!party.active) fail('INACTIVE', `العميل ${party.name} موقوف`);
  }
  let repId = input.rep_id ? Number(input.rep_id) : (party ? party.rep_id : null) || (wh.kind === 'rep' ? wh.rep_id : null);
  if (ctx.repScope) {
    if (party && ctx.partyScope && party.rep_id !== ctx.partyScope) fail('FORBIDDEN', 'هذا العميل خارج نطاقك', 403);
    const rep = ctx.db.prepare('SELECT * FROM reps WHERE id=?').get(ctx.repScope);
    if (warehouseId !== rep.warehouse_id) fail('FORBIDDEN', 'المندوب يبيع من مخزونه فقط', 403);
    repId = ctx.repScope;
  }
  const opts = invoiceOpts(ctx, input);
  const { lines, totals } = buildLines(ctx, input.lines, opts);
  const payments = (input.payments || []).filter((p) => p && p.amount != null && p.amount !== '' && Number(p.amount) !== 0)
    .map((p) => ({ method: p.method || 'cash', cash_account_id: p.cash_account_id || null, amount: toMinor(p.amount, 'مبلغ السداد') }));
  for (const p of payments) if (p.amount < 0) fail('INVALID_AMOUNT', 'مبلغ السداد لا يكون سالبًا');
  const session = P.openSessionFor(ctx, ctx.userId);
  const fields = {
    date, party_id: party ? party.id : null, warehouse_id: warehouseId, rep_id: repId, session_id: session ? session.id : null,
    ledger_account: 'AR', ledger_side: 'D', subtotal: totals.subtotal, discount: totals.discount, net: totals.net, tax: totals.tax,
    total: totals.total, prices_include_tax: opts.pricesIncludeTax ? 1 : 0, invoice_discount_bp: opts.invoiceDiscountBp,
    invoice_discount_amount: opts.invoiceDiscountAmount, notes: input.notes || null,
    due_date: input.due_date ? checkDate(input.due_date, 'تاريخ الاستحقاق') : null,
    data: { payments, override_reason: input.override_reason || null, credit_reason: input.credit_reason || null },
  };
  let doc;
  if (existing) {
    D.updateDoc(ctx, existing.id, fields);
    ctx.db.prepare('DELETE FROM doc_lines WHERE doc_id=?').run(existing.id);
    doc = D.getDocRow(ctx, existing.id);
  } else {
    doc = D.insertDoc(ctx, 'sale', fields);
  }
  lines.forEach((l, i) => {
    l.id = D.insertLine(ctx, doc.id, {
      line_no: i + 1, item_id: l.item.id, item_name: l.item.name, unit_id: l.unit.id, unit_name: l.unit.name, factor: l.unit.factor,
      qty: l.qty, base_qty: l.base, price: l.price, value: l.value, line_discount: l.line_discount, doc_discount: l.doc_discount,
      net: l.net, tax_rate_bp: l.tax_rate_bp, tax: l.tax, total: l.total, data: { list_price: l.list_price },
    });
  });
  return { doc: D.getDocRow(ctx, doc.id), lines, payments, party, totals };
}

/** فحوص الاعتماد: الخصم، السعر الأدنى، الائتمان، التوفر */
function approvalChecks(ctx, doc, lines, payments, party, input) {
  const overrides = [];
  const maxDefault = ctx.settingInt('cashier_max_discount_bp') ?? 0;
  for (const l of lines) {
    const listValue = mulDiv(l.qty, l.list_price, 1000);
    const effective = l.value - l.line_discount - l.doc_discount;
    if (listValue > 0 && effective < listValue) {
      const discBp = mulDiv(listValue - effective, 10000, listValue);
      const limit = l.item.max_discount_bp ?? maxDefault;
      if (discBp > limit) {
        ctx.require('sales.discount.override', 'sale.discount_override');
        overrides.push(`خصم ${fromBp(discBp)}% على ${l.item.name} يتجاوز الحد ${fromBp(limit)}%`);
      }
    }
    if (l.item.min_price != null) {
      // صافي سعر وحدة الأساس قبل الضريبة
      if (BigInt(l.net) * 1000n < BigInt(l.item.min_price) * BigInt(l.base)) {
        ctx.require('sales.price.override', 'sale.price_override');
        overrides.push(`سعر ${l.item.name} أقل من الحد الأدنى ${fromMinor(l.item.min_price)}`);
      }
    }
  }
  const paid = payments.reduce((s, p) => s + p.amount, 0);
  if (paid > doc.total) fail('OVERPAYMENT', `المدفوع (${fromMinor(paid)}) أكبر من إجمالي الفاتورة (${fromMinor(doc.total)})`);
  const unpaid = doc.total - paid;
  if (unpaid > 0) {
    if (!party) fail('CREDIT_NEEDS_CUSTOMER', 'البيع الآجل يتطلب تحديد العميل');
    if (party.credit_limit != null) {
      const bal = ledger.balance(ctx.db, 'AR', { party_id: party.id });
      if (bal + unpaid > party.credit_limit) {
        ctx.require('credit.override', 'sale.credit_override');
        overrides.push(`تجاوز الحد الائتماني للعميل ${party.name}: الرصيد بعد البيع ${fromMinor(bal + unpaid)} والحد ${fromMinor(party.credit_limit)}`);
      }
    }
  }
  let reason = null;
  if (overrides.length) {
    reason = ctx.requireReason(input.override_reason || D.docData(doc).override_reason, 'تجاوز الحدود');
  }
  // فحص التوفر بعد جمع احتياج كل صنف من كل السطور
  const need = new Map();
  for (const l of lines) need.set(l.item.id, (need.get(l.item.id) || 0) + l.base);
  const short = [];
  for (const [itemId, q] of need) {
    const avail = inv.sellableQty(ctx, itemId, doc.warehouse_id);
    if (avail < q) {
      const it = lines.find((l) => l.item.id === itemId).item;
      short.push({ item_id: itemId, item: it.name, required: fromQty(q), available: fromQty(avail) });
    }
  }
  if (short.length) {
    fail('INSUFFICIENT_STOCK', 'الرصيد الصالح غير كافٍ: ' + short.map((s) => `${s.item} (المطلوب ${s.required} والمتاح ${s.available})`).join('، '), 409, { short });
  }
  return { overrides, reason, unpaid };
}

function postSale(ctx, doc, lines, payments, party, input) {
  ctx.checkPeriod(doc.date);
  const { overrides, reason, unpaid } = approvalChecks(ctx, doc, lines, payments, party, input);
  let cost = 0;
  for (const l of lines) {
    const r = inv.consumeFefo(ctx, { doc, lineId: l.id, itemId: l.item.id, warehouseId: doc.warehouse_id, qty: l.base, itemName: l.item.name });
    ctx.db.prepare('UPDATE doc_lines SET cost=? WHERE id=?').run(r.cost, l.id);
    cost += r.cost;
  }
  const dueDate = doc.due_date || (unpaid > 0 ? addDays(doc.date, party.payment_terms_days || 0) : null);
  ctx.db.prepare('UPDATE docs SET cost=?, due_date=?, reason=? WHERE id=?').run(cost, dueDate, reason, doc.id);
  D.markApproved(ctx, doc);
  doc = D.getDocRow(ctx, doc.id);
  ledger.post(ctx, doc, [
    { account: 'AR', party_id: doc.party_id, debit: doc.total },
    { account: 'SALES', credit: doc.net, rep_id: doc.rep_id },
    { account: 'TAX_OUT', credit: doc.tax },
    { account: 'COGS', debit: cost },
    { account: 'INVENTORY', warehouse_id: doc.warehouse_id, credit: cost },
  ], 'فاتورة بيع');
  for (const p of payments) {
    P.cashDocInTx(ctx, 'receipt', {
      date: doc.date, party_id: doc.party_id, allow_no_party: true, amount_minor: p.amount, method: p.method, cash_account_id: p.cash_account_id,
      ref_doc_id: doc.id, allocations: [{ doc_id: doc.id, amount_minor: p.amount }], notes: `سداد ${doc.number}`,
    });
  }
  ctx.audit('sale.approve', {
    entity: 'doc', entity_id: doc.id, doc_number: doc.number, reason,
    after: { total: fromMinor(doc.total), paid: fromMinor(doc.total - unpaid), cost: fromMinor(cost), overrides },
  });
  return doc;
}

/** إنشاء فاتورة بيع (مسودة أو معتمدة مباشرة) */
function createSale(ctx, input) {
  ctx.require('sales.create');
  return ctx.tx(() => {
    const { doc, lines, payments, party } = storeDraft(ctx, input);
    if (input.approve === false) {
      ctx.audit('sale.draft', { entity: 'doc', entity_id: doc.id, doc_number: doc.number });
      return D.fullDoc(ctx, doc.id);
    }
    postSale(ctx, doc, lines, payments, party, input);
    return D.fullDoc(ctx, doc.id);
  });
}

function updateSaleDraft(ctx, id, input) {
  ctx.require('sales.create');
  return ctx.tx(() => {
    const ex = D.loadDoc(ctx, id, 'sale');
    if (ex.status !== 'draft') fail('INVALID_STATE', 'لا يمكن تعديل فاتورة معتمدة؛ استخدم المرتجع أو الإلغاء');
    if (ctx.repScope && ex.rep_id !== ctx.repScope) fail('FORBIDDEN', 'المستند خارج نطاقك', 403);
    const { doc, lines, payments, party } = storeDraft(ctx, input, ex);
    if (input.approve) postSale(ctx, doc, lines, payments, party, input);
    else ctx.audit('sale.draft_update', { entity: 'doc', entity_id: doc.id, doc_number: doc.number });
    return D.fullDoc(ctx, doc.id);
  });
}

function approveSaleDraft(ctx, id, input = {}) {
  ctx.require('sales.create');
  return ctx.tx(() => {
    const ex = D.loadDoc(ctx, id, 'sale');
    if (ex.status !== 'draft') fail('INVALID_STATE', 'الفاتورة ليست مسودة');
    const old = D.docLines(ctx, id);
    const data = D.docData(ex);
    const rebuilt = {
      date: input.date || ex.date, party_id: ex.party_id, warehouse_id: ex.warehouse_id, rep_id: ex.rep_id, notes: ex.notes,
      prices_include_tax: ex.prices_include_tax, invoice_discount_pct: ex.invoice_discount_bp != null ? ex.invoice_discount_bp / 100 : null,
      invoice_discount_amount: ex.invoice_discount_amount != null ? fromMinor(ex.invoice_discount_amount) : null,
      due_date: ex.due_date, override_reason: input.override_reason || data.override_reason,
      payments: input.payments || (data.payments || []).map((p) => ({ ...p, amount: fromMinor(p.amount) })),
      lines: old.map((l) => ({
        item_id: l.item_id, unit_id: l.unit_id, qty: fromQty(l.qty), price: fromMinor(l.price),
        discount_amount: l.line_discount ? fromMinor(l.line_discount) : null,
      })),
    };
    const { doc, lines, payments, party } = storeDraft(ctx, rebuilt, ex);
    postSale(ctx, doc, lines, payments, party, rebuilt);
    return D.fullDoc(ctx, doc.id);
  });
}

/** إلغاء فاتورة بيع معتمدة: مسموح فقط بلا تحصيل لاحق ولا مرتجع؛ يعكس السداد المرافق والمخزون والقيود */
function reverseSale(ctx, id, reason) {
  ctx.require('sales.reverse');
  return ctx.tx(() => {
    const doc = D.loadDoc(ctx, id, 'sale');
    if (doc.status !== 'approved') fail('INVALID_STATE', 'الفاتورة غير معتمدة');
    const r = ctx.requireReason(reason, 'إلغاء فاتورة معتمدة');
    ctx.checkPeriod(doc.date);
    ctx.checkPeriod(ctx.today());
    if (ctx.db.prepare("SELECT 1 FROM docs WHERE ref_doc_id=? AND type='sale_return' AND status<>'reversed'").get(id)) {
      fail('HAS_DEPENDENTS', 'الفاتورة مرتبطة بمرتجع؛ لا تُلغى إلا عبر مسار تصحيح', 409);
    }
    const allocs = ctx.db.prepare('SELECT a.*, s.ref_doc_id s_ref, s.type s_type FROM allocations a JOIN docs s ON s.id=a.source_doc_id WHERE a.target_doc_id=? AND a.reversed=0').all(id);
    for (const a of allocs) {
      if (!(a.s_type === 'receipt' && a.s_ref === id)) fail('HAS_DEPENDENTS', 'الفاتورة مرتبطة بتحصيل لاحق؛ ألغِ التحصيل أو استخدم المرتجع', 409);
    }
    const linked = ctx.db.prepare("SELECT * FROM docs WHERE ref_doc_id=? AND type='receipt' AND status='approved'").all(id);
    for (const rc of linked) {
      const other = ctx.db.prepare('SELECT 1 FROM allocations WHERE source_doc_id=? AND target_doc_id<>? AND reversed=0').get(rc.id, id);
      if (other) fail('HAS_DEPENDENTS', `السند ${rc.number} مخصص لمستندات أخرى`, 409);
      const acc = P.getCashAccount(ctx, rc.cash_account_id);
      if (acc.kind !== 'bank' && P.cashBalance(ctx, acc.id) < rc.total) fail('INSUFFICIENT_CASH', `رصيد ${acc.name} لا يكفي لرد المبلغ`, 409);
      D.markReversed(ctx, rc, r);
      ledger.reverseEntries(ctx, rc, ctx.today(), 'إلغاء ' + rc.number);
    }
    inv.reverseMoves(ctx, doc);
    D.markReversed(ctx, doc, r);
    ledger.reverseEntries(ctx, doc, ctx.today(), 'إلغاء ' + doc.number);
    ctx.audit('sale.reverse', { entity: 'doc', entity_id: doc.id, doc_number: doc.number, reason: r });
    return D.fullDoc(ctx, doc.id);
  });
}

// ===================== مرتجع المبيعات =====================

const CONDITIONS = { ok: 'صالح', pending: 'قيد الفحص', isolated: 'معزول', damaged: 'تالف' };

function prepareReturnLines(ctx, sale, linesInput) {
  if (!Array.isArray(linesInput) || !linesInput.length) fail('VALIDATION', 'اختر بنود المرتجع');
  const origLines = D.docLines(ctx, sale.id);
  const byLine = new Map();
  for (const [i, l] of linesInput.entries()) {
    const orig = origLines.find((o) => o.id === Number(l.line_id));
    if (!orig) fail('VALIDATION', `البند ${i + 1} لا يتبع الفاتورة الأصلية`);
    const cond = l.condition || 'ok';
    if (!CONDITIONS[cond]) fail('VALIDATION', 'حالة المرتجع غير صحيحة');
    const item = D.getItem(ctx, orig.item_id);
    const { qty, base } = D.toBaseQty(item, { factor: orig.factor }, l.qty, `البند ${i + 1}`);
    const key = orig.id;
    const prev = byLine.get(key) || 0;
    byLine.set(key, prev + base);
    const remaining = orig.base_qty - orig.returned_qty;
    if (prev + base > remaining) {
      fail('RETURN_EXCEEDS', `كمية المرتجع للصنف ${orig.item_name} (${fromQty(mulDiv(prev + base, 1000, orig.factor))} ${orig.unit_name}) تتجاوز المتبقي غير المرتجع (${fromQty(mulDiv(remaining, 1000, orig.factor))})`, 409);
    }
    l._orig = orig; l._qty = qty; l._base = base; l._cond = cond; l._item = item;
  }
  return linesInput;
}

/** القيمة النسبية من البند الأصلي؛ إرجاع آخر كمية يأخذ المتبقي بالضبط */
function returnValue(ctx, orig, base) {
  const prev = ctx.db.prepare(`SELECT COALESCE(SUM(l.net),0) net, COALESCE(SUM(l.tax),0) tax, COALESCE(SUM(l.line_discount+l.doc_discount),0) disc, COALESCE(SUM(l.value),0) value
    FROM doc_lines l JOIN docs d ON d.id=l.doc_id WHERE l.ref_line_id=? AND d.status='approved'`).get(orig.id);
  if (base === orig.base_qty - orig.returned_qty) {
    return { net: orig.net - prev.net, tax: orig.tax - prev.tax, value: orig.value - prev.value, discount: orig.line_discount + orig.doc_discount - prev.disc };
  }
  return {
    net: mulDiv(orig.net, base, orig.base_qty), tax: mulDiv(orig.tax, base, orig.base_qty), value: mulDiv(orig.value, base, orig.base_qty),
    discount: mulDiv(orig.line_discount + orig.doc_discount, base, orig.base_qty),
  };
}

function createSaleReturn(ctx, input) {
  ctx.require('sale_returns.create');
  return ctx.tx(() => {
    const sale = D.loadDoc(ctx, input.sale_id, 'sale');
    if (sale.status !== 'approved') fail('INVALID_STATE', 'المرتجع يكون من فاتورة معتمدة');
    if (ctx.repScope && sale.rep_id !== ctx.repScope) fail('FORBIDDEN', 'الفاتورة خارج نطاقك', 403);
    const reason = ctx.requireReason(input.reason, 'المرتجع');
    const lines = prepareReturnLines(ctx, sale, input.lines);
    const date = checkDate(input.date || ctx.today());
    let totals = { value: 0, discount: 0, net: 0, tax: 0 };
    const doc = D.insertDoc(ctx, 'sale_return', {
      date, party_id: sale.party_id, warehouse_id: input.warehouse_id || sale.warehouse_id, rep_id: sale.rep_id, ref_doc_id: sale.id,
      ledger_account: 'AR', ledger_side: 'C', reason, notes: input.notes || null,
      session_id: (P.openSessionFor(ctx, ctx.userId) || {}).id || null,
      data: { refund: input.refund || null },
    });
    lines.forEach((l, i) => {
      const v = returnValue(ctx, l._orig, l._base);
      totals.value += v.value; totals.discount += v.discount; totals.net += v.net; totals.tax += v.tax;
      D.insertLine(ctx, doc.id, {
        line_no: i + 1, item_id: l._orig.item_id, item_name: l._orig.item_name, unit_id: l._orig.unit_id, unit_name: l._orig.unit_name,
        factor: l._orig.factor, qty: l._qty, base_qty: l._base, price: l._orig.price, value: v.value, line_discount: v.discount,
        net: v.net, tax_rate_bp: l._orig.tax_rate_bp, tax: v.tax, total: v.net + v.tax, ref_line_id: l._orig.id, condition: l._cond,
      });
    });
    D.updateDoc(ctx, doc.id, { subtotal: totals.value, discount: totals.discount, net: totals.net, tax: totals.tax, total: totals.net + totals.tax });
    if (input.approve === false || !ctx.has('sale_returns.approve')) {
      ctx.audit('sale_return.draft', { entity: 'doc', entity_id: doc.id, doc_number: doc.number, reason });
      return D.fullDoc(ctx, doc.id);
    }
    postSaleReturn(ctx, D.getDocRow(ctx, doc.id), input.refund);
    return D.fullDoc(ctx, doc.id);
  });
}

function approveSaleReturn(ctx, id, input = {}) {
  ctx.require('sale_returns.approve');
  return ctx.tx(() => {
    const doc = D.loadDoc(ctx, id, 'sale_return');
    if (doc.status !== 'draft') fail('INVALID_STATE', 'المرتجع ليس مسودة');
    // إعادة حساب القيم عند الاعتماد لضمان عدم تجاوز المتبقي
    const sale = D.loadDoc(ctx, doc.ref_doc_id, 'sale');
    const lines = D.docLines(ctx, id);
    prepareReturnLines(ctx, sale, lines.map((l) => ({ line_id: l.ref_line_id, qty: fromQty(l.qty), condition: l.condition })));
    let totals = { value: 0, discount: 0, net: 0, tax: 0 };
    for (const l of lines) {
      const orig = ctx.db.prepare('SELECT * FROM doc_lines WHERE id=?').get(l.ref_line_id);
      const v = returnValue(ctx, orig, l.base_qty);
      ctx.db.prepare('UPDATE doc_lines SET value=?, line_discount=?, net=?, tax=?, total=? WHERE id=?').run(v.value, v.discount, v.net, v.tax, v.net + v.tax, l.id);
      totals.value += v.value; totals.discount += v.discount; totals.net += v.net; totals.tax += v.tax;
    }
    D.updateDoc(ctx, id, { subtotal: totals.value, discount: totals.discount, net: totals.net, tax: totals.tax, total: totals.net + totals.tax });
    postSaleReturn(ctx, D.getDocRow(ctx, id), input.refund || D.docData(doc).refund);
    return D.fullDoc(ctx, id);
  });
}

function postSaleReturn(ctx, doc, refund) {
  ctx.checkPeriod(doc.date);
  const sale = D.loadDoc(ctx, doc.ref_doc_id, 'sale');
  const lines = D.docLines(ctx, doc.id);
  let keptCost = 0, damagedCost = 0;
  const today = inv.minSellableExpiry(ctx);
  for (const l of lines) {
    // تكلفة المرتجع من حركات صرف البند الأصلي (التكلفة التاريخية)
    const moves = ctx.db.prepare('SELECT * FROM stock_moves WHERE line_id=? AND qty<0 ORDER BY id DESC').all(l.ref_line_id);
    let rem = l.base_qty, lineCost = 0;
    for (const m of moves) {
      if (rem === 0) break;
      const avail = -m.qty - m.returned_qty;
      if (avail <= 0) continue;
      const t = Math.min(avail, rem);
      const c = t === avail ? (-m.cost - m.returned_cost) : mulDiv(-m.cost, t, -m.qty);
      ctx.db.prepare('UPDATE stock_moves SET returned_qty=returned_qty+?, returned_cost=returned_cost+? WHERE id=?').run(t, c, m.id);
      rem -= t;
      lineCost += c;
      if (l.condition === 'damaged') { damagedCost += c; continue; }
      const origin = ctx.db.prepare('SELECT * FROM batches WHERE id=?').get(m.batch_id);
      let status = l.condition;
      if (status === 'ok' && origin.expiry_date && origin.expiry_date < today) status = 'isolated'; // مرتجع منتهٍ لا يزيد الرصيد الصالح
      inv.receiveLike(ctx, { doc, lineId: l.id, origin, warehouseId: doc.warehouse_id, status, qty: t, cost: c });
      keptCost += c;
    }
    if (rem !== 0) fail('RETURN_EXCEEDS', `لا توجد كمية مصروفة كافية للإرجاع في ${l.item_name}`, 409);
    ctx.db.prepare('UPDATE doc_lines SET cost=? WHERE id=?').run(lineCost, l.id);
    ctx.db.prepare('UPDATE doc_lines SET returned_qty=returned_qty+? WHERE id=?').run(l.base_qty, l.ref_line_id);
  }
  ctx.db.prepare('UPDATE docs SET cost=? WHERE id=?').run(keptCost + damagedCost, doc.id);
  D.markApproved(ctx, doc);
  doc = D.getDocRow(ctx, doc.id);
  ledger.post(ctx, doc, [
    { account: 'SALES_RETURNS', debit: doc.net, rep_id: doc.rep_id },
    { account: 'TAX_OUT', debit: doc.tax },
    { account: 'AR', party_id: doc.party_id, credit: doc.total },
    { account: 'INVENTORY', warehouse_id: doc.warehouse_id, debit: keptCost },
    { account: 'INV_LOSS', debit: damagedCost },
    { account: 'COGS', credit: keptCost + damagedCost },
  ], 'مرتجع مبيعات');
  // يقلل مديونية الفاتورة الأصلية أولاً
  const saleOpen = D.openAmount(ctx, sale.id);
  const toInvoice = Math.min(saleOpen, doc.total);
  if (toInvoice > 0) D.allocate(ctx, doc, sale, toInvoice, doc.date);
  // الباقي رصيد للعميل أو رد نقدي بسند صرف
  const rest = D.openAmount(ctx, doc.id);
  if (rest > 0 && (refund || !doc.party_id)) {
    const rf = refund || { method: 'cash' };
    P.cashDocInTx(ctx, 'payment', {
      account: 'AR', date: doc.date, party_id: doc.party_id, allow_no_party: true, amount_minor: rest, method: rf.method || 'cash',
      cash_account_id: rf.cash_account_id, ref_doc_id: doc.id, allocations: [{ doc_id: doc.id, amount_minor: rest }], notes: `رد قيمة ${doc.number}`,
    });
  }
  ctx.audit('sale_return.approve', { entity: 'doc', entity_id: doc.id, doc_number: doc.number, reason: doc.reason, after: { total: fromMinor(doc.total), cost: fromMinor(keptCost + damagedCost), damaged_cost: fromMinor(damagedCost) } });
  return doc;
}

/** بنود فاتورة مع الكميات القابلة للإرجاع */
function returnableLines(ctx, saleId) {
  const sale = D.loadDoc(ctx, saleId, 'sale');
  if (ctx.repScope && sale.rep_id !== ctx.repScope) fail('FORBIDDEN', 'الفاتورة خارج نطاقك', 403);
  return D.docLines(ctx, saleId).map((l) => ({
    ...D.present(l), returnable_qty: fromQty(mulDiv(l.base_qty - l.returned_qty, 1000, l.factor)),
  }));
}

module.exports = { createSale, updateSaleDraft, approveSaleDraft, reverseSale, createSaleReturn, approveSaleReturn, returnableLines, CONDITIONS, defaultWarehouse };
