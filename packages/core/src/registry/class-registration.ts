/**
 * Class registration module for the SMRT ObjectRegistry.
 *
 * Handles registering classes, collections, and manifest entries.
 *
 * Extracted from registry.ts as part of issue #1006.
 * @see https://github.com/happyvertical/smrt/issues/1006
 */

import {
  declareChangeFeedSensitiveTable,
  setChangeFeedSensitiveClassResolver,
} from '../change-feed-sensitivity.js';
import { ConfigurationError } from '../errors';
import {
  discoverManifestSync,
  discoverSTISiblingsSync,
  getPackageName,
  lookupInManifest,
  readProjectManifestSync,
} from '../manifest/manifest-loader.js';
import {
  cloneManifestSchemaColumns,
  findWorkspaceRootSync,
  getLocalTestManifestCache,
  getManifestCache,
  getNodeBuiltins,
  getStaticManifestCache,
  getTestManifestCache,
} from '../manifest/store.js';
import { SmrtObject } from '../object';
import type {
  FieldDefinition,
  FieldMeta,
  MethodDefinition,
  QualifiedClassName,
  SmartObjectDefinition,
  SmartObjectManifest,
  SmrtVisibility,
} from '../scanner/types.js';
import type {
  ColumnDefinition,
  IndexDefinition,
  SchemaDefinition,
} from '../schema/types.js';
import { tableNameFromClass, toSnakeCase } from '../utils';
import {
  createQualifiedName,
  isQualifiedName,
  parseQualifiedName,
} from '../utils/qualified-names.js';
import {
  type CollisionInputs,
  decideCollisionPolicy,
  type MatchKind,
} from './collision-policy.js';
import { isFrameworkBaseClass } from './framework-base-classes.js';
import { bumpRegistryGeneration } from './generation';
import { buildInheritanceChain } from './inheritance-resolver';
import {
  createFieldFromManifest,
  mergeManifestField,
} from './manifest-field-merge.js';
import {
  findClass,
  findClassesByName,
  getCanonicalClassName,
  hasClassCaseInsensitive,
  qualifyExtendsName,
} from './name-resolver';
import {
  getClasses,
  getCollections,
  getConstructorFieldDecorators,
  getConstructorIndex,
  getConstructorTenantScopedDeclarations,
  getInheritanceCache,
  getLegacyFieldDecorators,
  getSourceFileFromStack,
  getStiSiblingsLoaded,
  verboseLog,
} from './shared-state';
import type {
  RegisteredClass,
  RegisteredField,
  SmartObjectConfig,
  ValidatorFunction,
} from './types.js';
import { compileValidators } from './validator';

/**
 * Compute the pluralized endpoint/collection name from a class name, using
 * the SAME simple inflection rules as the scanner's manifest adapter
 * (`packages/scanner/src/manifest-adapter.ts`). Used only as a fallback when
 * a registered class has no manifest-provided `collection` (e.g. inline test
 * classes registered purely via the decorator path). Keep in sync with the
 * scanner; the manifest value is always preferred when present. (smrt#1311.)
 *
 *   Currency      -> currencies   (y -> ies)
 *   CompanyResearch -> companyresearches  (ch -> ches)
 *   SourceCrawl   -> sourcecrawls  (+ s)
 *   EmploymentPerson -> employmentpersons (naive + s, NOT "people")
 */
function pluralizeCollection(className: string): string {
  const lower = className.toLowerCase();
  if (lower.endsWith('y')) return `${lower.slice(0, -1)}ies`;
  if (lower.endsWith('s') || lower.endsWith('x') || lower.endsWith('z')) {
    return `${lower}es`;
  }
  if (lower.endsWith('ch') || lower.endsWith('sh')) return `${lower}es`;
  return `${lower}s`;
}

/**
 * The collection an STI subtype shares with its STI base, for a class that
 * registers with no manifest `collection` (#3125). The manifest generator
 * gives every STI subtype its base's collection (`findSTIBase`: the oldest
 * ancestor declaring `tableStrategy: 'sti'`); a subtype decorated before its
 * manifest loads — a consumer's bundled model chunk — must resolve the same
 * one, or permission slugs and route segments derived from it name a
 * collection nothing catalogues. Ancestors resolve by constructor identity, so
 * a same-named class in another package cannot stand in for the base.
 */
function inheritedStiCollection(ctor: typeof SmrtObject): string | undefined {
  let base: RegisteredClass | undefined;
  for (
    let parent = Object.getPrototypeOf(ctor);
    parent && parent !== Function.prototype;
    parent = Object.getPrototypeOf(parent)
  ) {
    const key = getConstructorIndex().get(parent as typeof SmrtObject);
    const registered = key ? getClasses().get(key) : undefined;
    if (registered?.config?.tableStrategy === 'sti') base = registered;
  }
  return base?.collection;
}

/**
 * Shared bundled-context detector. Source files in these output
 * directories come from a bundler (Vite library mode, webpack, Next.js,
 * Nuxt, svelte-kit) that can duplicate module code across chunks.
 */
export function isBundledOutputPath(sourceFile: string | undefined): boolean {
  if (!sourceFile) return false;
  return (
    sourceFile.includes('.svelte-kit/output/') ||
    sourceFile.includes('/dist/') ||
    sourceFile.includes('/build/') ||
    sourceFile.includes('.next/') ||
    sourceFile.includes('.nuxt/')
  );
}

