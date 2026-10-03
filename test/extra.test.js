'use strict';
// الاختبارات المالية والتشغيلية الإضافية (القسم 17) وحالات حدية.
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./helpers');
const Sales = require('../src/core/sales');
const Pur = require('../src/core/purchases');
const Pay = require('../src/core/payments');
const S = require('../src/core/stock');
const F = require('../src/core/finance');
const M = require('../src/core/masters');
const R = require('../src/core/reps');

test('مرتجع منتهٍ لا يزيد الرصيد الصالح ويظهر معزولاً', () => {
  const e = setup();
  const item = e.item({ price: 10, track_expiry: 1 });
  e.stock(item, 5, 4, { expiry: '2026-10-03', batch: 'X' });
  const sale = Sales.createSale(e.admin, { lines: [{ item_id: item.id, qty: 2 }], payments: [{ cash_account_id: e.cashId, amount: 20 }] });
  // بعد انتهاء الدفعة
  const later = e.ctxFor(e.admin.user);
  later._today = '2026-10-10';
  assert.equal(e.sellable(item.id), 3);
  Sales.createSaleReturn(later, { sale_id: sale.id, reason: 'منتهي', lines: [{ line_id: sale.lines[0].id, qty: 1 }], refund: { cash_account_id: e.cashId } });
  const iso = e.db.prepare("SELECT SUM(qty)/1000 q FROM batches WHERE item_id=? AND status='isolated'").get(item.id).q;
  assert.equal(iso, 1, 'يظهر في المعزول');
  const inv = require('../src/core/inventory');
  assert.equal(inv.sellableQty(later, item.id, 1), 0, 'لا يزيد الرصيد الصالح');
  assert.equal(e.bal('INVENTORY'), 16, 'المعزول يبقى مخزونًا بتكلفته (12 + 4)');
});

test('مرتجع تالف: خسارة موثقة دون تكرار احتساب التكلفة', () => {
  const e = setup();
  const item = e.item({ price: 10 });
  e.stock(item, 5, 4);
  const sale = Sales.createSale(e.admin, { lines: [{ item_id: item.id, qty: 2 }], payments: [{ cash_account_id: e.cashId, amount: 20 }] });
  Sales.createSaleReturn(e.admin, { sale_id: sale.id, reason: 'مكسور', lines: [{ line_id: sale.lines[0].id, qty: 1, condition: 'damaged' }], refund: { cash_account_id: e.cashId } });
  assert.equal(e.bal('COGS'), 4, 'تكلفة البيع للحبة المتبقية');
  assert.equal(e.bal('INV_LOSS'), 4, 'خسارة التالف');
  assert.equal(e.stockQty(item.id).qty, 3);
});

test('مرتجع قيد الفحص ثم إفراج صالح', () => {
  const e = setup();
  const item = e.item({ price: 10 });
  e.stock(item, 5, 4);
  const sale = Sales.createSale(e.admin, { lines: [{ item_id: item.id, qty: 2 }], payments: [{ cash_account_id: e.cashId, amount: 20 }] });
  Sales.createSaleReturn(e.admin, { sale_id: sale.id, reason: 'فحص', lines: [{ line_id: sale.lines[0].id, qty: 1, condition: 'pending' }], refund: { cash_account_id: e.cashId } });
  assert.equal(e.sellable(item.id), 3, 'حالة الفحص المعلقة لا تزيد المتاح');
  const pending = e.db.prepare("SELECT id FROM batches WHERE status='pending' AND qty>0").get();
  S.changeBatchStatus(e.admin, { batch_id: pending.id, to_status: 'ok', reason: 'فحص سليم' });
  assert.equal(e.sellable(item.id), 4);
});

