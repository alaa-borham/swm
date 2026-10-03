'use strict';
// التحويلات، الجرد، التالف، المخزون الافتتاحي، وتغيير حالة الدفعات.
const { fail, notFound } = require('../lib/errors');
const { toMinor, fromMinor, fromQty, mulDiv } = require('../lib/money');
const { checkDate } = require('../lib/dates');
const ledger = require('./ledger');
const inv = require('./inventory');
const D = require('./docs');

function getWarehouse(ctx, id) {
  const w = ctx.db.prepare('SELECT * FROM warehouses WHERE id=?').get(id);
  if (!w) notFound('المستودع');
  if (!w.active) fail('INACTIVE', `المستودع ${w.name} موقوف`);
  return w;
}

function getBatch(ctx, id) {
  const b = ctx.db.prepare('SELECT * FROM batches WHERE id=?').get(id);
  if (!b) notFound('الدفعة');
  return b;
}

// ===================== التحويل بين المستودعات =====================
/**
 * التحويل الفوري: خروج ودخول مترابطان لنفس الدفعات ونفس التكلفة، لا يغير إجمالي المخزون ولا ينشئ إيرادًا.
 * lines: [{item_id, unit_id?, qty, batch_id?}] — بدون دفعة يُصرف بالأقرب انتهاءً من الرصيد الصالح.
 */
function createTransfer(ctx, input) {
  ctx.require('stock.transfer');
  return ctx.tx(() => {
    const from = getWarehouse(ctx, input.from_warehouse_id);
    const to = getWarehouse(ctx, input.to_warehouse_id);
    if (from.id === to.id) fail('VALIDATION', 'المستودع المصدر والوجهة متطابقان');
    const date = checkDate(input.date || ctx.today());
    ctx.checkPeriod(date);
    if (!Array.isArray(input.lines) || !input.lines.length) fail('VALIDATION', 'أضف بندًا واحدًا على الأقل');
    // النقل على مراحل: يخرج من المصدر الآن ويبقى "بالطريق" غير متاح في الطرفين حتى استلام الوجهة
    const transit = !!input.in_transit;
    const doc = D.insertDoc(ctx, 'transfer', {
      date, warehouse_id: from.id, to_warehouse_id: to.id, rep_id: to.rep_id || from.rep_id || null, notes: input.notes || null,
      data: { custody: to.kind === 'rep' ? 'تسليم عهدة' : from.kind === 'rep' ? 'إعادة عهدة' : null, transit: transit ? 'in_transit' : null },
    });
    let total = 0;
    input.lines.forEach((l, i) => {
      const item = D.getItem(ctx, l.item_id);
      const unit = D.getUnit(ctx, item, l.unit_id);
      const { qty, base } = D.toBaseQty(item, unit, l.qty, `البند ${i + 1}`);
      const lineId = D.insertLine(ctx, doc.id, {
        line_no: i + 1, item_id: item.id, item_name: item.name, unit_id: unit.id, unit_name: unit.name, factor: unit.factor, qty, base_qty: base,
        batch_id: l.batch_id || null,
      });
      let takes;
      if (l.batch_id) {
        const b = getBatch(ctx, l.batch_id);
        if (b.item_id !== item.id || b.warehouse_id !== from.id) fail('VALIDATION', 'الدفعة لا تخص الصنف أو المستودع المصدر');
        takes = [inv.takeFromBatch(ctx, { doc, lineId, batch: b, qty: base })];
      } else {
        takes = inv.consumeFefo(ctx, { doc, lineId, itemId: item.id, warehouseId: from.id, qty: base, itemName: item.name }).takes;
      }
      let cost = 0;
      for (const t of takes) {
        if (!transit) inv.receiveLike(ctx, { doc, lineId, origin: t.batch, warehouseId: to.id, status: t.batch.status, qty: t.qty, cost: t.cost });
        cost += t.cost;
      }
      ctx.db.prepare('UPDATE doc_lines SET cost=?, data=? WHERE id=?').run(cost, transit ? JSON.stringify({ takes: takes.map((t) => ({ batch_id: t.batch_id, qty: t.qty, cost: t.cost })) }) : null, lineId);
      total += cost;
    });
    D.updateDoc(ctx, doc.id, { cost: total });
    D.markApproved(ctx, doc);
    // المخزون بالطريق: حساب المخزون بلا مستودع حتى الاستلام
    ledger.post(ctx, D.getDocRow(ctx, doc.id), [
      { account: 'INVENTORY', warehouse_id: transit ? null : to.id, debit: total },
      { account: 'INVENTORY', warehouse_id: from.id, credit: total },
    ], transit ? 'تحويل بالطريق' : 'تحويل مخزون');
    ctx.audit(transit ? 'transfer.ship' : 'transfer.create', { entity: 'doc', entity_id: doc.id, doc_number: doc.number, after: { from: from.name, to: to.name, cost: fromMinor(total) } });
    return D.fullDoc(ctx, doc.id);
  });
}

