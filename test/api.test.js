'use strict';
// اختبار القبول 15 (التكرار والتزامن) واختبارات الصلاحيات والنسخ عبر HTTP فعلي.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openDb } = require('../src/db');
const { createApp } = require('../src/server');
const users = require('../src/core/users');

async function boot() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'frs-'));
  const db = openDb(path.join(dataDir, 'data.db'));
  users.ensureAdmin(db, 'Admin12345');
  const app = createApp({ db, dataDir, today: '2026-10-02', logger: { error() {}, log() {} } });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const client = async (username, password) => {
    const res = await fetch(base + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'fetch' }, body: JSON.stringify({ username, password }) });
    assert.equal(res.status, 200, 'login ' + username);
    const cookie = res.headers.get('set-cookie').split(';')[0];
    const call = async (method, url, body, extra = {}) => {
      const r = await fetch(base + url, { method, headers: { 'content-type': 'application/json', 'x-requested-with': 'fetch', cookie, ...extra }, body: body ? JSON.stringify(body) : undefined });
      const ct = r.headers.get('content-type') || '';
      return { status: r.status, body: ct.includes('json') ? await r.json() : await r.arrayBuffer(), headers: r.headers };
    };
    return { get: (u) => call('GET', u), post: (u, b, h) => call('POST', u, b, h), put: (u, b, h) => call('PUT', u, b, h), del: (u) => call('DELETE', u) };
  };
  const admin = await client('admin', 'Admin12345');
  return { db, dataDir, server, base, client, admin, close: () => new Promise((r) => server.close(r)) };
}

test('15 التكرار والتزامن عبر الخادم', async () => {
  const t = await boot();
  try {
    const item = (await t.admin.post('/items', { name: 'سكر', base_unit: 'حبة', track_expiry: 0, sell_price: 20 })).body;
    await t.admin.post('/opening-stock', { warehouse_id: 1, lines: [{ item_id: item.id, qty: 10, unit_cost: 10 }] });
    const sale = { lines: [{ item_id: item.id, qty: 2 }], payments: [{ cash_account_id: 1, amount: 40 }] };
    const key = 'op-' + Date.now();
    const [a, b] = await Promise.all([t.admin.post('/sales', sale, { 'idempotency-key': key }), t.admin.post('/sales', sale, { 'idempotency-key': key })]);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal(a.body.id, b.body.id, 'نفس الفاتورة');
    const again = await t.admin.post('/sales', sale, { 'idempotency-key': key });
    assert.equal(again.body.number, a.body.number);
    assert.equal(again.headers.get('idempotent-replay'), 'true');
    const conflict = await t.admin.post('/sales', { ...sale, lines: [{ item_id: item.id, qty: 3 }] }, { 'idempotency-key': key });
    assert.equal(conflict.status, 409, 'إعادة المعرف بمحتوى مختلف تُرفض');
    assert.equal(t.db.prepare("SELECT COUNT(*) n FROM docs WHERE type='sale'").get().n, 1, 'فاتورة واحدة');
    assert.equal(t.db.prepare("SELECT SUM(total) s FROM docs WHERE type='receipt'").get().s / 100, 40, 'قبض 40');
    let stock = (await t.admin.get(`/reports/stock?item_id=${item.id}`)).body.rows[0];
    assert.equal(stock.sellable, 8, 'رصيد 8');

    // من رصيد 3: طلبان مستقلان لبيع 2 في نفس اللحظة
    const item2 = (await t.admin.post('/items', { name: 'ملح', base_unit: 'حبة', track_expiry: 0, sell_price: 5 })).body;
    await t.admin.post('/opening-stock', { warehouse_id: 1, lines: [{ item_id: item2.id, qty: 3, unit_cost: 1 }] });
    const s2 = { lines: [{ item_id: item2.id, qty: 2 }], payments: [{ cash_account_id: 1, amount: 10 }] };
    const res = await Promise.all([t.admin.post('/sales', s2, { 'idempotency-key': 'k1-' + Date.now() }), t.admin.post('/sales', s2, { 'idempotency-key': 'k2-' + Date.now() })]);
    const ok = res.filter((r) => r.status === 200);
    const rejected = res.filter((r) => r.status === 409);
    assert.equal(ok.length, 1, 'ينجح طلب واحد');
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0].body.error.code, 'INSUFFICIENT_STOCK');
    stock = (await t.admin.get(`/reports/stock?item_id=${item2.id}`)).body.rows[0];
    assert.equal(stock.sellable, 1, 'يبقى 1');
  } finally { await t.close(); }
});

