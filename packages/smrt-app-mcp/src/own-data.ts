/**
 * Own-data reads of application-supplied principal mappings (#3413 review
 * N1). Inherited values, accessors and prototype-poison keys never become
 * authority.
 *
 * @internal
 */

const FORBIDDEN_KEYS: ReadonlySet<string> = new Set([
  '__proto__',
  'constructor',
  'prototype',
]);

/**
 * The listed own data fields of a plain object (prototype `Object.prototype`
 * or `null`) in a null-prototype record, or `null` when `value` is not a
 * plain object, has an own `__proto__`/`constructor`/`prototype` key, or any
 * listed field is an accessor. Absent fields are omitted.
 */
export function readOwnFields(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === 'string' && FORBIDDEN_KEYS.has(key)) return null;
  }
  const fields = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    if (!descriptor) continue;
    if (!('value' in descriptor)) return null;
    fields[key] = descriptor.value;
  }
  return fields;
}

/**
 * A copy of a dense, plain array of strings read from own data properties,
 * or `null` for anything else (sparse, subclassed, extra keys, accessors,
 * non-strings).
 */
export function ownStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype)
    return null;
  const length = value.length;
  for (const key of Reflect.ownKeys(value)) {
    if (key === 'length') continue;
    if (
      typeof key !== 'string' ||
      !/^(?:0|[1-9][0-9]*)$/u.test(key) ||
      Number(key) >= length
    ) {
      return null;
    }
  }
  const copy: string[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, index);
    if (
      !descriptor ||
      !('value' in descriptor) ||
      typeof descriptor.value !== 'string'
    ) {
      return null;
    }
    copy.push(descriptor.value);
  }
  return copy;
}
