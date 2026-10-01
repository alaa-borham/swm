'use strict';
// التقارير ولوحة الإدارة. كل تقرير جدولي يعيد {title, columns, rows, totals} ليُعرض ويُصدّر بنفس الشكل.
const { fromMinor, fromQty } = require('../lib/money');
const { addDays, checkDate } = require('../lib/dates');
const ledger = require('./ledger');
const inv = require('./inventory');
const D = require('./docs');

const m = fromMinor;
const q = fromQty;

function period(ctx, { from, to } = {}) {
  const t = to ? checkDate(to, 'إلى') : ctx.today();
  const f = from ? checkDate(from, 'من') : t.slice(0, 8) + '01';
  return { from: f, to: t };
}

function sumAcc(ctx, account, p, f = {}) { return ledger.balance(ctx.db, account, { ...f, from: p.from, to: p.to }); }

// ===================== الأرباح =====================
function profitLoss(ctx, opts = {}) {
  ctx.require('profit.view');
  const p = period(ctx, opts);
  const sales = -sumAcc(ctx, 'SALES', p);
  const returns = sumAcc(ctx, 'SALES_RETURNS', p);
  const cogs = sumAcc(ctx, 'COGS', p);
  const expenses = sumAcc(ctx, 'EXPENSES', p);
  const commissions = sumAcc(ctx, 'COMMISSION_EXP', p);
  const invLoss = sumAcc(ctx, 'INV_LOSS', p);
  const invGain = -sumAcc(ctx, 'INV_GAIN', p);
  const cashDiff = sumAcc(ctx, 'CASH_OVER_SHORT', p);
  const other = -sumAcc(ctx, 'PURCHASE_RETURN_DIFF', p);
  const netSales = sales - returns;
  const gross = netSales - cogs;
  const operating = gross - expenses - commissions - (invLoss - invGain) - cashDiff + other;
  const byCat = ctx.db.prepare(`SELECT ec.name, SUM(jl.debit-jl.credit) v FROM journal_lines jl JOIN expense_categories ec ON ec.id=jl.expense_category_id
    WHERE jl.account='EXPENSES' AND jl.date BETWEEN ? AND ? GROUP BY ec.id ORDER BY v DESC`).all(p.from, p.to);
  return {
    ...p, sales: m(sales), returns: m(returns), net_sales: m(netSales), cogs: m(cogs), gross_profit: m(gross),
    gross_margin: netSales ? Math.round((gross / netSales) * 10000) / 100 : 0, expenses: m(expenses), commissions: m(commissions),
    inventory_losses: m(invLoss), inventory_gains: m(invGain), cash_differences: m(cashDiff), other_income: m(other), operating_profit: m(operating),
    expenses_by_category: byCat.map((r) => ({ name: r.name, amount: m(r.v) })),
  };
}

// ===================== لوحة الإدارة =====================
function dashboard(ctx, opts = {}) {
  ctx.require('dashboard.view');
  const p = period(ctx, opts);
  const canProfit = ctx.has('profit.view');
  const sales = -sumAcc(ctx, 'SALES', p) - sumAcc(ctx, 'SALES_RETURNS', p);
  const out = { ...p, net_sales: m(sales) };
  if (canProfit) {
    const pl = profitLoss(ctx, p);
    Object.assign(out, { cogs: pl.cogs, gross_profit: pl.gross_profit, expenses: pl.expenses, operating_profit: pl.operating_profit, commissions: pl.commissions, inventory_losses: pl.inventory_losses });
  }
  // التحصيلات: سندات القبض المعتمدة من العملاء في الفترة (تشمل السداد عند البيع)
  out.collections = m(ctx.db.prepare(`SELECT COALESCE(SUM(total),0) v FROM docs WHERE type='receipt' AND ledger_account='AR' AND status='approved' AND date BETWEEN ? AND ?`).get(p.from, p.to).v);
  out.receivables = m(ledger.balance(ctx.db, 'AR', {}));
  out.payables = m(-ledger.balance(ctx.db, 'AP', {}));
  const minExp = inv.minSellableExpiry(ctx);
  if (ctx.has('cost.view')) {
    out.stock_value = m(ctx.db.prepare(`SELECT COALESCE(SUM(cost),0) v FROM batches WHERE status='ok' AND (expiry_date IS NULL OR expiry_date>=?)`).get(minExp).v);
    out.blocked_stock_value = m(ctx.db.prepare(`SELECT COALESCE(SUM(cost),0) v FROM batches WHERE NOT (status='ok' AND (expiry_date IS NULL OR expiry_date>=?))`).get(minExp).v);
  }
  out.cash = ctx.has('cash.view') ? ctx.db.prepare(`SELECT c.id, c.name, c.kind, COALESCE(SUM(jl.debit-jl.credit),0) v FROM cash_accounts c
      LEFT JOIN journal_lines jl ON jl.cash_account_id=c.id AND jl.account='CASH' WHERE c.active=1 GROUP BY c.id ORDER BY c.kind, c.name`).all()
    .map((r) => ({ id: r.id, name: r.name, kind: r.kind, balance: m(r.v) })) : [];
  const a = alerts(ctx);
  out.alerts = {
    low_stock: a.low_stock.length, near_expiry: a.near_expiry.length, expired: a.expired.length, isolated: a.isolated.length,
    overdue_customers: a.overdue.length, drafts: a.drafts, open_sessions: a.open_sessions, pending_sessions: a.pending_sessions,
  };
  out.daily = ctx.db.prepare(`SELECT date, SUM(CASE WHEN type='sale' THEN net ELSE -net END) v FROM docs
    WHERE type IN ('sale','sale_return') AND status='approved' AND date BETWEEN ? AND ? GROUP BY date ORDER BY date`).all(p.from, p.to).map((r) => ({ date: r.date, net_sales: m(r.v) }));
  return out;
}