test('14 عبر الخادم: الكاشير مرفوض في الإدارة والتكلفة', async () => {
  const t = await boot();
  try {
    await t.admin.post('/users', { username: 'cashier', full_name: 'كاشير', password: 'Cash1234', roles: ['cashier'] });
    const c = await t.client('cashier', 'Cash1234');
    assert.equal((await c.post('/users', { username: 'hack', full_name: 'x', password: 'Hack1234', roles: ['admin'] })).status, 403);
    assert.equal((await c.put('/settings', { default_tax_rate_pct: 0 })).status, 403);
    assert.equal((await c.get('/reports/profit')).status, 403);
    assert.equal((await c.get('/audit')).status, 403);
    const item = (await t.admin.post('/items', { name: 'أرز', base_unit: 'حبة', sell_price: 5, track_expiry: 0 })).body;
    const view = await c.get('/items/' + item.id);
    assert.equal(view.status, 200);
    assert.equal(view.body.min_price, undefined, 'لا يرى التكلفة/السعر الأدنى');
    const logged = t.db.prepare("SELECT COUNT(*) n FROM audit_log WHERE username='cashier' AND ok=0").get().n;
    assert.ok(logged >= 4, 'تسجيل محاولات الرفض');
    // بدون رأس CSRF
    const r = await fetch(t.base + '/users', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(r.status, 403);
  } finally { await t.close(); }
});

test('حماية الدخول: إيقاف مؤقت بعد محاولات خاطئة', async () => {
  const t = await boot();
  try {
    for (let i = 0; i < 5; i++) {
      const r = await fetch(t.base + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'fetch' }, body: JSON.stringify({ username: 'admin', password: 'wrong' }) });
      assert.equal(r.status, 401);
    }
    const r = await fetch(t.base + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'fetch' }, body: JSON.stringify({ username: 'admin', password: 'Admin12345' }) });
    assert.equal(r.status, 429);
    const stored = t.db.prepare("SELECT password_hash FROM users WHERE username='admin'").get().password_hash;
    assert.ok(stored.startsWith('scrypt$') && !stored.includes('Admin12345'), 'كلمة المرور مجزأة');
  } finally { await t.close(); }
});

test('استعادة النسخة في بيئة منفصلة: تطابق المستندات والأرصدة والمرفقات', async () => {
  const t = await boot();
  try {
    const item = (await t.admin.post('/items', { name: 'زيت', base_unit: 'حبة', sell_price: 30, track_expiry: 0 })).body;
    await t.admin.post('/opening-stock', { warehouse_id: 1, lines: [{ item_id: item.id, qty: 10, unit_cost: 20 }] });
    await t.admin.post('/sales', { lines: [{ item_id: item.id, qty: 2 }], payments: [{ cash_account_id: 1, amount: 60 }] });
    const pdf = Buffer.from('%PDF-1.4 test').toString('base64');
    const att = await t.admin.post('/attachments', { file_name: 'فاتورة.pdf', mime: 'application/pdf', data: pdf });
    assert.equal(att.status, 200);
    const bad = await t.admin.post('/attachments', { file_name: 'x.pdf', mime: 'application/pdf', data: Buffer.from('MZ evil').toString('base64') });
    assert.equal(bad.status, 400, 'رفض محتوى لا يطابق النوع');
    const b = await t.admin.post('/backups', {});
    assert.equal(b.status, 200);
    const v = await t.admin.post(`/backups/${b.body.name}/verify`, {});
    assert.equal(v.body.ok, true, JSON.stringify(v.body));
    assert.equal(v.body.counts.docs, 3);
    assert.equal(v.body.files, 1);
    // استعادة فعلية إلى مجلد آخر ومقارنة
    const Backup = require('../src/core/backup');
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'frs-restore-'));
    Backup.restoreBackup(path.join(t.dataDir, 'backups'), b.body.name, path.join(other, 'data.db'), path.join(other, 'uploads'));
    const db2 = openDb(path.join(other, 'data.db'));
    assert.deepEqual(Backup.tableCounts(db2), Backup.tableCounts(t.db));
    assert.equal(fs.readdirSync(path.join(other, 'uploads')).length, 1);
    db2.close();
  } finally { await t.close(); }
});

test('تصدير التقارير Excel وCSV', async () => {
  const t = await boot();
  try {
    const x = await t.admin.get('/reports/stock/export?format=xlsx');
    assert.equal(x.status, 200);
    assert.equal(Buffer.from(x.body).slice(0, 2).toString(), 'PK');
    const c = await t.admin.get('/reports/cash/export?format=csv');
    assert.equal(c.status, 200);
  } finally { await t.close(); }
});

test('الإعدادات: رفض المنطقة الزمنية غير الصالحة وعدم تعطل النظام بها', async () => {
  const t = await boot();
  try {
    const bad = await t.admin.put('/settings', { timezone: 'مصر' });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error.message, /المنطقة الزمنية/);
    assert.equal((await t.admin.put('/settings', { timezone: 'Africa/Cairo', org_name: 'مؤسسة الاختبار' })).status, 200);
    // قيمة تالفة محفوظة مسبقًا (من إصدار قديم) لا توقف النظام
    t.db.prepare("UPDATE settings SET value='Cairo' WHERE key='timezone'").run();
    const me = await t.admin.get('/auth/me');
    assert.equal(me.status, 200);
  } finally { await t.close(); }
});

