'use strict';
// إرسال رسائل واتساب للعملاء عبر Meta WhatsApp Cloud API باستخدام قوالب معتمدة من Meta.
// الرسائل التي تبدأها المؤسسة يجب أن تكون بقوالب معتمدة، وللعملاء الذين وافقوا على الاستلام فقط.
// رمز الوصول (WHATSAPP_TOKEN) وسر التطبيق (WHATSAPP_APP_SECRET) يُقرآن من متغيرات البيئة ولا يُحفظان في القاعدة.
const crypto = require('crypto');
const { fail } = require('../lib/errors');
const { fromMinor, getMoneyDecimals } = require('../lib/money');
const D = require('./docs');

const KINDS = {
  invoice: { label: 'إرسال فاتورة', setting: 'whatsapp_template_invoice' },
  receipt: { label: 'إشعار سداد', setting: 'whatsapp_template_receipt' },
  reminder: { label: 'تذكير بالمستحقات', setting: 'whatsapp_template_reminder' },
};

// ---------- النقل (قابل للاستبدال في الاختبارات) ----------
async function graphTransport({ url, token, payload }) {
  const res = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(15000) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error((body.error && (body.error.error_user_msg || body.error.message)) || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return { id: body.messages && body.messages[0] ? body.messages[0].id : null };
}
let transport = graphTransport;
function setTransport(fn) { transport = fn || graphTransport; }

// ---------- الإعداد ----------
function config(ctx) {
  const s = ctx.settings();
  return {
    enabled: s.whatsapp_enabled === '1', phoneNumberId: s.whatsapp_phone_number_id || '', version: s.whatsapp_api_version || 'v21.0',
    lang: s.whatsapp_lang || 'ar', cc: (s.whatsapp_country_code || '').replace(/\D/g, ''), token: process.env.WHATSAPP_TOKEN || '',
  };
}

function status(ctx) {
  const c = config(ctx);
  const missing = [];
  if (!c.enabled) missing.push('التفعيل من الإعدادات');
  if (!c.phoneNumberId) missing.push('معرف رقم الهاتف (Phone number ID)');
  if (!c.token) missing.push('متغير البيئة WHATSAPP_TOKEN على الخادم');
  return { ready: missing.length === 0, enabled: c.enabled, token_configured: !!c.token, app_secret_configured: !!process.env.WHATSAPP_APP_SECRET, missing };
}

function requireReady(ctx) {
  const st = status(ctx);
  if (!st.ready) fail('WHATSAPP_NOT_READY', 'واتساب غير مهيأ: ' + st.missing.join('، '), 409);
  return config(ctx);
}

/** تحويل رقم محلي إلى الصيغة الدولية بأرقام فقط (مثل 9665xxxxxxxx) */
function normalizePhone(raw, cc) {
  let p = String(raw || '').replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x660)).replace(/[^\d+]/g, '');
  if (p.startsWith('+')) p = p.slice(1);
  else if (p.startsWith('00')) p = p.slice(2);
  else if (p.startsWith('0') && cc) p = cc + p.replace(/^0+/, '');
  else if (cc && p.length <= 10 && !p.startsWith(cc)) p = cc + p;
  if (!/^\d{8,15}$/.test(p)) return null;
  return p;
}

const money = (v) => fromMinor(v).toFixed(getMoneyDecimals());

/** فحص قابلية الإرسال لعميل: موافقة ورقم صحيح */
function checkParty(ctx, party, cc) {
  if (!party) fail('VALIDATION', 'المستند بلا عميل محدد');
  if (!party.whatsapp_opt_in) fail('NO_OPT_IN', `العميل ${party.name} لم يوافق على استلام رسائل واتساب (فعّل الموافقة في بطاقة العميل)`, 409);
  const phone = normalizePhone(party.phone, cc);
  if (!phone) fail('INVALID_PHONE', `رقم جوال العميل ${party.name} غير صحيح`, 400);
  return phone;
}

