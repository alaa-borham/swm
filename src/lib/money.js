'use strict';
// حساب دقيق بأعداد صحيحة: المبالغ بأصغر وحدة للعملة، والكميات بوحدة الأساس × 1000.
const { AppError } = require('./errors');

const QTY_SCALE = 1000;
let moneyDecimals = 2;
let MS = 100;

function setMoneyDecimals(d) {
  d = Number(d);
  if (!Number.isInteger(d) || d < 0 || d > 3) throw new Error('money decimals must be 0..3');
  moneyDecimals = d;
  MS = 10 ** d;
}
function getMoneyDecimals() { return moneyDecimals; }

function toNumber(x, field) {
  if (typeof x === 'string') x = x.trim().replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x660)).replace(/٫/g, '.').replace(/,/g, '');
  const n = Number(x);
  if (x === '' || x === null || x === undefined || !Number.isFinite(n)) {
    throw new AppError('INVALID_NUMBER', `قيمة رقمية غير صحيحة${field ? ' في ' + field : ''}`, 400, { field, value: x });
  }
  return n;
}

function scaleExact(x, scale, field, maxDecimals) {
  const n = toNumber(x, field);
  const scaled = Number((n * scale).toPrecision(15));
  const r = Math.round(scaled);
  if (Math.abs(scaled - r) > 1e-6) {
    throw new AppError('TOO_MANY_DECIMALS', `عدد المنازل العشرية أكبر من المسموح${field ? ' في ' + field : ''} (الحد ${maxDecimals})`, 400, { field, value: x });
  }
  if (!Number.isSafeInteger(r)) throw new AppError('NUMBER_TOO_LARGE', 'القيمة أكبر من المسموح', 400, { field });
  return r;
}

/** مبلغ بشري (103.5) → عدد صحيح بأصغر وحدة (10350) */
function toMinor(x, field) { return scaleExact(x, MS, field, moneyDecimals); }
/** عدد صحيح → رقم بشري */
function fromMinor(n) { return n == null ? null : Number((n / MS).toFixed(moneyDecimals)); }

/** كمية بشرية → وحدة × 1000 مع تحقق من دقة الصنف */
function toQty(x, decimals = 3, field) {
  const q = scaleExact(x, QTY_SCALE, field, decimals);
  const step = 10 ** (3 - decimals);
  if (q % step !== 0) {
    throw new AppError('QTY_PRECISION', decimals === 0 ? `الكمية يجب أن تكون عددًا صحيحًا${field ? ' في ' + field : ''}` : `دقة الكمية تتجاوز ${decimals} منازل عشرية`, 400, { field, value: x });
  }
  return q;
}
function fromQty(n) { return n == null ? null : Number((n / QTY_SCALE).toFixed(3)); }

/** نسبة مئوية (15) → basis points (1500) */
function toBp(x, field) {
  const bp = scaleExact(x, 100, field, 2);
  if (bp < 0 || bp > 10000) throw new AppError('INVALID_PERCENT', 'النسبة يجب أن تكون بين 0 و100', 400, { field });
  return bp;
}
function fromBp(bp) { return bp == null ? null : bp / 100; }

/** round(a*b/c) بتقريب نصف بعيدًا عن الصفر وبدقة كاملة عبر BigInt */
function mulDiv(a, b, c) {
  if (c === 0) throw new Error('division by zero');
  let num = BigInt(a) * BigInt(b);
  let den = BigInt(c);
  if (den < 0n) { num = -num; den = -den; }
  const neg = num < 0n;
  if (neg) num = -num;
  let q = num / den;
  const r = num % den;
  if (r * 2n >= den) q += 1n;
  const out = Number(neg ? -q : q);
  if (!Number.isSafeInteger(out)) throw new AppError('NUMBER_TOO_LARGE', 'القيمة أكبر من المسموح', 400);
  return out;
}

/** توزيع مبلغ صحيح على أوزان بطريقة الباقي الأكبر بحيث يساوي المجموع المبلغ تمامًا */
function distribute(total, weights) {
  const n = weights.length;
  if (n === 0) return [];
  let sumW = weights.reduce((s, w) => s + w, 0);
  const ws = sumW > 0 ? weights : weights.map(() => 1);
  if (sumW <= 0) sumW = n;
  const sign = total < 0 ? -1 : 1;
  const abs = Math.abs(total);
  const parts = ws.map((w) => {
    const exact = BigInt(abs) * BigInt(w);
    return { q: Number(exact / BigInt(sumW)), r: Number(exact % BigInt(sumW)) };
  });
  let rem = abs - parts.reduce((s, p) => s + p.q, 0);
  const order = parts.map((p, i) => i).sort((i, j) => parts[j].r - parts[i].r || i - j);
  for (let k = 0; k < rem; k++) parts[order[k % n]].q += 1;
  return parts.map((p) => sign * p.q);
}

module.exports = {
  QTY_SCALE, setMoneyDecimals, getMoneyDecimals, toMinor, fromMinor, toQty, fromQty, toBp, fromBp, mulDiv, distribute, toNumber,
};
