/**
 * Pure entry logic for `NumericKeypad` (smrt#3463): key press to next text,
 * range validation, and typed text <-> integer minor units. Svelte-free and
 * DOM-free so it unit-tests without rendering.
 *
 * Money never goes through a float: text converts to and from integer minor
 * units with string arithmetic, so `0.1 + 0.2` style drift cannot appear.
 */
import { ISO_4217_MINOR_UNITS } from '../display/currency-metadata.js';

/** One press on the keypad. */
export type KeypadKey =
  | { kind: 'digit'; digit: string }
  | { kind: 'decimal' }
  | { kind: 'backspace' }
  | { kind: 'clear' };

/** What `NumericKeypad`'s `onChange` and `onSubmit` receive. */
export interface NumericKeypadDetail {
  /** The typed text (`"12.5"`, `""` when empty). */
  text: string;
  /** Number value of the text, or null when empty. Not for money arithmetic. */
  number: number | null;
  /** Integer minor units in money mode; null otherwise or when empty. */
  minorUnits: number | null;
  /** True when the text is non-empty and inside `min` / `max`. */
  valid: boolean;
}

/** Limits that shape what can be typed. */
export interface EntryRules {
  /** Digits allowed after the point; 0 means integer-only. */
  maxDecimals: number;
  /** Longest typed text, counting the point. */
  maxLength: number;
}

/** Outcome of checking typed text against `min` / `max`. */
export type EntryValidity = 'empty' | 'ok' | 'below' | 'above' | 'invalid';

/** Default longest typed text. */
export const DEFAULT_MAX_LENGTH = 12;

const TEXT_PATTERN = /^\d*(\.\d*)?$/;

/** Minor-unit exponent of an ISO 4217 currency (USD 2, JPY 0, KWD 3). */
export function minorUnitExponent(
  currency: string | undefined,
  fallback = 2,
): number {
  if (!currency) return fallback;
  const exponent = ISO_4217_MINOR_UNITS.get(currency.toUpperCase());
  if (exponent === undefined) return fallback;
  // Funds and metals have no minor unit: whole units only.
  return exponent === null ? 0 : exponent;
}

/** Map a hardware `KeyboardEvent.key` to a keypad key; `,` types a point. */
export function keyFromKeyboard(key: string): KeypadKey | null {
  if (/^[0-9]$/.test(key)) return { kind: 'digit', digit: key };
  if (key === '.' || key === ',') return { kind: 'decimal' };
  if (key === 'Backspace') return { kind: 'backspace' };
  if (key === 'Delete') return { kind: 'clear' };
  return null;
}

/**
 * Coerce an outside value (a bound string, a number, junk) to well-formed
 * typed text under `rules`; anything unrepresentable becomes `''`.
 */
export function normalizeText(
  raw: string | number | null | undefined,
  rules: EntryRules,
): string {
  if (raw === null || raw === undefined) return '';
  let text = typeof raw === 'number' ? numberToPlainText(raw) : raw.trim();
  if (text === '') return '';
  text = text.replace(',', '.');
  if (!TEXT_PATTERN.test(text)) return '';
  let [whole = '', fraction] = text.split('.');
  whole = whole.replace(/^0+(?=\d)/, '');
  if (whole === '' && fraction !== undefined) whole = '0';
  if (fraction === undefined || rules.maxDecimals <= 0) {
    text = whole;
  } else {
    text = `${whole}.${fraction.slice(0, rules.maxDecimals)}`;
  }
  return text.length > rules.maxLength ? '' : text;
}

function numberToPlainText(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '';
  // Exponent forms ("1e21") are not typeable text.
  const text = String(value);
  return /e/i.test(text) ? '' : text;
}

/** The text after pressing `key`; the same string when the press is refused. */
export function applyKey(
  text: string,
  key: KeypadKey,
  rules: EntryRules,
): string {
  switch (key.kind) {
    case 'clear':
      return '';
    case 'backspace':
      return text.slice(0, -1);
    case 'decimal': {
      if (rules.maxDecimals <= 0 || text.includes('.')) return text;
      const next = text === '' ? '0.' : `${text}.`;
      return next.length > rules.maxLength ? text : next;
    }
    case 'digit': {
      if (!/^[0-9]$/.test(key.digit)) return text;
      const point = text.indexOf('.');
      if (point >= 0 && text.length - point - 1 >= rules.maxDecimals) {
        return text;
      }
      // A lone leading zero is replaced, so "05" never exists.
      const next = text === '0' ? key.digit : `${text}${key.digit}`;
      return next.length > rules.maxLength ? text : next;
    }
  }
}

/** Number value of typed text, or `null` when empty. Display and range use only. */
export function parseEntry(text: string): number | null {
  if (text === '' || text === '.') return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

/** Check typed text against optional `min` / `max` (major units). */
export function validateEntry(
  text: string,
  limits: { min?: number; max?: number },
): EntryValidity {
  if (text === '') return 'empty';
  if (!TEXT_PATTERN.test(text)) return 'invalid';
  const value = parseEntry(text);
  if (value === null) return 'invalid';
  if (limits.min !== undefined && value < limits.min) return 'below';
  if (limits.max !== undefined && value > limits.max) return 'above';
  return 'ok';
}

/** True when `text` is above `max`: the entry the "clamp" mode refuses. */
export function exceedsMax(text: string, max: number | undefined): boolean {
  if (max === undefined) return false;
  const value = parseEntry(text);
  return value !== null && value > max;
}

/**
 * Typed text to integer minor units (`"12.5"` with exponent 2 is `1250`).
 * `null` for empty or malformed text, more decimals than `exponent`, or a
 * result beyond `Number.MAX_SAFE_INTEGER`.
 */
export function textToMinorUnits(
  text: string,
  exponent: number,
): number | null {
  if (!Number.isInteger(exponent) || exponent < 0) return null;
  if (text === '' || text === '.' || !TEXT_PATTERN.test(text)) return null;
  const [whole = '', fraction = ''] = text.split('.');
  if (fraction.length > exponent) return null;
  const digits = `${whole}${fraction.padEnd(exponent, '0')}`.replace(
    /^0+(?=\d)/,
    '',
  );
  const minor = Number(digits === '' ? '0' : digits);
  return Number.isSafeInteger(minor) ? minor : null;
}

/**
 * Integer minor units to typed text (`1250`, exponent 2 -> `"12.5"`). With
 * `trim: false` the fraction is padded to `exponent` (`"12.50"`). `null` for a
 * non-integer, negative, or unsafe amount.
 */
export function minorUnitsToText(
  minor: number,
  exponent: number,
  options: { trim?: boolean } = {},
): string | null {
  if (!Number.isSafeInteger(minor) || minor < 0) return null;
  if (!Number.isInteger(exponent) || exponent < 0) return null;
  if (exponent === 0) return String(minor);
  const padded = String(minor).padStart(exponent + 1, '0');
  const whole = padded.slice(0, -exponent);
  let fraction = padded.slice(-exponent);
  if (options.trim !== false) fraction = fraction.replace(/0+$/, '');
  return fraction === '' ? whole : `${whole}.${fraction}`;
}
