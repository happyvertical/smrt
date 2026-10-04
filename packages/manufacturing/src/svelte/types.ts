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
import type {
  BillStructure,
  BillStructureLine,
  ComponentKind,
} from '../services/AssemblyService.js';
import type {
  ExplodedLine,
  Explosion,
  PlannedLine,
  RequirementsPlan,
} from '../types.js';
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

// ─────────────────────────────────────────────────────────────────────────────
// Exploded requirements
// ─────────────────────────────────────────────────────────────────────────────

/** One line of `RequirementsTree`, with the lines of its bill when opened. */
export interface RequirementLineView {
  /** Unique within the tree: the bills above it plus the line id. */
  key: string;
  /** 1 for the top bill's lines. */
  level: number;
  /** Component name; empty when it cannot be resolved. */
  name: string;
  /** Component SKU code; empty when unknown. */
  skuCode: string;
  /** What the component is. */
  kind: ComponentKind;
  /** Quantity required for the run (net of stock in a plan). */
  required: number;
  /** The line's unit. */
  uom: string;
  /** Unallocated available stock; `null` for a gross explosion. */
  available: number | null;
  /** How much is short; `null` for a gross explosion. */
  short: number | null;
  /** A sub-assembly with an active bill. */
  buildable: boolean;
  /** The lines of this sub-assembly's bill that were walked. */
  children: RequirementLineView[];
}

/** One row of the totals table of `RequirementsTree`. */
export interface RequirementTotalView {
  /** The component SKU. */
  componentSkuId: string;
  /** Component name; empty when it cannot be resolved. */
  name: string;
  /** Component SKU code; empty when unknown. */
  skuCode: string;
  /** Total required, summed over the lines not opened. */
  required: number;
  /** The first line's unit. */
  uom: string;
  /** Total short; `null` for a gross explosion. */
  short: number | null;
}

function isPlanned(line: ExplodedLine): line is PlannedLine {
  return 'short' in line;
}

/**
 * Nest the depth-first lines of an {@link Explosion} or a
 * {@link RequirementsPlan} for `RequirementsTree`.
 */
export function toRequirementTree(
  source: Pick<Explosion | RequirementsPlan, 'lines'>,
): RequirementLineView[] {
  const roots: RequirementLineView[] = [];
  const open: RequirementLineView[] = [];
  for (const line of source.lines as ExplodedLine[]) {
    const view: RequirementLineView = {
      key: [...line.path.map((entry) => entry.bomId), line.lineId].join('/'),
      level: line.level,
      name: line.name,
      skuCode: line.skuCode,
      kind: line.kind,
      required: line.totalQty,
      uom: line.uom,
      available: isPlanned(line) ? line.available : null,
      short: isPlanned(line) ? line.short : null,
      buildable: line.buildable,
      children: [],
    };
    open.length = Math.min(open.length, line.level - 1);
    const parent = open[line.level - 2];
    if (line.level > 1 && parent) parent.children.push(view);
    else roots.push(view);
    open[line.level - 1] = view;
  }
  return roots;
}

/**
 * The totals of an {@link Explosion} or a {@link RequirementsPlan}: every line
 * not opened, summed per component SKU (first unit kept).
 */
export function toRequirementTotals(
  source: Pick<Explosion | RequirementsPlan, 'lines'>,
): RequirementTotalView[] {
  const totals = new Map<string, RequirementTotalView>();
  for (const line of source.lines as ExplodedLine[]) {
    if (line.expanded) continue;
    const short = isPlanned(line) ? line.short : null;
    const existing = totals.get(line.componentSkuId);
    if (existing) {
      existing.required += line.totalQty;
      if (existing.short !== null && short !== null) existing.short += short;
    } else {
      totals.set(line.componentSkuId, {
        componentSkuId: line.componentSkuId,
        name: line.name,
        skuCode: line.skuCode,
        required: line.totalQty,
        uom: line.uom,
        short,
      });
    }
  }
  return Array.from(totals.values());
}