function alerts(ctx) {
  const minExp = inv.minSellableExpiry(ctx);
  const today = ctx.today();
  const defDays = ctx.settingInt('expiry_alert_days') || 30;
  const low = ctx.db.prepare(`SELECT i.id, i.code, i.name, i.base_unit, i.reorder_level,
      COALESCE((SELECT SUM(qty) FROM batches b WHERE b.item_id=i.id AND b.status='ok' AND (b.expiry_date IS NULL OR b.expiry_date>=?)),0) sellable
    FROM items i WHERE i.active=1 AND i.reorder_level>0`).all(minExp).filter((r) => r.sellable <= r.reorder_level)
    .map((r) => ({ ...r, sellable: q(r.sellable), reorder_level: q(r.reorder_level) }));
  const near = ctx.db.prepare(`SELECT b.id batch_id, b.batch_no, b.expiry_date, b.qty, i.name, i.base_unit, w.name warehouse,
      CAST(julianday(b.expiry_date)-julianday(?) AS INTEGER) days_left
    FROM batches b JOIN items i ON i.id=b.item_id JOIN warehouses w ON w.id=b.warehouse_id
    WHERE b.qty>0 AND b.status='ok' AND b.expiry_date IS NOT NULL AND b.expiry_date>=? AND b.expiry_date<=date(?, '+' || COALESCE(i.expiry_alert_days, ?) || ' days')
    ORDER BY b.expiry_date`).all(today, minExp, today, defDays).map((r) => ({ ...r, qty: q(r.qty) }));
  const expired = ctx.db.prepare(`SELECT b.id batch_id, b.batch_no, b.expiry_date, b.qty, b.cost, i.name, i.base_unit, w.name warehouse FROM batches b
    JOIN items i ON i.id=b.item_id JOIN warehouses w ON w.id=b.warehouse_id
    WHERE b.qty>0 AND b.status='ok' AND b.expiry_date IS NOT NULL AND b.expiry_date<? ORDER BY b.expiry_date`).all(minExp)
    .map((r) => ({ ...r, qty: q(r.qty), cost: ctx.has('cost.view') ? m(r.cost) : undefined }));
  const isolated = ctx.db.prepare(`SELECT b.id batch_id, b.batch_no, b.expiry_date, b.qty, b.status, i.name, i.base_unit, w.name warehouse FROM batches b
    JOIN items i ON i.id=b.item_id JOIN warehouses w ON w.id=b.warehouse_id WHERE b.qty>0 AND b.status IN ('isolated','pending') ORDER BY b.id`).all()
    .map((r) => ({ ...r, qty: q(r.qty) }));
  const overdue = ctx.db.prepare(`SELECT d.id, d.number, d.date, d.due_date, d.total, p.name party FROM docs d JOIN parties p ON p.id=d.party_id
    WHERE d.status='approved' AND d.ledger_account='AR' AND d.ledger_side='D' AND d.due_date < ?`).all(today)
    .map((d) => ({ ...d, open: D.openAmount(ctx, d.id) })).filter((d) => d.open > 0).map((d) => ({ ...d, total: m(d.total), open: m(d.open) }));
  const drafts = ctx.db.prepare("SELECT COUNT(*) n FROM docs WHERE status='draft'").get().n;
  const openSessions = ctx.db.prepare("SELECT COUNT(*) n FROM cash_sessions WHERE status='open'").get().n;
  const pendingSessions = ctx.db.prepare("SELECT COUNT(*) n FROM cash_sessions WHERE status='closing'").get().n;
  return { low_stock: low, near_expiry: near, expired, isolated, overdue, drafts, open_sessions: openSessions, pending_sessions: pendingSessions };
}

// ===================== المبيعات =====================
const SALE_GROUPS = {
  item: { label: 'الصنف', key: 'l.item_id', name: 'l.item_name' },
  customer: { label: 'العميل', key: 'd.party_id', name: "COALESCE(p.name,'عميل نقدي')" },
  rep: { label: 'المندوب', key: 'd.rep_id', name: "COALESCE(r.name,'بدون مندوب')" },
  day: { label: 'اليوم', key: 'd.date', name: 'd.date' },
  warehouse: { label: 'المستودع', key: 'd.warehouse_id', name: 'w.name' },
  category: { label: 'التصنيف', key: 'i.category_id', name: "COALESCE(c.name,'-')" },
};

