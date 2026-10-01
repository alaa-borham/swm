'use strict';
// اختبارات القبول من وثيقة المشروع (القسمان 15 و16). المبالغ بوحدات العملة، والضريبة صفر إلا إذا نُص عليها.
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
const users = require('../src/core/users');

test('1 تحويل الكرتون: شراء كرتونين وبيع كرتون و3 حبات', () => {
  const e = setup();
  const item = e.item({ name: 'عصير', carton: 12, cartonPrice: 96, price: 8 });
  const carton = item.units.find((u) => u.name === 'كرتون');
  const sup = e.supplier();
  const pur = Pur.createPurchase(e.admin, { party_id: sup.id, approve: true, lines: [{ item_id: item.id, unit_id: carton.id, qty: 2, price: 60 }] });
  assert.equal(pur.status, 'approved');
  assert.equal(e.stockQty(item.id).qty, 24, 'المخزون 24 حبة');
  const sale = Sales.createSale(e.admin, {
    lines: [{ item_id: item.id, unit_id: carton.id, qty: 1 }, { item_id: item.id, qty: 3 }],
    payments: [{ method: 'cash', cash_account_id: e.cashId, amount: 120 }],
  });
  assert.equal(sale.lines[0].base_qty + sale.lines[1].base_qty, 15, 'بيع 15 حبة');
  assert.equal(sale.total, 120, 'الإيراد 120');
  assert.equal(sale.cost, 75, 'التكلفة 75');
  assert.equal(sale.total - sale.cost, 45, 'مجمل الربح 45');
  assert.equal(e.stockQty(item.id).qty, 9, 'المتبقي 9');
  assert.equal(sale.lines[0].factor, 12, 'حفظ معامل التحويل في المستند');
});

test('2 صرف الأقرب انتهاءً مع تجاهل المنتهي', () => {
  const e = setup();
  const item = e.item({ name: 'لبن', price: 3, track_expiry: 1 });
  e.stock(item, 5, 1, { batch: 'A', expiry: '2026-10-01' });
  e.stock(item, 4, 1, { batch: 'B', expiry: '2026-10-12' });
  e.stock(item, 6, 1, { batch: 'C', expiry: '2026-11-01' });
  assert.equal(e.sellable(item.id), 10);
  const sale = Sales.createSale(e.admin, { lines: [{ item_id: item.id, qty: 7 }], payments: [{ cash_account_id: e.cashId, amount: 21 }] });
  const moves = e.db.prepare('SELECT b.batch_no, -m.qty/1000 q FROM stock_moves m JOIN batches b ON b.id=m.batch_id WHERE m.doc_id=? ORDER BY m.id').all(sale.id);
  assert.deepEqual(moves, [{ batch_no: 'B', q: 4 }, { batch_no: 'C', q: 3 }], 'صرف 4 ثم 3');
  assert.equal(e.sellable(item.id), 3, 'متبقٍ صالح 3');
  const a = e.db.prepare("SELECT qty/1000 q FROM batches WHERE batch_no='A'").get();
  assert.equal(a.q, 5, 'المنتهي 5 لا يُصرف');
});

test('3 رفض العجز عند تكرار الصنف في سطرين', () => {
  const e = setup();
  const item = e.item({ price: 10 });
  const c = e.customer();
  e.stock(item, 3, 5);
  assert.throws(() => Sales.createSale(e.admin, { party_id: c.id, lines: [{ item_id: item.id, qty: 2 }, { item_id: item.id, qty: 2 }] }),
    (err) => err.code === 'INSUFFICIENT_STOCK');
  assert.equal(e.sellable(item.id), 3, 'الرصيد 3');
  assert.equal(e.db.prepare("SELECT COUNT(*) n FROM docs WHERE type IN ('sale','receipt')").get().n, 0, 'لا فاتورة ولا قبض');
  assert.equal(e.bal('AR'), 0, 'لا مديونية');
});

test('4 التكلفة التاريخية للدفعات', () => {
  const e = setup();
  const item = e.item({ price: 20 });
  e.stock(item, 5, 10, { batch: 'B1' });
  e.stock(item, 5, 12, { batch: 'B2' });
  const sale = Sales.createSale(e.admin, { lines: [{ item_id: item.id, qty: 7 }], payments: [{ cash_account_id: e.cashId, amount: 140 }] });
  assert.equal(sale.total, 140);
  assert.equal(sale.cost, 74);
  assert.equal(sale.total - sale.cost, 66);
  assert.deepEqual(e.stockQty(item.id), { qty: 3, cost: 36 });
  const sup = e.supplier();
  Pur.createPurchase(e.admin, { party_id: sup.id, approve: true, lines: [{ item_id: item.id, qty: 10, price: 15 }] });
  const again = e.db.prepare('SELECT cost FROM docs WHERE id=?').get(sale.id);
  assert.equal(again.cost / 100, 74, 'الشراء الجديد لا يغير تكلفة البيع السابق');
});

