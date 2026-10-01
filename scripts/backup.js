'use strict';
// نسخة احتياطية يدوية: npm run backup
const { openDb } = require('../src/db');
const Backup = require('../src/core/backup');
const { dbFile, backupDir, uploadsDir } = require('./common');
const db = openDb(dbFile);
const retention = Number((db.prepare("SELECT value FROM settings WHERE key='backup_retention'").get() || {}).value || 30);
const r = Backup.createBackup(db, { backupDir, uploadsDir, retention, label: 'manual' });
console.log('تم إنشاء النسخة:', r.name);
console.log(JSON.stringify(r.counts));