function salesReport(ctx, opts = {}) {
  ctx.require('reports.sales');
  const p = period(ctx, opts);
  const g = SALE_GROUPS[opts.group] || SALE_GROUPS.item;
  const showCost = ctx.has('profit.view');
  const w = ["d.status='approved'", "d.type IN ('sale','sale_return')", 'd.date BETWEEN ? AND ?'];
  const params = [p.from, p.to];
  if (opts.warehouse_id) { w.push('d.warehouse_id=?'); params.push(Number(opts.warehouse_id)); }
  if (opts.rep_id) { w.push('d.rep_id=?'); params.push(Number(opts.rep_id)); }
  if (opts.party_id) { w.push('d.party_id=?'); params.push(Number(opts.party_id)); }
  if (opts.item_id) { w.push('l.item_id=?'); params.push(Number(opts.item_id)); }
  if (ctx.repScope) { w.push('d.rep_id=?'); params.push(ctx.repScope); }
  const rows = ctx.db.prepare(`SELECT ${g.key} k, ${g.name} name,
      SUM(CASE WHEN d.type='sale' THEN l.base_qty ELSE 0 END) sold_qty,
      SUM(CASE WHEN d.type='sale_return' THEN l.base_qty ELSE 0 END) returned_qty,
      SUM(CASE WHEN d.type='sale' THEN l.net ELSE 0 END) sales,
      SUM(CASE WHEN d.type='sale_return' THEN l.net ELSE 0 END) returns,
      SUM(CASE WHEN d.type='sale' THEN l.tax ELSE -l.tax END) tax,
      SUM(CASE WHEN d.type='sale' THEN l.cost ELSE -l.cost END) cost,
      COUNT(DISTINCT CASE WHEN d.type='sale' THEN d.id END) invoices
    FROM docs d JOIN doc_lines l ON l.doc_id=d.id LEFT JOIN parties p ON p.id=d.party_id LEFT JOIN reps r ON r.id=d.rep_id
    LEFT JOIN warehouses w ON w.id=d.warehouse_id LEFT JOIN items i ON i.id=l.item_id LEFT JOIN categories c ON c.id=i.category_id
    WHERE ${w.join(' AND ')} GROUP BY ${g.key} ORDER BY sales DESC`).all(...params);
  const out = rows.map((r) => {
    const o = { name: r.name, invoices: r.invoices, sales: m(r.sales), returns: m(r.returns), net_sales: m(r.sales - r.returns), tax: m(r.tax) };
    if (opts.group === 'item' || !opts.group) { o.sold_qty = q(r.sold_qty); o.returned_qty = q(r.returned_qty); }
    if (showCost) { o.cost = m(r.cost); o.profit = m(r.sales - r.returns - r.cost); }
    return o;
  });
  const cols = [{ key: 'name', label: g.label }];
  if (opts.group === 'item' || !opts.group) cols.push({ key: 'sold_qty', label: 'الكمية المباعة', type: 'qty' }, { key: 'returned_qty', label: 'المرتجع', type: 'qty' });
  cols.push({ key: 'invoices', label: 'عدد الفواتير', type: 'int' }, { key: 'sales', label: 'المبيعات', type: 'money' }, { key: 'returns', label: 'المرتجعات', type: 'money' },
    { key: 'net_sales', label: 'صافي البيع', type: 'money' }, { key: 'tax', label: 'الضريبة', type: 'money' });
  if (showCost) cols.push({ key: 'cost', label: 'التكلفة', type: 'money' }, { key: 'profit', label: 'مجمل الربح', type: 'money' });
  // حسب طريقة الدفع
  const methods = ctx.db.prepare(`SELECT c.name, c.kind, SUM(a.amount) v FROM allocations a JOIN docs s ON s.id=a.source_doc_id JOIN docs t ON t.id=a.target_doc_id
      JOIN cash_accounts c ON c.id=s.cash_account_id
    WHERE s.type='receipt' AND t.type='sale' AND a.reversed=0 AND t.date BETWEEN ? AND ? GROUP BY c.id`).all(p.from, p.to)
    .map((r) => ({ name: r.name, kind: r.kind, amount: m(r.v) }));
  return { title: `المبيعات حسب ${g.label}`, ...p, columns: cols, rows: out, totals: totalsOf(out, cols), by_payment: methods };
}

function totalsOf(rows, cols) {
  const t = {};
  for (const c of cols) if (c.type === 'money' || c.type === 'qty' || c.type === 'int') t[c.key] = Number(rows.reduce((s, r) => s + (r[c.key] || 0), 0).toFixed(3));
  return t;
}

// ===================== المشتريات =====================
function purchasesReport(ctx, opts = {}) {
  ctx.require('reports.purchases');
  const p = period(ctx, opts);
  const bySupplier = opts.group !== 'item';
  const rows = ctx.db.prepare(bySupplier
    ? `SELECT p.name, SUM(CASE WHEN d.type='purchase' THEN d.total ELSE 0 END) purchases, SUM(CASE WHEN d.type='purchase_return' THEN d.total ELSE 0 END) returns,
        COUNT(CASE WHEN d.type='purchase' THEN 1 END) invoices, p.id party_id
       FROM docs d JOIN parties p ON p.id=d.party_id WHERE d.status='approved' AND d.type IN ('purchase','purchase_return') AND d.date BETWEEN ? AND ? GROUP BY p.id ORDER BY purchases DESC`
    : `SELECT l.item_name name, SUM(CASE WHEN d.type='purchase' THEN l.base_qty ELSE -l.base_qty END) qty, SUM(CASE WHEN d.type='purchase' THEN l.cost ELSE -l.cost END) cost,
        COUNT(DISTINCT d.id) invoices
       FROM docs d JOIN doc_lines l ON l.doc_id=d.id WHERE d.status='approved' AND d.type IN ('purchase','purchase_return') AND d.date BETWEEN ? AND ? GROUP BY l.item_id ORDER BY cost DESC`)
    .all(p.from, p.to);
  let cols, out;
  if (bySupplier) {
    out = rows.map((r) => ({
      name: r.name, invoices: r.invoices, purchases: m(r.purchases), returns: m(r.returns), net: m(r.purchases - r.returns),
      payable: m(-ledger.balance(ctx.db, 'AP', { party_id: r.party_id })),
    }));
    cols = [{ key: 'name', label: 'المورد' }, { key: 'invoices', label: 'الفواتير', type: 'int' }, { key: 'purchases', label: 'المشتريات', type: 'money' },
      { key: 'returns', label: 'المرتجعات', type: 'money' }, { key: 'net', label: 'الصافي', type: 'money' }, { key: 'payable', label: 'المستحق الحالي', type: 'money' }];
  } else {
    out = rows.map((r) => ({ name: r.name, invoices: r.invoices, qty: q(r.qty), cost: ctx.has('cost.view') ? m(r.cost) : null }));
    cols = [{ key: 'name', label: 'الصنف' }, { key: 'invoices', label: 'الفواتير', type: 'int' }, { key: 'qty', label: 'الكمية (وحدة الأساس)', type: 'qty' }];
    if (ctx.has('cost.view')) cols.push({ key: 'cost', label: 'التكلفة', type: 'money' });
  }
  return { title: bySupplier ? 'المشتريات حسب المورد' : 'المشتريات حسب الصنف', ...p, columns: cols, rows: out, totals: totalsOf(out, cols) };
}