test('5 توزيع تكلفة النقل بنسبة قيمة البند', () => {
  const e = setup();
  const a = e.item({ name: 'أ' });
  const b = e.item({ name: 'ب' });
  const sup = e.supplier();
  const pur = Pur.createPurchase(e.admin, {
    party_id: sup.id, approve: true, extra_costs: [{ description: 'نقل', amount: 30 }],
    lines: [{ item_id: a.id, qty: 10, price: 5 }, { item_id: b.id, qty: 20, price: 10 }],
  });
  assert.deepEqual(pur.lines.map((l) => l.extra_cost), [6, 24], 'التوزيع 6 و24');
  assert.deepEqual(pur.lines.map((l) => l.cost / l.base_qty), [5.6, 11.2], 'تكلفة الوحدة 5.60 و11.20');
  assert.equal(e.bal('INVENTORY'), 280, 'المخزون 280');
  assert.equal(e.bal('EXPENSES'), 0, 'دون مصروف مكرر');
  assert.equal(-e.bal('AP', { party_id: sup.id }), 280, 'مستحق المورد يشمل النقل');
});

test('6 خصم وضريبة وسداد', () => {
  const e = setup();
  const item = e.item({ price: 100, tax: 15 });
  const c = e.customer();
  e.stock(item, 10, 50);
  const sale = Sales.createSale(e.admin, {
    party_id: c.id, lines: [{ item_id: item.id, qty: 2, discount_pct: 10 }], payments: [{ cash_account_id: e.cashId, amount: 100 }],
  });
  assert.equal(sale.subtotal, 200);
  assert.equal(sale.discount, 20);
  assert.equal(sale.net, 180, 'الصافي 180');
  assert.equal(sale.tax, 27, 'الضريبة 27');
  assert.equal(sale.total, 207, 'الإجمالي 207');
  assert.equal(sale.open_amount, 107, 'المستحق 107');
  assert.equal(sale.payment_status, 'partial');
  assert.equal(e.bal('AR', { party_id: c.id }), 107);
  assert.equal(-e.bal('TAX_OUT'), 27);
});

test('7 التحصيل ليس بيعًا', () => {
  const e = setup();
  const item = e.item({ price: 1000 });
  const c = e.customer();
  e.stock(item, 1, 500);
  const sale = Sales.createSale(e.admin, { party_id: c.id, lines: [{ item_id: item.id, qty: 1 }], payments: [{ cash_account_id: e.cashId, amount: 300 }] });
  Pay.createReceipt(e.admin, { party_id: c.id, cash_account_id: e.cashId, amount: 200, allocations: [{ doc_id: sale.id, amount: 200 }] });
  assert.equal(e.bal('AR', { party_id: c.id }), 500, 'المستحق 500');
  assert.equal(e.bal('CASH'), 500, 'المقبوض 500');
  assert.equal(-e.bal('SALES'), 1000, 'إيراد البيع يبقى 1000');
});

test('8 مستحق المورد', () => {
  const e = setup();
  const item = e.item();
  const sup = e.supplier();
  e.fundCash(1000);
  const pur = Pur.createPurchase(e.admin, { party_id: sup.id, approve: true, lines: [{ item_id: item.id, qty: 50, price: 10 }], payment: { cash_account_id: e.cashId, amount: 150 } });
  Pay.createPayment(e.admin, { party_id: sup.id, cash_account_id: e.cashId, amount: 100, allocations: [{ doc_id: pur.id, amount: 100 }] });
  assert.equal(-e.bal('AP', { party_id: sup.id }), 250, 'المستحق 250');
  const paid = e.db.prepare("SELECT SUM(total) s FROM docs WHERE type='payment' AND party_id=?").get(sup.id).s / 100;
  assert.equal(paid, 250, 'المدفوع 250');
  assert.equal(e.db.prepare('SELECT total FROM docs WHERE id=?').get(pur.id).total / 100, 500, 'قيمة الشراء الأصلية 500');
});

