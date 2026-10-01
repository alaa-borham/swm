'use strict';
// المصروفات، الورديات، الأرصدة الافتتاحية للأطراف والصناديق، وإقفال الفترات.
const { fail, notFound } = require('../lib/errors');
const { toMinor, fromMinor, toBp, mulDiv } = require('../lib/money');
const { checkDate } = require('../lib/dates');
const ledger = require('./ledger');
const D = require('./docs');
const P = require('./payments');

// ===================== المصروفات =====================
/**
 * input: {date, expense_category_id, party_id?, beneficiary, amount (قبل الضريبة), tax_pct?, description, approve?, pay?: {cash_account_id, method}}
 * الاعتماد يثبت المصروف والاستحقاق مرة واحدة، والسداد يخصم النقد أو يسوي الاستحقاق.
 */
function createExpense(ctx, input) {
  ctx.require('expenses.create');
  return ctx.tx(() => {
    const date = checkDate(input.date || ctx.today());
    const cat = ctx.db.prepare('SELECT * FROM expense_categories WHERE id=?').get(input.expense_category_id);
    if (!cat) fail('VALIDATION', 'حدد تصنيف المصروف');
    const net = toMinor(input.amount, 'المبلغ');
    if (net <= 0) fail('INVALID_AMOUNT', 'المبلغ يجب أن يكون أكبر من صفر');
    const taxBp = input.tax_pct != null && input.tax_pct !== '' ? toBp(input.tax_pct, 'الضريبة') : 0;
    const tax = mulDiv(net, taxBp, 10000);
    if (input.party_id && !ctx.db.prepare('SELECT 1 FROM parties WHERE id=?').get(input.party_id)) notFound('الطرف');
    const doc = D.insertDoc(ctx, 'expense', {
      date, expense_category_id: cat.id, party_id: input.party_id || null, ledger_account: 'AP', ledger_side: 'C',
      net, tax, total: net + tax, notes: input.description || null,
      data: { beneficiary: input.beneficiary || null, tax_rate_bp: taxBp, pay: input.pay || null },
    });
    D.insertLine(ctx, doc.id, { line_no: 1, description: input.description || cat.name, amount: net, tax_rate_bp: taxBp, tax, total: net + tax });
    if (input.attachment_ids) {
      for (const aid of input.attachment_ids) ctx.db.prepare('UPDATE attachments SET doc_id=? WHERE id=? AND doc_id IS NULL').run(doc.id, aid);
    }
    ctx.audit('expense.draft', { entity: 'doc', entity_id: doc.id, doc_number: doc.number });
    if (input.approve && ctx.has('expenses.approve')) approveExpenseInTx(ctx, D.getDocRow(ctx, doc.id), input.pay);
    return D.fullDoc(ctx, doc.id);
  });
}

function approveExpense(ctx, id, input = {}) {
  return ctx.tx(() => { approveExpenseInTx(ctx, D.loadDoc(ctx, id, 'expense'), input.pay); return D.fullDoc(ctx, id); });
}

function approveExpenseInTx(ctx, doc, pay) {
  ctx.require('expenses.approve');
  if (doc.status !== 'draft') fail('INVALID_STATE', 'المصروف ليس مسودة');
  ctx.checkPeriod(doc.date);
  D.markApproved(ctx, doc);
  const recoverable = ctx.setting('tax_recoverable') !== '0';
  ledger.post(ctx, doc, [
    { account: 'EXPENSES', expense_category_id: doc.expense_category_id, debit: doc.net + (recoverable ? 0 : doc.tax) },
    { account: 'TAX_IN', debit: recoverable ? doc.tax : 0 },
    { account: 'AP', party_id: doc.party_id, credit: doc.total },
  ], 'مصروف');
  ctx.audit('expense.approve', { entity: 'doc', entity_id: doc.id, doc_number: doc.number, after: { total: fromMinor(doc.total) } });
  if (pay && (pay.cash_account_id || pay.method)) payExpenseInTx(ctx, D.getDocRow(ctx, doc.id), pay);
}

