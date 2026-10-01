'use strict';
// البيانات الأساسية: الأصناف والوحدات والباركود، الأطراف، المستودعات، الحسابات النقدية، المناديب، التصنيفات.
// لا تُحذف السجلات المرتبطة بمستندات؛ تُوقف بدلاً من الحذف.
const { fail, notFound } = require('../lib/errors');
const { toMinor, toQty, toBp } = require('../lib/money');
const { present } = require('./docs');

const s = (v) => (v == null ? null : String(v).trim() || null);
const bool = (v, d = 0) => (v == null || v === '' ? d : (v === true || v === 1 || v === '1' || v === 'true' ? 1 : 0));
const optMoney = (v, f) => (v == null || v === '' ? null : toMinor(v, f));

function uniqueGuard(fn, msg) {
  try { return fn(); } catch (e) {
    if (e && e.code === 'SQLITE_CONSTRAINT_UNIQUE') fail('DUPLICATE', msg, 409);
    throw e;
  }
}

// ================= الأصناف =================
function itemFields(ctx, input, existing) {
  const name = s(input.name ?? existing?.name);
  if (!name) fail('VALIDATION', 'اسم الصنف مطلوب');
  const baseUnit = s(input.base_unit ?? existing?.base_unit);
  if (!baseUnit) fail('VALIDATION', 'وحدة الأساس مطلوبة');
  const qd = Number(input.qty_decimals ?? existing?.qty_decimals ?? 0);
  if (![0, 1, 2, 3].includes(qd)) fail('VALIDATION', 'دقة الكمية بين 0 و3');
  return {
    name, base_unit: baseUnit, qty_decimals: qd,
    category_id: input.category_id ?? existing?.category_id ?? null,
    brand: input.brand !== undefined ? s(input.brand) : existing?.brand ?? null,
    description: input.description !== undefined ? s(input.description) : existing?.description ?? null,
    track_expiry: input.track_expiry !== undefined ? bool(input.track_expiry) : existing?.track_expiry ?? 1,
    reorder_level: input.reorder_level !== undefined ? (input.reorder_level === '' || input.reorder_level == null ? 0 : toQty(input.reorder_level, 3, 'حد إعادة الطلب')) : existing?.reorder_level ?? 0,
    expiry_alert_days: input.expiry_alert_days !== undefined ? (input.expiry_alert_days === '' || input.expiry_alert_days == null ? null : Number(input.expiry_alert_days)) : existing?.expiry_alert_days ?? null,
    min_price: input.min_price !== undefined ? optMoney(input.min_price, 'السعر الأدنى') : existing?.min_price ?? null,
    max_discount_bp: input.max_discount_pct !== undefined ? (input.max_discount_pct === '' || input.max_discount_pct == null ? null : toBp(input.max_discount_pct, 'حد الخصم')) : existing?.max_discount_bp ?? null,
    tax_rate_bp: input.tax_rate_pct !== undefined ? (input.tax_rate_pct === '' || input.tax_rate_pct == null ? null : toBp(input.tax_rate_pct, 'الضريبة')) : existing?.tax_rate_bp ?? null,
    image: input.image !== undefined ? s(input.image) : existing?.image ?? null,
    active: input.active !== undefined ? bool(input.active, 1) : existing?.active ?? 1,
  };
}

function hasMovements(ctx, itemId) {
  return !!ctx.db.prepare('SELECT 1 FROM stock_moves WHERE item_id=? LIMIT 1').get(itemId)
    || !!ctx.db.prepare("SELECT 1 FROM doc_lines l JOIN docs d ON d.id=l.doc_id WHERE l.item_id=? LIMIT 1").get(itemId);
}

