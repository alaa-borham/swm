'use strict';
const path = require('path');
const dataDir = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
module.exports = { dataDir, dbFile: path.join(dataDir, 'data.db'), backupDir: path.join(dataDir, 'backups'), uploadsDir: path.join(dataDir, 'uploads') };
