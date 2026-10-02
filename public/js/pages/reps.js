// المناديب: القائمة، العهدة وتسويتها، خطط العمولة، وحساب واعتماد ودفع العمولات.
import { h, get, api, submitter, toast, run, M, Q, inp, sel, field, num, table, badge, STATUS, pageHead, can, askReason, today, monthStart, invalidate, cashSelect, modal } from '../lib.js';

export async function list({ el }) {
  pageHead('المناديب والعهد');
  if (can('warehouses.manage')) {
    const name = inp(); const phone = inp(); const area = inp(); const pct = inp({ type: 'number', placeholder: '%' });
    el.append(h('div', { class: 'card' }, h('h3', null, 'مندوب جديد'), h('div', { class: 'row' }, field('الاسم', name, { req: true }), field('الهاتف', phone), field('المنطقة', area), field('نسبة العمولة %', pct),
      h('button', { class: 'btn primary', onclick: async () => {
        if (await run(() => api('POST', '/reps', { name: name.value, phone: phone.value, area: area.value, commission_pct: pct.value || null }), 'أُنشئ المندوب مع مخزونه وحساب عهدته')) {
          invalidate('reps', 'warehouses', 'cash'); location.reload();
        }
      } }, 'إضافة')), h('p', { class: 'small muted' }, 'يُنشأ تلقائيًا مستودع خاص بمخزون المندوب وحساب نقدي لعهدته. اربط مستخدمًا بدور "المندوب" بهذا المندوب من صفحة المستخدمين.')));
  }
  const r = await get('/reports/reps', { from: '2000-01-01', to: today() });
  const canEdit = can('warehouses.manage');
  el.append(table({ columns: [{ key: 'name', label: 'المندوب', render: (x) => h('a', { href: '#/rep/' + x.rep_id }, x.name) }, ...r.columns.slice(1),
    ...(canEdit ? [{ key: 'e', label: '', render: (x) => (x.rep_id ? [h('button', { class: 'btn small', onclick: (e) => { e.stopPropagation(); editRep(x.rep_id, () => location.reload()); } }, 'تعديل'), ' ', can('stock.transfer') ? h('a', { class: 'btn small ok', href: '#/transfer?rep=' + x.rep_id, onclick: (e) => e.stopPropagation() }, 'تسليم بضاعة') : null] : '') }] : [])],
  rows: r.rows, totals: r.totals, onRow: (x) => { if (x.rep_id) location.hash = '#/rep/' + x.rep_id; } }));
}