// ===================== كشف الحساب =====================
function partyStatement(ctx, { party_id, account, from, to }) {
  ctx.require('parties.view');
  const party = require('./masters').getPartyRow(ctx, party_id);
  const acc = account === 'AP' ? 'AP' : 'AR';
  const sign = acc === 'AR' ? 1 : -1;
  const p = { from: from ? checkDate(from) : '0000-01-01', to: to ? checkDate(to) : ctx.today() };
  const opening = sign * ledger.balance(ctx.db, acc, { party_id: party.id, to: addDays(p.from, -1) });
  const lines = ctx.db.prepare(`SELECT jl.date, jl.debit, jl.credit, d.id doc_id, d.number, d.type, d.status, d.due_date, d.notes FROM journal_lines jl JOIN docs d ON d.id=jl.doc_id
    WHERE jl.account=? AND jl.party_id=? AND jl.date BETWEEN ? AND ? ORDER BY jl.date, jl.id`).all(acc, party.id, p.from, p.to);
  let run = opening;
  const rows = lines.map((l) => {
    run += sign * (l.debit - l.credit);
    return {
      date: l.date, doc_id: l.doc_id, number: l.number, type: D.DOC_LABELS[l.type], due_date: l.due_date,
      debit: m(acc === 'AR' ? l.debit : l.credit), credit: m(acc === 'AR' ? l.credit : l.debit), balance: m(run), notes: l.notes,
    };
  });
  const closing = sign * ledger.balance(ctx.db, acc, { party_id: party.id, to: p.to });
  return {
    title: `كشف حساب ${acc === 'AR' ? 'العميل' : 'المورد'}: ${party.name}`, party: { id: party.id, name: party.name }, account: acc, ...p,
    opening: m(opening), closing: m(closing), matches: run === closing,
    columns: [{ key: 'date', label: 'التاريخ' }, { key: 'number', label: 'المستند', link: 'doc_id' }, { key: 'type', label: 'النوع' },
      { key: 'debit', label: acc === 'AR' ? 'مدين (عليه)' : 'دائن (له)', type: 'money' }, { key: 'credit', label: acc === 'AR' ? 'دائن (منه)' : 'مدين (دفعنا)', type: 'money' },
      { key: 'balance', label: 'الرصيد', type: 'money' }],
    rows,
    open_docs: require('./payments').openDocs(ctx, { party_id: party.id, account: acc }),
  };
}

