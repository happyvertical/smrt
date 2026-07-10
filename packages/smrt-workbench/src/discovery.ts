import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import {
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path';
import { pathToFileURL } from 'node:url';
import fg from 'fast-glob';
import { coerceWorkbenchModules } from './runtime.js';
import type {
  DiscoveredWorkbenchTarget,
  SmrtWorkbenchModule,
  SmrtWorkbenchProject,
  SmrtWorkbenchScopeMode,
  SmrtWorkbenchVitePluginOptions,
  WorkbenchApiObjectFieldSummary,
  WorkbenchApiObjectSummary,
  WorkbenchApiParameterLocation,
  WorkbenchApiParameterSummary,
  WorkbenchApiSummary,
  WorkbenchCliCommandSummary,
  WorkbenchDocumentSummary,
  WorkbenchExampleSummary,
  WorkbenchKnowledgeSummary,
  WorkbenchMcpToolSummary,
  WorkbenchPackageSummary,
  WorkbenchRestEndpointSummary,
  WorkbenchScopeResolution,
} from './types.js';
import { commandIdForScript } from './utils.js';

const require = createRequire(import.meta.url);
const TS_SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts']);
const DOCUMENT_LIMIT = 20_000;
const EXAMPLE_LIMIT = 8_000;

interface PackageJsonLike {
  name?: string;
  version?: string;
  description?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  exports?: unknown;
}

interface WorkbenchPackageDir {
  packageDir: string;
  packageJson: PackageJsonLike;
  source: 'workspace' | 'package' | 'app';
}

export function findWorkspaceRoot(startDir = process.cwd()): string | null {
  let current = resolve(startDir);

  while (true) {
    if (existsSync(join(current, 'pnpm-workspace.yaml'))) {
      return current;
    }

    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

export function findSmrtWorkbenchWorkspaceRoot(
  startDir = process.cwd(),
): string | null {
  const workspaceRoot = findWorkspaceRoot(startDir);
  if (!workspaceRoot) {
    return null;
  }

  const hostPackageJsonPath = join(
    workspaceRoot,
    'packages',
    'smrt-workbench',
    'host',
    'package.json',
  );

  return existsSync(hostPackageJsonPath) ? workspaceRoot : null;
}

export function findProjectRoot(startDir = process.cwd()): string {
  let current = resolve(startDir);

  while (true) {
    if (existsSync(join(current, 'package.json'))) {
      return current;
    }

    const parent = dirname(current);
    if (parent === current) {
      return resolve(startDir);
    }
    current = parent;
  }
}

export function findPackageDir(
  startDir = process.cwd(),
  workspaceRoot?: string,
): string | null {
  let current = resolve(startDir);
  const boundary = workspaceRoot ? resolve(workspaceRoot) : null;

  while (true) {
    if (boundary && current === boundary) {
      return null;
    }

    const packageJsonPath = join(current, 'package.json');
    if (existsSync(packageJsonPath)) {
      return current;
    }

    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

export function detectWorkbenchMode(
  projectRoot = process.cwd(),
): 'workspace' | 'consumer' {
  return findSmrtWorkbenchWorkspaceRoot(projectRoot) ? 'workspace' : 'consumer';
}

function readJson<T = Record<string, unknown>>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf-8')) as T;
}

function readJsonIfExists<T = Record<string, unknown>>(path: string): T | null {
  return existsSync(path) ? readJson<T>(path) : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
}

function countItems(value: unknown): number {
  if (Array.isArray(value)) {
    return value.length;
  }
  if (isRecord(value)) {
    return Object.keys(value).length;
  }
  return 0;
}

function truncate(
  value: string,
  limit: number,
): {
  content: string;
  truncated: boolean;
} {
  if (value.length <= limit) {
    return { content: value, truncated: false };
  }

  return { content: value.slice(0, limit), truncated: true };
}

function readDocument(
  packageDir: string,
  fileName: string,
  kind: WorkbenchDocumentSummary['kind'],
): WorkbenchDocumentSummary | null {
  const path = join(packageDir, fileName);
  if (!existsSync(path)) {
    return null;
  }

  const { content, truncated } = truncate(
    readFileSync(path, 'utf-8'),
    DOCUMENT_LIMIT,
  );
  return {
    kind,
    title: fileName,
    path,
    content,
    truncated,
  };
}

function exportKeys(exportsField: unknown): string[] {
  if (!exportsField) {
    return [];
  }
  if (typeof exportsField === 'string') {
    return ['.'];
  }
  if (isRecord(exportsField)) {
    return Object.keys(exportsField).sort();
  }
  return [];
}

function dependencyNames(packageJson: PackageJsonLike): string[] {
  return Object.keys({
    ...packageJson.dependencies,
    ...packageJson.devDependencies,
    ...packageJson.peerDependencies,
  }).sort();
}

function smrtDependencyNames(packageJson: PackageJsonLike): string[] {
  return dependencyNames(packageJson).filter((name) =>
    name.startsWith('@happyvertical/smrt-'),
  );
}

function sdkDependencyNames(packageJson: PackageJsonLike): string[] {
  return dependencyNames(packageJson).filter(
    (name) =>
      name.startsWith('@happyvertical/') &&
      !name.startsWith('@happyvertical/smrt-'),
  );
}

function readKnowledgeSummary(packageDir: string): WorkbenchKnowledgeSummary {
  const knowledgeCandidates = [
    join(packageDir, '.smrt', 'smrt-knowledge.json'),
    join(packageDir, 'dist', 'smrt-knowledge.json'),
  ];
  const manifestCandidates = [
    join(packageDir, '.smrt', 'manifest.json'),
    join(packageDir, 'dist', 'manifest.json'),
    join(packageDir, 'src', 'manifest', 'manifest.json'),
  ];

  const knowledgePath = knowledgeCandidates.find((path) => existsSync(path));
  const manifestPath = manifestCandidates.find((path) => existsSync(path));
  const knowledge = knowledgePath
    ? readJsonIfExists<Record<string, unknown>>(knowledgePath)
    : null;
  const manifest = manifestPath
    ? readJsonIfExists<Record<string, unknown>>(manifestPath)
    : null;
  const knowledgeObjects = knowledge?.objects;
  const manifestObjects = manifest?.objects;
  const objects =
    countItems(knowledgeObjects) > 0 ? knowledgeObjects : manifestObjects;
  const objectNames = objectNamesFrom(objects);

  return {
    manifestPath,
    knowledgePath,
    objectCount: countItems(objects),
    relationshipCount:
      countItems(knowledge?.relationshipsV2) ||
      countItems(knowledge?.relationships),
    promptCount: countItems(knowledge?.prompts),
    mcpToolCount: countItems(knowledge?.mcpTools),
    surfaceCount: countItems(knowledge?.surfaces),
    tags: Array.isArray(knowledge?.tags)
      ? knowledge.tags.filter((tag): tag is string => typeof tag === 'string')
      : [],
    risks: Array.isArray(knowledge?.risks)
      ? knowledge.risks.filter(
          (risk): risk is string => typeof risk === 'string',
        )
      : [],
    objectNames,
  };
}

function objectNamesFrom(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (!isRecord(item)) {
          return null;
        }
        return stringValue(item.qualifiedName) || stringValue(item.name);
      })
      .filter((name): name is string => Boolean(name))
      .sort();
  }

  if (isRecord(value)) {
    return Object.keys(value).sort();
  }

  return [];
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function objectRecordsFrom(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    return value.filter(isRecord);
  }

  if (!isRecord(value)) {
    return [];
  }

  return Object.entries(value).map(([key, item]) => {
    if (isRecord(item)) {
      return {
        key,
        ...item,
      };
    }

    return {
      key,
      name: key,
    };
  });
}

function fieldSummariesFrom(value: unknown): WorkbenchApiObjectFieldSummary[] {
  if (Array.isArray(value)) {
    return value
      .filter(isRecord)
      .map((field) => ({
        name: stringValue(field.name) || 'unknown',
        type: stringValue(field.type) || undefined,
        required: booleanValue(field.required),
        related: stringValue(field.related) || undefined,
      }))
      .filter((field) => field.name !== 'unknown');
  }

  if (!isRecord(value)) {
    return [];
  }

  return Object.entries(value)
    .map(([name, field]) => {
      const fieldRecord = isRecord(field) ? field : {};
      return {
        name,
        type: stringValue(fieldRecord.type) || undefined,
        required: booleanValue(fieldRecord.required),
        related: stringValue(fieldRecord.related) || undefined,
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

function resolveManifestSourcePath(
  rootDir: string,
  packageDir: string,
  sourcePath: string | null,
): string | undefined {
  if (!sourcePath) {
    return undefined;
  }

  if (isAbsolute(sourcePath)) {
    return sourcePath;
  }

  const rootRelativePath = resolve(rootDir, sourcePath);
  if (existsSync(rootRelativePath)) {
    return rootRelativePath;
  }

  return resolve(packageDir, sourcePath);
}

function typedocPackageSlug(packageName: string | undefined): string | null {
  if (!packageName?.startsWith('@happyvertical/smrt-')) {
    return null;
  }

  return packageName.replace('@happyvertical/smrt-', '');
}

function findTypedocClassPath(
  rootDir: string,
  packageDir: string,
  packageName: string | undefined,
  className: string,
): string | undefined {
  const slug = typedocPackageSlug(packageName);
  const candidates = [
    slug
      ? join(
          rootDir,
          'docs',
          'content',
          'api',
          slug,
          'classes',
          `${className}.md`,
        )
      : null,
    join(packageDir, 'docs', 'classes', `${className}.md`),
    join(packageDir, 'docs', `${className}.md`),
  ].filter((path): path is string => Boolean(path));

  return candidates.find((path) => existsSync(path));
}

function extractTypedocSummary(content: string): string | undefined {
  const lines = content.split(/\r?\n/);
  const summary: string[] = [];
  let hasSeenTitle = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (!hasSeenTitle) {
      if (trimmed.startsWith('# ')) {
        hasSeenTitle = true;
      }
      continue;
    }

    if (!trimmed || trimmed.startsWith('Defined in:')) {
      continue;
    }
    if (trimmed.startsWith('## ')) {
      break;
    }
    if (trimmed.startsWith('> ')) {
      continue;
    }

    summary.push(trimmed);
  }

  const value = summary.join('\n').trim();
  return value.length > 0 ? value : undefined;
}

function readTypedocSummary(path: string | undefined): string | undefined {
  if (!path) {
    return undefined;
  }

  return extractTypedocSummary(readFileSync(path, 'utf-8'));
}

const CRUD_ACTIONS = ['list', 'get', 'create', 'update', 'delete'] as const;
const SERVER_MANAGED_FIELDS = new Set([
  'id',
  'tenantId',
  'tenant_id',
  'createdAt',
  'created_at',
  'updatedAt',
  'updated_at',
]);

function arrayOfStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function configObject(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function parameterRequired(
  value: Record<string, unknown>,
): boolean | undefined {
  if (typeof value.required === 'boolean') {
    return value.required;
  }

  const meta = configObject(value._meta);
  return typeof meta.required === 'boolean' ? meta.required : undefined;
}

function parameterDescription(
  value: Record<string, unknown>,
): string | undefined {
  return (
    stringValue(value.description) ||
    stringValue(configObject(value._meta).description) ||
    undefined
  );
}

function parameterDefaultValue(
  value: Record<string, unknown>,
): string | undefined {
  if (!Object.hasOwn(value, 'default')) {
    return undefined;
  }

  const defaultValue = value.default;
  if (
    typeof defaultValue === 'string' ||
    typeof defaultValue === 'number' ||
    typeof defaultValue === 'boolean'
  ) {
    return String(defaultValue);
  }

  if (defaultValue === null) {
    return 'null';
  }

  try {
    return JSON.stringify(defaultValue);
  } catch {
    return undefined;
  }
}

function fieldParameter(
  name: string,
  field: Record<string, unknown>,
  location: WorkbenchApiParameterLocation,
  requiredOverride?: boolean,
): WorkbenchApiParameterSummary {
  return {
    name,
    type: stringValue(field.type) || undefined,
    required: requiredOverride ?? parameterRequired(field),
    location,
    description: parameterDescription(field),
    defaultValue: parameterDefaultValue(field),
  };
}

function writableFieldEntries(
  object: Record<string, unknown>,
): Array<[string, Record<string, unknown>]> {
  const fields = configObject(object.fields);
  const apiConfig = configObject(configObject(object.decoratorConfig).api);
  const writableAllowlist = new Set(arrayOfStrings(apiConfig.writable));
  const hasWritableAllowlist = writableAllowlist.size > 0;

  return Object.entries(fields)
    .filter((entry): entry is [string, Record<string, unknown>] =>
      isRecord(entry[1]),
    )
    .filter(([name, field]) => {
      if (name.startsWith('_')) {
        return false;
      }
      if (SERVER_MANAGED_FIELDS.has(name)) {
        return false;
      }
      if (
        field.readonly === true ||
        configObject(field._meta).readonly === true
      ) {
        return false;
      }
      return !hasWritableAllowlist || writableAllowlist.has(name);
    })
    .sort(([left], [right]) => left.localeCompare(right));
}

function writableFieldParameters(
  object: Record<string, unknown>,
  location: WorkbenchApiParameterLocation,
  requiredMode: 'field' | 'optional',
): WorkbenchApiParameterSummary[] {
  return writableFieldEntries(object).map(([name, field]) =>
    fieldParameter(
      name,
      field,
      location,
      requiredMode === 'field' ? parameterRequired(field) : false,
    ),
  );
}

function methodParameterSummaries(
  object: Record<string, unknown>,
  action: string,
  location: WorkbenchApiParameterLocation,
): WorkbenchApiParameterSummary[] {
  const parameters = methodDefinition(object, action).parameters;
  if (!Array.isArray(parameters)) {
    return [];
  }

  return parameters.filter(isRecord).map((parameter) => ({
    name: stringValue(parameter.name) || 'parameter',
    type: stringValue(parameter.type) || undefined,
    required: parameter.optional !== true,
    location,
    description: parameterDescription(parameter),
    defaultValue: parameterDefaultValue(parameter),
  }));
}

function pathParameterNames(path: string): string[] {
  return Array.from(path.matchAll(/\{([^}]+)\}/g))
    .map((match) => match[1]?.trim())
    .filter((name): name is string => Boolean(name));
}

function pathParameters(path: string): WorkbenchApiParameterSummary[] {
  return pathParameterNames(path).map((name) => ({
    name,
    type: 'string',
    required: true,
    location: 'path',
  }));
}

function restCrudParameters(
  object: Record<string, unknown>,
  action: string,
  path: string,
): WorkbenchApiParameterSummary[] {
  if (action === 'list') {
    return [
      {
        name: 'limit',
        type: 'integer',
        required: false,
        location: 'query',
        description: 'Maximum number of items to return.',
        defaultValue: '50',
      },
      {
        name: 'offset',
        type: 'integer',
        required: false,
        location: 'query',
        description: 'Number of items to skip.',
        defaultValue: '0',
      },
    ];
  }

  if (action === 'create') {
    return writableFieldParameters(object, 'body', 'field');
  }

  if (action === 'update') {
    return [
      ...pathParameters(path),
      ...writableFieldParameters(object, 'body', 'optional'),
    ];
  }

  return pathParameters(path);
}

function restCustomParameters(
  object: Record<string, unknown>,
  action: string,
  method: string,
  path: string,
): WorkbenchApiParameterSummary[] {
  const pathParams = pathParameters(path);
  const pathParamNameSet = new Set(pathParams.map((param) => param.name));
  const bodyOrQueryParams = methodParameterSummaries(
    object,
    action,
    method === 'GET' ? 'query' : 'body',
  ).filter((param) => !pathParamNameSet.has(param.name));

  return [...pathParams, ...bodyOrQueryParams];
}

function cliCrudParameters(
  object: Record<string, unknown>,
  action: string,
): WorkbenchApiParameterSummary[] {
  if (action === 'list') {
    return [
      {
        name: '--limit',
        type: 'integer',
        required: false,
        location: 'option',
        description: 'Maximum number of items to return.',
        defaultValue: '50',
      },
      {
        name: '--offset',
        type: 'integer',
        required: false,
        location: 'option',
        description: 'Number of items to skip.',
        defaultValue: '0',
      },
      {
        name: '--order-by',
        type: 'string',
        required: false,
        location: 'option',
        description: 'Ordering expression, for example "created_at DESC".',
      },
      {
        name: '--where',
        type: 'object',
        required: false,
        location: 'option',
        description: 'JSON filter conditions.',
      },
    ];
  }

  if (action === 'get' || action === 'delete') {
    return [
      {
        name: 'id',
        type: 'string',
        required: true,
        location: 'argument',
        description: 'Object ID. May also be passed as --id.',
      },
    ];
  }

  const bodyParameters = writableFieldParameters(
    object,
    'option',
    action === 'create' ? 'field' : 'optional',
  ).map((param) => ({
    ...param,
    name: `--${param.name}`,
  }));

  if (action === 'create') {
    return [
      {
        name: '--from-file',
        type: 'path',
        required: false,
        location: 'option',
        description: 'Path to a JSON object payload.',
      },
      ...bodyParameters,
    ];
  }

  return [
    {
      name: 'id',
      type: 'string',
      required: true,
      location: 'argument',
      description: 'Object ID. May also be passed as --id.',
    },
    {
      name: '--from-file',
      type: 'path',
      required: false,
      location: 'option',
      description: 'Path to a JSON object payload.',
    },
    ...bodyParameters,
  ];
}

function cliCustomParameters(
  object: Record<string, unknown>,
  action: string,
): WorkbenchApiParameterSummary[] {
  const params = methodParameterSummaries(object, action, 'option').map(
    (param) => ({
      ...param,
      name: `--${param.name}`,
      required: false,
    }),
  );

  return [
    {
      name: 'id',
      type: 'string',
      required: false,
      location: 'argument',
      description:
        'Optional object ID for instance actions. May also be passed as --id.',
    },
    ...params,
  ];
}

function mcpCrudParameters(
  object: Record<string, unknown>,
  action: string,
): WorkbenchApiParameterSummary[] {
  if (action === 'list') {
    return [
      {
        name: 'limit',
        type: 'integer',
        required: false,
        location: 'input',
        description: 'Maximum number of items to return.',
        defaultValue: '50',
      },
      {
        name: 'offset',
        type: 'integer',
        required: false,
        location: 'input',
        description: 'Number of items to skip.',
        defaultValue: '0',
      },
      {
        name: 'orderBy',
        type: 'string',
        required: false,
        location: 'input',
        description: 'Ordering expression, for example "created_at DESC".',
      },
      {
        name: 'where',
        type: 'object',
        required: false,
        location: 'input',
        description: 'Filter conditions as key-value pairs.',
      },
    ];
  }

  if (action === 'get') {
    return [
      {
        name: 'id',
        type: 'string',
        required: true,
        location: 'input',
        description: 'Unique identifier of the object.',
      },
      {
        name: 'slug',
        type: 'string',
        required: false,
        location: 'input',
        description: 'URL-friendly identifier of the object.',
      },
    ];
  }

  if (action === 'delete') {
    return [
      {
        name: 'id',
        type: 'string',
        required: true,
        location: 'input',
        description: 'ID of the object to delete.',
      },
    ];
  }

  if (action === 'create') {
    return writableFieldParameters(object, 'input', 'field');
  }

  return [
    {
      name: 'id',
      type: 'string',
      required: true,
      location: 'input',
      description: 'ID of the object to update.',
    },
    ...writableFieldParameters(object, 'input', 'optional'),
  ];
}

function mcpCustomParameters(
  object: Record<string, unknown>,
  action: string,
): WorkbenchApiParameterSummary[] {
  const methodParams = methodParameterSummaries(object, action, 'input');
  return [
    {
      name: 'id',
      type: 'string',
      required: true,
      location: 'input',
      description: 'ID of the object to execute the action on.',
    },
    ...(methodParams.length > 0
      ? methodParams
      : [
          {
            name: 'options',
            type: 'object',
            required: false,
            location: 'input' as const,
            description: 'Additional options for the custom action.',
          },
        ]),
  ];
}

function enabledCrudActions(config: unknown): string[] {
  if (config === false) {
    return [];
  }

  const include = arrayOfStrings(configObject(config).include);
  const exclude = new Set(arrayOfStrings(configObject(config).exclude));
  const actions =
    include.length > 0
      ? include.filter((action) => CRUD_ACTIONS.includes(action as never))
      : [...CRUD_ACTIONS];

  return actions.filter((action) => !exclude.has(action));
}

function publicCustomMethodNames(object: Record<string, unknown>): string[] {
  return Object.entries(configObject(object.methods))
    .filter(([name, method]) => {
      if (CRUD_ACTIONS.includes(name as never) || !isRecord(method)) {
        return false;
      }
      return method.isPublic === true;
    })
    .map(([name]) => name)
    .sort();
}

function enabledCustomActions(
  object: Record<string, unknown>,
  surface: 'api' | 'cli' | 'mcp',
): string[] {
  const decoratorConfig = configObject(object.decoratorConfig);
  const surfaceConfig = decoratorConfig[surface];
  if (surfaceConfig === false) {
    return [];
  }

  const include = arrayOfStrings(configObject(surfaceConfig).include);
  const exclude = new Set(arrayOfStrings(configObject(surfaceConfig).exclude));
  const publicMethods = publicCustomMethodNames(object);

  if (surface === 'mcp' && include.length > 0) {
    return include
      .filter((name) => !CRUD_ACTIONS.includes(name as never))
      .filter((name) => publicMethods.includes(name))
      .filter((name) => !exclude.has(name));
  }

  if (surface === 'api') {
    return publicMethods
      .filter((name) => include.length === 0 || include.includes(name))
      .filter((name) => !exclude.has(name));
  }

  const customMethodsInInclude = include.filter(
    (name) => !CRUD_ACTIONS.includes(name as never),
  );
  return publicMethods
    .filter(
      (name) =>
        customMethodsInInclude.length === 0 ||
        customMethodsInInclude.includes(name),
    )
    .filter((name) => !exclude.has(name));
}

function routeOverrides(
  object: Record<string, unknown>,
): Record<string, Record<string, unknown>> {
  const apiConfig = configObject(configObject(object.decoratorConfig).api);
  const routes = configObject(apiConfig.routes);

  return Object.fromEntries(
    Object.entries(routes).filter(
      (entry): entry is [string, Record<string, unknown>] => isRecord(entry[1]),
    ),
  );
}

function methodDefinition(
  object: Record<string, unknown>,
  action: string,
): Record<string, unknown> {
  return configObject(configObject(object.methods)[action]);
}

function customRoutePath(
  object: Record<string, unknown>,
  action: string,
): string {
  const collection =
    stringValue(object.collection) || stringValue(object.name) || action;
  const routeConfig = routeOverrides(object)[action] || {};
  const method = methodDefinition(object, action);
  const configuredPath = stringValue(routeConfig.path) || action;
  const normalizedPath = configuredPath
    .split('/')
    .map((segment) => segment.trim())
    .filter(Boolean)
    .join('/')
    .replace(/\[([^\]]+)\]/g, '{$1}');
  const scope =
    stringValue(routeConfig.scope) ||
    (method.isStatic === true ? 'collection' : 'item');

  return scope === 'collection'
    ? `/api/v1/${collection}/${normalizedPath}`
    : `/api/v1/${collection}/{id}/${normalizedPath}`;
}

function restEndpointsFrom(
  object: Record<string, unknown>,
): WorkbenchRestEndpointSummary[] {
  const className =
    stringValue(object.className) || stringValue(object.name) || 'Object';
  const collection = stringValue(object.collection) || className.toLowerCase();
  const apiConfig = configObject(object.decoratorConfig).api;
  const endpoints: WorkbenchRestEndpointSummary[] = [];

  for (const action of enabledCrudActions(apiConfig)) {
    const route =
      action === 'list'
        ? ['GET', `/api/v1/${collection}`, `List ${className} objects`]
        : action === 'create'
          ? ['POST', `/api/v1/${collection}`, `Create ${className}`]
          : action === 'get'
            ? ['GET', `/api/v1/${collection}/{id}`, `Get ${className} by ID`]
            : action === 'update'
              ? ['PUT', `/api/v1/${collection}/{id}`, `Update ${className}`]
              : ['DELETE', `/api/v1/${collection}/{id}`, `Delete ${className}`];

    endpoints.push({
      objectName: className,
      action,
      method: route[0],
      path: route[1],
      description: route[2],
      parameters: restCrudParameters(object, action, route[1]),
    });
  }

  const overrides = routeOverrides(object);
  for (const action of enabledCustomActions(object, 'api')) {
    const routeConfig = overrides[action] || {};
    const method = stringValue(routeConfig.method) || 'POST';
    endpoints.push({
      objectName: className,
      action,
      method,
      path: customRoutePath(object, action),
      description: `Run ${className}.${action}`,
      parameters: restCustomParameters(
        object,
        action,
        method,
        customRoutePath(object, action),
      ),
    });
  }

  return endpoints;
}

function cliCommandsFrom(
  object: Record<string, unknown>,
): WorkbenchCliCommandSummary[] {
  const className =
    stringValue(object.className) || stringValue(object.name) || 'Object';
  const lowerName = className.toLowerCase();
  const cliConfig = configObject(object.decoratorConfig).cli;
  const commands: WorkbenchCliCommandSummary[] = [];

  for (const action of enabledCrudActions(cliConfig)) {
    const description =
      action === 'list'
        ? `List ${className} objects`
        : action === 'get'
          ? `Get ${className} by ID or slug`
          : action === 'create'
            ? `Create new ${className}`
            : action === 'update'
              ? `Update ${className}`
              : `Delete ${className}`;

    commands.push({
      objectName: className,
      action,
      command: `${lowerName}:${action}`,
      description,
      parameters: cliCrudParameters(object, action),
    });
  }

  for (const action of enabledCustomActions(object, 'cli')) {
    commands.push({
      objectName: className,
      action,
      command: `${lowerName}:${action}`,
      description: `Run ${className}.${action}`,
      parameters: cliCustomParameters(object, action),
    });
  }

  return commands;
}

function mcpToolsFrom(
  object: Record<string, unknown>,
): WorkbenchMcpToolSummary[] {
  const className =
    stringValue(object.className) || stringValue(object.name) || 'Object';
  const lowerName = className.toLowerCase();
  const mcpConfig = configObject(object.decoratorConfig).mcp;
  const tools: WorkbenchMcpToolSummary[] = [];

  for (const action of enabledCrudActions(mcpConfig)) {
    const description =
      action === 'list'
        ? `List ${className} objects with optional filtering`
        : action === 'get'
          ? `Get a specific ${className} by ID or slug`
          : action === 'create'
            ? `Create a new ${className}`
            : action === 'update'
              ? `Update an existing ${className}`
              : `Delete a ${className} by ID`;

    tools.push({
      objectName: className,
      action,
      toolName: `${lowerName}_${action}`,
      description,
      parameters: mcpCrudParameters(object, action),
    });
  }

  for (const action of enabledCustomActions(object, 'mcp')) {
    tools.push({
      objectName: className,
      action,
      toolName: `${lowerName}_${action}`.toLowerCase(),
      description: `Execute ${action} action on ${className}`,
      parameters: mcpCustomParameters(object, action),
    });
  }

  return tools;
}

function readApiSummary(
  packageDir: string,
  rootDir: string,
  packageName: string,
  knowledge: WorkbenchKnowledgeSummary,
  routeFiles: string[],
): WorkbenchApiSummary {
  const manifest = knowledge.manifestPath
    ? readJsonIfExists<Record<string, unknown>>(knowledge.manifestPath)
    : null;
  const objectRecords = objectRecordsFrom(manifest?.objects);

  const objects: WorkbenchApiObjectSummary[] = objectRecords.map((object) => {
    const name =
      stringValue(object.className) ||
      stringValue(object.name) ||
      stringValue(object.key) ||
      'unknown';
    const className = stringValue(object.className) || name;
    const sourcePath = resolveManifestSourcePath(
      rootDir,
      packageDir,
      stringValue(object.filePath) || stringValue(object.sourcePath),
    );
    const typedocPath = findTypedocClassPath(
      rootDir,
      packageDir,
      packageName,
      className,
    );
    const fields = fieldSummariesFrom(object.fields);

    return {
      name,
      className,
      qualifiedName: stringValue(object.qualifiedName) || undefined,
      collection: stringValue(object.collection) || undefined,
      sourcePath,
      typedocPath,
      description: readTypedocSummary(typedocPath),
      fields,
    };
  });

  const objectNames =
    objects.length > 0
      ? objects
          .map(
            (object) => object.qualifiedName || object.className || object.name,
          )
          .filter(Boolean)
          .sort()
      : knowledge.objectNames;
  const restEndpoints = objectRecords.flatMap(restEndpointsFrom);

  return {
    objectNames,
    objects,
    restEndpoints,
    cliCommands: objectRecords.flatMap(cliCommandsFrom),
    mcpTools: objectRecords.flatMap(mcpToolsFrom),
    endpointCount: restEndpoints.length,
    routeFiles,
  };
}

async function collectRouteFiles(packageDir: string): Promise<string[]> {
  return fg(['src/routes/**/*.{ts,svelte}', 'routes/**/*.{ts,svelte}'], {
    cwd: packageDir,
    absolute: true,
    onlyFiles: true,
    ignore: ['**/node_modules/**', '**/.svelte-kit/**'],
  });
}

async function collectMigrations(packageDir: string): Promise<string[]> {
  return fg(['migrations/**/*', 'src/migrations/**/*'], {
    cwd: packageDir,
    absolute: true,
    onlyFiles: true,
    ignore: ['**/node_modules/**'],
  });
}

async function collectExamples(
  packageDir: string,
  docs: WorkbenchDocumentSummary[],
): Promise<WorkbenchExampleSummary[]> {
  const fileMatches = await fg(
    [
      'examples/**/*.{ts,tsx,svelte,md}',
      'src/**/*.{example,stories}.{ts,tsx,svelte}',
      'src/**/examples/**/*.{ts,tsx,svelte,md}',
    ],
    {
      cwd: packageDir,
      absolute: true,
      onlyFiles: true,
      ignore: ['**/node_modules/**', '**/dist/**', '**/.svelte-kit/**'],
    },
  );

  const fileExamples = fileMatches.slice(0, 16).map((path, index) => ({
    id: `file:${index}`,
    title: relative(packageDir, path),
    path,
    source: 'file' as const,
  }));

  const readme = docs.find((doc) => doc.kind === 'readme');
  const readmeExamples = readme?.content
    ? extractReadmeCodeBlocks(readme.content).slice(0, 8)
    : [];

  return [...fileExamples, ...readmeExamples];
}

function extractReadmeCodeBlocks(content: string): WorkbenchExampleSummary[] {
  const examples: WorkbenchExampleSummary[] = [];
  const blockPattern = /```([A-Za-z0-9_-]*)\n([\s\S]*?)```/g;
  let index = 0;
  let match = blockPattern.exec(content);

  while (match) {
    const language = match[1] || undefined;
    const code = match[2] || '';
    if (!code.trim()) {
      match = blockPattern.exec(content);
      continue;
    }

    const { content: trimmedCode } = truncate(code, EXAMPLE_LIMIT);
    examples.push({
      id: `readme:${index}`,
      title: `README example ${index + 1}`,
      language,
      code: trimmedCode,
      source: 'readme',
    });
    index += 1;
    match = blockPattern.exec(content);
  }

  return examples;
}

async function summarizePackage(
  input: WorkbenchPackageDir,
  rootDir: string,
): Promise<WorkbenchPackageSummary> {
  const { packageDir, packageJson, source } = input;
  const packageName =
    packageJson.name || relative(rootDir, packageDir) || packageDir;
  const docs = [
    readDocument(packageDir, 'README.md', 'readme'),
    readDocument(packageDir, 'AGENTS.md', 'agents'),
    readDocument(packageDir, 'CHANGELOG.md', 'changelog'),
  ].filter((doc): doc is WorkbenchDocumentSummary => Boolean(doc));
  const examples = await collectExamples(packageDir, docs);
  const knowledge = readKnowledgeSummary(packageDir);
  const routeFiles = await collectRouteFiles(packageDir);
  const migrations = await collectMigrations(packageDir);
  const scripts = stringRecord(packageJson.scripts);
  const api = readApiSummary(
    packageDir,
    rootDir,
    packageName,
    knowledge,
    routeFiles,
  );

  return {
    name: packageName,
    version: packageJson.version,
    description: packageJson.description,
    source,
    directory: packageDir,
    relativeDirectory: relative(rootDir, packageDir) || '.',
    scripts,
    dependencies: stringRecord(packageJson.dependencies),
    devDependencies: stringRecord(packageJson.devDependencies),
    peerDependencies: stringRecord(packageJson.peerDependencies),
    smrtDependencies: smrtDependencyNames(packageJson),
    sdkDependencies: sdkDependencyNames(packageJson),
    exportKeys: exportKeys(packageJson.exports),
    docs,
    examples,
    knowledge,
    api,
    migrations,
    routeModuleCount: 0,
    routeCount: 0,
    playgroundEntryCount: 0,
    recommendedCommands: Object.keys(scripts)
      .filter((scriptName) =>
        ['test', 'typecheck', 'check', 'build', 'dev', 'workbench'].includes(
          scriptName,
        ),
      )
      .sort()
      .map((scriptName) => ({
        id: commandIdForScript(packageName, scriptName),
        label: scriptName,
        command: `pnpm --filter ${packageName} ${scriptName}`,
      })),
  };
}

async function discoverWorkspacePackageDirs(
  workspaceRoot: string,
): Promise<WorkbenchPackageDir[]> {
  const packageJsonPaths = await fg('packages/*/package.json', {
    cwd: workspaceRoot,
    absolute: true,
    onlyFiles: true,
  });

  return packageJsonPaths
    .map((packageJsonPath) => ({
      packageDir: dirname(packageJsonPath),
      packageJson: readJson<PackageJsonLike>(packageJsonPath),
      source: 'workspace' as const,
    }))
    .filter(
      (item) =>
        typeof item.packageJson.name === 'string' &&
        item.packageJson.name.startsWith('@happyvertical/smrt-'),
    )
    .sort((left, right) =>
      (left.packageJson.name || '').localeCompare(right.packageJson.name || ''),
    );
}

function resolveNodeModulePackageDir(
  projectRoot: string,
  packageName: string,
): string | null {
  const packageJsonPath = join(
    projectRoot,
    'node_modules',
    packageName,
    'package.json',
  );
  return existsSync(packageJsonPath) ? dirname(packageJsonPath) : null;
}

async function discoverConsumerPackageDirs(
  projectRoot: string,
): Promise<WorkbenchPackageDir[]> {
  const packageJsonPath = join(projectRoot, 'package.json');
  if (!existsSync(packageJsonPath)) {
    return [];
  }

  const packageJson = readJson<PackageJsonLike>(packageJsonPath);
  const dependencies = {
    ...packageJson.dependencies,
    ...packageJson.devDependencies,
    ...packageJson.peerDependencies,
  };
  const packageDirs: WorkbenchPackageDir[] = [];

  packageDirs.push({
    packageDir: projectRoot,
    packageJson,
    source: packageJson.name?.startsWith('@happyvertical/smrt-')
      ? 'package'
      : 'app',
  });

  for (const dependencyName of Object.keys(dependencies).sort()) {
    if (
      !dependencyName.startsWith('@happyvertical/smrt-') ||
      dependencyName === '@happyvertical/smrt-workbench'
    ) {
      continue;
    }

    const packageDir = resolveNodeModulePackageDir(projectRoot, dependencyName);
    if (!packageDir) {
      continue;
    }

    packageDirs.push({
      packageDir,
      packageJson: readJson<PackageJsonLike>(join(packageDir, 'package.json')),
      source: 'package',
    });
  }

  return packageDirs;
}

function resolvePackageByName(
  workspaceRoot: string,
  packageName: string,
): string | null {
  const packagesDir = join(workspaceRoot, 'packages');
  if (!existsSync(packagesDir)) {
    return null;
  }

  const packageJsonPaths = fg.sync('*/package.json', {
    cwd: packagesDir,
    absolute: true,
    onlyFiles: true,
  });

  for (const packageJsonPath of packageJsonPaths) {
    const packageJson = readJson<PackageJsonLike>(packageJsonPath);
    if (packageJson.name === packageName) {
      return dirname(packageJsonPath);
    }
  }

  return null;
}

export function resolveWorkbenchScope(
  cwd = process.cwd(),
  options: Pick<
    SmrtWorkbenchVitePluginOptions,
    'projectRoot' | 'workspaceRoot' | 'packageName'
  > = {},
): WorkbenchScopeResolution {
  const resolvedCwd = resolve(cwd);
  const requestedProjectRoot = options.projectRoot
    ? resolve(options.projectRoot)
    : undefined;
  const workspaceRoot =
    options.workspaceRoot ||
    (requestedProjectRoot
      ? findSmrtWorkbenchWorkspaceRoot(requestedProjectRoot)
      : null) ||
    findSmrtWorkbenchWorkspaceRoot(resolvedCwd);

  if (workspaceRoot) {
    const packageDir =
      (options.packageName
        ? resolvePackageByName(workspaceRoot, options.packageName)
        : null) ||
      findPackageDir(resolvedCwd, workspaceRoot) ||
      undefined;
    const packageJson = packageDir
      ? readJsonIfExists<PackageJsonLike>(join(packageDir, 'package.json'))
      : null;
    const packageName = options.packageName || packageJson?.name;
    const mode: SmrtWorkbenchScopeMode = packageName ? 'package' : 'workspace';

    return {
      mode,
      cwd: resolvedCwd,
      projectRoot: workspaceRoot,
      workspaceRoot,
      packageName,
      packageDir,
    };
  }

  const projectRoot = requestedProjectRoot || findProjectRoot(resolvedCwd);
  return {
    mode: 'consumer',
    cwd: resolvedCwd,
    projectRoot,
    packageName: options.packageName,
  };
}

export async function buildWorkbenchProject(
  scope: WorkbenchScopeResolution,
): Promise<SmrtWorkbenchProject> {
  const packageDirs =
    scope.mode === 'consumer'
      ? await discoverConsumerPackageDirs(scope.projectRoot)
      : await discoverWorkspacePackageDirs(scope.projectRoot);

  const filteredPackageDirs = scope.packageName
    ? packageDirs.filter((item) => item.packageJson.name === scope.packageName)
    : packageDirs;

  const packages = await Promise.all(
    filteredPackageDirs.map((item) =>
      summarizePackage(item, scope.projectRoot),
    ),
  );

  return {
    generatedAt: new Date().toISOString(),
    scope,
    packages,
  };
}

export async function discoverWorkspaceWorkbenches(
  workspaceRoot: string,
  packagesPattern = 'packages/*/src/workbench.ts',
): Promise<DiscoveredWorkbenchTarget[]> {
  const matches = await fg(packagesPattern, {
    cwd: workspaceRoot,
    absolute: true,
    onlyFiles: true,
  });

  return matches.sort().map((sourcePath) => {
    const packageDir = dirname(dirname(sourcePath));
    const packageJsonPath = join(packageDir, 'package.json');
    const packageJson = readJson<PackageJsonLike>(packageJsonPath);
    const runtimePath = join(packageDir, 'dist', 'workbench.js');

    return {
      packageName: packageJson.name,
      source: 'workspace' as const,
      sourcePath,
      runtimePath: existsSync(runtimePath) ? runtimePath : undefined,
    };
  });
}

export async function discoverInstalledWorkbenches(
  projectRoot = process.cwd(),
): Promise<DiscoveredWorkbenchTarget[]> {
  const packageJsonPath = join(projectRoot, 'package.json');
  if (!existsSync(packageJsonPath)) {
    return [];
  }

  const packageJson = readJson<PackageJsonLike>(packageJsonPath);
  const dependencies = {
    ...packageJson.dependencies,
    ...packageJson.devDependencies,
    ...packageJson.peerDependencies,
  };
  const discovered: DiscoveredWorkbenchTarget[] = [];

  for (const dependencyName of Object.keys(dependencies).sort()) {
    if (
      !dependencyName.startsWith('@happyvertical/smrt-') ||
      dependencyName === '@happyvertical/smrt-workbench'
    ) {
      continue;
    }

    const packageDir = resolveNodeModulePackageDir(projectRoot, dependencyName);
    if (!packageDir) {
      continue;
    }

    const dependencyPackageJson = readJson<PackageJsonLike>(
      join(packageDir, 'package.json'),
    );
    if (exportKeys(dependencyPackageJson.exports).includes('./workbench')) {
      discovered.push({
        packageName: dependencyName,
        source: 'package',
        importSpecifier: `${dependencyName}/workbench`,
      });
    }
  }

  return discovered;
}

export async function discoverWorkbenchTargets(
  projectRoot = process.cwd(),
  mode: 'auto' | 'workspace' | 'consumer' = 'auto',
  localWorkbenchPath = 'src/workbench.ts',
  packageName?: string,
  packagesPattern = 'packages/*/src/workbench.ts',
): Promise<DiscoveredWorkbenchTarget[]> {
  const effectiveMode =
    mode === 'auto' ? detectWorkbenchMode(projectRoot) : mode;

  if (effectiveMode === 'workspace') {
    const workspaceRoot =
      mode === 'workspace'
        ? findWorkspaceRoot(projectRoot)
        : findSmrtWorkbenchWorkspaceRoot(projectRoot);
    if (!workspaceRoot) {
      return [];
    }

    const targets = await discoverWorkspaceWorkbenches(
      workspaceRoot,
      packagesPattern,
    );
    return packageName
      ? targets.filter((target) => target.packageName === packageName)
      : targets;
  }

  const targets = await discoverInstalledWorkbenches(projectRoot);
  const localPath = resolve(projectRoot, localWorkbenchPath);
  if (existsSync(localPath)) {
    targets.push({
      source: 'app',
      sourcePath: localPath,
    });
  }

  return packageName
    ? targets.filter((target) => target.packageName === packageName)
    : targets;
}

export async function importWorkbenchModule(
  input: string,
): Promise<SmrtWorkbenchModule[]> {
  const imported =
    isAbsolute(input) || input.startsWith('.')
      ? await importPathModule(resolve(input))
      : await import(/* @vite-ignore */ input);

  const module = imported.default ?? imported.workbench ?? imported;
  return module && typeof module === 'object'
    ? coerceWorkbenchModules(module as SmrtWorkbenchModule)
    : [];
}

async function importPathModule(inputPath: string): Promise<unknown> {
  if (!TS_SOURCE_EXTENSIONS.has(extname(inputPath))) {
    return import(/* @vite-ignore */ pathToFileURL(inputPath).href);
  }

  let tsxApiPath: string;
  try {
    tsxApiPath = require.resolve('tsx/esm/api');
  } catch (tsxError) {
    throw new Error(
      `Failed to load workbench module from ${inputPath}: source workbench discovery requires the "tsx" package.`,
      { cause: tsxError },
    );
  }

  const { tsImport } = await import(
    /* @vite-ignore */ pathToFileURL(tsxApiPath).href
  );
  return tsImport(pathToFileURL(inputPath).href, {
    parentURL: import.meta.url,
  });
}

export function describeWorkbenchSource(
  target: DiscoveredWorkbenchTarget,
  cwd = process.cwd(),
): string {
  if (target.source === 'package') {
    return target.importSpecifier || target.packageName || 'installed package';
  }

  const path = target.sourcePath || target.runtimePath;
  return path ? relative(cwd, path) || '.' : target.source;
}