export async function view({ el, params }) {
  const rep = await get('/reps/' + params[0]);
  const head = pageHead(`المندوب ${rep.name}`, can('warehouses.manage') ? h('button', { class: 'btn primary', onclick: () => editRep(rep.id, () => location.reload()) }, 'تعديل البيانات وكلمة المرور') : null, can('stock.transfer') ? h('a', { class: 'btn ok', href: '#/transfer?rep=' + rep.id }, 'تسليم بضاعة للمندوب') : null,
    can('cash.transfer') ? h('a', { class: 'btn', href: '#/cash-transfer' }, 'توريد نقد') : null,
    can('commissions.manage') ? h('a', { class: 'btn', href: '#/commissions?rep=' + rep.id }, 'العمولات') : null);
  const from = inp({ type: 'date', value: monthStart() });
  const to = inp({ type: 'date', value: today() });
  const body = h('div');
  const load = async () => {
    const s = await get(`/reps/${rep.id}/custody`, { from: from.value, to: to.value });
    const counted = inp({ type: 'number' });
    const reason = inp({ placeholder: 'سبب الفرق' });
    body.replaceChildren(
      h('div', { class: 'kpis' },
        kpi('حالة العهدة', s.status), kpi('رصيد العهدة النقدية', M(s.cash_balance)), kpi('تحصيلات الفترة', M(s.collections)), kpi('توريدات الفترة', M(s.remittances)),
        kpi('مصروفات من العهدة', M(s.expenses)), kpi('مبيعات الفترة', M(s.sales.total)), s.goods_value !== undefined ? kpi('قيمة البضاعة بالعهدة', M(s.goods_value)) : null),
      h('div', { class: 'card' }, h('h3', null, 'البضاعة المتبقية في عهدته'), table({ columns: [{ key: 'name', label: 'الصنف' }, { key: 'qty', label: 'الكمية', type: 'qty' }, { key: 'base_unit', label: 'الوحدة' },
        s.goods_value !== undefined ? { key: 'cost', label: 'التكلفة', type: 'money' } : null].filter(Boolean), rows: s.goods, empty: 'لا توجد بضاعة في عهدته' })),
      can('reps.custody') ? h('div', { class: 'card' }, h('h3', null, 'تسوية العهدة النقدية'), h('div', { class: 'row' }, field('النقد المعدود مع المندوب', counted), field('السبب', reason),
        h('button', { class: 'btn primary', onclick: async () => {
          if (await run(() => api('POST', `/reps/${rep.id}/settle`, { counted_cash: num(counted.value), reason: reason.value || null }), 'سُجلت التسوية')) load();
        } }, 'تسوية')), h('p', { class: 'small muted' }, 'فروق البضاعة تُسوّى بجرد مستودع المندوب من صفحة الجرد.')) : null);
  };
  const plans = h('div', { class: 'card' }, h('h3', null, 'خطط العمولة'), table({ columns: [{ key: 'rate_bp', label: 'النسبة %' }, { key: 'valid_from', label: 'سارية من' }, { key: 'valid_to', label: 'حتى' }, { key: 'basis', label: 'الأساس', render: () => 'التحصيل المؤهل قبل الضريبة' }], rows: rep.plans, empty: 'لا توجد خطة' }));
  if (can('commissions.plans')) {
    const rate = inp({ type: 'number' }); const vf = inp({ type: 'date', value: today() });
    plans.append(h('div', { class: 'row', style: { marginTop: '8px' } }, field('نسبة جديدة %', rate), field('سارية من', vf), h('button', { class: 'btn', onclick: async () => {
      const reason = await askReason('تغيير خطة العمولة');
      if (reason && await run(() => api('POST', `/reps/${rep.id}/plans`, { rate_pct: num(rate.value), valid_from: vf.value, reason }), 'حُفظت الخطة')) location.reload();
    } }, 'إضافة خطة')));
  }
  if (head) el.append(head);
  el.append(h('form', { class: 'row card filters', style: { padding: '12px' }, onsubmit: (e) => { e.preventDefault(); load(); } }, field('من', from), field('إلى', to), h('button', { class: 'btn primary' }, 'عرض')), body, plans);
  await load();
}
const kpi = (k, v) => h('div', { class: 'kpi' }, h('div', { class: 'k' }, k), h('div', { class: 'v' }, v));

