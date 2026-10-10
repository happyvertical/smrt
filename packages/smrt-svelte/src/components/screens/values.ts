/**
 * Pure value handling for the manifest-derived record screens (#3718):
 * draft <-> payload conversion for edit forms and display formatting for list
 * and view screens. No DOM and no i18n: components map error codes and the
 * Yes/No labels through `useI18n`.
 *
 * Money is integer minor units end to end. Editing shows major units, but the
 * conversion is exact string math (never `* 100` on a float), and anything
 * that is not a JavaScript-safe integer is rejected rather than rounded.
 */
import { ISO_4217_MINOR_UNITS } from '@happyvertical/smrt-ui/currency';
import type {
  ScreenDraft,
  ScreenDraftValue,
  ScreenField,
  ScreenFieldErrorCode,
  ScreenPolicy,
  ScreenRecord,
} from './types.js';

/** Currency used for money fields when the screen is not told otherwise. */
export const DEFAULT_SCREEN_CURRENCY = 'USD';

/** Decimal places of a currency's minor unit (2 for an unknown code). */
export function currencyMinorDigits(currency: string): number {
  return ISO_4217_MINOR_UNITS.get(currency.trim().toUpperCase()) ?? 2;
}

/** `1999`, 2 digits -> `19.99`. Exact; `null` for a non-safe integer. */
export function minorUnitsToMajorString(
  minor: unknown,
  digits: number,
): string | null {
  if (typeof minor !== 'number' || !Number.isSafeInteger(minor)) return null;
  const negative = minor < 0;
  const absolute = String(Math.abs(minor));
  let text: string;
  if (digits <= 0) {
    text = absolute;
  } else {
    const padded = absolute.padStart(digits + 1, '0');
    text = `${padded.slice(0, -digits)}.${padded.slice(-digits)}`;
  }
  return negative ? `-${text}` : text;
}

/**
 * `19.99`, 2 digits -> `1999`. Accepts a leading sign and `,` grouping;
 * rejects more fraction digits than the currency has and non-safe integers.
 */
