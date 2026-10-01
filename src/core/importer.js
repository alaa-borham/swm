'use strict';
// الاستيراد من Excel/CSV مع معاينة وتحقق من التكرار والأخطاء قبل الاعتماد.
const ExcelJS = require('exceljs');
const { fail } = require('../lib/errors');
const M = require('./masters');
const S = require('./stock');
const F = require('./finance');

const TEMPLATES = {
  items: {
    label: 'الأصناف',
    columns: ['الكود', 'الاسم', 'التصنيف', 'وحدة الأساس', 'دقة الكمية', 'باركود الأساس', 'سعر الأساس', 'وحدة 2', 'معامل وحدة 2', 'باركود وحدة 2', 'سعر وحدة 2', 'الضريبة %', 'حد إعادة الطلب', 'تتبع الصلاحية'],
  },
  parties: {
    label: 'العملاء والموردون',
    columns: ['الاسم', 'الهاتف', 'العنوان', 'عميل', 'مورد', 'الحد الائتماني', 'مدة السداد', 'الرقم الضريبي', 'الرصيد الافتتاحي للعميل', 'الرصيد الافتتاحي للمورد'],
  },
  stock: {
    label: 'المخزون الافتتاحي',
    columns: ['كود الصنف', 'الكمية بوحدة الأساس', 'تكلفة الوحدة', 'رقم الدفعة', 'تاريخ الإنتاج', 'تاريخ الانتهاء'],
  },
};

async function parseFile(buf, filename) {
  const lower = String(filename || '').toLowerCase();
  if (lower.endsWith('.csv')) {
    const text = buf.toString('utf8').replace(/^﻿/, '');
    return text.split(/\r?\n/).filter((l) => l.trim()).map(parseCsvLine);
  }
  if (!lower.endsWith('.xlsx')) fail('VALIDATION', 'الملف يجب أن يكون xlsx أو csv');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const ws = wb.worksheets[0];
  if (!ws) fail('VALIDATION', 'الملف لا يحتوي على ورقة');
  const rows = [];
  ws.eachRow({ includeEmpty: false }, (row) => {
    const vals = [];
    for (let i = 1; i <= ws.columnCount; i++) {
      let v = row.getCell(i).value;
      if (v && typeof v === 'object') {
        if (v instanceof Date) v = v.toISOString().slice(0, 10);
        else if (v.text !== undefined) v = v.text;
        else if (v.result !== undefined) v = v.result;
        else if (v.richText) v = v.richText.map((t) => t.text).join('');
      }
      vals.push(v == null ? '' : String(v).trim());
    }
    rows.push(vals);
  });
  return rows;
}

function parseCsvLine(line) {
  const out = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') inQ = false; else cur += c;
    } else if (c === '"') inQ = true; else if (c === ',') { out.push(cur.trim()); cur = ''; } else cur += c;
  }
  out.push(cur.trim());
  return out;
}

const yes = (v) => ['1', 'نعم', 'yes', 'true', 'y', '✓'].includes(String(v || '').trim().toLowerCase());

function mapRows(kind, rows) {
  const tpl = TEMPLATES[kind];
  if (!tpl) fail('VALIDATION', 'نوع الاستيراد غير معروف');
  if (!rows.length) fail('VALIDATION', 'الملف فارغ');
  const header = rows[0].map((h) => String(h).trim());
  const idx = tpl.columns.map((c) => header.indexOf(c));
  const missing = tpl.columns.filter((c, i) => idx[i] < 0 && ['الاسم', 'وحدة الأساس', 'كود الصنف', 'الكمية بوحدة الأساس'].includes(c));
  if (missing.length) fail('VALIDATION', `أعمدة ناقصة: ${missing.join('، ')}`);
  return rows.slice(1).map((r, n) => {
    const o = { _row: n + 2 };
    tpl.columns.forEach((c, i) => { o[c] = idx[i] >= 0 ? r[idx[i]] ?? '' : ''; });
    return o;
  }).filter((o) => tpl.columns.some((c) => o[c] !== ''));
}

