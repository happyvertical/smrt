/**
 * Release C (#1134) — unified collision policy for class registration.
 *
 * `register()` and `registerFromManifest()` both need to decide what to do
 * when a new registration lands on an existing class with the same (or a
 * case-insensitive-matching) name. Before Release C the decision logic was
 * a ~300-line if/else tree duplicated across three code paths:
 *
 *   - `register()` exact-match branch          (class-registration.ts:159-275)
 *   - `register()` case-insensitive branch     (class-registration.ts:286-391)
 *   - `resolveManifestCollision()`             (class-registration.ts:876-929)
 *
 * This module collapses all three onto a single decision table. Each row
 * names a scenario that exists in the current test suite; the row order
 * encodes specificity (first match wins).
 *
 * # Invocation contract
 *
 * `decideCollisionPolicy(inputs)` is ONLY called when the caller has already
 * identified exactly one colliding candidate for the new registration. Two
 * cases MUST be handled upstream without consulting the table:
 *
 *   1. No colliding candidate exists  → register fresh.
 *   2. Ambiguous simple name matches >1 existing entry across different
 *      packages (`getCanonicalClassName()` returns undefined) → fall through
 *      to the exact-key path and allow coexistence under qualified keys.
 *      See issue #951 for the semantics being preserved.
 *
 * Feeding the ambiguous case through the table would lose the
 * `coexist-qualified` behavior that's crucial for multi-package apps.
 *
 * @see https://github.com/happyvertical/smrt/issues/1134
 */

export type RegistrationOrigin = 'decorator' | 'manifest';

/**
 * How the colliding candidate was identified.
 *
 *   - `exact-key`          : `classes.get(name)` returned the candidate.
 *                            `existingKey === name`.
 *   - `case-insensitive`   : Iteration found a case-insensitive match on
 *                            either the registry key or the entry's `name`
 *                            property. `existingKey !== name`.
 *   - `canonical-name`     : Looked up via `getCanonicalClassName(simpleName)`
 *                            — unambiguous single match under a lowered
 *                            simple name. Used by the manifest path.
 */
export type MatchKind = 'exact-key' | 'case-insensitive' | 'canonical-name';

export type Policy =
  /** Keep existing identity, update metadata via `upsertExistingEntry`. */
  | 'accept'
  /** Drop existing, register new as replacement. */
  | 'replace'
  /**
   * Fold manifest fields into existing registration. The **caller MUST**:
   *   (1) call `mergeManifestIntoExistingRegistration(existing, objectDef, packageName)`
   *   (2) if `registrationKey !== existingCanonical`, alias the existing entry
   *       under `registrationKey` via `classes.set()` + `constructorIndex.set()`
   * Both steps together preserve the `issue-951:144-200` contract.
   */
  | 'merge-manifest'
  /**
   * Different packages, different qualified keys. Both registrations stay
   * in the classes Map under their respective qualified keys. Ambiguity is
   * surfaced at `findClass` time. Preserves issue #951.
   */
  | 'coexist-qualified'
  /** Existing wins; silently ignore the new registration. */
  | 'skip'
  /** Unresolvable collision — raise a user-facing error. */
  | 'throw';

/**
 * Every signal the decision table can read. Computed by the caller from
 * inspection of the new and existing registrations.
 */
export interface CollisionInputs {
  readonly origin: RegistrationOrigin;
  readonly matchKind: MatchKind;

  /** `new.ctor === existing.constructor` (decorator path only; false for manifest). */
  readonly sameConstructor: boolean;

  /** `new.sourceFile === existing.sourceFilePath`, both truthy. */
  readonly sameSourceFile: boolean;

  /** Both the new and existing registrations have known source files. */
  readonly bothSourceFilesKnown: boolean;

  /** `existing.constructor._isManifestStub === true`. */
  readonly existingIsManifestStub: boolean;

  /**
   * New registration's source file lives in a bundled output directory
   * (`.svelte-kit/output/`, `/dist/`, `/build/`, `.next/`, `.nuxt/`).
   */
  readonly newInBundledContext: boolean;

  /**
   * New class extends existing.
   *   - decorator path: `new.ctor.prototype instanceof existing.constructor`
   *   - manifest path : `new.objectDef.extends` names existing
   */
  readonly newExtendsExisting: boolean;

  /** Inverse direction: existing extends new. */
  readonly existingExtendsNew: boolean;

  /** `new.packageName === existing.packageName` (both truthy). */
  readonly samePackage: boolean;

  /**
   * `existing.packageName?.startsWith('@')` — existing entry came from a
   * scoped package manifest (i.e., is externally identified).
   */
  readonly existingIsPackageQualified: boolean;