function partyBalance(ctx, partyId) {
  return ctx.db.prepare("SELECT COALESCE(SUM(debit-credit),0) b FROM journal_lines WHERE account='AR' AND party_id=?").get(partyId).b;
}

/** معاملات القالب لكل نوع بالترتيب المتفق عليه مع نص القالب في Meta */
function paramsFor(ctx, kind, { party, doc, overdue }) {
  if (kind === 'invoice') {
    return [party.name, doc.number, doc.date, money(doc.total), money(D.openAmount(ctx, doc.id))];
  }
  if (kind === 'receipt') {
    return [party.name, money(doc.total), doc.number, money(partyBalance(ctx, party.id))];
  }
  if (kind === 'reminder') {
    return [party.name, money(overdue.amount), overdue.oldest_due];
  }
  fail('VALIDATION', 'نوع الرسالة غير معروف');
}

async function deliver(ctx, { kind, party, doc, params, cfg, phone }) {
  const template = ctx.setting(KINDS[kind].setting);
  if (!template) fail('VALIDATION', `حدد اسم قالب ${KINDS[kind].label} في الإعدادات`);
  const id = ctx.db.prepare(`INSERT INTO messages(created_at,kind,party_id,doc_id,phone,template,params,status,user_id) VALUES(?,?,?,?,?,?,?,'queued',?)`)
    .run(ctx.now(), kind, party.id, doc ? doc.id : null, phone, template, JSON.stringify(params), ctx.userId).lastInsertRowid;
  const payload = {
    messaging_product: 'whatsapp', recipient_type: 'individual', to: phone, type: 'template',
    template: { name: template, language: { code: cfg.lang }, components: [{ type: 'body', parameters: params.map((t) => ({ type: 'text', text: String(t) })) }] },
  };
  try {
    const r = await transport({ url: `https://graph.facebook.com/${cfg.version}/${cfg.phoneNumberId}/messages`, token: cfg.token, payload });
    ctx.db.prepare("UPDATE messages SET status='sent', provider_id=?, updated_at=? WHERE id=?").run(r.id || null, ctx.now(), id);
    ctx.audit('whatsapp.send', { entity: 'message', entity_id: id, doc_number: doc ? doc.number : null, after: { kind, party: party.name, phone: mask(phone) } });
    return { id, status: 'sent', provider_id: r.id || null };
  } catch (e) {
    const msg = String(e.message || e).slice(0, 300);
    ctx.db.prepare("UPDATE messages SET status='failed', error=?, updated_at=? WHERE id=?").run(msg, ctx.now(), id);
    ctx.audit('whatsapp.failed', { entity: 'message', entity_id: id, doc_number: doc ? doc.number : null, ok: 0, reason: msg });
    return { id, status: 'failed', error: msg };
  }
}

const mask = (p) => p.slice(0, 4) + '****' + p.slice(-3);

/** إرسال رسالة مرتبطة بمستند: فاتورة بيع أو سند قبض */
async function sendForDoc(ctx, docId) {
  ctx.require('messages.send');
  const cfg = requireReady(ctx);
  const doc = D.loadDoc(ctx, docId);
  if (doc.status !== 'approved') fail('INVALID_STATE', 'يُرسل المستند المعتمد فقط');
  if (ctx.repScope && doc.rep_id !== ctx.repScope) fail('FORBIDDEN', 'المستند خارج نطاقك', 403);
  ctx.checkBranch(doc.branch_id);
  const kind = doc.type === 'sale' ? 'invoice' : doc.type === 'receipt' && doc.ledger_account === 'AR' ? 'receipt' : null;
  if (!kind) fail('VALIDATION', 'الإرسال متاح لفواتير البيع وسندات القبض من العملاء');
  const party = doc.party_id ? ctx.db.prepare('SELECT * FROM parties WHERE id=?').get(doc.party_id) : null;
  const phone = checkParty(ctx, party, cfg.cc);
  const r = await deliver(ctx, { kind, party, doc, params: paramsFor(ctx, kind, { party, doc }), cfg, phone });
  if (r.status === 'failed') fail('WHATSAPP_FAILED', 'تعذر الإرسال: ' + r.error, 502, r);
  return r;
}