/** أعمار الديون حسب تاريخ الاستحقاق */
function aging(ctx, { account = 'AR', as_of } = {}) {
  ctx.require(account === 'AR' ? 'reports.sales' : 'reports.purchases');
  const asOf = as_of ? checkDate(as_of) : ctx.today();
  const side = account === 'AR' ? 'D' : 'C';
  const docs = ctx.db.prepare(`SELECT d.*, p.name party FROM docs d JOIN parties p ON p.id=d.party_id WHERE d.status='approved' AND d.ledger_account=? AND d.ledger_side=?
    ${ctx.repScope ? 'AND p.rep_id=' + Number(ctx.repScope) : ''}`).all(account, side);
  const parties = new Map();
  for (const d of docs) {
    const open = D.openAmount(ctx, d.id);
    if (open <= 0) continue;
    const due = d.due_date || d.date;
    const days = Math.floor((Date.parse(asOf) - Date.parse(due)) / 86400000);
    const bucket = days <= 0 ? 'current' : days <= 30 ? 'd30' : days <= 60 ? 'd60' : days <= 90 ? 'd90' : 'd90p';
    const r = parties.get(d.party_id) || { party_id: d.party_id, name: d.party, current: 0, d30: 0, d60: 0, d90: 0, d90p: 0, total: 0, unapplied: 0 };
    r[bucket] += open; r.total += open;
    parties.set(d.party_id, r);
  }
  // الأرصدة الدائنة غير المخصصة (دفعات مقدمة)
  const credits = ctx.db.prepare(`SELECT d.id, d.party_id, p.name party FROM docs d JOIN parties p ON p.id=d.party_id WHERE d.status='approved' AND d.ledger_account=? AND d.ledger_side<>?`).all(account, side);
  for (const c of credits) {
    const open = D.openAmount(ctx, c.id);
    if (open <= 0) continue;
    const r = parties.get(c.party_id) || { party_id: c.party_id, name: c.party, current: 0, d30: 0, d60: 0, d90: 0, d90p: 0, total: 0, unapplied: 0 };
    r.unapplied += open; r.total -= open;
    parties.set(c.party_id, r);
  }
  const rows = [...parties.values()].map((r) => ({ ...r, current: m(r.current), d30: m(r.d30), d60: m(r.d60), d90: m(r.d90), d90p: m(r.d90p), unapplied: m(r.unapplied), total: m(r.total) }))
    .sort((a, b) => b.total - a.total);
  const cols = [{ key: 'name', label: account === 'AR' ? 'العميل' : 'المورد' }, { key: 'current', label: 'غير مستحق', type: 'money' }, { key: 'd30', label: '1-30 يوم', type: 'money' },
    { key: 'd60', label: '31-60', type: 'money' }, { key: 'd90', label: '61-90', type: 'money' }, { key: 'd90p', label: 'أكثر من 90', type: 'money' },
    { key: 'unapplied', label: 'دفعات غير مخصصة', type: 'money' }, { key: 'total', label: 'الصافي', type: 'money' }];
  return { title: account === 'AR' ? 'أعمار ديون العملاء' : 'أعمار مستحقات الموردين', as_of: asOf, columns: cols, rows, totals: totalsOf(rows, cols) };
}

// ===================== المخزون =====================
function stockReport(ctx, opts = {}) {
  ctx.require('stock.view');
  const showCost = ctx.has('cost.view');
  const minExp = inv.minSellableExpiry(ctx);
  const w = ['b.qty>0'];
  const p = [];
  if (opts.warehouse_id) { w.push('b.warehouse_id=?'); p.push(Number(opts.warehouse_id)); }
  if (opts.item_id) { w.push('b.item_id=?'); p.push(Number(opts.item_id)); }
  if (opts.category_id) { w.push('i.category_id=?'); p.push(Number(opts.category_id)); }
  if (ctx.repScope) { w.push('b.warehouse_id=(SELECT warehouse_id FROM reps WHERE id=?)'); p.push(ctx.repScope); }
  if (opts.by === 'batch') {
    const rows = ctx.db.prepare(`SELECT b.id batch_id, i.code, i.name, i.base_unit, w.name warehouse, b.batch_no, b.prod_date, b.expiry_date, b.status, b.qty, b.cost
      FROM batches b JOIN items i ON i.id=b.item_id JOIN warehouses w ON w.id=b.warehouse_id WHERE ${w.join(' AND ')} ORDER BY i.name, b.expiry_date`).all(...p)
      .map((r) => {
        const st = r.status === 'ok' ? (r.expiry_date && r.expiry_date < minExp ? 'منتهي' : 'صالح') : r.status === 'isolated' ? 'معزول' : 'قيد الفحص';
        const o = { ...r, state: st, qty: q(r.qty), cost: showCost ? m(r.cost) : undefined, unit_cost: showCost && r.qty ? Math.round((r.cost / r.qty) * 1000) / 100 : undefined };
        if (opts.state && opts.state !== st) return null;
        return o;
      }).filter(Boolean);
    const cols = [{ key: 'code', label: 'الكود' }, { key: 'name', label: 'الصنف' }, { key: 'warehouse', label: 'المستودع' }, { key: 'batch_no', label: 'الدفعة' },
      { key: 'expiry_date', label: 'الانتهاء' }, { key: 'state', label: 'الحالة' }, { key: 'qty', label: 'الكمية', type: 'qty' }, { key: 'base_unit', label: 'الوحدة' }];
    if (showCost) cols.push({ key: 'unit_cost', label: 'تكلفة الوحدة', type: 'money' }, { key: 'cost', label: 'القيمة', type: 'money' });
    return { title: 'رصيد المخزون حسب الدفعة', columns: cols, rows, totals: totalsOf(rows, cols) };
  }
  const rows = ctx.db.prepare(`SELECT i.id item_id, i.code, i.name, i.base_unit, i.reorder_level,
      SUM(CASE WHEN b.status='ok' AND (b.expiry_date IS NULL OR b.expiry_date>=?) THEN b.qty ELSE 0 END) sellable,
      SUM(CASE WHEN b.status='ok' AND (b.expiry_date IS NULL OR b.expiry_date>=?) THEN b.cost ELSE 0 END) sellable_cost,
      SUM(CASE WHEN b.status='ok' AND b.expiry_date<? THEN b.qty ELSE 0 END) expired,
      SUM(CASE WHEN b.status='isolated' THEN b.qty ELSE 0 END) isolated,
      SUM(CASE WHEN b.status='pending' THEN b.qty ELSE 0 END) pending,
      SUM(b.qty) total, SUM(b.cost) cost
    FROM batches b JOIN items i ON i.id=b.item_id WHERE ${w.join(' AND ')} GROUP BY i.id ORDER BY i.name`).all(minExp, minExp, minExp, ...p)
    .map((r) => ({
      item_id: r.item_id, code: r.code, name: r.name, base_unit: r.base_unit, sellable: q(r.sellable), expired: q(r.expired), isolated: q(r.isolated),
      pending: q(r.pending), total: q(r.total), low: r.reorder_level > 0 && r.sellable <= r.reorder_level ? 'ناقص' : '',
      sellable_value: showCost ? m(r.sellable_cost) : undefined, value: showCost ? m(r.cost) : undefined,
    }));
  const cols = [{ key: 'code', label: 'الكود' }, { key: 'name', label: 'الصنف' }, { key: 'base_unit', label: 'الوحدة' }, { key: 'sellable', label: 'الصالح للبيع', type: 'qty' },
    { key: 'expired', label: 'منتهي', type: 'qty' }, { key: 'isolated', label: 'معزول', type: 'qty' }, { key: 'pending', label: 'قيد الفحص', type: 'qty' },
    { key: 'total', label: 'الإجمالي', type: 'qty' }, { key: 'low', label: 'تنبيه' }];
  if (showCost) cols.push({ key: 'sellable_value', label: 'قيمة الصالح', type: 'money' }, { key: 'value', label: 'القيمة الكلية', type: 'money' });
  return { title: 'رصيد المخزون حسب الصنف', columns: cols, rows, totals: totalsOf(rows, cols) };
}

