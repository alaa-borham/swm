// أدوات العمل الميداني: المطلوب تحصيله، تقرير المندوب اليومي، وكشف حساب العميل للمشاركة.
import { h, get, money, inp, sel, field, table, pageHead, can, today, state, lookup, openWhatsApp, dt } from '../lib.js';
import { previewNode } from './docs.js';

const row = (k, v, bold) => h('div', { class: 'tr' + (bold ? ' b' : '') }, h('span', null, k), h('span', null, v));
const width = () => `${(state.settings.receipt_width_mm || 80) - 8}mm`;
const head = (title) => [
  state.settings.org_logo_url ? h('img', { class: 'logo', src: state.settings.org_logo_url, alt: '' }) : null,
  h('div', { class: 'c' }, h('b', { style: { fontSize: '1.15em' } }, state.settings.org_name)),
  h('div', { class: 'sep' }), h('div', { class: 'c' }, h('b', null, title))];

/** نص تذكير بالرصيد للعميل */
export function reminderText(p) {
  return [`${state.settings.org_name}`, `السادة/ ${p.name}${p.code ? ` (${p.code})` : ''}`,
    `رصيدكم المستحق: ${money(p.open ?? p.ar_balance)}`,
    p.overdue ? `منه متأخر السداد: ${money(p.overdue)}` : null,
    'نرجو التكرم بالسداد، وشكرًا لتعاملكم معنا.'].filter(Boolean).join('\n');
}

// ===================== المطلوب تحصيله =====================
export async function collect({ el, q }) {
  pageHead('المطلوب تحصيله');
  const onlyOverdue = h('input', { type: 'checkbox', checked: q.overdue === '1' });
  const reps = !state.rep && can('reps.view') ? await lookup('reps').catch(() => []) : [];
  const repSel = reps.length ? sel([{ value: '', label: 'كل المناديب' }, ...reps.map((r) => ({ value: r.id, label: r.name }))], q.rep || '') : null;
  const body = h('div');
  const load = async () => {
    const r = await get('/reports/collections', { only_overdue: onlyOverdue.checked ? '1' : '', rep_id: repSel?.value || '' });
    const tot = r.rows.reduce((a, x) => ({ open: a.open + x.open, overdue: a.overdue + x.overdue }), { open: 0, overdue: 0 });
    // بطاقة لكل عميل (أوضح على الجوال من جدول عريض)
    const card = (x) => h('div', { class: 'collect-card' + (x.days > 30 ? ' bad' : x.overdue ? ' late' : '') },
      h('div', { class: 'cc-top' },
        h('div', null, h('a', { href: '#/party/' + x.party_id }, h('b', null, x.name)), x.code ? h('span', { class: 'muted small' }, ' ', x.code) : null,
          h('div', { class: 'small muted' }, [x.rep_name && !state.rep ? x.rep_name : null, `${x.invoices} فاتورة مفتوحة`, `آخر تحصيل: ${x.last_receipt || '—'}`].filter(Boolean).join(' · '))),
        h('div', { class: 'cc-amt' }, h('b', null, money(x.open)), x.overdue ? h('div', { class: 'cc-late' }, 'متأخر ', money(x.overdue), ` · ${x.days} يوم`) : null)),
      h('div', { class: 'collect-acts' },
        can('cash.receipt') ? h('a', { class: 'btn small primary', href: `#/receipt?party=${x.party_id}` }, 'تحصيل') : null,
        h('button', { class: 'btn small', onclick: () => openWhatsApp(x.phone, reminderText(x)) }, 'تذكير واتساب'),
        x.phone ? h('a', { class: 'btn small', href: 'tel:' + x.phone }, 'اتصال') : null,
        h('a', { class: 'btn small', href: '#/party/' + x.party_id }, 'كشف الحساب')));
    body.replaceChildren(
      h('div', { class: 'home-stats', style: { marginBottom: '12px' } },
        h('div', { class: 'home-stat' }, h('span', { class: 'k' }, `إجمالي المستحق (${r.rows.length} عميل)`), h('span', { class: 'v' }, money(tot.open))),
        h('div', { class: 'home-stat' }, h('span', { class: 'k' }, 'منه متأخر'), h('span', { class: 'v', style: { color: 'var(--bad)' } }, money(tot.overdue)))),
      r.rows.length ? h('div', { class: 'collect-list' }, r.rows.map(card)) : h('div', { class: 'empty card' }, 'لا توجد مبالغ مستحقة 👍'));
  };
  onlyOverdue.addEventListener('change', load);
  repSel?.addEventListener('change', load);
  el.append(h('div', { class: 'card row filters', style: { padding: '12px', alignItems: 'center' } },
    h('label', { class: 'row', style: { gap: '6px', alignItems: 'center' } }, onlyOverdue, 'المتأخر فقط'), repSel ? field('المندوب', repSel) : null), body);
  await load();
}

