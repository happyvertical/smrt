/**
 * Serializable view types and pure helpers for the manufacturing components.
 *
 * Components take plain view objects (not model instances) so hosts can pass
 * data across the server/client boundary.
 */

import type { Assembly } from '../models/Assembly.js';
import type {
  ProductionRun,
  ProductionRunStatus,
} from '../models/ProductionRun.js';
import type { ComponentKind } from '../views.js';
import { M } from './i18n.js';

/** One row of `OperationList`; an `Operation` satisfies it. */
export interface OperationView {
  /** The `Operation` id. */
  id: string;
  code: string;
  name: string;
  category: string;
  isActive: boolean;
  /** Plain string id of the required qualification; empty or omitted for none. */
  requiredQualificationId?: string | null;
}

/** Existing values passed to `OperationForm` when editing. */
export interface OperationFormInitial {
  code: string;
  name: string;
  category: string;
  requiredQualificationId: string | null;
}

/**
 * What `OperationForm` hands to `onsubmit`; values are trimmed. A host maps a
 * new operation onto `OperationService.define`, and an edit onto `rename` and
 * `update` for the values that differ (the code never changes).
 */
export interface OperationFormValues {
  code: string;
  name: string;
  category: string;
  requiredQualificationId: string;
}

/** A field `validateOperationForm` can reject. */
export type OperationFormField = 'code' | 'name';

/** Result of {@link validateOperationForm}. */
export type OperationFormValidation =
  | { ok: true; values: OperationFormValues }
  | { ok: false; invalid: OperationFormField[] };

