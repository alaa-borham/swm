'use strict';
const { permissionsFor, PERMISSIONS } = require('./permissions');
const { AppError, fail } = require('../lib/errors');
const { todayIn, nowIso } = require('../lib/dates');

/**
 * سياق تنفيذ العملية: المستخدم وصلاحياته وقاعدة البيانات.
 * كل خدمة تستقبل ctx وتفحص الصلاحية في الخادم قبل أي تغيير.
 */
class Ctx {
  constructor(db, user, opts = {}) {
    this.db = db;
    this.user = user || null;
    this.ip = opts.ip || null;
    this._today = opts.today || null;
    this._perms = user ? permissionsFor(user.roles) : new Set();
    this._settings = null;
    this.denied = [];
  }

  static system(db, opts = {}) {
    return new Ctx(db, { id: null, username: 'system', full_name: 'النظام', roles: ['admin'] }, opts);
  }

  get userId() { return this.user ? this.user.id : null; }

  has(perm) {
    if (!PERMISSIONS[perm]) throw new Error('unknown permission ' + perm);
    return this._perms.has(perm);
  }

  require(perm, action) {
    if (!this.has(perm)) {
      this.deny(action || perm, perm);
      fail('FORBIDDEN', `ليست لديك صلاحية: ${PERMISSIONS[perm]}`, 403, { permission: perm });
    }
  }

  requireAny(perms, action) {
    if (!perms.some((p) => this.has(p))) {
      this.deny(action || perms.join('|'), perms.join('|'));
      fail('FORBIDDEN', `ليست لديك صلاحية: ${PERMISSIONS[perms[0]]}`, 403, { permission: perms });
    }
  }

  /** تسجيل محاولة مرفوضة: داخل معاملة تُؤجل حتى بعد التراجع، وخارجها تُكتب مباشرة */
  deny(action, perm) {
    this.denied.push({ action, perm });
    if (!this.db.inTransaction) this.flushDenied();
  }

  /** المستخدم المرتبط بفرع لا يتعامل إلا مع مستودعات وصناديق ومستندات فرعه */
  get branchScope() { return this.user && this.user.branch_id ? this.user.branch_id : null; }

  checkBranch(branchId) {
    if (this.branchScope && branchId && branchId !== this.branchScope) {
      this.deny('branch.scope', 'branch');
      fail('FORBIDDEN', 'العملية خارج فرعك', 403);
    }
  }

  /** المستخدم مندوب مقيد بنطاقه */
  get repScope() {
    if (!this.user || !this.user.rep_id) return null;
    return this.has('parties.all') ? null : this.user.rep_id;
  }

  settings() {
    if (!this._settings) {
      this._settings = {};
      for (const r of this.db.prepare('SELECT key,value FROM settings').all()) this._settings[r.key] = r.value;
    }
    return this._settings;
  }
  setting(key) { return this.settings()[key]; }
  settingInt(key) { const v = this.settings()[key]; return v === '' || v == null ? null : Number(v); }
  invalidateSettings() { this._settings = null; }

  today() { return this._today || todayIn(this.setting('timezone')); }
  now() { return nowIso(); }

  requireReason(reason, what = 'هذه العملية') {
    if (!reason || String(reason).trim().length < 3) fail('REASON_REQUIRED', `يجب كتابة سبب موثق لـ${what}`, 400);
    return String(reason).trim();
  }

  checkPeriod(date) {
    const locked = this.setting('locked_until');
    if (locked && date <= locked) fail('PERIOD_LOCKED', `الفترة المالية مقفلة حتى ${locked}؛ لا يمكن تسجيل أو تعديل مستند بتاريخ ${date}`, 409);
  }

  audit(action, { entity = null, entity_id = null, doc_number = null, reason = null, before = null, after = null, ok = 1 } = {}) {
    this.db.prepare(`INSERT INTO audit_log(ts,user_id,username,action,entity,entity_id,doc_number,reason,before_json,after_json,ok,ip)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      this.now(), this.userId, this.user ? this.user.username : null, action, entity, entity_id, doc_number, reason,
      before == null ? null : JSON.stringify(before), after == null ? null : JSON.stringify(after), ok ? 1 : 0, this.ip);
  }

  /** تنفيذ ذري: كل ما بداخله يُعتمد معًا أو يُلغى بالكامل. */
  tx(fn) {
    try {
      return this.db.transaction(fn).immediate();
    } catch (e) {
      if (!this.db.inTransaction) this.flushDenied(e);
      throw e;
    }
  }

  flushDenied(e) {
    if (!this.denied.length) return;
    const list = this.denied.splice(0);
    for (const d of list) {
      try { this.audit('denied:' + d.action, { reason: `رفض الصلاحية ${d.perm}`, ok: 0, after: e && e.details ? e.details : null }); } catch (_) { /* ignore */ }
    }
  }
}

function ensure(cond, code, message, status = 400, details) {
  if (!cond) throw new AppError(code, message, status, details);
}

module.exports = { Ctx, ensure };
