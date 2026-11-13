import type { Workbook } from '@happyvertical/spreadsheets';
import { checkLoaded, checkPlan, type ImportFacts } from './checks.js';
import { ImportRunError } from './errors.js';
import { type Finding, hasErrors } from './findings.js';
import { admit, type ImportLimits, planLoad } from './load.js';
import { type ImportPlan, validatePlan } from './plan.js';
import type { ImportTarget } from './target.js';

export interface RunImportOptions {
  /** A plan to validate; the validated copy is what runs. */
  plan: unknown;
  workbook: Workbook;
  target: ImportTarget;
  limits?: Partial<ImportLimits>;
  batchSize?: number;
}

export interface RunImportResult {
  /** True when nothing is an error: the data is loaded and proven. */
  ok: boolean;
  findings: Finding[];
  facts: ImportFacts;
  /** Rows the target reports loading, per table. Empty when nothing was written. */
  loaded: Record<string, number>;
  plan: ImportPlan;
}

/**
 * First import of a workbook into an empty target: validate, admit, check,
 * build structure, load every batch, then prove the result by reading it back.
 * Adapter errors propagate untouched.
 */
export async function runImport(
  options: RunImportOptions,
): Promise<RunImportResult> {
  const plan = validatePlan(options.plan);
  admit(options.workbook, options.limits, plan);

  const planned = checkPlan(plan, options.workbook);
  if (!planned.ok) {
    return {
      ok: false,
      findings: planned.findings,
      facts: planned.facts,
      loaded: {},
      plan,
    };
  }

  const structure = await options.target.describe();
  const existing = new Set(structure.tables.map((table) => table.key));
  const clash = plan.tables.filter((table) => existing.has(table.key));
  if (clash.length > 0) {
    throw new ImportRunError(
      'target-not-empty',
      `The target already has ${clash.map((t) => `"${t.key}"`).join(', ')}; this import is first-time only.`,
      { tables: clash.map((table) => table.key) },
    );
  }

  await options.target.applyStructure(plan);
  const loaded: Record<string, number> = {};
  const load = planLoad(plan, options.workbook, {
    batchSize: options.batchSize,
  });
  for (const table of load.order) loaded[table] = 0;
  for (const batch of load.batches()) {
    const result = await options.target.load(batch);
    loaded[batch.table] += result.loaded;
  }

  const verified = await checkLoaded(
    plan,
    options.workbook,
    options.target,
    planned.facts,
  );
  const findings = [...planned.findings, ...verified.findings];
  return {
    ok: !hasErrors(findings),
    findings,
    facts: planned.facts,
    loaded,
    plan,
  };
}
