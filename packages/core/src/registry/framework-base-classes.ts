/**
 * The framework's own abstract base classes, keyed by simple class name to
 * their declaring package.
 *
 * These are scaffolding every application model descends from — they carry
 * no `@smrt()` decorator and have no independent existence as a resource.
 * A foundation package like `@happyvertical/smrt-core` declares them as real
 * local classes (there is no other package for them to live in), so
 * `loadAllManifests()` registers them exactly like any genuine domain class
 * when a consumer installs `@happyvertical/smrt-core` — with no decoration
 * or framework-base filter of its own (#2642). The registration criterion
 * this framework was designed around is descent from `SmrtObject`, not the
 * presence of a decorator — undecorated domain classes (e.g. a hand-written
 * `SmrtCollection` subclass) keep their surfaces; only the framework's own
 * bases are excluded here, checked by class identity rather than decoration.
 *
 * This is the SINGLE shared source of truth for that identity check within
 * `@happyvertical/smrt-core` and its consumers — imported by:
 * - `./schema-builder.ts` (skips table/DDL generation for these classes)
 * - `../knowledge.ts` (the `.smrt/smrt-knowledge.json` surface projection)
 * - `../generators/mcp.ts` (`MCPGenerator.generateTools()`)
 * - `../generators/cli.ts` (`CLIGenerator.listCommands()`)
 * - `../generators/rest.ts` (`APIGenerator.findClassByCollectionSegment()`)
 * - `../vite-plugin/sveltekit-generator.ts` (REST route generation)
 * - `../vite-plugin/sync-apply-route.ts` (`collectSyncApplyTargets()`)
 * - `../vite-plugin/web-collections.ts` (the `smrt-virt-web` client's
 *   collection and WebMCP tool selectors)
 * - `@happyvertical/smrt-cli`'s `cli-generator.ts` (the live local `smrt`
 *   binary's object command generation), via core's public export
 *
 * Do not add another hardcoded copy of this list at a new call site — import
 * from here instead.
 *
 * `packages/scanner/src/inheritance-resolver.ts` keeps its own separate
 * `FRAMEWORK_BASE_CLASSES` set: that package is a lower-level AST layer this
 * one has no reason to otherwise depend on, and that set controls a
 * different concern (scanner-level extends-chain termination and stub
 * resolution for packages that don't declare these classes locally), not
 * resource exposure.
 *
 * Most of these live in `@happyvertical/smrt-core` itself, but
 * `SmrtReport`/`SmrtReportCollection` are declared in
 * `@happyvertical/smrt-reports` — the owning package is per-name, not a
 * single blanket package check. A new framework base must be added here AND
 * to the scanner's `FRAMEWORK_BASE_CLASSES`.
 *
 * Deliberately NOT exported: only `isFrameworkBaseClass()` below needs to be
 * public. A `Map` survives TypeScript's `ReadonlyMap` typing only at the
 * type-check layer — a plain-JS or `as Map` caller could still `.set()`/
 * `.clear()` an exported instance at runtime and change what the framework
 * considers a base class. Keeping the map itself module-private closes that
 * off entirely rather than relying on callers not to do that.
 */
const FRAMEWORK_BASE_CLASS_PACKAGES: ReadonlyMap<string, string> = new Map([
  ['SmrtObject', '@happyvertical/smrt-core'],
  ['SmrtClass', '@happyvertical/smrt-core'],
  ['SmrtCollection', '@happyvertical/smrt-core'],
  ['SmrtJunction', '@happyvertical/smrt-core'],
  ['SmrtHierarchical', '@happyvertical/smrt-core'],
  ['SmrtPolymorphicAssociation', '@happyvertical/smrt-core'],
  ['SmrtReport', '@happyvertical/smrt-reports'],
  ['SmrtReportCollection', '@happyvertical/smrt-reports'],
]);

/**
 * True when `className`/`packageName` identify one of the framework's own
 * abstract base classes rather than a genuine resource.
 *
 * Both a class name AND its declaring package must match: a consuming
 * package is free to declare its own local class named e.g. `SmrtReport`
 * without colliding with the framework base of the same name.
 */
export function isFrameworkBaseClass(
  className: string | undefined,
  packageName: string | undefined,
): boolean {
  return (
    className !== undefined &&
    packageName !== undefined &&
    FRAMEWORK_BASE_CLASS_PACKAGES.get(className) === packageName
  );
}