function normalizeSourcePath(path: string): string {
  return path
    .replace(/^file:\/\//, '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '');
}

function isAbsoluteSourcePath(path: string): boolean {
  return path.startsWith('/') || /^[a-z]:\//i.test(path);
}

/**
 * Directories a relative manifest `filePath` can be relative to: the scanned
 * project (the process's working directory) and its workspace root.
 */
function relativeSourceRoots(): string[] {
  if (typeof process === 'undefined' || typeof process.cwd !== 'function') {
    return [];
  }
  const cwd = normalizeSourcePath(process.cwd());
  const workspaceRoot = findWorkspaceRootSync(process.cwd());
  return workspaceRoot && normalizeSourcePath(workspaceRoot) !== cwd
    ? [cwd, normalizeSourcePath(workspaceRoot)]
    : [cwd];
}

/**
 * Whether two source paths name the same file. A stack frame reports an
 * absolute path; a manifest's `filePath` is absolute or relative to the
 * project or workspace root it was scanned from (anytown scans
 * `packages/cloud-network/src/models/*.ts` into the dashboard's manifest,
 * #3110), so a relative path is resolved against those roots, never matched by
 * suffix alone.
 */
export function isSameSourcePath(
  left: string | undefined,
  right: string | undefined,
): boolean {
  if (!left || !right) return false;
  const a = normalizeSourcePath(left);
  const b = normalizeSourcePath(right);
  if (a === b) return true;
  const aAbsolute = isAbsoluteSourcePath(a);
  const bAbsolute = isAbsoluteSourcePath(b);
  if (aAbsolute === bAbsolute) return false;
  const [absolute, relative] = aAbsolute ? [a, b] : [b, a];
  const path = getNodeBuiltins()?.path;
  if (!path) return false;
  // Platform `resolve` keeps a Windows drive-letter root absolute.
  return relativeSourceRoots().some(
    (root) => normalizeSourcePath(path.resolve(root, relative)) === absolute,
  );
}

/**
 * The package whose loaded manifest describes the class declared in
 * `sourceFile` — the class's identity when its nearest `package.json` is not
 * the package that scanned it (#3110). An app manifest commonly scans workspace
 * packages' sources under the app's own package name (anytown's
 * `packages/cloud-network` models are `@anytown/dashboard:*`), so the
 * stack-derived package of a source-consumed class (Vite dev server, Vitest,
 * tsx) never declares it.
 *
 * When several packages' entries describe the file, the stack-derived package
 * wins if it is one of them; otherwise a single candidate, or the one owned by
 * the manifest it appears in. Anything else is ambiguous and yields
 * `undefined`.
 */
function findManifestPackageForSource(
  name: string,
  sourceFile: string | undefined,
  stackPackageName: string | undefined,
): SourceManifestMatch | undefined {
  if (!sourceFile) return undefined;
  const manifests = new Set<SmartObjectManifest>();
  for (const manifest of [
    getLocalTestManifestCache(),
    getTestManifestCache(),
    getStaticManifestCache(),
    ...getManifestCache().values(),
  ]) {
    if (manifest?.objects) manifests.add(manifest);
  }

  const resolved = resolveSourceManifestPackage(
    name,
    sourceFile,
    stackPackageName,
    manifests,
  );
  if (resolved) return resolved;
  // No loaded manifest describes the file: a plain Node/tsx script has not
  // loaded the project's manifest yet (#3109).
  const projectManifest = readProjectManifestSync();
  return projectManifest?.objects && !manifests.has(projectManifest)
    ? resolveSourceManifestPackage(
        name,
        sourceFile,
        stackPackageName,
        new Set([projectManifest]),
      )
    : undefined;
}

interface SourceManifestMatch {
  packageName: string;
  /** The describing entry, used when the package's own manifest is not loaded. */
  entry: SmartObjectDefinition;
}

function resolveSourceManifestPackage(
  name: string,
  sourceFile: string,
  stackPackageName: string | undefined,
  manifests: Set<SmartObjectManifest>,
): SourceManifestMatch | undefined {
  const candidates = new Map<string, SmartObjectDefinition>();
  const ownedByTheirManifest = new Set<string>();
  for (const manifest of manifests) {
    for (const [key, entry] of Object.entries(manifest.objects)) {
      const qualified = isQualifiedName(key)
        ? parseQualifiedName(key)
        : undefined;
      const className = entry.className ?? qualified?.className ?? key;
      if (className !== name) continue;
      if (!isSameSourcePath(sourceFile, entry.filePath)) continue;
      const entryPackage =
        entry.packageName ?? qualified?.packageName ?? manifest.packageName;
      if (!entryPackage) continue;
      if (!candidates.has(entryPackage)) {
        candidates.set(entryPackage, { ...entry, packageName: entryPackage });
      }
      if (entryPackage === manifest.packageName) {
        ownedByTheirManifest.add(entryPackage);
      }
    }
  }

  const pick = (packageName: string): SourceManifestMatch => ({
    packageName,
    entry: candidates.get(packageName) as SmartObjectDefinition,
  });
  if (stackPackageName && candidates.has(stackPackageName)) {
    return pick(stackPackageName);
  }
  if (candidates.size === 1) return pick([...candidates.keys()][0]);
  if (ownedByTheirManifest.size === 1)
    return pick([...ownedByTheirManifest][0]);
  return undefined;
}

/**
 * Build `CollisionInputs` for the decorator-origin path (`register()`).
 * Manifest-origin inputs are built separately inside `registerFromManifest`.
 */
function buildDecoratorCollisionInputs(args: {
  ctor: typeof SmrtObject;
  name: string;
  newPackageName: string | undefined;
  newSourceFile: string | undefined;
  newInBundledContext: boolean;
  newDeclaredTableName: string | undefined;
  existing: RegisteredClass;
  existingKey: string;
  matchKind: MatchKind;
}): CollisionInputs {
  const {
    ctor,
    name,
    newPackageName,
    newSourceFile,
    newInBundledContext,
    newDeclaredTableName,
    existing,
    existingKey,
    matchKind,
  } = args;
  const existingTableName =
    existing.schema?.tableName || existing.config?.tableName;

  let newExtendsExisting = false;
  let existingExtendsNew = false;
  try {
    newExtendsExisting = ctor.prototype instanceof existing.constructor;
    existingExtendsNew = existing.constructor.prototype instanceof ctor;
  } catch {
    // `instanceof` can throw for non-function constructors. Keep both false.
  }

  const bothSourceFilesKnown = !!(newSourceFile && existing.sourceFilePath);
  const sameSourceFile =
    bothSourceFilesKnown &&
    isSameSourcePath(newSourceFile, existing.sourceFilePath);
  const existingIsPackageQualified = !!existing.packageName?.startsWith('@');
  const samePackage =
    !!newPackageName &&
    !!existing.packageName &&
    newPackageName === existing.packageName;
  const hasNewQualifiedKey = !!newPackageName;
  const existingKeyIsQualified = isQualifiedName(existingKey);

  return {
    origin: 'decorator',
    matchKind,
    sameConstructor: existing.constructor === ctor,
    sameSourceFile,
    bothSourceFilesKnown,
    existingIsManifestStub:
      (existing.constructor as { _isManifestStub?: boolean })
        ._isManifestStub === true,
    newInBundledContext,
    newExtendsExisting,
    existingExtendsNew,
    samePackage,
    existingIsPackageQualified,
    sameName: name === existing.name,
    hasNewQualifiedKey,
    existingKeyIsQualified,
    existingHasAnyPackage: !!existing.packageName,
    // Manifest-only fields; filled with safe defaults for decorator origin.
    hasManifestContent: false,
    registrationKeyDiffersFromExistingKey: false,
    existingHasNoPackage: !existing.packageName,
    declaresDifferentTable:
      !!newDeclaredTableName &&
      !!existingTableName &&
      newDeclaredTableName !== existingTableName,
  };
}

/**
 * Execute the collision policy for `register()`. Returns `true` if the
 * policy resolved the collision (caller should return from `register`);
 * `false` means no policy match (the decision table is exhaustive so
 * that never actually happens — the default row throws).
 *
 * All state mutation (`upsertExistingEntry`, verboseLog) stays in this
 * caller-side helper; the policy function itself is pure.
 */
function applyRegisterCollisionPolicy(args: {
  ctor: typeof SmrtObject;
  name: string;
  newPackageName: string | undefined;
  newSourceFile: string | undefined;
  newInBundledContext: boolean;
  newDeclaredTableName: string | undefined;
  existing: RegisteredClass;
  existingKey: string;
  matchKind: MatchKind;
  upsertExistingEntry: (
    existingKey: string,
    existing: RegisteredClass,
  ) => string;
}): boolean {
  const inputs = buildDecoratorCollisionInputs(args);
  const decision = decideCollisionPolicy(inputs);

  switch (decision.policy) {
    case 'accept':
    case 'replace': {
      // Both map to the same operation for the decorator path:
      // update the existing slot's constructor + metadata. `replace`
      // only differs in verboseLog flavor so a reviewer reading the log
      // can tell which scenario fired.
      const newKey = args.upsertExistingEntry(args.existingKey, args.existing);
      if (
        decision.scenario === 'sti-child-wins' ||
        decision.scenario === 'manifest-stub-replacement'
      ) {
        verboseLog(
          `[registry] ${decision.scenario}: '${args.name}' → key='${newKey}' (${decision.reason})`,
        );
      }
      return true;
    }
    case 'skip':
      verboseLog(
        `[registry] ${decision.scenario}: skipping '${args.name}' (${decision.reason})`,
      );
      return true;
    case 'throw': {
      const matchSuffix =
        args.matchKind === 'case-insensitive'
          ? ` (case-insensitive match with "${args.existingKey}")`
          : '';
      throw new Error(
        `SMRT Class Name Collision: "${args.name}"${matchSuffix}\n\n` +
          `A class with this name is already registered, but with a different constructor.\n` +
          `This usually happens when:\n` +
          `  1. Multiple test files define classes with the same name\n` +
          `  2. Different packages export classes with the same name\n\n` +
          `The collision will cause the wrong field definitions to be used,\n` +
          `leading to properties not being initialized correctly.\n\n` +
          `To fix:\n` +
          `  - Use unique class names (e.g., ${args.name}_UniqueId)\n` +
          `  - Or use @smrt({ name: 'unique_name' }) to override the registration name`,
      );
    }
    case 'coexist-qualified':
      // A different package's class: leave its entry alone and let the new
      // class register under its own qualified key (#3106).
      verboseLog(
        `[registry] ${decision.scenario}: '${args.name}' coexists with '${args.existingKey}' (${decision.reason})`,
      );
      return false;
    case 'merge-manifest':
      // Only reachable from the manifest path; if we somehow get here from
      // `register()`, something is miswired.
      throw new Error(
        `decideCollisionPolicy returned '${decision.policy}' for decorator origin (scenario: ${decision.scenario}). This is a bug.`,
      );
  }
}

/**
 * Build `CollisionInputs` for the manifest-origin path
 * (`registerFromManifest`). Manifest entries have string-based inheritance
 * (`objectDef.extends`) rather than prototype-based, and no real
 * constructor to compare — `sameConstructor` is always false here.
 */
function buildManifestCollisionInputs(args: {
  name: string;
  objectDef: SmartObjectDefinition;
  packageName: string | undefined;
  existing: RegisteredClass;
  existingKey: string;
  registrationKey: string;
  matchKind: MatchKind;
}): CollisionInputs {
  const {
    name,
    objectDef,
    packageName,
    existing,
    existingKey,
    registrationKey,
    matchKind,
  } = args;
  const newClassName = objectDef.className || name;
  const newExtends = objectDef.extends;

  // When an incoming manifest's `extends` points at the existing entry,
  // OR the existing entry's `extends` points at the incoming class, we
  // have an STI inheritance relationship. Each side checks:
  //   - the simple name of the other
  //   - the key under which the other is registered
  //   - a case-insensitive fallback
  //
  // The `existingKey` comparison is load-bearing for cross-package STI:
  // `existing.extends` is stored post-`qualifyExtendsName()`, so it may
  // be the fully-qualified parent key like `@pkg:Parent`. Without this
  // comparison, `existingExtendsNew` falsely reads as false and the
  // arriving parent manifest would be registered as a duplicate instead
  // of skipped. See the deep-review report on #1140 for the fix rationale.
  const newExtendsExisting = !!(
    newExtends &&
    (newExtends === existing.name ||
      newExtends === existingKey ||
      newExtends.toLowerCase() === existing.name.toLowerCase())
  );
  const existingExtendsNew = !!(
    existing.extends &&
    (existing.extends === newClassName ||
      existing.extends === name ||
      existing.extends === registrationKey ||
      existing.extends.toLowerCase() === newClassName.toLowerCase())
  );

  const newSourceFile = objectDef.filePath;
  const bothSourceFilesKnown = !!(newSourceFile && existing.sourceFilePath);
  const sameSourceFile =
    bothSourceFilesKnown && newSourceFile === existing.sourceFilePath;
  const existingIsPackageQualified = !!existing.packageName?.startsWith('@');
  const samePackage =
    !!packageName &&
    !!existing.packageName &&
    packageName === existing.packageName;

  return {
    origin: 'manifest',
    matchKind,
    sameConstructor: false,
    sameSourceFile,
    bothSourceFilesKnown,
    existingIsManifestStub:
      (existing.constructor as { _isManifestStub?: boolean })
        ._isManifestStub === true,
    newInBundledContext: false,
    newExtendsExisting,
    existingExtendsNew,
    samePackage,
    existingIsPackageQualified,
    sameName: newClassName === existing.name,
    hasNewQualifiedKey: isQualifiedName(registrationKey),
    existingKeyIsQualified: isQualifiedName(existingKey),
    existingHasAnyPackage: !!existing.packageName,
    hasManifestContent: !!(
      objectDef.fields ||
      objectDef.methods ||
      objectDef.schema ||
      objectDef.decoratorConfig
    ),
    registrationKeyDiffersFromExistingKey: registrationKey !== existingKey,
    existingHasNoPackage: !existing.packageName,
    declaresDifferentTable: false,
  };
  // Note: manifest-origin sets hasNewQualifiedKey from the final
  // registrationKey (not packageName) because registerFromManifest accepts
  // an objectDef.qualifiedName fallback when packageName is omitted —
  // deriving from packageName alone would miss that case and misroute the
  // coexistence rows. See PR #1140 review (Copilot P1 at line 287).
}

/**
 * Execute the collision policy for `registerFromManifest()`. Returns
 * `'return'` when the policy fully resolves the collision (caller should
 * early-return from `registerFromManifest`) or `'continue'` when the new
 * registration should proceed to the fresh-entry code below the collision
 * block (either a child-wins delete-then-register or a different-package
 * coexist-qualified scenario).
 *
 * Implements the `merge-manifest` contract end-to-end: fold fields via
 * `mergeManifestIntoExistingRegistration`, then conditionally alias the
 * existing entry under `registrationKey` when it differs from the
 * canonical key — both steps preserve `issue-951:144-200`.
 */
function applyManifestCollisionPolicy(args: {
  name: string;
  objectDef: SmartObjectDefinition;
  packageName: string | undefined;
  existing: RegisteredClass;
  existingKey: string;
  registrationKey: string;
  matchKind: MatchKind;
}): 'return' | 'continue' {
  const inputs = buildManifestCollisionInputs(args);
  const decision = decideCollisionPolicy(inputs);

  switch (decision.policy) {
    case 'skip':
      verboseLog(
        `[registry] ${decision.scenario}: skipping manifest '${args.name}' (${decision.reason})`,
      );
      return 'return';
    case 'replace':
      // STI child-wins: delete existing so the new entry can register fresh.
      getClasses().delete(args.existingKey);
      verboseLog(
        `[registry] ${decision.scenario}: '${args.name}' replaces '${args.existingKey}' (${decision.reason})`,
      );
      return 'continue';
    case 'merge-manifest': {
      mergeManifestIntoExistingRegistration(
        args.existing,
        args.objectDef,
        args.packageName,
      );
      if (args.registrationKey !== args.existingKey) {
        const classes = getClasses();
        classes.set(args.registrationKey, args.existing);
        getConstructorIndex().set(
          args.existing.constructor,
          args.registrationKey,
        );
      }
      return 'return';
    }
    case 'coexist-qualified':
      // Both registrations live under their qualified keys; caller falls
      // through to register the new one fresh.
      return 'continue';
    case 'accept':
      // Manifest origin never returns 'accept' (that's a decorator-path
      // policy). Treat defensively as return-no-op.
      return 'return';
    case 'throw':
      // Manifest collisions default to skip, never throw — this branch is
      // unreachable from the manifest origin. Guard against future drift.
      throw new Error(
        `decideCollisionPolicy returned 'throw' for manifest origin (scenario: ${decision.scenario}). This is a bug.`,
      );
  }
}

function resolveTableName(
  ctor: typeof SmrtObject,
  name: string,
  config: SmartObjectConfig,
): string {
  // A known package resolves by qualified identity so a same-named class in
  // another package cannot supply this one's table (#3098).
  const manifestEntry = config._manifest
    ? lookupRegistrationManifest(
        config._manifest,
        name,
        config.packageName,
        config._manifestKey,
      )
    : discoverManifestSync(
        config.packageName
          ? createQualifiedName(config.packageName, name)
          : name,
      );

  return (
    manifestEntry?.schema?.tableName ||
    manifestEntry?.decoratorConfig?.tableName ||
    config.tableName ||
    tableNameFromClass(ctor)
  );
}

/**
 * Whether `packageName` itself declares the class `qualifiedKey` names: it is
 * registered under that key (a manifest stub or an earlier registration), or
 * a manifest owned by that package describes it. A stack-derived package is
 * only trusted as a class's identity on this evidence — a consumer bundle
 * that inlined a dependency reports the consumer's package, whose manifest
 * describes the dependency's classes under the dependency's name (#3098).
 */
function packageDeclaresClass(
  packageName: string,
  qualifiedKey: string,
): boolean {
  if (getClasses().has(qualifiedKey)) return true;
  const entry = discoverManifestSync(qualifiedKey);
  return (
    !!entry &&
    (entry.packageName === undefined || entry.packageName === packageName)
  );
}

function lookupRegistrationManifest(
  manifest: SmartObjectManifest,
  name: string,
  _packageName: string | undefined,
  manifestKey: string | undefined,
): SmartObjectDefinition | undefined {
  if (manifestKey) return manifest.objects[manifestKey];
  // `_manifest` predates generated keyed registrations and accepts package-less,
  // unqualified manifests. Preserve that public compatibility path. Generated
  // code supplies `_manifestKey`, which is validated before this lookup and is
  // therefore never resolved through the ambiguous simple-name index.
  return lookupInManifest(manifest, name);
}

function validateIsolatedRegistrationManifest(
  manifest: SmartObjectManifest,
  manifestKey: string,
  name: string,
  packageName: string,
): SmartObjectDefinition {
  const entries = Object.entries(manifest.objects);
  const targetKey = createQualifiedName(packageName, name);
  const [actualKey, objectDef] = entries[0] ?? [];
  const keyMatchesIdentity =
    actualKey === name ||
    (isQualifiedName(actualKey || '') && actualKey === targetKey);
  const packageMatches =
    (!manifest.packageName || manifest.packageName === packageName) &&
    (!objectDef?.packageName || objectDef.packageName === packageName);

  if (
    entries.length !== 1 ||
    actualKey !== manifestKey ||
    !keyMatchesIdentity ||
    objectDef?.className !== name ||
    !packageMatches ||
    (objectDef?.qualifiedName !== undefined &&
      objectDef.qualifiedName !== targetKey)
  ) {
    throw new ConfigurationError(
      `Invalid isolated registration manifest for "${targetKey}".`,
      'CONFIG_INVALID_ISOLATED_MANIFEST',
      { manifestKey, targetKey },
    );
  }
  return objectDef;
}

/**
 * Publish a `@smrt({ sensitive: true })` declaration to the change feed
 * (issue #2937).
 *
 * Declares **every candidate name**, not just one. The name a class declares
 * and the name its rows are recorded under can diverge: a manifest stub
 * derives the name from `decoratorConfig` but installs
 * `objectDef.schema.tableName`, and the merge path can overwrite
 * `existing.schema.tableName`. A declaration landing on a name nothing writes
 * under is a silent fail-open, and the set is monotonic, so a superset is the
 * safe direction. (The STI case — a child declaring `sensitive` while writing
 * to its base class's table — is closed authoritatively at the write path by
 * `isChangeFeedSensitiveWrite`, which sees the real name.)
 *
 * Only `true` is acted on: the sensitive set is one-way by design, so there is
 * nothing here to undo a previous declaration.
 */
/**
 * Whether any config source declares the object credential-bearing (#2937).
 *
 * `sensitive` is one-way, so it is combined across sources with OR rather than
 * by spread precedence: only `=== true` carries meaning, and a `false` from any
 * source must never erase a `true` from another.
 */
function anySensitive(...configs: (SmartObjectConfig | undefined)[]): boolean {
  return configs.some((config) => config?.sensitive === true);
}

function declareSensitiveTable(
  config: SmartObjectConfig,
  ...tableNames: (string | undefined)[]
): void {
  if (config.sensitive !== true) return;
  for (const tableName of tableNames) {
    if (tableName) declareChangeFeedSensitiveTable(tableName);
  }
}

// The registry's class-level `sensitive` lookup, handed to the change feed so
// its write path can ask about an instance's class without importing the
// registry — `class.ts` already imports `change-feed.ts`, so the reverse edge
// would be a cycle. Installed once at module load (#2937).
setChangeFeedSensitiveClassResolver((ctor) => {
  if (typeof ctor !== 'function') return false;
  const key = getConstructorIndex().get(ctor as typeof SmrtObject);
  if (!key) return false;
  return getClasses().get(key)?.config?.sensitive === true;
});

function setSmrtTableName(ctor: typeof SmrtObject, tableName: string): void {
  const existing = Object.getOwnPropertyDescriptor(ctor, 'SMRT_TABLE_NAME');
  if (existing?.value === tableName) {
    return;
  }

  Object.defineProperty(ctor, 'SMRT_TABLE_NAME', {
    value: tableName,
    writable: false,
    enumerable: false,
    configurable: true,
  });
}

/**
 * Attach the registry's qualified name to the constructor as a static
 * property. Mirrors the `SMRT_TABLE_NAME` pattern.
 *
 * Survives:
 * - Minification (the property is set on the constructor itself).
 * - HMR / module duplication / federated-module boundaries where the
 *   `constructorIndex` WeakMap holds an older constructor identity than
 *   the one a caller has in hand.
 *
 * Acts as a belt-and-suspenders fallback for runtime code that has a
 * constructor reference and wants its registry identity without going
 * through a Map lookup (e.g. `SmrtHierarchical._hierarchyCollection`).
 */
function setSmrtQualifiedName(
  ctor: typeof SmrtObject,
  qualifiedName: string | undefined,
): void {
  if (!qualifiedName) return;
  const existing = Object.getOwnPropertyDescriptor(ctor, '_smrtQualifiedName');
  if (existing?.value === qualifiedName) {
    return;
  }

  Object.defineProperty(ctor, '_smrtQualifiedName', {
    value: qualifiedName,
    writable: false,
    enumerable: false,
    configurable: true,
  });
}

/**
 * Register (or re-register) a class. Every registration can add, replace or
 * mutate a registered class in place, so it invalidates the generation-keyed
 * registry memos before and after (#3047) — including when it throws partway.
 */
export function register(
  ctor: typeof SmrtObject,
  config: SmartObjectConfig = {},
): void {
  bumpRegistryGeneration();
  try {
    registerUntracked(ctor, config);
  } finally {
    bumpRegistryGeneration();
  }
}

function registerUntracked(
  ctor: typeof SmrtObject,
  config: SmartObjectConfig = {},
): void {
  const name = config.name || ctor.name;
  const explicitPackageName = config.packageName;
  let promotedCollectionConstructor: RegisteredClass['collectionConstructor'];
  let promotedRuntimeConfig: SmartObjectConfig | undefined;
  let isolatedManifestEntry: SmartObjectDefinition | undefined;

  if (config._manifestKey) {
    if (!explicitPackageName || !config._manifest) {
      throw new ConfigurationError(
        'Generated isolated manifest registration requires packageName and _manifest.',
        'CONFIG_INVALID_ISOLATED_MANIFEST',
      );
    }
    isolatedManifestEntry = validateIsolatedRegistrationManifest(
      config._manifest,
      config._manifestKey,
      name,
      explicitPackageName,
    );
    // Validate before promotion removes or rewrites an existing exact
    // constructor registration. A generated isolated manifest is authoritative
    // for schema, so it cannot silently erase a live @TenantScoped contract.
    if (
      config.tenantScoped === undefined &&
      normalizeTenantScopedConfig(
        isolatedManifestEntry.decoratorConfig?.tenantScoped,
      ) === undefined &&
      getConstructorTenantScopedDeclarations().get(ctor)
    ) {
      throw new ConfigurationError(
        `Manifest for '${name}' omits or disables tenantScoped but its runtime constructor is decorated with @TenantScoped(). Regenerate the manifest so tenancy schema and runtime enforcement agree.`,
        'CONFIG_TENANT_MANIFEST_CONFLICT',
      );
    }
  }

  function upsertExistingEntry(
    existingKey: string,
    existing: RegisteredClass,
  ): string {
    const nextPackageName = explicitPackageName || existing.packageName;
    const nextKey = nextPackageName
      ? createQualifiedName(nextPackageName, name)
      : name;
    // Capture pre-mutation identity so descendants whose `extends` still
    // references the old name/qualifiedName are caught by the post-mutation
    // invalidation sweep (#1139 Gap 2).
    const previousIdentity = {
      name: existing.name,
      qualifiedName: existing.qualifiedName as string | undefined,
    };

    existing.name = name;
    existing.packageName = nextPackageName;
    bumpRegistryGeneration();
    existing.qualifiedName = nextPackageName
      ? (createQualifiedName(nextPackageName, name) as QualifiedClassName)
      : undefined;
    const nextTableName = resolveTableName(ctor, name, {
      ...existing.config,
      ...config,
      ...(nextPackageName ? { packageName: nextPackageName } : {}),
    });
    existing.config = {
      ...existing.config,
      ...config,
      tableName: nextTableName,
      // OR, never last-wins — see `anySensitive` (#2937). A re-registration
      // must not be able to clear a declaration a previous one made.
      ...(anySensitive(existing.config, config)
        ? { sensitive: true as const }
        : {}),
    };
    if (!existing.schema) {
      existing.schema = {
        ddl: '',
        indexes: [],
        triggers: [],
        tableName: nextTableName,
        columns: {},
        foreignKeys: [],
        dependencies: [],
        version: '',
      };
    }
    existing.schema.tableName = nextTableName;
    // A manifest stub carries the manifest's `filePath` (a build-time source
    // path). Once a real class takes the entry over, later collision checks
    // compare against where that class actually loaded from (#3106).
    if (
      (existing.constructor as { _isManifestStub?: boolean })
        ._isManifestStub === true &&
      newSourceFile
    ) {
      existing.sourceFilePath = newSourceFile;
    }
    existing.constructor = ctor;
    setSmrtTableName(ctor, nextTableName);
    declareSensitiveTable(
      existing.config,
      nextTableName,
      existing.schema?.tableName,
    );
    setSmrtQualifiedName(ctor, existing.qualifiedName);

    if (existingKey !== nextKey) {
      const classes = getClasses();
      const existingAtNextKey = classes.get(nextKey);

      if (existingAtNextKey && existingAtNextKey !== existing) {
        throw new ConfigurationError(
          `Class registry collision while promoting "${existingKey}" to "${nextKey}". ` +
            'A different class is already registered under the target key.',
          'CONFIG_REGISTRY_PROMOTION_COLLISION',
          {
            existingKey,
            nextKey,
            className: name,
          },
        );
      }

      classes.delete(existingKey);
      classes.set(nextKey, existing);
    }

    getConstructorIndex().set(ctor, nextKey);

    // Release C follow-up #1139 Gap 2: we just mutated `existing.name`,
    // `existing.packageName`, `existing.qualifiedName`, `existing.config`,
    // `existing.constructor`, and `existing.schema.tableName`. Any
    // descendant whose cached `inheritedFields` was computed against the
    // prior identity now carries stale data. Invalidate `existing` and
    // every descendant whose `extends` matches the pre- or post-mutation
    // identity so the next field read re-merges from the current state.
    invalidateInheritanceEntries(existing, previousIdentity);

    return nextKey;
  }

  // Release C (#1134): collision resolution for both exact-match and
  // case-insensitive paths now routes through decideCollisionPolicy, which
  // consolidates the 11-branch if/else tree from pre-C.
  const newSourceFile = getSourceFileFromStack();
  const newInBundledContext = isBundledOutputPath(newSourceFile);

  // Generated consumer registration carries both an explicit package and the
  // exact constructor imported from the production bundle. Treat that pair as
  // authoritative identity: discard the earlier decorator registration (whose
  // runtime name/package may have been rewritten by bundling) and rebuild it
  // from the isolated manifest so fields, schema, and decorator config all
  // come from the correct object. This avoids guessing identity from paths,
  // names, or derived table names.
  const constructorKey = getConstructorIndex().get(ctor);
  const constructorEntry = constructorKey
    ? getClasses().get(constructorKey)
    : undefined;
  if (
    constructorKey &&
    constructorEntry &&
    Object.is(constructorEntry.constructor, ctor)
  ) {
    if (explicitPackageName && isolatedManifestEntry) {
      const targetKey = createQualifiedName(explicitPackageName, name);
      const targetEntry = getClasses().get(targetKey);
      const targetCollectionConstructor = targetEntry?.collectionConstructor;
      const targetIsManifestStub =
        targetEntry &&
        targetEntry !== constructorEntry &&
        (targetEntry.constructor as { _isManifestStub?: boolean })
          ._isManifestStub === true;

      if (
        targetEntry &&
        targetEntry !== constructorEntry &&
        !targetIsManifestStub
      ) {
        throw new ConfigurationError(
          `Class registry collision while promoting "${constructorKey}" to "${targetKey}". ` +
            'A different class is already registered under the target key.',
          'CONFIG_REGISTRY_PROMOTION_COLLISION',
          { existingKey: constructorKey, nextKey: targetKey, className: name },
        );
      }

      promotedCollectionConstructor =
        constructorEntry.collectionConstructor || targetCollectionConstructor;
      // Generated manifests are JSON data and cannot carry runtime-only
      // values such as function-valued lifecycle hooks. Preserve the exact
      // constructor's decorator-time config as the lowest-priority layer;
      // the authoritative manifest and explicit generated config still win
      // for serializable identity, schema, and policy fields.
      promotedRuntimeConfig = constructorEntry.config;
      getClasses().delete(constructorKey);
      getConstructorIndex().delete(ctor);
      if (targetIsManifestStub && targetEntry) {
        getClasses().delete(targetKey);
        getConstructorIndex().delete(targetEntry.constructor);
      }
    } else {
      upsertExistingEntry(constructorKey, constructorEntry);
      return;
    }
  }

  // The class's package identity: an explicit `packageName`; else the
  // package owning the declaring file (stack-derived) when that package
  // declares the class; else the package whose loaded manifest describes the
  // declaring file (a workspace package's source scanned into an app's
  // manifest, #3110); else the stack-derived package, unconfirmed.
  const stackPackageName = explicitPackageName
    ? undefined
    : getPackageName(ctor, true) || undefined;
  const stackPackageDeclaresClass =
    !!stackPackageName &&
    packageDeclaresClass(
      stackPackageName,
      createQualifiedName(stackPackageName, name),
    );
  const sourceManifestPackage =
    explicitPackageName || stackPackageDeclaresClass
      ? undefined
      : findManifestPackageForSource(name, newSourceFile, stackPackageName);
  const newPackageName =
    explicitPackageName ||
    sourceManifestPackage?.packageName ||
    stackPackageName;

  // #3098: when this constructor's own package is known and that package
  // declares this class (its manifest stub or an earlier registration sits
  // under the qualified key, or its manifest describes it), never adopt
  // another package's same-named registration below — `Account` exists in
  // both smrt-ledgers and smrt-messages, and a simple-name match would hand
  // one package's constructor the other's fields and table.
  const ownQualifiedKey = newPackageName
    ? createQualifiedName(newPackageName, name)
    : undefined;
  const ownPackageDeclaresClass =
    !!ownQualifiedKey &&
    (!!explicitPackageName ||
      stackPackageDeclaresClass ||
      !!sourceManifestPackage);
  const belongsToAnotherPackage = (existing: RegisteredClass): boolean =>
    ownPackageDeclaresClass &&
    !!existing.packageName &&
    existing.packageName !== newPackageName;

  // 1. Exact-match check (existingKey === name)
  const exactExisting = getClasses().get(name);
  if (exactExisting && !belongsToAnotherPackage(exactExisting)) {
    const existing = exactExisting;
    const handled = applyRegisterCollisionPolicy({
      ctor,
      name,
      newPackageName,
      newSourceFile,
      newInBundledContext,
      newDeclaredTableName: config.tableName,
      existing,
      existingKey: name,
      matchKind: 'exact-key',
      upsertExistingEntry,
    });
    if (handled) return;
  }

  // 2. Case-insensitive check for manifest stubs (Issue #531, #847) and
  //    other same-name-different-case collisions.
  const lowerName = name.toLowerCase();
  for (const [existingKey, existing] of getClasses().entries()) {
    const keyMatches = existingKey.toLowerCase() === lowerName;
    const nameMatches = existing.name?.toLowerCase() === lowerName;
    if (!(keyMatches || nameMatches) || existingKey === name) continue;

    // Distinct explicitly named packages are intentionally allowed to export
    // the same simple class name. Their qualified keys are unambiguous; do not
    // route them through the bundled-duplicate collision policy.
    if (
      explicitPackageName &&
      existing.packageName &&
      explicitPackageName !== existing.packageName &&
      isQualifiedName(existingKey)
    ) {
      continue;
    }
    // The same holds for a package identity the registry already knows this
    // class under (see ownPackageDeclaresClass above, #3098).
    if (belongsToAnotherPackage(existing)) {
      continue;
    }

    const handled = applyRegisterCollisionPolicy({
      ctor,
      name,
      newPackageName,
      newSourceFile,
      newInBundledContext,
      newDeclaredTableName: config.tableName,
      existing,
      existingKey,
      matchKind: 'case-insensitive',
      upsertExistingEntry,
    });
    if (handled) return;
  }

  // CRITICAL: Capture package name NOW, while stack trace still shows external package
  // This is called from the @smrt() decorator during import, so the stack trace
  // includes the external package file path. Later calls won't have this context.
  // Skip registry check to avoid circular dependency - class isn't registered yet!
  // This solves issue #159 where external package manifests couldn't be loaded.
  const packageNameFromStack = newPackageName;

  // Capture source file path for collision detection during module re-evaluation
  // (Issue #555: Test isolation - class name collision during vitest collection)
  const sourceFilePath = getSourceFileFromStack();

  // Get field definitions from manifest
  // Priority order (Issue #270 Phase 1 - synchronous manifest loading):
  // 1. Explicitly provided manifest (_manifest parameter)
  // 2. Test manifests (for test classes)
  // 3. Static manifests (for core framework classes)
  // 4. Cached external manifests (if already loaded)
  // For external packages not yet loaded, manifest discovery happens lazily during schema generation
  // Issue #713: Use lookupInManifest for qualified name support
  // The simple-name entry is a last resort for a class with a known package
  // identity. It never applies while another package registers a class of
  // this name, and a stack-derived identity nothing confirmed (outside
  // bundled output, where the stack package is the declaring file's own) also
  // refuses an entry another package owns: an app manifest that declares a
  // dependency loads that dependency's manifest before any of its classes
  // register, and its same-named entry would otherwise hand a consumer class
  // the dependency's identity, fields and table (#3106). In bundled output
  // (where the stack package is the bundle's) the entry is refused only when
  // the table the decorator resolved for the class differs from the entry's.
  // A class whose package is unknown still refuses a packaged entry that
  // describes another file (#3112): bundled output keeps it, where the stack
  // cannot name the declaring package, as for a stack-derived identity.
  const unknownPackageManifestEntry = () => {
    const entry = discoverManifestSync(name);
    if (
      !entry?.packageName ||
      newInBundledContext ||
      isSameSourcePath(newSourceFile, entry.filePath)
    ) {
      return entry;
    }
    return undefined;
  };
  const simpleNameManifestFallback = () => {
    if (
      findClassesByName(name).some(
        (candidate) =>
          !!candidate.packageName && candidate.packageName !== newPackageName,
      )
    ) {
      return undefined;
    }
    const entry = discoverManifestSync(name);
    const foreignEntry =
      !!entry?.packageName && entry.packageName !== newPackageName;
    if (!foreignEntry) return entry;
    // Another package's entry describes this class only when it describes
    // this class's own file: a class scanned into another package's
    // manifest under that package's key (core's own fixtures with an
    // explicit `packageName`, #3098).
    if (isSameSourcePath(newSourceFile, entry?.filePath)) return entry;
    if (ownPackageDeclaresClass) return undefined;
    const entryTable =
      entry?.schema?.tableName || entry?.decoratorConfig?.tableName;
    const declaresOtherTable =
      !!config.tableName && !!entryTable && config.tableName !== entryTable;
    return !newInBundledContext || declaresOtherTable ? undefined : entry;
  };
  let manifestEntry: ReturnType<typeof lookupInManifest> | undefined;
  if (config._manifest) {
    manifestEntry = lookupRegistrationManifest(
      config._manifest,
      name,
      explicitPackageName,
      config._manifestKey,
    );
  }
  if (!manifestEntry) {
    // A class whose own package is known resolves its manifest by qualified
    // identity only; a simple-name lookup could return another package's
    // same-named class (#3098).
    // When that identity has no manifest entry (e.g. an explicit
    // `packageName` on a class scanned into another package's manifest), the
    // simple-name entry still applies unless another package registers a
    // class of this name.
    // The same guard applies to an unconfirmed package identity: another
    // package's same-named entry must not become this class's manifest
    // (#3106).
    manifestEntry = ownQualifiedKey
      ? (discoverManifestSync(ownQualifiedKey) ??
        sourceManifestPackage?.entry ??
        simpleNameManifestFallback())
      : unknownPackageManifestEntry();
  }
  const runtimeTenantScopedDeclaration =
    getConstructorTenantScopedDeclarations().get(ctor);
  if (
    manifestEntry &&
    config.tenantScoped === undefined &&
    normalizeTenantScopedConfig(manifestEntry.decoratorConfig?.tenantScoped) ===
      undefined &&
    runtimeTenantScopedDeclaration
  ) {
    throw new ConfigurationError(
      `Manifest for '${name}' omits or disables tenantScoped but its runtime constructor is decorated with @TenantScoped(). Regenerate the manifest so tenancy schema and runtime enforcement agree.`,
      'CONFIG_TENANT_MANIFEST_CONFLICT',
    );
  }
  const fields = new Map<string, RegisteredField>();
  const methods = new Map<string, MethodDefinition>();
  let packageName: string | undefined;

  verboseLog(
    `[registry] Registering ${name}: manifestEntry =`,
    manifestEntry ? 'found' : 'not found',
  );
  if (manifestEntry?.fields) {
    verboseLog(
      `[registry] Manifest has ${Object.keys(manifestEntry.fields).length} fields:`,
      Object.keys(manifestEntry.fields),
    );
  }

  if (manifestEntry?.fields) {
    // Use manifest fields (from build-time AST scanning)
    // Store field definitions as plain objects with nested options
    for (const [fieldName, fieldDef] of Object.entries(
      manifestEntry.fields,
    ) as [string, FieldDefinition][]) {
      // Build options object, only including defined values
      const options: Record<string, unknown> = { ...fieldDef._meta };
      if (fieldDef.required !== undefined) options.required = fieldDef.required;
      if (fieldDef.default !== undefined) options.default = fieldDef.default;
      if (fieldDef.description !== undefined)
        options.description = fieldDef.description;
      if (fieldDef.transient !== undefined)
        options.transient = fieldDef.transient;

      // Store field definition as plain object maintaining Field-like structure
      const field: RegisteredField = {
        type: fieldDef.type,
      };

      // Only include options if not empty
      if (Object.keys(options).length > 0) {
        field._meta = options;
      }

      // Preserve top-level flags from manifest
      if (fieldDef.transient !== undefined) {
        field.transient = fieldDef.transient;
      }
      if (fieldDef.required !== undefined) {
        field.required = fieldDef.required;
      }
      if (fieldDef.sensitive !== undefined) {
        field.sensitive = fieldDef.sensitive;
      }
      if (fieldDef.readonly !== undefined) {
        field.readonly = fieldDef.readonly;
      }
      if (fieldDef.readPermission !== undefined) {
        field.readPermission = fieldDef.readPermission;
      }

      // Hoist related to top level for relationship fields
      // Check both fieldDef.related (new manifests) and _meta.related (old manifests)
      if (fieldDef.related !== undefined) {
        field.related = fieldDef.related;
      } else if (options.related !== undefined) {
        // `related` carries the related class name (always a string at runtime).
        field.related = options.related as string;
        delete field._meta?.related;
      }

      fields.set(fieldName, field);
    }

    verboseLog(
      `[registry] ✅ Loaded ${fields.size} fields for ${name} from manifest`,
    );

    // Use packageName from manifest if available, otherwise from stack trace
    // Priority: explicit manifest > manifestEntry > stack trace
    packageName =
      explicitPackageName ||
      config._manifest?.packageName ||
      manifestEntry.packageName ||
      packageNameFromStack;
  } else {
    // No manifest found yet - use package name from stack trace
    // This will be used later by ensureManifestLoaded() to load the external manifest
    verboseLog(
      `[registry] ⚠️  No manifest entry for ${name} - fields will be loaded later`,
    );
    packageName = packageNameFromStack;
  }

  // Apply decorator metadata to override/extend manifest fields
  // Decorators take priority over AST-scanned types (Issue #316)
  const decoratorKey = isolatedManifestEntry ? ctor.name : name;
  // Only explicit string-only registrations are ownerless legacy metadata.
  // Public decorators also expose a simple-name inspection mirror, but that
  // mirror must never become another constructor's schema.
  const simpleDecorators = getLegacyFieldDecorators().get(decoratorKey);
  const constructorDecorators = getConstructorFieldDecorators().get(ctor);
  const decorators = new Map(simpleDecorators);
  for (const [fieldName, options] of constructorDecorators ?? []) {
    decorators.set(fieldName, { ...decorators.get(fieldName), ...options });
  }
  if (decorators && decorators.size > 0) {
    verboseLog(
      `[registry] Applying ${decorators.size} field decorators for ${name}`,
    );

    for (const [fieldName, decoratorOptions] of decorators) {
      // Typed read-view of the raw `Record<string, unknown>` decorator bag so
      // the member reads below narrow to the `RegisteredField` member types
      // they feed (instead of `unknown`). Same runtime object, type-only view.
      const opts: DecoratorFieldOptions = decoratorOptions;
      const existingField = fields.get(fieldName);

      if (existingField) {
        // Merge decorator options with manifest field
        // Decorator type takes priority over AST-scanned type
        const mergedMeta: FieldMeta = {
          ...existingField._meta,
          ...decoratorOptions,
        };
        const mergedField: RegisteredField = {
          type: opts.type || existingField.type,
          _meta: mergedMeta,
        };

        // Remove 'type' from _meta if it was moved to top level
        if (mergedMeta.type) {
          delete mergedMeta.type;
        }

        // Preserve top-level flags (transient, required, etc.)
        if (opts.transient !== undefined) {
          mergedField.transient = opts.transient;
        } else if (existingField.transient !== undefined) {
          mergedField.transient = existingField.transient;
        }
        if (opts.sensitive !== undefined) {
          mergedField.sensitive = opts.sensitive;
        } else if (existingField.sensitive !== undefined) {
          mergedField.sensitive = existingField.sensitive;
        }
        if (opts.readonly !== undefined) {
          mergedField.readonly = opts.readonly;
        } else if (existingField.readonly !== undefined) {
          mergedField.readonly = existingField.readonly;
        }
        if (typeof opts.readPermission === 'string') {
          mergedField.readPermission = opts.readPermission;
        } else if (typeof existingField.readPermission === 'string') {
          mergedField.readPermission = existingField.readPermission;
        }

        // Handle required flag: nullable fields should not be required
        if (opts.nullable === true) {
          // Nullable explicitly set to true means field is NOT required
          mergedField.required = false;
          mergedMeta.required = false;
        } else if (opts.required !== undefined) {
          mergedField.required = opts.required;
        } else if (existingField.required !== undefined) {
          mergedField.required = existingField.required;
        }

        // Hoist related to top level for relationship fields
        if (opts.related !== undefined) {
          mergedField.related = opts.related;
          delete mergedField._meta?.related;
        } else if (existingField.related !== undefined) {
          mergedField.related = existingField.related;
        }

        fields.set(fieldName, mergedField);
        verboseLog(
          `[registry]   ✅ Merged decorator for ${fieldName}: type=${mergedField.type}`,
        );
      } else {
        // Decorator for field not in manifest - add it
        const newMeta: FieldMeta = decoratorOptions;
        const newField: RegisteredField = {
          type: opts.type || 'text',
          _meta: newMeta,
        };

        // Set top-level flags from decorator options
        if (opts.transient !== undefined) {
          newField.transient = opts.transient;
        }
        if (opts.sensitive !== undefined) {
          newField.sensitive = opts.sensitive;
        }
        if (opts.readonly !== undefined) {
          newField.readonly = opts.readonly;
        }
        if (typeof opts.readPermission === 'string') {
          newField.readPermission = opts.readPermission;
        }
        // Handle required flag: nullable fields should not be required
        if (opts.nullable === true) {
          newField.required = false;
          newMeta.required = false;
        } else if (opts.required !== undefined) {
          newField.required = opts.required;
        }

        // Hoist related to top level for relationship fields (Issue #746)
        // This is critical for getRelationshipMap() to detect relationships
        if (opts.related !== undefined) {
          newField.related = opts.related;
          delete newField._meta?.related;
        }

        fields.set(fieldName, newField);
        verboseLog(
          `[registry]   ✅ Added field ${fieldName} from decorator: type=${opts.type || 'text'}`,
        );
      }
    }
  }

  // Handle tenantScoped configuration (Issue #688)
  // External manifests can carry tenantScoped only in decoratorConfig, so
  // registration must honor the merged view rather than only explicit config.
  // `@TenantScoped()` is intentionally implemented by smrt-tenancy, not core;
  // when a standalone runtime imports an external model before its manifest is
  // cached, the tenant field decorator is the core-visible declaration of that
  // contract. Preserve it here so runtime registration and the manifest path
  // agree on the conflict target (#2763).
  let tenantScopedConfig: RegisteredClass['tenantScopedConfig'] | undefined;
  const constructorTenantScopedDeclaration = manifestEntry
    ? undefined
    : (runtimeTenantScopedDeclaration as
        | RegisteredClass['tenantScopedConfig']
        | undefined);
  const fieldTenantScopedConfig = tenantScopedConfigFromFieldMetadata(fields);
  const tenantScopedConfigSource: RegisteredClass['tenantScopedConfigSource'] =
    config.tenantScoped !== undefined
      ? 'explicit'
      : manifestEntry?.decoratorConfig?.tenantScoped !== undefined
        ? 'manifest'
        : manifestEntry
          ? 'manifest'
          : constructorTenantScopedDeclaration
            ? 'tenant-decorator'
            : fieldTenantScopedConfig
              ? 'field-fallback'
              : undefined;
  const effectiveTenantScoped =
    config.tenantScoped ??
    manifestEntry?.decoratorConfig?.tenantScoped ??
    (manifestEntry
      ? undefined
      : (constructorTenantScopedDeclaration ?? fieldTenantScopedConfig));
  if (effectiveTenantScoped) {
    tenantScopedConfig = normalizeTenantScopedConfig(effectiveTenantScoped);
    if (!tenantScopedConfig) return;

    // Inject or enrich tenantId field
    const fieldName = tenantScopedConfig.field;
    const hadTenantField = fields.has(fieldName);
    ensureTenantScopedField(fields, tenantScopedConfig);
    if (!hadTenantField) {
      verboseLog(
        `[registry] ✅ Injected ${fieldName} field for tenant-scoped class ${name}`,
      );
    }
  }

  if (manifestEntry?.methods) {
    // Load method definitions from manifest (for custom CLI/API/MCP generation)
    for (const [methodName, methodDef] of Object.entries(
      manifestEntry.methods,
    )) {
      methods.set(methodName, methodDef);
    }
  }

  // Also load methods from _manifestMethods in config (from consumer plugin register.js)
  // This is how external package methods are passed to the registry.
  // `_manifestMethods` is an undeclared escape-hatch carried on the config bag
  // by generated consumer `register.js`, so read it through a narrowed view.
  const manifestMethods = (
    config as unknown as {
      _manifestMethods?: Record<string, MethodDefinition>;
    }
  )._manifestMethods;
  if (manifestMethods) {
    for (const [methodName, methodDef] of Object.entries(manifestMethods)) {
      methods.set(methodName, methodDef);
    }
    verboseLog(
      `[registry] Loaded ${methods.size} methods for ${name} from _manifestMethods`,
    );
  }

  // Note: If manifest not found here, it will be loaded asynchronously when needed
  // via ensureManifestLoaded(). This allows decorators to remain synchronous while
  // supporting dynamic external package manifest loading.

  // Build inheritance chain from constructor (needed for STI table name resolution)
  const inheritanceChain = buildInheritanceChain(ctor);

  // Validate table strategy compatibility with parent (STI requirement)
  if (inheritanceChain.length > 1) {
    // This class has a parent - validate strategy compatibility
    const parentName = inheritanceChain[inheritanceChain.length - 2]; // Second-to-last is parent
    const parentEntry = findClass(parentName);

    // A framework base class (SmrtObject, SmrtHierarchical, SmrtJunction, …)
    // has no independent existence as a resource and carries no `@smrt()`
    // decorator of its own (see framework-base-classes.ts) — any table
    // strategy it appears to have once registered is just the registry's
    // undecorated-entry default, not an authored constraint later
    // subclasses must match. Every other one of this identity check's nine
    // existing call sites already exempts these classes; this STI-strategy
    // consistency check must too, or a framework base class that reaches
    // `ObjectRegistry` before its first concrete decorated descendant (e.g.
    // via #2750's worker-side manifest bulk-registration bulk-loading
    // `@happyvertical/smrt-core`'s manifest, which lists every class
    // extending `SmrtObject` including undecorated abstract bases) makes
    // that descendant's OWN, correctly-declared `tableStrategy` look like a
    // mismatch against its abstract parent's meaningless placeholder one.
    const parentIsFrameworkBase =
      parentEntry !== undefined &&
      isFrameworkBaseClass(parentEntry.name, parentEntry.packageName);

    if (parentEntry && !parentIsFrameworkBase) {
      const parentStrategy = parentEntry.config?.tableStrategy || 'default';
      const childStrategy = config.tableStrategy; // Don't default - undefined means inherit

      // Only validate if child has an EXPLICIT strategy that differs from parent
      // undefined childStrategy means it will inherit from parent
      if (childStrategy !== undefined && parentStrategy !== childStrategy) {
        throw ConfigurationError.incompatibleStrategy(
          name,
          childStrategy,
          parentName,
          parentStrategy,
        );
      }
    }
  }

  // Defer schema generation until needed (generateSchema now uses dynamic import)
  // Store table name for lazy schema generation
  // Priority for STI: manifest's tableName > decorator config > derived from class name
  // The manifest's tableName is computed at build-time when full class hierarchy is known,
  // which correctly handles STI inheritance. The decorator may derive wrong tableName
  // if parent class isn't registered yet at decorator execution time.
  // The table comes from the manifest entry selected above, which already
  // refuses another package's same-named entry: a fresh simple-name lookup
  // here bound a consumer's `LicenseSale` (`license_sales`) to smrt-commerce's
  // `contracts` table (#3106).
  const tableName =
    manifestEntry?.schema?.tableName ||
    manifestEntry?.decoratorConfig?.tableName ||
    config.tableName ||
    tableNameFromClass(ctor);
  setSmrtTableName(ctor, tableName);

  // Load pre-generated schema from manifest if available, otherwise placeholder
  let schema: SchemaDefinition;
  if (manifestEntry?.schema) {
    // Pre-generated schema from manifest (build-time)
    // Keep indexes as IndexDefinition objects for DDL strategies
    schema = {
      ddl: manifestEntry.schema.ddl,
      indexes:
        manifestEntry.schema.indexes?.map((idx: IndexDefinition) => ({
          name: idx.name,
          columns: idx.columns || [],
          unique: idx.unique || false,
          ...(idx.nullsNotDistinct ? { nullsNotDistinct: true } : {}),
          where: idx.where,
          description: idx.description,
          jsonPath: idx.jsonPath,
        })) || [],
      triggers: [],
      tableName: manifestEntry.schema.tableName || tableName,
      // Cast manifest columns to ColumnDefinition (same shape, TypeScript just needs help)
      columns: cloneManifestSchemaColumns(manifestEntry.schema.columns),
      foreignKeys: [],
      dependencies: [],
      version: manifestEntry.schema.version || '',
      packageName: manifestEntry.packageName,
    };
    verboseLog(
      `[registry] Loaded pre-generated schema for ${name} (${Object.keys(manifestEntry.schema.columns || {}).length} columns)`,
    );
  } else {
    // Placeholder schema - will be generated lazily when first needed
    schema = {
      ddl: '', // Generated lazily
      indexes: [], // Parsed from DDL lazily
      triggers: [], // No longer using database triggers - timestamps managed by application
      tableName,
      columns: {},
      foreignKeys: [],
      dependencies: [],
      version: '',
      packageName: undefined,
    };
  }

  if (schema.columns) {
    applySqlTypeOverrides(schema.columns, fields.entries());
    if (decorators && decorators.size > 0) {
      applySqlTypeOverrides(schema.columns, decorators.entries());
    }
  }

  // Use pre-computed validation rules from manifest if available (Issue #782)
  // For decorator-based registration, manifest may have pre-computed rules
  const validationRules = manifestEntry?.validationRules;
  let validators: ValidatorFunction[] | undefined;

  // Only compile validators if no pre-computed rules exist
  if (validationRules === undefined) {
    validators = compileValidators(name, fields);
  } else {
    verboseLog(
      `[registry] Using ${validationRules.length} pre-computed validation rules for ${name}`,
    );
  }

  // Derive extends from prototype chain if not available from manifest
  // This is critical for inline test classes that use decorators
  let extendsClass: string | undefined = manifestEntry?.extends;
  if (!extendsClass) {
    const proto = Object.getPrototypeOf(ctor);
    if (proto?.name && proto.name !== 'SmrtObject' && proto.name !== 'Object') {
      extendsClass = proto.name;
    }
  }

  // Merge manifest's decoratorConfig into config
  // Use the computed tableName which prioritizes manifest's value for STI correctness
  const mergedConfig = {
    ...promotedRuntimeConfig,
    ...manifestEntry?.decoratorConfig,
    ...config,
    tableName, // Override with correctly computed tableName
    // `sensitive` is an OR across every source, not last-wins (#2937). Ordinary
    // spread precedence would let an explicit `sensitive: false` from a
    // lower-priority-but-later source erase a `true` — for instance a stale
    // manifest disagreeing with the class — which is a silent fail-OPEN in a
    // control documented as one-way ("`sensitive: false` is not an opt-out").
    // Only `=== true` is meaningful anywhere, so OR is the whole rule.
    ...(anySensitive(
      promotedRuntimeConfig,
      manifestEntry?.decoratorConfig,
      config,
    )
      ? { sensitive: true as const }
      : {}),
  };

  // Declare from the MERGED config, not the raw one: generated consumer
  // registration passes the declaration through `manifestEntry.decoratorConfig`
  // rather than the call's own `config` (#2937). Both the resolved name and the
  // schema's own, which can differ.
  declareSensitiveTable(
    mergedConfig,
    tableName,
    schema?.tableName,
    manifestEntry?.schema?.tableName,
  );

  // Generate qualified name if we have a package name
  // Format: "@package/name:ClassName"
  const qualifiedName = packageName
    ? createQualifiedName(packageName, name)
    : undefined;

  // Determine visibility from config, manifest, or default to 'public'
  // Priority: explicit config > manifest > default
  const visibility: SmrtVisibility =
    config.visibility || manifestEntry?.visibility || 'public';

  // Issue #951: Use qualified name as primary key when available
  const registrationKey = qualifiedName || name;

  getClasses().set(registrationKey, {
    name,
    qualifiedName, // Qualified name for cross-package identification
    constructor: ctor,
    config: mergedConfig,
    fields,
    methods,
    schema,
    validators,
    validationRules, // Pre-computed rules from manifest (Issue #782)
    tools: manifestEntry?.tools, // AI-callable tool schemas (CLI param schemas)
    // Pluralized endpoint name. Prefer the manifest's computed value (handles
    // STI inheritance + any future inflection changes); fall back to the same
    // simple pluralization the scanner uses for inline/test classes that have
    // no manifest entry. (smrt#1311.) An STI subtype with no manifest entry
    // takes its registered STI base's, as the manifest would (#3125).
    collection:
      manifestEntry?.collection ??
      inheritedStiCollection(ctor) ??
      pluralizeCollection(name),
    collectionConstructor: promotedCollectionConstructor,
    packageName, // Store package name from manifest for getPackageName() lookup
    sourceFilePath, // Store source file for collision detection (Issue #555)
    extends: extendsClass, // Capture parent class name from manifest OR prototype chain
    extendsTypeArg: manifestEntry?.extendsTypeArg, // SmrtCollection<T> generic arg
    tenantScopedConfig, // Multi-tenancy config (Issue #688)
    tenantScopedConfigSource,
    visibility, // Visibility control for manifest filtering
    // NOTE: Don't pre-compute inheritanceChain here - let getInheritanceChain() compute
    // it lazily using the `extends` field. This ensures correct chain for both
    // decorator-registered and manifest-loaded classes.
  });

  // Release B (#1133): case-insensitive lookups iterate the classes Map
  // directly instead of maintaining a parallel classNameMap index.

  // Index constructor for O(1) reverse lookups (Issue #713: constructor-based lookup)
  getConstructorIndex().set(ctor, registrationKey);
  // Stamp the qualified name on the constructor itself as a fallback for
  // runtime code that has a constructor reference but might hit a
  // WeakMap miss (HMR / federated modules / multiple-copy edge cases).
  setSmrtQualifiedName(ctor, qualifiedName);

  verboseLog(
    `🎯 Registered smrt object: ${name} (key: ${registrationKey}) with schema for ${schema.tableName} and ${(validators?.length || 0) + (validationRules?.length || 0)} validators/rules`,
  );

  // STI sibling auto-loading (Issue #430)
  // When a class is registered that shares a table with other classes (STI),
  // we need to discover and register ALL siblings so that getAllSchemas()
  // can merge columns from all subtypes for the database adapter.
  //
  // IMPORTANT: Only auto-load siblings from EXTERNAL packages.
  // For test classes or classes in the same package, they will be registered
  // by their own @smrt() decorators. Auto-loading them as stubs would cause collisions.
  const collection = manifestEntry?.collection;
  if (collection && !getStiSiblingsLoaded().has(collection)) {
    // Mark this collection as processed to prevent infinite recursion
    getStiSiblingsLoaded().add(collection);

    verboseLog(
      `[registry] Checking for STI siblings for collection: ${collection}`,
    );

    // Discover all classes that share this collection (table)
    const siblings = discoverSTISiblingsSync(collection);

    // Register any siblings that aren't already registered
    // Only load siblings from DIFFERENT packages to avoid collisions with local classes
    for (const sibling of siblings) {
      // Use case-insensitive check to prevent registering 'Praeco' when 'praeco' exists
      if (!hasClassCaseInsensitive(sibling.className)) {
        // Skip siblings from the same package - they will be registered by their own decorators
        if (
          sibling.packageName &&
          packageName &&
          sibling.packageName === packageName
        ) {
          verboseLog(
            `[registry] Skipping STI sibling ${sibling.className} from same package: ${packageName}`,
          );
          continue;
        }

        verboseLog(
          `[registry] Auto-loading STI sibling: ${sibling.className} for collection: ${collection}`,
        );
        registerFromManifest(
          sibling.className,
          sibling.entry,
          sibling.packageName,
        );
      }
    }
  }
}

/**
 * Resolve the core-visible tenancy contract from a `@tenantId()` field when a
 * runtime registration has no manifest entry. `@TenantScoped()` lives in the
 * tenancy package, so core cannot import its registry without a cycle; the
 * field decorator runs before `@smrt()`. A nullable tenant identifier is the
 * runtime representation of optional tenancy used by that decorator.
 */
function tenantScopedConfigFromFieldMetadata(
  fields: Map<string, RegisteredField>,
): SmartObjectConfig['tenantScoped'] | undefined {
  for (const [fieldName, field] of fields) {
    const tenancy = field._meta?.__tenancy as
      | {
          isTenantIdField?: unknown;
          mode?: unknown;
          field?: unknown;
          autoFilter?: unknown;
          autoPopulate?: unknown;
          allowSuperAdminBypass?: unknown;
        }
      | undefined;
    if (tenancy?.isTenantIdField !== true) continue;

    return {
      mode:
        tenancy.mode === 'required'
          ? 'required'
          : tenancy.mode === 'optional' || field._meta?.nullable === true
            ? 'optional'
            : 'required',
      field: typeof tenancy.field === 'string' ? tenancy.field : fieldName,
      autoFilter: tenancy.autoFilter !== false,
      autoPopulate: tenancy.autoPopulate !== false,
      allowSuperAdminBypass: tenancy.allowSuperAdminBypass === true,
    };
  }
  return undefined;
}

export function registerCollection(
  objectName: string,
  // `new (options: any) => SmrtCollection<any>` is the irreducible
  // collection-constructor shape (S4 #1579): the public
  // `ObjectRegistry.registerCollection` wrapper hands a non-generic constructor
  // of exactly this form, which is not assignable to the generic
  // `typeof SmrtCollection`. Mirrors `RegisteredClass.collectionConstructor`.
  collectionConstructor: NonNullable<RegisteredClass['collectionConstructor']>,
): void {
  const registered = findClass(objectName);
  if (registered) {
    registered.collectionConstructor = collectionConstructor;
  }

  // The collections map stores `typeof SmrtCollection`; the runtime value is a
  // SmrtCollection subclass constructor. Bridge the loose constructor shape to
  // the map's element type without `any`.
  getCollections().set(
    objectName,
    collectionConstructor as unknown as Parameters<
      ReturnType<typeof getCollections>['set']
    >[1],
  );
}

// resolveManifestCollision was removed in Release C (#1134). Its three-branch
// decision is now represented as explicit rows in the collision-policy
// decision table — see `manifest-same-source-file`, `manifest-sti-child-wins`,
// `manifest-sti-parent-skip`, `manifest-default-skip` scenarios in
// packages/core/src/registry/collision-policy.ts.

type TenantScopedOptions = Exclude<
  SmartObjectConfig['tenantScoped'],
  boolean | undefined
>;

function normalizeTenantScopedConfig(
  tenantScoped: SmartObjectConfig['tenantScoped'],
): RegisteredClass['tenantScopedConfig'] | undefined {
  if (!tenantScoped) {
    return undefined;
  }

  const tenantOpts: TenantScopedOptions =
    typeof tenantScoped === 'boolean' ? {} : tenantScoped;
  return {
    mode: tenantOpts.mode ?? 'required',
    field: tenantOpts.field ?? 'tenantId',
    autoFilter: tenantOpts.autoFilter ?? true,
    autoPopulate: tenantOpts.autoPopulate ?? true,
    allowSuperAdminBypass: tenantOpts.allowSuperAdminBypass ?? false,
  };
}

export function ensureTenantScopedField(
  fields: Map<string, RegisteredField>,
  tenantScopedConfig: RegisteredClass['tenantScopedConfig'] | undefined,
): void {
  if (!tenantScopedConfig) {
    return;
  }
  // Mutates a registered class's field map in place (#3047).
  bumpRegistryGeneration();

  const fieldName = tenantScopedConfig.field;
  const existingField = fields.get(fieldName);
  if (existingField) {
    fields.set(fieldName, {
      ...existingField,
      required:
        existingField.required ?? tenantScopedConfig.mode === 'required',
      _meta: {
        ...existingField._meta,
        reference: existingField._meta?.reference ?? 'Tenant',
        sqlType: 'UUID',
        __tenancy: {
          ...existingField._meta?.__tenancy,
          isTenantIdField: true,
          ...tenantScopedConfig,
        },
      },
    });
    return;
  }

  fields.set(fieldName, {
    type: 'foreignKey',
    related: 'Tenant',
    required: tenantScopedConfig.mode === 'required',
    _meta: {
      reference: 'Tenant',
      sqlType: 'UUID',
      __tenancy: {
        isTenantIdField: true,
        ...tenantScopedConfig,
      },
    },
  });
}

function mergeIndexDefinitions(
  existingIndexes: IndexDefinition[] | undefined,
  manifestIndexes: IndexDefinition[] | undefined,
): IndexDefinition[] {
  const merged = [...(existingIndexes || [])];
  const seen = new Set(merged.map((index) => index?.name).filter(Boolean));

  for (const index of manifestIndexes || []) {
    if (!index?.name || seen.has(index.name)) {
      continue;
    }
    merged.push(index);
    seen.add(index.name);
  }

  return merged;
}

// cloneManifestSchemaColumns lives in ../manifest/store.ts — imported above.
// (Hoisted out of the duplicate definition here and in registry.ts.)

/**
 * Typed read-view of a raw decorator option bag.
 *
 * `getFieldDecorators()` stores decorator options as
 * `Map<string, Record<string, unknown>>`, so the individual reads come back as
 * `unknown` and won't narrow to the typed `RegisteredField` members they feed.
 * This interface re-types only the members the decorator-merge loop reads, with
 * exactly the target member types, and keeps the open index signature so a raw
 * `Record<string, unknown>` bag is assignable to it without `any`. (The bag's
 * runtime values are field-helper options; this view mirrors that contract.)
 */
interface DecoratorFieldOptions {
  type?: FieldDefinition['type'];
  required?: boolean;
  nullable?: boolean;
  transient?: boolean;
  sensitive?: boolean;
  readonly?: boolean;
  readPermission?: unknown;
  related?: string;
  [key: string]: unknown;
}

/**
 * Read-only field shape consumed by the SQL-type override helpers.
 *
 * `applySqlTypeOverrides` runs over two sources: the canonical
 * `Map<string, RegisteredField>` AND the raw decorator bag
 * (`Map<string, Record<string, unknown>>` from `getFieldDecorators()`). Both
 * satisfy this shape — every member is optional and the open index signature
 * matches both `RegisteredField`'s index signature and `Record<string, unknown>`
 * — so the helpers read the same overrides off either source without `any`.
 */
interface SqlTypeOverrideField {
  type?: unknown;
  sqlType?: unknown;
  __tenancy?: FieldMeta['__tenancy'];
  _meta?: FieldMeta;
  [key: string]: unknown;
}

function getReferenceKindFromFieldOptions(
  fieldOptions: SqlTypeOverrideField,
): ColumnDefinition['referenceKind'] | undefined {
  if (
    fieldOptions?.__tenancy?.isTenantIdField ||
    fieldOptions?._meta?.__tenancy?.isTenantIdField
  ) {
    return 'tenantId';
  }

  if (fieldOptions?.type === 'foreignKey') {
    return 'foreignKey';
  }

  if (fieldOptions?.type === 'crossPackageRef') {
    return 'crossPackageRef';
  }

  return undefined;
}

function applySqlTypeOverrides(
  columns: Record<string, ColumnDefinition>,
  fieldEntries: Iterable<[string, SqlTypeOverrideField]> | undefined,
): void {
  if (!fieldEntries) {
    return;
  }

  for (const [fieldName, fieldOptions] of fieldEntries) {
    const sqlType = fieldOptions?.sqlType ?? fieldOptions?._meta?.sqlType;
    const referenceKind = getReferenceKindFromFieldOptions(fieldOptions);
    if (!sqlType && !referenceKind) {
      continue;
    }

    const columnName = toSnakeCase(fieldName);
    const existingColumn = columns[columnName];
    if (!existingColumn) {
      continue;
    }

    columns[columnName] = {
      ...existingColumn,
      ...(sqlType
        ? { type: String(sqlType).toUpperCase() as ColumnDefinition['type'] }
        : {}),
      ...(referenceKind ? { referenceKind } : {}),
    };
  }
}

/**
 * Invalidate cached inheritance state (chain + inheritedFields +
 * inheritedMethods) on `existing` AND every descendant whose `extends` or
 * `inheritanceChain` references it.
 *
 * This covers both simple-name and qualified-name `extends` matches, which
 * is why `ObjectRegistry.invalidateInheritanceCache` delegates here (Release
 * C follow-up #1139 Gap 1 — the old recursive public helper only matched
 * `extends === className` by exact string, silently missing qualified
 * descendants like `@pkg:Parent`).
 *
 * `previousIdentity` is used by `upsertExistingEntry` (Gap 2): when a class
 * is promoted (its name/packageName/qualifiedName are mutated in place),
 * descendants registered against the pre-mutation identity need to be
 * invalidated too. Pass the pre-mutation `{ name, qualifiedName }` so this
 * sweep matches against both the old and new identity.
 *
 * Exported for the public `ObjectRegistry.invalidateInheritanceCache`
 * shim in registry.ts.
 */
export function invalidateInheritanceEntries(
  existing: RegisteredClass,
  previousIdentity?: {
    name?: string;
    qualifiedName?: string;
  },
): void {
  bumpRegistryGeneration();
  const cache = getInheritanceCache();
  const affectedNames = new Set<string>();

  const remember = (name: string | undefined): void => {
    if (name) {
      affectedNames.add(name);
    }
  };

  const matchNames = new Set<string>();
  const rememberMatch = (name: string | undefined): void => {
    if (name) matchNames.add(name);
  };
  rememberMatch(existing.name);
  rememberMatch(existing.qualifiedName);
  rememberMatch(previousIdentity?.name);
  rememberMatch(previousIdentity?.qualifiedName);

  for (const name of matchNames) {
    remember(name);
  }

  for (const [key, candidate] of getClasses()) {
    const extendsMatches =
      !!candidate.extends && matchNames.has(candidate.extends);
    const chainMatches =
      !!candidate.inheritanceChain &&
      candidate.inheritanceChain.some((n) => matchNames.has(n));

    if (candidate === existing || extendsMatches || chainMatches) {
      candidate.inheritanceChain = undefined;
      candidate.inheritedFields = undefined;
      candidate.inheritedMethods = undefined;
      remember(key);
      remember(candidate.name);
      remember(candidate.qualifiedName);
    }
  }

  for (const name of affectedNames) {
    cache.delete(name);
  }
}

function mergeManifestIntoExistingRegistration(
  existing: RegisteredClass,
  objectDef: SmartObjectDefinition,
  packageName?: string,
): void {
  const manifestConfig = objectDef.decoratorConfig || {};
  const runtimeTenantScopedDeclaration =
    getConstructorTenantScopedDeclarations().get(existing.constructor);
  if (
    existing.tenantScopedConfigSource !== 'explicit' &&
    normalizeTenantScopedConfig(manifestConfig.tenantScoped) === undefined &&
    runtimeTenantScopedDeclaration
  ) {
    throw new ConfigurationError(
      `Manifest for '${existing.qualifiedName || existing.name}' omits or disables tenantScoped but its runtime constructor is decorated with @TenantScoped(). Regenerate the manifest so tenancy schema and runtime enforcement agree.`,
      'CONFIG_TENANT_MANIFEST_CONFLICT',
    );
  }
  const manifestTableName =
    objectDef.schema?.tableName ||
    manifestConfig.tableName ||
    existing.schema?.tableName ||
    existing.config.tableName ||
    tableNameFromClass(existing.constructor);

  existing.config = {
    ...manifestConfig,
    ...existing.config,
    tableName: manifestTableName,
    // OR, never last-wins — see `anySensitive` (#2937).
    ...(anySensitive(manifestConfig, existing.config)
      ? { sensitive: true as const }
      : {}),
  };

  // The merge can move the recorded name onto the manifest's (#2937). Nothing
  // else on this path re-declares, so a sensitive class merged here would
  // otherwise keep its declaration on the pre-merge name only.
  declareSensitiveTable(
    existing.config,
    manifestTableName,
    objectDef.schema?.tableName,
    existing.schema?.tableName,
  );

  if (objectDef.fields) {
    for (const [fieldName, fd] of Object.entries(objectDef.fields)) {
      if (!existing.fields.has(fieldName)) {
        existing.fields.set(fieldName, createFieldFromManifest(fd));
        continue;
      }

      const existingField = existing.fields.get(fieldName);
      if (!existingField) {
        continue;
      }

      existing.fields.set(fieldName, mergeManifestField(existingField, fd));
    }
  }

  // An explicit core declaration remains authoritative. Otherwise a manifest
  // is authoritative even when it is silent: discard provisional decorator or
  // field-fallback tenancy so lazy manifest loading matches preloaded runtime.
  if (existing.tenantScopedConfigSource !== 'explicit') {
    const tenantScopedConfig = normalizeTenantScopedConfig(
      manifestConfig.tenantScoped,
    );
    existing.tenantScopedConfig = tenantScopedConfig;
    existing.tenantScopedConfigSource = 'manifest';
    if (tenantScopedConfig) {
      ensureTenantScopedField(existing.fields, tenantScopedConfig);
    }
  }

  if (objectDef.methods) {
    for (const [methodName, methodDef] of Object.entries(objectDef.methods)) {
      existing.methods.set(methodName, methodDef);
    }
  }

  if (objectDef.schema) {
    const manifestSchema: SchemaDefinition = {
      ddl: objectDef.schema.ddl || '',
      indexes:
        objectDef.schema.indexes?.map((idx: IndexDefinition) => ({
          name: idx.name,
          columns: idx.columns || [],
          unique: idx.unique || false,
          ...(idx.nullsNotDistinct ? { nullsNotDistinct: true } : {}),
          where: idx.where,
          description: idx.description,
          jsonPath: idx.jsonPath,
        })) || [],
      triggers: [],
      tableName: objectDef.schema.tableName || manifestTableName,
      columns: cloneManifestSchemaColumns(objectDef.schema.columns),
      foreignKeys: [],
      dependencies: [],
      version: objectDef.schema.version || '',
      packageName: packageName,
    };

    applySqlTypeOverrides(manifestSchema.columns, existing.fields.entries());

    existing.schema = {
      ...(existing.schema || {}),
      ...manifestSchema,
      tableName: manifestSchema.tableName,
      ddl: manifestSchema.ddl || existing.schema?.ddl || '',
      columns: {
        ...(existing.schema?.columns || {}),
        ...(manifestSchema.columns || {}),
      },
      indexes: mergeIndexDefinitions(
        existing.schema?.indexes,
        manifestSchema.indexes,
      ),
      packageName: packageName || existing.schema?.packageName,
    };
  } else if (!existing.schema) {
    existing.schema = {
      ddl: '',
      indexes: [],
      triggers: [],
      tableName: manifestTableName,
      columns: {},
      foreignKeys: [],
      dependencies: [],
      version: '',
      packageName: packageName,
    };
  } else {
    existing.schema.tableName = manifestTableName;
    existing.schema.packageName = packageName || existing.schema.packageName;
  }

  if (objectDef.validationRules !== undefined) {
    existing.validationRules = objectDef.validationRules;
    existing.validators = undefined;
  } else if (!existing.validationRules && !existing.validators) {
    existing.validators = compileValidators(existing.name, existing.fields);
  }

  if (packageName) {
    existing.packageName = packageName;
    existing.qualifiedName = createQualifiedName(
      packageName,
      existing.name,
    ) as QualifiedClassName;
  } else if (!existing.packageName && objectDef.packageName) {
    existing.packageName = objectDef.packageName;
  }

  if (objectDef.extends) {
    existing.extends = packageName
      ? qualifyExtendsName(objectDef.extends, packageName)
      : objectDef.extends;
  }

  if (!existing.sourceFilePath && objectDef.filePath) {
    existing.sourceFilePath = objectDef.filePath;
  }

  // The manifest's collection is authoritative (it carries STI inheritance):
  // a class decorated before its manifest loaded registered a derived one,
  // which permission slugs and route segments would otherwise keep (#3125).
  if (objectDef.collection) {
    existing.collection = objectDef.collection;
  }

  existing.visibility =
    objectDef.visibility || manifestConfig.visibility || existing.visibility;
  invalidateInheritanceEntries(existing);
}

export function registerFromManifest(
  name: string,
  objectDef: SmartObjectDefinition,
  manifestPackageName?: string,
): void {
  // Same invalidation contract as register() (#3047).
  bumpRegistryGeneration();
  try {
    registerFromManifestUntracked(name, objectDef, manifestPackageName);
  } finally {
    bumpRegistryGeneration();
  }
}

function registerFromManifestUntracked(
  name: string,
  objectDef: SmartObjectDefinition,
  manifestPackageName?: string,
): void {
  // Issue #2970: `manifestPackageName` identifies the package that owns the
  // manifest FILE this entry was read from, which is not always the package
  // that declares the class. A consumer app's generated `.smrt/manifest.json`
  // is an aggregate: it carries every consumed package's objects verbatim,
  // each keyed by its qualified name and each stating its own `packageName`.
  // Deriving identity from the file's owner re-attributed all of them to the
  // consumer, so a class reached through both that aggregate and its own
  // package's manifest became two registry entries under two packages and its
  // simple name went ambiguous in `findClassStrict()` — reported for
  // `SmrtHierarchical`, but true of any aggregated object.
  //
  // The entry's own declaration therefore wins; the caller's value stays as
  // the fallback for a local manifest whose entries name no package. This is
  // identity-based, so two packages genuinely declaring the same class name
  // still produce two entries and are still reported as ambiguous.
  const packageName = objectDef.packageName || manifestPackageName;

  // Issue #951: Compute simple class name and registration key early
  // `name` may be a qualified key from manifest (e.g., '@happyvertical/smrt-events:Event')
  // `simpleClassName` is always the plain class name (e.g., 'Event')
  const simpleClassName = objectDef.className || name;
  const qualifiedNameEarly = packageName
    ? createQualifiedName(packageName, simpleClassName)
    : objectDef.qualifiedName;
  const registrationKey = (qualifiedNameEarly || name) as string;

  // Release C (#1134): collision resolution routes through
  // decideCollisionPolicy. See collision-policy.ts for the 16-row decision
  // table; applyManifestCollisionPolicy below turns a policy into registry
  // mutations.
  //
  // Two collision checks, matching pre-C behavior:
  //   1. Canonical-name lookup (case-insensitive simple-name match; covers
  //      issue #950's STI child-wins and issue #951's qualified coexistence).
  //   2. Exact-key match (handles re-registration with same qualified key).
  //
  // The ambiguous case (multiple existing entries share the simple name —
  // `getCanonicalClassName` returns undefined) is NOT fed through the table.
  // It falls through both checks into the new-registration code below,
  // preserving issue #951's coexistence semantics.
  const existingCanonical = getCanonicalClassName(simpleClassName);
  if (existingCanonical) {
    const existing = getClasses().get(existingCanonical);
    if (existing) {
      const outcome = applyManifestCollisionPolicy({
        name,
        objectDef,
        packageName,
        existing,
        existingKey: existingCanonical,
        registrationKey,
        matchKind: 'canonical-name',
      });
      if (outcome === 'return') return;
      // outcome === 'continue' means policy was replace (child-wins) or
      // coexist — fall through into the new-registration code below.
    }
    // else: stale map entry (key exists but class was removed) — allow registration
  }

  if (getClasses().has(registrationKey)) {
    const existing = getClasses().get(registrationKey);
    if (!existing) return;
    const outcome = applyManifestCollisionPolicy({
      name,
      objectDef,
      packageName,
      existing,
      existingKey: registrationKey,
      registrationKey,
      matchKind: 'exact-key',
    });
    if (outcome === 'return') return;
  }

  // Issue #1004: Qualify the `extends` value BEFORE inserting this class
  // into the classes Map. Otherwise qualifyExtendsName would iterate and
  // find the child's own entry, creating a circular extends chain
  // (e.g., @test/sports:TestEvent extends itself). Release B (#1133) swapped
  // the underlying classNameMap lookup for an iteration over `classes`, but
  // the ordering invariant still holds.
  const qualifiedExtends =
    objectDef.extends && packageName
      ? qualifyExtendsName(objectDef.extends, packageName)
      : objectDef.extends;

  // Release B (#1133): case-insensitive lookups iterate the classes Map
  // directly; no parallel classNameMap index to maintain.

  // Create stub constructor - not needed for CLI command generation
  // The CLI only needs metadata (fields, methods, config)
  // Mark as manifest stub so real class can replace it during decorator registration
  const stubConstructor = class extends SmrtObject {
    static readonly _isManifestStub = true;
  } as typeof SmrtObject;
  Object.defineProperty(stubConstructor, 'name', { value: simpleClassName });

  // Convert manifest field definitions to Field objects
  const fields = new Map<string, RegisteredField>();
  const decorators = getLegacyFieldDecorators().get(simpleClassName);
  if (objectDef.fields) {
    for (const [fieldName, fd] of Object.entries(objectDef.fields)) {
      fields.set(fieldName, createFieldFromManifest(fd));
    }
  }

  // Load method definitions
  const methods = new Map<string, MethodDefinition>();
  if (objectDef.methods) {
    for (const [methodName, methodDef] of Object.entries(objectDef.methods)) {
      methods.set(methodName, methodDef);
    }
  }

  // Get config from manifest
  const config = objectDef.decoratorConfig || {};
  const tableName = config.tableName || tableNameFromClass(stubConstructor);
  // A manifest-only registration (a consumed package's stub) still carries the
  // credential declaration, and is often the ONLY registration a consumer app
  // performs for that class (#2937). `tableName` here is derived from
  // `decoratorConfig`, while the schema installed below uses
  // `objectDef.schema.tableName` — declare both.
  declareSensitiveTable(config, tableName, objectDef.schema?.tableName);

  // Load pre-generated schema from manifest if available
  // This enables efficient external package consumption without runtime schema generation
  let schema: SchemaDefinition;
  if (objectDef.schema) {
    // Pre-generated schema from manifest (build-time)
    // Keep indexes as IndexDefinition objects for DDL strategies
    schema = {
      ddl: objectDef.schema.ddl,
      indexes:
        objectDef.schema.indexes?.map((idx: IndexDefinition) => ({
          name: idx.name,
          columns: idx.columns || [],
          unique: idx.unique || false,
          ...(idx.nullsNotDistinct ? { nullsNotDistinct: true } : {}),
          where: idx.where,
          description: idx.description,
          jsonPath: idx.jsonPath,
        })) || [],
      triggers: [],
      tableName: objectDef.schema.tableName,
      columns: cloneManifestSchemaColumns(objectDef.schema.columns),
      foreignKeys: [],
      dependencies: [],
      version: objectDef.schema.version || '',
      packageName: packageName,
    };
    applySqlTypeOverrides(schema.columns, fields.entries());
    applySqlTypeOverrides(schema.columns, decorators?.entries());
    verboseLog(
      `[registry] Loaded pre-generated schema for ${name} (${Object.keys(objectDef.schema.columns || {}).length} columns)`,
    );
  } else {
    // Placeholder schema - will be generated at runtime if needed
    schema = {
      ddl: '',
      indexes: [],
      triggers: [],
      tableName,
      columns: {},
      foreignKeys: [],
      dependencies: [],
      version: '',
      packageName: packageName,
    };
  }

  // Use pre-computed validation rules from manifest if available (Issue #782)
  // This avoids compiling validator closures at runtime, reducing startup time
  const validationRules = objectDef.validationRules;
  let validators: ValidatorFunction[] | undefined;

  // Only compile validators if no pre-computed rules exist
  // (backward compatibility for older manifests)
  if (validationRules === undefined) {
    validators = compileValidators(name, fields);
    verboseLog(
      `[registry] No pre-computed rules for ${name}, compiled ${validators.length} validators`,
    );
  } else {
    verboseLog(
      `[registry] Using ${validationRules.length} pre-computed validation rules for ${name}`,
    );
  }

  // Issue #951: Use qualifiedNameEarly computed at the top of this function
  // (uses simpleClassName, not the manifest key which may already be qualified)
  const qualifiedName = qualifiedNameEarly;

  // Get visibility from manifest (defaults to 'public')
  const visibility: SmrtVisibility =
    objectDef.visibility || config.visibility || 'public';

  // Register in ObjectRegistry (metadata only, no collection constructor)
  // Manifest registration is for command discovery and help text.
  // Runtime execution requires real classes loaded from entry point.
  //
  // Issue #847: Use className from objectDef (simple name like 'Council') for the name
  // property, not the qualified name key. This enables getFields() lookups by simple
  // class name to work correctly. simpleClassName is defined earlier in this function.
  //
  // A manifest-loaded class carries `tenantScoped` only in its decorator
  // config; normalize it the way registerClass() does so the schema owner's
  // tenant column resolves for `getConflictColumns()` / `getTenantColumn()`
  // on this registration too (#2360). The manifest pipeline already
  // materialized the tenant field (`injectTenantScopedFields`), so the field
  // map is left as the manifest describes it.
  const tenantScopedConfig = normalizeTenantScopedConfig(config.tenantScoped);

  // Issue #951: Use registrationKey (qualified when available) as the primary key
  getClasses().set(registrationKey, {
    name: simpleClassName,
    qualifiedName, // Qualified name for cross-package identification
    constructor: stubConstructor,
    config,
    fields,
    methods,
    schema,
    tenantScopedConfig,
    validators,
    validationRules, // Pre-computed rules from manifest (Issue #782)
    tools: objectDef.tools, // AI-callable tool schemas (used for CLI param schemas)
    // Pluralized endpoint name; fall back to simple pluralization if a
    // (legacy) manifest lacks it. (smrt#1311.)
    collection: objectDef.collection ?? pluralizeCollection(simpleClassName),
    packageName,
    sourceFilePath: objectDef.filePath, // Store source file for collision detection (Issue #555)
    extends: qualifiedExtends, // Issue #1004: Pre-computed qualified parent
    extendsTypeArg: objectDef.extendsTypeArg, // SmrtCollection<T> generic arg
    visibility, // New: Visibility control for manifest filtering
  });
  // Tag the synthetic stub constructor with the qualified name so the
  // same constructor-side identity convention holds for manifest-loaded
  // classes as well as decorator-registered ones.
  setSmrtQualifiedName(stubConstructor, qualifiedName);

  verboseLog(
    `📦 Registered ${simpleClassName} from manifest (key: ${registrationKey}, ${fields.size} fields, ${methods.size} methods)`,
  );

  // STI sibling auto-loading (Issue #430)
  // When a class is registered that shares a table with other classes (STI),
  // we need to discover and register ALL siblings so that getAllSchemas()
  // can merge columns from all subtypes for the database adapter.
  //
  // IMPORTANT: Only auto-load siblings from EXTERNAL packages.
  // For test classes or classes in the same package, they will be registered
  // by their own @smrt() decorators. Auto-loading them as stubs would cause collisions.
  const collection = objectDef.collection;
  if (collection && !getStiSiblingsLoaded().has(collection)) {
    // Mark this collection as processed to prevent infinite recursion
    getStiSiblingsLoaded().add(collection);

    verboseLog(
      `[registry] Checking for STI siblings for collection: ${collection}`,
    );

    // Discover all classes that share this collection (table)
    const siblings = discoverSTISiblingsSync(collection);

    // Register any siblings that aren't already registered
    // Only load siblings from DIFFERENT packages to avoid collisions with local classes
    for (const sibling of siblings) {
      // Use case-insensitive check to prevent registering 'Praeco' when 'praeco' exists
      if (!hasClassCaseInsensitive(sibling.className)) {
        // Skip siblings from the same package - they will be registered by their own decorators
        if (
          sibling.packageName &&
          packageName &&
          sibling.packageName === packageName
        ) {
          verboseLog(
            `[registry] Skipping STI sibling ${sibling.className} from same package: ${packageName}`,
          );
          continue;
        }

        verboseLog(
          `[registry] Auto-loading STI sibling: ${sibling.className} for collection: ${collection}`,
        );
        registerFromManifest(
          sibling.className,
          sibling.entry,
          sibling.packageName,
        );
      }
    }
  }
}
