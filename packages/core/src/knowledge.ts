export {
  discoverScopedPackageDirectories,
  readPackageAgentDoc,
  type ScopedPackageDirectory,
} from './knowledge-discovery.js';

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';
import type {
  DomainKnowledgeAgentSurface,
  DomainKnowledgeConfig,
  DomainKnowledgeField,
  DomainKnowledgeFieldConstraints,
  DomainKnowledgeManifest,
  DomainKnowledgeMethodSignature,
  DomainKnowledgeModuleDoc,
  DomainKnowledgeObject,
  DomainKnowledgeSurface,
  DomainKnowledgeTenant,
  DomainKnowledgeWithheldSurface,
} from '@happyvertical/smrt-types';
import {
  type ApiMethodExposure,
  CRUD_OPERATIONS,
  createManifestClassNamePredicate,
  isCrudOperation,
  isCrudToolAction,
  isFrameworkLifecycleMethod,
  resolveApiMethodExposure,
  resolveCustomActionMetadata,
  resolveEffectiveActionMetadata,
} from './generators/custom-action.js';
import { isFrameworkBaseClass } from './registry/framework-base-classes.js';
import type {
  SmartObjectDefinition,
  SmartObjectManifest,
} from './scanner/types.js';
import { toSnakeCase } from './utils/naming.js';

/**
 * Minimal package.json shape consumed by the knowledge builder.
 * `name`/`version` are typed concretely because they flow into the manifest's
 * string-typed metadata fields; everything else is read via `unknown`-accepting
 * helpers (`record()`, `exportKeys()`), so an index signature is sufficient.
 */
export interface PackageJsonLike {
  name?: string;
  version?: string;
  [key: string]: unknown;
}

export interface BuildDomainKnowledgeOptions {
  manifest: SmartObjectManifest;
  rootDir: string;
  packageJson?: PackageJsonLike;
  manifestPath?: string;
  config?: DomainKnowledgeConfig;
  /**
   * The package's declared view intents and playbooks (#2591), produced by the
   * scanner's agent-surface matcher.
   *
   * Passed in rather than scanned here for one reason: the scanner carries a
   * native parser binary, and `smrt-core`'s main entry is browser-reachable.
   * The Vite plugin already imports the scanner lazily on the Node side and is
   * the one caller that writes this artifact, so it does the scan and hands the
   * result over.
   */
  agentSurface?: DomainKnowledgeAgentSurface;
}

const SDK_PACKAGE_NAMES = new Set([
  '@happyvertical/ai',
  '@happyvertical/cache',
  '@happyvertical/documents',
  '@happyvertical/email',
  '@happyvertical/encryption',
  '@happyvertical/files',
  '@happyvertical/geo',
  '@happyvertical/images',
  '@happyvertical/jobs',
  '@happyvertical/json',
  '@happyvertical/logger',
  '@happyvertical/messages',
  '@happyvertical/ocr',
  '@happyvertical/pdf',
  '@happyvertical/projects',
  '@happyvertical/repos',
  '@happyvertical/secrets',
  '@happyvertical/spider',
  '@happyvertical/sql',
  '@happyvertical/utils',
]);

const RELATIONSHIP_FIELD_TYPES = new Set([
  'foreignKey',
  'crossPackageRef',
  'oneToMany',
  'manyToMany',
]);

/**
 * The generated CRUD verbs, derived from the generators' own list so both
 * halves of this projection — which operations are ENUMERATED
 * (`resolveCrudOperations`) and which method names are RESERVED
 * (`reservesCrudName`) — move together. Reading one from `CRUD_OPERATIONS` and
 * the other from a local copy would let a new verb be suppressed as a custom
 * method while never being added as CRUD, dropping the surface entirely.
 */
const STANDARD_OPERATIONS: readonly string[] = CRUD_OPERATIONS;

/**
 * Markdown inline links whose target is a `.md` file — `[label](agents/x.md)`,
 * tolerating an `#anchor` and a `"title"`. This is how a package registers a
 * sibling module doc (#2108): the link in `AGENTS.md` IS the registration, so
 * there is no separate index to drift out of sync.
 */
