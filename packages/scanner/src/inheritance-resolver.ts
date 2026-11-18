/**
 * Inheritance Resolver
 *
 * Resolves class inheritance chains over the scanned classes, each identified
 * by the file that declares it and its name. Handles STI (Single Table
 * Inheritance) detection and field merging.
 */

import { dirname, resolve as resolvePath } from 'node:path';
import {
  isFrameworkExport,
  ModuleResolver,
  type ResolvedBinding,
  type ResolverModule,
} from './module-resolver.js';
import type {
  ExternalManifest,
  RawClassDefinition,
  RawFieldDefinition,
  RawImportBinding,
  RawModuleExports,
  RawReExport,
  ResolvedClassDefinition,
  ScanError,
} from './types.js';

/**
 * Framework base classes that are always recognized.
 *
 * Hardcoded list — every framework abstract base class that consuming
 * packages can subclass without needing `@smrt()` must appear here, or
 * the scanner will silently drop undecorated subclasses from the manifest.
 *
 * `SmrtJunction`, `SmrtHierarchical`, and `SmrtPolymorphicAssociation` are
 * stopgap entries pending a manifest-driven base-class detection scheme —
 * core would export its abstract bases in its manifest and dependents would
 * resolve through them via the existing cross-package chain walker (see
 * `findClassDefinition`). After tracing the wiring at R3 kickoff
 * (2026-05-18), generalization was deferred: new `SmartObjectManifest →
 * ExternalManifest` adapter, new vite-plugin scan-path failure modes,
 * new sync-I/O surface — large cost for ~two saved lines per future
 * abstract base. R4 added the third base and re-confirmed the call: a new
 * abstract base is still two lines here + two in
 * `FRAMEWORK_ABSTRACT_BASE_NAMES`, far cheaper than the generalization's
 * new failure surface. Extend this list instead.
 */
export const FRAMEWORK_BASE_CLASSES: ReadonlySet<string> = new Set([
  'SmrtObject',
  'SmrtClass',
  'SmrtCollection',
  'SmrtJunction',
  'SmrtJunctionBase',
  'SmrtHierarchical',
  'SmrtPolymorphicAssociation',
  'SmrtReport',
  'SmrtReportCollection',
]);

/**
 * npm package name of a bare, scoped module specifier
 * (`@scope/pkg` or `@scope/pkg/subpath` → `@scope/pkg`), else `undefined`.
 * Relative, absolute, protocol (`node:`), unscoped, and alias-like specifiers
 * (`@/lib`, `$lib/…`) name no SMRT package: qualified names are always scoped.
 */
export function scopedPackageOfSpecifier(
  specifier: string,
): string | undefined {
  const match = /^(@[a-z0-9][\w.~-]*\/[a-z0-9][\w.~-]*)(?:\/.*)?$/i.exec(
    specifier,
  );
  return match?.[1];
}

/** One step of an inheritance chain: the name written, and the class it is. */
interface ChainLink {
  name: string;
  /** `null` for a framework base or a parent the scan cannot see. */
  definition: RawClassDefinition | null;
  /**
   * Found by name only, for a parent the child imports from a package whose
   * manifest is not registered here: possibly a same-named class that is not
   * the parent at all. Its fields are not merged (generation merges them once
   * the parent is verified).
   */
  unverified?: boolean;
  /** The link is a framework base class (`SmrtObject`, …). */
  framework?: boolean;
}

/** How a class's `extends` binds, as the module resolver found it. */
interface ParentLink {
  /** The parent's own name (the declaring class's, or the package export's). */
  name: string;
  definition: RawClassDefinition | null;
  framework: boolean;
  unverified?: boolean;
  /** A parent exported by a package whose manifest the scan has not read. */
  package?: { packageName: string; exportName: string };
  /** Why the parent does not resolve to exactly one declaration. */
  error?: string;
}

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx'];
const MAX_RE_EXPORT_DEPTH = 8;

