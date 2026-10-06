// قراءة الباركود بكاميرا الجوال: BarcodeDetector المدمج في المتصفح إن وُجد، وإلا مكتبة ZXing المحلية (تُحمَّل عند الحاجة فقط).
import { h, modal, toast } from './lib.js';

export const canScan = () => !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);

let zxingLoading;
const loadZxing = () => zxingLoading || (zxingLoading = new Promise((res, rej) => {
  if (window.ZXing) return res(window.ZXing);
  const s = document.createElement('script');
  s.src = '/vendor/zxing.min.js';
  s.onload = () => res(window.ZXing);
  s.onerror = () => { zxingLoading = null; rej(new Error('تعذر تحميل قارئ الباركود')); };
  document.head.appendChild(s);
}));

const FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'code_93', 'itf', 'codabar', 'qr_code'];

/** يفتح الكاميرا ويعيد نص أول باركود يُقرأ، أو null إن أُغلقت النافذة */
export async function scanBarcode() {
  const video = h('video', { autoplay: true });
  video.muted = true; video.setAttribute('playsinline', ''); video.setAttribute('muted', '');
  const status = h('div', { class: 'small muted', style: { marginTop: '8px', textAlign: 'center' } }, 'وجّه الكاميرا نحو الباركود…');
  const m = modal('مسح الباركود', h('div', null, h('div', { class: 'scan-box' }, video, h('div', { class: 'scan-frame' }), h('div', { class: 'scan-line' })), status), []);
  let stream = null, stopped = false, reader = null;
  const stop = () => {
    stopped = true;
    try { reader?.reset(); } catch (_) { /* ignore */ }
    if (stream) stream.getTracks().forEach((t) => t.stop());
  };
  m.done.then(stop);
  const finish = (code) => { if (stopped) return; if (navigator.vibrate) navigator.vibrate(80); stop(); m.close(code); };
  try {
    let native = null;
    if ('BarcodeDetector' in window) {
      try {
        const supported = await window.BarcodeDetector.getSupportedFormats();
        const f = FORMATS.filter((x) => supported.includes(x));
        if (f.length) native = new window.BarcodeDetector({ formats: f });
      } catch (_) { native = null; }
    }
    if (native) {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } }, audio: false });
      if (stopped) { stop(); return m.done; }
      video.srcObject = stream;
      await video.play().catch(() => {});
      const tick = async () => {
        if (stopped) return;
        try {
          if (video.readyState >= 2) {
            const codes = await native.detect(video);
            if (codes.length && codes[0].rawValue) return finish(codes[0].rawValue.trim());
          }
        } catch (_) { /* إطار غير جاهز */ }
        setTimeout(tick, 120);
      };
      tick();
    } else {
      const ZXing = await loadZxing();
      if (stopped) return m.done;
      reader = new ZXing.BrowserMultiFormatReader();
      reader.decodeOnceFromConstraints({ video: { facingMode: { ideal: 'environment' } }, audio: false }, video)
        .then((r) => finish(String(r.getText ? r.getText() : r.text).trim()))
        .catch((e) => { if (!stopped) status.textContent = 'تعذرت القراءة: ' + (e.message || e); });
    }
  } catch (e) {
    const msg = e && e.name === 'NotAllowedError' ? 'لم يُسمح باستخدام الكاميرا؛ اسمح بها من إعدادات المتصفح للموقع' : (e.message || 'تعذر تشغيل الكاميرا');
    toast(msg, 'bad'); stop(); m.close(null);
  }
  return m.done;
}
