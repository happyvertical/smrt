/**
 * Transport kernel: write input (#5158). Owned by K3; the allowlist is
 * switched on here by F2 and nowhere else.
 */
import type { SmrtObject } from '../object.js';
import { notImplemented } from './not-implemented.js';
import type { TransportModel, WritableField } from './types.js';

/**
 * The fields a caller may write on create or update.
 *
 * Contract: declared scalar, foreign-key, cross-package-reference and `@meta`
 * fields; `slug` and `context` on create; write-through fields; declared
 * input fields. Never `readonly`, generated, relationship, system, tenant or
 * `_`-prefixed names. Intersected with `api.writable` when the model sets it.
 * Own and inherited fields both count. Memoised per registry generation.
 */
export function resolveWritableFields(
  _model: TransportModel,
  _operation: 'create' | 'update',
): ReadonlyMap<string, WritableField> {
  return notImplemented('resolveWritableFields', 'K3');
}

/**
 * Reduce an untrusted body to the keys the model accepts.
 *
 * Contract:
 * - Anything that is not a plain record is refused, arrays included.
 * - Only own enumerable keys are read. `__proto__`, `constructor` and
 *   `prototype` are never accepted.
 * - Keys the model can return but not accept (system, readonly, generated,
 *   `displayLabel`) are dropped silently, so a get-modify-put round trip
 *   works. Any other unknown key is `VALIDATION_UNKNOWN_FIELD`.
 * - Returns a new object; no caller-supplied object is passed on.
 * - While `model.profile.write` is present, applies that transport's filter
 *   exactly, including which keys it leaves alone.
 */
export function filterWriteInput(
  _model: TransportModel,
  _operation: 'create' | 'update',
  _body: unknown,
): Record<string, unknown> {
  return notImplemented('filterWriteInput', 'K3');
}

/**
 * Apply filtered input to an existing instance.
 *
 * Contract: assigns own keys of `data` only, through the instance's setters,
 * and never a key that names a method or an accessor without a setter. The
 * caller saves.
 */
export function applyWriteInput(
  _instance: SmrtObject,
  _data: Record<string, unknown>,
): void {
  notImplemented('applyWriteInput', 'K3');
}
