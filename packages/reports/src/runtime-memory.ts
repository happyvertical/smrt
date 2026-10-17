/**
 * Database-free runtime report runner (#4100).
 *
 * `runRuntimeReportInMemory()` evaluates a parsed `RuntimeReportSpec` over
 * rows the caller already holds and returns the same `RuntimeReportResult`
 * shape `runRuntimeReport()` returns. It shares the column, operator, value
 * coercion and cell rules with the SQL compiler (`runtime-plan.ts`), and its
 * SQL-shaped semantics (NULL handling, grouping, buckets, HAVING, ordering,
 * truncation) are held to the SQL path by `runtime-memory-parity.test.ts`.
 *
 * It is a BROWSER PREVIEW AND TEST RUNNER, NOT AN AUTHORITY BOUNDARY. Its
 * source descriptions are caller-supplied and carry no registry field policy,
 * principal, RBAC or tenant: whoever hands it rows has already decided the
 * caller may see them. Production reports still compile on the server
 * (`compileRuntimeReportSpec()` with the live principal) and save only through
 * `saveRuntimeReport()`.
 */

import {
  assertRuntimeReportFilterOperator,
  coerceRuntimeReportValue,
  describeRuntimeReportFields,
  humanizeRuntimeReportName,
  normalizeRuntimeReportCell,
  planRuntimeReportColumns,
  type RuntimeReportColumn,
  type RuntimeReportColumnType,
  type RuntimeReportPlanField,
  type RuntimeReportResult,
  type RuntimeReportSourceDescription,
  resolveRuntimeReportFieldPolicy,
  unknownRuntimeReportField,
} from './runtime-plan.js';
import {
  parseRuntimeReportSpec,
  RUNTIME_REPORT_LIMITS,
  type RuntimeReportBucket,
  RuntimeReportError,
  type RuntimeReportFilter,
  type RuntimeReportHaving,
  type RuntimeReportSpec,
  runtimeReportSpecDigest,
} from './runtime-spec.js';

/** One declared field of an in-memory source; rows are keyed by `name`. */
export interface RuntimeReportMemoryField {
  name: string;
  type: RuntimeReportColumnType;
  label?: string;
  /** Format hint carried onto result columns (for example `money`). */
  format?: string;
}

/**
 * An in-memory report source: the browser counterpart of a server
 * `RuntimeReportSourceDefinition`. `schema` declares the fields the rows
 * carry; `fields` / `excludeFields` narrow them exactly as on the server
 * (omitted `fields` keeps every declared field, exclusions win, unknown names
 * reject the source). Names starting with `_` and `tenantId` are never
 * nameable. A declared `deletedAt` field soft-deletes rows where it is set.
 */
export interface RuntimeReportMemorySource {
  id: string;
  label?: string;
  description?: string;
  schema: readonly RuntimeReportMemoryField[];
  fields?: readonly string[];
  excludeFields?: readonly string[];
}

export type RuntimeReportMemoryRow = Readonly<Record<string, unknown>>;

export interface RunRuntimeReportInMemoryOptions {
  /** Caller-owned allow-list; the spec reaches nothing outside it. */
  sources: readonly RuntimeReportMemorySource[];
  /** Host row ceiling applied on top of the spec's own limit. */
  maxRows?: number;
  /** Clock for `ranAt`; pass a fixed one for deterministic previews. */
  now?: () => Date;
}

const NON_NAMEABLE = new Set(['tenantId', 'tenant_id']);

function resolveMemorySource(
  sources: readonly RuntimeReportMemorySource[],
  id: string,
): RuntimeReportMemorySource {
  const source = sources.find((candidate) => candidate.id === id);
  if (!source) {
    throw new RuntimeReportError(
      'unknown_source',
      'spec.source',
      `'${id}' is not an available report source`,
    );
  }
  return source;
}

function memoryFields(
  source: RuntimeReportMemorySource,
): Map<string, RuntimeReportPlanField> {
  const known = new Set(source.schema.map((field) => field.name));
  const { included, excluded } = resolveRuntimeReportFieldPolicy(source, known);
  const fields = new Map<string, RuntimeReportPlanField>();
  for (const field of source.schema) {
    if (
      field.name.startsWith('_') ||
      NON_NAMEABLE.has(field.name) ||
      excluded?.has(field.name) ||
      (included && !included.has(field.name)) ||
      fields.has(field.name)
    ) {
      continue;
    }
    fields.set(field.name, {
      name: field.name,
      type: field.type,
      ...(field.format ? { format: field.format } : {}),
      label: field.label ?? humanizeRuntimeReportName(field.name),
    });
  }
  return fields;
}