test('المستودعات: تعديل الاسم وحذف الفارغ فقط', async () => {
  const t = await boot();
  try {
    const w = (await t.admin.post('/warehouses', { name: 'مستودع مؤقت' })).body;
    assert.equal((await t.admin.put('/warehouses/' + w.id, { name: 'مستودع معدل' })).body.name, 'مستودع معدل');
    const used = (await t.admin.post('/warehouses', { name: 'مستودع مستخدم' })).body;
    const item = (await t.admin.post('/items', { name: 'سكر', base_unit: 'حبة', track_expiry: 0, sell_price: 5 })).body;
    await t.admin.post('/opening-stock', { warehouse_id: used.id, lines: [{ item_id: item.id, qty: 2, unit_cost: 1 }] });
    const r1 = await t.admin.del('/warehouses/' + used.id);
    assert.equal(r1.status, 400);
    assert.match(r1.body.error.message, /منتجات/);
    assert.equal((await t.admin.del('/warehouses/' + w.id)).status, 200);
    assert.equal(t.db.prepare('SELECT COUNT(*) n FROM warehouses WHERE id=?').get(w.id).n, 0);
    assert.equal(t.db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action='warehouse.delete'").get().n, 1, 'الحذف موثق');
  } finally { await t.close(); }
});

test('الصناديق: تعديل الاسم وحذف غير المستخدم فقط', async () => {
  const t = await boot();
  try {
    const c = (await t.admin.post('/cash-accounts', { name: 'صندوق مؤقت', kind: 'cash' })).body;
    assert.equal((await t.admin.put('/cash-accounts/' + c.id, { name: 'كاش' })).body.name, 'كاش');
    const item = (await t.admin.post('/items', { name: 'ملح', base_unit: 'حبة', track_expiry: 0, sell_price: 5 })).body;
    await t.admin.post('/opening-stock', { warehouse_id: 1, lines: [{ item_id: item.id, qty: 5, unit_cost: 1 }] });
    await t.admin.post('/sales', { lines: [{ item_id: item.id, qty: 1 }], payments: [{ cash_account_id: c.id, amount: 5 }] });
    const r = await t.admin.del('/cash-accounts/' + c.id);
    assert.equal(r.status, 400);
    assert.match(r.body.error.message, /حركات/);
    const c2 = (await t.admin.post('/cash-accounts', { name: 'بنك جديد', kind: 'bank' })).body;
    assert.equal((await t.admin.del('/cash-accounts/' + c2.id)).status, 200);
  } finally { await t.close(); }
});

test('فاتورة الشراء: نقدًا تُسدد كامل الإجمالي، وآجل تبقى دينًا', async () => {
  const t = await boot();
  try {
    const sup = (await t.admin.post('/parties', { name: 'مورد', is_supplier: 1 })).body;
    const item = (await t.admin.post('/items', { name: 'سكر', base_unit: 'حبة', track_expiry: 0 })).body;
    t.db.prepare("UPDATE cash_accounts SET kind='bank' WHERE id=1").run(); // تجاوز فحص رصيد الصندوق في الاختبار
    const base = { party_id: sup.id, lines: [{ item_id: item.id, unit_id: item.units[0].id, qty: 3, price: 10, tax_rate_pct: 15 }] };
    const cash = await t.admin.post('/purchases', { ...base, approve: true, payment: { mode: 'cash', cash_account_id: 1 } });
    assert.equal(cash.status, 200, JSON.stringify(cash.body));
    const c = (await t.admin.get('/docs/' + cash.body.id)).body;
    assert.equal(c.total, 34.5);
    assert.equal(c.open_amount, 0, 'مسددة بالكامل');
    assert.equal(c.due_date, c.date);
    const credit = await t.admin.post('/purchases', { ...base, approve: true });
    assert.equal((await t.admin.get('/docs/' + credit.body.id)).body.open_amount, 34.5);
  } finally { await t.close(); }
});

test('البحث للبيع: لا تظهر إلا الأصناف التي لها رصيد في المستودع', async () => {
  const t = await boot();
  try {
    const a = (await t.admin.post('/items', { name: 'صنف برصيد', base_unit: 'حبة', track_expiry: 0, sell_price: 5 })).body;
    await t.admin.post('/items', { name: 'صنف بلا رصيد', base_unit: 'حبة', track_expiry: 0, sell_price: 5 });
    await t.admin.post('/opening-stock', { warehouse_id: 1, lines: [{ item_id: a.id, qty: 2, unit_cost: 1 }] });
    const names = async (q) => (await t.admin.get(`/items/lookup?q=${encodeURIComponent(q)}&warehouse_id=1&in_stock=1`)).body.map((x) => x.name);
    assert.deepEqual(await names('صنف'), ['صنف برصيد']);
    assert.deepEqual(await names(''), ['صنف برصيد'], 'قائمة التصفح');
    assert.equal((await t.admin.get(`/items/lookup?q=${encodeURIComponent('صنف')}&warehouse_id=1`)).body.length, 2, 'الشراء يرى كل الأصناف');
  } finally { await t.close(); }
});

test('سعر الشراء للوحدات: يُحفظ ولا يظهر للكاشير', async () => {
  const t = await boot();
  try {
    const it = (await t.admin.post('/items', { name: 'جبنة', base_unit: 'حبة', track_expiry: 0, sell_price: 10, purchase_price: 7, units: [{ name: 'كرتون', factor: 12, purchase_price: 80 }] })).body;
    assert.deepEqual(it.units.map((u) => u.purchase_price), [7, 80]);
    const upd = (await t.admin.put('/items/' + it.id, { name: 'جبنة', base_unit: 'حبة', units: it.units.map((u) => ({ ...u, purchase_price: u.is_base ? 7.5 : undefined })) })).body;
    assert.deepEqual(upd.units.map((u) => u.purchase_price), [7.5, 80], 'عدم الإرسال لا يمسح السعر');
    await t.admin.post('/users', { username: 'cashier', full_name: 'كاشير', password: 'Cash1234', roles: ['cashier'] });
    const c = await t.client('cashier', 'Cash1234');
    assert.equal((await c.get('/items/' + it.id)).body.units[0].purchase_price, undefined);
  } finally { await t.close(); }
});

test('نسبة الربح: سعر البيع = سعر الشراء + النسبة عند عدم إدخاله', async () => {
  const t = await boot();
  try {
    const it = (await t.admin.post('/items', { name: 'زيت', base_unit: 'حبة', track_expiry: 0, purchase_price: 10, profit_margin: 25, units: [{ name: 'كرتون', factor: 12, purchase_price: 100, profit_margin: 20 }, { name: 'ربطة', factor: 6, purchase_price: 50, profit_margin: 20, sell_price: 70 }] })).body;
    assert.deepEqual(it.units.map((u) => [u.name, u.sell_price, u.profit_margin]), [['حبة', 12.5, 25], ['ربطة', 70, 20], ['كرتون', 120, 20]]);
    const bad = await t.admin.post('/items', { name: 'خطأ', base_unit: 'حبة', purchase_price: 1, profit_margin: -5 });
    assert.equal(bad.status, 400);
  } finally { await t.close(); }
});

test('وحدة الإدخال: الشراء بوحدة واحدة فقط والبيع بكل الوحدات', async () => {
  const t = await boot();
  try {
    const sup = (await t.admin.post('/parties', { name: 'مورد', is_supplier: 1 })).body;
    const it = (await t.admin.post('/items', { name: 'حلاوة', base_unit: 'حبة', track_expiry: 0, sell_price: 2, base_for_purchase: 0, units: [{ name: 'كرتون', factor: 12, sell_price: 20, for_purchase: 1 }] })).body;
    const [piece, carton] = it.units;
    assert.deepEqual([piece.for_purchase, carton.for_purchase], [0, 1]);
    const bad = await t.admin.post('/purchases', { party_id: sup.id, lines: [{ item_id: it.id, unit_id: piece.id, qty: 1, price: 1 }] });
    assert.equal(bad.status, 400);
    assert.equal((await t.admin.post('/purchases', { party_id: sup.id, approve: true, lines: [{ item_id: it.id, unit_id: carton.id, qty: 1, price: 12 }] })).status, 200);
    const sale = await t.admin.post('/sales', { lines: [{ item_id: it.id, unit_id: piece.id, qty: 1 }], payments: [{ cash_account_id: 1, amount: 2 }] });
    assert.equal(sale.status, 200, 'البيع بالحبة متاح');
    // إيقاف وحدة الإدخال الوحيدة يعيدها لوحدة المنتج
    const upd = (await t.admin.put('/items/' + it.id, { name: 'حلاوة', base_unit: 'حبة', units: [{ ...piece, for_purchase: 0 }, { ...carton, for_purchase: 1, active: 0 }] })).body;
    assert.equal(upd.units.find((u) => u.is_base).for_purchase, 1);
  } finally { await t.close(); }
});

test('الرقم الضريبي: رفض الرقم غير الصحيح عند تفعيل رمز QR', async () => {
  const t = await boot();
  try {
    const bad = await t.admin.put('/settings', { org_tax_number: '1111111111', einvoice_qr: true });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error.message, /15 رقمًا/);
    assert.equal((await t.admin.put('/settings', { org_tax_number: '310123456700003' })).status, 200);
    assert.equal((await t.admin.get('/settings')).body.einvoice_qr, '1', 'يُفعّل تلقائيًا مع رقم صحيح');
  } finally { await t.close(); }
});

