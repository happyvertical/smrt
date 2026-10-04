/**
 * Hardened copies of caller-supplied plain data (#3413 review N1).
 *
 * Every copy is built from own data properties only, into null-prototype
 * objects and fresh dense arrays, and deep-frozen. It rejects, at every
 * depth: the keys `__proto__`, `constructor` and `prototype`; accessor
 * properties (getters are never invoked); objects whose prototype is not
 * `Object.prototype` or `null` (class instances, objects inheriting data);
 * arrays that are sparse, subclassed or carry extra own keys; functions; and
 * nesting deeper than {@link MAX_PLAIN_DATA_DEPTH}. Non-enumerable own
 * properties are dropped.
 *
 * @internal
 */

/** Keys that can rewrite a prototype or impersonate a constructor. */
export const FORBIDDEN_DATA_KEYS: ReadonlySet<string> = new Set([
  '__proto__',
  'constructor',
  'prototype',
]);

/** Deepest accepted nesting. */
export const MAX_PLAIN_DATA_DEPTH = 8;

/** Thrown for input that is not acceptable plain data. */
export class PlainDataError extends Error {
  override readonly name = 'PlainDataError';
}

/** Deep-frozen copy of `value`, or a {@link PlainDataError}. */
export function deepFrozenPlainCopy(value: unknown, depth = 0): unknown {
  if (typeof value === 'function') {
    throw new PlainDataError('may contain only plain data');
  }
  if (value === null || typeof value !== 'object') return value;
  if (depth > MAX_PLAIN_DATA_DEPTH) {
    throw new PlainDataError('is nested too deeply');
  }
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) {
      throw new PlainDataError('may contain only plain arrays');
    }
    const length = value.length;
    for (const key of Reflect.ownKeys(value)) {
      if (key === 'length') continue;
      if (
        typeof key !== 'string' ||
        !/^(?:0|[1-9][0-9]*)$/u.test(key) ||
        Number(key) >= length
      ) {
        throw new PlainDataError('may contain only plain arrays');
      }
    }
    const copy: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = Reflect.getOwnPropertyDescriptor(value, index);
      if (!descriptor || !('value' in descriptor)) {
        throw new PlainDataError('may contain only dense data arrays');
      }
      Object.defineProperty(copy, index, {
        value: deepFrozenPlainCopy(descriptor.value, depth + 1),
        enumerable: true,
        writable: false,
        configurable: false,
      });
    }
    return Object.freeze(copy);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new PlainDataError('may contain only plain data');
  }
  const copy = Object.create(null) as Record<PropertyKey, unknown>;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === 'string' && FORBIDDEN_DATA_KEYS.has(key)) {
      throw new PlainDataError(`may not contain the key ${key}`);
    }
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable) continue;
    if (!('value' in descriptor)) {
      throw new PlainDataError('may not contain accessor properties');
    }
    Object.defineProperty(copy, key, {
      value: deepFrozenPlainCopy(descriptor.value, depth + 1),
      enumerable: true,
      writable: false,
      configurable: false,
    });
  }
  return Object.freeze(copy);
}

/** Own data value of `key` on a copy made by {@link deepFrozenPlainCopy}. */
export function ownValue(record: object, key: PropertyKey): unknown {
  return Object.hasOwn(record, key)
    ? (record as Record<PropertyKey, unknown>)[key]
    : undefined;
}
