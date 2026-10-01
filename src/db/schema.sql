-- نظام إدارة مؤسسة مواد غذائية — مخطط قاعدة البيانات
-- المبالغ أعداد صحيحة بأصغر وحدة للعملة (مثلاً: قرش/فلس) والكميات أعداد صحيحة بوحدة الأساس × 1000.
-- النسب المئوية بالـ basis points (15% = 1500).

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- ============ المستخدمون والصلاحيات والتدقيق ============
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  full_name     TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  roles         TEXT NOT NULL DEFAULT '[]',        -- JSON array of role codes
  rep_id        INTEGER REFERENCES reps(id),
  active        INTEGER NOT NULL DEFAULT 1,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash  TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id),
  created_at  TEXT NOT NULL,
  last_seen   TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  ip          TEXT
);

CREATE TABLE IF NOT EXISTS login_attempts (
  id        INTEGER PRIMARY KEY,
  username  TEXT NOT NULL,
  ip        TEXT,
  ts        TEXT NOT NULL,
  ok        INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY,
  ts         TEXT NOT NULL,
  user_id    INTEGER,
  username   TEXT,
  action     TEXT NOT NULL,
  entity     TEXT,
  entity_id  INTEGER,
  doc_number TEXT,
  reason     TEXT,
  before_json TEXT,
  after_json  TEXT,
  ok         INTEGER NOT NULL DEFAULT 1,
  ip         TEXT
);
CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;

CREATE TABLE IF NOT EXISTS idempotency (
  key          TEXT NOT NULL,
  user_id      INTEGER NOT NULL,
  route        TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response     TEXT NOT NULL,
  status       INTEGER NOT NULL,
  created_at   TEXT NOT NULL,
  PRIMARY KEY (key, user_id)
);