test('9 مرتجع شامل خصمًا وضريبة', () => {
  const e = setup();
  const item = e.item({ price: 100, tax: 15 });
  const c = e.customer();
  e.stock(item, 10, 50);
  const sale = Sales.createSale(e.admin, { party_id: c.id, lines: [{ item_id: item.id, qty: 2, discount_pct: 10 }], payments: [{ cash_account_id: e.cashId, amount: 100 }] });
  const before = e.stockQty(item.id);
  const ret = Sales.createSaleReturn(e.admin, { sale_id: sale.id, reason: 'إرجاع صالح', lines: [{ line_id: sale.lines[0].id, qty: 1, condition: 'ok' }] });
  assert.equal(ret.total, 103.5, 'إشعار دائن 103.50');
  assert.equal(ret.net, 90);
  assert.equal(ret.tax, 13.5);
  assert.equal(e.bal('AR', { party_id: c.id }), 3.5, 'مستحق 3.50');
  const after = e.stockQty(item.id);
  assert.equal(after.qty - before.qty, 1, 'استرجاع الكمية');
  assert.equal(after.cost - before.cost, 50, 'بالتكلفة الأصلية');
});

test('10 مرتجع نقدي وحد الكمية', () => {
  const e = setup();
  const item = e.item({ price: 25 });
  e.stock(item, 10, 10);
  const sale = Sales.createSale(e.admin, { lines: [{ item_id: item.id, qty: 4 }], payments: [{ cash_account_id: e.cashId, amount: 100 }] });
  Sales.createSaleReturn(e.admin, { sale_id: sale.id, reason: 'لا يرغب', lines: [{ line_id: sale.lines[0].id, qty: 1 }], refund: { cash_account_id: e.cashId } });
  assert.equal(e.bal('CASH'), 75, 'صافي المقبوض 75');
  assert.equal(-e.bal('SALES') - e.bal('SALES_RETURNS'), 75, 'صافي الإيراد 75');
  assert.equal(e.bal('COGS'), 30, 'التكلفة 30');
  assert.equal(e.stockQty(item.id).qty, 7, 'زيادة المخزون حبة');
  assert.throws(() => Sales.createSaleReturn(e.admin, { sale_id: sale.id, reason: 'زيادة', lines: [{ line_id: sale.lines[0].id, qty: 4 }], refund: { cash_account_id: e.cashId } }),
    (err) => err.code === 'RETURN_EXCEEDS', 'مجموع المرتجع لا يتجاوز 4');
  Sales.createSaleReturn(e.admin, { sale_id: sale.id, reason: 'باقي', lines: [{ line_id: sale.lines[0].id, qty: 3 }], refund: { cash_account_id: e.cashId } });
  assert.equal(e.bal('CASH'), 0);
  assert.equal(e.bal('COGS'), 0);
});

test('11 مرتجع المورد مقيد بالموجود من الدفعة', () => {
  const e = setup();
  const item = e.item({ price: 7 });
  const sup = e.supplier();
  const pur = Pur.createPurchase(e.admin, { party_id: sup.id, approve: true, lines: [{ item_id: item.id, qty: 10, price: 5 }] });
  Sales.createSale(e.admin, { lines: [{ item_id: item.id, qty: 7 }], payments: [{ cash_account_id: e.cashId, amount: 49 }] });
  assert.throws(() => Pur.createPurchaseReturn(e.admin, { purchase_id: pur.id, reason: 'تالف', lines: [{ line_id: pur.lines[0].id, qty: 4 }] }),
    (err) => err.code === 'RETURN_EXCEEDS_BATCH');
  Pur.createPurchaseReturn(e.admin, { purchase_id: pur.id, reason: 'تالف', lines: [{ line_id: pur.lines[0].id, qty: 2 }] });
  assert.equal(e.stockQty(item.id).qty, 1, 'تبقى حبة');
  assert.equal(-e.bal('AP', { party_id: sup.id }), 40, 'مستحق المورد من 50 إلى 40');
});