// ===================== تقرير المندوب اليومي =====================
export async function repDay({ el, q }) {
  pageHead('تقرير المندوب اليومي');
  const reps = !state.rep && can('reps.view') ? await lookup('reps').catch(() => []) : [];
  const repSel = reps.length ? sel(reps.map((r) => ({ value: r.id, label: r.name })), q.rep || reps[0]?.id) : null;
  const date = inp({ type: 'date', value: q.date || today() });
  const body = h('div');
  let data;
  const load = async () => {
    if (!state.rep && !repSel) { body.replaceChildren(h('div', { class: 'empty' }, 'لا يوجد مناديب')); return; }
    data = await get('/rep-day', { rep_id: repSel?.value || '', date: date.value });
    const s = data.summary;
    const stat = (k, v, c) => h('div', { class: 'home-stat' }, h('span', { class: 'k' }, k), h('span', { class: 'v', style: c ? { color: c } : null }, money(v)));
    body.replaceChildren(
      h('div', { class: 'home-stats', style: { marginBottom: '12px' } },
        stat(`المبيعات (${s.sales_count})`, s.sales_total), stat('منها نقدًا', s.sales_cash), stat('منها آجل', s.sales_credit, 'var(--warn)'),
        stat('تحصيل ديون سابقة', s.collections, 'var(--ok)'), stat('المرتجعات', s.returns_total, 'var(--bad)'),
        stat('النقد المستلم اليوم', s.cash_in_day), stat('العهدة النقدية الآن', s.cash_custody)),
      h('div', { class: 'actions', style: { margin: '0 0 12px' } },
        h('button', { class: 'btn primary', onclick: () => previewNode(repDayNode(data), { format: 'thermal', filename: `تقرير-${data.rep.name}-${data.date}.png` }) }, 'طباعة / مشاركة التقرير')),
      h('h3', null, 'فواتير البيع'),
      table({ columns: [{ key: 'number', label: 'الفاتورة', render: (x) => h('a', { href: '#/doc/' + x.doc_id }, x.number) }, { key: 'party', label: 'العميل' },
        { key: 'total', label: 'الإجمالي', type: 'money' }, { key: 'paid', label: 'نقدًا', type: 'money' }, { key: 'credit', label: 'آجل', type: 'money' }], rows: data.sales, empty: 'لا توجد مبيعات' }),
      h('h3', null, 'تحصيل ديون سابقة'),
      table({ columns: [{ key: 'number', label: 'السند', render: (x) => h('a', { href: '#/doc/' + x.doc_id }, x.number) }, { key: 'party', label: 'العميل' }, { key: 'total', label: 'المبلغ', type: 'money' }], rows: data.collections, empty: 'لا يوجد' }),
      data.returns.length ? h('h3', null, 'المرتجعات') : null,
      data.returns.length ? table({ columns: [{ key: 'number', label: 'المرتجع', render: (x) => h('a', { href: '#/doc/' + x.doc_id }, x.number) }, { key: 'party', label: 'العميل' }, { key: 'total', label: 'المبلغ', type: 'money' }], rows: data.returns }) : null,
      h('h3', null, 'البضاعة المتبقية في العهدة'),
      table({ columns: [{ key: 'name', label: 'الصنف' }, { key: 'qty', label: 'الكمية', render: (x) => `${x.qty} ${x.unit}` }], rows: data.stock, empty: 'لا توجد بضاعة' }));
  };
  repSel?.addEventListener('change', load);
  date.addEventListener('change', load);
  el.append(h('div', { class: 'card row filters', style: { padding: '12px' } }, repSel ? field('المندوب', repSel) : null, field('التاريخ', date)), body);
  await load();
}