test('المندوب المرتبط بفرع: يرى طرق السداد (البنوك) ويبيع بها، ويرى عملاءه المسندين', async () => {
  const t = await boot();
  try {
    const br = (await t.admin.post('/branches', { name: 'جده' })).body;
    const mada = (await t.admin.post('/cash-accounts', { name: 'مدى', kind: 'bank' })).body;
    const rep = (await t.admin.post('/reps', { name: 'مصطفى' })).body;
    await t.admin.post('/users', { username: 'mostafa', full_name: 'مصطفى', password: 'Rep12345', roles: ['rep'], rep_id: rep.id, branch_id: br.id });
    const c = (await t.admin.post('/parties', { name: 'البوادي', is_customer: 1 })).body;
    const item = (await t.admin.post('/items', { name: 'حلاوه', base_unit: 'حبة', track_expiry: 0, sell_price: 10 })).body;
    await t.admin.post('/opening-stock', { warehouse_id: 1, lines: [{ item_id: item.id, qty: 20, unit_cost: 5 }] });
    await t.admin.post('/transfers', { from_warehouse_id: 1, to_warehouse_id: rep.warehouse_id, lines: [{ item_id: item.id, unit_id: item.units[0].id, qty: 10 }] });
    const r = await t.client('mostafa', 'Rep12345');
    assert.deepEqual((await r.get('/parties?type=customer')).body.rows.map((p) => p.name), [], 'قبل الإسناد');
    await t.admin.post(`/reps/${rep.id}/customers`, { party_ids: [c.id] });
    assert.deepEqual((await r.get('/parties?type=customer')).body.rows.map((p) => p.name), ['البوادي']);
    assert.ok((await r.get('/cash-accounts')).body.some((a) => a.id === mada.id), 'مدى ظاهر للمندوب');
    const sale = await r.post('/sales', { party_id: c.id, warehouse_id: rep.warehouse_id, lines: [{ item_id: item.id, qty: 2 }], payments: [{ method: 'card', cash_account_id: mada.id, amount: 20 }] });
    assert.equal(sale.status, 200, JSON.stringify(sale.body));
  } finally { await t.close(); }
});