test('مصروف 100 يعتمد ثم يدفع: مصروف 100 فقط ونقد ناقص 100 فقط', () => {
  const e = setup();
  e.fundCash(500);
  const exp = F.createExpense(e.admin, { expense_category_id: 1, amount: 100, description: 'إيجار', approve: true });
  assert.equal(e.bal('EXPENSES'), 100);
  assert.equal(e.bal('CASH'), 500, 'الاعتماد لا يمس النقد');
  F.payExpense(e.admin, exp.id, { cash_account_id: e.cashId });
  assert.equal(e.bal('EXPENSES'), 100, 'مصروف 100 فقط');
  assert.equal(e.bal('CASH'), 400, 'نقد ناقص 100 فقط');
  assert.throws(() => F.payExpense(e.admin, exp.id, { cash_account_id: e.cashId }), (err) => err.code === 'ALREADY_PAID');
});

test('تحويل 10 حبات بين مستودعين: الإجمالي والقيمة ثابتان', () => {
  const e = setup();
  const item = e.item();
  e.stock(item, 30, 3);
  const wh2 = M.saveWarehouse(e.admin, { name: 'مستودع 2' });
  const before = e.stockQty(item.id);
  S.createTransfer(e.admin, { from_warehouse_id: e.mainWh, to_warehouse_id: wh2.id, lines: [{ item_id: item.id, qty: 10 }] });
  assert.equal(e.stockQty(item.id, e.mainWh).qty, 20, 'المصدر ناقص 10');
  assert.equal(e.stockQty(item.id, wh2.id).qty, 10, 'الوجهة زائد 10');
  assert.deepEqual(e.stockQty(item.id), before, 'إجمالي المخزون والقيمة ثابتان');
  assert.equal(e.bal('INVENTORY'), 90);
  assert.equal(e.bal('SALES'), 0, 'لا ينشئ إيرادًا');
});

test('سداد عمولة معتمدة مرتين: الأول ينجح والثاني يُرفض', () => {
  const e = setup();
  e.fundCash(1000);
  const rep = M.createRep(e.admin, { name: 'ماجد', commission_pct: 5 });
  const item = e.item({ price: 100 });
  e.stock(item, 10, 50);
  const c = e.customer({ rep_id: rep.id });
  const sale = Sales.createSale(e.admin, { party_id: c.id, lines: [{ item_id: item.id, qty: 2 }] });
  Pay.createReceipt(e.admin, { party_id: c.id, cash_account_id: e.cashId, amount: 200, allocations: 'auto' });
  const com = R.calculateCommission(e.admin, { rep_id: rep.id });
  assert.equal(com.total, 10);
  R.approveCommission(e.admin, com.id);
  R.payCommission(e.admin, com.id, { cash_account_id: e.cashId });
  assert.throws(() => R.payCommission(e.admin, com.id, { cash_account_id: e.cashId }), (err) => err.code === 'ALREADY_PAID');
  assert.equal(e.bal('COMMISSION_EXP'), 10, 'دون أثر إضافي');
  assert.equal(e.bal('COMMISSION_PAYABLE'), 0);
  assert.throws(() => R.calculateCommission(e.admin, { rep_id: rep.id }), (err) => err.code === 'NOTHING_TO_CALC', 'لا تُحسب مرتين');
  void sale;
});

test('تصحيح العمولة عند إلغاء تحصيل محتسب', () => {
  const e = setup();
  e.fundCash(1000);
  const rep = M.createRep(e.admin, { name: 'نادر', commission_pct: 10 });
  const item = e.item({ price: 100 });
  e.stock(item, 10, 50);
  const c = e.customer({ rep_id: rep.id });
  Sales.createSale(e.admin, { party_id: c.id, lines: [{ item_id: item.id, qty: 3 }] });
  const rc = Pay.createReceipt(e.admin, { party_id: c.id, cash_account_id: e.cashId, amount: 300, allocations: 'auto' });
  const com = R.calculateCommission(e.admin, { rep_id: rep.id });
  R.approveCommission(e.admin, com.id);
  assert.equal(com.total, 30);
  Pay.reverseCashDoc(e.admin, rc.id, 'شيك مرتجع');
  Pay.createReceipt(e.admin, { party_id: c.id, cash_account_id: e.cashId, amount: 100, allocations: 'auto' });
  const com2 = R.calculateCommission(e.admin, { rep_id: rep.id });
  assert.equal(com2.net, -200, 'أساس التصحيح -300 + تحصيل جديد 100');
  assert.equal(com2.ledger_side, 'D', 'تصحيح سالب لصالح المؤسسة');
  assert.equal(com2.total, 20);
  R.approveCommission(e.admin, com2.id);
  const first = R.commissionDetail(e.admin, com.id);
  assert.equal(first.open_amount, 10, 'يُخصم التصحيح من العمولة غير المدفوعة');
  assert.equal(e.bal('COMMISSION_EXP'), 10);
});

