// طباعة الإيصال على طابعات البلوتوث الحرارية المحمولة (ESC/POS) من الجوال.
// الإيصال يُرسم صورةً (حتى يظهر العربي والشعار ورمز QR كما هو) ثم يُحوَّل إلى أبيض/أسود بأوامر GS v 0.
// طريقتان: تطبيق RawBT (بلوتوث عادي، يعمل مع أغلب الطابعات) أو Web Bluetooth مباشرة (طابعات BLE).

/** رسم عنصر HTML على canvas بعرض محدد بالبكسل */
export async function renderCanvas(node, { width = null, scale = 2 } = {}) {
  const toDataUrl = (blob) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(blob); });
  const clone = node.cloneNode(true);
  clone.style.maxWidth = 'none';
  // الصور الخارجية (الشعار) تُضمَّن كبيانات حتى لا تُمنع في الرسم
  for (const img of clone.querySelectorAll('img')) {
    if (img.src && !img.src.startsWith('data:')) { try { img.src = await toDataUrl(await (await fetch(img.src, { credentials: 'same-origin' })).blob()); } catch (_) { img.remove(); } }
  }
  const css = await (await fetch('/css/app.css')).text();
  const rect = node.getBoundingClientRect();
  const pad = width ? 4 : 12;
  const w = Math.ceil(rect.width) + pad * 2;
  // ارتفاع إضافي احتياطًا: قد يختلف الخط داخل الصورة عن الشاشة فيطول الإيصال؛ الأبيض الزائد يُقص عند التحويل
  const hgt = Math.ceil(rect.height * (width ? 2.5 : 1)) + pad * 2 + (width ? 400 : 0);
  const html = new XMLSerializer().serializeToString(clone);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${hgt}"><foreignObject width="100%" height="100%">`
    + `<div xmlns="http://www.w3.org/1999/xhtml" dir="rtl" class="print-area" style="display:block;background:#fff;color:#000;padding:${pad}px;font-family:Tahoma,Arial,sans-serif">`
    + `<style>${css.replace(/<\/style/gi, '')}</style>${html}</div></foreignObject></svg>`;
  const img = new Image();
  await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('تعذر تجهيز صورة الإيصال')); img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg); });
  const k = width ? width / w : scale;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * k); canvas.height = Math.round(hgt * k);
  const g = canvas.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, canvas.width, canvas.height);
  g.scale(k, k); g.drawImage(img, 0, 0);
  return canvas;
}

/** عدد النقاط لعرض الورق: 58مم ← 384، 80مم ← 576 (203 نقطة/بوصة) */
export const paperDots = (mm) => (Number(mm) <= 60 ? 384 : 576);

/** تحويل canvas إلى أوامر ESC/POS (صورة نقطية على شرائح) */
export function canvasToEscPos(canvas) {
  const W = canvas.width; const H = canvas.height;
  const px = canvas.getContext('2d').getImageData(0, 0, W, H).data;
  const bytesPerRow = Math.ceil(W / 8);
  // قص الفراغ الأبيض في الأسفل
  let last = H - 1;
  // الأسود والرمادي الغامق ← نقطة سوداء، والأبيض ← فراغ، والألوان الفاتحة/المتوسطة (مثل الشعار الملوّن) ← نقاط متدرجة (Bayer)
  // حتى لا تختفي الألوان الفاتحة من الإيصال
  const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
  const dark = (x, y) => {
    const i = (y * W + x) * 4;
    if (px[i + 3] === 0) return false;
    const l = (px[i] * 299 + px[i + 1] * 587 + px[i + 2] * 114) / 1000;
    if (l < 110) return true;
    if (l > 235) return false;
    return (l - 110) / 125 * 16 < BAYER[(y & 3) * 4 + (x & 3)] + 0.5;
  };
  for (; last > 0; last--) { let any = false; for (let x = 0; x < W; x++) { const i = (last * W + x) * 4; if (px[i + 3] && px[i] + px[i + 1] + px[i + 2] < 700) { any = true; break; } } if (any) break; }
  const rows = last + 1;
  const out = [0x1b, 0x40]; // تهيئة
  const BAND = 48; // شرائح صغيرة تناسب ذاكرة الطابعات المحمولة
  for (let y0 = 0; y0 < rows; y0 += BAND) {
    const hh = Math.min(BAND, rows - y0);
    out.push(0x1d, 0x76, 0x30, 0x00, bytesPerRow & 0xff, bytesPerRow >> 8, hh & 0xff, hh >> 8);
    for (let y = y0; y < y0 + hh; y++) {
      for (let b = 0; b < bytesPerRow; b++) {
        let v = 0;
        for (let bit = 0; bit < 8; bit++) { const x = b * 8 + bit; if (x < W && dark(x, y)) v |= 0x80 >> bit; }
        out.push(v);
      }
    }
  }
  // مسافة فارغة أسفل الإيصال (~3 سم) ليسهل قطعه
  out.push(0x1b, 0x4a, 0xf0); // تغذية 240 نقطة
  out.push(0x0a, 0x0a, 0x0a);
  out.push(0x1d, 0x56, 0x42, 0x00); // قص (تتجاهله الطابعات بلا قاطع)
  // حشوة في النهاية: بعض الطابعات المحمولة تُسقط آخر البيانات المستلمة، فتسقط الحشوة بدل نهاية الإيصال
  for (let i = 0; i < 1536; i++) out.push(0x00);
  return new Uint8Array(out);
}

