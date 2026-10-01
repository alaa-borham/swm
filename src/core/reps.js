'use strict';
// عهد المناديب وعمولاتهم.
const { fail, notFound } = require('../lib/errors');
const { toMinor, fromMinor, fromQty, mulDiv, fromBp } = require('../lib/money');
const { checkDate } = require('../lib/dates');
const ledger = require('./ledger');
const D = require('./docs');
const P = require('./payments');

function getRepRow(ctx, id) {
  const r = ctx.db.prepare('SELECT * FROM reps WHERE id=?').get(id);
  if (!r) notFound('المندوب');
  return r;
}

function planRate(ctx, repId, date) {
  const p = ctx.db.prepare(`SELECT rate_bp FROM commission_plans WHERE rep_id=? AND valid_from<=? AND (valid_to IS NULL OR valid_to>=?)
    ORDER BY valid_from DESC LIMIT 1`).get(repId, date, date);
  return p ? p.rate_bp : null;
}

/**
 * عناصر العمولة المؤهلة غير المحتسبة حتى تاريخ معين:
 * - تحصيل نقدي مخصص لفواتير المندوب: الأساس = الجزء قبل الضريبة بنسبة صافي الفاتورة إلى إجماليها.
 * - رد قيمة مرتجع لفواتير المندوب: أساس سالب.
 * - تحصيل محتسب سابقًا ثم أُلغي: تصحيح سالب.
 */
function eligibleItems(ctx, repId, from, to) {
  const items = [];
  const collections = ctx.db.prepare(`SELECT a.id, a.amount, a.date, t.net, t.total, t.number FROM allocations a
      JOIN docs s ON s.id=a.source_doc_id JOIN docs t ON t.id=a.target_doc_id
    WHERE s.type='receipt' AND t.type='sale' AND t.rep_id=? AND a.reversed=0 AND a.date<=? AND a.date>=?
      AND NOT EXISTS (SELECT 1 FROM commission_items ci JOIN docs cd ON cd.id=ci.commission_doc_id WHERE ci.allocation_id=a.id AND ci.kind='collection' AND cd.status<>'reversed')`)
    .all(repId, to, from || '0000-00-00');
  for (const c of collections) {
    const base = c.total > 0 ? mulDiv(c.amount, c.net, c.total) : 0;
    items.push({ allocation_id: c.id, base, date: c.date, kind: 'collection', ref: c.number });
  }
  const refunds = ctx.db.prepare(`SELECT a.id, a.amount, a.date, t.net, t.total, t.number FROM allocations a
      JOIN docs s ON s.id=a.source_doc_id JOIN docs t ON t.id=a.target_doc_id
    WHERE s.type='payment' AND t.type='sale_return' AND t.rep_id=? AND a.reversed=0 AND a.date<=? AND a.date>=?
      AND NOT EXISTS (SELECT 1 FROM commission_items ci JOIN docs cd ON cd.id=ci.commission_doc_id WHERE ci.allocation_id=a.id AND cd.status<>'reversed')`)
    .all(repId, to, from || '0000-00-00');
  for (const r of refunds) {
    const base = r.total > 0 ? -mulDiv(r.amount, r.net, r.total) : 0;
    items.push({ allocation_id: r.id, base, date: r.date, kind: 'correction', ref: r.number });
  }
  const reversed = ctx.db.prepare(`SELECT ci.allocation_id, ci.base, ci.rate_bp, a.date FROM commission_items ci JOIN allocations a ON a.id=ci.allocation_id
      JOIN docs cd ON cd.id=ci.commission_doc_id
    WHERE cd.rep_id=? AND cd.status<>'reversed' AND ci.kind='collection' AND a.reversed=1
      AND NOT EXISTS (SELECT 1 FROM commission_items c2 JOIN docs d2 ON d2.id=c2.commission_doc_id WHERE c2.allocation_id=ci.allocation_id AND c2.kind='correction' AND d2.status<>'reversed')`)
    .all(repId);
  for (const r of reversed) items.push({ allocation_id: r.allocation_id, base: -r.base, rate_bp: r.rate_bp, date: r.date, kind: 'correction', ref: 'إلغاء تحصيل' });
  return items;
}

