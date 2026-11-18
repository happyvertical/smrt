/**
 * Transport kernel: list queries (#5158). Owned by K4; caller-aware field
 * access is switched on here by F4 and nowhere else.
 */
import { notImplemented } from './not-implemented.js';
import type {
  ListInput,
  ListQuery,
  Principal,
  TransportModel,
} from './types.js';

/**
 * Validate untrusted list arguments.
 *
 * Contract:
 * - `limit` and `offset` go through the shared bounds parser: default 50,
 *   ceiling 1000, a typed 400 for anything that is not a non-negative integer.
 * - `where` is a record (AND) or a DNF array of non-empty arrays of records
 *   (outer OR, inner AND). Every branch is walked; an empty branch is refused.
 * - Every filter and sort key is normalised to its column before any check,
 *   so two spellings of one column cannot both be given.
 * - A key the caller may not read is refused with the same
 *   `QUERY_FIELD_NOT_ALLOWED` as a key that does not exist. Sensitive fields
 *   are never filterable or sortable.
 * - A key that normalises to the tenant column is refused.
 * - With no caller ordering, the result is ordered by `created_at DESC` and
 *   then the primary key.
 * - While `model.profile.query` is present, parses as that transport does
 *   today.
 */
export function parseListQuery(
  _model: TransportModel,
  _principal: Principal,
  _raw: ListInput,
): ListQuery {
  return notImplemented('parseListQuery', 'K4');
}
