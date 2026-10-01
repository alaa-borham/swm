// الإدارة: الإعدادات، المستخدمون والأدوار، سجل التدقيق، النسخ الاحتياطي، الاستيراد، الأرصدة الافتتاحية، إقفال الفترات، كلمة المرور.
import { h, clear, dt, state, get, api, submitter, toast, run, M, inp, sel, field, num, table, pageHead, can, askReason, today, lookup, readFileB64, download, partySelect, cashSelect, warehouseSelect, modal } from '../lib.js';

export async function settings({ el }) {
  pageHead('الإعدادات');
  const s = await get('/settings');
  const F = (key, label, attrs = {}) => { const i = inp({ value: s[key] ?? '', ...attrs }); i.dataset.key = key; return field(label, i); };
  const chk = (key, label) => { const c = h('input', { type: 'checkbox', checked: s[key] === '1' }); c.dataset.key = key; return h('label', { class: 'check' }, c, label); };
  const basis = sel([{ value: 'value', label: 'بنسبة قيمة البند' }, { value: 'qty', label: 'بنسبة الكمية' }], s.extra_cost_basis);
  basis.dataset.key = 'extra_cost_basis';
  const scaleMode = sel([{ value: 'weight', label: 'الوزن بالجرام' }, { value: 'price', label: 'السعر' }], s.scale_mode || 'weight');
  scaleMode.dataset.key = 'scale_mode';
  const form = h('div', null,
    h('div', { class: 'card' }, h('h3', null, 'بيانات المؤسسة'), h('div', { class: 'grid' }, F('org_name', 'اسم المؤسسة'), F('org_address', 'العنوان'), F('org_phone', 'الهاتف'),
      F('org_tax_number', 'الرقم الضريبي'), F('country', 'بلد التشغيل'), F('currency', 'العملة'), F('money_decimals', 'منازل العملة', { type: 'number' }), F('timezone', 'المنطقة الزمنية'))),
    can('tax.manage') ? h('div', { class: 'card' }, h('h3', null, 'الضرائب'), h('div', { class: 'grid' }, F('default_tax_rate_pct', 'نسبة الضريبة الافتراضية %', { type: 'number' })),
      h('div', { class: 'row', style: { marginTop: '8px' } }, chk('prices_include_tax', 'الأسعار شاملة الضريبة'), chk('tax_recoverable', 'ضريبة المشتريات قابلة للاسترداد (لا تدخل التكلفة)'),
        chk('einvoice_qr', 'طباعة رمز QR للفاتورة الضريبية المبسطة (TLV) — يتطلب الرقم الضريبي')),
      h('p', { class: 'small muted' }, 'تحدد المؤسسة الضريبة حسب بلد التشغيل بالتنسيق مع محاسبها. تغيير الإعداد يسري على المستندات الجديدة فقط.')) : null,
    h('div', { class: 'card' }, h('h3', null, 'البيع والمخزون'), h('div', { class: 'grid' }, F('cashier_max_discount_pct', 'حد الخصم الافتراضي %', { type: 'number' }),
      F('expiry_block_days', 'منع البيع قبل الانتهاء بـ (أيام)', { type: 'number' }),
      F('scale_prefix', 'بادئة باركود الميزان (فارغ = غير مفعّل)'), F('scale_plu_digits', 'خانات كود الصنف في باركود الميزان', { type: 'number' }),
      F('scale_value_digits', 'خانات الوزن/السعر', { type: 'number' }), F('expiry_alert_days', 'تنبيه الصلاحية (أيام)', { type: 'number' }), field('توزيع تكاليف الشراء', basis), field('باركود الميزان يحمل', scaleMode))),
    h('div', { class: 'card' }, h('h3', null, 'الطباعة والجلسات والنسخ'), h('div', { class: 'grid' }, F('invoice_footer', 'تذييل الفاتورة'), F('receipt_width_mm', 'عرض الإيصال الحراري (مم)', { type: 'number' }),
      F('session_timeout_minutes', 'انتهاء الجلسة عند الخمول (دقيقة)', { type: 'number' }), F('backup_hour', 'ساعة النسخ اليومي (0-23)', { type: 'number' }), F('backup_retention', 'عدد النسخ المحفوظة', { type: 'number' }))));
  el.append(form, h('button', { class: 'btn ok', onclick: async () => {
    const body = {};
    for (const e of form.querySelectorAll('[data-key]')) {
      const v = e.type === 'checkbox' ? e.checked : e.value;
      const orig = e.type === 'checkbox' ? s[e.dataset.key] === '1' : String(s[e.dataset.key] ?? '');
      if (v !== orig) body[e.dataset.key] = e.type === 'checkbox' ? v : (e.classList.contains('num-in') ? num(v) : v);
    }
    if (!Object.keys(body).length) return toast('لا تغييرات');
    if (await run(() => api('PUT', '/settings', body), 'حُفظت الإعدادات')) setTimeout(() => location.reload(), 600);
  } }, 'حفظ الإعدادات'));
}

