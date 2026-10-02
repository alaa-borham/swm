'use strict';
// رمز QR للفاتورة المبسطة بصيغة TLV (اسم البائع، الرقم الضريبي، وقت الفاتورة، الإجمالي، الضريبة) مشفرة Base64.
// هذه الصيغة المطلوبة للفواتير المبسطة في المرحلة الأولى من الفوترة الإلكترونية في السعودية؛
// الربط والتوقيع الإلكتروني (المرحلة الثانية) أو متطلبات بلدان أخرى تُنفذ حسب الجهة الضريبية.
const QRCode = require('qrcode');
const { fail } = require('../lib/errors');
const { fromMinor, getMoneyDecimals } = require('../lib/money');

function tlv(fields) {
  const parts = fields.map(([tag, value]) => {
    const v = Buffer.from(String(value), 'utf8');
    if (v.length > 255) fail('VALIDATION', 'قيمة أطول من المسموح في رمز الفاتورة');
    return Buffer.concat([Buffer.from([tag, v.length]), v]);
  });
  return Buffer.concat(parts).toString('base64');
}

/** رقم ضريبة القيمة المضافة السعودي: 15 رقمًا يبدأ وينتهي بـ 3 */
function validVatNumber(v) { return /^3\d{13}3$/.test(String(v || '').trim()); }

function invoicePayload(ctx, doc) {
  const s = ctx.settings();
  if (!s.org_tax_number) fail('VALIDATION', 'أدخل الرقم الضريبي للمؤسسة في الإعدادات لإصدار رمز الفاتورة');
  if (!validVatNumber(s.org_tax_number)) fail('VALIDATION', 'الرقم الضريبي غير صحيح: يجب أن يكون 15 رقمًا يبدأ وينتهي بالرقم 3 (كما في شهادة التسجيل في ضريبة القيمة المضافة). صحّحه من الإعدادات');
  const ts = (doc.approved_at || doc.created_at).replace(/\.\d+Z$/, 'Z');
  const sign = doc.type === 'sale_return' ? -1 : 1;
  const amt = (v) => (sign * fromMinor(v)).toFixed(getMoneyDecimals());
  return tlv([[1, s.org_name], [2, s.org_tax_number], [3, ts], [4, amt(doc.total)], [5, amt(doc.tax)]]);
}

async function qrSvg(ctx, doc) {
  if (!['sale', 'sale_return'].includes(doc.type) || doc.status !== 'approved') fail('VALIDATION', 'رمز الفاتورة لفواتير البيع والمرتجع المعتمدة');
  const payload = invoicePayload(ctx, doc);
  return { payload, svg: await QRCode.toString(payload, { type: 'svg', margin: 4, errorCorrectionLevel: 'M' }) };
}

/** فك TLV للتحقق */
function decodeTlv(b64) {
  const buf = Buffer.from(b64, 'base64');
  const out = {};
  for (let i = 0; i < buf.length;) {
    const tag = buf[i], len = buf[i + 1];
    out[tag] = buf.slice(i + 2, i + 2 + len).toString('utf8');
    i += 2 + len;
  }
  return out;
}

module.exports = { tlv, invoicePayload, qrSvg, decodeTlv, validVatNumber };