  /**
   * Case-sensitive equality between `new.name` and `existing.name`.
   * Used to distinguish a pnpm-duplicate (same exact name) from a genuine
   * case-insensitive collision (different names that lower to the same string).
   */
  readonly sameName: boolean;

  /**
   * New registration has (or can derive) a qualified key `@pkg:Name`.
   * Paired with `existingIsPackageQualified` to drive the different-packages
   * coexistence behavior from issue #951.
   */
  readonly hasNewQualifiedKey: boolean;

  /**
   * Existing registry key contains a `:` separator. Needed alongside
   * `existingIsPackageQualified` to identify valid pnpm-dup candidates
   * (old code required both).
   */
  readonly existingKeyIsQualified: boolean;

  /**
   * Manifest-origin only: the incoming `objectDef` carries at least one of
   * `fields`, `methods`, `schema`, or `decoratorConfig`. Without that, the
   * merge path has nothing to fold in and the caller should skip the
   * merge-manifest policy entirely.
   */
  readonly hasManifestContent: boolean;

  /**
   * Manifest-origin only: the new registration's qualified key differs
   * from the existing entry's canonical key. When true and the policy is
   * `merge-manifest`, the caller MUST also alias the existing entry under
   * the new qualified key (step 2 of the merge-manifest contract).
   */
  readonly registrationKeyDiffersFromExistingKey: boolean;

  /**
   * Existing registration has no `packageName` set. Distinct from
   * `!samePackage`: this specifically means the existing entry is a bare
   * source registration waiting for a package manifest to promote it. When
   * true and the new registration carries a packageName, merge-manifest
   * treats it as promotion rather than collision.
   */
  readonly existingHasNoPackage: boolean;
}

export interface PolicyDecision {
  readonly policy: Policy;
  /** Stable id. Matches the scenario name in the test suite 1-to-1. */
  readonly scenario: string;
  /** Human-readable explanation. Used by verboseLog + the error message. */
  readonly reason: string;
}

interface Row {
  readonly scenario: string;
  readonly match: (inputs: CollisionInputs) => boolean;
  readonly policy: Policy;
  readonly reason: (inputs: CollisionInputs) => string;
}

/**
 * Ordered decision table. First row whose `match` returns true wins.
 * Order reflects specificity — scenarios that narrow down earlier
 * scenarios come before them.
 *
 * Each row is named to match a scenario in the test suite so a reviewer
 * can bisect one-to-one between "new class extends existing" (the code)
 * and "sti-child-wins" (the test row and the verbose-log output).
 */