/** معاينة: تعيد الصفوف مع أخطاء كل صف دون أي تغيير */
function preview(ctx, kind, rows) {
  ctx.require('import.manage');
  const data = mapRows(kind, rows);
  const seen = new Map();
  const out = data.map((r) => {
    const errors = [];
    if (kind === 'items') {
      if (!r['الاسم']) errors.push('الاسم مطلوب');
      if (!r['وحدة الأساس']) errors.push('وحدة الأساس مطلوبة');
      for (const k of ['الكود', 'باركود الأساس', 'باركود وحدة 2']) {
        const v = r[k];
        if (!v) continue;
        const key = (k === 'الكود' ? 'code:' : 'bc:') + v;
        if (seen.has(key)) errors.push(`${k} ${v} مكرر في الملف (الصف ${seen.get(key)})`); else seen.set(key, r._row);
        if (k === 'الكود' && ctx.db.prepare('SELECT 1 FROM items WHERE code=?').get(v)) errors.push(`الكود ${v} موجود مسبقًا`);
        if (k !== 'الكود' && ctx.db.prepare('SELECT 1 FROM item_units WHERE barcode=?').get(v)) errors.push(`الباركود ${v} موجود مسبقًا`);
      }
      if (r['وحدة 2'] && !(Number(r['معامل وحدة 2']) > 0)) errors.push('معامل الوحدة الثانية مطلوب');
      for (const k of ['سعر الأساس', 'سعر وحدة 2', 'الضريبة %', 'حد إعادة الطلب', 'دقة الكمية']) if (r[k] !== '' && !Number.isFinite(Number(r[k]))) errors.push(`${k} ليس رقمًا`);
    } else if (kind === 'parties') {
      if (!r['الاسم']) errors.push('الاسم مطلوب');
      if (!yes(r['عميل']) && !yes(r['مورد'])) errors.push('حدد عميل أو مورد');
      const key = 'p:' + r['الاسم'] + '|' + r['الهاتف'];
      if (seen.has(key)) errors.push(`مكرر في الملف (الصف ${seen.get(key)})`); else seen.set(key, r._row);
      if (ctx.db.prepare('SELECT 1 FROM parties WHERE name=? AND COALESCE(phone,\'\')=?').get(r['الاسم'], r['الهاتف'] || '')) errors.push('الطرف موجود مسبقًا بنفس الاسم والهاتف');
      for (const k of ['الحد الائتماني', 'مدة السداد', 'الرصيد الافتتاحي للعميل', 'الرصيد الافتتاحي للمورد']) if (r[k] !== '' && !Number.isFinite(Number(r[k]))) errors.push(`${k} ليس رقمًا`);
    } else if (kind === 'stock') {
      const it = ctx.db.prepare('SELECT * FROM items WHERE code=?').get(r['كود الصنف']);
      if (!it) errors.push(`الصنف ${r['كود الصنف']} غير موجود`);
      if (!(Number(r['الكمية بوحدة الأساس']) > 0)) errors.push('الكمية يجب أن تكون أكبر من صفر');
      if (r['تكلفة الوحدة'] === '' || !(Number(r['تكلفة الوحدة']) >= 0)) errors.push('تكلفة الوحدة مطلوبة');
      if (it && it.track_expiry && !r['تاريخ الانتهاء']) errors.push('تاريخ الانتهاء مطلوب');
      for (const k of ['تاريخ الإنتاج', 'تاريخ الانتهاء']) if (r[k] && !/^\d{4}-\d{2}-\d{2}$/.test(r[k])) errors.push(`${k} بصيغة YYYY-MM-DD`);
    }
    return { ...r, _errors: errors };
  });
  return { kind, columns: TEMPLATES[kind].columns, rows: out, valid: out.filter((r) => !r._errors.length).length, invalid: out.filter((r) => r._errors.length).length };
}

