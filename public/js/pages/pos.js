// نقطة البيع: بحث بالباركود أو الاسم، وحدات وكميات، خصم وضريبة، سداد نقدي/شبكة/آجل جزئي.
import { stepper, h, clear, state, get, api, submitter, toast, run, M, money, Q, inp, sel, field, num, itemPicker, isTouch, partySelect, warehouseSelect, cashSelect, pageHead, can, askReason, today, modal, lookup } from '../lib.js';
import { printDoc } from './docs.js';
import { enqueue, refreshCatalog } from '../offline.js';

export async function render(c) {
  const { el } = c;
  pageHead('فاتورة بيع جديدة');
  const needsSession = !can('cash.view') && !state.rep;
  if (needsSession && !state.session) return openSessionForm(el);
  await posView(c);
}

async function openSessionForm(el) {
  const cash = await cashSelect('', {}, (a) => a.kind === 'cash');
  const card = await cashSelect('', {}, (a) => a.kind === 'bank', { empty: '— بدون —' });
  const wh = await warehouseSelect('');
  const opening = inp({ type: 'number', value: '0' });
  const send = submitter();
  el.append(h('div', { class: 'card', style: { maxWidth: '560px' } },
    h('h3', null, 'افتح ورديتك قبل البيع'),
    h('div', { class: 'grid' }, field('الصندوق', cash, { req: true }), field('طريقة سداد الشبكة الافتراضية', card), field('المستودع', wh), field('النقد الافتتاحي المعدود', opening, { req: true })),
    h('div', { class: 'actions', style: { marginTop: '12px' } }, h('button', { class: 'btn primary', onclick: async () => {
      try {
        await send('POST', '/sessions', { cash_account_id: Number(cash.value), card_account_id: card.value ? Number(card.value) : null, warehouse_id: Number(wh.value), opening_amount: num(opening.value) ?? 0 });
        toast('تم فتح الوردية', 'ok');
        window.dispatchEvent(new CustomEvent('session-changed'));
      } catch (e) { toast(e.message, 'bad'); }
    } }, 'فتح الوردية'))));
}

