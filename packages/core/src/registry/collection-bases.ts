/**
 * The framework's collection bases and the manifest-entry classification built
 * on them. Dependency-free on purpose: the standalone knowledge entry and the
 * route generators read it without loading the runtime collection class.
 * `./collection-resolution.ts` re-exports the public names.
 */

/**
 * Framework base classes that ARE collections (extend `SmrtCollection`).
 *
 * `SmrtJunction` and `SmrtJunctionBase` are abstract collection bases — junction collections declare
 * `extends SmrtJunction<Item>`, and the manifest records that *direct* parent.
 * `SmrtJunction` is itself never registered in a consumer's registry, so the
 * inheritance-chain walk in `isCollectionRegistration()` cannot reach
 * `SmrtCollection` through it. Recognizing the junction base by name here is
 * what keeps a junction Collection classified as a collection (and therefore
 * redirected to its item class for schema generation) regardless of
 * registration order. Without it, a junction Collection that is iterated
 * before its item class is mistaken for a regular table-bearing class and
 * creates a base-columns-only table, dropping the junction's FK columns
 * (#1342 — `place_assets` vs `profile_assets` asymmetry).
 *
 * `SmrtReportCollection` (`@happyvertical/smrt-reports`) is the same case: a
 * framework collection base that is never registered, so a report collection
 * (`class XCollection extends SmrtReportCollection<X>`) was classified as a
 * table-bearing class and claimed its item's table. The schema planner then
 * rejected the pair as two unrelated owners of one table (#3110).
 *
 * Keep in sync with the collection bases that extend `SmrtCollection` in
 * `packages/core/src/junction.ts` and `packages/reports/src/report.ts`. (`SmrtHierarchical` and
 * `SmrtPolymorphicAssociation` extend `SmrtObject`, not `SmrtCollection`, so
 * they deliberately do NOT belong here.)
 *
 * A new framework collection base must also be added to the other parallel
 * framework-base lists so it is recognized everywhere it matters:
 * - `FRAMEWORK_BASE_CLASSES` in
 *   `packages/scanner/src/inheritance-resolver.ts` (scanner chain termination).
 * - `FRAMEWORK_ABSTRACT_BASE_NAMES` in
 *   `packages/core/src/scanner/manifest-generator.ts` (field-merge skipping).
 *
 * Downstream tooling that needs this detector (e.g. @happyvertical/smrt-vitest)
 * should IMPORT it from `@happyvertical/smrt-core` rather than keep a copy — a
 * duplicate detector is exactly how the #1342 junction schema-drop bug
 * half-survived the original core fix.
 */
export const SMRT_COLLECTION_BASE_NAMES = [
  'SmrtCollection',
  'SmrtJunction',
  'SmrtJunctionBase',
  'SmrtReportCollection',
] as const;

/** The framework package that declares each collection base. */
const FRAMEWORK_COLLECTION_PACKAGES: Readonly<
  Record<(typeof SMRT_COLLECTION_BASE_NAMES)[number], string>
> = {
  SmrtCollection: '@happyvertical/smrt-core',
  SmrtJunction: '@happyvertical/smrt-core',
  SmrtJunctionBase: '@happyvertical/smrt-core',
  SmrtReportCollection: '@happyvertical/smrt-reports',
};

export function isSmrtCollectionExtendsName(
  extendsName: string | undefined,
): boolean {
  if (!extendsName) {
    return false;
  }
  // A qualified name is the framework base only when the framework package
  // declares it: another package's class named `SmrtCollection` (an app's
  // `@app/pkg:SmrtCollection`) is a model, not a collection base.
  return SMRT_COLLECTION_BASE_NAMES.some(
    (base) =>
      extendsName === base ||
      extendsName === `${FRAMEWORK_COLLECTION_PACKAGES[base]}:${base}`,
  );
}

/**
 * Whether one manifest entry marks itself a collection without walking its
 * ancestry: it extends the framework's `SmrtCollection` by identity (a
 * qualified parent is a package's own class named `SmrtCollection`, not the
 * framework base), it extends one of the framework's other collection bases
 * with a type argument (`SmrtReportCollection<Item>`), or generation recorded
 * the model it manages (`collectionOf`). A type argument next to another
 * parent is no marker: an ordinary generic model
 * (`Ledger extends RecordBase<Currency>`) has one.
 */
export function hasCollectionMarker(entry: {
  extends?: string;
  extendsQualified?: string;
  extendsTypeArg?: string | null;
  collectionOf?: unknown;
}): boolean {
  if (typeof entry.collectionOf === 'string' && entry.collectionOf) {
    return true;
  }
  if (!entry.extendsQualified && entry.extends === 'SmrtCollection') {
    return true;
  }
  if (!entry.extendsTypeArg) return false;
  // A manifest of an older generation recorded a collection's item without
  // its parent: a class with a type argument always has a parent otherwise.
  if (!entry.extends && !entry.extendsQualified) return true;
  return isSmrtCollectionExtendsName(entry.extendsQualified || entry.extends);
}
