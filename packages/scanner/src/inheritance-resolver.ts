/**
 * Inheritance Resolver
 *
 * Resolves class inheritance chains using in-memory class map.
 * Handles STI (Single Table Inheritance) detection and field merging.
 */

import type {
  ExternalManifest,
  RawClassDefinition,
  RawFieldDefinition,
  ResolvedClassDefinition,
} from './types.js';

/**
 * Framework base classes that are always recognized
 */
const FRAMEWORK_BASE_CLASSES = new Set([
  'SmrtObject',
  'SmrtClass',
  'SmrtCollection',
]);

/**
 * Resolves class inheritance chains and STI hierarchies from raw OXC scan output.
 *
 * After {@link OxcScanner} parses files, `InheritanceResolver` builds a
 * class map from the raw definitions and walks each class's `extends` chain
 * to produce fully-resolved {@link ResolvedClassDefinition} objects.
 *
 * Key responsibilities:
 * - Walking extends chains across local classes and external package manifests.
 * - Detecting which classes participate in STI (Single Table Inheritance).
 * - Merging fields from ancestor classes for STI subclasses (base fields first).
 * - Caching resolved chains to avoid repeated traversals.
 *
 * Framework base classes (`SmrtObject`, `SmrtClass`, `SmrtCollection`) are
 * recognized without needing to appear in source files.
 *
 * @example
 * ```typescript
 * import { InheritanceResolver } from '@happyvertical/smrt-scanner';
 *
 * const resolver = new InheritanceResolver({ baseClasses: ['MyBaseClass'] });
 * resolver.addClasses(rawClasses);
 * const resolved = resolver.resolveAll();
 * ```
 *
 * @see {@link OxcScanner} which owns and drives this resolver internally.
 */
export class InheritanceResolver {
  /** Map of className -> RawClassDefinition */
  private classMap: Map<string, RawClassDefinition> = new Map();

  /** External package manifests for cross-package resolution */
  private externalManifests: Map<string, ExternalManifest> = new Map();

  /** Known base classes (user-provided) */
  private knownBaseClasses: Set<string>;

  /** Cache of resolved inheritance chains */
  private chainCache: Map<string, string[]> = new Map();

  /**
   * Create a new `InheritanceResolver`.
   *
   * @param options.baseClasses - Additional class names to treat as known
   *   framework base classes (beyond the built-in `SmrtObject`, `SmrtClass`,
   *   and `SmrtCollection`).
   * @param options.externalManifests - Pre-loaded external package manifests
   *   keyed by package name, used for cross-package parent class resolution.
   */
  constructor(
    options: {
      baseClasses?: string[];
      externalManifests?: Map<string, ExternalManifest>;
    } = {},
  ) {
    this.knownBaseClasses = new Set([
      ...FRAMEWORK_BASE_CLASSES,
      ...(options.baseClasses || []),
    ]);
    this.externalManifests = options.externalManifests || new Map();
  }

  /**
   * Register raw class definitions from a scan pass.
   *
   * Adds each class to the internal class map by `className`.  Calling this
   * clears the inheritance chain cache so subsequent calls to
   * {@link resolveAll} or {@link resolveInheritanceChain} reflect the new
   * classes.
   *
   * @param classes - Array of {@link RawClassDefinition} objects from
   *   {@link ScanResults.classes}.
   */
  addClasses(classes: RawClassDefinition[]): void {
    for (const classDef of classes) {
      this.classMap.set(classDef.className, classDef);
    }
    // Clear cache when classes are added
    this.chainCache.clear();
  }

  /**
   * Register an external package manifest for cross-package base class resolution.
   *
   * Clears the chain cache after registration so re-resolution picks up the
   * new definitions.
   *
   * @param manifest - External package manifest providing class definitions
   *   that may appear as base classes in the local project.
   *
   * @see {@link ExternalManifest}
   */
  addExternalManifest(manifest: ExternalManifest): void {
    this.externalManifests.set(manifest.packageName, manifest);
    this.chainCache.clear();
  }

  /**
   * Resolve all registered classes and return fully-resolved definitions.
   *
   * A class is included in the output if it either:
   * 1. Has an `@smrt()` decorator, or
   * 2. Directly or transitively extends a framework base class
   *    (`SmrtObject`, `SmrtClass`, `SmrtCollection`) — this captures
   *    collection classes such as `class MeetingCollection extends
   *    SmrtCollection<Meeting>` that do not carry `@smrt()` themselves.
   *
   * @returns An array of {@link ResolvedClassDefinition} — one entry per
   *   eligible class, with inheritance chain, STI metadata, and merged fields
   *   populated.
   *
   * @see {@link resolve} to resolve a single class definition.
   */
  resolveAll(): ResolvedClassDefinition[] {
    const resolved: ResolvedClassDefinition[] = [];

    for (const classDef of this.classMap.values()) {
      // Include classes with @smrt() decorator
      // OR classes that extend framework base classes
      const extendsFrameworkBase = this.extendsFrameworkBase(classDef);
      if (!classDef.hasSmartDecorator && !extendsFrameworkBase) continue;

      const resolvedClass = this.resolve(classDef);
      resolved.push(resolvedClass);
    }

    return resolved;
  }

