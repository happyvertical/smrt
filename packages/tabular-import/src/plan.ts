import { range as parseA1Range } from '@happyvertical/spreadsheets';
import {
  type AggregateOperand,
  ExpressionError,
  renderExpression,
} from '@happyvertical/sql/query';
import { ImportPlanError, type ImportPlanErrorCode } from './errors.js';

export type ImportFieldType =
  | 'text'
  | 'number'
  | 'integer'
  | 'boolean'
  | 'date'
  | 'money'
  | 'choice'
  | 'reference';

export const IMPORT_FIELD_TYPES: readonly ImportFieldType[] = Object.freeze([
  'text',
  'number',
  'integer',
  'boolean',
  'date',
  'money',
  'choice',
  'reference',
]);

export type { AggregateOperand };

export interface PlanReference {
  /** Key of the referenced table. */
  table: string;
  /** Field keys of the referenced table; must equal its `lookupKey`. */
  by: string[];
  /** 1-based sheet columns whose values are matched, in `by` order. */
  columns: number[];
}

export interface PlanField {
  key: string;
  label: string;
  type: ImportFieldType;
  required?: boolean;
  /** 1-based sheet column the value comes from. */
  column?: number;
  /** SDK expression over sibling field keys; the field has no column. */
  calculated?: AggregateOperand;
  /** For calculated fields: the column holding the workbook's cached result. */
  cachedColumn?: number;
  reference?: PlanReference;
  choices?: string[];
  /** Stored as integer minor units: `value * 10^scale`. */
  money?: { currency: string; scale: number };
}

export interface PlanTable {
  key: string;
  label: string;
  source: {
    sheet: string;
    /** A1 range holding the header row and the data rows. */
    range: string;
    /** Absolute sheet row of the header. */
    headerRow: number;
    /** Absolute sheet rows to leave out (totals, notes). */
    skipRows?: number[];
    /** Rows are the distinct combinations of the mapped columns. */
    distinct?: boolean;
  };
  fields: PlanField[];
  /** Field keys that identify a row (reference target, re-import match). */
  lookupKey?: string[];
  titleField?: string;
}

/** Opaque to this package; passed to the target as given. */
export interface PlanReport {
  key: string;
  label: string;
  spec: unknown;
}

export interface ImportPlan {
  version: 1;
  tables: PlanTable[];
  reports?: PlanReport[];
}

export interface PlanLimits {
  maxTables: number;
  maxFieldsPerTable: number;
  maxPlanBytes: number;
  maxReports: number;
  maxChoices: number;
  maxSkipRows: number;
  maxExpressionNodes: number;
}

export const DEFAULT_PLAN_LIMITS: Readonly<PlanLimits> = Object.freeze({
  maxTables: 200,
  maxFieldsPerTable: 500,
  maxPlanBytes: 2 * 1024 * 1024,
  maxReports: 200,
  maxChoices: 1000,
  maxSkipRows: 100_000,
  maxExpressionNodes: 1024,
});

export const PLAN_KEY_PATTERN = /^[a-z][a-z0-9_]{0,62}$/;

/**
 * Keys that name something on every object. Refused so a key can never address
 * inherited state in a record built from a plan, whatever the target does with it.
 */
const RESERVED_KEYS: ReadonlySet<string> = new Set([
  ...Object.getOwnPropertyNames(Object.prototype),
  'prototype',
]);

const MAX_LABEL = 200;
const MAX_COLUMN = 16384;
const MAX_ROW = 1_048_576;

function fail(code: ImportPlanErrorCode, path: string, message: string): never {
  throw new ImportPlanError(code, path, message);
}

/** Copies the input through JSON so only own, plain data survives. */
function toPlainData(input: unknown, limits: PlanLimits): unknown {
  let text: string | undefined;
  try {
    text = JSON.stringify(input, (_key, value) => {
      const kind = typeof value;
      if (kind === 'function' || kind === 'symbol' || kind === 'bigint') {
        throw new TypeError(`a ${kind} is not plain data`);
      }
      if (typeof value === 'number' && !Number.isFinite(value)) {
        throw new TypeError('a non-finite number is not plain data');
      }
      return value;
    });
  } catch (error) {
    fail(
      'plan-not-data',
      '',
      `a plan must be plain JSON data (${error instanceof Error ? error.message : 'unserializable'})`,
    );
  }
  if (text === undefined) {
    fail('plan-not-data', '', 'a plan must be plain JSON data');
  }
  if (text.length > limits.maxPlanBytes) {
    fail(
      'plan-too-large',
      '',
      `plan is ${text.length} bytes; the limit is ${limits.maxPlanBytes}`,
    );
  }
  return JSON.parse(text);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function closedObject(
  value: unknown,
  path: string,
  allowed: readonly string[],
): Record<string, unknown> {
  if (!isRecord(value)) fail('invalid-shape', path, 'expected an object');
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      fail('unknown-key', `${path}.${key}`, `unknown key "${key}"`);
    }
  }
  return value;
}

