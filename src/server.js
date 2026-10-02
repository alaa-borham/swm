'use strict';
// خادم HTTP: واجهة برمجية JSON + الواجهة العربية. الصلاحيات تُفحص داخل الخدمات لكل عملية.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { openDb } = require('./db');
const { Ctx } = require('./core/context');
const { AppError, fail } = require('./lib/errors');
const { toBp, toMinor, fromMinor, fromBp, getMoneyDecimals } = require('./lib/money');
const { PERMISSIONS, ROLES, permissionsFor, parseOverrides, effectiveRoles } = require('./core/permissions');
const users = require('./core/users');
const M = require('./core/masters');
const D = require('./core/docs');
const Sales = require('./core/sales');
const Pur = require('./core/purchases');
const Pay = require('./core/payments');
const S = require('./core/stock');
const F = require('./core/finance');
const Reps = require('./core/reps');
const R = require('./core/reports');
const Backup = require('./core/backup');
const Importer = require('./core/importer');
const Export = require('./api/export');
const WA = require('./core/whatsapp');
const { DEFAULT_SETTINGS } = require('./db');

const ALLOWED_UPLOADS = {
  'application/pdf': [0x25, 0x50, 0x44, 0x46],
  'image/png': [0x89, 0x50, 0x4e, 0x47],
  'image/jpeg': [0xff, 0xd8, 0xff],
  'image/webp': [0x52, 0x49, 0x46, 0x46],
};
const MAX_UPLOAD = 5 * 1024 * 1024;

// رقم الإصدار المنشور (Railway يمرر رقم الـ commit) لمعرفة النسخة التي تعمل فعليًا
const APP_VERSION = (process.env.RAILWAY_GIT_COMMIT_SHA || process.env.GIT_COMMIT || '').slice(0, 7) || 'dev';

