'use strict';
// القيود المحاسبية المتوازنة المرتبطة بالمستندات. لا تُعدل الأرصدة مباشرة: كل رصيد يُستخرج من القيود.
const { AppError } = require('../lib/errors');

const ACCOUNTS = {
  CASH: { name: 'النقد والبنوك', type: 'asset' },
  AR: { name: 'ذمم العملاء', type: 'asset' },
  INVENTORY: { name: 'المخزون', type: 'asset' },
  TAX_IN: { name: 'ضريبة المشتريات القابلة للاسترداد', type: 'asset' },
  AP: { name: 'ذمم الموردين والمستحقات', type: 'liability' },
  TAX_OUT: { name: 'ضريبة المبيعات المستحقة', type: 'liability' },
  COMMISSION_PAYABLE: { name: 'عمولات مستحقة للمناديب', type: 'liability' },
  OPENING_EQUITY: { name: 'أرصدة افتتاحية', type: 'equity' },
  SALES: { name: 'المبيعات', type: 'revenue' },
  SALES_RETURNS: { name: 'مرتجعات المبيعات', type: 'contra_revenue' },
  INV_GAIN: { name: 'زيادة جرد', type: 'revenue' },
  PURCHASE_RETURN_DIFF: { name: 'فروق مرتجع المشتريات', type: 'revenue' },
  COGS: { name: 'تكلفة البضاعة المباعة', type: 'cogs' },
  EXPENSES: { name: 'المصروفات', type: 'expense' },
  INV_LOSS: { name: 'خسائر الجرد والتالف', type: 'expense' },
  COMMISSION_EXP: { name: 'مصروف العمولات', type: 'expense' },
  CASH_OVER_SHORT: { name: 'فروق الصندوق والعهد', type: 'expense' },
};

/**
 * ترحيل قيد متوازن.
 * lines: [{account, debit?, credit?, party_id?, cash_account_id?, warehouse_id?, rep_id?, expense_category_id?}]
 * مبلغ سالب في debit يتحول تلقائيًا إلى credit والعكس.
 */
function post(ctx, doc, lines, memo, date) {
  const norm = [];
  for (const l of lines) {
    if (!ACCOUNTS[l.account]) throw new Error('unknown account ' + l.account);
    let d = l.debit || 0, c = l.credit || 0;
    if (!Number.isSafeInteger(d) || !Number.isSafeInteger(c)) throw new Error('journal amounts must be integers');
    if (d < 0) { c -= d; d = 0; }
    if (c < 0) { d -= c; c = 0; }
    const net = d - c;
    if (net === 0) continue;
    norm.push({ ...l, debit: net > 0 ? net : 0, credit: net < 0 ? -net : 0 });
  }
  const sd = norm.reduce((s, l) => s + l.debit, 0);
  const sc = norm.reduce((s, l) => s + l.credit, 0);
  if (sd !== sc) throw new AppError('UNBALANCED', `قيد غير متوازن (${sd} ≠ ${sc}) للمستند ${doc.number}`, 500);
  if (!norm.length) return null;
  const d = date || doc.date;
  const entryId = ctx.db.prepare('INSERT INTO journal_entries(doc_id,date,memo,created_at) VALUES(?,?,?,?)')
    .run(doc.id, d, memo || null, ctx.now()).lastInsertRowid;
  const ins = ctx.db.prepare(`INSERT INTO journal_lines(entry_id,doc_id,date,account,debit,credit,party_id,cash_account_id,warehouse_id,rep_id,expense_category_id)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`);
  for (const l of norm) {
    ins.run(entryId, doc.id, d, l.account, l.debit, l.credit, l.party_id ?? null, l.cash_account_id ?? null,
      l.warehouse_id ?? null, l.rep_id ?? null, l.expense_category_id ?? null);
  }
  return entryId;
}

/** عكس كل قيود المستند بقيد مقابل بتاريخ العكس */
function reverseEntries(ctx, doc, date, memo = 'عكس') {
  const lines = ctx.db.prepare('SELECT * FROM journal_lines WHERE doc_id=?').all(doc.id);
  if (!lines.length) return null;
  return post(ctx, doc, lines.map((l) => ({ ...l, debit: l.credit, credit: l.debit })), memo, date);
}

/** رصيد حساب (مدين - دائن) مع مرشحات اختيارية */
function balance(db, account, f = {}) {
  const w = ['account = ?'];
  const p = [account];
  for (const k of ['party_id', 'cash_account_id', 'warehouse_id', 'rep_id', 'expense_category_id']) {
    if (f[k] !== undefined) { if (f[k] === null) w.push(`${k} IS NULL`); else { w.push(`${k} = ?`); p.push(f[k]); } }
  }
  if (f.branch_id) { w.push('doc_id IN (SELECT id FROM docs WHERE branch_id = ?)'); p.push(f.branch_id); }
  if (f.from) { w.push('date >= ?'); p.push(f.from); }
  if (f.to) { w.push('date <= ?'); p.push(f.to); }
  const r = db.prepare(`SELECT COALESCE(SUM(debit),0) d, COALESCE(SUM(credit),0) c FROM journal_lines WHERE ${w.join(' AND ')}`).get(...p);
  return r.d - r.c;
}

module.exports = { ACCOUNTS, post, reverseEntries, balance };