function arrayOf(value: unknown, path: string, max: number): unknown[] {
  if (!Array.isArray(value)) fail('invalid-shape', path, 'expected an array');
  if (value.length > max) {
    fail('limit-exceeded', path, `at most ${max} entries; got ${value.length}`);
  }
  return value;
}

function planKey(value: unknown, path: string): string {
  if (typeof value !== 'string' || !PLAN_KEY_PATTERN.test(value)) {
    fail('invalid-key', path, 'a key matches ^[a-z][a-z0-9_]{0,62}$');
  }
  if (RESERVED_KEYS.has(value)) {
    fail('reserved-key', path, `"${value}" is a reserved key`);
  }
  return value;
}

function label(value: unknown, path: string): string {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    value.length > MAX_LABEL
  ) {
    fail('invalid-value', path, `a non-empty string of at most ${MAX_LABEL}`);
  }
  return value;
}

function positiveInt(value: unknown, path: string, max: number): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > max
  ) {
    fail('invalid-value', path, `an integer from 1 to ${max}`);
  }
  return value;
}

function optionalBoolean(value: unknown, path: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') fail('invalid-value', path, 'a boolean');
  return value;
}

function keyList(
  value: unknown,
  path: string,
  max: number,
): { keys: string[]; paths: string[] } {
  const list = arrayOf(value, path, max);
  if (list.length === 0) fail('invalid-value', path, 'at least one key');
  const seen = new Set<string>();
  const keys = list.map((item, index) => {
    const key = planKey(item, `${path}[${index}]`);
    if (seen.has(key)) fail('duplicate-key', `${path}[${index}]`, `"${key}"`);
    seen.add(key);
    return key;
  });
  return { keys, paths: list.map((_, index) => `${path}[${index}]`) };
}

const FIELD_KEYS = [
  'key',
  'label',
  'type',
  'required',
  'column',
  'calculated',
  'cachedColumn',
  'reference',
  'choices',
  'money',
] as const;

