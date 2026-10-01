'use strict';
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { setMoneyDecimals } = require('../lib/money');
const { nowIso } = require('../lib/dates');

const SCHEMA_VERSION = 1;

const DEFAULT_SETTINGS = {
  org_name: 'مؤسسة المواد الغذائية',
  org_address: '',
  org_phone: '',
  org_tax_number: '',
  country: '',
  currency: 'ريال',
  money_decimals: '2',
  timezone: 'Asia/Riyadh',
  default_tax_rate_bp: '0',           // تحدد المؤسسة الضريبة حسب بلد التشغيل
  prices_include_tax: '0',
  tax_recoverable: '1',               // ضريبة المشتريات قابلة للاسترداد ولا تدخل التكلفة
  expiry_block_days: '0',             // آخر يوم للبيع = تاريخ الانتهاء - هذا العدد
  expiry_alert_days: '30',
  cashier_max_discount_bp: '1000',    // حد الخصم الافتراضي 10%
  extra_cost_basis: 'value',          // توزيع تكاليف الشراء التابعة: value | qty
  session_timeout_minutes: '480',
  locked_until: '',                   // آخر تاريخ مقفل
  backup_hour: '23',
  backup_retention: '30',
  invoice_footer: 'شكرًا لتعاملكم معنا',
  receipt_width_mm: '80',
};

const DOC_PREFIXES = {
  sale: 'INV', sale_return: 'SRT', purchase: 'PUR', purchase_return: 'PRT', receipt: 'RCV', payment: 'PAY',
  expense: 'EXP', transfer: 'TRF', stock_count: 'CNT', damage: 'DMG', opening_stock: 'OST', opening_balance: 'OBL',
  cash_transfer: 'CTR', session_variance: 'SVR', custody_settlement: 'CST', commission: 'COM', batch_status: 'BST',
  session: 'SES',
};

function openDb(file, { readonly = false } = {}) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new Database(file, { readonly });
  // ذاكرة للجمل المُعدّة: إعادة إعداد نفس الجملة في كل عملية مكلفة
  const prepare = db.prepare.bind(db);
  const cache = new Map();
  db.prepare = (sql) => {
    let st = cache.get(sql);
    if (!st) {
      if (cache.size > 2000) cache.clear();
      st = prepare(sql);
      cache.set(sql, st);
    }
    return st;
  };
  db.pragma('foreign_keys = ON');
  if (!readonly) {
    if (file !== ':memory:') db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');
    db.pragma('synchronous = NORMAL');
    migrate(db);
  }
  const dec = db.prepare("SELECT value FROM settings WHERE key='money_decimals'").get();
  setMoneyDecimals(dec ? Number(dec.value) : 2);
  return db;
}

function migrate(db) {
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  db.exec(schema);
  const ver = db.prepare("SELECT value FROM meta WHERE key='schema_version'").get();
  if (!ver) {
    seed(db);
    db.prepare("INSERT INTO meta(key,value) VALUES('schema_version',?)").run(String(SCHEMA_VERSION));
  }
}

function seed(db) {
  const now = nowIso();
  const tx = db.transaction(() => {
    const insS = db.prepare('INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)');
    for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) insS.run(k, v);
    const insSeq = db.prepare('INSERT OR IGNORE INTO doc_sequences(type,prefix,next) VALUES(?,?,1)');
    for (const [t, p] of Object.entries(DOC_PREFIXES)) insSeq.run(t, p);
    if (!db.prepare('SELECT 1 FROM branches').get()) {
      const b = db.prepare("INSERT INTO branches(name) VALUES('الفرع الرئيسي')").run().lastInsertRowid;
      db.prepare("INSERT INTO warehouses(branch_id,name,kind) VALUES(?,'المستودع الرئيسي','main')").run(b);
      db.prepare("INSERT INTO cash_accounts(name,kind,branch_id) VALUES('الصندوق الرئيسي','cash',?)").run(b);
      db.prepare("INSERT INTO cash_accounts(name,kind,branch_id) VALUES('البنك','bank',?)").run(b);
      db.prepare("INSERT INTO categories(name) VALUES('عام')").run();
      for (const n of ['إيجار', 'رواتب', 'كهرباء ومياه', 'نقل', 'صيانة', 'متفرقة']) db.prepare('INSERT INTO expense_categories(name) VALUES(?)').run(n);
    }
    db.prepare("INSERT OR IGNORE INTO meta(key,value) VALUES('created_at',?)").run(now);
  });
  tx();
}

module.exports = { openDb, DEFAULT_SETTINGS, DOC_PREFIXES };