  /**
   * Check if a class extends a framework base class
   * (SmrtObject, SmrtClass, or SmrtCollection)
   */
  private extendsFrameworkBase(classDef: RawClassDefinition): boolean {
    // Direct extension of framework base
    if (
      classDef.extendsClause &&
      this.knownBaseClasses.has(classDef.extendsClause)
    ) {
      return true;
    }

    // Walk inheritance chain to check indirect extension
    const chain = this.resolveInheritanceChain(classDef.className);
    return chain.some((className) => this.knownBaseClasses.has(className));
  }

  /**
   * Resolve a single raw class definition into a fully-resolved definition.
   *
   * Computes the inheritance chain, determines the effective table strategy,
   * detects STI membership, and merges ancestor fields for STI classes.
   *
   * @param classDef - The raw class definition to resolve.
   * @returns A {@link ResolvedClassDefinition} with all inherited metadata
   *   applied.  The `packageName` field is left as `null` and must be set by
   *   the caller (e.g. {@link ManifestAdapter}).
   *
   * @see {@link resolveAll} to resolve every registered class at once.
   */
  resolve(classDef: RawClassDefinition): ResolvedClassDefinition {
    const inheritanceChain = this.resolveInheritanceChain(classDef.className);
    const stiBase = this.findSTIBase(inheritanceChain);
    const effectiveTableStrategy = this.determineTableStrategy(
      classDef,
      inheritanceChain,
    );
    const isFrameworkBase = this.knownBaseClasses.has(classDef.className);
    const isSTI = effectiveTableStrategy === 'sti';

    // Merge fields for STI classes
    const allFields = isSTI
      ? this.mergeFieldsForSTI(inheritanceChain)
      : classDef.fields;

    return {
      ...classDef,
      inheritanceChain,
      stiBase,
      effectiveTableStrategy,
      isSTI,
      isFrameworkBase,
      allFields,
      packageName: null, // Will be set by manifest adapter
    };
  }

  /**
   * Resolve the full inheritance chain for a named class, from the root base
   * class down to the named class itself.
   *
   * Results are memoised in an internal cache that is cleared whenever
   * {@link addClasses} or {@link addExternalManifest} is called.
   *
   * @param className - Name of the class to resolve.
   * @returns An ordered array of class names starting from the furthest
   *   ancestor and ending with `className`.
   *
   * @example
   * ```typescript
   * // Given: class Article extends Content, class Content extends SmrtObject
   * resolver.resolveInheritanceChain('Article');
   * // => ['SmrtObject', 'Content', 'Article']
   * ```
   */
  resolveInheritanceChain(className: string): string[] {
    // Check cache
    const cached = this.chainCache.get(className);
    if (cached) return cached;

    const chain: string[] = [];
    const visited = new Set<string>();
    let current: string | null = className;

    while (current && !visited.has(current)) {
      visited.add(current);
      chain.unshift(current);

      // Check if this is a framework base class
      if (this.knownBaseClasses.has(current)) {
        break;
      }

      // Find parent class
      const classDef = this.findClassDefinition(current);
      current = classDef?.extendsClause || null;
    }

    // Cache result
    this.chainCache.set(className, chain);

    return chain;
  }

  /**
   * Look up a class definition by name, searching in priority order:
   * 1. Local classes added via {@link addClasses}.
   * 2. External package manifests added via {@link addExternalManifest}.
   * 3. Built-in framework base classes (`SmrtObject`, `SmrtClass`,
   *    `SmrtCollection`) — returns a minimal stub definition so chain walking
   *    can terminate cleanly.
   *
   * @param className - Class name to look up.
   * @returns The {@link RawClassDefinition} if found, or `null` if the class
   *   is unknown to the resolver.
   */
  findClassDefinition(className: string): RawClassDefinition | null {
    // 1. Check local classes
    const local = this.classMap.get(className);
    if (local) return local;

    // 2. Check external manifests
    for (const manifest of this.externalManifests.values()) {
      const external = manifest.classes.get(className);
      if (external) return external;
    }

    // 3. Check if it's a known base class
    if (this.knownBaseClasses.has(className)) {
      // Return a minimal definition for framework bases
      return {
        className,
        filePath: '',
        extendsClause: null,
        extendsTypeArg: null,
        decoratorConfig: null,
        hasSmartDecorator: false,
        fields: [],
        methods: [],
        startLine: 0,
        endLine: 0,
      };
    }

    return null;
  }