function repDayNode(d) {
  const s = d.summary;
  return h('div', { class: 'print-thermal', style: { width: width() } }, ...head('تقرير المندوب اليومي'),
    row('المندوب', d.rep.name), row('التاريخ', d.date), h('div', { class: 'sep' }),
    row(`المبيعات (${s.sales_count})`, money(s.sales_total), true), row('نقدًا', money(s.sales_cash)), row('آجل', money(s.sales_credit)),
    row('تحصيل ديون سابقة', money(s.collections)), row('المرتجعات', money(s.returns_total)),
    s.refunds ? row('مدفوع للعملاء', money(s.refunds)) : null,
    h('div', { class: 'sep' }), row('النقد المستلم اليوم', money(s.cash_in_day), true), row('العهدة النقدية الآن', money(s.cash_custody)),
    d.sales.length ? [h('div', { class: 'sep' }), h('table', { class: 't-lines' }, h('thead', null, h('tr', null, h('th', null, 'العميل'), h('th', null, 'الفاتورة'), h('th', null, 'الإجمالي'))),
      h('tbody', null, d.sales.map((x) => h('tr', null, h('td', null, x.party), h('td', { class: 'n' }, x.number), h('td', { class: 'n' }, money(x.total))))))] : null,
    d.collections.length ? [h('div', { class: 'sep' }), h('div', { class: 'c' }, h('b', null, 'التحصيلات')), h('table', { class: 't-lines' },
      h('tbody', null, d.collections.map((x) => h('tr', null, h('td', null, x.party), h('td', { class: 'n' }, money(x.total))))))] : null,
    d.stock.length ? [h('div', { class: 'sep' }), h('div', { class: 'c' }, h('b', null, 'البضاعة المتبقية')), h('table', { class: 't-lines' },
      h('tbody', null, d.stock.map((x) => h('tr', null, h('td', null, x.name), h('td', { class: 'n' }, `${x.qty} ${x.unit}`)))))] : null,
    h('div', { class: 'sep' }), h('div', { class: 'c small' }, 'طُبع ', dt(new Date().toISOString())),
    h('div', { style: { marginTop: '18px' } }, row('توقيع المندوب', '..........'), row('توقيع المستلم', '..........')));
}

// ===================== كشف حساب العميل للمشاركة =====================
export function statementNode(p, r) {
  return h('div', { class: 'print-thermal', style: { width: width() } }, ...head('كشف حساب عميل'),
    h('div', { class: 'c', style: { fontWeight: '700', margin: '2px 0' } }, p.name), p.code ? row('رقم العميل', p.code) : null,
    row('الفترة', `${r.from === '0000-01-01' ? 'من البداية' : r.from} ← ${r.to}`), h('div', { class: 'sep' }),
    row('الرصيد السابق', money(r.opening)),
    r.rows.length ? h('table', { class: 't-lines' },
      h('thead', null, h('tr', null, h('th', null, 'البيان'), h('th', null, 'عليه'), h('th', null, 'له'), h('th', null, 'الرصيد'))),
      h('tbody', null, r.rows.map((x) => h('tr', null, h('td', null, x.type, ' ', h('span', { style: { fontSize: '.85em' } }, x.number), h('div', { style: { fontSize: '.85em' } }, x.date)),
        h('td', { class: 'n' }, x.debit ? money(x.debit) : ''), h('td', { class: 'n' }, x.credit ? money(x.credit) : ''), h('td', { class: 'n' }, money(x.balance)))))) : h('div', { class: 'c' }, 'لا توجد حركات في الفترة'),
    h('div', { class: 'sep' }), row('الرصيد المستحق', money(r.closing), true),
    p.overdue ? row('منه متأخر', money(p.overdue)) : null,
    h('div', { class: 'c small', style: { marginTop: '6px' } }, 'طُبع ', dt(new Date().toISOString())));
}
