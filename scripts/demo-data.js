'use strict';
// بيانات تجربة منفصلة عن البيانات الفعلية: DATA_DIR=./demo npm run demo
// تُنشئ أصنافًا ووحدات وأطرافًا ومندوبًا ومشتريات ومبيعات ومستخدمين لكل دور.
const path = require('path');
const fs = require('fs');
const { openDb } = require('../src/db');
const { Ctx } = require('../src/core/context');
const users = require('../src/core/users');
const M = require('../src/core/masters');
const Pur = require('../src/core/purchases');
const Sales = require('../src/core/sales');
const Pay = require('../src/core/payments');
const S = require('../src/core/stock');
const F = require('../src/core/finance');

const dataDir = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'demo'));
const dbFile = path.join(dataDir, 'data.db');
if (fs.existsSync(dbFile) && !process.argv.includes('--force')) {
  console.error(`توجد قاعدة في ${dataDir}. استخدم --force لإعادة الإنشاء.`);
  process.exit(1);
}
for (const f of ['data.db', 'data.db-wal', 'data.db-shm']) fs.rmSync(path.join(dataDir, f), { force: true });
const db = openDb(dbFile);
users.ensureAdmin(db, 'Admin12345');
db.prepare("UPDATE users SET must_change_password=0 WHERE username='admin'").run();
const admin = new Ctx(db, users.publicUser(db.prepare("SELECT * FROM users WHERE username='admin'").get()));
const today = admin.today();
const d = (n) => { const t = new Date(today + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };

db.prepare("UPDATE settings SET value='مؤسسة الخير للمواد الغذائية (تجربة)' WHERE key='org_name'").run();
db.prepare("UPDATE settings SET value='1500' WHERE key='default_tax_rate_bp'").run();
admin.invalidateSettings();

const cat = (n) => M.saveCategory(admin, 'categories', { name: n }).id;
const drinks = cat('مشروبات'), grains = cat('حبوب'), dairy = cat('ألبان');
const juice = M.createItem(admin, { code: 'JU001', name: 'عصير برتقال 250مل', category_id: drinks, base_unit: 'حبة', barcode: '6281000000011', sell_price: 2.5, track_expiry: 1, reorder_level: 24,
  units: [{ name: 'كرتون', factor: 24, barcode: '6281000000028', sell_price: 55 }] });
const water = M.createItem(admin, { code: 'WA001', name: 'مياه 600مل', category_id: drinks, base_unit: 'حبة', barcode: '6281000000035', sell_price: 1, track_expiry: 1, reorder_level: 48,
  units: [{ name: 'شد', factor: 12, barcode: '6281000000042', sell_price: 11 }] });
const rice = M.createItem(admin, { code: 'RI001', name: 'أرز بسمتي', category_id: grains, base_unit: 'كجم', qty_decimals: 3, barcode: '6281000000059', sell_price: 9, track_expiry: 0, reorder_level: 50,
  units: [{ name: 'كيس 5 كجم', factor: 5, barcode: '6281000000066', sell_price: 42 }] });
const milk = M.createItem(admin, { code: 'MI001', name: 'حليب طازج 1لتر', category_id: dairy, base_unit: 'حبة', barcode: '6281000000073', sell_price: 6, track_expiry: 1, reorder_level: 20, expiry_alert_days: 5 });
const sugar = M.createItem(admin, { code: 'SU001', name: 'سكر 2كجم', category_id: grains, base_unit: 'حبة', barcode: '6281000000080', sell_price: 12, track_expiry: 0, min_price: 9 });

const sup1 = M.createParty(admin, { name: 'شركة المراعي للتوريد', phone: '0500000001', is_supplier: 1, payment_terms_days: 30 });
const sup2 = M.createParty(admin, { name: 'مؤسسة الحبوب الذهبية', phone: '0500000002', is_supplier: 1, payment_terms_days: 15 });
const rep = M.createRep(admin, { name: 'سالم المندوب', phone: '0550000000', area: 'الحي الشمالي', commission_pct: 2 });
const c1 = M.createParty(admin, { name: 'بقالة النور', phone: '0510000001', is_customer: 1, credit_limit: 5000, payment_terms_days: 30, rep_id: rep.id });
const c2 = M.createParty(admin, { name: 'سوبرماركت الريان', phone: '0510000002', is_customer: 1, credit_limit: 10000, payment_terms_days: 15 });
M.createParty(admin, { name: 'مطعم الضيافة', phone: '0510000003', is_customer: 1, is_supplier: 1, credit_limit: 2000 });

F.createOpeningBalance(admin, { kind: 'cash', cash_account_id: 1, amount: 5000, date: d(-20) });
F.createOpeningBalance(admin, { kind: 'cash', cash_account_id: 2, amount: 20000, date: d(-20) });
F.createOpeningBalance(admin, { kind: 'customer', party_id: c2.id, amount: 750, date: d(-20) });

const carton = juice.units.find((u) => u.name === 'كرتون');
const p1 = Pur.createPurchase(admin, { party_id: sup1.id, supplier_invoice_no: 'MR-1001', date: d(-15), approve: true, extra_costs: [{ description: 'نقل', amount: 60 }],
  lines: [{ item_id: juice.id, unit_id: carton.id, qty: 20, price: 40, batch_no: 'J-A', expiry_date: d(120) },
    { item_id: milk.id, qty: 60, price: 4, batch_no: 'M-1', expiry_date: d(4) }, { item_id: milk.id, qty: 40, price: 4.2, batch_no: 'M-2', expiry_date: d(12) },
    { item_id: water.id, unit_id: water.units.find((u) => u.name === 'شد').id, qty: 30, price: 7, batch_no: 'W-1', expiry_date: d(300) }],
  payment: { cash_account_id: 2, amount: 1000 } });
Pur.createPurchase(admin, { party_id: sup2.id, supplier_invoice_no: 'GG-77', date: d(-10), approve: true,
  lines: [{ item_id: rice.id, unit_id: rice.units.find((u) => u.name === 'كيس 5 كجم').id, qty: 40, price: 30 }, { item_id: sugar.id, qty: 100, price: 8 }] });
S.createOpeningStock(admin, { warehouse_id: 1, date: d(-20), lines: [{ item_id: milk.id, qty: 10, unit_cost: 3.9, batch_no: 'M-OLD', expiry_date: d(-2) }] });

S.createTransfer(admin, { from_warehouse_id: 1, to_warehouse_id: rep.warehouse_id, date: d(-8), lines: [{ item_id: juice.id, unit_id: carton.id, qty: 5 }, { item_id: water.id, qty: 60 }] });

for (let i = 7; i >= 1; i--) {
  Sales.createSale(admin, { date: d(-i), lines: [{ item_id: juice.id, qty: 6 + i }, { item_id: water.id, qty: 10 }, { item_id: rice.id, qty: 2.5 }], payments: i % 2 ? [] : [{ cash_account_id: 1, amount: 30 }],
    party_id: c2.id });
}
const s1 = Sales.createSale(admin, { party_id: c2.id, date: d(-3), lines: [{ item_id: milk.id, qty: 12 }, { item_id: sugar.id, qty: 10, discount_pct: 5 }], payments: [{ cash_account_id: 1, amount: 50 }] });
Pay.createReceipt(admin, { party_id: c2.id, cash_account_id: 2, amount: 500, date: d(-1), allocations: 'auto' });
Sales.createSaleReturn(admin, { sale_id: s1.id, reason: 'عبوة تالفة عند الاستلام', date: d(-2), lines: [{ line_id: s1.lines[0].id, qty: 2, condition: 'damaged' }] });

F.createExpense(admin, { expense_category_id: 1, amount: 3000, description: 'إيجار الشهر', approve: true, pay: { cash_account_id: 2 }, date: d(-5) });
F.createExpense(admin, { expense_category_id: 3, amount: 420, description: 'فاتورة كهرباء', approve: true, date: d(-2) });

const mk = (username, full_name, roles, extra = {}) => users.createUser(admin, { username, full_name, password: 'Passw0rd1', roles, ...extra });
mk('cashier', 'كاشير الفرع', ['cashier']);
mk('accountant', 'المحاسب', ['accountant']);
mk('store', 'أمين المستودع', ['storekeeper']);
mk('buyer', 'موظف المشتريات', ['purchasing']);
const repUser = mk('salem', 'سالم المندوب', ['rep'], { rep_id: rep.id });
db.prepare('UPDATE users SET must_change_password=0').run();
const repCtx = new Ctx(db, repUser);
const rs = Sales.createSale(repCtx, { party_id: c1.id, warehouse_id: rep.warehouse_id, date: d(-4), lines: [{ item_id: juice.id, unit_id: carton.id, qty: 2 }, { item_id: water.id, qty: 24 }] });
Pay.createReceipt(repCtx, { party_id: c1.id, amount: 80, date: d(-2), allocations: [{ doc_id: rs.id, amount: 80 }] });
void p1;
console.log(`تم إنشاء بيانات التجربة في ${dataDir}
المستخدمون (كلمة المرور Passw0rd1 ما عدا admin = Admin12345):
  admin (مدير) · cashier (كاشير) · accountant (محاسب) · store (أمين مستودع) · buyer (مشتريات) · salem (مندوب)
التشغيل: DATA_DIR=${path.relative(process.cwd(), dataDir) || '.'} npm start`);
