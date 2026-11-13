import type { Workbook } from '@happyvertical/spreadsheets';
import {
  checkLoaded,
  checkPlan,
  type ImportFacts,
  verificationWork,
} from './checks.js';
import { ImportRunError } from './errors.js';
import { WorkBudget } from './evaluate.js';
import { type Finding, hasErrors } from './findings.js';
import { DEFAULT_IMPORT_LIMITS, type ImportLimits } from './limits.js';
import { admit, planLoad } from './load.js';
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
  /** Work units spent, verification reservation included. */
  work: number;
}

/**
 * First import of a workbook into an empty target: validate, admit, check,
 * plan the whole load, reserve the read-back work, and only then touch the
 * target: build structure, load every batch, prove the result by reading it
 * back. `work-over-limit` is therefore thrown before the first target call or
 * not at all. Adapter errors propagate untouched.
 */
export async function runImport(
  options: RunImportOptions,
): Promise<RunImportResult> {
  const plan = validatePlan(options.plan);
  admit(options.workbook, options.limits, plan);

  // One ceiling for every step: checking, planning and verifying.
  const budget = new WorkBudget(
    options.limits?.maxWork ?? DEFAULT_IMPORT_LIMITS.maxWork,
  );
  const planned = checkPlan(
    plan,
    options.workbook,
    undefined,
    options.limits,
    budget,
  );
  if (!planned.ok) {
    return {
      ok: false,
      findings: planned.findings,
      facts: planned.facts,
      loaded: {},
      plan,
      work: budget.used,
    };
  }

  // Everything that can exhaust the budget happens before the first call on
  // the target: plan the whole load now, and reserve the read-back work.
  const load = planLoad(plan, options.workbook, {
    batchSize: options.batchSize,
    limits: options.limits,
    budget,
  });
  const batches = [...load.batches()];
  budget.charge(verificationWork(plan, planned.facts));

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
  for (const table of load.order) loaded[table] = 0;
  for (const batch of batches) {
    const result = await options.target.load(batch);
    loaded[batch.table] += result.loaded;
  }

  // Verification draws from the reservation: its own bounded accounting, no throw.
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
    work: budget.used,
  };
}
