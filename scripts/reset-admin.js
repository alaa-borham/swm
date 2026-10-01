'use strict';
// إعادة تعيين كلمة مرور المدير من الخادم: npm run reset-admin -- <كلمة مرور جديدة>
const { openDb } = require('../src/db');
const users = require('../src/core/users');
const { dbFile } = require('./common');
const pw = process.argv[2];
if (!pw || pw.length < 8) { console.error('حدد كلمة مرور من 8 أحرف على الأقل'); process.exit(1); }
const db = openDb(dbFile);
const u = db.prepare("SELECT id FROM users WHERE username='admin'").get();
if (!u) { users.ensureAdmin(db, pw); console.log('أُنشئ المستخدم admin'); process.exit(0); }
db.prepare('UPDATE users SET password_hash=?, active=1, must_change_password=1 WHERE id=?').run(users.hashPassword(pw), u.id);
db.prepare('DELETE FROM sessions WHERE user_id=?').run(u.id);
db.prepare('DELETE FROM login_attempts WHERE username=?').run('admin');
db.prepare("INSERT INTO audit_log(ts,username,action,reason,ok) VALUES(?,?,?,?,1)").run(new Date().toISOString(), 'system', 'user.reset_admin', 'إعادة تعيين من الخادم');
console.log('تم تعيين كلمة مرور admin؛ يجب تغييرها بعد الدخول');
