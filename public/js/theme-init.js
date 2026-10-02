// يُطبَّق المظهر المحفوظ قبل رسم الصفحة لتجنب الوميض: auto | light | dark | gray
(function () {
  var t = 'auto';
  try { t = localStorage.getItem('frs-theme') || 'auto'; } catch (e) { /* ignore */ }
  if (t !== 'auto') document.documentElement.setAttribute('data-theme', t);
}());
