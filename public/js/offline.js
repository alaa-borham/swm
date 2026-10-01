// العمل دون اتصال لنقطة البيع: كتالوج أصناف محلي، وطابور مبيعات يُرسل تلقائيًا عند عودة الاتصال
// بنفس معرف العملية، فلا تتكرر الفاتورة إذا كان الخادم قد استلمها قبل انقطاع الرد.
// الخادم يعيد فحص الرصيد والصلاحيات عند المزامنة؛ ما يُرفض يبقى في قائمة "العمليات المعلقة" للمراجعة.
import { api, toast } from './lib.js';

const QKEY = 'frs-pos-queue-v1';
const CKEY = 'frs-pos-catalog-v1';
const MEKEY = 'frs-me-v1';

function read(key, def) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : def; } catch (_) { return def; }
}
function write(key, v) {
  try { localStorage.setItem(key, JSON.stringify(v)); return true; } catch (_) { return false; }
}

// ---------- بيانات المستخدم للتشغيل دون اتصال ----------
export const saveMe = (me) => write(MEKEY, me);
export const loadMe = () => read(MEKEY, null);
export const clearMe = () => { try { localStorage.removeItem(MEKEY); } catch (_) { /* ignore */ } };

// ---------- الكتالوج ----------
export async function refreshCatalog(warehouseId) {
  try {
    const c = await api('GET', '/items/catalog' + (warehouseId ? `?warehouse_id=${warehouseId}` : ''));
    write(CKEY, c);
    return c;
  } catch (_) { return null; }
}
export const loadCatalog = () => read(CKEY, null);

/** بحث محلي بنفس شكل نتائج /items/lookup */
export function searchCatalog(q) {
  const c = loadCatalog();
  if (!c) return [];
  const term = String(q || '').trim();
  if (!term) return [];
  const sc = c.scale || {};
  if (sc.prefix && /^\d+$/.test(term) && term.startsWith(sc.prefix) && term.length === sc.prefix.length + sc.plu + sc.val + 1) {
    const plu = term.slice(sc.prefix.length, sc.prefix.length + sc.plu);
    const raw = Number(term.slice(sc.prefix.length + sc.plu, sc.prefix.length + sc.plu + sc.val));
    const it = c.items.find((x) => x.code === plu || x.code === plu.replace(/^0+(?=\d)/, ''));
    if (it) {
      const base = it.units.find((u) => u.is_base) || it.units[0];
      const dec = 10 ** (Number((window.__moneyDecimals ?? 2)));
      return [{ ...it, selected_unit_id: base.id, scale_qty: sc.mode === 'price' ? (base.sell_price ? Number((raw / dec / base.sell_price).toFixed(it.qty_decimals)) : 0) : raw / 1000 }];
    }
  }
  for (const it of c.items) {
    const u = it.units.find((x) => x.barcode === term);
    if (u) return [{ ...it, selected_unit_id: u.id }];
  }
  return c.items.filter((it) => it.name.includes(term) || it.code === term).slice(0, 20)
    .map((it) => ({ ...it, selected_unit_id: (it.units.find((u) => u.is_base) || it.units[0]).id }));
}

function decrementCatalog(lines) {
  const c = loadCatalog();
  if (!c) return;
  for (const l of lines) {
    const it = c.items.find((x) => x.id === l.item_id);
    const u = it && it.units.find((x) => x.id === l.unit_id);
    if (it && u) it.sellable_qty = Math.max(0, Number((it.sellable_qty - l.qty * u.factor).toFixed(3)));
  }
  write(CKEY, c);
}

// ---------- الطابور ----------
export const queue = () => read(QKEY, []);
export const pendingCount = () => queue().filter((x) => x.state !== 'synced').length;
function saveQueue(q) {
  // نحتفظ بآخر 200 عملية مرسلة للمراجعة فقط
  const synced = q.filter((x) => x.state === 'synced').slice(-200);
  write(QKEY, [...q.filter((x) => x.state !== 'synced'), ...synced]);
  window.dispatchEvent(new CustomEvent('queue-changed'));
}

export function enqueue({ key, url, body, label, total }) {
  const q = queue();
  if (q.some((x) => x.key === key)) return;
  q.push({ key, url, body, label, total, state: 'pending', created_at: new Date().toISOString(), error: null });
  if (!saveQueue(q) && !read(QKEY, []).some((x) => x.key === key)) throw new Error('تعذر الحفظ المحلي');
  if (body && body.lines) decrementCatalog(body.lines);
}

export function removeFromQueue(key) { saveQueue(queue().filter((x) => x.key !== key)); }

let syncing = false;
/** إرسال المعلق بالترتيب؛ يتوقف عند انقطاع الاتصال */
export async function sync({ silent, includeFailed } = {}) {
  if (syncing) return { sent: 0 };
  syncing = true;
  let sent = 0, failed = 0;
  try {
    for (const item of queue().filter((x) => x.state === 'pending' || (includeFailed && x.state === 'failed'))) {
      try {
        const r = await api('POST', item.url, item.body, { idem: item.key });
        const q = queue();
        const it = q.find((x) => x.key === item.key);
        if (it) { it.state = 'synced'; it.doc_id = r.id; it.number = r.number; it.error = null; it.synced_at = new Date().toISOString(); }
        saveQueue(q);
        sent++;
      } catch (e) {
        if (e.code === 'NETWORK') break;
        const q = queue();
        const it = q.find((x) => x.key === item.key);
        if (it) { it.state = 'failed'; it.error = e.message; }
        saveQueue(q);
        failed++;
      }
    }
  } finally { syncing = false; }
  if (!silent && (sent || failed)) toast(`المزامنة: أُرسلت ${sent}${failed ? ` — مرفوضة ${failed} تحتاج مراجعة` : ''}`, failed ? 'bad' : 'ok');
  return { sent, failed };
}

export function startAutoSync() {
  window.addEventListener('online', () => sync());
  setInterval(() => { if (navigator.onLine && pendingCount()) sync({ silent: false }); }, 30000);
  if (navigator.onLine && pendingCount()) sync();
}
