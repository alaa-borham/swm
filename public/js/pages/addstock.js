// إضافة رصيد سريعة: صنف ← مستودع ← كمية ← تكلفة ← حفظ، فيصبح الصنف جاهزًا للبيع.
// خلف الكواليس تُسجَّل فاتورة شراء معتمدة (من مورد) أو مستند مخزون افتتاحي (بضاعة موجودة) حتى تبقى الحسابات صحيحة.
import { h, api, get, can, toast, run, inp, sel, field, num, modal, itemPicker, warehouseSelect, cashSelect, state, today } from '../lib.js';

export const canAddStock = () => can('opening.manage') || (can('purchases.create') && can('purchases.approve'));

export async function addStockModal(item = null, onDone) {
  const canBuy = can('purchases.create') && can('purchases.approve');
  const canOpen = can('opening.manage');
  let it = item;
  const itemBox = h('div');
  const wh = await warehouseSelect(state.warehouse?.id || '');
  const qty = inp({ type: 'number', placeholder: 'الكمية' });
  const unitSel = h('select');
  const cost = inp({ type: 'number', placeholder: 'تكلفة الوحدة' });
  const expiry = inp({ type: 'date' });
  const expiryField = field('تاريخ الانتهاء', expiry, { req: true });
  const source = sel([
    ...(canBuy ? [{ value: 'purchase', label: 'شراء من مورد' }] : []),
    ...(canOpen ? [{ value: 'opening', label: 'بضاعة موجودة عندي (رصيد افتتاحي)' }] : []),
  ], canBuy ? 'purchase' : 'opening');
  const suppliers = canBuy ? (await get('/parties', { type: 'supplier', limit: 500 })).rows.filter((p) => p.active) : [];
  const supplier = sel([{ value: '', label: '— اختر المورد —' }, ...suppliers.map((p) => ({ value: p.id, label: p.name }))], '');
  const payMode = sel([{ value: 'credit', label: 'آجل' }, { value: 'cash', label: 'نقدًا' }], 'credit');
  const payAcc = await cashSelect('');
  const supplierBox = h('div', { class: 'grid' }, field('المورد', supplier, { req: true }), field('الدفع', payMode), field('من حساب', payAcc));

  const units = () => (it ? it.units.filter((u) => u.active && (source.value !== 'purchase' || u.for_purchase)) : []);
  const fillUnits = () => {
    if (!it) { unitSel.replaceChildren(h('option', { value: '' }, '— اختر الصنف أولًا —')); unitSel.disabled = true; return; }
    unitSel.disabled = false;
    const list = units();
    const prev = Number(unitSel.value);
    unitSel.replaceChildren(...list.map((u) => h('option', { value: u.id }, u.name + (u.is_base ? '' : ` (${u.factor} ${it.base_unit})`))));
    const keep = list.find((u) => u.id === prev) || list.find((u) => u.for_purchase) || list[0];
    if (keep) unitSel.value = String(keep.id);
    syncCost();
  };
  const syncCost = () => {
    const u = it?.units.find((x) => x.id === Number(unitSel.value));
    if (u && u.purchase_price != null && !cost.dataset.touched) cost.value = u.purchase_price;
  };
  cost.addEventListener('input', () => { cost.dataset.touched = '1'; });
  unitSel.addEventListener('change', () => { delete cost.dataset.touched; syncCost(); });
  const syncSource = () => {
    supplierBox.style.display = source.value === 'purchase' ? '' : 'none';
    payAcc.closest('.field').style.display = payMode.value === 'cash' ? '' : 'none';
    fillUnits();
  };
  source.addEventListener('change', syncSource);
  payMode.addEventListener('change', syncSource);

  const showItem = () => {
    if (it) {
      itemBox.replaceChildren(h('div', { class: 'row', style: { alignItems: 'center' } }, h('b', { style: { fontSize: '18px' } }, it.name), h('span', { class: 'muted small' }, it.code),
        item ? null : h('button', { type: 'button', class: 'btn small', onclick: () => { it = null; showItem(); } }, 'تغيير')));
      expiryField.style.display = it.track_expiry ? '' : 'none';
      fillUnits();
      setTimeout(() => qty.focus(), 30);
    } else {
      const picker = itemPicker({ allowCreate: true, placeholder: 'اضغط لاختيار الصنف أو اكتب الاسم أو الباركود', onPick: (x) => { it = x; showItem(); } });
      itemBox.replaceChildren(picker.el);
      expiryField.style.display = 'none';
      fillUnits();
      setTimeout(() => picker.input.focus(), 30);
    }
  };

  const save = async () => {
    if (!it) return toast('اختر الصنف', 'bad'), false;
    if (!(num(qty.value) > 0)) return toast('اكتب الكمية', 'bad'), false;
    if (it.track_expiry && !expiry.value) return toast('تاريخ الانتهاء مطلوب لهذا الصنف', 'bad'), false;
    const line = { item_id: it.id, unit_id: Number(unitSel.value), qty: num(qty.value), expiry_date: expiry.value || null };
    let doc;
    if (source.value === 'purchase') {
      if (!supplier.value) return toast('اختر المورد', 'bad'), false;
      doc = await run(() => api('POST', '/purchases', {
        party_id: Number(supplier.value), warehouse_id: Number(wh.value), date: today(), approve: true,
        payment: payMode.value === 'cash' ? { mode: 'cash', cash_account_id: Number(payAcc.value) } : null,
        lines: [{ ...line, price: num(cost.value) ?? 0 }],
      }, { idem: crypto.randomUUID?.() }));
    } else {
      doc = await run(() => api('POST', '/opening-stock', { warehouse_id: Number(wh.value), date: today(), lines: [{ ...line, unit_cost: num(cost.value) ?? 0 }] }, { idem: crypto.randomUUID?.() }));
    }
    if (!doc) return false;
    const u = it.units.find((x) => x.id === line.unit_id);
    toast(`أُضيف ${line.qty} ${u?.name || ''} من ${it.name} إلى ${wh.selectedOptions[0]?.textContent} — جاهز للبيع`, 'ok');
    onDone?.(doc);
    return true;
  };

  modal('إضافة رصيد', h('div', null, itemBox,
    h('div', { class: 'grid', style: { marginTop: '10px' } }, field('المستودع', wh, { req: true }), field('الكمية', qty, { req: true }), field('الوحدة', unitSel),
      field('تكلفة الوحدة', cost), expiryField, field('مصدر البضاعة', source)),
    supplierBox,
    h('p', { class: 'small muted' }, 'بعد الحفظ يظهر الصنف فورًا في فاتورة البيع من نفس المستودع. «شراء من مورد» يُسجّل فاتورة شراء معتمدة على المورد، و«بضاعة موجودة» تُسجَّل رصيدًا افتتاحيًا.')),
  [{ label: 'إضافة الرصيد', class: 'ok', onClick: save }]);
  showItem();
  syncSource();
}
