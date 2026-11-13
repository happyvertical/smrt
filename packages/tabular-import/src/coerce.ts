import type { Cell } from '@happyvertical/spreadsheets';
import type { PlanField } from './plan.js';

export type CoerceFailureCode =
  | 'cell-error'
  | 'not-number'
  | 'not-integer'
  | 'unsafe-integer'
  | 'unsafe-number'
  | 'not-boolean'
  | 'not-date'
  | 'not-money'
  | 'not-choice'
  | 'not-coercible';

export type CoerceResult =
  | { ok: true; value: string | number | boolean | null }
  | { ok: false; code: CoerceFailureCode; detail: string };

const EMPTY: Cell = { value: null, type: 'empty' };
const DECIMAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;
const ISO_DATE =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

/** The shortest decimal that round-trips, never in exponent form. */
export function plainDecimal(value: number): string {
  const text = String(value);
  const match = /^(-?)(\d+)(?:\.(\d+))?e([+-]\d+)$/.exec(text);
  if (!match) return text;
  const [, sign, whole, fraction = '', exp] = match;
  const digits = whole + fraction;
  const point = whole.length + Number(exp);
  if (point <= 0) return `${sign}0.${'0'.repeat(-point)}${digits}`;
  if (point >= digits.length)
    return sign + digits + '0'.repeat(point - digits.length);
  return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
}

function failure(code: CoerceFailureCode, detail: string): CoerceResult {
  return { ok: false, code, detail };
}

export function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** A short, bounded rendering of a cell for findings. */
export function describeCell(cell: Cell | undefined): string {
  if (!cell || cell.type === 'empty' || cell.value === null) {
    return cell?.type === 'error' ? (cell.error ?? '#VALUE!') : '';
  }
  const value = cell.value;
  const text =
    value instanceof Date
      ? value.toISOString()
      : typeof value === 'number'
        ? (cell.originalText ?? plainDecimal(value))
        : String(value);
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}

export function isBlankCell(cell: Cell | undefined, trim = true): boolean {
  if (!cell || cell.type === 'empty' || cell.value === null) {
    return cell?.type !== 'error';
  }
  if (cell.type === 'error') return false;
  if (typeof cell.value === 'string') {
    return trim ? cell.value.trim().length === 0 : cell.value.length === 0;
  }
  return false;
}

/** The text of a number cell: what the author typed if the source kept it. */
function numberText(cell: Cell): string {
  return cell.originalText ?? plainDecimal(cell.value as number);
}

/** Digits of a number-like string, ignoring sign and the decimal point. */
function digitCount(text: string): number {
  return text.replace(/[^0-9]/g, '').length;
}

/** `007` and `00.5` are codes, not numbers; `0`, `0.5` and `-0.5` are numbers. */
export function hasLeadingZeros(text: string): boolean {
  return /^[+-]?0\d/.test(text.trim());
}

function decimalOf(
  cell: Cell,
  code: 'not-number' | 'not-integer' | 'not-money',
): { ok: true; value: number } | { ok: false; result: CoerceResult } {
  if (cell.type === 'number' && typeof cell.value === 'number') {
    if (!Number.isFinite(cell.value)) {
      return { ok: false, result: failure(code, 'not a finite number') };
    }
    return { ok: true, value: cell.value };
  }
  if (cell.type === 'text' && typeof cell.value === 'string') {
    const text = cell.value.trim();
    if (!DECIMAL.test(text)) {
      return { ok: false, result: failure(code, `"${text}" is not a number`) };
    }
    if (hasLeadingZeros(text)) {
      return {
        ok: false,
        result: failure(code, `"${text}" has leading zeros; keep it as text`),
      };
    }
    if (digitCount(text) >= 16) {
      return {
        ok: false,
        result: failure(
          code === 'not-integer' ? 'unsafe-integer' : 'unsafe-number',
          `"${text}" has too many digits to hold as a number`,
        ),
      };
    }
    const value = Number(text);
    if (!Number.isFinite(value)) {
      return { ok: false, result: failure(code, 'not a finite number') };
    }
    return { ok: true, value };
  }
  return {
    ok: false,
    result: failure(code, `a ${cell.type} cell is not a number`),
  };
}