-- ============ البيانات الأساسية ============
CREATE TABLE IF NOT EXISTS branches (
  id     INTEGER PRIMARY KEY,
  name   TEXT NOT NULL UNIQUE,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS reps (
  id                 INTEGER PRIMARY KEY,
  name               TEXT NOT NULL,
  phone              TEXT,
  area               TEXT,
  warehouse_id       INTEGER REFERENCES warehouses(id),
  custody_account_id INTEGER REFERENCES cash_accounts(id),
  active             INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS commission_plans (
  id          INTEGER PRIMARY KEY,
  rep_id      INTEGER NOT NULL REFERENCES reps(id),
  rate_bp     INTEGER NOT NULL,             -- نسبة من التحصيل المؤهل قبل الضريبة
  valid_from  TEXT NOT NULL,
  valid_to    TEXT,
  basis       TEXT NOT NULL DEFAULT 'collection_pretax'
);

CREATE TABLE IF NOT EXISTS warehouses (
  id        INTEGER PRIMARY KEY,
  branch_id INTEGER NOT NULL REFERENCES branches(id),
  name      TEXT NOT NULL UNIQUE,
  kind      TEXT NOT NULL DEFAULT 'main' CHECK (kind IN ('main','rep')),
  rep_id    INTEGER REFERENCES reps(id),
  active    INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS cash_accounts (
  id        INTEGER PRIMARY KEY,
  name      TEXT NOT NULL UNIQUE,
  kind      TEXT NOT NULL CHECK (kind IN ('cash','bank','rep_custody')),
  branch_id INTEGER REFERENCES branches(id),
  rep_id    INTEGER REFERENCES reps(id),
  active    INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS categories (
  id     INTEGER PRIMARY KEY,
  name   TEXT NOT NULL UNIQUE,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS expense_categories (
  id     INTEGER PRIMARY KEY,
  name   TEXT NOT NULL UNIQUE,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS items (
  id                INTEGER PRIMARY KEY,
  code              TEXT NOT NULL UNIQUE,
  name              TEXT NOT NULL,
  category_id       INTEGER REFERENCES categories(id),
  brand             TEXT,
  description       TEXT,
  base_unit         TEXT NOT NULL,
  qty_decimals      INTEGER NOT NULL DEFAULT 0 CHECK (qty_decimals BETWEEN 0 AND 3),
  track_expiry      INTEGER NOT NULL DEFAULT 1,
  reorder_level     INTEGER NOT NULL DEFAULT 0,          -- بوحدة الأساس × 1000
  expiry_alert_days INTEGER,
  min_price         INTEGER,                              -- أدنى سعر لوحدة الأساس (بأصغر وحدة عملة)
  max_discount_bp   INTEGER,                              -- حد الخصم للصنف
  tax_rate_bp       INTEGER,                              -- NULL = الإعداد العام
  image             TEXT,
  active            INTEGER NOT NULL DEFAULT 1,
  created_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS item_units (
  id         INTEGER PRIMARY KEY,
  item_id    INTEGER NOT NULL REFERENCES items(id),
  name       TEXT NOT NULL,
  factor     INTEGER NOT NULL CHECK (factor > 0),  -- كمية وحدة الأساس × 1000 في هذه الوحدة
  barcode    TEXT UNIQUE,
  sell_price INTEGER NOT NULL DEFAULT 0,
  is_base    INTEGER NOT NULL DEFAULT 0,
  for_sale   INTEGER NOT NULL DEFAULT 1,
  for_purchase INTEGER NOT NULL DEFAULT 1,
  active     INTEGER NOT NULL DEFAULT 1,
  UNIQUE (item_id, name)
);

CREATE TABLE IF NOT EXISTS parties (
  id                 INTEGER PRIMARY KEY,
  name               TEXT NOT NULL,
  phone              TEXT,
  address            TEXT,
  is_customer        INTEGER NOT NULL DEFAULT 0,
  is_supplier        INTEGER NOT NULL DEFAULT 0,
  credit_limit       INTEGER,                    -- NULL = بلا حد آجل (نقدي فقط إن كان 0)
  payment_terms_days INTEGER NOT NULL DEFAULT 0,
  rep_id             INTEGER REFERENCES reps(id),
  tax_number         TEXT,
  notes              TEXT,
  active             INTEGER NOT NULL DEFAULT 1,
  created_at         TEXT NOT NULL
);

-- ============ المستندات ============
CREATE TABLE IF NOT EXISTS doc_sequences (
  type   TEXT PRIMARY KEY,
  prefix TEXT NOT NULL,
  next   INTEGER NOT NULL DEFAULT 1
);

-- رأس مستند موحد لكل العمليات
CREATE TABLE IF NOT EXISTS docs (
  id              INTEGER PRIMARY KEY,
  type            TEXT NOT NULL,
  number          TEXT NOT NULL UNIQUE,
  date            TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','reversed')),
  party_id        INTEGER REFERENCES parties(id),
  warehouse_id    INTEGER REFERENCES warehouses(id),
  to_warehouse_id INTEGER REFERENCES warehouses(id),
  cash_account_id INTEGER REFERENCES cash_accounts(id),
  to_cash_account_id INTEGER REFERENCES cash_accounts(id),
  rep_id          INTEGER REFERENCES reps(id),
  session_id      INTEGER REFERENCES cash_sessions(id),
  expense_category_id INTEGER REFERENCES expense_categories(id),
  ref_doc_id      INTEGER REFERENCES docs(id),         -- المستند الأصلي (للمرتجع/التصحيح)
  reversal_of     INTEGER REFERENCES docs(id),
  supplier_invoice_no TEXT,
  due_date        TEXT,
  method          TEXT,                                -- cash/bank/card ...
  ledger_account  TEXT,                                -- AR / AP / COMMISSION_PAYABLE: حساب الذمة الذي يؤثر فيه المستند
  ledger_side     TEXT CHECK (ledger_side IN ('D','C')),
  subtotal        INTEGER NOT NULL DEFAULT 0,          -- قيمة البنود قبل الخصم
  discount        INTEGER NOT NULL DEFAULT 0,          -- إجمالي الخصومات
  net             INTEGER NOT NULL DEFAULT 0,          -- الصافي قبل الضريبة
  tax             INTEGER NOT NULL DEFAULT 0,
  extra_cost      INTEGER NOT NULL DEFAULT 0,          -- تكاليف شراء تابعة
  total           INTEGER NOT NULL DEFAULT 0,          -- الإجمالي المستحق على/للطرف
  cost            INTEGER NOT NULL DEFAULT 0,          -- تكلفة البضاعة (مبيعات) أو أثر المخزون
  prices_include_tax INTEGER NOT NULL DEFAULT 0,
  invoice_discount_bp INTEGER,
  invoice_discount_amount INTEGER,
  data            TEXT,                                -- JSON لحقول إضافية خاصة بالنوع
  notes           TEXT,
  reason          TEXT,
  print_count     INTEGER NOT NULL DEFAULT 0,
  created_by      INTEGER REFERENCES users(id),
  created_at      TEXT NOT NULL,
  approved_by     INTEGER REFERENCES users(id),
  approved_at     TEXT,
  reversed_by     INTEGER REFERENCES users(id),
  reversed_at     TEXT
);
CREATE INDEX IF NOT EXISTS docs_type_date ON docs(type, date);
CREATE INDEX IF NOT EXISTS docs_party ON docs(party_id);
CREATE INDEX IF NOT EXISTS docs_ref ON docs(ref_doc_id);
CREATE INDEX IF NOT EXISTS docs_supplier_invoice ON docs(party_id, supplier_invoice_no);

CREATE TABLE IF NOT EXISTS doc_lines (
  id            INTEGER PRIMARY KEY,
  doc_id        INTEGER NOT NULL REFERENCES docs(id),
  line_no       INTEGER NOT NULL,
  item_id       INTEGER REFERENCES items(id),
  item_name     TEXT,                    -- نسخة تاريخية
  unit_id       INTEGER REFERENCES item_units(id),
  unit_name     TEXT,
  factor        INTEGER,                 -- معامل التحويل المستخدم وقت العملية
  qty           INTEGER NOT NULL DEFAULT 0,   -- بالوحدة × 1000
  base_qty      INTEGER NOT NULL DEFAULT 0,   -- بوحدة الأساس × 1000
  price         INTEGER NOT NULL DEFAULT 0,   -- سعر الوحدة
  value         INTEGER NOT NULL DEFAULT 0,   -- الكمية × السعر
  line_discount INTEGER NOT NULL DEFAULT 0,
  doc_discount  INTEGER NOT NULL DEFAULT 0,   -- حصة البند من خصم الفاتورة
  net           INTEGER NOT NULL DEFAULT 0,   -- قبل الضريبة
  tax_rate_bp   INTEGER NOT NULL DEFAULT 0,
  tax           INTEGER NOT NULL DEFAULT 0,
  total         INTEGER NOT NULL DEFAULT 0,
  extra_cost    INTEGER NOT NULL DEFAULT 0,   -- حصة التكاليف التابعة
  cost          INTEGER NOT NULL DEFAULT 0,   -- التكلفة الفعلية للبند
  batch_id      INTEGER REFERENCES batches(id),
  batch_no      TEXT,
  prod_date     TEXT,
  expiry_date   TEXT,
  ref_line_id   INTEGER REFERENCES doc_lines(id),
  returned_qty  INTEGER NOT NULL DEFAULT 0,   -- بوحدة الأساس × 1000
  condition     TEXT,                     -- للمرتجع: ok/pending/isolated/damaged
  system_qty    INTEGER,                  -- للجرد: الرصيد المرجعي
  counted_qty   INTEGER,                  -- للجرد: الكمية الفعلية
  amount        INTEGER NOT NULL DEFAULT 0,   -- لبنود عامة (مصروف/عمولة)
  description   TEXT,
  data          TEXT
);
CREATE INDEX IF NOT EXISTS doc_lines_doc ON doc_lines(doc_id);
CREATE INDEX IF NOT EXISTS doc_lines_ref ON doc_lines(ref_line_id);

-- ============ المخزون ============
CREATE TABLE IF NOT EXISTS batches (
  id            INTEGER PRIMARY KEY,
  item_id       INTEGER NOT NULL REFERENCES items(id),
  warehouse_id  INTEGER NOT NULL REFERENCES warehouses(id),
  batch_no      TEXT,
  prod_date     TEXT,
  expiry_date   TEXT,
  status        TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok','pending','isolated')),
  qty           INTEGER NOT NULL DEFAULT 0 CHECK (qty >= 0),
  cost          INTEGER NOT NULL DEFAULT 0 CHECK (cost >= 0),
  source_doc_id INTEGER REFERENCES docs(id),
  origin_batch_id INTEGER REFERENCES batches(id),
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS batches_item_wh ON batches(item_id, warehouse_id, status, expiry_date);

CREATE TABLE IF NOT EXISTS stock_moves (
  id           INTEGER PRIMARY KEY,
  doc_id       INTEGER NOT NULL REFERENCES docs(id),
  line_id      INTEGER REFERENCES doc_lines(id),
  item_id      INTEGER NOT NULL REFERENCES items(id),
  batch_id     INTEGER NOT NULL REFERENCES batches(id),
  warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
  qty          INTEGER NOT NULL,       -- موجب دخول / سالب خروج (وحدة الأساس × 1000)
  cost         INTEGER NOT NULL,       -- موجب/سالب
  returned_qty INTEGER NOT NULL DEFAULT 0,
  returned_cost INTEGER NOT NULL DEFAULT 0,
  date         TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  user_id      INTEGER
);
CREATE INDEX IF NOT EXISTS stock_moves_item ON stock_moves(item_id, warehouse_id, date);
CREATE INDEX IF NOT EXISTS stock_moves_line ON stock_moves(line_id);
CREATE INDEX IF NOT EXISTS stock_moves_doc ON stock_moves(doc_id);

-- ============ الحسابات والقيود ============
CREATE TABLE IF NOT EXISTS journal_entries (
  id         INTEGER PRIMARY KEY,
  doc_id     INTEGER NOT NULL REFERENCES docs(id),
  date       TEXT NOT NULL,
  memo       TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS journal_lines (
  id              INTEGER PRIMARY KEY,
  entry_id        INTEGER NOT NULL REFERENCES journal_entries(id),
  doc_id          INTEGER NOT NULL REFERENCES docs(id),
  date            TEXT NOT NULL,
  account         TEXT NOT NULL,
  debit           INTEGER NOT NULL DEFAULT 0 CHECK (debit >= 0),
  credit          INTEGER NOT NULL DEFAULT 0 CHECK (credit >= 0),
  party_id        INTEGER REFERENCES parties(id),
  cash_account_id INTEGER REFERENCES cash_accounts(id),
  warehouse_id    INTEGER REFERENCES warehouses(id),
  rep_id          INTEGER REFERENCES reps(id),
  expense_category_id INTEGER REFERENCES expense_categories(id)
);
CREATE INDEX IF NOT EXISTS jl_account ON journal_lines(account, date);
CREATE INDEX IF NOT EXISTS jl_party ON journal_lines(party_id, account);
CREATE INDEX IF NOT EXISTS jl_cash ON journal_lines(cash_account_id);
CREATE TRIGGER IF NOT EXISTS jl_no_update BEFORE UPDATE ON journal_lines
BEGIN SELECT RAISE(ABORT, 'journal is append-only'); END;
CREATE TRIGGER IF NOT EXISTS jl_no_delete BEFORE DELETE ON journal_lines
BEGIN SELECT RAISE(ABORT, 'journal is append-only'); END;
CREATE TRIGGER IF NOT EXISTS sm_no_delete BEFORE DELETE ON stock_moves
BEGIN SELECT RAISE(ABORT, 'stock moves are append-only'); END;

-- تخصيص السداد/المرتجعات للفواتير
CREATE TABLE IF NOT EXISTS allocations (
  id            INTEGER PRIMARY KEY,
  source_doc_id INTEGER NOT NULL REFERENCES docs(id),   -- سند/مرتجع
  target_doc_id INTEGER NOT NULL REFERENCES docs(id),   -- فاتورة/مستحق
  amount        INTEGER NOT NULL CHECK (amount > 0),
  date          TEXT NOT NULL,
  reversed      INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  created_by    INTEGER
);
CREATE INDEX IF NOT EXISTS alloc_source ON allocations(source_doc_id);
CREATE INDEX IF NOT EXISTS alloc_target ON allocations(target_doc_id);

-- ============ الورديات ============
CREATE TABLE IF NOT EXISTS cash_sessions (
  id               INTEGER PRIMARY KEY,
  number           TEXT NOT NULL UNIQUE,
  user_id          INTEGER NOT NULL REFERENCES users(id),
  cash_account_id  INTEGER NOT NULL REFERENCES cash_accounts(id),
  card_account_id  INTEGER REFERENCES cash_accounts(id),
  warehouse_id     INTEGER REFERENCES warehouses(id),
  status           TEXT NOT NULL CHECK (status IN ('open','closing','closed')),
  opening_amount   INTEGER NOT NULL,
  opened_at        TEXT NOT NULL,
  expected_amount  INTEGER,
  counted_amount   INTEGER,
  variance         INTEGER,
  variance_reason  TEXT,
  variance_doc_id  INTEGER REFERENCES docs(id),
  closed_at        TEXT,
  approved_by      INTEGER REFERENCES users(id)
);

-- ============ العمولات ============
CREATE TABLE IF NOT EXISTS commission_items (
  id                 INTEGER PRIMARY KEY,
  commission_doc_id  INTEGER NOT NULL REFERENCES docs(id),
  allocation_id      INTEGER NOT NULL REFERENCES allocations(id),
  base               INTEGER NOT NULL,     -- الأساس قبل الضريبة (سالب للتصحيح)
  rate_bp            INTEGER NOT NULL,
  amount             INTEGER NOT NULL,
  kind               TEXT NOT NULL CHECK (kind IN ('collection','correction'))
);
CREATE INDEX IF NOT EXISTS ci_alloc ON commission_items(allocation_id);

-- ============ المرفقات ============
CREATE TABLE IF NOT EXISTS attachments (
  id          INTEGER PRIMARY KEY,
  doc_id      INTEGER REFERENCES docs(id),
  file_name   TEXT NOT NULL,
  stored_name TEXT NOT NULL UNIQUE,
  mime        TEXT NOT NULL,
  size        INTEGER NOT NULL,
  uploaded_by INTEGER REFERENCES users(id),
  created_at  TEXT NOT NULL
);