function payExpenseInTx(ctx, doc, pay) {
  ctx.require('cash.payment');
  const open = D.openAmount(ctx, doc.id);
  if (open <= 0) fail('ALREADY_PAID', 'المصروف مدفوع بالكامل', 409);
  const amount = pay.amount != null && pay.amount !== '' ? toMinor(pay.amount) : open;
  return P.cashDocInTx(ctx, 'payment', {
    account: 'AP', party_id: doc.party_id, amount_minor: amount, cash_account_id: pay.cash_account_id, method: pay.method,
    date: pay.date || ctx.today(), ref_doc_id: doc.id, allocations: [{ doc_id: doc.id, amount_minor: amount }], notes: `سداد ${doc.number}`,
  });
}

function payExpense(ctx, id, pay) {
  return ctx.tx(() => {
    const doc = D.loadDoc(ctx, id, 'expense');
    if (doc.status !== 'approved') fail('INVALID_STATE', 'المصروف غير معتمد');
    payExpenseInTx(ctx, doc, pay || {});
    return D.fullDoc(ctx, id);
  });
}

function reverseExpense(ctx, id, reason) {
  ctx.require('docs.reverse');
  return ctx.tx(() => {
    const doc = D.loadDoc(ctx, id, 'expense');
    if (doc.status !== 'approved') fail('INVALID_STATE', 'المصروف غير معتمد');
    const r = ctx.requireReason(reason, 'إلغاء المصروف');
    ctx.checkPeriod(doc.date);
    ctx.checkPeriod(ctx.today());
    if (ctx.db.prepare('SELECT 1 FROM allocations WHERE target_doc_id=? AND reversed=0').get(id)) fail('HAS_DEPENDENTS', 'المصروف مدفوع؛ ألغِ سند الصرف أولاً', 409);
    D.markReversed(ctx, doc, r);
    ledger.reverseEntries(ctx, doc, ctx.today(), 'إلغاء ' + doc.number);
    ctx.audit('expense.reverse', { entity: 'doc', entity_id: id, doc_number: doc.number, reason: r });
    return D.fullDoc(ctx, id);
  });
}

// ===================== الورديات =====================
function openSession(ctx, { cash_account_id, card_account_id, opening_amount, warehouse_id }) {
  ctx.require('sessions.own');
  return ctx.tx(() => {
    if (P.openSessionFor(ctx, ctx.userId)) fail('SESSION_OPEN', 'لديك وردية مفتوحة بالفعل', 409);
    const acc = P.getCashAccount(ctx, cash_account_id);
    if (acc.kind !== 'cash') fail('VALIDATION', 'الوردية تكون على صندوق نقدي');
    const busy = ctx.db.prepare("SELECT s.number, u.full_name FROM cash_sessions s JOIN users u ON u.id=s.user_id WHERE s.cash_account_id=? AND s.status<>'closed'").get(acc.id);
    if (busy) fail('SESSION_OPEN', `الصندوق مستخدم في الوردية ${busy.number} (${busy.full_name})`, 409);
    if (card_account_id) { const c = P.getCashAccount(ctx, card_account_id); if (c.kind !== 'bank') fail('VALIDATION', 'حساب الشبكة يجب أن يكون بنكيًا'); }
    const opening = toMinor(opening_amount ?? 0, 'رصيد الافتتاح');
    if (opening < 0) fail('VALIDATION', 'رصيد الافتتاح لا يكون سالبًا');
    const number = D.nextNumber(ctx, 'session');
    const id = ctx.db.prepare(`INSERT INTO cash_sessions(number,user_id,cash_account_id,card_account_id,warehouse_id,status,opening_amount,opened_at)
      VALUES(?,?,?,?,?,'open',?,?)`).run(number, ctx.userId, acc.id, card_account_id || null, warehouse_id || null, opening, ctx.now()).lastInsertRowid;
    ctx.audit('session.open', { entity: 'session', entity_id: id, doc_number: number, after: { opening: fromMinor(opening), cash: acc.name } });
    return getSession(ctx, id);
  });
}