function saveUnits(ctx, item, units) {
  if (!Array.isArray(units)) return;
  for (const u of units) {
    const name = s(u.name);
    if (!name) fail('VALIDATION', 'اسم الوحدة مطلوب');
    const factor = u.is_base ? 1000 : toQty(u.factor, 3, `معامل الوحدة ${name}`);
    if (factor <= 0) fail('VALIDATION', `معامل الوحدة ${name} يجب أن يكون أكبر من صفر`);
    const vals = {
      name, factor, barcode: s(u.barcode), sell_price: u.sell_price == null || u.sell_price === '' ? 0 : toMinor(u.sell_price, `سعر ${name}`),
      for_sale: bool(u.for_sale, 1), for_purchase: bool(u.for_purchase, 1), active: bool(u.active, 1),
    };
    if (vals.sell_price < 0) fail('VALIDATION', 'السعر لا يكون سالبًا');
    uniqueGuard(() => {
      if (u.id) {
        const ex = ctx.db.prepare('SELECT * FROM item_units WHERE id=? AND item_id=?').get(u.id, item.id);
        if (!ex) notFound('الوحدة');
        if (ex.is_base) vals.factor = 1000;
        ctx.db.prepare('UPDATE item_units SET name=?,factor=?,barcode=?,sell_price=?,for_sale=?,for_purchase=?,active=? WHERE id=?')
          .run(vals.name, vals.factor, vals.barcode, vals.sell_price, vals.for_sale, vals.for_purchase, ex.is_base ? 1 : vals.active, ex.id);
      } else {
        ctx.db.prepare('INSERT INTO item_units(item_id,name,factor,barcode,sell_price,is_base,for_sale,for_purchase,active) VALUES(?,?,?,?,?,?,?,?,?)')
          .run(item.id, vals.name, vals.factor, vals.barcode, vals.sell_price, u.is_base ? 1 : 0, vals.for_sale, vals.for_purchase, vals.active);
      }
    }, `الباركود ${vals.barcode || ''} أو اسم الوحدة ${name} مستخدم مسبقًا`);
  }
}