export function majorStringToMinorUnits(
  text: string,
  digits: number,
): number | null {
  const cleaned = text.trim().replace(/[,\s]/g, '');
  const pattern = digits > 0 ? /^(-?)(\d+)(?:\.(\d*))?$/ : /^(-?)(\d+)$/;
  const match = pattern.exec(cleaned);
  if (!match) return null;
  const [, sign, whole, fraction = ''] = match;
  if (fraction.length > Math.max(0, digits)) return null;
  const minor = Number(`${whole}${fraction.padEnd(Math.max(0, digits), '0')}`);
  if (!Number.isSafeInteger(minor)) return null;
  return sign === '-' && minor !== 0 ? -minor : minor;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** A record datetime as a `datetime-local` input value (local time). */
export function toDatetimeLocal(value: unknown): string {
  if (value === null || value === undefined || value === '') return '';
  const date =
    value instanceof Date ? value : new Date(value as string | number);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export interface ScreenValueContext {
  /** ISO 4217 code used by money fields. */
  currency?: string;
}

/** One field's value as the draft representation its control edits. */
export function toDraftValue(
  field: Pick<ScreenField, 'kind'>,
  value: unknown,
  context: ScreenValueContext = {},
): ScreenDraftValue {
  if (field.kind === 'boolean') return value === true || value === 'true';
  if (value === null || value === undefined) return '';
  switch (field.kind) {
    case 'money':
      return (
        minorUnitsToMajorString(
          value,
          currencyMinorDigits(context.currency ?? DEFAULT_SCREEN_CURRENCY),
        ) ?? ''
      );
    case 'datetime':
      return toDatetimeLocal(value);
    case 'json':
      return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    default:
      return String(value);
  }
}

/** Draft for editing an existing record. */
export function draftFromRecord(
  fields: readonly ScreenField[],
  record: ScreenRecord,
  context: ScreenValueContext = {},
): ScreenDraft {
  const draft: ScreenDraft = {};
  for (const field of fields) {
    draft[field.name] = toDraftValue(field, record[field.name], context);
  }
  return draft;
}

/**
 * Draft for a new record: the resolved policy default when one resolved
 * (an explicit `null` default included), else the manifest default.
 */
export function draftForCreate(
  fields: readonly ScreenField[],
  policy?: ScreenPolicy | null,
  context: ScreenValueContext = {},
): ScreenDraft {
  const draft: ScreenDraft = {};
  for (const field of fields) {
    const policyField = policy?.fields[field.name];
    const seeded =
      policyField?.hasDefault === true
        ? policyField.defaultValue
        : field.definition.default;
    draft[field.name] = toDraftValue(field, seeded, context);
  }
  return draft;
}

export interface ParseDraftContext extends ScreenValueContext {
  /**
   * The loaded record being edited. A datetime control shows minute
   * precision only, so a datetime whose draft text still equals what the
   * record rendered is submitted as the record's own value, keeping seconds
   * and milliseconds. A genuinely edited datetime saves the new value.
   */
  record?: ScreenRecord | null;
}

export interface ParsedDraft {
  /** Payload values, keyed by field name. */
  values: Record<string, unknown>;
  errors: Record<string, ScreenFieldErrorCode>;
}

/**
 * Convert a draft into a write payload. An empty optional text field becomes
 * `null` when the field is nullable and `''` otherwise; every other empty
 * optional field becomes `null`. A required empty field is an error.
 */
export function parseDraft(
  fields: readonly ScreenField[],
  draft: ScreenDraft,
  context: ParseDraftContext = {},
): ParsedDraft {
  const values: Record<string, unknown> = {};
  const errors: Record<string, ScreenFieldErrorCode> = {};
  const digits = currencyMinorDigits(
    context.currency ?? DEFAULT_SCREEN_CURRENCY,
  );

  for (const field of fields) {
    const raw = draft[field.name];
    if (field.kind === 'boolean') {
      values[field.name] = raw === true || raw === 'true';
      continue;
    }
    const text = typeof raw === 'string' ? raw : '';
    const trimmed = text.trim();

    if (trimmed === '') {
      if (field.required) {
        errors[field.name] = 'required';
      } else if (
        (field.kind === 'text' ||
          field.kind === 'textarea' ||
          field.kind === 'email' ||
          field.kind === 'url' ||
          field.kind === 'tel') &&
        field.definition.nullable !== true
      ) {
        values[field.name] = '';
      } else {
        values[field.name] = null;
      }
      continue;
    }

    switch (field.kind) {
      case 'integer': {
        const parsed = /^-?\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN;
        if (Number.isSafeInteger(parsed)) values[field.name] = parsed;
        else errors[field.name] = 'invalid_integer';
        break;
      }
      case 'decimal': {
        const parsed = Number(trimmed);
        if (Number.isFinite(parsed)) values[field.name] = parsed;
        else errors[field.name] = 'invalid_decimal';
        break;
      }
      case 'money': {
        const minor = majorStringToMinorUnits(trimmed, digits);
        if (minor === null) errors[field.name] = 'invalid_money';
        else values[field.name] = minor;
        break;
      }
      case 'datetime': {
        const original = context.record?.[field.name];
        const originalDate =
          original === null || original === undefined || original === ''
            ? null
            : original instanceof Date
              ? original
              : new Date(original as string | number);
        if (
          originalDate &&
          !Number.isNaN(originalDate.getTime()) &&
          trimmed === toDatetimeLocal(originalDate)
        ) {
          // Unchanged at the control's precision: keep the full-precision
          // original instead of truncating to the minute.
          values[field.name] = originalDate.toISOString();
          break;
        }
        const date = new Date(trimmed);
        if (Number.isNaN(date.getTime()))
          errors[field.name] = 'invalid_datetime';
        else values[field.name] = date.toISOString();
        break;
      }
      case 'json': {
        try {
          values[field.name] = JSON.parse(trimmed);
        } catch {
          errors[field.name] = 'invalid_json';
        }
        break;
      }
      case 'reference':
        values[field.name] = trimmed;
        break;
      default:
        // Free text keeps the user's whitespace.
        values[field.name] = text;
    }
  }
  return { values, errors };
}

export interface FormatValueContext extends ScreenValueContext {
  locale?: string;
  timeZone?: string;
  /** Labels for boolean values (the component supplies localized ones). */
  yes?: string;
  no?: string;
}

/** A record value as display text for a list cell or a view row. */
export function formatScreenValue(
  field: Pick<ScreenField, 'kind'>,
  value: unknown,
  context: FormatValueContext = {},
): string {
  if (field.kind === 'boolean') {
    if (value === null || value === undefined) return '';
    return value === true || value === 'true'
      ? (context.yes ?? 'Yes')
      : (context.no ?? 'No');
  }
  if (value === null || value === undefined || value === '') return '';
  try {
    switch (field.kind) {
      case 'integer':
        return typeof value === 'number'
          ? new Intl.NumberFormat(context.locale, {
              maximumFractionDigits: 0,
            }).format(value)
          : String(value);
      case 'decimal':
        return typeof value === 'number'
          ? new Intl.NumberFormat(context.locale, {
              maximumFractionDigits: 6,
            }).format(value)
          : String(value);
      case 'money': {
        const currency = (context.currency ?? DEFAULT_SCREEN_CURRENCY)
          .trim()
          .toUpperCase();
        const digits = currencyMinorDigits(currency);
        if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
          return String(value);
        }
        return new Intl.NumberFormat(context.locale, {
          style: 'currency',
          currency,
        }).format(value / 10 ** digits);
      }
      case 'datetime': {
        const date =
          value instanceof Date ? value : new Date(value as string | number);
        if (Number.isNaN(date.getTime())) return String(value);
        return new Intl.DateTimeFormat(context.locale, {
          dateStyle: 'medium',
          timeStyle: 'short',
          ...(context.timeZone ? { timeZone: context.timeZone } : {}),
        }).format(date);
      }
      case 'json':
        return typeof value === 'string' ? value : JSON.stringify(value);
      default:
        return String(value);
    }
  } catch {
    // An unsupported currency code or locale must not break a row render.
    return String(value);
  }
}

/**
 * Order two record values for a list column: empty values last (whichever
 * way the column sorts), numbers numerically, everything else as text.
 */
export function compareScreenValues(
  left: unknown,
  right: unknown,
  direction: 'asc' | 'desc' | null,
): number {
  if (!direction) return 0;
  const leftEmpty = left === null || left === undefined || left === '';
  const rightEmpty = right === null || right === undefined || right === '';
  if (leftEmpty && rightEmpty) return 0;
  if (leftEmpty) return 1;
  if (rightEmpty) return -1;
  let result: number;
  if (typeof left === 'number' && typeof right === 'number') {
    result = left - right;
  } else if (typeof left === 'boolean' && typeof right === 'boolean') {
    result = Number(left) - Number(right);
  } else {
    result = String(left).localeCompare(String(right));
  }
  return direction === 'asc' ? result : -result;
}