export async function commissions({ el, q, isCurrent }) {
  pageHead('العمولات');
  const reps = await get('/reps');
  const repSel = sel(reps.map((r) => ({ value: r.id, label: r.name })), q.rep || '');
  const from = inp({ type: 'date' });
  const to = inp({ type: 'date', value: today() });
  const preview = h('div');
  const docs = h('div');
  const send = submitter();
  const load = async () => {
    const items = await get('/commissions/preview', { rep_id: repSel.value, from: from.value, to: to.value });
    if (!isCurrent()) return;
    const total = items.reduce((s, i) => s + (i.amount || 0), 0);
    preview.replaceChildren(h('h3', null, 'تحصيلات مؤهلة غير محتسبة'), table({ columns: [{ key: 'date', label: 'التاريخ' }, { key: 'ref', label: 'المرجع' }, { key: 'kind', label: 'النوع', render: (r) => (r.kind === 'collection' ? 'تحصيل' : 'تصحيح') },
      { key: 'base', label: 'الأساس قبل الضريبة', type: 'money' }, { key: 'rate', label: 'النسبة %' }, { key: 'amount', label: 'العمولة', type: 'money' }], rows: items, totals: { amount: total }, empty: 'لا يوجد تحصيل مؤهل' }),
    items.length ? h('button', { class: 'btn primary', style: { marginTop: '10px' }, onclick: async () => {
      const d = await run(() => send('POST', '/commissions', { rep_id: Number(repSel.value), from: from.value || null, to: to.value }), 'حُسبت العمولة كمسودة للمراجعة');
      if (d) load();
    } }, 'حساب العمولة (مسودة)') : null);
    const r = await get('/docs', { type: 'commission', rep_id: repSel.value, limit: 100 });
    docs.replaceChildren(h('h3', null, 'مستندات العمولة'), table({ columns: [
      { key: 'number', label: 'الرقم', render: (d) => h('a', { href: '#/doc/' + d.id }, d.number) }, { key: 'date', label: 'حتى تاريخ' }, { key: 'net', label: 'الأساس', type: 'money' },
      { key: 'total', label: 'المبلغ', type: 'money' }, { key: 'open_amount', label: 'غير مدفوع', type: 'money' }, { key: 'status', label: 'الحالة', render: (d) => badge(STATUS, d.status) },
      { key: 'a', label: '', render: (d) => [
        d.status === 'draft' ? h('button', { class: 'btn small ok', onclick: async () => { if (await run(() => api('POST', `/commissions/${d.id}/approve`, {}), 'اعتُمدت العمولة')) load(); } }, 'اعتماد') : null,
        d.status === 'draft' ? h('button', { class: 'btn small danger', onclick: async () => { const rs = await askReason('إلغاء مسودة العمولة'); if (rs && await run(() => api('POST', `/commissions/${d.id}/cancel`, { reason: rs }), 'أُلغيت')) load(); } }, 'إلغاء') : null,
        d.status === 'approved' && d.open_amount > 0 && can('commissions.pay') ? h('button', { class: 'btn small primary', onclick: () => pay(d, load) }, 'دفع') : null] }],
    rows: r.rows }));
  };
  el.append(h('form', { class: 'row card filters', style: { padding: '12px' }, onsubmit: (e) => { e.preventDefault(); load(); } }, field('المندوب', repSel), field('من (اختياري)', from), field('إلى', to), h('button', { class: 'btn primary' }, 'عرض')),
    h('div', { class: 'note' }, 'الأساس: التحصيل المخصص لفواتير المندوب بعد استبعاد الضريبة. المرتجع المردود وإلغاء التحصيل ينشئان تصحيحًا سالبًا. الاعتماد يثبت المصروف والاستحقاق مرة واحدة، والدفع يسوي الاستحقاق ويمنع الدفع مرتين.'),
    h('div', { class: 'card' }, preview), h('div', { class: 'card' }, docs));
  if (repSel.value) await load();
  repSel.addEventListener('change', load);
}

async function pay(d, done) {
  const acc = await cashSelect('', {});
  const amt = inp({ type: 'number', value: d.open_amount });
  const send = submitter();
  const m = modal(`دفع العمولة ${d.number}`, h('div', { class: 'grid' }, field('من حساب', acc), field('المبلغ', amt)),
    [{ label: 'دفع', class: 'primary', onClick: async () => !!(await run(() => send('POST', `/commissions/${d.id}/pay`, { cash_account_id: Number(acc.value), amount: num(amt.value) }), 'تم الدفع')) }]);
  if (await m.done) done();
  void Q; void toast;
}

