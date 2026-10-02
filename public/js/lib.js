// أدوات الواجهة المشتركة: بناء العناصر، الاتصال بالخادم، التنسيق، الجداول، النوافذ.

// append/replaceChildren/prepend تتجاهل القيم الفارغة والشرطية (null/false) وتسطح المصفوفات بدل كتابة "null" نصًا
for (const name of ['append', 'prepend', 'replaceChildren']) {
  const orig = Element.prototype[name];
  Element.prototype[name] = function patched(...kids) { return orig.apply(this, kids.flat(Infinity).filter((k) => k != null && k !== false && k !== '')); };
}

export const state = { me: null, perms: new Set(), settings: {}, cache: new Map(), meta: null };

export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'value') el.value = v;
      else if (k === 'checked') el.checked = !!v;
      else if (k === 'html') throw new Error('raw html not allowed');
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  append(el, kids);
  return el;
}
function append(el, kids) {
  for (const k of kids) {
    if (k == null || k === false) continue;
    if (Array.isArray(k)) append(el, k);
    else el.appendChild(k instanceof Node ? k : document.createTextNode(String(k)));
  }
}
export function clear(el) {
  // إزالة حقل عليه التركيز تطلق blur/change أثناء الحذف؛ نطلقها قبل الحذف لتجنب التداخل
  const a = document.activeElement;
  if (a && a !== document.body && el.contains(a)) a.blur();
  el.replaceChildren();
  return el;
}

export const can = (p) => state.perms.has(p);

// ---------- الاتصال ----------
let saving = 0;
function busy(d) {
  saving += d;
  let bar = document.querySelector('.saving');
  if (saving > 0 && !bar) document.body.appendChild(h('div', { class: 'saving' }));
  if (saving <= 0 && bar) bar.remove();
}

export class ApiError extends Error {
  constructor(status, body) {
    super(body && body.error ? body.error.message : `خطأ ${status}`);
    this.status = status; this.code = body && body.error ? body.error.code : null; this.details = body && body.error ? body.error.details : null;
  }
}

export async function api(method, url, body, opts = {}) {
  const headers = { 'X-Requested-With': 'fetch' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (opts.idem) headers['Idempotency-Key'] = opts.idem;
  busy(1);
  let res;
  try {
    res = await fetch('/api' + url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, credentials: 'same-origin' });
  } catch (e) {
    throw new ApiError(0, { error: { code: 'NETWORK', message: 'تعذر الاتصال بالخادم؛ تحقق من الشبكة وأعد المحاولة (لن تتكرر العملية)' } });
  } finally { busy(-1); }
  if (opts.raw) { if (!res.ok) throw new ApiError(res.status, await res.json().catch(() => null)); return res; }
  const data = await res.json().catch(() => null);
  if (res.status === 401 && url !== '/auth/login') { window.dispatchEvent(new CustomEvent('auth-required')); }
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}
export const get = (url, q) => api('GET', url + qs(q));
export function qs(q) {
  if (!q) return '';
  const p = Object.entries(q).filter(([, v]) => v !== undefined && v !== null && v !== '');
  return p.length ? '?' + p.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&') : '';
}

/** إرسال عملية بمعرف ثابت حتى تنجح: إعادة المحاولة بعد انقطاع لا تكرر العملية */
export function submitter() {
  let key = null;
  return async (method, url, body) => {
    if (!key) key = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));
    const r = await api(method, url, body, { idem: key });
    key = null;
    return r;
  };
}

/** تنفيذ عملية مع رسائل مفهومة دون فقد المدخلات */
export async function run(fn, okMsg) {
  try {
    const r = await fn();
    if (okMsg) toast(okMsg, 'ok');
    return r;
  } catch (e) {
    toast(e.message || 'حدث خطأ', 'bad');
    console.warn(e);
    return undefined;
  }
}