// ===================== التالف =====================
/** lines: [{batch_id, qty (بوحدة الأساس), reason}] */
function createDamage(ctx, input) {
  ctx.require('stock.damage');
  return ctx.tx(() => {
    const date = checkDate(input.date || ctx.today());
    const reason = ctx.requireReason(input.reason, 'تسجيل التالف');
    if (!Array.isArray(input.lines) || !input.lines.length) fail('VALIDATION', 'أضف بندًا واحدًا على الأقل');
    const wh = getWarehouse(ctx, input.warehouse_id);
    const doc = D.insertDoc(ctx, 'damage', { date, warehouse_id: wh.id, reason, notes: input.notes || null });
    input.lines.forEach((l, i) => {
      const b = getBatch(ctx, l.batch_id);
      if (b.warehouse_id !== wh.id) fail('VALIDATION', 'الدفعة ليست في هذا المستودع');
      const item = D.getItem(ctx, b.item_id);
      const unit = D.getUnit(ctx, item, null);
      const { qty, base } = D.toBaseQty(item, unit, l.qty, `البند ${i + 1}`);
      if (base > b.qty) fail('INSUFFICIENT_STOCK', `كمية التالف أكبر من رصيد الدفعة (${fromQty(b.qty)})`, 409);
      D.insertLine(ctx, doc.id, {
        line_no: i + 1, item_id: item.id, item_name: item.name, unit_id: unit.id, unit_name: unit.name, factor: 1000, qty, base_qty: base,
        batch_id: b.id, batch_no: b.batch_no, expiry_date: b.expiry_date, description: l.reason || null,
      });
    });
    ctx.audit('damage.draft', { entity: 'doc', entity_id: doc.id, doc_number: doc.number, reason });
    if (input.approve !== false && ctx.has('stock.damage.approve')) approveDamageInTx(ctx, D.getDocRow(ctx, doc.id));
    return D.fullDoc(ctx, doc.id);
  });
}

function approveDamage(ctx, id) {
  return ctx.tx(() => { approveDamageInTx(ctx, D.loadDoc(ctx, id, 'damage')); return D.fullDoc(ctx, id); });
}

function approveDamageInTx(ctx, doc) {
  ctx.require('stock.damage.approve');
  if (doc.status !== 'draft') fail('INVALID_STATE', 'المستند ليس مسودة');
  ctx.checkPeriod(doc.date);
  let total = 0;
  for (const l of D.docLines(ctx, doc.id)) {
    const t = inv.takeFromBatch(ctx, { doc, lineId: l.id, batch: { id: l.batch_id }, qty: l.base_qty });
    ctx.db.prepare('UPDATE doc_lines SET cost=? WHERE id=?').run(t.cost, l.id);
    total += t.cost;
  }
  D.updateDoc(ctx, doc.id, { cost: total });
  D.markApproved(ctx, doc);
  ledger.post(ctx, D.getDocRow(ctx, doc.id), [
    { account: 'INV_LOSS', debit: total },
    { account: 'INVENTORY', warehouse_id: doc.warehouse_id, credit: total },
  ], 'تالف');
  ctx.audit('damage.approve', { entity: 'doc', entity_id: doc.id, doc_number: doc.number, reason: doc.reason, after: { cost: fromMinor(total) } });
}

