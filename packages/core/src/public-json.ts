/**
 * Finding an object's public serialiser.
 *
 * Request-facing paths serialise a model through `toPublicJSON()`, which
 * leaves out `sensitive` fields and the `readPermission` fields the caller may
 * not read. That method is inherited: it lives on the class, and these helpers
 * read it from the prototype chain only. An own property of the instance
 * called `toPublicJSON` — whatever put it there and whatever it holds — is
 * never the serialiser of an object whose class provides one.
 *
 * Import-free at runtime so emitted code, generators and the browser entry
 * share one definition.
 */

import type { PublicJsonOptions } from './object';

type PublicSerializer = (options?: PublicJsonOptions) => unknown;

/**
 * The public serialiser of `value`, bound to it, or `undefined` when it has
 * none.
 *
 * - An object whose class (anywhere up its prototype chain) defines
 *   `toPublicJSON` is serialised by that method.
 * - An object whose prototype chain says nothing about the name may carry the
 *   function itself; value objects returned by custom actions do.
 */
export function publicSerializerOf(
  value: unknown,
): PublicSerializer | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const prototype = Object.getPrototypeOf(value) as Record<
    string,
    unknown
  > | null;
  if (prototype !== null && 'toPublicJSON' in prototype) {
    const inherited = prototype.toPublicJSON;
    return typeof inherited === 'function'
      ? (options) => (inherited as PublicSerializer).call(value, options)
      : undefined;
  }
  const own = Object.getOwnPropertyDescriptor(value, 'toPublicJSON')?.value;
  return typeof own === 'function'
    ? (options) => (own as PublicSerializer).call(value, options)
    : undefined;
}

/**
 * Serialise `value` for a caller: its public projection when it has a public
 * serialiser, otherwise the value unchanged.
 */
export function toPublicJSONValue(
  value: unknown,
  options?: PublicJsonOptions,
): unknown {
  const serialize = publicSerializerOf(value);
  return serialize ? serialize(options) : value;
}

/**
 * Serialise a result that may hold models anywhere inside it: every object
 * with a public serialiser is replaced by its public projection, and arrays
 * and plain objects are walked. Other instances (a `Date`, a `Map`) and
 * primitives pass through.
 *
 * A container reached more than once (two properties naming one envelope)
 * is projected once and that projection reused, never returned as the
 * original: the original still holds the models, which `JSON.stringify`
 * would write with their ordinary `toJSON()`. A reference back into a
 * container still being projected (a cycle) becomes `null`.
 *
 * For values a transport returns to a caller — a custom action's result, an
 * envelope a custom serialiser built — whose nested models would otherwise be
 * written by their ordinary `toJSON()`.
 */
export function toPublicResultValue(
  value: unknown,
  options?: PublicJsonOptions,
  projected: WeakMap<object, unknown> = new WeakMap(),
): unknown {
  if (value === null || typeof value !== 'object') return value;
  const serialize = publicSerializerOf(value);
  if (serialize) return serialize(options);
  if (projected.has(value)) return projected.get(value);
  if (Array.isArray(value)) {
    projected.set(value, null);
    const out = value.map((entry) =>
      toPublicResultValue(entry, options, projected),
    );
    projected.set(value, out);
    return out;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;
  projected.set(value, null);
  const out = Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      toPublicResultValue(entry, options, projected),
    ]),
  );
  projected.set(value, out);
  return out;
}
