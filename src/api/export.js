'use strict';
// تصدير التقارير الجدولية إلى Excel أو CSV.
const ExcelJS = require('exceljs');

async function toXlsx(report, orgName) {
  const wb = new ExcelJS.Workbook();
  wb.creator = orgName || '';
  const ws = wb.addWorksheet('تقرير', { views: [{ rightToLeft: true }] });
  ws.addRow([report.title || 'تقرير']).font = { bold: true, size: 14 };
  const sub = [orgName, report.from && report.to ? `من ${report.from} إلى ${report.to}` : report.as_of ? `حتى ${report.as_of}` : ''].filter(Boolean).join(' — ');
  if (sub) ws.addRow([sub]);
  if (report.opening !== undefined) ws.addRow(['رصيد أول المدة', report.opening]);
  ws.addRow([]);
  const head = ws.addRow(report.columns.map((c) => c.label));
  head.font = { bold: true };
  head.eachCell((c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8EEF5' } }; });
  for (const r of report.rows) ws.addRow(report.columns.map((c) => (r[c.key] === undefined ? null : r[c.key])));
  if (report.totals && Object.keys(report.totals).length) {
    const t = ws.addRow(report.columns.map((c, i) => (i === 0 ? 'الإجمالي' : report.totals[c.key] ?? null)));
    t.font = { bold: true };
  }
  if (report.closing !== undefined) ws.addRow(['رصيد آخر المدة', report.closing]);
  report.columns.forEach((c, i) => {
    const col = ws.getColumn(i + 1);
    col.width = Math.max(12, Math.min(40, String(c.label).length + 6));
    if (c.type === 'money') col.numFmt = '#,##0.00';
  });
  return wb.xlsx.writeBuffer();
}

function toCsv(report) {
  const esc = (v) => {
    if (v == null) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [report.columns.map((c) => esc(c.label)).join(',')];
  for (const r of report.rows) lines.push(report.columns.map((c) => esc(r[c.key])).join(','));
  if (report.totals) lines.push(report.columns.map((c, i) => esc(i === 0 ? 'الإجمالي' : report.totals[c.key])).join(','));
  return '﻿' + lines.join('\r\n');
}

module.exports = { toXlsx, toCsv };