async function posView({ el, q }) {
  const s = state.settings;
  const cart = [];
  let send = submitter();
  const isRep = !!state.rep && !can('parties.all');
  const whSel = await warehouseSelect(isRep ? state.rep.warehouse_id : (state.session?.warehouse_id || ''), { disabled: isRep || null });
  const custSel = await partySelect('customer', q.party || '');
  const priceEditable = can('sales.price.edit');
  const dateIn = inp({ type: 'date', value: today() });
  const notes = inp({ placeholder: 'ملاحظات' });
  const invDiscPct = inp({ type: 'number', placeholder: '%' });
  const invDiscAmt = inp({ type: 'number', placeholder: '%', min: 0, max: 100 });
  const cashIn = inp({ type: 'number', placeholder: '0' });
  const cardIn = inp({ type: 'number', placeholder: '0' });
  const bankSel = await cashSelect('', {}, (a) => a.kind === 'bank', { empty: '— اختر طريقة السداد —' });
  const cashSel = can('cash.view') && !state.session && !isRep ? await cashSelect('', {}, (a) => a.kind === 'cash') : null;
  // واجهة السداد المبسطة: طريقة واحدة + المبلغ (يُقترح إجمالي الفاتورة)، والباقي آجل على العميل.
  // تُترجم داخليًا إلى حقلي النقد والشبكة اللذين يبني منهما الطلب.
  const banks = [...bankSel.options].filter((o) => o.value);
  const payMethod = sel([{ value: 'cash', label: 'نقدي' }, ...banks.map((o) => ({ value: 'bank:' + o.value, label: o.textContent })), { value: 'credit', label: 'آجل على العميل' }], 'cash');
  const payAmt = inp({ type: 'number', placeholder: '0' });
  let payTouched = false;
  const cashBox = cashSel ? field('الصندوق', cashSel) : null;
  const syncPay = () => {
    const m = payMethod.value;
    payAmt.disabled = m === 'credit';
    if (m === 'credit') payAmt.value = '';
    cashIn.value = m === 'cash' ? payAmt.value : '';
    cardIn.value = m.startsWith('bank:') ? payAmt.value : '';
    if (m.startsWith('bank:')) bankSel.value = m.slice(5);
    if (cashBox) cashBox.style.display = m === 'cash' ? '' : 'none';
  };
  payMethod.addEventListener('change', () => { payTouched = false; draw(); });
  payAmt.addEventListener('input', () => { payTouched = true; syncPay(); draw(); });
  const tbody = h('tbody');
  const totals = h('div', { class: 'total-box' });
  const changeBox = h('div', { class: 'muted' });
  // المسودات: فتح مسودة محفوظة لإكمالها أو اعتمادها
  let draftId = null;
  const draftNote = h('div');
  const draftsBtn = h('button', { class: 'btn', onclick: () => showDrafts() }, 'المسودات');
  const refreshDraftCount = async () => {
    try {
      const r = await get('/docs', { type: 'sale', status: 'draft', limit: 1 });
      draftsBtn.textContent = r.total ? `المسودات (${r.total})` : 'المسودات';
    } catch { /* بلا اتصال */ }
  };
  // الفاتورة الجارية تُحفظ على الجهاز تلقائيًا: لو أُعيد تحميل الصفحة (سحب للأسفل، إغلاق التطبيق) تعود كما كانت
  const wipKey = `frs-pos-wip-${state.me?.id || 'u'}`;
  let wipReady = false;
  const saveWip = () => {
    if (!wipReady) return;
    try {
      if (!cart.length) { localStorage.removeItem(wipKey); return; }
      localStorage.setItem(wipKey, JSON.stringify({ t: Date.now(), draftId, party: custSel.value, wh: whSel.value, notes: notes.value, invDisc: invDiscAmt.value,
        pay: payMethod.value, payAmt: payAmt.value, payTouched,
        cart: cart.map((l) => ({ item_id: l.item.id, unit_id: l.unit_id, qty: l.qty, price: l.price, discMode: l.discMode, discount_amt: l.discount_amt, discount_pct: l.discount_pct })) }));
    } catch (_) { /* تخزين غير متاح */ }
  };
  const restoreWip = async () => {
    let w = null;
    try { w = JSON.parse(localStorage.getItem(wipKey) || 'null'); } catch (_) { w = null; }
    if (!w || Date.now() - w.t > 2 * 864e5 || !w.cart?.length) return;
    for (const l of w.cart || []) {
      try {
        const item = await get('/items/' + l.item_id);
        cart.push({ item, unit_id: l.unit_id, qty: l.qty, price: priceEditable ? l.price : (item.units.find((u) => u.id === l.unit_id)?.sell_price ?? l.price), discMode: l.discMode, discount_amt: l.discount_amt, discount_pct: l.discount_pct });
      } catch (_) { /* صنف محذوف أو بلا اتصال */ }
    }
    if (w.party) custSel.value = w.party;
    if (w.wh && !isRep) whSel.value = w.wh;
    notes.value = w.notes || ''; invDiscAmt.value = w.invDisc || '';
    if (w.pay) payMethod.value = w.pay;
    if (w.payTouched) { payTouched = true; payAmt.value = w.payAmt || ''; }
    if (w.draftId) draftId = w.draftId;
    toast('استُرجعت الفاتورة التي لم تُحفظ', 'ok');
  };
  const resetForm = () => {
    cart.length = 0; cashIn.value = ''; cardIn.value = ''; invDiscPct.value = ''; invDiscAmt.value = ''; notes.value = '';
    payTouched = false; payMethod.value = 'cash';
    draftId = null; draftNote.replaceChildren();
  };
  async function showDrafts() {
    const r = await run(() => get('/docs', { type: 'sale', status: 'draft', limit: 100 }));
    if (!r) return;
    const m = modal('مسودات فواتير البيع', r.rows.length ? h('div', { class: 'table-wrap' }, h('table', null,
      h('thead', null, h('tr', null, ['الرقم', 'التاريخ', 'العميل', 'الإجمالي', ''].map((x) => h('th', null, x)))),
      h('tbody', null, r.rows.map((d) => h('tr', null, h('td', null, d.number), h('td', null, d.date), h('td', null, d.party_name || '—'), h('td', null, M(d.total)),
        h('td', null, h('button', { class: 'btn small primary', onclick: async () => { m.close(); await loadDraft(d.id); } }, 'فتح'), ' ',
          h('button', { class: 'btn small danger', onclick: async (e) => {
            const tr = e.currentTarget.closest('tr');
            if (!confirm(`حذف المسودة ${d.number}${d.party_name ? ' — ' + d.party_name : ''}؟`)) return;
            if (!await run(() => api('POST', `/docs/${d.id}/cancel`, { reason: 'حذف مسودة من شاشة البيع' }), 'حُذفت المسودة')) return;
            tr.remove();
            if (draftId === d.id) resetForm();
            refreshDraftCount();
          } }, 'حذف'))))))) : h('p', { class: 'muted' }, 'لا توجد مسودات'));
  }
  // الخصم المحفوظ (قبل الضريبة) يُعرض كما أدخله المستخدم: الفرق بين إجمالي البند بالضريبة قبل الخصم وبعده
  const grossDiscOf = (l) => {
    const r = l.tax_rate_bp || 0; // نسبة مئوية (معروضة من الخادم)
    if (s.prices_include_tax || !r) return l.line_discount;
    const md = 10 ** (s.money_decimals ?? 2);
    const v = Math.round(l.value * md);
    return (v + Math.round(v * r / 100) - Math.round(l.total * md)) / md;
  };
  async function loadDraft(id) {
    if (cart.length && !confirm('في الفاتورة الحالية أصناف لم تُحفظ. استبدالها بالمسودة؟')) return;
    const d = await run(() => get('/docs/' + id));
    if (!d) return;
    if (d.status !== 'draft') return toast('هذه الفاتورة لم تعد مسودة', 'bad');
    resetForm();
    for (const l of d.lines) {
      const item = await get('/items/' + l.item_id);
      cart.push({ item, unit_id: l.unit_id, qty: l.qty, price: priceEditable ? l.price : (item.units.find((u) => u.id === l.unit_id)?.sell_price ?? l.price), discount_pct: '', discMode: l.line_discount ? 'amt' : 'pct', discount_amt: l.line_discount ? grossDiscOf(l) : '' });
    }
    custSel.value = d.party_id ? String(d.party_id) : '';
    if (d.warehouse_id) whSel.value = String(d.warehouse_id);
    notes.value = d.notes || '';
    // خصم الفاتورة المحفوظ يُعرض كما كُتب: الإجمالي قبل خصم الفاتورة ناقص إجمالي المسودة
    invDiscAmt.value = d.invoice_discount_bp || '';
    draftId = d.id;
    draftNote.replaceChildren(h('div', { class: 'note warn', style: { marginBottom: '8px' } }, `تعمل على المسودة ${d.number} — الحفظ يحدّثها والاعتماد يعتمدها `,
      h('button', { class: 'btn small', onclick: () => { resetForm(); draw(); } }, 'فاتورة جديدة بدلًا منها')));
    draw();
  }

  // حد خصم الصنف (٪): نسبة المندوب من كارته، أو الحد الموحد لكل الأصناف، أو حد الصنف، أو الحد الافتراضي؛ المدير بلا حد
  const lineLimitPct = (it) => {
    if (can('settings.manage')) return null;
    if (isRep && state.rep?.discount_limit_pct != null) return state.rep.discount_limit_pct;
    if (s.item_discount_uniform) return s.item_discount_default_pct ?? 0;
    return it.max_discount_bp ?? s.item_discount_default_pct ?? 0;
  };
  const taxOf = (it) => (it.tax_rate_bp != null ? it.tax_rate_bp : s.default_tax_rate) || 0;
  const picker = itemPicker({ autofocus: true, inStockOnly: true, emptyHint: isRep ? 'لا توجد بضاعة في عهدتك. تُسلَّم البضاعة للمندوب من الإدارة (المناديب ← تسليم بضاعة)' : null, warehouseId: () => whSel.value, onPick: (it) => addToCart(it) });
  function addToCart(it) {
    const unitId = it.selected_unit_id;
    const ex = it.scale_qty ? null : cart.find((l) => l.item.id === it.id && l.unit_id === unitId);
    if (ex) ex.qty = Number(ex.qty) + 1;
    else if (it.scale_qty) {
      const u = it.units.find((x) => x.id === unitId);
      cart.push({ item: it, unit_id: unitId, qty: it.scale_qty, price: u.sell_price, discount_pct: '' });
    }
    else {
      const u = it.units.find((x) => x.id === unitId);
      cart.push({ item: it, unit_id: unitId, qty: 1, price: u.sell_price, discount_pct: '' });
    }
    draw();
  }

  // زر عائم لاختيار الأصناف دون الرجوع لأعلى الشاشة
  const fabCount = h('span', { class: 'pos-fab-n' });
  const fab = h('button', { type: 'button', class: 'pos-fab', title: 'إضافة أصناف', onclick: () => openPickModal() }, h('span', { class: 'pos-fab-plus' }, '+'), h('span', null, 'أصناف'), fabCount);
  const syncFab = () => { const n = cart.length; fabCount.textContent = n ? String(n) : ''; fabCount.classList.toggle('hidden', !n); };
  function openPickModal() {
    // الضغط على الصنف يضيفه مباشرة ويغلق النافذة (الضغط على نفس الصنف لاحقًا يزيد الكمية)
    let m;
    const p2 = itemPicker({ keepOpen: true, inStockOnly: true, warehouseId: () => whSel.value, placeholder: 'ابحث عن صنف…', onPick: (it) => {
      addToCart(it);
      m.close();
      toast(`أُضيف ${it.name}`, 'ok');
    } });
    m = modal('اختيار صنف', h('div', { class: 'pick-modal' }, p2.el), []);
  }

  function calc() {
    const md = 10 ** (s.money_decimals ?? 2);
    const lines = cart.map((l) => {
      const value = Math.round(num(l.qty) * num(l.price) * md) || 0;
      // الخصم قيمة تُطرح من إجمالي البند بعد الضريبة: يُحوَّل إلى خصم قبل الضريبة يعطي نفس الإجمالي
      let disc;
      if (l.discMode === 'amt') {
        const D = Math.max(Math.round(num(l.discount_amt) * md) || 0, 0);
        const rate = taxOf(l.item);
        if (s.prices_include_tax || !rate) disc = D;
        else {
          const grossBefore = value + Math.round(value * rate / 100);
          const netAfter = Math.round(Math.max(grossBefore - D, 0) * 100 / (100 + rate));
          disc = D ? value - netAfter : 0;
        }
      } else disc = l.discount_pct ? Math.round(value * num(l.discount_pct) / 100) : 0;
      disc = Math.min(Math.max(disc, 0), value);
      return { l, value, disc, after: value - disc };
    });
    const sumAfter = lines.reduce((a, x) => a + x.after, 0);
    let inv = 0;
    // خصم الفاتورة نسبة مئوية من إجمالي الفاتورة (تنقص الإجمالي شامل الضريبة بنفس النسبة)
    const P = Math.min(Math.max(num(invDiscAmt.value) || 0, 0), 100);
    if (P) inv = Math.round(sumAfter * P / 100);
    let sub = 0, dsc = 0, net = 0, tax = 0;
    for (const x of lines) {
      const share = sumAfter ? Math.round(inv * x.after / sumAfter) : 0;
      const gross = x.after - share;
      const rate = taxOf(x.l.item);
      let n, t;
      if (s.prices_include_tax) { n = Math.round(gross * 100 / (100 + rate)); t = gross - n; } else { n = gross; t = Math.round(gross * rate / 100); }
      x.total = (n + t) / md;
      sub += x.value; dsc += x.disc + share; net += n; tax += t;
    }
    return { lines, inv: inv / md, subtotal: sub / md, discount: dsc / md, net: net / md, tax: tax / md, total: (net + tax) / md };
  }

  // خصم البند قبل الضريبة (يُرسل للخادم) كما يحسبه calc
  const netDisc = (l) => { const c = calc(); const x = c.lines.find((y) => y.l === l); return x ? x.disc / 10 ** (s.money_decimals ?? 2) : 0; };

  let pending = false;
  const redraw = () => { if (!pending) { pending = true; setTimeout(() => { pending = false; draw(); }, 0); } };
  function draw() {
    drawInner();
    syncFab();
    saveWip();
  }
  function drawInner() {
    const c = calc();
    clear(tbody);
    cart.forEach((l, i) => {
      const units = l.item.units.filter((u) => u.for_sale && u.active);
      const unitSel = sel(units.map((u) => ({ value: u.id, label: `${u.name}${u.factor !== 1 ? ' (' + u.factor + ')' : ''}` })), l.unit_id, {
        onchange: () => { l.unit_id = Number(unitSel.value); l.price = units.find((u) => u.id === l.unit_id).sell_price; redraw(); } });
      const qIn = inp({ type: 'number', value: l.qty, style: { width: '80px' }, onchange: () => { l.qty = qIn.value; redraw(); } });
      const pIn = inp({ type: 'number', value: l.price, style: { width: '90px' }, onchange: () => { l.price = pIn.value; redraw(); } });
      const lc = c.lines[i];
      const md = 10 ** (s.money_decimals ?? 2);
      const repNoDisc = isRep && state.rep?.discount_limit_pct === 0;
      const offDisc = invDiscUsed() || repNoDisc || null;
      const offTitle = repNoDisc ? 'الخصم غير مسموح لك' : offDisc ? 'خصم الأصناف غير متاح مع خصم الفاتورة' : isRep && state.rep?.discount_limit_pct ? `أقصى خصم لك ${state.rep.discount_limit_pct}%` : null;
      // خصم الصنف قيمة (مبلغ) وليس نسبة
      const amtShown = l.discMode === 'amt' ? l.discount_amt : (lc.disc ? (lc.disc / md).toFixed(s.money_decimals ?? 2) : '');
      // أقصى قيمة خصم للبند = النسبة × إجمالي البند شامل الضريبة
      const limPct = lineLimitPct(l.item);
      const grossLine = (lc.value + (s.prices_include_tax ? 0 : Math.round(lc.value * taxOf(l.item) / 100))) / md;
      const maxAmt = limPct == null ? null : Math.floor(grossLine * limPct / 100 * md) / md;
      // تنبيه واحد فقط عند بلوغ الحد، ولا يتكرر مع كل ضغطة + حتى ينزل الخصم تحت الحد
      const clampDisc = () => {
        if (maxAmt == null) return;
        if (num(l.discount_amt) > maxAmt) {
          l.discount_amt = maxAmt;
          if (!l.limitWarned) { l.limitWarned = true; toast(`أقصى خصم لـ ${l.item.name}: ${money(maxAmt)} (${limPct}%)`, 'warn'); }
        } else if (num(l.discount_amt) < maxAmt) l.limitWarned = false;
      };
      const aIn = inp({ type: 'number', value: amtShown, placeholder: '0.00', min: 0, style: { width: '90px' }, disabled: offDisc, title: offTitle, onchange: () => { l.discMode = 'amt'; l.discount_amt = aIn.value; l.discount_pct = ''; clampDisc(); redraw(); } });
      const discHint = maxAmt != null && !offDisc ? h('div', { class: 'small muted' }, `الحد ${limPct}% = ${money(maxAmt)}`) : null;
      tbody.append(h('tr', null,
        h('td', null, l.item.name, l.item.sellable_qty != null ? h('div', { class: 'small muted' }, 'متاح ', Q(l.item.sellable_qty), ' ', l.item.base_unit) : null),
        h('td', null, unitSel), h('td', null, stepper(qIn, { step: 1, min: 0, onChange: (v) => { l.qty = v; redraw(); } })),
        h('td', null, priceEditable ? stepper(pIn, { step: 1, min: 0, onChange: (v) => { l.price = v; redraw(); } }) : h('span', { class: 'n', title: 'سعر البيع ثابت' }, money(l.price))), h('td', null, stepper(aIn, { step: 1, min: 0, onChange: (v) => { l.discMode = 'amt'; l.discount_amt = v; l.discount_pct = ''; clampDisc(); redraw(); } }), discHint), h('td', { class: 'n' }, M(c.lines[i].total)),
        h('td', null, h('button', { class: 'btn small danger', 'aria-label': 'حذف', onclick: () => { cart.splice(i, 1); draw(); } }, '×'))));
    });
    if (!cart.length) tbody.append(h('tr', null, h('td', { colspan: 7, class: 'empty' }, 'امسح الباركود أو ابحث عن صنف لإضافته')));
    if (!payTouched && payMethod.value !== 'credit') payAmt.value = cart.length ? c.total : '';
    syncPay();
    const paid = (num(cashIn.value) || 0) + (num(cardIn.value) || 0);
    const credit = Math.max(0, Number((c.total - paid).toFixed(3)));
    clear(totals).append(
      line('إجمالي الفاتورة', c.subtotal), line('الخصم', c.discount), line('الصافي قبل الضريبة', c.net), line('الضريبة', c.tax),
      h('div', { class: 'line grand' }, h('span', null, 'الإجمالي شامل الضريبة'), M(c.total)),
      line('المدفوع', Math.min(paid, c.total)), credit > 0 ? h('div', { class: 'line', style: { color: 'var(--bad)' } }, h('span', null, 'آجل على العميل'), M(credit)) : null);
    const change = paid - c.total;
    changeBox.textContent = change > 0 && num(cashIn.value) ? `الباقي للعميل: ${money(change)}` : '';
    return c;
  }
  const line = (k, v) => h('div', { class: 'line' }, h('span', null, k), M(v));
  // سياسة خصم الفاتورة: يظهر لغير المدير فقط إذا فعّله المدير، واستخدامه يلغي خصومات الأصناف
  const isAdmin = can('settings.manage');
  const invDiscAllowed = isAdmin || !!s.invoice_discount_enabled;
  const invDiscUsed = () => (num(invDiscAmt.value) || 0) !== 0;
  let invLimitWarned = false;
  const onInvDisc = () => {
    if (!isAdmin && s.invoice_discount_max_pct != null) {
      if (num(invDiscAmt.value) > s.invoice_discount_max_pct) {
        invDiscAmt.value = s.invoice_discount_max_pct;
        if (!invLimitWarned) { invLimitWarned = true; toast(`أقصى خصم للفاتورة ${s.invoice_discount_max_pct}%`, 'warn'); }
      } else if (num(invDiscAmt.value) < s.invoice_discount_max_pct) invLimitWarned = false;
    }
    if (invDiscUsed() && cart.some((l) => l.discount_pct || l.discount_amt)) { cart.forEach((l) => { l.discount_pct = ''; l.discount_amt = ''; l.discMode = 'pct'; }); toast('أُلغيت خصومات الأصناف لأن خصم الفاتورة مستخدم', 'warn'); }
    draw();
  };
  invDiscAmt.addEventListener('input', onInvDisc);
  for (const x of [cashIn, cardIn]) x.addEventListener('input', draw);

  const payload = (approve, extra = {}) => {
    const c = calc();
    const cash = Math.min(num(cashIn.value) || 0, c.total);
    const card = Math.min(num(cardIn.value) || 0, Math.max(0, c.total - cash));
    const payments = [];
    if (cash > 0) payments.push({ method: 'cash', amount: Number(cash.toFixed(3)), cash_account_id: cashSel ? Number(cashSel.value) : undefined });
    if (card > 0) payments.push({ method: 'card', amount: Number(card.toFixed(3)), cash_account_id: bankSel.value ? Number(bankSel.value) : undefined });
    return {
      approve, date: dateIn.value, party_id: custSel.value ? Number(custSel.value) : null, warehouse_id: Number(whSel.value), notes: notes.value || null,
      invoice_discount_pct: num(invDiscAmt.value) || null, invoice_discount_amount: null, payments,
      lines: cart.map((l) => ({ item_id: l.item.id, unit_id: l.unit_id, qty: num(l.qty), price: num(l.price), discount_pct: l.discMode === 'amt' ? null : (l.discount_pct || null), discount_amount: l.discMode === 'amt' ? (netDisc(l) || null) : null })), ...extra,
    };
  };

  async function submit(approve, print) {
    if (!cart.length) return toast('أضف صنفًا أولاً', 'bad');
    let body = payload(approve);
    const paidNow = body.payments.reduce((a, p) => a + p.amount, 0);
    if (approve && !body.party_id && paidNow + 0.0001 < calc().total) return toast('البيع الآجل يتطلب اختيار العميل؛ أو أدخل المبلغ المدفوع كاملًا', 'bad');
    // معرف العملية ثابت لهذه الفاتورة: إعادة الإرسال أو المزامنة لاحقًا لا تكررها
    const key = crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const doc = draftId ? await api('PUT', '/sales/' + draftId, body) : await api('POST', '/sales', body, { idem: key });
        toast(approve ? `تم اعتماد الفاتورة ${doc.number}` : `حُفظت المسودة ${doc.number}`, 'ok');
        resetForm();
        refreshDraftCount();
        send = submitter();
        draw();
        if (approve) done(doc, print);
        if (!isTouch()) picker.input.focus();
        return;
      } catch (e) {
        if (e.code === 'NETWORK' && approve && !draftId) {
          try {
            enqueue({ key, url: '/sales', body, label: `بيع ${cart.length} بند`, total: calc().total });
          } catch (x) { toast('تعذر الحفظ دون اتصال: ' + x.message, 'bad'); return; }
          toast('لا يوجد اتصال: حُفظت الفاتورة على الجهاز وستُرسل تلقائيًا عند عودة الاتصال', 'ok');
          cart.length = 0; cashIn.value = ''; cardIn.value = ''; invDiscPct.value = ''; invDiscAmt.value = ''; notes.value = '';
          payTouched = false; payMethod.value = 'cash';
          draw();
          if (!isTouch()) picker.input.focus();
          return;
        }
        if (e.code === 'REASON_REQUIRED' && attempt === 0) {
          const reason = await askReason('تجاوز الحدود يحتاج سببًا موثقًا', e.message);
          if (!reason) return;
          body = { ...body, override_reason: reason };
          continue;
        }
        toast(e.message, 'bad');
        return;
      }
    }
  }

  function done(doc, print) {
    if (print) return printDoc(doc.id, print);
    modal(`الفاتورة ${doc.number}`, h('div', null,
      h('p', null, 'الإجمالي: ', M(doc.total), ' — المتبقي: ', M(doc.open_amount))),
    [{ label: 'طباعة إيصال', class: 'primary', onClick: () => printDoc(doc.id, 'thermal') }, { label: 'طباعة A4', onClick: () => printDoc(doc.id, 'a4') },
      { label: 'عرض الفاتورة', onClick: () => { location.hash = '#/doc/' + doc.id; } },
      ...(state.settings.whatsapp_enabled && doc.party_id && can('messages.send') ? [{ label: 'إرسال واتساب', onClick: async () => !!(await run(() => api('POST', `/docs/${doc.id}/whatsapp`, {}), 'أُرسلت الرسالة')) }] : [])]);
  }

  const keys = (e) => {
    if (!document.body.contains(tbody)) return document.removeEventListener('keydown', keys);
    if (e.key === 'F2') { e.preventDefault(); picker.input.focus(); }
    if (e.key === 'F4') { e.preventDefault(); submit(false); }
    if (e.key === 'F9') { e.preventDefault(); submit(true); }
    if (e.key === 'F10') { e.preventDefault(); submit(true, 'thermal'); }
  };
  document.addEventListener('keydown', keys);

  el.append(h('div', { class: 'pos pos-compact' },
    h('div', null,
      draftNote,
      // العميل أولًا ثم الأصناف
      h('div', { class: 'card pos-sec pos-customer' }, h('div', { class: 'pos-sec-h' }, '١ · العميل'), h('div', { class: 'grid' }, field('العميل', custSel), (whSel.options.length > 1 ? field('المستودع', whSel) : null), can('settings.manage') ? field('التاريخ', dateIn) : null)),
      h('div', { class: 'card pos-sec pos-search' }, h('div', { class: 'pos-sec-h' }, '٢ · الأصناف'), picker.el, h('div', { class: 'small muted pos-keys', style: { marginTop: '6px' } },
        h('span', { class: 'kbd' }, 'F2'), ' بحث · ', h('span', { class: 'kbd' }, 'Enter'), ' إضافة · ', h('span', { class: 'kbd' }, 'F4'), ' مسودة · ',
        h('span', { class: 'kbd' }, 'F9'), ' اعتماد · ', h('span', { class: 'kbd' }, 'F10'), ' اعتماد وطباعة')),
      h('div', { class: 'table-wrap' }, h('table', { class: 'lines-table' },
        h('thead', null, h('tr', null, ['الصنف', 'الوحدة', 'الكمية', 'السعر', 'الخصم (قيمة)', 'الإجمالي', ''].map((x) => h('th', null, x)))), tbody))),
    h('div', null,
      h('div', { class: 'card pos-sec pos-extra' }, h('div', { class: 'pos-sec-h' }, '٣ · الخصم والملاحظات'),
        invDiscAllowed ? h('div', null, field('خصم على إجمالي الفاتورة %', stepper(invDiscAmt, { step: 1, min: 0, onChange: onInvDisc })),
          h('div', { class: 'small muted' }, 'نسبة من إجمالي الفاتورة، ويلغي خصومات الأصناف.', !isAdmin && s.invoice_discount_max_pct != null ? ` الحد الأقصى ${s.invoice_discount_max_pct}%.` : '')) : null,
        h('div', { style: { marginTop: '8px' } }, notes)),
      h('div', { class: 'card pos-sec pos-totals' }, h('div', { class: 'pos-sec-h' }, '٤ · الإجمالي'), totals),
      h('div', { class: 'card pos-sec pos-pay' }, h('div', { class: 'pos-sec-h' }, '٥ · السداد والاعتماد'),
        h('div', { class: 'row' }, field('طريقة السداد', payMethod), field('المبلغ المدفوع', stepper(payAmt, { step: 1, min: 0, onChange: () => { payTouched = true; syncPay(); draw(); } })), cashBox),
        can('warehouses.manage') ? h('a', { class: 'small', href: '#/warehouses' }, '+ إضافة طريقة سداد جديدة') : null,
        changeBox,
        h('div', { class: 'small muted', style: { marginTop: '6px' } }, 'المبلغ يُقترح بإجمالي الفاتورة؛ إن دُفع أقل يُسجَّل الباقي آجلاً ويتطلب اختيار العميل'),
        h('div', { class: 'actions', style: { marginTop: '12px' } },
          h('button', { class: 'btn ok', onclick: () => submit(true) }, 'اعتماد'),
          h('button', { class: 'btn primary', onclick: () => submit(true, 'thermal') }, 'اعتماد وطباعة'),
          h('button', { class: 'btn', onclick: () => submit(false) }, 'حفظ مسودة'),
          draftsBtn)))), fab);
  if (!q.draft) await restoreWip();
  wipReady = true;
  draw();
  custSel.addEventListener('change', saveWip);
  // بعد اختيار العميل تصعد الشاشة حتى يصبح قسم الأصناف في الأعلى فتتسع المساحة لاختيار الأصناف
  custSel.addEventListener('change', () => {
    if (!custSel.value) return;
    const sec = el.querySelector('.pos-search');
    const top = document.querySelector('.top');
    if (!sec) return;
    setTimeout(() => {
      const off = (top ? top.getBoundingClientRect().bottom : 0) + 8;
      window.scrollTo({ top: window.scrollY + sec.getBoundingClientRect().top - off, behavior: 'smooth' });
    }, 50);
  });
  notes.addEventListener('input', saveWip);
  refreshDraftCount();
  if (q.draft) loadDraft(Number(q.draft));
  if (navigator.onLine) refreshCatalog(whSel.value);
  void lookup; void send;
}
