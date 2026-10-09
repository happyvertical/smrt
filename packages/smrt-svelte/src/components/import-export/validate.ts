import { restoreNeutralized } from './csv.js';
import type {
  ColumnMapping,
  ImportExportField,
  ImportIssue,
  ImportIssueCode,
  ValidationResult,
  ValidRecord,
} from './types.js';

const MAX_ECHOED_VALUE = 200;

const TRUE_WORDS = new Set(['true', 't', 'yes', 'y', '1', 'on']);
const FALSE_WORDS = new Set(['false', 'f', 'no', 'n', '0', 'off']);

const INTEGER = /^[+-]?\d+$/;
const DECIMAL = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATETIME =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

export type CoerceResult =
  | { ok: true; value: unknown }
  | { ok: false; code: ImportIssueCode; detail?: string };

function parseDatetime(raw: string): string | null {
  const m = DATETIME.exec(raw);
  if (!m) return null;
  const [, y, mo, d, h = '00', mi = '00', s = '00', frac = '0', zone] = m;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day ||
    Number(h) > 23 ||
    Number(mi) > 59 ||
    Number(s) > 59
  ) {
    return null;
  }
  const millis = frac.slice(0, 3).padEnd(3, '0');
  let offset = 'Z';
  if (zone && zone !== 'Z') {
    offset = zone.includes(':') ? zone : `${zone.slice(0, 3)}:${zone.slice(3)}`;
  }
  const iso = `${y}-${mo}-${d}T${h}:${mi}:${s}.${millis}${offset}`;
  const time = Date.parse(iso);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

/**
 * Coerce one non-empty, trimmed cell to the field's type. Empty-cell handling
 * (required, defaults) belongs to the caller.
 *
 * Datetimes are strict ISO 8601 (`2026-03-05`, `2026-03-05T09:30`,
 * `2026-03-05T09:30:00-05:00`); a missing offset means UTC. Locale formats
 * such as `3/5/2026` are rejected rather than guessed.
 */
export function coerceCell(
  raw: string,
  field: ImportExportField,
): CoerceResult {
  switch (field.type) {
    case 'integer': {
      if (!INTEGER.test(raw)) return { ok: false, code: 'invalid-integer' };
      const n = Number(raw);
      if (!Number.isSafeInteger(n)) return { ok: false, code: 'out-of-range' };
      return { ok: true, value: n };
    }
    case 'decimal': {
      if (!DECIMAL.test(raw)) return { ok: false, code: 'invalid-decimal' };
      const n = Number(raw);
      if (!Number.isFinite(n)) return { ok: false, code: 'out-of-range' };
      return { ok: true, value: n };
    }
    case 'boolean': {
      const word = raw.toLowerCase();
      if (TRUE_WORDS.has(word)) return { ok: true, value: true };
      if (FALSE_WORDS.has(word)) return { ok: true, value: false };
      return { ok: false, code: 'invalid-boolean' };
    }
    case 'datetime': {
      const iso = parseDatetime(raw);
      return iso === null
        ? { ok: false, code: 'invalid-datetime' }
        : { ok: true, value: iso };
    }
    case 'json': {
      try {
        return { ok: true, value: JSON.parse(raw) as unknown };
      } catch {
        return { ok: false, code: 'invalid-json' };
      }
    }
    case 'enum': {
      const options = field.options ?? [];
      const hit = options.find((o) => o.toLowerCase() === raw.toLowerCase());
      return hit === undefined
        ? { ok: false, code: 'invalid-enum', detail: options.join(', ') }
        : { ok: true, value: hit };
    }
    case 'reference':
      return /\s/.test(raw)
        ? { ok: false, code: 'invalid-reference' }
        : { ok: true, value: raw };
    default: {
      const text = restoreNeutralized(raw);
      if (field.widget === 'email' && !EMAIL.test(text)) {
        return { ok: false, code: 'invalid-email' };
      }
      if (field.widget === 'url') {
        try {
          const url = new URL(text);
          if (url.protocol !== 'http:' && url.protocol !== 'https:') {
            return { ok: false, code: 'invalid-url' };
          }
        } catch {
          return { ok: false, code: 'invalid-url' };
        }
      }
      return { ok: true, value: text };
    }
  }
}

/** Mapping-level problems: two columns on one field, or a required field with no source. */
export function validateMapping(
  headers: readonly string[],
  mapping: ColumnMapping,
  fields: readonly ImportExportField[],
): ImportIssue[] {
  const issues: ImportIssue[] = [];
  const seen = new Map<string, number>();
  mapping.forEach((target, index) => {
    if (target === null) return;
    if (seen.has(target)) {
      issues.push({
        code: 'duplicate-mapping',
        line: 0,
        field: target,
        column: headers[index],
      });
    }
    seen.set(target, index);
  });
  for (const field of fields) {
    if (
      field.required &&
      field.importable &&
      !field.hasDefault &&
      !seen.has(field.name)
    ) {
      issues.push({ code: 'unmapped-required', line: 0, field: field.name });
    }
  }
  return issues;
}