test('تعديل صلاحيات الأدوار: يسري فورًا، والمدير ثابت، والاستعادة للافتراضي', async () => {
  const t = await boot();
  try {
    await t.admin.post('/users', { username: 'cashier', full_name: 'كاشير', password: 'Cash1234', roles: ['cashier'] });
    const c = await t.client('cashier', 'Cash1234');
    assert.equal((await c.get('/reports/stock')).status, 200);
    const meta = (await t.admin.get('/meta')).body;
    const perms = meta.roles.cashier.permissions.filter((p) => p !== 'stock.view');
    assert.equal((await t.admin.put('/roles/cashier/permissions', { permissions: perms })).status, 200);
    assert.equal((await c.get('/reports/stock')).status, 403, 'سُحبت الصلاحية فورًا');
    assert.equal((await t.admin.put('/roles/admin/permissions', { permissions: [] })).status, 400, 'المدير ثابت');
    assert.equal((await t.admin.put('/roles/cashier/permissions', { permissions: ['bogus.perm'] })).status, 400);
    assert.equal((await c.put('/roles/cashier/permissions', { permissions: [...perms, 'users.manage'] })).status, 403, 'الكاشير لا يعدل الصلاحيات');
    assert.equal((await t.admin.put('/roles/cashier/permissions', { reset: true })).status, 200);
    assert.equal((await c.get('/reports/stock')).status, 200, 'عادت الافتراضية');
  } finally { await t.close(); }
});

test('عميل لكل المناديب: يظهر لكل مندوب ويبيع له، والعميل الخاص لمندوبه فقط', async () => {
  const t = await boot();
  try {
    const r1 = (await t.admin.post('/reps', { name: 'أ' })).body;
    const r2 = (await t.admin.post('/reps', { name: 'ب' })).body;
    await t.admin.post('/users', { username: 'repa', full_name: 'أ', password: 'Rep12345', roles: ['rep'], rep_id: r1.id });
    await t.admin.post('/users', { username: 'repb', full_name: 'ب', password: 'Rep12345', roles: ['rep'], rep_id: r2.id });
    const all = (await t.admin.post('/parties', { name: 'الجنوب', is_customer: 1, rep_id: 'all' })).body;
    assert.equal(all.all_reps, 1);
    await t.admin.post('/parties', { name: 'خاص أ', is_customer: 1, rep_id: r1.id });
    const a = await t.client('repa', 'Rep12345');
    const b = await t.client('repb', 'Rep12345');
    assert.deepEqual((await a.get('/parties?type=customer')).body.rows.map((p) => p.name).sort(), ['الجنوب', 'خاص أ'].sort());
    assert.deepEqual((await b.get('/parties?type=customer')).body.rows.map((p) => p.name), ['الجنوب']);
    assert.equal((await b.get('/parties/' + all.id)).status, 200);
    const upd = (await t.admin.put('/parties/' + all.id, { name: 'الجنوب', is_customer: 1, rep_id: r2.id })).body;
    assert.equal(upd.all_reps, 0);
    assert.deepEqual((await a.get('/parties?type=customer')).body.rows.map((p) => p.name), ['خاص أ']);
  } finally { await t.close(); }
});

test('استيراد الأصناف من القالب: سعر الشراء ونسبة الربح ووحدة الإدخال، والقالب القديم مقبول', async () => {
  const t = await boot();
  try {
    const ExcelJS = require('exceljs');
    const tpl = await t.admin.get('/import/template/items');
    assert.equal(tpl.status, 200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(tpl.body));
    assert.deepEqual(wb.worksheets.map((w) => w.name), ['الأصناف', 'مثال', 'التعليمات']);
    const ex = wb.getWorksheet('مثال');
    ex.eachRow((row, n) => { if (n > 1) wb.worksheets[0].addRow(row.values.slice(1)); });
    const data = Buffer.from(await wb.xlsx.writeBuffer()).toString('base64');
    const pv = await t.admin.post('/import/preview', { kind: 'items', filename: 'a.xlsx', data });
    assert.equal(pv.status, 200, JSON.stringify(pv.body));
    assert.equal(pv.body.invalid, 0, JSON.stringify(pv.body.rows.map((r) => r._errors)));
    assert.equal(pv.body.valid, 4);
    assert.equal((await t.admin.post('/import/commit', { kind: 'items', filename: 'a.xlsx', data })).status, 200);
    const items = (await t.admin.get('/items')).body.rows;
    const sugar = items.find((i) => i.name === 'سكر الأسرة 1 كجم');
    const [piece, carton] = sugar.units;
    assert.equal(piece.purchase_price, 4.5); assert.equal(piece.sell_price, 5.4, 'من نسبة الربح');
    assert.equal(carton.factor, 10); assert.equal(carton.purchase_price, 42); assert.equal(carton.sell_price, 50.4);
    assert.deepEqual([piece.for_purchase, carton.for_purchase], [0, 1], 'وحدة الإدخال كرتون');
    const rice = items.find((i) => i.name === 'أرز بسمتي 5 كجم');
    assert.equal(rice.units[0].sell_price, 39); assert.equal(rice.units[0].for_purchase, 1);
    // القالب القديم بأسماء الأعمدة السابقة
    const csv = 'الاسم,وحدة الأساس,سعر الأساس\nملح,حبة,2\n';
    const old = await t.admin.post('/import/commit', { kind: 'items', filename: 'old.csv', data: Buffer.from(csv).toString('base64') });
    assert.equal(old.status, 200, JSON.stringify(old.body));
  } finally { await t.close(); }
});

