/**
 * Component-free view adapters for the manufacturing components.
 *
 * Pure functions and plain view types, importable from
 * `@happyvertical/smrt-manufacturing/views` without compiling any `.svelte`
 * file (server loads adapt service results here). `./svelte` re-exports
 * everything in this module unchanged.
 */

import type {
  BillStructure,
  BillStructureLine,
  ComponentKind,
} from './services/AssemblyService.js';
import type {
  ExplodedLine,
  Explosion,
  PlannedLine,
  RequirementsPlan,
} from './types.js';

export type { ComponentKind };

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