/** بطاقة صنف: حركات الصنف مع الرصيد الجاري */
function itemCard(ctx, { item_id, warehouse_id, from, to }) {
  ctx.require('stock.view');
  const item = D.getItem(ctx, item_id);
  const p = { from: from || '0000-01-01', to: to || ctx.today() };
  const wf = warehouse_id ? 'AND sm.warehouse_id=' + Number(warehouse_id) : '';
  const opening = ctx.db.prepare(`SELECT COALESCE(SUM(qty),0) q, COALESCE(SUM(cost),0) c FROM stock_moves sm WHERE item_id=? AND date<? ${wf}`).get(item.id, p.from);
  const moves = ctx.db.prepare(`SELECT sm.date, sm.qty, sm.cost, d.id doc_id, d.number, d.type, w.name warehouse, b.batch_no, b.expiry_date
    FROM stock_moves sm JOIN docs d ON d.id=sm.doc_id JOIN warehouses w ON w.id=sm.warehouse_id JOIN batches b ON b.id=sm.batch_id
    WHERE sm.item_id=? AND sm.date BETWEEN ? AND ? ${wf} ORDER BY sm.date, sm.id`).all(item.id, p.from, p.to);
  let rq = opening.q, rc = opening.c;
  const showCost = ctx.has('cost.view');
  const rows = moves.map((mv) => {
    rq += mv.qty; rc += mv.cost;
    return {
      date: mv.date, doc_id: mv.doc_id, number: mv.number, type: D.DOC_LABELS[mv.type], warehouse: mv.warehouse, batch_no: mv.batch_no, expiry_date: mv.expiry_date,
      in: mv.qty > 0 ? q(mv.qty) : 0, out: mv.qty < 0 ? q(-mv.qty) : 0, balance: q(rq), cost: showCost ? m(mv.cost) : undefined, value: showCost ? m(rc) : undefined,
    };
  });
  const cols = [{ key: 'date', label: 'التاريخ' }, { key: 'number', label: 'المستند', link: 'doc_id' }, { key: 'type', label: 'النوع' }, { key: 'warehouse', label: 'المستودع' },
    { key: 'batch_no', label: 'الدفعة' }, { key: 'in', label: 'وارد', type: 'qty' }, { key: 'out', label: 'صادر', type: 'qty' }, { key: 'balance', label: 'الرصيد', type: 'qty' }];
  if (showCost) cols.push({ key: 'cost', label: 'قيمة الحركة', type: 'money' }, { key: 'value', label: 'قيمة الرصيد', type: 'money' });
  return { title: `بطاقة صنف: ${item.name} (${item.base_unit})`, ...p, opening_qty: q(opening.q), columns: cols, rows };
}

// ===================== المصروفات والنقد =====================
function expensesReport(ctx, opts = {}) {
  ctx.require('reports.finance');
  const p = period(ctx, opts);
  const rows = ctx.db.prepare(`SELECT d.id doc_id, d.number, d.date, ec.name category, d.net, d.tax, d.total, d.notes, d.status,
      json_extract(d.data,'$.beneficiary') beneficiary FROM docs d LEFT JOIN expense_categories ec ON ec.id=d.expense_category_id
    WHERE d.type='expense' AND d.status='approved' AND d.date BETWEEN ? AND ? ORDER BY d.date, d.id`).all(p.from, p.to)
    .map((r) => ({ ...r, net: m(r.net), tax: m(r.tax), total: m(r.total), open: m(D.openAmount(ctx, r.doc_id)) }));
  const cols = [{ key: 'date', label: 'التاريخ' }, { key: 'number', label: 'المستند', link: 'doc_id' }, { key: 'category', label: 'التصنيف' }, { key: 'beneficiary', label: 'المستفيد' },
    { key: 'notes', label: 'البيان' }, { key: 'net', label: 'المبلغ', type: 'money' }, { key: 'tax', label: 'الضريبة', type: 'money' }, { key: 'total', label: 'الإجمالي', type: 'money' },
    { key: 'open', label: 'غير مدفوع', type: 'money' }];
  return { title: 'المصروفات', ...p, columns: cols, rows, totals: totalsOf(rows, cols) };
}

