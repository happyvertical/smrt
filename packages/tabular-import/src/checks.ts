import {
  address,
  type Cell,
  type Workbook,
  type WorkbookProfile,
} from '@happyvertical/spreadsheets';
import { describeCell, isBlankCell, isoDate } from './coerce.js';
import {
  type EvaluatedTable,
  evaluatePlan,
  keyText,
  type PlannedRecord,
  WorkBudget,
} from './evaluate.js';
import { type Finding, FindingSink, hasErrors } from './findings.js';
import { DEFAULT_IMPORT_LIMITS, type ImportLimits } from './limits.js';
import type { ImportPlan, PlanField, PlanTable } from './plan.js';
import type { ImportTarget } from './target.js';

/** Numbers a table summed per field, for the after-load comparison. */
export interface TableFacts {
  /** Data rows examined. */
  read: number;
  /** Rows left out: skipRows and rows with every mapped cell blank. */
  skipped: number;
  /** Rows refused by an error finding. */
  rejected: number;
  /** Records that will be loaded. */
  planned: number;
}

export interface ImportFacts {
  tables: Record<string, TableFacts>;
  /** table -> field -> sum. Money and integers in exact minor units/integers. */
  sums: Record<string, Record<string, number>>;
}

export interface CheckResult {
  /** No error findings. */
  ok: boolean;
  findings: Finding[];
}

export interface PlanCheckResult extends CheckResult {
  facts: ImportFacts;
  /** Work units this check spent against `maxWork`. */
  work: number;
}

const SUMMED: ReadonlySet<string> = new Set(['number', 'integer', 'money']);

/** Neumaier-compensated sum: the error does not grow with the row count. */
export function compensatedSum(values: Iterable<number>): number {
  let sum = 0;
  let compensation = 0;
  for (const value of values) {
    const next = sum + value;
    compensation +=
      Math.abs(sum) >= Math.abs(value)
        ? sum - next + value
        : value - next + sum;
    sum = next;
  }
  return sum + compensation;
}

function columnSum(
  rows: readonly PlannedRecord[],
  field: PlanField,
): { value: number; safe: boolean } {
  if (field.type === 'number') {
    return {
      value: compensatedSum(
        rows.map((row) => Number(row.values[field.key] ?? 0)),
      ),
      safe: true,
    };
  }
  let total = 0n;
  for (const row of rows) {
    const value = row.values[field.key];
    if (typeof value === 'number') total += BigInt(value);
  }
  const safe =
    total <= BigInt(Number.MAX_SAFE_INTEGER) &&
    total >= BigInt(Number.MIN_SAFE_INTEGER);
  return { value: Number(total), safe };
}

/** Findings that need the rows of more than one table. */
function crossChecks(
  tables: ReadonlyMap<string, EvaluatedTable>,
  sink: FindingSink,
  budget: WorkBudget,
): void {
  const keyIndex = new Map<string, Set<string>>();
  for (const evaluated of tables.values()) {
    const { table } = evaluated;
    if (!table.lookupKey) continue;
    const keys = new Set<string>();
    const firstRow = new Map<string, number>();
    const columnOf = new Map(table.fields.map((f) => [f.key, f.column]));
    budget.charge(
      1 + table.fields.length + evaluated.rows.length * table.lookupKey.length,
    );
    for (const row of evaluated.rows) {
      const parts = table.lookupKey.map((key) => row.values[key] ?? null);
      const blankIndex = parts.indexOf(null);
      if (blankIndex >= 0) {
        const field = table.lookupKey[blankIndex];
        const column = columnOf.get(field);
        sink.add({
          code: 'lookup-key-blank',
          severity: 'error',
          table: table.key,
          field,
          sheet: table.source.sheet,
          row: row.sourceRow,
          ...(column !== undefined
            ? { cell: address({ row: row.sourceRow, col: column }) }
            : {}),
          message: `Row ${row.sourceRow}: lookup key field "${field}" is blank.`,
        });
        continue;
      }
      const text = keyText(parts);
      const earlier = firstRow.get(text);
      if (earlier !== undefined) {
        sink.add({
          code: 'lookup-key-not-unique',
          severity: 'error',
          table: table.key,
          field: table.lookupKey.join(','),
          sheet: table.source.sheet,
          row: row.sourceRow,
          actual: parts.join(' | '),
          message: `Row ${row.sourceRow}: lookup key (${parts.join(', ')}) already appears on row ${earlier}.`,
        });
        continue;
      }
      firstRow.set(text, row.sourceRow);
      keys.add(text);
    }
    keyIndex.set(table.key, keys);
  }

  for (const evaluated of tables.values()) {
    const { table } = evaluated;
    for (const field of table.fields) {
      if (!field.reference) continue;
      const known = keyIndex.get(field.reference.table) ?? new Set<string>();
      budget.charge(1 + evaluated.rows.length);
      for (const row of evaluated.rows) {
        const ref = row.references[field.key];
        if (!ref || known.has(keyText(ref.key))) continue;
        const column = field.reference.columns[0];
        sink.add({
          code: 'reference-unresolved',
          severity: 'error',
          table: table.key,
          field: field.key,
          sheet: table.source.sheet,
          cell: address({ row: row.sourceRow, col: column }),
          row: row.sourceRow,
          expected: field.reference.table,
          actual: ref.key.join(' | '),
          message: `Row ${row.sourceRow}: no ${field.reference.table} row has key (${ref.key.join(', ')}).`,
        });
      }
    }
  }
}

