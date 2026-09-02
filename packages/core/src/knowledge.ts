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
} from '@happyvertical/smrt-types';
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

const STANDARD_OPERATIONS = ['list', 'get', 'create', 'update', 'delete'];

/**
 * Framework abstract base classes (`SmrtObject`, `SmrtCollection`, ...) carry
 * no `@smrt()` decorator of their own, so they never register with
 * `ObjectRegistry` and never get MCP tools, CLI commands, or REST routes
 * under their own name — only their `@smrt()`-decorated subclasses do. The
 * scanner still emits a manifest entry for them (so cross-package `extends`
 * chains can resolve), and — because a foundation package like
 * `@happyvertical/smrt-core` declares them as real local classes rather than
 * an external reference — that entry has `decoratorConfig: {}`,
 * indistinguishable in shape from a genuine bare `@smrt()`. Without this
 * exclusion, #2619's "omitted config is full CRUD" rule reports a synthetic
 * `smrtobjects.list`/`smrtcollections.create`/... surface for every one of
 * them (317 phantom surfaces in `@happyvertical/smrt-core`'s own artifact).
 *
 * Mirrors `FRAMEWORK_BASE_CLASSES` in
 * `packages/scanner/src/inheritance-resolver.ts` — kept as a separate
 * hardcoded list rather than imported (that package is a lower-level AST
 * layer knowledge.ts has no reason to otherwise depend on), matching that
 * set's own documented precedent of "extend the list" over generalizing a
 * flag through the manifest shape.
 */
const FRAMEWORK_BASE_CLASS_NAMES = new Set([
  'SmrtObject',
  'SmrtClass',
  'SmrtCollection',
  'SmrtJunction',
  'SmrtHierarchical',
  'SmrtPolymorphicAssociation',
  'SmrtReport',
  'SmrtReportCollection',
]);

function isFrameworkBaseClass(object: SmartObjectDefinition): boolean {
  return (
    object.packageName === '@happyvertical/smrt-core' &&
    FRAMEWORK_BASE_CLASS_NAMES.has(object.className)
  );
}

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

function configuredSurfaces(
  kind: 'api' | 'cli' | 'mcp',
  object: SmartObjectDefinition,
  manifest: SmartObjectManifest,
): DomainKnowledgeSurface[] {
  const config = object.decoratorConfig?.[kind];
  const operations = configuredOperations(kind, object, config, manifest);
  return operations.map((operation) => ({
    kind,
    name:
      kind === 'api'
        ? `${object.collection}.${operation}`
        : `${object.className.toLowerCase()}_${operation}`,
    operation,
    objectName: object.qualifiedName ?? object.className,
    path: kind === 'api' ? apiPath(object, operation) : undefined,
    method: kind === 'api' ? apiMethod(operation) : undefined,
  }));
}

/**
 * A hand-written `SmrtCollection` subclass (`class WidgetCollection extends
 * SmrtCollection<Widget>`) is discovered structurally by the scanner and
 * lands in the manifest even without its own `@smrt()` decorator, so it never
 * registers with `ObjectRegistry`. `MCPGenerator`/`CLIGenerator` iterate
 * `ObjectRegistry`, not the manifest, so such a class never gets its own
 * MCP tools or CLI commands — only its collection-scoped custom actions get
 * REST routes. Reporting full CRUD for it here would over-report a surface
 * that does not exist, trading the #2619 under-report for a new false
 * positive.
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
  const objects = Object.values(manifest.objects);
  if (name.includes(':')) {
    const exact = objects.find((candidate) => candidate.qualifiedName === name);
    if (exact) return exact;
  }
  if (owner.packageName) {
    const packageLocal = objects.find(
      (candidate) =>
        candidate.packageName === owner.packageName &&
        candidate.className === name,
    );
    if (packageLocal) return packageLocal;
  }
  return objects.find((candidate) => candidate.className === name);
}

/**
 * Operations exposed for one object's `api`/`cli`/`mcp` surface, derived from
 * the same defaults `APIGenerator`/`CLIGenerator`/`MCPGenerator` apply rather
 * than from the presence of a config key (#2619): an omitted config is full
 * CRUD, not a closed surface, and every generator gates custom (non-CRUD,
 * public) methods with the same rule — an `include` list, when present, is
 * the COMPLETE allowlist for custom methods too; without one, every public
 * method not explicitly excluded is exposed by default. Only `config ===
 * false` closes the surface entirely.
 */
function configuredOperations(
  kind: 'api' | 'cli' | 'mcp',
  object: SmartObjectDefinition,
  config: unknown,
  manifest: SmartObjectManifest,
): string[] {
  if (config === false) return [];
  if (isFrameworkBaseClass(object)) return [];
  const collectionClass = isSurfaceCollectionClass(manifest, object);
  // Undecorated collection classes never register with ObjectRegistry, so
  // MCP/CLI expose nothing under their own name; only REST custom actions
  // reach them.
  if (collectionClass && kind !== 'api') return [];
  const crud = collectionClass ? [] : resolveCrudOperations(config);
  const custom = resolveCustomMethodNames(
    Object.entries(object.methods),
    config,
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
): string[] {
  const { include, exclude } = includeExcludeConfig(config);
  const excluded = new Set(exclude ?? []);
  const names: string[] = [];
  for (const [name, method] of methods) {
    if (STANDARD_OPERATIONS.includes(name)) continue;
    if (!method.isPublic) continue;
    if (excluded.has(name)) continue;
    if (include !== undefined && !include.includes(name)) continue;
    names.push(name);
  }
  return names;
}

function includeExcludeConfig(config: unknown): {
  include?: string[];
  exclude?: string[];
} {
  if (typeof config !== 'object' || config === null || Array.isArray(config)) {
    return {};
  }
  return config as { include?: string[]; exclude?: string[] };
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

function apiPath(object: SmartObjectDefinition, operation: string): string {
  const collection = object.decoratorConfig?.api;
  const configuredPath =
    typeof collection === 'object' && typeof collection.path === 'string'
      ? collection.path
      : object.collection.replaceAll('_', '-');
  if (operation === 'list' || operation === 'create') {
    return `/${configuredPath}`;
  }
  if (STANDARD_OPERATIONS.includes(operation)) {
    return `/${configuredPath}/[id]`;
  }
  return `/${configuredPath}/${operation}`;
}

function apiMethod(operation: string): string {
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