/** العملاء المتأخرون: فواتير مستحقة ومتبقية حتى اليوم */
function overdueParties(ctx, partyIds) {
  const today = ctx.today();
  const docs = ctx.db.prepare(`SELECT d.id, d.party_id, COALESCE(d.due_date, d.date) due FROM docs d JOIN parties p ON p.id=d.party_id
    WHERE d.status='approved' AND d.ledger_account='AR' AND d.ledger_side='D' AND COALESCE(d.due_date, d.date) < ?
      ${ctx.repScope ? 'AND p.rep_id=' + Number(ctx.repScope) : ''} ${ctx.branchScope ? 'AND d.branch_id=' + Number(ctx.branchScope) : ''}`).all(today);
  const map = new Map();
  for (const d of docs) {
    if (partyIds && partyIds.length && !partyIds.includes(d.party_id)) continue;
    const open = D.openAmount(ctx, d.id);
    if (open <= 0) continue;
    const r = map.get(d.party_id) || { party_id: d.party_id, amount: 0, oldest_due: d.due, invoices: 0 };
    r.amount += open; r.invoices += 1;
    if (d.due < r.oldest_due) r.oldest_due = d.due;
    map.set(d.party_id, r);
  }
  return [...map.values()];
}

/** تذكير المتأخرين؛ يتخطى من لم يوافق أو رقمه غير صحيح أو أُرسل له تذكير اليوم */
async function remindOverdue(ctx, { party_ids } = {}) {
  ctx.require('messages.bulk');
  const cfg = requireReady(ctx);
  const list = overdueParties(ctx, (party_ids || []).map(Number));
  const out = { sent: 0, failed: 0, skipped: [] };
  const since = new Date(Date.now() - 20 * 3600 * 1000).toISOString();
  for (const o of list) {
    const party = ctx.db.prepare('SELECT * FROM parties WHERE id=?').get(o.party_id);
    let phone;
    try { phone = checkParty(ctx, party, cfg.cc); } catch (e) { out.skipped.push({ party: party.name, reason: e.message }); continue; }
    const already = ctx.db.prepare("SELECT 1 FROM messages WHERE party_id=? AND kind='reminder' AND status<>'failed' AND created_at>=?").get(party.id, since);
    if (already) { out.skipped.push({ party: party.name, reason: 'أُرسل له تذكير خلال آخر 20 ساعة' }); continue; }
    const r = await deliver(ctx, { kind: 'reminder', party, params: paramsFor(ctx, 'reminder', { party, overdue: o }), cfg, phone });
    if (r.status === 'sent') out.sent++; else { out.failed++; out.skipped.push({ party: party.name, reason: r.error }); }
  }
  out.total = list.length;
  ctx.audit('whatsapp.reminders', { entity: 'message', after: { sent: out.sent, failed: out.failed, skipped: out.skipped.length } });
  return out;
}

/** إرسال تلقائي بعد اعتماد البيع أو القبض (لا يُعطل العملية إن فشل) */
function autoNotify(ctx, doc) {
  try {
    const s = ctx.settings();
    const kind = doc.type === 'sale' ? 'invoice' : doc.type === 'receipt' && doc.ledger_account === 'AR' ? 'receipt' : null;
    if (!kind || !doc.party_id || s.whatsapp_enabled !== '1') return;
    if ((kind === 'invoice' && s.whatsapp_auto_invoice !== '1') || (kind === 'receipt' && s.whatsapp_auto_receipt !== '1')) return;
    if (!status(ctx).ready) return;
    const party = ctx.db.prepare('SELECT * FROM parties WHERE id=?').get(doc.party_id);
    if (!party || !party.whatsapp_opt_in || !normalizePhone(party.phone, config(ctx).cc)) return;
    const cfg = config(ctx);
    const full = D.getDocRow(ctx, doc.id);
    deliver(ctx, { kind, party, doc: full, params: paramsFor(ctx, kind, { party, doc: full }), cfg, phone: normalizePhone(party.phone, cfg.cc) }).catch(() => null);
  } catch (_) { /* الإشعار لا يؤثر في العملية */ }
}