test('وردية: افتتاحي 100 + بيع نقدي 200 + شبكة 150 - صرف نقدي 30 = متوقع 270', () => {
  const e = setup();
  const item = e.item({ price: 50 });
  e.stock(item, 20, 10);
  const cashier = e.makeUser('cash2', ['cashier', 'accountant']);
  e.fundCash(100);
  const s = F.openSession(cashier, { cash_account_id: e.cashId, card_account_id: e.bankId, opening_amount: 100 });
  Sales.createSale(cashier, { lines: [{ item_id: item.id, qty: 4 }], payments: [{ method: 'cash', amount: 200 }] });
  Sales.createSale(cashier, { lines: [{ item_id: item.id, qty: 3 }], payments: [{ method: 'card', amount: 150 }] });
  F.createExpense(cashier, { expense_category_id: 6, amount: 30, approve: true, pay: { method: 'cash' } });
  const live = F.getSession(cashier, s.id);
  assert.equal(live.live_expected, 270, 'النقد المتوقع 270');
  assert.equal(live.card_total, 150, 'الشبكة لا تزيد درج الكاشير');
  const closed = F.closeSession(cashier, s.id, { counted_amount: 265, reason: 'نقص فكة' });
  assert.equal(closed.variance, -5);
  assert.equal(closed.status, 'closing', 'الفرق بانتظار الاعتماد');
  const appr = F.approveSessionVariance(e.admin, s.id);
  assert.equal(appr.status, 'closed');
  assert.equal(e.bal('CASH_OVER_SHORT'), 5, 'الفرق منفصل');
});

test('إقفال الفترة يمنع التسجيل بتاريخ مقفل', () => {
  const e = setup();
  const item = e.item({ price: 5 });
  e.stock(item, 10, 2);
  F.lockPeriod(e.admin, { until: '2026-09-30' });
  assert.throws(() => Sales.createSale(e.admin, { date: '2026-09-15', lines: [{ item_id: item.id, qty: 1 }], payments: [{ cash_account_id: 1, amount: 5 }] }), (err) => err.code === 'PERIOD_LOCKED');
  Sales.createSale(e.admin, { lines: [{ item_id: item.id, qty: 1 }], payments: [{ cash_account_id: 1, amount: 5 }] });
});

test('الحد الائتماني وحد الخصم والسعر الأدنى تحتاج صلاحية وسببًا', () => {
  const e = setup();
  const item = e.item({ price: 100, maxDiscount: 5, minPrice: 80 });
  e.stock(item, 10, 50);
  const c = e.customer({ limit: 150 });
  const cashier = e.makeUser('cashier3', ['cashier']);
  F.openSession(cashier, { cash_account_id: e.cashId, opening_amount: 0 });
  assert.throws(() => Sales.createSale(cashier, { party_id: c.id, lines: [{ item_id: item.id, qty: 1, discount_pct: 10 }], payments: [{ amount: 90 }] }), (err) => err.status === 403);
  assert.throws(() => Sales.createSale(cashier, { party_id: c.id, lines: [{ item_id: item.id, qty: 2 }] }), (err) => err.status === 403, 'تجاوز الحد الائتماني');
  assert.throws(() => Sales.createSale(e.admin, { party_id: c.id, lines: [{ item_id: item.id, qty: 1, price: 70 }], payments: [{ cash_account_id: 1, amount: 70 }] }), (err) => err.code === 'REASON_REQUIRED');
  const ok = Sales.createSale(e.admin, { party_id: c.id, override_reason: 'عرض خاص معتمد', lines: [{ item_id: item.id, qty: 1, price: 70 }], payments: [{ cash_account_id: 1, amount: 70 }] });
  assert.equal(ok.reason, 'عرض خاص معتمد');
});