function validateField(
  value: unknown,
  path: string,
  limits: PlanLimits,
): PlanField {
  const raw = closedObject(value, path, FIELD_KEYS);
  const key = planKey(raw.key, `${path}.key`);
  const fieldLabel = label(raw.label, `${path}.label`);
  if (
    typeof raw.type !== 'string' ||
    !IMPORT_FIELD_TYPES.includes(raw.type as ImportFieldType)
  ) {
    fail(
      'invalid-value',
      `${path}.type`,
      `one of ${IMPORT_FIELD_TYPES.join(', ')}`,
    );
  }
  const type = raw.type as ImportFieldType;
  const field: PlanField = { key, label: fieldLabel, type };
  const required = optionalBoolean(raw.required, `${path}.required`);
  if (required !== undefined) field.required = required;

  const sources = (['column', 'calculated', 'reference'] as const).filter(
    (name) => raw[name] !== undefined,
  );
  if (sources.length !== 1) {
    fail(
      'field-source',
      path,
      `exactly one of column, calculated or reference is required; got ${sources.length}`,
    );
  }
  const source = sources[0];

  if (source === 'column') {
    field.column = positiveInt(raw.column, `${path}.column`, MAX_COLUMN);
  }
  if (source === 'calculated') {
    field.calculated = raw.calculated as AggregateOperand;
  }
  if (raw.cachedColumn !== undefined) {
    if (source !== 'calculated') {
      fail(
        'field-source',
        `${path}.cachedColumn`,
        'cachedColumn belongs to calculated fields',
      );
    }
    field.cachedColumn = positiveInt(
      raw.cachedColumn,
      `${path}.cachedColumn`,
      MAX_COLUMN,
    );
  }
  if (source === 'reference') {
    if (type !== 'reference') {
      fail(
        'field-source',
        `${path}.type`,
        'a reference field has type reference',
      );
    }
    const ref = closedObject(raw.reference, `${path}.reference`, [
      'table',
      'by',
      'columns',
    ]);
    const by = keyList(ref.by, `${path}.reference.by`, 16);
    const columnList = arrayOf(ref.columns, `${path}.reference.columns`, 16);
    if (columnList.length !== by.keys.length) {
      fail(
        'reference-mismatch',
        `${path}.reference.columns`,
        'columns must pair one-to-one with by',
      );
    }
    field.reference = {
      table: planKey(ref.table, `${path}.reference.table`),
      by: by.keys,
      columns: columnList.map((column, index) =>
        positiveInt(column, `${path}.reference.columns[${index}]`, MAX_COLUMN),
      ),
    };
  } else if (type === 'reference') {
    fail('field-source', `${path}.type`, 'type reference needs a reference');
  }

  if (type === 'choice') {
    if (raw.choices === undefined) {
      fail('invalid-value', `${path}.choices`, 'a choice field needs choices');
    }
    const list = arrayOf(raw.choices, `${path}.choices`, limits.maxChoices);
    if (list.length === 0) {
      fail('invalid-value', `${path}.choices`, 'a choice field needs choices');
    }
    const seen = new Set<string>();
    field.choices = list.map((item, index) => {
      if (
        typeof item !== 'string' ||
        item.length === 0 ||
        item.length > MAX_LABEL ||
        item !== item.trim()
      ) {
        fail(
          'invalid-value',
          `${path}.choices[${index}]`,
          'a trimmed, non-empty string',
        );
      }
      if (seen.has(item)) {
        fail('duplicate-key', `${path}.choices[${index}]`, `"${item}"`);
      }
      seen.add(item);
      return item;
    });
  } else if (raw.choices !== undefined) {
    fail('invalid-value', `${path}.choices`, 'choices belong to choice fields');
  }

  if (type === 'money') {
    const money = closedObject(raw.money, `${path}.money`, [
      'currency',
      'scale',
    ]);
    if (
      typeof money.currency !== 'string' ||
      !/^[A-Z]{3}$/.test(money.currency)
    ) {
      fail(
        'invalid-value',
        `${path}.money.currency`,
        'a three-letter upper-case currency code',
      );
    }
    if (
      typeof money.scale !== 'number' ||
      !Number.isInteger(money.scale) ||
      money.scale < 0 ||
      money.scale > 6
    ) {
      fail('invalid-value', `${path}.money.scale`, 'an integer from 0 to 6');
    }
    field.money = { currency: money.currency, scale: money.scale };
  } else if (raw.money !== undefined) {
    fail('invalid-value', `${path}.money`, 'money belongs to money fields');
  }
  return field;
}

const TABLE_KEYS = [
  'key',
  'label',
  'source',
  'fields',
  'lookupKey',
  'titleField',
] as const;
const SOURCE_KEYS = [
  'sheet',
  'range',
  'headerRow',
  'skipRows',
  'distinct',
] as const;

function validateTable(
  value: unknown,
  path: string,
  limits: PlanLimits,
): PlanTable {
  const raw = closedObject(value, path, TABLE_KEYS);
  const key = planKey(raw.key, `${path}.key`);
  const tableLabel = label(raw.label, `${path}.label`);

  const src = closedObject(raw.source, `${path}.source`, SOURCE_KEYS);
  if (
    typeof src.sheet !== 'string' ||
    src.sheet.length === 0 ||
    src.sheet.length > 255
  ) {
    fail('invalid-source', `${path}.source.sheet`, 'a sheet name');
  }
  if (typeof src.range !== 'string') {
    fail('invalid-source', `${path}.source.range`, 'an A1 range');
  }
  try {
    parseA1Range(src.range);
  } catch {
    fail('invalid-source', `${path}.source.range`, `"${src.range}" is not A1`);
  }
  const source: PlanTable['source'] = {
    sheet: src.sheet,
    range: src.range,
    headerRow: positiveInt(src.headerRow, `${path}.source.headerRow`, MAX_ROW),
  };
  if (src.skipRows !== undefined) {
    const rows = arrayOf(
      src.skipRows,
      `${path}.source.skipRows`,
      limits.maxSkipRows,
    );
    const seen = new Set<number>();
    source.skipRows = rows.map((row, index) => {
      const n = positiveInt(row, `${path}.source.skipRows[${index}]`, MAX_ROW);
      if (seen.has(n)) {
        fail('duplicate-key', `${path}.source.skipRows[${index}]`, `row ${n}`);
      }
      seen.add(n);
      return n;
    });
  }
  const distinct = optionalBoolean(src.distinct, `${path}.source.distinct`);
  if (distinct !== undefined) source.distinct = distinct;

  const fieldList = arrayOf(
    raw.fields,
    `${path}.fields`,
    limits.maxFieldsPerTable,
  );
  if (fieldList.length === 0) {
    fail('invalid-value', `${path}.fields`, 'a table needs at least one field');
  }
  const fields = fieldList.map((item, index) =>
    validateField(item, `${path}.fields[${index}]`, limits),
  );
  const byKey = new Map<string, PlanField>();
  fields.forEach((field, index) => {
    if (byKey.has(field.key)) {
      fail('duplicate-key', `${path}.fields[${index}].key`, `"${field.key}"`);
    }
    byKey.set(field.key, field);
  });

  const table: PlanTable = { key, label: tableLabel, source, fields };
  if (raw.lookupKey !== undefined) {
    const list = keyList(raw.lookupKey, `${path}.lookupKey`, 16);
    list.keys.forEach((fieldKey, index) => {
      const field = byKey.get(fieldKey);
      if (!field) {
        fail('unknown-field', list.paths[index], `no field "${fieldKey}"`);
      }
      if (field.column === undefined) {
        fail(
          'field-source',
          list.paths[index],
          'a lookup key field takes its value from a column',
        );
      }
    });
    table.lookupKey = list.keys;
  }
  if (raw.titleField !== undefined) {
    const title = planKey(raw.titleField, `${path}.titleField`);
    if (!byKey.has(title)) {
      fail('unknown-field', `${path}.titleField`, `no field "${title}"`);
    }
    table.titleField = title;
  }
  return table;
}

