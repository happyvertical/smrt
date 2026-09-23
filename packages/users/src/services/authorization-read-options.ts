/** Collection options for framework-internal authorization reads. @packageDocumentation */
import type {
  SmrtClassOptions,
  SmrtCollectionOptions,
} from '@happyvertical/smrt-core';

/**
 * The caller's options with its list bounds removed.
 *
 * `SmrtCollection.create()` forwards `defaultListLimit`/`maxListLimit` from
 * any options bag it is handed (#2367), so a bounded bag (for example a
 * bounded collection's own options) would silently truncate a read that an
 * authorization decision needs in full: a dropped DENY widens access, a
 * dropped row in a quota count lifts the quota (#3047 review, #3048).
 * Collections that back an authorization decision are therefore always
 * created from this bag. Only the list bounds are stripped; the database,
 * tenancy context and every other option still apply.
 */
export function withoutListBounds(
  options: SmrtClassOptions | SmrtCollectionOptions,
): SmrtCollectionOptions {
  return { ...options, defaultListLimit: undefined, maxListLimit: undefined };
}