test('رقم فاتورة مورد مكرر يُرفض', () => {
  const e = setup();
  const item = e.item();
  const sup = e.supplier();
  Pur.createPurchase(e.admin, { party_id: sup.id, supplier_invoice_no: 'S-1', approve: true, lines: [{ item_id: item.id, qty: 1, price: 1 }] });
  assert.throws(() => Pur.createPurchase(e.admin, { party_id: sup.id, supplier_invoice_no: 'S-1', approve: true, lines: [{ item_id: item.id, qty: 1, price: 1 }] }), (err) => err.code === 'DUPLICATE_SUPPLIER_INVOICE');
  assert.equal(e.count('purchase'), 1);
});

test('الدقة: الحبة عدد صحيح والوزن عشري بدقة معلنة', () => {
  const e = setup();
  const piece = e.item({ price: 1 });
  const rice = e.item({ base: 'كجم', decimals: 3, price: 4.5 });
  e.stock(piece, 5, 1);
  e.stock(rice, 10.5, 3);
  assert.throws(() => Sales.createSale(e.admin, { lines: [{ item_id: piece.id, qty: 1.5 }] }), (err) => err.code === 'QTY_PRECISION');
  const s = Sales.createSale(e.admin, { lines: [{ item_id: rice.id, qty: 1.255 }], payments: [{ cash_account_id: 1, amount: 5.65 }] });
  assert.equal(s.total, 5.65);
  assert.equal(e.stockQty(rice.id).qty, 9.245);
});

test('إلغاء فاتورة مرتبطة بتحصيل لاحق ممنوع، وبدونها يعكس كل الأثر', () => {
  const e = setup();
  const item = e.item({ price: 10 });
  e.stock(item, 10, 4);
  const c = e.customer();
  const s1 = Sales.createSale(e.admin, { party_id: c.id, lines: [{ item_id: item.id, qty: 2 }] });
  Pay.createReceipt(e.admin, { party_id: c.id, cash_account_id: 1, amount: 5, allocations: [{ doc_id: s1.id, amount: 5 }] });
  assert.throws(() => Sales.reverseSale(e.admin, s1.id, 'خطأ إدخال'), (err) => err.code === 'HAS_DEPENDENTS');
  const s2 = Sales.createSale(e.admin, { lines: [{ item_id: item.id, qty: 3 }], payments: [{ cash_account_id: 1, amount: 30 }] });
  Sales.reverseSale(e.admin, s2.id, 'خطأ إدخال');
  assert.equal(e.stockQty(item.id).qty, 8);
  assert.equal(e.bal('CASH'), 5);
  assert.equal(-e.bal('SALES'), 20);
});

test('القيود متوازنة دائمًا وسجل التدقيق لا يُعدل', () => {
  const e = setup();
  const item = e.item({ price: 10, tax: 15 });
  e.stock(item, 10, 4);
  Sales.createSale(e.admin, { lines: [{ item_id: item.id, qty: 3, discount_amount: 1 }], payments: [{ cash_account_id: 1, amount: 33.35 }] });
  const r = e.db.prepare('SELECT SUM(debit) d, SUM(credit) c FROM journal_lines').get();
  assert.equal(r.d, r.c);
  assert.throws(() => e.db.prepare('DELETE FROM audit_log').run(), /append-only/);
  assert.throws(() => e.db.prepare('UPDATE journal_lines SET debit=0').run(), /append-only/);
});