// ---------- التنسيق ----------
const dec = () => state.settings.money_decimals ?? 2;
export function money(n) {
  if (n == null || n === '') return '';
  return Number(n).toLocaleString('en-US', { minimumFractionDigits: dec(), maximumFractionDigits: dec() });
}
export function qty(n) {
  if (n == null || n === '') return '';
  return Number(n).toLocaleString('en-US', { maximumFractionDigits: 3 });
}
export const M = (n) => h('span', { class: 'money' }, money(n));
export const Q = (n) => h('span', { class: 'qty' }, qty(n));
/** تاريخ/وقت ISO بتوقيت الجهاز للعرض */
export function dt(iso) { if (!iso) return ''; const d = new Date(iso); return h('span', { class: 'num' }, `${d.toLocaleDateString('en-CA')} ${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`); }
export const N = (v) => h('span', { class: 'num' }, v ?? '');
export const today = () => state.settings.today || new Date().toISOString().slice(0, 10);
export function monthStart() { return today().slice(0, 8) + '01'; }

export const STATUS = { draft: ['مسودة', 'warn'], approved: ['معتمد', 'ok'], reversed: ['ملغي/معكوس', 'bad'] };
export const PAY_STATUS = { paid: ['مسدد', 'ok'], partial: ['جزئي', 'warn'], unpaid: ['غير مسدد', 'bad'], credit: ['رصيد دائن', ''] };
export function badge(map, key) {
  const v = map[key];
  return v ? h('span', { class: 'badge ' + v[1] }, v[0]) : '';
}

// ---------- الإشعارات والنوافذ ----------
export function toast(msg, kind = '') {
  const t = h('div', { class: 'toast ' + kind, role: 'status' }, msg);
  document.getElementById('toasts').appendChild(t);
  setTimeout(() => t.remove(), kind === 'bad' ? 7000 : 3500);
}

export function modal(title, body, actions = []) {
  let resolveFn;
  const done = new Promise((r) => { resolveFn = r; });
  const close = (v) => { bg.remove(); document.removeEventListener('keydown', esc); resolveFn(v); };
  const esc = (e) => { if (e.key === 'Escape') close(undefined); };
  const bg = h('div', { class: 'modal-bg', onclick: (e) => { if (e.target === bg) close(undefined); } },
    h('div', { class: 'modal', role: 'dialog', 'aria-label': title },
      h('h3', null, title), body,
      h('div', { class: 'actions', style: { marginTop: '16px' } },
        ...actions.map((a) => h('button', { class: 'btn ' + (a.class || ''), onclick: async () => { const v = await a.onClick?.(); if (v !== false) close(v); } }, a.label)),
        h('button', { class: 'btn', onclick: () => close(undefined) }, 'إغلاق'))));
  document.body.appendChild(bg);
  document.addEventListener('keydown', esc);
  setTimeout(() => { const f = bg.querySelector('input,select,textarea'); if (f) f.focus(); }, 30);
  return { close, done };
}

/** طلب سبب موثق */
export function askReason(title, hint = 'اكتب السبب (مطلوب للتوثيق)') {
  const ta = h('textarea', { placeholder: hint });
  const m = modal(title, h('div', null, ta), [{ label: 'تأكيد', class: 'primary', onClick: () => { if (ta.value.trim().length < 3) { toast('السبب مطلوب', 'bad'); return false; } return ta.value.trim(); } }]);
  return m.done;
}

export function confirmBox(title, text) {
  const m = modal(title, h('p', null, text), [{ label: 'تأكيد', class: 'primary', onClick: () => true }]);
  return m.done;
}

// ---------- النماذج ----------
export function field(label, input, opts = {}) {
  return h('div', { class: 'field' + (opts.req ? ' req' : ''), style: opts.style }, h('label', null, label), input);
}
export function inp(attrs = {}) {
  const a = { ...attrs };
  if (a.type === 'number') { a.type = 'text'; a.inputmode = 'decimal'; a.class = (a.class || '') + ' num-in'; }
  return h('input', a);
}
export function sel(options, value, attrs = {}) {
  const s = h('select', attrs);
  for (const o of options) {
    const op = h('option', { value: o.value ?? o.id ?? '' }, o.label ?? o.name ?? '');
    if (String(op.value) === String(value ?? '')) op.selected = true;
    s.appendChild(op);
  }
  return s;
}
export const num = (v) => (v === '' || v == null ? null : Number(String(v).replace(/[٠-٩]/g, (c) => c.charCodeAt(0) - 0x660).replace(/,/g, '')));

