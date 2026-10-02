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
    return { get: (u) => call('GET', u), post: (u, b, h) => call('POST', u, b, h), put: (u, b, h) => call('PUT', u, b, h) };
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