function expressionColumns(
  root: unknown,
  path: string,
  limits: PlanLimits,
): string[] {
  const found = new Set<string>();
  const stack: unknown[] = [root];
  let nodes = 0;
  while (stack.length > 0) {
    const node = stack.pop();
    if (Array.isArray(node)) {
      for (const item of node) stack.push(item);
      continue;
    }
    if (!isRecord(node)) continue;
    if (++nodes > limits.maxExpressionNodes) {
      fail(
        'invalid-expression',
        path,
        `more than ${limits.maxExpressionNodes} nodes`,
      );
    }
    if (Object.hasOwn(node, 'col')) {
      if (Object.keys(node).length !== 1 || typeof node.col !== 'string') {
        fail('invalid-expression', path, 'a column node is { col: string }');
      }
      found.add(node.col);
      continue;
    }
    for (const item of Object.values(node)) stack.push(item);
  }
  return [...found];
}

const EXPRESSION_COLUMN_TYPE: Record<
  ImportFieldType,
  'number' | 'text' | 'boolean' | 'date' | 'unknown'
> = {
  text: 'text',
  choice: 'text',
  number: 'number',
  integer: 'number',
  money: 'number',
  boolean: 'boolean',
  date: 'date',
  reference: 'unknown',
};

/** The result type an expression must have to be stored in a field of this type. */
const EXPECTED_RESULT: Record<ImportFieldType, readonly string[]> = {
  text: ['text'],
  choice: ['text'],
  number: ['number'],
  integer: ['number'],
  money: ['number'],
  boolean: ['boolean'],
  date: ['date'],
  reference: [],
};

function validateCalculated(
  table: PlanTable,
  tablePath: string,
  limits: PlanLimits,
): void {
  const siblings = new Map(table.fields.map((field) => [field.key, field]));
  table.fields.forEach((field, index) => {
    if (field.calculated === undefined) return;
    const path = `${tablePath}.fields[${index}].calculated`;
    if (field.type === 'reference') {
      fail('field-source', path, 'a calculated field cannot be a reference');
    }
    for (const column of expressionColumns(field.calculated, path, limits)) {
      const sibling = siblings.get(column);
      if (!sibling) {
        fail(
          'expression-column',
          path,
          `"${column}" is not a field of this table`,
        );
      }
      if (sibling.column === undefined) {
        fail(
          'expression-column',
          path,
          `"${column}" is not a column field; a calculated field reads column fields only`,
        );
      }
    }
    try {
      const rendered = renderExpression(field.calculated, {
        dialect: 'sqlite',
        mode: 'ddl',
        resolveColumn: (name) => {
          const sibling = siblings.get(name);
          return {
            name,
            type: sibling ? EXPRESSION_COLUMN_TYPE[sibling.type] : 'unknown',
          };
        },
      });
      const result = rendered.resultType as string;
      if (
        result !== 'unknown' &&
        result !== 'null' &&
        !EXPECTED_RESULT[field.type].includes(result)
      ) {
        fail(
          'expression-type',
          path,
          `expression yields ${result}, but the field is ${field.type}`,
        );
      }
    } catch (error) {
      if (error instanceof ImportPlanError) throw error;
      if (error instanceof ExpressionError) {
        fail('invalid-expression', path, `${error.code}: ${error.message}`);
      }
      fail(
        'invalid-expression',
        path,
        error instanceof Error ? error.message : String(error),
      );
    }
  });
}

