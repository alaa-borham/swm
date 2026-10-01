'use strict';
// اختبار استرجاع نسخة في بيئة منفصلة: npm run verify-backup -- <اسم النسخة> (بدون اسم = أحدث نسخة)
const Backup = require('../src/core/backup');
const { backupDir } = require('./common');
const name = process.argv[2] || (Backup.listBackups(backupDir)[0] || {}).name;
if (!name) { console.error('لا توجد نسخ'); process.exit(1); }
const r = Backup.verifyBackup(backupDir, name);
console.log(r.ok ? `✓ النسخة ${name} سليمة ومطابقة` : `✗ النسخة ${name} غير مطابقة`);
console.log(JSON.stringify({ integrity: r.integrity, mismatches: r.mismatches, balanced: r.balanced, files: `${r.files}/${r.expected_files}` }, null, 2));
process.exit(r.ok ? 0 : 2);