// ===================== الجرد =====================
/**
 * إنشاء جرد بتاريخ ونطاق محددين: يحفظ رصيدًا مرجعيًا لكل دفعة وقت الإنشاء.
 * عند الاعتماد: الفرق = المعدود - المرجعي، ويُطبق على الرصيد الحالي فتُراعى الحركات التي حدثت أثناء العد.
 */
function createCount(ctx, input) {
  ctx.require('stock.count');
  return ctx.tx(() => {
    const wh = getWarehouse(ctx, input.warehouse_id);
    const date = checkDate(input.date || ctx.today());
    const w = ['warehouse_id=?', "status IN ('ok','isolated')"];
    const p = [wh.id];
    if (Array.isArray(input.item_ids) && input.item_ids.length) { w.push(`item_id IN (${input.item_ids.map(() => '?').join(',')})`); p.push(...input.item_ids.map(Number)); }
    if (input.category_id) { w.push('item_id IN (SELECT id FROM items WHERE category_id=?)'); p.push(Number(input.category_id)); }
    const batches = ctx.db.prepare(`SELECT b.*, i.name item_name, i.base_unit FROM batches b JOIN items i ON i.id=b.item_id WHERE ${w.join(' AND ')} AND (qty>0 OR b.id IN
      (SELECT batch_id FROM stock_moves WHERE warehouse_id=?)) ORDER BY i.name, b.expiry_date`).all(...p, wh.id).filter((b) => b.qty > 0);
    const doc = D.insertDoc(ctx, 'stock_count', {
      date, warehouse_id: wh.id, notes: input.notes || null,
      data: { scope: { item_ids: input.item_ids || null, category_id: input.category_id || null }, snapshot_at: ctx.now() },
    });
    batches.forEach((b, i) => {
      D.insertLine(ctx, doc.id, {
        line_no: i + 1, item_id: b.item_id, item_name: b.item_name, unit_name: b.base_unit, factor: 1000, batch_id: b.id, batch_no: b.batch_no,
        expiry_date: b.expiry_date, system_qty: b.qty, cost: b.cost, data: { status: b.status },
      });
    });
    ctx.audit('count.create', { entity: 'doc', entity_id: doc.id, doc_number: doc.number });
    return D.fullDoc(ctx, doc.id);
  });
}

/** إدخال الكميات المعدودة: counts: [{line_id, counted_qty}] أو إضافة دفعة غير مدرجة [{batch_id, counted_qty}] */
function enterCounts(ctx, id, counts) {
  ctx.require('stock.count');
  return ctx.tx(() => {
    const doc = D.loadDoc(ctx, id, 'stock_count');
    if (doc.status !== 'draft') fail('INVALID_STATE', 'الجرد معتمد');
    for (const c of counts || []) {
      let line;
      if (c.line_id) {
        line = ctx.db.prepare('SELECT * FROM doc_lines WHERE id=? AND doc_id=?').get(c.line_id, id);
        if (!line) fail('VALIDATION', 'سطر الجرد غير موجود');
      } else if (c.batch_id) {
        const b = getBatch(ctx, c.batch_id);
        if (b.warehouse_id !== doc.warehouse_id) fail('VALIDATION', 'الدفعة في مستودع آخر');
        line = ctx.db.prepare('SELECT * FROM doc_lines WHERE doc_id=? AND batch_id=?').get(id, b.id);
        if (!line) {
          const item = D.getItem(ctx, b.item_id);
          const n = ctx.db.prepare('SELECT COALESCE(MAX(line_no),0)+1 n FROM doc_lines WHERE doc_id=?').get(id).n;
          const lid = D.insertLine(ctx, id, {
            line_no: n, item_id: b.item_id, item_name: item.name, unit_name: item.base_unit, factor: 1000, batch_id: b.id, batch_no: b.batch_no,
            expiry_date: b.expiry_date, system_qty: b.qty, cost: b.cost, data: { status: b.status },
          });
          line = ctx.db.prepare('SELECT * FROM doc_lines WHERE id=?').get(lid);
        }
      } else fail('VALIDATION', 'حدد السطر أو الدفعة');
      let q = null;
      if (c.counted_qty !== null && c.counted_qty !== '') {
        const item = D.getItem(ctx, line.item_id);
        const { toQty } = require('../lib/money');
        q = toQty(c.counted_qty, item.qty_decimals, item.name);
        if (q < 0) fail('VALIDATION', 'الكمية المعدودة لا تكون سالبة');
      }
      ctx.db.prepare('UPDATE doc_lines SET counted_qty=?, description=COALESCE(?,description) WHERE id=?').run(q, c.reason || null, line.id);
    }
    return D.fullDoc(ctx, id);
  });
}