test('12 عهدة المندوب وعمولته', () => {
  const e = setup();
  const rep = M.createRep(e.admin, { name: 'سالم', commission_pct: 2 });
  const item = e.item({ price: 100 });
  e.stock(item, 20, 40);
  S.createTransfer(e.admin, { from_warehouse_id: e.mainWh, to_warehouse_id: rep.warehouse_id, lines: [{ item_id: item.id, qty: 10 }] });
  const c = e.customer({ rep_id: rep.id });
  const repUser = e.makeUser('salem', ['rep'], { rep_id: rep.id });
  const sale = Sales.createSale(repUser, { party_id: c.id, warehouse_id: rep.warehouse_id, lines: [{ item_id: item.id, qty: 10 }] });
  assert.equal(sale.total, 1000);
  assert.equal(sale.rep_id, rep.id);
  Pay.createReceipt(repUser, { party_id: c.id, amount: 600, allocations: [{ doc_id: sale.id, amount: 600 }] });
  Pay.createCashTransfer(e.admin, { from_id: rep.custody_account_id, to_id: e.cashId, amount: 500 });
  assert.equal(e.bal('AR', { party_id: c.id }), 400, 'دين العميل 400');
  assert.equal(e.bal('CASH', { cash_account_id: rep.custody_account_id }), 100, 'عهدة المندوب 100');
  assert.equal(e.bal('CASH', { cash_account_id: e.cashId }), 500, 'الخزينة 500');
  const com = R.calculateCommission(e.admin, { rep_id: rep.id, to: e.today });
  assert.equal(com.total, 12, 'عمولة 12');
  R.approveCommission(e.admin, com.id);
  assert.equal(e.count('receipt'), 1, 'دون قبض مزدوج');
  const st = R.custodyStatement(e.admin, rep.id);
  assert.equal(st.collections, 600);
  assert.equal(st.remittances, 500);
  assert.equal(st.cash_balance, 100);
});

test('13 الجرد والتالف', () => {
  const e = setup();
  const item = e.item({ price: 9 });
  e.stock(item, 20, 5);
  const cnt = S.createCount(e.admin, { warehouse_id: e.mainWh });
  S.enterCounts(e.admin, cnt.id, [{ line_id: cnt.lines[0].id, counted_qty: 18 }]);
  const done = S.approveCount(e.admin, cnt.id);
  assert.equal(done.lines[0].base_qty, -2, 'تسوية نقص 2');
  assert.equal(done.lines[0].amount, -10, 'بقيمة 10');
  assert.deepEqual(e.stockQty(item.id), { qty: 18, cost: 90 }, 'رصيد 18 بقيمة 90');
  assert.equal(e.bal('INV_LOSS'), 10, 'خسارة 10');
  assert.equal(e.bal('SALES'), 0, 'دون تغيير المبيعات');
});

test('13ب الجرد يراعي الحركات أثناء العد', () => {
  const e = setup();
  const item = e.item({ price: 9 });
  e.stock(item, 20, 5);
  const cnt = S.createCount(e.admin, { warehouse_id: e.mainWh });
  Sales.createSale(e.admin, { lines: [{ item_id: item.id, qty: 3 }], payments: [{ cash_account_id: e.cashId, amount: 27 }] });
  S.enterCounts(e.admin, cnt.id, [{ line_id: cnt.lines[0].id, counted_qty: 20 }]);
  S.approveCount(e.admin, cnt.id);
  assert.equal(e.stockQty(item.id).qty, 17, 'لا فرق وهمي بسبب البيع أثناء العد');
});

test('14 الصلاحيات تُفحص في الخادم', () => {
  const e = setup();
  const cashier = e.makeUser('cashier1', ['cashier']);
  const item = e.item({ price: 5 });
  e.stock(item, 10, 2);
  assert.throws(() => users.createUser(cashier, { username: 'x1', full_name: 'x', password: 'Passw0rd1', roles: ['admin'] }), (err) => err.status === 403);
  assert.throws(() => M.updateItem(cashier, item.id, { min_price: 1 }), (err) => err.status === 403);
  const cnt = S.createCount(e.admin, { warehouse_id: e.mainWh });
  S.enterCounts(e.admin, cnt.id, [{ line_id: cnt.lines[0].id, counted_qty: 9 }]);
  assert.throws(() => S.approveCount(cashier, cnt.id), (err) => err.status === 403);
  assert.equal(e.db.prepare("SELECT status FROM docs WHERE id=?").get(cnt.id).status, 'draft', 'دون تغيير السجل');
  const denied = e.db.prepare("SELECT COUNT(*) n FROM audit_log WHERE ok=0 AND action LIKE 'denied:%' AND username='cashier1'").get().n;
  assert.equal(denied, 3, 'تسجيل الأحداث المرفوضة');
  F.openSession(cashier, { cash_account_id: e.cashId, opening_amount: 0 });
  const sale = Sales.createSale(cashier, { lines: [{ item_id: item.id, qty: 1 }], payments: [{ method: 'cash', amount: 5 }] });
  assert.equal(sale.status, 'approved', 'البيع المسموح ينجح');
});
