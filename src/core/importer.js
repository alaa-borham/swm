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
    columns: ['الكود', 'الاسم', 'التصنيف', 'وحدة المنتج', 'دقة الكمية', 'باركود وحدة المنتج', 'سعر شراء وحدة المنتج', 'نسبة الربح %', 'سعر بيع وحدة المنتج',
      'وحدة 2', 'معامل وحدة 2', 'باركود وحدة 2', 'سعر شراء وحدة 2', 'سعر بيع وحدة 2', 'وحدة الإدخال', 'الضريبة %', 'حد إعادة الطلب', 'تتبع الصلاحية'],
    // أسماء أعمدة القالب القديم مقبولة
    aliases: { 'وحدة الأساس': 'وحدة المنتج', 'باركود الأساس': 'باركود وحدة المنتج', 'سعر الأساس': 'سعر بيع وحدة المنتج', 'سعر وحدة 2': 'سعر بيع وحدة 2' },
    required: ['الاسم', 'وحدة المنتج'],
  },
  parties: {
    label: 'العملاء والموردون',
    columns: ['الاسم', 'الهاتف', 'العنوان', 'عميل', 'مورد', 'المندوب', 'الحد الائتماني', 'مدة السداد', 'الرقم الضريبي', 'الرصيد الافتتاحي للعميل', 'الرصيد الافتتاحي للمورد'],
    aliases: { 'اسم العميل': 'الاسم', 'الجوال': 'الهاتف', 'رقم الجوال': 'الهاتف', 'الرقم الضريبي للعميل': 'الرقم الضريبي', 'الرصيد الافتتاحي': 'الرصيد الافتتاحي للعميل' },
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

const no = (v) => ['0', 'لا', 'no', 'false', 'n'].includes(String(v || '').trim().toLowerCase());
// إكسيل يحذف الصفر الأول من أرقام الجوال (551234567)؛ نعيده
const fixPhone = (v) => { const t = String(v || '').replace(/\s+/g, ''); return /^5\d{8}$/.test(t) ? '0' + t : t; };
// المندوب بالاسم: فارغ = بدون مندوب، «الكل» = لكل المناديب
const repOf = (ctx, v) => {
  const t = String(v || '').trim();
  if (!t) return { rep_id: null };
  if (['الكل', 'كل المناديب', 'للكل'].includes(t)) return { rep_id: 'all' };
  const r = ctx.db.prepare('SELECT id FROM reps WHERE name=? OR TRIM(name)=?').get(t, t);
  return r ? { rep_id: r.id } : null;
};
const yes = (v) => ['1', 'نعم', 'yes', 'true', 'y', '✓'].includes(String(v || '').trim().toLowerCase());

function mapRows(kind, rows) {
  const tpl = TEMPLATES[kind];
  if (!tpl) fail('VALIDATION', 'نوع الاستيراد غير معروف');
  if (!rows.length) fail('VALIDATION', 'الملف فارغ');
  const header = rows[0].map((h) => { const t = String(h).trim(); return (tpl.aliases && tpl.aliases[t]) || t; });
  const idx = tpl.columns.map((c) => header.indexOf(c));
  const missing = tpl.columns.filter((c, i) => idx[i] < 0 && (tpl.required || ['الاسم', 'كود الصنف', 'الكمية بوحدة الأساس']).includes(c));
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
      if (!r['وحدة المنتج']) errors.push('وحدة المنتج مطلوبة');
      for (const k of ['الكود', 'باركود وحدة المنتج', 'باركود وحدة 2']) {
        const v = r[k];
        if (!v) continue;
        const key = (k === 'الكود' ? 'code:' : 'bc:') + v;
        if (seen.has(key)) errors.push(`${k} ${v} مكرر في الملف (الصف ${seen.get(key)})`); else seen.set(key, r._row);
        if (k === 'الكود' && ctx.db.prepare('SELECT 1 FROM items WHERE code=?').get(v)) errors.push(`الكود ${v} موجود مسبقًا`);
        if (k !== 'الكود' && ctx.db.prepare('SELECT 1 FROM item_units WHERE barcode=?').get(v)) errors.push(`الباركود ${v} موجود مسبقًا`);
      }
      if (r['وحدة 2'] && !(Number(r['معامل وحدة 2']) > 0)) errors.push('معامل الوحدة الثانية مطلوب');
      for (const k of ['سعر شراء وحدة المنتج', 'نسبة الربح %', 'سعر بيع وحدة المنتج', 'سعر شراء وحدة 2', 'سعر بيع وحدة 2', 'الضريبة %', 'حد إعادة الطلب', 'دقة الكمية']) if (r[k] !== '' && !Number.isFinite(Number(r[k]))) errors.push(`${k} ليس رقمًا`);
      if (r['وحدة الإدخال'] && !['', 'وحدة المنتج', 'الأساس', 'وحدة 2', r['وحدة المنتج'], r['وحدة 2']].includes(r['وحدة الإدخال'])) errors.push('وحدة الإدخال يجب أن تكون اسم وحدة المنتج أو اسم الوحدة 2');
      if (r['وحدة الإدخال'] && [r['وحدة 2'], 'وحدة 2'].includes(r['وحدة الإدخال']) && !r['وحدة 2']) errors.push('وحدة الإدخال هي الوحدة 2 لكن الوحدة 2 فارغة');
    } else if (kind === 'parties') {
      r['الهاتف'] = fixPhone(r['الهاتف']);
      // عمودا عميل/مورد فارغان = عميل
      if (r['عميل'] === '' && r['مورد'] === '') r['عميل'] = 'نعم';
      if (!r['الاسم']) errors.push('الاسم مطلوب');
      if (!yes(r['عميل']) && !yes(r['مورد'])) errors.push('حدد عميل أو مورد');
      if (r['المندوب'] && !repOf(ctx, r['المندوب'])) errors.push(`المندوب «${r['المندوب']}» غير موجود`);
      if (r['الرقم الضريبي'] && !/^\d{15}$/.test(String(r['الرقم الضريبي']).trim())) errors.push('الرقم الضريبي يجب أن يكون 15 رقمًا');
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
        // وحدة الإدخال (الشراء): الوحدة 2 إن حُددت باسمها أو بـ«وحدة 2»، وإلا وحدة المنتج
        const entry2 = !!r['وحدة 2'] && [r['وحدة 2'], 'وحدة 2'].includes(r['وحدة الإدخال']);
        M.createItem(ctx, {
          code: r['الكود'] || null, name: r['الاسم'], category_id: cat ? cat.id : null, base_unit: r['وحدة المنتج'], qty_decimals: Number(r['دقة الكمية'] || 0),
          barcode: r['باركود وحدة المنتج'] || null, sell_price: r['سعر بيع وحدة المنتج'] || 0, tax_rate_pct: r['الضريبة %'] === '' ? null : r['الضريبة %'],
          purchase_price: r['سعر شراء وحدة المنتج'] === '' ? undefined : r['سعر شراء وحدة المنتج'], profit_margin: r['نسبة الربح %'] === '' ? undefined : r['نسبة الربح %'],
          base_for_purchase: entry2 ? 0 : 1,
          reorder_level: r['حد إعادة الطلب'] || 0, track_expiry: r['تتبع الصلاحية'] === '' ? 1 : (yes(r['تتبع الصلاحية']) ? 1 : 0),
          units: r['وحدة 2'] ? [{ name: r['وحدة 2'], factor: r['معامل وحدة 2'], barcode: r['باركود وحدة 2'] || null, sell_price: r['سعر بيع وحدة 2'] || 0,
            purchase_price: r['سعر شراء وحدة 2'] === '' ? undefined : r['سعر شراء وحدة 2'], profit_margin: r['نسبة الربح %'] === '' ? undefined : r['نسبة الربح %'], for_purchase: entry2 ? 1 : 0 }] : [],
        });
        n++;
      }
    } else if (kind === 'parties') {
      for (const r of pv.rows) {
        const p = M.createParty(ctx, {
          name: r['الاسم'], phone: r['الهاتف'], address: r['العنوان'], is_customer: yes(r['عميل']), is_supplier: yes(r['مورد']),
          credit_limit: r['الحد الائتماني'] === '' ? null : r['الحد الائتماني'], payment_terms_days: r['مدة السداد'] || 0, tax_number: r['الرقم الضريبي'] || null,
          ...(yes(r['عميل']) ? repOf(ctx, r['المندوب']) : {}),
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
  // الورقة الأولى هي التي تُستورد: العناوين فقط وتُملأ من الصف الثاني
  const ws = wb.addWorksheet(tpl.label, { views: [{ rightToLeft: true, state: 'frozen', ySplit: 1 }] });
  ws.addRow(tpl.columns);
  const head = ws.getRow(1);
  head.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E79' } };
  head.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
  head.height = 32;
  ws.columns.forEach((c, i) => { c.width = Math.max(14, String(tpl.columns[i]).length + 4); });
  if (kind === 'items') {
    const col = (name) => tpl.columns.indexOf(name) + 1;
    const req = ['الاسم', 'وحدة المنتج'];
    for (const n of req) ws.getCell(1, col(n)).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFC00000' } };
    ws.getColumn(col('الاسم')).width = 28;
    // قوائم منسدلة وتحقق من الأرقام لـ 1000 صف
    for (let r = 2; r <= 1001; r++) {
      ws.getCell(r, col('تتبع الصلاحية')).dataValidation = { type: 'list', allowBlank: true, formulae: ['"نعم,لا"'] };
      ws.getCell(r, col('دقة الكمية')).dataValidation = { type: 'list', allowBlank: true, formulae: ['"0,1,2,3"'] };
      for (const n of ['سعر شراء وحدة المنتج', 'نسبة الربح %', 'سعر بيع وحدة المنتج', 'معامل وحدة 2', 'سعر شراء وحدة 2', 'سعر بيع وحدة 2', 'الضريبة %', 'حد إعادة الطلب']) {
        ws.getCell(r, col(n)).dataValidation = { type: 'decimal', operator: 'greaterThanOrEqual', allowBlank: true, formulae: [0], showErrorMessage: true, error: 'أدخل رقمًا موجبًا' };
      }
      for (const n of ['الكود', 'باركود وحدة المنتج', 'باركود وحدة 2']) ws.getCell(r, col(n)).numFmt = '@';
    }
    // ورقة مثال (لا تُستورد)
    const ex = wb.addWorksheet('مثال', { views: [{ rightToLeft: true }] });
    ex.addRow(tpl.columns).font = { bold: true };
    const rows = [
      ['', 'سكر الأسرة 1 كجم', 'مواد تموينية', 'حبة', 0, '6281000000017', 4.5, 20, '', 'كرتون', 10, '6281000000024', 42, '', 'كرتون', 15, 20, 'لا'],
      ['', 'أرز بسمتي 5 كجم', 'مواد تموينية', 'كيس', 0, '6281000000031', 30, '', 39, '', '', '', '', '', '', 15, 10, 'لا'],
      ['', 'حليب طويل الأجل 1 لتر', 'ألبان', 'حبة', 0, '6281000000048', 4, 25, '', 'كرتون', 12, '6281000000055', 45, 60, 'كرتون', 15, 24, 'نعم'],
      ['', 'جبنة بيضاء', 'ألبان', 'كجم', 3, '', 22, 30, '', '', '', '', '', '', '', 15, 5, 'نعم'],
    ];
    rows.forEach((r) => ex.addRow(r));
    ex.columns.forEach((c, i) => { c.width = i === 1 ? 28 : Math.max(14, String(tpl.columns[i]).length + 4); });
    // التعليمات
    const help = wb.addWorksheet('التعليمات', { views: [{ rightToLeft: true }] });
    help.getColumn(1).width = 26; help.getColumn(2).width = 95;
    help.addRow(['طريقة الاستيراد', 'املأ الورقة الأولى «الأصناف» من الصف الثاني (صف لكل صنف)، ثم من النظام: المراجعة ← الاستيراد ← الأصناف ← اختر الملف ← معاينة ← اعتماد.']).font = { bold: true };
    help.addRow(['', 'لا تغيّر أسماء الأعمدة. الأعمدة الحمراء إلزامية والباقي اختياري. ورقة «مثال» للتوضيح فقط ولا تُستورد.']);
    help.addRow([]);
    const notes = [
      ['الكود', 'اختياري؛ يُنشأ تلقائيًا إن تُرك فارغًا (IT00001...). يجب ألا يتكرر.'],
      ['الاسم', 'إلزامي. اسم الصنف كما يظهر في الفواتير.'],
      ['التصنيف', 'اختياري؛ يُنشأ التصنيف تلقائيًا إن لم يكن موجودًا.'],
      ['وحدة المنتج', 'إلزامي. أصغر وحدة يُحسب بها المخزون: حبة، كيس، كجم، لتر...'],
      ['دقة الكمية', '0 للأعداد الصحيحة (حبة)، و3 للوزن بالكيلو (مثل 1.250 كجم).'],
      ['باركود وحدة المنتج', 'اختياري؛ يجب ألا يتكرر. يُكتب كنص حتى لا تحذف الأصفار.'],
      ['سعر شراء وحدة المنتج', 'اختياري؛ يُقترح تلقائيًا في فاتورة الشراء.'],
      ['نسبة الربح %', 'اختياري؛ إن تُرك سعر البيع فارغًا يُحسب: سعر البيع = سعر الشراء + النسبة (لكل وحدة).'],
      ['سعر بيع وحدة المنتج', 'اختياري إن وُجد سعر شراء ونسبة ربح؛ وإن كُتب يُعتمد كما هو.'],
      ['وحدة 2 / معامل وحدة 2', 'وحدة أكبر اختيارية مثل كرتون، والمعامل = كم وحدة منتج داخلها (مثال: 12).'],
      ['باركود / أسعار وحدة 2', 'اختيارية بنفس قواعد وحدة المنتج.'],
      ['وحدة الإدخال', 'الوحدة التي يُشترى بها الصنف: اكتب اسم الوحدة 2 (مثل كرتون) أو اتركها فارغة لتكون وحدة المنتج.'],
      ['الضريبة %', 'اختياري؛ فارغ = النسبة العامة في الإعدادات (15%). اكتب 0 للصنف المعفى.'],
      ['حد إعادة الطلب', 'اختياري؛ عند نزول الرصيد عنه يظهر تنبيه «أصناف ناقصة» (بوحدة المنتج).'],
      ['تتبع الصلاحية', 'نعم = يُطلب تاريخ الانتهاء عند الشراء ويُمنع بيع المنتهي. فارغ = نعم.'],
    ];
    notes.forEach(([k, v]) => { const row = help.addRow([k, v]); row.getCell(1).font = { bold: true }; row.alignment = { wrapText: true, vertical: 'top' }; });
  }
  if (kind === 'parties') {
    const col = (name) => tpl.columns.indexOf(name) + 1;
    ws.getCell(1, col('الاسم')).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFC00000' } };
    ws.getColumn(col('الاسم')).width = 28; ws.getColumn(col('العنوان')).width = 24;
    for (let r = 2; r <= 2001; r++) {
      for (const n of ['عميل', 'مورد']) ws.getCell(r, col(n)).dataValidation = { type: 'list', allowBlank: true, formulae: ['"نعم,لا"'] };
      for (const n of ['الهاتف', 'الرقم الضريبي']) ws.getCell(r, col(n)).numFmt = '@';
      for (const n of ['الحد الائتماني', 'مدة السداد']) ws.getCell(r, col(n)).dataValidation = { type: 'decimal', operator: 'greaterThanOrEqual', allowBlank: true, formulae: [0], showErrorMessage: true, error: 'أدخل رقمًا موجبًا' };
    }
    const ex = wb.addWorksheet('مثال', { views: [{ rightToLeft: true }] });
    ex.addRow(tpl.columns).font = { bold: true };
    [
      ['بقالة البوادي', '0551234567', 'جدة - حي الصفا', 'نعم', '', 'أحمد', 5000, 30, '310123456700003', 1200, ''],
      ['سوبرماركت النخيل', '0509876543', 'جدة - حي النسيم', 'نعم', '', 'الكل', '', '', '', '', ''],
      ['عميل نقدي محمد', '0533333333', '', '', '', '', '', '', '', '', ''],
      ['مصنع الحلويات', '0122222222', 'جدة - الصناعية', '', 'نعم', '', '', '', '300000000000003', '', 3500],
    ].forEach((r) => ex.addRow(r));
    ex.columns.forEach((c, i) => { c.width = i === 0 ? 24 : Math.max(14, String(tpl.columns[i]).length + 4); });
    const help = wb.addWorksheet('التعليمات', { views: [{ rightToLeft: true }] });
    help.getColumn(1).width = 26; help.getColumn(2).width = 95;
    help.addRow(['طريقة الاستيراد', 'املأ الورقة الأولى من الصف الثاني (صف لكل عميل)، ثم من النظام: الاستيراد من Excel ← العملاء والموردون ← اختر الملف ← معاينة وتحقق ← اعتماد الاستيراد.']).font = { bold: true };
    help.addRow(['', 'لا تغيّر أسماء الأعمدة. الاسم فقط إلزامي والباقي اختياري. ورقة «مثال» للتوضيح ولا تُستورد. لا يُستورد شيء ما دام في الملف صف به خطأ.']);
    help.addRow([]);
    [
      ['الاسم', 'إلزامي. إن وُجد عميل بنفس الاسم والهاتف يظهر خطأ حتى لا يتكرر.'],
      ['الهاتف', 'للاتصال وواتساب. إن حذف إكسيل الصفر الأول (551234567) يُعاد تلقائيًا.'],
      ['عميل / مورد', 'نعم أو لا. إن تُركا فارغين يُعتبر عميلًا.'],
      ['المندوب', 'اسم المندوب كما هو في النظام ليظهر العميل له؛ «الكل» ليظهر لكل المناديب؛ فارغ = بدون مندوب.'],
      ['الحد الائتماني', 'أقصى رصيد آجل مسموح؛ فارغ = بلا حد.'],
      ['مدة السداد', 'عدد أيام الآجل (مثل 30).'],
      ['الرقم الضريبي', '15 رقمًا؛ يظهر في فاتورة العميل.'],
      ['الرصيد الافتتاحي للعميل', 'المبلغ المستحق على العميل حاليًا (من دفاترك السابقة) بتاريخ الأرصدة المختار في شاشة الاستيراد.'],
      ['الرصيد الافتتاحي للمورد', 'المبلغ المستحق للمورد حاليًا.'],
    ].forEach(([k, v]) => { const row = help.addRow([k, v]); row.getCell(1).font = { bold: true }; row.alignment = { wrapText: true, vertical: 'top' }; });
  }
  return wb.xlsx.writeBuffer();
}

module.exports = { parseFile, preview, commit, templateXlsx, TEMPLATES };