export interface ValidateRowsInput {
  headers: readonly string[];
  /** Data rows (header excluded). */
  rows: ReadonlyArray<ReadonlyArray<string>>;
  /** 1-based file line of each row. Defaults to row index + 2. */
  lines?: readonly number[];
  mapping: ColumnMapping;
  fields: readonly ImportExportField[];
  /** Stop collecting row issues past this many (counts keep running). */
  maxIssues?: number;
}

function echo(value: string): string {
  return value.length > MAX_ECHOED_VALUE
    ? `${value.slice(0, MAX_ECHOED_VALUE)}…`
    : value;
}

/**
 * Validate and coerce every row against the mapped fields. Pure: this is the
 * dry run, nothing is written. A row with any issue is excluded from
 * `records`; `invalidRows` counts it once however many issues it has. While
 * `mappingIssues` is non-empty `records` is empty.
 */
export function validateRows(input: ValidateRowsInput): ValidationResult {
  const { headers, rows, mapping, fields } = input;
  const maxIssues = input.maxIssues ?? 1000;
  const byName = new Map(fields.map((f) => [f.name, f]));
  const mappingIssues = validateMapping(headers, mapping, fields);
  const blocked = new Set(
    mappingIssues
      .filter((i) => i.code === 'duplicate-mapping')
      .map((i) => i.field),
  );

  const columns: Array<{ index: number; field: ImportExportField }> = [];
  mapping.forEach((target, index) => {
    const field = target === null ? undefined : byName.get(target);
    if (field?.importable && !blocked.has(field.name)) {
      columns.push({ index, field });
    }
  });
  const mappedNames = new Set(columns.map((c) => c.field.name));

  const records: ValidRecord[] = [];
  const issues: ImportIssue[] = [];
  let issuesTruncated = false;
  let invalidRows = 0;
  const unique = new Map<string, Set<string>>();
  for (const field of fields)
    if (field.unique) unique.set(field.name, new Set());

  rows.forEach((row, index) => {
    const line = input.lines?.[index] ?? index + 2;
    const rowIssues: ImportIssue[] = [];
    const values: Record<string, unknown> = {};
    const pendingUnique: Array<[Set<string>, string]> = [];

    if (row.length > headers.length) {
      rowIssues.push({
        code: 'extra-cells',
        line,
        detail: `${row.length} cells, ${headers.length} columns`,
      });
    }

    for (const { index: col, field } of columns) {
      const raw = (row[col] ?? '').trim();
      if (raw === '') continue;
      const result = coerceCell(raw, field);
      if (!result.ok) {
        rowIssues.push({
          code: result.code,
          line,
          field: field.name,
          column: headers[col],
          value: echo(raw),
          detail: result.detail,
        });
        continue;
      }
      if (field.unique) {
        const key = JSON.stringify(result.value);
        const set = unique.get(field.name);
        if (set?.has(key)) {
          rowIssues.push({
            code: 'duplicate-value',
            line,
            field: field.name,
            column: headers[col],
            value: echo(raw),
          });
          continue;
        }
        if (set) pendingUnique.push([set, key]);
      }
      values[field.name] = result.value;
    }

    for (const field of fields) {
      if (!(field.name in values) && field.hasDefault) {
        values[field.name] = field.defaultValue;
      }
      if (field.required && field.importable && !(field.name in values)) {
        const mappedColumn = columns.find((c) => c.field.name === field.name);
        // An unmapped required field is a mapping issue, reported once.
        if (mappedNames.has(field.name)) {
          rowIssues.push({
            code: 'required',
            line,
            field: field.name,
            column: mappedColumn ? headers[mappedColumn.index] : undefined,
          });
        }
      }
    }

    if (rowIssues.length > 0) {
      invalidRows++;
      for (const issue of rowIssues) {
        if (issues.length < maxIssues) issues.push(issue);
        else issuesTruncated = true;
      }
    } else {
      for (const [set, key] of pendingUnique) set.add(key);
      records.push({ index, line, values });
    }
  });

  return {
    totalRows: rows.length,
    // Nothing is importable until the mapping itself is sound: an unmapped
    // required field would otherwise be written without its value.
    records: mappingIssues.length > 0 ? [] : records,
    issues,
    issuesTruncated,
    mappingIssues,
    invalidRows,
  };
}
