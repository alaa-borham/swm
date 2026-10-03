'use strict';
// تصفير بيانات التجربة قبل التشغيل الفعلي: يحذف المستندات وحركاتها (ومعها الأصناف والعملاء اختياريًا)
// ويبقي الإعدادات والمستخدمين والفروع والمستودعات والحسابات والمناديب. تُؤخذ نسخة احتياطية قبله.
const fs = require('fs');
const path = require('path');
const { fail } = require('../lib/errors');

const CONFIRM = 'تصفير';

function resetData(ctx, { confirm, items = true, parties = false, uploadsDir } = {}) {
  ctx.require('users.manage');
  ctx.require('backup.manage');
  if (String(confirm || '').trim() !== CONFIRM) fail('VALIDATION', `اكتب كلمة «${CONFIRM}» للتأكيد`);
  const db = ctx.db;
  const count = (t) => db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n;
  const before = { docs: count('docs'), items: count('items'), parties: count('parties') };
  const files = db.prepare('SELECT stored_name FROM attachments').all().map((r) => r.stored_name);
  // حذف بترتيب الاعتماديات مع إيقاف فحص المفاتيح مؤقتًا ثم التحقق بعده
  db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => {
      // القيود وحركات المخزون محمية من الحذف؛ تُرفع الحماية داخل نفس المعاملة فقط ثم تعود كما كانت
      const guards = db.prepare("SELECT name, sql FROM sqlite_master WHERE type='trigger' AND name IN ('jl_no_delete','sm_no_delete')").all();
      for (const g of guards) db.exec(`DROP TRIGGER ${g.name}`);
      for (const t of ['commission_items', 'attachments', 'messages', 'doc_shares', 'allocations', 'journal_lines', 'journal_entries',
        'stock_moves', 'batches', 'doc_lines', 'docs', 'cash_sessions', 'idempotency']) {
        if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t)) db.prepare(`DELETE FROM ${t}`).run();
      }
      db.prepare('UPDATE doc_sequences SET next=1').run();
      if (items) { db.prepare('DELETE FROM item_units').run(); db.prepare('DELETE FROM items').run(); }
      if (parties) db.prepare('DELETE FROM parties').run();
      for (const g of guards) db.exec(g.sql);
      const bad = db.pragma('foreign_key_check');
      if (bad.length) fail('INTEGRITY', 'تعذر التصفير: بيانات مرتبطة متبقية', 500, { rows: bad.slice(0, 5) });
    })();
  } finally {
    db.pragma('foreign_keys = ON');
  }
  for (const f of files) { try { fs.unlinkSync(path.join(uploadsDir, f)); } catch (_) { /* غير موجود */ } }
  ctx.audit('data.reset', { entity: 'system', before, after: { items_deleted: !!items, parties_deleted: !!parties } });
  return { ok: true, deleted: { docs: before.docs, items: items ? before.items : 0, parties: parties ? before.parties : 0 } };
}

module.exports = { resetData, CONFIRM };
