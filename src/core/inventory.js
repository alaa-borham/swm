'use strict';
// سجل حركة المخزون والدفعات. كل تغيير في المخزون ينشئ حركة مرتبطة بمستند مصدر،
// والرصيد يُستخرج من الحركات المعتمدة (جدول الدفعات يحتفظ بالرصيد الجاري لكل دفعة مع تكلفته).
const { fail } = require('../lib/errors');
const { mulDiv, fromQty } = require('../lib/money');
const { addDays } = require('../lib/dates');

/** آخر تاريخ انتهاء مقبول للبيع اليوم: تاريخ الانتهاء >= اليوم + أيام المنع */
function minSellableExpiry(ctx) {
  return addDays(ctx.today(), ctx.settingInt('expiry_block_days') || 0);
}

function sellableBatches(ctx, itemId, warehouseId) {
  return ctx.db.prepare(`SELECT * FROM batches WHERE item_id=? AND warehouse_id=? AND status='ok' AND qty>0
      AND (expiry_date IS NULL OR expiry_date >= ?)
    ORDER BY CASE WHEN expiry_date IS NULL THEN 1 ELSE 0 END, expiry_date, id`).all(itemId, warehouseId, minSellableExpiry(ctx));
}

function sellableQty(ctx, itemId, warehouseId) {
  return ctx.db.prepare(`SELECT COALESCE(SUM(qty),0) q FROM batches WHERE item_id=? AND warehouse_id=? AND status='ok' AND qty>0
      AND (expiry_date IS NULL OR expiry_date >= ?)`).get(itemId, warehouseId, minSellableExpiry(ctx)).q;
}

/** تكلفة جزء من دفعة: نسبي من المتبقي، والسحب الكامل يأخذ كل التكلفة المتبقية لتجنب فروق التقريب */
function batchCost(batch, q) {
  if (q === batch.qty) return batch.cost;
  return mulDiv(batch.cost, q, batch.qty);
}