function createApp({ db, dataDir, today, logger = console } = {}) {
  const uploadsDir = path.join(dataDir, 'uploads');
  const backupDir = path.join(dataDir, 'backups');
  fs.mkdirSync(uploadsDir, { recursive: true });
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', process.env.TRUST_PROXY === '1');

  // رؤوس الحماية
  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'same-origin',
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'",
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    });
    next();
  });

  // فحص صحة الخادم للاستضافة (لا يكشف بيانات)
  app.get('/healthz', (req, res) => {
    try { db.prepare('SELECT 1').get(); res.json({ ok: true, version: APP_VERSION }); } catch (_) { res.status(503).json({ ok: false }); }
  });
  app.use(express.static(path.join(__dirname, '..', 'public'), { index: 'index.html', maxAge: 0 }));

  // Webhook حالات تسليم واتساب من Meta (خارج /api: لا جلسة، ويُتحقق من توقيع Meta)
  app.get('/webhooks/whatsapp', (req, res) => {
    const token = (db.prepare("SELECT value FROM settings WHERE key='whatsapp_verify_token'").get() || {}).value;
    if (req.query['hub.mode'] === 'subscribe' && token && req.query['hub.verify_token'] === token) return res.type('text/plain').send(String(req.query['hub.challenge'] || ''));
    res.sendStatus(403);
  });
  app.post('/webhooks/whatsapp', express.raw({ type: '*/*', limit: '1mb' }), (req, res) => {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
    if (!WA.verifySignature(raw, req.get('X-Hub-Signature-256'), process.env.WHATSAPP_APP_SECRET)) return res.sendStatus(403);
    try { WA.applyStatuses(db, JSON.parse(raw.toString('utf8'))); } catch (e) { logger.error('whatsapp webhook:', e.message); }
    res.sendStatus(200);
  });
  app.use('/api', express.json({ limit: '8mb' }));

  const timeout = () => Number((db.prepare("SELECT value FROM settings WHERE key='session_timeout_minutes'").get() || {}).value || 480);
  const cookieToken = (req) => {
    const m = /(?:^|;\s*)sid=([^;]+)/.exec(req.headers.cookie || '');
    return m ? decodeURIComponent(m[1]) : null;
  };
  const ctxOf = (req) => new Ctx(db, req.user, { ip: req.ip, today });

  // CSRF: الطلبات المغيِّرة يجب أن تأتي من الواجهة (رأس مخصص) مع كوكي SameSite=Strict
  app.use('/api', (req, res, next) => {
    if (req.method !== 'GET' && req.get('X-Requested-With') !== 'fetch') return next(new AppError('CSRF', 'طلب غير مسموح', 403));
    next();
  });

  // ---------- الدخول ----------
  app.post('/api/auth/login', (req, res) => {
    const r = users.login(db, { username: req.body.username, password: req.body.password, ip: req.ip }, timeout());
    const secure = req.secure || process.env.COOKIE_SECURE === '1';
    // كوكي جلسة المتصفح؛ انتهاء الخمول يُفرض في الخادم
    res.cookie('sid', r.token, { httpOnly: true, sameSite: 'strict', secure, path: '/' });
    res.json({ user: r.user });
  });
  app.post('/api/auth/logout', (req, res) => {
    users.logout(db, cookieToken(req));
    res.clearCookie('sid', { path: '/' });
    res.json({ ok: true });
  });

  // المصادقة لكل ما بعده
  app.use('/api', (req, res, next) => {
    const u = users.authenticate(db, cookieToken(req), timeout());
    if (!u) return next(new AppError('UNAUTHENTICATED', 'انتهت الجلسة؛ سجّل الدخول', 401));
    req.user = u;
    next();
  });

  // منع تكرار العملية: نفس المعرف يعيد نفس النتيجة، ومحتوى مختلف بنفس المعرف يُرفض
  app.use('/api', (req, res, next) => {
    const key = req.get('Idempotency-Key');
    if (req.method !== 'POST' && req.method !== 'PUT') return next();
    if (!key) return next();
    if (!/^[\w-]{8,100}$/.test(key)) return next(new AppError('VALIDATION', 'معرف العملية غير صالح', 400));
    const hash = crypto.createHash('sha256').update(req.method + req.originalUrl + JSON.stringify(req.body || {})).digest('hex');
    const ex = db.prepare('SELECT * FROM idempotency WHERE key=? AND user_id=?').get(key, req.user.id);
    if (ex) {
      if (ex.request_hash !== hash) return next(new AppError('IDEMPOTENCY_CONFLICT', 'معرف العملية مستخدم لطلب بمحتوى مختلف', 409));
      res.set('Idempotent-Replay', 'true');
      return res.status(ex.status).type('json').send(ex.response);
    }
    const json = res.json.bind(res);
    res.json = (body) => {
      if (res.statusCode < 300) {
        try {
          db.prepare('INSERT INTO idempotency(key,user_id,route,request_hash,response,status,created_at) VALUES(?,?,?,?,?,?,?)')
            .run(key, req.user.id, req.originalUrl, hash, JSON.stringify(body), res.statusCode, new Date().toISOString());
        } catch (e) { logger.error('idempotency store failed', e.message); }
      }
      return json(body);
    };
    next();
  });

  const api = express.Router();
  app.use('/api', api);
  const h = (fn) => (req, res) => {
    const out = fn(ctxOf(req), req, res);
    if (out && typeof out.then === 'function') return out.then((v) => { if (!res.headersSent) res.json(v === undefined ? { ok: true } : v); });
    if (!res.headersSent) res.json(out === undefined ? { ok: true } : out);
  };
  const id = (req) => Number(req.params.id);

  // ---------- الجلسة الحالية والإعدادات ----------
  api.get('/auth/me', h((ctx) => {
    const s = ctx.settings();
    const session = Pay.openSessionFor(ctx, ctx.userId);
    return {
      user: ctx.user, permissions: [...ctx._perms], session,
      rep: ctx.user.rep_id ? M.getRep(ctx, ctx.user.rep_id) : null,
      branch: ctx.user.branch_id ? db.prepare('SELECT id,name FROM branches WHERE id=?').get(ctx.user.branch_id) : null,
      branches_count: db.prepare('SELECT COUNT(*) n FROM branches WHERE active=1').get().n,
      settings: {
        org_name: s.org_name, org_address: s.org_address, org_phone: s.org_phone, org_tax_number: s.org_tax_number, org_cr_number: s.org_cr_number, currency: s.currency,
        org_logo_url: s.org_logo ? '/api/settings/logo?v=' + crypto.createHash('sha1').update(s.org_logo).digest('hex').slice(0, 10) : null,
        money_decimals: getMoneyDecimals(), prices_include_tax: s.prices_include_tax === '1', default_tax_rate: fromBp(Number(s.default_tax_rate_bp)),
        invoice_footer: s.invoice_footer, receipt_width_mm: Number(s.receipt_width_mm), locked_until: s.locked_until, today: ctx.today(),
        expiry_alert_days: Number(s.expiry_alert_days), einvoice_qr: s.einvoice_qr === '1', whatsapp_enabled: s.whatsapp_enabled === '1', app_version: APP_VERSION, invoice_discount_enabled: s.invoice_discount_enabled === '1',
      },
    };
  }));
  api.post('/auth/password', h((ctx, req) => users.changeOwnPassword(ctx, req.body)));
  api.get('/meta', h((ctx) => ({ permissions: PERMISSIONS, roles: effectiveRoles(parseOverrides(ctx.setting('role_permissions'))), doc_labels: D.DOC_LABELS })));
  // تعديل صلاحيات دور (عدا المدير)؛ reset يعيده للافتراضي
  api.put('/roles/:role/permissions', h((ctx, req) => ctx.tx(() => {
    ctx.require('users.manage');
    const role = req.params.role;
    if (!ROLES[role]) fail('NOT_FOUND', 'الدور غير موجود', 404);
    if (role === 'admin') fail('VALIDATION', 'صلاحيات المدير ثابتة ولا تُعدّل');
    const all = parseOverrides(ctx.setting('role_permissions'));
    const before = all[role] || ROLES[role].permissions;
    if (req.body.reset) delete all[role];
    else {
      const list = req.body.permissions;
      if (!Array.isArray(list)) fail('VALIDATION', 'قائمة الصلاحيات مطلوبة');
      const bad = list.filter((p) => !PERMISSIONS[p]);
      if (bad.length) fail('VALIDATION', 'صلاحيات غير معروفة: ' + bad.join(', '));
      all[role] = [...new Set(list)];
    }
    db.prepare("INSERT INTO settings(key,value) VALUES('role_permissions',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(all));
    ctx.invalidateSettings();
    ctx.audit('role.permissions', { entity: 'role', reason: role, before, after: all[role] || ROLES[role].permissions });
    return effectiveRoles(all)[role];
  })));

  const SETTING_KEYS = {
    org_name: 'settings.manage', org_address: 'settings.manage', org_phone: 'settings.manage', org_tax_number: 'settings.manage', country: 'settings.manage',
    org_logo: 'settings.manage', org_cr_number: 'settings.manage', reps_all_customers: 'settings.manage', invoice_discount_enabled: 'settings.manage',
    currency: 'settings.manage', timezone: 'settings.manage', expiry_block_days: 'settings.manage', expiry_alert_days: 'settings.manage',
    cashier_max_discount_pct: 'settings.manage', extra_cost_basis: 'settings.manage', session_timeout_minutes: 'settings.manage', backup_hour: 'backup.manage',
    backup_retention: 'backup.manage', invoice_footer: 'settings.manage', receipt_width_mm: 'settings.manage', money_decimals: 'settings.manage',
    default_tax_rate_pct: 'tax.manage', prices_include_tax: 'tax.manage', tax_recoverable: 'tax.manage', einvoice_qr: 'tax.manage', whatsapp_enabled: 'settings.manage', whatsapp_phone_number_id: 'settings.manage', whatsapp_api_version: 'settings.manage', whatsapp_lang: 'settings.manage', whatsapp_country_code: 'settings.manage', whatsapp_template_invoice: 'settings.manage', whatsapp_template_receipt: 'settings.manage', whatsapp_template_reminder: 'settings.manage', whatsapp_auto_invoice: 'settings.manage', whatsapp_auto_receipt: 'settings.manage', whatsapp_verify_token: 'settings.manage', scale_prefix: 'settings.manage', scale_plu_digits: 'settings.manage', scale_value_digits: 'settings.manage', scale_mode: 'settings.manage',
  };
  // شعار المؤسسة للطباعة
  api.get('/settings/logo', (req, res, next) => {
    try {
      const v = db.prepare("SELECT value FROM settings WHERE key='org_logo'").get()?.value;
      const m = v && /^data:(image\/(?:png|jpeg|webp));base64,(.+)$/.exec(v);
      if (!m) return res.status(404).end();
      res.set('Content-Type', m[1]).set('Cache-Control', 'private, max-age=31536000, immutable').send(Buffer.from(m[2], 'base64'));
    } catch (e) { next(e); }
  });
  api.get('/settings', h((ctx) => {
    ctx.require('settings.manage');
    const s = { ...ctx.settings() };
    s.default_tax_rate_pct = fromBp(Number(s.default_tax_rate_bp));
    s.cashier_max_discount_pct = fromBp(Number(s.cashier_max_discount_bp));
    s.whatsapp_status = WA.status(ctx);
    return s;
  }));
  api.put('/settings', h((ctx, req) => ctx.tx(() => {
    const before = { ...ctx.settings() };
    const set = db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
    for (const [k, v] of Object.entries(req.body || {})) {
      const perm = SETTING_KEYS[k];
      if (!perm) continue;
      ctx.require(perm, 'settings.' + k);
      // التحقق من القيم قبل الحفظ: قيمة خاطئة هنا قد تعطل العمليات كلها
      const intIn = (min, max, label) => { const n = Number(v); if (!Number.isInteger(n) || n < min || n > max) fail('VALIDATION', `${label}: أدخل رقمًا صحيحًا بين ${min} و${max}`); };
      if (k === 'timezone' && !require('./lib/dates').validTimeZone(String(v || ''))) fail('VALIDATION', 'المنطقة الزمنية غير صحيحة؛ اخترها من القائمة (مثل Africa/Cairo أو Asia/Riyadh)');
      if (k === 'org_name' && !String(v || '').trim()) fail('VALIDATION', 'اسم المؤسسة مطلوب');
      // الشعار صورة PNG/JPG/WebP مضمنة (بدون SVG لأنه قد يحمل نصوصًا برمجية) وبحجم معقول للطباعة
      if (k === 'org_logo' && v) {
        const m = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(v));
        if (!m) fail('VALIDATION', 'الشعار يجب أن يكون صورة PNG أو JPG أو WebP');
        if (m[2].length * 0.75 > 300 * 1024) fail('VALIDATION', 'حجم الشعار كبير؛ الحد 300 كيلوبايت');
      }
      // رمز QR السعودي يتطلب رقمًا ضريبيًا صحيحًا (15 رقمًا يبدأ وينتهي بـ 3)
      const vatMsg = 'الرقم الضريبي يجب أن يكون 15 رقمًا يبدأ وينتهي بالرقم 3 (مثل 310123456700003)؛ وإلا لن يُقرأ رمز QR في تطبيق الهيئة';
      const qrOn = 'einvoice_qr' in req.body ? !!req.body.einvoice_qr && req.body.einvoice_qr !== '0' : before.einvoice_qr === '1';
      if (k === 'org_tax_number' && v && qrOn && !require('./core/einvoice').validVatNumber(v)) fail('VALIDATION', vatMsg);
      if (k === 'einvoice_qr' && v && v !== '0' && !require('./core/einvoice').validVatNumber('org_tax_number' in req.body ? req.body.org_tax_number : before.org_tax_number)) fail('VALIDATION', vatMsg);
      // أول إدخال للرقم الضريبي يفعّل رمز QR للفاتورة الضريبية تلقائيًا
      if (k === 'org_tax_number' && v && !before.org_tax_number && !('einvoice_qr' in req.body) && ctx.has('tax.manage') && require('./core/einvoice').validVatNumber(v)) set.run('einvoice_qr', '1');
      if (k === 'expiry_block_days') intIn(0, 365, 'منع البيع قبل الانتهاء');
      if (k === 'expiry_alert_days') intIn(0, 3650, 'تنبيه الصلاحية');
      if (k === 'session_timeout_minutes') intIn(5, 10080, 'انتهاء الجلسة');
      if (k === 'backup_hour') intIn(0, 23, 'ساعة النسخ');
      if (k === 'backup_retention') intIn(1, 365, 'عدد النسخ');
      if (k === 'receipt_width_mm') intIn(40, 120, 'عرض الإيصال');
      if (k === 'scale_plu_digits' || k === 'scale_value_digits') intIn(1, 8, 'خانات باركود الميزان');
      if (k === 'scale_prefix' && v && !/^\d{1,3}$/.test(String(v))) fail('VALIDATION', 'بادئة باركود الميزان أرقام فقط (1-3 خانات)');
      if (k === 'whatsapp_country_code' && v && !/^\d{1,4}$/.test(String(v))) fail('VALIDATION', 'رمز الدولة أرقام فقط مثل 966 أو 20');
      if (k === 'default_tax_rate_pct') { set.run('default_tax_rate_bp', String(toBp(v))); continue; }
      if (k === 'cashier_max_discount_pct') { set.run('cashier_max_discount_bp', String(toBp(v))); continue; }
      if (k === 'money_decimals' && String(v) !== before.money_decimals) {
        if (db.prepare('SELECT 1 FROM docs LIMIT 1').get()) fail('VALIDATION', 'لا يمكن تغيير منازل العملة بعد تسجيل مستندات');
        if (![0, 1, 2, 3].includes(Number(v))) fail('VALIDATION', 'منازل العملة بين 0 و3');
        require('./lib/money').setMoneyDecimals(Number(v));
      }
      if (['invoice_discount_enabled', 'reps_all_customers', 'prices_include_tax', 'tax_recoverable', 'einvoice_qr', 'whatsapp_enabled', 'whatsapp_auto_invoice', 'whatsapp_auto_receipt'].includes(k)) { set.run(k, v ? '1' : '0'); continue; }
      set.run(k, String(v ?? ''));
    }
    ctx.invalidateSettings();
    ctx.audit('settings.update', { entity: 'settings', before, after: ctx.settings(), reason: req.body.reason || null });
    return { ok: true };
  })));

  // ---------- المستخدمون والتدقيق ----------
  api.get('/users', h((ctx) => users.listUsers(ctx)));
  api.post('/users', h((ctx, req) => users.createUser(ctx, req.body)));
  api.put('/users/:id', h((ctx, req) => users.updateUser(ctx, id(req), req.body)));
  api.get('/audit', h((ctx, req) => R.auditLog(ctx, req.query)));

  // ---------- البيانات الأساسية ----------
  api.get('/items', h((ctx, req) => M.listItems(ctx, req.query)));
  api.get('/items/lookup', h((ctx, req) => M.lookupItem(ctx, req.query.q || '', req.query.warehouse_id ? Number(req.query.warehouse_id) : null, req.query.in_stock === '1')));
  api.get('/items/catalog', h((ctx, req) => M.posCatalog(ctx, req.query.warehouse_id ? Number(req.query.warehouse_id) : null)));
  api.get('/items/:id', h((ctx, req) => { ctx.require('items.view'); return M.getItemFull(ctx, id(req)); }));
  api.get('/items/:id/batches', h((ctx, req) => R.stockReport(ctx, { by: 'batch', item_id: id(req), warehouse_id: req.query.warehouse_id })));
  api.post('/items', h((ctx, req) => M.createItem(ctx, req.body)));
  api.put('/items/:id', h((ctx, req) => M.updateItem(ctx, id(req), req.body)));
  for (const [route, table] of [['categories', 'categories'], ['expense-categories', 'expense_categories']]) {
    api.get('/' + route, h((ctx) => M.simpleList(ctx, table)));
    api.post('/' + route, h((ctx, req) => M.saveCategory(ctx, table, req.body)));
    api.put(`/${route}/:id`, h((ctx, req) => M.saveCategory(ctx, table, req.body, id(req))));
  }
  api.get('/parties', h((ctx, req) => M.listParties(ctx, req.query)));
  api.get('/parties/:id', h((ctx, req) => M.getParty(ctx, id(req))));
  api.post('/parties', h((ctx, req) => M.createParty(ctx, req.body)));
  api.put('/parties/:id', h((ctx, req) => M.updateParty(ctx, id(req), req.body)));
  api.get('/warehouses', h((ctx, req) => M.listWarehouses(ctx, { all: req.query.all === '1' })));
  api.post('/warehouses', h((ctx, req) => M.saveWarehouse(ctx, req.body)));
  api.put('/warehouses/:id', h((ctx, req) => M.saveWarehouse(ctx, req.body, id(req))));
  api.delete('/warehouses/:id', h((ctx, req) => M.deleteWarehouse(ctx, id(req))));
  api.get('/cash-accounts', h((ctx) => M.listCashAccounts(ctx)));
  api.post('/cash-accounts', h((ctx, req) => M.saveCashAccount(ctx, req.body)));
  api.put('/cash-accounts/:id', h((ctx, req) => M.saveCashAccount(ctx, req.body, id(req))));
  api.delete('/cash-accounts/:id', h((ctx, req) => M.deleteCashAccount(ctx, id(req))));
  api.get('/branches', h((ctx) => M.listBranches(ctx)));
  api.post('/branches', h((ctx, req) => M.saveBranch(ctx, req.body)));
  api.put('/branches/:id', h((ctx, req) => M.saveBranch(ctx, req.body, id(req))));
  api.get('/reps', h((ctx) => M.listReps(ctx)));
  api.get('/reps/:id', h((ctx, req) => M.getRep(ctx, id(req))));
  api.post('/reps', h((ctx, req) => M.createRep(ctx, req.body)));
  api.put('/reps/:id', h((ctx, req) => M.updateRep(ctx, id(req), req.body)));
  api.post('/reps/:id/customers', h((ctx, req) => M.assignRepCustomers(ctx, id(req), req.body)));
  api.post('/reps/:id/plans', h((ctx, req) => { M.addCommissionPlan(ctx, id(req), req.body); return M.getRep(ctx, id(req)); }));
  api.get('/reps/:id/custody', h((ctx, req) => Reps.custodyStatement(ctx, id(req), req.query)));
  api.post('/reps/:id/settle', h((ctx, req) => Reps.settleCustody(ctx, id(req), req.body)));

  // ---------- المستندات ----------
  const canView = (ctx, doc) => {
    const perm = D.DOC_VIEW_PERM[doc.type];
    if (perm) ctx.require(perm);
    if (ctx.repScope && doc.rep_id !== ctx.repScope) fail('FORBIDDEN', 'المستند خارج نطاقك', 403);
    // التحويل الوارد يراه فرع الوجهة أيضًا
    const toBranch = doc.to_warehouse_id ? db.prepare('SELECT branch_id FROM warehouses WHERE id=?').get(doc.to_warehouse_id).branch_id : null;
    if (!(ctx.branchScope && toBranch === ctx.branchScope)) ctx.checkBranch(doc.branch_id);
  };
  api.get('/docs', h((ctx, req) => R.listDocs(ctx, req.query)));
  api.get('/docs/:id', h((ctx, req) => {
    const doc = D.loadDoc(ctx, id(req));
    canView(ctx, doc);
    const full = doc.type === 'commission' ? Reps.commissionDetail(ctx, doc.id) : D.fullDoc(ctx, doc.id);
    if (!ctx.has('cost.view')) {
      delete full.cost;
      for (const l of full.lines) { delete l.cost; delete l.extra_cost; }
      if (['purchase', 'purchase_return', 'opening_stock'].includes(doc.type)) for (const l of full.lines) { delete l.price; }
    }
    return full;
  }));
  api.get('/docs/:id/qr', h(async (ctx, req) => {
    const doc = D.loadDoc(ctx, id(req));
    canView(ctx, doc);
    return require('./core/einvoice').qrSvg(ctx, doc);
  }));
  api.post('/docs/:id/whatsapp', h((ctx, req) => WA.sendForDoc(ctx, id(req))));
  api.get('/whatsapp/status', h((ctx) => { ctx.requireAny(['messages.send', 'settings.manage']); return WA.status(ctx); }));
  api.get('/whatsapp/overdue', h((ctx) => {
    ctx.require('messages.bulk');
    const cc = (ctx.setting('whatsapp_country_code') || '');
    return WA.overdueParties(ctx).map((o) => {
      const p = db.prepare('SELECT id,name,phone,whatsapp_opt_in FROM parties WHERE id=?').get(o.party_id);
      return { ...o, amount: fromMinor(o.amount), name: p.name, phone: p.phone, opt_in: !!p.whatsapp_opt_in, phone_ok: !!WA.normalizePhone(p.phone, cc) };
    });
  }));
  api.post('/whatsapp/reminders', h((ctx, req) => WA.remindOverdue(ctx, req.body)));
  api.post('/whatsapp/test', h((ctx, req) => WA.sendTest(ctx, req.body)));
  api.get('/messages', h((ctx, req) => WA.listMessages(ctx, req.query)));
  api.post('/docs/:id/print', h((ctx, req) => {
    ctx.require('sales.print');
    const doc = D.loadDoc(ctx, id(req));
    canView(ctx, doc);
    if (doc.status !== 'approved') fail('INVALID_STATE', 'لا يُطبع إلا المستند المعتمد');
    db.prepare('UPDATE docs SET print_count=print_count+1 WHERE id=?').run(doc.id);
    const n = doc.print_count + 1;
    if (n > 1) ctx.audit('doc.reprint', { entity: 'doc', entity_id: doc.id, doc_number: doc.number, after: { copy: n } });
    return { print_count: n, copy: n > 1 };
  }));
  api.post('/docs/:id/cancel', h((ctx, req) => ctx.tx(() => {
    const doc = D.loadDoc(ctx, id(req));
    if (doc.status !== 'draft') fail('INVALID_STATE', 'هذا المسار لإلغاء المسودات فقط');
    const createPerm = { purchase_order: 'purchases.create', sale: 'sales.create', sale_return: 'sale_returns.create', purchase: 'purchases.create', expense: 'expenses.create', stock_count: 'stock.count', damage: 'stock.damage', commission: 'commissions.manage' }[doc.type];
    ctx.require(createPerm || 'docs.reverse');
    if (ctx.repScope && doc.rep_id !== ctx.repScope) fail('FORBIDDEN', 'المستند خارج نطاقك', 403);
    D.markReversed(ctx, doc, ctx.requireReason(req.body.reason, 'إلغاء المسودة'));
    ctx.audit('draft.cancel', { entity: 'doc', entity_id: doc.id, doc_number: doc.number, reason: req.body.reason });
    return D.fullDoc(ctx, doc.id);
  })));

  // المبيعات
  // الإشعار التلقائي يُرسل بعد اكتمال الاعتماد ولا يؤثر فيه
  const notify = (ctx, doc) => { if (doc && doc.status === 'approved') setImmediate(() => WA.autoNotify(ctx, doc)); return doc; };
  api.post('/sales', h((ctx, req) => notify(ctx, Sales.createSale(ctx, req.body))));
  api.put('/sales/:id', h((ctx, req) => Sales.updateSaleDraft(ctx, id(req), req.body)));
  api.post('/sales/:id/approve', h((ctx, req) => notify(ctx, Sales.approveSaleDraft(ctx, id(req), req.body))));
  api.post('/sales/:id/reverse', h((ctx, req) => Sales.reverseSale(ctx, id(req), req.body.reason)));
  api.get('/sales/:id/returnable', h((ctx, req) => { ctx.require('sale_returns.create'); return Sales.returnableLines(ctx, id(req)); }));
  api.post('/sale-returns', h((ctx, req) => Sales.createSaleReturn(ctx, req.body)));
  api.post('/sale-returns/:id/approve', h((ctx, req) => Sales.approveSaleReturn(ctx, id(req), req.body)));
  // المشتريات
  api.post('/purchases', h((ctx, req) => Pur.createPurchase(ctx, req.body)));
  api.put('/purchases/:id', h((ctx, req) => Pur.updatePurchase(ctx, id(req), req.body)));
  api.post('/purchases/:id/approve', h((ctx, req) => Pur.approvePurchase(ctx, id(req), req.body)));
  api.post('/purchases/:id/reverse', h((ctx, req) => Pur.reversePurchase(ctx, id(req), req.body.reason)));
  api.post('/purchase-orders', h((ctx, req) => Pur.createPurchaseOrder(ctx, req.body)));
  api.put('/purchase-orders/:id', h((ctx, req) => Pur.updatePurchaseOrder(ctx, id(req), req.body)));
  api.post('/purchase-orders/:id/approve', h((ctx, req) => Pur.approvePurchaseOrder(ctx, id(req))));
  api.post('/purchase-orders/:id/close', h((ctx, req) => Pur.closePurchaseOrder(ctx, id(req), req.body.reason)));
  api.get('/purchase-orders/:id/remaining', h((ctx, req) => Pur.poRemaining(ctx, id(req))));
  api.post('/purchase-returns', h((ctx, req) => Pur.createPurchaseReturn(ctx, req.body)));
  // النقد
  api.post('/receipts', h((ctx, req) => notify(ctx, Pay.createReceipt(ctx, req.body))));
  api.post('/payments', h((ctx, req) => Pay.createPayment(ctx, req.body)));
  api.post('/allocations', h((ctx, req) => Pay.allocateLater(ctx, req.body)));
  api.post('/cash-transfers', h((ctx, req) => Pay.createCashTransfer(ctx, req.body)));
  api.post('/cash-docs/:id/reverse', h((ctx, req) => Pay.reverseCashDoc(ctx, id(req), req.body.reason)));
  api.get('/open-docs', h((ctx, req) => {
    ctx.requireAny(['cash.receipt', 'cash.payment', 'commissions.pay']);
    if (req.query.party_id) M.getPartyRow(ctx, Number(req.query.party_id));
    return Pay.openDocs(ctx, { party_id: req.query.party_id ? Number(req.query.party_id) : null, account: req.query.account || 'AR', rep_id: req.query.rep_id });
  }));
  // المصروفات
  api.post('/expenses', h((ctx, req) => F.createExpense(ctx, req.body)));
  api.post('/expenses/:id/approve', h((ctx, req) => F.approveExpense(ctx, id(req), req.body)));
  api.post('/expenses/:id/pay', h((ctx, req) => F.payExpense(ctx, id(req), req.body)));
  api.post('/expenses/:id/reverse', h((ctx, req) => F.reverseExpense(ctx, id(req), req.body.reason)));
  // المخزون
  api.post('/transfers', h((ctx, req) => S.createTransfer(ctx, req.body)));
  api.post('/transfers/:id/receive', h((ctx, req) => S.receiveTransfer(ctx, id(req), req.body)));
  api.post('/transfers/:id/reverse', h((ctx, req) => S.reverseTransfer(ctx, id(req), req.body.reason)));
  api.post('/damages', h((ctx, req) => S.createDamage(ctx, req.body)));
  api.post('/damages/:id/approve', h((ctx, req) => S.approveDamage(ctx, id(req))));
  api.post('/counts', h((ctx, req) => S.createCount(ctx, req.body)));
  api.put('/counts/:id', h((ctx, req) => S.enterCounts(ctx, id(req), req.body.counts)));
  api.post('/counts/:id/approve', h((ctx, req) => S.approveCount(ctx, id(req), req.body)));
  api.post('/opening-stock', h((ctx, req) => S.createOpeningStock(ctx, req.body)));
  api.post('/batches/:id/status', h((ctx, req) => S.changeBatchStatus(ctx, { ...req.body, batch_id: id(req) })));
  api.post('/opening-balances', h((ctx, req) => F.createOpeningBalance(ctx, req.body)));
  api.post('/period/lock', h((ctx, req) => F.lockPeriod(ctx, req.body)));
  // الورديات
  api.get('/sessions', h((ctx, req) => F.listSessions(ctx, req.query)));
  api.get('/sessions/current', h((ctx) => { const s = Pay.openSessionFor(ctx, ctx.userId); return s ? F.getSession(ctx, s.id) : null; }));
  api.post('/sessions', h((ctx, req) => F.openSession(ctx, req.body)));
  api.get('/sessions/:id', h((ctx, req) => F.getSession(ctx, id(req))));
  api.post('/sessions/:id/close', h((ctx, req) => F.closeSession(ctx, id(req), req.body)));
  api.post('/sessions/:id/approve', h((ctx, req) => F.approveSessionVariance(ctx, id(req))));
  api.post('/sessions/:id/reopen', h((ctx, req) => F.reopenSession(ctx, id(req), req.body.reason)));
  // العمولات
  api.get('/commissions/preview', h((ctx, req) => Reps.commissionPreview(ctx, req.query)));
  api.post('/commissions', h((ctx, req) => Reps.calculateCommission(ctx, req.body)));
  api.post('/commissions/:id/approve', h((ctx, req) => Reps.approveCommission(ctx, id(req))));
  api.post('/commissions/:id/pay', h((ctx, req) => Reps.payCommission(ctx, id(req), req.body)));
  api.post('/commissions/:id/cancel', h((ctx, req) => Reps.cancelCommissionDraft(ctx, id(req), req.body.reason)));

  // ---------- التقارير ----------
  const A = require('./core/accounting');
  api.get('/accounts', h((ctx) => { ctx.requireAny(['reports.finance', 'journal.manual']); return { all: Object.entries(A.ACCOUNTS).map(([code, a]) => ({ code, ...a })), manual: A.manualAccounts() }; }));
  api.post('/journals', h((ctx, req) => A.createJournal(ctx, req.body)));
  api.post('/journals/:id/reverse', h((ctx, req) => A.reverseJournal(ctx, id(req), req.body.reason)));
  api.get('/reports/balance-sheet', h((ctx, req) => A.balanceSheet(ctx, req.query)));
  const REPORTS = {
    sales: R.salesReport, purchases: R.purchasesReport, statement: R.partyStatement, aging: R.aging, stock: R.stockReport,
    'item-card': R.itemCard, 'trial-balance': A.trialBalance, ledger: A.generalLedger, expenses: R.expensesReport, cash: R.cashReport, reps: R.repsReport,
  };
  api.get('/reports/dashboard', h((ctx, req) => R.dashboard(ctx, req.query)));
  api.get('/reports/alerts', h((ctx) => { ctx.requireAny(['stock.view', 'dashboard.view']); return R.alerts(ctx); }));
  api.get('/reports/profit', h((ctx, req) => R.profitLoss(ctx, req.query)));
  api.get('/reports/tax', h((ctx, req) => R.taxReport(ctx, req.query)));
  api.get('/reports/:name', h((ctx, req) => {
    const fn = REPORTS[req.params.name];
    if (!fn) fail('NOT_FOUND', 'التقرير غير موجود', 404);
    return fn(ctx, req.query);
  }));
  api.get('/reports/:name/export', h(async (ctx, req, res) => {
    ctx.require('reports.export');
    const fn = REPORTS[req.params.name];
    if (!fn) fail('NOT_FOUND', 'التقرير غير موجود', 404);
    const rep = fn(ctx, req.query);
    const fname = `${req.params.name}-${ctx.today()}`;
    ctx.audit('report.export', { entity: 'report', after: { name: req.params.name, query: req.query } });
    if (req.query.format === 'csv') {
      res.set('Content-Disposition', `attachment; filename="${fname}.csv"`).type('text/csv; charset=utf-8').send(Export.toCsv(rep));
    } else {
      const buf = await Export.toXlsx(rep, ctx.setting('org_name'));
      res.set('Content-Disposition', `attachment; filename="${fname}.xlsx"`).type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').send(Buffer.from(buf));
    }
  }));

  // ---------- الاستيراد ----------
  api.get('/import/template/:kind', h(async (ctx, req, res) => {
    ctx.require('import.manage');
    const buf = await Importer.templateXlsx(req.params.kind);
    res.set('Content-Disposition', `attachment; filename="template-${req.params.kind}.xlsx"`).type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').send(Buffer.from(buf));
  }));
  const readUpload = async (body) => {
    if (!body || !body.data) fail('VALIDATION', 'أرفق الملف');
    const buf = Buffer.from(String(body.data), 'base64');
    if (buf.length > MAX_UPLOAD) fail('TOO_LARGE', 'حجم الملف أكبر من 5 ميجابايت');
    return Importer.parseFile(buf, body.filename);
  };
  api.post('/import/preview', h(async (ctx, req) => Importer.preview(ctx, req.body.kind, await readUpload(req.body))));
  api.post('/import/commit', h(async (ctx, req) => Importer.commit(ctx, req.body.kind, await readUpload(req.body), { warehouse_id: req.body.warehouse_id, date: req.body.date })));

  // ---------- المرفقات ----------
  api.post('/attachments', h((ctx, req) => {
    ctx.requireAny(['expenses.create', 'purchases.create', 'items.manage']);
    const { file_name, mime, data, doc_id } = req.body || {};
    const magic = ALLOWED_UPLOADS[mime];
    if (!magic) fail('VALIDATION', 'نوع الملف غير مسموح (PDF أو صورة PNG/JPEG/WEBP)');
    const buf = Buffer.from(String(data || ''), 'base64');
    if (!buf.length) fail('VALIDATION', 'الملف فارغ');
    if (buf.length > MAX_UPLOAD) fail('TOO_LARGE', 'حجم المرفق أكبر من 5 ميجابايت');
    if (!magic.every((b, i) => buf[i] === b)) fail('VALIDATION', 'محتوى الملف لا يطابق نوعه');
    if (doc_id) canView(ctx, D.loadDoc(ctx, Number(doc_id)));
    const stored = crypto.randomBytes(16).toString('hex');
    fs.writeFileSync(path.join(uploadsDir, stored), buf, { mode: 0o600 });
    const safe = String(file_name || 'file').replace(/[^\p{L}\p{N}._ -]/gu, '_').slice(0, 100);
    const aid = db.prepare('INSERT INTO attachments(doc_id,file_name,stored_name,mime,size,uploaded_by,created_at) VALUES(?,?,?,?,?,?,?)')
      .run(doc_id || null, safe, stored, mime, buf.length, ctx.userId, ctx.now()).lastInsertRowid;
    ctx.audit('attachment.upload', { entity: 'attachment', entity_id: aid, after: { file_name: safe, size: buf.length, doc_id } });
    return { id: aid, file_name: safe, size: buf.length };
  }));
  api.get('/attachments/:id', h((ctx, req, res) => {
    const a = db.prepare('SELECT * FROM attachments WHERE id=?').get(id(req));
    if (!a) fail('NOT_FOUND', 'المرفق غير موجود', 404);
    if (a.doc_id) canView(ctx, D.loadDoc(ctx, a.doc_id)); else if (a.uploaded_by !== ctx.userId) fail('FORBIDDEN', 'غير مسموح', 403);
    res.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(a.file_name)}`).type(a.mime).send(fs.readFileSync(path.join(uploadsDir, a.stored_name)));
  }));

  // ---------- النسخ الاحتياطي ----------
  api.get('/backups', h((ctx) => { ctx.require('backup.manage'); return Backup.listBackups(backupDir); }));
  api.post('/backups', h((ctx) => {
    ctx.require('backup.manage');
    const r = Backup.createBackup(db, { backupDir, uploadsDir, retention: Number(ctx.setting('backup_retention') || 30), label: 'manual' });
    ctx.audit('backup.create', { entity: 'backup', after: { name: r.name } });
    return r;
  }));
  api.post('/backups/:name/verify', h((ctx, req) => {
    ctx.require('backup.manage');
    const r = Backup.verifyBackup(backupDir, req.params.name, dataDir);
    ctx.audit('backup.verify', { entity: 'backup', after: { name: req.params.name, ok: r.ok } });
    return r;
  }));
  api.get('/backups/:name/download', h((ctx, req, res) => {
    ctx.require('backup.manage');
    const dir = Backup.safeName(backupDir, req.params.name);
    ctx.audit('backup.download', { entity: 'backup', after: { name: req.params.name } });
    res.set('Content-Disposition', `attachment; filename="${req.params.name}.db"`).type('application/octet-stream').send(fs.readFileSync(path.join(dir, 'data.db')));
  }));

  // ---------- الأخطاء ----------
  app.use('/api', (req, res, next) => next(new AppError('NOT_FOUND', 'المسار غير موجود', 404)));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof AppError) return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: { code: 'TOO_LARGE', message: 'حجم الطلب كبير' } });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: { code: 'BAD_JSON', message: 'صيغة الطلب غير صحيحة' } });
    const ref = crypto.randomBytes(4).toString('hex');
    logger.error(`[${ref}] ${req.method} ${req.path}: ${err.code || ''} ${err.message}`);
    res.status(500).json({ error: { code: 'SERVER_ERROR', message: `حدث خطأ غير متوقع؛ لم تُحفظ العملية (مرجع ${ref})` } });
  });

  // الواجهة: أي مسار غير API يعيد الصفحة الرئيسية
  app.get(/^\/(?!api\/).*/, (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));
  return app;
}

/** جدولة النسخ اليومي */
function scheduleBackups(db, dataDir, logger = console) {
  const backupDir = path.join(dataDir, 'backups');
  const tick = () => {
    try {
      const hour = Number((db.prepare("SELECT value FROM settings WHERE key='backup_hour'").get() || {}).value ?? 23);
      const retention = Number((db.prepare("SELECT value FROM settings WHERE key='backup_retention'").get() || {}).value ?? 30);
      const now = new Date();
      const today = now.toISOString().slice(0, 10).replace(/-/g, '');
      const done = Backup.listBackups(backupDir).some((b) => b.name.startsWith(`backup-${today}`) && b.name.endsWith('-auto'));
      if (!done && now.getHours() >= hour) {
        const r = Backup.createBackup(db, { backupDir, uploadsDir: path.join(dataDir, 'uploads'), retention, label: 'auto' });
        logger.log('نسخة احتياطية تلقائية:', r.name);
      }
    } catch (e) {
      logger.error('فشل النسخ الاحتياطي التلقائي:', e.message);
      try { db.prepare("INSERT INTO audit_log(ts,action,reason,ok) VALUES(?,?,?,0)").run(new Date().toISOString(), 'backup.failed', e.message); } catch (_) { /* ignore */ }
    }
  };
  tick();
  return setInterval(tick, 10 * 60 * 1000);
}

if (require.main === module) {
  // على Railway تُحفظ البيانات في القرص الدائم (Volume) تلقائيًا
  const dataDir = path.resolve(process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, '..', 'data'));
  if (process.env.RAILWAY_ENVIRONMENT && !process.env.RAILWAY_VOLUME_MOUNT_PATH && !process.env.DATA_DIR) {
    console.warn('تحذير: لا يوجد قرص دائم (Volume) مربوط؛ ستُفقد البيانات عند إعادة النشر. أضف Volume على المسار /data');
  }
  const db = openDb(path.join(dataDir, 'data.db'));
  const pw = users.ensureAdmin(db, process.env.ADMIN_PASSWORD);
  if (pw && process.env.ADMIN_PASSWORD) console.log('\nتم إنشاء المستخدم admin بكلمة المرور المحددة في ADMIN_PASSWORD؛ غيّرها بعد أول دخول.\n');
  else if (pw) console.log(`\nتم إنشاء المستخدم admin بكلمة مرور مؤقتة: ${pw}\nغيّرها بعد أول دخول.\n`);
  const app = createApp({ db, dataDir });
  scheduleBackups(db, dataDir);
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || '0.0.0.0';
  app.listen(port, host, () => console.log(`النظام يعمل على http://localhost:${port}`));
}

module.exports = { createApp, scheduleBackups, DEFAULT_SETTINGS, toMinor, fromMinor };
