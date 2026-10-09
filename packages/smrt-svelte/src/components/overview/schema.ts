/**
 * Versioned widget option schemas (#3727). A widget's options are a flat list
 * of typed fields; this module validates untrusted option values against it.
 *
 * The rule that keeps a stored overview from running arbitrary queries: an
 * option value can only be a JSON primitive that passes its field's type, so
 * there is no free-form filter, SQL, expression or URL field. A `model` option
 * is a bare identifier (optionally confined to a page-declared list) and every
 * other "which data" option is an `identifier` or a closed `enum`; the loader
 * maps those to queries it owns and authorizes.
 *
 * Pure and Svelte-free: it runs on the server on save and on load, and in the
 * browser for the option editor.
 */
import type {
  OverviewOptions,
  OverviewOptionValue,
  WidgetOptionField,
  WidgetOptionIssue,
  WidgetOptionsContext,
  WidgetOptionsResult,
} from './types.js';

const KEY_PATTERN = /^[A-Za-z][A-Za-z0-9]{0,31}$/;
/** A field, preset or period id: short, no separators that form paths. */
export const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;
/** `Class`, `pkg:Class` or `@scope/pkg:Class`. */
export const MODEL_PATTERN =
  /^(?:(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*:)?[A-Za-z][A-Za-z0-9_]{0,63}$/;
const MODEL_MAX_LENGTH = 160;
const DEFAULT_TEXT_MAX = 200;
const DEFAULT_MARKDOWN_MAX = 10_000;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Throws when a schema is malformed: unsafe or duplicate keys, empty enums, invalid defaults. */
export function assertWidgetOptionFields(
  type: string,
  fields: readonly WidgetOptionField[],
): void {
  const seen = new Set<string>();
  for (const field of fields) {
    if (!KEY_PATTERN.test(field.key)) {
      throw new Error(`widget "${type}": invalid option key "${field.key}"`);
    }
    if (seen.has(field.key)) {
      throw new Error(`widget "${type}": duplicate option key "${field.key}"`);
    }
    seen.add(field.key);
    if (field.type === 'enum' && !field.choices?.length) {
      throw new Error(
        `widget "${type}": enum option "${field.key}" needs choices`,
      );
    }
    if (field.default !== undefined && field.default !== null) {
      const check = validateField(field, field.default, undefined);
      if (check.issue) {
        throw new Error(
          `widget "${type}": default of option "${field.key}" is invalid`,
        );
      }
    }
  }
}

interface FieldCheck {
  value?: OverviewOptionValue;
  issue?: WidgetOptionIssue;
}

function fail(key: string, code: WidgetOptionIssue['code']): FieldCheck {
  return { issue: { key, code } };
}

function validateField(
  field: WidgetOptionField,
  raw: unknown,
  context: WidgetOptionsContext | undefined,
): FieldCheck {
  const { key } = field;
  switch (field.type) {
    case 'text':
    case 'markdown': {
      if (typeof raw !== 'string') return fail(key, 'invalid_type');
      const max =
        field.maxLength ??
        (field.type === 'markdown' ? DEFAULT_MARKDOWN_MAX : DEFAULT_TEXT_MAX);
      if (raw.length > max) return fail(key, 'too_long');
      return { value: raw };
    }
    case 'identifier': {
      if (typeof raw !== 'string') return fail(key, 'invalid_type');
      if (!IDENTIFIER_PATTERN.test(raw)) return fail(key, 'invalid_format');
      return { value: raw };
    }
    case 'model': {
      if (typeof raw !== 'string') return fail(key, 'invalid_type');
      if (raw.length > MODEL_MAX_LENGTH || !MODEL_PATTERN.test(raw)) {
        return fail(key, 'invalid_format');
      }
      if (context?.models && !context.models.includes(raw)) {
        return fail(key, 'not_allowed');
      }
      return { value: raw };
    }
    case 'enum': {
      if (typeof raw !== 'string') return fail(key, 'invalid_type');
      if (!field.choices?.some((choice) => choice.value === raw)) {
        return fail(key, 'not_in_choices');
      }
      return { value: raw };
    }
    case 'boolean': {
      if (typeof raw !== 'boolean') return fail(key, 'invalid_type');
      return { value: raw };
    }
    case 'integer':
    case 'number': {
      if (typeof raw !== 'number' || !Number.isFinite(raw)) {
        return fail(key, 'invalid_type');
      }
      if (field.type === 'integer' && !Number.isSafeInteger(raw)) {
        return fail(key, 'invalid_type');
      }
      if (
        (field.min !== undefined && raw < field.min) ||
        (field.max !== undefined && raw > field.max)
      ) {
        return fail(key, 'out_of_range');
      }
      return { value: raw };
    }
  }
}

/** The options a new widget starts with: every field that has a default. */
export function defaultWidgetOptions(
  fields: readonly WidgetOptionField[],
): OverviewOptions {
  const options: OverviewOptions = {};
  for (const field of fields) {
    if (field.default !== undefined && field.default !== null) {
      options[field.key] = field.default;
    }
  }
  return options;
}

/**
 * Validate untrusted options against a schema. Strict: an unknown key, a
 * wrong type, an out-of-range number, a value outside a closed set, or a
 * missing required field fails the whole object (all issues are reported).
 * Missing optional fields take their default, or stay absent. A `null` value
 * counts as missing. The result contains only schema keys, in schema order.
 */
export function validateWidgetOptions(
  fields: readonly WidgetOptionField[],
  raw: unknown,
  context?: WidgetOptionsContext,
): WidgetOptionsResult {
  const issues: WidgetOptionIssue[] = [];
  const input: Record<string, unknown> =
    raw === undefined || raw === null ? {} : isPlainRecord(raw) ? raw : {};
  if (raw !== undefined && raw !== null && !isPlainRecord(raw)) {
    issues.push({ key: '', code: 'invalid_type' });
    return { ok: false, issues };
  }
  const known = new Set(fields.map((field) => field.key));
  for (const key of Object.keys(input)) {
    if (!known.has(key)) issues.push({ key, code: 'unknown_option' });
  }
  const options: OverviewOptions = {};
  for (const field of fields) {
    const value = Object.hasOwn(input, field.key)
      ? input[field.key]
      : undefined;
    if (value === undefined || value === null) {
      if (field.default !== undefined && field.default !== null) {
        options[field.key] = field.default;
      } else if (field.required) {
        issues.push({ key: field.key, code: 'required' });
      }
      continue;
    }
    // A cleared select or identifier box behaves as unset.
    if (value === '' && field.type !== 'text' && field.type !== 'markdown') {
      if (field.default !== undefined && field.default !== null) {
        options[field.key] = field.default;
      } else if (field.required) {
        issues.push({ key: field.key, code: 'required' });
      }
      continue;
    }
    const check = validateField(field, value, context);
    if (check.issue) issues.push(check.issue);
    else if (check.value !== undefined) options[field.key] = check.value;
  }
  return issues.length > 0 ? { ok: false, issues } : { ok: true, options };
}

/** Structural equality of two option objects (primitives only). */
export function optionsEqual(
  a: OverviewOptions | undefined,
  b: OverviewOptions | undefined,
): boolean {
  const left = a ?? {};
  const right = b ?? {};
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    if ((left[key] ?? null) !== (right[key] ?? null)) return false;
  }
  return true;
}
