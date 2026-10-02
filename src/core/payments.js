'use strict';
// سندات القبض والصرف والتخصيص والتحويلات النقدية.
const { fail, notFound } = require('../lib/errors');
const { toMinor, fromMinor } = require('../lib/money');
const ledger = require('./ledger');
const D = require('./docs');

const ACCOUNT_LABEL = { AR: 'العملاء', AP: 'الموردين والمستحقات', COMMISSION_PAYABLE: 'عمولات المناديب' };

function getCashAccount(ctx, id) {
  const a = ctx.db.prepare('SELECT * FROM cash_accounts WHERE id=?').get(id);
  if (!a) notFound('الصندوق أو البنك');
  if (!a.active) fail('INACTIVE', `الحساب ${a.name} موقوف`);
  return a;
}

function openSessionFor(ctx, userId) {
  if (!userId) return null;
  return ctx.db.prepare("SELECT * FROM cash_sessions WHERE user_id=? AND status='open'").get(userId) || null;
}

/**
 * تحديد الحساب النقدي للدفع: صريح، أو حسب الطريقة من وردية المستخدم، أو عهدة المندوب.
 * يعيد {account, session_id}
 */
function resolveCashAccount(ctx, { cash_account_id, method }) {
  const session = openSessionFor(ctx, ctx.userId);
  if (ctx.repScope) {
    const rep = ctx.db.prepare('SELECT * FROM reps WHERE id=?').get(ctx.repScope);
    if (method === 'card' || method === 'bank') {
      const acc = cash_account_id ? getCashAccount(ctx, cash_account_id) : null;
      if (!acc || acc.kind !== 'bank') fail('VALIDATION', 'حدد الحساب البنكي للدفع الإلكتروني');
      return { account: acc, session_id: null };
    }
    if (cash_account_id && Number(cash_account_id) !== rep.custody_account_id) fail('FORBIDDEN', 'التحصيل النقدي للمندوب يسجل في عهدته فقط', 403);
    return { account: getCashAccount(ctx, rep.custody_account_id), session_id: null };
  }
  let acc;
  if (cash_account_id) acc = getCashAccount(ctx, cash_account_id);
  else if (method === 'card' || method === 'bank') {
    acc = session && session.card_account_id ? getCashAccount(ctx, session.card_account_id)
      : ctx.db.prepare("SELECT * FROM cash_accounts WHERE kind='bank' AND active=1 ORDER BY id LIMIT 1").get();
    if (!acc) fail('VALIDATION', 'لا يوجد حساب بنكي معرف');
  } else if (session) acc = getCashAccount(ctx, session.cash_account_id);
  else fail('NO_SESSION', 'حدد الصندوق أو افتح وردية لاستلام النقد');
  if (acc.kind === 'rep_custody' && !ctx.has('reps.custody')) fail('FORBIDDEN', 'لا يمكن استخدام عهدة مندوب', 403);
  // المستخدم بلا صلاحية عرض الصناديق (كاشير) يستلم النقد داخل ورديته فقط
  if (acc.kind === 'cash' && !ctx.has('cash.view')) {
    if (!session) fail('NO_SESSION', 'افتح وردية قبل استلام النقد');
    if (session.cash_account_id !== acc.id) fail('FORBIDDEN', 'النقد يُستلم في صندوق ورديتك فقط', 403);
  }
  const sessionId = session && (session.cash_account_id === acc.id || session.card_account_id === acc.id) ? session.id : null;
  return { account: acc, session_id: sessionId };
}

function cashBalance(ctx, accountId) { return ledger.balance(ctx.db, 'CASH', { cash_account_id: accountId }); }

function sideFor(type) { return type === 'receipt' ? 'C' : 'D'; }

/**
 * إنشاء سند قبض/صرف معتمد داخل معاملة قائمة.
 * receipt: مدين النقد / دائن الذمة. payment: مدين الذمة / دائن النقد.
 */