const toBase64 = (bytes) => { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(s); };

export const isAndroid = () => /android/i.test(navigator.userAgent);

/** إرسال الأوامر إلى تطبيق RawBT (يطبع على طابعة البلوتوث المقترنة) */
export function printViaRawBT(bytes) {
  const store = 'https://play.google.com/store/apps/details?id=ru.a402d.rawbtprinter';
  location.href = `intent:base64,${toBase64(bytes)}#Intent;scheme=rawbt;package=ru.a402d.rawbtprinter;S.browser_fallback_url=${encodeURIComponent(store)};end;`;
}

// خدمات BLE الشائعة في الطابعات الحرارية الصينية/المحمولة
const BLE_SERVICES = [
  '000018f0-0000-1000-8000-00805f9b34fb', 'e7810a71-73ae-499d-8c15-faa9aef0c3f2', '49535343-fe7d-4ae5-8fa9-9fafd205e455',
  '0000ff00-0000-1000-8000-00805f9b34fb', '0000ffe0-0000-1000-8000-00805f9b34fb', '0000fff0-0000-1000-8000-00805f9b34fb',
  '0000ae30-0000-1000-8000-00805f9b34fb', '0000af30-0000-1000-8000-00805f9b34fb', '0000ff80-0000-1000-8000-00805f9b34fb',
  '0000eee0-0000-1000-8000-00805f9b34fb', '0000fee7-0000-1000-8000-00805f9b34fb', '0000ffb0-0000-1000-8000-00805f9b34fb',
];
let bleChar = null;

// سرعة الإرسال: كمية البيانات قبل كل توقف، ومدة التوقف (تُحفظ على الجهاز)
export const BLE_SPEEDS = {
  normal: { label: 'عادية', block: 512, pause: 40 },
  slow: { label: 'بطيئة', block: 256, pause: 80 },
  slowest: { label: 'بطيئة جدًا', block: 128, pause: 120 },
};
export const bleSpeed = () => { try { return localStorage.getItem('ble_speed') || 'slow'; } catch (_) { return 'slow'; } };
export const setBleSpeed = (v) => { try { localStorage.setItem('ble_speed', v); } catch (_) { /* تخزين غير متاح */ } };

export const canBluetooth = () => !!navigator.bluetooth;

async function findWritable(server) {
  for (const svc of await server.getPrimaryServices()) {
    for (const c of await svc.getCharacteristics()) {
      if (c.properties.writeWithoutResponse || c.properties.write) return c;
    }
  }
  return null;
}

/** طباعة مباشرة عبر Web Bluetooth (أول مرة يختار المستخدم الطابعة) */
export async function printViaBluetooth(bytes, onProgress) {
  if (!navigator.bluetooth) throw new Error('المتصفح لا يدعم البلوتوث؛ استخدم Chrome على أندرويد أو تطبيق RawBT');
  if (!bleChar || !bleChar.service.device.gatt.connected) {
    const device = bleChar?.service.device || await navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: BLE_SERVICES });
    const server = await device.gatt.connect();
    bleChar = await findWritable(server);
    if (!bleChar) { device.gatt.disconnect(); throw new Error('الطابعة لا تدعم البلوتوث منخفض الطاقة (BLE)؛ استخدم تطبيق RawBT'); }
  }
  // قطع 20 بايت (تناسب أي اتصال BLE دون كتابة طويلة)، مع توقف دوري حسب السرعة المختارة حتى لا تمتلئ ذاكرة الطابعة،
  // وإعادة المحاولة عند خطأ عابر بدل التوقف في منتصف الإيصال.
  const speed = BLE_SPEEDS[bleSpeed()] || BLE_SPEEDS.normal;
  let noResp = !!bleChar.properties.writeWithoutResponse;
  const chunk = 20;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const writeOnce = (part) => (noResp ? bleChar.writeValueWithoutResponse(part) : bleChar.writeValueWithResponse(part));
  for (let i = 0, sent = 0; i < bytes.length; i += chunk) {
    const part = bytes.slice(i, i + chunk);
    // الطابعة المشغولة بالطباعة قد ترفض البيانات مؤقتًا: ننتظر ونعيد المحاولة (حتى ~15 ثانية) بدل قطع آخر الإيصال،
    // وبعد أول رفض ننتقل للكتابة بتأكيد الاستلام إن دعمتها الطابعة لأنها تنتظر جاهزيتها تلقائيًا
    for (let attempt = 0; ; attempt++) {
      try { await writeOnce(part); break; } catch (e) {
        if (attempt >= 12) throw new Error(`انقطع الإرسال للطابعة عند ${Math.round((i / bytes.length) * 100)}٪ — اختر سرعة أبطأ وأعد المحاولة`);
        if (noResp && bleChar.properties.write) noResp = false;
        await wait(Math.min(250 * (attempt + 1), 2000));
        if (!bleChar.service.device.gatt.connected) { const server = await bleChar.service.device.gatt.connect(); bleChar = await findWritable(server); }
      }
    }
    sent += part.length;
    if (sent >= speed.block) { sent = 0; onProgress?.(i / bytes.length); await wait(speed.pause); }
  }
  onProgress?.(1);
  await wait(1500); // مهلة حتى تُفرّغ آخر البيانات من ذاكرة البلوتوث قبل أي عملية أخرى
}
