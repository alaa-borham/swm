// سندات القبض والصرف مع التخصيص، الصناديق والبنوك، التحويل النقدي، الورديات، والمصروفات.
import { h, clear, dt, state, get, api, submitter, toast, run, M, inp, sel, field, num, table, badge, STATUS, partySelect, cashSelect, pageHead, can, askReason, today, monthStart, lookup, readFileB64, modal } from '../lib.js';

// ===================== سند قبض / صرف =====================
export async function cashDoc({ el, q }, type) {
  const isReceipt = type === 'receipt';
  pageHead(isReceipt ? 'سند قبض' : 'سند صرف');
  const accountSel = sel(isReceipt
    ? [{ value: 'AR', label: 'تحصيل من عميل' }, { value: 'AP', label: 'استرداد من مورد' }]
    : [{ value: 'AP', label: 'سداد لمورد/مستحق' }, { value: 'AR', label: 'رد مبلغ لعميل' }], q.account || (isReceipt ? 'AR' : 'AP'));
  const isRep = !!state.rep && !can('parties.all');
  let partyWrap = h('div', { class: 'field' });
  let partySel;
  const cash = isRep ? null : await cashSelect(state.session?.cash_account_id || '', {});
  const amount = inp({ type: 'number' });
  const date = inp({ type: 'date', value: today() });
  const notes = inp({ placeholder: 'البيان' });
  const openBox = h('div');
  let openDocs = [];
  const allocInputs = new Map();

  const loadParty = async () => {
    const kind = accountSel.value === 'AR' ? 'customer' : 'supplier';
    partySel = await partySelect(kind, q.party || '', { onchange: loadOpen });
    partySel.options[0].textContent = kind === 'customer' ? '— اختر العميل —' : '— اختر المورد —';
    clear(partyWrap).append(h('label', null, kind === 'customer' ? 'العميل' : 'المورد'), partySel);
    await loadOpen();
  };
  const loadOpen = async () => {
    clear(openBox); allocInputs.clear();
    if (!partySel.value) return;
    openDocs = (await get('/open-docs', { party_id: partySel.value, account: accountSel.value }))
      .filter((d) => (isReceipt ? (accountSel.value === 'AR' ? d.ledger_side === 'D' : d.ledger_side === 'D') : (accountSel.value === 'AP' ? d.ledger_side === 'C' : d.ledger_side === 'C')) && d.open_amount > 0);
    if (!openDocs.length) { openBox.append(h('div', { class: 'note' }, 'لا توجد مستندات مفتوحة؛ سيُسجل المبلغ دفعة غير مخصصة يمكن تخصيصها لاحقًا.')); return; }
    const rows = openDocs.map((d) => {
      const i = inp({ type: 'number', style: { width: '110px' }, value: q.doc && Number(q.doc) === d.id ? d.open_amount : '' });
      allocInputs.set(d.id, i);
      return { ...d, input: i };
    });
    openBox.append(h('h3', null, 'التخصيص على المستندات المفتوحة'),
      table({ columns: [{ key: 'number', label: 'المستند', render: (d) => h('a', { href: '#/doc/' + d.id }, d.number) }, { key: 'label', label: 'النوع' }, { key: 'date', label: 'التاريخ' },
        { key: 'due_date', label: 'الاستحقاق' }, { key: 'total', label: 'الإجمالي', type: 'money' }, { key: 'open_amount', label: 'المتبقي', type: 'money' }, { key: 'x', label: 'المخصص', render: (d) => d.input }], rows }),
      h('div', { class: 'actions', style: { marginTop: '8px' } }, h('button', { class: 'btn small', onclick: autoAlloc }, 'توزيع تلقائي (الأقدم أولاً)')));
    if (q.doc) amount.value = openDocs.find((d) => d.id === Number(q.doc))?.open_amount || '';
  };
  const autoAlloc = () => {
    let rem = num(amount.value) || 0;
    for (const d of openDocs) { const a = Math.min(rem, d.open_amount); allocInputs.get(d.id).value = a > 0 ? Number(a.toFixed(3)) : ''; rem -= a; }
  };
  accountSel.addEventListener('change', () => { q.party = ''; q.doc = ''; loadParty(); });
  await loadParty();

  const send = submitter();
  el.append(h('div', { class: 'card' },
    h('div', { class: 'grid' }, field('النوع', accountSel), partyWrap, cash ? field(isReceipt ? 'إلى حساب' : 'من حساب', cash, { req: true }) : field('الحساب', h('div', null, 'عهدة المندوب')),
      field('المبلغ', amount, { req: true }), field('التاريخ', date), field('البيان', notes)),
    h('div', { style: { marginTop: '12px' } }, openBox),
    h('div', { class: 'actions', style: { marginTop: '12px' } }, h('button', { class: 'btn ok', onclick: async () => {
      if (!partySel.value) return toast('اختر الطرف', 'bad');
      const allocations = [...allocInputs.entries()].filter(([, i]) => num(i.value) > 0).map(([id, i]) => ({ doc_id: id, amount: num(i.value) }));
      const body = { account: accountSel.value, party_id: Number(partySel.value), cash_account_id: cash ? Number(cash.value) : undefined, amount: num(amount.value), date: date.value, notes: notes.value || null, allocations };
      const d = await run(() => send('POST', isReceipt ? '/receipts' : '/payments', body), 'تم حفظ السند');
      if (d) location.hash = '#/doc/' + d.id;
    } }, 'اعتماد السند'))));
}