function approveCount(ctx, id, { reason } = {}) {
  ctx.require('stock.count.approve');
  return ctx.tx(() => {
    const doc = D.loadDoc(ctx, id, 'stock_count');
    if (doc.status !== 'draft') fail('INVALID_STATE', 'الجرد معتمد مسبقًا');
    ctx.checkPeriod(doc.date);
    const lines = D.docLines(ctx, id);
    const missing = lines.filter((l) => l.counted_qty == null);
    if (missing.length) fail('COUNT_INCOMPLETE', `لم تُدخل الكمية المعدودة لـ ${missing.length} سطر`, 400, { lines: missing.map((l) => l.id) });
    let loss = 0, gain = 0;
    for (const l of lines) {
      const diff = l.counted_qty - l.system_qty;
      if (diff === 0) { ctx.db.prepare('UPDATE doc_lines SET qty=0, base_qty=0, amount=0 WHERE id=?').run(l.id); continue; }
      const b = getBatch(ctx, l.batch_id);
      let value;
      if (diff < 0) {
        if (-diff > b.qty) fail('COUNT_CONFLICT', `لا يمكن خصم ${fromQty(-diff)} من الدفعة ${b.batch_no || b.id}: رصيدها الحالي ${fromQty(b.qty)}`, 409);
        value = inv.takeFromBatch(ctx, { doc, lineId: l.id, batch: b, qty: -diff }).cost;
        loss += value;
      } else {
        // تقييم الزيادة بتكلفة الوحدة المرجعية للدفعة
        value = l.system_qty > 0 ? mulDiv(l.cost, diff, l.system_qty) : (b.qty > 0 ? mulDiv(b.cost, diff, b.qty) : 0);
        inv.addToBatch(ctx, { doc, lineId: l.id, batchId: b.id, qty: diff, cost: value });
        gain += value;
      }
      ctx.db.prepare('UPDATE doc_lines SET qty=?, base_qty=?, amount=? WHERE id=?').run(diff, diff, diff < 0 ? -value : value, l.id);
    }
    D.updateDoc(ctx, id, { cost: gain - loss, reason: reason || null });
    D.markApproved(ctx, doc);
    ledger.post(ctx, D.getDocRow(ctx, id), [
      { account: 'INV_LOSS', debit: loss },
      { account: 'INVENTORY', warehouse_id: doc.warehouse_id, credit: loss },
      { account: 'INVENTORY', warehouse_id: doc.warehouse_id, debit: gain },
      { account: 'INV_GAIN', credit: gain },
    ], 'تسوية جرد');
    ctx.audit('count.approve', { entity: 'doc', entity_id: id, doc_number: doc.number, reason, after: { loss: fromMinor(loss), gain: fromMinor(gain) } });
    return D.fullDoc(ctx, id);
  });
}