/** حساب عمولة فترة (مسودة قابلة للمراجعة) */
function calculateCommission(ctx, { rep_id, from, to }) {
  ctx.require('commissions.manage');
  return ctx.tx(() => {
    const rep = getRepRow(ctx, rep_id);
    const t = checkDate(to || ctx.today(), 'نهاية الفترة');
    const f = from ? checkDate(from, 'بداية الفترة') : null;
    if (ctx.db.prepare("SELECT 1 FROM docs WHERE type='commission' AND rep_id=? AND status='draft'").get(rep.id)) {
      fail('DRAFT_EXISTS', 'توجد عمولة مسودة لهذا المندوب؛ اعتمدها أو ألغها أولاً', 409);
    }
    const items = eligibleItems(ctx, rep.id, f, t);
    if (!items.length) fail('NOTHING_TO_CALC', 'لا يوجد تحصيل مؤهل غير محتسب في الفترة', 409);
    const doc = D.insertDoc(ctx, 'commission', {
      date: t, rep_id: rep.id, ledger_account: 'COMMISSION_PAYABLE', ledger_side: 'C', data: { from: f, to: t },
    });
    let total = 0, base = 0;
    for (const it of items) {
      const rate = it.rate_bp ?? planRate(ctx, rep.id, it.date);
      if (rate == null) fail('NO_PLAN', `لا توجد خطة عمولة سارية للمندوب ${rep.name} بتاريخ ${it.date}`);
      const amount = mulDiv(it.base, rate, 10000);
      ctx.db.prepare('INSERT INTO commission_items(commission_doc_id,allocation_id,base,rate_bp,amount,kind) VALUES(?,?,?,?,?,?)')
        .run(doc.id, it.allocation_id, it.base, rate, amount, it.kind);
      total += amount; base += it.base;
    }
    // صافي سالب = تصحيح لصالح المؤسسة يُخصم من عمولات المندوب المستحقة
    D.updateDoc(ctx, doc.id, { net: base, total: Math.abs(total), ledger_side: total < 0 ? 'D' : 'C' });
    ctx.audit('commission.calc', { entity: 'doc', entity_id: doc.id, doc_number: doc.number, after: { base: fromMinor(base), total: fromMinor(total) } });
    return commissionDetail(ctx, doc.id);
  });
}

function commissionDetail(ctx, id) {
  const d = D.fullDoc(ctx, id);
  d.items = ctx.db.prepare(`SELECT ci.*, a.date, a.amount alloc_amount, s.number source_number, t.number target_number FROM commission_items ci
    JOIN allocations a ON a.id=ci.allocation_id JOIN docs s ON s.id=a.source_doc_id JOIN docs t ON t.id=a.target_doc_id
    WHERE ci.commission_doc_id=? ORDER BY a.date, ci.id`).all(id).map((r) => ({ ...D.present(r), alloc_amount: fromMinor(r.alloc_amount) }));
  return d;
}

/** اعتماد العمولة يثبت المصروف والاستحقاق مرة واحدة */
function approveCommission(ctx, id) {
  ctx.require('commissions.manage');
  return ctx.tx(() => {
    const doc = D.loadDoc(ctx, id, 'commission');
    if (doc.status !== 'draft') fail('INVALID_STATE', 'العمولة ليست مسودة');
    ctx.checkPeriod(doc.date);
    D.markApproved(ctx, doc);
    const signed = doc.ledger_side === 'D' ? -doc.total : doc.total;
    ledger.post(ctx, doc, [
      { account: 'COMMISSION_EXP', debit: signed, rep_id: doc.rep_id },
      { account: 'COMMISSION_PAYABLE', rep_id: doc.rep_id, credit: signed },
    ], doc.ledger_side === 'D' ? 'تصحيح عمولة' : 'عمولة مندوب');
    // مقاصة تلقائية بين العمولات والتصحيحات المفتوحة لنفس المندوب
    const others = ctx.db.prepare(`SELECT * FROM docs WHERE type='commission' AND status='approved' AND rep_id=? AND ledger_side<>? AND id<>? ORDER BY date, id`)
      .all(doc.rep_id, doc.ledger_side, doc.id);
    for (const o of others) {
      const a = Math.min(D.openAmount(ctx, doc.id), D.openAmount(ctx, o.id));
      if (a > 0) D.allocate(ctx, doc.ledger_side === 'D' ? doc : o, doc.ledger_side === 'D' ? o : doc, a, doc.date);
    }
    ctx.audit('commission.approve', { entity: 'doc', entity_id: id, doc_number: doc.number, after: { total: fromMinor(doc.total) } });
    return commissionDetail(ctx, id);
  });
}