/**
 * Checks a plan against a workbook before anything is written. The plan must
 * already be valid ({@link validatePlan}); `profile` is accepted for callers
 * that hold a workbook profile and is not needed to decide anything here.
 */
export function checkPlan(
  plan: ImportPlan,
  workbook: Workbook,
  _profile?: WorkbookProfile,
  limits: Partial<ImportLimits> = {},
  budget: WorkBudget = new WorkBudget(
    limits.maxWork ?? DEFAULT_IMPORT_LIMITS.maxWork,
  ),
): PlanCheckResult {
  const sink = new FindingSink();
  const tables = evaluatePlan(plan, workbook, sink, budget);
  crossChecks(tables, sink, budget);

  const facts: ImportFacts = { tables: {}, sums: {} };
  for (const [key, evaluated] of tables) {
    facts.tables[key] = {
      read: evaluated.read,
      skipped: evaluated.skipped,
      rejected: evaluated.rejected,
      planned: evaluated.rows.length,
    };
    const sums: Record<string, number> = {};
    for (const field of evaluated.table.fields) {
      if (field.column === undefined || !SUMMED.has(field.type)) continue;
      budget.charge(1 + evaluated.rows.length);
      const sum = columnSum(evaluated.rows, field);
      if (!sum.safe) {
        sink.add({
          code: 'sum-unsafe',
          severity: 'error',
          table: key,
          field: field.key,
          message: `The column sum of "${field.key}" exceeds the safe integer range.`,
        });
      }
      sums[field.key] = sum.value;
    }
    facts.sums[key] = sums;
  }
  const findings = sink.list();
  return { ok: !hasErrors(findings), findings, facts, work: budget.used };
}

function relativelyEqual(a: number, b: number, tolerance = 1e-9): boolean {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  if (a === b) return true;
  return Math.abs(a - b) <= tolerance * Math.max(Math.abs(a), Math.abs(b));
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (value === 1 || value === '1') return true;
  if (value === 0 || value === '0') return false;
  return undefined;
}

function asIsoDate(value: unknown): string | undefined {
  if (value instanceof Date) return isoDate(value);
  if (typeof value === 'string')
    return /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : undefined;
  return undefined;
}

/** Why a stored calculated value cannot be a valid value of its field, if it cannot. */
function invalidCalculated(
  field: PlanField,
  actual: unknown,
): string | undefined {
  if (actual === null || actual === undefined) return undefined;
  const whole = field.type === 'integer' || field.type === 'money';
  if (!whole && field.type !== 'number') return undefined;
  if (typeof actual === 'bigint') {
    return actual <= BigInt(Number.MAX_SAFE_INTEGER) &&
      actual >= BigInt(Number.MIN_SAFE_INTEGER)
      ? undefined
      : `${actual} is beyond the safe integer range`;
  }
  const n = actual;
  if (typeof n !== 'number' || !Number.isFinite(n)) {
    return `${String(actual)} is not a finite number`;
  }
  if (whole && !Number.isInteger(n)) return `${n} is not a whole number`;
  if (whole && !Number.isSafeInteger(n))
    return `${n} is beyond the safe integer range`;
  return undefined;
}

/** Does the target's value for a calculated field agree with the workbook's cached result? */
function cachedAgrees(
  field: PlanField,
  cached: Cell | undefined,
  actual: unknown,
): boolean {
  const cachedBlank = isBlankCell(cached, false) || cached?.type === 'error';
  if (cachedBlank) return actual === null || actual === undefined;
  if (actual === null || actual === undefined) return false;
  const value = cached?.value;
  switch (field.type) {
    case 'number': {
      const a = asNumber(actual);
      return (
        typeof value === 'number' &&
        a !== undefined &&
        relativelyEqual(value, a)
      );
    }
    // Integers and money are exact: no tolerance, however large the value.
    case 'integer': {
      const a = asNumber(actual);
      return typeof value === 'number' && a !== undefined && value === a;
    }
    case 'money': {
      const a = asNumber(actual);
      if (typeof value !== 'number' || a === undefined) return false;
      const minor = value * 10 ** (field.money?.scale ?? 0);
      const rounded = Math.round(minor);
      // A cached amount finer than a minor unit cannot equal a stored integer.
      return Math.abs(minor - rounded) <= 1e-6 && rounded === a;
    }
    case 'boolean':
      return typeof value === 'boolean' && asBoolean(actual) === value;
    case 'date':
      return value instanceof Date && asIsoDate(actual) === isoDate(value);
    default:
      return typeof value === 'string'
        ? value === String(actual)
        : describeCell(cached) === String(actual);
  }
}