// ===================== المخزون الافتتاحي =====================
/** lines: [{item_id, unit_id?, qty, unit_cost, batch_no, prod_date, expiry_date}] */
function createOpeningStock(ctx, input) {
  ctx.require('opening.manage');
  return ctx.tx(() => {
    const wh = getWarehouse(ctx, input.warehouse_id);
    const date = checkDate(input.date || ctx.today());
    ctx.checkPeriod(date);
    if (!Array.isArray(input.lines) || !input.lines.length) fail('VALIDATION', 'أضف بندًا واحدًا على الأقل');
    const doc = D.insertDoc(ctx, 'opening_stock', { date, warehouse_id: wh.id, notes: input.notes || 'مخزون افتتاحي' });
    let total = 0;
    input.lines.forEach((l, i) => {
      const item = D.getItem(ctx, l.item_id);
      const unit = D.getUnit(ctx, item, l.unit_id);
      const { qty, base } = D.toBaseQty(item, unit, l.qty, `البند ${i + 1}`);
      const price = toMinor(l.unit_cost ?? 0, `تكلفة البند ${i + 1}`);
      const cost = mulDiv(qty, price, 1000);
      if (item.track_expiry && !l.expiry_date) fail('EXPIRY_REQUIRED', `تاريخ الانتهاء مطلوب للصنف ${item.name}`);
      const lineId = D.insertLine(ctx, doc.id, {
        line_no: i + 1, item_id: item.id, item_name: item.name, unit_id: unit.id, unit_name: unit.name, factor: unit.factor, qty, base_qty: base,
        price, value: cost, cost, batch_no: l.batch_no || null, prod_date: l.prod_date ? checkDate(l.prod_date) : null,
        expiry_date: l.expiry_date ? checkDate(l.expiry_date) : null,
      });
      const b = inv.receiveNewBatch(ctx, {
        doc, lineId, itemId: item.id, warehouseId: wh.id, qty: base, cost, batchNo: l.batch_no || doc.number, prodDate: l.prod_date || null, expiryDate: l.expiry_date || null,
      });
      ctx.db.prepare('UPDATE doc_lines SET batch_id=? WHERE id=?').run(b.id, lineId);
      total += cost;
    });
    D.updateDoc(ctx, doc.id, { cost: total, total });
    D.markApproved(ctx, doc);
    ledger.post(ctx, D.getDocRow(ctx, doc.id), [
      { account: 'INVENTORY', warehouse_id: wh.id, debit: total },
      { account: 'OPENING_EQUITY', credit: total },
    ], 'مخزون افتتاحي');
    ctx.audit('opening_stock.create', { entity: 'doc', entity_id: doc.id, doc_number: doc.number, after: { total: fromMinor(total) } });
    return D.fullDoc(ctx, doc.id);
  });
}

/**
 * تحديث تكلفة بنود مخزون افتتاحي أُدخل بلا تكلفة (أو بتكلفة خاطئة):
 * - الكمية الباقية (في أي مستودع انتقلت إليه) تأخذ التكلفة الجديدة
 * - فواتير البيع التي صُرفت منها تُصحَّح تكلفتها حتى يظهر ربحها صحيحًا
 * - قيد تسوية: مخزون (للباقي) + تكلفة مبيعات (لما خرج) مقابل الأرصدة الافتتاحية
 * lines: [{line_id, unit_cost}] (تكلفة وحدة الإدخال للبند)
 */