  /**
   * Find the STI root class in a resolved inheritance chain.
   *
   * Walks the chain from base to leaf and returns the name of the first class
   * whose `@smrt()` decorator explicitly declares `tableStrategy: 'sti'`.
   *
   * @param chain - Ordered inheritance chain (base → leaf) as returned by
   *   {@link resolveInheritanceChain}.
   * @returns The class name of the STI root, or `null` if no class in the
   *   chain uses `tableStrategy: 'sti'`.
   */
  findSTIBase(chain: string[]): string | null {
    for (const className of chain) {
      const classDef = this.findClassDefinition(className);
      if (classDef?.decoratorConfig?.tableStrategy === 'sti') {
        return className;
      }
    }
    return null;
  }

  /**
   * Determine the effective table strategy (`'sti'` or `'cti'`) for a class.
   *
   * Resolution order:
   * 1. The class's own `@smrt({ tableStrategy })` declaration, if present.
   * 2. The nearest ancestor that declares `tableStrategy: 'sti'` — STI is
   *    inherited automatically by all subclasses.
   * 3. Defaults to `'cti'` if no STI ancestor is found.
   *
   * @param classDef - Raw class definition whose strategy is being determined.
   * @param chain - Pre-resolved inheritance chain for `classDef` (base → leaf).
   * @returns `'sti'` or `'cti'`.
   */
  determineTableStrategy(
    classDef: RawClassDefinition,
    chain: string[],
  ): 'sti' | 'cti' {
    // Check if this class explicitly declares a strategy
    if (classDef.decoratorConfig?.tableStrategy) {
      return classDef.decoratorConfig.tableStrategy;
    }

    // Check ancestors for STI
    for (const className of chain) {
      if (className === classDef.className) continue;

      const ancestorDef = this.findClassDefinition(className);
      if (ancestorDef?.decoratorConfig?.tableStrategy === 'sti') {
        return 'sti';
      }
    }

    return 'cti';
  }

  /**
   * Merge fields from all classes in an STI inheritance chain.
   *
   * Iterates from the root base class to the leaf class so that base class
   * fields appear first in the returned array.  If a field name is declared in
   * both an ancestor and a descendant, the ancestor's definition takes
   * precedence (first-seen wins), preserving the base-class column layout.
   *
   * @param chain - Ordered inheritance chain (base → leaf) as returned by
   *   {@link resolveInheritanceChain}.
   * @returns A deduplicated, ordered array of {@link RawFieldDefinition}
   *   covering every field in the STI hierarchy.
   */
  mergeFieldsForSTI(chain: string[]): RawFieldDefinition[] {
    const allFields: RawFieldDefinition[] = [];
    const seenNames = new Set<string>();

    for (const className of chain) {
      const classDef = this.findClassDefinition(className);
      if (!classDef) continue;

      for (const field of classDef.fields) {
        // Skip if already seen (child overrides parent)
        if (seenNames.has(field.name)) continue;

        seenNames.add(field.name);
        allFields.push(field);
      }
    }

    return allFields;
  }

  /**
   * Return all known descendants of a class.
   *
   * Useful for STI schema generation where the base table must accommodate
   * columns from every subclass.
   *
   * @param className - The ancestor class name to search from.
   * @returns An array of class names (local classes only) whose resolved
   *   inheritance chain includes `className`.  Does not include `className`
   *   itself.
   */
  getDescendants(className: string): string[] {
    const descendants: string[] = [];

    for (const [name] of this.classMap) {
      if (name === className) continue;

      const chain = this.resolveInheritanceChain(name);
      if (chain.includes(className)) {
        descendants.push(name);
      }
    }

    return descendants;
  }

  /**
   * Check whether a class participates in an STI hierarchy.
   *
   * @param className - Name of the class to check.
   * @returns `true` if any class in the resolved inheritance chain declares
   *   `tableStrategy: 'sti'`, `false` otherwise.
   */
  isSTIClass(className: string): boolean {
    const chain = this.resolveInheritanceChain(className);
    return this.findSTIBase(chain) !== null;
  }

  /**
   * Return aggregate statistics about the classes registered with this resolver.
   *
   * @returns An object with:
   *   - `totalClasses` — total number of classes in the class map.
   *   - `smrtClasses` — classes that carry `@smrt()`.
   *   - `stiClasses` — `@smrt()` classes in an STI hierarchy.
   *   - `maxInheritanceDepth` — length of the deepest inheritance chain among
   *     `@smrt()` classes.
   */
  getStats(): {
    totalClasses: number;
    smrtClasses: number;
    stiClasses: number;
    maxInheritanceDepth: number;
  } {
    let smrtClasses = 0;
    let stiClasses = 0;
    let maxInheritanceDepth = 0;

    for (const classDef of this.classMap.values()) {
      if (classDef.hasSmartDecorator) {
        smrtClasses++;

        const chain = this.resolveInheritanceChain(classDef.className);
        maxInheritanceDepth = Math.max(maxInheritanceDepth, chain.length);

        if (this.findSTIBase(chain)) {
          stiClasses++;
        }
      }
    }

    return {
      totalClasses: this.classMap.size,
      smrtClasses,
      stiClasses,
      maxInheritanceDepth,
    };
  }
}
