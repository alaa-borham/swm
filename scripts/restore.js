'use strict';
// الاستعادة (أوقف الخادم أولاً): npm run restore -- <اسم النسخة>
const Backup = require('../src/core/backup');
const { dbFile, backupDir, uploadsDir } = require('./common');
const name = process.argv[2];
if (!name) {
  console.log('النسخ المتاحة:');
  for (const b of Backup.listBackups(backupDir)) console.log(' ', b.name, b.created_at, `مستندات: ${b.counts.docs}`);
  console.log('\nالاستخدام: npm run restore -- <اسم النسخة>');
  process.exit(1);
}
try {
  const r = Backup.restoreBackup(backupDir, name, dbFile, uploadsDir);
  console.log(`✓ تمت الاستعادة من ${name}. حُفظت القاعدة السابقة بجانبها باسم *.before-restore-*`);
  console.log(JSON.stringify(r.counts));
} catch (e) {
  console.error('✗ فشلت الاستعادة:', e.message);
  process.exit(2);
}