export async function users({ el }) {
  pageHead('المستخدمون والأدوار');
  const meta = await get('/meta');
  const list = await get('/users');
  const reps = await lookup('reps');
  const branches = await lookup('branches');
  const roleBoxes = (sel0 = []) => Object.entries(meta.roles).map(([k, r]) => { const c = h('input', { type: 'checkbox', value: k, checked: sel0.includes(k) }); return h('label', { class: 'check' }, c, r.name); });
  const form = (u) => {
    const un = inp({ value: u?.username || '', disabled: u ? true : null });
    const fn = inp({ value: u?.full_name || '' });
    const pw = inp({ type: 'password', placeholder: u ? 'اتركها فارغة دون تغيير' : '8 أحرف على الأقل بأرقام وحروف', autocomplete: 'new-password' });
    const rep = sel([{ value: '', label: '—' }, ...reps.map((r) => ({ value: r.id, label: r.name }))], u?.rep_id || '');
    const branch = sel([{ value: '', label: 'كل الفروع (غير مقيد)' }, ...branches.map((b) => ({ value: b.id, label: b.name }))], u?.branch_id || '');
    const active = h('input', { type: 'checkbox', checked: u ? !!u.active : true });
    const roles = h('div', { class: 'row' }, roleBoxes(u?.roles || []));
    const m = modal(u ? `تعديل ${u.username}` : 'مستخدم جديد', h('div', null, h('div', { class: 'grid' }, field('اسم المستخدم', un), field('الاسم الكامل', fn), field('كلمة المرور', pw), field('المندوب المرتبط (لدور المندوب)', rep), field('الفرع', branch)),
      h('h4', null, 'الأدوار (يمكن الجمع)'), roles, h('label', { class: 'check', style: { marginTop: '8px' } }, active, 'الحساب نشط'),
      h('p', { class: 'small muted' }, 'تعديل الدور يسري على الطلبات اللاحقة مباشرة. إيقاف الحساب أو تغيير كلمة المرور ينهي جلساته.')),
    [{ label: 'حفظ', class: 'primary', onClick: async () => {
      const body = { full_name: fn.value, roles: [...roles.querySelectorAll('input:checked')].map((c) => c.value), rep_id: rep.value ? Number(rep.value) : null, branch_id: branch.value ? Number(branch.value) : null, active: active.checked ? 1 : 0 };
      if (pw.value) body.password = pw.value;
      if (!u) { body.username = un.value; body.password = pw.value; }
      const r = await run(() => (u ? api('PUT', '/users/' + u.id, body) : api('POST', '/users', body)), 'تم الحفظ');
      if (r) location.reload();
      return !!r;
    } }]);
    return m.done;
  };
  el.append(h('button', { class: 'btn primary', style: { marginBottom: '12px' }, onclick: () => form() }, 'مستخدم جديد'),
    table({ columns: [{ key: 'username', label: 'المستخدم' }, { key: 'full_name', label: 'الاسم' }, { key: 'roles', label: 'الأدوار', render: (u) => u.roles.map((r) => meta.roles[r]?.name || r).join('، ') },
      { key: 'rep_name', label: 'المندوب' }, { key: 'branch_name', label: 'الفرع' }, { key: 'active', label: 'الحالة', render: (u) => (u.active ? h('span', { class: 'badge ok' }, 'نشط') : h('span', { class: 'badge bad' }, 'موقوف')) },
      { key: 'a', label: '', render: (u) => h('button', { class: 'btn small', onclick: () => form(u) }, 'تعديل') }], rows: list }),
    h('div', { class: 'card', style: { marginTop: '16px' } }, h('h3', null, 'مصفوفة الصلاحيات المبدئية'), permMatrix(meta)));
}