// ---------- الجداول ----------
/** columns: [{key, label, type: money|qty|int|date, render(row), link}] */
export function table({ columns, rows, totals, onRow, empty = 'لا توجد بيانات', footer }) {
  if (!rows || !rows.length) return h('div', { class: 'table-wrap' }, h('div', { class: 'empty' }, empty));
  const isN = (c) => ['money', 'qty', 'int'].includes(c.type);
  const cell = (c, r) => {
    if (c.render) return c.render(r);
    const v = r[c.key];
    if (c.type === 'money') return M(v);
    if (c.type === 'qty') return Q(v);
    if (c.link && r[c.link]) return h('a', { href: `#/doc/${r[c.link]}` }, v);
    return v ?? '';
  };
  return h('div', { class: 'table-wrap' }, h('table', null,
    h('thead', null, h('tr', null, columns.map((c) => h('th', { class: isN(c) ? 'n' : '' }, c.label)))),
    h('tbody', null, rows.map((r) => h('tr', { class: onRow ? 'clickable' : '', onclick: onRow ? (e) => { if (!e.target.closest('a,button,input,select')) onRow(r); } : null },
      columns.map((c) => h('td', { class: isN(c) ? 'n' : '' }, cell(c, r)))))),
    totals ? h('tfoot', null, h('tr', null, columns.map((c, i) => h('td', { class: isN(c) ? 'n' : '' },
      i === 0 ? 'الإجمالي' : totals[c.key] == null ? '' : c.type === 'money' ? M(totals[c.key]) : c.type === 'qty' ? Q(totals[c.key]) : totals[c.key])))) : null,
    footer || null));
}

// ---------- القوائم المرجعية (مع تخزين مؤقت) ----------
export async function lookup(name, force) {
  if (!force && state.cache.has(name)) return state.cache.get(name);
  const urls = {
    warehouses: '/warehouses', allWarehouses: '/warehouses?all=1', cash: '/cash-accounts', categories: '/categories', expcats: '/expense-categories', reps: '/reps',
    customers: '/parties?type=customer&active=1&limit=1000', suppliers: '/parties?type=supplier&active=1&limit=1000', branches: '/branches',
  };
  let data;
  const key = 'frs-lookup-' + name;
  try {
    data = await get(urls[name]);
    if (data && data.rows) data = data.rows;
    try { localStorage.setItem(key, JSON.stringify(data)); } catch (_) { /* ignore */ }
  } catch (e) {
    // دون اتصال: آخر نسخة محفوظة على الجهاز
    let cached = null;
    try { cached = JSON.parse(localStorage.getItem(key) || 'null'); } catch (_) { /* ignore */ }
    if (e.code !== 'NETWORK' || !cached) throw e;
    data = cached;
  }
  state.cache.set(name, data);
  return data;
}
export function invalidate(...names) { for (const n of names) state.cache.delete(n); }

/** قائمة اختيار بحث للعميل/المورد */
export async function partySelect(kind, value, attrs = {}) {
  const list = await lookup(kind === 'supplier' ? 'suppliers' : 'customers');
  return sel([{ value: '', label: kind === 'supplier' ? '— اختر المورد —' : '— عميل نقدي —' }, ...list.map((p) => ({ value: p.id, label: p.name + (p.phone ? ' — ' + p.phone : '') }))], value, attrs);
}
/** اختيار الفرع للتقارير (يظهر فقط عند تعدد الفروع ولمستخدم غير مقيد بفرع) */
export async function branchFilter(value) {
  if (state.branch || (state.branchesCount || 1) < 2) return null;
  const list = (await lookup('branches')).filter((b) => b.active);
  return sel([{ value: '', label: 'كل الفروع' }, ...list.map((b) => ({ value: b.id, label: b.name }))], value || '');
}
export async function warehouseSelect(value, attrs = {}, { all = false, any = false } = {}) {
  const list = (await lookup(any ? 'allWarehouses' : 'warehouses')).filter((w) => w.active);
  return sel([...(all ? [{ value: '', label: 'كل المستودعات' }] : []), ...list.map((w) => ({ value: w.id, label: w.name }))], value, attrs);
}
export async function cashSelect(value, attrs = {}, filter = () => true, { empty } = {}) {
  const list = (await lookup('cash')).filter((c) => c.active && filter(c));
  return sel([...(empty ? [{ value: '', label: empty }] : []), ...list.map((c) => ({ value: c.id, label: c.name }))], value, attrs);
}

