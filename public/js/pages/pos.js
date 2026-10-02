// نقطة البيع: بحث بالباركود أو الاسم، وحدات وكميات، خصم وضريبة، سداد نقدي/شبكة/آجل جزئي.
import { h, clear, state, get, api, submitter, toast, run, M, money, Q, inp, sel, field, num, itemPicker, partySelect, warehouseSelect, cashSelect, pageHead, can, askReason, today, modal, lookup } from '../lib.js';
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
    h('div', { class: 'grid' }, field('الصندوق', cash, { req: true }), field('حساب الشبكة', card), field('المستودع', wh), field('النقد الافتتاحي المعدود', opening, { req: true })),
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
  const dateIn = inp({ type: 'date', value: today() });
  const notes = inp({ placeholder: 'ملاحظات' });
  const invDiscPct = inp({ type: 'number', placeholder: '%' });
  const invDiscAmt = inp({ type: 'number', placeholder: 'مبلغ' });
  const cashIn = inp({ type: 'number', placeholder: '0' });
  const cardIn = inp({ type: 'number', placeholder: '0' });
  const bankSel = await cashSelect('', {}, (a) => a.kind === 'bank', { empty: '— حساب الشبكة —' });
  const cashSel = can('cash.view') && !state.session && !isRep ? await cashSelect('', {}, (a) => a.kind === 'cash') : null;
  const tbody = h('tbody');
  const totals = h('div', { class: 'total-box' });
  const changeBox = h('div', { class: 'muted' });

  const taxOf = (it) => (it.tax_rate_bp != null ? it.tax_rate_bp : s.default_tax_rate) || 0;
  const picker = itemPicker({ autofocus: true, warehouseId: () => whSel.value, onPick: (it) => {
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
  } });

  function calc() {
    const md = 10 ** (s.money_decimals ?? 2);
    const lines = cart.map((l) => {
      const value = Math.round(num(l.qty) * num(l.price) * md) || 0;
      const disc = l.discount_pct ? Math.round(value * num(l.discount_pct) / 100) : 0;
      return { l, value, disc, after: value - disc };
    });
    const sumAfter = lines.reduce((a, x) => a + x.after, 0);
    let inv = 0;
    if (num(invDiscPct.value)) inv += Math.round(sumAfter * num(invDiscPct.value) / 100);
    if (num(invDiscAmt.value)) inv += Math.round(num(invDiscAmt.value) * md);
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
    return { lines, subtotal: sub / md, discount: dsc / md, net: net / md, tax: tax / md, total: (net + tax) / md };
  }

  let pending = false;
  const redraw = () => { if (!pending) { pending = true; setTimeout(() => { pending = false; draw(); }, 0); } };
  function draw() {
    const c = calc();
    clear(tbody);
    cart.forEach((l, i) => {
      const units = l.item.units.filter((u) => u.for_sale && u.active);
      const unitSel = sel(units.map((u) => ({ value: u.id, label: `${u.name}${u.factor !== 1 ? ' (' + u.factor + ')' : ''}` })), l.unit_id, {
        onchange: () => { l.unit_id = Number(unitSel.value); l.price = units.find((u) => u.id === l.unit_id).sell_price; redraw(); } });
      const qIn = inp({ type: 'number', value: l.qty, style: { width: '80px' }, onchange: () => { l.qty = qIn.value; redraw(); } });
      const pIn = inp({ type: 'number', value: l.price, style: { width: '90px' }, onchange: () => { l.price = pIn.value; redraw(); } });
      const dIn = inp({ type: 'number', value: l.discount_pct, placeholder: '%', style: { width: '64px' }, onchange: () => { l.discount_pct = dIn.value; redraw(); } });
      tbody.append(h('tr', null,
        h('td', null, l.item.name, l.item.sellable_qty != null ? h('div', { class: 'small muted' }, 'متاح ', Q(l.item.sellable_qty), ' ', l.item.base_unit) : null),
        h('td', null, unitSel), h('td', null, qIn), h('td', null, pIn), h('td', null, dIn), h('td', { class: 'n' }, M(c.lines[i].total)),
        h('td', null, h('button', { class: 'btn small danger', 'aria-label': 'حذف', onclick: () => { cart.splice(i, 1); draw(); } }, '×'))));
    });
    if (!cart.length) tbody.append(h('tr', null, h('td', { colspan: 7, class: 'empty' }, 'امسح الباركود أو ابحث عن صنف لإضافته')));
    const paid = (num(cashIn.value) || 0) + (num(cardIn.value) || 0);
    const credit = Math.max(0, Number((c.total - paid).toFixed(3)));
    clear(totals).append(
      line('قيمة البنود', c.subtotal), line('الخصم', c.discount), line('الصافي قبل الضريبة', c.net), line('الضريبة', c.tax),
      h('div', { class: 'line grand' }, h('span', null, 'الإجمالي'), M(c.total)),
      line('المدفوع', Math.min(paid, c.total)), credit > 0 ? h('div', { class: 'line', style: { color: 'var(--bad)' } }, h('span', null, 'آجل على العميل'), M(credit)) : null);
    const change = paid - c.total;
    changeBox.textContent = change > 0 && num(cashIn.value) ? `الباقي للعميل: ${money(change)}` : '';
    return c;
  }
  const line = (k, v) => h('div', { class: 'line' }, h('span', null, k), M(v));
  for (const x of [invDiscPct, invDiscAmt, cashIn, cardIn]) x.addEventListener('input', draw);

  const payload = (approve, extra = {}) => {
    const c = calc();
    const cash = Math.min(num(cashIn.value) || 0, c.total);
    const card = Math.min(num(cardIn.value) || 0, Math.max(0, c.total - cash));
    const payments = [];
    if (cash > 0) payments.push({ method: 'cash', amount: Number(cash.toFixed(3)), cash_account_id: cashSel ? Number(cashSel.value) : undefined });
    if (card > 0) payments.push({ method: 'card', amount: Number(card.toFixed(3)), cash_account_id: bankSel.value ? Number(bankSel.value) : undefined });
    return {
      approve, date: dateIn.value, party_id: custSel.value ? Number(custSel.value) : null, warehouse_id: Number(whSel.value), notes: notes.value || null,
      invoice_discount_pct: invDiscPct.value || null, invoice_discount_amount: invDiscAmt.value || null, payments,
      lines: cart.map((l) => ({ item_id: l.item.id, unit_id: l.unit_id, qty: num(l.qty), price: num(l.price), discount_pct: l.discount_pct || null })), ...extra,
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
        const doc = await api('POST', '/sales', body, { idem: key });
        toast(approve ? `تم اعتماد الفاتورة ${doc.number}` : `حُفظت المسودة ${doc.number}`, 'ok');
        cart.length = 0; cashIn.value = ''; cardIn.value = ''; invDiscPct.value = ''; invDiscAmt.value = ''; notes.value = '';
        send = submitter();
        draw();
        if (approve) done(doc, print);
        picker.input.focus();
        return;
      } catch (e) {
        if (e.code === 'NETWORK' && approve) {
          try {
            enqueue({ key, url: '/sales', body, label: `بيع ${cart.length} بند`, total: calc().total });
          } catch (x) { toast('تعذر الحفظ دون اتصال: ' + x.message, 'bad'); return; }
          toast('لا يوجد اتصال: حُفظت الفاتورة على الجهاز وستُرسل تلقائيًا عند عودة الاتصال', 'ok');
          cart.length = 0; cashIn.value = ''; cardIn.value = ''; invDiscPct.value = ''; invDiscAmt.value = ''; notes.value = '';
          draw();
          picker.input.focus();
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

  el.append(h('div', { class: 'pos' },
    h('div', null,
      h('div', { class: 'card' }, picker.el, h('div', { class: 'small muted', style: { marginTop: '6px' } },
        h('span', { class: 'kbd' }, 'F2'), ' بحث · ', h('span', { class: 'kbd' }, 'Enter'), ' إضافة · ', h('span', { class: 'kbd' }, 'F4'), ' مسودة · ',
        h('span', { class: 'kbd' }, 'F9'), ' اعتماد · ', h('span', { class: 'kbd' }, 'F10'), ' اعتماد وطباعة')),
      h('div', { class: 'table-wrap' }, h('table', null,
        h('thead', null, h('tr', null, ['الصنف', 'الوحدة', 'الكمية', 'السعر', 'خصم %', 'الإجمالي', ''].map((x) => h('th', null, x)))), tbody))),
    h('div', null,
      h('div', { class: 'card' },
        h('div', { class: 'grid' }, field('العميل', custSel), field('المستودع', whSel), can('settings.manage') ? field('التاريخ', dateIn) : null),
        h('div', { class: 'row', style: { marginTop: '8px' } }, field('خصم الفاتورة %', invDiscPct), field('أو مبلغ', invDiscAmt)),
        h('div', { style: { marginTop: '8px' } }, notes)),
      h('div', { class: 'card' }, totals),
      h('div', { class: 'card' },
        h('div', { class: 'row' }, field('نقدي مستلم', cashIn), cashSel ? field('الصندوق', cashSel) : null),
        h('div', { class: 'row', style: { marginTop: '8px' } }, field('شبكة/بنك', cardIn), field('الحساب', bankSel)),
        changeBox,
        h('div', { class: 'small muted', style: { marginTop: '6px' } }, 'غير المدفوع يُسجل آجلاً ويتطلب اختيار العميل'),
        h('div', { class: 'actions', style: { marginTop: '12px' } },
          h('button', { class: 'btn ok', onclick: () => submit(true) }, 'اعتماد'),
          h('button', { class: 'btn primary', onclick: () => submit(true, 'thermal') }, 'اعتماد وطباعة'),
          h('button', { class: 'btn', onclick: () => submit(false) }, 'حفظ مسودة'))))));
  draw();
  if (navigator.onLine) refreshCatalog(whSel.value);
  void lookup; void send;
}
