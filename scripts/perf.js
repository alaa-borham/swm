'use strict';
// اختبار حمل مبدئي في بيئة منفصلة: node scripts/perf.js [عدد الأصناف] [عدد الفواتير]
// يقيس زمن البحث بالباركود والاسم وزمن اعتماد الفاتورة بعد تعبئة القاعدة.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openDb } = require('../src/db');
const { Ctx } = require('../src/core/context');
const users = require('../src/core/users');
const M = require('../src/core/masters');
const S = require('../src/core/stock');
const Sales = require('../src/core/sales');

const ITEMS = Number(process.argv[2] || 3000);
const INVOICES = Number(process.argv[3] || 20000);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-'));
const db = openDb(path.join(dir, 'data.db'));
users.ensureAdmin(db, 'Admin12345');
const ctx = new Ctx(db, users.publicUser(db.prepare('SELECT * FROM users').get()));
const t0 = Date.now();
const ids = [];
db.transaction(() => {
  for (let i = 0; i < ITEMS; i++) {
    const it = M.createItem(ctx, { name: `صنف تجريبي ${i}`, base_unit: 'حبة', barcode: String(6280000000000 + i), sell_price: 5 + (i % 20), track_expiry: 0,
      units: [{ name: 'كرتون', factor: 12, barcode: String(6290000000000 + i), sell_price: 55 }] });
    ids.push(it.id);
  }
  for (let i = 0; i < ITEMS; i += 200) {
    S.createOpeningStock(ctx, { warehouse_id: 1, lines: ids.slice(i, i + 200).map((id) => ({ item_id: id, qty: 100000, unit_cost: 3 })) });
  }
})();
console.log(`أصناف ${ITEMS}: ${Date.now() - t0}ms`);
const cust = M.createParty(ctx, { name: 'عميل اختبار الحمل', is_customer: 1 });
const t1 = Date.now();
db.transaction(() => {
  for (let i = 0; i < INVOICES; i++) {
    const a = ids[i % ids.length], b = ids[(i * 7) % ids.length];
    Sales.createSale(ctx, { party_id: cust.id, lines: [{ item_id: a, qty: 2 }, { item_id: b, qty: 1 }], payments: [{ cash_account_id: 1, amount: 1 }] });
  }
})();
console.log(`فواتير ${INVOICES}: ${Date.now() - t1}ms`);
const time = (label, fn, n = 50) => {
  const s = process.hrtime.bigint();
  for (let i = 0; i < n; i++) fn(i);
  const ms = Number(process.hrtime.bigint() - s) / 1e6 / n;
  console.log(`${label}: ${ms.toFixed(2)}ms في المتوسط`);
  return ms;
};
const r = [];
r.push(time('بحث بالباركود', (i) => M.lookupItem(ctx, String(6290000000000 + ((i * 37) % ITEMS)), 1)));
r.push(time('بحث بالاسم', (i) => M.lookupItem(ctx, `صنف تجريبي ${(i * 13) % ITEMS}`, 1)));
r.push(time('اعتماد فاتورة 5 بنود', (i) => Sales.createSale(ctx, { lines: [0, 1, 2, 3, 4].map((k) => ({ item_id: ids[(i * 11 + k) % ids.length], qty: 1 })), party_id: cust.id, payments: [{ cash_account_id: 1, amount: 1 }] }), 30));
r.push(time('تقرير المخزون', () => require('../src/core/reports').stockReport(ctx, {}), 3));
r.push(time('لوحة الإدارة', () => require('../src/core/reports').dashboard(ctx, {}), 3));
fs.rmSync(dir, { recursive: true, force: true });
console.log(r[0] < 2000 && r[1] < 2000 && r[2] < 3000 ? 'ضمن هدف الأداء المبدئي (بحث ≤ 2ث، اعتماد ≤ 3ث)' : 'خارج هدف الأداء');