/** منتقي صنف بالبحث بالاسم أو الباركود */
export function itemPicker({ onPick, warehouseId, placeholder = 'ابحث بالاسم أو امسح الباركود', autofocus, allowCreate, inStockOnly, emptyHint }) {
  const input = inp({ class: 'search', placeholder, autocomplete: 'off', autofocus });
  const box = h('div', { class: 'results hidden' });
  let results = [], idx = 0, timer, empty = '';
  const render = () => {
    clear(box);
    box.classList.toggle('hidden', !results.length && !empty);
    if (!results.length && empty) {
      box.appendChild(h('div', { class: 'r', style: { cursor: 'default' } }, h('span', { class: 'muted' }, inStockOnly ? (empty === ' ' ? (emptyHint || 'لا توجد أصناف لها رصيد في هذا المستودع') : `لا يوجد رصيد متاح لـ "${empty}" في هذا المستودع`) : empty === ' ' ? 'لا توجد أصناف مسجلة بعد' : `لا يوجد صنف باسم "${empty}"`),
        allowCreate && can('items.manage') ? h('button', { type: 'button', class: 'btn small primary', onclick: () => quickItem(empty.trim()) }, '+ صنف جديد') : null));
    }
    results.forEach((it, i) => {
      const unit = it.units.find((u) => u.id === it.selected_unit_id) || it.units[0];
      box.appendChild(h('div', { class: 'r' + (i === idx ? ' sel' : ''), onclick: () => pick(i) },
        h('span', null, it.name, ' ', h('span', { class: 'muted small' }, it.code)),
        h('span', { class: 'small' }, it.sellable_qty != null ? ['متاح ', Q(it.sellable_qty), ' ', it.base_unit, ' · '] : '', unit ? [unit.name, ' ', M(unit.sell_price)] : '')));
    });
  };
  const pick = (i) => { const it = results[i]; if (!it) return; results = []; empty = ''; render(); input.value = ''; onPick(it); input.focus(); };
  const search = async (exact, browse) => {
    const q = input.value.trim();
    if (!q && !browse) { results = []; empty = ''; render(); return; }
    try {
      const wid = typeof warehouseId === 'function' ? warehouseId() : warehouseId;
      try {
        results = await get('/items/lookup', { q, warehouse_id: wid, in_stock: inStockOnly ? 1 : undefined });
      } catch (e) {
        if (e.code !== 'NETWORK') throw e;
        results = (await import('./offline.js')).searchCatalog(q);
        if (inStockOnly) results = results.filter((it) => it.sellable_qty == null || it.sellable_qty > 0);
      }
      idx = 0;
      empty = results.length ? '' : (q || ' ');
      if (exact && results.length === 1) return pick(0);
      if (exact && !results.length && !allowCreate) toast(inStockOnly ? 'لا يوجد رصيد متاح لهذا الصنف في المستودع المختار' : 'لا يوجد صنف بهذا الاسم أو الباركود', 'bad');
      render();
    } catch (e) { toast(e.message, 'bad'); }
  };
  input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => search(false), 250); });
  // عند الضغط على الحقل وهو فارغ تظهر قائمة الأصناف للاختيار منها
  input.addEventListener('click', () => { if (!input.value.trim()) search(false, true); });
  input.addEventListener('blur', () => setTimeout(() => { if (!box.contains(document.activeElement) && !input.value.trim()) { results = []; empty = ''; render(); } }, 200));
  // إنشاء صنف سريع دون مغادرة الشاشة؛ يُضاف مباشرة بعد الحفظ
  const quickItem = (name) => {
    const isCode = /^\d{6,}$/.test(name);
    const f = { name: inp({ value: isCode ? '' : name }), base_unit: inp({ value: 'حبة' }), cost: inp({ type: 'number', placeholder: 'اختياري' }), margin: inp({ type: 'number', placeholder: 'اختياري' }),
      barcode: inp({ value: isCode ? name : '', placeholder: 'اختياري' }), track_expiry: h('input', { type: 'checkbox', checked: true }) };
    const sellPreview = h('p', { class: 'small', style: { margin: '6px 0 0' } });
    const showSell = () => {
      const pp = Number(f.cost.value), pm = Number(f.margin.value);
      sellPreview.textContent = f.cost.value && f.margin.value && pp >= 0 && pm >= 0 ? `سعر البيع المحسوب: ${(pp * (1 + pm / 100)).toFixed(state.settings.money_decimals ?? 2)}` : '';
    };
    f.cost.addEventListener('input', showSell); f.margin.addEventListener('input', showSell);
    // وحدات إضافية: الاسم، وكم وحدة منتج تحتوي، وسعرها وباركودها
    const extra = [];
    const unitsBox = h('div');
    const unitName = () => f.base_unit.value.trim() || 'وحدة المنتج';
    const drawUnits = () => {
      clear(unitsBox);
      extra.forEach((u, i) => unitsBox.appendChild(h('div', { class: 'grid', style: { alignItems: 'end', marginTop: '8px', paddingTop: '8px', borderTop: '1px dashed var(--line)' } },
        field('اسم الوحدة', u.name, { req: true }), field(`تحتوي كم ${unitName()}`, u.factor, { req: true }), field('سعر شرائها', u.cost), field('باركودها', u.barcode),
        h('button', { type: 'button', class: 'btn small danger', onclick: () => { extra.splice(i, 1); drawUnits(); } }, 'حذف الوحدة'))));
    };
    f.base_unit.addEventListener('input', () => extra.forEach((u, i) => { const l = unitsBox.children[i]?.querySelectorAll('label')[1]; if (l) l.textContent = `تحتوي كم ${unitName()}`; }));
    const addUnit = () => {
      extra.push({ name: inp({ placeholder: 'مثال: كرتون' }), factor: inp({ type: 'number', placeholder: 'مثال: 12' }), cost: inp({ type: 'number', placeholder: 'اختياري' }), barcode: inp({ placeholder: 'اختياري' }) });
      drawUnits(); extra[extra.length - 1].name.focus();
    };
    modal('صنف جديد', h('div', null, h('div', { class: 'grid' }, field('اسم الصنف', f.name, { req: true }), field('وحدة المنتج', f.base_unit, { req: true }),
      field('سعر الشراء', f.cost), field('نسبة الربح %', f.margin), field('الباركود', f.barcode)), sellPreview, h('label', { class: 'check' }, f.track_expiry, 'له تاريخ انتهاء'),
    h('h4', { style: { margin: '14px 0 4px' } }, 'وحدات أخرى'),
    h('p', { class: 'small muted', style: { margin: 0 } }, 'مثال: وحدة المنتج "حبة"، ووحدة أخرى "كرتون" تحتوي 12 حبة. المخزون يُحسب دائمًا بوحدة المنتج.'),
    unitsBox, h('button', { type: 'button', class: 'btn small', style: { marginTop: '8px' }, onclick: addUnit }, '+ إضافة وحدة أخرى'),
    h('p', { class: 'small muted' }, 'سعر الشراء يُكتب في الفاتورة تلقائيًا. عند كتابة نسبة الربح يُحسب سعر البيع لكل وحدة = سعر شرائها + النسبة. باقي البيانات تُضبط من صفحة الأصناف.')),
    [{ label: 'حفظ وإضافة', class: 'primary', onClick: async () => {
      // وحدة الإدخال: أول وحدة أخرى لها سعر شراء إن لم يُكتب سعر لوحدة المنتج، وإلا وحدة المنتج
      const entry = f.cost.value ? null : extra.find((u) => u.cost.value) || null;
      const units = extra.map((u) => ({ name: u.name.value, factor: u.factor.value, barcode: u.barcode.value || undefined, purchase_price: u.cost.value || undefined, profit_margin: f.margin.value || undefined, for_purchase: u === entry ? 1 : 0 }));
      const it = await run(() => api('POST', '/items', { name: f.name.value, base_unit: f.base_unit.value, sell_price: 0, purchase_price: f.cost.value || undefined, profit_margin: f.margin.value || undefined, base_for_purchase: entry ? 0 : 1, barcode: f.barcode.value || undefined, track_expiry: f.track_expiry.checked ? 1 : 0, units }), 'أُضيف الصنف');
      if (!it) return false;
      // سعر الشراء المُدخل لكل وحدة يُمرَّر للسطر؛ وتُختار أول وحدة أخرى لها سعر وإلا وحدة المنتج
      const base = it.units.find((u) => u.is_base);
      it.quick_cost = {};
      if (f.cost.value) it.quick_cost[base.id] = f.cost.value;
      let chosen = null;
      extra.forEach((u) => { const unit = it.units.find((x) => !x.is_base && x.name === u.name.value.trim()); if (unit && u.cost.value) { it.quick_cost[unit.id] = u.cost.value; chosen = chosen || unit; } });
      it.selected_unit_id = (f.cost.value || !chosen ? base : chosen).id;
      results = [it]; pick(0);
      return true;
    } }]);
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); clearTimeout(timer); if (results.length && box.offsetParent) pick(idx); else search(true); }
    else if (e.key === 'ArrowDown') { idx = Math.min(idx + 1, results.length - 1); render(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { idx = Math.max(idx - 1, 0); render(); e.preventDefault(); }
    else if (e.key === 'Escape') { results = []; render(); }
  });
  const addBtn = allowCreate && can('items.manage')
    ? h('button', { type: 'button', class: 'btn primary', style: { whiteSpace: 'nowrap' }, onclick: () => quickItem(input.value.trim()) }, '+ صنف جديد') : null;
  return { el: h('div', null, addBtn ? h('div', { class: 'row', style: { gap: '6px', flexWrap: 'nowrap' } }, input, addBtn) : input, box), input };
}

