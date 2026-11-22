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
 * A field the caller may not write (read-only, outside the model's
 * `api.writable` allowlist, `_`-prefixed) is compared with the value the
 * loaded object holds: a value that would persist identically is accepted
 * and left unassigned, so a record read from the API can be sent back as is;
 * a different value is refused with {@link FieldNotWritableError}. On a
 * create there is no stored value, so any such field sent with a non-null
 * value is refused. Server-managed keys ({@link SERVER_MANAGED_WRITE_KEYS})
 * are skipped and never compared.
 *
 * This module is the rule itself and knows no registry, so the structural
 * sync processor and browser code can use it. `request-input.ts` binds it to
 * a registered model.
 */

import { ValidationError } from './errors';
import { isServiceOptionInput } from './service-options';
import { jsonValuesEqual, parseJsonContainerText } from './utils/json-equal';

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

/** Code of {@link FieldNotWritableError}. */
export const FIELD_NOT_WRITABLE_CODE = 'VALIDATION_FIELD_NOT_WRITABLE';

/**
 * A write that changes a field the caller may not write: a read-only field, a
 * field outside the model's `api.writable` allowlist, or a `_`-prefixed key.
 * `details.field` names it.
 */
export class FieldNotWritableError extends WriteInputError {
  constructor(field: string) {
    super(`Field '${field}' cannot be written.`, FIELD_NOT_WRITABLE_CODE, {
      field,
    });
    this.name = 'FieldNotWritableError';
  }
}

/**
 * Whether `error` is a refused write key (unknown, or not writable by the
 * caller), without relying on `instanceof`.
 */
export function isWriteInputError(error: unknown): error is WriteInputError {
  if (!error || typeof error !== 'object') return false;
  const code = (error as { code?: unknown }).code;
  return (
    (code === 'VALIDATION_UNKNOWN_FIELD' || code === FIELD_NOT_WRITABLE_CODE) &&
    (error as { status?: unknown }).status === 400
  );
}

/**
 * The field a refused write names, when the error is a
 * {@link FieldNotWritableError}.
 */
export function notWritableFieldOf(error: unknown): string | undefined {
  if (!isWriteInputError(error) || error.code !== FIELD_NOT_WRITABLE_CODE) {
    return undefined;
  }
  const field = (error as { details?: { field?: unknown } }).details?.field;
  return typeof field === 'string' ? field : undefined;
}

/**
 * Keys the server writes and a write body never sets: the row id, the tenant,
 * the timestamps and the STI discriminator columns. A body read from the API
 * carries them; they are skipped and never compared, so a concurrent change
 * to them (an `updatedAt` bump) never refuses a write.
 */
export const SERVER_MANAGED_WRITE_KEYS: readonly string[] = Object.freeze([
  'id',
  'tenantId',
  'tenant_id',
  'createdAt',
  'created_at',
  'updatedAt',
  'updated_at',
  '_meta_type',
  '_meta_data',
]);

const SERVER_MANAGED_KEY_SET: ReadonlySet<string> = new Set(
  SERVER_MANAGED_WRITE_KEYS,
);

/** Whether `key` is one of {@link SERVER_MANAGED_WRITE_KEYS}. */
export function isServerManagedWriteKey(key: string): boolean {
  return SERVER_MANAGED_KEY_SET.has(key);
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
   * Keys the model writes into its own output and never stores
   * (`displayLabel`): a body read from the API carries them, and they are
   * skipped without an error or a comparison.
   */
  isEmittedOnly?(key: string): boolean;
  /**
   * Keys the caller may not write: read-only fields, keys outside the model's
   * `api.writable` allowlist, `_`-prefixed keys. Such a key is accepted only
   * when its value equals the value the object holds ({@link sameValue}),
   * and is then left unassigned; otherwise the body is refused with
   * {@link FieldNotWritableError}.
   */
  isProtected?(key: string): boolean;
  /**
   * Whether the caller can read `key` of the stored object in its own
   * response. A protected key the caller cannot read is never compared with
   * the stored value (the answer would confirm a guess of a value the caller
   * may not see): it refuses the body whatever its value. Defaults to
   * readable.
   */
  isReadable?(key: string): boolean;
  /**
   * Whether `incoming` would persist as the value `stored` holds for `key`.
   * Defaults to {@link sameStoredValue} without a declared type.
   */
  sameValue?(key: string, stored: unknown, incoming: unknown): boolean;
}

/**
 * The value an object holds under `key`, as a protected-field comparison
 * reads it: a method or a throwing accessor holds nothing a body can match.
 */
export function storedValueOf(target: object, key: string): unknown {
  if (key === '__proto__' || key in Object.prototype) {
    return STORED_UNMATCHABLE;
  }
  try {
    const value = Reflect.get(target, key) as unknown;
    return typeof value === 'function' ? STORED_UNMATCHABLE : value;
  } catch {
    return STORED_UNMATCHABLE;
  }
}

/** A stored value no incoming value equals. */
const STORED_UNMATCHABLE: unique symbol = Symbol('smrt.unmatchable');

