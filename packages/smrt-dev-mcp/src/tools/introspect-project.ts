/**
 * Project Introspection Tool
 * Returns a manifest-equivalent inventory of SMRT objects in a project.
 */

import type { Dirent } from 'node:fs';
import { access, readdir, readFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import {
  ManifestGenerator,
  type SmartObjectManifest,
} from '@happyvertical/smrt-core/scanner';
import type { ScanError } from '@happyvertical/smrt-scanner';
import { ManifestAdapter, OxcScanner } from '@happyvertical/smrt-scanner';

interface IntrospectProjectArgs {
  directory?: string;
  manifestPath?: string;
  includeFields?: boolean;
  includeRelationships?: boolean;
  includeMethods?: boolean;
}

type DiagnosticSeverity = 'error' | 'warning' | 'info';

interface Diagnostic {
  severity: DiagnosticSeverity;
  message: string;
  filePath?: string;
  line?: number;
  column?: number;
}

interface ManifestLike {
  version?: string;
  packageName?: string;
  packageVersion?: string;
  objects?: Record<string, ManifestObject>;
}

interface ManifestObject {
  name?: string;
  className: string;
  qualifiedName?: string;
  collection?: string;
  filePath: string;
  packageName?: string;
  packageVersion?: string;
  importPath?: string;
  modulePath?: string;
  exportName?: string;
  collectionExportName?: string;
  fields?: Record<string, ManifestField>;
  methods?: Record<string, ManifestMethod>;
  decoratorConfig?: Record<string, unknown>;
  extends?: string;
  extendsTypeArg?: string;
  schema?: ManifestSchema;
  staticProperties?: Record<string, unknown>;
  validationRules?: Record<string, unknown>;
}

interface ManifestField {
  type: string;
  required?: boolean;
  default?: unknown;
  related?: string;
  description?: string;
  _meta?: Record<string, unknown>;
  transient?: boolean;
}

interface ManifestMethod {
  name?: string;
  async?: boolean;
  parameters?: Array<{
    name: string;
    type?: string;
    optional?: boolean;
    default?: unknown;
  }>;
  returnType?: string;
  description?: string;
  isStatic?: boolean;
  isPublic?: boolean;
}

interface ManifestSchema {
  tableName?: string;
  ddl?: string;
  columns?: Record<string, unknown>;
  indexes?: Array<{
    name?: string;
    columns?: string[];
    unique?: boolean;
    where?: string;
    jsonPath?: unknown;
  }>;
  version?: string;
}

interface PackageMetadata {
  name?: string;
  version?: string;
  json?: Record<string, unknown>;
}

const DEFAULT_MANIFEST_PATHS = [
  '.smrt/manifest.json',
  'dist/manifest.json',
  'src/manifest/manifest.json',
];

const SCAN_EXCLUDE = [
  '**/node_modules/**',
  '**/dist/**',
  '**/build/**',
  '**/.git/**',
  '**/.smrt/**',
  '**/*.d.ts',
  '**/*.test.ts',
  '**/*.spec.ts',
  '**/__tests__/**',
];

const RELATIONSHIP_TYPES = new Set([
  'foreignKey',
  'crossPackageRef',
  'oneToMany',
  'manyToMany',
]);

export async function introspectProject(
  args: IntrospectProjectArgs,
): Promise<string> {
  const {
    directory = process.cwd(),
    includeFields = true,
    includeRelationships = true,
    includeMethods = true,
  } = args;
  const projectPath = resolve(directory);

  const exists = await pathExists(projectPath);
  if (!exists) {
    return JSON.stringify(
      {
        projectPath,
        manifestSource: 'none',
        objectCount: 0,
        objects: [],
        diagnostics: [
          {
            severity: 'warning',
            message: `Project directory does not exist: ${projectPath}`,
          },
        ],
      },
      null,
      2,
    );
  }

  const packageMetadata = await readPackageMetadata(projectPath);
  const tenantScopes = await scanTenantScopes(projectPath);
  const manifestResult =
    (await loadManifestArtifact(projectPath, args.manifestPath)) ??
    (await scanSourceManifest(projectPath, packageMetadata));

  const objects = Object.entries(manifestResult.manifest.objects ?? {})
    .map(([manifestKey, object]) =>
      formatObject({
        manifestKey,
        object,
        projectPath,
        includeFields,
        includeRelationships,
        includeMethods,
        tenantScope: tenantScopes.get(object.className),
      }),
    )
    .sort((left, right) => left.className.localeCompare(right.className));

  const output = {
    projectPath,
    manifestSource: manifestResult.source,
    manifestPath:
      'path' in manifestResult
        ? relative(projectPath, manifestResult.path)
        : undefined,
    packageName:
      manifestResult.manifest.packageName ?? packageMetadata.name ?? undefined,
    packageVersion:
      manifestResult.manifest.packageVersion ??
      packageMetadata.version ??
      undefined,
    objectCount: objects.length,
    scannedFileCount: manifestResult.scannedFileCount,
    parseTimeMs: manifestResult.parseTimeMs,
    objects,
    diagnostics: manifestResult.diagnostics,
  };

  return JSON.stringify(output, null, 2);
}

async function loadManifestArtifact(
  projectPath: string,
  manifestPath: string | undefined,
): Promise<
  | {
      source: 'manifest';
      path: string;
      manifest: ManifestLike;
      diagnostics: Diagnostic[];
      scannedFileCount?: number;
      parseTimeMs?: number;
    }
  | undefined
> {
  const candidates = manifestPath
    ? [resolve(projectPath, manifestPath)]
    : DEFAULT_MANIFEST_PATHS.map((candidate) => join(projectPath, candidate));

  const diagnostics: Diagnostic[] = [];
  for (const candidate of candidates) {
    if (!(await pathExists(candidate))) {
      continue;
    }

    try {
      const parsed = JSON.parse(await readFile(candidate, 'utf-8')) as unknown;
      if (isManifestLike(parsed)) {
        return {
          source: 'manifest',
          path: candidate,
          manifest: parsed,
          diagnostics,
        };
      }

      diagnostics.push({
        severity: 'warning',
        filePath: candidate,
        message: 'Manifest artifact is present but does not contain objects.',
      });
    } catch (error) {
      diagnostics.push({
        severity: 'error',
        filePath: candidate,
        message: `Unable to parse manifest artifact: ${messageFromError(error)}`,
      });
    }
  }

  return manifestPath
    ? {
        source: 'manifest',
        path: resolve(projectPath, manifestPath),
        manifest: { objects: {} },
        diagnostics: [
          ...diagnostics,
          {
            severity: 'warning',
            filePath: resolve(projectPath, manifestPath),
            message: 'Requested manifest artifact was not found.',
          },
        ],
      }
    : undefined;
}

async function scanSourceManifest(
  projectPath: string,
  packageMetadata: PackageMetadata,
): Promise<{
  source: 'scanner';
  manifest: ManifestLike;
  diagnostics: Diagnostic[];
  scannedFileCount: number;
  parseTimeMs: number;
}> {
  const scanner = new OxcScanner({
    cwd: projectPath,
    include: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx'],
    exclude: SCAN_EXCLUDE,
  });
  const { results, resolved } = await scanner.scanAndResolve();
  const adapter = new ManifestAdapter();
  const manifest = adapter.toManifest(
    resolved.filter((classDef) => classDef.hasSmartDecorator),
    {
      packageName: packageMetadata.name,
      packageVersion: packageMetadata.version,
      typeAliases: results.typeAliases,
    },
  ) as ManifestLike;
  finalizeScannerManifest(manifest, packageMetadata);

  return {
    source: 'scanner',
    manifest,
    diagnostics: results.errors.map(scanErrorToDiagnostic),
    scannedFileCount: results.fileCount,
    parseTimeMs: Math.round(results.totalParseTimeMs),
  };
}

function finalizeScannerManifest(
  manifest: ManifestLike,
  packageMetadata: PackageMetadata,
): void {
  const manifestGen = new ManifestGenerator();
  const fullManifest = manifest as unknown as SmartObjectManifest;
  withSuppressedConsoleLog(() => {
    manifestGen.injectTenantScopedFields(fullManifest);
    manifestGen.mergeInheritedFields(fullManifest);
    manifestGen.generateValidationRules(fullManifest);
    manifestGen.generateSchemas(fullManifest);
    manifestGen.assertTenantScopedSchemaContract(fullManifest);
    manifestGen.generateAgentManifests(
      fullManifest,
      packageMetadata.name,
      packageMetadata.json,
    );
  });
}

function withSuppressedConsoleLog<T>(callback: () => T): T {
  const originalLog = console.log;
  console.log = () => undefined;
  try {
    return callback();
  } finally {
    console.log = originalLog;
  }
}

function formatObject({
  manifestKey,
  object,
  projectPath,
  includeFields,
  includeRelationships,
  includeMethods,
  tenantScope,
}: {
  manifestKey: string;
  object: ManifestObject;
  projectPath: string;
  includeFields: boolean;
  includeRelationships: boolean;
  includeMethods: boolean;
  tenantScope?: Record<string, unknown>;
}) {
  const fieldDetails = Object.entries(object.fields ?? {}).map(
    ([name, field]) => ({
      name,
      type: field.type,
      ...(field.required !== undefined ? { required: field.required } : {}),
      ...(field.default !== undefined ? { default: field.default } : {}),
      ...(field.related ? { related: field.related } : {}),
      ...(field.description ? { description: field.description } : {}),
      ...(field._meta ? { meta: field._meta } : {}),
      ...(field.transient !== undefined ? { transient: field.transient } : {}),
    }),
  );
  const relationshipDetails = fieldDetails
    .filter((field) => RELATIONSHIP_TYPES.has(field.type))
    .map((field) => ({
      field: field.name,
      relatedClass: field.related ?? '',
      type: field.type,
      ...(field.meta ? { meta: field.meta } : {}),
    }));
  const methodDetails = Object.entries(object.methods ?? {}).map(
    ([name, method]) => ({
      name: method.name ?? name,
      isAsync: method.async === true,
      isStatic: method.isStatic === true,
      isPublic: method.isPublic !== false,
      parameters: method.parameters ?? [],
      returnType: method.returnType ?? 'unknown',
      ...(method.description ? { description: method.description } : {}),
    }),
  );

  const decoratorConfig = object.decoratorConfig ?? {};
  const effectiveTenantScope =
    tenantScope ?? normalizeTenantScopedConfig(decoratorConfig.tenantScoped);
  const schema = object.schema;

  return compactObject({
    manifestKey,
    name: object.name,
    className: object.className,
    qualifiedName: object.qualifiedName,
    filePath: sanitizePath(projectPath, object.filePath),
    packageName: object.packageName,
    packageVersion: object.packageVersion,
    importPath: object.importPath,
    modulePath: object.modulePath,
    exportName: object.exportName,
    collectionExportName: object.collectionExportName,
    collection: object.collection,
    extends: object.extends,
    extendsTypeArg: object.extendsTypeArg,
    tableName:
      schema?.tableName ??
      stringFromConfig(decoratorConfig.tableName) ??
      object.collection,
    tableStrategy: stringFromConfig(decoratorConfig.tableStrategy) ?? 'cti',
    conflictColumns: arrayFromConfig(decoratorConfig.conflictColumns),
    tenantScope: effectiveTenantScope,
    decoratorConfig,
    schema: schema
      ? {
          tableName: schema.tableName,
          columns: schema.columns,
          indexes: schema.indexes ?? [],
          version: schema.version,
        }
      : undefined,
    indexes: schema?.indexes ?? [],
    staticProperties: object.staticProperties,
    validationRules: object.validationRules,
    ...(includeFields && {
      fields: fieldDetails
        .map((field) => `${field.name}: ${field.type}`)
        .join(', '),
      fieldDetails,
    }),
    ...(includeRelationships &&
      relationshipDetails.length > 0 && {
        relationships: relationshipDetails
          .map(
            (relationship) =>
              `${relationship.field} -> ${relationship.relatedClass} (${relationship.type})`,
          )
          .join(', '),
        relationshipDetails,
      }),
    ...(includeMethods &&
      methodDetails.length > 0 && {
        methods: methodDetails
          .map((method) => `${method.isAsync ? 'async ' : ''}${method.name}()`)
          .join(', '),
        methodDetails,
      }),
  });
}

async function scanTenantScopes(
  projectPath: string,
): Promise<Map<string, Record<string, unknown>>> {
  const files = await listSourceFiles(projectPath);
  const scopes = new Map<string, Record<string, unknown>>();

  await Promise.all(
    files.map(async (filePath) => {
      const content = await readFile(filePath, 'utf-8');
      const classMatches = content.matchAll(/class\s+([A-Za-z_]\w*)\b/g);
      for (const match of classMatches) {
        const className = match[1];
        if (!className || match.index === undefined) continue;
        const prefix = content.slice(
          Math.max(0, match.index - 800),
          match.index,
        );
        const tenantMatches = Array.from(
          prefix.matchAll(/@TenantScoped\s*\(([\s\S]*?)\)/g),
        );
        const tenantMatch = tenantMatches.at(-1);
        if (!tenantMatch) continue;
        scopes.set(className, {
          source: 'TenantScoped',
          ...parseTenantScopedOptions(tenantMatch[1]),
        });
      }
    }),
  );

  return scopes;
}

async function listSourceFiles(projectPath: string): Promise<string[]> {
  const files: string[] = [];

  async function visit(dir: string): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (
          [
            'node_modules',
            'dist',
            'build',
            '.git',
            '.smrt',
            '__tests__',
          ].includes(entry.name) ||
          entry.name.startsWith('.')
        ) {
          continue;
        }
        await visit(fullPath);
        continue;
      }

      if (
        entry.isFile() &&
        /\.(tsx?|jsx?)$/.test(entry.name) &&
        !entry.name.endsWith('.d.ts') &&
        !entry.name.endsWith('.test.ts') &&
        !entry.name.endsWith('.spec.ts')
      ) {
        files.push(fullPath);
      }
    }
  }

  await visit(projectPath);
  return files;
}