/**
 * Describe what a spec may reference on an in-memory source: the browser
 * counterpart of `describeRuntimeReportSource()` (`reports.runtime.sources`).
 */
export function describeRuntimeReportMemorySource(
  sources: readonly RuntimeReportMemorySource[],
  sourceId: string,
): RuntimeReportSourceDescription {
  const source = resolveMemorySource(sources, sourceId);
  return {
    id: source.id,
    label: source.label ?? humanizeRuntimeReportName(source.id),
    ...(source.description ? { description: source.description } : {}),
    fields: describeRuntimeReportFields(memoryFields(source).values()),
  };
}

// ---------------------------------------------------------------------------
// Values. Rows are untrusted-shape data, so every read is typed defensively.

type Cell = string | number | boolean | Date | null;

function toDate(value: unknown): Date | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value === 'string' || typeof value === 'number') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

/** Read a row value as the field's type; null when absent or unreadable. */
function readCell(
  row: RuntimeReportMemoryRow,
  field: RuntimeReportPlanField,
): Cell {
  const value = row[field.name];
  if (value === null || value === undefined) return null;
  switch (field.type) {
    case 'integer':
    case 'decimal': {
      if (typeof value === 'bigint') {
        // Past the safe range two integers become one Number, silently
        // merging groups and distinct counts; refuse rather than mis-count.
        if (
          value > BigInt(Number.MAX_SAFE_INTEGER) ||
          value < BigInt(Number.MIN_SAFE_INTEGER)
        ) {
          throw new RuntimeReportError(
            'invalid_result',
            field.name,
            'integer value exceeds the JavaScript safe range',
          );
        }
        return Number(value);
      }
      const numeric =
        typeof value === 'number'
          ? value
          : typeof value === 'string' && value.trim() !== ''
            ? Number(value)
            : Number.NaN;
      return Number.isFinite(numeric) ? numeric : null;
    }
    case 'boolean':
      if (value === true || value === 1 || value === '1' || value === 'true')
        return true;
      if (value === false || value === 0 || value === '0' || value === 'false')
        return false;
      return null;
    case 'datetime':
      return toDate(value);
    default:
      return typeof value === 'string' ? value : String(value);
  }
}

/**
 * SQL-style comparison of two non-null cells of one type. Strings compare by
 * UTF-16 code unit, which matches SQLite's BINARY collation for the BMP.
 */
