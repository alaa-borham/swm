'use strict';
const { AppError } = require('./errors');

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** تاريخ اليوم YYYY-MM-DD في المنطقة الزمنية المحددة */
const formatters = new Map();
function todayIn(timeZone) {
  const tz = timeZone || 'UTC';
  let f = formatters.get(tz);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
    } catch (_) {
      // منطقة زمنية غير صالحة في الإعدادات لا يجب أن توقف النظام
      f = new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' });
    }
    formatters.set(tz, f);
  }
  return f.format(new Date());
}

function checkDate(d, field = 'التاريخ', required = true) {
  if (d == null || d === '') {
    if (required) throw new AppError('INVALID_DATE', `${field} مطلوب`, 400, { field });
    return null;
  }
  if (!ISO_DATE.test(d) || Number.isNaN(Date.parse(d + 'T00:00:00Z'))) {
    throw new AppError('INVALID_DATE', `${field} غير صحيح (الصيغة YYYY-MM-DD)`, 400, { field, value: d });
  }
  return d;
}

function addDays(d, n) {
  const t = new Date(d + 'T00:00:00Z');
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}

function validTimeZone(tz) {
  try { new Intl.DateTimeFormat('en-CA', { timeZone: tz }); return true; } catch (_) { return false; }
}

function nowIso() { return new Date().toISOString(); }

module.exports = { validTimeZone, todayIn, checkDate, addDays, nowIso, ISO_DATE };