function cashReport(ctx, opts = {}) {
  ctx.require('cash.view');
  const p = period(ctx, opts);
  if (opts.cash_account_id) {
    const acc = ctx.db.prepare('SELECT * FROM cash_accounts WHERE id=?').get(opts.cash_account_id);
    const opening = ledger.balance(ctx.db, 'CASH', { cash_account_id: acc.id, to: addDays(p.from, -1) });
    let run = opening;
    const rows = ctx.db.prepare(`SELECT jl.date, jl.debit, jl.credit, d.id doc_id, d.number, d.type, d.notes, p.name party FROM journal_lines jl JOIN docs d ON d.id=jl.doc_id
      LEFT JOIN parties p ON p.id=d.party_id WHERE jl.account='CASH' AND jl.cash_account_id=? AND jl.date BETWEEN ? AND ? ORDER BY jl.date, jl.id`).all(acc.id, p.from, p.to)
      .map((r) => { run += r.debit - r.credit; return { date: r.date, doc_id: r.doc_id, number: r.number, type: D.DOC_LABELS[r.type], party: r.party, notes: r.notes, in: m(r.debit), out: m(r.credit), balance: m(run) }; });
    const cols = [{ key: 'date', label: 'التاريخ' }, { key: 'number', label: 'المستند', link: 'doc_id' }, { key: 'type', label: 'النوع' }, { key: 'party', label: 'الطرف' },
      { key: 'notes', label: 'البيان' }, { key: 'in', label: 'وارد', type: 'money' }, { key: 'out', label: 'صادر', type: 'money' }, { key: 'balance', label: 'الرصيد', type: 'money' }];
    return { title: `حركة ${acc.name}`, ...p, opening: m(opening), closing: m(run), columns: cols, rows, totals: totalsOf(rows, cols.filter((c) => c.key !== 'balance')) };
  }
  const rows = ctx.db.prepare('SELECT * FROM cash_accounts ORDER BY kind, name').all().map((a) => {
    const opening = ledger.balance(ctx.db, 'CASH', { cash_account_id: a.id, to: addDays(p.from, -1) });
    const r = ctx.db.prepare(`SELECT COALESCE(SUM(debit),0) d, COALESCE(SUM(credit),0) c FROM journal_lines WHERE account='CASH' AND cash_account_id=? AND date BETWEEN ? AND ?`).get(a.id, p.from, p.to);
    return { id: a.id, name: a.name, kind: { cash: 'صندوق', bank: 'بنك', rep_custody: 'عهدة مندوب' }[a.kind], opening: m(opening), in: m(r.d), out: m(r.c), closing: m(opening + r.d - r.c) };
  });
  const cols = [{ key: 'name', label: 'الحساب' }, { key: 'kind', label: 'النوع' }, { key: 'opening', label: 'رصيد أول المدة', type: 'money' }, { key: 'in', label: 'المقبوضات', type: 'money' },
    { key: 'out', label: 'المدفوعات', type: 'money' }, { key: 'closing', label: 'رصيد آخر المدة', type: 'money' }];
  return { title: 'الصناديق والبنوك', ...p, columns: cols, rows, totals: totalsOf(rows, cols) };
}

function repsReport(ctx, opts = {}) {
  ctx.require('reps.view');
  const p = period(ctx, opts);
  const rows = ctx.db.prepare('SELECT * FROM reps ORDER BY name').all().map((r) => {
    const s = ctx.db.prepare(`SELECT COALESCE(SUM(CASE WHEN type='sale' THEN net ELSE -net END),0) v FROM docs WHERE rep_id=? AND type IN ('sale','sale_return') AND status='approved' AND date BETWEEN ? AND ?`).get(r.id, p.from, p.to).v;
    const col = ctx.db.prepare(`SELECT COALESCE(SUM(a.amount),0) v FROM allocations a JOIN docs s ON s.id=a.source_doc_id JOIN docs t ON t.id=a.target_doc_id
      WHERE s.type='receipt' AND t.type='sale' AND t.rep_id=? AND a.reversed=0 AND a.date BETWEEN ? AND ?`).get(r.id, p.from, p.to).v;
    const comm = ctx.db.prepare(`SELECT COALESCE(SUM(CASE WHEN ledger_side='C' THEN total ELSE -total END),0) v FROM docs WHERE type='commission' AND status='approved' AND rep_id=? AND date BETWEEN ? AND ?`).get(r.id, p.from, p.to).v;
    const payable = -ledger.balance(ctx.db, 'COMMISSION_PAYABLE', { rep_id: r.id });
    const custody = r.custody_account_id ? ledger.balance(ctx.db, 'CASH', { cash_account_id: r.custody_account_id }) : 0;
    const goods = ctx.db.prepare('SELECT COALESCE(SUM(cost),0) c FROM batches WHERE warehouse_id=?').get(r.warehouse_id).c;
    return { rep_id: r.id, name: r.name, net_sales: m(s), collections: m(col), commissions: m(comm), commission_payable: m(payable), cash_custody: m(custody), goods_custody: ctx.has('cost.view') ? m(goods) : undefined };
  });
  const cols = [{ key: 'name', label: 'المندوب' }, { key: 'net_sales', label: 'صافي المبيعات', type: 'money' }, { key: 'collections', label: 'التحصيلات', type: 'money' },
    { key: 'commissions', label: 'العمولات المعتمدة', type: 'money' }, { key: 'commission_payable', label: 'عمولات غير مدفوعة', type: 'money' }, { key: 'cash_custody', label: 'العهدة النقدية', type: 'money' }];
  if (ctx.has('cost.view')) cols.push({ key: 'goods_custody', label: 'عهدة البضاعة (تكلفة)', type: 'money' });
  return { title: 'المناديب وتحصيلاتهم وعهدهم وعمولاتهم', ...p, columns: cols, rows, totals: totalsOf(rows, cols) };
}