// ===================== الصناديق والبنوك =====================
export async function accounts({ el, q }) {
  pageHead('الصناديق والبنوك', can('cash.transfer') ? h('a', { class: 'btn', href: '#/cash-transfer' }, 'تحويل نقدي / توريد') : null);
  const acc = await cashSelect(q.id || '', {}, () => true, { empty: 'ملخص كل الحسابات' });
  const from = inp({ type: 'date', value: q.from || monthStart() });
  const to = inp({ type: 'date', value: q.to || today() });
  const body = h('div');
  const load = async () => {
    const r = await get('/reports/cash', { cash_account_id: acc.value, from: from.value, to: to.value });
    body.replaceChildren(acc.value ? h('div', { class: 'note' }, 'رصيد أول المدة: ', M(r.opening), ' — رصيد آخر المدة: ', M(r.closing)) : '',
      table({ columns: r.columns, rows: r.rows, totals: r.totals, onRow: acc.value ? null : (row) => { acc.value = row.id; load(); } }));
  };
  el.append(h('form', { class: 'row card', style: { padding: '12px' }, onsubmit: (e) => { e.preventDefault(); load(); } }, field('الحساب', acc), field('من', from), field('إلى', to), h('button', { class: 'btn primary' }, 'عرض')), body);
  await load();
}

export async function transfer({ el }) {
  pageHead('تحويل نقدي / توريد عهدة');
  const from = await cashSelect('', {});
  const to = await cashSelect('', {});
  const amount = inp({ type: 'number' });
  const notes = inp({ placeholder: 'البيان' });
  const send = submitter();
  el.append(h('div', { class: 'note' }, 'التحويل بين الصناديق والبنوك وتوريد نقد المندوب حركة داخلية: لا تسدد حساب العميل ولا تُعد إيرادًا.'),
    h('div', { class: 'card', style: { maxWidth: '700px' } }, h('div', { class: 'grid' }, field('من', from, { req: true }), field('إلى', to, { req: true }), field('المبلغ', amount, { req: true }), field('البيان', notes)),
      h('div', { class: 'actions', style: { marginTop: '12px' } }, h('button', { class: 'btn ok', onclick: async () => {
        const d = await run(() => send('POST', '/cash-transfers', { from_id: Number(from.value), to_id: Number(to.value), amount: num(amount.value), notes: notes.value || null }), 'تم التحويل');
        if (d) location.hash = '#/doc/' + d.id;
      } }, 'اعتماد التحويل'))));
}