test('خصم الفاتورة: يفعّله المدير، واستخدامه من المندوب يلغي خصومات الأصناف', async () => {
  const t = await boot();
  try {
    const rep = (await t.admin.post('/reps', { name: 'م' })).body;
    await t.admin.post('/users', { username: 'repx', full_name: 'م', password: 'Rep12345', roles: ['rep'], rep_id: rep.id });
    const item = (await t.admin.post('/items', { name: 'حلاوه', base_unit: 'حبة', track_expiry: 0, sell_price: 10, max_discount_pct: 50 })).body;
    await t.admin.post('/opening-stock', { warehouse_id: 1, lines: [{ item_id: item.id, qty: 20, unit_cost: 5 }] });
    await t.admin.post('/transfers', { from_warehouse_id: 1, to_warehouse_id: rep.warehouse_id, lines: [{ item_id: item.id, unit_id: item.units[0].id, qty: 10 }] });
    const c = (await t.admin.post('/parties', { name: 'ع', is_customer: 1, rep_id: rep.id })).body;
    const r = await t.client('repx', 'Rep12345');
    const body = { party_id: c.id, warehouse_id: rep.warehouse_id, invoice_discount_amount: 2, lines: [{ item_id: item.id, qty: 2, discount_pct: 10 }], payments: [] };
    const off = await r.post('/sales', body);
    assert.equal(off.status, 403, 'غير مفعّل');
    assert.match(off.body.error.message, /غير مفعّل/);
    await t.admin.put('/settings', { invoice_discount_enabled: true });
    const on = await r.post('/sales', body);
    assert.equal(on.status, 200, JSON.stringify(on.body));
    assert.equal(on.body.lines[0].line_discount, 0, 'أُلغي خصم الصنف');
    assert.equal(on.body.discount, 2, 'بقي خصم الفاتورة فقط');
    // بدون خصم فاتورة: خصم الصنف يبقى
    const lineOnly = await r.post('/sales', { party_id: c.id, warehouse_id: rep.warehouse_id, lines: [{ item_id: item.id, qty: 1, discount_pct: 10 }], payments: [] });
    assert.equal(lineOnly.body.lines[0].line_discount, 1);
  } finally { await t.close(); }
});

test('مشاركة الفاتورة برابط: صفحة عامة بلا دخول وبلا تكاليف، والمسودة والشراء لا يُشاركان', async () => {
  const t = await boot();
  try {
    const item = (await t.admin.post('/items', { name: 'شاي', base_unit: 'حبة', track_expiry: 0, sell_price: 10 })).body;
    await t.admin.post('/opening-stock', { warehouse_id: 1, lines: [{ item_id: item.id, qty: 10, unit_cost: 4 }] });
    const c = (await t.admin.post('/parties', { name: 'عميل', is_customer: 1, phone: '0501234567' })).body;
    const sale = (await t.admin.post('/sales', { party_id: c.id, lines: [{ item_id: item.id, qty: 2 }], payments: [] })).body;
    const sh = await t.admin.post(`/docs/${sale.id}/share`);
    assert.equal(sh.status, 200, JSON.stringify(sh.body));
    assert.match(sh.body.url, /\/r\/[a-f0-9]{48}$/);
    assert.equal(sh.body.phone, '0501234567');
    assert.equal((await t.admin.post(`/docs/${sale.id}/share`)).body.url, sh.body.url, 'نفس الرابط عند التكرار');
    const token = sh.body.url.split('/r/')[1];
    const root = t.base.replace(/\/api$/, '');
    const page = await fetch(`${root}/r/${token}`);
    assert.equal(page.status, 200);
    const pub = await fetch(`${root}/public/receipt/${token}`);
    assert.equal(pub.status, 200);
    const j = await pub.json();
    assert.equal(j.doc.number, sale.number);
    assert.equal(j.doc.total, 20);
    assert.equal(j.doc.cost, undefined, 'لا تكلفة');
    assert.equal(j.doc.lines[0].cost, undefined, 'لا تكلفة للبند');
    assert.equal((await fetch(`${root}/public/receipt/${'0'.repeat(48)}`)).status, 404);
    assert.equal((await fetch(`${root}/r/abc`)).status, 404);
    const draft = (await t.admin.post('/sales', { party_id: c.id, draft: true, lines: [{ item_id: item.id, qty: 1 }], payments: [] })).body;
    if (draft.status === 'draft') assert.equal((await t.admin.post(`/docs/${draft.id}/share`)).status >= 400, true, 'المسودة لا تُشارك');
    const sup = (await t.admin.post('/parties', { name: 'مورد', is_supplier: 1 })).body;
    const pur = (await t.admin.post('/purchases', { party_id: sup.id, warehouse_id: 1, approve: true, lines: [{ item_id: item.id, qty: 1, price: 4 }] })).body;
    assert.equal((await t.admin.post(`/docs/${pur.id}/share`)).status >= 400, true, 'الشراء لا يُشارك');
  } finally { await t.close(); }
});