// ---------- Webhook: حالات التسليم ----------
function verifySignature(rawBody, header, secret) {
  if (!secret) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(String(header || '')), b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const STATUS_ORDER = { queued: 0, sent: 1, delivered: 2, read: 3, failed: 4 };
function applyStatuses(db, body) {
  let n = 0;
  for (const entry of (body && body.entry) || []) {
    for (const ch of entry.changes || []) {
      for (const st of (ch.value && ch.value.statuses) || []) {
        const row = db.prepare('SELECT * FROM messages WHERE provider_id=?').get(st.id);
        if (!row || !STATUS_ORDER[st.status]) continue;
        if (st.status !== 'failed' && STATUS_ORDER[st.status] <= STATUS_ORDER[row.status]) continue;
        const err = st.status === 'failed' && st.errors && st.errors[0] ? String(st.errors[0].title || st.errors[0].message || '').slice(0, 300) : null;
        db.prepare('UPDATE messages SET status=?, error=COALESCE(?, error), updated_at=? WHERE id=?').run(st.status, err, new Date().toISOString(), row.id);
        n++;
      }
    }
  }
  return n;
}

function listMessages(ctx, { party_id, doc_id, status: st, limit = 200 } = {}) {
  if (!(doc_id && ctx.has('messages.send'))) ctx.require('messages.view');
  const w = ['1=1'], p = [];
  if (party_id) { w.push('m.party_id=?'); p.push(Number(party_id)); }
  if (doc_id) { w.push('m.doc_id=?'); p.push(Number(doc_id)); }
  if (st) { w.push('m.status=?'); p.push(st); }
  return ctx.db.prepare(`SELECT m.*, p.name party_name, d.number doc_number, u.full_name user_name FROM messages m LEFT JOIN parties p ON p.id=m.party_id
    LEFT JOIN docs d ON d.id=m.doc_id LEFT JOIN users u ON u.id=m.user_id WHERE ${w.join(' AND ')} ORDER BY m.id DESC LIMIT ?`).all(...p, Math.min(Number(limit) || 200, 1000))
    .map((m) => ({ ...m, kind_label: KINDS[m.kind] ? KINDS[m.kind].label : m.kind, params: m.params ? JSON.parse(m.params) : [] }));
}

/** رسالة اختبار بقالب hello_world الافتراضي في حساب Meta */
async function sendTest(ctx, { phone }) {
  ctx.require('settings.manage');
  const cfg = requireReady(ctx);
  const to = normalizePhone(phone, cfg.cc);
  if (!to) fail('INVALID_PHONE', 'رقم غير صحيح');
  try {
    const r = await transport({ url: `https://graph.facebook.com/${cfg.version}/${cfg.phoneNumberId}/messages`, token: cfg.token,
      payload: { messaging_product: 'whatsapp', to, type: 'template', template: { name: 'hello_world', language: { code: 'en_US' } } } });
    ctx.audit('whatsapp.test', { entity: 'message', after: { phone: mask(to) } });
    return { ok: true, provider_id: r.id };
  } catch (e) { fail('WHATSAPP_FAILED', 'فشل الإرسال: ' + e.message, 502); }
}

module.exports = {
  KINDS, setTransport, status, normalizePhone, sendForDoc, remindOverdue, overdueParties, autoNotify, verifySignature, applyStatuses, listMessages, sendTest, paramsFor,
};
