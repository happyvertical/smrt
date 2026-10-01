import { json, keys, record, text, toolName } from './validation.js';
export type SettingSchema = { title: string; description?: string } & (
  | { type: 'boolean' }
  | {
      type: 'string';
      enum?: string[];
      minLength?: number;
      maxLength?: number;
      pattern?: string;
    }
  | {
      type: 'number' | 'integer';
      minimum?: number;
      maximum?: number;
      multipleOf?: number;
    }
);
export interface SettingsSchema {
  type: 'object';
  properties: Record<string, SettingSchema>;
  required?: string[];
}
export interface SettingsGroup {
  kind: 'group';
  title: string;
  items: (
    | { kind: 'property'; property: string }
    | { kind: 'tool'; tool: string; title: string; description?: string }
  )[];
}
export interface SettingsReadResult {
  schema: SettingsSchema;
  values: Record<string, string | number | boolean>;
  layout?: SettingsGroup[];
}
/** Bounded primitive-only settings, matching the pinned extension schema. */
export function validateSettingsSchema(value: unknown): SettingsSchema {
  json(value);
  const schema = record(value);
  keys(schema, ['type', 'properties', 'required']);
  if (schema.type !== 'object')
    throw new TypeError('Settings schema must be an object');
  const properties = record(schema.properties);
  if (Object.keys(properties).length > 64)
    throw new TypeError('Too many settings');
  for (const [name, raw] of Object.entries(properties)) {
    text(name, 128);
    const property = record(raw);
    text(property.title, 256);
    if (property.description !== undefined) text(property.description, 2048);
    const common = ['type', 'title', 'description'];
    if (property.type === 'boolean') keys(property, common);
    else if (property.type === 'string') {
      keys(property, [...common, 'enum', 'minLength', 'maxLength', 'pattern']);
      if (
        property.enum !== undefined &&
        (!Array.isArray(property.enum) ||
          !property.enum.length ||
          property.enum.length > 64 ||
          property.enum.some((v) => typeof v !== 'string' || v.length > 4096) ||
          new Set(property.enum).size !== property.enum.length)
      )
        throw new TypeError('Invalid settings enum');
      for (const bound of ['minLength', 'maxLength'])
        if (
          property[bound] !== undefined &&
          (!Number.isSafeInteger(property[bound]) ||
            Number(property[bound]) < 0 ||
            Number(property[bound]) > 4096)
        )
          throw new TypeError('Invalid string bound');
      if (Number(property.minLength ?? 0) > Number(property.maxLength ?? 4096))
        throw new TypeError('Invalid string bounds');
      // Arbitrary regex execution is deliberately excluded from this first adapter.
      if (property.pattern !== undefined)
        throw new TypeError(
          'Settings patterns are unsupported; use enum or the owning validator',
        );
    } else if (property.type === 'number' || property.type === 'integer') {
      keys(property, [...common, 'minimum', 'maximum', 'multipleOf']);
      for (const bound of ['minimum', 'maximum', 'multipleOf'])
        if (
          property[bound] !== undefined &&
          (typeof property[bound] !== 'number' ||
            !Number.isFinite(property[bound]))
        )
          throw new TypeError('Invalid numeric bound');
      if (
        Number(property.minimum ?? -Infinity) >
          Number(property.maximum ?? Infinity) ||
        Number(property.multipleOf ?? 1) <= 0
      )
        throw new TypeError('Invalid numeric bounds');
    } else throw new TypeError('Unsupported setting type');
  }
  if (
    schema.required !== undefined &&
    (!Array.isArray(schema.required) ||
      new Set(schema.required).size !== schema.required.length ||
      schema.required.some(
        (key) => typeof key !== 'string' || !Object.hasOwn(properties, key),
      ))
  )
    throw new TypeError('Invalid required settings');
  return structuredClone(value) as SettingsSchema;
}
export function validateSettingsValues(
  value: unknown,
  schema: SettingsSchema,
  partial = false,
): Record<string, string | number | boolean> {
  json(value);
  const values = record(value);
  if (
    !partial &&
    Object.keys(schema.properties).some((key) => !Object.hasOwn(values, key))
  )
    throw new TypeError('Missing effective settings value');
  for (const [key, v] of Object.entries(values)) {
    if (!Object.hasOwn(schema.properties, key))
      throw new TypeError('Unknown setting');
    const property = schema.properties[key];
    if (property.type === 'boolean') {
      if (typeof v !== 'boolean')
        throw new TypeError('Invalid boolean setting');
    } else if (property.type === 'string') {
      if (
        typeof v !== 'string' ||
        [...v].length < (property.minLength ?? 0) ||
        [...v].length > (property.maxLength ?? 4096) ||
        (property.enum && !property.enum.includes(v))
      )
        throw new TypeError('Invalid string setting');
    } else {
      if (
        typeof v !== 'number' ||
        !Number.isFinite(v) ||
        (property.type === 'integer' && !Number.isSafeInteger(v)) ||
        v < (property.minimum ?? -Infinity) ||
        v > (property.maximum ?? Infinity)
      )
        throw new TypeError('Invalid numeric setting');
      if (property.multipleOf !== undefined) {
        const ratio = v / property.multipleOf;
        if (
          Math.abs(ratio - Math.round(ratio)) >
          Number.EPSILON * Math.max(1, Math.abs(ratio)) * 4
        )
          throw new TypeError('Invalid setting multiple');
      }
    }
  }
  return structuredClone(values) as Record<string, string | number | boolean>;
}
/** Object key order is immaterial; array order remains part of the contract. */
function canonicalSchema(value: unknown): string {
  return JSON.stringify(value, (_key, item) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        )
      : item,
  );
}
export function validateSettingsRead(
  value: unknown,
  expectedSchema?: SettingsSchema,
): SettingsReadResult {
  json(value);
  const result = record(value);
  keys(result, ['schema', 'values', 'layout']);
  const schema = validateSettingsSchema(result.schema);
  if (
    expectedSchema &&
    canonicalSchema(schema) !== canonicalSchema(expectedSchema)
  )
    throw new TypeError('Settings schema changed unexpectedly');
  const values = validateSettingsValues(result.values, schema);
  if (result.layout !== undefined) {
    if (!Array.isArray(result.layout) || result.layout.length > 32)
      throw new TypeError('Invalid settings layout');
    const seen = new Set<string>();
    for (const raw of result.layout) {
      const group = record(raw);
      keys(group, ['kind', 'title', 'items']);
      if (
        group.kind !== 'group' ||
        !Array.isArray(group.items) ||
        group.items.length > 64
      )
        throw new TypeError('Invalid settings group');
      text(group.title, 256);
      for (const rawItem of group.items) {
        const item = record(rawItem);
        if (item.kind === 'property') {
          keys(item, ['kind', 'property']);
          const name = text(item.property, 128);
          if (!Object.hasOwn(schema.properties, name) || seen.has(name))
            throw new TypeError('Unknown or duplicate layout property');
          seen.add(name);
        } else if (item.kind === 'tool') {
          keys(item, ['kind', 'tool', 'title', 'description']);
          toolName(item.tool);
          text(item.title, 256);
          if (item.description !== undefined) text(item.description, 2048);
        } else throw new TypeError('Unknown settings layout kind');
      }
    }
  }
  return {
    schema,
    values,
    ...(result.layout === undefined
      ? {}
      : { layout: structuredClone(result.layout) as SettingsGroup[] }),
  };
}