test('استعادة كلمة مرور المدير من ADMIN_RESET_PASSWORD: مرة واحدة لكل قيمة وتفك القفل', async () => {
  const t = await boot();
  try {
    await t.admin.post('/auth/change-password', { current_password: 'Admin12345', new_password: 'Forgotten999' }).catch(() => null);
    for (let i = 0; i < 6; i++) await fetch(t.base + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'fetch' }, body: JSON.stringify({ username: 'admin', password: 'wrong-pass' }) });
    assert.equal(users.resetAdmin(t.db, 'short'), 'short');
    assert.equal(users.resetAdmin(t.db, 'NewReset2026'), 'reset');
    const c = await t.client('admin', 'NewReset2026');
    const me = await c.get('/auth/me');
    assert.equal(me.body.user.must_change_password, 1, 'يُطلب تغييرها');
    assert.equal(users.resetAdmin(t.db, 'NewReset2026'), 'already', 'لا تُعاد عند إعادة التشغيل');
  } finally { await t.close(); }
});

test('استيراد العملاء من Excel: المندوب بالاسم و«الكل»، إعادة صفر الجوال، العميل افتراضيًا، والرصيد الافتتاحي', async () => {
  const t = await boot();
  try {
    const ExcelJS = require('exceljs');
    const rep = (await t.admin.post('/reps', { name: 'أحمد' })).body;
    const tpl = await t.admin.get('/import/template/parties');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(tpl.body));
    assert.deepEqual(wb.worksheets.map((w) => w.name), ['العملاء والموردون', 'مثال', 'التعليمات']);
    wb.getWorksheet('مثال').eachRow((row, n) => { if (n > 1) wb.worksheets[0].addRow(row.values.slice(1)); });
    wb.worksheets[0].addRow(['رقم بلا صفر', 551112222]);
    const data = Buffer.from(await wb.xlsx.writeBuffer()).toString('base64');
    const pv = await t.admin.post('/import/preview', { kind: 'parties', filename: 'c.xlsx', data });
    assert.equal(pv.status, 200, JSON.stringify(pv.body));
    assert.equal(pv.body.invalid, 0, JSON.stringify(pv.body.rows.filter((r) => r._errors.length)));
    const c = await t.admin.post('/import/commit', { kind: 'parties', filename: 'c.xlsx', data, date: '2026-10-01' });
    assert.equal(c.body.imported, 5);
    const P = (name) => t.db.prepare('SELECT * FROM parties WHERE name=?').get(name);
    assert.equal(P('بقالة البوادي').rep_id, rep.id);
    assert.equal(P('بقالة البوادي').tax_number, '310123456700003');
    assert.equal(P('سوبرماركت النخيل').all_reps, 1);
    assert.equal(P('عميل نقدي محمد').is_customer, 1, 'فارغ = عميل');
    assert.equal(P('مصنع الحلويات').is_supplier, 1);
    assert.equal(P('رقم بلا صفر').phone, '0551112222');
    const bal = (await t.admin.get('/parties/' + P('بقالة البوادي').id)).body;
    assert.equal(bal.ar_balance, 1200);
    // أخطاء واضحة: مندوب غير موجود ورقم ضريبي خاطئ وتكرار
    const bad = new ExcelJS.Workbook(); const ws = bad.addWorksheet('x');
    ws.addRow(['الاسم', 'المندوب', 'الرقم الضريبي']); ws.addRow(['ع1', 'مجهول', '']); ws.addRow(['ع2', '', '123']); ws.addRow(['بقالة البوادي', '', '']);
    const pv2 = await t.admin.post('/import/preview', { kind: 'parties', filename: 'b.xlsx', data: Buffer.from(await bad.xlsx.writeBuffer()).toString('base64') });
    assert.equal(pv2.body.invalid, 2, JSON.stringify(pv2.body.rows.map((r) => r._errors)));
    // خيار «كل المناديب» من شاشة الاستيراد للصفوف بلا مندوب
    const g = new ExcelJS.Workbook(); const gs = g.addWorksheet('x');
    gs.addRow(['الاسم', 'المندوب']); gs.addRow(['عميل للجميع', '']); gs.addRow(['عميل لأحمد', 'أحمد']);
    const gd = Buffer.from(await g.xlsx.writeBuffer()).toString('base64');
    const gc = await t.admin.post('/import/commit', { kind: 'parties', filename: 'g.xlsx', data: gd, default_rep: 'all' });
    assert.equal(gc.body.imported, 2, JSON.stringify(gc.body));
    assert.equal(P('عميل للجميع').all_reps, 1);
    assert.equal(P('عميل لأحمد').rep_id, rep.id, 'عمود الملف أولى');
  } finally { await t.close(); }
});