// ===================== الورديات =====================
export async function sessions({ el, q }) {
  pageHead('الورديات');
  const body = h('div');
  el.append(body);
  const load = async () => {
    clear(body);
    const cur = await get('/sessions/current');
    if (cur) body.append(sessionCard(cur, load));
    else if (can('sessions.own')) body.append(await openForm(load));
    const list = await get('/sessions', { status: q.status });
    body.append(h('h3', null, 'سجل الورديات'), table({ columns: [
      { key: 'number', label: 'الرقم' }, { key: 'user_name', label: 'المستخدم' }, { key: 'cash_account_name', label: 'الصندوق' }, { key: 'opened_at', label: 'الفتح', render: (s) => dt(s.opened_at) },
      { key: 'opening_amount', label: 'الافتتاحي', type: 'money' }, { key: 'expected_amount', label: 'المتوقع', type: 'money' }, { key: 'counted_amount', label: 'المعدود', type: 'money' },
      { key: 'variance', label: 'الفرق', type: 'money' }, { key: 'status', label: 'الحالة', render: (s) => badge({ open: ['مفتوحة', 'ok'], closing: ['بانتظار اعتماد الفرق', 'warn'], closed: ['مغلقة', ''] }, s.status) },
      { key: 'a', label: '', render: (s) => [
        s.status === 'closing' && can('sessions.manage') ? h('button', { class: 'btn small ok', onclick: async () => { if (await run(() => api('POST', `/sessions/${s.id}/approve`, {}), 'تم اعتماد الفرق')) load(); } }, 'اعتماد الفرق') : null,
        s.status !== 'open' && can('sessions.manage') ? h('button', { class: 'btn small', onclick: async () => { const r = await askReason('إعادة فتح الوردية للتصحيح'); if (r && await run(() => api('POST', `/sessions/${s.id}/reopen`, { reason: r }), 'أُعيد فتح الوردية')) load(); } }, 'إعادة فتح') : null,
        s.status === 'open' && can('sessions.manage') ? h('button', { class: 'btn small', onclick: async () => { body.prepend(sessionCard(await get('/sessions/' + s.id), load)); } }, 'عرض') : null] }],
    rows: list }));
  };
  await load();
}

async function openForm(load) {
  const cash = await cashSelect('', {}, (a) => a.kind === 'cash');
  const card = await cashSelect('', {}, (a) => a.kind === 'bank', { empty: '— بدون —' });
  const wh = sel((await lookup('warehouses')).filter((w) => w.active && w.kind === 'main').map((w) => ({ value: w.id, label: w.name })), '');
  const opening = inp({ type: 'number', value: '0' });
  const send = submitter();
  return h('div', { class: 'card' }, h('h3', null, 'فتح وردية'), h('div', { class: 'grid' }, field('الصندوق', cash), field('حساب الشبكة', card), field('المستودع', wh), field('النقد الافتتاحي', opening)),
    h('button', { class: 'btn primary', style: { marginTop: '10px' }, onclick: async () => {
      if (await run(() => send('POST', '/sessions', { cash_account_id: Number(cash.value), card_account_id: card.value ? Number(card.value) : null, warehouse_id: Number(wh.value), opening_amount: num(opening.value) ?? 0 }), 'تم فتح الوردية')) {
        window.dispatchEvent(new CustomEvent('session-changed'));
      }
    } }, 'فتح'));
}

function sessionCard(s, load) {
  const counted = inp({ type: 'number' });
  const reason = inp({ placeholder: 'سبب الفرق إن وجد' });
  return h('div', { class: 'card' }, h('h3', null, `الوردية ${s.number} — ${s.user_name}`),
    h('div', { class: 'doc-head' },
      h('div', null, h('b', null, 'الصندوق'), s.cash_account_name), h('div', null, h('b', null, 'النقد الافتتاحي'), M(s.opening_amount)),
      h('div', null, h('b', null, 'المقبوضات النقدية'), M(s.cash_in)), h('div', null, h('b', null, 'المدفوعات النقدية'), M(s.cash_out)),
      h('div', null, h('b', null, 'النقد المتوقع'), h('strong', null, M(s.live_expected))), h('div', null, h('b', null, 'الشبكة/البنك (لا تدخل الدرج)'), M(s.card_total)),
      h('div', null, h('b', null, 'عدد الفواتير'), s.sales_count)),
    s.breakdown.length ? table({ columns: [{ key: 'label', label: 'النوع' }, { key: 'in', label: 'داخل', type: 'money' }, { key: 'out', label: 'خارج', type: 'money' }], rows: s.breakdown }) : null,
    s.status === 'open' ? h('div', { class: 'row', style: { marginTop: '12px' } }, field('النقد المعدود فعليًا', counted), field('السبب', reason),
      h('button', { class: 'btn primary', onclick: async () => {
        if (counted.value === '') return toast('أدخل النقد المعدود', 'bad');
        const r = await run(() => api('POST', `/sessions/${s.id}/close`, { counted_amount: num(counted.value), reason: reason.value || null }));
        if (r) { toast(r.variance ? `أُغلقت الوردية بفرق ${r.variance} بانتظار الاعتماد` : 'أُغلقت الوردية بلا فرق', r.variance ? '' : 'ok'); window.dispatchEvent(new CustomEvent('session-changed')); }
      } }, 'إغلاق الوردية')) : null);
}

