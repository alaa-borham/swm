'use strict';
// القيود اليدوية، ميزان المراجعة، دفتر الأستاذ، والمركز المالي.
// القيد اليدوي مسموح فقط على الحسابات غير المرتبطة بمستندات تشغيلية (لا يمس المخزون أو ذمم العملاء والموردين أو العمولات)
// حتى تبقى أرصدة الدفعات والفواتير المفتوحة مطابقة للقيود.
const { fail } = require('../lib/errors');
const { toMinor, fromMinor } = require('../lib/money');
const { checkDate, addDays } = require('../lib/dates');
const ledger = require('./ledger');
const D = require('./docs');

const { ACCOUNTS } = ledger;

function createJournal(ctx, { date, lines, reason, notes }) {
  ctx.require('journal.manual');
  return ctx.tx(() => {
    const d = checkDate(date || ctx.today());
    ctx.checkPeriod(d);
    const r = ctx.requireReason(reason, 'القيد اليدوي');
    if (!Array.isArray(lines) || lines.length < 2) fail('VALIDATION', 'القيد يحتاج سطرين على الأقل');
    const norm = lines.map((l, i) => {
      const acc = ACCOUNTS[l.account];
      if (!acc) fail('VALIDATION', `الحساب غير معروف في السطر ${i + 1}`);
      if (!acc.manual) fail('VALIDATION', `لا يُسمح بالقيد اليدوي على ${acc.name}؛ استخدم المستند المخصص له`);
      const debit = l.debit ? toMinor(l.debit, `مدين السطر ${i + 1}`) : 0;
      const credit = l.credit ? toMinor(l.credit, `دائن السطر ${i + 1}`) : 0;
      if (debit < 0 || credit < 0 || (debit > 0) === (credit > 0)) fail('VALIDATION', `السطر ${i + 1}: أدخل مدينًا أو دائنًا (واحدًا فقط) أكبر من صفر`);
      let cash = null;
      if (l.account === 'CASH') {
        cash = ctx.db.prepare('SELECT * FROM cash_accounts WHERE id=?').get(l.cash_account_id);
        if (!cash) fail('VALIDATION', `حدد الصندوق أو البنك في السطر ${i + 1}`);
        ctx.checkBranch(cash.branch_id);
      }
      const cat = l.account === 'EXPENSES' ? (l.expense_category_id || null) : null;
      return { account: l.account, debit, credit, cash_account_id: cash ? cash.id : null, expense_category_id: cat, description: l.description || null };
    });
    const sd = norm.reduce((s, l) => s + l.debit, 0), sc = norm.reduce((s, l) => s + l.credit, 0);
    if (sd !== sc) fail('UNBALANCED', `القيد غير متوازن: المدين ${fromMinor(sd)} والدائن ${fromMinor(sc)}`);
    const doc = D.insertDoc(ctx, 'journal', { date: d, status: 'approved', total: sd, net: sd, reason: r, notes: notes || null, approved_by: ctx.userId, approved_at: ctx.now() });
    norm.forEach((l, i) => D.insertLine(ctx, doc.id, {
      line_no: i + 1, description: l.description, amount: l.debit || -l.credit,
      data: { account: l.account, account_name: ACCOUNTS[l.account].name, debit: fromMinor(l.debit), credit: fromMinor(l.credit), cash_account_id: l.cash_account_id, expense_category_id: l.expense_category_id },
    }));
    ledger.post(ctx, doc, norm, 'قيد يدوي');
    ctx.audit('journal.create', { entity: 'doc', entity_id: doc.id, doc_number: doc.number, reason: r, after: { total: fromMinor(sd) } });
    return D.fullDoc(ctx, doc.id);
  });
}

function reverseJournal(ctx, id, reason) {
  ctx.require('journal.manual');
  return ctx.tx(() => {
    const doc = D.loadDoc(ctx, id, 'journal');
    if (doc.status !== 'approved') fail('INVALID_STATE', 'القيد غير معتمد');
    const r = ctx.requireReason(reason, 'عكس القيد');
    ctx.checkPeriod(doc.date);
    ctx.checkPeriod(ctx.today());
    D.markReversed(ctx, doc, r);
    ledger.reverseEntries(ctx, doc, ctx.today(), 'عكس ' + doc.number);
    ctx.audit('journal.reverse', { entity: 'doc', entity_id: id, doc_number: doc.number, reason: r });
    return D.fullDoc(ctx, id);
  });
}

const DEBIT_NATURE = new Set(['asset', 'expense', 'cogs', 'contra_revenue']);