function updateOpeningCost(ctx, docId, input = {}) {
  ctx.require('opening.manage');
  return ctx.tx(() => {
    const os = D.loadDoc(ctx, docId, 'opening_stock');
    if (os.status !== 'approved') fail('INVALID_STATE', 'المستند غير معتمد');
    const date = ctx.today();
    ctx.checkPeriod(date);
    if (!Array.isArray(input.lines) || !input.lines.length) fail('VALIDATION', 'أدخل تكلفة بند واحد على الأقل');
    const lines = D.docLines(ctx, os.id);
    const inv_ = new Map(); // warehouse_id → فرق قيمة المخزون
    let totalDelta = 0, invDelta = 0, changed = 0;
    const touchedSales = new Set();
    for (const [i, l] of input.lines.entries()) {
      const line = lines.find((x) => x.id === Number(l.line_id));
      if (!line) fail('VALIDATION', `البند ${i + 1} لا يتبع المستند`);
      if (l.unit_cost === '' || l.unit_cost == null) continue;
      const price = toMinor(l.unit_cost, `تكلفة ${line.item_name}`);
      if (price < 0) fail('VALIDATION', 'التكلفة لا يمكن أن تكون سالبة');
      const newCost = mulDiv(line.qty, price, 1000);
      if (newCost === line.cost && price === line.price) continue;
      const Q = line.base_qty;
      const rate = (q) => mulDiv(q, newCost, Q);
      const fam = ctx.db.prepare('SELECT * FROM batches WHERE id=? OR origin_batch_id=?').all(line.batch_id, line.batch_id);
      const famIds = new Set(fam.map((b) => b.id));
      // الباقي في الدفعات
      for (const b of fam) {
        if (b.qty <= 0) continue;
        const nb = rate(b.qty);
        if (nb !== b.cost) {
          ctx.db.prepare('UPDATE batches SET cost=? WHERE id=?').run(nb, b.id);
          inv_.set(b.warehouse_id, (inv_.get(b.warehouse_id) || 0) + nb - b.cost);
          invDelta += nb - b.cost;
        }
      }
      // ما خرج بالبيع: تصحيح تكلفة البند والفاتورة
      // ومرتجعات البيع التي عادت إليها تُصحَّح كذلك (تكلفة المرتجع من تكلفة البيع الأصلية)
      const moves = ctx.db.prepare(`SELECT m.*, d.type FROM stock_moves m JOIN docs d ON d.id=m.doc_id
        WHERE m.batch_id IN (${[...famIds].join(',')}) AND ((m.qty<0 AND d.type='sale') OR (m.qty>0 AND d.type='sale_return'))`).all();
      for (const m of moves) {
        const nc = m.qty < 0 ? -rate(-m.qty) : rate(m.qty);
        const diff = m.qty < 0 ? m.cost - nc : nc - m.cost; // موجب = زيادة تكلفة المستند
        if (!diff) continue;
        ctx.db.prepare('UPDATE stock_moves SET cost=?, returned_cost=? WHERE id=?').run(nc, m.qty < 0 ? rate(m.returned_qty) : m.returned_cost, m.id);
        if (m.line_id) ctx.db.prepare('UPDATE doc_lines SET cost=cost+? WHERE id=?').run(diff, m.line_id);
        ctx.db.prepare('UPDATE docs SET cost=cost+? WHERE id=?').run(diff, m.doc_id);
        touchedSales.add(m.doc_id);
      }
      ctx.db.prepare('UPDATE doc_lines SET price=?, value=?, cost=? WHERE id=?').run(price, newCost, newCost, line.id);
      // سعر الشراء المقترح للصنف إن لم يكن محددًا
      ctx.db.prepare('UPDATE item_units SET purchase_price=? WHERE id=? AND (purchase_price IS NULL OR purchase_price=0)').run(price, line.unit_id);
      totalDelta += newCost - line.cost;
      changed++;
    }
    if (!changed) fail('VALIDATION', 'لم تتغير أي تكلفة');
    const total = ctx.db.prepare('SELECT COALESCE(SUM(cost),0) c FROM doc_lines WHERE doc_id=?').get(os.id).c;
    D.updateDoc(ctx, os.id, { cost: total, total });
    const adj = D.insertDoc(ctx, 'cost_adjust', { date, warehouse_id: os.warehouse_id, ref_doc_id: os.id, total: totalDelta, cost: totalDelta,
      notes: `تحديث تكلفة ${os.number}${input.notes ? ' — ' + input.notes : ''}` });
    D.markApproved(ctx, adj);
    ledger.post(ctx, D.getDocRow(ctx, adj.id), [
      ...[...inv_].map(([wh, v]) => ({ account: 'INVENTORY', warehouse_id: wh, debit: v })),
      { account: 'COGS', debit: totalDelta - invDelta },
      { account: 'OPENING_EQUITY', credit: totalDelta },
    ], `تحديث تكلفة ${os.number}`);
    ctx.audit('opening_stock.cost_update', { entity: 'doc', entity_id: os.id, doc_number: os.number, after: { delta: fromMinor(totalDelta), lines: changed, sales: touchedSales.size } });
    return { ...D.fullDoc(ctx, os.id), adjustment: { id: adj.id, number: adj.number, delta: fromMinor(totalDelta), sales_updated: touchedSales.size } };
  });
}