/** The raw text `OperationForm` collects, before trimming and checks. */
export interface OperationFormDraft {
  code: string;
  name: string;
  category: string;
  requiredQualificationId: string;
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** Map an operation's state onto `StatusBadge` default color-scheme keys. */
export function operationStatusBadgeKey(isActive: boolean): string {
  return isActive ? 'active' : 'inactive';
}

/** Trim a form draft and check the required fields: code and name. */
export function validateOperationForm(
  draft: Readonly<Partial<OperationFormDraft>>,
): OperationFormValidation {
  const code = textOf(draft.code);
  const name = textOf(draft.name);
  const invalid: OperationFormField[] = [];
  if (!code) invalid.push('code');
  if (!name) invalid.push('name');
  if (invalid.length > 0) return { ok: false, invalid };
  return {
    ok: true,
    values: {
      code,
      name,
      category: textOf(draft.category),
      requiredQualificationId: textOf(draft.requiredQualificationId),
    },
  };
}

/**
 * The part of a resolved field policy `AssemblyList` reads: each field's
 * visibility. smrt-fields' `ResolvedObjectFieldPolicy` satisfies it.
 */
export interface AssemblyFieldPolicy {
  fields: Readonly<Record<string, { visibility?: string } | undefined>>;
}

/** A field of `AssemblyForm`, named as `Assembly` and `Product` name it. */
export type AssemblyFormField =
  | 'name'
  | 'description'
  | 'category'
  | 'partReference'
  | 'price'
  | 'estimatedLabourMinutes'
  | 'defaultOperationId'
  | 'tags'
  | 'skuCode';

/** Existing values passed to `AssemblyForm` when editing; an `Assembly` satisfies it. */
export interface AssemblyFormInitial {
  name: string;
  description: string;
  category: string;
  partReference: string;
  /** Catalog price in integer minor units (cents). */
  price: number;
  /** Labour to build one unit, in whole minutes. */
  estimatedLabourMinutes: number;
  /** The default `Operation` id, or `null` for none. */
  defaultOperationId: string | null;
  tags: readonly string[];
  /**
   * The part number: the code of the assembly's `Sku`. Optional; read only
   * when the form shows the part-number field.
   */
  skuCode?: string;
}

/**
 * What `AssemblyForm` hands to `onsubmit`; text is trimmed. A hidden or
 * read-only field carries its initial value unchanged (a default for a new
 * assembly), so a host can save every key or only the ones that differ.
 */
export interface AssemblyFormValues {
  name: string;
  description: string;
  category: string;
  partReference: string;
  /** Integer minor units (cents). */
  price: number;
  /** A whole number of minutes, zero or more. */
  estimatedLabourMinutes: number;
  /** The chosen `Operation` id, or `null` for none. */
  defaultOperationId: string | null;
  tags: string[];
  /**
   * The trimmed part number (SKU code, never empty). Present only when the
   * form showed the part-number field.
   */
  skuCode?: string;
}

/** A field `validateAssemblyForm` can reject. */
export type AssemblyFormInvalidField =
  | 'name'
  | 'price'
  | 'estimatedLabourMinutes'
  | 'skuCode';

/** The raw text `AssemblyForm` collects, before trimming and checks. */
export interface AssemblyFormDraft {
  name: string;
  description: string;
  category: string;
  partReference: string;
  /** Major units as typed, e.g. `1250.00`. */
  price: string;
  estimatedLabourMinutes: string;
  /** Empty for none. */
  defaultOperationId: string;
  /** Comma-separated. */
  tags: string;
  /** The part number as typed; present only when the form shows the field. */
  skuCode?: string;
}

/**
 * Errors the host reports back to `AssemblyForm`, such as a part number
 * already in use. A field message shows under that field; `form` shows above
 * the actions.
 */
export interface AssemblyFormErrors {
  form?: string;
  fields?: Partial<Record<AssemblyFormField, string>>;
}

/** Result of {@link validateAssemblyForm}. */
export type AssemblyFormValidation =
  | { ok: true; values: AssemblyFormValues }
  | { ok: false; invalid: AssemblyFormInvalidField[] };

/**
 * The number of decimal places in a currency's minor unit (2 for USD, 0 for
 * JPY, 3 for KWD), as `Intl` knows it; 2 when the code is not recognized.
 */
export function currencyExponent(currency: string): number {
  try {
    return (
      new Intl.NumberFormat('en', {
        style: 'currency',
        currency,
      }).resolvedOptions().maximumFractionDigits ?? 2
    );
  } catch {
    return 2;
  }
}

/**
 * Format integer minor units as the major-unit text the price field shows,
 * with `exponent` decimals. A negative value keeps its sign so validation
 * reports it instead of replacing it.
 */
export function formatPriceInput(minorUnits: number, exponent = 2): string {
  if (!Number.isSafeInteger(minorUnits)) return formatPriceInput(0, exponent);
  const sign = minorUnits < 0 ? '-' : '';
  const abs = Math.abs(minorUnits);
  if (exponent <= 0) return `${sign}${abs}`;
  const scale = 10 ** exponent;
  const whole = Math.floor(abs / scale);
  return `${sign}${whole}.${String(abs - whole * scale).padStart(exponent, '0')}`;
}

/** The draft `AssemblyForm` starts from for an assembly, or a blank one. */
export function assemblyFormDraft(
  initial: AssemblyFormInitial | null,
  exponent = 2,
): AssemblyFormDraft {
  return {
    name: initial?.name ?? '',
    description: initial?.description ?? '',
    category: initial?.category ?? '',
    partReference: initial?.partReference ?? '',
    price: formatPriceInput(initial?.price ?? 0, exponent),
    estimatedLabourMinutes: String(initial?.estimatedLabourMinutes ?? 0),
    defaultOperationId: initial?.defaultOperationId ?? '',
    tags: (initial?.tags ?? []).join(', '),
    ...(initial?.skuCode === undefined ? {} : { skuCode: initial.skuCode }),
  };
}

/**
 * `values` with every field in `protectedFields` replaced by its initial
 * value, exactly as stored (not trimmed or re-split), or its default for a
 * new assembly. A hidden or read-only field is never rewritten by the form.
 */
export function keepProtectedFields(
  values: AssemblyFormValues,
  initial: AssemblyFormInitial | null,
  protectedFields: readonly AssemblyFormField[],
): AssemblyFormValues {
  const kept: AssemblyFormValues = { ...values };
  const original: AssemblyFormValues = {
    name: initial?.name ?? '',
    description: initial?.description ?? '',
    category: initial?.category ?? '',
    partReference: initial?.partReference ?? '',
    price: initial?.price ?? 0,
    estimatedLabourMinutes: initial?.estimatedLabourMinutes ?? 0,
    defaultOperationId: initial?.defaultOperationId ?? null,
    tags: [...(initial?.tags ?? [])],
  };
  for (const field of protectedFields) {
    // The part number is optional: it is kept only when the form carried it.
    if (field === 'skuCode') {
      if (kept.skuCode !== undefined) kept.skuCode = initial?.skuCode ?? '';
      continue;
    }
    (kept as unknown as Record<string, unknown>)[field] = original[field];
  }
  return kept;
}

function parseTags(raw: string): string[] {
  const tags: string[] = [];
  for (const part of raw.split(',')) {
    const tag = part.trim();
    if (tag && !tags.includes(tag)) tags.push(tag);
  }
  return tags;
}

/**
 * Trim a form draft and check it the way the model does: the name is
 * required, the labour estimate is a whole number of minutes of zero or more
 * (empty counts as zero), and the price is an amount of zero or more with at
 * most `exponent` decimals (empty counts as zero; 2 unless the currency says
 * otherwise). A part number, when the draft carries one, must not be empty.
 * Fields in `skip` (hidden or
 * read-only in the form) are not checked.
 */
export function validateAssemblyForm(
  draft: Readonly<Partial<AssemblyFormDraft>>,
  skip: readonly AssemblyFormField[] = [],
  exponent = 2,
): AssemblyFormValidation {
  const invalid: AssemblyFormInvalidField[] = [];
  const name = textOf(draft.name);
  const minutesText = textOf(draft.estimatedLabourMinutes);
  const priceText = textOf(draft.price);

  let estimatedLabourMinutes = 0;
  if (minutesText !== '') {
    estimatedLabourMinutes = /^\d+$/.test(minutesText)
      ? Number(minutesText)
      : Number.NaN;
  }
  let price = 0;
  if (priceText !== '') {
    const match = new RegExp(
      exponent > 0 ? `^(\\d+)(?:\\.(\\d{1,${exponent}}))?$` : '^(\\d+)$',
    ).exec(priceText);
    price = match
      ? Number(match[1]) * 10 ** exponent +
        Number((match[2] ?? '').padEnd(exponent, '0') || 0)
      : Number.NaN;
  }

  if (!name && !skip.includes('name')) invalid.push('name');
  if (!Number.isSafeInteger(price) && !skip.includes('price'))
    invalid.push('price');
  if (
    !Number.isSafeInteger(estimatedLabourMinutes) &&
    !skip.includes('estimatedLabourMinutes')
  )
    invalid.push('estimatedLabourMinutes');
  const skuCode =
    draft.skuCode === undefined ? undefined : textOf(draft.skuCode);
  if (skuCode === '' && !skip.includes('skuCode')) invalid.push('skuCode');
  if (invalid.length > 0) return { ok: false, invalid };

  return {
    ok: true,
    values: {
      ...(skuCode === undefined ? {} : { skuCode }),
      name,
      description: textOf(draft.description),
      category: textOf(draft.category),
      partReference: textOf(draft.partReference),
      price: Number.isSafeInteger(price) ? price : 0,
      estimatedLabourMinutes: Number.isSafeInteger(estimatedLabourMinutes)
        ? estimatedLabourMinutes
        : 0,
      defaultOperationId: textOf(draft.defaultOperationId) || null,
      tags: parseTags(draft.tags ?? ''),
    },
  };
}

export type {
  BomEditorLine,
  ComponentKind,
  RequirementLineView,
  RequirementTotalView,
} from '../views.js';
export {
  toBomEditorLine,
  toBomEditorLines,
  toRequirementTotals,
  toRequirementTree,
} from '../views.js';

/** One row of {@link AssemblyList}. */
export interface AssemblyView {
  /** The assembly id. */
  id: string;
  /** Display name. */
  name: string;
  /** The organization's drawing or part number; empty when none. */
  partReference: string;
  /** Codes of the assembly's SKUs, in the host's order. */
  skuCodes: string[];
  /** Catalog price in integer minor units (cents). */
  price: number;
  /** Labour to build one unit, in minutes; `0` when not estimated. */
  estimatedLabourMinutes: number;
  /** Version of the active bill, or `null` when the assembly has none. */
  activeBomVersion: number | null;
}

/**
 * Build an {@link AssemblyView} from an `Assembly` plus the facts the list
 * shows that live on its neighbours: its SKU codes and its active bill.
 */
export function toAssemblyView(
  assembly: Pick<
    Assembly,
    'id' | 'name' | 'partReference' | 'price' | 'estimatedLabourMinutes'
  >,
  related: {
    skuCodes?: readonly string[];
    activeBomVersion?: number | null;
  } = {},
): AssemblyView {
  return {
    id: assembly.id ?? '',
    name: assembly.name,
    partReference: assembly.partReference ?? '',
    skuCodes: [...(related.skuCodes ?? [])],
    price: Number(assembly.price ?? 0),
    estimatedLabourMinutes: Number(assembly.estimatedLabourMinutes ?? 0),
    activeBomVersion: related.activeBomVersion ?? null,
  };
}

/** A component the editor offers when adding a line. */
export interface BomComponentOption {
  /** The component SKU id. */
  skuId: string;
  /** Text shown in the chooser, e.g. `Side panel (SP-100)`. */
  label: string;
}

/** A bill line as the editor submits it, checked and trimmed. */
export interface BomLineDraft {
  /** The component SKU id. */
  componentSkuId: string;
  /** Quantity per produced unit, greater than zero. */
  qtyPerUnit: number;
  /** Unit of measure, never empty. */
  uom: string;
  /** Expected waste in percent, zero or more. */
  wastePercent: number;
}

/** A field of {@link BomLineDraft} that can fail validation. */
export type BomLineDraftField = keyof BomLineDraft;

/** The editor's raw input for one line, before validation. */
export interface BomLineInput {
  /** Chosen component SKU id; empty when none is chosen. */
  componentSkuId: string;
  /** Quantity as typed. */
  qtyPerUnit: string | number;
  /** Unit as typed. */
  uom: string;
  /** Waste percent as typed; empty means zero. */
  wastePercent: string | number;
}

/** The outcome of {@link validateBomLineInput}. */
export type BomLineValidation =
  | { ok: true; value: BomLineDraft }
  | { ok: false; invalid: BomLineDraftField[] };

function toNumber(raw: string | number): number {
  if (typeof raw === 'number') return raw;
  const trimmed = raw.trim();
  return trimmed === '' ? Number.NaN : Number(trimmed);
}

/**
 * Check one line's input: a component must be chosen, the quantity must be a
 * number greater than zero, the unit must not be empty, and the waste percent
 * must be a number of zero or more (empty counts as zero).
 */
export function validateBomLineInput(input: BomLineInput): BomLineValidation {
  const invalid: BomLineDraftField[] = [];
  const componentSkuId = input.componentSkuId.trim();
  const qtyPerUnit = toNumber(input.qtyPerUnit);
  const uom = input.uom.trim();
  const wasteRaw =
    typeof input.wastePercent === 'string' && input.wastePercent.trim() === ''
      ? 0
      : toNumber(input.wastePercent);

  if (!componentSkuId) invalid.push('componentSkuId');
  if (!Number.isFinite(qtyPerUnit) || qtyPerUnit <= 0)
    invalid.push('qtyPerUnit');
  if (!uom) invalid.push('uom');
  if (!Number.isFinite(wasteRaw) || wasteRaw < 0) invalid.push('wastePercent');

  if (invalid.length > 0) return { ok: false, invalid };
  return {
    ok: true,
    value: { componentSkuId, qtyPerUnit, uom, wastePercent: wasteRaw },
  };
}

/** The message key naming a {@link ComponentKind} in words. */
export function componentKindLabelKey(kind: ComponentKind) {
  switch (kind) {
    case 'assembly':
      return M['manufacturing.kind.assembly'];
    case 'material':
      return M['manufacturing.kind.material'];
    case 'bought':
      return M['manufacturing.kind.bought'];
    default:
      return M['manufacturing.kind.missing'];
  }
}

/** Split a labour estimate into whole hours and the remaining minutes. */
export function splitLabourMinutes(minutes: number): {
  hours: number;
  minutes: number;
} {
  const whole = Math.max(0, Math.round(minutes));
  return { hours: Math.floor(whole / 60), minutes: whole % 60 };
}

// ─────────────────────────────────────────────────────────────────────────────
// Production runs
// ─────────────────────────────────────────────────────────────────────────────

export type { ProductionRunStatus };

/** One row of `ProductionRunList`. */
export interface ProductionRunView {
  /** The run id. */
  id: string;
  /** What is being built, as the host names it (an assembly's name, say). */
  label: string;
  /** Units to build. */
  targetQty: number;
  /** Units reported done. */
  completedQty: number;
  /** The run's status. */
  status: ProductionRunStatus;
}

/** Adapt a `ProductionRun` to a {@link ProductionRunView}, with the host's label. */
export function toProductionRunView(
  run: Pick<ProductionRun, 'id' | 'targetQty' | 'completedQty' | 'status'>,
  label: string,
): ProductionRunView {
  return {
    id: run.id as string,
    label,
    targetQty: Number(run.targetQty),
    completedQty: Number(run.completedQty),
    status: run.status,
  };
}

/** The message key naming a run status in words. */
export function productionRunStatusLabelKey(status: ProductionRunStatus) {
  switch (status) {
    case 'planned':
      return M['manufacturing.production_run_status.planned'];
    case 'in_progress':
      return M['manufacturing.production_run_status.in_progress'];
    case 'done':
      return M['manufacturing.production_run_status.done'];
    default:
      return M['manufacturing.production_run_status.cancelled'];
  }
}

/** The `StatusBadge` tone for a run status. */
export function productionRunStatusTone(
  status: ProductionRunStatus,
): 'neutral' | 'info' | 'success' | 'warning' {
  switch (status) {
    case 'in_progress':
      return 'info';
    case 'done':
      return 'success';
    case 'cancelled':
      return 'warning';
    default:
      return 'neutral';
  }
}

/** `true` while a run can still take completions. */
export function isProductionRunOpen(status: ProductionRunStatus): boolean {
  return status === 'planned' || status === 'in_progress';
}

/** Result of {@link validateCompletionQty}. */
export type CompletionQtyValidation =
  | { ok: true; qty: number }
  | { ok: false; reason: 'invalid' | 'too_many' };

/**
 * Check a typed completion quantity against what the run has left (the
 * service checks again under its lock).
 */
export function validateCompletionQty(
  raw: string,
  run: Pick<ProductionRunView, 'targetQty' | 'completedQty'>,
): CompletionQtyValidation {
  const text = raw.trim();
  const qty = text === '' ? Number.NaN : Number(text);
  if (!Number.isFinite(qty) || qty <= 0)
    return { ok: false, reason: 'invalid' };
  // Whole millionths compared exactly, as ProductionRunService does
  // (QUANTITY_DECIMALS = 6, MAX_QUANTITY = 999,999,999).
  const millionths = (value: number) =>
    Number(value.toFixed(6).replace('.', ''));
  const rounded = Number(qty.toFixed(6));
  if (rounded <= 0 || rounded > 999_999_999)
    return { ok: false, reason: 'invalid' };
  const remaining = millionths(run.targetQty) - millionths(run.completedQty);
  if (millionths(rounded) > remaining) return { ok: false, reason: 'too_many' };
  return { ok: true, qty: rounded };
}

/** Result of {@link validateTargetQty}. */
export type TargetQtyValidation =
  | { ok: true; qty: number }
  | { ok: false; reason: 'invalid' | 'below_done' };

/**
 * Check a typed target quantity: greater than zero, within the quantity
 * limits, and not below what the run has already completed (the service
 * checks again under its lock).
 */
export function validateTargetQty(
  raw: string,
  run: Pick<ProductionRunView, 'completedQty'>,
): TargetQtyValidation {
  const text = raw.trim();
  const qty = text === '' ? Number.NaN : Number(text);
  if (!Number.isFinite(qty) || qty <= 0)
    return { ok: false, reason: 'invalid' };
  const millionths = (value: number) =>
    Number(value.toFixed(6).replace('.', ''));
  const rounded = Number(qty.toFixed(6));
  if (rounded <= 0 || rounded > 999_999_999)
    return { ok: false, reason: 'invalid' };
  if (millionths(rounded) < millionths(run.completedQty))
    return { ok: false, reason: 'below_done' };
  return { ok: true, qty: rounded };
}