/** النقد المتوقع = الافتتاحي + المقبوضات النقدية + التحويلات الداخلة - المدفوعات النقدية - التحويلات الخارجة (داخل الوردية) */
function sessionExpected(ctx, s) {
  const r = ctx.db.prepare(`SELECT COALESCE(SUM(jl.debit),0) d, COALESCE(SUM(jl.credit),0) c FROM journal_lines jl JOIN docs d ON d.id=jl.doc_id
    WHERE jl.account='CASH' AND jl.cash_account_id=? AND d.session_id=? AND d.type<>'session_variance'`).get(s.cash_account_id, s.id);
  const breakdown = ctx.db.prepare(`SELECT d.type, COALESCE(SUM(jl.debit),0) d, COALESCE(SUM(jl.credit),0) c FROM journal_lines jl JOIN docs d ON d.id=jl.doc_id
    WHERE jl.account='CASH' AND jl.cash_account_id=? AND d.session_id=? AND d.type<>'session_variance' GROUP BY d.type`).all(s.cash_account_id, s.id);
  const card = s.card_account_id ? ctx.db.prepare(`SELECT COALESCE(SUM(jl.debit-jl.credit),0) v FROM journal_lines jl JOIN docs d ON d.id=jl.doc_id
    WHERE jl.account='CASH' AND jl.cash_account_id=? AND d.session_id=?`).get(s.card_account_id, s.id).v : 0;
  return { expected: s.opening_amount + r.d - r.c, cash_in: r.d, cash_out: r.c, card, breakdown };
}

function getSession(ctx, id) {
  const s = ctx.db.prepare(`SELECT s.*, u.full_name user_name, c.name cash_account_name, b.name card_account_name FROM cash_sessions s
    JOIN users u ON u.id=s.user_id JOIN cash_accounts c ON c.id=s.cash_account_id LEFT JOIN cash_accounts b ON b.id=s.card_account_id WHERE s.id=?`).get(id);
  if (!s) notFound('الوردية');
  if (s.user_id !== ctx.userId) ctx.require('sessions.manage');
  const e = sessionExpected(ctx, s);
  const out = D.present(s);
  out.live_expected = fromMinor(e.expected);
  out.cash_in = fromMinor(e.cash_in);
  out.cash_out = fromMinor(e.cash_out);
  out.card_total = fromMinor(e.card);
  out.breakdown = e.breakdown.map((b) => ({ type: b.type, label: D.DOC_LABELS[b.type], in: fromMinor(b.d), out: fromMinor(b.c) }));
  out.sales_count = ctx.db.prepare("SELECT COUNT(*) n FROM docs WHERE session_id=? AND type='sale' AND status='approved'").get(id).n;
  return out;
}

/** إغلاق الوردية بعد إدخال النقد المعدود؛ الفرق يظهر منفصلاً ويُعتمد بسبب */
function closeSession(ctx, id, { counted_amount, reason }) {
  return ctx.tx(() => {
    const s = ctx.db.prepare('SELECT * FROM cash_sessions WHERE id=?').get(id);
    if (!s) notFound('الوردية');
    if (s.user_id !== ctx.userId) ctx.require('sessions.manage'); else ctx.require('sessions.own');
    if (s.status !== 'open') fail('INVALID_STATE', 'الوردية ليست مفتوحة');
    const counted = toMinor(counted_amount, 'النقد المعدود');
    if (counted < 0) fail('VALIDATION', 'النقد المعدود لا يكون سالبًا');
    const { expected } = sessionExpected(ctx, s);
    const variance = counted - expected;
    let r = null;
    if (variance !== 0) r = ctx.requireReason(reason, 'فرق الوردية');
    ctx.db.prepare(`UPDATE cash_sessions SET status=?, expected_amount=?, counted_amount=?, variance=?, variance_reason=?, closed_at=? WHERE id=?`)
      .run(variance === 0 ? 'closed' : 'closing', expected, counted, variance, r, ctx.now(), id);
    ctx.audit('session.close', { entity: 'session', entity_id: id, doc_number: s.number, reason: r, after: { expected: fromMinor(expected), counted: fromMinor(counted), variance: fromMinor(variance) } });
    if (variance !== 0 && ctx.has('sessions.manage') && s.user_id !== ctx.userId) approveVarianceInTx(ctx, id);
    return getSession(ctx, id);
  });
}