function validateReferences(plan: ImportPlan): void {
  const tables = new Map(plan.tables.map((table) => [table.key, table]));
  const edges = new Map<string, Set<string>>();
  plan.tables.forEach((table, tableIndex) => {
    const out = new Set<string>();
    edges.set(table.key, out);
    table.fields.forEach((field, fieldIndex) => {
      if (!field.reference) return;
      const path = `tables[${tableIndex}].fields[${fieldIndex}].reference`;
      const target = tables.get(field.reference.table);
      if (!target) {
        fail(
          'unknown-table',
          `${path}.table`,
          `no table "${field.reference.table}"`,
        );
      }
      const lookup = target.lookupKey;
      if (
        !lookup ||
        lookup.length !== field.reference.by.length ||
        lookup.some((key, i) => key !== field.reference?.by[i])
      ) {
        fail(
          'reference-mismatch',
          `${path}.by`,
          `must equal the lookupKey of "${target.key}"`,
        );
      }
      out.add(target.key);
    });
  });
  const state = new Map<string, 1 | 2>();
  const visit = (key: string, trail: string[]): void => {
    if (state.get(key) === 2) return;
    if (state.get(key) === 1) {
      const loop = [...trail.slice(trail.indexOf(key)), key].join(' -> ');
      fail('reference-cycle', 'tables', `references form a cycle: ${loop}`);
    }
    state.set(key, 1);
    for (const next of edges.get(key) ?? []) visit(next, [...trail, key]);
    state.set(key, 2);
  };
  for (const table of plan.tables) visit(table.key, []);
}

/**
 * Validates a plan and returns a clean copy. Throws {@link ImportPlanError}.
 * A plan is data: it names no function, path or SQL string, and an unknown key
 * anywhere refuses the whole plan.
 */
export function validatePlan(
  input: unknown,
  overrides: Partial<PlanLimits> = {},
): ImportPlan {
  const limits: PlanLimits = { ...DEFAULT_PLAN_LIMITS, ...overrides };
  const data = toPlainData(input, limits);
  const raw = closedObject(data, '', ['version', 'tables', 'reports']);
  if (raw.version !== 1) {
    fail('unsupported-version', 'version', 'this package reads plan version 1');
  }
  const tableList = arrayOf(raw.tables, 'tables', limits.maxTables);
  if (tableList.length === 0) {
    fail('invalid-value', 'tables', 'a plan needs at least one table');
  }
  const tables = tableList.map((item, index) =>
    validateTable(item, `tables[${index}]`, limits),
  );
  const seen = new Set<string>();
  tables.forEach((table, index) => {
    if (seen.has(table.key)) {
      fail('duplicate-key', `tables[${index}].key`, `"${table.key}"`);
    }
    seen.add(table.key);
  });
  const plan: ImportPlan = { version: 1, tables };

  if (raw.reports !== undefined) {
    const list = arrayOf(raw.reports, 'reports', limits.maxReports);
    const keys = new Set<string>();
    plan.reports = list.map((item, index) => {
      const path = `reports[${index}]`;
      const report = closedObject(item, path, ['key', 'label', 'spec']);
      const key = planKey(report.key, `${path}.key`);
      if (keys.has(key)) fail('duplicate-key', `${path}.key`, `"${key}"`);
      keys.add(key);
      return {
        key,
        label: label(report.label, `${path}.label`),
        spec: report.spec,
      };
    });
  }

  validateReferences(plan);
  for (const [index, table] of tables.entries()) {
    validateCalculated(table, `tables[${index}]`, limits);
  }
  return plan;
}

/** Table keys with referenced tables before the tables that reference them. */
export function loadOrder(plan: ImportPlan): string[] {
  const order: string[] = [];
  const done = new Set<string>();
  const tables = new Map(plan.tables.map((table) => [table.key, table]));
  const visit = (key: string): void => {
    if (done.has(key)) return;
    done.add(key);
    const table = tables.get(key);
    if (!table) return;
    for (const field of table.fields) {
      if (field.reference) visit(field.reference.table);
    }
    order.push(key);
  };
  for (const table of plan.tables) visit(table.key);
  return order;
}