const MARKDOWN_MD_LINK =
  /\[[^\]]*\]\(\s*([^)\s#]+\.md)(?:#[^)\s]*)?(?:\s+"[^"]*")?\s*\)/g;

/** `sourceHashes` key prefix for a linked module doc, e.g. `moduleDoc:agents/crm.md`. */
export const MODULE_DOC_HASH_PREFIX = 'moduleDoc:';

/**
 * `sourceHashes` key prefix for a module declaring a view intent or playbook,
 * e.g. `agentSurface:src/lib/orders.intents.ts` (#2591).
 */
export const AGENT_SURFACE_HASH_PREFIX = 'agentSurface:';

/**
 * Module doc paths linked from a package's `AGENTS.md`, relative to the package
 * root and in document order.
 *
 * Instruction chains are additive (see `scripts/check-agents-chain.mjs`), so an
 * oversized package doc is split into `packages/<pkg>/agents/<module>.md` siblings
 * instead of nested `AGENTS.md` files. Only links resolving to an existing file
 * INSIDE the package are accepted — a cross-package reference such as
 * `packages/affiliates/MIGRATION.md` belongs to that package's own chain and is
 * ignored here.
 */
export function resolveAgentModuleDocPaths(
  rootDir: string,
  agentDoc: string | undefined,
): string[] {
  if (!agentDoc) return [];
  const root = resolve(rootDir);
  const paths: string[] = [];
  for (const match of agentDoc.matchAll(MARKDOWN_MD_LINK)) {
    const target = match[1];
    if (target.includes('://')) continue;
    const absolute = resolve(root, target);
    if (absolute !== root && !absolute.startsWith(root + sep)) continue;
    const relativePath = relative(root, absolute).split(sep).join('/');
    if (relativePath === 'AGENTS.md' || relativePath === 'CLAUDE.md') continue;
    if (paths.includes(relativePath)) continue;
    if (!existsSync(absolute) || !statSync(absolute).isFile()) continue;
    paths.push(relativePath);
  }
  return paths;
}

/** {@link resolveAgentModuleDocPaths}, with each doc's contents read. */
export function readAgentModuleDocs(
  rootDir: string,
  agentDoc: string | undefined,
): DomainKnowledgeModuleDoc[] {
  return resolveAgentModuleDocPaths(rootDir, agentDoc).map((path) => ({
    path,
    module: basename(path, '.md'),
    content: readFileSync(join(rootDir, path), 'utf8'),
  }));
}

export function buildDomainKnowledgeManifest(
  options: BuildDomainKnowledgeOptions,
): DomainKnowledgeManifest {
  const rootDir = options.rootDir;
  const packageJson = options.packageJson ?? readPackageJson(rootDir) ?? {};
  const packageName = options.manifest.packageName ?? packageJson.name;
  const packageVersion = options.manifest.packageVersion ?? packageJson.version;
  const agentDocPath = existingPath(rootDir, 'AGENTS.md');
  const agentDocContent = agentDocPath
    ? readFileSync(agentDocPath, 'utf8')
    : undefined;
  const includeDocs = options.config?.includeDocs !== false;
  const agentDoc = includeDocs ? agentDocContent : undefined;
  // Module doc PATHS are always resolved so their hashes gate freshness even
  // when doc bodies are excluded from the artifact — same stance as `agents`.
  const moduleDocPaths = resolveAgentModuleDocPaths(rootDir, agentDocContent);
  const allDependencies = {
    ...record(packageJson.dependencies),
    ...record(packageJson.devDependencies),
    ...record(packageJson.peerDependencies),
  };
  const manifestObjects = Object.values(options.manifest.objects).filter(
    (object) => object.decoratorConfig?.knowledge !== false,
  );
  const objects = manifestObjects.map((object) =>
    buildKnowledgeObject(object, options.manifest),
  );
  const surfaces = objects.flatMap((object) => object.surfaces);
  const manifestJson = stableJson(normalizeManifestForHash(options.manifest));
  const agentSurface = normalizeAgentSurface(options.agentSurface);

  return {
    schemaVersion: 1,
    sensitiveFieldsExcluded: true,
    generatedAt: new Date().toISOString(),
    packageName,
    packageVersion,
    sourceManifestPath: options.manifestPath
      ? relative(rootDir, options.manifestPath)
      : undefined,
    agentDocPath: agentDocPath ? relative(rootDir, agentDocPath) : undefined,
    sourceHashes: sourceHashes({
      manifest: { content: manifestJson },
      packageJson: fileHashSource(existingPath(rootDir, 'package.json')),
      agents: fileHashSource(agentDocPath),
      ...Object.fromEntries(
        moduleDocPaths.map((path) => [
          `${MODULE_DOC_HASH_PREFIX}${path}`,
          fileHashSource(join(rootDir, path)),
        ]),
      ),
      // A module declaring an intent or a playbook is an authored source of
      // this artifact exactly like `AGENTS.md` is, so editing one must mark the
      // artifact stale (#2591).
      ...Object.fromEntries(
        agentSurfaceSourcePaths(agentSurface).map((path) => [
          `${AGENT_SURFACE_HASH_PREFIX}${path}`,
          fileHashSource(join(rootDir, path)),
        ]),
      ),
    }),
    exports: exportKeys(packageJson.exports),
    dependencies: allDependencies,
    smrtDependencies: Object.keys(allDependencies)
      .filter((dep) => dep.startsWith('@happyvertical/smrt-'))
      .sort(),
    sdkDependencies: Object.keys(allDependencies)
      .filter((dep) => SDK_PACKAGE_NAMES.has(dep))
      .sort(),
    tags: options.config?.tags ?? [],
    summary: options.config?.summary,
    risks: options.config?.risks ?? [],
    objects,
    surfaces,
    prompts:
      options.config?.includePrompts === false ? [] : readPrompts(rootDir),
    relationshipsV2: summarizeRelationships(objects, manifestObjects),
    agentDoc,
    moduleDocs:
      includeDocs && moduleDocPaths.length > 0
        ? readAgentModuleDocs(rootDir, agentDocContent)
        : undefined,
    agentSurface,
  };
}

/**
 * Drop an agent surface that carries nothing.
 *
 * Keeping the key absent for a package that declares no intent, no playbook,
 * and no diagnostic is what makes this field additive in practice: every
 * checked-in artifact for such a package stays byte-identical to what it
 * emitted before the field existed, so adding emission does not churn the
 * repository's knowledge artifacts.
 */
function normalizeAgentSurface(
  surface: DomainKnowledgeAgentSurface | undefined,
): DomainKnowledgeAgentSurface | undefined {
  if (!surface) return undefined;
  const empty =
    surface.intents.length === 0 &&
    surface.playbooks.length === 0 &&
    surface.diagnostics.length === 0;
  return empty ? undefined : surface;
}

/** Every package-relative module that contributed to the emitted surface. */
function agentSurfaceSourcePaths(
  surface: DomainKnowledgeAgentSurface | undefined,
): string[] {
  if (!surface) return [];
  const paths = new Set<string>();
  for (const intent of surface.intents) paths.add(intent.sourceFile);
  for (const playbook of surface.playbooks) paths.add(playbook.sourceFile);
  for (const diagnostic of surface.diagnostics)
    paths.add(diagnostic.sourceFile);
  return [...paths].sort();
}

function buildKnowledgeObject(
  object: SmartObjectDefinition,
  manifest: SmartObjectManifest,
): DomainKnowledgeObject {
  const knowledge =
    typeof object.decoratorConfig?.knowledge === 'object'
      ? object.decoratorConfig.knowledge
      : {};
  const fields = Object.entries(object.fields)
    .filter(([, field]) => !isSensitiveField(field))
    .map(([name, field]): DomainKnowledgeField => {
      const defaultValue = fieldValue(field, 'default');
      return {
        name,
        type: field.type,
        required: field.required,
        related: field.related,
        columnType: columnType(object, name),
        ...(defaultValue.present ? { default: defaultValue.value } : {}),
        constraints: fieldConstraints(field),
        readonly:
          field.readonly === true || field._meta?.readonly === true
            ? true
            : undefined,
        transient:
          field.transient === true || field._meta?.transient === true
            ? true
            : undefined,
      };
    });
  const sensitiveIdentifiers = sensitiveFieldIdentifiers(object.fields);
  const tenant = sanitizeTenantFacts(
    tenantFacts(object.decoratorConfig?.tenantScoped),
    sensitiveIdentifiers,
  );
  const conflictColumns = object.decoratorConfig?.conflictColumns?.filter(
    (column) => !sensitiveIdentifiers.has(column),
  );
  const relationships = fields
    .filter((field) => RELATIONSHIP_FIELD_TYPES.has(field.type))
    .map((field) => ({
      name: field.name,
      type: field.type,
      required: field.required,
      related: field.related,
      columnType: field.columnType,
    }));

  return {
    name: object.className,
    qualifiedName: object.qualifiedName,
    collection: object.collection,
    tableName: object.schema?.tableName,
    packageName: object.packageName,
    extends: object.extends,
    visibility: object.visibility,
    fields,
    relationships,
    methods: Object.keys(object.methods).sort(),
    methodSignatures: methodSignatures(object),
    tenant,
    tableStrategy: object.decoratorConfig?.tableStrategy,
    conflictColumns:
      conflictColumns && conflictColumns.length > 0
        ? conflictColumns
        : undefined,
    surfaces: objectSurfaces(object, manifest),
    ...withheldApiSurfaces(object, manifest),
    relationshipFeatures: relationshipFeatures(object, fields),
    tags: knowledge.tags ?? [],
    summary: knowledge.summary,
    risks: knowledge.risks ?? [],
  };
}

function isSensitiveField(field: SmartObjectDefinition['fields'][string]) {
  return field.sensitive === true || field._meta?.sensitive === true;
}

function sensitiveFieldIdentifiers(
  fields: SmartObjectDefinition['fields'],
): Set<string> {
  return new Set(
    Object.entries(fields)
      .filter(([, field]) => isSensitiveField(field))
      .flatMap(([name]) => [name, toSnakeCase(name), camelToSnake(name)]),
  );
}

function fieldValue(
  field: SmartObjectDefinition['fields'][string],
  key: 'default' | 'min' | 'max' | 'minLength' | 'maxLength',
): { present: boolean; value: unknown } {
  if (Object.hasOwn(field, key)) {
    return { present: field[key] !== undefined, value: field[key] };
  }
  const value = field._meta?.[key];
  return { present: value !== undefined, value };
}

function fieldConstraints(
  field: SmartObjectDefinition['fields'][string],
): DomainKnowledgeFieldConstraints | undefined {
  const constraints: DomainKnowledgeFieldConstraints = {};
  for (const key of ['min', 'max', 'minLength', 'maxLength'] as const) {
    const value = fieldValue(field, key);
    if (value.present && typeof value.value === 'number') {
      constraints[key] = value.value;
    }
  }
  const pattern = normalizePattern(
    (field as { pattern?: unknown }).pattern ?? field._meta?.pattern,
  );
  if (pattern !== undefined) constraints.pattern = pattern;
  return Object.keys(constraints).length > 0 ? constraints : undefined;
}

function normalizePattern(pattern: unknown): string | undefined {
  if (typeof pattern === 'string') return pattern;
  if (pattern instanceof RegExp) return pattern.source;
  if (
    pattern &&
    typeof pattern === 'object' &&
    typeof (pattern as { source?: unknown }).source === 'string'
  ) {
    return (pattern as { source: string }).source;
  }
  return undefined;
}

function tenantFacts(
  tenantScoped: SmartObjectDefinition['decoratorConfig']['tenantScoped'],
): DomainKnowledgeTenant | undefined {
  if (!tenantScoped) return undefined;
  if (tenantScoped === true) {
    return { scoped: true, mode: 'required', field: 'tenantId' };
  }
  return {
    scoped: true,
    mode: tenantScoped.mode ?? 'required',
    field: tenantScoped.field ?? 'tenantId',
  };
}

function sanitizeTenantFacts(
  tenant: DomainKnowledgeTenant | undefined,
  sensitiveIdentifiers: Set<string>,
): DomainKnowledgeTenant | undefined {
  if (!tenant?.field || !sensitiveIdentifiers.has(tenant.field)) return tenant;
  return { scoped: tenant.scoped, mode: tenant.mode };
}

function methodSignatures(
  object: SmartObjectDefinition,
): DomainKnowledgeMethodSignature[] | undefined {
  const signatures = Object.values(object.methods)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((method) => ({
      name: method.name,
      async: method.async || undefined,
      static: method.isStatic || undefined,
      params:
        method.parameters.length > 0
          ? method.parameters.map(
              (parameter) =>
                `${parameter.name}${parameter.optional ? '?' : ''}: ${parameter.type}`,
            )
          : undefined,
      returns: method.returnType || undefined,
    }));
  return signatures.length > 0 ? signatures : undefined;
}

function objectSurfaces(
  object: SmartObjectDefinition,
  manifest: SmartObjectManifest,
): DomainKnowledgeSurface[] {
  return [
    ...configuredSurfaces('api', object, manifest),
    ...configuredSurfaces('cli', object, manifest),
    ...configuredSurfaces('mcp', object, manifest),
    ...aiSurfaces(object),
  ];
}

/**
 * Every API-exposure decision for one object's methods, from the shared
 * resolver the route emitters use — so a method reported here as exposed has a
 * route file, and one reported as withheld has none.
 *
 * The whole point of routing this through `resolveApiMethodExposure` rather
 * than a local mirror is that a fourth copy of the rule is a fourth chance to
 * disagree with the emitters (#2686).
 */
function apiMethodDecisions(
  object: SmartObjectDefinition,
  manifest: SmartObjectManifest,
): Array<[string, ApiMethodExposure]> {
  const apiConfig = object.decoratorConfig?.api;
  const isModelClassName = createManifestClassNamePredicate(manifest);
  const collectionClass = isSurfaceCollectionClass(manifest, object);
  return Object.entries(object.methods).map(([name, method]) => [
    name,
    resolveApiMethodExposure({
      actionName: name,
      method,
      apiConfig,
      isCollectionClass: collectionClass,
      ...(isModelClassName ? { isModelClassName } : {}),
    }),
  ]);
}

/**
 * The `withheldSurfaces` half of the artifact: every public method the API
 * declined, with the reason.
 *
 * Reported for `api` only. `cli`/`mcp` gate on a much smaller, purely
 * name-based rule set that a reader can already infer from the config, while
 * the API's wire-ability heuristic rejects on a signature detail nothing else
 * in the artifact shows — which is exactly the silence #2686 set out to close.
 *
 * CRUD-reserved and non-public methods are excluded: neither was ever a
 * candidate custom action, so listing them would bury the actionable entries.
 */
function withheldApiSurfaces(
  object: SmartObjectDefinition,
  manifest: SmartObjectManifest,
): { withheldSurfaces?: DomainKnowledgeWithheldSurface[] } {
  if (isFrameworkBaseClass(object.className, object.packageName)) return {};
  const withheld = apiMethodDecisions(object, manifest)
    .filter(
      ([, decision]) =>
        !decision.exposed &&
        decision.code !== 'crud-reserved' &&
        decision.code !== 'not-public',
    )
    .map(([operation, decision]) => ({
      kind: 'api' as const,
      operation,
      code: decision.code ?? 'unknown',
      reason: decision.reason ?? '',
      objectName: object.qualifiedName ?? object.className,
    }))
    .sort((a, b) => a.operation.localeCompare(b.operation));
  return withheld.length > 0 ? { withheldSurfaces: withheld } : {};
}

function configuredSurfaces(
  kind: 'api' | 'cli' | 'mcp',
  object: SmartObjectDefinition,
  manifest: SmartObjectManifest,
): DomainKnowledgeSurface[] {
  const config = object.decoratorConfig?.[kind];
  // NOTE: the `cli` projection models the reservation rule core's
  // `CLIGenerator` used to apply (retired by #2664 -- see git history for
  // the deleted `packages/core/src/generators/cli.ts`), which reserves a
  // CRUD verb unconditionally.
  // That is NOT the shipped local CLI: `packages/cli/src/cli-generator.ts`'s
  // generator reserves one only where the CRUD command is emitted (each of
  // its commands carries its own handler), so with
  // `cli: { include: ['list', 'get'] }` a public `create()` is a reachable
  // `${object}:create` there that this projection does not report.
  //
  // Retargeting this projection at the shipped binary is tracked on #2692.
  // That is a CONTRACT CHANGE rather than a cleanup: the generators genuinely
  // disagree, so `smrt-knowledge.json` snapshots would move. Predates #2646.
  const collectionClass = isSurfaceCollectionClass(manifest, object);
  const operations = configuredOperations(kind, object, config, manifest);
  return operations.map((operation) => {
    const route =
      kind === 'api' && !STANDARD_OPERATIONS.includes(operation)
        ? apiCustomRoute(object, operation, collectionClass)
        : undefined;
    return {
      kind,
      name: surfaceName(kind, object, operation),
      operation,
      objectName: object.qualifiedName ?? object.className,
      path: kind === 'api' ? apiPath(object, operation, route) : undefined,
      method: kind === 'api' ? apiMethod(operation, route) : undefined,
    };
  });
}

/**
 * `MCPGenerator.buildCustomActionTool()` registers a custom-action tool as
 * `` `${lowerName}_${methodName}`.toLowerCase() `` — lowercasing the WHOLE
 * joined string, not just the object-name prefix. A CRUD verb is already
 * lowercase so this is a no-op there, but a camelCase custom method name
 * (`findByDimensions`) would otherwise report a surface `name` the real tool
 * is never registered under. `packages/cli/src/cli-generator.ts`'s command
 * builder (`CLIGenerator`'s private `generateObjectCommands()`) does not
 * lowercase the method half of its command string, so `cli` keeps the
 * operation as-authored.
 *
 * Note the shapes differ from the transports' own: a `cli` surface `name`
 * here is `object_operation`, while the command a user types is
 * `object:operation`. `operation` is the field to correlate on.
 */
function surfaceName(
  kind: 'api' | 'cli' | 'mcp',
  object: SmartObjectDefinition,
  operation: string,
): string {
  if (kind === 'api') return `${object.collection}.${operation}`;
  const name = `${object.className.toLowerCase()}_${operation}`;
  return kind === 'mcp' ? name.toLowerCase() : name;
}

/**
 * A hand-written `SmrtCollection` subclass (`class WidgetCollection extends
 * SmrtCollection<Widget>`) is discovered structurally by the scanner and
 * lands in the manifest even without its own `@smrt()` decorator, so it never
 * registers with `ObjectRegistry` by decoration. `MCPGenerator` (and,
 * historically, core's now-retired `CLIGenerator`, #2664) iterate the
 * decoration-populated `ObjectRegistry` directly, not the manifest, so such a
 * class never gets its own MCP tools there — only its collection-scoped
 * custom actions get REST routes. The shipped local CLI
 * (`packages/cli/src/cli-generator.ts`) is a documented exception: its
 * `ensureManifestLoaded()` pre-registers every manifest entry into
 * `ObjectRegistry` via `registerFromManifest()` before generating commands,
 * with no collection-class filter, so a manifest-only collection class IS
 * reachable there (e.g. `smrt itemcollection:list`) even though this
 * projection reports none. Reporting full CRUD for it here would over-report
 * the projection's own (registry-scoped) surface, trading the #2619
 * under-report for a new false positive there -- it does not claim the
 * shipped CLI binary lacks the surface too.
 *
 * A deeper subclass (`SpecialCollection extends WidgetCollection`) carries no
 * `extendsTypeArg` of its own, so this walks the extends chain through the
 * manifest — mirroring `isCollectionManifestClass` in
 * `vite-plugin/web-collections.ts` (kept as a separate, lean implementation
 * here rather than imported: that module pulls in the full SvelteKit route
 * generator transitively, which would balloon the standalone `./knowledge`
 * build entry for a ~15-line check).
 */
function isSurfaceCollectionClass(
  manifest: SmartObjectManifest,
  object: SmartObjectDefinition,
  seen: Set<string> = new Set(),
): boolean {
  // Truthy check (not `!== undefined`) mirrors the scanner: a non-generic
  // base emitting `extendsTypeArg: null` must not be misread as a collection.
  if (object.extends === 'SmrtCollection' || object.extendsTypeArg) {
    return true;
  }
  const parentName = object.extendsQualified || object.extends;
  if (!parentName || seen.has(parentName)) return false;
  seen.add(parentName);
  const parent = findManifestObjectByName(manifest, parentName, object);
  return parent ? isSurfaceCollectionClass(manifest, parent, seen) : false;
}

function findManifestObjectByName(
  manifest: SmartObjectManifest,
  name: string,
  owner: SmartObjectDefinition,
): SmartObjectDefinition | undefined {
  const entries = Object.entries(manifest.objects);
  if (name.includes(':')) {
    const exact = entries.find(
      ([key, candidate]) => (candidate.qualifiedName ?? key) === name,
    );
    if (exact) return exact[1];
  }
  // Prefer a same-package parent before falling back to a bare simple name:
  // an aggregated manifest can carry several classes sharing one simple name,
  // and resolving the wrong one misclassifies the collection-class carve-out.
  const ownerKey = entries.find(([, candidate]) => candidate === owner)?.[0];
  const ownerPackage = manifestObjectPackage(owner, ownerKey);
  if (ownerPackage) {
    const packageLocal = entries.find(
      ([key, candidate]) =>
        manifestObjectPackage(candidate, key) === ownerPackage &&
        candidate.className === name,
    );
    if (packageLocal) return packageLocal[1];
  }
  return entries.find(([, candidate]) => candidate.className === name)?.[1];
}

/**
 * An object's owning package. `packageName` is optional on
 * `SmartObjectDefinition` (older manifests and hand-built fixtures omit it),
 * so fall back to the package half of the qualified name — and, when that is
 * absent too, of the manifest key, which is qualified for every entry the
 * scanner writes. Mirrors `manifestObjectPackage` in
 * `vite-plugin/web-collections.ts`, key fallback included: without it an
 * entry carrying only a qualified key resolves no package at all, the
 * same-package preference is skipped, and a duplicate simple name can pick
 * the wrong parent.
 */
function manifestObjectPackage(
  object: SmartObjectDefinition,
  manifestKey?: string,
): string | undefined {
  if (object.packageName) return object.packageName;
  const qualifiedName = object.qualifiedName ?? manifestKey;
  const separator = qualifiedName?.lastIndexOf(':') ?? -1;
  return separator > 0 ? qualifiedName?.slice(0, separator) : undefined;
}

/**
 * Operations exposed for one object's `api`/`cli`/`mcp` surface, derived from
 * the same defaults `APIGenerator`/core's retired `CLIGenerator`
 * (#2664)/`MCPGenerator` apply rather
 * than from the presence of a config key (#2619): an omitted config is full
 * CRUD, not a closed surface — an `include` list, when present, is the
 * COMPLETE allowlist for custom methods too; without one, every public
 * method not explicitly excluded is exposed by default. Only `config ===
 * false` closes the surface entirely.
 *
 * Custom (non-CRUD, public) method gating is NOT identical across the three
 * kinds. Core's retired `CLIGenerator.listCommands()`/`assertCommandExposed()`
 * (#2664) and
 * `MCPGenerator.generateTools()` both refuse a framework lifecycle method
 * (`save`, `initialize`, ...) even when a class declares its own override —
 * it is the mechanism behind generated CRUD, not a distinct action (#2638) —
 * and `resolveCustomMethodNames()` below mirrors that same
 * `isFrameworkLifecycleMethod()` check for `kind === 'cli'` and
 * `kind === 'mcp'` (#2657, #2638). `api` remains ungated on this: the
 * generator did not change in #2650/#2638, and the fix there is a PR #2651
 * recommendation, not yet implemented.
 *
 * `resolveCustomMethodNames()` also mirrors two more `mcp`-only behaviors
 * that follow from its case-folded tool-id namespace (#2638): an `exclude`
 * entry is compared case-insensitively (matching `MCPGenerator`'s own
 * asymmetry fix -- `exclude` used to fail open on a cased entry the way
 * `include` never did), and two method names that fold onto the same tool id
 * (e.g. `Refresh`/`refresh`) are reported once, keeping whichever was
 * declared first, mirroring `MCPGenerator`'s per-object dedup. `cli`/`api`
 * keep declared casing in their command/route names, so neither behavior
 * applies to them.
 *
 * This `cli` projection models the reservation rule core's `CLIGenerator`
 * used to apply (`generators/cli.ts`, retired by #2664), not the shipped
 * local CLI transport (`packages/cli/src/cli-generator.ts`, the
 * `smrt <object>:<action>` binary): that generator does not gate on
 * `isFrameworkLifecycleMethod()` today, so a locally overridden lifecycle
 * method the artifact now reports as absent can still be invoked there.
 * Retargeting this projection at the shipped binary is a contract change
 * tracked on #2692, not part of this fix.
 */
function configuredOperations(
  kind: 'api' | 'cli' | 'mcp',
  object: SmartObjectDefinition,
  config: unknown,
  manifest: SmartObjectManifest,
): string[] {
  if (config === false) return [];
  // The framework's own abstract base classes (SmrtObject, SmrtCollection,
  // ...) are scaffolding, not resources: MCPGenerator/route generation and
  // packages/cli's CLIGenerator all skip them by class identity now (#2642),
  // independent of
  // their `decoratorConfig: {}` shape, so this mirrors the same shared
  // check rather than reporting a synthetic surface for them.
  if (isFrameworkBaseClass(object.className, object.packageName)) return [];
  const collectionClass = isSurfaceCollectionClass(manifest, object);
  const crud = collectionClass ? [] : resolveCrudOperations(config);
  // `api` delegates custom-method eligibility wholesale to the emitters' own
  // resolver — CRUD reservation, framework lifecycle methods, include/exclude,
  // `@method()` overrides, the wire-ability heuristic, and the receiver check
  // are all decided there, once (#2686). `cli`/`mcp` keep their own projection
  // of `CLIGenerator`/`MCPGenerator`, whose rules genuinely differ (case-folded
  // tool ids, per-object dedup) and which #2692 owns.
  if (kind === 'api') {
    const custom = apiMethodDecisions(object, manifest)
      .filter(([, decision]) => decision.exposed)
      .map(([operation]) => operation);
    return [...crud, ...custom];
  }
  const custom = resolveCustomMethodNames(
    Object.entries(object.methods),
    config,
    kind,
  );
  return [...crud, ...custom];
}

function resolveCrudOperations(config: unknown): string[] {
  const { include, exclude } = includeExcludeConfig(config);
  const base = include
    ? STANDARD_OPERATIONS.filter((operation) => include.includes(operation))
    : [...STANDARD_OPERATIONS];
  if (!exclude || exclude.length === 0) return base;
  const excluded = new Set(exclude);
  return base.filter((operation) => !excluded.has(operation));
}

function resolveCustomMethodNames(
  methods: Iterable<[string, { isPublic?: boolean }]>,
  config: unknown,
  kind: 'api' | 'cli' | 'mcp',
): string[] {
  const { include, exclude } = includeExcludeConfig(config);
  const excluded = new Set(exclude ?? []);
  // MCP tool ids are case-folded, so `MCPGenerator` compares `exclude`
  // case-insensitively too (`exclude: ['Refresh']` must suppress a method
  // declared `refresh`, and vice versa, #2638) -- mirror that here for
  // `kind === 'mcp'` only. `cli`/`api` keep the declared casing in their
  // command/route names (same asymmetry `reservesCrudName` documents below),
  // so an exact-match `exclude` stays correct for them.
  const excludedLower =
    kind === 'mcp'
      ? new Set([...excluded].map((entry) => entry.toLowerCase()))
      : undefined;
  // Tool ids already claimed for this object's `mcp` surface, so two
  // distinctly-cased method names (e.g. `Refresh`/`refresh`) that fold onto
  // the same MCP tool id are reported once, not twice -- mirroring
  // `MCPGenerator`'s per-object dedup (first declared wins, #2638). `cli`/
  // `api` need no such set: their command/route names keep declared casing,
  // so two cased method names never collide there.
  const emittedLower = kind === 'mcp' ? new Set<string>() : undefined;
  const names: string[] = [];
  for (const [name, method] of methods) {
    if (reservesCrudName(kind, name)) continue;
    // A framework lifecycle method (save/initialize/...) is never a custom
    // CLI or MCP action, even when a class declares its own override — it is
    // the mechanism behind generated CRUD, not a distinct operation, matching
    // core's retired CLIGenerator's (#2664) and MCPGenerator's own
    // isFrameworkLifecycleMethod() gate
    // (#2657, #2638). `api` is deliberately left alone — see
    // configuredOperations' doc comment above.
    if ((kind === 'cli' || kind === 'mcp') && isFrameworkLifecycleMethod(name))
      continue;
    if (!method.isPublic) continue;
    if (
      excludedLower ? excludedLower.has(name.toLowerCase()) : excluded.has(name)
    )
      continue;
    if (include !== undefined && !include.includes(name)) continue;
    if (emittedLower) {
      const lower = name.toLowerCase();
      if (emittedLower.has(lower)) continue;
      emittedLower.add(lower);
    }
    names.push(name);
  }
  return names;
}

/**
 * Whether `kind` reserves `name` for its generated CRUD operation, so the
 * method behind it is not reported as a distinct surface.
 *
 * MCP folds case: its tool ids are lowercased whole
 * (`` `${object}_${method}`.toLowerCase() ``), so a method named `List` lands on
 * the `${object}_list` identifier the CRUD tool already owns and
 * `MCPGenerator` emits no separate tool for it (#2646). REST and the CLI keep
 * the declared casing in their route/command names, so only an exact match is
 * reserved there.
 *
 * Reads the emitters' own predicates rather than re-testing the verb list, and
 * `STANDARD_OPERATIONS` derives from `CRUD_OPERATIONS`, so a change to the
 * shared list reaches both halves of this projection together.
 */
function reservesCrudName(kind: 'api' | 'cli' | 'mcp', name: string): boolean {
  return kind === 'mcp' ? isCrudToolAction(name) : isCrudOperation(name);
}

function includeExcludeConfig(config: unknown): {
  include?: string[];
  exclude?: string[];
} {
  if (typeof config !== 'object' || config === null || Array.isArray(config)) {
    return {};
  }
  // A non-array `include`/`exclude` is treated as unset rather than
  // throwing later on `.includes()` — mirrors the same defensive stance
  // `shouldIncludeInApi` in `vite-plugin/sveltekit-generator.ts` takes for
  // a scanned decorator config that failed to resolve to an array.
  const record = config as { include?: unknown; exclude?: unknown };
  return {
    include: Array.isArray(record.include) ? record.include : undefined,
    exclude: Array.isArray(record.exclude) ? record.exclude : undefined,
  };
}

function aiSurfaces(object: SmartObjectDefinition): DomainKnowledgeSurface[] {
  return (object.tools ?? []).map((tool) => ({
    kind: 'ai',
    name: tool.function.name,
    operation: tool.function.name,
    description: tool.function.description,
    objectName: object.qualifiedName ?? object.className,
  }));
}

/** Route facts for one custom action, as `generateRoutesForObject` emits it. */
interface ApiCustomRoute {
  scope: 'item' | 'collection';
  segments: string[];
  method: string;
}

/**
 * Resolve a custom (non-CRUD) action's REST route the way the generator does,
 * or `undefined` when no route is emitted for it at all.
 *
 * A custom action's path is NOT `/collection/action`: `generateRoutesForObject`
 * nests an item-scoped action under `[id]`, and an instance method defaults to
 * item scope. Reporting the collection-shaped path for every public instance
 * method would advertise endpoints that do not exist — the exact failure this
 * projection exists to avoid. Scope comes from the shared
 * `resolveCustomActionMetadata`, the same resolver the REST, CLI, MCP, and
 * WebMCP paths use, so a `routes` override cannot drift between them.
 *
 * `kebabRoutes` is a Vite-plugin option rather than manifest data, so an
 * explicit `routes[action].path` is honored but the generator's optional
 * kebab-casing of a derived segment is not visible here.
 */
function apiCustomRoute(
  object: SmartObjectDefinition,
  operation: string,
  collectionClass: boolean,
): ApiCustomRoute | undefined {
  const method = object.methods[operation];
  const apiConfig = object.decoratorConfig?.api;
  const defaultScope: 'item' | 'collection' =
    collectionClass || method?.isStatic ? 'collection' : 'item';
  const scope = resolveActionScope(operation, method, apiConfig, defaultScope);

  // Mirrors the generator's own skips: a collection class emits only
  // collection-scoped routes, and a model class warns and skips a
  // collection-scoped non-static method (no receiver to bind).
  if (collectionClass) {
    if (scope !== 'collection') return undefined;
  } else if (scope === 'collection' && !method?.isStatic) {
    return undefined;
  }

  // `@method({ path, httpMethod })` wins field by field over the legacy
  // `api.routes[operation]` entry, exactly as `resolveApiActionRouteConfig`
  // resolves it for the emitter — otherwise the artifact would report the
  // pre-migration URL for a class that has moved to the decorator (#2686).
  const effective = resolveEffectiveActionMetadata({
    actionName: operation,
    ...(method ? { method } : {}),
    apiConfig,
  });
  const overridden =
    typeof effective.path === 'string'
      ? effective.path
          .split('/')
          .map((segment) => segment.trim())
          .filter(Boolean)
      : [];
  return {
    scope,
    segments: overridden.length > 0 ? overridden : [operation],
    method: normalizeApiMethod(effective.httpMethod),
  };
}

/**
 * The shared resolver validates as it resolves — a `routes` entry declaring
 * `effect: 'read'` on a PUT/PATCH/DELETE route throws by design. This
 * projection reads untrusted scanned config and must not fail the whole
 * knowledge build for one malformed action (same defensive stance as
 * {@link includeExcludeConfig}), so fall back to the receiver the method
 * itself dictates — which a route-only override cannot change anyway.
 */
function resolveActionScope(
  operation: string,
  method: SmartObjectDefinition['methods'][string] | undefined,
  apiConfig: unknown,
  defaultScope: 'item' | 'collection',
): 'item' | 'collection' {
  try {
    return resolveCustomActionMetadata({
      actionName: operation,
      method,
      apiConfig,
      defaultScope,
    }).scope;
  } catch {
    return defaultScope;
  }
}

/** Mirrors `normalizeApiHttpMethod` in `vite-plugin/sveltekit-generator.ts`. */
function normalizeApiMethod(method: unknown): string {
  const normalized =
    typeof method === 'string' ? method.toUpperCase() : undefined;
  switch (normalized) {
    case 'GET':
    case 'POST':
    case 'PUT':
    case 'PATCH':
    case 'DELETE':
      return normalized;
    default:
      return 'POST';
  }
}

/**
 * The collection segment of a generated REST route.
 *
 * `generateRoutesForObject` builds its route directory from
 * `objectDef.collection` verbatim, and the runtime dispatcher in
 * `generators/rest.ts` matches the URL segment against `info.collection`
 * verbatim, so this reports that and nothing else (#2630).
 *
 * In particular it does NOT read `api.path`, which configures a different
 * surface: `@happyvertical/smrt-agents`' own agent-facing route map derives
 * `api.path ?? tableName.replace(/_/g, '-')`. Honoring it here produced a
 * hybrid — `api.path` over `collection` — that matched neither transport and
 * named endpoints that 404 on both.
 */
function apiCollectionSegment(object: SmartObjectDefinition): string {
  return object.collection;
}

function apiPath(
  object: SmartObjectDefinition,
  operation: string,
  route?: ApiCustomRoute,
): string {
  const configuredPath = apiCollectionSegment(object);
  if (route) {
    const base =
      route.scope === 'collection'
        ? `/${configuredPath}`
        : `/${configuredPath}/[id]`;
    return `${base}/${route.segments.join('/')}`;
  }
  if (operation === 'list' || operation === 'create') {
    return `/${configuredPath}`;
  }
  if (STANDARD_OPERATIONS.includes(operation)) {
    return `/${configuredPath}/[id]`;
  }
  return `/${configuredPath}/${operation}`;
}

function apiMethod(operation: string, route?: ApiCustomRoute): string {
  if (route) return route.method;
  switch (operation) {
    case 'list':
    case 'get':
      return 'GET';
    case 'create':
      return 'POST';
    case 'update':
      return 'PATCH';
    case 'delete':
      return 'DELETE';
    default:
      return 'POST';
  }
}

function relationshipFeatures(
  object: SmartObjectDefinition,
  fields: DomainKnowledgeField[],
): string[] {
  const features = new Set<string>();
  for (const field of fields) {
    if (field.type === 'foreignKey') features.add('foreignKey');
    if (field.type === 'crossPackageRef') features.add('crossPackageRef');
    if (field.type === 'oneToMany') features.add('oneToMany');
    if (field.type === 'manyToMany') features.add('manyToMany');
  }
  if (object.extends === 'SmrtJunction') features.add('SmrtJunction');
  if (object.extends === 'SmrtHierarchical') features.add('SmrtHierarchical');
  if (
    object.extends === 'SmrtPolymorphicAssociation' ||
    fields.some((field) => field.name === 'metaType') ||
    fields.some((field) => field.name === 'metaId')
  ) {
    features.add('SmrtPolymorphicAssociation');
  }
  if (
    Object.keys(object.schema?.columns ?? {}).some(
      (name) => object.schema?.columns[name]?.type === 'UUID',
    )
  ) {
    features.add('uuidColumns');
  }
  return [...features].sort();
}

function summarizeRelationships(
  objects: DomainKnowledgeObject[],
  manifestObjects: SmartObjectDefinition[],
) {
  const fields = objects.flatMap((object) => object.fields);
  return {
    foreignKeyFields: fields.filter((field) => field.type === 'foreignKey')
      .length,
    crossPackageRefFields: fields.filter(
      (field) => field.type === 'crossPackageRef',
    ).length,
    junctionCollections: objects.filter((object) =>
      object.relationshipFeatures.includes('SmrtJunction'),
    ).length,
    hierarchicalObjects: objects.filter((object) =>
      object.relationshipFeatures.includes('SmrtHierarchical'),
    ).length,
    polymorphicAssociations: objects.filter((object) =>
      object.relationshipFeatures.includes('SmrtPolymorphicAssociation'),
    ).length,
    uuidColumns: manifestObjects.reduce(
      (count, object) =>
        count +
        Object.values(object.schema?.columns ?? {}).filter(
          (column) => column.type === 'UUID',
        ).length,
      0,
    ),
  };
}

function columnType(
  object: SmartObjectDefinition,
  fieldName: string,
): string | undefined {
  const columnName = camelToSnake(fieldName);
  return object.schema?.columns[columnName]?.type;
}

function readPrompts(
  rootDir: string,
): Array<{ filePath: string; key?: string }> {
  const srcDir = join(rootDir, 'src');
  if (!existsSync(srcDir)) return [];
  const prompts: Array<{ filePath: string; key?: string }> = [];
  for (const filePath of walkFiles(srcDir)) {
    if (!filePath.endsWith('.ts')) continue;
    const content = readFileSync(filePath, 'utf8');
    if (!content.includes('definePrompt')) continue;
    const keyMatch = content.match(/definePrompt\s*\(\s*['"`]([^'"`]+)['"`]/);
    prompts.push({
      filePath: relative(rootDir, filePath),
      key: keyMatch?.[1],
    });
  }
  return prompts;
}

function walkFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (
      entry.name === 'node_modules' ||
      entry.name === 'dist' ||
      entry.name === '.svelte-kit'
    ) {
      continue;
    }
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkFiles(fullPath));
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }
  return files;
}

function sourceHashes(sources: Record<string, HashSource | undefined>) {
  const hashes: Record<string, string> = {};
  for (const [name, source] of Object.entries(sources)) {
    if (!source) continue;
    const content =
      'content' in source ? source.content : readFileSync(source.path, 'utf8');
    hashes[name] = createHash('sha256').update(content).digest('hex');
  }
  return hashes;
}

type HashSource = { content: string } | { path: string };

function fileHashSource(path: string | undefined): HashSource | undefined {
  return path ? { path } : undefined;
}

function existingPath(rootDir: string, path: string): string | undefined {
  const fullPath = join(rootDir, path);
  return existsSync(fullPath) ? fullPath : undefined;
}

function readPackageJson(rootDir: string): PackageJsonLike | null {
  const path = join(rootDir, 'package.json');
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8'));
}

function record(value: unknown): Record<string, string> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, string>)
    : {};
}

function exportKeys(exportsField: unknown): string[] {
  if (typeof exportsField === 'string') return ['.'];
  if (
    typeof exportsField !== 'object' ||
    exportsField === null ||
    Array.isArray(exportsField)
  ) {
    return [];
  }
  return Object.keys(exportsField).sort();
}

function camelToSnake(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[-\s]+/g, '_')
    .toLowerCase();
}

function normalizeManifestForHash(manifest: SmartObjectManifest): unknown {
  const normalized = JSON.parse(JSON.stringify(manifest)) as Record<
    string,
    unknown
  >;
  delete normalized.timestamp;
  return normalized;
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value), null, 2);
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, sortJson(entry)]),
    );
  }
  return value;
}