function approveVarianceInTx(ctx, id) {
  ctx.require('sessions.manage');
  const s = ctx.db.prepare('SELECT * FROM cash_sessions WHERE id=?').get(id);
  if (s.status !== 'closing') fail('INVALID_STATE', 'الوردية ليست بانتظار اعتماد الفرق');
  const date = ctx.today();
  ctx.checkPeriod(date);
  const doc = D.insertDoc(ctx, 'session_variance', {
    date, status: 'approved', cash_account_id: s.cash_account_id, session_id: s.id, total: Math.abs(s.variance), net: s.variance,
    reason: s.variance_reason, approved_by: ctx.userId, approved_at: ctx.now(),
  });
  ledger.post(ctx, doc, [
    { account: 'CASH', cash_account_id: s.cash_account_id, debit: s.variance },
    { account: 'CASH_OVER_SHORT', credit: s.variance },
  ], 'فرق وردية');
  ctx.db.prepare("UPDATE cash_sessions SET status='closed', variance_doc_id=?, approved_by=? WHERE id=?").run(doc.id, ctx.userId, id);
  ctx.audit('session.variance_approve', { entity: 'session', entity_id: id, doc_number: doc.number, reason: s.variance_reason });
}

function approveSessionVariance(ctx, id) {
  return ctx.tx(() => { approveVarianceInTx(ctx, id); return getSession(ctx, id); });
}

function reopenSession(ctx, id, reason) {
  ctx.require('sessions.manage');
  return ctx.tx(() => {
    const s = ctx.db.prepare('SELECT * FROM cash_sessions WHERE id=?').get(id);
    if (!s) notFound('الوردية');
    if (s.status === 'open') fail('INVALID_STATE', 'الوردية مفتوحة');
    const r = ctx.requireReason(reason, 'إعادة فتح وردية مغلقة');
    if (ctx.db.prepare("SELECT 1 FROM cash_sessions WHERE user_id=? AND status='open'").get(s.user_id)) fail('SESSION_OPEN', 'للمستخدم وردية مفتوحة أخرى', 409);
    if (s.variance_doc_id) {
      const vd = D.getDocRow(ctx, s.variance_doc_id);
      ctx.checkPeriod(ctx.today());
      D.markReversed(ctx, vd, r);
      ledger.reverseEntries(ctx, vd, ctx.today(), 'إعادة فتح الوردية');
    }
    ctx.db.prepare("UPDATE cash_sessions SET status='open', expected_amount=NULL, counted_amount=NULL, variance=NULL, variance_reason=NULL, variance_doc_id=NULL, closed_at=NULL WHERE id=?").run(id);
    ctx.audit('session.reopen', { entity: 'session', entity_id: id, doc_number: s.number, reason: r });
    return getSession(ctx, id);
  });
}

function listSessions(ctx, { status, user_id } = {}) {
  const w = ['1=1'];
  const p = [];
  if (!ctx.has('sessions.manage')) { w.push('s.user_id=?'); p.push(ctx.userId); } else if (user_id) { w.push('s.user_id=?'); p.push(user_id); }
  if (status) { w.push('s.status=?'); p.push(status); }
  return ctx.db.prepare(`SELECT s.*, u.full_name user_name, c.name cash_account_name FROM cash_sessions s JOIN users u ON u.id=s.user_id
    JOIN cash_accounts c ON c.id=s.cash_account_id WHERE ${w.join(' AND ')} ORDER BY s.id DESC LIMIT 200`).all(...p).map(D.present);
}

