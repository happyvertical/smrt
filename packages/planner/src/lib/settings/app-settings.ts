import { getModelByQualifiedName } from '../catalog/index.ts';
import type { Cookbook } from '../cookbook/types.ts';
import { recipesById } from '../recipes/index.ts';
import { type FieldPolicyRow, resolveFields } from '../recipes/policy.ts';

/**
 * App settings: the few defaults that belong to the visitor's app, not to a
 * cookbook. They have no field of their own in the cookbook; they are the
 * same app-scope `defaultValue` policy rows a cookbook writes, kept in one
 * place so the Settings tab, the cookbook preview and the cookbooks agree on
 * which fields each setting covers.
 */
export interface AppSettings {
  /** ISO 4217 code. */
  currency: string;
  /** Default tax rate as a fraction (0.0825 is 8.25%). */
  taxRate: number;
  /** Default payment terms; empty means unset. */
  paymentTerms: string;
}

export const DEFAULT_SETTINGS: Readonly<AppSettings> = {
  currency: 'USD',
  taxRate: 0,
  paymentTerms: '',
};

const C = '@happyvertical/smrt-commerce:';

/** Which model fields each setting is the default of (the single source). */
export const SETTING_TARGETS: Readonly<
  Record<keyof AppSettings, readonly { model: string; field: string }[]>
> = {
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
  paymentTerms: [
    ...['Order', 'WholesaleOrder', 'Estimate', 'Invoice', 'Agreement'].map(
      (model) => ({ model: `${C}${model}`, field: 'terms' }),
    ),
    { model: `${C}Customer`, field: 'paymentTerms' },
  ],
};

/**
 * A setting's row on a model no added recipe covers yet. Kept (by the store's
 * pruning and the import check) so a recipe added later starts with the
 * app's settings, and so removing every recipe never loses them.
 */
export function isSettingRow(row: FieldPolicyRow): boolean {
  return Object.values(SETTING_TARGETS).some((targets) =>
    targets.some((t) => t.model === row.objectRef && t.field === row.fieldName),
  );
}

const KEYS = Object.keys(SETTING_TARGETS) as (keyof AppSettings)[];

function rowValue(row: FieldPolicyRow | undefined): unknown {
  if (row?.defaultValue === undefined || row.defaultValue === null) {
    return undefined;
  }
  try {
    return JSON.parse(row.defaultValue);
  } catch {
    return undefined;
  }
}

function findRow(
  policies: readonly FieldPolicyRow[],
  model: string,
  field: string,
): FieldPolicyRow | undefined {
  return policies.find(
    (r) =>
      r.scopeType === 'app' && r.objectRef === model && r.fieldName === field,
  );
}

/** The app's settings: the first stored row of each, else the defaults. */
export function readSettings(
  cookbook: Pick<Cookbook, 'policies'>,
): AppSettings {
  const out: AppSettings = { ...DEFAULT_SETTINGS };
  const first = (key: keyof AppSettings, type: 'number' | 'string') => {
    for (const { model, field } of SETTING_TARGETS[key]) {
      const value = rowValue(findRow(cookbook.policies, model, field));
      if (typeof value === type) return value;
    }
    return undefined;
  };
  const currency = first('currency', 'string');
  const taxRate = first('taxRate', 'number');
  const paymentTerms = first('paymentTerms', 'string');
  if (typeof currency === 'string') out.currency = currency;
  if (typeof taxRate === 'number') out.taxRate = taxRate;
  if (typeof paymentTerms === 'string') out.paymentTerms = paymentTerms;
  return out;
}

/** Does the cookbook state a tax rate (a row), rather than leave the default? */
export function hasTaxRateRow(cookbook: Pick<Cookbook, 'policies'>): boolean {
  return SETTING_TARGETS.taxRate.some(
    ({ model, field }) =>
      typeof rowValue(findRow(cookbook.policies, model, field)) === 'number',
  );
}

/** What a model's field starts as before any app-scope row (catalog + recipe hints). */
function seedDefault(
  cookbook: Pick<Cookbook, 'recipes'>,
  modelId: string,
  field: string,
): unknown {
  const model = getModelByQualifiedName(modelId)?.model;
  if (!model) return undefined;
  const hints = cookbook.recipes
    .map((id) => recipesById.get(id)?.options?.[modelId])
    .find(Boolean);
  const entry = resolveFields(model, hints, []).find(
    (r) => r.field.name === field,
  );
  return entry?.hasDefault ? entry.default : undefined;
}

const isUnset = (v: unknown) => v === undefined || v === null || v === '';

/**
 * A copy of the cookbook with the settings written as policy rows. A row is
 * written for every model a setting covers (covered or not, so a recipe
 * added later picks it up) and only where the value
 * differs from what the model starts as; otherwise any row for it is removed,
 * so an unset or default setting leaves no rows. Other keys on a row
 * (visibility, label, ...) are kept.
 */
export function writeSettings(
  cookbook: Cookbook,
  settings: AppSettings,
): Cookbook {
  let policies = cookbook.policies.map((row) => ({ ...row }));

  for (const key of KEYS) {
    const raw = settings[key];
    const value =
      key === 'paymentTerms'
        ? String(raw).trim()
        : key === 'currency'
          ? String(raw).trim().toUpperCase()
          : raw;
    for (const { model, field } of SETTING_TARGETS[key]) {
      const seed = seedDefault(cookbook, model, field);
      const wanted =
        !isUnset(value) &&
        !(isUnset(seed) ? false : seed === value) &&
        !(isUnset(seed) && key === 'taxRate' && value === 0);
      const existing = findRow(policies, model, field);
      if (wanted) {
        const encoded = JSON.stringify(value);
        if (existing) existing.defaultValue = encoded;
        else
          policies.push({
            objectRef: model,
            fieldName: field,
            scopeType: 'app',
            defaultValue: encoded,
          });
      } else if (existing) {
        delete existing.defaultValue;
        if (Object.keys(existing).length <= 3) {
          policies = policies.filter((r) => r !== existing);
        }
      }
    }
  }
  return { ...cookbook, policies };
}

/** Starting values for a cookbook's editor: what it sets, else the defaults. */
export function settingsOfCookbook(
  settings: Partial<AppSettings> | undefined,
): AppSettings {
  return { ...DEFAULT_SETTINGS, ...settings };
}
