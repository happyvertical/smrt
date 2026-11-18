/**
 * Transport kernel: public projection (#5158). Owned by K6; prototype-checked
 * projection is switched on here by F2 and nowhere else.
 */
import { notImplemented } from './not-implemented.js';
import type { Principal, TransportModel } from './types.js';

/**
 * Reduce a value to what the caller may read.
 *
 * Contract:
 * - A `SmrtObject` becomes `toPublicJSON({ permissions })` with the caller's
 *   field permissions: no sensitive field, and no `readPermission` field the
 *   caller lacks. Recognised by its prototype chain.
 * - Arrays and plain objects are walked; a `SmrtObject` anywhere inside is
 *   projected the same way. Other instances (`Date`, `Map`) pass through.
 * - A reference cycle ends in `null`; the walk always terminates.
 * - Never calls `toJSON()` on a `SmrtObject`.
 * - With `model`, a plain object returned by a custom serialiser also has that
 *   model's permission-gated field names removed.
 * - While `model.profile.serialize` is present, projects as that transport
 *   does today.
 */
export function toPublic(
  _value: unknown,
  _principal: Principal,
  _model?: TransportModel,
): unknown {
  return notImplemented('toPublic', 'K6');
}
