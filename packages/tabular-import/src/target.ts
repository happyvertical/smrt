import type { LoadBatch } from './load.js';
import type { ImportPlan } from './plan.js';

/** What a target already holds. Only keys matter to the import. */
export interface TargetStructure {
  tables: Array<{
    key: string;
    fields: Array<{ key: string; type?: string }>;
    lookupKey?: string[];
  }>;
}

export interface TargetRow {
  /** Absolute sheet row the target kept for the record. */
  sourceRow: number;
  values: Record<string, unknown>;
}

/**
 * The product-owned half of an import. This package decides what to load and
 * proves it arrived; a target decides where it goes. Nothing in the contract
 * names a product, a database or a model layer.
 */
export interface ImportTarget {
  describe(): Promise<TargetStructure>;
  /** Creates tables, fields, calculated fields and reports. */
  applyStructure(plan: ImportPlan): Promise<void>;
  /** Resolves references by lookup key. All or nothing per batch. */
  load(batch: LoadBatch): Promise<{ loaded: number }>;
  count(table: string): Promise<number>;
  /** Money in minor units. Integer/money totals beyond the safe range stay bigint. */
  sum(table: string, field: string): Promise<number | bigint>;
  /** Stored values in source-row order, calculated fields included. */
  values(
    table: string,
    fields: string[],
    sourceRows?: number[],
  ): AsyncIterable<TargetRow>;
}