function createItem(ctx, input) {
  ctx.require('items.manage');
  return ctx.tx(() => {
    const f = itemFields(ctx, input);
    const code = s(input.code);
    const id = uniqueGuard(() => ctx.db.prepare(`INSERT INTO items(code,name,category_id,brand,description,base_unit,qty_decimals,track_expiry,reorder_level,
        expiry_alert_days,min_price,max_discount_bp,tax_rate_bp,image,active,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(code || `TMP-${Date.now()}-${Math.random()}`, f.name, f.category_id, f.brand, f.description, f.base_unit, f.qty_decimals, f.track_expiry,
        f.reorder_level, f.expiry_alert_days, f.min_price, f.max_discount_bp, f.tax_rate_bp, f.image, f.active, ctx.now()).lastInsertRowid,
    `كود الصنف ${code} مستخدم مسبقًا`);
    if (!code) ctx.db.prepare('UPDATE items SET code=? WHERE id=?').run(`IT${String(id).padStart(5, '0')}`, id);
    const item = ctx.db.prepare('SELECT * FROM items WHERE id=?').get(id);
    const units = [{ is_base: 1, name: f.base_unit, barcode: input.barcode, sell_price: input.sell_price ?? 0 }, ...(input.units || []).filter((u) => !u.is_base)];
    saveUnits(ctx, item, units);
    ctx.audit('item.create', { entity: 'item', entity_id: id, after: { ...f, code: item.code } });
    return getItemFull(ctx, id);
  });
}

function updateItem(ctx, id, input) {
  ctx.require('items.manage');
  return ctx.tx(() => {
    const ex = ctx.db.prepare('SELECT * FROM items WHERE id=?').get(id);
    if (!ex) notFound('الصنف');
    const f = itemFields(ctx, input, ex);
    if ((f.base_unit !== ex.base_unit || f.qty_decimals !== ex.qty_decimals) && hasMovements(ctx, id)) {
      fail('ITEM_IN_USE', 'لا يمكن تغيير وحدة الأساس أو دقة الكمية لصنف له حركات؛ أنشئ صنفًا جديدًا');
    }
    if (input.code && s(input.code) !== ex.code) {
      uniqueGuard(() => ctx.db.prepare('UPDATE items SET code=? WHERE id=?').run(s(input.code), id), 'كود الصنف مستخدم مسبقًا');
    }
    ctx.db.prepare(`UPDATE items SET name=?,category_id=?,brand=?,description=?,base_unit=?,qty_decimals=?,track_expiry=?,reorder_level=?,
        expiry_alert_days=?,min_price=?,max_discount_bp=?,tax_rate_bp=?,image=?,active=? WHERE id=?`)
      .run(f.name, f.category_id, f.brand, f.description, f.base_unit, f.qty_decimals, f.track_expiry, f.reorder_level, f.expiry_alert_days,
        f.min_price, f.max_discount_bp, f.tax_rate_bp, f.image, f.active, id);
    if (f.base_unit !== ex.base_unit) ctx.db.prepare('UPDATE item_units SET name=? WHERE item_id=? AND is_base=1').run(f.base_unit, id);
    if (input.units) saveUnits(ctx, { id }, input.units);
    ctx.audit('item.update', { entity: 'item', entity_id: id, before: ex, after: f });
    return getItemFull(ctx, id);
  });
}

function getItemFull(ctx, id) {
  const it = ctx.db.prepare(`SELECT i.*, c.name category_name FROM items i LEFT JOIN categories c ON c.id=i.category_id WHERE i.id=?`).get(id);
  if (!it) notFound('الصنف');
  const out = present(it);
  out.units = ctx.db.prepare('SELECT * FROM item_units WHERE item_id=? ORDER BY is_base DESC, factor').all(id).map(present);
  if (!ctx.has('cost.view')) delete out.min_price;
  return out;
}

function listItems(ctx, { q, active, category_id, limit = 200, offset = 0 } = {}) {
  ctx.require('items.view');
  const w = ['1=1'];
  const p = [];
  if (q) { w.push('(i.name LIKE ? OR i.code LIKE ? OR i.id IN (SELECT item_id FROM item_units WHERE barcode=?))'); p.push(`%${q}%`, `%${q}%`, q); }
  if (active !== undefined && active !== '') { w.push('i.active=?'); p.push(bool(active)); }
  if (category_id) { w.push('i.category_id=?'); p.push(category_id); }
  const rows = ctx.db.prepare(`SELECT i.*, c.name category_name FROM items i LEFT JOIN categories c ON c.id=i.category_id WHERE ${w.join(' AND ')}
    ORDER BY i.name LIMIT ? OFFSET ?`).all(...p, Number(limit), Number(offset));
  const total = ctx.db.prepare(`SELECT COUNT(*) n FROM items i WHERE ${w.join(' AND ')}`).get(...p).n;
  const units = ctx.db.prepare('SELECT * FROM item_units WHERE item_id=? ORDER BY is_base DESC, factor');
  return {
    total, rows: rows.map((r) => {
      const o = present(r);
      o.units = units.all(r.id).map(present);
      if (!ctx.has('cost.view')) delete o.min_price;
      return o;
    }),
  };
}

/** بحث نقطة البيع: بالباركود (يحدد الوحدة) أو الاسم */
/** كتالوج مختصر للأصناف النشطة ووحداتها وأرصدتها لنقطة البيع دون اتصال */
function posCatalog(ctx, warehouseId) {
  ctx.require('sales.create');
  const { minSellableExpiry } = require('./inventory');
  const minExp = minSellableExpiry(ctx);
  const items = ctx.db.prepare(`SELECT i.id, i.code, i.name, i.base_unit, i.qty_decimals, i.tax_rate_bp,
      COALESCE((SELECT SUM(qty) FROM batches b WHERE b.item_id=i.id AND b.warehouse_id=? AND b.status='ok' AND (b.expiry_date IS NULL OR b.expiry_date>=?)),0) sellable
    FROM items i WHERE i.active=1 ORDER BY i.name`).all(warehouseId || 0, minExp);
  const units = ctx.db.prepare('SELECT id, item_id, name, factor, barcode, sell_price, is_base, for_sale, active FROM item_units WHERE active=1').all();
  const byItem = new Map();
  for (const u of units) { if (!byItem.has(u.item_id)) byItem.set(u.item_id, []); byItem.get(u.item_id).push(present(u)); }
  return {
    generated_at: ctx.now(), warehouse_id: warehouseId || null,
    scale: { prefix: ctx.setting('scale_prefix') || '', plu: Number(ctx.setting('scale_plu_digits') || 5), val: Number(ctx.setting('scale_value_digits') || 5), mode: ctx.setting('scale_mode') || 'weight' },
    items: items.map((i) => ({ ...present(i), sellable_qty: i.sellable / 1000, units: byItem.get(i.id) || [] })),
  };
}

/**
 * باركود الميزان: بادئة + كود الصنف (PLU) + الوزن بالجرام أو السعر + رقم تحقق.
 * يعيد {code, qty} أو null. الإعدادات: scale_prefix، scale_plu_digits، scale_value_digits، scale_mode (weight|price).
 */
function parseScaleBarcode(ctx, code) {
  const s = ctx.settings();
  const prefix = s.scale_prefix || '';
  const plu = Number(s.scale_plu_digits || 5), val = Number(s.scale_value_digits || 5);
  if (!prefix || !/^\d+$/.test(code) || !code.startsWith(prefix) || code.length !== prefix.length + plu + val + 1) return null;
  const pluCode = code.slice(prefix.length, prefix.length + plu);
  const raw = Number(code.slice(prefix.length + plu, prefix.length + plu + val));
  return { code: pluCode.replace(/^0+(?=\d)/, ''), pluRaw: pluCode, raw, mode: s.scale_mode === 'price' ? 'price' : 'weight' };
}

function lookupItem(ctx, q, warehouseId) {
  ctx.require('items.view');
  const { sellableQty } = require('./inventory');
  const res = [];
  const scale = parseScaleBarcode(ctx, String(q || '').trim());
  if (scale) {
    const it = ctx.db.prepare('SELECT id FROM items WHERE active=1 AND (code=? OR code=?)').get(scale.code, scale.pluRaw);
    if (it) {
      const full = getItemFull(ctx, it.id);
      const base = full.units.find((u) => u.is_base);
      full.selected_unit_id = base.id;
      // الوزن بالجرام ← كجم؛ أو السعر ← الكمية = السعر ÷ سعر وحدة الأساس
      full.scale_qty = scale.mode === 'weight' ? scale.raw / 1000 : (base.sell_price ? Number((scale.raw / 10 ** require('../lib/money').getMoneyDecimals() / base.sell_price).toFixed(full.qty_decimals)) : 0);
      if (warehouseId) full.sellable_qty = sellableQty(ctx, it.id, warehouseId) / 1000;
      return [full];
    }
  }
  const byBarcode = ctx.db.prepare(`SELECT u.*, i.name item_name, i.active item_active FROM item_units u JOIN items i ON i.id=u.item_id
    WHERE u.barcode=? AND u.active=1`).get(String(q || '').trim());
  let items;
  if (byBarcode) items = [{ id: byBarcode.item_id, unit_id: byBarcode.id }];
  else {
    items = ctx.db.prepare(`SELECT id FROM items WHERE active=1 AND (name LIKE ? OR code=?) ORDER BY name LIMIT 20`).all(`%${q}%`, q)
      .map((r) => ({ id: r.id, unit_id: null }));
  }
  for (const it of items) {
    const full = getItemFull(ctx, it.id);
    if (!full.active) continue;
    full.selected_unit_id = it.unit_id || full.units.find((u) => u.is_base).id;
    if (warehouseId) full.sellable_qty = sellableQty(ctx, it.id, warehouseId) / 1000;
    res.push(full);
  }
  return res;
}

// ================= الأطراف =================
function partyFields(input, ex = {}) {
  const name = s(input.name ?? ex.name);
  if (!name) fail('VALIDATION', 'الاسم مطلوب');
  const f = {
    name,
    phone: input.phone !== undefined ? s(input.phone) : ex.phone ?? null,
    address: input.address !== undefined ? s(input.address) : ex.address ?? null,
    is_customer: input.is_customer !== undefined ? bool(input.is_customer) : ex.is_customer ?? 0,
    is_supplier: input.is_supplier !== undefined ? bool(input.is_supplier) : ex.is_supplier ?? 0,
    credit_limit: input.credit_limit !== undefined ? optMoney(input.credit_limit, 'الحد الائتماني') : ex.credit_limit ?? null,
    payment_terms_days: input.payment_terms_days !== undefined ? Number(input.payment_terms_days || 0) : ex.payment_terms_days ?? 0,
    rep_id: input.rep_id !== undefined ? (input.rep_id || null) : ex.rep_id ?? null,
    tax_number: input.tax_number !== undefined ? s(input.tax_number) : ex.tax_number ?? null,
    notes: input.notes !== undefined ? s(input.notes) : ex.notes ?? null,
    active: input.active !== undefined ? bool(input.active, 1) : ex.active ?? 1,
  };
  if (!f.is_customer && !f.is_supplier) fail('VALIDATION', 'حدد هل الطرف عميل أو مورد أو كلاهما');
  if (!Number.isInteger(f.payment_terms_days) || f.payment_terms_days < 0) fail('VALIDATION', 'مدة السداد غير صحيحة');
  return f;
}

function createParty(ctx, input) {
  ctx.require('parties.manage');
  return ctx.tx(() => {
    const f = partyFields(input);
    if (ctx.repScope) f.rep_id = ctx.repScope;
    const id = ctx.db.prepare(`INSERT INTO parties(name,phone,address,is_customer,is_supplier,credit_limit,payment_terms_days,rep_id,tax_number,notes,active,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(f.name, f.phone, f.address, f.is_customer, f.is_supplier, f.credit_limit, f.payment_terms_days,
      f.rep_id, f.tax_number, f.notes, f.active, ctx.now()).lastInsertRowid;
    ctx.audit('party.create', { entity: 'party', entity_id: id, after: f });
    return getParty(ctx, id);
  });
}

function updateParty(ctx, id, input) {
  ctx.require('parties.manage');
  return ctx.tx(() => {
    const ex = getPartyRow(ctx, id);
    const f = partyFields(input, ex);
    if (f.credit_limit !== ex.credit_limit && !ctx.has('credit.override') && !ctx.has('users.manage')) ctx.require('credit.override', 'party.credit_limit');
    ctx.db.prepare(`UPDATE parties SET name=?,phone=?,address=?,is_customer=?,is_supplier=?,credit_limit=?,payment_terms_days=?,rep_id=?,tax_number=?,notes=?,active=? WHERE id=?`)
      .run(f.name, f.phone, f.address, f.is_customer, f.is_supplier, f.credit_limit, f.payment_terms_days, f.rep_id, f.tax_number, f.notes, f.active, id);
    ctx.audit('party.update', { entity: 'party', entity_id: id, before: ex, after: f });
    return getParty(ctx, id);
  });
}

function getPartyRow(ctx, id) {
  const p = ctx.db.prepare('SELECT * FROM parties WHERE id=?').get(id);
  if (!p) notFound('الطرف');
  if (ctx.repScope && p.rep_id !== ctx.repScope) fail('FORBIDDEN', 'هذا العميل خارج نطاقك', 403);
  return p;
}

function getParty(ctx, id) {
  ctx.require('parties.view');
  const { balance } = require('./ledger');
  const p = present(getPartyRow(ctx, id));
  p.ar_balance = balance(ctx.db, 'AR', { party_id: id }) / 10 ** require('../lib/money').getMoneyDecimals();
  p.ap_balance = -balance(ctx.db, 'AP', { party_id: id }) / 10 ** require('../lib/money').getMoneyDecimals();
  p.rep_name = p.rep_id ? (ctx.db.prepare('SELECT name FROM reps WHERE id=?').get(p.rep_id) || {}).name : null;
  return p;
}

function listParties(ctx, { q, type, active, limit = 200, offset = 0 } = {}) {
  ctx.require('parties.view');
  const w = ['1=1'];
  const p = [];
  if (q) { w.push('(name LIKE ? OR phone LIKE ?)'); p.push(`%${q}%`, `%${q}%`); }
  if (type === 'customer') w.push('is_customer=1');
  if (type === 'supplier') w.push('is_supplier=1');
  if (active !== undefined && active !== '') { w.push('active=?'); p.push(bool(active)); }
  if (ctx.repScope) { w.push('rep_id=?'); p.push(ctx.repScope); }
  const rows = ctx.db.prepare(`SELECT p.*,
      (SELECT COALESCE(SUM(debit-credit),0) FROM journal_lines WHERE account='AR' AND party_id=p.id) ar,
      (SELECT COALESCE(SUM(credit-debit),0) FROM journal_lines WHERE account='AP' AND party_id=p.id) ap,
      (SELECT name FROM reps WHERE id=p.rep_id) rep_name
    FROM parties p WHERE ${w.join(' AND ')} ORDER BY name LIMIT ? OFFSET ?`).all(...p, Number(limit), Number(offset));
  const total = ctx.db.prepare(`SELECT COUNT(*) n FROM parties WHERE ${w.join(' AND ')}`).get(...p).n;
  const { fromMinor } = require('../lib/money');
  return { total, rows: rows.map((r) => ({ ...present(r), ar_balance: fromMinor(r.ar), ap_balance: fromMinor(r.ap) })) };
}

// ================= المستودعات والحسابات والتصنيفات =================
function simpleList(ctx, table, perm) {
  if (perm) ctx.require(perm);
  return ctx.db.prepare(`SELECT * FROM ${table} ORDER BY active DESC, name`).all();
}

function listWarehouses(ctx, { all } = {}) {
  // all: كل المستودعات (لاختيار وجهة تحويل لفرع آخر)
  const scope = all ? null : ctx.branchScope;
  return ctx.db.prepare(`SELECT w.*, b.name branch_name, r.name rep_name FROM warehouses w JOIN branches b ON b.id=w.branch_id
    LEFT JOIN reps r ON r.id=w.rep_id ${scope ? 'WHERE w.branch_id=' + Number(scope) : ''} ORDER BY w.active DESC, w.kind, w.name`).all();
}

// ================= الفروع =================
function listBranches(ctx) {
  const scope = ctx.branchScope;
  return ctx.db.prepare(`SELECT b.*, (SELECT COUNT(*) FROM warehouses WHERE branch_id=b.id) warehouses,
      (SELECT COUNT(*) FROM users WHERE branch_id=b.id) users FROM branches b ${scope ? 'WHERE b.id=' + Number(scope) : ''} ORDER BY b.id`).all();
}

function saveBranch(ctx, input, id) {
  ctx.require('warehouses.manage');
  return ctx.tx(() => uniqueGuard(() => {
    const name = s(input.name);
    if (!name) fail('VALIDATION', 'اسم الفرع مطلوب');
    if (id) {
      const ex = ctx.db.prepare('SELECT * FROM branches WHERE id=?').get(id);
      if (!ex) notFound('الفرع');
      const active = input.active !== undefined ? bool(input.active, 1) : ex.active;
      if (!active && ctx.db.prepare('SELECT 1 FROM batches b JOIN warehouses w ON w.id=b.warehouse_id WHERE w.branch_id=? AND b.qty>0').get(id)) fail('IN_USE', 'لا يمكن إيقاف فرع في مستودعاته رصيد');
      ctx.db.prepare('UPDATE branches SET name=?, address=?, phone=?, active=? WHERE id=?')
        .run(name, input.address !== undefined ? s(input.address) : ex.address, input.phone !== undefined ? s(input.phone) : ex.phone, active, id);
      ctx.audit('branch.update', { entity: 'branch', entity_id: id, before: ex, after: input });
      return ctx.db.prepare('SELECT * FROM branches WHERE id=?').get(id);
    }
    const nid = ctx.db.prepare('INSERT INTO branches(name,address,phone) VALUES(?,?,?)').run(name, s(input.address), s(input.phone)).lastInsertRowid;
    // كل فرع جديد يبدأ بمستودع وصندوق
    ctx.db.prepare("INSERT INTO warehouses(branch_id,name,kind) VALUES(?,?,'main')").run(nid, `مستودع ${name}`);
    ctx.db.prepare("INSERT INTO cash_accounts(name,kind,branch_id) VALUES(?,'cash',?)").run(`صندوق ${name}`, nid);
    ctx.audit('branch.create', { entity: 'branch', entity_id: nid, after: input });
    return ctx.db.prepare('SELECT * FROM branches WHERE id=?').get(nid);
  }, 'اسم الفرع أو مستودعه أو صندوقه مستخدم مسبقًا'));
}

function branchOf(ctx, id) {
  const b = ctx.db.prepare('SELECT * FROM branches WHERE id=? AND active=1').get(id);
  if (!b) fail('VALIDATION', 'الفرع غير صحيح');
  return b.id;
}

function saveWarehouse(ctx, input, id) {
  ctx.require('warehouses.manage');
  return ctx.tx(() => {
    const name = s(input.name);
    if (!name) fail('VALIDATION', 'اسم المستودع مطلوب');
    const branch = input.branch_id ? branchOf(ctx, input.branch_id) : (ctx.branchScope || ctx.db.prepare('SELECT id FROM branches ORDER BY id LIMIT 1').get().id);
    ctx.checkBranch(branch);
    return uniqueGuard(() => {
      if (id) {
        const ex = ctx.db.prepare('SELECT * FROM warehouses WHERE id=?').get(id);
        if (!ex) notFound('المستودع');
        const active = input.active !== undefined ? bool(input.active, 1) : ex.active;
        if (!active && ctx.db.prepare('SELECT 1 FROM batches WHERE warehouse_id=? AND qty>0').get(id)) fail('IN_USE', 'لا يمكن إيقاف مستودع به رصيد');
        ctx.db.prepare('UPDATE warehouses SET name=?, branch_id=?, active=? WHERE id=?').run(name, branch, active, id);
        ctx.audit('warehouse.update', { entity: 'warehouse', entity_id: id, before: ex, after: input });
        return ctx.db.prepare('SELECT * FROM warehouses WHERE id=?').get(id);
      }
      const nid = ctx.db.prepare("INSERT INTO warehouses(branch_id,name,kind) VALUES(?,?,'main')").run(branch, name).lastInsertRowid;
      ctx.audit('warehouse.create', { entity: 'warehouse', entity_id: nid, after: input });
      return ctx.db.prepare('SELECT * FROM warehouses WHERE id=?').get(nid);
    }, 'اسم المستودع مستخدم');
  });
}

function listCashAccounts(ctx) {
  const rows = ctx.db.prepare(`SELECT c.*, r.name rep_name,
      (SELECT COALESCE(SUM(debit-credit),0) FROM journal_lines WHERE account='CASH' AND cash_account_id=c.id) bal
    FROM cash_accounts c LEFT JOIN reps r ON r.id=c.rep_id ${ctx.branchScope ? 'WHERE c.branch_id=' + Number(ctx.branchScope) : ''} ORDER BY c.active DESC, c.kind, c.name`).all();
  const { fromMinor } = require('../lib/money');
  const showBal = ctx.has('cash.view');
  return rows.map((r) => ({ ...r, balance: showBal ? fromMinor(r.bal) : undefined, bal: undefined }));
}

function saveCashAccount(ctx, input, id) {
  ctx.require('warehouses.manage');
  return ctx.tx(() => {
    const name = s(input.name);
    if (!name) fail('VALIDATION', 'الاسم مطلوب');
    return uniqueGuard(() => {
      if (id) {
        const ex = ctx.db.prepare('SELECT * FROM cash_accounts WHERE id=?').get(id);
        if (!ex) notFound('الحساب');
        ctx.db.prepare('UPDATE cash_accounts SET name=?, active=? WHERE id=?').run(name, input.active !== undefined ? bool(input.active, 1) : ex.active, id);
        ctx.audit('cash_account.update', { entity: 'cash_account', entity_id: id, before: ex, after: input });
        return ctx.db.prepare('SELECT * FROM cash_accounts WHERE id=?').get(id);
      }
      const kind = input.kind === 'bank' ? 'bank' : 'cash';
      const branch = input.branch_id ? branchOf(ctx, input.branch_id) : (ctx.branchScope || ctx.db.prepare('SELECT id FROM branches ORDER BY id LIMIT 1').get().id);
      ctx.checkBranch(branch);
      const nid = ctx.db.prepare('INSERT INTO cash_accounts(name,kind,branch_id) VALUES(?,?,?)').run(name, kind, branch).lastInsertRowid;
      ctx.audit('cash_account.create', { entity: 'cash_account', entity_id: nid, after: input });
      return ctx.db.prepare('SELECT * FROM cash_accounts WHERE id=?').get(nid);
    }, 'اسم الحساب مستخدم');
  });
}

function saveCategory(ctx, table, input, id) {
  ctx.require(table === 'categories' ? 'items.manage' : 'expenses.approve');
  return ctx.tx(() => uniqueGuard(() => {
    const name = s(input.name);
    if (!name) fail('VALIDATION', 'الاسم مطلوب');
    if (id) {
      ctx.db.prepare(`UPDATE ${table} SET name=?, active=? WHERE id=?`).run(name, input.active !== undefined ? bool(input.active, 1) : 1, id);
      return ctx.db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id);
    }
    const nid = ctx.db.prepare(`INSERT INTO ${table}(name) VALUES(?)`).run(name).lastInsertRowid;
    return ctx.db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(nid);
  }, 'الاسم مستخدم مسبقًا'));
}

// ================= المناديب =================
function createRep(ctx, input) {
  ctx.require('warehouses.manage');
  return ctx.tx(() => {
    const name = s(input.name);
    if (!name) fail('VALIDATION', 'اسم المندوب مطلوب');
    const branch = input.branch_id ? branchOf(ctx, input.branch_id) : (ctx.branchScope || ctx.db.prepare('SELECT id FROM branches ORDER BY id LIMIT 1').get().id);
    const repId = ctx.db.prepare('INSERT INTO reps(name,phone,area) VALUES(?,?,?)').run(name, s(input.phone), s(input.area)).lastInsertRowid;
    const wh = uniqueGuard(() => ctx.db.prepare("INSERT INTO warehouses(branch_id,name,kind,rep_id) VALUES(?,?,'rep',?)").run(branch, `مخزون المندوب ${name}`, repId).lastInsertRowid, 'يوجد مستودع بنفس اسم المندوب');
    const ca = uniqueGuard(() => ctx.db.prepare("INSERT INTO cash_accounts(name,kind,branch_id,rep_id) VALUES(?,'rep_custody',?,?)").run(`عهدة المندوب ${name}`, branch, repId).lastInsertRowid, 'يوجد حساب عهدة بنفس الاسم');
    ctx.db.prepare('UPDATE reps SET warehouse_id=?, custody_account_id=? WHERE id=?').run(wh, ca, repId);
    if (input.commission_pct != null && input.commission_pct !== '') {
      ctx.db.prepare('INSERT INTO commission_plans(rep_id,rate_bp,valid_from) VALUES(?,?,?)').run(repId, toBp(input.commission_pct, 'نسبة العمولة'), input.commission_from || '2000-01-01');
    }
    ctx.audit('rep.create', { entity: 'rep', entity_id: repId, after: input });
    return getRep(ctx, repId);
  });
}

function updateRep(ctx, id, input) {
  ctx.require('warehouses.manage');
  return ctx.tx(() => {
    const ex = ctx.db.prepare('SELECT * FROM reps WHERE id=?').get(id);
    if (!ex) notFound('المندوب');
    ctx.db.prepare('UPDATE reps SET name=?, phone=?, area=?, active=? WHERE id=?')
      .run(s(input.name) || ex.name, input.phone !== undefined ? s(input.phone) : ex.phone, input.area !== undefined ? s(input.area) : ex.area,
        input.active !== undefined ? bool(input.active, 1) : ex.active, id);
    ctx.audit('rep.update', { entity: 'rep', entity_id: id, before: ex, after: input });
    return getRep(ctx, id);
  });
}

function addCommissionPlan(ctx, repId, { rate_pct, valid_from, reason }) {
  ctx.require('commissions.plans');
  return ctx.tx(() => {
    const { checkDate } = require('../lib/dates');
    const from = checkDate(valid_from, 'تاريخ السريان');
    const r = ctx.requireReason(reason, 'تغيير خطة العمولة');
    ctx.db.prepare('UPDATE commission_plans SET valid_to=? WHERE rep_id=? AND valid_to IS NULL AND valid_from<?').run(require('../lib/dates').addDays(from, -1), repId, from);
    const id = ctx.db.prepare('INSERT INTO commission_plans(rep_id,rate_bp,valid_from) VALUES(?,?,?)').run(repId, toBp(rate_pct, 'نسبة العمولة'), from).lastInsertRowid;
    ctx.audit('commission_plan.create', { entity: 'rep', entity_id: repId, reason: r, after: { rate_pct, valid_from } });
    return id;
  });
}

function getRep(ctx, id) {
  const r = ctx.db.prepare(`SELECT r.*, w.name warehouse_name, c.name custody_name FROM reps r
    LEFT JOIN warehouses w ON w.id=r.warehouse_id LEFT JOIN cash_accounts c ON c.id=r.custody_account_id WHERE r.id=?`).get(id);
  if (!r) notFound('المندوب');
  r.plans = ctx.db.prepare('SELECT * FROM commission_plans WHERE rep_id=? ORDER BY valid_from').all(id).map(present);
  return r;
}

function listReps(ctx) {
  return ctx.db.prepare(`SELECT r.*, w.name warehouse_name, c.name custody_name,
      (SELECT rate_bp FROM commission_plans p WHERE p.rep_id=r.id ORDER BY valid_from DESC LIMIT 1) rate_bp
    FROM reps r LEFT JOIN warehouses w ON w.id=r.warehouse_id LEFT JOIN cash_accounts c ON c.id=r.custody_account_id ORDER BY r.active DESC, r.name`).all().map(present);
}

module.exports = {
  createItem, updateItem, getItemFull, listItems, lookupItem, posCatalog, createParty, updateParty, getParty, getPartyRow, listParties,
  simpleList, listWarehouses, listBranches, saveBranch, saveWarehouse, listCashAccounts, saveCashAccount, saveCategory, createRep, updateRep, getRep, listReps, addCommissionPlan,
};