function cashDocInTx(ctx, type, input) {
  const account = input.account || (type === 'receipt' ? 'AR' : 'AP');
  if (!ACCOUNT_LABEL[account]) fail('VALIDATION', 'حساب الذمة غير صحيح');
  const amount = typeof input.amount_minor === 'number' ? input.amount_minor : toMinor(input.amount, 'المبلغ');
  if (amount <= 0) fail('INVALID_AMOUNT', 'المبلغ يجب أن يكون أكبر من صفر');
  const date = input.date || ctx.today();
  ctx.checkPeriod(date);
  let partyId = input.party_id || null;
  if (partyId) {
    const p = ctx.db.prepare('SELECT * FROM parties WHERE id=?').get(partyId);
    if (!p) notFound('الطرف');
    if (ctx.partyScope && p.rep_id !== ctx.partyScope) fail('FORBIDDEN', 'هذا العميل خارج نطاقك', 403);
  }
  if (account === 'AR' && !partyId && !input.allow_no_party) fail('VALIDATION', 'حدد العميل');
  if (account === 'COMMISSION_PAYABLE' && !input.rep_id) fail('VALIDATION', 'حدد المندوب');
  const { account: cash, session_id } = input.cash_account
    ? { account: input.cash_account, session_id: input.session_id ?? null }
    : resolveCashAccount(ctx, { cash_account_id: input.cash_account_id, method: input.method });
  if (type === 'payment' && cash.kind !== 'bank' && cashBalance(ctx, cash.id) < amount) {
    fail('INSUFFICIENT_CASH', `رصيد ${cash.name} (${fromMinor(cashBalance(ctx, cash.id))}) لا يكفي للصرف`, 409);
  }
  const repId = input.rep_id || (cash.kind === 'rep_custody' ? cash.rep_id : null);
  const doc = D.insertDoc(ctx, type, {
    date, status: 'approved', party_id: partyId, cash_account_id: cash.id, rep_id: repId, session_id: session_id || input.session_id || null,
    ref_doc_id: input.ref_doc_id || null, method: input.method || cash.kind, ledger_account: account, ledger_side: sideFor(type),
    total: amount, net: amount, notes: input.notes || null, approved_by: ctx.userId, approved_at: ctx.now(),
  });
  const ledgerLine = { account, party_id: partyId, rep_id: account === 'COMMISSION_PAYABLE' ? repId : null };
  const cashLine = { account: 'CASH', cash_account_id: cash.id };
  if (type === 'receipt') ledger.post(ctx, doc, [{ ...cashLine, debit: amount }, { ...ledgerLine, credit: amount }], D.DOC_LABELS.receipt);
  else ledger.post(ctx, doc, [{ ...ledgerLine, debit: amount }, { ...cashLine, credit: amount }], D.DOC_LABELS.payment);

  // التخصيص
  let allocs = input.allocations;
  if (allocs === 'auto') {
    const targets = ctx.db.prepare(`SELECT * FROM docs WHERE status='approved' AND ledger_account=? AND ledger_side<>? AND id<>?
        AND COALESCE(party_id,0)=COALESCE(?,0) ${account === 'COMMISSION_PAYABLE' ? 'AND rep_id=' + Number(repId) : ''} ORDER BY COALESCE(due_date,date), id`)
      .all(account, sideFor(type), doc.id, partyId);
    let rem = amount;
    allocs = [];
    for (const t of targets) {
      if (rem <= 0) break;
      const open = D.openAmount(ctx, t.id);
      if (open <= 0) continue;
      const a = Math.min(open, rem);
      allocs.push({ doc_id: t.id, amount_minor: a });
      rem -= a;
    }
  }
  let sum = 0;
  for (const a of allocs || []) {
    const target = D.loadDoc(ctx, a.doc_id);
    const amt = typeof a.amount_minor === 'number' ? a.amount_minor : toMinor(a.amount, 'مبلغ التخصيص');
    if (amt === 0) continue;
    sum += amt;
    if (sum > amount) fail('OVER_ALLOCATION', 'مجموع التخصيصات أكبر من مبلغ السند', 409);
    D.allocate(ctx, doc, target, amt, date);
  }
  ctx.audit(`${type}.create`, { entity: 'doc', entity_id: doc.id, doc_number: doc.number, after: { amount: fromMinor(amount), account, party_id: partyId, cash: cash.name } });
  return D.getDocRow(ctx, doc.id);
}

function createReceipt(ctx, input) {
  ctx.require('cash.receipt');
  return ctx.tx(() => D.fullDoc(ctx, cashDocInTx(ctx, 'receipt', input).id));
}

function createPayment(ctx, input) {
  ctx.require(input.account === 'COMMISSION_PAYABLE' ? 'commissions.pay' : 'cash.payment');
  return ctx.tx(() => D.fullDoc(ctx, cashDocInTx(ctx, 'payment', input).id));
}

/** تخصيص لاحق لدفعة مقدمة أو رصيد دائن على فاتورة */
function allocateLater(ctx, { source_id, target_id, amount, date }) {
  ctx.requireAny(['cash.receipt', 'cash.payment']);
  return ctx.tx(() => {
    const s = D.loadDoc(ctx, source_id);
    const t = D.loadDoc(ctx, target_id);
    const d = date || ctx.today();
    ctx.checkPeriod(d);
    const amt = toMinor(amount, 'المبلغ');
    const id = D.allocate(ctx, s, t, amt, d);
    ctx.audit('allocation.create', { entity: 'allocation', entity_id: id, after: { source: s.number, target: t.number, amount } });
    return { id, source: D.fullDoc(ctx, s.id), target: D.fullDoc(ctx, t.id) };
  });
}