/** تعديل بيانات المندوب: الاسم والهاتف والمنطقة والحالة ونسبة العمولة وحساب دخوله وكلمة المرور */
export async function editRep(repId, onSaved) {
  const rep = await get('/reps/' + repId);
  const users = can('users.manage') ? await get('/users') : [];
  const user = users.find((u) => u.rep_id === rep.id);
  const current = [...rep.plans].reverse().find((p) => !p.valid_to) || rep.plans[rep.plans.length - 1];
  const f = {
    name: inp({ value: rep.name }), phone: inp({ value: rep.phone || '' }), area: inp({ value: rep.area || '' }),
    active: h('input', { type: 'checkbox', checked: !!rep.active }),
    rate: inp({ type: 'number', value: current ? current.rate_bp : '', placeholder: '%' }),
    rateReason: inp({ placeholder: 'مثال: اتفاق جديد' }),
    username: inp({ value: user ? user.username : '', disabled: !!user || null, autocomplete: 'off' }),
    password: inp({ type: 'password', placeholder: user ? 'اتركها فارغة لعدم التغيير' : 'كلمة المرور', autocomplete: 'new-password' }),
  };
  const rateReasonField = field('سبب تغيير النسبة', f.rateReason, { req: true });
  rateReasonField.style.display = 'none';
  f.rate.addEventListener('input', () => { rateReasonField.style.display = num(f.rate.value) !== (current ? current.rate_bp : null) ? '' : 'none'; });
  const canPlans = can('commissions.plans');
  const login = can('users.manage') ? h('div', null, h('h4', { style: { margin: '14px 0 6px' } }, 'حساب الدخول للمندوب'),
    h('div', { class: 'grid' }, field('اسم المستخدم', f.username, { req: !user }), field(user ? 'كلمة مرور جديدة' : 'كلمة المرور', f.password, { req: !user })),
    h('p', { class: 'small muted', style: { margin: '4px 0 0' } }, user
      ? 'عند تعيين كلمة مرور جديدة يُطلب من المندوب تغييرها عند أول دخول، وتُغلق جلساته المفتوحة.'
      : 'لا يوجد حساب دخول لهذا المندوب. اكتب اسم مستخدم وكلمة مرور (8 أحرف على الأقل بأرقام وحروف) لإنشائه، أو اتركهما فارغين.')) : null;
  modal('تعديل بيانات المندوب', h('div', null,
    h('div', { class: 'grid' }, field('الاسم', f.name, { req: true }), field('الهاتف', f.phone), field('المنطقة', f.area),
      canPlans ? field('نسبة العمولة %', f.rate) : null, canPlans ? rateReasonField : null),
    h('label', { class: 'check', style: { marginTop: '8px' } }, f.active, 'نشط'), login),
  [{ label: 'حفظ', class: 'primary', onClick: async () => {
    const newRate = num(f.rate.value);
    const rateChanged = canPlans && newRate != null && newRate !== (current ? current.rate_bp : null);
    if (rateChanged && f.rateReason.value.trim().length < 3) { toast('اكتب سبب تغيير النسبة', 'bad'); return false; }
    if (!user && (f.username.value || f.password.value) && !(f.username.value && f.password.value)) { toast('اكتب اسم المستخدم وكلمة المرور معًا', 'bad'); return false; }
    const ok = await run(async () => {
      await api('PUT', '/reps/' + rep.id, { name: f.name.value, phone: f.phone.value, area: f.area.value, active: f.active.checked ? 1 : 0 });
      if (rateChanged) await api('POST', `/reps/${rep.id}/plans`, { rate_pct: newRate, valid_from: today(), reason: f.rateReason.value.trim() });
      if (user && f.password.value) await api('PUT', '/users/' + user.id, { password: f.password.value });
      if (!user && f.username.value && f.password.value) await api('POST', '/users', { username: f.username.value, full_name: f.name.value, password: f.password.value, roles: ['rep'], rep_id: rep.id });
      return true;
    }, 'حُفظت بيانات المندوب');
    if (ok) { invalidate('reps'); onSaved?.(); }
    return !!ok;
  } }]);
}
