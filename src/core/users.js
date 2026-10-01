'use strict';
// المستخدمون، كلمات المرور (scrypt)، الجلسات، وتحديد محاولات الدخول.
const crypto = require('crypto');
const { fail, notFound } = require('../lib/errors');
const { ROLES } = require('./permissions');

const MAX_FAILS = 5;
const LOCK_MINUTES = 15;

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function verifyPassword(pw, stored) {
  const [alg, n, saltB, hashB] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const hash = Buffer.from(hashB, 'base64');
  const test = crypto.scryptSync(pw, Buffer.from(saltB, 'base64'), hash.length, { N: Number(n), r: 8, p: 1 });
  return crypto.timingSafeEqual(hash, test);
}

function checkPasswordPolicy(pw) {
  if (typeof pw !== 'string' || pw.length < 8) fail('WEAK_PASSWORD', 'كلمة المرور يجب ألا تقل عن 8 أحرف');
  if (!/\d/.test(pw) || !/\D/.test(pw)) fail('WEAK_PASSWORD', 'كلمة المرور يجب أن تحتوي على أرقام وحروف');
}

const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');

function publicUser(u) {
  if (!u) return null;
  let roles = u.roles;
  if (typeof roles === 'string') roles = JSON.parse(roles);
  return { id: u.id, username: u.username, full_name: u.full_name, roles, rep_id: u.rep_id, active: u.active, must_change_password: u.must_change_password, created_at: u.created_at };
}

function validRoles(roles) {
  if (!Array.isArray(roles) || !roles.length) fail('VALIDATION', 'حدد دورًا واحدًا على الأقل');
  for (const r of roles) if (!ROLES[r]) fail('VALIDATION', `دور غير معروف: ${r}`);
  return roles;
}

function createUser(ctx, { username, full_name, password, roles, rep_id }) {
  ctx.require('users.manage');
  return ctx.tx(() => {
    const un = String(username || '').trim();
    if (!/^[A-Za-z0-9_.\-؀-ۿ]{3,40}$/.test(un)) fail('VALIDATION', 'اسم المستخدم 3-40 حرفًا بلا مسافات');
    if (!full_name) fail('VALIDATION', 'الاسم الكامل مطلوب');
    checkPasswordPolicy(password);
    validRoles(roles);
    if (roles.includes('rep') && !rep_id) fail('VALIDATION', 'حدد المندوب المرتبط بالمستخدم');
    if (ctx.db.prepare('SELECT 1 FROM users WHERE username=?').get(un)) fail('DUPLICATE', 'اسم المستخدم مستخدم', 409);
    const id = ctx.db.prepare('INSERT INTO users(username,full_name,password_hash,roles,rep_id,must_change_password,created_at) VALUES(?,?,?,?,?,1,?)')
      .run(un, full_name, hashPassword(password), JSON.stringify(roles), rep_id || null, ctx.now()).lastInsertRowid;
    ctx.audit('user.create', { entity: 'user', entity_id: id, after: { username: un, full_name, roles, rep_id } });
    return publicUser(ctx.db.prepare('SELECT * FROM users WHERE id=?').get(id));
  });
}

/** تعديل الدور يسري على الطلبات اللاحقة مباشرة لأن الصلاحيات تُقرأ من القاعدة مع كل طلب */
function updateUser(ctx, id, { full_name, roles, rep_id, active, password }) {
  ctx.require('users.manage');
  return ctx.tx(() => {
    const u = ctx.db.prepare('SELECT * FROM users WHERE id=?').get(id);
    if (!u) notFound('المستخدم');
    const before = publicUser(u);
    if (roles) validRoles(roles);
    if (u.id === ctx.userId && ((active !== undefined && !active) || (roles && !roles.includes('admin') && JSON.parse(u.roles).includes('admin')))) {
      fail('VALIDATION', 'لا يمكنك إيقاف حسابك أو إزالة دور المدير عن نفسك');
    }
    ctx.db.prepare('UPDATE users SET full_name=?, roles=?, rep_id=?, active=? WHERE id=?').run(
      full_name || u.full_name, roles ? JSON.stringify(roles) : u.roles, rep_id !== undefined ? rep_id || null : u.rep_id,
      active !== undefined ? (active ? 1 : 0) : u.active, id);
    if (password) {
      checkPasswordPolicy(password);
      ctx.db.prepare('UPDATE users SET password_hash=?, must_change_password=1 WHERE id=?').run(hashPassword(password), id);
    }
    if ((active !== undefined && !active) || password) ctx.db.prepare('DELETE FROM sessions WHERE user_id=?').run(id);
    const after = publicUser(ctx.db.prepare('SELECT * FROM users WHERE id=?').get(id));
    ctx.audit('user.update', { entity: 'user', entity_id: id, before, after: { ...after, password_changed: !!password } });
    return after;
  });
}