function epochOf(value: unknown): number | undefined {
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isNaN(time) ? undefined : time;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const time = Date.parse(value);
    return Number.isNaN(time) ? undefined : time;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return undefined;
}

function numberOf(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isNaN(value) ? undefined : value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  return undefined;
}

function booleanOf(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (value === 1 || value === '1' || value === 'true' || value === 1n) {
    return true;
  }
  if (value === 0 || value === '0' || value === 'false' || value === 0n) {
    return false;
  }
  return undefined;
}

/**
 * Whether an incoming body value would persist as the value an object holds,
 * after the normalisation the write path applies for the field's declared
 * `type`:
 *
 * - `null` and `undefined` are both an absent value (`NULL`).
 * - `datetime`: the same instant, whether a `Date` or an ISO string.
 * - `integer` / `decimal`: the same number, whether a number, a bigint or a
 *   numeric string (PostgreSQL returns `numeric` and `int8` as strings).
 * - `boolean`: `true`/`false`, `1`/`0` and their string forms (SQLite stores
 *   booleans as integers).
 * - `json`: the same value in its JSON form, object keys in any order
 *   (PostgreSQL `jsonb` does not keep key order), JSON text decoded first
 *   (`jsonValuesEqual`).
 * - anything else: the same primitive, or the same JSON-form structure.
 */
export function sameStoredValue(
  type: string | undefined,
  stored: unknown,
  incoming: unknown,
): boolean {
  if (stored === STORED_UNMATCHABLE) return false;
  if (stored == null || incoming == null) {
    return stored == null && incoming == null;
  }
  switch (type?.toLowerCase()) {
    case 'datetime':
    case 'date':
    case 'timestamp': {
      const a = epochOf(stored);
      if (a !== undefined) return a === epochOf(incoming);
      break;
    }
    case 'integer':
    case 'decimal':
    case 'real':
    case 'number': {
      const a = numberOf(stored);
      if (a !== undefined) return a === numberOf(incoming);
      break;
    }
    case 'boolean': {
      const a = booleanOf(stored);
      if (a !== undefined) return a === booleanOf(incoming);
      break;
    }
    case 'json':
      return jsonValuesEqual(
        parseJsonContainerText(stored),
        parseJsonContainerText(incoming),
      );
  }
  if (stored instanceof Date) {
    const a = epochOf(stored);
    return a !== undefined && a === epochOf(incoming);
  }
  if (typeof stored !== 'object' && typeof incoming !== 'object') {
    return stored === incoming;
  }
  return jsonValuesEqual(stored, incoming);
}

/**
 * Check one key the caller may not write against the value `target` holds.
 *
 * @param sameValue - The model's comparison (see
 *   {@link UpdateInputRules.sameValue}); untyped {@link sameStoredValue} when
 *   omitted
 * @throws {FieldNotWritableError} when `incoming` would change it
 */
export function assertProtectedUnchanged(
  target: object,
  key: string,
  incoming: unknown,
  sameValue?: UpdateInputRules['sameValue'],
): void {
  const stored = storedValueOf(target, key);
  const same =
    stored !== STORED_UNMATCHABLE &&
    (sameValue
      ? sameValue(key, stored, incoming)
      : sameStoredValue(undefined, stored, incoming));
  if (!same) throw new FieldNotWritableError(key);
}

/** What a write path knows about the fields of the model it writes. */
export interface WriteBodyPolicy {
  /**
   * Keys the caller may not write: read-only fields, keys outside the
   * model's `api.writable` allowlist, `_`-prefixed keys.
   */
  isProtected(key: string): boolean;
  /**
   * Whether the caller can read `key` of the stored object in its own
   * response; see {@link UpdateInputRules.isReadable}. Only consulted on an
   * update. Defaults to readable.
   */
  isReadable?(key: string): boolean;
  /**
   * Keys skipped without a comparison besides
   * {@link SERVER_MANAGED_WRITE_KEYS}: keys that configure a service of the
   * object, keys the model only writes into its output (`displayLabel`).
   */
  isSkipped?(key: string): boolean;
  /** See {@link UpdateInputRules.sameValue}. */
  sameValue?(key: string, stored: unknown, incoming: unknown): boolean;
}

/**
 * The write body a request-facing write path hands to its model: the one
 * rule runtime REST, the generated SvelteKit routes and sync apply share.
 *
 * - {@link SERVER_MANAGED_WRITE_KEYS} and the keys `policy.isSkipped` names
 *   are left out and never compared.
 * - A key the caller may not write (`policy.isProtected`):
 *   - on an update, a key the caller cannot read (`policy.isReadable`) refuses
 *     the body whatever its value, since comparing it would confirm guesses;
 *   - on an update (`stored` given), is left out when its value would
 *     persist as the stored value, so a record read from the API can be sent
 *     back as is, and refuses the body otherwise;
 *   - on a create (no `stored`), refuses the body when sent with a non-null
 *     value, since there is no stored value to match, and is left out when
 *     null.
 * - Every other key is kept, for the declared-field check that follows.
 *
 * @param stored - The loaded object an update targets; omit for a create
 * @throws {FieldNotWritableError} naming the first protected key the body
 *   would set or change
 */