function cancelCommissionDraft(ctx, id, reason) {
  ctx.require('commissions.manage');
  return ctx.tx(() => {
    const doc = D.loadDoc(ctx, id, 'commission');
    if (doc.status !== 'draft') fail('INVALID_STATE', 'لا تُلغى إلا المسودة');
    D.markReversed(ctx, doc, ctx.requireReason(reason, 'إلغاء مسودة العمولة'));
    ctx.audit('commission.cancel', { entity: 'doc', entity_id: id, doc_number: doc.number, reason });
    return commissionDetail(ctx, id);
  });
}

/** دفع العمولة يسوي الاستحقاق؛ الدفع الثاني لنفس المبلغ يُرفض لعدم وجود متبقٍ */
function payCommission(ctx, id, { cash_account_id, amount, date }) {
  ctx.require('commissions.pay');
  return ctx.tx(() => {
    const doc = D.loadDoc(ctx, id, 'commission');
    if (doc.status !== 'approved') fail('INVALID_STATE', 'العمولة غير معتمدة');
    if (doc.ledger_side === 'D') fail('VALIDATION', 'هذا تصحيح لصالح المؤسسة ولا يُدفع');
    const open = D.openAmount(ctx, id);
    if (open <= 0) fail('ALREADY_PAID', `العمولة ${doc.number} مدفوعة بالكامل`, 409);
    const amt = amount != null && amount !== '' ? toMinor(amount) : open;
    if (amt > open) fail('OVER_ALLOCATION', `المبلغ أكبر من المتبقي (${fromMinor(open)})`, 409);
    P.cashDocInTx(ctx, 'payment', {
      account: 'COMMISSION_PAYABLE', rep_id: doc.rep_id, amount_minor: amt, cash_account_id, date: date || ctx.today(), ref_doc_id: id,
      allocations: [{ doc_id: id, amount_minor: amt }], notes: `دفع ${doc.number}`,
    });
    return commissionDetail(ctx, id);
  });
}

