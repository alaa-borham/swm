'use strict';
// النسخ الاحتياطي: نسخة متسقة من القاعدة (VACUUM INTO) مع المرفقات، والاحتفاظ بآخر N نسخة، والتحقق في بيئة منفصلة.
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { fail } = require('../lib/errors');

const CHECK_TABLES = ['docs', 'doc_lines', 'journal_lines', 'stock_moves', 'batches', 'items', 'parties', 'allocations', 'attachments', 'users'];

function stamp() { return new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15); }

function createBackup(db, { backupDir, uploadsDir, retention = 30, label = 'auto' }) {
  fs.mkdirSync(backupDir, { recursive: true });
  const name = `backup-${stamp()}-${label}`;
  const dir = path.join(backupDir, name);
  fs.mkdirSync(dir);
  const dbFile = path.join(dir, 'data.db');
  db.prepare('VACUUM INTO ?').run(dbFile);
  let files = 0;
  if (uploadsDir && fs.existsSync(uploadsDir)) {
    const up = path.join(dir, 'uploads');
    fs.mkdirSync(up);
    for (const f of fs.readdirSync(uploadsDir)) { fs.copyFileSync(path.join(uploadsDir, f), path.join(up, f)); files++; }
  }
  const manifest = { name, created_at: new Date().toISOString(), counts: tableCounts(db), files };
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  prune(backupDir, retention);
  return manifest;
}

function tableCounts(db) {
  const c = {};
  for (const t of CHECK_TABLES) c[t] = db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n;
  const s = db.prepare('SELECT COALESCE(SUM(debit),0) d, COALESCE(SUM(credit),0) c FROM journal_lines').get();
  c.journal_debit = s.d; c.journal_credit = s.c;
  c.stock_qty = db.prepare('SELECT COALESCE(SUM(qty),0) q FROM batches').get().q;
  c.stock_cost = db.prepare('SELECT COALESCE(SUM(cost),0) q FROM batches').get().q;
  return c;
}

function prune(backupDir, retention) {
  const list = listBackups(backupDir);
  for (const b of list.slice(retention)) fs.rmSync(path.join(backupDir, b.name), { recursive: true, force: true });
}

function listBackups(backupDir) {
  if (!fs.existsSync(backupDir)) return [];
  return fs.readdirSync(backupDir).filter((n) => n.startsWith('backup-') && fs.existsSync(path.join(backupDir, n, 'manifest.json')))
    .map((n) => {
      const m = JSON.parse(fs.readFileSync(path.join(backupDir, n, 'manifest.json'), 'utf8'));
      const size = fs.statSync(path.join(backupDir, n, 'data.db')).size;
      return { ...m, size };
    }).sort((a, b) => (a.name < b.name ? 1 : -1));
}

function safeName(backupDir, name) {
  if (!/^backup-[\w-]+$/.test(name)) fail('VALIDATION', 'اسم النسخة غير صحيح');
  const dir = path.join(backupDir, name);
  if (!fs.existsSync(path.join(dir, 'data.db'))) fail('NOT_FOUND', 'النسخة غير موجودة', 404);
  return dir;
}

/**
 * اختبار الاسترجاع في بيئة منفصلة: نسخ ملف النسخة إلى مجلد مؤقت، فحص السلامة، ومطابقة الأعداد والأرصدة مع البيان.
 */
function verifyBackup(backupDir, name, tmpRoot) {
  const dir = safeName(backupDir, name);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  const tmp = fs.mkdtempSync(path.join(tmpRoot || require('os').tmpdir(), 'restore-test-'));
  try {
    const f = path.join(tmp, 'data.db');
    fs.copyFileSync(path.join(dir, 'data.db'), f);
    const db = new Database(f);
    const integrity = db.prepare('PRAGMA integrity_check').get().integrity_check;
    const counts = tableCounts(db);
    db.close();
    const mismatches = Object.keys(manifest.counts).filter((k) => manifest.counts[k] !== counts[k]);
    const upDir = path.join(dir, 'uploads');
    const files = fs.existsSync(upDir) ? fs.readdirSync(upDir).length : 0;
    return {
      name, ok: integrity === 'ok' && mismatches.length === 0 && counts.journal_debit === counts.journal_credit && files === manifest.files,
      integrity, counts, expected: manifest.counts, mismatches, balanced: counts.journal_debit === counts.journal_credit, files, expected_files: manifest.files,
    };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** الاستعادة تُنفذ والخادم متوقف عبر scripts/restore.js */
function restoreBackup(backupDir, name, dataFile, uploadsDir) {
  const dir = safeName(backupDir, name);
  const v = verifyBackup(backupDir, name);
  if (!v.ok) fail('BACKUP_INVALID', 'النسخة لم تجتز التحقق؛ لن تتم الاستعادة', 409, v);
  if (fs.existsSync(dataFile)) {
    const keep = `${dataFile}.before-restore-${stamp()}`;
    fs.renameSync(dataFile, keep);
    for (const ext of ['-wal', '-shm']) if (fs.existsSync(dataFile + ext)) fs.rmSync(dataFile + ext);
  }
  fs.copyFileSync(path.join(dir, 'data.db'), dataFile);
  const up = path.join(dir, 'uploads');
  if (uploadsDir && fs.existsSync(up)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
    for (const f of fs.readdirSync(up)) fs.copyFileSync(path.join(up, f), path.join(uploadsDir, f));
  }
  return v;
}

module.exports = { createBackup, listBackups, verifyBackup, restoreBackup, safeName, tableCounts };
