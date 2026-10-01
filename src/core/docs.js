'use strict';
// أدوات مشتركة للمستندات: الترقيم، الإنشاء، القراءة، حساب البنود، الأرصدة المفتوحة والتخصيص.
const { fail, notFound } = require('../lib/errors');
const { mulDiv, distribute, toMinor, toBp, toQty, fromMinor, fromQty, fromBp } = require('../lib/money');
const { checkDate } = require('../lib/dates');

const DOC_LABELS = {
  sale: 'فاتورة بيع', sale_return: 'مرتجع مبيعات', purchase: 'فاتورة شراء', purchase_return: 'مرتجع مشتريات',
  receipt: 'سند قبض', payment: 'سند صرف', expense: 'مصروف', transfer: 'تحويل مخزون', stock_count: 'جرد',
  damage: 'تالف', opening_stock: 'مخزون افتتاحي', opening_balance: 'رصيد افتتاحي', cash_transfer: 'تحويل نقدي',
  session_variance: 'فرق وردية', custody_settlement: 'تسوية عهدة', commission: 'عمولة', batch_status: 'تغيير حالة دفعة',
};

// صلاحية العرض لكل نوع مستند
const DOC_VIEW_PERM = {
  sale: 'sales.view', sale_return: 'sales.view', purchase: 'purchases.view', purchase_return: 'purchases.view', receipt: 'cash.receipt', payment: 'cash.view',
  expense: 'expenses.create', transfer: 'stock.view', stock_count: 'stock.view', damage: 'stock.view', opening_stock: 'stock.view', opening_balance: 'opening.manage',
  cash_transfer: 'cash.view', session_variance: 'cash.view', custody_settlement: 'reps.view', commission: 'commissions.manage', batch_status: 'stock.view',
};

function nextNumber(ctx, type) {
  const seq = ctx.db.prepare('SELECT prefix,next FROM doc_sequences WHERE type=?').get(type);
  if (!seq) throw new Error('no sequence for ' + type);
  ctx.db.prepare('UPDATE doc_sequences SET next=next+1 WHERE type=?').run(type);
  return `${seq.prefix}-${String(seq.next).padStart(6, '0')}`;
}

const DOC_COLS = ['date', 'status', 'party_id', 'warehouse_id', 'to_warehouse_id', 'cash_account_id', 'to_cash_account_id', 'rep_id',
  'session_id', 'branch_id', 'expense_category_id', 'ref_doc_id', 'reversal_of', 'supplier_invoice_no', 'due_date', 'method', 'ledger_account',
  'ledger_side', 'subtotal', 'discount', 'net', 'tax', 'extra_cost', 'total', 'cost', 'prices_include_tax', 'invoice_discount_bp',
  'invoice_discount_amount', 'data', 'notes', 'reason', 'approved_by', 'approved_at'];

function insertDoc(ctx, type, fields) {
  const date = checkDate(fields.date || ctx.today());
  const number = nextNumber(ctx, type);
  const f = { status: 'draft', ...fields, date };
  // فرع المستند: من المستودع ثم الحساب النقدي ثم فرع المستخدم
  if (!f.branch_id) {
    const w = f.warehouse_id ? ctx.db.prepare('SELECT branch_id FROM warehouses WHERE id=?').get(f.warehouse_id) : null;
    const c = !w && f.cash_account_id ? ctx.db.prepare('SELECT branch_id FROM cash_accounts WHERE id=?').get(f.cash_account_id) : null;
    f.branch_id = (w && w.branch_id) || (c && c.branch_id) || ctx.branchScope || null;
  }
  ctx.checkBranch(f.branch_id);
  if (f.data && typeof f.data !== 'string') f.data = JSON.stringify(f.data);
  const cols = DOC_COLS.filter((c) => f[c] !== undefined);
  const id = ctx.db.prepare(`INSERT INTO docs(type,number,created_by,created_at,${cols.join(',')}) VALUES(?,?,?,?,${cols.map(() => '?').join(',')})`)
    .run(type, number, ctx.userId, ctx.now(), ...cols.map((c) => f[c] ?? null)).lastInsertRowid;
  return getDocRow(ctx, id);
}

function updateDoc(ctx, id, fields) {
  const f = { ...fields };
  if (f.data && typeof f.data !== 'string') f.data = JSON.stringify(f.data);
  const cols = DOC_COLS.filter((c) => f[c] !== undefined);
  if (!cols.length) return;
  ctx.db.prepare(`UPDATE docs SET ${cols.map((c) => c + '=?').join(',')} WHERE id=?`).run(...cols.map((c) => f[c] ?? null), id);
}