/** كشف عهدة المندوب: البضاعة في مخزونه والنقد في عهدته وحركاتهما */
function custodyStatement(ctx, repId, { from, to } = {}) {
  ctx.require('reps.view');
  const rep = getRepRow(ctx, repId);
  const f = from || '0000-00-00', t = to || '9999-12-31';
  const goods = ctx.db.prepare(`SELECT i.id item_id, i.name, i.base_unit, SUM(b.qty) qty, SUM(b.cost) cost FROM batches b JOIN items i ON i.id=b.item_id
    WHERE b.warehouse_id=? AND b.qty>0 GROUP BY i.id ORDER BY i.name`).all(rep.warehouse_id)
    .map((g) => ({ ...g, qty: fromQty(g.qty), cost: ctx.has('cost.view') ? fromMinor(g.cost) : undefined }));
  const moves = ctx.db.prepare(`SELECT d.type, COALESCE(SUM(jl.debit),0) d, COALESCE(SUM(jl.credit),0) c FROM journal_lines jl JOIN docs d ON d.id=jl.doc_id
    WHERE jl.account='CASH' AND jl.cash_account_id=? AND jl.date BETWEEN ? AND ? GROUP BY d.type`).all(rep.custody_account_id, f, t);
  const sum = (type, col) => moves.filter((m) => m.type === type).reduce((s, m) => s + m[col], 0);
  const goodsIn = ctx.db.prepare(`SELECT COALESCE(SUM(sm.qty),0) q, COALESCE(SUM(sm.cost),0) c FROM stock_moves sm JOIN docs d ON d.id=sm.doc_id
    WHERE sm.warehouse_id=? AND d.type='transfer' AND sm.qty>0 AND sm.date BETWEEN ? AND ?`).get(rep.warehouse_id, f, t);
  const sold = ctx.db.prepare(`SELECT COALESCE(SUM(net),0) net, COALESCE(SUM(total),0) total, COALESCE(SUM(cost),0) cost, COUNT(*) n FROM docs
    WHERE type='sale' AND status='approved' AND rep_id=? AND date BETWEEN ? AND ?`).get(rep.id, f, t);
  const balance = P.cashBalance(ctx, rep.custody_account_id);
  return {
    rep: { id: rep.id, name: rep.name },
    goods,
    goods_value: ctx.has('cost.view') ? fromMinor(ctx.db.prepare('SELECT COALESCE(SUM(cost),0) c FROM batches WHERE warehouse_id=?').get(rep.warehouse_id).c) : undefined,
    goods_received_cost: ctx.has('cost.view') ? fromMinor(goodsIn.c) : undefined,
    sales: { count: sold.n, total: fromMinor(sold.total), net: fromMinor(sold.net) },
    collections: fromMinor(sum('receipt', 'd')),
    remittances: fromMinor(sum('cash_transfer', 'c')),
    expenses: fromMinor(sum('payment', 'c')),
    adjustments: fromMinor(sum('custody_settlement', 'd') - sum('custody_settlement', 'c')),
    cash_balance: fromMinor(balance),
    status: balance === 0 && !goods.length ? 'مسواة' : 'مسلمة',
  };
}

/** تسوية العهدة النقدية: النقد المعدود مقابل رصيد العهدة، والفرق يُعتمد بسبب */
function settleCustody(ctx, repId, { counted_cash, reason, date }) {
  ctx.require('reps.custody');
  return ctx.tx(() => {
    const rep = getRepRow(ctx, repId);
    const d = checkDate(date || ctx.today());
    ctx.checkPeriod(d);
    const bal = P.cashBalance(ctx, rep.custody_account_id);
    const counted = toMinor(counted_cash, 'النقد المعدود');
    const diff = counted - bal;
    const r = diff !== 0 ? ctx.requireReason(reason, 'فرق العهدة') : (reason || null);
    const doc = D.insertDoc(ctx, 'custody_settlement', {
      date: d, status: 'approved', rep_id: rep.id, cash_account_id: rep.custody_account_id, net: diff, total: Math.abs(diff), reason: r,
      data: { book_balance: fromMinor(bal), counted: fromMinor(counted) }, approved_by: ctx.userId, approved_at: ctx.now(),
    });
    ledger.post(ctx, doc, [
      { account: 'CASH', cash_account_id: rep.custody_account_id, debit: diff },
      { account: 'CASH_OVER_SHORT', credit: diff, rep_id: rep.id },
    ], 'تسوية عهدة');
    ctx.audit('custody.settle', { entity: 'rep', entity_id: rep.id, doc_number: doc.number, reason: r, after: { book: fromMinor(bal), counted: fromMinor(counted) } });
    return { doc: D.fullDoc(ctx, doc.id), statement: custodyStatement(ctx, rep.id) };
  });
}

function commissionPreview(ctx, { rep_id, from, to }) {
  ctx.require('commissions.manage');
  const rep = getRepRow(ctx, rep_id);
  const items = eligibleItems(ctx, rep.id, from || null, to || ctx.today());
  return items.map((it) => {
    const rate = it.rate_bp ?? planRate(ctx, rep.id, it.date);
    return { ...it, base: fromMinor(it.base), rate: rate == null ? null : fromBp(rate), amount: rate == null ? null : fromMinor(mulDiv(it.base, rate, 10000)) };
  });
}

module.exports = { calculateCommission, approveCommission, cancelCommissionDraft, payCommission, commissionDetail, custodyStatement, settleCustody, commissionPreview };
