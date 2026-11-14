// Form-field mapping and value coercion, driven by the describe shape.
import { inputToMinor, minorToInput } from './money.ts';
import type { FieldDef, ModelInfo, RecordRow } from './types.ts';

/** "dueDate" -> "Due date". */
export function humanize(name: string): string {
  const spaced = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export function fieldLabel(name: string, def: FieldDef): string {
  return def.label?.trim() || humanize(name);
}

export type InputKind =
  | 'text'
  | 'number'
  | 'integer'
  | 'checkbox'
  | 'date'
  | 'money'
  | 'select'
  | 'reference'
  | 'json';

export interface FieldSpec {
  name: string;
  label: string;
  kind: InputKind;
  required: boolean;
  choices: string[];
  ref: string | null;
}

export function inputKind(def: FieldDef): InputKind {
  switch (def.type) {
    case 'boolean':
      return 'checkbox';
    case 'choice':
      return 'select';
    case 'text':
    case 'number':
    case 'integer':
    case 'date':
    case 'money':
    case 'reference':
    case 'json':
      return def.type;
    default:
      return 'text';
  }
}

export function fieldSpec(name: string, def: FieldDef): FieldSpec {
  return {
    name,
    label: fieldLabel(name, def),
    kind: inputKind(def),
    required: !!def.required,
    choices: def.choices ?? [],
    ref: def.ref ?? null,
  };
}

/** The form's fields in definition order (hidden ones never reach describe). */
export function formFields(model: Pick<ModelInfo, 'fields'>): FieldSpec[] {
  return Object.entries(model.fields)
    .filter(([, d]) => !d.hidden)
    .map(([n, d]) => fieldSpec(n, d));
}

/** A form value: text for most inputs, a boolean for checkboxes. */
export type FormValue = string | boolean;
export type FormValues = Record<string, FormValue>;

function isTrue(v: unknown): boolean {
  return v === true || v === 1 || v === '1' || v === 'true';
}

/** The date input wants YYYY-MM-DD; the store keeps an ISO timestamp. */
export function dateToInput(v: unknown): string {
  if (v === null || v === undefined || v === '') return '';
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
}

export function toFormValue(def: FieldDef, v: unknown): FormValue {
  switch (def.type) {
    case 'boolean':
      return isTrue(v);
    case 'money':
      return minorToInput(v);
    case 'date':
      return dateToInput(v);
    case 'json':
      if (v === null || v === undefined || v === '') return '';
      if (typeof v === 'string') {
        try {
          return JSON.stringify(JSON.parse(v), null, 2);
        } catch {
          return v;
        }
      }
      return JSON.stringify(v, null, 2);
    default:
      return v === null || v === undefined ? '' : String(v);
  }
}

export function initialValues(
  fields: Record<string, FieldDef>,
  record?: RecordRow | null,
): FormValues {
  const out: FormValues = {};
  for (const [name, def] of Object.entries(fields)) {
    if (def.hidden || def.calculated) continue;
    out[name] = toFormValue(def, record ? record[name] : undefined);
  }
  return out;
}

export type FormErrors = Record<string, string>;

export interface Serialized {
  data: Record<string, unknown>;
  errors: FormErrors;
}

/** One form value -> the value to send, or an error message. */
export function coerceInput(
  def: FieldDef,
  raw: FormValue | undefined,
): { ok: true; value: unknown } | { ok: false; error: string } {
  if (def.type === 'boolean') return { ok: true, value: raw === true };
  const text = typeof raw === 'string' ? raw : '';
  const empty = text.trim() === '';
  if (empty) {
    return def.required
      ? { ok: false, error: 'This field is required' }
      : { ok: true, value: null };
  }
  switch (def.type) {
    case 'text':
      return { ok: true, value: text };
    case 'reference':
    case 'date':
      return { ok: true, value: text.trim() };
    case 'choice':
      return def.choices?.includes(text)
        ? { ok: true, value: text }
        : { ok: false, error: 'Choose one of the listed options' };
    case 'number': {
      const n = Number(text);
      return Number.isFinite(n)
        ? { ok: true, value: n }
        : { ok: false, error: 'Enter a number' };
    }
    case 'integer': {
      const n = Number(text);
      return Number.isInteger(n)
        ? { ok: true, value: n }
        : { ok: false, error: 'Enter a whole number' };
    }
    case 'money': {
      const minor = inputToMinor(text);
      return minor === null
        ? { ok: false, error: 'Enter an amount like 12.50' }
        : { ok: true, value: minor };
    }
    case 'json':
      try {
        return { ok: true, value: JSON.parse(text) };
      } catch {
        return { ok: false, error: 'Enter valid JSON' };
      }
    default:
      return { ok: true, value: text };
  }
}

/**
 * Validate and convert the form. With `only`, just those fields are kept
 * (used on update so untouched values are never rewritten).
 */
export function serializeForm(
  fields: Record<string, FieldDef>,
  values: FormValues,
  only?: Iterable<string>,
): Serialized {
  const keep = only ? new Set(only) : null;
  const data: Record<string, unknown> = {};
  const errors: FormErrors = {};
  for (const [name, def] of Object.entries(fields)) {
    if (def.hidden || def.calculated || (keep && !keep.has(name))) continue;
    const r = coerceInput(def, values[name]);
    if (r.ok) data[name] = r.value;
    else errors[name] = r.error;
  }
  return { data, errors };
}

/** Names of fields whose form value differs from the record's. */
export function changedFields(
  fields: Record<string, FieldDef>,
  values: FormValues,
  record: RecordRow,
): string[] {
  const base = initialValues(fields, record);
  return Object.keys(base).filter((k) => base[k] !== values[k]);
}

/**
 * Server errors read `Model.field message` (or `Model has no field 'x'`).
 * Returns the field the message is about, if it names one.
 */
export function fieldOfError(
  message: string,
  model: string,
  fieldNames: string[],
): string | null {
  const m = new RegExp(`^${model}\\.([A-Za-z0-9]+)\\b`).exec(message);
  if (m && fieldNames.includes(m[1])) return m[1];
  const quoted = /field '([A-Za-z0-9]+)'/.exec(message);
  if (quoted && fieldNames.includes(quoted[1])) return quoted[1];
  return null;
}

/** "Chore.title must be text" -> "must be text" for display next to a field. */
export function stripFieldPrefix(message: string, model: string): string {
  return message.replace(new RegExp(`^${model}\\.[A-Za-z0-9]+:?\\s*`), '');
}

/** A short label for a record, for selects and links. */
export function recordLabel(
  model: Pick<ModelInfo, 'fields'> | undefined,
  record: RecordRow,
): string {
  if (model) {
    for (const [name, def] of Object.entries(model.fields)) {
      if (def.type !== 'text') continue;
      const v = record[name];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
  }
  return record.id.length > 8 ? `${record.id.slice(0, 8)}…` : record.id;
}

/** The generated tool for a method: `<classname lowercased>_<method>`. */
export function methodToolName(className: string, method: string): string {
  return `${className.toLowerCase()}_${method}`;
}