function taxReport(ctx, opts = {}) {
  ctx.require('reports.finance');
  const p = period(ctx, opts);
  const out = -sumAcc(ctx, 'TAX_OUT', p);
  const inp = sumAcc(ctx, 'TAX_IN', p);
  return { ...p, output_tax: m(out), input_tax: m(inp), net_due: m(out - inp) };
}

/** سجل المستندات مع البحث والتصفية */
function listDocs(ctx, opts = {}) {
  const w = ['1=1'];
  const p = [];
  const typePerm = {
    sale: 'sales.view', sale_return: 'sales.view', purchase: 'purchases.view', purchase_return: 'purchases.view', receipt: 'cash.receipt', payment: 'cash.view',
    expense: 'expenses.create', transfer: 'stock.view', stock_count: 'stock.view', damage: 'stock.view', opening_stock: 'stock.view', opening_balance: 'opening.manage',
    cash_transfer: 'cash.view', session_variance: 'cash.view', custody_settlement: 'reps.view', commission: 'commissions.manage', batch_status: 'stock.view',
  };
  if (opts.type) {
    const types = String(opts.type).split(',');
    for (const t of types) if (typePerm[t]) ctx.require(typePerm[t]);
    w.push(`d.type IN (${types.map(() => '?').join(',')})`); p.push(...types);
  } else {
    const allowed = Object.keys(typePerm).filter((t) => ctx.has(typePerm[t]));
    w.push(`d.type IN (${allowed.map(() => '?').join(',') || "''"})`); p.push(...allowed);
  }
  if (opts.status) { w.push('d.status=?'); p.push(opts.status); }
  if (opts.from) { w.push('d.date>=?'); p.push(opts.from); }
  if (opts.to) { w.push('d.date<=?'); p.push(opts.to); }
  if (opts.party_id) { w.push('d.party_id=?'); p.push(Number(opts.party_id)); }
  if (opts.rep_id) { w.push('d.rep_id=?'); p.push(Number(opts.rep_id)); }
  if (opts.q) { w.push('(d.number LIKE ? OR p.name LIKE ? OR d.supplier_invoice_no LIKE ? OR d.notes LIKE ?)'); p.push(`%${opts.q}%`, `%${opts.q}%`, `%${opts.q}%`, `%${opts.q}%`); }
  if (ctx.repScope) { w.push('d.rep_id=?'); p.push(ctx.repScope); }
  if (opts.mine) { w.push('d.created_by=?'); p.push(ctx.userId); }
  const limit = Math.min(Number(opts.limit) || 50, 500);
  const offset = Number(opts.offset) || 0;
  const total = ctx.db.prepare(`SELECT COUNT(*) n FROM docs d LEFT JOIN parties p ON p.id=d.party_id WHERE ${w.join(' AND ')}`).get(...p).n;
  const rows = ctx.db.prepare(`SELECT d.id, d.type, d.number, d.date, d.status, d.total, d.net, d.tax, d.party_id, p.name party_name, d.ledger_account, d.due_date,
      d.supplier_invoice_no, r.name rep_name, u.full_name created_by_name, d.notes
    FROM docs d LEFT JOIN parties p ON p.id=d.party_id LEFT JOIN reps r ON r.id=d.rep_id LEFT JOIN users u ON u.id=d.created_by
    WHERE ${w.join(' AND ')} ORDER BY d.date DESC, d.id DESC LIMIT ? OFFSET ?`).all(...p, limit, offset);
  return {
    total, rows: rows.map((r) => ({
      ...D.present(r), label: D.DOC_LABELS[r.type],
      open_amount: r.ledger_account && r.status === 'approved' ? m(D.openAmount(ctx, r.id)) : null,
      payment_status: r.ledger_account ? D.paymentStatus(ctx, r) : null,
    })),
  };
}

function auditLog(ctx, opts = {}) {
  ctx.require('audit.view');
  const w = ['1=1'];
  const p = [];
  if (opts.user) { w.push('username=?'); p.push(opts.user); }
  if (opts.action) { w.push('action LIKE ?'); p.push(`%${opts.action}%`); }
  if (opts.from) { w.push('ts>=?'); p.push(opts.from); }
  if (opts.to) { w.push('ts<=?'); p.push(opts.to + 'T23:59:59Z'); }
  if (opts.q) { w.push('(doc_number LIKE ? OR reason LIKE ? OR after_json LIKE ?)'); p.push(`%${opts.q}%`, `%${opts.q}%`, `%${opts.q}%`); }
  if (opts.denied) w.push('ok=0');
  const limit = Math.min(Number(opts.limit) || 100, 1000);
  return ctx.db.prepare(`SELECT * FROM audit_log WHERE ${w.join(' AND ')} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...p, limit, Number(opts.offset) || 0);
}

module.exports = {
  profitLoss, dashboard, alerts, salesReport, purchasesReport, partyStatement, aging, stockReport, itemCard, expensesReport, cashReport, repsReport, taxReport,
  listDocs, auditLog,
};