function parseTenantScopedOptions(raw: string): Record<string, unknown> {
  const mode = raw.match(/mode\s*:\s*['"`](required|optional)['"`]/)?.[1];
  const field = raw.match(/field\s*:\s*['"`]([A-Za-z_]\w*)['"`]/)?.[1];
  const allowSuperAdminBypass = raw.match(
    /allowSuperAdminBypass\s*:\s*(true|false)/,
  )?.[1];
  const autoFilter = raw.match(/autoFilter\s*:\s*(true|false)/)?.[1];
  const autoPopulate = raw.match(/autoPopulate\s*:\s*(true|false)/)?.[1];

  return compactObject({
    mode: mode ?? 'required',
    field: field ?? 'tenantId',
    autoFilter: autoFilter === undefined ? undefined : autoFilter === 'true',
    autoPopulate:
      autoPopulate === undefined ? undefined : autoPopulate === 'true',
    allowSuperAdminBypass:
      allowSuperAdminBypass === undefined
        ? undefined
        : allowSuperAdminBypass === 'true',
  });
}

function normalizeTenantScopedConfig(
  tenantScoped: unknown,
): Record<string, unknown> | undefined {
  if (!tenantScoped) return undefined;
  const options =
    typeof tenantScoped === 'object' && !Array.isArray(tenantScoped)
      ? (tenantScoped as Record<string, unknown>)
      : {};
  return {
    source: 'smrt',
    mode: options.mode ?? 'required',
    field: options.field ?? 'tenantId',
    autoFilter: options.autoFilter ?? true,
    autoPopulate: options.autoPopulate ?? true,
    allowSuperAdminBypass: options.allowSuperAdminBypass ?? false,
  };
}

async function readPackageMetadata(
  projectPath: string,
): Promise<PackageMetadata> {
  const packageJsonPath = join(projectPath, 'package.json');
  if (!(await pathExists(packageJsonPath))) return {};

  try {
    const json = JSON.parse(await readFile(packageJsonPath, 'utf-8')) as Record<
      string,
      unknown
    >;
    return {
      name: typeof json.name === 'string' ? json.name : undefined,
      version: typeof json.version === 'string' ? json.version : undefined,
      json,
    };
  } catch {
    return {};
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function isManifestLike(value: unknown): value is ManifestLike {
  return (
    !!value &&
    typeof value === 'object' &&
    !!(value as ManifestLike).objects &&
    typeof (value as ManifestLike).objects === 'object'
  );
}

function scanErrorToDiagnostic(error: ScanError): Diagnostic {
  return {
    severity: error.severity,
    message: error.message,
    filePath: error.filePath,
    line: error.line,
    column: error.column,
  };
}

function sanitizePath(projectPath: string, filePath: string): string {
  const absolute = isAbsolute(filePath)
    ? filePath
    : resolve(projectPath, filePath);
  const relativePath = relative(projectPath, absolute);
  if (!relativePath.startsWith('..')) {
    return relativePath || filePath;
  }
  return filePath;
}

function stringFromConfig(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function arrayFromConfig(value: unknown): string[] | undefined {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : undefined;
}

function compactObject<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as T;
}

function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
