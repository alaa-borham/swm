'use strict';
const { openDb } = require('../src/db');
const { Ctx } = require('../src/core/context');
const users = require('../src/core/users');
const M = require('../src/core/masters');
const S = require('../src/core/stock');
const F = require('../src/core/finance');
const ledger = require('../src/core/ledger');
const { fromMinor } = require('../src/lib/money');

const TODAY = '2026-10-02';

function setup({ taxPct = 0 } = {}) {
  const db = openDb(':memory:');
  users.ensureAdmin(db, 'Admin12345');
  const adminRow = db.prepare("SELECT * FROM users WHERE username='admin'").get();
  const admin = new Ctx(db, users.publicUser(adminRow), { today: TODAY });
  db.prepare("UPDATE settings SET value=? WHERE key='default_tax_rate_bp'").run(String(taxPct * 100));
  admin.invalidateSettings();
  const env = {
    db, admin, today: TODAY,
    mainWh: 1, cashId: 1, bankId: 2,
    ctxFor(user) { return new Ctx(db, user, { today: TODAY }); },
    item(opts = {}) {
      const units = [];
      if (opts.carton) units.push({ name: 'كرتون', factor: opts.carton, sell_price: opts.cartonPrice ?? 0, barcode: opts.cartonBarcode });
      return M.createItem(admin, {
        name: opts.name || 'صنف ' + Math.random().toString(36).slice(2, 7), base_unit: opts.base || 'حبة', qty_decimals: opts.decimals ?? 0,
        track_expiry: opts.track_expiry ?? 0, sell_price: opts.price ?? 0, tax_rate_pct: opts.tax ?? null, units, barcode: opts.barcode,
        max_discount_pct: opts.maxDiscount ?? null, min_price: opts.minPrice ?? null,
      });
    },
    customer(opts = {}) { return M.createParty(admin, { name: opts.name || 'عميل', is_customer: 1, credit_limit: opts.limit ?? null, rep_id: opts.rep_id, payment_terms_days: 30 }); },
    supplier(opts = {}) { return M.createParty(admin, { name: opts.name || 'مورد', is_supplier: 1 }); },
    stock(item, qty, unitCost, opts = {}) {
      return S.createOpeningStock(admin, {
        warehouse_id: opts.wh || 1, date: opts.date || '2026-09-01',
        lines: [{ item_id: item.id, qty, unit_cost: unitCost, batch_no: opts.batch, expiry_date: opts.expiry }],
      });
    },
    fundCash(amount, id = 1) { return F.createOpeningBalance(admin, { kind: 'cash', cash_account_id: id, amount, date: '2026-09-01' }); },
    bal(account, f) { return fromMinor(ledger.balance(db, account, f || {})); },
    sellable(itemId, wh = 1) { return require('../src/core/inventory').sellableQty(admin, itemId, wh) / 1000; },
    stockQty(itemId, wh) {
      const r = db.prepare(`SELECT COALESCE(SUM(qty),0) q, COALESCE(SUM(cost),0) c FROM batches WHERE item_id=? ${wh ? 'AND warehouse_id=' + Number(wh) : ''}`).get(itemId);
      return { qty: r.q / 1000, cost: fromMinor(r.c) };
    },
    count(type) { return db.prepare("SELECT COUNT(*) n FROM docs WHERE type=? AND status='approved'").get(type).n; },
    makeUser(username, roles, extra = {}) {
      const u = users.createUser(admin, { username, full_name: username, password: 'Passw0rd1', roles, ...extra });
      return new Ctx(db, u, { today: TODAY });
    },
  };
  return env;
}

module.exports = { setup, TODAY };