// ===================== تغيير حالة دفعة (عزل/إفراج/نتيجة فحص المرتجع) =====================
/**
 * نقل كمية من دفعة إلى حالة أخرى: ok | isolated | damaged (تالف يخرج من المخزون كخسارة)
 */
function changeBatchStatus(ctx, { batch_id, qty, to_status, reason }) {
  const b0 = getBatch(ctx, batch_id);
  if (b0.status === 'pending') ctx.requireAny(['sale_returns.inspect', 'stock.batch.change'], 'batch.inspect');
  else ctx.require('stock.batch.change', 'batch.status');
  return ctx.tx(() => {
    const b = getBatch(ctx, batch_id);
    if (!['ok', 'isolated', 'damaged'].includes(to_status)) fail('VALIDATION', 'الحالة الجديدة غير صحيحة');
    if (to_status === b.status) fail('VALIDATION', 'الدفعة بنفس الحالة');
    const r = ctx.requireReason(reason, 'تغيير حالة الدفعة');
    const item = D.getItem(ctx, b.item_id);
    const q = qty == null || qty === '' ? b.qty : D.toBaseQty(item, { factor: 1000 }, qty, 'الكمية').base;
    if (q > b.qty || q <= 0) fail('VALIDATION', `الكمية يجب أن تكون بين 0 و${fromQty(b.qty)}`);
    const date = ctx.today();
    ctx.checkPeriod(date);
    const doc = D.insertDoc(ctx, to_status === 'damaged' ? 'damage' : 'batch_status', {
      date, warehouse_id: b.warehouse_id, reason: r, data: { from_status: b.status, to_status },
    });
    const lineId = D.insertLine(ctx, doc.id, {
      line_no: 1, item_id: item.id, item_name: item.name, unit_name: item.base_unit, factor: 1000, qty: q, base_qty: q, batch_id: b.id,
      batch_no: b.batch_no, expiry_date: b.expiry_date, condition: to_status,
    });
    const t = inv.takeFromBatch(ctx, { doc, lineId, batch: b, qty: q });
    if (to_status === 'damaged') {
      ledger.post(ctx, doc, [{ account: 'INV_LOSS', debit: t.cost }, { account: 'INVENTORY', warehouse_id: b.warehouse_id, credit: t.cost }], 'تالف');
    } else {
      inv.receiveLike(ctx, { doc, lineId, origin: b, warehouseId: b.warehouse_id, status: to_status, qty: q, cost: t.cost });
    }
    ctx.db.prepare('UPDATE doc_lines SET cost=? WHERE id=?').run(t.cost, lineId);
    D.updateDoc(ctx, doc.id, { cost: t.cost });
    D.markApproved(ctx, doc);
    ctx.audit('batch.status', { entity: 'batch', entity_id: b.id, doc_number: doc.number, reason: r, before: { status: b.status }, after: { status: to_status, qty: fromQty(q) } });
    return D.fullDoc(ctx, doc.id);
  });
}

/**
 * استلام تحويل بالطريق في الوجهة: الكميات المستلمة تدخل بنفس الدفعات والتكلفة،
 * والنقص (إن وجد) يُثبت خسارة بسبب موثق.
 * received: [{line_id, qty}] بوحدة البند؛ بدونها يُستلم كل شيء.
 */
