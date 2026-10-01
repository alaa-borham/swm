'use strict';
// الفروع المتعددة وترقية قاعدة البيانات.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { setup } = require('./helpers');
const { openDb, SCHEMA_VERSION } = require('../src/db');
const M = require('../src/core/masters');
const S = require('../src/core/stock');
const Sales = require('../src/core/sales');
const F = require('../src/core/finance');
const R = require('../src/core/reports');

test('مستخدم الفرع مقيد بمستودعات وصناديق ومستندات فرعه', () => {
  const e = setup();
  const b2 = M.saveBranch(e.admin, { name: 'فرع الشمال', address: 'الشارع العام', phone: '0111' });
  const wh2 = e.db.prepare('SELECT id FROM warehouses WHERE branch_id=?').get(b2.id).id;
  const cash2 = e.db.prepare('SELECT id FROM cash_accounts WHERE branch_id=?').get(b2.id).id;
  const item = e.item({ price: 10 });
  e.stock(item, 10, 4);
  e.stock(item, 10, 4, { wh: wh2 });
  Sales.createSale(e.admin, { lines: [{ item_id: item.id, qty: 1 }], payments: [{ cash_account_id: 1, amount: 10 }] });
  const u = e.makeUser('north', ['cashier', 'accountant'], { branch_id: b2.id });
  assert.equal(u.branchScope, b2.id);
  assert.throws(() => Sales.createSale(u, { warehouse_id: 1, lines: [{ item_id: item.id, qty: 1 }], payments: [{ cash_account_id: 1, amount: 10 }] }), (err) => err.status === 403);
  assert.throws(() => F.openSession(u, { cash_account_id: 1, opening_amount: 0 }), (err) => err.status === 403);
  F.openSession(u, { cash_account_id: cash2, opening_amount: 0 });
  const s = Sales.createSale(u, { warehouse_id: wh2, lines: [{ item_id: item.id, qty: 2 }], payments: [{ method: 'cash', amount: 20 }] });
  assert.equal(s.branch_id, b2.id);
  assert.equal(s.branch_name, 'فرع الشمال');
  const docs = R.listDocs(u, { type: 'sale' });
  assert.equal(docs.total, 1, 'يرى مستندات فرعه فقط');
  assert.equal(R.salesReport(u, {}).totals.net_sales, 20);
  assert.equal(R.stockReport(u, {}).rows[0].sellable, 8);
  assert.equal(M.listWarehouses(u).length, 1);
  const all = R.dashboard(e.admin, {});
  const north = R.dashboard(e.admin, { branch_id: b2.id });
  assert.equal(all.net_sales, 30);
  assert.equal(north.net_sales, 20);
  assert.throws(() => S.createTransfer(u, { from_warehouse_id: 1, to_warehouse_id: wh2, lines: [{ item_id: item.id, qty: 1 }] }), (err) => err.status === 403);
});

test('ترقية قاعدة من الإصدار 1 تضيف الأعمدة وتملأ الفرع', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-'));
  const f = path.join(dir, 'data.db');
  let db = openDb(f);
  db.prepare("INSERT INTO docs(type,number,date,status,warehouse_id,created_at) VALUES('transfer','X-1','2026-01-01','approved',1,'x')").run();
  db.exec("DROP INDEX docs_branch; ALTER TABLE docs DROP COLUMN branch_id; ALTER TABLE users DROP COLUMN branch_id; ALTER TABLE doc_lines DROP COLUMN received_qty; UPDATE meta SET value='1' WHERE key='schema_version'");
  db.close();
  db = openDb(f);
  assert.equal(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value, String(SCHEMA_VERSION));
  assert.equal(db.prepare("SELECT branch_id FROM docs WHERE number='X-1'").get().branch_id, 1);
  assert.ok(db.prepare('PRAGMA table_info(doc_lines)').all().some((c) => c.name === 'received_qty'));
  db.close();
});