test('تقارير الفترة تطابق المستندات المعتمدة', () => {
  const e = setup();
  const Rep = require('../src/core/reports');
  const item = e.item({ price: 25 });
  e.stock(item, 10, 10);
  const s = Sales.createSale(e.admin, { lines: [{ item_id: item.id, qty: 4 }], payments: [{ cash_account_id: 1, amount: 100 }] });
  Sales.createSaleReturn(e.admin, { sale_id: s.id, reason: 'x1x', lines: [{ line_id: s.lines[0].id, qty: 1 }], refund: { cash_account_id: 1 } });
  F.createExpense(e.admin, { expense_category_id: 1, amount: 20, approve: true, pay: { cash_account_id: 1 } });
  const pl = Rep.profitLoss(e.admin, { from: '2026-10-01', to: '2026-10-31' });
  assert.equal(pl.sales, 100);
  assert.equal(pl.returns, 25);
  assert.equal(pl.net_sales, 75);
  assert.equal(pl.cogs, 30);
  assert.equal(pl.gross_profit, 45);
  assert.equal(pl.expenses, 20);
  assert.equal(pl.operating_profit, 25);
  const dash = Rep.dashboard(e.admin, { from: '2026-10-01', to: '2026-10-31' });
  assert.equal(dash.net_sales, 75);
  assert.equal(dash.stock_value, 70);
});

test('طلب شراء واستلام جزئي على دفعتين ومنع تجاوز المطلوب', () => {
  const e = setup();
  const item = e.item({ name: 'زيت', carton: 12 });
  const carton = item.units.find((u) => u.name === 'كرتون');
  const sup = e.supplier();
  const po = Pur.createPurchaseOrder(e.admin, { party_id: sup.id, approve: true, lines: [{ item_id: item.id, unit_id: carton.id, qty: 10, price: 60 }] });
  assert.equal(po.data.po_state, 'open');
  assert.equal(e.bal('INVENTORY'), 0, 'الطلب لا يؤثر في المخزون');
  const pl = po.lines[0].id;
  Pur.createPurchase(e.admin, { party_id: sup.id, po_id: po.id, approve: true, lines: [{ item_id: item.id, unit_id: carton.id, qty: 4, price: 60, po_line_id: pl }] });
  let r = Pur.poRemaining(e.admin, po.id);
  assert.equal(r.lines[0].received, 4);
  assert.equal(r.lines[0].remaining, 6);
  assert.equal(r.po.data.po_state, 'partial');
  assert.throws(() => Pur.createPurchase(e.admin, { party_id: sup.id, po_id: po.id, approve: true, lines: [{ item_id: item.id, unit_id: carton.id, qty: 7, price: 60, po_line_id: pl }] }), (err) => err.code === 'OVER_RECEIPT');
  const p2 = Pur.createPurchase(e.admin, { party_id: sup.id, po_id: po.id, approve: true, lines: [{ item_id: item.id, unit_id: carton.id, qty: 6, price: 60, po_line_id: pl }] });
  assert.equal(Pur.poRemaining(e.admin, po.id).po.data.po_state, 'received');
  Pur.reversePurchase(e.admin, p2.id, 'إدخال خاطئ');
  r = Pur.poRemaining(e.admin, po.id);
  assert.equal(r.lines[0].remaining, 6, 'إلغاء الاستلام يعيد المتبقي');
  assert.equal(r.po.data.po_state, 'partial');
  Pur.closePurchaseOrder(e.admin, po.id, 'المورد لن يورد الباقي');
  assert.throws(() => Pur.createPurchase(e.admin, { party_id: sup.id, po_id: po.id, lines: [{ item_id: item.id, unit_id: carton.id, qty: 1, price: 60, po_line_id: pl }] }), (err) => err.code === 'INVALID_STATE');
  assert.equal(e.stockQty(item.id).qty, 48);
});

