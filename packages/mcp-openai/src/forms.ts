/** Bounded OpenAI form wire profile; pinned upstream sources are in FORMS.md. */
import { json, keys, record, text } from './validation.js';

export interface FormIcon {
  src: string;
  mimeType?: string;
  sizes?: string[];
  theme?: 'light' | 'dark';
}
export interface FormOption {
  const: string;
  title: string;
  description?: string;
  'x-openai-thumbnail'?: FormIcon;
  'x-openai-preview'?: FormIcon;
}
export interface FormResource {
  uri: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
  size?: number;
  icons?: FormIcon[];
  annotations?: {
    audience?: ('user' | 'assistant')[];
    priority?: number;
    lastModified?: string;
  };
  _meta?: Record<string, unknown>;
}
export interface FormResourceInput {
  type: 'resource' | 'file';
  options: FormResource[];
  userOptions?: { kind?: 'file' | 'directory'; accept?: string[] };
  selection?: 'explicit' | 'implicit';
}
interface FormCommon {
  title?: string;
  description?: string;
}
export interface FormString extends FormCommon {
  type: 'string';
  minLength?: number;
  maxLength?: number;
  format?: 'email' | 'uri' | 'date' | 'date-time';
  default?: string;
  'x-openai-suggestions'?: FormOption[];
}
export type FormField =
  | FormString
  | (FormCommon & {
      type: 'string';
      enum: string[];
      enumNames?: string[];
      default?: string;
    })
  | (FormCommon & { type: 'string'; oneOf: FormOption[]; default?: string })
  | (FormCommon & {
      type: 'number' | 'integer';
      minimum?: number;
      maximum?: number;
      default?: number;
    })
  | (FormCommon & { type: 'boolean'; default?: boolean })
  | (FormCommon & {
      type: 'array';
      minItems?: number;
      maxItems?: number;
      default?: string[];
      items:
        | FormString
        | { type: 'string'; enum: string[] }
        | { anyOf: FormOption[] };
      uniqueItems?: boolean;
    })
  | (FormString & {
      format: 'uri';
      'x-openai-input': Omit<FormResourceInput, 'selection'>;
    })
  | (FormCommon & {
      type: 'array';
      minItems?: number;
      maxItems?: number;
      default?: string[];
      items: FormString & { format: 'uri' };
      'x-openai-input': FormResourceInput;
    });
export interface OpenAiForm {
  $schema?: string;
  type: 'object';
  properties: Record<string, FormField>;
  required?: string[];
}
export type FormValue = string | number | boolean | string[];
export type OpenAiFormReply =
  | { action: 'accept'; content: Record<string, FormValue> }
  | { action: 'cancel' | 'decline' };