const LINE_COLS = ['line_no', 'item_id', 'item_name', 'unit_id', 'unit_name', 'factor', 'qty', 'base_qty', 'price', 'value', 'line_discount',
  'doc_discount', 'net', 'tax_rate_bp', 'tax', 'total', 'extra_cost', 'cost', 'batch_id', 'batch_no', 'prod_date', 'expiry_date',
  'ref_line_id', 'condition', 'system_qty', 'counted_qty', 'amount', 'description', 'data'];

function insertLine(ctx, docId, line) {
  const l = { ...line };
  if (l.data && typeof l.data !== 'string') l.data = JSON.stringify(l.data);
  const cols = LINE_COLS.filter((c) => l[c] !== undefined);
  return ctx.db.prepare(`INSERT INTO doc_lines(doc_id,${cols.join(',')}) VALUES(?,${cols.map(() => '?').join(',')})`)
    .run(docId, ...cols.map((c) => l[c] ?? null)).lastInsertRowid;
}

function getDocRow(ctx, id) {
  return ctx.db.prepare('SELECT * FROM docs WHERE id=?').get(id);
}

function loadDoc(ctx, id, type) {
  const d = getDocRow(ctx, id);
  if (!d || (type && d.type !== type)) notFound(type ? DOC_LABELS[type] : 'المستند');
  return d;
}

function docLines(ctx, id) {
  return ctx.db.prepare('SELECT * FROM doc_lines WHERE doc_id=? ORDER BY line_no, id').all(id);
}

function docData(doc) { return doc.data ? JSON.parse(doc.data) : {}; }

/** الرصيد المفتوح لمستند ذمة = الإجمالي - المخصص منه أو له */
function openAmount(ctx, docId) {
  const d = getDocRow(ctx, docId);
  if (!d) return 0;
  const r = ctx.db.prepare(`SELECT COALESCE(SUM(amount),0) s FROM allocations WHERE reversed=0 AND (source_doc_id=? OR target_doc_id=?)`).get(docId, docId);
  return d.total - r.s;
}

/**
 * تخصيص بين مستندين على نفس حساب الذمة ونفس الطرف وبجهتين متعاكستين.
 * source: السند أو المرتجع، target: الفاتورة أو المستحق.
 */
function allocate(ctx, source, target, amount, date) {
  if (!(amount > 0)) fail('INVALID_AMOUNT', 'مبلغ التخصيص يجب أن يكون أكبر من صفر');
  if (source.status !== 'approved' || target.status !== 'approved') fail('NOT_APPROVED', 'التخصيص يتم بين مستندات معتمدة فقط');
  if (!source.ledger_account || source.ledger_account !== target.ledger_account) fail('ALLOC_MISMATCH', `لا يمكن تخصيص ${source.number} على ${target.number}: حساب مختلف`);
  if (source.ledger_side === target.ledger_side) fail('ALLOC_MISMATCH', `لا يمكن تخصيص ${source.number} على ${target.number}: نفس الاتجاه`);
  if ((source.party_id ?? null) !== (target.party_id ?? null)) fail('ALLOC_MISMATCH', 'التخصيص يجب أن يكون لنفس الطرف');
  if (source.ledger_account === 'COMMISSION_PAYABLE' && source.rep_id !== target.rep_id) fail('ALLOC_MISMATCH', 'التخصيص يجب أن يكون لنفس المندوب');
  const so = openAmount(ctx, source.id);
  const to = openAmount(ctx, target.id);
  if (amount > so) fail('OVER_ALLOCATION', `مبلغ التخصيص (${fromMinor(amount)}) يتجاوز المتبقي في ${source.number} (${fromMinor(so)})`, 409);
  if (amount > to) fail('OVER_ALLOCATION', `مبلغ التخصيص (${fromMinor(amount)}) يتجاوز المتبقي في ${target.number} (${fromMinor(to)})`, 409);
  return ctx.db.prepare('INSERT INTO allocations(source_doc_id,target_doc_id,amount,date,created_at,created_by) VALUES(?,?,?,?,?,?)')
    .run(source.id, target.id, amount, date || source.date, ctx.now(), ctx.userId).lastInsertRowid;
}

/** حالة السداد للعرض */
function paymentStatus(ctx, doc) {
  if (!doc.ledger_account || doc.status !== 'approved') return null;
  const open = openAmount(ctx, doc.id);
  if (open === 0) return 'paid';
  if (open < 0) return 'credit';
  if (open === doc.total) return 'unpaid';
  return 'partial';
}

// ---------- حساب البنود ----------

function getItem(ctx, id) {
  const it = ctx.db.prepare('SELECT * FROM items WHERE id=?').get(id);
  if (!it) notFound('الصنف');
  return it;
}

