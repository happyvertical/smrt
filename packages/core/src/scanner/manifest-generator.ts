import {
  generatedExpression,
  validateGeneratedFields,
} from '../generated-fields.js';
import { writeThroughFields } from '../write-through.js';
/**
 * Manifest generator for creating service manifests from AST scan results
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { createLogger } from '@happyvertical/logger';
import { ConfigurationError } from '../errors.js';
import {
  createManifestClassNamePredicate,
  resolveApiMethodExposure,
  resolveCustomActionMetadata,
  resolveEffectiveActionMetadata,
} from '../generators/custom-action.js';
import {
  type DiscoveredSmrtPackages,
  discoverSmrtPackageLocations,
} from '../manifest/discover-smrt-packages.js';
import {
  isPackageResolvableSync,
  loadExternalManifestSync,
  loadManifestFromPathSync,
  lookupInManifest,
} from '../manifest/manifest-loader.js';
import {
  annotateModelReplacements,
  sameNameReplacementTableMismatch,
} from '../manifest/model-replacements';
import { selectObjectDeclarations } from '../manifest/object-declarations.js';
import { readRetiredTablesFromPackageJson } from '../migrations/retired-tables.js';
import { tryComputeManifestSchemaFingerprint } from '../migrations/schema-fingerprint.js';
import { findField, type HelpModel, validateHelp } from '../recipe-help.js';
import {
  closeWildcardExclusions,
  findCollectionWriteEscalations,
  formatCollectionWriteEscalations,
  inheritCollectionExposure,
} from '../registry/collection-exposure.js';
import { isSmrtCollectionExtendsName } from '../registry/collection-resolution.js';
import { isFrameworkBaseClassName } from '../registry/framework-base-classes.js';
import { VERBOSE_ENABLED } from '../registry/shared-state.js';
import {
  findStaleWidenings,
  findSubclassExposureEscalations,
  formatSubclassExposureEscalations,
  inheritSubclassExposure,
} from '../registry/subclass-exposure.js';
import type { SmartObjectConfig } from '../registry/types.js';
import {
  defaultConflictColumns,
  resolveOwnershipTenantColumn,
  resolveTenantColumn,
} from '../schema/conflict-target.js';
import type { DatabaseEngine } from '../schema/ddl/types.js';
import {
  type FieldInheritanceLink,
  resolveInheritedFields,
} from '../schema/field-inheritance.js';
import {
  resolveForeignKeyDeleteAction,
  resolveForeignKeyUpdateAction,
} from '../schema/foreign-key-policy.js';
import { SchemaGenerator } from '../schema/generator.js';
import { SYSTEM_TABLE_NAMES } from '../schema/system-table-shapes.js';
import type {
  ColumnDefinition,
  SchemaDefinition,
  SQLDataType,
} from '../schema/types.js';
import { generateToolManifest } from '../tools/tool-generator.js';
import {
  DISPLAY_LABEL_FIELD,
  displayLabelFieldProblem,
  FIELD_UI_FORMAT_TYPES,
  FIELD_UI_FORMATS,
  FIELD_UI_WIDGET_TYPES,
  FIELD_UI_WIDGETS,
  isFieldUIFormat,
  isFieldUIWidget,
  isRelationshipRole,
  RELATIONSHIP_ROLES,
  resolveDisplayLabelField,
  resolveDisplayLabelProjection,
} from '../ui-metadata.js';
import { classnameToTablename, toSnakeCase } from '../utils/naming.js';
import {
  assertScopedPackageName,
  createQualifiedName,
  isQualifiedName,
  isQualifiedNameAliasFormat,
  parseQualifiedName,
  readPreviousQualifiedNames,
} from '../utils/qualified-names.js';
import { applyRecipeDemo } from './recipe-demo-pass.js';
import { isTestFile } from './test-file-patterns.js';
import type {
  AgentAdminRouteManifest,
  AgentComponentDeclaration,
  AgentCreateEntryManifest,
  AgentFeature,
  AgentManifest,
  AgentMenuItem,
  AgentPermission,
  AgentUISlotManifest,
  FieldDefinition,
  ManifestColumnDefinition,
  ManifestSchema,
  MethodDefinition,
  ScanResult,
  SmartObjectDefinition,
  SmartObjectManifest,
  SmrtVisibility,
  ValidationRule,
} from './types.js';
import { MANIFEST_TIMESTAMP } from './types.js';

/** Package.json shape consumed for import-path and component discovery. */
interface PackageJsonLike {
  name?: string;
  main?: string;
  exports?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Object form of the `@smrt({ tenantScoped })` config. Mirrors the object
 * branch of `SmartObjectConfig['tenantScoped']`; all keys optional because
 * the boolean shorthand normalizes to `{}`.
 */
interface TenantScopedOptions {
  mode?: 'required' | 'optional';
  field?: string;
  autoFilter?: boolean;
  autoPopulate?: boolean;
  allowSuperAdminBypass?: boolean;
}

/** JSON Schema property entry emitted for a field in generated MCP tools. */
interface JsonSchemaProperty {
  type: string;
  description: string;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  enum?: Array<string | number>;
}

type SchemaGeneratorLike = {
  generateSQL: (schema: SchemaDefinition, engine?: DatabaseEngine) => string;
};

// Create require function for synchronous module loading in ESM context
const require = createRequire(import.meta.url);

// Build-time schema/manifest-generation diagnostics route through the shared
// logger (S14 / dim-9, #1579) instead of unconditional stdout writes. Level
// follows the repo-wide SMRT_VERBOSE/DEBUG convention (#2896) so per-class
// detail is opt-in rather than always-on info.
const logger = createLogger({ level: VERBOSE_ENABLED ? 'debug' : 'info' });

/**
 * Fields every `SmrtObject` carries that are not manifest fields (#3590): a
 * recipe option may still refine them.
 */
const UNIVERSAL_OBJECT_FIELDS = [
  'id',
  'slug',
  'context',
  'created_at',
  'updated_at',
];

/** A model a refused bare-name target is reported against (`modelsNamed`). */
interface NamedModel {
  identity: string;
  definition: SmartObjectDefinition;
  /** Declared in the manifest being generated, not in a dependency's. */
  local: boolean;
  label: string;
}

/**
 * Framework abstract base classes whose declared fields must be merged
 * into every subclass's `fields` map.
 *
 * These classes live in SMRT framework packages, have no `@smrt()`
 * decorator, no table of their own, and contribute structural fields
 * (e.g. `SmrtHierarchical.parentId`) that subclasses query against —
 * without merging, downstream WHERE-clause validation rejects queries on
 * those columns.
 *
 * SmrtObject / SmrtClass / SmrtCollection are intentionally NOT in this
 * set even though they live in core. SmrtObject's universal columns
 * (`id`, `slug`, `context`, `created_at`, `updated_at`) are added by a
 * separate universal-baseline mechanism in `fieldsFromClass`, and merging
 * them here would double-write with subtly different `_meta` payloads
 * and regress existing field expectations.
 *
 * Keep in sync with `FRAMEWORK_BASE_CLASSES` in
 * `packages/scanner/src/inheritance-resolver.ts` — note that set is
 * broader: it controls scanner-level chain termination and stub
 * resolution, while this one only controls field merging.
 */
const FRAMEWORK_ABSTRACT_BASE_NAMES = new Set([
  'SmrtJunction',
  'SmrtJunctionBase',
  'SmrtHierarchical',
  'SmrtPolymorphicAssociation',
  'SmrtReport',
  'SmrtReportCollection',
]);

/**
 * Framework base classes to exclude from the ancestor **method** merge
 * below (#2624). Unlike fields, methods are never columns, so they never
 * needed the STI-vs-CTI field-merge rule above — they inherited it only by
 * sharing the same loop.
 *
 * Deliberately NARROWER than `FRAMEWORK_ABSTRACT_BASE_NAMES`: only the
 * three universal object/collection primitives (`SmrtObject`, `SmrtClass`,
 * `SmrtCollection`) are internal-only. These are the same three the
 * runtime resolver's `getAllMethods()`
 * (`packages/core/src/registry/inheritance-resolver.ts`) explicitly skips
 * by name, and the same three the field-merge doc comment above excludes
 * from `FRAMEWORK_ABSTRACT_BASE_NAMES` for the identical reason: their
 * surface (`save`, `destroy`, `toJSON`, `withTransaction`, ...) is generic
 * object-lifecycle plumbing, never a subclass-specific action.
 *
 * `FRAMEWORK_ABSTRACT_BASE_NAMES` (`SmrtJunction`, `SmrtHierarchical`,
 * `SmrtPolymorphicAssociation`, `SmrtReport`, `SmrtReportCollection`) is
 * intentionally NOT folded in here, unlike an earlier version of this fix.
 * Those classes are mixin-style bases whose declared methods ARE the
 * subclass's real, intended public API — the same way `SmrtHierarchical.
 * parentId` is a real, intended field, which is exactly why
 * `FRAMEWORK_ABSTRACT_BASE_NAMES` fields already merge into every subclass
 * regardless of STI/CTI (see above). Directly confirmed for two of the
 * five: `SmrtJunction.attach`/`detach`/`byLeft`/`byRight`/`setLinks`
 * (`packages/core/src/junction.ts`) — a `packages/template-sveltekit/
 * __tests__/runtimeProfileParity.test.ts` snapshot broke when an earlier
 * revision of this fix folded all 8 `FRAMEWORK_BASE_CLASSES` in here,
 * which is how this got caught — and `SmrtHierarchical.getParent`/
 * `getChildren`/`getAncestors`/`getDescendants`/`getHierarchy`/`moveTo`
 * (`packages/core/src/hierarchical.ts`). `SmrtPolymorphicAssociation`
 * follows the identical pattern by inspection but has no dedicated
 * regression test yet. `SmrtReport`/`SmrtReportCollection` are the
 * least-audited of the five: `SmrtReportCollection` overrides `list`/`get`
 * (`packages/reports/src/report.ts`), which are also the universal CRUD
 * operation names — a downstream `class X extends SmrtReportCollection`
 * with default (non-strict) MCP config would have seen a generated
 * custom-action tool collide with the standard `list`/`get` tool name.
 * #2646 closed that separately and independently of this exclusion set: the
 * MCP generator now refuses to expose a CRUD-named method as a custom action,
 * matching case-folded because its tool ids are lowercased whole. Each emitter
 * reserves on its own terms, and not all of them read the shared
 * `CRUD_OPERATIONS` list yet — see its docblock in
 * `generators/custom-action.ts` for the per-emitter rules. Keep in sync with the field-merge set's own doc comment; this one
 * governs method merging only.
 */
const FRAMEWORK_METHOD_BASE_NAMES = new Set([
  'SmrtObject',
  'SmrtClass',
  'SmrtCollection',
]);

/**
 * The real directory of the installed package `packageName` that code in
 * `fromDir` loads: the nearest `node_modules/<packageName>` above it, the
 * way Node looks it up. `undefined` when none is installed there.
 */
function installedPackageDir(
  packageName: string,
  fromDir: string,
): string | undefined {
  for (let current = fromDir; ; ) {
    const candidate = join(current, 'node_modules', packageName);
    if (existsSync(join(candidate, 'package.json'))) {
      try {
        return realpathSync(candidate);
      } catch {
        return candidate;
      }
    }
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/**
 * What makes two installed directories of a package the same package: its
 * name, its version and the content of the manifest it ships (the first of
 * `dist/manifest.json`, `.smrt/manifest.json` that exists, or none).
 * `undefined` when the directory's package.json cannot be read or names no
 * version, so the copies are taken to differ.
 */
function installedCopyIdentity(packageDir: string): string | undefined {
  try {
    const json = JSON.parse(
      readFileSync(join(packageDir, 'package.json'), 'utf8'),
    ) as { name?: unknown; version?: unknown };
    if (typeof json.name !== 'string' || typeof json.version !== 'string') {
      return undefined;
    }
    const manifest = ['dist/manifest.json', '.smrt/manifest.json']
      .map((path) => join(packageDir, path))
      .find((path) => existsSync(path));
    const digest = manifest
      ? createHash('sha256').update(readFileSync(manifest)).digest('hex')
      : 'none';
    return `${json.name}@${json.version}#${digest}`;
  } catch {
    return undefined;
  }
}

/**
 * Whether `obj` directly extends the framework's `SmrtCollection`, by
 * identity: the bare name with no qualified parent. A class of a package
 * named `SmrtCollection` (the scanner records it with that package's
 * `extendsQualified`) is a model like any other, and its subclasses inherit
 * its exposure.
 */
function extendsFrameworkCollection(obj: SmartObjectDefinition): boolean {
  return !obj.extendsQualified && obj.extends === 'SmrtCollection';
}

/**
 * Whether `obj` directly extends one of the framework's collection bases
 * (`SmrtCollection`, `SmrtJunction`, `SmrtJunctionBase`,
 * `SmrtReportCollection`), by identity as in
 * {@link extendsFrameworkCollection}.
 */
function extendsFrameworkCollectionBase(obj: SmartObjectDefinition): boolean {
  return !obj.extendsQualified && isSmrtCollectionExtendsName(obj.extends);
}

/**
 * Deterministic string comparator (#2749). Manifest object iteration order
 * follows scan/discovery order, which is not stable across runs, so any
 * emitted artifact keyed off `Object.entries(manifest.objects)` needs a
 * stable sort before emission.
 */
function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/**
 * True when a package.json `exports` condition resolves to a non-JS asset
 * (e.g. the `./manifest`/`./manifest.json` convention pointing at
 * `dist/manifest.json`), so subpath matching (smrt#2845's
 * `matchExportsSubpath`) never attributes a scanned object to it — no
 * `@smrt()` class's source file can be loaded from a JSON target.
 */
function targetsJsonAsset(condition: unknown): boolean {
  if (typeof condition === 'string') return condition.endsWith('.json');
  if (condition && typeof condition === 'object') {
    const record = condition as Record<string, unknown>;
    const target = record.import ?? record.default ?? record.require;
    return typeof target === 'string' && target.endsWith('.json');
  }
  return false;
}

/**
 * Infer visibility from file path and explicit config
 *
 * Priority:
 * 1. Explicit visibility in decorator config
 * 2. Auto-detect test files → 'test'
 * 3. Default to 'public'
 */
function inferVisibility(
  filePath: string,
  explicitVisibility?: SmrtVisibility,
): SmrtVisibility {
  if (explicitVisibility) return explicitVisibility;
  if (isTestFile(filePath)) return 'test';
  return 'public';
}

export class ManifestGenerator {
  /**
   * Generate manifest from scan results
   *
   * @param scanResults - Array of scan results containing object definitions
   * @param options - Optional configuration
   * @param options.packageName - Package name to inject into manifest and object definitions
   * @param options.packageVersion - Package version
   * @param options.packageJson - Full package.json object for determining import paths
   * @param options.smrtDependencies - List of SMRT package dependencies to include in manifest
   * @param options.includeVisibility - Array of visibility levels to include (default: all)
   *   - For published packages: ['public']
   *   - For development: ['public', 'internal', 'test'] or omit for all
   */
  generateManifest(
    scanResults: ScanResult[],
    options?: {
      packageName?: string;
      packageVersion?: string;
      packageJson?: PackageJsonLike;
      smrtDependencies?: string[];
      includeVisibility?: SmrtVisibility[];
      /** See {@link applyGenerationPasses}. */
      projectRoot?: string;
    },
  ): SmartObjectManifest {
    const manifest: SmartObjectManifest = {
      version: '1.0.0',
      timestamp: MANIFEST_TIMESTAMP,
      objects: {},
    };

    if (scanResults.some((result) => result.objects.length > 0)) {
      assertScopedPackageName(options?.packageName);
    }

    // Set package metadata at manifest level if provided
    if (options?.packageName) {
      manifest.packageName = options.packageName;
    }
    if (options?.packageVersion) {
      manifest.packageVersion = options.packageVersion;
    }
    // Set smrtDependencies BEFORE mergeInheritedFields() so external packages can be loaded
    if (options?.smrtDependencies) {
      manifest.smrtDependencies = options.smrtDependencies;
    }

    for (const result of scanResults) {
      for (const objectDef of result.objects) {
        // Set package metadata on object definition if provided
        if (options?.packageName) {
          objectDef.packageName = options.packageName;
        }
        if (options?.packageVersion) {
          objectDef.packageVersion = options.packageVersion;
        }

        // Generate qualified name (required for manifest keying)
        // Must have packageName to generate qualified name
        if (objectDef.packageName) {
          objectDef.qualifiedName = createQualifiedName(
            objectDef.packageName,
            objectDef.className,
          );
        }

        // Infer visibility from file path and decorator config
        objectDef.visibility = inferVisibility(
          objectDef.filePath,
          objectDef.decoratorConfig?.visibility as SmrtVisibility | undefined,
        );

        // Filter by visibility if specified
        // Skip objects that don't match the requested visibility levels
        if (
          options?.includeVisibility &&
          options.includeVisibility.length > 0 &&
          !options.includeVisibility.includes(objectDef.visibility)
        ) {
          // Skip this object - visibility not in allowed list
          continue;
        }

        // Determine import path from package.json exports
        if (options?.packageName && options?.packageJson) {
          objectDef.importPath = this.determineImportPath(
            options.packageJson,
            objectDef.filePath,
          );
        }

        // Set export names (defaults to className)
        objectDef.exportName = objectDef.exportName || objectDef.className;
        objectDef.collectionExportName =
          objectDef.collectionExportName || `${objectDef.className}Collection`;

        // Generate AI tools from methods if AI config exists
        if (objectDef.decoratorConfig.ai) {
          const methods = Object.values(objectDef.methods);
          const tools = generateToolManifest(
            methods,
            objectDef.decoratorConfig.ai,
          );

          // Store tools in object definition
          if (tools.length > 0) {
            objectDef.tools = tools;
          }
        }

        // Determine manifest key: use qualified name if available, fall back to lowercase name
        // During transition, some objects may not have qualified names
        const manifestKey = objectDef.qualifiedName || objectDef.name;

        // Check for collisions using the manifest key
        if (manifest.objects[manifestKey]) {
          const existing = manifest.objects[manifestKey];
          throw new Error(
            `Class name collision detected: '${objectDef.className}' (${manifestKey}) is defined in multiple files:\n` +
              `  1. ${existing.filePath}\n` +
              `  2. ${objectDef.filePath}\n\n` +
              `Class names must be unique within a package. Use different class names or separate packages.`,
          );
        }

        manifest.objects[manifestKey] = objectDef;
      }
    }

    this.applyGenerationPasses(manifest, {
      packageName: options?.packageName,
      packageJson: options?.packageJson,
      projectRoot: options?.projectRoot,
    });

    return manifest;
  }

  /**
   * Run every manifest generation pass, in order, on a manifest whose
   * `objects` have been collected. This is THE pass sequence: the OXC vite
   * plugin (`vite-plugin/index.ts`) and `ManifestBuilder.buildManifest()`
   * call it too, so the three producers cannot drift — before #2360
   * `ManifestBuilder` skipped the report passes and its manifests carried
   * `(slug, context)` conflict indexes for `@report` classes while the
   * runtime upserted on the report's group columns.
   *
   * @param manifest - manifest with `objects` populated (and
   *   `smrtDependencies` set, so external STI bases resolve)
   * @param options - package metadata for the agent-manifest pass
   * @param options.projectRoot - root of the project the manifest is
   *   generated for. Dependency manifests (parents imported from another
   *   package, STI relatives) are resolved from it, the way the project
   *   itself resolves them. Every producer passes it; without it resolution
   *   starts at `process.cwd()`, which is only the same thing when the build
   *   runs from the project directory.
   */
  applyGenerationPasses(
    manifest: SmartObjectManifest,
    options?: {
      packageName?: string;
      packageJson?: PackageJsonLike;
      projectRoot?: string;
    },
  ): void {
    const previous = this.dependencyScope;
    // Every run reads its dependencies once, from its project root, and
    // holds them for that run only. Without an explicit root the working
    // directory is the root; the process-wide cache is never read, so a
    // provider that changed between two runs is read again.
    this.dependencyScope = {
      root: options?.projectRoot ?? process.cwd(),
      manifests: new Map(),
    };
    try {
      this.runGenerationPasses(manifest, options);
    } finally {
      this.dependencyScope = previous;
    }
  }

  /**
   * Where dependency manifests are resolved from during one
   * {@link applyGenerationPasses} run, and what that run has loaded.
   */
  private dependencyScope:
    | {
        root: string;
        locations?: DiscoveredSmrtPackages;
        manifests: Map<string, ReturnType<typeof loadExternalManifestSync>>;
      }
    | undefined;

  /**
   * A dependency package's manifest for the generation passes.
   *
   * Inside a run that names its project root, the package is resolved from
   * that root: first the manifest package discovery selected for it (the same
   * file the producer's `smrtDependencies` list was built from), then the
   * package's `./manifest` export as seen from the root. The result is held
   * for the run, so every pass reads one manifest per package. Without a
   * root, resolution is the loader's default.
   */
  private loadDependencyManifest(
    packageName: string,
    options: { warn?: boolean } = {},
  ): ReturnType<typeof loadExternalManifestSync> {
    const scope = this.dependencyScope;
    if (!scope) return loadExternalManifestSync(packageName, options);
    const held = scope.manifests.get(packageName);
    if (held !== undefined) return held;
    scope.locations ??= discoverSmrtPackageLocations({ baseDir: scope.root });
    const location = scope.locations[packageName];
    const manifest =
      (location
        ? loadManifestFromPathSync(location.manifestPath, { cache: false })
        : null) ??
      loadExternalManifestSync(packageName, {
        ...options,
        baseDir: scope.root,
        // The run holds what it loaded (`scope.manifests`); a cache that
        // outlives the run would let a rebuild confirm a parent from a
        // manifest that has since changed or gone.
        cache: false,
      });
    scope.manifests.set(packageName, manifest);
    return manifest;
  }

  private runGenerationPasses(
    manifest: SmartObjectManifest,
    options?: { packageName?: string; packageJson?: PackageJsonLike },
  ): void {
    // An unscoped package name would yield `pkg:Class` keys the registry
    // rejects at startup (#3408); fail here with an actionable message. An app
    // that declares no classes generates no qualified names and still builds.
    if (Object.keys(manifest.objects).length > 0) {
      assertScopedPackageName(options?.packageName);
    }

    // An app may keep its source constructor name while exporting the upstream name.
    const publicNames = new Map<string, string>();
    for (const [key, obj] of Object.entries(manifest.objects)) {
      const parentName = (obj.extendsQualified ?? obj.extends)
        ?.split(':')
        .at(-1);
      const publicName =
        obj.decoratorConfig.name ??
        (obj.exportName === parentName ? obj.exportName : undefined);
      if (!publicName || publicName === obj.className) continue;
      // Readers classify an entry by its parent's bare name, so a model
      // published under a framework base's name would read as that base
      // (its children would skip exposure inheritance). The scanner refuses
      // such a name in the scanned package; this covers a manifest built
      // before it did.
      if (isFrameworkBaseClassName(publicName)) {
        throw new ConfigurationError(
          `${obj.className} (${obj.filePath}) is published under the public name ${publicName}, the name of a framework base class; ` +
            'rename it: the framework reserves this class name.',
          'CONFIG_RESERVED_CLASS_NAME',
          { className: obj.className, publicName },
        );
      }
      const packageName = obj.packageName ?? options?.packageName;
      if (!packageName) throw new Error(`Missing package for ${key}`);
      const nextKey = createQualifiedName(packageName, publicName);
      if (manifest.objects[nextKey] && manifest.objects[nextKey] !== obj) {
        throw new Error(`Class name collision for public model ${nextKey}`);
      }
      publicNames.set(obj.className, publicName);
      publicNames.set(key, nextKey);
      obj.className = publicName;
      obj.name = publicName.toLowerCase();
      obj.decoratorConfig.name = publicName;
      obj.qualifiedName = nextKey;
      delete manifest.objects[key];
      manifest.objects[obj.qualifiedName] = obj;
    }

    // Local collection generics, subclasses and references still use the
    // source identifier; keep those edges attached to its public identity.
    for (const obj of Object.values(manifest.objects)) {
      for (const property of [
        'extends',
        'extendsQualified',
        'extendsTypeArg',
        'collectionOf',
      ] as const) {
        const value = obj[property];
        if (value && publicNames.has(value))
          obj[property] = publicNames.get(value);
      }
      for (const field of Object.values(obj.fields)) {
        if (field.related && publicNames.has(field.related))
          field.related = publicNames.get(field.related);
      }
    }

    // `exclude: ['*']` closes a surface; no generator reads `'*'` as a
    // wildcard, so normalize it before any pass or manifest reader sees it
    // (#3468, smrt-profiles MagicLinkToken).
    for (const objectDef of Object.values(manifest.objects)) {
      if (objectDef.decoratorConfig) {
        objectDef.decoratorConfig = closeWildcardExclusions(
          objectDef.decoratorConfig,
        );
      }
    }

    // Capture authored API exposure before making the abstract class itself
    // read-only so hosted concrete descendants can inherit the authored part.
    for (const objectDef of Object.values(manifest.objects)) {
      if (objectDef.decoratorConfig?.abstract !== true) continue;
      if (!Object.hasOwn(objectDef, 'abstractDeclaredApi')) {
        objectDef.abstractDeclaredApi = objectDef.decoratorConfig.api ?? null;
      }
    }

    // Deprecated qualified-name aliases (#3338) fail closed at build time, the
    // same as the registry refuses them at runtime.
    this.assertQualifiedNameAliases(manifest);

    // Keep only import-derived parent qualifications the parent's package
    // confirms (#4145), before any pass walks `extendsQualified`.
    this.verifyImportedParents(manifest);
    // What a confirmed provider parent passes on (its ancestors in other
    // packages, its relationship targets in other packages) must come from
    // the copy of that package the provider itself loads.
    this.verifyProviderCopies(manifest);

    // Report cache rows are safe to scope by tenant even when a report is
    // global: optional mode keeps tenant-less rows readable outside a tenant
    // context and gives tenant-scoped reports the tenant_id column their raw
    // aggregate refresh path must write.
    this.normalizeReportTenantScope(manifest);

    // Second pass: materialize implicit tenant fields before inheritance and schema generation.
    this.injectTenantScopedFields(manifest);

    // Report models default to a read-only surface. Apply that before
    // inheritance, so a report model's collection inherits it and the
    // collection-exposure guard sees it.
    this.applyReportSurfaceDefaults(manifest);

    // Third pass: Merge inherited fields for STI classes
    // This ensures STI subclasses have all parent fields inline in the manifest
    this.mergeInheritedFields(manifest);

    // Confirm every relationship target and report source the scanner traced
    // to another package's export, once inherited fields (a provider
    // parent's included) are in place and before any schema is built from
    // them, by identity and entry. A target written as a bare name names a
    // model of this manifest only (`localBareTarget`).
    this.confirmPackageTargets(manifest);

    // A model subclass may narrow its parent's generated surface but not
    // widen it. Before the abstract pass below, which synthesizes write
    // exclusions on an abstract parent that its concrete subclasses exist to
    // lift.
    this.assertSubclassExposure(manifest);

    // All producers, including OXC, must suppress custom actions on abstract
    // resources and their collection classes. Do this after inheritance so
    // ancestor methods are covered and projections share the same exclusions.
    const objectsByName = new Map(
      Object.values(manifest.objects).map((objectDef) => [
        objectDef.className,
        objectDef,
      ]),
    );
    for (const objectDef of Object.values(manifest.objects)) {
      const config = objectDef.decoratorConfig;
      const isCollection =
        extendsFrameworkCollection(objectDef) ||
        this.extendsCollection(objectDef, objectsByName, manifest);
      let collectionItem: SmartObjectDefinition | undefined;
      if (isCollection) {
        const seenParents = new Set<string>();
        let candidate: SmartObjectDefinition | undefined = objectDef;
        while (candidate) {
          if (candidate.extendsTypeArg || candidate.fields._itemClass) {
            collectionItem = this.findItemClass(
              candidate,
              manifest,
              objectsByName,
            );
            break;
          }
          const parentName = candidate.extendsQualified || candidate.extends;
          if (!parentName || seenParents.has(parentName)) break;
          seenParents.add(parentName);
          candidate = lookupInManifest(manifest, parentName) as
            | SmartObjectDefinition
            | undefined;
        }
        collectionItem ??= this.findItemClass(
          objectDef,
          manifest,
          objectsByName,
        );
      }
      const itemIsAbstract = collectionItem?.decoratorConfig?.abstract === true;
      if (config?.abstract !== true && !itemIsAbstract) continue;
      const methods = Object.entries(objectDef.methods || {})
        .filter(([, method]) => method.isPublic)
        .map(([name]) => name)
        .filter((name) => name !== 'list' && name !== 'get');
      for (const surface of ['api', 'mcp', 'cli'] as const) {
        if (config[surface] === false) continue;
        const current = config[surface];
        const excludes =
          current && typeof current === 'object' && current.exclude
            ? current.exclude
            : [];
        config[surface] = {
          ...(current && typeof current === 'object' ? current : {}),
          exclude: [
            ...new Set([...excludes, 'create', 'update', 'delete', ...methods]),
          ],
        };
      }
    }

    // A collection may not open a generated write its model closes. After
    // the abstract pass above, which closes writes over abstract models.
    this.assertCollectionExposure(manifest);

    // Recipe options may only name fields the merged model declares (#3590).
    this.assertRecipeOptions(manifest);
    this.assertRecipeHelp(manifest);
    // Browser capability of the package and the demo mode of its recipes (#3709).
    applyRecipeDemo(manifest, options?.packageName);

    // Presentation metadata (#3599): widget hints, display label, selector
    // bindings. After inheritance so a label may name an inherited STI column.
    this.applyUiMetadata(manifest);

    // Report models are read-only cache tables. Fill in the generated surface
    // and natural conflict key from report metadata before schema generation.
    this.normalizeReportObjects(manifest);

    // Tenant-scoped classes key on `[tenant column, ...natural key]` (#2360);
    // materialize that default so schema generation, the knowledge artifact
    // and the runtime read the same conflict target.
    this.normalizeConflictColumns(manifest);

    // Fourth pass: Generate validation rules for all objects
    // This pre-computes validation rules from field definitions, eliminating
    // the need to compile validator closures at runtime (Issue #782)
    this.generateValidationRules(manifest);

    // Tables this package retires (#5005), read before the schemas so the
    // stamp that generateSchemas() writes covers them.
    this.applyRetiredTables(manifest, options);

    // Fifth pass: Generate schemas for each object (build-time schema generation)
    // This pre-computes DDL, indexes, and columns for efficient external package consumption.
    // A bare-name foreign key takes its table only from `localBareTarget`, the
    // rule `assertKnownTargets` enforces.
    this.buildSchemas(manifest, 'generation');
    Object.assign(manifest, annotateModelReplacements(manifest));
    this.assertTenantScopedSchemaContract(manifest);

    // Sixth pass: Generate agent manifests for Agent subclasses
    // Derives permissions, features, menuItems, and components from code
    this.generateAgentManifests(
      manifest,
      options?.packageName,
      options?.packageJson,
    );

    // Seventh pass: stamp the subpath consumers should import each object
    // from. `generateManifest()`'s own per-object loop already does this,
    // but the Vite plugin and `ManifestBuilder` (the other two manifest
    // producers this pass sequence exists to keep from drifting, #2360)
    // build their manifest via `ManifestAdapter.toManifest()` and call
    // `applyGenerationPasses()` directly — never through `generateManifest()`
    // — so their objects reached this pass with no `importPath` at all. That
    // is smrt#2845: `DataSurfaceActionIdempotencyState` in
    // `@happyvertical/smrt-agents` lives under `src/server/` (served only by
    // the `./server` export), but the published manifest carried no
    // `importPath`, so consumer registration
    // (`consumer-plugin/index.ts`'s own `determineImportPath`) fell back to
    // the bare package specifier the object was never exported from.
    this.resolveImportPaths(
      manifest,
      options?.packageName,
      options?.packageJson,
    );

    // Last, after the specific checks above have reported what they know:
    // every relationship target and report source names a class this
    // manifest or a dependency's declares. A target recorded under a binding
    // or alias name would point the relationship at no model, or another.
    this.assertKnownTargets(manifest);
  }

  /**
   * Confirm every parent, and every collection item, the scanner traced to
   * ANOTHER package's export (#4145), before any pass walks
   * `extendsQualified`: that package's manifest must declare the class under
   * exactly that qualified name, at the entry the source imports it from.
   *
   * A parent the source imports from another package and no loaded manifest
   * confirms is not "no parent": every later pass would treat the class as a
   * root model, give a single-table child its own table, and skip the surface
   * it inherits. That is a generation error, as is a qualification that is not
   * a valid qualified name at all. Same-package qualifications name this
   * manifest's own classes and are left alone.
   */
  verifyImportedParents(manifest: SmartObjectManifest): void {
    const root = this.dependencyScope?.root ?? process.cwd();
    for (const obj of Object.values(manifest.objects)) {
      const ownPackage = obj.packageName ?? manifest.packageName;
      const parent = obj.extendsQualified;
      if (parent) {
        const fail = (packageName: string, reason: string): never => {
          throw new ConfigurationError(
            `${obj.className} (${obj.filePath}) extends ${obj.extends}, imported from ${packageName}, ` +
              `but its parent cannot be confirmed from ${root}: ${reason}. ` +
              `A class of the same name elsewhere is not the parent the source imports. Without its parent the class ` +
              `would be generated as a root model, with its own table and none of the fields or surface limits it ` +
              `inherits. Import the parent by its class name from the package that declares it, build that package so ` +
              `its manifest exists, and declare it as a dependency of this package.`,
            'CONFIG_UNRESOLVED_IMPORTED_PARENT',
            {
              className: obj.className,
              parent,
              parentPackage: packageName,
              resolutionRoot: root,
            },
          );
        };
        if (!isQualifiedName(parent)) {
          fail(
            parent.split(':')[0] ?? parent,
            `${parent} is not a qualified name (\`@scope/package:Class\`), so it names no package's class`,
          );
        }
        const { packageName } = parseQualifiedName(parent);
        if (packageName !== ownPackage) {
          const confirmed = this.confirmPackageExport(
            parent,
            obj.extendsImportPath,
          );
          if ('reason' in confirmed) fail(packageName, confirmed.reason);
          // Every later pass looks the parent up by the identity the
          // provider's manifest keys it under (its public name), not by the
          // export name the source imports.
          else {
            obj.extendsQualified = this.identityOf(
              confirmed.definition,
              parent,
            );
          }
        }
      }
      const item = obj.extendsTypeArgQualified;
      if (item) {
        const packageName = isQualifiedName(item)
          ? parseQualifiedName(item).packageName
          : item;
        const confirmed = isQualifiedName(item)
          ? packageName === ownPackage
            ? lookupInManifest(manifest, item)
              ? { ok: true }
              : { reason: `this package declares no ${item}` }
            : this.confirmPackageExport(item, obj.extendsTypeArgImportPath)
          : { reason: `${item} is not a qualified name` };
        if ('definition' in confirmed) {
          obj.extendsTypeArgQualified = this.identityOf(
            confirmed.definition,
            item,
          );
        }
        if ('reason' in confirmed) {
          throw new ConfigurationError(
            `${obj.className} (${obj.filePath}) is a collection of ${obj.extendsTypeArg}, imported from ${packageName}, ` +
              `but that item cannot be confirmed from ${root}: ${confirmed.reason}. ` +
              `A class of the same name elsewhere is not the item the source imports; the collection would take its ` +
              `table and surface from another model. Import the item model from the package that declares it, at the ` +
              `entry it is declared at, and declare that package as a dependency.`,
            'CONFIG_UNRESOLVED_IMPORTED_PARENT',
            {
              className: obj.className,
              parent: item,
              parentPackage: packageName,
              resolutionRoot: root,
            },
          );
        }
      }
    }
  }

  /**
   * Fail generation when a confirmed provider parent passes on a class of a
   * THIRD package (an ancestor it extends, or a relationship target it
   * declares) and the copy of that package generation reads from the
   * project root is not the copy the provider loads. Two versions of one
   * package can both export `Room` at the same specifier with different
   * tables; the provider was built against its own copy, so an inherited
   * parent or foreign key resolved through the root's copy would describe a
   * different table. Walks each confirmed provider chain once, to its end:
   * the walk stops only at a parent it has already checked (a shared chain,
   * or a cycle), never at a depth, since the schema passes that follow walk
   * the whole chain too.
   */
  private verifyProviderCopies(manifest: SmartObjectManifest): void {
    const root = this.dependencyScope?.root ?? process.cwd();
    const seen = new Set<SmartObjectDefinition>();
    for (const obj of Object.values(manifest.objects)) {
      const ownPackage = obj.packageName ?? manifest.packageName;
      let ref = obj.extendsQualified;
      if (!ref || !isQualifiedName(ref)) continue;
      if (parseQualifiedName(ref).packageName === ownPackage) continue;
      const visited = new Set<string>();
      while (ref && isQualifiedName(ref) && !visited.has(ref)) {
        visited.add(ref);
        const providerPackage = parseQualifiedName(ref).packageName;
        const providerManifest = this.loadDependencyManifest(providerPackage, {
          warn: false,
        });
        const ancestor = providerManifest
          ? (lookupInManifest(providerManifest, ref) as
              | SmartObjectDefinition
              | undefined)
          : undefined;
        if (!ancestor || seen.has(ancestor)) break;
        seen.add(ancestor);
        const owner = ancestor.packageName ?? providerPackage;
        for (const [fieldName, field] of Object.entries(
          ancestor.fields ?? {},
        )) {
          // Only a relationship that puts a constraint on this table names
          // the target's table in the DDL: a `@foreignKey` whose
          // `constraint` is not false. A `@oneToMany` or `@manyToMany` keeps
          // no key of the target here, and a foreign key without a
          // constraint (or the tenant column) references no table; the same
          // rule decides the constraint in the schema pass.
          if (
            field.type !== 'foreignKey' ||
            field._meta?.constraint === false ||
            field._meta?.__tenancy?.isTenantIdField === true ||
            !field.relatedQualified ||
            !isQualifiedName(field.relatedQualified)
          ) {
            continue;
          }
          const target = parseQualifiedName(field.relatedQualified).packageName;
          const conflict = this.providerCopyConflict(owner, target);
          if (conflict) {
            throw new ConfigurationError(
              `${obj.className} (${obj.filePath}) inherits ${ancestor.className}.${fieldName} from ${owner}, which targets ` +
                `${field.relatedQualified}, but ${conflict}. The relationship would reference a table of another version of ` +
                `${target}. Install one copy of ${target} (dedupe the dependency) so the provider and this build read the same package.`,
              'CONFIG_UNKNOWN_RELATIONSHIP_TARGET',
              {
                className: obj.className,
                field: fieldName,
                target: field.relatedQualified,
                resolutionRoot: root,
              },
            );
          }
        }
        const next = this.parentRef(ancestor, manifest);
        if (!next || !isQualifiedName(next)) break;
        const nextPackage = parseQualifiedName(next).packageName;
        const conflict = this.providerCopyConflict(owner, nextPackage);
        if (conflict) {
          throw new ConfigurationError(
            `${obj.className} (${obj.filePath}) inherits from ${ancestor.className} of ${owner}, which extends ${next}, ` +
              `but ${conflict}. Its table, fields and surface limits would come from another version of ${nextPackage}. ` +
              `Install one copy of ${nextPackage} (dedupe the dependency) so the provider and this build read the same package.`,
            'CONFIG_UNRESOLVED_IMPORTED_PARENT',
            {
              className: obj.className,
              parent: next,
              parentPackage: nextPackage,
              resolutionRoot: root,
            },
          );
        }
        ref = next;
      }
    }
  }

  /**
   * Why the manifest of `target` that generation reads is not the copy of
   * `target` that `owner` loads, or `undefined` when they are the same
   * installed package (or either cannot be found, or `owner` is `target`).
   */
  private providerCopyConflict(
    owner: string,
    target: string,
  ): string | undefined {
    const scope = this.dependencyScope;
    if (!scope || owner === target) return undefined;
    scope.locations ??= discoverSmrtPackageLocations({ baseDir: scope.root });
    const ownerDir =
      scope.locations[owner]?.packageDir ??
      installedPackageDir(owner, scope.root);
    if (!ownerDir) return undefined;
    const fromOwner = installedPackageDir(target, ownerDir);
    const read =
      scope.locations[target]?.packageDir ??
      installedPackageDir(target, scope.root);
    if (!fromOwner || !read) return undefined;
    const real = (path: string) => {
      try {
        return realpathSync(path);
      } catch {
        return path;
      }
    };
    if (real(fromOwner) === real(read)) return undefined;
    // pnpm installs one version of a package in several store directories
    // when its peers resolve differently; those copies are one package.
    const ownerCopy = installedCopyIdentity(real(fromOwner));
    const readCopy = installedCopyIdentity(real(read));
    if (ownerCopy && readCopy && ownerCopy === readCopy) return undefined;
    return `${owner} loads ${target} from ${real(fromOwner)}, while generation reads the manifest of ${real(read)}`;
  }

  /**
   * Confirm `qualified` (`@pkg:Export`), imported from `specifier`, against
   * that package's manifest: it must declare the class (by qualified name,
   * or for a relationship target also by export name), and the full specifier
   * must be the entry it records the class at (`importPath`). Another entry
   * of a package can export a different class under the same name, so a
   * manifest without the entry, or a source without the specifier, is not
   * evidence.
   */
  private confirmPackageExport(
    qualified: string,
    specifier: string | undefined,
  ): { definition: SmartObjectDefinition } | { reason: string } {
    const root = this.dependencyScope?.root ?? process.cwd();
    const { packageName, className: exportName } =
      parseQualifiedName(qualified);
    // A default import: the manifest does not record which class a package
    // exports by default, so the local name proves nothing.
    if (exportName === 'default') {
      return {
        reason: `it is the default export of ${packageName}, and a package manifest does not record which class that is`,
      };
    }
    const dependency = this.loadDependencyManifest(packageName, {
      warn: false,
    });
    if (!dependency) {
      return {
        reason: isPackageResolvableSync(packageName, { baseDir: root })
          ? `${packageName} is installed there but has no readable manifest`
          : `${packageName} resolves to no package there`,
      };
    }
    // A JavaScript export name is exact: an entry found under another case
    // (`ACCOUNT` for the model `Account`) is a different binding, maybe a
    // plain helper the manifest does not list, so it confirms nothing.
    const found = lookupInManifest(dependency, qualified) as
      | SmartObjectDefinition
      | undefined;
    const exactly =
      found &&
      (found.className === exportName ||
        found.exportName === exportName ||
        found.decoratorConfig?.name === exportName)
        ? found
        : undefined;
    // A model whose public name differs from its export (`export class
    // InvoiceRecord` with `@smrt({ name: 'Invoice' })`) is keyed by the
    // public name; the import names the export, so it is found by that exact
    // export name, preferring the entry the import uses.
    const byExport = (
      Object.values(dependency.objects) as SmartObjectDefinition[]
    ).filter(
      (entry) =>
        entry.exportName === exportName &&
        (entry.packageName ?? dependency.packageName) === packageName,
    );
    const definition =
      exactly ??
      byExport.find((entry) => entry.importPath === specifier) ??
      byExport[0];
    if (!definition) {
      return {
        reason: `the manifest of ${packageName} does not declare ${exportName}; if ${packageName} only re-exports it, import it from the package that declares it`,
      };
    }
    if (!specifier) {
      return {
        reason: `the manifest being generated does not record which entry of ${packageName} it is imported from; generate it with this version of the scanner`,
      };
    }
    if (!definition.importPath) {
      return {
        reason: `the manifest of ${packageName} does not record the entry ${exportName} is exported from (importPath), so the import cannot be confirmed; rebuild ${packageName} with this version of SMRT`,
      };
    }
    if (definition.importPath !== specifier) {
      return {
        reason: `it is imported from '${specifier}', but ${packageName} declares ${exportName} at '${definition.importPath}', and another entry of a package can export a different class under the same name; import ${exportName} from '${definition.importPath}'`,
      };
    }
    return { definition };
  }

  /**
   * Fail generation when a relationship target (`@foreignKey`,
   * `@oneToMany`, `@manyToMany`) or a report source (`@report({ source,
   * joins })`) names no class of this manifest or of a dependency whose
   * manifest generation can load. `@crossPackageRef` names its package and
   * is checked at save time instead.
   */
  private assertKnownTargets(manifest: SmartObjectManifest): void {
    const known = (target: string): boolean => {
      // A target may name a column of its class (`'Author.email'`); the class
      // is the part before the first dot of the class name.
      const name = isQualifiedName(target)
        ? `${parseQualifiedName(target).packageName}:${parseQualifiedName(target).className.split('.')[0]}`
        : target.split('.')[0];
      if (lookupInManifest(manifest, name)) return true;
      if (isQualifiedName(name)) {
        const dependency = this.loadDependencyManifest(
          parseQualifiedName(name).packageName,
          { warn: false },
        );
        return Boolean(dependency && lookupInManifest(dependency, name));
      }
      return this.parentPackages(manifest).some((packageName) => {
        const dependency = this.loadDependencyManifest(packageName, {
          warn: false,
        });
        return Boolean(dependency && lookupInManifest(dependency, name));
      });
    };
    // A target the scanner traced to a package export (`@pkg:Export`) was
    // confirmed by identity in `confirmPackageTargets`. A bare name must name
    // a model of this manifest by its exact name (`localBareTarget`, the rule
    // schema generation takes the foreign key's table from).
    const unknown: string[] = [];
    const ambiguous: string[] = [];
    const bare = (
      where: string,
      target: string,
      owner: SmartObjectDefinition,
    ): void => {
      const found = this.localBareTarget(manifest, owner, target);
      if (found.definition) return;
      if (found.localExact.length > 1) {
        ambiguous.push(
          `${where} names "${target}", which matches ${found.localExact
            .map(
              (candidate) =>
                `${candidate.qualifiedName ?? candidate.className} (${candidate.filePath})`,
            )
            .join(', ')}; import the one you mean and pass the class`,
        );
        return;
      }
      const className = target.split('.')[0];
      const candidates = [
        ...this.modelsNamed(manifest, className, 'exact')
          .filter((candidate) => !candidate.local)
          .map((candidate) => `${candidate.label}, another package's model`),
        ...this.modelsNamed(manifest, className, 'other-case').map(
          (candidate) =>
            `${candidate.label}, which differs only in letter case`,
        ),
      ];
      unknown.push(
        candidates.length > 0
          ? `${where} names "${target}", which no model of this package declares by that exact name; it matches ${candidates.join('; ')}`
          : `${where} targets "${target}"`,
      );
    };
    for (const obj of Object.values(manifest.objects)) {
      for (const [fieldName, field] of Object.entries(obj.fields ?? {})) {
        if (
          field.type !== 'foreignKey' &&
          field.type !== 'oneToMany' &&
          field.type !== 'manyToMany'
        ) {
          continue;
        }
        const where = `${obj.className}.${fieldName} (${obj.filePath}): @${field.type}()`;
        if (field.relatedQualified) continue;
        if (typeof field.related !== 'string' || field.related.trim() === '') {
          unknown.push(`${where} names no target`);
        } else if (isQualifiedName(field.related)) {
          if (!known(field.related)) {
            unknown.push(`${where} targets "${field.related}"`);
          }
        } else {
          bare(where, field.related, obj);
        }
      }
      const report = obj.decoratorConfig?.report as
        | {
            source?: unknown;
            sourceQualified?: unknown;
            joins?: Record<
              string,
              { source?: unknown; sourceQualified?: unknown }
            >;
          }
        | undefined;
      const sources: Array<
        [string, { source?: unknown; sourceQualified?: unknown } | undefined]
      > = [
        ['source', report],
        ...Object.entries(report?.joins ?? {}).map(
          ([join, entry]): [string, typeof entry] => [
            `joins.${join}.source`,
            entry,
          ],
        ),
      ];
      for (const [path, holder] of sources) {
        if (!holder) continue;
        if (typeof holder.sourceQualified === 'string') continue;
        const source = holder.source;
        if (typeof source !== 'string' || source === '') continue;
        if (isQualifiedName(source)) {
          if (!known(source)) {
            unknown.push(
              `${obj.className} (${obj.filePath}): @report() ${path} is "${source}"`,
            );
          }
        } else {
          bare(
            `${obj.className} (${obj.filePath}): @report() ${path}`,
            source,
            obj,
          );
        }
      }
    }
    if (unknown.length > 0) {
      throw new ConfigurationError(
        `A relationship target or report source written as a bare name must name a model class of this package ` +
          `by its exact name, and a qualified one a model this package or one of its SMRT dependencies declares; ` +
          `these name none:\n  ${unknown.join('\n  ')}\n` +
          `Write the model's exact name. To reference another package's model, use a qualified @crossPackageRef, ` +
          `or import its class from the package that declares it (built, and a dependency of this package) and pass it.`,
        'CONFIG_UNKNOWN_RELATIONSHIP_TARGET',
        { targets: unknown },
      );
    }
    if (ambiguous.length > 0) {
      throw new ConfigurationError(
        `A relationship target or report source written as a bare name is looked up by that name, so it must ` +
          `match exactly one model of this manifest; these match more than one:\n  ` +
          `${ambiguous.join('\n  ')}\n` +
          `Pass the imported class instead of its name: an imported class is resolved to its one declaration.`,
        'CONFIG_AMBIGUOUS_RELATIONSHIP_TARGET',
        { targets: ambiguous },
      );
    }
  }

  /**
   * The model a relationship target or report source written as a bare class
   * name names: a model of the manifest being generated whose class name is
   * exactly that name, the referring class's own package's first, else the
   * only one. `localExact` lists the exact matches when there is no single
   * one. A dependency's model and a model whose name differs only in letter
   * case are never it. `assertKnownTargets` fails generation for a bare name
   * this finds no model for, and schema generation takes a bare foreign key's
   * table from what this finds and from nothing else.
   */
  private localBareTarget(
    manifest: SmartObjectManifest,
    owner: SmartObjectDefinition,
    target: string,
  ): {
    definition?: SmartObjectDefinition;
    localExact: SmartObjectDefinition[];
  } {
    const className = target.split('.')[0];
    const ownPackage = owner.packageName ?? manifest.packageName;
    const localExact = Object.values(manifest.objects).filter(
      (candidate) => candidate.className === className,
    );
    const own = localExact.find(
      (candidate) =>
        (candidate.packageName ?? manifest.packageName) === ownPackage,
    );
    if (own) return { definition: own, localExact };
    return {
      definition: localExact.length === 1 ? localExact[0] : undefined,
      localExact,
    };
  }

  /**
   * Confirm every relationship target (`relatedQualified`) and report source
   * (`sourceQualified`) the scanner traced to another package's export,
   * inherited fields included, and record the declaring class as the simple
   * target. Runs after inheritance and before schema generation.
   *
   * A confirmed target is pinned to one declaration: schema generation takes
   * its table by identity (`qualifiedTargetSchema`) and the runtime resolves
   * it by constructor and qualified name, so another package's model of the
   * same simple name (smrt-ledgers and smrt-messages both declare `Account`)
   * does not make it ambiguous. Only a target written as a bare name can be;
   * `assertKnownTargets` refuses that.
   */
  private confirmPackageTargets(manifest: SmartObjectManifest): void {
    const root = this.dependencyScope?.root ?? process.cwd();
    const unknown: string[] = [];
    const confirm = (
      where: string,
      qualified: string,
      specifier: string | undefined,
      ownPackage: string | undefined,
    ): SmartObjectDefinition | undefined => {
      if (!isQualifiedName(qualified)) {
        unknown.push(`${where} is ${qualified}, which is not a qualified name`);
        return undefined;
      }
      if (parseQualifiedName(qualified).packageName === ownPackage) {
        const own = lookupInManifest(manifest, qualified) as
          | SmartObjectDefinition
          | undefined;
        if (!own) unknown.push(`${where} is ${qualified}`);
        return own;
      }
      const confirmed = this.confirmPackageExport(qualified, specifier);
      if ('reason' in confirmed) {
        unknown.push(`${where} is ${qualified}: ${confirmed.reason}`);
        return undefined;
      }
      return confirmed.definition;
    };
    for (const obj of Object.values(manifest.objects)) {
      const ownPackage = obj.packageName ?? manifest.packageName;
      for (const [fieldName, field] of Object.entries(obj.fields ?? {})) {
        if (
          !field.relatedQualified ||
          (field.type !== 'foreignKey' &&
            field.type !== 'oneToMany' &&
            field.type !== 'manyToMany')
        ) {
          continue;
        }
        const declared = confirm(
          `${obj.className}.${fieldName} (${obj.filePath}): @${field.type}() target`,
          field.relatedQualified,
          field.relatedImportPath,
          ownPackage,
        );
        if (declared) {
          // The class is the declaring one; a referenced column written
          // after it (`'Room.code'`) stays, so the constraint keeps it.
          const written =
            typeof field.related === 'string'
              ? field.related.slice(field.related.lastIndexOf(':') + 1)
              : '';
          const dot = written.indexOf('.');
          field.related =
            dot >= 0
              ? `${declared.className}${written.slice(dot)}`
              : declared.className;
          // The declaring class's identity, which an export name may differ from.
          field.relatedQualified = this.identityOf(
            declared,
            field.relatedQualified,
          );
        }
      }
      const report = obj.decoratorConfig?.report as
        | (Record<string, unknown> & {
            joins?: Record<string, Record<string, unknown>>;
          })
        | undefined;
      const holders: Array<[string, Record<string, unknown> | undefined]> = [
        ['source', report],
        ...Object.entries(report?.joins ?? {}).map(
          ([join, entry]): [string, Record<string, unknown>] => [
            `joins.${join}.source`,
            entry,
          ],
        ),
      ];
      for (const [path, holder] of holders) {
        if (!holder || typeof holder.sourceQualified !== 'string') continue;
        const declared = confirm(
          `${obj.className} (${obj.filePath}): @report() ${path}`,
          holder.sourceQualified,
          typeof holder.sourceImportPath === 'string'
            ? holder.sourceImportPath
            : undefined,
          ownPackage,
        );
        if (declared) {
          holder.source = declared.className;
          holder.sourceQualified = this.identityOf(
            declared,
            holder.sourceQualified,
          );
        }
      }
    }
    if (unknown.length > 0) {
      throw new ConfigurationError(
        `Relationship and report targets imported from another package must be that package's model, ` +
          `imported from the entry its manifest declares it at; these cannot be confirmed from ${root}:\n  ${unknown.join('\n  ')}\n` +
          `Import the model class from the package that declares it, build that package so its manifest exists, ` +
          `and declare it as a dependency of this package.`,
        'CONFIG_UNKNOWN_RELATIONSHIP_TARGET',
        { targets: unknown },
      );
    }
  }

  /**
   * The distinct models a refused bare name is reported against: this
   * manifest's and those of every package it reads (`parentPackages`), named
   * exactly `className` (`exact`), or named like it in another letter case
   * only (`other-case`). None of them is ever resolved to (`localBareTarget`
   * resolves). An app class that replaces another of them (#4921: it extends
   * that class and shares its table) is the same table, so it is not a second
   * candidate.
   */
  private modelsNamed(
    manifest: SmartObjectManifest,
    className: string,
    match: 'exact' | 'other-case',
  ): NamedModel[] {
    const tableOf = (definition: SmartObjectDefinition) =>
      definition.schema?.tableName ??
      definition.decoratorConfig?.tableName ??
      this.classNameToTableName(definition.className);
    const found = new Map<string, NamedModel>();
    const lower = className.toLowerCase();
    const named = (from: SmartObjectManifest) =>
      Object.values(from.objects).filter((candidate) =>
        match === 'exact'
          ? candidate.className === className
          : candidate.className !== className &&
            candidate.className?.toLowerCase() === lower,
      );
    for (const candidate of named(manifest)) {
      const identity =
        candidate.qualifiedName ??
        (manifest.packageName
          ? createQualifiedName(manifest.packageName, candidate.className)
          : candidate.className);
      found.set(identity, {
        identity,
        label: `${identity} (${candidate.filePath})`,
        definition: candidate,
        local: true,
      });
    }
    for (const packageName of this.parentPackages(manifest)) {
      const dependency = this.loadDependencyManifest(packageName, {
        warn: false,
      });
      if (!dependency) continue;
      for (const candidate of named(dependency) as SmartObjectDefinition[]) {
        const identity =
          candidate.qualifiedName ??
          createQualifiedName(packageName, candidate.className);
        if (found.has(identity)) continue;
        // The entry and export name the provider's manifest records are the
        // import its consumers are confirmed against.
        found.set(identity, {
          identity,
          label: `${identity} (dependency ${packageName}; import { ${candidate.exportName ?? candidate.className} } from '${candidate.importPath ?? packageName}')`,
          definition: candidate,
          local: false,
        });
      }
    }
    const all = [...found.values()];
    return all.filter(
      (candidate) =>
        !all.some(
          (other) =>
            other !== candidate &&
            candidate.definition.extendsQualified === other.identity &&
            tableOf(candidate.definition) === tableOf(other.definition),
        ),
    );
  }

  /** The qualified identity of `definition`, declared in `qualified`'s package. */
  private identityOf(
    definition: SmartObjectDefinition,
    qualified: string,
  ): string {
    return (
      definition.qualifiedName ??
      createQualifiedName(
        parseQualifiedName(qualified).packageName,
        definition.className,
      )
    );
  }

  /**
   * The packages a manifest's parents can come from: its `smrtDependencies`,
   * then the package of every confirmed import-qualified parent.
   *
   * A parent's package is not always a listed dependency: the list comes from
   * package discovery, and an app may extend a class of a package it names
   * only in its consumer configuration. `verifyImportedParents` confirmed the
   * parent against that package's manifest, so every later pass must be able
   * to load it from there too. A parent that is confirmed and then not found
   * would be generated as if it did not exist.
   */
  private parentPackages(manifest: SmartObjectManifest): string[] {
    const packages = new Set(manifest.smrtDependencies ?? []);
    for (const obj of Object.values(manifest.objects)) {
      const parent = obj.extendsQualified;
      if (!parent || !isQualifiedName(parent)) continue;
      const { packageName } = parseQualifiedName(parent);
      if (packageName !== (obj.packageName ?? manifest.packageName)) {
        packages.add(packageName);
      }
    }
    return [...packages];
  }

  /**
   * The name to resolve an object's parent by: the import-derived qualified
   * name when the scanner traced one (#4145), else the simple `extends`.
   *
   * With `manifest`, the parent of a class from ANOTHER package's manifest
   * (an ancestor reached through a confirmed provider parent) is qualified
   * with that package: its bare `extends` names a class of the provider, and
   * read by simple name here it could bind this app's class of that name and
   * give the child the app's table.
   */
  private parentRef(
    obj: SmartObjectDefinition,
    manifest?: SmartObjectManifest,
  ): string | undefined {
    if (obj.extendsQualified) return obj.extendsQualified;
    if (!obj.extends || !manifest) return obj.extends;
    const owner = obj.packageName;
    if (
      !owner ||
      owner === manifest.packageName ||
      Object.values(manifest.objects).includes(obj) ||
      FRAMEWORK_ABSTRACT_BASE_NAMES.has(obj.extends) ||
      FRAMEWORK_METHOD_BASE_NAMES.has(obj.extends) ||
      isSmrtCollectionExtendsName(obj.extends)
    ) {
      return obj.extends;
    }
    return createQualifiedName(owner, obj.extends);
  }

  /**
   * Resolve a parent reference from {@link parentRef}. A qualified reference
   * matches only that package's class (this manifest's, else the dependency's
   * manifest), never a same-named class of another package; a simple one
   * keeps the established local-then-dependency lookup. `child` is skipped so
   * a local class named like its imported parent never resolves to itself.
   */
  private resolveParentDefinition(
    ref: string,
    child: SmartObjectDefinition | undefined,
    manifest: SmartObjectManifest,
    objectsByName: Map<string, SmartObjectDefinition>,
  ): SmartObjectDefinition | undefined {
    let parent: SmartObjectDefinition | undefined = isQualifiedName(ref)
      ? (manifest.objects[ref] as SmartObjectDefinition | undefined)
      : objectsByName.get(ref);
    if (parent === child) parent = undefined;
    if (!parent && isQualifiedName(ref)) {
      // A qualified parent is that package's class: read its manifest first,
      // whether or not it is a listed dependency.
      const owner = this.loadDependencyManifest(
        parseQualifiedName(ref).packageName,
        { warn: false },
      );
      parent = owner
        ? (lookupInManifest(owner, ref) as SmartObjectDefinition | undefined)
        : undefined;
    }
    if (!parent) {
      const packages = this.parentPackages(manifest);
      if (packages.length > 0) {
        parent = this.loadParentFromExternalPackage(
          ref,
          packages,
          objectsByName,
        );
      }
    }
    return parent === child ? undefined : parent;
  }

  /**
   * `obj`'s parent among `objectsByName` (keyed by class name), without
   * loading dependency manifests. An import-qualified parent only matches a
   * definition of that package, never a same-named class of another one
   * (#4176); a definition carrying no package identity still matches by name.
   * `manifest` is the one `objectsByName` was built from, where a qualified
   * parent that lost its class-name slot is still found.
   */
  private namedParent(
    obj: SmartObjectDefinition,
    objectsByName: Map<string, SmartObjectDefinition>,
    manifest?: SmartObjectManifest,
  ): SmartObjectDefinition | undefined {
    const qualified = obj.extendsQualified;
    if (!qualified) {
      return obj.extends ? objectsByName.get(obj.extends) : undefined;
    }
    const direct = objectsByName.get(qualified);
    if (direct) return direct;
    const identity = (candidate: SmartObjectDefinition) =>
      candidate.qualifiedName ??
      (candidate.packageName
        ? `${candidate.packageName}:${candidate.className}`
        : undefined);
    const candidate = objectsByName.get(this.simpleClassName(qualified));
    if (candidate && (identity(candidate) ?? qualified) === qualified) {
      return candidate;
    }
    // The class-name slot may hold another package's same-named class; the
    // imported one is then still in the manifest the map was built from.
    const keyed = manifest?.objects[qualified] as
      | SmartObjectDefinition
      | undefined;
    if (keyed) return keyed;
    for (const definition of [
      ...objectsByName.values(),
      ...Object.values(manifest?.objects ?? {}),
    ] as SmartObjectDefinition[]) {
      if (identity(definition) === qualified) return definition;
    }
    return undefined;
  }

  /**
   * Stamp `importPath` (via {@link determineImportPath}) on every object
   * that does not already have one. Safe to call unconditionally: objects
   * that went through `generateManifest()`'s own inline assignment already
   * carry an `importPath` and are left untouched.
   */
  resolveImportPaths(
    manifest: SmartObjectManifest,
    packageName?: string,
    packageJson?: PackageJsonLike,
  ): void {
    if (!packageName || !packageJson) return;

    for (const obj of Object.values(manifest.objects)) {
      if (obj.importPath) continue;
      obj.importPath = this.determineImportPath(packageJson, obj.filePath);
    }
  }

  /**
   * Materialize tenantScoped schema fields.
   *
   * Runtime registration already injects tenant fields for
   * `@smrt({ tenantScoped: true })`, but published manifests must contain the
   * same field before schema generation so migrations create `tenant_id`.
   */
  injectTenantScopedFields(manifest: SmartObjectManifest): void {
    for (const objectDef of Object.values(manifest.objects)) {
      this.injectTenantScopedField(objectDef);
    }
  }

  private injectTenantScopedField(objectDef: SmartObjectDefinition): void {
    const tenantScoped = objectDef.decoratorConfig?.tenantScoped;
    if (!tenantScoped) {
      return;
    }

    const { tenantConfig } = this.normalizeTenantScopedConfig(tenantScoped);
    const fieldName = tenantConfig.field;
    const existingField = objectDef.fields[fieldName];
    const tenancyMeta = {
      isTenantIdField: true,
      ...tenantConfig,
    };

    if (existingField) {
      const fieldTypeFailure = this.getTenantScopedFieldTypeFailure(
        objectDef,
        fieldName,
      );
      if (fieldTypeFailure) {
        throw new Error(
          `Tenant-scoped field configuration invalid: ${fieldTypeFailure}`,
        );
      }

      existingField._meta = {
        ...existingField._meta,
        sqlType: 'UUID',
        __tenancy: {
          ...existingField._meta?.__tenancy,
          ...tenancyMeta,
        },
      };
      return;
    }

    objectDef.fields[fieldName] = {
      type: 'text',
      // Use the normalized tenant mode so the boolean shorthand has the same
      // requiredness in manifests as it does during runtime registration.
      required: tenantConfig.mode === 'required',
      _meta: {
        generated: true,
        source: 'tenantScoped_decorator',
        sqlType: 'UUID',
        __tenancy: tenancyMeta,
      },
    };

    logger.debug(
      `[manifest-generator] Injected ${fieldName} field for ${objectDef.className} (tenantScoped: ${JSON.stringify(tenantConfig)})`,
    );
  }

  /**
   * Fail the build when a recipe's `options` name a field its model does not
   * declare (#3590). Runs after inherited fields merge, because only the merged
   * manifest knows STI-merged, injected tenant, and framework-base fields
   * (`SmrtHierarchical.parentId`); the scanner sees class bodies alone. The
   * universal `SmrtObject` fields exist on every object but are not manifest
   * fields, so they are accepted by name.
   */
  assertRecipeOptions(manifest: SmartObjectManifest): void {
    const problems: string[] = [];
    for (const recipe of manifest.recipes ?? []) {
      for (const entry of recipe.nav) {
        if (!entry.filter) continue;
        const object = Object.values(manifest.objects).find(
          (candidate) =>
            (candidate.qualifiedName ?? candidate.className) === entry.model,
        );
        if (
          object &&
          !Object.keys(object.fields).includes(entry.filter.field) &&
          !UNIVERSAL_OBJECT_FIELDS.includes(entry.filter.field as never)
        ) {
          problems.push(
            `recipe ${recipe.id}: nav "${entry.label}" filters on "${entry.filter.field}", which ${object.className} does not declare`,
          );
        }
      }
      for (const [model, options] of Object.entries(recipe.options ?? {})) {
        const object = Object.values(manifest.objects).find(
          (candidate) =>
            (candidate.qualifiedName ?? candidate.className) === model,
        );
        if (!object) {
          problems.push(
            `recipe ${recipe.id}: options name ${model}, which is not an object in this package`,
          );
          continue;
        }
        const declared = new Set([
          ...Object.keys(object.fields),
          ...UNIVERSAL_OBJECT_FIELDS,
        ]);
        for (const field of Object.keys(options.fields ?? {})) {
          if (!declared.has(field)) {
            problems.push(
              `recipe ${recipe.id}: options.${object.className}.fields.${field}: ${object.className} declares no field "${field}"; options only refine fields the model already declares`,
            );
          }
        }
      }
    }
    if (problems.length > 0) {
      throw new Error(
        `[manifest-generator] invalid recipe options:\n  ${problems.join('\n  ')}`,
      );
    }
  }

  /**
   * Fail the build when a recipe's help refers to a field its models do not
   * declare, or its `fieldRefs` disagree with the Markdown (#3591). Runs on the
   * merged manifest for the same reason as {@link assertRecipeOptions}. The
   * scanner derives `fieldRefs` with its own copy of the reference grammar
   * (it cannot import core); re-deriving here with the real parser means the
   * two can never silently diverge.
   */
  assertRecipeHelp(manifest: SmartObjectManifest): void {
    const problems: string[] = [];
    for (const recipe of manifest.recipes ?? []) {
      if (!recipe.help) continue;
      const models: HelpModel[] = [];
      const sensitiveByModel = new Map<string, Set<string>>();
      for (const model of recipe.models) {
        const object = Object.values(manifest.objects).find(
          (candidate) =>
            (candidate.qualifiedName ?? candidate.className) === model,
        );
        if (!object) continue;
        const sensitive = Object.entries(object.fields)
          .filter(
            ([, field]) =>
              field.sensitive === true || field._meta?.sensitive === true,
          )
          .map(([name]) => name);
        models.push({
          id: model,
          name: object.className,
          // Declared fields only: the universal ones (`slug`, `id`, ...) are not
          // manifest fields, so they never reach the knowledge artifact and a
          // host building its field list from it would drop the step.
          fields: Object.keys(object.fields).map((name) => ({
            name,
            label: name,
            visibility: 'basic',
          })),
        });
        sensitiveByModel.set(object.className, new Set(sensitive));
      }
      for (const problem of validateHelp(recipe.help, models)) {
        problems.push(`recipe ${recipe.id}: help: ${problem}`);
      }
      // Sensitive fields never reach the knowledge artifact, so a host that
      // builds its field list from it would silently drop the step that names
      // one. Keep help prose free of them.
      for (const ref of recipe.help.fieldRefs) {
        const found = findField(ref, models);
        if (
          found &&
          sensitiveByModel.get(found.model.name)?.has(found.field.name)
        ) {
          problems.push(
            `recipe ${recipe.id}: help: {field:${ref}} names a sensitive field; sensitive fields are excluded from the knowledge artifact, so describe it without a field reference`,
          );
        }
      }
    }
    if (problems.length > 0) {
      throw new Error(
        `[manifest-generator] invalid recipe help:\n  ${problems.join('\n  ')}`,
      );
    }
  }

  /**
   * Validate every `decoratorConfig.previousQualifiedNames` declaration
   * (#3338). The declaration rides into the manifest verbatim — it is the
   * lazy loader's alias index — so a malformed or colliding alias must stop
   * the build rather than ship a manifest the runtime will refuse:
   *
   * - an array of scoped `@scope/package:ClassName` strings, each listed once;
   * - never the object's own qualified name, nor any object of this manifest;
   * - never declared by two objects of this manifest.
   */
  assertQualifiedNameAliases(manifest: SmartObjectManifest): void {
    const ownNames = new Set<string>();
    for (const [key, obj] of Object.entries(manifest.objects)) {
      ownNames.add(obj.qualifiedName ?? key);
    }
    const claimedBy = new Map<string, string>();
    for (const key of Object.keys(manifest.objects).sort(compareText)) {
      const obj = manifest.objects[key];
      const owner = obj.qualifiedName ?? key;
      const declared = (
        obj.decoratorConfig as { previousQualifiedNames?: unknown } | undefined
      )?.previousQualifiedNames;
      if (declared === undefined) continue;
      if (!Array.isArray(declared)) {
        throw new Error(
          `[manifest-generator] ${owner}: previousQualifiedNames must be an array of qualified names ("@package/name:ClassName").`,
        );
      }
      const aliases = readPreviousQualifiedNames(obj.decoratorConfig);
      if (aliases.length !== declared.length) {
        throw new Error(
          `[manifest-generator] ${owner}: previousQualifiedNames must contain only string literals.`,
        );
      }
      const seen = new Set<string>();
      for (const alias of aliases) {
        if (!isQualifiedNameAliasFormat(alias)) {
          throw new Error(
            `[manifest-generator] ${owner}: previousQualifiedNames entry "${alias}" is not a qualified name ("@package/name:ClassName").`,
          );
        }
        if (seen.has(alias)) {
          throw new Error(
            `[manifest-generator] ${owner}: previousQualifiedNames lists "${alias}" more than once.`,
          );
        }
        seen.add(alias);
        if (ownNames.has(alias)) {
          throw new Error(
            `[manifest-generator] ${owner}: previousQualifiedNames "${alias}" names a live object of this package; an alias may only name a class that no longer exists.`,
          );
        }
        const other = claimedBy.get(alias);
        if (other) {
          throw new Error(
            `[manifest-generator] previousQualifiedNames "${alias}" is declared by both ${other} and ${owner}; an old name can resolve to only one class.`,
          );
        }
        claimedBy.set(alias, owner);
      }
    }
  }

  /**
   * Validate and resolve presentation metadata (#3599), failing the build on
   * a declaration no host could honor:
   *
   * - `@field({ ui: { widget } })` must name a known widget the field's type
   *   accepts (every widget is text-only; `currency` is an ISO 4217 code
   *   picker, not an amount).
   * - `@smrt({ display: { label } })` must name an own, non-sensitive,
   *   non-transient, non-relationship field, or one public reference hop.
   * - A selector slot's `selects` must resolve when it names this package.
   *
   * Also stamps each object's resolved `displayLabelField` (the declared field,
   * else the first of name/title/label/code).
   */
  applyUiMetadata(manifest: SmartObjectManifest): void {
    const failures: string[] = [];
    const aggregated = this.createAggregatedManifest(manifest);

    for (const key of Object.keys(manifest.objects).sort(compareText)) {
      const obj = manifest.objects[key];
      const owner = obj.qualifiedName ?? key;

      for (const [fieldName, field] of Object.entries(obj.fields)) {
        const role = (field._meta as { role?: unknown } | undefined)?.role;
        if (role !== undefined) {
          if (!isRelationshipRole(role)) {
            failures.push(
              `${owner}.${fieldName}: role ${JSON.stringify(role)} is not one of ${RELATIONSHIP_ROLES.join(', ')}.`,
            );
          } else if (
            field.type !== 'foreignKey' &&
            field.type !== 'crossPackageRef'
          ) {
            failures.push(
              `${owner}.${fieldName}: role "${role}" needs a foreignKey or crossPackageRef field, but this field is ${field.type}.`,
            );
          }
        }
        const ui = field._meta?.ui as
          | { widget?: unknown; format?: unknown }
          | undefined;
        if (!ui || typeof ui !== 'object') continue;
        if (ui.format !== undefined) {
          if (!isFieldUIFormat(ui.format)) {
            failures.push(
              `${owner}.${fieldName}: ui.format ${JSON.stringify(ui.format)} is not one of ${FIELD_UI_FORMATS.join(', ')}.`,
            );
          } else if (!FIELD_UI_FORMAT_TYPES[ui.format].includes(field.type)) {
            failures.push(
              `${owner}.${fieldName}: ui.format "${ui.format}" needs a field of type ${FIELD_UI_FORMAT_TYPES[ui.format].join(' or ')}, but this field is ${field.type}.`,
            );
          }
        }
        if (ui.widget === undefined) continue;
        if (!isFieldUIWidget(ui.widget)) {
          failures.push(
            `${owner}.${fieldName}: ui.widget ${JSON.stringify(ui.widget)} is not one of ${FIELD_UI_WIDGETS.join(', ')}.`,
          );
        } else if (!FIELD_UI_WIDGET_TYPES[ui.widget].includes(field.type)) {
          failures.push(
            `${owner}.${fieldName}: ui.widget "${ui.widget}" needs a field of type ${FIELD_UI_WIDGET_TYPES[ui.widget].join(' or ')}, but this field is ${field.type}.`,
          );
        }
      }

      if (obj.decoratorConfig?.writeThrough) {
        obj.writeThroughFields = writeThroughFields(
          obj.fields,
          obj.decoratorConfig.writeThrough,
          (via) => {
            const related = obj.fields[via]?.related;
            const target =
              typeof related === 'string'
                ? lookupInManifest(aggregated, related)
                : undefined;
            if (!target)
              throw new Error(`writeThrough target ${related} is unavailable`);
            return target.fields;
          },
        );
      }
      const display = (obj.decoratorConfig as { display?: unknown } | undefined)
        ?.display;
      let declared: string | undefined;
      delete obj.displayLabelProjection;
      if (display !== undefined) {
        const label =
          display && typeof display === 'object'
            ? (display as { label?: unknown }).label
            : undefined;
        if (label && typeof label === 'object') {
          try {
            const projection = resolveDisplayLabelProjection(label);
            if (!projection) throw new Error('Invalid display projection.');
            const edge = obj.fields[projection.via];
            if (
              !edge ||
              (!['foreignKey', 'crossPackageRef'].includes(edge.type) &&
                !(
                  edge.type === 'text' &&
                  typeof obj.decoratorConfig?.display?.references?.[
                    projection.via
                  ] === 'string' &&
                  obj.decoratorConfig.display.references[
                    projection.via
                  ].includes(':')
                )) ||
              edge.sensitive ||
              edge._meta?.sensitive ||
              edge.transient ||
              edge._meta?.transient ||
              edge.readPermission ||
              edge._meta?.readPermission
            ) {
              throw new Error(
                'display.label.via must name a public, persisted foreignKey or crossPackageRef.',
              );
            }
            if (
              Object.keys(obj.fields).some(
                (name) => toSnakeCase(name) === 'display_label',
              )
            ) {
              throw new Error(
                'displayLabel is reserved for the projected label.',
              );
            }
            const related = ['foreignKey', 'crossPackageRef'].includes(
              edge.type,
            )
              ? edge.related
              : obj.decoratorConfig?.display?.references?.[projection.via];
            const target =
              typeof related === 'string'
                ? lookupInManifest(aggregated, related)
                : undefined;
            if (!target)
              throw new Error(
                `display.label target ${related} is unavailable; include its owning package in smrtDependencies.`,
              );
            const targetField = target.fields[projection.field];
            const problem =
              displayLabelFieldProblem(target.fields, projection.field) ??
              (targetField?.readPermission || targetField?._meta?.readPermission
                ? 'it is a permission-gated field'
                : null);
            if (problem)
              throw new Error(
                `display.label target ${related}.${projection.field}: ${problem}.`,
              );
            obj.displayLabelProjection = projection;
          } catch (error) {
            failures.push(
              `${owner}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        } else if (
          label !== undefined &&
          (typeof label !== 'string' || label === '')
        ) {
          failures.push(
            `${owner}: display.label must be the name of an own field or a one-hop projection, not ${JSON.stringify(label)}.`,
          );
        } else if (typeof label === 'string') {
          const problem = displayLabelFieldProblem(obj.fields, label);
          if (problem) {
            failures.push(
              `${owner}: display.label "${label}" cannot label a record: ${problem}.`,
            );
          } else {
            declared = label;
          }
        } else if (display === null || typeof display !== 'object') {
          failures.push(`${owner}: display must be an object ({ label }).`);
        }
      }
      const resolved = obj.displayLabelProjection
        ? DISPLAY_LABEL_FIELD
        : resolveDisplayLabelField(obj.fields, declared);
      if (resolved) {
        obj.displayLabelField = resolved;
      } else {
        delete obj.displayLabelField;
      }
    }

    const own = new Set<string>();
    for (const [key, obj] of Object.entries(manifest.objects)) {
      own.add(obj.qualifiedName ?? key);
    }
    for (const [slotId, selector] of Object.entries(
      manifest.uiSelectors ?? {},
    )) {
      const target = selector.selects;
      const targetPackage = target.slice(0, target.indexOf(':'));
      if (
        manifest.packageName &&
        targetPackage === manifest.packageName &&
        !own.has(target)
      ) {
        failures.push(
          `UI slot "${slotId}" selects ${target}, which is not an object of ${manifest.packageName}.`,
        );
      }
    }

    if (failures.length > 0) {
      throw new Error(
        `UI metadata invalid:\n${failures.map((f) => `  - ${f}`).join('\n')}`,
      );
    }
  }

  assertTenantScopedSchemaContract(manifest: SmartObjectManifest): void {
    const failures: string[] = [];

    for (const objectDef of Object.values(manifest.objects)) {
      const tenantScoped = objectDef.decoratorConfig?.tenantScoped;
      if (!tenantScoped) {
        continue;
      }

      const { tenantConfig } = this.normalizeTenantScopedConfig(tenantScoped);
      const fieldName = tenantConfig.field;
      const columnName = toSnakeCase(fieldName);

      if (!objectDef.fields[fieldName]) {
        failures.push(
          `${objectDef.className}: missing tenant-scoped field "${fieldName}"`,
        );
        continue;
      }

      const fieldTypeFailure = this.getTenantScopedFieldTypeFailure(
        objectDef,
        fieldName,
      );
      if (fieldTypeFailure) {
        failures.push(fieldTypeFailure);
        continue;
      }

      const schemaOwner = this.getTenantScopedSchemaOwner(objectDef, manifest);
      const schemaOwnerContext =
        schemaOwner === objectDef
          ? ''
          : ` on STI base "${schemaOwner.className}"`;

      if (!schemaOwner.schema?.columns) {
        failures.push(
          `${objectDef.className}: schema has not been generated for tenant-scoped column "${columnName}"${schemaOwnerContext}`,
        );
        continue;
      }

      if (!schemaOwner.schema.columns[columnName]) {
        failures.push(
          `${objectDef.className}: schema is missing tenant-scoped column "${columnName}"${schemaOwnerContext}`,
        );
      }
    }

    if (failures.length > 0) {
      throw new Error(
        `Tenant-scoped schema contract failed:\n${failures
          .map((failure) => `  - ${failure}`)
          .join('\n')}`,
      );
    }
  }

  private getTenantScopedSchemaOwner(
    objectDef: SmartObjectDefinition,
    manifest: SmartObjectManifest,
  ): SmartObjectDefinition {
    if (!this.isSTIChildClass(objectDef, manifest)) {
      return objectDef;
    }

    const stiBase = this.findSTIBaseInfo(objectDef, manifest);
    if (!stiBase) {
      return objectDef;
    }

    const localBase = Object.values(manifest.objects).find(
      (candidate) => candidate.className === stiBase.className,
    );

    return localBase ?? objectDef;
  }

  private getTenantScopedFieldTypeFailure(
    objectDef: SmartObjectDefinition,
    fieldName: string,
  ): string | undefined {
    const field = objectDef.fields[fieldName];
    if (!field) {
      return undefined;
    }

    if (field.type !== 'text' && field.type !== 'foreignKey') {
      return `${objectDef.className}: tenant-scoped field "${fieldName}" must use type "text" or "foreignKey"; received "${field.type}"`;
    }

    const sqlType = field._meta?.sqlType;
    if (sqlType && !['TEXT', 'UUID'].includes(String(sqlType).toUpperCase())) {
      return `${objectDef.className}: tenant-scoped field "${fieldName}" must use SQL type "UUID" or legacy "TEXT"; received "${sqlType}"`;
    }

    return undefined;
  }

  private normalizeTenantScopedConfig(tenantScoped: unknown): {
    tenantConfig: {
      mode: string;
      field: string;
      autoFilter: boolean;
      autoPopulate: boolean;
      allowSuperAdminBypass: boolean;
    };
  } {
    const tenantOptions: TenantScopedOptions =
      typeof tenantScoped === 'boolean'
        ? {}
        : (tenantScoped as TenantScopedOptions);

    return {
      tenantConfig: {
        mode: tenantOptions.mode ?? 'required',
        field: tenantOptions.field ?? 'tenantId',
        autoFilter: tenantOptions.autoFilter ?? true,
        autoPopulate: tenantOptions.autoPopulate ?? true,
        allowSuperAdminBypass: tenantOptions.allowSuperAdminBypass ?? false,
      },
    };
  }

  /**
   * Generate pre-computed validation rules for all objects in the manifest.
   *
   * This extracts validation constraints (required, min, max, minLength, maxLength, pattern)
   * from field definitions and stores them as serializable rules in the manifest.
   *
   * At runtime, these rules can be evaluated without creating validator closures,
   * significantly reducing CLI startup time for projects with many SMRT objects.
   *
   * @param manifest - The manifest to process in-place
   */
  generateValidationRules(manifest: SmartObjectManifest): void {
    for (const [name, obj] of Object.entries(manifest.objects)) {
      let generatedValidated = false;
      const rules: ValidationRule[] = [];
      let skippedAutoPopulatedTenantRequiredRule = false;

      for (const [fieldName, field] of Object.entries(obj.fields)) {
        if (!generatedValidated && generatedExpression(field) !== undefined) {
          validateGeneratedFields(new Map(Object.entries(obj.fields)));
          generatedValidated = true;
        }

        // Skip transient fields (they're not persisted, so no validation needed)
        if (
          field.transient ||
          field._meta?.transient ||
          generatedExpression(field) !== undefined
        ) {
          continue;
        }

        const options = field._meta || {};

        // Required field rule
        const isAutoPopulatedTenantField =
          options.__tenancy?.isTenantIdField === true &&
          options.__tenancy.autoPopulate !== false;
        if (
          (options.required || field.required) &&
          !isAutoPopulatedTenantField
        ) {
          rules.push({
            field: fieldName,
            rule: 'required',
            fieldType: field.type,
          });
        } else if (
          isAutoPopulatedTenantField &&
          (options.required || field.required)
        ) {
          // Tenant IDs can be required in the manifest and database while still
          // being absent at this pre-interceptor validation stage. Tenancy's
          // beforeSave hook stamps them from the active context before writing.
          skippedAutoPopulatedTenantRequiredRule = true;
        }

        // Numeric range rules (for integer, decimal fields)
        if (field.type === 'integer' || field.type === 'decimal') {
          if (options.min !== undefined || field.min !== undefined) {
            rules.push({
              field: fieldName,
              rule: 'min',
              value: options.min ?? field.min,
              fieldType: field.type,
            });
          }

          if (options.max !== undefined || field.max !== undefined) {
            rules.push({
              field: fieldName,
              rule: 'max',
              value: options.max ?? field.max,
              fieldType: field.type,
            });
          }
        }

        // String length rules (for text fields)
        if (field.type === 'text') {
          if (
            options.minLength !== undefined ||
            field.minLength !== undefined
          ) {
            rules.push({
              field: fieldName,
              rule: 'minLength',
              value: options.minLength ?? field.minLength,
              fieldType: field.type,
            });
          }

          if (
            options.maxLength !== undefined ||
            field.maxLength !== undefined
          ) {
            rules.push({
              field: fieldName,
              rule: 'maxLength',
              value: options.maxLength ?? field.maxLength,
              fieldType: field.type,
            });
          }

          // Pattern rule (regex validation)
          // Note: Custom validator functions (options.validate) cannot be serialized
          // and will fall back to compiled validators at runtime
          // Note: Pattern is only available in field options, not in FieldDefinition
          const pattern = options.pattern;
          if (pattern) {
            rules.push({
              field: fieldName,
              rule: 'pattern',
              // RegExp patterns expose `.source`; a JSON-collapsed RegExp ({})
              // has none, preserving the prior `undefined` value exactly.
              value:
                typeof pattern === 'string'
                  ? pattern
                  : (pattern as { source?: string }).source,
              fieldType: field.type,
            });
          }
        }
      }

      // An explicit empty list is meaningful when the sole required field is
      // auto-populated by tenancy: it prevents runtime registration from
      // recompiling a pre-interceptor required validator for that field.
      if (rules.length > 0 || skippedAutoPopulatedTenantRequiredRule) {
        obj.validationRules = rules;
      }
    }
  }

  /**
   * Generate pre-computed schemas for all objects in the manifest.
   *
   * This enables external package consumers to use pre-generated schemas
   * without calling generateSchema() at runtime, eliminating latency.
   *
   * IMPORTANT: For STI classes, we aggregate ALL descendants from both local
   * and external packages to ensure complete schemas are generated.
   *
   * This method is public to allow external callers (like OXC scanner) to use it.
   * A direct call keeps the legacy lookup of a bare-name foreign key target by
   * name; the generation passes use the stricter local rule (`buildSchemas`).
   *
   * @param manifest - The manifest to process in-place
   */
  generateSchemas(manifest: SmartObjectManifest): void {
    this.buildSchemas(manifest, 'direct');
  }

  /**
   * `generateSchemas()`, where `generation` (the generation passes) takes a
   * bare-name foreign key's table only from `localBareTarget`, and `direct`
   * (a public caller) keeps the legacy lookup by name.
   */
  private buildSchemas(
    manifest: SmartObjectManifest,
    mode: 'generation' | 'direct',
  ): void {
    const generator = new SchemaGenerator();

    // Create aggregated manifest that includes external package objects
    // This ensures STI schema generation finds ALL descendants
    const aggregatedManifest = this.createAggregatedManifest(manifest);
    const schemaClasses = new Map(
      Object.values(aggregatedManifest.objects).map((obj) => [
        obj.className,
        obj,
      ]),
    );

    // An external class with the same simple name cannot replace a local item.
    for (const obj of Object.values(manifest.objects))
      schemaClasses.set(obj.className, obj);

    for (const [name, obj] of Object.entries(manifest.objects)) {
      // Collections access their item model's table; an independent schema can
      // contradict that model's tenant/conflict identity during aggregation.
      if (this.extendsCollection(obj, schemaClasses, aggregatedManifest)) {
        delete obj.schema;
        continue;
      }
      if (FRAMEWORK_ABSTRACT_BASE_NAMES.has(obj.className)) {
        continue;
      }

      // Determine table name (may have been inherited from external STI base)
      // Use obj.className (PascalCase) for consistent table name derivation with runtime
      const tableName =
        obj.decoratorConfig?.tableName ||
        this.classNameToTableName(obj.className);

      // Check if this is an STI class. `mergeInheritedFields()` copies the
      // base's `tableStrategy` onto every descendant, so both the root and
      // its children arrive here; `isSTIChildClass` covers a child whose
      // strategy was not inherited.
      if (
        obj.decoratorConfig?.tableStrategy === 'sti' ||
        this.isSTIChildClass(obj, manifest)
      ) {
        // Every class in an STI hierarchy — root, local child, or a child of
        // an EXTERNAL base — carries the schema of the ONE shared table,
        // generated from the ROOT base so descendant discovery, the
        // discriminator-partial unique indexes and the base-declared /
        // descendant-declared distinction are computed against the same
        // hierarchy on every class (#527, #2359). A child generated as if it
        // were the root would treat its own descendant-only `unique: true`
        // fields as base-declared and emit a full unique index that
        // `getAllSchemasAsDefinitions()` then merges into the table beside
        // the correct partial one.
        const stiRoot = this.findSTIBaseInfo(obj, manifest);
        // The root is the class of that name sharing the root's table (an
        // app replacement of the root counts); a namesake in another table is
        // not it, so then the root's own identity decides.
        const byName = stiRoot
          ? this.resolveManifestKey(stiRoot.className, aggregatedManifest)
          : undefined;
        const byNameObject = byName
          ? aggregatedManifest.objects[byName]
          : undefined;
        const sharesRootTable =
          byNameObject &&
          (byNameObject.decoratorConfig?.tableName ||
            byNameObject.schema?.tableName ||
            this.classNameToTableName(byNameObject.className)) ===
            stiRoot?.tableName;
        const rootKey = stiRoot
          ? ((byName && (sharesRootTable || !stiRoot.qualifiedName)
              ? byName
              : undefined) ??
            (stiRoot.qualifiedName &&
            aggregatedManifest.objects[stiRoot.qualifiedName]
              ? stiRoot.qualifiedName
              : undefined) ??
            byName ??
            stiRoot.className)
          : name;
        const rootTableName = stiRoot?.tableName || tableName;
        const rootConfig =
          aggregatedManifest.objects[rootKey]?.decoratorConfig ??
          obj.decoratorConfig;

        logger.debug(
          `[manifest-generator] Generating STI schema for ${name} (root: ${rootKey}, table: ${rootTableName})`,
        );

        // Use aggregated manifest to find descendants from ALL packages
        obj.schema = generator.generateSTISchemaFromManifest(
          rootKey,
          rootTableName,
          obj.fields,
          aggregatedManifest,
          rootConfig,
        );
        this.applySqlTypeOverrides(obj);
      } else {
        // CTI class - generate individual table schema
        logger.debug(
          `[manifest-generator] Generating CTI schema for ${name} (table: ${tableName})`,
        );

        obj.schema = generator.generateCTISchemaFromManifest(
          name,
          tableName,
          obj.fields,
          obj.decoratorConfig,
        );
        this.applySqlTypeOverrides(obj);
      }
    }

    this.resolveSamePackageForeignKeyColumnTypes(manifest, generator, mode);

    // Preserve collection metadata, but take persistence identity from the item
    // model only after every model schema (including FK repair) is complete.
    for (const obj of Object.values(manifest.objects)) {
      if (!this.extendsCollection(obj, schemaClasses, aggregatedManifest))
        continue;
      let current: SmartObjectDefinition | undefined = obj;
      const visited = new Set<SmartObjectDefinition>();
      while (current && !visited.has(current)) {
        visited.add(current);
        const item = this.findItemClass(
          current,
          aggregatedManifest,
          schemaClasses,
        );
        if (
          item?.schema &&
          !this.extendsCollection(item, schemaClasses, aggregatedManifest)
        ) {
          obj.schema = structuredClone(item.schema);
          break;
        }
        current = this.namedParent(current, schemaClasses, aggregatedManifest);
      }
    }
    manifest.schemaFingerprint = tryComputeManifestSchemaFingerprint(
      manifest,
      (error) => logger.warn(`No schema fingerprint written: ${error.message}`),
    );
  }

  /**
   * Carry the package's declared table retirements (`smrt.retiredTables` in
   * its `package.json`) into the manifest (#5005). A malformed declaration
   * fails the build, naming the table.
   */
  applyRetiredTables(
    manifest: SmartObjectManifest,
    options?: { packageName?: string; packageJson?: PackageJsonLike },
  ): void {
    // No package.json given (a scan of loose sources): nothing to read, and a
    // list the caller set on the manifest stays.
    if (!options?.packageJson) return;
    const retired = readRetiredTablesFromPackageJson(
      options?.packageJson,
      options?.packageName,
      (table) => SYSTEM_TABLE_NAMES.includes(table),
    );
    if (retired.length > 0) manifest.retiredTables = retired;
    else delete manifest.retiredTables;
  }

  /** A report model's generated surface defaults to `list`/`get`. */
  applyReportSurfaceDefaults(manifest: SmartObjectManifest): void {
    for (const obj of Object.values(manifest.objects)) {
      if (!obj.decoratorConfig?.report) continue;
      obj.decoratorConfig.api ??= { include: ['list', 'get'] };
      obj.decoratorConfig.mcp ??= { include: ['list', 'get'] };
    }
  }

  normalizeReportObjects(manifest: SmartObjectManifest): void {
    this.applyReportSurfaceDefaults(manifest);
    for (const obj of Object.values(manifest.objects)) {
      if (!obj.decoratorConfig?.report) continue;

      if (obj.decoratorConfig.conflictColumns) continue;

      const tenantScoped = obj.decoratorConfig.tenantScoped;
      const tenantField =
        tenantScoped && typeof tenantScoped === 'object'
          ? tenantScoped.field || 'tenantId'
          : tenantScoped
            ? 'tenantId'
            : undefined;
      const tenantColumn =
        tenantField && obj.fields[tenantField] ? toSnakeCase(tenantField) : '';

      const conflictColumns = Object.entries(obj.fields)
        .filter(([, field]) => {
          const kind = field._meta?.__report?.kind;
          return kind === 'group' || kind === 'bucket';
        })
        .map(([fieldName]) => toSnakeCase(fieldName));

      obj.decoratorConfig.conflictColumns =
        conflictColumns.length > 0
          ? [...(tenantColumn ? [tenantColumn] : []), ...conflictColumns]
          : ['id'];
    }
  }

  normalizeReportTenantScope(manifest: SmartObjectManifest): void {
    for (const obj of Object.values(manifest.objects)) {
      if (!obj.decoratorConfig?.report) continue;
      obj.decoratorConfig.tenantScoped ??= { mode: 'optional' };
    }
  }

  /**
   * Materialize the tenant-aware default conflict target (#2360).
   *
   * A tenant-owned class — tenant-scoped, or carrying an undeclared
   * `tenantId` field (`resolveOwnershipTenantColumn()`) — that declares no
   * `@smrt({ conflictColumns })` keys on `[tenant column, ...natural key]` — `(tenant_id, slug, context)` for
   * a class-per-table object, `(tenant_id, slug, context, _meta_type)` for a
   * single-table hierarchy — so two tenants can each own the same slug and
   * neither `save()` adopts the other's row. Writing the resolved key into
   * `decoratorConfig.conflictColumns` (mirroring `normalizeReportObjects`)
   * makes the manifest, the generated schema, the knowledge artifact and
   * `ObjectRegistry.getConflictColumns()` read one value.
   *
   * Only schema owners are normalized: an STI child inherits the table (and
   * therefore the key) from its root, and `getConflictColumns()` resolves a
   * child through its root at runtime. Explicit `conflictColumns` and
   * `@report` classes (keyed by `normalizeReportObjects`) are left alone.
   * Runs after `injectTenantScopedFields()` and `mergeInheritedFields()` so
   * the tenant field and the inherited `tableStrategy` are in place, and
   * before `generateSchemas()`.
   */
  normalizeConflictColumns(manifest: SmartObjectManifest): void {
    for (const obj of Object.values(manifest.objects)) {
      if (!obj.decoratorConfig) continue;
      if (FRAMEWORK_ABSTRACT_BASE_NAMES.has(obj.className)) continue;
      if (obj.decoratorConfig.conflictColumns) continue;
      if (obj.decoratorConfig.report) continue;
      if (this.isSTIChildClass(obj, manifest)) continue;

      const tenantScoped = obj.decoratorConfig.tenantScoped;
      const declaredTenantColumn = tenantScoped
        ? resolveTenantColumn(
            this.normalizeTenantScopedConfig(tenantScoped).tenantConfig.field,
            (fieldName) => Boolean(obj.fields[fieldName]),
            toSnakeCase,
          )
        : undefined;
      // A class that carries `tenantId` without declaring tenancy (a consumer
      // registers it with the tenancy interceptor at runtime) is still
      // tenant-OWNED: its natural key is unique per tenant too.
      const tenantColumn = resolveOwnershipTenantColumn(
        declaredTenantColumn,
        (column) =>
          Object.keys(obj.fields).some(
            (fieldName) => toSnakeCase(fieldName) === column,
          ),
      );
      if (!tenantColumn) continue;

      obj.decoratorConfig.conflictColumns = defaultConflictColumns(
        obj.decoratorConfig.tableStrategy === 'sti' ? 'sti' : 'cti',
        tenantColumn,
      );
    }
  }

  private resolveSamePackageForeignKeyColumnTypes(
    manifest: SmartObjectManifest,
    generator: SchemaGeneratorLike,
    mode: 'generation' | 'direct',
  ): void {
    // One representative schema per table for target-id lookups, plus EVERY
    // schema that describes a table: each class of an STI hierarchy carries a
    // copy of the shared table's schema (#2359), and every copy must receive
    // the same reconciled type or `getAllSchemasAsDefinitions()`'s
    // first-wins column merge can surface an unreconciled one.
    const schemaByTable = new Map<string, ManifestSchema>();
    const schemasByTable = new Map<string, ManifestSchema[]>();
    const ownerBySchema = new Map<
      ManifestSchema,
      { name: string; obj: SmartObjectDefinition }
    >();
    const changedSchemas = new Set<ManifestSchema>();
    const objectsByName = new Map<string, SmartObjectDefinition>();

    for (const [name, obj] of Object.entries(manifest.objects)) {
      objectsByName.set(obj.className, obj);
      objectsByName.set(obj.className.toLowerCase(), obj);
      if (obj.schema?.tableName) {
        schemaByTable.set(obj.schema.tableName, obj.schema);
        const siblings = schemasByTable.get(obj.schema.tableName) ?? [];
        siblings.push(obj.schema);
        schemasByTable.set(obj.schema.tableName, siblings);
        ownerBySchema.set(obj.schema, { name, obj });
      }
    }

    for (const obj of Object.values(manifest.objects)) {
      const sourceTable = this.getObjectTableName(obj);
      if (!sourceTable) {
        continue;
      }

      const sourceSchemas = schemasByTable.get(sourceTable);
      if (!sourceSchemas || sourceSchemas.length === 0) {
        continue;
      }

      for (const [fieldName, field] of Object.entries(obj.fields || {})) {
        if (
          field.type !== 'foreignKey' ||
          !field.related ||
          field._meta?.__tenancy?.isTenantIdField === true
        ) {
          continue;
        }

        const emitConstraint = field._meta?.constraint !== false;

        const columnName = toSnakeCase(fieldName);
        // A target confirmed as another package's model is that model's
        // table, by identity: its manifest's schema gives the table, the key
        // column and its type. Looked up by simple name it would be missing
        // here (and the constraint dropped) or be a local namesake's table.
        // In the generation passes a bare name takes its table from the one
        // local model `localBareTarget` finds, the rule `assertKnownTargets`
        // fails the build by; no other name lookup. Only a direct caller of
        // the public `generateSchemas()` keeps the legacy lookup by name.
        // A written qualified name (`'@pkg:Class'`, optionally `.column`) is an
        // identity, looked up as one.
        const writtenQualified =
          !field.relatedQualified && isQualifiedName(field.related)
            ? `${parseQualifiedName(field.related).packageName}:${parseQualifiedName(field.related).className.split('.')[0]}`
            : undefined;
        const bareModel =
          mode === 'generation' && !field.relatedQualified && !writtenQualified
            ? this.localBareTarget(manifest, obj, field.related).definition
            : undefined;
        const targetSchema = field.relatedQualified
          ? this.qualifiedTargetSchema(field.relatedQualified, manifest)
          : mode === 'generation'
            ? writtenQualified
              ? this.qualifiedTargetSchema(writtenQualified, manifest)
              : bareModel &&
                schemaByTable.get(this.getObjectTableName(bareModel) ?? '')
            : this.findForeignKeyTargetSchema(
                field.related,
                manifest,
                schemaByTable,
                obj.packageName,
              );
        // A confirmed package target whose table or referenced column the
        // provider's manifest does not give cannot carry its constraint;
        // dropping it would ship the relationship (and its onDelete)
        // unenforced, and referencing a column the table lacks would fail
        // when the DDL is applied, so generation fails instead. The column
        // checked is the one the constraint would reference: the written
        // one (`'Room.code'`), else the target's primary key, else `id`.
        const [, writtenTargetColumn] = field.related.split('.');
        const effectiveTargetColumn =
          writtenTargetColumn ||
          (targetSchema &&
            Object.entries(targetSchema.columns).find(
              ([, definition]) => definition.primaryKey === true,
            )?.[0]) ||
          'id';
        if (
          field.relatedQualified &&
          emitConstraint &&
          (!targetSchema || !targetSchema.columns[effectiveTargetColumn])
        ) {
          const snake = toSnakeCase(effectiveTargetColumn);
          const suggestion =
            targetSchema &&
            snake !== effectiveTargetColumn &&
            targetSchema.columns[snake]
              ? ` (columns are snake_case: write '${field.related.split('.')[0]}.${snake}')`
              : '';
          throw new ConfigurationError(
            `${obj.className}.${fieldName} (${obj.filePath}): @foreignKey() target ${field.relatedQualified} is confirmed, but ` +
              (targetSchema
                ? `its schema has no column ${effectiveTargetColumn}${writtenTargetColumn ? '' : ' (its primary key, or id)'}${suggestion}`
                : `its package's manifest records no schema for it`) +
              `, so the foreign-key constraint (table, column, onDelete) cannot be generated. ` +
              `Rebuild ${parseQualifiedName(field.relatedQualified).packageName} with this version of SMRT so its manifest carries the schema, ` +
              `reference a column the target declares, or set \`constraint: false\` for a relationship without a database constraint.`,
            'CONFIG_UNKNOWN_RELATIONSHIP_TARGET',
            {
              className: obj.className,
              field: fieldName,
              target: field.relatedQualified,
            },
          );
        }
        if (!targetSchema) {
          for (const sourceSchema of sourceSchemas) {
            const sourceColumn = sourceSchema.columns[columnName];
            if (sourceColumn?.foreignKey) {
              sourceSchema.columns[columnName] = {
                ...sourceColumn,
                foreignKey: undefined,
              };
              changedSchemas.add(sourceSchema);
            }
          }
          continue;
        }

        const [, declaredTargetColumn] = field.related.split('.');
        const targetColumn =
          declaredTargetColumn ||
          Object.entries(targetSchema.columns).find(
            ([, definition]) => definition.primaryKey === true,
          )?.[0] ||
          'id';
        const targetIdType = targetSchema.columns[targetColumn]?.type;
        const conflictOwner =
          this.findSTIBase(obj, objectsByName, manifest) ?? obj;
        const conflictColumns = new Set(
          (conflictOwner.decoratorConfig?.conflictColumns || []).map((column) =>
            toSnakeCase(column),
          ),
        );
        const { action } = resolveForeignKeyDeleteAction({
          declared: field._meta?.onDelete,
          isConflictColumn: conflictColumns.has(columnName),
          isTenantIdField: false,
          columnName,
        });

        for (const sourceSchema of sourceSchemas) {
          const sourceColumn = sourceSchema.columns[columnName];
          if (!sourceColumn) {
            continue;
          }
          const nextColumn = {
            ...sourceColumn,
            ...(!field._meta?.sqlType && targetIdType
              ? { type: targetIdType }
              : {}),
            foreignKey: emitConstraint
              ? {
                  table: targetSchema.tableName,
                  column: targetColumn,
                  onDelete: action,
                  onUpdate: resolveForeignKeyUpdateAction(
                    field._meta?.onUpdate,
                  ),
                  ...(typeof field._meta?.constraint === 'object'
                    ? { engines: [...field._meta.constraint.engines] }
                    : {}),
                }
              : undefined,
          };
          if (JSON.stringify(nextColumn) === JSON.stringify(sourceColumn)) {
            continue;
          }
          sourceSchema.columns[columnName] = nextColumn;
          changedSchemas.add(sourceSchema);
        }
      }
    }

    for (const schema of changedSchemas) {
      this.refreshManifestSchemaDDL(
        schema,
        generator,
        ownerBySchema.get(schema),
        manifest,
      );
    }
  }

  /**
   * The schema of the class `qualified` names: this manifest's entry of that
   * identity, else the declaring package's manifest entry.
   */
  private qualifiedTargetSchema(
    qualified: string,
    manifest: SmartObjectManifest,
  ): ManifestSchema | undefined {
    if (!isQualifiedName(qualified)) return undefined;
    const local = manifest.objects[qualified] as
      | SmartObjectDefinition
      | undefined;
    if (local) return local.schema;
    const owner = this.loadDependencyManifest(
      parseQualifiedName(qualified).packageName,
      { warn: false },
    );
    const target = owner
      ? (lookupInManifest(owner, qualified) as
          | SmartObjectDefinition
          | undefined)
      : undefined;
    return target?.schema;
  }

  private findForeignKeyTargetSchema(
    related: string,
    manifest: SmartObjectManifest,
    schemaByTable: Map<string, ManifestSchema>,
    sourcePackageName?: string,
  ): ManifestSchema | undefined {
    const relatedTarget = related.split('.')[0];
    if (schemaByTable.has(relatedTarget)) {
      return schemaByTable.get(relatedTarget);
    }

    const candidates = Object.values(manifest.objects).filter(
      (candidate) =>
        candidate.className === relatedTarget ||
        candidate.qualifiedName === relatedTarget ||
        candidate.name === relatedTarget ||
        candidate.decoratorConfig?.tableName === relatedTarget ||
        candidate.schema?.tableName === relatedTarget,
    );
    const localTarget = candidates.find(
      (candidate) => candidate.packageName === sourcePackageName,
    );
    if (!localTarget && candidates.length > 1) {
      throw new Error(
        `Ambiguous foreign key target ${relatedTarget} from package ${sourcePackageName}`,
      );
    }
    const targetObj = localTarget ?? candidates[0];

    if (!targetObj && relatedTarget.includes(':')) {
      return undefined;
    }

    const targetTable = targetObj
      ? this.getObjectTableName(targetObj)
      : this.classNameToTableName(relatedTarget);

    return targetTable ? schemaByTable.get(targetTable) : undefined;
  }

  private getObjectTableName(obj: SmartObjectDefinition): string | undefined {
    return (
      obj.schema?.tableName ||
      obj.decoratorConfig?.tableName ||
      this.classNameToTableName(obj.className)
    );
  }

  private refreshManifestSchemaDDL(
    schema: ManifestSchema,
    generator: SchemaGeneratorLike,
    owner: { name: string; obj: SmartObjectDefinition } | undefined,
    manifest: SmartObjectManifest,
  ): void {
    const columns: Record<string, ColumnDefinition> = {};
    for (const [name, column] of Object.entries(schema.columns)) {
      columns[name] = {
        // ManifestColumnDefinition stores `type` as a plain string; it is
        // always a valid SQLDataType for DDL rendering.
        type: column.type as SQLDataType,
        primaryKey: column.primaryKey,
        notNull: column.notNull,
        unique: column.unique,
        defaultValue: column.default,
        foreignKey: column.foreignKey ? { ...column.foreignKey } : undefined,
      };
    }

    const schemaDefinition: SchemaDefinition = {
      tableName: schema.tableName,
      columns,
      indexes: (schema.indexes || []).map((index) => ({
        name: index.name,
        columns: index.columns,
        unique: index.unique,
        ...(index.nullsNotDistinct ? { nullsNotDistinct: true } : {}),
        where: index.where,
        jsonPath: index.jsonPath,
      })),
      triggers: [],
      foreignKeys: Object.entries(columns).flatMap(([column, definition]) =>
        definition.foreignKey
          ? [
              {
                column,
                referencesTable: definition.foreignKey.table,
                referencesColumn: definition.foreignKey.column,
                onDelete: definition.foreignKey.onDelete,
                onUpdate: definition.foreignKey.onUpdate,
                ...(definition.foreignKey.engines
                  ? { engines: definition.foreignKey.engines }
                  : {}),
              },
            ]
          : [],
      ),
      dependencies: Object.values(columns)
        .flatMap((definition) =>
          definition.foreignKey ? [definition.foreignKey.table] : [],
        )
        .filter((dependency) => dependency !== schema.tableName),
      version: schema.version,
      packageName: '',
    };

    schema.ddl = generator.generateSQL(schemaDefinition);
    schema.version = this.computeManifestSchemaVersion(schema, owner, manifest);
  }

  private computeManifestSchemaVersion(
    schema: ManifestSchema,
    owner: { name: string; obj: SmartObjectDefinition } | undefined,
    manifest: SmartObjectManifest,
  ): string {
    if (schema.columns._meta_type && owner) {
      const baseClassName =
        owner.obj.decoratorConfig?.tableStrategy === 'sti'
          ? owner.name
          : this.findSTIBaseInfo(owner.obj, manifest)?.className || owner.name;

      return createHash('sha256')
        .update(
          JSON.stringify({
            columns: schema.columns,
            baseClassName,
            descendants: this.findDescendantsInManifest(
              baseClassName,
              manifest,
            ),
          }),
        )
        .digest('hex')
        .substring(0, 8);
    }

    return createHash('sha256')
      .update(
        JSON.stringify({
          columns: schema.columns,
          className: owner?.name || schema.tableName,
        }),
      )
      .digest('hex')
      .substring(0, 8);
  }

  private findDescendantsInManifest(
    baseClassName: string,
    manifest: SmartObjectManifest,
    visited: Set<string> = new Set(),
  ): string[] {
    const descendants: string[] = [];
    if (visited.has(baseClassName)) {
      return descendants;
    }
    visited.add(baseClassName);

    const baseClassLower = this.simpleClassName(baseClassName).toLowerCase();

    for (const [name, obj] of Object.entries(manifest.objects)) {
      const classNameLower = this.simpleClassName(obj.className).toLowerCase();
      const extendsLower = obj.extends
        ? this.simpleClassName(obj.extends).toLowerCase()
        : undefined;

      if (
        classNameLower === baseClassLower &&
        extendsLower === baseClassLower
      ) {
        continue;
      }

      // An import-qualified parent names its package: a same-named base of
      // another package is not this class's ancestor (#4145).
      if (
        extendsLower === baseClassLower &&
        !this.qualifiedParentExcludes(obj, baseClassName)
      ) {
        descendants.push(name);
        descendants.push(
          ...this.findDescendantsInManifest(name, manifest, visited),
        );
      }
    }

    return descendants;
  }

  /**
   * Whether `obj`'s import-qualified parent rules out `baseClassName` (a
   * qualified name of another class with the same simple name).
   */
  private qualifiedParentExcludes(
    obj: SmartObjectDefinition,
    baseClassName: string,
  ): boolean {
    return (
      !!obj.extendsQualified &&
      isQualifiedName(baseClassName) &&
      obj.extendsQualified !== baseClassName
    );
  }

  private applySqlTypeOverrides(obj: SmartObjectDefinition): void {
    if (!obj.schema?.columns) {
      return;
    }

    for (const [fieldName, field] of Object.entries(obj.fields || {})) {
      const sqlType = field?._meta?.sqlType;
      const referenceKind = this.getReferenceKind(field);
      if (!sqlType && !referenceKind) {
        continue;
      }

      const columnName = toSnakeCase(fieldName);
      if (!obj.schema.columns[columnName]) {
        continue;
      }

      const column = {
        ...obj.schema.columns[columnName],
        ...(sqlType ? { type: String(sqlType).toUpperCase() } : {}),
        ...(referenceKind ? { referenceKind } : {}),
      };
      // A `''` initializer (e.g. `tenantId: string = ''`) is not a uuid: as a
      // column default PostgreSQL stores `(''::text)::uuid` unevaluated and
      // every INSERT that omits the column fails with 22P02. An identifier
      // column has no default.
      if (
        String(column.type).toUpperCase() === 'UUID' &&
        column.default === ''
      ) {
        delete column.default;
      }
      obj.schema.columns[columnName] = column;
    }
  }

  private getReferenceKind(
    field: SmartObjectDefinition['fields'][string] | undefined,
  ): ManifestColumnDefinition['referenceKind'] | undefined {
    if (field?._meta?.__tenancy?.isTenantIdField) {
      return 'tenantId';
    }

    if (field?.type === 'foreignKey') {
      return 'foreignKey';
    }

    if (field?.type === 'crossPackageRef') {
      return 'crossPackageRef';
    }

    return undefined;
  }

  /**
   * Create an aggregated manifest that includes objects from all external packages
   *
   * This is used for STI schema generation to ensure ALL descendants are found,
   * regardless of which package they're defined in.
   *
   * @param manifest - The local manifest
   * @returns Aggregated manifest with local + external objects
   */
  private createAggregatedManifest(
    manifest: SmartObjectManifest,
  ): SmartObjectManifest {
    // Start with a copy of local objects
    const aggregatedObjects: Record<string, SmartObjectDefinition> = {
      ...manifest.objects,
    };
    // Load and merge external package objects: the listed dependencies, and
    // the package of each confirmed imported parent.
    for (const packageName of this.parentPackages(manifest)) {
      const externalManifest = this.loadDependencyManifest(packageName);
      if (externalManifest) {
        // Merge external objects (local objects take precedence on collision)
        for (const [name, obj] of Object.entries(externalManifest.objects)) {
          if (!aggregatedObjects[name]) {
            aggregatedObjects[name] = obj;
          }
        }

        logger.debug(
          `[manifest-generator] Aggregated ${Object.keys(externalManifest.objects).length} objects from ${packageName}`,
        );
      }
    }

    return {
      ...manifest,
      objects: aggregatedObjects,
    };
  }

  /**
   * Check if an object is an STI child class (inherits from STI base)
   *
   * Walks up the inheritance chain to find if any ancestor has tableStrategy: 'sti'.
   * Also checks external SMRT packages for parent class definitions.
   */
  private isSTIChildClass(
    obj: SmartObjectDefinition,
    manifest: SmartObjectManifest,
  ): boolean {
    if (!obj.extends) return false;

    // Build a lookup map for efficient access
    const objectsByName = new Map<string, SmartObjectDefinition>();
    for (const [_name, objDef] of Object.entries(manifest.objects)) {
      objectsByName.set(objDef.className, objDef);
      objectsByName.set(objDef.className.toLowerCase(), objDef);
    }

    // Walk up the inheritance chain looking for STI base
    let currentClass: string | undefined = this.parentRef(obj);
    const visited = new Set<string>();

    while (currentClass) {
      if (visited.has(currentClass)) break;
      visited.add(currentClass);

      // Local first, then external SMRT packages; a qualified parent only
      // resolves to its own package's class (#4145).
      const parentObj = this.resolveParentDefinition(
        currentClass,
        obj,
        manifest,
        objectsByName,
      );

      if (!parentObj) break; // Parent not found anywhere (e.g., SmrtObject)

      if (parentObj.decoratorConfig?.tableStrategy === 'sti') {
        return true; // Found STI ancestor
      }

      currentClass = this.parentRef(parentObj, manifest);
    }

    return false;
  }

  /**
   * Resolve a class name (simple `Content` or qualified `@pkg:Content`) to
   * the key it is stored under in `manifest.objects`, or `undefined` when the
   * manifest does not carry it. Manifest keys are qualified names; `extends`
   * and {@link findSTIBaseInfo} report simple names.
   */
  private resolveManifestKey(
    className: string,
    manifest: SmartObjectManifest,
  ): string | undefined {
    if (manifest.objects[className]) return className;
    const simpleName = className.includes(':')
      ? className.slice(className.lastIndexOf(':') + 1)
      : className;
    for (const [key, obj] of Object.entries(manifest.objects)) {
      if (obj.qualifiedName === className || obj.className === simpleName) {
        return key;
      }
    }
    return undefined;
  }

  /**
   * Find full STI base class info (className + tableName)
   *
   * Walks up the inheritance chain to find the STI base class and returns
   * both its className and tableName. This is critical for external STI bases
   * where the child needs to use the base's table name for schema generation.
   */
  private findSTIBaseInfo(
    obj: SmartObjectDefinition,
    manifest: SmartObjectManifest,
  ):
    | { className: string; qualifiedName?: string; tableName: string }
    | undefined {
    if (!obj.extends) return undefined;

    // Build a lookup map for efficient access
    const objectsByName = new Map<string, SmartObjectDefinition>();
    for (const [_name, objDef] of Object.entries(manifest.objects)) {
      objectsByName.set(objDef.className, objDef);
      objectsByName.set(objDef.className.toLowerCase(), objDef);
    }

    // Track the oldest STI base found as we walk up
    // (we need to keep walking to find the ROOT STI class, not the first one)
    let stiBaseInfo:
      | { className: string; qualifiedName?: string; tableName: string }
      | undefined;

    // Walk up the inheritance chain looking for the OLDEST STI base
    let currentClass: string | undefined = this.parentRef(obj);
    const visited = new Set<string>();

    while (currentClass) {
      if (visited.has(currentClass)) break;
      visited.add(currentClass);

      const parentObj = this.resolveParentDefinition(
        currentClass,
        obj,
        manifest,
        objectsByName,
      );

      if (!parentObj) break;

      if (parentObj.decoratorConfig?.tableStrategy === 'sti') {
        // Found an STI ancestor - it becomes the new candidate base
        // Keep walking to find the OLDEST/ROOT STI class in the hierarchy
        const tableName =
          parentObj.decoratorConfig?.tableName ||
          parentObj.schema?.tableName ||
          this.classNameToTableName(parentObj.className);
        stiBaseInfo = {
          className: parentObj.className,
          // The identity too: an app class may share the root's simple name
          // in another table.
          qualifiedName:
            parentObj.qualifiedName ??
            (parentObj.packageName
              ? createQualifiedName(parentObj.packageName, parentObj.className)
              : undefined),
          tableName,
        };
      }

      currentClass = this.parentRef(parentObj, manifest);
    }

    return stiBaseInfo; // Return the oldest STI ancestor found (or undefined if none)
  }

  /**
   * Convert class name to table name (snake_case pluralized)
   *
   * IMPORTANT: Must use the same algorithm as runtime's tableNameFromClass()
   * to ensure manifest-generated table names match runtime-derived names.
   */
  private classNameToTableName(className: string): string {
    // Use the shared pluralization function that handles English plurals correctly
    // (e.g., 'Currency' → 'currencies', 'JournalEntry' → 'journal_entries')
    return classnameToTablename(className);
  }

  private simpleClassName(className: string): string {
    return className.includes(':')
      ? className.split(':').pop() || className
      : className;
  }

  /**
   * Merge inherited fields into child classes (build-time inheritance resolution)
   *
   * For STI hierarchies, child classes don't define their own fields in source code
   * (they inherit from parent). This method merges parent fields into child manifests
   * so that runtime code doesn't need to do field resolution.
   *
   * Fields merge by the one rule in `schema/field-inheritance.ts` (#4940),
   * shared with the registry: ancestors base to child, the nearest concrete
   * declaration winning and the class's own declaration winning over all.
   * An own-table (CTI) subclass of a concrete own-table class gets its
   * ancestors' fields too (#4922).
   *
   * Also handles collection classes (SmrtCollection<T>) that should inherit their
   * item class's tableName and collection when the item uses STI.
   *
   * Handles multi-level inheritance (grandparents, great-grandparents, etc.)
   * Automatically loads parent class definitions from external SMRT packages when needed
   *
   * @param manifest - The manifest to process in-place
   */
  public mergeInheritedFields(manifest: SmartObjectManifest): void {
    // Build a map of className -> objectDef for fast lookup
    const objectsByName = new Map<string, SmartObjectDefinition>();
    for (const [name, obj] of Object.entries(manifest.objects)) {
      objectsByName.set(obj.className, obj);
      // Also store by lowercase name for case-insensitive lookup
      objectsByName.set(obj.className.toLowerCase(), obj);
    }

    // FIRST PASS: Handle STI field merging and tableName inheritance
    // This must happen FIRST so that item classes (like Meeting) have their tableName
    // inherited from their STI base (like Event) before collection classes (like Meetings)
    // try to read it
    for (const obj of Object.values(manifest.objects)) {
      if (!obj.extends) continue; // No parent, skip

      // Always walk the chain below — fields and methods now have
      // independent merge rules (#2624):
      //   FIELDS merge when ANY of:
      //     (a) STI is in play — shared table with parent, full chain
      //         merges.
      //     (b) An ancestor in the chain is a framework abstract base class
      //         (SmrtHierarchical, SmrtJunction, …) — those have no table of
      //         their own, so structural fields they declare (e.g.
      //         `SmrtHierarchical.parentId`) must propagate into every CTI
      //         subclass's manifest, otherwise WHERE-clause validation
      //         rejects queries against the inherited column.
      //     (c) An own-table (CTI) subclass of a concrete own-table
      //     ancestor (#4922): its table definition holds the ancestors'
      //     fields too, the nearest declaration winning, so a same-named
      //     subclass replaces its parent's table definition without losing
      //     the parent's columns and a differently named one stores the
      //     inherited values in its own table.
      //   METHODS merge from every ancestor except framework base classes,
      //     independent of STI/CTI — a concrete decorated ancestor's public
      //     methods are real inherited API regardless of table strategy.
      //     There is no early exit here for a "plain CTI through a
      //     user-defined base" class: that is exactly the case whose
      //     methods previously went unmerged (the under-report half of
      //     #2624).
      const usesSTI = this.isSTIClass(obj, objectsByName, manifest);
      const directParent = this.resolveParentDefinition(
        this.parentRef(obj) ?? obj.extends,
        obj,
        manifest,
        objectsByName,
      );
      // Only a class that itself declares `replaceParent: true` takes its
      // same-named parent's configuration. The choice is read from the
      // class's own decorator before anything is inherited, and it is never
      // inherited: a same-named subclass of a replacement declares its own,
      // and a subtype keeps only the collection it declares (#5143).
      const declaresReplacement =
        directParent?.className === obj.className &&
        obj.decoratorConfig.replaceParent === true;
      const replacedTable = declaresReplacement
        ? (directParent.schema?.tableName ??
          directParent.decoratorConfig.tableName ??
          this.classNameToTableName(directParent.className))
        : undefined;
      // A replacement shares its parent's table. An authored table that
      // differs is refused here, before the STI pass below rewrites it to the
      // family's base table and hides the conflict from the later check.
      if (
        declaresReplacement &&
        obj.decoratorConfig.tableName &&
        obj.decoratorConfig.tableName !== replacedTable
      ) {
        throw sameNameReplacementTableMismatch(
          obj.qualifiedName ?? obj.className,
          directParent.qualifiedName ?? directParent.className,
          obj.decoratorConfig.tableName,
          replacedTable,
        );
      }
      const replacementParent = declaresReplacement ? directParent : undefined;

      logger.debug(
        `[manifest-generator] Merging inherited fields for ${obj.className} from ${obj.extends}`,
      );

      // Build full inheritance chain (base -> child). Each ancestor keeps
      // the definition it resolved to: re-resolving its simple name later
      // could pick another package's same-named class (#4145).
      const inheritanceChain: string[] = [];
      const ancestorDefs: Array<SmartObjectDefinition | undefined> = [];
      let currentClass: string | undefined = this.parentRef(obj);
      const visited = new Set<string>();

      while (currentClass) {
        if (visited.has(currentClass)) {
          logger.warn(
            `[manifest-generator] Circular inheritance detected for ${obj.className}`,
          );
          break;
        }
        visited.add(currentClass);

        // Skips self-reference: when a local class has the same name as its
        // imported parent (e.g., local Performer extends external Performer),
        // the local lookup returns the child itself and falls through to the
        // external package lookup.
        const parentObj = this.resolveParentDefinition(
          currentClass,
          obj,
          manifest,
          objectsByName,
        );

        // Chain entries are simple names, as before; the resolved definition
        // rides alongside.
        const ancestorName = this.simpleClassName(currentClass);
        inheritanceChain.unshift(ancestorName); // Add to front (building base -> child)
        ancestorDefs.unshift(parentObj);
        if (!parentObj) break; // Parent not found anywhere (e.g., SmrtObject)
        currentClass = this.parentRef(parentObj, manifest);
      }

      logger.debug(
        `[manifest-generator] Inheritance chain for ${obj.className}: ${inheritanceChain.join(' -> ')}`,
      );

      // A single-table child inherits its confirmed ancestors' manifest
      // static metadata (`uiSlots`, `adminRoutes`, …) the way the runtime
      // class inherits static members: the nearest declaration wins and the
      // child's own apply last. The scanner merges these only along a chain
      // it could follow inside the scan; generation completes it from the
      // parent it confirmed.
      if (usesSTI) {
        const inherited: Record<string, unknown> = {};
        for (const ancestor of ancestorDefs) {
          Object.assign(inherited, ancestor?.staticProperties ?? {});
        }
        if (Object.keys(inherited).length > 0) {
          obj.staticProperties = {
            ...inherited,
            ...(obj.staticProperties ?? {}),
          };
        }
      }

      // Merge fields from ancestors (base to child) by the one shared rule
      // (`resolveInheritedFields`, #4940): STI subclasses share one table, so
      // every ancestor's columns are needed; an own-table (CTI) subclass
      // carries its concrete ancestors' fields and framework abstract bases'
      // too (#4922). Both: the nearest declaration wins and the child's own
      // fields apply last. The universal object/collection primitives are not
      // models: for an own-table class their own fields (core's manifest
      // declares them) never merge.
      const fieldLinks: Array<FieldInheritanceLink<FieldDefinition>> = [];
      const mergedMethods: Record<string, MethodDefinition> = {};

      for (const [index, ancestorName] of inheritanceChain.entries()) {
        const ancestor = ancestorDefs[index];
        if (!ancestor) continue;

        const ancestorIsFrameworkBase =
          FRAMEWORK_ABSTRACT_BASE_NAMES.has(ancestorName);

        if (
          usesSTI ||
          ancestorIsFrameworkBase ||
          !FRAMEWORK_METHOD_BASE_NAMES.has(ancestorName)
        ) {
          fieldLinks.push({
            name: ancestorName,
            fields: this.qualifyInheritedTargets(ancestor, manifest),
            // The object/collection primitives are scaffolding too: a
            // shared-table family reaches them through its chain.
            frameworkBase:
              ancestorIsFrameworkBase ||
              FRAMEWORK_METHOD_BASE_NAMES.has(ancestorName),
          });
        }

        // METHODS (#2624): methods are not columns and never needed the
        // STI/CTI field rule above — they inherited it only by sharing the
        // loop. Give them their own rule instead: merge from every ancestor
        // except the universal object/collection primitives in
        // FRAMEWORK_METHOD_BASE_NAMES (see its doc comment — deliberately
        // narrower than FRAMEWORK_ABSTRACT_BASE_NAMES), independent of
        // `usesSTI`. This both stops STI subclasses from absorbing
        // `SmrtObject`/`SmrtClass`/`SmrtCollection` internals (over-merge)
        // and lets CTI subclasses inherit a concrete decorated ancestor's
        // own public methods (under-merge), matching the runtime resolver's
        // `getAllMethods()` — while still letting a framework abstract
        // base's own intended API (e.g. SmrtJunction.attach/detach,
        // SmrtHierarchical.getChildren) merge in, the same way its fields
        // already do.
        //
        // Assignment is unconditional (not "first ancestor wins"): the
        // outer loop walks `inheritanceChain` base-to-child, so a later
        // (more-derived) ancestor's override must replace an earlier one —
        // e.g. a middle class that overrides a grandparent method. This
        // matches the runtime resolver's own `getAllMethods()`, which
        // walks the same base-to-child order and does a plain `Map.set()`
        // per ancestor for the identical reason (see its "Child methods
        // override parent methods (no merging)" comment). The child's own
        // methods still win over everything via the unconditional
        // "Add child's own methods" step below.
        if (!FRAMEWORK_METHOD_BASE_NAMES.has(ancestorName)) {
          for (const [methodName, methodDef] of Object.entries(
            ancestor.methods || {},
          )) {
            mergedMethods[methodName] = methodDef;
          }
        }
      }

      const mergedFields = Object.fromEntries(
        resolveInheritedFields({
          strategy: usesSTI ? 'shared-table' : 'own-table',
          className: obj.className,
          ancestors: fieldLinks,
          own: Object.entries(obj.fields),
          representation: 'manifest',
        }),
      );

      // Add child's own methods
      for (const [methodName, methodDef] of Object.entries(obj.methods || {})) {
        mergedMethods[methodName] = methodDef;
      }

      // Update object definition with merged fields
      obj.fields = mergedFields;
      obj.methods = mergedMethods;

      if (replacementParent) {
        // Model-move aliases belong to the declaring identity, not subclasses.
        const {
          previousQualifiedNames: _aliases,
          replaceParent: _parentChoice,
          ...parentConfig
        } = replacementParent.decoratorConfig;
        obj.decoratorConfig = {
          ...parentConfig,
          ...obj.decoratorConfig,
          tableName:
            replacementParent.schema?.tableName ??
            replacementParent.decoratorConfig.tableName ??
            this.classNameToTableName(replacementParent.className),
        };
        obj.collection =
          obj.decoratorConfig.collection ?? replacementParent.collection;
      }

      // Share storage while allowing an explicit independent route collection.
      const stiBase = this.findSTIBase(obj, objectsByName, manifest);
      if (stiBase && stiBase !== obj) {
        // Determine the STI base's table name (explicit or derived from className)
        // Note: We don't use stiBase.collection as fallback because collection uses
        // lowercase-only format (e.g., 'querytestevents') while tableName needs
        // snake_case format (e.g., 'query_test_events')
        const baseTableName =
          stiBase.decoratorConfig?.tableName ||
          this.classNameToTableName(stiBase.className);

        if (
          (obj.decoratorConfig?.sensitive === true) !==
          (stiBase.decoratorConfig?.sensitive === true)
        ) {
          throw new ConfigurationError(
            `STI hierarchy ${stiBase.className} has mixed sensitivity; mark every class sensitive or use separate tables.`,
            'CONFIG_STI_MIXED_SENSITIVITY',
          );
        }
        // Inherit tableName from STI base
        obj.decoratorConfig = obj.decoratorConfig || {};
        obj.decoratorConfig.tableName = baseTableName;
        logger.debug(
          `[manifest-generator] ${obj.className} inherits tableName: '${baseTableName}' from ${stiBase.className}`,
        );

        // Inherit tableStrategy from STI base (so runtime doesn't need to walk inheritance chain)
        if (stiBase.decoratorConfig?.tableStrategy) {
          obj.decoratorConfig.tableStrategy =
            stiBase.decoratorConfig.tableStrategy;
          logger.debug(
            `[manifest-generator] ${obj.className} inherits tableStrategy: '${stiBase.decoratorConfig.tableStrategy}' from ${stiBase.className}`,
          );
        }

        // Collection controls routes/permissions independently of shared storage.
        if (typeof obj.decoratorConfig.collection === 'string') {
          obj.collection = obj.decoratorConfig.collection;
        }
        // Preserve the inherited default when no collection was declared.
        if (
          !obj.decoratorConfig.collection &&
          stiBase.collection !== obj.collection
        ) {
          logger.debug(
            `[manifest-generator] ${obj.className} inherits collection: '${stiBase.collection}' from ${stiBase.className}`,
          );
          obj.collection = stiBase.collection;
        }
      }

      logger.debug(
        `[manifest-generator] ✅ ${obj.className} now has ${Object.keys(mergedFields).length} fields (including inherited)`,
      );
    }

    // A model subclass inherits every generated surface (and `sensitive`) it
    // leaves unset from its parent model. Before the collection pass below,
    // so a subclass's collection inherits the subclass's effective surface.
    this.applySubclassExposureInheritance(manifest, objectsByName);

    // SECOND PASS: Handle collection classes that should inherit from their item class
    // This must happen AFTER STI field merging so item classes have their tableName set
    for (const obj of Object.values(manifest.objects)) {
      // Check if this is a collection class (extends SmrtCollection)
      const isCollection =
        extendsFrameworkCollection(obj) ||
        this.extendsCollection(obj, objectsByName, manifest);
      // Junction and report collections inherit their model's exposure too,
      // but keep their own storage naming (that predates this pass).
      if (
        !isCollection &&
        !this.extendsAnyCollectionBase(obj, objectsByName, manifest)
      ) {
        continue;
      }

      // Find the item class from _itemClass static property
      const itemClass = this.findItemClass(obj, manifest, objectsByName);
      if (!itemClass || itemClass === obj) continue;

      logger.debug(
        `[manifest-generator] ${obj.className} is a collection class for ${itemClass.className}`,
      );

      // Record the classification itself: collection entries also carry the
      // model's tableName and schema (for routes and parity), so without it
      // a runtime that cannot walk the parent chain or match prototypes
      // (another core copy, an unloaded parent manifest) would count the
      // collection as a second owner of the model's table (#3956).
      obj.collectionOf = itemClass.qualifiedName || itemClass.className;

      if (isCollection) {
        // Inherit tableName from item class (which may have inherited it from STI base)
        if (itemClass.decoratorConfig?.tableName) {
          obj.decoratorConfig = obj.decoratorConfig || {};
          obj.decoratorConfig.tableName = itemClass.decoratorConfig.tableName;
          logger.debug(
            `[manifest-generator] ${obj.className} inherits tableName: '${itemClass.decoratorConfig.tableName}' from item class ${itemClass.className}`,
          );
        }

        // Routes may use an explicit namespace independently of item storage.
        // Match registry registration, where decorator collection wins.
        if (typeof obj.decoratorConfig?.collection === 'string') {
          obj.collection = obj.decoratorConfig.collection;
        } else if (itemClass.collection !== obj.collection) {
          logger.debug(
            `[manifest-generator] ${obj.className} inherits collection: '${itemClass.collection}' from item class ${itemClass.className} (was '${obj.collection}')`,
          );
          obj.collection = itemClass.collection;
        }
      }

      // A collection class is generated as a resource of its own, so a
      // surface it leaves unset inherits its model's exposure: `false`,
      // the CRUD verbs of an `include` list, an `exclude` list, and
      // read-only MCP over a `sensitive` model. Without this an object-form
      // model config left the collection open on every transport. From an
      // `include` list only CRUD verbs and names only the collection declares
      // carry over: a name the model declares is the model's own method, and
      // a same-named collection method is a different operation, so it stays
      // closed until the collection lists it. See `registry/collection-exposure.ts`.
      const inherited = inheritCollectionExposure(
        obj.decoratorConfig || {},
        itemClass.decoratorConfig || {},
        {
          collection: new Set(Object.keys(obj.methods || {})),
          item: new Set(Object.keys(itemClass.methods || {})),
        },
      );
      if (Object.keys(inherited).length > 0) {
        obj.decoratorConfig = { ...(obj.decoratorConfig || {}), ...inherited };
        // Keep the copied surfaces distinguishable from the collection's own,
        // so the runtime can follow its model's effective config (#3468).
        obj.inheritedExposure = Object.keys(inherited) as Array<
          keyof typeof inherited
        >;
        logger.debug(
          `[manifest-generator] ${obj.className} inherits ${Object.keys(inherited).join(', ')} exposure from item class ${itemClass.className}`,
        );
      }
    }
  }

  /**
   * `ancestor`'s fields as a descendant inherits them. An ancestor from
   * ANOTHER package's manifest names its relationship targets by simple name,
   * meaning classes of its own package; inherited here, that name could bind
   * this app's class of the same name and its table. Such a target is given
   * the provider's identity (`relatedQualified`) when the provider's manifest
   * declares it, so it is confirmed and referenced by identity. Field objects
   * of the provider's manifest are copied, never changed.
   */
  private qualifyInheritedTargets(
    ancestor: SmartObjectDefinition,
    manifest: SmartObjectManifest,
  ): Array<[string, FieldDefinition]> {
    const entries = Object.entries(ancestor.fields);
    const owner = ancestor.packageName;
    if (
      !owner ||
      owner === manifest.packageName ||
      Object.values(manifest.objects).includes(ancestor)
    ) {
      return entries;
    }
    const providerManifest = this.loadDependencyManifest(owner, {
      warn: false,
    });
    if (!providerManifest) return entries;
    return entries.map(([name, field]) => {
      if (
        (field.type !== 'foreignKey' &&
          field.type !== 'oneToMany' &&
          field.type !== 'manyToMany') ||
        field.relatedQualified ||
        typeof field.related !== 'string' ||
        field.related === ''
      ) {
        return [name, field];
      }
      const qualified = createQualifiedName(owner, field.related.split('.')[0]);
      const target = lookupInManifest(providerManifest, qualified) as
        | SmartObjectDefinition
        | undefined;
      // A provider built before entries were recorded keeps the simple name.
      if (!target?.importPath) return [name, field];
      return [
        name,
        {
          ...field,
          relatedQualified: qualified,
          relatedImportPath: target.importPath,
        },
      ];
    });
  }

  /**
   * The model a model class directly extends, from this manifest or an
   * external SMRT dependency's, or `undefined` when its parent is a framework
   * base, a collection or unknown, or when the class is itself a collection.
   */
  private findParentModel(
    obj: SmartObjectDefinition,
    manifest: SmartObjectManifest,
    objectsByName: Map<string, SmartObjectDefinition>,
  ): SmartObjectDefinition | undefined {
    const parentName = obj.extendsQualified || obj.extends;
    if (!parentName) return undefined;
    const simpleParent = this.simpleClassName(parentName);
    // Only an unqualified parent can be a framework base: a qualified one is
    // a model of a package (another package's, or this package's own class
    // named like a framework base), whose exposure the child inherits.
    if (
      !obj.extendsQualified &&
      (FRAMEWORK_ABSTRACT_BASE_NAMES.has(simpleParent) ||
        FRAMEWORK_METHOD_BASE_NAMES.has(simpleParent) ||
        isSmrtCollectionExtendsName(parentName))
    ) {
      return undefined;
    }
    if (
      this.extendsCollection(obj, objectsByName, manifest) ||
      this.extendsAnyCollectionBase(obj, objectsByName, manifest)
    ) {
      return undefined;
    }
    // A confirmed import-qualified parent is resolved by its qualified name
    // only: this manifest's entry of that identity, else the parent
    // package's. A same-named class of this package is never it, so exposure
    // inheritance and the widening check read the parent the table and
    // fields come from.
    const parent = this.resolveParentDefinition(
      obj.extendsQualified ?? obj.extends ?? simpleParent,
      obj,
      manifest,
      objectsByName,
    );
    if (!parent) return undefined;
    if (
      this.extendsCollection(parent, objectsByName, manifest) ||
      this.extendsAnyCollectionBase(parent, objectsByName, manifest)
    ) {
      return undefined;
    }
    return parent;
  }

  /**
   * A model's config with the surfaces it inherits from its ancestors
   * (`registry/subclass-exposure.ts`), computed without mutating `obj` or any
   * external manifest entry.
   */
  private subclassEffectiveConfig(
    obj: SmartObjectDefinition,
    manifest: SmartObjectManifest,
    objectsByName: Map<string, SmartObjectDefinition>,
    memo: Map<SmartObjectDefinition, SmartObjectConfig>,
    visiting: Set<SmartObjectDefinition> = new Set(),
  ): SmartObjectConfig {
    const cached = memo.get(obj);
    if (cached) return cached;
    const own = obj.decoratorConfig || {};
    if (visiting.has(obj)) return own;
    visiting.add(obj);
    let config = own;
    const parent = this.findParentModel(obj, manifest, objectsByName);
    if (parent) {
      const inherited = inheritSubclassExposure(
        own,
        this.subclassEffectiveConfig(
          parent,
          manifest,
          objectsByName,
          memo,
          visiting,
        ),
      );
      if (Object.keys(inherited).length > 0) config = { ...own, ...inherited };
    }
    visiting.delete(obj);
    memo.set(obj, config);
    return config;
  }

  /**
   * Give every model subclass in this manifest the generated surfaces and
   * `sensitive` flag it leaves unset from its parent model. Without this an
   * STI child such as `Person extends Profile` was generated with the open
   * default surface, publishing every write and method `Profile` closes.
   */
  private applySubclassExposureInheritance(
    manifest: SmartObjectManifest,
    objectsByName: Map<string, SmartObjectDefinition>,
  ): void {
    const memo = new Map<SmartObjectDefinition, SmartObjectConfig>();
    const updates: Array<[SmartObjectDefinition, SmartObjectConfig]> = [];
    for (const obj of Object.values(manifest.objects)) {
      const effective = this.subclassEffectiveConfig(
        obj,
        manifest,
        objectsByName,
        memo,
      );
      if (effective !== (obj.decoratorConfig || {})) {
        updates.push([obj, effective]);
      }
    }
    for (const [obj, effective] of updates) {
      obj.decoratorConfig = effective;
      logger.debug(
        `[manifest-generator] ${obj.className} inherits generated-surface exposure from ${obj.extends}`,
      );
    }
  }

  /**
   * Fail the build when a model subclass's own `@smrt()` opens a generated
   * operation (a CRUD verb or a parent method, on REST, MCP or CLI) that its
   * parent model closes, or drops its parent's `sensitive: true`, without
   * naming it in `widenParentExposure`. Runs after inheritance, so only a
   * subclass's own config can trip it.
   */
  private assertSubclassExposure(manifest: SmartObjectManifest): void {
    const objectsByName = new Map<string, SmartObjectDefinition>();
    for (const objectDef of Object.values(manifest.objects)) {
      objectsByName.set(objectDef.className, objectDef);
    }
    const memo = new Map<SmartObjectDefinition, SmartObjectConfig>();
    const findings: Parameters<typeof formatSubclassExposureEscalations>[0] =
      [];
    for (const obj of Object.values(manifest.objects)) {
      const parent = this.findParentModel(obj, manifest, objectsByName);
      if (!parent) continue;
      const childConfig = this.subclassEffectiveConfig(
        obj,
        manifest,
        objectsByName,
        memo,
      );
      const parentConfig = this.subclassEffectiveConfig(
        parent,
        manifest,
        objectsByName,
        memo,
      );
      const parentOperations = Object.entries(parent.methods || {})
        .filter(([, method]) => method.isPublic !== false)
        .map(([name]) => name);
      const escalations = findSubclassExposureEscalations(
        childConfig,
        parentConfig,
        parentOperations,
      );
      const stale = findStaleWidenings(childConfig, parentConfig);
      if (escalations.length > 0 || stale.length > 0) {
        findings.push({
          subclass: obj.qualifiedName || obj.className,
          parent: parent.qualifiedName || parent.className,
          escalations,
          stale,
        });
      }
    }
    if (findings.length > 0) {
      throw new ConfigurationError(
        formatSubclassExposureEscalations(findings),
        'CONFIG_SUBCLASS_EXPOSURE',
      );
    }
  }

  /**
   * Fail the build when a collection class opens a generated CRUD write (MCP
   * or CLI) that its model keeps closed. Runs after inheritance, so only a
   * collection's own `@smrt()` surface can trip it.
   */
  private assertCollectionExposure(manifest: SmartObjectManifest): void {
    const objectsByName = new Map(
      Object.values(manifest.objects).map((objectDef) => [
        objectDef.className,
        objectDef,
      ]),
    );
    const findings: Parameters<typeof formatCollectionWriteEscalations>[0] = [];
    for (const obj of Object.values(manifest.objects)) {
      if (
        !extendsFrameworkCollection(obj) &&
        !this.extendsCollection(obj, objectsByName, manifest) &&
        !this.extendsAnyCollectionBase(obj, objectsByName, manifest)
      ) {
        continue;
      }
      const itemClass = this.findItemClass(obj, manifest, objectsByName);
      if (!itemClass || itemClass === obj) continue;
      const escalations = findCollectionWriteEscalations(
        obj.decoratorConfig || {},
        itemClass.decoratorConfig || {},
      );
      if (escalations.length > 0) {
        findings.push({
          collection: obj.qualifiedName || obj.className,
          model: itemClass.qualifiedName || itemClass.className,
          escalations,
        });
      }
    }
    if (findings.length > 0) {
      throw new ConfigurationError(
        formatCollectionWriteEscalations(findings),
        'CONFIG_COLLECTION_EXPOSURE',
      );
    }
  }

  /**
   * Whether a class descends from any SMRT collection base (`SmrtCollection`,
   * `SmrtJunction`, `SmrtJunctionBase`, `SmrtReportCollection`), following
   * parents declared in this manifest.
   */
  private extendsAnyCollectionBase(
    obj: SmartObjectDefinition,
    objectsByName: Map<string, SmartObjectDefinition>,
    manifest?: SmartObjectManifest,
  ): boolean {
    let current: SmartObjectDefinition | undefined = obj;
    const visited = new Set<SmartObjectDefinition>();
    while (current?.extends) {
      if (extendsFrameworkCollectionBase(current)) return true;
      if (visited.has(current)) return false;
      visited.add(current);
      current = this.namedParent(current, objectsByName, manifest);
    }
    return false;
  }

  /**
   * Check if a class extends SmrtCollection (directly or indirectly)
   *
   * @param obj - The object definition to check
   * @param objectsByName - Map of className -> objectDef for lookups
   * @returns true if this class extends SmrtCollection
   */
  private extendsCollection(
    obj: SmartObjectDefinition,
    objectsByName: Map<string, SmartObjectDefinition>,
    manifest?: SmartObjectManifest,
  ): boolean {
    // Walk up inheritance chain looking for SmrtCollection
    let current: SmartObjectDefinition | undefined = obj;
    const visited = new Set<SmartObjectDefinition>();

    while (current?.extends) {
      if (visited.has(current)) break;
      visited.add(current);

      if (extendsFrameworkCollection(current)) return true;

      current = this.namedParent(current, objectsByName, manifest);
    }

    return false;
  }

  /**
   * Find the item class for a collection class
   *
   * Lookup priority:
   * 1. extendsTypeArg - Generic type argument from extends clause (e.g., "Meeting" from SmrtCollection<Meeting>)
   * 2. _itemClass static property - May be captured by AST scanner
   * 3. Name-based inference - Fallback (e.g., "Meetings" -> "Meeting")
   *
   * @param collectionObj - The collection class definition
   * @param manifest - The manifest
   * @param objectsByName - Map of className -> objectDef for lookups
   * @returns Item class definition or undefined
   */
  private findItemClass(
    collectionObj: SmartObjectDefinition,
    manifest: SmartObjectManifest,
    objectsByName: Map<string, SmartObjectDefinition>,
  ): SmartObjectDefinition | undefined {
    // PRIORITY 0: an item the scanner traced to a package export is that
    // package's class (confirmed in `verifyImportedParents`), never a class
    // of the same simple name here or in another dependency.
    if (collectionObj.extendsTypeArgQualified) {
      const qualified = collectionObj.extendsTypeArgQualified;
      const local = manifest.objects[qualified] as
        | SmartObjectDefinition
        | undefined;
      if (local) return local;
      if (!isQualifiedName(qualified)) return undefined;
      const owner = this.loadDependencyManifest(
        parseQualifiedName(qualified).packageName,
        { warn: false },
      );
      return owner
        ? (lookupInManifest(owner, qualified) as
            | SmartObjectDefinition
            | undefined)
        : undefined;
    }

    // PRIORITY 1: Use generic type argument from extends clause
    // This is the most reliable method: SmrtCollection<Meeting> -> "Meeting"
    if (collectionObj.extendsTypeArg) {
      const itemClassName = collectionObj.extendsTypeArg;
      logger.debug(
        `[manifest-generator] ${collectionObj.className} has extendsTypeArg: ${itemClassName}`,
      );

      // Try to find the item class by name in local manifest
      const itemClass = objectsByName.get(itemClassName);
      if (itemClass) {
        logger.debug(
          `[manifest-generator] Found item class ${itemClassName} in local manifest`,
        );
        return itemClass;
      }

      // Try loading from external packages
      if (manifest.smrtDependencies && manifest.smrtDependencies.length > 0) {
        const externalItemClass = this.loadParentFromExternalPackage(
          itemClassName,
          manifest.smrtDependencies,
          objectsByName,
        );
        if (externalItemClass) {
          logger.debug(
            `[manifest-generator] Found item class ${itemClassName} in external package`,
          );
          return externalItemClass;
        }
      }
    }

    // PRIORITY 2: Look for _itemClass static field in the collection class
    // This is defined like: static readonly _itemClass = Meeting;
    // Note: AST scanner currently skips static properties, so this rarely works
    const itemClassField = collectionObj.fields._itemClass;

    if (itemClassField) {
      // Extract class name from the field's default value or metadata
      // The AST scanner might capture this as a reference
      const itemClassName = itemClassField.related || itemClassField.default;

      if (itemClassName && typeof itemClassName === 'string') {
        // Try to find the item class by name
        const itemClass = objectsByName.get(itemClassName);
        if (itemClass) {
          return itemClass;
        }

        // Try loading from external packages
        if (manifest.smrtDependencies && manifest.smrtDependencies.length > 0) {
          return this.loadParentFromExternalPackage(
            itemClassName,
            manifest.smrtDependencies,
            objectsByName,
          );
        }
      }
    }

    // PRIORITY 3: Fallback - Try to infer from collection class name
    // Generate candidate item class names and check if they exist
    const collectionName = collectionObj.className;
    const candidates: string[] = [];

    // Strip "Collection" suffix first if present
    let baseName = collectionName;
    if (baseName.endsWith('Collection')) {
      baseName = baseName.slice(0, -'Collection'.length);
    }

    // Generate singularization candidates (order matters - try most specific first)
    // 1. Exact name (e.g., "Event" from "EventCollection")
    candidates.push(baseName);

    // 2. Remove trailing 's' (e.g., "Meetings" -> "Meeting")
    if (baseName.endsWith('s') && baseName.length > 1) {
      candidates.push(baseName.slice(0, -1));
    }

    // 3. Handle 'ies' -> 'y' (e.g., "Categories" -> "Category")
    if (baseName.endsWith('ies') && baseName.length > 3) {
      candidates.push(`${baseName.slice(0, -3)}y`);
    }

    // 4. Handle 'es' -> '' for words ending in s/x/z/ch/sh (e.g., "Statuses" -> "Status")
    if (baseName.endsWith('es') && baseName.length > 2) {
      candidates.push(baseName.slice(0, -2));
    }

    // Try each candidate against local classes first, then external packages
    // Skip candidates that match the collection class itself
    for (const candidate of candidates) {
      if (candidate === collectionObj.className) continue; // Don't match self
      const itemClass = objectsByName.get(candidate);
      if (itemClass) {
        return itemClass;
      }
    }

    // Try loading from external packages
    if (manifest.smrtDependencies && manifest.smrtDependencies.length > 0) {
      for (const candidate of candidates) {
        if (candidate === collectionObj.className) continue; // Don't match self
        const itemClass = this.loadParentFromExternalPackage(
          candidate,
          manifest.smrtDependencies,
          objectsByName,
        );
        if (itemClass) {
          return itemClass;
        }
      }
    }

    return undefined;
  }

  /**
   * Check if a class uses STI (either explicitly or inherited from an ancestor)
   *
   * Walks up the inheritance chain to find if any ancestor has tableStrategy: 'sti'.
   * If found, all descendants inherit STI and should have fields merged.
   * Also checks external SMRT packages for parent class definitions.
   *
   * @param obj - The object definition to check
   * @param objectsByName - Map of className -> objectDef for lookups
   * @param manifest - The manifest (for accessing smrtDependencies)
   * @returns true if this class uses STI (directly or inherited)
   */
  private isSTIClass(
    obj: SmartObjectDefinition,
    objectsByName: Map<string, SmartObjectDefinition>,
    manifest: SmartObjectManifest,
  ): boolean {
    // Check if explicitly marked as STI
    if (obj.decoratorConfig?.tableStrategy === 'sti') {
      return true;
    }

    // Walk up the inheritance chain looking for STI base
    let currentClass: string | undefined = this.parentRef(obj);
    const visited = new Set<string>();

    while (currentClass) {
      if (visited.has(currentClass)) {
        break; // Circular inheritance, stop
      }
      visited.add(currentClass);

      // Skips self-reference (local class with same name as imported parent).
      const parentDef = this.resolveParentDefinition(
        currentClass,
        obj,
        manifest,
        objectsByName,
      );

      if (!parentDef) break; // Parent not found anywhere

      // Check if this ancestor uses STI
      if (parentDef.decoratorConfig?.tableStrategy === 'sti') {
        return true; // Found STI ancestor
      }

      currentClass = this.parentRef(parentDef, manifest);
    }

    return false; // No STI in hierarchy
  }

  /**
   * Find the STI base class for a given object
   *
   * Walks up the inheritance chain to find the first ancestor that defines
   * tableStrategy: 'sti'. This is the class that owns the shared table.
   *
   * @param obj - The object definition to find the STI base for
   * @param objectsByName - Map of className -> objectDef for lookups
   * @param manifest - The manifest (for accessing smrtDependencies)
   * @returns The STI base class definition, or the object itself if it's the base
   */
  private findSTIBase(
    obj: SmartObjectDefinition,
    objectsByName: Map<string, SmartObjectDefinition>,
    manifest: SmartObjectManifest,
  ): SmartObjectDefinition | undefined {
    // Track the oldest STI class found as we walk up
    let stiBase: SmartObjectDefinition | undefined;

    // If this object explicitly defines STI, it's a candidate (but ancestors may also be STI)
    if (obj.decoratorConfig?.tableStrategy === 'sti') {
      stiBase = obj;
    }

    // Walk up the inheritance chain looking for the oldest STI base
    let currentClass: string | undefined = this.parentRef(obj);
    const visited = new Set<string>();

    while (currentClass) {
      if (visited.has(currentClass)) {
        break; // Circular inheritance, stop
      }
      visited.add(currentClass);

      // Skips self-reference (local class with same name as imported parent).
      const parentDef = this.resolveParentDefinition(
        currentClass,
        obj,
        manifest,
        objectsByName,
      );

      if (!parentDef) break; // Parent not found anywhere

      // Check if this ancestor defines STI - if so, it becomes the new candidate base
      // (we keep walking to find the oldest/root STI class)
      if (parentDef.decoratorConfig?.tableStrategy === 'sti') {
        stiBase = parentDef;
      }

      currentClass = this.parentRef(parentDef, manifest);
    }

    return stiBase; // Return the oldest STI ancestor found (or undefined if none)
  }

  /**
   * Load parent class definition from external SMRT packages
   *
   * When a child class extends a parent from an external package (e.g., praeco's Council extends
   * smrt-profiles' Organization), this method loads the parent's manifest and extracts the
   * parent's field definitions.
   *
   * @param parentClassName - Name of the parent class to find
   * @param smrtDependencies - List of external SMRT packages to search
   * @param objectsByName - Map to cache loaded external objects
   * @returns Parent object definition if found, undefined otherwise
   */
  private loadParentFromExternalPackage(
    parentClassName: string,
    smrtDependencies: string[],
    objectsByName: Map<string, SmartObjectDefinition>,
  ): SmartObjectDefinition | undefined {
    // Try each external SMRT dependency
    for (const packageName of smrtDependencies) {
      const externalManifest = this.loadDependencyManifest(packageName);

      if (!externalManifest) {
        continue;
      }

      // Use lookupInManifest for O(1) lookup via cached className index
      // Handles both qualified names and simple class names
      const parentObj = lookupInManifest(externalManifest, parentClassName);

      if (parentObj) {
        // Cache the loaded parent object for future lookups, but never over
        // a local class of the same simple name: that entry is this
        // package's own parent for its other subclasses (#4145).
        if (!objectsByName.has(parentObj.className)) {
          objectsByName.set(parentObj.className, parentObj);
        }
        if (!objectsByName.has(parentObj.className.toLowerCase())) {
          objectsByName.set(parentObj.className.toLowerCase(), parentObj);
        }

        return parentObj;
      }
    }

    return undefined;
  }

  /**
   * Determine import path from package.json exports
   *
   * Tries the following strategies in order:
   * 1. package.json exports["./objects"] - Specific objects export
   * 2. package.json exports["."] - Main export
   * 3. package.json main - Main field
   * 4. Fallback to package name
   */
  /**
   * Determine the specifier consumers should import an object from.
   *
   * `filePath` was accepted (and ignored — the parameter was named
   * `_filePath`) since before this fix, so every object always resolved to
   * the bare package name regardless of where it actually lived. That is
   * wrong for an object scanned from a file only a non-root `exports`
   * subpath serves (e.g. `./server`): the manifest advertised the object as
   * importable from the package root, but the root bundle never exports it,
   * so a consumer dynamically importing by manifest metadata (or generating
   * `.smrt/register.js`, `consumer-plugin/index.ts`'s own
   * `determineImportPath`) silently failed to find it. That is smrt#2845 —
   * `DataSurfaceActionIdempotencyState` in `@happyvertical/smrt-agents` lives
   * under `src/server/` (served only by the `./server` export), but the
   * manifest pointed consumers at the bare `@happyvertical/smrt-agents`
   * specifier.
   *
   * Strategy: match `filePath` against the package's `exports` subpaths —
   * `src/<segment>/...` or `src/<segment>.ts` maps to the `./<segment>`
   * export key — and prefer the longest matching segment. Falls back to the
   * legacy behavior (bare package name, with the `./objects` special case)
   * when the file does not match any subpath, which covers objects reachable
   * from the root `.` entry point.
   */
  private determineImportPath(
    packageJson: PackageJsonLike,
    filePath?: string,
  ): string {
    // Only invoked once a package name is known (guarded at the call site),
    // so `name` is always present here.
    const packageName = packageJson.name as string;

    if (packageJson.exports && typeof packageJson.exports === 'object') {
      const subpathSegment = this.matchExportsSubpath(
        packageJson.exports,
        filePath,
      );
      if (subpathSegment) {
        return `${packageName}/${subpathSegment}`;
      }

      // Legacy special case, kept for packages whose `./objects` export
      // predates file-path-based matching and whose objects' `filePath`
      // does not follow the `src/objects/...` convention above.
      if (packageJson.exports['./objects']) {
        return `${packageName}/objects`;
      }
    }

    // Strategy 2/3: main field or bare fallback — both resolve to the
    // package root, which is where an unmatched object is assumed to live.
    return packageName;
  }

  /**
   * Match a scanned object's `filePath` against a package's `exports` map,
   * returning the longest matching non-root subpath segment (e.g. `"server"`
   * for `./server`), or `undefined` when the file does not correspond to any
   * declared subpath (the object is assumed reachable from the root `.`
   * entry point instead).
   */
  private matchExportsSubpath(
    exportsMap: Record<string, unknown>,
    filePath?: string,
  ): string | undefined {
    if (!filePath) return undefined;

    const normalized = filePath.replace(/\\/g, '/');
    const srcMarker = 'src/';
    const srcIndex = normalized.lastIndexOf(srcMarker);
    if (srcIndex === -1) return undefined;
    const relativeToSrc = normalized.slice(srcIndex + srcMarker.length);

    // Path components with any source-file extension stripped from the last
    // one, so `lib/models/Category.ts` and `server.js` both compare as plain
    // component lists (`['lib','models','Category']`, `['server']`).
    const pathParts = relativeToSrc.split('/');
    const lastIndex = pathParts.length - 1;
    pathParts[lastIndex] = pathParts[lastIndex].replace(
      /\.(ts|tsx|js|jsx|mjs|cjs)$/,
      '',
    );

    const segments = Object.keys(exportsMap)
      .filter(
        (key) =>
          key !== '.' &&
          key !== './package.json' &&
          !key.includes('*') &&
          // Exclude subpaths that resolve to a non-JS asset (e.g. the
          // `./manifest`/`./manifest.json` convention pointing at
          // `dist/manifest.json`). No @smrt object's source file can ever
          // legitimately resolve there, so this only guards against a
          // coincidental `src/manifest/...` path being misattributed to it.
          !targetsJsonAsset(exportsMap[key]),
      )
      .map((key) => key.replace(/^\.\//, ''))
      .filter((segment) => segment.length > 0)
      // Longest first so a nested segment (rare) wins over a shorter prefix.
      .sort((a, b) => b.length - a.length);

    return segments.find((segment) => {
      const segmentParts = segment.split('/');
      // Match the segment's components as a contiguous run anywhere in the
      // file's path — not just a root-level prefix. Handles both a direct
      // subpath directory (`server/x.ts` for `./server`) and a re-export
      // barrel whose real source lives deeper than its export key implies
      // (`@happyvertical/smrt-products`: `./models` -> `src/models.ts` ->
      // `export * from './lib/models/index'`, with the actual `@smrt()`
      // classes scanned from `src/lib/models/*.ts` — `relativeToSrc` is
      // `lib/models/Category.ts`, which contains `models` as a component,
      // just not at index 0).
      for (
        let start = 0;
        start <= pathParts.length - segmentParts.length;
        start++
      ) {
        if (
          segmentParts.every(
            (part, offset) => pathParts[start + offset] === part,
          )
        ) {
          return true;
        }
      }
      return false;
    });
  }

  /**
   * Generate TypeScript interfaces from manifest
   */
  generateTypeDefinitions(manifest: SmartObjectManifest): string {
    const interfaces: string[] = [];

    // Manifest key order follows scan/discovery order, which is not stable
    // across runs (#2749): the vite-plugin's server-mode `@smrt/types`
    // resolution calls this method directly, so sort deterministically
    // before emitting for the same reason as the prebuild/client-mode paths.
    // One class can be listed under several packages (#3296); the shared
    // declaration selection collapses those listings to one interface.
    for (const { interfaceName, obj } of selectObjectDeclarations(manifest)) {
      interfaces.push(this.generateInterface(obj, interfaceName));
    }

    return interfaces.join('\n\n');
  }

  /**
   * Generate a single interface definition
   */
  private generateInterface(
    obj: SmartObjectDefinition,
    interfaceName: string,
  ): string {
    const fields = Object.entries({ ...obj.fields, ...obj.writeThroughFields })
      .map(([name, field]) => {
        const optional = !field.required ? '?' : '';
        const type = this.mapFieldTypeToTS(field.type);
        return `  ${name}${optional}: ${type};`;
      })
      .join('\n');

    return `export interface ${interfaceName} {
${fields}
}`;
  }

  /**
   * Map field types to TypeScript types
   */
  private mapFieldTypeToTS(fieldType: string): string {
    switch (fieldType) {
      case 'text':
        return 'string';
      case 'decimal':
        return 'number';
      case 'integer':
        return 'number';
      case 'boolean':
        return 'boolean';
      case 'datetime':
        return 'Date | string';
      case 'json':
        return 'any';
      case 'foreignKey':
        return 'string';
      case 'crossPackageRef':
        return 'string';
      default:
        return 'any';
    }
  }

  /**
   * Generate simple endpoint list for testing/documentation
   */
  generateRestEndpoints(manifest: SmartObjectManifest): string {
    const endpoints: string[] = [];

    for (const [_name, obj] of Object.entries(manifest.objects)) {
      const apiConfig = obj.decoratorConfig.api;
      if (apiConfig !== false) {
        endpoints.push(...this.getSimpleEndpoints(obj, manifest));
      }
    }

    return endpoints.join('\n');
  }

  /**
   * Generate REST endpoint code implementations
   */
  generateRestEndpointCode(manifest: SmartObjectManifest): string {
    const endpoints: string[] = [];

    for (const [_name, obj] of Object.entries(manifest.objects)) {
      const apiConfig = obj.decoratorConfig.api;
      if (apiConfig !== false) {
        endpoints.push(this.generateRestEndpoint(obj));
      }
    }

    return endpoints.join('\n\n');
  }

  /**
   * Get simple endpoint strings for an object
   */
  private getApiRouteMetadata(
    obj: SmartObjectDefinition,
    actionName: string,
    actionDef: MethodDefinition | { isStatic?: boolean },
  ): {
    scope: 'item' | 'collection';
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    path: string;
  } {
    const config =
      obj.decoratorConfig.api && typeof obj.decoratorConfig.api === 'object'
        ? obj.decoratorConfig.api
        : undefined;
    // `@method({ httpMethod, path })` wins field by field over the class-level
    // `api.routes[action]` entry, the same merge `resolveApiActionRouteConfig`
    // and the knowledge artifact perform. Reading `routes` alone printed the
    // PRE-migration verb and path for a class that had moved to the decorator
    // (#2686).
    const effective = resolveEffectiveActionMetadata({
      actionName,
      method: actionDef,
      apiConfig: config,
    });
    const normalizedPath = (effective.path || actionName)
      .split('/')
      .map((segment) => segment.trim())
      .filter(Boolean)
      .join('/');
    const isCollectionClass =
      extendsFrameworkCollection(obj) || !!obj.extendsTypeArg;

    const defaultScope =
      isCollectionClass || actionDef.isStatic ? 'collection' : 'item';

    return {
      scope: resolveCustomActionMetadata({
        actionName,
        method: actionDef,
        apiConfig: config,
        defaultScope,
      }).scope,
      method: effective.httpMethod ?? 'POST',
      path: normalizedPath || actionName,
    };
  }

  private getSimpleEndpoints(
    obj: SmartObjectDefinition,
    manifest?: SmartObjectManifest,
  ): string[] {
    const { collection } = obj;
    const config = obj.decoratorConfig.api;
    const exclude = (typeof config === 'object' && config?.exclude) || [];
    const include =
      (typeof config === 'object' && config?.include) || undefined;
    const isCollectionClass =
      extendsFrameworkCollection(obj) || !!obj.extendsTypeArg;
    const isModelClassName = createManifestClassNamePredicate(manifest);

    const endpoints: string[] = [];

    // Determine which operations to include
    const shouldInclude = (op: string) => {
      if (include && !include.includes(op)) return false;
      if (exclude.includes(op)) return false;
      return true;
    };

    if (!isCollectionClass) {
      if (shouldInclude('list')) {
        endpoints.push(`GET /${collection}`);
      }
      if (shouldInclude('create')) {
        endpoints.push(`POST /${collection}`);
      }
      if (shouldInclude('get')) {
        endpoints.push(`GET /${collection}/:id`);
      }
      if (shouldInclude('update')) {
        endpoints.push(`PUT /${collection}/:id`);
      }
      if (shouldInclude('delete')) {
        endpoints.push(`DELETE /${collection}/:id`);
      }
    }

    // Custom actions read the ONE shared exposure resolver rather than a local
    // copy of the include/exclude rule. This listing is a published virtual
    // module (`@happyvertical/smrt-virt-routes`), so a stale rule here
    // advertises operations whose routes the emitters never wrote -- exactly
    // the consumer disagreement #2686 exists to close.
    for (const [actionName, actionDef] of Object.entries(obj.methods)) {
      if (
        !resolveApiMethodExposure({
          actionName,
          method: actionDef,
          apiConfig: config,
          isCollectionClass,
          ...(isModelClassName ? { isModelClassName } : {}),
        }).exposed
      ) {
        continue;
      }

      const route = this.getApiRouteMetadata(obj, actionName, actionDef);
      const suffix = route.scope === 'collection' ? '' : '/:id';
      endpoints.push(`${route.method} /${collection}${suffix}/${route.path}`);
    }

    return endpoints;
  }

  /**
   * Generate a single REST endpoint
   */
  private generateRestEndpoint(obj: SmartObjectDefinition): string {
    const { collection, className } = obj;
    const config = obj.decoratorConfig.api;
    const exclude = (typeof config === 'object' && config?.exclude) || [];
    const include =
      (typeof config === 'object' && config?.include) || undefined;

    const operations: string[] = [];

    // Determine which operations to include
    const shouldInclude = (op: string) => {
      if (include && !include.includes(op)) return false;
      if (exclude.includes(op)) return false;
      return true;
    };

    if (shouldInclude('list')) {
      operations.push(`  // GET /${collection} - List ${collection}`);
      operations.push(`  app.get('/${collection}', async (req: Request) => {`);
      operations.push(
        `    const collection = await get${className}Collection();`,
      );
      operations.push('    const items = await collection.list(req.query);');
      operations.push('    return Response.json(items);');
      operations.push('  });');
    }

    if (shouldInclude('get')) {
      operations.push(`  // GET /${collection}/:id - Get ${className}`);
      operations.push(
        `  app.get('/${collection}/:id', async (req: Request) => {`,
      );
      operations.push(
        `    const collection = await get${className}Collection();`,
      );
      operations.push('    const item = await collection.get(req.params.id);');
      operations.push(
        `    if (!item) return new Response('Not found', { status: 404 });`,
      );
      operations.push('    return Response.json(item);');
      operations.push('  });');
    }

    if (shouldInclude('create')) {
      operations.push(`  // POST /${collection} - Create ${className}`);
      operations.push(`  app.post('/${collection}', async (req: Request) => {`);
      operations.push(
        `    const collection = await get${className}Collection();`,
      );
      operations.push('    const data = await req.json();');
      operations.push('    const item = await collection.create(data);');
      operations.push('    return Response.json(item, { status: 201 });');
      operations.push('  });');
    }

    if (shouldInclude('update')) {
      operations.push(`  // PUT /${collection}/:id - Update ${className}`);
      operations.push(
        `  app.put('/${collection}/:id', async (req: Request) => {`,
      );
      operations.push(
        `    const collection = await get${className}Collection();`,
      );
      operations.push('    const data = await req.json();');
      operations.push(
        '    const item = await collection.update(req.params.id, data);',
      );
      operations.push(
        `    if (!item) return new Response('Not found', { status: 404 });`,
      );
      operations.push('    return Response.json(item);');
      operations.push('  });');
    }

    if (shouldInclude('delete')) {
      operations.push(`  // DELETE /${collection}/:id - Delete ${className}`);
      operations.push(
        `  app.delete('/${collection}/:id', async (req: Request) => {`,
      );
      operations.push(
        `    const collection = await get${className}Collection();`,
      );
      operations.push(
        '    const success = await collection.delete(req.params.id);',
      );
      operations.push(
        `    if (!success) return new Response('Not found', { status: 404 });`,
      );
      operations.push(`    return new Response('', { status: 204 });`);
      operations.push('  });');
    }

    return `// ${className} endpoints\n${operations.join('\n')}`;
  }

  /**
   * Generate simple MCP tool names for testing/documentation
   */
  generateMCPTools(manifest: SmartObjectManifest): string {
    const tools: string[] = [];

    for (const obj of this.selectMCPToolOwners(manifest)) {
      tools.push(...this.getSimpleMCPToolNames(obj));
    }

    return tools.join('\n');
  }

  /**
   * Choose exactly one canonical MCP owner per `collection`.
   *
   * MCP tool names are keyed on `collection`, but the framework's normal shape
   * puts a model class and its `FooCollection` access class in the manifest
   * under the SAME collection. Emitting both produces duplicate tool names with
   * differing create/update schemas, and an MCP client that indexes tools by
   * name then resolves an arbitrary one (#2631 review).
   *
   * Owners are ranked, in order:
   *
   * 1. The model class beats the collection-access class. `create`/`update`
   *    input schemas derive from `obj.fields`, and the row shape lives on the
   *    model, not on the access class.
   * 2. The shallowest class in the collection's own inheritance tree wins. An
   *    STI family shares one `collection`, and the base defines the shared row
   *    contract; a leaf subclass would narrow the emitted schema to one variant
   *    of a table the tool addresses as a whole.
   * 3. Remaining ties break lexically on the qualified name, so the emitted
   *    surface is deterministic across generation passes.
   */
  private selectMCPToolOwners(
    manifest: SmartObjectManifest,
  ): SmartObjectDefinition[] {
    const candidatesByCollection = new Map<string, SmartObjectDefinition[]>();

    for (const obj of Object.values(manifest.objects)) {
      if (obj.decoratorConfig.mcp === false) continue;
      const bucket = candidatesByCollection.get(obj.collection);
      if (bucket) bucket.push(obj);
      else candidatesByCollection.set(obj.collection, [obj]);
    }

    return [...candidatesByCollection.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([, candidates]) => {
        const depths = this.inheritanceDepthsWithin(candidates);
        let owner = candidates[0];
        for (const candidate of candidates.slice(1)) {
          if (this.preferMCPToolOwner(candidate, owner, depths)) {
            owner = candidate;
          }
        }
        return owner;
      });
  }

  /** Stable identity for an MCP owner candidate. */
  private mcpOwnerKey(obj: SmartObjectDefinition): string {
    return obj.qualifiedName || obj.className;
  }

  /**
   * Depth of each candidate inside the candidate set's OWN inheritance tree,
   * keyed by {@link mcpOwnerKey}. A candidate with no candidate ancestor is a
   * root at depth 0. Ancestors outside the set (framework bases, classes in
   * other collections) do not add depth: only the shared-collection family
   * decides which member is canonical.
   *
   * Parents resolve on `extendsQualified` first. Two packages may legally
   * contribute same-simple-name classes to one collection, so a simple-name
   * match is used only when it is unambiguous within the candidate set —
   * otherwise the walk stops rather than linking unrelated classes.
   */
  private inheritanceDepthsWithin(
    candidates: SmartObjectDefinition[],
  ): Map<string, number> {
    const byQualified = new Map<string, SmartObjectDefinition>();
    const bySimpleName = new Map<string, SmartObjectDefinition | null>();
    for (const candidate of candidates) {
      byQualified.set(this.mcpOwnerKey(candidate), candidate);
      const simple = this.simpleClassName(candidate.className);
      // `null` marks an ambiguous simple name; never resolve through it.
      bySimpleName.set(simple, bySimpleName.has(simple) ? null : candidate);
    }

    const resolveParent = (
      obj: SmartObjectDefinition,
    ): SmartObjectDefinition | undefined => {
      if (obj.extendsQualified) return byQualified.get(obj.extendsQualified);
      if (!obj.extends) return undefined;
      return bySimpleName.get(this.simpleClassName(obj.extends)) ?? undefined;
    };

    const depths = new Map<string, number>();
    for (const candidate of candidates) {
      const key = this.mcpOwnerKey(candidate);
      let depth = 0;
      let current: SmartObjectDefinition | undefined = candidate;
      const visited = new Set<string>([key]);
      while (current) {
        const parent: SmartObjectDefinition | undefined =
          resolveParent(current);
        if (!parent) break;
        const parentKey = this.mcpOwnerKey(parent);
        // Circular or self-referential extends: stop rather than loop.
        if (visited.has(parentKey)) break;
        visited.add(parentKey);
        depth += 1;
        current = parent;
      }
      depths.set(key, depth);
    }
    return depths;
  }

  /** True when `candidate` is the better canonical MCP owner than `current`. */
  private preferMCPToolOwner(
    candidate: SmartObjectDefinition,
    current: SmartObjectDefinition,
    depths: Map<string, number>,
  ): boolean {
    const candidateIsCollection = this.isCollectionAccessClass(candidate);
    const currentIsCollection = this.isCollectionAccessClass(current);
    if (candidateIsCollection !== currentIsCollection) {
      return !candidateIsCollection;
    }

    const candidateKey = this.mcpOwnerKey(candidate);
    const currentKey = this.mcpOwnerKey(current);

    const candidateDepth = depths.get(candidateKey) ?? 0;
    const currentDepth = depths.get(currentKey) ?? 0;
    if (candidateDepth !== currentDepth) {
      return candidateDepth < currentDepth;
    }

    return candidateKey < currentKey;
  }

  /**
   * Collection-access class detection, matching the convention already used by
   * `generateRestRoutes` (direct base / generic type argument) plus the
   * `FooCollection` naming fallback this generator uses elsewhere, so a deeper
   * subclass that carries no type argument of its own is still recognised.
   */
  private isCollectionAccessClass(obj: SmartObjectDefinition): boolean {
    return (
      extendsFrameworkCollection(obj) ||
      !!obj.extendsTypeArg ||
      obj.className.endsWith('Collection')
    );
  }

  /**
   * Generate MCP tool JSON definitions
   */
  generateMCPToolsCode(manifest: SmartObjectManifest): string {
    const tools: string[] = [];

    for (const obj of this.selectMCPToolOwners(manifest)) {
      const code = this.generateMCPTool(obj);
      // An object whose every operation is excluded contributes nothing;
      // pushing '' would emit a hole in the array literal (#2631).
      if (code) tools.push(code);
    }

    return tools.length > 0 ? `[\n${tools.join(',\n')}\n]` : '[]';
  }

  /**
   * Get simple MCP tool names for an object
   */
  private getSimpleMCPToolNames(obj: SmartObjectDefinition): string[] {
    const { collection } = obj;
    const config = obj.decoratorConfig.mcp;
    const exclude = (typeof config === 'object' && config?.exclude) || [];
    const include =
      (typeof config === 'object' && config?.include) || undefined;

    const tools: string[] = [];

    const shouldInclude = (op: string) => {
      if (include && !include.includes(op)) return false;
      if (exclude.includes(op)) return false;
      return true;
    };

    if (shouldInclude('list')) {
      tools.push(`list_${collection}`);
    }
    if (shouldInclude('get')) {
      tools.push(`get_${collection}`);
    }
    if (shouldInclude('create')) {
      tools.push(`create_${collection}`);
    }
    if (shouldInclude('update')) {
      tools.push(`update_${collection}`);
    }
    if (shouldInclude('delete')) {
      tools.push(`delete_${collection}`);
    }

    return tools;
  }

  /**
   * Generate a single MCP tool
   */
  private generateMCPTool(obj: SmartObjectDefinition): string {
    const { collection } = obj;
    const config = obj.decoratorConfig.mcp;
    const exclude = (typeof config === 'object' && config?.exclude) || [];
    const include =
      (typeof config === 'object' && config?.include) || undefined;

    const tools: string[] = [];

    const shouldInclude = (op: string) => {
      if (include && !include.includes(op)) return false;
      if (exclude.includes(op)) return false;
      return true;
    };

    if (shouldInclude('list')) {
      tools.push(`  {
    name: "list_${collection}",
    description: "List ${collection}",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number" },
        offset: { type: "number" },
        where: { type: "object" }
      }
    }
  }`);
    }

    if (shouldInclude('get')) {
      tools.push(`  {
    name: "get_${collection}",
    description: "Get a ${collection} entry by ID",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The ${collection} entry ID" }
      },
      required: ["id"]
    }
  }`);
    }

    const schemaProperties = JSON.stringify(
      this.generateSchemaProperties(
        Object.fromEntries(
          Object.entries(obj.fields).filter(
            ([, field]) => generatedExpression(field) === undefined,
          ),
        ),
      ),
      null,
      6,
    );

    if (shouldInclude('create')) {
      const requiredFields = Object.entries(obj.fields)
        .filter(
          ([_, field]) =>
            field.required && generatedExpression(field) === undefined,
        )
        .map(([fieldName]) => fieldName);

      tools.push(`  {
    name: "create_${collection}",
    description: "Create a new ${collection} entry",
    inputSchema: {
      type: "object",
      properties: ${schemaProperties},
      required: ${JSON.stringify(requiredFields)}
    }
  }`);
    }

    if (shouldInclude('update')) {
      tools.push(`  {
    name: "update_${collection}",
    description: "Update an existing ${collection} entry",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The ${collection} entry ID" },
        data: {
          type: "object",
          description: "Fields to update on the ${collection} entry",
          properties: ${schemaProperties}
        }
      },
      required: ["id", "data"]
    }
  }`);
    }

    if (shouldInclude('delete')) {
      tools.push(`  {
    name: "delete_${collection}",
    description: "Delete a ${collection} entry by ID",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The ${collection} entry ID" }
      },
      required: ["id"]
    }
  }`);
    }

    return tools.join(',\n');
  }

  /**
   * Generate JSON schema properties for fields
   */
  private generateSchemaProperties(
    fields: Record<string, FieldDefinition>,
  ): Record<string, JsonSchemaProperty> {
    const properties: Record<string, JsonSchemaProperty> = {};

    for (const [name, field] of Object.entries(fields)) {
      properties[name] = {
        type: this.mapFieldTypeToJSON(field.type),
        description: field.description || `The ${name} field`,
      };

      if (field.min !== undefined) properties[name].minimum = field.min;
      if (field.max !== undefined) properties[name].maximum = field.max;
      if (field.minLength !== undefined)
        properties[name].minLength = field.minLength;
      if (field.maxLength !== undefined)
        properties[name].maxLength = field.maxLength;
      if (
        field.enum &&
        field.enum.length > 0 &&
        (field.type === 'text' ||
          field.type === 'integer' ||
          field.type === 'decimal')
      ) {
        properties[name].enum = [...field.enum];
      }
    }

    return properties;
  }

  /**
   * Map field types to JSON Schema types
   */
  private mapFieldTypeToJSON(fieldType: string): string {
    switch (fieldType) {
      case 'text':
        return 'string';
      case 'decimal':
        return 'number';
      case 'integer':
        return 'integer';
      case 'boolean':
        return 'boolean';
      case 'datetime':
        return 'string';
      case 'json':
        return 'object';
      case 'foreignKey':
        return 'string';
      case 'crossPackageRef':
        return 'string';
      default:
        return 'string';
    }
  }

  /**
   * Generate agent manifests for Agent subclasses (fifth pass).
   *
   * For any SmartObjectDefinition with `agent` in its decoratorConfig,
   * auto-generates:
   * - Permissions from uiSlots (manage:*) and CLI/MCP methods (execute:*)
   * - Features from uiSlots and exposed methods
   * - Menu items from uiSlots
   * - Component declarations from package.json exports
   *
   * @param manifest - The manifest to process in-place
   * @param packageName - Package name for component export paths
   * @param packageJson - Full package.json for component discovery
   */
  generateAgentManifests(
    manifest: SmartObjectManifest,
    packageName?: string,
    packageJson?: PackageJsonLike,
  ): void {
    for (const obj of Object.values(manifest.objects)) {
      if (!obj.decoratorConfig.agent) continue;

      const agentConfig = obj.decoratorConfig.agent;
      const slug = obj.className.toLowerCase();
      // staticProperties is an untyped AST capture; assert the shape the
      // scanner records for `static uiSlots` on Agent subclasses.
      const uiSlots: Record<string, AgentUISlotManifest> =
        (obj.staticProperties?.uiSlots as
          | Record<string, AgentUISlotManifest>
          | undefined) ?? {};

      // Derive permissions
      const permissions: AgentPermission[] = [];

      // From uiSlots: manage:<slotId>
      for (const [slotId, slot] of Object.entries(uiSlots)) {
        permissions.push({
          id: `manage:${slotId}`,
          label: `Manage ${(slot as AgentUISlotManifest).label || slotId}`,
          category: 'slot',
          defaultGranted: true,
        });
      }

      // From CLI/MCP methods: execute:<methodName>
      const exposedMethods = this.getExposedMethods(obj);
      for (const methodName of exposedMethods) {
        permissions.push({
          id: `execute:${methodName}`,
          label: `Execute ${methodName}`,
          category: 'method',
          defaultGranted: true,
        });
      }

      // Derive features
      const features: AgentFeature[] = [];

      for (const [slotId, slot] of Object.entries(uiSlots)) {
        const typedSlot = slot as AgentUISlotManifest;
        features.push({
          id: slotId,
          label: typedSlot.label || slotId,
          description: typedSlot.description,
          type: 'slot',
        });
      }

      for (const methodName of exposedMethods) {
        features.push({
          id: methodName,
          label: methodName,
          type: 'method',
        });
      }

      // Derive menu items from uiSlots (sorted by order)
      const menuItems: AgentMenuItem[] = Object.entries(uiSlots)
        .map(([slotId, slot]) => {
          const typedSlot = slot as AgentUISlotManifest;
          return {
            id: slotId,
            label: typedSlot.label || slotId,
            icon: typedSlot.icon,
            order: typedSlot.order ?? 999,
            path: `/agents/${slug}/${slotId}`,
            requiredPermission: `manage:${slotId}`,
          };
        })
        .sort((a, b) => a.order - b.order);

      // Derive component declarations from package.json exports
      const components: AgentComponentDeclaration[] = [];
      if (packageName && packageJson?.exports) {
        for (const [exportKey, exportValue] of Object.entries(
          packageJson.exports,
        )) {
          // Match patterns like './admin', './town', etc.
          if (exportKey === '.' || exportKey === './manifest') continue;

          // Check if this export has a svelte condition (component export)
          const hasSvelteCondition = this.hasSvelteExport(exportValue);
          if (hasSvelteCondition) {
            const type = exportKey.replace('./', '');
            components.push({
              exportPath: `${packageName}/${type}`,
              type,
            });
          }
        }
      }

      // Capture adminRoutes from static property (same pattern as uiSlots)
      const adminRoutes: AgentAdminRouteManifest[] =
        (obj.staticProperties?.adminRoutes as
          | AgentAdminRouteManifest[]
          | undefined) ?? [];

      // Capture createEntries (agent-contributed create options)
      const createEntries: AgentCreateEntryManifest[] =
        (obj.staticProperties?.createEntries as
          | AgentCreateEntryManifest[]
          | undefined) ?? [];

      // Capture signalSubscriptions from static property
      const signalSubscriptions: string[] =
        (obj.staticProperties?.signalSubscriptions as string[] | undefined) ??
        [];

      const agentManifest: AgentManifest = {
        name: obj.className,
        slug,
        icon: agentConfig.icon,
        tier: agentConfig.tier || 'free',
        description: agentConfig.description,
        uiSlots,
        ...(adminRoutes.length > 0 ? { adminRoutes } : {}),
        ...(createEntries.length > 0 ? { createEntries } : {}),
        ...(signalSubscriptions.length > 0 ? { signalSubscriptions } : {}),
        permissions,
        features,
        menuItems,
        components,
      };

      obj.agent = agentManifest;

      logger.debug(
        `[manifest-generator] Generated agent manifest for ${obj.className}: ` +
          `${permissions.length} permissions, ${features.length} features, ` +
          `${menuItems.length} menu items, ${components.length} components`,
      );
    }
  }

  /**
   * Get deduplicated list of method names exposed via CLI and MCP config
   */
  private getExposedMethods(obj: SmartObjectDefinition): string[] {
    const methods = new Set<string>();

    const cliConfig = obj.decoratorConfig.cli;
    if (cliConfig && typeof cliConfig === 'object' && cliConfig.include) {
      for (const m of cliConfig.include) {
        methods.add(m);
      }
    }

    const mcpConfig = obj.decoratorConfig.mcp;
    if (mcpConfig && typeof mcpConfig === 'object' && mcpConfig.include) {
      for (const m of mcpConfig.include) {
        methods.add(m);
      }
    }

    return Array.from(methods);
  }

  /**
   * Check if an export value has a svelte condition (indicating a component export)
   */
  private hasSvelteExport(exportValue: unknown): boolean {
    if (!exportValue || typeof exportValue !== 'object') return false;

    // Check for { svelte: ... } condition
    if ('svelte' in exportValue) return true;

    // Check nested conditions like { import: { svelte: ... } }
    for (const val of Object.values(exportValue)) {
      if (val && typeof val === 'object' && 'svelte' in (val as object)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Save manifest to file
   */
  saveManifest(manifest: SmartObjectManifest, filePath: string): void {
    const fs = require('node:fs');
    fs.writeFileSync(filePath, JSON.stringify(manifest, null, 2));
  }

  /**
   * Load manifest from file
   */
  loadManifest(filePath: string): SmartObjectManifest {
    const fs = require('node:fs');
    const content = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(content);
  }
}

/**
 * Convenience function to generate manifest
 *
 * @param scanResults - Array of scan results containing object definitions
 * @param options - Optional configuration (passed to ManifestGenerator.generateManifest)
 */
export function generateManifest(
  scanResults: ScanResult[],
  options?: {
    packageName?: string;
    packageVersion?: string;
    packageJson?: PackageJsonLike;
    smrtDependencies?: string[];
    includeVisibility?: SmrtVisibility[];
  },
): SmartObjectManifest {
  const generator = new ManifestGenerator();
  return generator.generateManifest(scanResults, options);
}
