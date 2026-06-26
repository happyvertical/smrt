import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type {
  DomainKnowledgeConfig,
  DomainKnowledgeManifest,
  DomainKnowledgeObject,
  DomainKnowledgeSurface,
} from '@happyvertical/smrt-types';
import type {
  SmartObjectDefinition,
  SmartObjectManifest,
} from './scanner/types.js';

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

export function buildDomainKnowledgeManifest(
  options: BuildDomainKnowledgeOptions,
): DomainKnowledgeManifest {
  const rootDir = options.rootDir;
  const packageJson = options.packageJson ?? readPackageJson(rootDir) ?? {};
  const packageName = options.manifest.packageName ?? packageJson.name;
  const packageVersion = options.manifest.packageVersion ?? packageJson.version;
  const agentDocPath = existingPath(rootDir, 'AGENTS.md');
  const agentDoc =
    options.config?.includeDocs === false || !agentDocPath
      ? undefined
      : readFileSync(agentDocPath, 'utf8');
  const allDependencies = {
    ...record(packageJson.dependencies),
    ...record(packageJson.devDependencies),
    ...record(packageJson.peerDependencies),
  };
  const manifestObjects = Object.values(options.manifest.objects).filter(
    (object) => object.decoratorConfig?.knowledge !== false,
  );
  const objects = manifestObjects.map((object) => buildKnowledgeObject(object));
  const surfaces = objects.flatMap((object) => object.surfaces);
  const manifestJson = stableJson(normalizeManifestForHash(options.manifest));

  return {
    schemaVersion: 1,
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
  };
}

function buildKnowledgeObject(
  object: SmartObjectDefinition,
): DomainKnowledgeObject {
  const knowledge =
    typeof object.decoratorConfig?.knowledge === 'object'
      ? object.decoratorConfig.knowledge
      : {};
  const fields = Object.entries(object.fields).map(([name, field]) => ({
    name,
    type: field.type,
    required: field.required,
    related: field.related,
    columnType: columnType(object, name),
  }));
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
    surfaces: objectSurfaces(object),
    relationshipFeatures: relationshipFeatures(object),
    tags: knowledge.tags ?? [],
    summary: knowledge.summary,
    risks: knowledge.risks ?? [],
  };
}

function objectSurfaces(
  object: SmartObjectDefinition,
): DomainKnowledgeSurface[] {
  return [
    ...configuredSurfaces('api', object),
    ...configuredSurfaces('cli', object),
    ...configuredSurfaces('mcp', object),
    ...aiSurfaces(object),
  ];
}

function configuredSurfaces(
  kind: 'api' | 'cli' | 'mcp',
  object: SmartObjectDefinition,
): DomainKnowledgeSurface[] {
  const config = object.decoratorConfig?.[kind];
  if (!config) return [];
  const operations = configuredOperations(config);
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

function configuredOperations(config: unknown): string[] {
  if (config === true) return [...STANDARD_OPERATIONS];
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    return [];
  }
  const recordConfig = config as { include?: string[]; exclude?: string[] };
  const base = Array.isArray(recordConfig.include)
    ? recordConfig.include
    : STANDARD_OPERATIONS;
  const excluded = new Set(recordConfig.exclude ?? []);
  return [...new Set(base.filter((operation) => !excluded.has(operation)))];
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

function relationshipFeatures(object: SmartObjectDefinition): string[] {
  const features = new Set<string>();
  for (const field of Object.values(object.fields)) {
    if (field.type === 'foreignKey') features.add('foreignKey');
    if (field.type === 'crossPackageRef') features.add('crossPackageRef');
    if (field.type === 'oneToMany') features.add('oneToMany');
    if (field.type === 'manyToMany') features.add('manyToMany');
  }
  if (object.extends === 'SmrtJunction') features.add('SmrtJunction');
  if (object.extends === 'SmrtHierarchical') features.add('SmrtHierarchical');
  if (
    object.extends === 'SmrtPolymorphicAssociation' ||
    object.fields.metaType ||
    object.fields.metaId
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