// ===================== المصروفات =====================
export async function expenses({ el, q, isCurrent }) {
  pageHead('المصروفات', h('a', { class: 'btn primary', href: '#/expense' }, 'مصروف جديد'));
  const from = inp({ type: 'date', value: q.from || monthStart() });
  const to = inp({ type: 'date', value: q.to || today() });
  const status = sel([{ value: '', label: 'الكل' }, { value: 'draft', label: 'مسودة' }, { value: 'approved', label: 'معتمد' }], q.status || '');
  const body = h('div');
  const load = async () => {
    const r = await get('/docs', { type: 'expense', from: from.value, to: to.value, status: status.value, limit: 300 });
    if (!isCurrent()) return;
    body.replaceChildren(table({ columns: [
      { key: 'number', label: 'الرقم', render: (d) => h('a', { href: '#/doc/' + d.id }, d.number) }, { key: 'date', label: 'التاريخ' }, { key: 'notes', label: 'البيان' },
      { key: 'total', label: 'المبلغ', type: 'money' }, { key: 'open_amount', label: 'غير مدفوع', type: 'money' }, { key: 'status', label: 'الحالة', render: (d) => badge(STATUS, d.status) }],
    rows: r.rows, onRow: (d) => { location.hash = '#/doc/' + d.id; } }));
  };
  el.append(h('form', { class: 'row card', style: { padding: '12px' }, onsubmit: (e) => { e.preventDefault(); load(); } }, field('من', from), field('إلى', to), field('الحالة', status), h('button', { class: 'btn primary' }, 'عرض')), body);
  await load();
}

export async function expenseForm({ el }) {
  pageHead('تسجيل مصروف');
  const cats = await lookup('expcats');
  const cat = sel(cats.filter((c) => c.active).map((c) => ({ value: c.id, label: c.name })), '');
  const benef = inp({ placeholder: 'اسم المستفيد' });
  const amount = inp({ type: 'number' });
  const tax = inp({ type: 'number', placeholder: '0' });
  const desc = inp({ placeholder: 'البيان' });
  const date = inp({ type: 'date', value: today() });
  const payNow = h('input', { type: 'checkbox', checked: true });
  const acc = await cashSelect(state.session?.cash_account_id || '', {});
  const file = h('input', { type: 'file', accept: 'application/pdf,image/png,image/jpeg,image/webp' });
  const send = submitter();
  el.append(h('div', { class: 'card', style: { maxWidth: '820px' } },
    h('div', { class: 'grid' }, field('التصنيف', cat, { req: true }), field('المستفيد', benef), field('المبلغ قبل الضريبة', amount, { req: true }), field('الضريبة %', tax),
      field('التاريخ', date), field('البيان', desc), field('مرفق (PDF أو صورة حتى 5MB)', file)),
    can('expenses.approve') ? h('div', { class: 'row', style: { marginTop: '10px' } }, h('label', { class: 'check' }, payNow, 'اعتماد ودفع الآن من'), acc) : h('p', { class: 'muted' }, 'سيُحفظ المصروف للمراجعة والاعتماد'),
    h('div', { class: 'actions', style: { marginTop: '12px' } }, h('button', { class: 'btn ok', onclick: async () => {
      let attachment_ids = [];
      if (file.files[0]) {
        const f = file.files[0];
        if (f.size > 5 * 1024 * 1024) return toast('حجم المرفق أكبر من 5MB', 'bad');
        const a = await run(async () => api('POST', '/attachments', { file_name: f.name, mime: f.type, data: await readFileB64(f) }));
        if (!a) return;
        attachment_ids = [a.id];
      }
      const approve = can('expenses.approve');
      const body = { expense_category_id: Number(cat.value), beneficiary: benef.value || null, amount: num(amount.value), tax_pct: tax.value || null, date: date.value,
        description: desc.value || null, attachment_ids, approve, pay: approve && payNow.checked ? { cash_account_id: Number(acc.value) } : null };
      const d = await run(() => send('POST', '/expenses', body), 'تم حفظ المصروف');
      if (d) location.hash = '#/doc/' + d.id;
    } }, 'حفظ'))));
  void modal;
}