function receiveTransfer(ctx, id, { received, reason, date } = {}) {
  ctx.require('stock.transfer');
  return ctx.tx(() => {
    const doc = D.loadDoc(ctx, id, 'transfer');
    const data = D.docData(doc);
    if (doc.status !== 'approved' || data.transit !== 'in_transit') fail('INVALID_STATE', 'التحويل ليس بالطريق');
    const to = getWarehouse(ctx, doc.to_warehouse_id);
    ctx.checkBranch(to.branch_id);
    const d = checkDate(date || ctx.today());
    ctx.checkPeriod(d);
    let got = 0, lost = 0;
    const shortages = [];
    for (const l of D.docLines(ctx, id)) {
      const item = D.getItem(ctx, l.item_id);
      const r = (received || []).find((x) => Number(x.line_id) === l.id);
      let qty = l.base_qty;
      if (r && r.qty !== undefined && r.qty !== null && r.qty !== '') {
        qty = r.qty === 0 || r.qty === '0' ? 0 : D.toBaseQty(item, { factor: l.factor }, r.qty, item.name).base;
      }
      if (qty > l.base_qty) fail('VALIDATION', `الكمية المستلمة من ${item.name} أكبر من المرسلة`);
      let rem = qty;
      const takes = JSON.parse(l.data).takes;
      for (const t of takes) {
        const origin = getBatch(ctx, t.batch_id);
        const q = Math.min(rem, t.qty);
        rem -= q;
        const c = q === t.qty ? t.cost : mulDiv(t.cost, q, t.qty);
        if (q > 0) inv.receiveLike(ctx, { doc, lineId: l.id, origin, warehouseId: to.id, status: origin.status, qty: q, cost: c });
        got += c;
        lost += t.cost - c;
      }
      ctx.db.prepare('UPDATE doc_lines SET received_qty=? WHERE id=?').run(qty, l.id);
      if (qty < l.base_qty) shortages.push(`${item.name}: ${fromQty(l.base_qty - qty)}`);
    }
    const r = shortages.length ? ctx.requireReason(reason, 'نقص الاستلام') : reason || null;
    data.transit = 'received';
    data.received_at = d;
    data.received_by = ctx.userId;
    if (shortages.length) data.shortages = shortages;
    D.updateDoc(ctx, id, { data });
    ledger.post(ctx, doc, [
      { account: 'INVENTORY', warehouse_id: to.id, debit: got },
      { account: 'INV_LOSS', debit: lost },
      { account: 'INVENTORY', warehouse_id: null, credit: got + lost },
    ], 'استلام تحويل', d);
    ctx.audit('transfer.receive', { entity: 'doc', entity_id: id, doc_number: doc.number, reason: r, after: { received_cost: fromMinor(got), shortage_cost: fromMinor(lost), shortages } });
    return D.fullDoc(ctx, id);
  });
}

function reverseTransfer(ctx, id, reason) {
  ctx.require('docs.reverse');
  return ctx.tx(() => {
    const doc = D.loadDoc(ctx, id, 'transfer');
    if (doc.status !== 'approved') fail('INVALID_STATE', 'المستند غير معتمد');
    const r = ctx.requireReason(reason, 'إلغاء التحويل');
    ctx.checkPeriod(doc.date);
    ctx.checkPeriod(ctx.today());
    inv.reverseMoves(ctx, doc);
    D.markReversed(ctx, doc, r);
    ledger.reverseEntries(ctx, doc, ctx.today(), 'إلغاء ' + doc.number);
    const data = D.docData(doc);
    if (data.transit === 'in_transit') { data.transit = 'cancelled'; D.updateDoc(ctx, id, { data }); }
    ctx.audit('transfer.reverse', { entity: 'doc', entity_id: id, doc_number: doc.number, reason: r });
    return D.fullDoc(ctx, id);
  });
}

module.exports = {
  createTransfer, receiveTransfer, reverseTransfer, createDamage, approveDamage, createCount, enterCounts, approveCount, createOpeningStock, updateOpeningCost, changeBatchStatus,
};