function permMatrix(meta) {
  const roles = Object.entries(meta.roles);
  return h('div', { class: 'table-wrap' }, h('table', null, h('thead', null, h('tr', null, h('th', null, 'الصلاحية'), roles.map(([, r]) => h('th', null, r.name)))),
    h('tbody', null, Object.entries(meta.permissions).map(([k, label]) => h('tr', null, h('td', null, label), roles.map(([, r]) => h('td', { style: { textAlign: 'center' } }, r.permissions.includes(k) ? '✓' : '')))))));
}

export async function audit({ el }) {
  pageHead('سجل التدقيق');
  const user = inp({ placeholder: 'المستخدم' });
  const action = inp({ placeholder: 'نوع العملية' });
  const qIn = inp({ placeholder: 'رقم المستند أو السبب' });
  const denied = h('input', { type: 'checkbox' });
  const body = h('div');
  const load = async () => {
    const rows = await get('/audit', { user: user.value, action: action.value, q: qIn.value, denied: denied.checked ? 1 : '', limit: 300 });
    body.replaceChildren(table({ columns: [
      { key: 'ts', label: 'الوقت', render: (r) => dt(r.ts) }, { key: 'username', label: 'المستخدم' }, { key: 'action', label: 'العملية' },
      { key: 'doc_number', label: 'المستند' }, { key: 'reason', label: 'السبب' }, { key: 'ok', label: 'النتيجة', render: (r) => (r.ok ? '' : h('span', { class: 'badge bad' }, 'مرفوض/فشل')) },
      { key: 'd', label: 'التفاصيل', render: (r) => (r.before_json || r.after_json ? h('button', { class: 'btn small', onclick: () => modal('تفاصيل', h('div', null,
        r.before_json ? [h('h4', null, 'قبل'), h('pre', { style: { whiteSpace: 'pre-wrap', direction: 'ltr', textAlign: 'left' } }, JSON.stringify(JSON.parse(r.before_json), null, 1))] : null,
        r.after_json ? [h('h4', null, 'بعد'), h('pre', { style: { whiteSpace: 'pre-wrap', direction: 'ltr', textAlign: 'left' } }, JSON.stringify(JSON.parse(r.after_json), null, 1))] : null)) }, 'عرض') : '') }],
    rows }));
  };
  el.append(h('div', { class: 'note' }, 'السجل للإضافة فقط ولا يمكن تعديله أو حذفه من أي مستخدم.'),
    h('form', { class: 'row card', style: { padding: '12px' }, onsubmit: (e) => { e.preventDefault(); load(); } }, field('المستخدم', user), field('العملية', action), field('بحث', qIn), h('label', { class: 'check' }, denied, 'المرفوض فقط'), h('button', { class: 'btn primary' }, 'بحث')), body);
  await load();
}

export async function backup({ el }) {
  pageHead('النسخ الاحتياطي والاستعادة');
  const body = h('div');
  const load = async () => {
    const list = await get('/backups');
    body.replaceChildren(table({ columns: [{ key: 'name', label: 'النسخة' }, { key: 'created_at', label: 'الوقت', render: (b) => dt(b.created_at) },
      { key: 'size', label: 'الحجم', render: (b) => Math.round(b.size / 1024) + ' ك.ب' }, { key: 'docs', label: 'المستندات', render: (b) => b.counts.docs }, { key: 'files', label: 'المرفقات' },
      { key: 'a', label: '', render: (b) => [
        h('button', { class: 'btn small', onclick: async () => { const r = await run(() => api('POST', `/backups/${b.name}/verify`, {})); if (r) modal('نتيجة اختبار الاسترجاع', verifyView(r)); } }, 'اختبار الاسترجاع'), ' ',
        h('button', { class: 'btn small', onclick: () => download(`/backups/${b.name}/download`, b.name + '.db') }, 'تنزيل')] }], rows: list, empty: 'لا توجد نسخ بعد' }));
  };
  el.append(h('div', { class: 'note' }, 'نسخة يومية تلقائية تشمل قاعدة البيانات والمرفقات مع الاحتفاظ بآخر 30 نسخة (قابل للتعديل من الإعدادات). احفظ نسخة خارج الخادم دوريًا.'),
    h('button', { class: 'btn primary', style: { marginBottom: '12px' }, onclick: async () => { if (await run(() => api('POST', '/backups', {}), 'تم إنشاء النسخة')) load(); } }, 'إنشاء نسخة الآن'),
    body, h('div', { class: 'card', style: { marginTop: '16px' } }, h('h3', null, 'الاستعادة'),
      h('p', null, 'الاستعادة تتم والخادم متوقف بالأمر: ', h('code', { style: { direction: 'ltr', display: 'inline-block' } }, 'npm run restore -- <اسم النسخة>'),
        '. يتحقق الأمر من سلامة النسخة ومطابقة أعدادها قبل الاستبدال، ويحتفظ بالقاعدة الحالية باسم احتياطي. التفاصيل في دليل النسخ والاستعادة.')));
  await load();
}

