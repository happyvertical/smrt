/**
 * What an update body may set on a loaded object.
 *
 * An update assigns request keys onto a live instance, and an instance has
 * more on it than fields: its methods, its serialisers and its `constructor`
 * all live on the prototype chain, where an assignment creates an own property
 * that hides them. So a key is assigned only when it names something made to
 * be set:
 *
 * - a field the model declares, or
 * - an accessor with a setter (models take derived input through getter/setter
 *   pairs, and `slug` / `context` are accessors of every object).
 *
 * A key that names a method, an accessor without a setter, a member of
 * `Object.prototype`, or nothing the model declares is refused with
 * {@link WriteInputError}, a typed 400 that names the key.
 *
 * This module is the rule itself and knows no registry, so the structural
 * sync processor and browser code can use it. `request-input.ts` binds it to
 * a registered model.
 */

import { ValidationError } from './errors';
import { isServiceOptionInput } from './service-options';

/**
 * An update key that cannot be set on the object.
 *
 * Extends `ValidationError` so the retry classifier never retries it, and
 * carries `status` / `publicMessage` so `normalizeTypedHttpError()` renders it
 * as a structured 400 and MCP reports it as a tool failure with a code.
 */
export class WriteInputError extends ValidationError {
  readonly status = 400;
  readonly publicMessage: string;

  constructor(
    message: string,
    code = 'VALIDATION_UNKNOWN_FIELD',
    details?: Record<string, unknown>,
  ) {
    super(message, code, details);
    this.name = 'WriteInputError';
    this.publicMessage = message;
  }
}

/** Whether `error` is a refused update key, without relying on `instanceof`. */
export function isWriteInputError(error: unknown): error is WriteInputError {
  return (
    !!error &&
    typeof error === 'object' &&
    (error as { code?: unknown }).code === 'VALIDATION_UNKNOWN_FIELD' &&
    (error as { status?: unknown }).status === 400
  );
}

/**
 * How an object answers an assignment to `key`.
 *
 * - `'accessor'`: a setter runs (on the prototype chain, or installed on the
 *   instance itself).
 * - `'data'`: the instance already holds a plain, writable value under it.
 * - `'absent'`: nothing answers to the name yet; an assignment would create
 *   an own property.
 * - `'refused'`: the name belongs to a method, an accessor without a setter, a
 *   read-only property, or `Object.prototype`.
 */
export type UpdateKeyKind = 'accessor' | 'data' | 'absent' | 'refused';

/**
 * Classify an assignment of `key` on `target` by what it would reach.
 *
 * The prototype chain is read first: whatever a class defines under a name
 * decides, even when an earlier write has already put an own property over
 * it. `Object.prototype` is never walked; every name it carries is refused.
 */
export function classifyUpdateKey(target: object, key: string): UpdateKeyKind {
  if (key === '__proto__' || key in Object.prototype) return 'refused';

  for (
    let proto: object | null = Object.getPrototypeOf(target);
    proto && proto !== Object.prototype;
    proto = Object.getPrototypeOf(proto)
  ) {
    const descriptor = Object.getOwnPropertyDescriptor(proto, key);
    if (!descriptor) continue;
    // A prototype data property is a method or a shared constant.
    return descriptor.set ? 'accessor' : 'refused';
  }

  const own = Object.getOwnPropertyDescriptor(target, key);
  if (!own) return 'absent';
  if (own.get || own.set) return own.set ? 'accessor' : 'refused';
  if (typeof own.value === 'function' || own.writable === false) {
    return 'refused';
  }
  return 'data';
}

/** What is known about the model an update targets. */
export interface UpdateInputRules {
  /** Whether the model, or one of its ancestors, declares `key` as a field. */
  declaresField(key: string): boolean;
  /**
   * False when the model has no registered field at all (an unscanned inline
   * class, a structural row). The instance's own plain properties then stand
   * in for the declaration: they are what its class initialised.
   */
  hasFieldMetadata: boolean;
  /**
   * Keys the model never accepts in an update but a body may carry: keys it
   * writes into its own output (`displayLabel`) and keys its write policy
   * withholds (read-only fields, keys outside its `api.writable` allowlist).
   * They are skipped without an error, as each route's own policy skips them,
   * so a body read from the API can be sent back unchanged.
   */
  isEmittedOnly?(key: string): boolean;
}

/**
 * The keys of `data` an update may assign onto `target`, in order.
 *
 * @throws {WriteInputError} naming the first key that may not be set
 */
export function resolveUpdateInput(
  target: object,
  data: Record<string, unknown>,
  rules: UpdateInputRules,
): string[] {
  const keys: string[] = [];
  for (const key of Object.keys(data)) {
    if (rules.isEmittedOnly?.(key)) continue;
    const kind = classifyUpdateKey(target, key);
    const allowed =
      kind !== 'refused' &&
      // `options` and the keys that configure a service are never row data
      // unless the model declares a field of that name.
      !isServiceOptionInput(key, rules.declaresField) &&
      (kind === 'accessor' ||
        rules.declaresField(key) ||
        (kind === 'data' && !rules.hasFieldMetadata));
    if (!allowed) {
      throw new WriteInputError(
        `Field '${key}' cannot be set.`,
        'VALIDATION_UNKNOWN_FIELD',
        { field: key },
      );
    }
    keys.push(key);
  }
  return keys;
}

/**
 * Assign an update body onto `target`, setting declared fields and settable
 * accessors only. Every key is checked before the first one is assigned, so a
 * refused body changes nothing.
 *
 * @throws {WriteInputError} naming the first key that may not be set
 */
export function assignUpdateInput(
  target: object,
  data: Record<string, unknown>,
  rules: UpdateInputRules,
): void {
  const keys = resolveUpdateInput(target, data, rules);
  const writable = target as Record<string, unknown>;
  for (const key of keys) writable[key] = data[key];
}

/**
 * Rules for an object nothing is registered about: its own plain properties
 * and its settable accessors.
 */
export const STRUCTURAL_UPDATE_RULES: UpdateInputRules = Object.freeze({
  declaresField: () => false,
  hasFieldMetadata: false,
});