/** الاعتماد: لا يُنفذ إلا إذا خلت كل الصفوف من الأخطاء، وفي معاملة واحدة */
function commit(ctx, kind, rows, opts = {}) {
  const pv = preview(ctx, kind, rows);
  if (pv.invalid) fail('IMPORT_ERRORS', `يوجد ${pv.invalid} صف به أخطاء؛ صححها ثم أعد المعاينة`, 400, { rows: pv.rows.filter((r) => r._errors.length) });
  return ctx.tx(() => {
    let n = 0;
    if (kind === 'items') {
      for (const r of pv.rows) {
        let cat = null;
        if (r['التصنيف']) {
          cat = ctx.db.prepare('SELECT id FROM categories WHERE name=?').get(r['التصنيف']);
          if (!cat) cat = { id: ctx.db.prepare('INSERT INTO categories(name) VALUES(?)').run(r['التصنيف']).lastInsertRowid };
        }
        M.createItem(ctx, {
          code: r['الكود'] || null, name: r['الاسم'], category_id: cat ? cat.id : null, base_unit: r['وحدة الأساس'], qty_decimals: Number(r['دقة الكمية'] || 0),
          barcode: r['باركود الأساس'] || null, sell_price: r['سعر الأساس'] || 0, tax_rate_pct: r['الضريبة %'] === '' ? null : r['الضريبة %'],
          reorder_level: r['حد إعادة الطلب'] || 0, track_expiry: r['تتبع الصلاحية'] === '' ? 1 : (yes(r['تتبع الصلاحية']) ? 1 : 0),
          units: r['وحدة 2'] ? [{ name: r['وحدة 2'], factor: r['معامل وحدة 2'], barcode: r['باركود وحدة 2'] || null, sell_price: r['سعر وحدة 2'] || 0 }] : [],
        });
        n++;
      }
    } else if (kind === 'parties') {
      for (const r of pv.rows) {
        const p = M.createParty(ctx, {
          name: r['الاسم'], phone: r['الهاتف'], address: r['العنوان'], is_customer: yes(r['عميل']), is_supplier: yes(r['مورد']),
          credit_limit: r['الحد الائتماني'] === '' ? null : r['الحد الائتماني'], payment_terms_days: r['مدة السداد'] || 0, tax_number: r['الرقم الضريبي'],
        });
        if (Number(r['الرصيد الافتتاحي للعميل'])) F.createOpeningBalance(ctx, { kind: 'customer', party_id: p.id, amount: r['الرصيد الافتتاحي للعميل'], date: opts.date });
        if (Number(r['الرصيد الافتتاحي للمورد'])) F.createOpeningBalance(ctx, { kind: 'supplier', party_id: p.id, amount: r['الرصيد الافتتاحي للمورد'], date: opts.date });
        n++;
      }
    } else if (kind === 'stock') {
      const lines = pv.rows.map((r) => ({
        item_id: ctx.db.prepare('SELECT id FROM items WHERE code=?').get(r['كود الصنف']).id, qty: r['الكمية بوحدة الأساس'], unit_cost: r['تكلفة الوحدة'],
        batch_no: r['رقم الدفعة'] || null, prod_date: r['تاريخ الإنتاج'] || null, expiry_date: r['تاريخ الانتهاء'] || null,
      }));
      S.createOpeningStock(ctx, { warehouse_id: opts.warehouse_id, date: opts.date, lines });
      n = lines.length;
    }
    ctx.audit('import.commit', { entity: kind, after: { rows: n } });
    return { imported: n };
  });
}

async function templateXlsx(kind) {
  const tpl = TEMPLATES[kind];
  if (!tpl) fail('VALIDATION', 'نوع غير معروف');
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(tpl.label, { views: [{ rightToLeft: true }] });
  ws.addRow(tpl.columns);
  ws.getRow(1).font = { bold: true };
  ws.columns.forEach((c) => { c.width = 18; });
  return wb.xlsx.writeBuffer();
}

module.exports = { parseFile, preview, commit, templateXlsx, TEMPLATES };
