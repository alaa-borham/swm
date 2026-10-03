'use strict';
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { setMoneyDecimals } = require('../lib/money');
const { nowIso } = require('../lib/dates');

// كل ترقية تُنفذ مرة واحدة بالترتيب على القواعد القائمة والجديدة
const MIGRATIONS = {
  2: (db) => {
    addColumn(db, 'docs', 'branch_id', 'INTEGER REFERENCES branches(id)');
    addColumn(db, 'users', 'branch_id', 'INTEGER REFERENCES branches(id)');
    addColumn(db, 'branches', 'address', 'TEXT');
    addColumn(db, 'branches', 'phone', 'TEXT');
    addColumn(db, 'doc_lines', 'received_qty', 'INTEGER NOT NULL DEFAULT 0');
    db.exec(`UPDATE docs SET branch_id = COALESCE(
        (SELECT branch_id FROM warehouses WHERE id = docs.warehouse_id),
        (SELECT branch_id FROM cash_accounts WHERE id = docs.cash_account_id))
      WHERE branch_id IS NULL;
      CREATE INDEX IF NOT EXISTS docs_branch ON docs(branch_id, type, date);`);
  },
  3: (db) => {
    // موافقة العميل على استلام رسائل واتساب، وسجل الرسائل وحالات التسليم
    addColumn(db, 'parties', 'whatsapp_opt_in', 'INTEGER NOT NULL DEFAULT 0');
    db.exec(`CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY,
        created_at TEXT NOT NULL,
        channel TEXT NOT NULL DEFAULT 'whatsapp',
        kind TEXT NOT NULL,
        party_id INTEGER REFERENCES parties(id),
        doc_id INTEGER REFERENCES docs(id),
        phone TEXT NOT NULL,
        template TEXT NOT NULL,
        params TEXT,
        status TEXT NOT NULL,
        provider_id TEXT,
        error TEXT,
        updated_at TEXT,
        user_id INTEGER REFERENCES users(id)
      );
      CREATE INDEX IF NOT EXISTS messages_doc ON messages(doc_id);
      CREATE INDEX IF NOT EXISTS messages_party ON messages(party_id, created_at);
      CREATE UNIQUE INDEX IF NOT EXISTS messages_provider ON messages(provider_id) WHERE provider_id IS NOT NULL;`);
  },
  4: (db) => {
    // سعر الشراء الافتراضي لكل وحدة (يُقترح في فاتورة وطلب الشراء)
    addColumn(db, 'item_units', 'purchase_price', 'INTEGER');
  },
  5: (db) => {
    // نسبة الربح على سعر الشراء لحساب سعر البيع تلقائيًا (×100)
    addColumn(db, 'item_units', 'profit_margin_bp', 'INTEGER');
  },
  6: (db) => {
    // نقل مستودع المندوب وعهدته إلى فرع حساب دخوله (كانت تُنشأ في الفرع الرئيسي فتُرفض مبيعاته)
    db.exec(`UPDATE warehouses SET branch_id=(SELECT u.branch_id FROM users u JOIN reps r ON r.id=u.rep_id WHERE r.warehouse_id=warehouses.id AND u.branch_id IS NOT NULL LIMIT 1)
        WHERE kind='rep' AND EXISTS (SELECT 1 FROM users u JOIN reps r ON r.id=u.rep_id WHERE r.warehouse_id=warehouses.id AND u.branch_id IS NOT NULL);
      UPDATE cash_accounts SET branch_id=(SELECT u.branch_id FROM users u JOIN reps r ON r.id=u.rep_id WHERE r.custody_account_id=cash_accounts.id AND u.branch_id IS NOT NULL LIMIT 1)
        WHERE kind='rep_custody' AND EXISTS (SELECT 1 FROM users u JOIN reps r ON r.id=u.rep_id WHERE r.custody_account_id=cash_accounts.id AND u.branch_id IS NOT NULL);`);
  },
  7: (db) => {
    // عميل متاح لكل المناديب
    addColumn(db, 'parties', 'all_reps', 'INTEGER NOT NULL DEFAULT 0');
  },
  8: (db) => {
    // روابط مشاركة الفواتير للعملاء (رمز عشوائي، صلاحية محدودة، دون تسجيل دخول)
    db.exec(`CREATE TABLE IF NOT EXISTS doc_shares (
        token TEXT PRIMARY KEY,
        doc_id INTEGER NOT NULL REFERENCES docs(id),
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        user_id INTEGER REFERENCES users(id)
      );
      CREATE INDEX IF NOT EXISTS doc_shares_doc ON doc_shares(doc_id);`);
  },
  9: (db) => {
    // رقم لكل عميل/مورد (C00001...) بترتيب الإدخال
    addColumn(db, 'parties', 'code', 'TEXT');
    const rows = db.prepare('SELECT id FROM parties WHERE code IS NULL ORDER BY id').all();
    const up = db.prepare('UPDATE parties SET code=? WHERE id=?');
    rows.forEach((r, i) => up.run('C' + String(i + 1).padStart(5, '0'), r.id));
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS parties_code ON parties(code)');
  },
  10: (db) => {
    // صيغة أبسط لرقم العميل: A1، A2، A3... بدل C00001
    const rows = db.prepare("SELECT id, code FROM parties WHERE code GLOB 'C[0-9][0-9][0-9][0-9][0-9]'").all();
    const up = db.prepare('UPDATE parties SET code=? WHERE id=?');
    for (const r of rows) up.run('A' + Number(r.code.slice(1)), r.id);
  },
};
const SCHEMA_VERSION = Math.max(1, ...Object.keys(MIGRATIONS).map(Number));