function compareCells(a: Exclude<Cell, null>, b: Exclude<Cell, null>): number {
  const left = a instanceof Date ? a.getTime() : a;
  const right = b instanceof Date ? b.getTime() : b;
  if (typeof left === 'boolean' || typeof right === 'boolean') {
    return Number(left) - Number(right);
  }
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

type Predicate = (row: RuntimeReportMemoryRow) => boolean;

function filterPredicate(
  filter: RuntimeReportFilter,
  field: RuntimeReportPlanField,
  path: string,
): Predicate {
  assertRuntimeReportFilterOperator(filter, field.type, path);
  const read = (row: RuntimeReportMemoryRow) => readCell(row, field);
  switch (filter.op) {
    case 'isNull':
      return (row) => read(row) === null;
    case 'isNotNull':
      return (row) => read(row) !== null;
    case 'in':
    case 'notIn': {
      const values = (filter.value as unknown[]).map((entry, index) =>
        coerceRuntimeReportValue(field.type, entry, `${path}.value[${index}]`),
      );
      const member = (cell: Exclude<Cell, null>) =>
        values.some((value) => compareCells(cell, value) === 0);
      // SQL: NULL IN (...) and NULL NOT IN (...) are both unknown, so false.
      return filter.op === 'in'
        ? (row) => {
            const cell = read(row);
            return cell !== null && member(cell);
          }
        : (row) => {
            const cell = read(row);
            return cell !== null && !member(cell);
          };
    }
    case 'contains': {
      const needle = coerceRuntimeReportValue(
        field.type,
        filter.value,
        `${path}.value`,
      ) as string;
      // Case-sensitive substring, as the SQL builder's instr()/strpos().
      return (row) => {
        const cell = read(row);
        return typeof cell === 'string' && cell.includes(needle);
      };
    }
    default: {
      const target = coerceRuntimeReportValue(
        field.type,
        filter.value,
        `${path}.value`,
      );
      const test = {
        eq: (order: number) => order === 0,
        ne: (order: number) => order !== 0,
        gt: (order: number) => order > 0,
        gte: (order: number) => order >= 0,
        lt: (order: number) => order < 0,
        lte: (order: number) => order <= 0,
      }[filter.op];
      // Any comparison with NULL is unknown in SQL, so the row is excluded.
      return (row) => {
        const cell = read(row);
        return cell !== null && test(compareCells(cell, target));
      };
    }
  }
}

/** UTC start of the bucket containing `date`, as the SQL builder truncates. */
function bucketStart(date: Date, bucket: RuntimeReportBucket): Date {
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth();
  const d = date.getUTCDate();
  switch (bucket) {
    case 'minute':
      return new Date(
        Date.UTC(y, m, d, date.getUTCHours(), date.getUTCMinutes()),
      );
    case 'hour':
      return new Date(Date.UTC(y, m, d, date.getUTCHours()));
    case 'day':
      return new Date(Date.UTC(y, m, d));
    case 'week': {
      // Weeks start on Monday (ISO), like date_trunc('week') and the SQLite expr.
      const daysSinceMonday = (date.getUTCDay() + 6) % 7;
      return new Date(Date.UTC(y, m, d - daysSinceMonday));
    }
    case 'month':
      return new Date(Date.UTC(y, m, 1));
    case 'quarter':
      return new Date(Date.UTC(y, Math.floor(m / 3) * 3, 1));
    case 'year':
      return new Date(Date.UTC(y, 0, 1));
  }
}

function cellKey(cell: Cell): string {
  if (cell === null) return 'n';
  if (cell instanceof Date) return `d${cell.getTime()}`;
  return `${typeof cell}:${String(cell)}`;
}

function aggregate(fn: string, cells: Cell[] | null, rowCount: number): Cell {
  if (cells === null) return rowCount; // count(*)
  const present = cells.filter(
    (cell): cell is Exclude<Cell, null> => cell !== null,
  );
  switch (fn) {
    case 'count':
      return present.length;
    case 'countDistinct':
      return new Set(present.map(cellKey)).size;
    case 'sum': {
      if (present.length === 0) return null;
      return (present as number[]).reduce((total, value) => total + value, 0);
    }
    case 'avg': {
      if (present.length === 0) return null;
      const total = (present as number[]).reduce(
        (sum, value) => sum + value,
        0,
      );
      return total / present.length;
    }
    case 'min':
    case 'max': {
      if (present.length === 0) return null;
      let best = present[0];
      for (const cell of present.slice(1)) {
        const order = compareCells(cell, best);
        if (fn === 'min' ? order < 0 : order > 0) best = cell;
      }
      return best;
    }
    default:
      return null;
  }
}

function havingHolds(entry: RuntimeReportHaving, value: Cell): boolean {
  if (typeof value !== 'number') return false; // NULL compares unknown
  switch (entry.op) {
    case 'eq':
      return value === entry.value;
    case 'ne':
      return value !== entry.value;
    case 'gt':
      return value > entry.value;
    case 'gte':
      return value >= entry.value;
    case 'lt':
      return value < entry.value;
    case 'lte':
      return value <= entry.value;
  }
}

/** NULLs sort first ascending and last descending, as SQLite orders them. */
function compareForSort(a: Cell, b: Cell, direction: 'asc' | 'desc'): number {
  let order: number;
  if (a === null && b === null) order = 0;
  else if (a === null) order = -1;
  else if (b === null) order = 1;
  else order = compareCells(a, b);
  return direction === 'desc' ? -order : order;
}

/**
 * Evaluate a runtime report spec over in-memory rows of its source.
 *
 * Validation matches the server compiler: an unknown source, a field outside
 * the source's allow-list, a bucket on a non-datetime field, `sum` on text, an
 * operator the field type does not admit or an uncoercible filter value all
 * throw the same `RuntimeReportError` codes and paths. Result datetimes
 * (buckets, datetime dimensions, `min`/`max`) are ISO-8601 UTC strings, the
 * form PostgreSQL and DuckDB results take; SQLite returns bucket TEXT.
 *
 * `rows` are the rows of `spec.source`; the caller picks them. A browser
 * preview, never an authority boundary (see the module comment).
 */
export async function runRuntimeReportInMemory(
  input: RuntimeReportSpec,
  rows: readonly RuntimeReportMemoryRow[],
  options: RunRuntimeReportInMemoryOptions,
): Promise<RuntimeReportResult> {
  const spec = parseRuntimeReportSpec(input);
  const source = resolveMemorySource(options.sources, spec.source);
  const fields = memoryFields(source);
  const columns = planRuntimeReportColumns(spec, fields);
  const lookup = (name: string, path: string): RuntimeReportPlanField => {
    const field = fields.get(name);
    if (!field) unknownRuntimeReportField(path, name);
    return field;
  };

  const predicates: Predicate[] = [];
  if (source.schema.some((field) => field.name === 'deletedAt')) {
    predicates.push(
      (row) => row.deletedAt === null || row.deletedAt === undefined,
    );
  }
  for (const [index, filter] of spec.filters.entries()) {
    const path = `spec.filters[${index}]`;
    predicates.push(
      filterPredicate(filter, lookup(filter.field, `${path}.field`), path),
    );
  }
  const kept = rows.filter((row) => predicates.every((test) => test(row)));

  // Group by the dimension tuple, in first-seen order.
  const dimensionReaders = spec.dimensions.map((dimension) => {
    const field = fields.get(dimension.field) as RuntimeReportPlanField;
    return (row: RuntimeReportMemoryRow): Cell => {
      const cell = readCell(row, field);
      if (dimension.bucket && cell instanceof Date) {
        return bucketStart(cell, dimension.bucket);
      }
      return cell;
    };
  });
  const groups = new Map<
    string,
    { key: Cell[]; rows: RuntimeReportMemoryRow[] }
  >();
  if (spec.dimensions.length === 0) {
    // An aggregate with no GROUP BY always yields exactly one row.
    groups.set('', { key: [], rows: kept });
  } else {
    for (const row of kept) {
      const key = dimensionReaders.map((read) => read(row));
      // A JSON array keeps tuple boundaries: a '|' inside a value cannot
      // merge two groups.
      const id = JSON.stringify(key.map(cellKey));
      const group = groups.get(id);
      if (group) group.rows.push(row);
      else groups.set(id, { key, rows: [row] });
    }
  }

  const measureFields = spec.measures.map((measure) =>
    measure.field
      ? (fields.get(measure.field) as RuntimeReportPlanField)
      : null,
  );
  let results = [...groups.values()].map((group) => {
    const values: Record<string, Cell> = {};
    spec.dimensions.forEach((dimension, index) => {
      values[dimension.as] = group.key[index];
    });
    spec.measures.forEach((measure, index) => {
      const field = measureFields[index];
      values[measure.as] = aggregate(
        measure.fn,
        field ? group.rows.map((row) => readCell(row, field)) : null,
        group.rows.length,
      );
    });
    return values;
  });

  if (spec.having.length > 0) {
    results = results.filter((values) =>
      spec.having.every((entry) => havingHolds(entry, values[entry.measure])),
    );
  }

  const sort =
    spec.sort.length > 0
      ? spec.sort
      : spec.dimensions.length > 0
        ? [{ by: spec.dimensions[0].as, direction: 'asc' as const }]
        : [];
  if (sort.length > 0) {
    results = results
      .map((values, index) => ({ values, index }))
      .sort((left, right) => {
        for (const entry of sort) {
          const order = compareForSort(
            left.values[entry.by],
            right.values[entry.by],
            entry.direction,
          );
          if (order !== 0) return order;
        }
        return left.index - right.index;
      })
      .map(({ values }) => values);
  }

  const limit = Math.min(
    spec.limit,
    options.maxRows ?? RUNTIME_REPORT_LIMITS.maxRowLimit,
  );
  const truncated = results.length > limit;
  const outRows = results.slice(0, limit).map((values) => {
    const out: Record<string, string | number | boolean | null> = {};
    for (const column of columns as RuntimeReportColumn[]) {
      out[column.id] = normalizeRuntimeReportCell(column, values[column.id]);
    }
    return out;
  });

  return {
    version: 1,
    specHash: await runtimeReportSpecDigest(spec),
    title: spec.title,
    columns,
    rows: outRows,
    rowCount: outRows.length,
    truncated,
    ranAt: (options.now?.() ?? new Date()).toISOString(),
    chart: spec.chart,
  };
}