/** إلغاء سند قبض/صرف معتمد بقيد عكسي (يفك التخصيصات) */
function reverseCashDoc(ctx, id, reason) {
  ctx.require('docs.reverse');
  return ctx.tx(() => {
    const doc = D.loadDoc(ctx, id);
    if (!['receipt', 'payment', 'cash_transfer'].includes(doc.type)) fail('VALIDATION', 'هذا المسار لإلغاء السندات والتحويلات النقدية');
    if (doc.status !== 'approved') fail('INVALID_STATE', 'المستند غير معتمد');
    const r = ctx.requireReason(reason, 'إلغاء المستند');
    ctx.checkPeriod(doc.date);
    ctx.checkPeriod(ctx.today());
    if (doc.type === 'cash_transfer') {
      const bal = cashBalance(ctx, doc.to_cash_account_id);
      const to = getCashAccount(ctx, doc.to_cash_account_id);
      if (to.kind !== 'bank' && bal < doc.total) fail('INSUFFICIENT_CASH', 'رصيد الحساب المحول إليه لا يكفي للعكس', 409);
    } else if (doc.type === 'receipt') {
      const acc = getCashAccount(ctx, doc.cash_account_id);
      if (acc.kind !== 'bank' && cashBalance(ctx, acc.id) < doc.total) fail('INSUFFICIENT_CASH', 'رصيد الصندوق لا يكفي لعكس القبض', 409);
    }
    D.markReversed(ctx, doc, r);
    ledger.reverseEntries(ctx, doc, ctx.today(), 'إلغاء ' + doc.number);
    ctx.audit(`${doc.type}.reverse`, { entity: 'doc', entity_id: doc.id, doc_number: doc.number, reason: r });
    return D.fullDoc(ctx, doc.id);
  });
}

/** تحويل بين صندوقين/بنك/عهدة (توريد المندوب للصندوق تحويل داخلي) */
function createCashTransfer(ctx, { from_id, to_id, amount, date, notes }) {
  ctx.require('cash.transfer');
  return ctx.tx(() => {
    const from = getCashAccount(ctx, from_id);
    const to = getCashAccount(ctx, to_id);
    if (from.id === to.id) fail('VALIDATION', 'لا يمكن التحويل لنفس الحساب');
    const amt = toMinor(amount, 'المبلغ');
    if (amt <= 0) fail('INVALID_AMOUNT', 'المبلغ يجب أن يكون أكبر من صفر');
    const d = date || ctx.today();
    ctx.checkPeriod(d);
    if (from.kind !== 'bank' && cashBalance(ctx, from.id) < amt) fail('INSUFFICIENT_CASH', `رصيد ${from.name} (${fromMinor(cashBalance(ctx, from.id))}) لا يكفي`, 409);
    const session = openSessionFor(ctx, ctx.userId);
    const doc = D.insertDoc(ctx, 'cash_transfer', {
      date: d, status: 'approved', cash_account_id: from.id, to_cash_account_id: to.id, total: amt, net: amt, notes: notes || null,
      rep_id: from.rep_id || to.rep_id || null, approved_by: ctx.userId, approved_at: ctx.now(),
      session_id: session && (session.cash_account_id === from.id || session.cash_account_id === to.id) ? session.id : null,
    });
    ledger.post(ctx, doc, [{ account: 'CASH', cash_account_id: to.id, debit: amt }, { account: 'CASH', cash_account_id: from.id, credit: amt }], 'تحويل نقدي');
    ctx.audit('cash_transfer.create', { entity: 'doc', entity_id: doc.id, doc_number: doc.number, after: { from: from.name, to: to.name, amount } });
    return D.fullDoc(ctx, doc.id);
  });
}

/** المستندات المفتوحة لطرف (للتخصيص) */
function openDocs(ctx, { party_id, account = 'AR', rep_id }) {
  const rows = ctx.db.prepare(`SELECT * FROM docs WHERE status='approved' AND ledger_account=? AND COALESCE(party_id,0)=COALESCE(?,0)
      ${rep_id ? 'AND rep_id=' + Number(rep_id) : ''} ORDER BY COALESCE(due_date,date), id`).all(account, party_id || null);
  return rows.map((d) => ({ ...D.present(d), open_amount: fromMinor(D.openAmount(ctx, d.id)), label: D.DOC_LABELS[d.type] }))
    .filter((d) => d.open_amount !== 0);
}

module.exports = {
  getCashAccount, openSessionFor, resolveCashAccount, cashBalance, cashDocInTx, createReceipt, createPayment, allocateLater, reverseCashDoc,
  createCashTransfer, openDocs,
};
