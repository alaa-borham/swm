'use strict';
// الصلاحيات تُفحص في الخادم لكل عملية. الأدوار قابلة للجمع لنفس المستخدم.

const PERMISSIONS = {
  'dashboard.view': 'عرض لوحة الإدارة',
  'settings.manage': 'تعديل الإعدادات',
  'tax.manage': 'تغيير إعدادات الضرائب',
  'users.manage': 'إدارة المستخدمين والأدوار',
  'audit.view': 'عرض سجل التدقيق',
  'period.lock': 'إقفال وإعادة فتح الفترات المالية',
  'backup.manage': 'النسخ الاحتياطي والاستعادة',
  'import.manage': 'استيراد البيانات',
  'opening.manage': 'إدخال الأرصدة الافتتاحية',

  'items.view': 'عرض الأصناف',
  'items.manage': 'إدارة الأصناف والوحدات والباركود',
  'cost.view': 'عرض التكاليف',
  'cost.change': 'تغيير التكلفة',
  'profit.view': 'عرض الأرباح',

  'parties.view': 'عرض العملاء والموردين',
  'parties.manage': 'إدارة العملاء والموردين',
  'parties.all': 'الوصول لكل العملاء (غير مقيد بالمندوب)',
  'credit.override': 'تجاوز الحد الائتماني',
  'warehouses.manage': 'إدارة المستودعات والحسابات والمناديب',

  'sales.create': 'إنشاء واعتماد فاتورة بيع',
  'sales.view': 'عرض المبيعات',
  'sales.discount.override': 'تجاوز حد الخصم',
  'sales.price.override': 'البيع بأقل من الحد الأدنى',
  'sales.reverse': 'إلغاء فاتورة بيع معتمدة',
  'sales.print': 'طباعة المستندات',
  'sale_returns.create': 'إنشاء مرتجع مبيعات',
  'sale_returns.approve': 'اعتماد مرتجع مبيعات',
  'sale_returns.inspect': 'فحص المرتجعات',

  'purchases.view': 'عرض المشتريات',
  'purchases.create': 'إنشاء فاتورة شراء',
  'purchases.approve': 'اعتماد الاستلام وفاتورة الشراء',
  'purchases.duplicate.override': 'قبول رقم فاتورة مورد مكرر',
  'purchases.reverse': 'إلغاء فاتورة شراء معتمدة',
  'purchase_returns.create': 'مرتجع مشتريات',

  'stock.view': 'عرض المخزون والدفعات',
  'stock.transfer': 'التحويل بين المستودعات',
  'stock.count': 'إنشاء الجرد وإدخال العد',
  'stock.count.approve': 'اعتماد الجرد',
  'stock.damage': 'تسجيل التالف',
  'stock.damage.approve': 'اعتماد التالف',
  'stock.batch.change': 'تغيير حالة الدفعات يدويًا',

  'cash.view': 'عرض الصناديق والبنوك',
  'cash.receipt': 'سندات القبض',
  'cash.payment': 'سندات الصرف',
  'cash.transfer': 'التحويل بين الصناديق والبنوك',
  'expenses.create': 'تسجيل المصروفات',
  'expenses.approve': 'اعتماد المصروفات',
  'sessions.own': 'فتح وإغلاق ورديته',
  'sessions.manage': 'اعتماد الورديات وإعادة فتحها',
  'docs.reverse': 'إلغاء مستند معتمد (قبض/صرف/مصروف/تحويل)',
  'journal.manual': 'القيود اليدوية',
  'messages.send': 'إرسال رسائل واتساب للعملاء',
  'messages.view': 'عرض سجل الرسائل',
  'messages.bulk': 'إرسال تذكيرات جماعية',

  'reps.view': 'عرض المناديب والعهد',
  'reps.custody': 'تسوية العهد',
  'commissions.manage': 'حساب واعتماد العمولات',
  'commissions.pay': 'دفع العمولات',
  'commissions.plans': 'تغيير خطط العمولات',

  'reports.sales': 'تقارير المبيعات',
  'reports.purchases': 'تقارير المشتريات',
  'reports.stock': 'تقارير المخزون',
  'reports.finance': 'التقارير المالية',
  'reports.export': 'تصدير التقارير',
};

const ALL = Object.keys(PERMISSIONS);

const ROLES = {
  admin: { name: 'المدير', permissions: ALL },
  cashier: {
    name: 'الكاشير',
    permissions: ['items.view', 'parties.view', 'parties.all', 'sales.create', 'sales.view', 'sales.print', 'sale_returns.create',
      'cash.receipt', 'sessions.own', 'stock.view', 'messages.send'],
  },
  purchasing: {
    name: 'المشتريات',
    permissions: ['items.view', 'items.manage', 'cost.view', 'parties.view', 'parties.all', 'parties.manage', 'purchases.view', 'purchases.create',
      'purchases.approve', 'purchase_returns.create', 'stock.view', 'reports.purchases', 'reports.export', 'sales.print'],
  },
  storekeeper: {
    name: 'أمين المستودع',
    permissions: ['items.view', 'stock.view', 'stock.transfer', 'stock.count', 'stock.damage', 'sale_returns.inspect', 'reports.stock', 'sales.print'],
  },
  accountant: {
    name: 'المحاسب',
    permissions: ['dashboard.view', 'items.view', 'cost.view', 'profit.view', 'parties.view', 'parties.all', 'parties.manage', 'sales.view', 'purchases.view',
      'cash.view', 'cash.receipt', 'cash.payment', 'cash.transfer', 'expenses.create', 'expenses.approve', 'reps.view', 'reps.custody',
      'commissions.manage', 'commissions.pay', 'journal.manual', 'messages.send', 'messages.view', 'messages.bulk', 'stock.view', 'reports.sales', 'reports.purchases', 'reports.stock', 'reports.finance',
      'reports.export', 'sales.print', 'sale_returns.approve'],
  },
  rep: {
    name: 'المندوب',
    permissions: ['items.view', 'parties.view', 'sales.create', 'sales.view', 'sales.print', 'sale_returns.create', 'cash.receipt', 'stock.view'],
  },
};

/** صلاحيات الأدوار المعدلة من الإدارة (مخزنة في الإعدادات) تحل محل الافتراضية؛ دور المدير ثابت دائمًا */
function parseOverrides(json) {
  if (!json) return {};
  try { const o = JSON.parse(json); return o && typeof o === 'object' ? o : {}; } catch (_) { return {}; }
}

function rolePermissions(role, overrides = {}) {
  if (!ROLES[role]) return [];
  if (role === 'admin' || !Array.isArray(overrides[role])) return ROLES[role].permissions;
  return overrides[role].filter((p) => PERMISSIONS[p]);
}

function permissionsFor(roles, overrides = {}) {
  const set = new Set();
  for (const r of roles || []) for (const p of rolePermissions(r, overrides)) set.add(p);
  return set;
}

/** الأدوار بصلاحياتها الفعلية والافتراضية للعرض والتعديل */
function effectiveRoles(overrides = {}) {
  return Object.fromEntries(Object.entries(ROLES).map(([k, r]) => [k, { name: r.name, permissions: rolePermissions(k, overrides), defaults: r.permissions, locked: k === 'admin', customized: k !== 'admin' && Array.isArray(overrides[k]) }]));
}

module.exports = { PERMISSIONS, ROLES, permissionsFor, parseOverrides, rolePermissions, effectiveRoles };