/** شريط فلاتر بسيط */
export function filters(fields, onApply) {
  const btn = h('button', { class: 'btn primary' }, 'عرض');
  const form = h('form', { class: 'row card filters', style: { padding: '12px' }, onsubmit: (e) => { e.preventDefault(); onApply(); } }, ...fields, btn);
  return form;
}

export function pageHead(title, ...actions) {
  document.querySelector('.top .title').textContent = title;
  document.title = title + ' — ' + (state.settings.org_name || 'النظام');
  return actions.length ? h('div', { class: 'actions', style: { marginBottom: '14px' } }, ...actions) : null;
}

export function go(hash) { location.hash = hash; }

export function readFileB64(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(',')[1]);
    r.onerror = rej;
    r.readAsDataURL(file);
  });
}

export async function download(url, filename) {
  const res = await api('GET', url, undefined, { raw: true });
  const blob = await res.blob();
  const a = h('a', { href: URL.createObjectURL(blob), download: filename });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// نماذج الفلترة (class=filters) تُطبَّق تلقائيًا: فورًا عند تغيير قائمة/تاريخ/خيار، وبعد توقف الكتابة في حقول البحث.
let filterTimer = null;
const submitFilters = (form) => { clearTimeout(filterTimer); if (form.isConnected) form.requestSubmit(); };
document.addEventListener('change', (e) => {
  const form = e.target.closest?.('form.filters');
  if (form && e.target.matches('select, input[type=date], input[type=checkbox], input[type=month]')) submitFilters(form);
});
document.addEventListener('input', (e) => {
  const form = e.target.closest?.('form.filters');
  if (!form || !e.target.matches('input:not([type]), input[type=text], input[type=search], input[type=number]')) return;
  clearTimeout(filterTimer);
  filterTimer = setTimeout(() => submitFilters(form), 450);
});