function getUnit(ctx, item, unitId) {
  const u = unitId
    ? ctx.db.prepare('SELECT * FROM item_units WHERE id=? AND item_id=?').get(unitId, item.id)
    : ctx.db.prepare('SELECT * FROM item_units WHERE item_id=? AND is_base=1').get(item.id);
  if (!u) fail('INVALID_UNIT', `الوحدة غير معرفة للصنف ${item.name}`);
  return u;
}

/** تحويل كمية بالوحدة إلى وحدة الأساس مع التحقق من دقة الصنف */
function toBaseQty(item, unit, qtyInput, field) {
  const q = toQty(qtyInput, 3, field);
  if (q <= 0) fail('INVALID_QTY', `الكمية يجب أن تكون أكبر من صفر${field ? ' في ' + field : ''}`);
  const base = mulDiv(q, unit.factor, 1000);
  const step = 10 ** (3 - item.qty_decimals);
  if (base % step !== 0 || mulDiv(base, 1000, unit.factor) !== q) {
    fail('QTY_PRECISION', item.qty_decimals === 0 ? `كمية ${item.name} يجب أن تكون عددًا صحيحًا من ${item.base_unit}` : `دقة كمية ${item.name} تتجاوز ${item.qty_decimals} منازل`, 400, { field });
  }
  return { qty: q, base };
}

/**
 * حساب بنود فاتورة: القيمة = الكمية × سعر الوحدة، ثم خصم البند، ثم حصته من خصم الفاتورة، ثم الضريبة.
 * lines: [{qty (×1000), price, discount_bp?, discount_amount?, tax_rate_bp}]
 */
function priceLines(lines, { invoiceDiscountBp = null, invoiceDiscountAmount = null, pricesIncludeTax = false } = {}) {
  const out = lines.map((l, i) => {
    const value = mulDiv(l.qty, l.price, 1000);
    let disc = 0;
    if (l.discount_bp) disc = mulDiv(value, l.discount_bp, 10000);
    if (l.discount_amount) disc += l.discount_amount;
    if (disc < 0 || disc > value) fail('INVALID_DISCOUNT', `خصم البند ${i + 1} أكبر من قيمته`);
    return { ...l, value, line_discount: disc, after: value - disc };
  });
  const sumAfter = out.reduce((s, l) => s + l.after, 0);
  let invDisc = 0;
  if (invoiceDiscountBp) invDisc = mulDiv(sumAfter, invoiceDiscountBp, 10000);
  if (invoiceDiscountAmount) invDisc += invoiceDiscountAmount;
  if (invDisc < 0 || invDisc > sumAfter) fail('INVALID_DISCOUNT', 'خصم الفاتورة أكبر من قيمتها');
  const shares = distribute(invDisc, out.map((l) => l.after));
  const totals = { subtotal: 0, discount: 0, net: 0, tax: 0, total: 0 };
  out.forEach((l, i) => {
    l.doc_discount = shares[i];
    const gross = l.after - shares[i];
    if (pricesIncludeTax) {
      l.net = mulDiv(gross, 10000, 10000 + l.tax_rate_bp);
      l.tax = gross - l.net;
    } else {
      l.net = gross;
      l.tax = mulDiv(gross, l.tax_rate_bp, 10000);
    }
    l.total = l.net + l.tax;
    totals.subtotal += l.value;
    totals.discount += l.line_discount + l.doc_discount;
    totals.net += l.net;
    totals.tax += l.tax;
    totals.total += l.total;
    delete l.after;
  });
  return { lines: out, totals };
}

/** قراءة مدخلات الخصم والضريبة البشرية */
function parseLineMoney(l, i) {
  const f = `البند ${i + 1}`;
  return {
    discount_bp: l.discount_pct != null && l.discount_pct !== '' ? toBp(l.discount_pct, f) : null,
    discount_amount: l.discount_amount != null && l.discount_amount !== '' ? toMinor(l.discount_amount, f) : null,
  };
}

function itemTaxBp(ctx, item, override) {
  if (override != null && override !== '') return toBp(override, 'نسبة الضريبة');
  if (item.tax_rate_bp != null) return item.tax_rate_bp;
  return ctx.settingInt('default_tax_rate_bp') || 0;
}

// ---------- عرض بشري ----------
const MONEY_FIELDS = ['subtotal', 'discount', 'net', 'tax', 'extra_cost', 'total', 'cost', 'invoice_discount_amount', 'price', 'value',
  'line_discount', 'doc_discount', 'amount', 'open_amount', 'opening_amount', 'expected_amount', 'counted_amount', 'variance', 'sell_price',
  'min_price', 'credit_limit', 'base', 'balance'];