function addColumn(db, table, col, def) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
}

const DEFAULT_SETTINGS = {
  org_name: 'مؤسسة المواد الغذائية',
  org_address: '',
  org_phone: '',
  org_tax_number: '',
  org_cr_number: '',
  org_logo: '',
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
  einvoice_qr: '0',
  // واتساب (Meta Cloud API). رمز الوصول وسر التطبيق في متغيرات البيئة فقط: WHATSAPP_TOKEN و WHATSAPP_APP_SECRET
  whatsapp_enabled: '0',
  whatsapp_phone_number_id: '',
  whatsapp_api_version: 'v21.0',
  whatsapp_lang: 'ar',
  whatsapp_country_code: '966',
  whatsapp_template_invoice: 'invoice_notice',
  whatsapp_template_receipt: 'payment_received',
  whatsapp_template_reminder: 'payment_reminder',
  whatsapp_auto_invoice: '0',
  whatsapp_auto_receipt: '0',
  whatsapp_verify_token: '',
  scale_prefix: '',                  // باركود الميزان: البادئة (مثل 2 أو 21)، فارغ = غير مفعّل
  scale_plu_digits: '5',
  scale_value_digits: '5',
  scale_mode: 'weight',              // weight: الوزن بالجرام، price: السعر
};

const DOC_PREFIXES = {
  sale: 'INV', sale_return: 'SRT', purchase: 'PUR', purchase_return: 'PRT', receipt: 'RCV', payment: 'PAY',
  expense: 'EXP', transfer: 'TRF', stock_count: 'CNT', damage: 'DMG', opening_stock: 'OST', opening_balance: 'OBL',
  cash_transfer: 'CTR', session_variance: 'SVR', custody_settlement: 'CST', commission: 'COM', batch_status: 'BST',
  session: 'SES', purchase_order: 'PO', journal: 'JV', cost_adjust: 'CAD',
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
  let ver = db.prepare("SELECT value FROM meta WHERE key='schema_version'").get();
  if (!ver) {
    seed(db);
    db.prepare("INSERT INTO meta(key,value) VALUES('schema_version','1')").run();
    ver = { value: '1' };
  }
  for (let v = Number(ver.value) + 1; v <= SCHEMA_VERSION; v++) {
    db.transaction(() => {
      MIGRATIONS[v](db);
      db.prepare("UPDATE meta SET value=? WHERE key='schema_version'").run(String(v));
    })();
  }
  // إعدادات وتسلسلات جديدة تُضاف دون المساس بالقيم الحالية
  const insS = db.prepare('INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)');
  for (const [k, val] of Object.entries(DEFAULT_SETTINGS)) insS.run(k, val);
  const insSeq = db.prepare('INSERT OR IGNORE INTO doc_sequences(type,prefix,next) VALUES(?,?,1)');
  for (const [t, p] of Object.entries(DOC_PREFIXES)) insSeq.run(t, p);
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

module.exports = { SCHEMA_VERSION, openDb, DEFAULT_SETTINGS, DOC_PREFIXES };