function boundedJson(v: unknown) {
  json(v);
  if (new TextEncoder().encode(JSON.stringify(v)).length > 65536)
    throw new TypeError('Form exceeds byte limit');
}
const common = ['type', 'title', 'description', 'default'];
const strings = ['minLength', 'maxLength', 'format', 'x-openai-suggestions'];
function optionalText(v: Record<string, unknown>, names: string[], max = 4096) {
  for (const name of names)
    if (
      v[name] !== undefined &&
      (typeof v[name] !== 'string' || (v[name] as string).length > max)
    )
      throw new TypeError('Invalid form text');
}
function list(v: unknown, max = 64): unknown[] {
  if (!Array.isArray(v) || v.length > max)
    throw new TypeError('Invalid form list');
  return v;
}
function stringList(v: unknown, max = 64): string[] {
  const a = list(v, max);
  if (a.some((x) => typeof x !== 'string' || x.length > 4096))
    throw new TypeError('Invalid string list');
  return a as string[];
}
function bounds(
  f: Record<string, unknown>,
  min: string,
  max: string,
  limit?: number,
) {
  for (const key of [min, max])
    if (
      f[key] !== undefined &&
      (typeof f[key] !== 'number' ||
        !Number.isFinite(f[key]) ||
        (limit !== undefined &&
          (!Number.isSafeInteger(f[key]) ||
            (f[key] as number) < 0 ||
            (f[key] as number) > limit)))
    )
      throw new TypeError('Invalid form bounds');
  if (Number(f[min] ?? -Infinity) > Number(f[max] ?? Infinity))
    throw new TypeError('Reversed form bounds');
}
function icon(v: unknown) {
  const i = record(v);
  keys(i, ['src', 'mimeType', 'sizes', 'theme']);
  text(i.src, 8192);
  optionalText(i, ['mimeType'], 128);
  if (i.sizes !== undefined) stringList(i.sizes, 8);
  if (i.theme !== undefined && !['light', 'dark'].includes(String(i.theme)))
    throw new TypeError('Invalid icon theme');
  // No active/SVG image payloads or arbitrary schemes in form declarations.
  if (
    !/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(
      String(i.src),
    )
  ) {
    const u = new URL(String(i.src));
    if (u.protocol !== 'https:' || u.username || u.password)
      throw new TypeError('Unsafe form image');
  }
}
function options(v: unknown) {
  const a = list(v);
  const values = new Set<string>();
  for (const raw of a) {
    const o = record(raw);
    keys(o, [
      'const',
      'title',
      'description',
      'x-openai-thumbnail',
      'x-openai-preview',
    ]);
    optionalText(o, ['const', 'title', 'description']);
    if (
      typeof o.const !== 'string' ||
      typeof o.title !== 'string' ||
      values.has(o.const)
    )
      throw new TypeError('Invalid option');
    values.add(o.const);
    for (const k of ['x-openai-thumbnail', 'x-openai-preview'])
      if (o[k] !== undefined) icon(o[k]);
  }
  return a;
}
function resource(v: unknown) {
  const r = record(v);
  keys(r, [
    'uri',
    'name',
    'title',
    'description',
    'mimeType',
    'size',
    'icons',
    'annotations',
    '_meta',
  ]);
  text(r.uri, 2048);
  text(r.name, 256);
  uri(String(r.uri));
  optionalText(r, ['title', 'description', 'mimeType']);
  if (
    r.size !== undefined &&
    (!Number.isSafeInteger(r.size) || Number(r.size) < 0)
  )
    throw new TypeError('Invalid resource size');
  if (r.icons !== undefined) for (const i of list(r.icons, 8)) icon(i);
  if (r._meta !== undefined) record(r._meta);
  if (r.annotations !== undefined) {
    const a = record(r.annotations);
    keys(a, ['audience', 'priority', 'lastModified']);
    if (
      a.audience !== undefined &&
      stringList(a.audience, 2).some((x) => !['user', 'assistant'].includes(x))
    )
      throw new TypeError('Invalid resource audience');
    if (
      a.priority !== undefined &&
      (typeof a.priority !== 'number' || a.priority < 0 || a.priority > 1)
    )
      throw new TypeError('Invalid priority');
    optionalText(a, ['lastModified'], 64);
  }
}
function uri(v: string) {
  if (v.length > 2048 || /[\s\\]/.test(v))
    throw new TypeError('Invalid resource URI');
  const u = new URL(v);
  if (
    ['javascript:', 'data:', 'file:'].includes(u.protocol) ||
    u.username ||
    u.password
  )
    throw new TypeError('Expected opaque resource URI');
}
function stringField(f: Record<string, unknown>, extra: string[] = []) {
  if (f.default !== undefined && typeof f.default !== 'string')
    throw new TypeError('Invalid string default');
  keys(f, [...common, ...strings, ...extra]);
  bounds(f, 'minLength', 'maxLength', 4096);
  if (
    f.format !== undefined &&
    !['email', 'uri', 'date', 'date-time'].includes(String(f.format))
  )
    throw new TypeError('Invalid format');
  if (f['x-openai-suggestions'] !== undefined)
    options(f['x-openai-suggestions']);
}
function field(raw: unknown): void {
  const f = record(raw);
  optionalText(f, ['title', 'description']);
  if (f.type === 'string') {
    if (f.enum !== undefined) {
      keys(f, [...common, 'enum', 'enumNames']);
      const values = stringList(f.enum);
      if (new Set(values).size !== values.length)
        throw new TypeError('Duplicate enum');
      if (
        f.enumNames !== undefined &&
        stringList(f.enumNames).length !== values.length
      )
        throw new TypeError('Invalid enum titles');
    } else if (f.oneOf !== undefined) {
      keys(f, [...common, 'oneOf']);
      options(f.oneOf);
    } else stringField(f, ['x-openai-input']);
  } else if (f.type === 'array') {
    keys(f, [
      ...common,
      'minItems',
      'maxItems',
      'items',
      'uniqueItems',
      'x-openai-input',
    ]);
    bounds(f, 'minItems', 'maxItems', 64);
    const item = record(f.items);
    if (item.anyOf !== undefined) {
      keys(item, ['anyOf']);
      options(item.anyOf);
      if (f.uniqueItems !== undefined)
        throw new TypeError('uniqueItems only supports string arrays');
    } else if (item.enum !== undefined) {
      keys(item, ['type', 'enum']);
      if (item.type !== 'string') throw new TypeError('Expected string items');
      stringList(item.enum);
      if (f.uniqueItems !== undefined)
        throw new TypeError('uniqueItems only supports string arrays');
    } else {
      if (item.type !== 'string') throw new TypeError('Expected string items');
      stringField(item);
      optionalText(item, ['title', 'description']);
      if (f.uniqueItems !== undefined && typeof f.uniqueItems !== 'boolean')
        throw new TypeError('Invalid uniqueItems');
    }
  } else if (f.type === 'boolean') keys(f, common);
  else if (f.type === 'number' || f.type === 'integer') {
    keys(f, [...common, 'minimum', 'maximum']);
    bounds(f, 'minimum', 'maximum');
  } else throw new TypeError('Unsupported form field');
  if (f['x-openai-input'] !== undefined) {
    if (f.uniqueItems !== undefined)
      throw new TypeError('Resource array does not support uniqueItems');
    const input = record(f['x-openai-input']);
    keys(input, [
      'type',
      'options',
      'userOptions',
      ...(f.type === 'array' ? ['selection'] : []),
    ]);
    if (!['file', 'resource'].includes(String(input.type)))
      throw new TypeError('Unsupported resource input');
    if (
      f.type === 'string'
        ? f.format !== 'uri'
        : f.type !== 'array' || record(f.items).format !== 'uri'
    )
      throw new TypeError('Resource picker requires URI fields');
    const resources = list(input.options);
    for (const r of resources) resource(r);
    const uris = resources.map((r) => record(r).uri);
    if (new Set(uris).size !== uris.length)
      throw new TypeError('Duplicate resource');
    if (
      input.selection !== undefined &&
      !['explicit', 'implicit'].includes(String(input.selection))
    )
      throw new TypeError('Invalid selection');
    if (input.userOptions !== undefined) {
      const u = record(input.userOptions);
      keys(u, ['kind', 'accept']);
      if (
        u.kind !== undefined &&
        !['file', 'directory'].includes(String(u.kind))
      )
        throw new TypeError('Invalid resource kind');
      if (u.accept !== undefined) stringList(u.accept, 16);
    }
    if (
      f.default !== undefined &&
      (input.selection === 'implicit' ||
        (Array.isArray(f.default) ? f.default : [f.default]).some(
          (x) => !uris.includes(x),
        ))
    )
      throw new TypeError('Invalid resource default');
  }
  if (f.default !== undefined) validateValue(f, f.default);
}
/** Parse a detached inert snapshot. Unknown semantics are rejected, never stripped. */
export function validateOpenAiForm(value: unknown): OpenAiForm {
  boundedJson(value);
  const form = record(value);
  keys(form, ['$schema', 'type', 'properties', 'required']);
  optionalText(form, ['$schema'], 256);
  if (form.type !== 'object') throw new TypeError('Expected form object');
  const properties = record(form.properties);
  if (Object.keys(properties).length > 64)
    throw new TypeError('Too many form fields');
  for (const [name, f] of Object.entries(properties)) {
    text(name, 128);
    field(f);
  }
  if (form.required !== undefined) {
    const required = stringList(form.required);
    if (
      new Set(required).size !== required.length ||
      required.some((name) => !Object.hasOwn(properties, name))
    )
      throw new TypeError('Invalid required fields');
  }
  return structuredClone(value) as OpenAiForm;
}
function validateValue(f: Record<string, unknown>, value: unknown): void {
  if (f.type === 'array') {
    const a = stringList(value);
    if (
      a.length < Number(f.minItems ?? 0) ||
      a.length > Number(f.maxItems ?? 64) ||
      (f.uniqueItems === true && new Set(a).size !== a.length)
    )
      throw new TypeError('Invalid array value');
    const item = record(f.items);
    for (const v of a)
      validateValue(
        item.anyOf ? { type: 'string', oneOf: item.anyOf } : item,
        v,
      );
  } else if (f.type === 'string') {
    if (
      typeof value !== 'string' ||
      value.length > 4096 ||
      [...value].length < Number(f.minLength ?? 0) ||
      [...value].length > Number(f.maxLength ?? 4096)
    )
      throw new TypeError('Invalid string value');
    if (
      (f.enum && !stringList(f.enum).includes(value)) ||
      (f.oneOf && !list(f.oneOf).some((o) => record(o).const === value))
    )
      throw new TypeError('Unknown option');
    if (f.format === 'uri') uri(value);
    if (f.format === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))
      throw new TypeError('Invalid email');
    if (
      f.format === 'date' &&
      (!/^\d{4}-\d{2}-\d{2}$/.test(value) ||
        Number.isNaN(Date.parse(value)) ||
        new Date(value).toISOString().slice(0, 10) !== value)
    )
      throw new TypeError('Invalid date');
    if (
      f.format === 'date-time' &&
      (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
        value,
      ) ||
        Number.isNaN(Date.parse(value)))
    )
      throw new TypeError('Invalid date-time');
  } else if (f.type === 'boolean') {
    if (typeof value !== 'boolean')
      throw new TypeError('Invalid boolean value');
  } else if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    (f.type === 'integer' && !Number.isSafeInteger(value)) ||
    value < Number(f.minimum ?? -Infinity) ||
    value > Number(f.maximum ?? Infinity)
  )
    throw new TypeError('Invalid numeric value');
  if (f['x-openai-input']) {
    const input = record(f['x-openai-input']);
    if (
      input.selection !== 'implicit' &&
      input.userOptions === undefined &&
      (Array.isArray(value) ? value : [value]).some(
        (v) => !list(input.options).some((o) => record(o).uri === v),
      )
    )
      throw new TypeError('Resource not offered');
  }
}
/** Reply validation grants no file access, identity, or domain approval. */
export function validateOpenAiFormReply(
  schema: unknown,
  value: unknown,
): OpenAiFormReply {
  const form = validateOpenAiForm(schema);
  boundedJson(value);
  const reply = record(value);
  if (reply.action === 'cancel' || reply.action === 'decline') {
    keys(reply, ['action']);
    return { action: reply.action };
  }
  if (reply.action !== 'accept') throw new TypeError('Invalid form action');
  keys(reply, ['action', 'content']);
  const content = record(reply.content);
  if (
    Object.keys(content).some(
      (name) => !Object.hasOwn(form.properties, name),
    ) ||
    (form.required ?? []).some((name) => !Object.hasOwn(content, name))
  )
    throw new TypeError('Invalid form fields');
  for (const [name, v] of Object.entries(content))
    validateValue(record(form.properties[name]), v);
  return structuredClone(value) as OpenAiFormReply;
}
/** Enumerate selections for the owning live authorization callback, never fetch. */
export function formResourceSelections(
  schema: OpenAiForm,
  reply: OpenAiFormReply,
): string[] {
  if (reply.action !== 'accept') return [];
  return [
    ...new Set(
      Object.entries(schema.properties)
        .filter(([, f]) => 'x-openai-input' in f)
        .flatMap(([name]) => {
          const v = reply.content[name];
          return v === undefined ? [] : Array.isArray(v) ? v : [v as string];
        }),
    ),
  ];
}
/** SDK-v2 2.0.0 MRTR InputRequest union excludes openai/elicitation/create. */
export function openAiFormSupport(capabilities: unknown): {
  mode: 'application-form';
  native: false;
  reason: 'capability-absent' | 'capability-unknown' | 'sdk-mrtr-unsupported';
} {
  try {
    json(capabilities);
    const c = record(capabilities);
    const e = c.extensions === undefined ? {} : record(c.extensions);
    if (e['openai/elicitation'] === undefined)
      return {
        mode: 'application-form',
        native: false,
        reason: 'capability-absent',
      };
    const x = record(e['openai/elicitation']);
    if (x.form !== undefined) {
      const f = record(x.form);
      if (!Object.keys(f).length)
        return {
          mode: 'application-form',
          native: false,
          reason: 'sdk-mrtr-unsupported',
        };
    }
  } catch {}
  return {
    mode: 'application-form',
    native: false,
    reason: 'capability-unknown',
  };
}