// ===================== الأرصدة الافتتاحية =====================
/**
 * رصيد افتتاحي لطرف أو صندوق بمستند مؤرخ.
 * kind: customer (مدين على العميل) | supplier (دائن للمورد) | cash
 */
function createOpeningBalance(ctx, { kind, party_id, cash_account_id, amount, date, notes }) {
  ctx.require('opening.manage');
  return ctx.tx(() => {
    const d = checkDate(date || ctx.today());
    ctx.checkPeriod(d);
    let amt = toMinor(amount, 'المبلغ');
    if (amt === 0) fail('INVALID_AMOUNT', 'المبلغ لا يكون صفرًا');
    let doc;
    if (kind === 'cash') {
      const acc = P.getCashAccount(ctx, cash_account_id);
      if (amt < 0) fail('VALIDATION', 'رصيد الصندوق الافتتاحي لا يكون سالبًا');
      doc = D.insertDoc(ctx, 'opening_balance', { date: d, cash_account_id: acc.id, total: amt, net: amt, notes: notes || 'رصيد افتتاحي', status: 'approved', approved_by: ctx.userId, approved_at: ctx.now() });
      ledger.post(ctx, doc, [{ account: 'CASH', cash_account_id: acc.id, debit: amt }, { account: 'OPENING_EQUITY', credit: amt }], 'رصيد افتتاحي');
    } else if (kind === 'customer' || kind === 'supplier') {
      const p = ctx.db.prepare('SELECT * FROM parties WHERE id=?').get(party_id);
      if (!p) notFound('الطرف');
      const account = kind === 'customer' ? 'AR' : 'AP';
      // موجب: على العميل / للمورد. سالب: رصيد معاكس
      const side = kind === 'customer' ? (amt > 0 ? 'D' : 'C') : (amt > 0 ? 'C' : 'D');
      const abs = Math.abs(amt);
      doc = D.insertDoc(ctx, 'opening_balance', {
        date: d, party_id: p.id, ledger_account: account, ledger_side: side, total: abs, net: abs, notes: notes || 'رصيد افتتاحي',
        status: 'approved', approved_by: ctx.userId, approved_at: ctx.now(), due_date: d,
      });
      const debitParty = side === 'D';
      ledger.post(ctx, doc, [
        { account, party_id: p.id, debit: debitParty ? abs : 0, credit: debitParty ? 0 : abs },
        { account: 'OPENING_EQUITY', debit: debitParty ? 0 : abs, credit: debitParty ? abs : 0 },
      ], 'رصيد افتتاحي');
      amt = abs;
    } else fail('VALIDATION', 'نوع الرصيد الافتتاحي غير صحيح');
    ctx.audit('opening_balance.create', { entity: 'doc', entity_id: doc.id, doc_number: doc.number, after: { kind, amount } });
    return D.fullDoc(ctx, doc.id);
  });
}

// ===================== إقفال الفترات =====================
function lockPeriod(ctx, { until, reason }) {
  ctx.require('period.lock');
  return ctx.tx(() => {
    const prev = ctx.setting('locked_until') || '';
    if (until) checkDate(until, 'تاريخ الإقفال');
    const r = until && prev && until < prev ? ctx.requireReason(reason, 'إعادة فتح فترة مقفلة') : (until ? reason || null : ctx.requireReason(reason, 'إلغاء الإقفال'));
    ctx.db.prepare("INSERT INTO settings(key,value) VALUES('locked_until',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(until || '');
    ctx.invalidateSettings();
    ctx.audit(until && (!prev || until >= prev) ? 'period.lock' : 'period.reopen', { entity: 'settings', reason: r, before: { locked_until: prev }, after: { locked_until: until || '' } });
    return { locked_until: until || '' };
  });
}

module.exports = {
  createExpense, approveExpense, payExpense, reverseExpense, openSession, closeSession, getSession, listSessions, approveSessionVariance,
  reopenSession, sessionExpected, createOpeningBalance, lockPeriod,
};
