import type { SettingTargets } from './types.js';

/** smrt-ui's built-in presets (kept as data so the engine imports no UI package). */
export const DEFAULT_THEME_PRESETS: readonly string[] = [
  'material',
  'glass',
  'studio',
  'smrt',
  'happyvertical',
];
export const DEFAULT_PRESET = 'smrt';
export const DEFAULT_COLOR_SCHEME = 'system';
export const DEFAULT_APP_NAME = 'my-app';
export const MAX_TERMS_LENGTH = 40;

const C = '@happyvertical/smrt-commerce:';

/** The commerce fields the app settings are the defaults of. */
export const COMMERCE_SETTING_TARGETS: SettingTargets = {
  currency: [
    'Order',
    'PurchaseOrder',
    'WholesaleOrder',
    'Estimate',
    'Invoice',
    'Agreement',
  ].map((model) => ({ model: `${C}${model}`, field: 'currency' })),
  taxRate: ['InvoiceLineItem', 'ContractLineItem'].map((model) => ({
    model: `${C}${model}`,
    field: 'taxRate',
  })),
  pricesIncludeTax: ['Invoice', 'Contract'].map((model) => ({
    model: `${C}${model}`,
    field: 'lineAmountType',
  })),
  taxRounding: ['Invoice', 'Contract'].map((model) => ({
    model: `${C}${model}`,
    field: 'taxRoundingScope',
  })),
  paymentTerms: [
    ...['Order', 'WholesaleOrder', 'Estimate', 'Invoice', 'Agreement'].map(
      (model) => ({ model: `${C}${model}`, field: 'terms' }),
    ),
    { model: `${C}Customer`, field: 'paymentTerms' },
  ],
};