export function resolveWriteBody(
  data: unknown,
  policy: WriteBodyPolicy,
  stored?: object,
): Record<string, unknown> {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (isServerManagedWriteKey(key)) continue;
    if (policy.isSkipped?.(key)) continue;
    if (policy.isProtected(key)) {
      if (stored) {
        // A key the caller cannot read is never compared: the answer would
        // confirm a guess of a value they may not see.
        if (policy.isReadable && !policy.isReadable(key))
          throw new FieldNotWritableError(key);
        assertProtectedUnchanged(stored, key, value, policy.sameValue);
      } else if (value != null) throw new FieldNotWritableError(key);
      continue;
    }
    result[key] = value;
  }
  return result;
}

/**
 * The keys of `data` an update may assign onto `target`, in order.
 *
 * A key the caller may not write ({@link UpdateInputRules.isProtected}) whose
 * value equals what `target` holds is accepted and left out; one whose value
 * differs refuses the body.
 *
 * @throws {WriteInputError} naming the first key that may not be set
 * @throws {FieldNotWritableError} naming the first protected key the body
 *   would change
 */
export function resolveUpdateInput(
  target: object,
  data: Record<string, unknown>,
  rules: UpdateInputRules,
): string[] {
  const keys: string[] = [];
  for (const key of Object.keys(data)) {
    if (rules.isEmittedOnly?.(key)) continue;
    if (rules.isProtected?.(key)) {
      if (rules.isReadable && !rules.isReadable(key))
        throw new FieldNotWritableError(key);
      assertProtectedUnchanged(target, key, data[key], rules.sameValue);
      continue;
    }
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
  const accessors = keys.filter(
    (key) => classifyUpdateKey(target, key) === 'accessor',
  );
  // A settable accessor writes through to other fields: a protected field
  // must hold the value it had, whatever key the body used to reach it.
  const guarded = accessors.length ? protectedFieldsOf(target, rules) : [];
  if (!guarded.length) {
    for (const key of keys) writable[key] = data[key];
    return;
  }
  const unreadable = guarded.filter((key) => rules.isReadable?.(key) === false);
  const declared = Object.keys(target).filter(
    (key) =>
      !key.startsWith('_') &&
      !isServerManagedWriteKey(key) &&
      rules.declaresField(key),
  );
  const before = new Map(
    declared.map((key) => [key, storedValueOf(target, key)] as const),
  );

  // A field the caller cannot read must not answer by its value: the outcome
  // may not tell an equal assignment from a different one. Any assignment to
  // it while the body is applied is caught by a trap on the instance, and
  // refuses the body. A field that cannot be trapped refuses the accessor.
  const originals = new Map<string, PropertyDescriptor>();
  let assigned = false;
  for (const key of unreadable) {
    const descriptor = Object.getOwnPropertyDescriptor(target, key);
    if (!descriptor || !('value' in descriptor) || !descriptor.configurable) {
      throw new FieldNotWritableError(accessors[0]);
    }
    originals.set(key, descriptor);
  }
  try {
    for (const [key, descriptor] of originals) {
      Object.defineProperty(target, key, {
        configurable: true,
        enumerable: descriptor.enumerable,
        get: () => descriptor.value,
        set: () => {
          assigned = true;
        },
      });
    }
    for (const key of keys) writable[key] = data[key];
  } finally {
    for (const [key, descriptor] of originals) {
      Object.defineProperty(target, key, descriptor);
    }
  }

  let refused: string | undefined;
  if (assigned) {
    // The same answer for every value, and no hidden field named.
    refused = accessors[0];
  } else {
    for (const key of guarded) {
      if (originals.has(key)) continue;
      const was = before.get(key);
      const now = storedValueOf(target, key);
      if (now === was) continue;
      const same =
        was !== STORED_UNMATCHABLE &&
        (rules.sameValue
          ? rules.sameValue(key, was, now)
          : sameStoredValue(undefined, was, now));
      if (!same) {
        refused = key;
        break;
      }
    }
  }
  if (refused === undefined) return;
  // A refused body changes nothing: put every declared field back.
  for (const [name, value] of before) {
    if (value === STORED_UNMATCHABLE) continue;
    try {
      writable[name] = value;
    } catch {
      // A field that refuses assignment was not changed through one.
    }
  }
  throw new FieldNotWritableError(refused);
}

/** The declared fields of `target` the caller may not write. */
function protectedFieldsOf(target: object, rules: UpdateInputRules): string[] {
  if (!rules.isProtected) return [];
  return Object.keys(target).filter(
    (key) =>
      !key.startsWith('_') &&
      !isServerManagedWriteKey(key) &&
      rules.declaresField(key) &&
      rules.isProtected?.(key),
  );
}

/**
 * Rules for an object nothing is registered about: its own plain properties
 * and its settable accessors.
 */
export const STRUCTURAL_UPDATE_RULES: UpdateInputRules = Object.freeze({
  declaresField: () => false,
  hasFieldMetadata: false,
});