const QTY_FIELDS = ['qty', 'base_qty', 'returned_qty', 'system_qty', 'counted_qty', 'factor', 'reorder_level'];
const BP_FIELDS = ['tax_rate_bp', 'invoice_discount_bp', 'max_discount_bp', 'rate_bp', 'default_tax_rate_bp'];

/** تحويل صف إلى أرقام بشرية */
function present(row) {
  if (!row) return row;
  const o = { ...row };
  for (const k of MONEY_FIELDS) if (typeof o[k] === 'number') o[k] = fromMinor(o[k]);
  for (const k of QTY_FIELDS) if (typeof o[k] === 'number') o[k] = fromQty(o[k]);
  for (const k of BP_FIELDS) if (typeof o[k] === 'number') o[k] = fromBp(o[k]);
  if (typeof o.data === 'string') { try { o.data = JSON.parse(o.data); } catch (_) { /* keep */ } }
  return o;
}

function fullDoc(ctx, id) {
  const d = loadDoc(ctx, id);
  const lines = docLines(ctx, id);
  const out = present(d);
  out.label = DOC_LABELS[d.type];
  out.lines = lines.map(present);
  if (d.ledger_account) {
    out.open_amount = fromMinor(openAmount(ctx, id));
    out.payment_status = paymentStatus(ctx, d);
  }
  out.allocations = ctx.db.prepare(`SELECT a.id,a.amount,a.date,a.reversed,a.source_doc_id,s.number source_number,s.type source_type,
      a.target_doc_id,t.number target_number,t.type target_type
    FROM allocations a JOIN docs s ON s.id=a.source_doc_id JOIN docs t ON t.id=a.target_doc_id
    WHERE a.source_doc_id=? OR a.target_doc_id=? ORDER BY a.id`).all(id, id).map(present);
  out.related = ctx.db.prepare('SELECT id,type,number,date,status,total FROM docs WHERE (ref_doc_id=? OR reversal_of=?) AND id<>? ORDER BY id').all(id, id, id).map(present);
  const names = ctx.db.prepare(`SELECT
      (SELECT name FROM parties WHERE id=?) party_name,
      (SELECT name FROM warehouses WHERE id=?) warehouse_name,
      (SELECT name FROM warehouses WHERE id=?) to_warehouse_name,
      (SELECT name FROM cash_accounts WHERE id=?) cash_account_name,
      (SELECT name FROM cash_accounts WHERE id=?) to_cash_account_name,
      (SELECT name FROM reps WHERE id=?) rep_name,
      (SELECT full_name FROM users WHERE id=?) created_by_name,
      (SELECT full_name FROM users WHERE id=?) approved_by_name,
      (SELECT number FROM docs WHERE id=?) ref_doc_number,
      (SELECT name FROM branches WHERE id=?) branch_name,
      (SELECT address FROM branches WHERE id=?) branch_address,
      (SELECT phone FROM branches WHERE id=?) branch_phone,
      (SELECT name FROM expense_categories WHERE id=?) expense_category_name`)
    .get(d.party_id, d.warehouse_id, d.to_warehouse_id, d.cash_account_id, d.to_cash_account_id, d.rep_id, d.created_by, d.approved_by, d.ref_doc_id, d.branch_id, d.branch_id, d.branch_id, d.expense_category_id);
  Object.assign(out, names);
  out.attachments = ctx.db.prepare('SELECT id,file_name,mime,size,created_at FROM attachments WHERE doc_id=?').all(id);
  return out;
}

function markApproved(ctx, doc) {
  ctx.db.prepare("UPDATE docs SET status='approved', approved_by=?, approved_at=? WHERE id=?").run(ctx.userId, ctx.now(), doc.id);
  doc.status = 'approved';
}

function markReversed(ctx, doc, reason) {
  ctx.db.prepare("UPDATE docs SET status='reversed', reversed_by=?, reversed_at=?, reason=COALESCE(reason || ' | ', '') || ? WHERE id=?")
    .run(ctx.userId, ctx.now(), 'إلغاء: ' + reason, doc.id);
  ctx.db.prepare('UPDATE allocations SET reversed=1 WHERE reversed=0 AND (source_doc_id=? OR target_doc_id=?)').run(doc.id, doc.id);
}

module.exports = {
  DOC_LABELS, DOC_VIEW_PERM, nextNumber, insertDoc, updateDoc, insertLine, getDocRow, loadDoc, docLines, docData, openAmount, allocate, paymentStatus,
  getItem, getUnit, toBaseQty, priceLines, parseLineMoney, itemTaxBp, present, fullDoc, markApproved, markReversed,
};