function recordMove(ctx, { doc, lineId = null, batch, qty, cost, date }) {
  return ctx.db.prepare(`INSERT INTO stock_moves(doc_id,line_id,item_id,batch_id,warehouse_id,qty,cost,date,created_at,user_id)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).run(doc.id, lineId, batch.item_id, batch.id, batch.warehouse_id, qty, cost, date || doc.date, ctx.now(), ctx.userId).lastInsertRowid;
}

/** سحب كمية محددة من دفعة محددة */
function takeFromBatch(ctx, { doc, lineId, batch, qty }) {
  const b = ctx.db.prepare('SELECT * FROM batches WHERE id=?').get(batch.id);
  if (qty <= 0) fail('INVALID_QTY', 'الكمية يجب أن تكون أكبر من صفر');
  if (qty > b.qty) fail('INSUFFICIENT_STOCK', `الكمية المطلوبة (${fromQty(qty)}) أكبر من رصيد الدفعة ${b.batch_no || b.id} (${fromQty(b.qty)})`, 409);
  const cost = batchCost(b, qty);
  ctx.db.prepare('UPDATE batches SET qty=qty-?, cost=cost-? WHERE id=?').run(qty, cost, b.id);
  const moveId = recordMove(ctx, { doc, lineId, batch: b, qty: -qty, cost: -cost });
  return { batch_id: b.id, qty, cost, move_id: moveId, batch: b };
}

/**
 * صرف كمية بالأقرب انتهاءً (FEFO) من الدفعات الصالحة فقط.
 * يرفض العملية إذا لم يكفِ الرصيد الصالح (لا رصيد سالب).
 */
function consumeFefo(ctx, { doc, lineId, itemId, warehouseId, qty, itemName }) {
  const batches = sellableBatches(ctx, itemId, warehouseId);
  const avail = batches.reduce((s, b) => s + b.qty, 0);
  if (avail < qty) {
    fail('INSUFFICIENT_STOCK', `الرصيد الصالح غير كافٍ للصنف ${itemName || itemId}: المطلوب ${fromQty(qty)} والمتاح ${fromQty(avail)}`, 409,
      { item_id: itemId, required: fromQty(qty), available: fromQty(avail) });
  }
  let rem = qty;
  const takes = [];
  for (const b of batches) {
    if (rem === 0) break;
    const t = Math.min(rem, b.qty);
    takes.push(takeFromBatch(ctx, { doc, lineId, batch: b, qty: t }));
    rem -= t;
  }
  return { takes, cost: takes.reduce((s, t) => s + t.cost, 0) };
}

/** إدخال كمية بتكلفة في دفعة جديدة */
function receiveNewBatch(ctx, { doc, lineId, itemId, warehouseId, qty, cost, batchNo, prodDate, expiryDate, status = 'ok', originBatchId = null }) {
  if (qty <= 0) fail('INVALID_QTY', 'الكمية يجب أن تكون أكبر من صفر');
  if (cost < 0) fail('INVALID_COST', 'التكلفة لا يمكن أن تكون سالبة');
  const id = ctx.db.prepare(`INSERT INTO batches(item_id,warehouse_id,batch_no,prod_date,expiry_date,status,qty,cost,source_doc_id,origin_batch_id,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(itemId, warehouseId, batchNo || null, prodDate || null, expiryDate || null, status, qty, cost, doc.id, originBatchId, ctx.now()).lastInsertRowid;
  const batch = ctx.db.prepare('SELECT * FROM batches WHERE id=?').get(id);
  recordMove(ctx, { doc, lineId, batch, qty, cost });
  return batch;
}

/** إضافة كمية لدفعة قائمة (مرتجع صالح لنفس الدفعة) */
function addToBatch(ctx, { doc, lineId, batchId, qty, cost }) {
  ctx.db.prepare('UPDATE batches SET qty=qty+?, cost=cost+? WHERE id=?').run(qty, cost, batchId);
  const batch = ctx.db.prepare('SELECT * FROM batches WHERE id=?').get(batchId);
  recordMove(ctx, { doc, lineId, batch, qty, cost });
  return batch;
}

/**
 * إدخال كمية بنفس بيانات دفعة أصلية في مستودع/حالة: يدمج في دفعة مطابقة إن وجدت، وإلا ينشئ دفعة جديدة.
 */
function receiveLike(ctx, { doc, lineId, origin, warehouseId, status, qty, cost }) {
  const rootId = origin.origin_batch_id || origin.id;
  if (origin.warehouse_id === warehouseId && origin.status === status) {
    return addToBatch(ctx, { doc, lineId, batchId: origin.id, qty, cost });
  }
  const match = ctx.db.prepare(`SELECT id FROM batches WHERE item_id=? AND warehouse_id=? AND status=? AND COALESCE(origin_batch_id,id)=?
      AND COALESCE(expiry_date,'')=COALESCE(?,'') ORDER BY id LIMIT 1`)
    .get(origin.item_id, warehouseId, status, rootId, origin.expiry_date);
  if (match) return addToBatch(ctx, { doc, lineId, batchId: match.id, qty, cost });
  return receiveNewBatch(ctx, {
    doc, lineId, itemId: origin.item_id, warehouseId, qty, cost, batchNo: origin.batch_no, prodDate: origin.prod_date,
    expiryDate: origin.expiry_date, status, originBatchId: rootId,
  });
}

/** عكس كل حركات مستند (لإلغاء مستند معتمد) بشرط توفر الكميات الداخلة */
function reverseMoves(ctx, doc) {
  const moves = ctx.db.prepare('SELECT * FROM stock_moves WHERE doc_id=? ORDER BY id DESC').all(doc.id);
  for (const m of moves) {
    if (m.qty > 0) {
      const b = ctx.db.prepare('SELECT * FROM batches WHERE id=?').get(m.batch_id);
      if (b.qty < m.qty || b.cost < m.cost) fail('CANNOT_REVERSE', `لا يمكن الإلغاء: كمية الدفعة ${b.batch_no || b.id} استُخدمت في حركات لاحقة؛ استخدم مستند تصحيح`, 409);
      ctx.db.prepare('UPDATE batches SET qty=qty-?, cost=cost-? WHERE id=?').run(m.qty, m.cost, b.id);
    } else {
      ctx.db.prepare('UPDATE batches SET qty=qty-?, cost=cost-? WHERE id=?').run(m.qty, m.cost, m.batch_id);
    }
    ctx.db.prepare(`INSERT INTO stock_moves(doc_id,line_id,item_id,batch_id,warehouse_id,qty,cost,date,created_at,user_id)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).run(m.doc_id, m.line_id, m.item_id, m.batch_id, m.warehouse_id, -m.qty, -m.cost, ctx.today(), ctx.now(), ctx.userId);
  }
}

/** ملخص رصيد صنف: صالح/منتهي/معزول/قيد الفحص */
function itemBalance(ctx, itemId, warehouseId) {
  const minExp = minSellableExpiry(ctx);
  const today = ctx.today();
  const w = warehouseId ? 'AND warehouse_id=?' : '';
  const p = warehouseId ? [itemId, warehouseId] : [itemId];
  const r = ctx.db.prepare(`SELECT
      COALESCE(SUM(qty),0) total_qty, COALESCE(SUM(cost),0) total_cost,
      COALESCE(SUM(CASE WHEN status='ok' AND (expiry_date IS NULL OR expiry_date>=?) THEN qty END),0) sellable_qty,
      COALESCE(SUM(CASE WHEN status='ok' AND (expiry_date IS NULL OR expiry_date>=?) THEN cost END),0) sellable_cost,
      COALESCE(SUM(CASE WHEN status='ok' AND expiry_date IS NOT NULL AND expiry_date<? THEN qty END),0) expired_qty,
      COALESCE(SUM(CASE WHEN status='ok' AND expiry_date IS NOT NULL AND expiry_date<? THEN cost END),0) expired_cost,
      COALESCE(SUM(CASE WHEN status='isolated' THEN qty END),0) isolated_qty,
      COALESCE(SUM(CASE WHEN status='isolated' THEN cost END),0) isolated_cost,
      COALESCE(SUM(CASE WHEN status='pending' THEN qty END),0) pending_qty
    FROM batches WHERE item_id=? ${w}`).get(minExp, minExp, today, today, ...p);
  // "منتهي" يشمل الدفعات التي تجاوزت آخر يوم مسموح للبيع
  r.blocked_qty = r.total_qty - r.sellable_qty - r.isolated_qty - r.pending_qty;
  return r;
}

module.exports = {
  minSellableExpiry, sellableBatches, sellableQty, batchCost, recordMove, takeFromBatch, consumeFefo, receiveNewBatch, addToBatch,
  receiveLike, reverseMoves, itemBalance,
};