function verifyView(r) {
  return h('div', null, h('div', { class: 'note ' + (r.ok ? '' : 'bad') }, r.ok ? 'النسخة سليمة ومطابقة: المستندات والأرصدة والمخزون والمرفقات متطابقة والقيود متوازنة.' : 'النسخة غير مطابقة'),
    table({ columns: [{ key: 'k', label: 'البند' }, { key: 'e', label: 'المتوقع' }, { key: 'a', label: 'في النسخة المستعادة' }],
      rows: Object.keys(r.expected).map((k) => ({ k, e: r.expected[k], a: r.counts[k] })) }),
    h('p', null, `فحص السلامة: ${r.integrity} — المرفقات ${r.files}/${r.expected_files}`));
}

export async function importPage({ el }) {
  pageHead('الاستيراد من Excel');
  const kind = sel([{ value: 'items', label: 'الأصناف والوحدات والباركود' }, { value: 'parties', label: 'العملاء والموردون (مع الأرصدة الافتتاحية)' }, { value: 'stock', label: 'المخزون الافتتاحي' }], 'items');
  const file = h('input', { type: 'file', accept: '.xlsx,.csv' });
  const wh = await warehouseSelect('');
  const date = inp({ type: 'date', value: today() });
  const body = h('div');
  const payload = async () => ({ kind: kind.value, filename: file.files[0].name, data: await readFileB64(file.files[0]), warehouse_id: Number(wh.value), date: date.value });
  el.append(h('div', { class: 'card' }, h('div', { class: 'grid' }, field('نوع البيانات', kind), field('الملف (xlsx أو csv)', file), field('المستودع (للمخزون)', wh), field('تاريخ الأرصدة', date)),
    h('div', { class: 'actions', style: { marginTop: '12px' } },
      h('button', { class: 'btn', onclick: () => download(`/import/template/${kind.value}`, `template-${kind.value}.xlsx`) }, 'تنزيل القالب'),
      h('button', { class: 'btn primary', onclick: async () => {
        if (!file.files[0]) return toast('اختر الملف', 'bad');
        const r = await run(async () => api('POST', '/import/preview', await payload()));
        if (!r) return;
        body.replaceChildren(h('div', { class: 'note ' + (r.invalid ? 'bad' : '') }, `صفوف سليمة: ${r.valid} — صفوف بها أخطاء: ${r.invalid}`),
          table({ columns: [{ key: '_row', label: 'الصف' }, ...r.columns.map((c) => ({ key: c, label: c })), { key: '_errors', label: 'الأخطاء', render: (x) => h('span', { style: { color: 'var(--bad)' } }, x._errors.join('، ')) }], rows: r.rows }),
          !r.invalid ? h('button', { class: 'btn ok', style: { marginTop: '12px' }, onclick: async () => {
            const c = await run(async () => api('POST', '/import/commit', await payload()), 'تم الاستيراد');
            if (c) body.replaceChildren(h('div', { class: 'note' }, `تم استيراد ${c.imported} صف.`));
          } }, 'اعتماد الاستيراد') : h('p', null, 'صحح الأخطاء في الملف ثم أعد المعاينة. لا يُستورد أي صف ما دام هناك خطأ.'));
      } }, 'معاينة وتحقق'))), body);
}

