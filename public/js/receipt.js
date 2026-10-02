// صفحة الفاتورة العامة (رابط المشاركة): تعرض الفاتورة بنفس قالب الطباعة دون تسجيل دخول
import { h, state } from './lib.js';
import { thermal, a4 } from './pages/docs.js';

const area = document.getElementById('area');
const token = location.pathname.split('/').pop();
(async () => {
  try {
    const res = await fetch('/public/receipt/' + encodeURIComponent(token), { cache: 'no-store' });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error?.message || 'الرابط غير صالح');
    state.settings = { ...state.settings, ...data.settings };
    const d = data.doc;
    d._qr = data.qr ? h('img', { src: 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(data.qr), alt: 'QR', style: { width: '40mm', height: 'auto', display: 'block', margin: '8px auto' } }) : null;
    document.title = `${d.label} ${d.number} — ${data.settings.org_name}`;
    document.getElementById('org').textContent = data.settings.org_name;
    const narrow = window.innerWidth < 700;
    area.replaceChildren(narrow || d.type === 'receipt' ? thermal(d, data.settings, false) : a4(d, data.settings, false));
    document.head.appendChild(h('style', null, narrow ? `@page { size: ${data.settings.receipt_width_mm || 80}mm auto; margin: 2mm; }` : '@page { size: A4; margin: 10mm; }'));
  } catch (e) {
    area.replaceChildren(h('p', { style: { textAlign: 'center', padding: '40px' } }, e.message));
  }
})();
document.getElementById('print-btn').addEventListener('click', () => window.print());