const ROWS: readonly Row[] = [
  // --- Cross-origin: constructor identity and stub replacement ----------

  {
    scenario: 'same-constructor-reregistration',
    match: (i) => i.sameConstructor,
    policy: 'accept',
    reason: () =>
      'Same constructor identity — module re-evaluation. Update metadata only.',
  },

  {
    // Decorator-only: the decorator fires after a manifest builder
    // pre-registered a stub placeholder under this name. The real class
    // takes over. Manifest-origin stub-to-stub arrivals fall through to
    // the source-file / STI rows instead.
    scenario: 'manifest-stub-replacement',
    match: (i) =>
      i.origin === 'decorator' &&
      i.existingIsManifestStub &&
      !i.sameConstructor,
    policy: 'replace',
    reason: () =>
      'Existing entry is a manifest stub placeholder; the real implementation takes over.',
  },

  // --- Manifest-origin rows (checked before decorator-origin) -----------

  {
    scenario: 'manifest-same-source-file',
    match: (i) => i.origin === 'manifest' && i.sameSourceFile,
    policy: 'skip',
    reason: () =>
      'Same source file — consumer manifest re-export, not a real collision.',
  },

  {
    scenario: 'manifest-sti-child-wins',
    match: (i) =>
      i.origin === 'manifest' && i.newExtendsExisting && !i.existingExtendsNew,
    policy: 'replace',
    reason: () =>
      'Manifest entry extends existing — STI child wins over parent.',
  },

  {
    scenario: 'manifest-sti-parent-skip',
    match: (i) =>
      i.origin === 'manifest' && i.existingExtendsNew && !i.newExtendsExisting,
    policy: 'skip',
    reason: () =>
      'Existing entry is the STI child of the incoming manifest parent; keep the child.',
  },

  {
    scenario: 'manifest-different-packages-qualified-coexist',
    match: (i) =>
      i.origin === 'manifest' &&
      !i.samePackage &&
      i.hasNewQualifiedKey &&
      i.existingIsPackageQualified,
    policy: 'coexist-qualified',
    reason: () =>
      'Different packages share a simple name; both registrations live under their qualified keys (issue #951).',
  },

  {
    // Covers two related scenarios:
    //   (a) `samePackage`          — decorator + manifest from the same
    //       package land on the same class; merge fields (issue #1000).
    //   (b) `existingHasNoPackage` — source registration hasn't been
    //       promoted to a qualified key yet and a manifest now provides
    //       the package identity (issue #951:144-200). The merge runs
    //       AND the caller aliases the existing entry under the new
    //       qualified key.
    scenario: 'manifest-same-package-merge',
    match: (i) =>
      i.origin === 'manifest' &&
      (i.samePackage || (i.existingHasNoPackage && i.hasNewQualifiedKey)) &&
      !i.existingIsManifestStub &&
      i.hasManifestContent,
    policy: 'merge-manifest',
    reason: () =>
      'Manifest arriving for an existing same-package or unqualified source registration; fold fields in and alias the qualified key if keys differ.',
  },

  {
    scenario: 'manifest-default-skip',
    match: (i) => i.origin === 'manifest',
    policy: 'skip',
    reason: () =>
      'Manifest collision with no inheritance relationship; keep existing entry (pre-Release-C resolveManifestCollision default).',
  },

  // --- Decorator-origin rows --------------------------------------------

  {
    scenario: 'decorator-exact-match-same-package-external',
    match: (i) =>
      i.origin === 'decorator' &&
      i.matchKind === 'exact-key' &&
      i.existingIsPackageQualified &&
      i.samePackage &&
      !i.sameConstructor,
    policy: 'accept',
    reason: () =>
      'External package manifest entry being replaced by its own decorator-registered class (issue #584).',
  },

  {
    scenario: 'decorator-case-insensitive-pnpm-duplicate',
    match: (i) =>
      i.origin === 'decorator' &&
      i.matchKind === 'case-insensitive' &&
      i.existingKeyIsQualified &&
      i.existingIsPackageQualified &&
      i.samePackage &&
      i.sameName &&
      !i.sameConstructor,
    policy: 'accept',
    reason: () =>
      'pnpm store duplicated the same package; different physical constructors but semantically identical.',
  },

  {
    scenario: 'decorator-bundled-context-known-package',
    match: (i) =>
      i.origin === 'decorator' &&
      i.newInBundledContext &&
      i.existingIsPackageQualified,
    policy: 'accept',
    reason: () =>
      'Bundled output duplicated a known package class across chunks; treat as re-registration.',
  },

  {
    scenario: 'decorator-same-source-file',
    match: (i) => i.origin === 'decorator' && i.sameSourceFile,
    policy: 'accept',
    reason: () =>
      'Same source file — module re-evaluated (vitest test-isolation or HMR).',
  },

  {
    scenario: 'decorator-unknown-source-fallback',
    match: (i) => i.origin === 'decorator' && !i.bothSourceFilesKnown,
    policy: 'accept',
    reason: () =>
      'Source file unavailable for comparison; allow re-registration rather than block legitimate updates.',
  },

  // --- Cross-origin STI fallbacks (used by decorator path; manifest
  //     path has its own explicit rows above that come first) ------------

  {
    scenario: 'sti-child-wins',
    match: (i) => i.newExtendsExisting && !i.existingExtendsNew,
    policy: 'replace',
    reason: () => 'New class extends existing — STI child wins over parent.',
  },

  {
    scenario: 'sti-parent-skip',
    match: (i) => i.existingExtendsNew && !i.newExtendsExisting,
    policy: 'skip',
    reason: () => 'Existing entry extends new — STI child already registered.',
  },

  // --- Default: unresolvable decorator collision ------------------------

  {
    scenario: 'true-collision',
    match: () => true,
    policy: 'throw',
    reason: () =>
      'Different constructors, different source files, no inheritance relationship. Unresolvable collision.',
  },
];

/**
 * Resolve a collision to a policy. See module docstring for the invocation
 * contract — callers MUST NOT invoke this for the no-candidate or
 * ambiguous-simple-name cases.
 */
export function decideCollisionPolicy(inputs: CollisionInputs): PolicyDecision {
  for (const row of ROWS) {
    if (row.match(inputs)) {
      return {
        policy: row.policy,
        scenario: row.scenario,
        reason: row.reason(inputs),
      };
    }
  }
  // Unreachable — `true-collision` is the final catch-all.
  throw new Error(
    `decideCollisionPolicy: no row matched (should be unreachable). Inputs: ${JSON.stringify(inputs)}`,
  );
}

/** Test-only: expose the row list so integration tests can scenario-id. */
export const __POLICY_ROWS_FOR_TEST: readonly Row[] = ROWS;