export async function opening({ el }) {
  pageHead('الأرصدة الافتتاحية');
  const kind = sel([{ value: 'customer', label: 'رصيد عميل (عليه)' }, { value: 'supplier', label: 'رصيد مورد (له)' }, { value: 'cash', label: 'رصيد صندوق/بنك' }], 'customer');
  const target = h('div', { class: 'field' });
  const amount = inp({ type: 'number' });
  const date = inp({ type: 'date', value: today() });
  let tsel;
  const setT = async () => {
    tsel = kind.value === 'cash' ? await cashSelect('', {}) : await partySelect(kind.value === 'customer' ? 'customer' : 'supplier', '');
    target.replaceChildren(h('label', null, kind.value === 'cash' ? 'الحساب' : 'الطرف'), tsel);
  };
  kind.addEventListener('change', setT);
  await setT();
  const send = submitter();
  el.append(h('div', { class: 'note' }, 'تُدخل الأرصدة الافتتاحية بمستندات محددة التاريخ يمكن تتبعها. القيمة السالبة تعني رصيدًا معاكسًا (مثل دفعة مقدمة من عميل). المخزون الافتتاحي من صفحته أو بالاستيراد.'),
    h('div', { class: 'card', style: { maxWidth: '760px' } }, h('div', { class: 'grid' }, field('النوع', kind), target, field('المبلغ', amount), field('التاريخ', date)),
      h('div', { class: 'actions', style: { marginTop: '12px' } }, h('button', { class: 'btn ok', onclick: async () => {
        const body = { kind: kind.value, amount: num(amount.value), date: date.value };
        if (kind.value === 'cash') body.cash_account_id = Number(tsel.value); else body.party_id = Number(tsel.value);
        const d = await run(() => send('POST', '/opening-balances', body), 'سُجل الرصيد');
        if (d) location.hash = '#/doc/' + d.id;
      } }, 'تسجيل'), h('a', { class: 'btn', href: '#/opening-stock' }, 'المخزون الافتتاحي'), h('a', { class: 'btn', href: '#/import' }, 'استيراد من Excel'))));
}

export async function period({ el }) {
  pageHead('إقفال الفترات المالية');
  const cur = state.settings.locked_until;
  const until = inp({ type: 'date', value: cur || '' });
  el.append(h('div', { class: 'card', style: { maxWidth: '640px' } },
    h('p', null, cur ? ['الفترات مقفلة حتى ', h('b', null, cur), '. لا يمكن تسجيل أو إلغاء مستند بتاريخ مقفل.'] : 'لا توجد فترة مقفلة.'),
    h('div', { class: 'row' }, field('إقفال حتى تاريخ', until), h('button', { class: 'btn primary', onclick: async () => {
      const reopening = cur && (!until.value || until.value < cur);
      const reason = reopening ? await askReason('إعادة فتح فترة مقفلة تحتاج تفويضًا وسببًا') : null;
      if (reopening && !reason) return;
      if (await run(() => api('POST', '/period/lock', { until: until.value || null, reason }), 'تم')) window.dispatchEvent(new CustomEvent('session-changed'));
    } }, 'حفظ'))));
}

export async function password({ el }) {
  pageHead('تغيير كلمة المرور');
  const cur = inp({ type: 'password', autocomplete: 'current-password' });
  const pw = inp({ type: 'password', autocomplete: 'new-password' });
  const pw2 = inp({ type: 'password', autocomplete: 'new-password' });
  el.append(h('div', { class: 'card', style: { maxWidth: '420px' } }, field('كلمة المرور الحالية', cur), h('br'), field('الجديدة (8 أحرف على الأقل بأرقام وحروف)', pw), h('br'), field('تأكيد الجديدة', pw2),
    h('button', { class: 'btn primary', style: { marginTop: '12px' }, onclick: async () => {
      if (pw.value !== pw2.value) return toast('التأكيد لا يطابق', 'bad');
      if (await run(() => api('POST', '/auth/password', { current: cur.value, password: pw.value }), 'تم تغيير كلمة المرور')) { clear(el); window.dispatchEvent(new CustomEvent('session-changed')); location.hash = '#/'; }
    } }, 'حفظ')));
  void M;
}