/** ميزان المراجعة: رصيد أول المدة وحركة الفترة ورصيد آخر المدة لكل حساب */
function trialBalance(ctx, { from, to, branch_id } = {}) {
  ctx.require('reports.finance');
  const t = to ? checkDate(to) : ctx.today();
  const f = from ? checkDate(from) : t.slice(0, 8) + '01';
  const br = ctx.branchScope || (branch_id ? Number(branch_id) : undefined);
  const rows = Object.entries(ACCOUNTS).map(([code, a]) => {
    const opening = ledger.balance(ctx.db, code, { to: addDays(f, -1), branch_id: br });
    const r = ctx.db.prepare(`SELECT COALESCE(SUM(debit),0) d, COALESCE(SUM(credit),0) c FROM journal_lines WHERE account=? AND date BETWEEN ? AND ?
      ${br ? 'AND doc_id IN (SELECT id FROM docs WHERE branch_id=' + Number(br) + ')' : ''}`).get(code, f, t);
    const closing = opening + r.d - r.c;
    return {
      code, name: a.name, type: a.type, opening: fromMinor(opening), debit: fromMinor(r.d), credit: fromMinor(r.c),
      closing_debit: closing > 0 ? fromMinor(closing) : 0, closing_credit: closing < 0 ? fromMinor(-closing) : 0,
    };
  }).filter((r) => r.opening || r.debit || r.credit || r.closing_debit || r.closing_credit);
  const cols = [{ key: 'name', label: 'الحساب' }, { key: 'opening', label: 'رصيد أول المدة (مدين+)', type: 'money' }, { key: 'debit', label: 'مدين الفترة', type: 'money' },
    { key: 'credit', label: 'دائن الفترة', type: 'money' }, { key: 'closing_debit', label: 'رصيد مدين', type: 'money' }, { key: 'closing_credit', label: 'رصيد دائن', type: 'money' }];
  const totals = {};
  for (const c of cols.slice(1)) totals[c.key] = Number(rows.reduce((s, r) => s + r[c.key], 0).toFixed(3));
  return { title: 'ميزان المراجعة', from: f, to: t, columns: cols, rows, totals, balanced: Math.abs(totals.closing_debit - totals.closing_credit) < 0.0001 && Math.abs(totals.debit - totals.credit) < 0.0001 };
}

/** دفتر الأستاذ لحساب واحد مع الرصيد الجاري */
function generalLedger(ctx, { account, from, to, branch_id } = {}) {
  ctx.require('reports.finance');
  if (!ACCOUNTS[account]) fail('VALIDATION', 'اختر الحساب');
  const t = to ? checkDate(to) : ctx.today();
  const f = from ? checkDate(from) : t.slice(0, 8) + '01';
  const br = ctx.branchScope || (branch_id ? Number(branch_id) : undefined);
  const sign = DEBIT_NATURE.has(ACCOUNTS[account].type) ? 1 : -1;
  const opening = sign * ledger.balance(ctx.db, account, { to: addDays(f, -1), branch_id: br });
  let run = opening;
  const rows = ctx.db.prepare(`SELECT jl.date, jl.debit, jl.credit, d.id doc_id, d.number, d.type, d.notes, p.name party, c.name cash FROM journal_lines jl JOIN docs d ON d.id=jl.doc_id
      LEFT JOIN parties p ON p.id=jl.party_id LEFT JOIN cash_accounts c ON c.id=jl.cash_account_id
    WHERE jl.account=? AND jl.date BETWEEN ? AND ? ${br ? 'AND d.branch_id=' + Number(br) : ''} ORDER BY jl.date, jl.id`).all(account, f, t)
    .map((r) => {
      run += sign * (r.debit - r.credit);
      return { date: r.date, doc_id: r.doc_id, number: r.number, type: D.DOC_LABELS[r.type], detail: r.party || r.cash || r.notes || '', debit: fromMinor(r.debit), credit: fromMinor(r.credit), balance: fromMinor(run) };
    });
  const cols = [{ key: 'date', label: 'التاريخ' }, { key: 'number', label: 'المستند', link: 'doc_id' }, { key: 'type', label: 'النوع' }, { key: 'detail', label: 'البيان' },
    { key: 'debit', label: 'مدين', type: 'money' }, { key: 'credit', label: 'دائن', type: 'money' }, { key: 'balance', label: 'الرصيد', type: 'money' }];
  const totals = { debit: Number(rows.reduce((s, r) => s + r.debit, 0).toFixed(3)), credit: Number(rows.reduce((s, r) => s + r.credit, 0).toFixed(3)) };
  return { title: `دفتر الأستاذ: ${ACCOUNTS[account].name}`, from: f, to: t, opening: fromMinor(opening), closing: fromMinor(run), columns: cols, rows, totals };
}

/** المركز المالي في تاريخ: الأصول = الالتزامات + حقوق الملكية (شاملة صافي الربح المتراكم) */
function balanceSheet(ctx, { as_of } = {}) {
  ctx.require('reports.finance');
  ctx.require('profit.view');
  const t = as_of ? checkDate(as_of) : ctx.today();
  const bal = (code) => ledger.balance(ctx.db, code, { to: t });
  const group = (type, sign) => Object.entries(ACCOUNTS).filter(([, a]) => a.type === type).map(([code, a]) => ({ code, name: a.name, amount: sign * bal(code) })).filter((r) => r.amount);
  const assets = group('asset', 1);
  const liabilities = group('liability', -1);
  const equity = group('equity', -1);
  const pnlTypes = ['revenue', 'contra_revenue', 'cogs', 'expense'];
  const retained = -Object.entries(ACCOUNTS).filter(([, a]) => pnlTypes.includes(a.type)).reduce((s, [code]) => s + bal(code), 0);
  equity.push({ code: 'RETAINED', name: 'الأرباح المتراكمة (صافي الربح حتى التاريخ)', amount: retained });
  const sum = (a) => a.reduce((s, r) => s + r.amount, 0);
  const out = (a) => a.map((r) => ({ ...r, amount: fromMinor(r.amount) }));
  return {
    as_of: t, assets: out(assets), liabilities: out(liabilities), equity: out(equity), total_assets: fromMinor(sum(assets)),
    total_liabilities_equity: fromMinor(sum(liabilities) + sum(equity)), balanced: sum(assets) === sum(liabilities) + sum(equity),
  };
}

function manualAccounts() {
  return Object.entries(ACCOUNTS).filter(([, a]) => a.manual).map(([code, a]) => ({ code, name: a.name, type: a.type }));
}

module.exports = { createJournal, reverseJournal, trialBalance, generalLedger, balanceSheet, manualAccounts, ACCOUNTS };