/**
 * Resolves class inheritance chains and STI hierarchies from raw OXC scan output.
 *
 * After {@link OxcScanner} parses files, `InheritanceResolver` indexes the
 * raw definitions and walks each class's `extends` chain to produce
 * fully-resolved {@link ResolvedClassDefinition} objects.
 *
 * A class is identified by its FILE and its name, never by its name alone.
 * Two files may declare a class of the same name — a model and an unrelated
 * helper is ordinary — and each keeps its own definition. A parent is found
 * the way the declaring module binds it: a class in the same file, else the
 * file a relative import (followed through re-exports) points at, else a
 * registered external manifest for an imported package. Only when none of
 * those applies (a path alias, a self-import, a default import) is the parent
 * looked up by name, preferring a class that is itself a model.
 *
 * Key responsibilities:
 * - Walking extends chains across local classes and external package manifests.
 * - Detecting which classes participate in STI (Single Table Inheritance).
 * - Merging fields from ancestor classes for STI subclasses (base fields first).
 * - Reporting two model classes that share a name: a manifest keys a class
 *   by `<package>:<ClassName>`, so only one of them could be recorded.
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
  /** Every registered class, in registration order. */
  private classes: RawClassDefinition[] = [];

  /** Classes by simple name; more than one entry when files share a name. */
  private classesByName: Map<string, RawClassDefinition[]> = new Map();

  /** Classes by declaring file (normalized path), then by name. */
  private classesByFile: Map<string, Map<string, RawClassDefinition>> =
    new Map();

  /** Re-exports by file (normalized path), for imports through a barrel. */
  private reExportsByFile: Map<string, RawReExport[]> = new Map();

  /** Normalized paths of every file the scan read. */
  private knownFiles: Set<string> = new Set();

  /** External package manifests for cross-package resolution */
  private externalManifests: Map<string, ExternalManifest> = new Map();

  /** Known base classes (user-provided) */
  private knownBaseClasses: Set<string>;

  /** Cache of resolved parents and chains, by class definition. */
  private parentCache: Map<RawClassDefinition, RawClassDefinition | null> =
    new Map();
  private chainCache: Map<RawClassDefinition, ChainLink[]> = new Map();
  /** Classes whose parent is being resolved, to stop a cyclic lookup. */
  private resolving: Set<RawClassDefinition> = new Set();

  /** The raw definition each resolved definition was built from. */
  private rawByResolved: WeakMap<ResolvedClassDefinition, RawClassDefinition> =
    new WeakMap();

  /** Diagnostics from the last {@link resolveAll}. */
  private resolutionErrors: ScanError[] = [];

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
      /**
       * Project root whose `tsconfig.json` `paths` the module resolver
       * reads for path aliases.
       */
      projectRoot?: string;
    } = {},
  ) {
    this.knownBaseClasses = new Set([
      ...FRAMEWORK_BASE_CLASSES,
      ...(options.baseClasses || []),
    ]);
    this.customBaseClasses = new Set(options.baseClasses || []);
    this.externalManifests = options.externalManifests || new Map();
    this.moduleResolver = new ModuleResolver(this.modules, options.projectRoot);
  }

  /** Base class names configured by the caller (`baseClasses`). */
  private customBaseClasses: Set<string>;

  /** Scanned modules with their import and export tables, by file. */
  private modules: Map<string, ResolverModule> = new Map();

  private moduleResolver: ModuleResolver;

  private linkCache: Map<RawClassDefinition, ParentLink | null> = new Map();

  /**
   * Register raw class definitions from a scan pass.
   *
   * Each class is indexed under its declaring file and its name, so a class
   * never replaces a same-named class from another file. Calling this clears
   * the resolution caches so subsequent calls to {@link resolveAll} or
   * {@link resolveInheritanceChain} reflect the new classes.
   *
   * @param classes - Array of {@link RawClassDefinition} objects from
   *   {@link ScanResults.classes}.
   */
  addClasses(classes: RawClassDefinition[]): void {
    for (const classDef of classes) {
      this.classes.push(classDef);
      const named = this.classesByName.get(classDef.className);
      if (named) named.push(classDef);
      else this.classesByName.set(classDef.className, [classDef]);

      const file = normalizeFile(classDef.filePath);
      this.knownFiles.add(file);
      let inFile = this.classesByFile.get(file);
      if (!inFile) {
        inFile = new Map();
        this.classesByFile.set(file, inFile);
      }
      inFile.set(classDef.className, classDef);
    }
    this.clearCaches();
  }

  /**
   * Register the files a scan read and what each re-exports, so a parent
   * imported through a relative path — directly or through a barrel — is
   * resolved to the file that declares it.
   *
   * @param files - Scanned files; `reExports` as in
   *   {@link FileScanResult.reExports}.
   */
  addModules(
    files: Array<{
      filePath: string;
      reExports?: RawReExport[];
      moduleExports?: RawModuleExports;
      imports?: Record<string, RawImportBinding>;
    }>,
  ): void {
    for (const file of files) {
      const path = normalizeFile(file.filePath);
      this.knownFiles.add(path);
      if (file.reExports && file.reExports.length > 0) {
        this.reExportsByFile.set(path, file.reExports);
      }
      // A file the scan parsed resolves its imports strictly: through the
      // module graph, never by a class's name.
      if (file.moduleExports) {
        let classes = this.classesByFile.get(path);
        if (!classes) {
          classes = new Map();
          this.classesByFile.set(path, classes);
        }
        this.modules.set(path, {
          classes,
          imports: file.imports ?? {},
          exports: file.moduleExports,
        });
      }
    }
    this.clearCaches();
  }

  /**
   * Forget every class and module registered with {@link addClasses} and
   * {@link addModules}, keeping external manifests and base classes. A
   * rescan registers the project again from scratch; without this a class
   * would be registered once per scan and collide with itself.
   */
  clearClasses(): void {
    this.classes = [];
    this.classesByName.clear();
    this.classesByFile.clear();
    this.reExportsByFile.clear();
    this.knownFiles.clear();
    this.modules.clear();
    this.resolutionErrors = [];
    this.clearCaches();
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
    this.clearCaches();
  }

  private clearCaches(): void {
    this.parentCache.clear();
    this.chainCache.clear();
    this.linkCache.clear();
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
   * Two included classes of one package that share a name are both returned
   * and reported through {@link getResolutionErrors}: a caller must fail on
   * that diagnostic rather than build a manifest that can hold only one of
   * them.
   *
   * @returns An array of {@link ResolvedClassDefinition} — one entry per
   *   eligible class, with inheritance chain, STI metadata, and merged fields
   *   populated.
   *
   * @see {@link resolve} to resolve a single class definition.
   */
  resolveAll(): ResolvedClassDefinition[] {
    const resolved: ResolvedClassDefinition[] = [];
    const included = new Map<string, RawClassDefinition[]>();

    for (const classDef of this.classes) {
      // Include classes with @smrt() decorator
      // OR classes that extend framework base classes
      if (!this.isModelClass(classDef)) continue;

      resolved.push(this.resolve(classDef));
      // Identity is the package and the class name. A class that declares
      // its package (`@smrt({ packageName })`) is compared with the classes
      // of that package only: a fixture standing in for another package does
      // not collide with the scanned package's own class of the same name.
      const identity = `${declaredPackageName(classDef) ?? ''}\u0000${classDef.className}`;
      const sameName = included.get(identity);
      if (sameName) sameName.push(classDef);
      else included.set(identity, [classDef]);
    }

    this.resolutionErrors = [];
    for (const declarations of included.values()) {
      if (declarations.length < 2) continue;
      const later = declarations[declarations.length - 1];
      const className = later.className;
      this.resolutionErrors.push({
        message:
          `Class name collision: \`${className}\` is declared by ${declarations.length} SMRT classes in this scan ` +
          `(${declarations.map((entry) => entry.filePath).join(', ')}). ` +
          `A manifest identifies a class as \`<package>:${className}\`, so only one of them could be recorded ` +
          `and the others would be missing from it. Rename the classes so each name is unique within the package.`,
        filePath: later.filePath,
        line: later.startLine || undefined,
        severity: 'error',
      });
    }

    return resolved;
  }

  /**
   * Diagnostics found by the last {@link resolveAll}: model classes that
   * share a name. `OxcScanner.resolve()` adds them to `ScanResults.errors`.
   */
  getResolutionErrors(): ScanError[] {
    return [...this.resolutionErrors];
  }

  /** Has `@smrt()`, or its chain reaches a framework base class. */
  private isModelClass(classDef: RawClassDefinition): boolean {
    return classDef.hasSmartDecorator || this.extendsFrameworkBase(classDef);
  }

  /**
   * Check if a class extends a framework base class
   * (SmrtObject, SmrtClass, or SmrtCollection)
   */
  private extendsFrameworkBase(classDef: RawClassDefinition): boolean {
    // A framework link is one the module resolver traced to the framework
    // package's export (or, for a class the scan did not parse, named like
    // one); a scanned class of a framework name is the framework's own.
    return this.chainOf(classDef).some(
      (link) =>
        link.framework ||
        (link.definition !== null && this.knownBaseClasses.has(link.name)),
    );
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
    const chain = this.chainOf(classDef);
    const stiBase =
      chain.find(
        (link) => link.definition?.decoratorConfig?.tableStrategy === 'sti',
      )?.name ?? null;
    const effectiveTableStrategy =
      classDef.decoratorConfig?.tableStrategy ??
      (chain.some(
        (link) =>
          link.definition !== classDef &&
          link.definition?.decoratorConfig?.tableStrategy === 'sti',
      )
        ? 'sti'
        : 'cti');
    const isFrameworkBase = this.knownBaseClasses.has(classDef.className);
    const isSTI = effectiveTableStrategy === 'sti';

    // Merge fields for STI classes. For non-STI classes, the
    // ManifestGenerator in core selectively merges fields from framework
    // abstract bases (e.g. `SmrtHierarchical.parentId`) — see
    // `FRAMEWORK_ABSTRACT_BASE_NAMES` in
    // `packages/core/src/scanner/manifest-generator.ts`. Doing that merge
    // here too would compound with subtly different field shapes and
    // regress universal-baseline expectations in `fieldsFromClass`.
    // Fields are merged only from links below the last unverified one: a
    // class found by name for a package import may be an unrelated namesake.
    let firstMerged = 0;
    chain.forEach((link, index) => {
      if (link.unverified) firstMerged = index + 1;
    });
    const allFields = isSTI
      ? this.mergeFields(
          chain.slice(firstMerged).map((link) => link.definition),
        )
      : classDef.fields;

    const parentLink = this.linkOf(classDef);
    const resolved: ResolvedClassDefinition = {
      ...classDef,
      ...(parentLink &&
      this.moduleResolver.has(normalizeFile(classDef.filePath))
        ? {
            extendsResolution: parentLink.framework
              ? ('framework' as const)
              : parentLink.package
                ? ('package' as const)
                : parentLink.definition
                  ? ('local' as const)
                  : ('unresolved' as const),
            extendsName: parentLink.name,
            ...(parentLink.definition && !parentLink.package
              ? { extendsIsModel: this.isModelClass(parentLink.definition) }
              : {}),
            ...(parentLink.package
              ? { extendsPackage: parentLink.package }
              : {}),
          }
        : {}),
      inheritanceChain: chain.map((link) => link.name),
      stiBase,
      effectiveTableStrategy,
      isSTI,
      isFrameworkBase,
      allFields,
      packageName: null, // Will be set by manifest adapter
    };
    this.rawByResolved.set(resolved, classDef);
    return resolved;
  }

  /**
   * The scanned classes `classDef` inherits from, nearest last, excluding
   * framework bases and parents the scan cannot see. Accepts a raw definition
   * or one returned by {@link resolve}.
   */
  getAncestors(
    classDef: RawClassDefinition | ResolvedClassDefinition,
  ): RawClassDefinition[] {
    const raw =
      this.rawByResolved.get(classDef as ResolvedClassDefinition) ?? classDef;
    return this.chainOf(raw)
      .map((link) => link.definition)
      .filter(
        (definition): definition is RawClassDefinition =>
          definition !== null && definition !== raw,
      );
  }

  /**
   * Resolve the full inheritance chain for a named class, from the root base
   * class down to the named class itself.
   *
   * Results are memoised in an internal cache that is cleared whenever
   * {@link addClasses} or {@link addExternalManifest} is called. When more
   * than one registered class has this name, the chain is that of
   * {@link findClassDefinition}'s choice; resolve a definition with
   * {@link resolve} to address one of them exactly.
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
    const classDef = this.findLocalByName(className);
    if (!classDef) {
      const external = this.findExternalByName(className);
      return external
        ? this.chainOf(external).map((link) => link.name)
        : [className];
    }
    return this.chainOf(classDef).map((link) => link.name);
  }

  /**
   * The chain of one class definition, base first. A link's `definition` is
   * `null` where the chain leaves the scan: a framework base class, or a
   * parent that no scanned file or registered manifest declares.
   */
  private chainOf(classDef: RawClassDefinition): ChainLink[] {
    const cached = this.chainCache.get(classDef);
    if (cached) return cached;

    const cacheable = this.resolving.size === 0;
    const chain: ChainLink[] = [
      { name: classDef.className, definition: classDef },
    ];
    const visited = new Set<RawClassDefinition>([classDef]);
    let current = classDef;

    // A class named like a known base class ends its own chain.
    while (!this.knownBaseClasses.has(current.className)) {
      const link = this.linkOf(current);
      if (!link) break;
      if (link.framework) {
        chain.unshift({ name: link.name, definition: null, framework: true });
        break;
      }
      const parent = link.definition;
      if (!parent) {
        chain.unshift({ name: link.name, definition: null });
        break;
      }
      if (visited.has(parent)) break;
      visited.add(parent);
      chain.unshift({
        name: link.name,
        definition: parent,
        ...(link.unverified ? { unverified: true } : {}),
      });
      current = parent;
    }

    if (cacheable) this.chainCache.set(classDef, chain);
    return chain;
  }

  /**
   * The class `classDef` extends, resolved the way its module binds the name.
   *
   * 1. Not imported: a class of that name declared in the same file.
   * 2. A relative import: the class the target file declares or re-exports.
   * 3. A package import: that package's registered external manifest.
   * 4. Otherwise, by name — see {@link findLocalByName}.
   */
  private parentOf(classDef: RawClassDefinition): RawClassDefinition | null {
    const cached = this.parentCache.get(classDef);
    if (cached !== undefined) return cached;
    // A lookup that comes back to a class already being resolved is a cycle
    // through same-named candidates; treat the parent as unseen for it.
    if (this.resolving.has(classDef)) return null;

    const cacheable = this.resolving.size === 0;
    this.resolving.add(classDef);
    let parent: RawClassDefinition | null;
    try {
      parent = this.findParent(classDef);
    } finally {
      this.resolving.delete(classDef);
    }
    if (cacheable) this.parentCache.set(classDef, parent);
    return parent;
  }

  /**
   * How `classDef`'s `extends` binds. A class from a file the scan parsed is
   * resolved through the module graph (`ModuleResolver`): the declaring
   * class, a framework base only when the binding is the framework
   * package's export, a package export (confirmed at generation against
   * that package's manifest), or an error. A class registered without its
   * module (a hand-built definition) is resolved by the older rules.
   */
  private linkOf(classDef: RawClassDefinition): ParentLink | null {
    if (this.linkCache.has(classDef)) {
      return this.linkCache.get(classDef) ?? null;
    }
    const link = this.computeLink(classDef);
    this.linkCache.set(classDef, link);
    return link;
  }

  private computeLink(classDef: RawClassDefinition): ParentLink | null {
    const name = classDef.extendsClause;
    if (!name) return null;
    const file = normalizeFile(classDef.filePath);
    if (!this.moduleResolver.has(file)) {
      if (this.knownBaseClasses.has(name)) {
        return { name, definition: null, framework: true };
      }
      const parent = this.parentOf(classDef);
      return {
        name,
        definition: parent,
        framework: false,
        ...(parent && this.isUnverifiedPackageParent(classDef)
          ? { unverified: true }
          : {}),
      };
    }

    let resolved: ResolvedBinding;
    if (classDef.extendsSource) {
      resolved = this.moduleResolver.resolveImport(
        file,
        classDef.extendsSource,
        classDef.extendsDefaultImport ? 'default' : name,
      );
    } else {
      const sameFile = this.classesByFile.get(file)?.get(name);
      if (sameFile && sameFile !== classDef) {
        resolved = { kind: 'class', definition: sameFile };
      } else if (this.knownBaseClasses.has(name)) {
        // Neither declared nor imported: only a global could bind it, and a
        // framework base is the only global a model can extend.
        return { name, definition: null, framework: true };
      } else {
        resolved = {
          kind: 'unresolved',
          reason: `\`${name}\` is neither declared in this file nor imported`,
        };
      }
    }

    if (resolved.kind === 'class') {
      if (resolved.definition === classDef) {
        return {
          name,
          definition: null,
          framework: false,
          error: 'the class extends itself',
        };
      }
      return {
        name: resolved.definition.className,
        definition: resolved.definition,
        framework: false,
      };
    }
    if (resolved.kind === 'package') {
      const { packageName, exportName } = resolved;
      if (
        isFrameworkExport(packageName, exportName, FRAMEWORK_BASE_CLASSES) ||
        this.customBaseClasses.has(exportName)
      ) {
        return { name: exportName, definition: null, framework: true };
      }
      const external = this.externalManifests
        .get(packageName)
        ?.classes.get(exportName);
      return {
        name: exportName,
        definition: external ?? null,
        framework: false,
        package: { packageName, exportName },
      };
    }
    return { name, definition: null, framework: false, error: resolved.reason };
  }

  /**
   * Parent bindings that do not resolve to exactly one declaration, for
   * every class `resolved` contains and each ancestor in its chain: one scan
   * error each. Classes outside every model report nothing.
   */
  parentResolutionErrors(resolved: ResolvedClassDefinition[]): ScanError[] {
    const errors: ScanError[] = [];
    const seen = new Set<RawClassDefinition>();
    for (const entry of resolved) {
      const raw = this.rawByResolved.get(entry);
      if (!raw) continue;
      for (const link of this.chainOf(raw)) {
        const definition = link.definition;
        if (!definition || seen.has(definition)) continue;
        seen.add(definition);
        const parent = this.linkOf(definition);
        if (parent?.error) {
          errors.push({
            message:
              `${definition.className} extends \`${definition.extendsClause}\`` +
              `${definition.extendsSource ? ` imported from '${definition.extendsSource}'` : ''}, ` +
              `which does not resolve to one class: ${parent.error}. ` +
              'Import the parent class by its name from the module that declares it.',
            filePath: definition.filePath,
            line: definition.startLine,
            severity: 'error',
          });
        }
      }
    }
    return errors;
  }

  /**
   * How a scanned class's relationship target or report source imported as
   * `imported` from `specifier` binds, for the scanner's confirmation pass.
   * `undefined` when the class's file was not parsed by the scan.
   */
  resolveImportedClass(
    classDef: RawClassDefinition,
    specifier: string,
    imported: string,
  ): ResolvedBinding | undefined {
    const file = normalizeFile(classDef.filePath);
    if (!this.moduleResolver.has(file)) return undefined;
    return this.moduleResolver.resolveImport(file, specifier, imported);
  }

  /**
   * Whether `classDef`'s parent is imported from a scoped package whose
   * registered manifest does not declare it, so any parent found for it is
   * found by name only.
   */
  private isUnverifiedPackageParent(classDef: RawClassDefinition): boolean {
    const source = classDef.extendsSource;
    const name = classDef.extendsClause;
    if (!source || !name || isRelativeSpecifier(source)) return false;
    const packageName = scopedPackageOfSpecifier(source);
    if (!packageName) return false;
    return !this.externalManifests.get(packageName)?.classes.get(name);
  }

  private findParent(classDef: RawClassDefinition): RawClassDefinition | null {
    const name = classDef.extendsClause;
    if (!name) return null;
    const file = normalizeFile(classDef.filePath);
    const source = classDef.extendsSource;

    if (!source) {
      const sameFile = this.classesByFile.get(file)?.get(name);
      if (sameFile && sameFile !== classDef) return sameFile;
    } else if (isRelativeSpecifier(source)) {
      const declared = this.findExportedClass(
        this.resolveModule(file, source),
        name,
        0,
        new Set(),
      );
      if (declared && declared !== classDef) return declared;
    } else {
      const packageName = scopedPackageOfSpecifier(source);
      const external = packageName
        ? this.externalManifests.get(packageName)?.classes.get(name)
        : undefined;
      if (external) return external;
    }

    return (
      this.findLocalByName(name, classDef) ?? this.findExternalByName(name)
    );
  }

  /**
   * The class `file` exports as `name`: one it declares, or one it re-exports
   * from another scanned file (`export { A as B } from`, `export * from`,
   * `export { A as B }`), followed to a bounded depth.
   */
  private findExportedClass(
    file: string | undefined,
    name: string,
    depth: number,
    seen: Set<string>,
  ): RawClassDefinition | null {
    if (!file || depth > MAX_RE_EXPORT_DEPTH) return null;
    const key = `${file}\u0000${name}`;
    if (seen.has(key)) return null;
    seen.add(key);

    const declared = this.classesByFile.get(file);
    const own = declared?.get(name);
    if (own) return own;

    for (const reExport of this.reExportsByFile.get(file) ?? []) {
      if (reExport.source === undefined) {
        if (reExport.exported === name && reExport.imported) {
          const renamed = declared?.get(reExport.imported);
          if (renamed) return renamed;
        }
        continue;
      }
      if (!isRelativeSpecifier(reExport.source)) continue;
      const star = reExport.exported === undefined;
      if (!star && reExport.exported !== name) continue;
      const found = this.findExportedClass(
        this.resolveModule(file, reExport.source),
        star ? name : (reExport.imported ?? name),
        depth + 1,
        seen,
      );
      if (found) return found;
    }
    return null;
  }

  /** The scanned file a relative specifier in `fromFile` refers to. */
  private resolveModule(
    fromFile: string,
    specifier: string,
  ): string | undefined {
    const base = resolvePath(dirname(fromFile), specifier);
    const candidates = [base];
    // `./model.js` in TypeScript source names `./model.ts`.
    const withoutExtension = base.replace(/\.(?:[cm]?js|jsx)$/, '');
    for (const stem of new Set([withoutExtension, base])) {
      for (const extension of SOURCE_EXTENSIONS) {
        candidates.push(`${stem}${extension}`);
      }
      for (const extension of SOURCE_EXTENSIONS) {
        candidates.push(resolvePath(stem, `index${extension}`));
      }
    }
    return candidates.find((candidate) => this.knownFiles.has(candidate));
  }

  /**
   * A registered local class by name alone. With several of that name, a
   * model class is preferred over a class that is not one, then the first
   * registered; `except` is never returned.
   */
  private findLocalByName(
    className: string,
    except?: RawClassDefinition,
  ): RawClassDefinition | null {
    const candidates = (this.classesByName.get(className) ?? []).filter(
      (candidate) => candidate !== except,
    );
    if (candidates.length <= 1) return candidates[0] ?? null;
    return (
      candidates.find((candidate) => this.isModelClass(candidate)) ??
      candidates[0]
    );
  }

  private findExternalByName(className: string): RawClassDefinition | null {
    for (const manifest of this.externalManifests.values()) {
      const external = manifest.classes.get(className);
      if (external) return external;
    }
    return null;
  }

  /**
   * Look up a class definition by name, searching in priority order:
   * 1. Local classes added via {@link addClasses}. When several files declare
   *    the name, a model class is preferred, then the first registered.
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
    const local = this.findLocalByName(className);
    if (local) return local;

    // 2. Check external manifests
    const external = this.findExternalByName(className);
    if (external) return external;

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
   * both an ancestor and a descendant, the descendant's definition takes
   * precedence while preserving the base-class column position.
   *
   * @param chain - Ordered inheritance chain (base → leaf) as returned by
   *   {@link resolveInheritanceChain}.
   * @returns A deduplicated, ordered array of {@link RawFieldDefinition}
   *   covering every field in the STI hierarchy.
   */
  mergeFieldsForSTI(chain: string[]): RawFieldDefinition[] {
    return this.mergeFields(
      chain.map((className) => this.findClassDefinition(className)),
    );
  }

  private mergeFields(
    chain: Array<RawClassDefinition | null>,
  ): RawFieldDefinition[] {
    const allFields: RawFieldDefinition[] = [];
    const positions = new Map<string, number>();

    for (const classDef of chain) {
      if (!classDef) continue;

      for (const field of classDef.fields) {
        const position = positions.get(field.name);
        if (position === undefined) {
          positions.set(field.name, allFields.length);
          allFields.push(field);
        } else {
          allFields[position] = this.mergeSTIFieldOverride(
            allFields[position],
            field,
          );
        }
      }
    }

    return allFields;
  }

  /**
   * Merge a descendant's redeclared STI field with the entry it replaces.
   *
   * Leaf-wins: the descendant's own declaration (its initializer, type
   * annotation, decorators, optionality) always takes precedence — a
   * redeclaration that carries its own options keeps them. But a bare
   * `override fieldName = value` redeclaration (no type annotation, no
   * decorators) carries no metadata source of its own, so everything the
   * declaring ancestor attached — an enum type annotation, a
   * `@field({ description })` decorator — would otherwise be dropped from
   * the merged raw field and, with it, from the converted manifest. Fill
   * that missing metadata in from the ancestor entry being replaced so a
   * grandchild's bare override keeps the inherited field's `enum` and
   * `description` (#4005).
   *
   * @param ancestor - The previously merged (nearest declaring ancestor)
   *   field entry being replaced.
   * @param descendant - The descendant's own redeclaration, which wins.
   * @returns The descendant's field with missing `typeAnnotation` and
   *   `decorators` filled from the ancestor.
   */
  private mergeSTIFieldOverride(
    ancestor: RawFieldDefinition,
    descendant: RawFieldDefinition,
  ): RawFieldDefinition {
    return {
      ...descendant,
      ...(descendant.typeAnnotation === null && ancestor.typeAnnotation !== null
        ? { typeAnnotation: ancestor.typeAnnotation }
        : {}),
      ...(descendant.decorators.length === 0 && ancestor.decorators.length > 0
        ? { decorators: ancestor.decorators }
        : {}),
    };
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
    const descendants = new Set<string>();

    for (const classDef of this.classes) {
      if (classDef.className === className) continue;

      const chain = this.chainOf(classDef).map((link) => link.name);
      if (chain.includes(className)) {
        descendants.add(classDef.className);
      }
    }

    return [...descendants];
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

    for (const classDef of this.classes) {
      if (classDef.hasSmartDecorator) {
        smrtClasses++;

        const chain = this.chainOf(classDef);
        maxInheritanceDepth = Math.max(maxInheritanceDepth, chain.length);

        if (
          chain.some(
            (link) => link.definition?.decoratorConfig?.tableStrategy === 'sti',
          )
        ) {
          stiClasses++;
        }
      }
    }

    return {
      totalClasses: this.classes.length,
      smrtClasses,
      stiClasses,
      maxInheritanceDepth,
    };
  }
}

/**
 * The package a class says it belongs to through a literal
 * `@smrt({ packageName })`, or `undefined` for a class of the scanned package.
 */
export function declaredPackageName(
  classDef: Pick<RawClassDefinition, 'decoratorConfig'>,
): string | undefined {
  const declared = classDef.decoratorConfig?.packageName;
  return typeof declared === 'string' && declared !== '' ? declared : undefined;
}

function normalizeFile(filePath: string): string {
  return filePath ? resolvePath(filePath) : filePath;
}

function isRelativeSpecifier(specifier: string): boolean {
  return (
    specifier === '.' ||
    specifier === '..' ||
    specifier.startsWith('./') ||
    specifier.startsWith('../')
  );
}