/**
 * The most work `checkLoaded` can spend for these planned counts. `runImport`
 * reserves it before its first call on the target, so verification can never
 * exhaust the budget after something was written.
 */
export function verificationWork(plan: ImportPlan, facts: ImportFacts): number {
  let work = 0;
  for (const table of plan.tables) {
    const planned = facts.tables[table.key]?.planned ?? 0;
    const calculated = table.fields.filter((f) => f.calculated !== undefined);
    const summed = table.fields.filter(
      (f) => f.column !== undefined && SUMMED.has(f.type),
    );
    work += 1 + summed.length;
    if (calculated.length > 0) work += (planned + 1) * (1 + calculated.length);
  }
  return work;
}

/**
 * After a load: row counts, column sums and every calculated field with a
 * cached column, read back from the target and compared with the workbook.
 */
export async function checkLoaded(
  plan: ImportPlan,
  workbook: Workbook,
  target: ImportTarget,
  facts: ImportFacts,
  budget: WorkBudget = new WorkBudget(Number.POSITIVE_INFINITY),
): Promise<CheckResult> {
  const sink = new FindingSink();
  for (const table of plan.tables) {
    const planned = facts.tables[table.key]?.planned ?? 0;
    const count = await target.count(table.key);
    if (count !== planned) {
      sink.add({
        code: 'row-count-mismatch',
        severity: 'error',
        table: table.key,
        expected: planned,
        actual: count,
        message: `"${table.key}" holds ${count} rows; the workbook plans ${planned}.`,
      });
    }
    for (const field of table.fields) {
      if (field.column === undefined || !SUMMED.has(field.type)) continue;
      const expected = facts.sums[table.key]?.[field.key];
      if (expected === undefined) continue;
      const actual = Number(await target.sum(table.key, field.key));
      const equal =
        field.type === 'number'
          ? relativelyEqual(expected, actual)
          : expected === actual;
      if (!equal) {
        sink.add({
          code: 'sum-mismatch',
          severity: 'error',
          table: table.key,
          field: field.key,
          expected,
          actual,
          message: `"${table.key}.${field.key}" sums to ${actual}; the workbook sums to ${expected}.`,
        });
      }
    }
    await checkCalculated(table, workbook, target, sink, budget, planned + 1);
  }
  const findings = sink.list();
  return { ok: !hasErrors(findings), findings };
}

async function checkCalculated(
  table: PlanTable,
  workbook: Workbook,
  target: ImportTarget,
  sink: FindingSink,
  budget: WorkBudget,
  maxRows: number,
): Promise<void> {
  const sheet = workbook.sheets.find((s) => s.name === table.source.sheet);
  const calculated = table.fields.filter((f) => f.calculated !== undefined);
  if (calculated.length === 0) return;
  // One pass over the stored rows for every calculated field of the table.
  // Bounded by planned rows + 1: a target holding more is a row-count-mismatch
  // (reported from count()), never unbounded work.
  let seen = 0;
  for await (const row of target.values(
    table.key,
    calculated.map((f) => f.key),
  )) {
    if (++seen > maxRows) break;
    budget.charge(1 + calculated.length);
    for (const field of calculated) {
      const column = field.cachedColumn;
      const actual = row.values[field.key];
      const shown =
        actual === null || actual === undefined
          ? null
          : typeof actual === 'object'
            ? JSON.stringify(actual)
            : typeof actual === 'bigint'
              ? String(actual)
              : (actual as string | number | boolean);
      const invalid = invalidCalculated(field, actual);
      if (invalid !== undefined) {
        sink.add({
          code: 'calculated-invalid',
          severity: 'error',
          table: table.key,
          field: field.key,
          row: row.sourceRow,
          actual: shown,
          message: `Row ${row.sourceRow}: "${field.key}" holds ${invalid}.`,
        });
        continue;
      }
      if (column === undefined || !sheet) continue;
      const cached = sheet.cells.get(row.sourceRow, column);
      if (cachedAgrees(field, cached, actual)) continue;
      sink.add({
        code: 'calculated-mismatch',
        severity: 'error',
        table: table.key,
        field: field.key,
        sheet: table.source.sheet,
        cell: address({ row: row.sourceRow, col: column }),
        row: row.sourceRow,
        expected: describeCell(cached),
        actual: shown,
        message: `Row ${row.sourceRow}: "${field.key}" is ${String(actual)} in the target; the workbook cached ${describeCell(cached)}.`,
      });
    }
  }
}
