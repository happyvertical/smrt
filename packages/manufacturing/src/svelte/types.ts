/**
 * Serializable view types and pure helpers for the manufacturing components.
 *
 * Components take plain view objects (not model instances) so hosts can pass
 * data across the server/client boundary.
 */

import type { Assembly } from '../models/Assembly.js';
import type {
  BillStructure,
  BillStructureLine,
  ComponentKind,
} from '../services/AssemblyService.js';
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

export type { ComponentKind };

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

/** One line of {@link BomEditor}. */
export interface BomEditorLine {
  /** The bill line id. */
  id: string;
  /** The component SKU the line consumes. */
  componentSkuId: string;
  /** The component's product name, or its SKU code when that is unknown. */
  componentName: string;
  /** The component's SKU code; empty when the SKU is missing. */
  skuCode: string;
  /** What the component is. */
  kind: ComponentKind;
  /** Quantity per produced unit, before waste. */
  qtyPerUnit: number;
  /** Unit of measure. */
  uom: string;
  /** Expected waste, in percent. */
  wastePercent: number;
  /** Free-form notes. */
  notes: string;
  /**
   * For a sub-assembly, the id of its own active bill; `null` when it has
   * none, and for every other kind.
   */
  subBomId: string | null;
}

/** Adapt one resolved bill line for {@link BomEditor}. */
export function toBomEditorLine(entry: BillStructureLine): BomEditorLine {
  const { line, component } = entry;
  const skuCode = component.sku?.code ?? '';
  return {
    id: line.id ?? '',
    componentSkuId: line.componentSkuId,
    componentName: component.product?.name || skuCode || line.componentSkuId,
    skuCode,
    kind: component.kind,
    qtyPerUnit: Number(line.qtyPerUnit ?? 0),
    uom: line.uom,
    wastePercent: Number(line.wastePercent ?? 0),
    notes: line.notes ?? '',
    subBomId: component.activeBom?.id ?? null,
  };
}

/**
 * Adapt a whole bill from `AssemblyService.getBillStructure` for
 * {@link BomEditor}, keeping its line order.
 */
export function toBomEditorLines(structure: BillStructure): BomEditorLine[] {
  return structure.lines.map(toBomEditorLine);
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