const TRUE_WORDS = new Set(['true', 'yes', 'y', '1']);
const FALSE_WORDS = new Set(['false', 'no', 'n', '0']);

function validDate(year: number, month: number, day: number): boolean {
  const probe = new Date(Date.UTC(year, month - 1, day));
  return (
    probe.getUTCFullYear() === year &&
    probe.getUTCMonth() === month - 1 &&
    probe.getUTCDate() === day
  );
}

/**
 * Turns one workbook cell into the value a plan field stores, or refuses with
 * a code. Nothing is guessed: a value that does not fit is refused, never
 * rounded, truncated or reinterpreted. A caller reading many cells passes the
 * field's choices as a set, so matching stays constant-time per cell.
 */
export function coerceCell(
  cell: Cell | undefined,
  field: PlanField,
  choiceSet?: ReadonlySet<string>,
): CoerceResult {
  const c = cell ?? EMPTY;
  if (c.type === 'error') {
    return failure('cell-error', c.error ?? '#VALUE!');
  }
  if (field.type === 'reference') {
    return failure(
      'not-coercible',
      'reference values resolve through a lookup',
    );
  }
  if (isBlankCell(c, field.type !== 'text')) return { ok: true, value: null };

  switch (field.type) {
    case 'text': {
      if (typeof c.value === 'string') return { ok: true, value: c.value };
      if (c.type === 'number') return { ok: true, value: numberText(c) };
      if (c.value instanceof Date) {
        return { ok: true, value: isoDate(c.value) };
      }
      return { ok: true, value: String(c.value) };
    }
    case 'number': {
      const parsed = decimalOf(c, 'not-number');
      return parsed.ok ? { ok: true, value: parsed.value + 0 } : parsed.result;
    }
    case 'integer': {
      const parsed = decimalOf(c, 'not-integer');
      if (!parsed.ok) return parsed.result;
      if (!Number.isInteger(parsed.value)) {
        return failure(
          'not-integer',
          `${plainDecimal(parsed.value)} is not whole`,
        );
      }
      if (!Number.isSafeInteger(parsed.value)) {
        return failure('unsafe-integer', 'beyond the safe integer range');
      }
      return { ok: true, value: parsed.value + 0 };
    }
    case 'boolean': {
      if (c.type === 'boolean') return { ok: true, value: c.value as boolean };
      const word =
        c.type === 'number' && typeof c.value === 'number'
          ? String(c.value)
          : typeof c.value === 'string'
            ? c.value.trim().toLowerCase()
            : '';
      if (TRUE_WORDS.has(word)) return { ok: true, value: true };
      if (FALSE_WORDS.has(word)) return { ok: true, value: false };
      return failure('not-boolean', `"${describeCell(c)}" is not yes/no`);
    }
    case 'date': {
      if (c.value instanceof Date) {
        return { ok: true, value: isoDate(c.value) };
      }
      if (c.type === 'text' && typeof c.value === 'string') {
        const match = ISO_DATE.exec(c.value.trim());
        if (match && validDate(+match[1], +match[2], +match[3])) {
          return { ok: true, value: `${match[1]}-${match[2]}-${match[3]}` };
        }
      }
      return failure('not-date', `"${describeCell(c)}" is not a date`);
    }
    case 'money': {
      const parsed = decimalOf(c, 'not-money');
      if (!parsed.ok) return parsed.result;
      const scale = field.money?.scale ?? 0;
      const minor = parsed.value * 10 ** scale;
      const rounded = Math.round(minor);
      if (
        !Number.isFinite(minor) ||
        Math.abs(minor - rounded) > 1e-6 ||
        !Number.isSafeInteger(rounded)
      ) {
        return failure(
          'not-money',
          `${plainDecimal(parsed.value)} does not fit ${scale} decimal places`,
        );
      }
      return { ok: true, value: rounded + 0 };
    }
    case 'choice': {
      const text =
        typeof c.value === 'string'
          ? c.value.trim()
          : c.type === 'number'
            ? numberText(c)
            : String(c.value);
      if (choiceSet ? choiceSet.has(text) : field.choices?.includes(text))
        return { ok: true, value: text };
      return failure('not-choice', `"${text}" is not one of the choices`);
    }
  }
}