test('رقم العميل: تلقائي متسلسل، قابل للتعديل دون تكرار، والبحث به', async () => {
  const t = await boot();
  try {
    const a = (await t.admin.post('/parties', { name: 'عميل أ', is_customer: 1 })).body;
    const b = (await t.admin.post('/parties', { name: 'عميل ب', is_customer: 1 })).body;
    assert.match(a.code, /^A\d+$/);
    assert.equal(Number(b.code.slice(1)), Number(a.code.slice(1)) + 1);
    const dup = await t.admin.put('/parties/' + b.id, { code: a.code });
    assert.equal(dup.status, 409);
    assert.equal((await t.admin.put('/parties/' + b.id, { code: 'VIP1' })).body.code, 'VIP1');
    const found = (await t.admin.get('/parties?q=' + a.code)).body.rows;
    assert.deepEqual(found.map((p) => p.id), [a.id]);
    const c = (await t.admin.post('/parties', { name: 'عميل ج', is_customer: 1 })).body;
    assert.equal(c.code, 'A' + (Number(a.code.slice(1)) + 1), 'التالي بعد أكبر رقم A');
    assert.equal(t.db.prepare('SELECT COUNT(*) n FROM parties WHERE code IS NULL').get().n, 0);
  } finally { await t.close(); }
});

test('مخزون افتتاحي بلا تكلفة ثم تحديثها: الباقي في كل المستودعات، تكلفة الفواتير والمرتجعات، والقيد متوازن', async () => {
  const t = await boot();
  try {
    const item = (await t.admin.post('/items', { name: 'سيسي', base_unit: 'شد', track_expiry: 0, sell_price: 20 })).body;
    const rep = (await t.admin.post('/reps', { name: 'م' })).body;
    // استيراد بتكلفة فارغة
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('x');
    ws.addRow(['كود الصنف', 'الكمية بوحدة الأساس', 'تكلفة الوحدة']); ws.addRow([item.code, 100, '']);
    const data = Buffer.from(await wb.xlsx.writeBuffer()).toString('base64');
    const pv = await t.admin.post('/import/preview', { kind: 'stock', filename: 's.xlsx', data });
    assert.equal(pv.body.invalid, 0, JSON.stringify(pv.body.rows));
    const cm = await t.admin.post('/import/commit', { kind: 'stock', filename: 's.xlsx', data, warehouse_id: 1, date: '2026-10-02' });
    assert.equal(cm.status, 200, JSON.stringify(cm.body));
    const os = t.db.prepare("SELECT * FROM docs WHERE type='opening_stock'").get();
    assert.equal(os.total, 0);
    // تحويل 30 للمندوب، بيع 20 من الرئيسي و5 من المندوب، ثم مرتجع 4
    await t.admin.post('/transfers', { from_warehouse_id: 1, to_warehouse_id: rep.warehouse_id, lines: [{ item_id: item.id, qty: 30 }] });
    const s1 = (await t.admin.post('/sales', { warehouse_id: 1, lines: [{ item_id: item.id, qty: 20 }], payments: [{ cash_account_id: 1, amount: 400 }] })).body;
    const s2 = (await t.admin.post('/sales', { warehouse_id: rep.warehouse_id, lines: [{ item_id: item.id, qty: 5 }], payments: [{ cash_account_id: 1, amount: 100 }] })).body;
    assert.equal(t.db.prepare('SELECT cost FROM docs WHERE id=?').get(s1.id).cost, 0);
    const ret = await t.admin.post('/sale-returns', { sale_id: s1.id, reason: 'تجربة', refund: { cash_account_id: 1 }, lines: [{ line_id: s1.lines[0].id, qty: 4, condition: 'ok' }] });
    assert.equal(ret.status, 200, JSON.stringify(ret.body));
    // تحديث التكلفة إلى 12 للشد
    const line = t.db.prepare('SELECT id FROM doc_lines WHERE doc_id=?').get(os.id);
    const up = await t.admin.post(`/opening-stock/${os.id}/cost`, { lines: [{ line_id: line.id, unit_cost: 12 }] });
    assert.equal(up.status, 200, JSON.stringify(up.body));
    assert.equal(up.body.total, 1200);
    assert.equal(up.body.adjustment.delta, 1200);
    const batchVal = t.db.prepare('SELECT SUM(cost) c, SUM(qty) q FROM batches WHERE item_id=?').get(item.id);
    assert.equal(batchVal.q / 1000, 79, 'الباقي 100-20-5+4');
    assert.equal(batchVal.c / 100, 79 * 12);
    assert.equal(t.db.prepare('SELECT cost FROM docs WHERE id=?').get(s1.id).cost / 100, 240);
    assert.equal(t.db.prepare('SELECT cost FROM docs WHERE id=?').get(s2.id).cost / 100, 60);
    assert.equal(t.db.prepare('SELECT cost FROM docs WHERE id=?').get(ret.body.id).cost / 100, 48);
    const bal = (acc) => t.db.prepare('SELECT COALESCE(SUM(debit-credit),0) b FROM journal_lines WHERE account=?').get(acc).b / 100;
    assert.equal(bal('INVENTORY'), 79 * 12, 'المخزون في الدفاتر = قيمة الدفعات');
    assert.equal(bal('COGS'), 240 + 60 - 48, 'تكلفة المبيعات = الفواتير - المرتجع');
    assert.equal(bal('OPENING_EQUITY'), -1200);
    const tb = t.db.prepare('SELECT SUM(debit) d, SUM(credit) c FROM journal_lines').get();
    assert.equal(tb.d, tb.c);
    assert.equal(t.db.prepare('SELECT purchase_price FROM item_units WHERE item_id=? AND is_base=1').get(item.id).purchase_price, 1200);
    // لا تغيير = خطأ واضح
    assert.equal((await t.admin.post(`/opening-stock/${os.id}/cost`, { lines: [{ line_id: line.id, unit_cost: 12 }] })).status, 400);
  } finally { await t.close(); }
});