test('رمز QR للفاتورة المبسطة بصيغة TLV', async () => {
  const e = setup();
  const EI = require('../src/core/einvoice');
  e.db.prepare("UPDATE settings SET value='300000000000003' WHERE key='org_tax_number'").run();
  e.admin.invalidateSettings();
  const item = e.item({ price: 100, tax: 15 });
  e.stock(item, 5, 50);
  const s = Sales.createSale(e.admin, { lines: [{ item_id: item.id, qty: 2 }], payments: [{ cash_account_id: 1, amount: 230 }] });
  const doc = e.db.prepare('SELECT * FROM docs WHERE id=?').get(s.id);
  const { payload, svg } = await EI.qrSvg(e.admin, doc);
  const f = EI.decodeTlv(payload);
  assert.equal(f[1], e.admin.setting('org_name'));
  assert.equal(f[2], '300000000000003');
  assert.match(f[3], /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.equal(f[4], '230.00');
  assert.equal(f[5], '30.00');
  assert.ok(svg.startsWith('<svg'));
});

test('باركود الميزان: كود الصنف والوزن داخل الباركود', () => {
  const e = setup();
  const M2 = require('../src/core/masters');
  e.db.prepare("UPDATE settings SET value='21' WHERE key='scale_prefix'").run();
  e.admin.invalidateSettings();
  const cheese = M2.createItem(e.admin, { code: '01234', name: 'جبن أبيض', base_unit: 'كجم', qty_decimals: 3, sell_price: 40, track_expiry: 0 });
  const r = M2.lookupItem(e.admin, '2101234012508', 1); // 1.250 كجم
  assert.equal(r.length, 1);
  assert.equal(r[0].id, cheese.id);
  assert.equal(r[0].scale_qty, 1.25);
  e.db.prepare("UPDATE settings SET value='price' WHERE key='scale_mode'").run();
  e.admin.invalidateSettings();
  assert.equal(M2.lookupItem(e.admin, '2101234050003', 1)[0].scale_qty, 1.25, 'السعر 50.00 ÷ 40 = 1.25 كجم');
});

test('القيد اليدوي وميزان المراجعة والمركز المالي', () => {
  const e = setup();
  const A = require('../src/core/accounting');
  e.fundCash(1000);
  const item = e.item({ price: 25 });
  e.stock(item, 10, 10);
  Sales.createSale(e.admin, { lines: [{ item_id: item.id, qty: 4 }], payments: [{ cash_account_id: 1, amount: 100 }] });
  assert.throws(() => A.createJournal(e.admin, { reason: 'تسوية', lines: [{ account: 'INVENTORY', debit: 5 }, { account: 'EQUITY', credit: 5 }] }), /لا يُسمح/);
  assert.throws(() => A.createJournal(e.admin, { reason: 'تسوية', lines: [{ account: 'FIXED_ASSETS', debit: 5 }, { account: 'EQUITY', credit: 4 }] }), (err) => err.code === 'UNBALANCED');
  const j = A.createJournal(e.admin, { reason: 'شراء ثلاجة من مال المالك', lines: [{ account: 'FIXED_ASSETS', debit: 500 }, { account: 'EQUITY', credit: 500 }] });
  assert.equal(j.status, 'approved');
  const cashier = e.makeUser('cashier9', ['cashier']);
  assert.throws(() => A.createJournal(cashier, { reason: 'x1x', lines: [] }), (err) => err.status === 403);
  const tb = A.trialBalance(e.admin, { from: '2026-01-01', to: '2026-12-31' });
  assert.ok(tb.balanced, 'ميزان المراجعة متوازن');
  const bs = A.balanceSheet(e.admin, {});
  assert.ok(bs.balanced, 'الأصول = الالتزامات + حقوق الملكية');
  assert.equal(bs.equity.find((x) => x.code === 'RETAINED').amount, 60, 'ربح 100 - 40');
  const gl = A.generalLedger(e.admin, { account: 'CASH', from: '2026-01-01', to: '2026-12-31' });
  assert.equal(gl.closing, 1100);
  A.reverseJournal(e.admin, j.id, 'خطأ في التصنيف');
  assert.equal(e.bal('FIXED_ASSETS'), 0);
});
