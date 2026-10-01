'use strict';
// واتساب: القوالب والموافقة والأرقام والتذكيرات وحالات التسليم (بنقل وهمي بدل Meta).
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { setup } = require('./helpers');
const WA = require('../src/core/whatsapp');
const M = require('../src/core/masters');
const Sales = require('../src/core/sales');
const Pay = require('../src/core/payments');

function configure(e) {
  process.env.WHATSAPP_TOKEN = 'test-token';
  for (const [k, v] of [['whatsapp_enabled', '1'], ['whatsapp_phone_number_id', '123456'], ['whatsapp_country_code', '966']]) e.db.prepare('UPDATE settings SET value=? WHERE key=?').run(v, k);
  e.admin.invalidateSettings();
}

test('تحويل أرقام الجوال للصيغة الدولية', () => {
  assert.equal(WA.normalizePhone('0501234567', '966'), '966501234567');
  assert.equal(WA.normalizePhone('+966 50 123 4567', '966'), '966501234567');
  assert.equal(WA.normalizePhone('00201001234567', '966'), '201001234567');
  assert.equal(WA.normalizePhone('٠٥٠١٢٣٤٥٦٧', '966'), '966501234567');
  assert.equal(WA.normalizePhone('123', '966'), null);
});

test('إرسال الفاتورة وسند القبض بقوالب معتمدة وللعميل الموافق فقط', async () => {
  const e = setup();
  const sent = [];
  WA.setTransport(async (r) => { sent.push(r); return { id: 'wamid.' + sent.length }; });
  try {
    const item = e.item({ price: 100 });
    e.stock(item, 10, 50);
    const c = M.createParty(e.admin, { name: 'بقالة النور', phone: '0501234567', is_customer: 1 });
    const sale = Sales.createSale(e.admin, { party_id: c.id, lines: [{ item_id: item.id, qty: 3 }], payments: [{ cash_account_id: 1, amount: 100 }] });
    await assert.rejects(WA.sendForDoc(e.admin, sale.id), (err) => err.code === 'WHATSAPP_NOT_READY');
    configure(e);
    await assert.rejects(WA.sendForDoc(e.admin, sale.id), (err) => err.code === 'NO_OPT_IN');
    M.updateParty(e.admin, c.id, { whatsapp_opt_in: 1 });
    const r = await WA.sendForDoc(e.admin, sale.id);
    assert.equal(r.status, 'sent');
    const p = sent[0];
    assert.equal(p.url, 'https://graph.facebook.com/v21.0/123456/messages');
    assert.equal(p.token, 'test-token');
    assert.equal(p.payload.to, '966501234567');
    assert.equal(p.payload.template.name, 'invoice_notice');
    assert.equal(p.payload.template.language.code, 'ar');
    assert.deepEqual(p.payload.template.components[0].parameters.map((x) => x.text), ['بقالة النور', sale.number, sale.date, '300.00', '200.00']);
    const rc = Pay.createReceipt(e.admin, { party_id: c.id, cash_account_id: 1, amount: 50, allocations: 'auto' });
    await WA.sendForDoc(e.admin, rc.id);
    assert.deepEqual(sent[1].payload.template.components[0].parameters.map((x) => x.text), ['بقالة النور', '50.00', rc.number, '150.00']);
    const log = WA.listMessages(e.admin, { party_id: c.id });
    assert.equal(log.length, 2);
    assert.equal(log[1].provider_id, 'wamid.1');
    WA.setTransport(async () => { throw new Error('(#131030) Recipient phone number not in allowed list'); });
    await assert.rejects(WA.sendForDoc(e.admin, sale.id), (err) => err.code === 'WHATSAPP_FAILED');
    assert.equal(WA.listMessages(e.admin, {})[0].status, 'failed');
  } finally { WA.setTransport(null); delete process.env.WHATSAPP_TOKEN; }
});

test('تذكير المتأخرين: مرة واحدة يوميًا ويتخطى غير الموافقين', async () => {
  const e = setup();
  configure(e);
  const sent = [];
  WA.setTransport(async (r) => { sent.push(r); return { id: 'wamid.r' + sent.length }; });
  try {
    const item = e.item({ price: 100 });
    e.stock(item, 10, 50);
    const a = M.createParty(e.admin, { name: 'عميل أ', phone: '0501111111', is_customer: 1, whatsapp_opt_in: 1, payment_terms_days: 0 });
    const b = M.createParty(e.admin, { name: 'عميل ب', phone: '0502222222', is_customer: 1, payment_terms_days: 0 });
    Sales.createSale(e.admin, { date: '2026-09-01', party_id: a.id, lines: [{ item_id: item.id, qty: 2 }] });
    Sales.createSale(e.admin, { date: '2026-09-01', party_id: b.id, lines: [{ item_id: item.id, qty: 1 }] });
    const r1 = await WA.remindOverdue(e.admin, {});
    assert.equal(r1.sent, 1);
    assert.equal(r1.skipped.length, 1);
    assert.deepEqual(sent[0].payload.template.components[0].parameters.map((x) => x.text), ['عميل أ', '200.00', '2026-09-01']);
    const r2 = await WA.remindOverdue(e.admin, {});
    assert.equal(r2.sent, 0, 'لا يتكرر التذكير في نفس اليوم');
    const cashier = e.makeUser('cashier7', ['cashier']);
    await assert.rejects(WA.remindOverdue(cashier, {}), (err) => err.status === 403);
  } finally { WA.setTransport(null); delete process.env.WHATSAPP_TOKEN; }
});

test('Webhook: تحقق التوقيع وتحديث حالة التسليم', async () => {
  const { openDb } = require('../src/db');
  const { createApp } = require('../src/server');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-'));
  const db = openDb(path.join(dir, 'data.db'));
  db.prepare("INSERT INTO messages(created_at,kind,phone,template,status,provider_id) VALUES('x','invoice','966500000000','invoice_notice','sent','wamid.X')").run();
  db.prepare("UPDATE settings SET value='verify-me' WHERE key='whatsapp_verify_token'").run();
  process.env.WHATSAPP_APP_SECRET = 'app-secret';
  const app = createApp({ db, dataDir: dir, logger: { error() {}, log() {} } });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}/webhooks/whatsapp`;
  try {
    const v = await fetch(base + '?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=42');
    assert.equal(await v.text(), '42');
    assert.equal((await fetch(base + '?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1')).status, 403);
    const body = JSON.stringify({ entry: [{ changes: [{ value: { statuses: [{ id: 'wamid.X', status: 'delivered' }] } }] }] });
    assert.equal((await fetch(base, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=bad' }, body })).status, 403);
    const sig = 'sha256=' + crypto.createHmac('sha256', 'app-secret').update(body).digest('hex');
    assert.equal((await fetch(base, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig }, body })).status, 200);
    assert.equal(db.prepare("SELECT status FROM messages WHERE provider_id='wamid.X'").get().status, 'delivered');
  } finally { delete process.env.WHATSAPP_APP_SECRET; await new Promise((r) => server.close(r)); }
});
