/** Collection options for framework-internal, correctness-critical reads. @packageDocumentation */
import type {
  SmrtClassOptions,
  SmrtCollectionOptions,
} from '@happyvertical/smrt-core';

/**
 * The caller's options with its list bounds removed.
 *
 * `SmrtCollection.create()` forwards `defaultListLimit`/`maxListLimit` from
 * any options bag it is handed (#2367), so a host that configures those
 * application-wide — a perfectly ordinary thing to do — would silently cap
 * every internal enumeration this package runs. Two of those are
 * correctness-critical and neither is a user-facing page of results
 * (`FeatureDefinition`/`FeatureOverride` expose no generated list surface,
 * #3013): a dropped ancestor override changes the flag's *resolved value*
 * (`FeatureResolver.isEnabled()`), and a dropped definition makes a feature
 * invisible to a management screen or a sync prune pass (#3056, same hazard
 * class as #3048). The collections built here are therefore always created
 * from this bag. Only the list bounds are stripped; the database, tenancy
 * context, and every other option still apply.
 *
 * This is a local copy of `@happyvertical/smrt-users`'
 * `authorization-read-options.ts#withoutListBounds` (added for #3048/#3051).
 * `smrt-features` deliberately never imports `smrt-users` (see package
 * AGENTS.md), and no shared `smrt-core` helper exists for this yet, so the
 * two-line implementation is duplicated here rather than adding a
 * cross-package dependency for it.
 */
export function withoutListBounds(
  options: SmrtClassOptions | SmrtCollectionOptions,
): SmrtCollectionOptions {
  return { ...options, defaultListLimit: undefined, maxListLimit: undefined };
}