function listUsers(ctx) {
  ctx.require('users.manage');
  return ctx.db.prepare('SELECT u.*, r.name rep_name FROM users u LEFT JOIN reps r ON r.id=u.rep_id ORDER BY u.active DESC, u.username').all()
    .map((u) => ({ ...publicUser(u), rep_name: u.rep_name }));
}

function changeOwnPassword(ctx, { current, password }) {
  return ctx.tx(() => {
    const u = ctx.db.prepare('SELECT * FROM users WHERE id=?').get(ctx.userId);
    if (!u || !verifyPassword(String(current || ''), u.password_hash)) fail('INVALID_CREDENTIALS', 'كلمة المرور الحالية غير صحيحة', 400);
    checkPasswordPolicy(password);
    ctx.db.prepare('UPDATE users SET password_hash=?, must_change_password=0 WHERE id=?').run(hashPassword(password), u.id);
    ctx.audit('user.password', { entity: 'user', entity_id: u.id });
    return { ok: true };
  });
}

// ---------- الدخول والجلسات ----------
function login(db, { username, password, ip }, timeoutMinutes = 480) {
  const now = new Date();
  const since = new Date(now.getTime() - LOCK_MINUTES * 60000).toISOString();
  const un = String(username || '').trim();
  const fails = db.prepare('SELECT COUNT(*) n FROM login_attempts WHERE username=? AND ok=0 AND ts>? AND id>COALESCE((SELECT MAX(id) FROM login_attempts WHERE username=? AND ok=1),0)').get(un, since, un).n;
  if (fails >= MAX_FAILS) fail('LOCKED', `تم إيقاف الدخول مؤقتًا بعد ${MAX_FAILS} محاولات خاطئة؛ حاول بعد ${LOCK_MINUTES} دقيقة`, 429);
  const u = db.prepare('SELECT * FROM users WHERE username=?').get(un);
  const ok = !!(u && u.active && verifyPassword(String(password || ''), u.password_hash));
  db.prepare('INSERT INTO login_attempts(username,ip,ts,ok) VALUES(?,?,?,?)').run(un, ip || null, now.toISOString(), ok ? 1 : 0);
  db.prepare('INSERT INTO audit_log(ts,user_id,username,action,ok,ip) VALUES(?,?,?,?,?,?)').run(now.toISOString(), u ? u.id : null, un, ok ? 'login' : 'login.failed', ok ? 1 : 0, ip || null);
  if (!ok) fail('INVALID_CREDENTIALS', 'اسم المستخدم أو كلمة المرور غير صحيحة', 401);
  const token = crypto.randomBytes(32).toString('base64url');
  const exp = new Date(now.getTime() + timeoutMinutes * 60000).toISOString();
  db.prepare('INSERT INTO sessions(token_hash,user_id,created_at,last_seen,expires_at,ip) VALUES(?,?,?,?,?,?)').run(sha(token), u.id, now.toISOString(), now.toISOString(), exp, ip || null);
  db.prepare('DELETE FROM sessions WHERE expires_at<?').run(now.toISOString());
  return { token, user: publicUser(u), expires_at: exp };
}

/** التحقق من الجلسة مع انتهاء عند الخمول */
function authenticate(db, token, timeoutMinutes = 480) {
  if (!token) return null;
  const s = db.prepare('SELECT * FROM sessions WHERE token_hash=?').get(sha(token));
  if (!s) return null;
  const now = new Date();
  if (s.expires_at < now.toISOString()) { db.prepare('DELETE FROM sessions WHERE token_hash=?').run(s.token_hash); return null; }
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(s.user_id);
  if (!u || !u.active) return null;
  // تمديد عند النشاط (مرة كل دقيقة على الأكثر)
  if (now.getTime() - Date.parse(s.last_seen) > 60000) {
    db.prepare('UPDATE sessions SET last_seen=?, expires_at=? WHERE token_hash=?').run(now.toISOString(), new Date(now.getTime() + timeoutMinutes * 60000).toISOString(), s.token_hash);
  }
  const pu = publicUser(u);
  return pu;
}

function logout(db, token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(sha(token));
}

/** إنشاء المدير الأول إن لم يوجد مستخدمون */
function ensureAdmin(db, password) {
  if (db.prepare('SELECT 1 FROM users').get()) return null;
  const pw = password || crypto.randomBytes(9).toString('base64url') + '7a';
  db.prepare("INSERT INTO users(username,full_name,password_hash,roles,must_change_password,created_at) VALUES('admin','مدير النظام',?,'[\"admin\"]',1,?)")
    .run(hashPassword(pw), new Date().toISOString());
  return pw;
}

module.exports = { hashPassword, verifyPassword, createUser, updateUser, listUsers, changeOwnPassword, login, authenticate, logout, ensureAdmin, publicUser };
