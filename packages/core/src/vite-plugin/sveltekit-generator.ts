/**
 * SvelteKit route auto-generation from SMRT objects
 * Generates real TypeScript files in src/routes/api/ based on discovered SMRT objects
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, relative } from 'node:path';
import type { DomainKnowledgeConfig } from '@happyvertical/smrt-types';
import { generateConditionalGetRouteHelper } from '../generators/conditional-get.js';
import type {
  ApiConfig,
  ApiCustomRouteConfig,
  ApiHttpMethod,
  ApiSerializerReference,
} from '../registry/types.js';
import type {
  MethodDefinition,
  SmartObjectDefinition,
  SmartObjectManifest,
} from '../scanner/types';
import { generateChangesRoute } from './changes-route.js';
import { generateEventsRoute } from './events-route.js';
import { AUTO_GENERATED_ROUTE_HEADER } from './route-header.js';
import { generateSyncApplyRoute } from './sync-apply-route.js';

export interface SvelteKitOptions {
  enabled: boolean;
  routesDir: string;
  objectsDir: string;
  configPath?: string; // default: 'src/lib/server'
  configFileName?: string; // default: 'smrt.ts'
  /**
   * Apply kebab-case to custom-method URL segments (e.g. `discoverFromUrl`
   * becomes `/discover-from-url`). Opt-in for one minor; default flips in the
   * next major. An explicit `api.routes[name].path` always wins over this.
   */
  kebabRoutes?: boolean;
  /** Domain knowledge API route generation. Disabled unless explicitly enabled. */
  knowledge?: DomainKnowledgeConfig;
  /**
   * Change-feed `_changes` route generation (#1758). Enabled by default
   * (the route is auth-guarded fail-closed); set `enabled: false` to skip.
   */
  changesRoute?: { enabled?: boolean };
  /**
   * Live `_events` SSE route generation (#1763). Enabled by default (the route
   * is auth-guarded fail-closed, same-origin only); set `enabled: false` to
   * skip.
   */
  eventsRoute?: { enabled?: boolean };
}

// Keep this aligned with biome.json formatter.lineWidth.
const BIOME_LINE_WIDTH = 80;
const STANDARD_API_ACTIONS = ['list', 'get', 'create', 'update', 'delete'];

interface ResolvedApiActionRouteConfig {
  scope: 'item' | 'collection';
  method: ApiHttpMethod;
  pathSegments: string[];
  pathParamNames: string[];
}

interface GeneratedActionRouteSpec {
  lookupClassName: string;
  lookupObjectDef?: SmartObjectDefinition;
  hostClassName: string;
  actionName: string;
  actionDef: MethodDefinition;
  routeConfig: ResolvedApiActionRouteConfig;
  hostType: 'item' | 'collection';
}

interface ResolvedStandardRouteSerializers {
  importStatements: string[];
  itemSerializerName?: string;
  listItemSerializerName?: string;
}

interface GeneratedTypeReference {
  typeName: string;
  importStatement?: string;
}

/**
 * Extract simple class name from potentially qualified name.
 * Qualified names follow the pattern: @scope/package:ClassName
 *
 * Issue #870: Manifests may contain qualified names which generate invalid
 * import statements like: import { @pkg:Class } from '@pkg'
 *
 * @param qualifiedName - Class name that may be qualified (e.g., "@pkg:Class" or "Class")
 * @returns Simple class name (e.g., "Class")
 */
function extractSimpleClassName(qualifiedName: string): string {
  const colonIndex = qualifiedName.indexOf(':');
  if (colonIndex !== -1) {
    return qualifiedName.substring(colonIndex + 1);
  }
  return qualifiedName;
}

/**
 * Check if an object definition represents a SmrtCollection class.
 * Collection classes share route paths with their item class (via inherited `collection` field),
 * so generating routes for both would cause file collisions.
 */
function isCollectionClass(objectDef: SmartObjectDefinition): boolean {
  return objectDef.extends === 'SmrtCollection' || !!objectDef.extendsTypeArg;
}

function getRegistrationPackageName(
  manifest: SmartObjectManifest,
  objectDef: SmartObjectDefinition,
  isLocal: boolean,
): string | undefined {
  if (isLocal) {
    return manifest.packageName ?? objectDef.packageName;
  }

  return objectDef.packageName;
}

function toSingleQuotedStringLiteral(value: string): string {
  const jsonLiteral = JSON.stringify(value);
  const jsonContent = jsonLiteral.slice(1, -1).replaceAll("'", "\\'");
  return `'${jsonContent}'`;
}

function getApiConfigObject(apiConfig: unknown): ApiConfig | null {
  if (!apiConfig || typeof apiConfig !== 'object') {
    return null;
  }

  return apiConfig as ApiConfig;
}

function isSameSerializerReference(
  left?: ApiSerializerReference,
  right?: ApiSerializerReference,
): boolean {
  return (
    !!left &&
    !!right &&
    left.importPath === right.importPath &&
    left.exportName === right.exportName
  );
}

function resolveStandardRouteSerializers(
  apiConfig: unknown,
): ResolvedStandardRouteSerializers {
  const config = getApiConfigObject(apiConfig);
  const itemSerializer = config?.serializers?.item;
  const listItemSerializer =
    config?.serializers?.listItem || config?.serializers?.item;

  const importStatements: string[] = [];
  let itemSerializerName: string | undefined;
  let listItemSerializerName: string | undefined;

  if (itemSerializer) {
    itemSerializerName = 'serializeItemResponse';
    importStatements.push(
      `import { ${itemSerializer.exportName} as ${itemSerializerName} } from '${itemSerializer.importPath}';`,
    );
  }

  if (listItemSerializer) {
    if (isSameSerializerReference(listItemSerializer, itemSerializer)) {
      listItemSerializerName = itemSerializerName;
    } else {
      listItemSerializerName = 'serializeListItemResponse';
      importStatements.push(
        `import { ${listItemSerializer.exportName} as ${listItemSerializerName} } from '${listItemSerializer.importPath}';`,
      );
    }
  }

  return {
    importStatements,
    itemSerializerName,
    listItemSerializerName,
  };
}

function isValidTypeIdentifier(name: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name);
}

function resolveObjectTypeReference(
  projectRoot: string,
  className: string,
  objectDef: SmartObjectDefinition | undefined,
  options: SvelteKitOptions,
  routeDir?: string,
): GeneratedTypeReference {
  const simpleClassName = extractSimpleClassName(className);

  if (!objectDef || !isValidTypeIdentifier(simpleClassName)) {
    return { typeName: "import('@happyvertical/smrt-core').SmrtObject" };
  }

  const importPath =
    isLocalObject(projectRoot, objectDef) || !objectDef.packageName
      ? getRouteTypeImportPath(
          projectRoot,
          objectDef,
          options,
          simpleClassName,
          routeDir,
        )
      : objectDef.packageName;

  return {
    typeName: simpleClassName,
    importStatement: `import type { ${simpleClassName} } from '${importPath}';`,
  };
}

function getRouteTypeImportPath(
  projectRoot: string,
  objectDef: SmartObjectDefinition,
  options: SvelteKitOptions,
  simpleClassName: string,
  routeDir?: string,
): string {
  if (objectDef.filePath) {
    const srcLibDir = join(projectRoot, 'src/lib');
    if (objectDef.filePath.startsWith(`${srcLibDir}/`)) {
      const libRelative = relative(srcLibDir, objectDef.filePath)
        .replace(/\\/g, '/')
        .replace(/\.(ts|js|tsx|jsx)$/, '');
      return `$lib/${libRelative}`.replace(/\/+/g, '/');
    }

    if (routeDir) {
      const routeRelative = relative(routeDir, objectDef.filePath)
        .replace(/\\/g, '/')
        .replace(/\.(ts|js|tsx|jsx)$/, '');
      return routeRelative.startsWith('.')
        ? routeRelative
        : `./${routeRelative}`;
    }
  }

  return getSvelteKitImportPath(
    projectRoot,
    objectDef.filePath,
    options.objectsDir,
    simpleClassName,
  );
}

function mergeImportStatements(
  importStatements: Array<string | undefined>,
): string {
  return Array.from(new Set(importStatements.filter(Boolean))).join('\n');
}

function findObjectDefByRegistryKey(
  manifest: SmartObjectManifest,
  className: string,
): SmartObjectDefinition | undefined {
  return (
    manifest.objects[className] ??
    Object.values(manifest.objects).find(
      (objectDef) => objectDef.className === extractSimpleClassName(className),
    )
  );
}

/**
 * Collect property names marked `@field({ readonly: true })` for an object, so
 * the generated write surfaces can strip them from request bodies (#1540, 2b).
 */
function collectReadonlyFieldNames(objectDef: SmartObjectDefinition): string[] {
  const fields = objectDef.fields || {};
  const names: string[] = [];
  for (const [name, def] of Object.entries(fields)) {
    const meta = (def as { _meta?: Record<string, unknown> })._meta;
    if (
      (def as { readonly?: boolean }).readonly === true ||
      meta?.readonly === true
    ) {
      names.push(name);
    }
  }
  return names;
}

/**
 * Resolve the optional `@smrt({ api: { writable: [...] } })` allowlist. When
 * present, only these fields may be set from a create/update request body.
 */
function getApiWritableAllowlist(apiConfig: unknown): string[] | null {
  const config = getApiConfigObject(apiConfig);
  return Array.isArray(config?.writable) ? config.writable : null;
}

/**
 * Emit the mass-assignment guard helper injected into generated route files
 * (#1540, 2b). It strips framework/server-managed (`id`, `tenantId`,
 * timestamps, `_`-prefixed) and `@field({ readonly: true })` fields from
 * request bodies, and — when a `writable` allowlist is configured — intersects
 * with it. Applied to every generated `create`/`update` handler.
 */
function generateWritablePolicyHelper(
  objectDef: SmartObjectDefinition,
): string {
  const readonly = collectReadonlyFieldNames(objectDef);
  const writable = getApiWritableAllowlist(objectDef.decoratorConfig?.api);

  return `
// Mass-assignment guard (#1540): strip framework/server-managed + read-only
// fields from create/update request bodies before they reach the model.
const WRITABLE_ALLOWLIST: string[] | null = ${
    writable ? JSON.stringify(writable) : 'null'
  };
const READONLY_FIELDS: string[] = ${JSON.stringify(readonly)};
const SERVER_MANAGED_FIELDS = [
  'id',
  'tenantId',
  'tenant_id',
  'createdAt',
  'created_at',
  'updatedAt',
  'updated_at',
];

function applyWritablePolicy(data: unknown): Record<string, unknown> {
  if (!data || typeof data !== 'object') return {};
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    if (key.startsWith('_')) continue;
    if (SERVER_MANAGED_FIELDS.includes(key)) continue;
    if (READONLY_FIELDS.includes(key)) continue;
    if (WRITABLE_ALLOWLIST && !WRITABLE_ALLOWLIST.includes(key)) continue;
    result[key] = value;
  }
  return result;
}
`;
}

/**
 * Resolve the `@smrt({ api: { public } })` posture (fail-closed default).
 * - `false`/unset → all routes require an authenticated principal.
 * - `true` → all routes are public.
 * - `'read'` → reads are public, mutations still require auth.
 */
function getApiPublicAccess(apiConfig: unknown): boolean | 'read' {
  const config = getApiConfigObject(apiConfig);
  const value = config?.public;
  if (value === true || value === 'read') {
    return value;
  }
  return false;
}

function toFieldColumnAlias(fieldName: string): string {
  return fieldName
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/([a-z\d])([A-Z])/g, '$1_$2')
    .replace(/[-\s]+/g, '_')
    .toLowerCase();
}

function manifestObjectKey(objectDef: SmartObjectDefinition): string {
  return objectDef.qualifiedName ?? objectDef.className;
}

function manifestObjectExtends(
  objectDef: SmartObjectDefinition,
  parent: SmartObjectDefinition,
): boolean {
  const extendsQualified = objectDef.extendsQualified;
  const extendsName = objectDef.extends;
  return (
    (typeof extendsQualified === 'string' &&
      extendsQualified === parent.qualifiedName) ||
    (typeof extendsName === 'string' &&
      (extendsName === parent.className ||
        extendsName === parent.qualifiedName))
  );
}

function findManifestParent(
  objectDef: SmartObjectDefinition,
  manifest: SmartObjectManifest,
): SmartObjectDefinition | undefined {
  return Object.values(manifest.objects).find((candidate) =>
    manifestObjectExtends(objectDef, candidate),
  );
}

function collectStiHierarchyObjects(
  objectDef: SmartObjectDefinition,
  manifest?: SmartObjectManifest,
): SmartObjectDefinition[] {
  if (!manifest) return [objectDef];

  let cursor: SmartObjectDefinition | undefined = objectDef;
  let stiBase: SmartObjectDefinition | undefined =
    cursor.decoratorConfig?.tableStrategy === 'sti' ? cursor : undefined;
  while (cursor) {
    const parent = findManifestParent(cursor, manifest);
    if (!parent) break;
    if (parent.decoratorConfig?.tableStrategy === 'sti') {
      stiBase = parent;
    }
    cursor = parent;
  }

  if (!stiBase) return [objectDef];

  const members = new Map<string, SmartObjectDefinition>();
  const visit = (current: SmartObjectDefinition) => {
    const key = manifestObjectKey(current);
    if (members.has(key)) return;
    members.set(key, current);
    for (const candidate of Object.values(manifest.objects)) {
      if (candidate === current) continue;
      if (manifestObjectExtends(candidate, current)) {
        visit(candidate);
      }
    }
  };

  visit(stiBase);
  return [...members.values()];
}

function collectReadPermissionFields(
  objectDef: SmartObjectDefinition,
  manifest?: SmartObjectManifest,
): Array<[string, string]> {
  const result: Array<[string, string]> = [];
  const seen = new Set<string>();
  for (const member of collectStiHierarchyObjects(objectDef, manifest)) {
    for (const [name, def] of Object.entries(member.fields ?? {})) {
      const permission =
        typeof def.readPermission === 'string'
          ? def.readPermission
          : typeof def._meta?.readPermission === 'string'
            ? def._meta.readPermission
            : undefined;
      if (!permission) continue;
      for (const fieldName of [name, toFieldColumnAlias(name)]) {
        const key = `${fieldName}\0${permission}`;
        if (seen.has(key)) continue;
        seen.add(key);
        result.push([fieldName, permission]);
      }
    }
  }
  return result;
}

/**
 * Emit the fail-closed authorization guard injected into generated route files
 * (#1540, 2c). Every generated CRUD/action handler calls `requireRouteAuth`,
 * which throws 401 unless the route is `public` or `locals` carries an
 * authenticated principal. Mirrors the knowledge-route `isKnowledgeAdmin`
 * precedent. Mutating verbs require auth even when reads are public.
 */
function generateAuthGuardHelper(
  objectDef: SmartObjectDefinition,
  manifest?: SmartObjectManifest,
): string {
  const publicAccess = getApiPublicAccess(objectDef.decoratorConfig?.api);
  const readPermissionFields = collectReadPermissionFields(objectDef, manifest);

  return `
// Fail-closed authorization (#1540): generated routes require an authenticated
// principal on \`locals\` unless explicitly marked \`@smrt({ api: { public } })\`.
const PUBLIC_ACCESS: boolean | 'read' = ${JSON.stringify(publicAccess)};
const READ_PERMISSION_FIELDS: Array<[string, string]> = ${JSON.stringify(readPermissionFields)};

interface PublicJsonOptions {
  permissions?: Iterable<string>;
}

function hasAuthenticatedPrincipal(locals: unknown): boolean {
  if (!locals || typeof locals !== 'object') return false;
  const l = locals as Record<string, unknown>;
  // Only a resolved, object-shaped principal counts. We intentionally do NOT
  // treat \`locals.auth\` as a signal: Auth.js/SvelteKit put a callable
  // \`auth()\` helper on every request (including anonymous ones), so honoring
  // it would fail OPEN. Booleans don't count either (no convention sets
  // \`locals.user = true\`); the only boolean accepted is the explicit
  // \`smrtAuth\` opt-in marker.
  const isResolvedPrincipal = (v: unknown) =>
    typeof v === 'object' && v !== null;
  return (
    isResolvedPrincipal(l.user) ||
    isResolvedPrincipal(l.session) ||
    l.smrtAuth === true
  );
}

function requireRouteAuth(locals: unknown, mutating: boolean): void {
  if (PUBLIC_ACCESS === true) return;
  if (PUBLIC_ACCESS === 'read' && !mutating) return;
  if (!hasAuthenticatedPrincipal(locals)) {
    throw error(401, 'Authentication required');
  }
}

function getPublicJsonOptions(locals: unknown): PublicJsonOptions {
  const l = readJsonRecord(locals);
  const permissions = l.permissions ?? l.permissionSet ?? l.smrtPermissions;
  if (Array.isArray(permissions) || permissions instanceof Set) {
    return { permissions };
  }
  return {};
}

function hasReadPermission(
  options: PublicJsonOptions,
  permission: string,
): boolean {
  if (!options.permissions) return false;
  for (const granted of options.permissions) {
    if (granted === permission) return true;
  }
  return false;
}

function applyReadPermissionRedaction(
  value: unknown,
  options: PublicJsonOptions,
  seen: WeakSet<object> = new WeakSet(),
): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return null;
  if (hasPublicJson(value)) {
    seen.add(value);
    return applyReadPermissionRedaction(
      value.toPublicJSON(options),
      options,
      seen,
    );
  }
  if (Array.isArray(value)) {
    seen.add(value);
    return value.map((entry) =>
      applyReadPermissionRedaction(entry, options, seen),
    );
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;
  seen.add(value);
  const out = { ...(value as Record<string, unknown>) };
  const metaData =
    out._meta_data && typeof out._meta_data === 'object'
      ? { ...(out._meta_data as Record<string, unknown>) }
      : null;
  for (const [fieldName, permission] of READ_PERMISSION_FIELDS) {
    if (hasReadPermission(options, permission)) continue;
    delete out[fieldName];
    if (metaData) delete metaData[fieldName];
  }
  if (metaData) out._meta_data = metaData;
  for (const [key, entry] of Object.entries(out)) {
    out[key] = applyReadPermissionRedaction(entry, options, seen);
  }
  return out;
}

// Sensitive-field-safe serialization for custom-action results (#1540): a
// custom method may return a SmrtObject (or one nested in an array/plain
// object), so recurse and route each through toPublicJSON() rather than letting
// JSON.stringify call toJSON(). Non-plain instances (Date, etc.) and primitives
// pass through; a cycle guard prevents infinite loops.
interface PublicJsonSource {
  toPublicJSON(options?: PublicJsonOptions): unknown;
}

function hasPublicJson(value: object): value is PublicJsonSource {
  return (
    'toPublicJSON' in value &&
    typeof (value as { toPublicJSON?: unknown }).toPublicJSON === 'function'
  );
}

function readJsonRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function toPublicResult(
  value: unknown,
  options: PublicJsonOptions,
  seen: WeakSet<object> = new WeakSet(),
): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return null;
  if (hasPublicJson(value)) {
    seen.add(value);
    return toPublicResult(value.toPublicJSON(options), options, seen);
  }
  if (Array.isArray(value)) {
    seen.add(value);
    return value.map((entry) => toPublicResult(entry, options, seen));
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;
  seen.add(value);
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(
    value as Record<string, unknown>,
  )) {
    out[key] = toPublicResult(entry, options, seen);
  }
  return out;
}
`;
}

/**
 * Whether an object is `@TenantScoped` (carries a `tenantScoped` config in its
 * `@smrt()`/`@TenantScoped()` decorator). Drives tenant-context establishment in
 * generated routes (#1540, facet 2).
 */
function isTenantScoped(objectDef: SmartObjectDefinition): boolean {
  return !!objectDef.decoratorConfig?.tenantScoped;
}

/**
 * Emit the tenant-context establishment + fail-closed read-scope helpers for
 * `@TenantScoped` objects (#1540 facet 2; #1782). Generated handlers call
 * `establishTenantContext(locals)` after the auth guard so every query runs
 * inside the tenant context derived from the authenticated principal — engaging
 * the `@TenantScoped` interceptors that auto-filter by tenant.
 *
 * `establishTenantContext` reads the canonical `locals.tenantId` set by the
 * smrt-users auth hook (with `user`/`session` fallbacks). It is a no-op when a
 * context is already active (e.g. an upstream tenancy handle) or when the
 * request carries no tenant (anonymous / global principal).
 *
 * When no context could be established, an `optional`-mode read would otherwise
 * fall through the interceptor UNFILTERED and return rows from ALL tenants (the
 * interceptor only hard-fails `required` mode) — the #1782 leak. So read
 * handlers additionally call `tenantReadScope()`, which restricts reads to
 * NULL-tenant (global) rows only when tenancy is enabled but no context is
 * active. Both helpers are imported only for tenant-scoped routes, which already
 * depend on `@happyvertical/smrt-tenancy`.
 */
function generateTenantContextHelper(): string {
  return `
import { enterTenantContext, getCurrentTenant, hasTenantContext, isSuperAdminBypass, isTenancyEnabled } from '@happyvertical/smrt-tenancy';

function establishTenantContext(locals: unknown): void {
  if (hasTenantContext()) return;
  if (!locals || typeof locals !== 'object') return;
  const l = locals as Record<string, unknown>;
  const user = l.user as Record<string, unknown> | undefined;
  const session = l.session as Record<string, unknown> | undefined;
  const tenantId = l.tenantId ?? user?.tenantId ?? session?.tenantId;
  if (typeof tenantId === 'string' && tenantId) {
    enterTenantContext({ tenantId });
  }
}

// Fail-closed read scope (#1782): a public/anonymous read on a @TenantScoped
// model has no tenant context, so the tenancy interceptor (optional mode) would
// pass the query through UNFILTERED and return every tenant's rows. When tenancy
// is enabled but no context was established, restrict reads to NULL-tenant
// (global) rows only — mirroring the dispatch resolver + _changes convention:
// tenancy enforced with no context => global rows only. Returns undefined when a
// context is active (the interceptor filters by it) or tenancy is disabled.
function tenantReadScope(): { tenantId: null } | undefined {
  return isTenancyEnabled() && !hasTenantContext()
    ? { tenantId: null }
    : undefined;
}

// Custom GET actions that accept a single options object may perform their
// own reads instead of calling generated list/get handlers. Give those actions
// an explicit tenant scope: active tenant when present, NULL-tenant global rows
// when tenancy is enabled but no tenant context exists. Super-admin bypass
// stays unscoped so admin callers keep deliberate cross-tenant access.
function tenantReadOptionsScope(): { tenantId: string | null } | undefined {
  if (!isTenancyEnabled() || isSuperAdminBypass()) {
    return undefined;
  }
  return { tenantId: getCurrentTenant()?.tenantId ?? null };
}
`;
}

/**
 * The per-handler guard preamble: the fail-closed auth check (#1540 2c) plus, for
 * tenant-scoped objects, tenant-context establishment (#1540 facet 2).
 */
function routeGuardPreamble(
  objectDef: SmartObjectDefinition,
  mutating: boolean,
): string {
  const lines = [`  requireRouteAuth(locals, ${mutating});`];
  if (isTenantScoped(objectDef)) {
    lines.push('  establishTenantContext(locals);');
  }
  return lines.join('\n');
}

function normalizeApiHttpMethod(method?: string): ApiHttpMethod {
  switch (method?.toUpperCase()) {
    case 'GET':
    case 'POST':
    case 'PUT':
    case 'PATCH':
    case 'DELETE':
      return method.toUpperCase() as ApiHttpMethod;
    default:
      return 'POST';
  }
}

/**
 * Convert a camelCase / PascalCase method name to a kebab-case URL segment.
 * Examples:
 *   discoverFromUrl -> discover-from-url
 *   XMLExport       -> xml-export
 *   URL             -> url
 *   a1B2c3          -> a1-b2c3
 *
 * Known limitation: consecutive uppercase acronyms aren't split apart, e.g.
 * `HTMLAPIExport` becomes `htmlapi-export` rather than `html-api-export`.
 * Override with an explicit `api.routes[name].path` if you need a specific
 * segmentation.
 */
export function methodNameToKebab(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
    .toLowerCase();
}

function normalizeCustomRoutePath(
  actionName: string,
  path?: string,
  options: { kebabRoutes?: boolean } = {},
): string[] {
  // Explicit path override always wins, and is used verbatim (split on /).
  if (path) {
    const segments = path
      .split('/')
      .map((segment) => segment.trim())
      .filter(Boolean);
    if (segments.length > 0) {
      return segments;
    }
  }

  const segment = options.kebabRoutes
    ? methodNameToKebab(actionName)
    : actionName;
  return [segment];
}

function extractRoutePathParamNames(pathSegments: string[]): string[] {
  return pathSegments
    .filter((segment) => /^\[[^\]]+\]$/.test(segment))
    .map((segment) => segment.slice(1, -1))
    .filter(Boolean);
}

function resolveApiActionRouteConfig(
  actionName: string,
  actionDef: { isStatic?: boolean },
  apiConfig: unknown,
  routeOptions: { kebabRoutes?: boolean } = {},
  defaultScope: 'item' | 'collection' = actionDef.isStatic
    ? 'collection'
    : 'item',
): ResolvedApiActionRouteConfig {
  const config = getApiConfigObject(apiConfig);
  const routeConfig: ApiCustomRouteConfig | undefined =
    config?.routes?.[actionName];

  const pathSegments = normalizeCustomRoutePath(
    actionName,
    routeConfig?.path,
    routeOptions,
  );

  return {
    scope: routeConfig?.scope || defaultScope,
    method: normalizeApiHttpMethod(routeConfig?.method),
    pathSegments,
    pathParamNames: extractRoutePathParamNames(pathSegments),
  };
}

function buildRouteHandlerArgs(
  includeParams: boolean,
  includeRequest: boolean,
): string {
  // `locals` is always destructured so the fail-closed auth guard (#1540) can
  // inspect the authenticated principal.
  const args: string[] = ['locals'];

  if (includeParams) {
    args.push('params');
  }

  if (includeRequest) {
    args.push('request');
  }

  return `{ ${args.join(', ')} }`;
}

function buildPathParamsObjectLiteral(pathParamNames: string[]): string {
  if (pathParamNames.length === 0) {
    return '{}';
  }

  return `{
${pathParamNames
  .map(
    (paramName) =>
      `    ${buildObjectTypeProperty(paramName)}: ${buildRouteParamAccess(paramName)},`,
  )
  .join('\n')}
  }`;
}

function hasSingleOptionsParameter(actionDef: MethodDefinition): boolean {
  const parameters = Array.isArray(actionDef.parameters)
    ? actionDef.parameters
    : [];

  return parameters.length === 1 && parameters[0]?.name === 'options';
}

function buildActionInvocationArgs(
  actionDef: MethodDefinition,
  optionsIdentifier = 'options',
): string[] {
  const parameters = Array.isArray(actionDef.parameters)
    ? actionDef.parameters
    : [];

  if (parameters.length === 0) {
    return [];
  }

  if (hasSingleOptionsParameter(actionDef)) {
    return [optionsIdentifier];
  }

  return parameters.map((parameter) =>
    buildOptionsPropertyAccess(parameter.name),
  );
}

function buildObjectTypeProperty(propertyName: string): string {
  if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(propertyName)) {
    return propertyName;
  }

  return JSON.stringify(propertyName);
}

function buildSingleQuotedStringLiteral(value: string): string {
  return `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
}

function buildRouteParamAccess(paramName: string): string {
  if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(paramName)) {
    return `params.${paramName}`;
  }

  return `params[${buildSingleQuotedStringLiteral(paramName)}]`;
}

function buildActionTargetTypeExpression(
  targetTypeName: string,
  isStatic: boolean,
): string {
  return isStatic ? `(typeof ${targetTypeName})` : targetTypeName;
}

function buildActionArgsTypeAlias(
  actionName: string,
  targetTypeName: string,
  isStatic: boolean,
): string {
  const targetTypeExpression = buildActionTargetTypeExpression(
    targetTypeName,
    isStatic,
  );
  return `  type ActionArgs = Parameters<${targetTypeExpression}[${buildSingleQuotedStringLiteral(actionName)}]>;`;
}

function buildActionOptionsTypeAlias(actionDef: MethodDefinition): string {
  const parameters = Array.isArray(actionDef.parameters)
    ? actionDef.parameters
    : [];

  if (parameters.length <= 1 && parameters[0]?.name === 'options') {
    return '';
  }

  return [
    '  type ActionOptions = {',
    ...parameters.map(
      (parameter, index) =>
        `    ${buildObjectTypeProperty(parameter.name)}: ActionArgs[${index}];`,
    ),
    '  };',
  ].join('\n');
}

function buildActionOptionsLoad(
  actionName: string,
  actionDef: MethodDefinition,
  routeConfig: ResolvedApiActionRouteConfig,
  targetTypeName: string,
  isStatic: boolean,
): string {
  const parameters = Array.isArray(actionDef.parameters)
    ? actionDef.parameters
    : [];
  if (parameters.length === 0) {
    return '';
  }

  const hasPathParams = routeConfig.pathParamNames.length > 0;
  const pathParamsObjectLiteral = buildPathParamsObjectLiteral(
    routeConfig.pathParamNames,
  );
  const isSingleOptionsParameter =
    parameters.length === 1 && parameters[0]?.name === 'options';
  const lines = [
    buildActionArgsTypeAlias(actionName, targetTypeName, isStatic),
  ];
  const optionsTypeAlias = buildActionOptionsTypeAlias(actionDef);
  if (optionsTypeAlias) {
    lines.push(optionsTypeAlias);
  }

  if (routeConfig.method === 'GET') {
    if (hasPathParams) {
      lines.push(
        `  const pathParams = ${pathParamsObjectLiteral};`,
        '  const options = {',
        '    ...Object.fromEntries(new URL(request.url).searchParams.entries()),',
        '    ...pathParams,',
        `  } as ${isSingleOptionsParameter ? 'ActionArgs[0]' : 'ActionOptions'};`,
        '',
      );
    } else {
      lines.push(
        '  const options = Object.fromEntries(',
        '    new URL(request.url).searchParams.entries(),',
        `  ) as ${isSingleOptionsParameter ? 'ActionArgs[0]' : 'ActionOptions'};`,
        '',
      );
    }
    return lines.join('\n');
  }

  if (hasPathParams) {
    lines.push(
      `  const pathParams = ${pathParamsObjectLiteral};`,
      '  const body: unknown = await request.json();',
      '  const options = {',
      '    ...readJsonRecord(body),',
      '    ...pathParams,',
      `  } as ${isSingleOptionsParameter ? 'ActionArgs[0]' : 'ActionOptions'};`,
      '',
    );
    return lines.join('\n');
  }

  lines.push('  const body: unknown = await request.json();');
  if (isSingleOptionsParameter) {
    lines.push('  const options = body as ActionArgs[0];', '');
  } else {
    lines.push('  const options = readJsonRecord(body) as ActionOptions;', '');
  }
  return lines.join('\n');
}

function buildOptionsPropertyAccess(propertyName: string): string {
  if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(propertyName)) {
    return `options.${propertyName}`;
  }

  const escapedPropertyName = propertyName
    .replaceAll('\\', '\\\\')
    .replaceAll("'", "\\'");

  return `options['${escapedPropertyName}']`;
}

function buildActionInvocationExpression(
  receiverExpression: string,
  actionName: string,
  invocationArgs: string[],
): string {
  const singleLineInvocation = `await ${receiverExpression}.${actionName}(${invocationArgs.join(', ')})`;
  const singleLineResultAssignment = `  const result = ${singleLineInvocation};`;

  if (singleLineResultAssignment.length <= 100) {
    return singleLineInvocation;
  }

  return [
    `await ${receiverExpression}.${actionName}(`,
    ...invocationArgs.map((argument) => `    ${argument},`),
    '  )',
  ].join('\n');
}

function buildScopedOptionsForTenantRead(
  actionDef: MethodDefinition,
  routeConfig: ResolvedApiActionRouteConfig,
  tenantScoped: boolean,
): { source: string; optionsIdentifier: string } {
  // The generator can only pass tenant read scope to methods that expose an
  // options object. Zero-argument methods that perform their own raw reads must
  // infer tenant scope in their implementation or adopt the options contract.
  if (
    !tenantScoped ||
    routeConfig.method !== 'GET' ||
    !hasSingleOptionsParameter(actionDef)
  ) {
    return { source: '', optionsIdentifier: 'options' };
  }

  return {
    source: `  const readScope = tenantReadOptionsScope();
  const scopedOptions = readScope
    ? ({ ...options, ...readScope } as ActionArgs[0])
    : options;

`,
    optionsIdentifier: 'scopedOptions',
  };
}

function findItemClassRegistryKey(
  className: string,
  objectDef: SmartObjectDefinition,
  manifest: SmartObjectManifest,
): string {
  const itemClassName =
    objectDef.extendsTypeArg ||
    (className.endsWith('Collection')
      ? className.slice(0, -'Collection'.length)
      : undefined);

  if (!itemClassName) {
    return className;
  }

  const manifestMatch = Object.entries(manifest.objects).find(
    ([manifestKey, candidate]) =>
      manifestKey === itemClassName || candidate.className === itemClassName,
  );

  return manifestMatch?.[0] || itemClassName;
}

function groupCustomActionRoutes(
  actionSpecs: Array<{
    routeDir: string;
    spec: GeneratedActionRouteSpec;
  }>,
): Map<string, GeneratedActionRouteSpec[]> {
  const groupedRoutes = new Map<string, GeneratedActionRouteSpec[]>();

  for (const { routeDir, spec } of actionSpecs) {
    const existing = groupedRoutes.get(routeDir) || [];
    const duplicateMethod = existing.find(
      (candidate) => candidate.routeConfig.method === spec.routeConfig.method,
    );

    if (duplicateMethod) {
      throw new Error(
        `Duplicate custom API route handler for ${routeDir} (${spec.routeConfig.method}). ` +
          `Methods ${duplicateMethod.actionName} and ${spec.actionName} resolve to the same generated route.`,
      );
    }

    existing.push(spec);
    groupedRoutes.set(routeDir, existing);
  }

  return groupedRoutes;
}

/**
 * Generates SvelteKit API routes from manifest
 */
export async function generateSvelteKitRoutes(
  projectRoot: string,
  manifest: SmartObjectManifest,
  options: SvelteKitOptions,
): Promise<void> {
  if (!options.enabled) return;

  console.log('[smrt] Generating SvelteKit routes...');

  clearGeneratedRouteFiles(join(projectRoot, options.routesDir));
  clearGeneratedKnowledgeRoute(projectRoot, options);

  // Generate centralized configuration file first (if it doesn't exist)
  await generateSmrtConfigFile(projectRoot, manifest, options);

  let generatedCount = 0;
  let skippedCollections = 0;
  for (const [className, objectDef] of Object.entries(manifest.objects)) {
    if (isCollectionClass(objectDef)) {
      const generatedCollectionRoutes = await generateCollectionRoutesForObject(
        projectRoot,
        className,
        objectDef,
        manifest,
        options,
      );
      if (generatedCollectionRoutes) {
        generatedCount++;
      } else {
        console.log(
          `[smrt] Skipping ${className} - no collection API routes to generate`,
        );
        skippedCollections++;
      }
      continue;
    }
    await generateRoutesForObject(
      projectRoot,
      className,
      objectDef,
      manifest,
      options,
    );
    generatedCount++;
  }

  if (options.knowledge?.api?.enabled) {
    generateKnowledgeRoute(projectRoot, options);
  }

  // Batch write contract route (#1759): {routesDir}/sync/apply/+server.ts.
  generateSyncApplyRoute(projectRoot, manifest, options);
  // Change-feed route (#1758) — cleanup rides clearGeneratedRouteFiles above.
  generateChangesRoute(projectRoot, manifest, options);
  // Live change-signal SSE route (#1763) — cleanup rides the sweep above.
  generateEventsRoute(projectRoot, manifest, options);

  // Update .gitignore to exclude generated routes
  updateGitignore(projectRoot, options);

  const skippedMsg =
    skippedCollections > 0
      ? ` (skipped ${skippedCollections} collection classes)`
      : '';
  console.log(
    `[smrt] Generated routes for ${generatedCount} SMRT objects${skippedMsg}`,
  );
}

function clearGeneratedRouteFiles(routesRoot: string): void {
  if (!existsSync(routesRoot)) {
    return;
  }

  for (const entry of readdirSync(routesRoot, { withFileTypes: true })) {
    const entryPath = join(routesRoot, entry.name);

    if (entry.isDirectory()) {
      clearGeneratedRouteFiles(entryPath);
      continue;
    }

    if (!entry.isFile() || entry.name !== '+server.ts') {
      continue;
    }

    const fileContent = readFileSync(entryPath, 'utf-8');
    if (fileContent.startsWith(AUTO_GENERATED_ROUTE_HEADER)) {
      unlinkSync(entryPath);
    }
  }
}

function knowledgeRouteDir(projectRoot: string, options: SvelteKitOptions) {
  const basePath = String(
    options.knowledge?.api?.basePath || '/__smrt/knowledge',
  );
  const routeRoot = svelteKitRouteRoot(options.routesDir);
  const segments = basePath
    .split('/')
    .map((segment) => segment.trim())
    .filter(Boolean);

  return join(projectRoot, routeRoot, ...segments);
}

function svelteKitRouteRoot(routesDir: string): string {
  const normalized = routesDir.replaceAll('\\', '/').replace(/\/+$/, '');
  const marker = '/routes';
  const markerIndex = normalized.indexOf(marker);

  if (normalized === 'src/routes' || normalized.endsWith('/routes')) {
    return normalized;
  }
  if (markerIndex !== -1) {
    return normalized.slice(0, markerIndex + marker.length);
  }
  return 'src/routes';
}

function clearGeneratedKnowledgeRoute(
  projectRoot: string,
  options: SvelteKitOptions,
): void {
  const routeDir = knowledgeRouteDir(projectRoot, options);
  const routePath = join(routeDir, '+server.ts');
  if (!existsSync(routePath)) return;

  const content = readFileSync(routePath, 'utf-8');
  if (content.startsWith(AUTO_GENERATED_ROUTE_HEADER)) {
    unlinkSync(routePath);
  }
}

function generateKnowledgeRoute(
  projectRoot: string,
  options: SvelteKitOptions,
): void {
  const routeDir = knowledgeRouteDir(projectRoot, options);
  const route = generateKnowledgeRouteTemplate(
    options.knowledge ?? {},
    readKnowledgeRouteArtifact(projectRoot),
  );
  writeRoute(routeDir, '+server.ts', route);
}

function readKnowledgeRouteArtifact(
  projectRoot: string,
): Record<string, unknown> | null {
  for (const relativePath of [
    '.smrt/smrt-knowledge.json',
    'dist/smrt-knowledge.json',
  ]) {
    const fullPath = join(projectRoot, relativePath);
    if (!existsSync(fullPath)) continue;
    try {
      return JSON.parse(readFileSync(fullPath, 'utf-8'));
    } catch {
      return null;
    }
  }

  return null;
}

/**
 * Generates SMRT object registration file
 * This file imports all SMRT objects to trigger their @smrt() decorators
 */
async function generateRegistrationFile(
  projectRoot: string,
  manifest: SmartObjectManifest,
  options: SvelteKitOptions,
): Promise<void> {
  const configPath = options.configPath || 'src/lib/server';
  const configDir = join(projectRoot, configPath);
  const registrationFilePath = join(configDir, 'smrt-register.ts');

  // Group objects by package for efficient imports
  const localObjects: Array<[string, (typeof manifest.objects)[string]]> = [];
  const packageObjects = new Map<
    string,
    { classNames: string[]; hasCollectionImport: boolean }
  >();

  for (const [className, objectDef] of Object.entries(manifest.objects)) {
    if (isLocalObject(projectRoot, objectDef)) {
      // Local object (source in project, not node_modules) - use $lib path
      localObjects.push([className, objectDef]);
    } else if (objectDef.packageName) {
      // External package - group by package name
      const packageEntry = packageObjects.get(objectDef.packageName) || {
        classNames: [],
        hasCollectionImport: false,
      };

      if (isCollectionClass(objectDef)) {
        packageEntry.hasCollectionImport = true;
      } else {
        packageEntry.classNames.push(className);
      }

      packageObjects.set(objectDef.packageName, packageEntry);
    } else {
      // No package name and not local - treat as local fallback
      localObjects.push([className, objectDef]);
    }
  }

  // Generate imports for local objects
  // Issue #870: Extract simple class names from qualified names
  const localNamedImports = new Map<string, string[]>();
  const localSideEffectImports = new Set<string>();

  for (const [className, objectDef] of localObjects) {
    const simpleClassName = extractSimpleClassName(className);

    // Calculate direct relative path from the configDir where smrt-register.ts lives
    // to the actual source file of the object.
    let importPath = '';
    if (objectDef.filePath) {
      const relativeToConfig = relative(configDir, objectDef.filePath);
      const normalized = relativeToConfig
        .replace(/\\/g, '/')
        .replace(/\.(ts|js|tsx|jsx)$/, '');
      importPath = normalized.startsWith('.') ? normalized : `./${normalized}`;
    } else {
      // Fallback for missing file paths
      importPath = getSvelteKitImportPath(
        projectRoot,
        undefined,
        options.objectsDir,
        simpleClassName,
      );
    }

    if (isCollectionClass(objectDef)) {
      localSideEffectImports.add(importPath);
      continue;
    }

    const existing = localNamedImports.get(importPath) ?? [];
    existing.push(simpleClassName);
    localNamedImports.set(importPath, existing);
  }

  const localImports = [
    ...Array.from(localNamedImports.entries())
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([importPath, simpleNames]) => {
        const sortedNames = simpleNames.sort((a, b) => a.localeCompare(b));
        return `import { ${sortedNames.join(', ')} } from '${importPath}';`;
      }),
    ...Array.from(localSideEffectImports.values())
      .sort((a, b) => a.localeCompare(b))
      .map((importPath) => `import '${importPath}';`),
  ].join('\n');

  // Generate imports for external packages
  // Issue #870: Extract simple class names from qualified names
  const packageImports = Array.from(packageObjects.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([packageName, packageEntry]) => {
      const imports: string[] = [];

      if (packageEntry.hasCollectionImport) {
        imports.push(`import '${packageName}';`);
      }

      if (packageEntry.classNames.length > 0) {
        // Extract simple class names for valid import syntax
        const simpleNames = packageEntry.classNames
          .map(extractSimpleClassName)
          .sort((a, b) => a.localeCompare(b));
        imports.push(
          `import { ${simpleNames.join(', ')} } from '${packageName}';`,
        );
      }

      return imports;
    })
    .join('\n');

  const imports = [packageImports, localImports].filter(Boolean).join('\n');
  const registrations = Object.entries(manifest.objects)
    .map(([className, objectDef]) => {
      if (isCollectionClass(objectDef)) {
        // Importing the collection class is enough to trigger its decorator.
        // Explicit package-qualified re-registration only applies to object
        // classes, because ObjectRegistry.register() is object-only.
        return null;
      }

      const simpleClassName = extractSimpleClassName(className);
      const localObject = isLocalObject(projectRoot, objectDef);
      const packageName = getRegistrationPackageName(
        manifest,
        objectDef,
        localObject,
      );

      if (!packageName) {
        return null;
      }

      const packageNameLiteral = toSingleQuotedStringLiteral(packageName);
      const singleLineRegistration = `ObjectRegistry.register(${simpleClassName}, { name: '${simpleClassName}', packageName: ${packageNameLiteral} });`;

      if (singleLineRegistration.length <= BIOME_LINE_WIDTH) {
        return singleLineRegistration;
      }

      return [
        `ObjectRegistry.register(${simpleClassName}, {`,
        `  name: '${simpleClassName}',`,
        `  packageName: ${packageNameLiteral},`,
        `});`,
      ].join('\n');
    })
    .filter((registration): registration is string => registration !== null)
    .join('\n');

  const registrationContent = `/**
 * Auto-generated SMRT object registration
 * DO NOT EDIT - changes will be overwritten
 *
 * Importing these modules triggers their @smrt() decorators, which perform
 * the initial registration. The explicit re-registration below is intentional:
 * it upgrades bundled runtimes to deterministic qualified registrations.
 */

import { ObjectRegistry } from '@happyvertical/smrt-core';

${imports}

// Re-register imported objects with explicit package names for bundled runtimes
${registrations}
`;

  // Create directory if it doesn't exist
  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true });
  }

  writeFileSync(registrationFilePath, registrationContent, 'utf-8');
  console.log(`[smrt] Generated registration file: ${registrationFilePath}`);
}

/**
 * Generates centralized SMRT configuration file
 * Only creates if file doesn't exist (preserves user customizations)
 */
async function generateSmrtConfigFile(
  projectRoot: string,
  manifest: SmartObjectManifest,
  options: SvelteKitOptions,
): Promise<void> {
  const configPath = options.configPath || 'src/lib/server';
  const configFileName = options.configFileName || 'smrt.ts';
  const configDir = join(projectRoot, configPath);
  const configFilePath = join(configDir, configFileName);

  // Always generate registration file (it gets overwritten)
  await generateRegistrationFile(projectRoot, manifest, options);

  // Don't overwrite existing config file
  if (existsSync(configFilePath)) {
    console.log('[smrt] Config file already exists, skipping generation');
    return;
  }

  const configContent = `/**
 * Centralized SMRT configuration with per-object overrides
 * Generated by @smrt/core vite plugin
 *
 * Most objects will use the default configuration.
 * Add entries to \`objectOverrides\` for objects that need different backends.
 */

// Import SMRT objects to register them via @smrt() decorators
import './smrt-register.js';

import { ObjectRegistry } from '@happyvertical/smrt-core';
import type { SmrtClassOptions } from '@happyvertical/smrt-core';

declare global {
  // eslint-disable-next-line no-var
  var __smrtGetRequestScopedDatabase:
    | (() => SmrtClassOptions['db'] | undefined)
    | undefined;
}

/**
 * Per-object configuration overrides
 * Define specific backends for objects that differ from project defaults
 *
 * @example
 * const objectOverrides: Record<string, Partial<SmrtClassOptions>> = {
 *   // Analytics uses a separate PostgreSQL database
 *   Analytics: {
 *     db: {
 *       url: process.env.ANALYTICS_DATABASE_URL!,
 *       type: 'postgres'
 *     }
 *   },
 *
 *   // AuditLog uses dedicated database with no AI
 *   AuditLog: {
 *     db: {
 *       url: process.env.AUDIT_DATABASE_URL!,
 *       type: 'postgres'
 *     },
 *     ai: undefined
 *   },
 *
 *   // Cache uses REST adapter (e.g., Redis)
 *   Cache: {
 *     persistence: {
 *       type: 'rest',
 *       baseUrl: process.env.REDIS_URL!
 *     }
 *   }
 * };
 */
const objectOverrides: Record<string, Partial<SmrtClassOptions>> = {
  // Add your per-object configuration overrides here
};

/**
 * Default configuration for most SMRT objects
 * Customize this to change project-wide defaults
 */
function getDefaultConfig(): SmrtClassOptions {
  return {
    db: {
      url: process.env.DATABASE_URL || ':memory:',
      type: (process.env.DATABASE_TYPE as 'sqlite' | 'postgres') || 'sqlite'
    },
    ai: process.env.OPENAI_API_KEY ? {
      type: 'openai',
      apiKey: process.env.OPENAI_API_KEY
    } : process.env.ANTHROPIC_API_KEY ? {
      type: 'anthropic',
      apiKey: process.env.ANTHROPIC_API_KEY
    } : undefined
  };
}

function getRequestScopedDatabase(): SmrtClassOptions['db'] | undefined {
  const getter = globalThis.__smrtGetRequestScopedDatabase;
  return typeof getter === 'function' ? getter() : undefined;
}

/**
 * Get configuration for a specific SMRT object
 * Merges project defaults with per-object overrides if defined
 */
export function getSmrtConfig(className: string): SmrtClassOptions {
  const defaults = getDefaultConfig();
  const override = objectOverrides[className];

  if (override) {
    // Deep merge: override specific properties while keeping defaults
    return {
      ...defaults,
      ...override,
      // Ensure nested objects are merged properly
      db: override.db
        ? { ...(defaults.db as any), ...(override.db as any) }
        : defaults.db,
      ai: override.ai !== undefined ? override.ai : defaults.ai
    };
  }

  return defaults;
}

/**
 * Helper to get a collection with centralized configuration
 * Automatically applies project defaults or object-specific overrides
 */
export async function getCollection<
  T extends import('@happyvertical/smrt-core').SmrtObject,
>(className: string, overrides: Partial<SmrtClassOptions> = {}) {
  const config = getSmrtConfig(className);
  const objectOverride = objectOverrides[className];
  const requestScopedDb =
    !overrides.db && !objectOverride?.db
      ? getRequestScopedDatabase()
      : undefined;

  return await ObjectRegistry.getCollection<T>(
    className,
    {
      ...config,
      ...overrides,
      db: overrides.db
        ? { ...(config.db as any), ...(overrides.db as any) }
        : requestScopedDb ?? config.db,
      ai: overrides.ai !== undefined ? overrides.ai : config.ai
    }
  );
}
`;

  // Create directory if it doesn't exist
  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true });
  }

  writeFileSync(configFilePath, configContent, 'utf-8');
  console.log(`[smrt] Generated configuration file: ${configFilePath}`);
}

/**
 * Generates route files for a single SMRT object
 */
async function generateRoutesForObject(
  projectRoot: string,
  className: string,
  objectDef: SmartObjectDefinition,
  manifest: SmartObjectManifest,
  options: SvelteKitOptions,
): Promise<void> {
  const collectionName = objectDef.collection;
  const routeDir = join(projectRoot, options.routesDir, collectionName);

  // Check if API is enabled for this object
  const apiConfig = objectDef.decoratorConfig?.api;
  if (apiConfig === false) {
    console.log(`[smrt] Skipping ${className} - API disabled`);
    return;
  }

  // Determine which CRUD actions to include via the shared resolver.
  const includedActions = resolveStandardCrudActions(apiConfig);

  // Generate collection route (list, create)
  if (includedActions.includes('list') || includedActions.includes('create')) {
    const collectionRoute = generateCollectionRouteTemplate(
      projectRoot,
      className,
      objectDef,
      manifest,
      includedActions,
      options,
      routeDir,
    );
    writeRoute(routeDir, '+server.ts', collectionRoute);
  }

  // Generate item route (get, update, delete)
  if (
    includedActions.includes('get') ||
    includedActions.includes('update') ||
    includedActions.includes('delete')
  ) {
    const itemRoute = generateItemRouteTemplate(
      projectRoot,
      className,
      objectDef,
      manifest,
      includedActions,
      options,
      join(routeDir, '[id]'),
    );
    writeRoute(join(routeDir, '[id]'), '+server.ts', itemRoute);
  }

  // Generate custom action routes
  const customActions = Object.entries(objectDef.methods).filter(
    ([name, method]) =>
      !STANDARD_API_ACTIONS.includes(name) &&
      method.isPublic &&
      shouldIncludeInApi(name, apiConfig),
  );

  const actionSpecs: Array<{
    routeDir: string;
    spec: GeneratedActionRouteSpec;
  }> = [];

  for (const [actionName, actionDef] of customActions) {
    const routeConfig = resolveApiActionRouteConfig(
      actionName,
      actionDef,
      apiConfig,
      { kebabRoutes: options.kebabRoutes },
    );

    if (routeConfig.scope === 'collection' && !actionDef.isStatic) {
      console.warn(
        `[smrt] Skipping ${className}.${actionName} - collection API routes require a static method`,
      );
      continue;
    }

    const actionBaseDir =
      routeConfig.scope === 'collection' ? routeDir : join(routeDir, '[id]');
    actionSpecs.push({
      routeDir: join(actionBaseDir, ...routeConfig.pathSegments),
      spec: {
        lookupClassName: className,
        lookupObjectDef: objectDef,
        hostClassName: className,
        actionName,
        actionDef,
        routeConfig,
        hostType: 'item',
      },
    });
  }

  for (const [actionRouteDir, routeSpecs] of groupCustomActionRoutes(
    actionSpecs,
  )) {
    const actionRoute = generateActionRouteTemplate(
      projectRoot,
      actionRouteDir,
      routeSpecs,
      objectDef,
      manifest,
      options,
    );
    writeRoute(actionRouteDir, '+server.ts', actionRoute);
  }
}

async function generateCollectionRoutesForObject(
  projectRoot: string,
  className: string,
  objectDef: SmartObjectDefinition,
  manifest: SmartObjectManifest,
  options: SvelteKitOptions,
): Promise<boolean> {
  const apiConfig = objectDef.decoratorConfig?.api;
  if (apiConfig === false) {
    console.log(`[smrt] Skipping ${className} - API disabled`);
    return false;
  }

  const routeDir = join(projectRoot, options.routesDir, objectDef.collection);
  const lookupClassName = findItemClassRegistryKey(
    className,
    objectDef,
    manifest,
  );
  const lookupObjectDef = findObjectDefByRegistryKey(manifest, lookupClassName);

  const customActions = Object.entries(objectDef.methods).filter(
    ([name, method]) =>
      !STANDARD_API_ACTIONS.includes(name) &&
      method.isPublic &&
      shouldIncludeInApi(name, apiConfig),
  );

  if (customActions.length === 0) {
    return false;
  }

  let generatedAnyRoutes = false;
  const actionSpecs: Array<{
    routeDir: string;
    spec: GeneratedActionRouteSpec;
  }> = [];

  for (const [actionName, actionDef] of customActions) {
    const routeConfig = resolveApiActionRouteConfig(
      actionName,
      actionDef,
      apiConfig,
      { kebabRoutes: options.kebabRoutes },
      'collection',
    );

    if (routeConfig.scope !== 'collection') {
      console.warn(
        `[smrt] Skipping ${className}.${actionName} - collection class methods only support collection-scoped API routes`,
      );
      continue;
    }

    actionSpecs.push({
      routeDir: join(routeDir, ...routeConfig.pathSegments),
      spec: {
        lookupClassName,
        lookupObjectDef,
        hostClassName: className,
        actionName,
        actionDef,
        routeConfig,
        hostType: 'collection',
      },
    });
  }

  for (const [actionRouteDir, routeSpecs] of groupCustomActionRoutes(
    actionSpecs,
  )) {
    const actionRoute = generateActionRouteTemplate(
      projectRoot,
      actionRouteDir,
      routeSpecs,
      objectDef,
      manifest,
      options,
    );
    writeRoute(actionRouteDir, '+server.ts', actionRoute);
    generatedAnyRoutes = true;
  }

  return generatedAnyRoutes;
}

/**
 * Resolve the list of standard CRUD actions exposed by the API for a given
 * apiConfig. Single source of truth for both the route generator and the
 * cli↔api coherence lint.
 */
function resolveStandardCrudActions(apiConfig: unknown): string[] {
  if (apiConfig === false) return [];
  if (apiConfig === true || apiConfig === undefined) {
    return [...STANDARD_API_ACTIONS];
  }
  if (typeof apiConfig !== 'object') return [...STANDARD_API_ACTIONS];

  const config = apiConfig as { include?: string[]; exclude?: string[] };
  let crud: string[] = config.include
    ? config.include.filter((a) => STANDARD_API_ACTIONS.includes(a))
    : [...STANDARD_API_ACTIONS];
  if (Array.isArray(config.exclude)) {
    const exclude = config.exclude;
    crud = crud.filter((a) => !exclude.includes(a));
  }
  return crud;
}

/**
 * Check if a custom action should be included in API.
 *
 * Mirrors the CRUD inclusion path: intersect with `include` (when set), then
 * subtract `exclude`. Both filters apply together, matching principle of least
 * surprise for users supplying both lists.
 */
function shouldIncludeInApi(actionName: string, apiConfig: unknown): boolean {
  if (apiConfig === false) return false;
  if (apiConfig === true || apiConfig === undefined) return true;

  if (typeof apiConfig === 'object' && apiConfig !== null) {
    const config = apiConfig as { include?: unknown; exclude?: unknown };
    // Narrow the scanned decorator config defensively: a non-array
    // include/exclude is treated as unset rather than throwing on .includes().
    const included = Array.isArray(config.include)
      ? config.include.includes(actionName)
      : true;
    const excluded = Array.isArray(config.exclude)
      ? config.exclude.includes(actionName)
      : false;
    return included && !excluded;
  }

  return true;
}

/**
 * Compute the set of action names (standard CRUD + custom methods) that the
 * API exposes for a given object definition. This is the same resolution used
 * to drive route generation, exposed so coherence checks (e.g. CLI vs API)
 * can ask "what does the API expose?" without re-implementing the logic.
 */
export function resolveApiActionSet(
  objectDef: SmartObjectDefinition,
): Set<string> {
  const apiConfig = objectDef.decoratorConfig?.api;
  if (apiConfig === false) return new Set();

  const actions = new Set<string>(resolveStandardCrudActions(apiConfig));
  const objectIsCollectionClass = isCollectionClass(objectDef);
  const config = getApiConfigObject(apiConfig);

  // Custom (non-CRUD, public) methods. We mirror BOTH the include/exclude
  // filter AND the scope/static skip rules that the route generators apply
  // (sveltekit-generator.ts generateRoutesForObject and
  // generateCollectionRoutesForObject). Otherwise the cli↔api coherence lint
  // would claim "reachable via API" for methods that produce no HTTP route.
  for (const [name, method] of Object.entries(objectDef.methods || {})) {
    if (STANDARD_API_ACTIONS.includes(name)) continue;
    if (!method.isPublic) continue;
    if (!shouldIncludeInApi(name, apiConfig)) continue;

    const routeConfig: ApiCustomRouteConfig | undefined =
      config?.routes?.[name];
    const defaultScope: 'item' | 'collection' = objectIsCollectionClass
      ? 'collection'
      : method.isStatic
        ? 'collection'
        : 'item';
    const scope = routeConfig?.scope || defaultScope;

    if (objectIsCollectionClass) {
      // Collection classes only emit collection-scoped custom routes.
      if (scope !== 'collection') continue;
    } else {
      // Non-collection classes skip collection-scoped non-static methods
      // (the generator emits a console warning in this case).
      if (scope === 'collection' && !method.isStatic) continue;
    }

    actions.add(name);
  }

  return actions;
}

/**
 * Detail for a single cli-vs-api coherence violation.
 */
export interface CliApiCoherenceViolation {
  className: string;
  unreachable: string[];
}

/**
 * Inspect a manifest and return classes whose `cli.include` references
 * methods not exposed via the API. Classes that opt out via
 * `cli: { skipApiCheck: true }` are skipped.
 *
 * Throws nothing; returns the violation list so callers can choose to throw
 * or warn.
 */
export function findCliApiCoherenceViolations(
  manifest: SmartObjectManifest,
): CliApiCoherenceViolation[] {
  const violations: CliApiCoherenceViolation[] = [];

  for (const [className, objectDef] of Object.entries(manifest.objects)) {
    const cliConfig = objectDef.decoratorConfig?.cli;
    if (!cliConfig || typeof cliConfig !== 'object') continue;
    if (cliConfig.skipApiCheck) continue;
    if (!cliConfig.include || cliConfig.include.length === 0) continue;

    // Match generateCLIModule's effective command set: include − exclude.
    // A command in both lists is not actually registered, so the lint must
    // not flag it as unreachable.
    const cliExclude = Array.isArray(cliConfig.exclude)
      ? cliConfig.exclude
      : [];
    const effectiveCliCommands = cliConfig.include.filter(
      (cmd: string) => !cliExclude.includes(cmd),
    );
    if (effectiveCliCommands.length === 0) continue;

    const apiActionSet = resolveApiActionSet(objectDef);
    const unreachable = effectiveCliCommands.filter(
      (action: string) => !apiActionSet.has(action),
    );

    if (unreachable.length > 0) {
      violations.push({ className, unreachable });
    }
  }

  return violations;
}

/**
 * Throw if any class in the manifest has `cli.include` methods that aren't
 * reachable via the API. Default build-time gate; opt-out per-class via
 * `cli: { skipApiCheck: true }` (or globally via the vite plugin option
 * `validateCliApiCoherence: false`).
 */
export function validateCliIncludeAgainstApi(
  manifest: SmartObjectManifest,
): void {
  const violations = findCliApiCoherenceViolations(manifest);
  if (violations.length === 0) return;

  const messages = violations.flatMap(({ className, unreachable }) =>
    unreachable.map(
      (action) =>
        `[smrt] ${className}.${action} is declared in cli.include but is not exposed via the api.\n` +
        `  Either:\n` +
        `    - Add '${action}' to api.include, or\n` +
        `    - Remove '${action}' from cli.include.\n` +
        `  The CLI invokes methods over HTTP; methods without API routes are unreachable.\n` +
        `  If this CLI is intentionally invoked in-process (no HTTP), set\n` +
        `  \`cli: { skipApiCheck: true }\` on the @smrt() decorator to acknowledge.`,
    ),
  );

  throw new Error(messages.join('\n\n'));
}

/**
 * Writes a route file, creating directories as needed
 */
function writeRoute(dir: string, filename: string, content: string): void {
  try {
    // Create directory if needed
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    // Write the file (writeFileSync is synchronous and will throw on failure)
    const filePath = join(dir, filename);
    writeFileSync(filePath, content, 'utf-8');
    console.log(`[smrt] Generated: ${filePath}`);
  } catch (error) {
    console.error(`[smrt] [ERROR] Failed to write route file:`);
    console.error(`[smrt] [ERROR]   Directory: ${dir}`);
    console.error(`[smrt] [ERROR]   Filename: ${filename}`);
    console.error(`[smrt] [ERROR]   Error:`, error);
    throw error;
  }
}

/**
 * Converts absolute file path to SvelteKit $lib alias import
 * For SvelteKit projects, uses $lib alias for better module resolution
 */
function getSvelteKitImportPath(
  projectRoot: string,
  objectFilePath: string | undefined,
  objectsDir: string,
  className?: string,
): string {
  // Handle undefined filePath by generating a default path
  // This allows tests to work without providing explicit file paths
  const filePath =
    objectFilePath ||
    join(projectRoot, objectsDir, `${className || 'Object'}.ts`);

  // Convert objectsDir to absolute path if it's relative
  const absoluteObjectsDir = objectsDir.startsWith('/')
    ? objectsDir
    : join(projectRoot, objectsDir);

  // Get the relative path from objectsDir to the file
  const relativePath = relative(absoluteObjectsDir, filePath);

  // Convert to forward slashes and remove extension
  const normalizedPath = relativePath.replace(/\\/g, '/');
  const withoutExtension = normalizedPath.replace(/\.(ts|js|tsx|jsx)$/, '');

  // If objectsDir is under src/lib, use $lib alias
  if (objectsDir.includes('src/lib')) {
    const libSubpath = objectsDir.split('src/lib')[1] || '';
    const fullPath = libSubpath
      ? `${libSubpath}/${withoutExtension}`
      : withoutExtension;
    return `$lib${fullPath}`.replace(/\/+/g, '/'); // Clean up double slashes
  }

  // Otherwise use relative path (fallback for non-standard layouts)
  return withoutExtension.startsWith('.')
    ? withoutExtension
    : `./${withoutExtension}`;
}

/**
 * Check if an object's source file is local to the project (not in node_modules).
 * The scanner sets packageName for all objects (including local ones from the
 * project's own package.json), so we check the filePath to distinguish.
 */
function isLocalObject(
  projectRoot: string,
  objectDef: SmartObjectDefinition,
): boolean {
  if (!objectDef.filePath) return false;
  return (
    objectDef.filePath.startsWith(projectRoot) &&
    !objectDef.filePath.includes('/node_modules/')
  );
}

/**
 * Generates collection route template (GET list, POST create)
 */
function generateCollectionRouteTemplate(
  projectRoot: string,
  className: string,
  objectDef: SmartObjectDefinition,
  manifest: SmartObjectManifest,
  includedActions: string[],
  options: SvelteKitOptions,
  routeDir: string,
): string {
  const hasGet = includedActions.includes('list');
  const hasPost = includedActions.includes('create');
  const modelType = resolveObjectTypeReference(
    projectRoot,
    className,
    objectDef,
    options,
    routeDir,
  );
  const serializers = resolveStandardRouteSerializers(
    objectDef.decoratorConfig?.api,
  );
  const serializerImports = serializers.importStatements.join('\n');
  // A custom list serializer can render related-table data the per-table
  // change-feed version cannot observe (#1765), so such routes keep the v1
  // body-hash ETag; the default toPublicJSON path uses the v2 version source.
  const listUsesSerializer = !!serializers.listItemSerializerName;
  const readPermissionFields = collectReadPermissionFields(objectDef, manifest);
  const listUsesPermissionScopedBody = readPermissionFields.length > 0;
  const listUsesBodyHash = listUsesSerializer || listUsesPermissionScopedBody;

  const imports = `${AUTO_GENERATED_ROUTE_HEADER}
// DO NOT EDIT - changes will be overwritten

import { error${hasPost ? ', json' : ''} } from '@sveltejs/kit';
${
  serializerImports ? `${serializerImports}\n` : ''
}import { getCollection } from '$lib/server/smrt';
${modelType.importStatement ? `${modelType.importStatement}\n` : ''}import type { RequestHandler } from './$types';
// Note: ${className} is auto-registered by the Vite plugin scanner
${generateAuthGuardHelper(objectDef, manifest)}${isTenantScoped(objectDef) ? generateTenantContextHelper() : ''}${hasPost ? generateWritablePolicyHelper(objectDef) : ''}${hasGet ? generateConditionalGetRouteHelper(objectDef.decoratorConfig?.api, { tenantScoped: isTenantScoped(objectDef), permissionScoped: listUsesPermissionScopedBody, modelName: className, useBodyHash: listUsesBodyHash }) : ''}`;

  // #1782: tenant-scoped reads fail closed to global (NULL-tenant) rows when no
  // tenant context is active (public/anonymous read). Non-tenant models keep the
  // plain list/count.
  const listAndCount = isTenantScoped(objectDef)
    ? `  const readScope = tenantReadScope();
  const items = await collection.list({ limit, offset, where: readScope });
  const count = await collection.count({ where: readScope });`
    : `  const items = await collection.list({ limit, offset });
  const count = await collection.count();`;

  const getHandler = hasGet
    ? `
// List all ${className.toLowerCase()}s
export const GET: RequestHandler = async ({ locals, url, request }) => {
${routeGuardPreamble(objectDef, false)}
  const publicJsonOptions = getPublicJsonOptions(locals);
  const limit = Number(url.searchParams.get('limit')) || 50;
  const offset = Number(url.searchParams.get('offset')) || 0;

${generateCollectionLoad(className, { typeName: modelType.typeName })}
${
  listUsesSerializer
    ? `${listAndCount}
  // Custom serializer may render related-table data → v1 body-hash ETag (#1765).
  const serializedItems = await Promise.all(
    items.map(async (item) =>
      applyReadPermissionRedaction(
        await ${serializers.listItemSerializerName}(item),
        publicJsonOptions,
      ),
    ),
  );
  return conditionalJson(request, { items: serializedItems, count, limit, offset });`
    : listUsesPermissionScopedBody
      ? `${listAndCount}
  // Field read permissions make the body vary by caller permissions → v1 body-hash ETag (#1565).
  const items_public = items.map((item) => item.toPublicJSON(publicJsonOptions));
  return conditionalJson(request, { items: items_public, count, limit, offset });`
      : `  // ETag v2 (#1765): the table-version ETag is checked first; on a concrete
  // If-None-Match the list query below never runs (zero-query 304).
  return conditionalVersionedRead(request, collection.db, collection.tableName, async () => {
${listAndCount}
    const items_public = items.map((item) => item.toPublicJSON(publicJsonOptions));
    return { items: items_public, count, limit, offset };
  });`
}
};
`
    : '';

  const postHandler = hasPost
    ? `
// Create new ${className.toLowerCase()}
export const POST: RequestHandler = async ({ locals, request }) => {
${routeGuardPreamble(objectDef, true)}
  const publicJsonOptions = getPublicJsonOptions(locals);
  const body: unknown = await request.json();
  const data = applyWritablePolicy(body);

${generateCollectionLoad(className, { typeName: modelType.typeName })}
  const item = await collection.create(data);
  await item.save();
${
  serializers.itemSerializerName
    ? `
  const serializedItem = await ${serializers.itemSerializerName}(item);

  return json(
    applyReadPermissionRedaction(serializedItem, publicJsonOptions),
    { status: 201 },
  );`
    : `
  return json(item.toPublicJSON(publicJsonOptions), { status: 201 });`
}
};
`
    : '';

  return imports + getHandler + postHandler;
}

function generateCollectionLoad(
  className: string,
  options: { typeName?: string } = {},
): string {
  const genericSuffix = options.typeName ? `<${options.typeName}>` : '';

  return [
    `  const collection = await getCollection${genericSuffix}(`,
    `    '${className}',`,
    '  );',
  ].join('\n');
}

function generateNotFoundError(className: string): string {
  const singleLineNotFoundError = `  if (!item) throw error(404, '${className} not found');`;

  if (singleLineNotFoundError.length <= 100) {
    return singleLineNotFoundError;
  }

  return [
    '  if (!item)',
    '    throw error(',
    '      404,',
    `      '${className} not found',`,
    '    );',
  ].join('\n');
}

function generateCollectionNotRegisteredError(className: string): string {
  return [
    '  if (!collection)',
    '    throw error(',
    '      500,',
    `      '${className} collection is not registered',`,
    '    );',
  ].join('\n');
}

function generateClassNotRegisteredError(className: string): string {
  return [
    '  if (!registered)',
    '    throw error(',
    '      500,',
    `      '${className} is not registered',`,
    '    );',
  ].join('\n');
}

/**
 * Generates item route template (GET, PUT, DELETE)
 */
function generateItemRouteTemplate(
  projectRoot: string,
  className: string,
  objectDef: SmartObjectDefinition,
  manifest: SmartObjectManifest,
  includedActions: string[],
  options: SvelteKitOptions,
  routeDir: string,
): string {
  const hasGet = includedActions.includes('get');
  const hasPut = includedActions.includes('update');
  const hasDelete = includedActions.includes('delete');
  const simpleClassName = extractSimpleClassName(className);
  const modelType = resolveObjectTypeReference(
    projectRoot,
    className,
    objectDef,
    options,
    routeDir,
  );
  const serializers = resolveStandardRouteSerializers(
    objectDef.decoratorConfig?.api,
  );
  const serializerImports = serializers.importStatements.join('\n');
  // A custom item serializer can render related-table data the per-table
  // change-feed version cannot observe (#1765), so such routes keep the v1
  // body-hash ETag; the default toPublicJSON path uses the v2 version source.
  const getUsesSerializer = !!serializers.itemSerializerName;
  const readPermissionFields = collectReadPermissionFields(objectDef, manifest);
  const getUsesPermissionScopedBody = readPermissionFields.length > 0;
  const getUsesBodyHash = getUsesSerializer || getUsesPermissionScopedBody;

  const imports = `${AUTO_GENERATED_ROUTE_HEADER}
// DO NOT EDIT - changes will be overwritten

import { error${hasPut || hasDelete ? ', json' : ''} } from '@sveltejs/kit';
${serializerImports ? `${serializerImports}\n` : ''}import { getCollection } from '$lib/server/smrt';
${modelType.importStatement ? `${modelType.importStatement}\n` : ''}import type { RequestHandler } from './$types';
${generateAuthGuardHelper(objectDef, manifest)}${isTenantScoped(objectDef) ? generateTenantContextHelper() : ''}${hasPut ? generateWritablePolicyHelper(objectDef) : ''}${hasGet ? generateConditionalGetRouteHelper(objectDef.decoratorConfig?.api, { tenantScoped: isTenantScoped(objectDef), permissionScoped: getUsesPermissionScopedBody, modelName: className, useBodyHash: getUsesBodyHash }) : ''}`;

  // #1782: a tenant-scoped single read fails closed to global (NULL-tenant)
  // rows when no tenant context is active, so a public/anonymous GET /:id can't
  // fetch another tenant's row by id. Mutations (PUT/DELETE) require auth, so
  // they keep the plain id lookup and rely on the interceptor.
  const getForRead = isTenantScoped(objectDef)
    ? `  const readScope = tenantReadScope();
  const item = await collection.get(
    readScope ? { id: params.id, ...readScope } : params.id,
  );`
    : `  const item = await collection.get(params.id);`;

  const getHandler = hasGet
    ? `
// Get single ${simpleClassName.toLowerCase()}
export const GET: RequestHandler = async ({ locals, params, request }) => {
${routeGuardPreamble(objectDef, false)}
  const publicJsonOptions = getPublicJsonOptions(locals);
${generateCollectionLoad(className, { typeName: modelType.typeName })}
${
  getUsesSerializer
    ? `${getForRead}
${generateNotFoundError(className)}
  // Custom serializer may render related-table data → v1 body-hash ETag (#1765).
  const serializedItem = await ${serializers.itemSerializerName}(item);
  return conditionalJson(
    request,
    applyReadPermissionRedaction(serializedItem, publicJsonOptions),
  );`
    : getUsesPermissionScopedBody
      ? `${getForRead}
${generateNotFoundError(className)}
  // Field read permissions make the body vary by caller permissions → v1 body-hash ETag (#1565).
  return conditionalJson(request, item.toPublicJSON(publicJsonOptions));`
      : `  // ETag v2 (#1765): a concrete If-None-Match answers 304 without the row fetch
  // (a delete advances the version, so a since-deleted row can't false-match);
  // a wildcard \`*\` is deferred until the fetch confirms the row exists.
  return conditionalVersionedRead(request, collection.db, collection.tableName, async () => {
${getForRead}
${generateNotFoundError(className)}
    return item.toPublicJSON(publicJsonOptions);
  });`
}
};
`
    : '';

  const putHandler = hasPut
    ? `
// Update ${simpleClassName.toLowerCase()}
export const PUT: RequestHandler = async ({ locals, params, request }) => {
${routeGuardPreamble(objectDef, true)}
  const publicJsonOptions = getPublicJsonOptions(locals);
${generateCollectionLoad(className, { typeName: modelType.typeName })}
  const item = await collection.get(params.id);
${generateNotFoundError(className)}

  const body: unknown = await request.json();
  const data = applyWritablePolicy(body);
  Object.assign(item, data);
  await item.save();
${
  serializers.itemSerializerName
    ? `
  const serializedItem = await ${serializers.itemSerializerName}(item);

  return json(applyReadPermissionRedaction(serializedItem, publicJsonOptions));`
    : `
  return json(item.toPublicJSON(publicJsonOptions));`
}
};
`
    : '';

  const deleteHandler = hasDelete
    ? `
// Delete ${simpleClassName.toLowerCase()}
export const DELETE: RequestHandler = async ({ locals, params }) => {
${routeGuardPreamble(objectDef, true)}
${generateCollectionLoad(className, { typeName: modelType.typeName })}
  const item = await collection.get(params.id);
${generateNotFoundError(className)}

  await item.delete();
  return json({ success: true });
};
`
    : '';

  return imports + getHandler + putHandler + deleteHandler;
}

/**
 * Generates custom action route template
 */
function generateActionRouteTemplate(
  projectRoot: string,
  routeDir: string,
  routeSpecs: GeneratedActionRouteSpec[],
  objectDef: SmartObjectDefinition,
  manifest: SmartObjectManifest,
  options: SvelteKitOptions,
): string {
  if (routeSpecs.length === 0) {
    throw new Error('Cannot generate a custom action route without handlers');
  }

  const [firstSpec] = routeSpecs;
  const { lookupClassName, routeConfig, hostType } = firstSpec;
  const lookupModelType = resolveObjectTypeReference(
    projectRoot,
    lookupClassName,
    firstSpec.lookupObjectDef,
    options,
    routeDir,
  );
  const hostModelType = resolveObjectTypeReference(
    projectRoot,
    firstSpec.hostClassName,
    objectDef,
    options,
    routeDir,
  );
  const typeImports = mergeImportStatements([
    lookupModelType.importStatement,
    hostModelType.importStatement,
  ]);

  const hasMixedHosts = routeSpecs.some(
    (spec) =>
      spec.hostType !== hostType ||
      spec.lookupClassName !== lookupClassName ||
      spec.routeConfig.scope !== routeConfig.scope,
  );

  if (hasMixedHosts) {
    throw new Error(
      `Cannot generate mixed custom route handlers for ${lookupClassName}. ` +
        'All handlers sharing a route path must target the same host type and scope.',
    );
  }

  const importBlock = [
    "import { error, json } from '@sveltejs/kit';",
    hostType === 'collection' || routeConfig.scope !== 'collection'
      ? "import { getCollection } from '$lib/server/smrt';"
      : "import { ObjectRegistry } from '@happyvertical/smrt-core';",
    typeImports,
    "import type { RequestHandler } from './$types';",
  ]
    .filter(Boolean)
    .join('\n');

  const tenantScoped =
    isTenantScoped(objectDef) ||
    routeSpecs.some(
      (spec) => !!spec.lookupObjectDef && isTenantScoped(spec.lookupObjectDef),
    );
  const handlers = routeSpecs
    .map((spec) =>
      generateActionRouteHandler(
        spec.lookupClassName,
        spec.actionName,
        spec.actionDef,
        spec.routeConfig,
        spec.hostType,
        tenantScoped,
        lookupModelType.typeName,
        hostModelType.typeName,
      ),
    )
    .join('\n');

  return `${AUTO_GENERATED_ROUTE_HEADER}
// DO NOT EDIT - changes will be overwritten

${importBlock}
${generateAuthGuardHelper(objectDef, manifest)}${tenantScoped ? generateTenantContextHelper() : ''}
${handlers}`;
}

function generateActionRouteHandler(
  lookupClassName: string,
  actionName: string,
  actionDef: MethodDefinition,
  routeConfig: ResolvedApiActionRouteConfig,
  hostType: 'item' | 'collection',
  tenantScoped: boolean,
  lookupTypeName: string,
  hostTypeName: string,
): string {
  const handlerName = routeConfig.method;
  // Mutating verbs require auth even when reads are public (#1540). Tenant-scoped
  // objects also establish tenant context so the action runs filtered.
  const guardLines = [
    `  requireRouteAuth(locals, ${routeConfig.method !== 'GET'});`,
  ];
  if (tenantScoped) {
    guardLines.push('  establishTenantContext(locals);');
  }
  const authGuardLine = guardLines.join('\n');
  const hasInput = actionDef.parameters.length > 0;
  const needsRequest = hasInput;
  const collectionHandlerArgs = buildRouteHandlerArgs(
    routeConfig.pathParamNames.length > 0,
    needsRequest,
  );
  const itemHandlerArgs = buildRouteHandlerArgs(true, needsRequest);

  if (hostType === 'collection') {
    const optionsLoad = buildActionOptionsLoad(
      actionName,
      actionDef,
      routeConfig,
      hostTypeName,
      actionDef.isStatic,
    );
    const receiverExpression = actionDef.isStatic
      ? 'CollectionClass'
      : 'typedCollection';
    const staticTargetLoad = actionDef.isStatic
      ? `  const CollectionClass = typedCollection.constructor as typeof ${hostTypeName};\n`
      : '';
    const scopedOptions = buildScopedOptionsForTenantRead(
      actionDef,
      routeConfig,
      tenantScoped,
    );
    const invocationArgs = buildActionInvocationArgs(
      actionDef,
      scopedOptions.optionsIdentifier,
    );

    return `// Custom collection method: ${actionName}
export const ${handlerName}: RequestHandler = async (${collectionHandlerArgs}) => {
${authGuardLine}
  const publicJsonOptions = getPublicJsonOptions(locals);
${generateCollectionLoad(lookupClassName, { typeName: lookupTypeName })}
  const typedCollection = collection as unknown as ${hostTypeName};
${generateCollectionNotRegisteredError(lookupClassName)}
${staticTargetLoad}

${optionsLoad}${scopedOptions.source}  const result = ${buildActionInvocationExpression(
      receiverExpression,
      actionName,
      invocationArgs,
    )};

  return json({
    action: '${actionName}',
    result: toPublicResult(result, publicJsonOptions),
  });
};
`;
  }

  if (routeConfig.scope === 'collection') {
    const optionsLoad = buildActionOptionsLoad(
      actionName,
      actionDef,
      routeConfig,
      hostTypeName,
      true,
    );
    const scopedOptions = buildScopedOptionsForTenantRead(
      actionDef,
      routeConfig,
      tenantScoped,
    );
    const invocationArgs = buildActionInvocationArgs(
      actionDef,
      scopedOptions.optionsIdentifier,
    );
    return `// Custom collection action: ${actionName}
export const ${handlerName}: RequestHandler = async (${collectionHandlerArgs}) => {
${authGuardLine}
  const publicJsonOptions = getPublicJsonOptions(locals);
  const registered = ObjectRegistry.getClass('${lookupClassName}');
${generateClassNotRegisteredError(lookupClassName)}

${optionsLoad}${scopedOptions.source}  const ClassRef = registered.constructor as typeof ${hostTypeName};
  const result = ${buildActionInvocationExpression(
    'ClassRef',
    actionName,
    invocationArgs,
  )};

  return json({
    action: '${actionName}',
    result: toPublicResult(result, publicJsonOptions),
  });
};
`;
  }

  const optionsLoad = buildActionOptionsLoad(
    actionName,
    actionDef,
    routeConfig,
    hostTypeName,
    false,
  );
  const scopedItemLoad =
    tenantScoped && routeConfig.method === 'GET'
      ? `  const readScope = tenantReadScope();
  const item = await collection.get(
    readScope ? { id: params.id, ...readScope } : params.id,
  );`
      : '  const item = await collection.get(params.id);';
  const invocationArgs = buildActionInvocationArgs(actionDef);
  return `// Custom action: ${actionName}
export const ${handlerName}: RequestHandler = async (${itemHandlerArgs}) => {
${authGuardLine}
  const publicJsonOptions = getPublicJsonOptions(locals);
${generateCollectionLoad(lookupClassName, { typeName: lookupTypeName })}
${scopedItemLoad}
${generateNotFoundError(lookupClassName)}

${optionsLoad}  const result = ${buildActionInvocationExpression(
    'item',
    actionName,
    invocationArgs,
  )};

  return json({
    action: '${actionName}',
    result: toPublicResult(result, publicJsonOptions),
  });
};
`;
}

function generateKnowledgeRouteTemplate(
  knowledge: DomainKnowledgeConfig,
  artifact: Record<string, unknown> | null,
): string {
  const api = knowledge.api ?? {};
  const includeDocs = api.includeDocs === true;
  const includePrompts = api.includePrompts === true;
  const requireAdmin = api.requireAdmin !== false;
  const artifactLiteral = artifact ? JSON.stringify(artifact) : 'null';

  return `${AUTO_GENERATED_ROUTE_HEADER}
// DO NOT EDIT - changes will be overwritten

import { dev } from '$app/environment';
import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

const INCLUDE_DOCS_BY_DEFAULT = ${JSON.stringify(includeDocs)};
const INCLUDE_PROMPTS_BY_DEFAULT = ${JSON.stringify(includePrompts)};
const REQUIRE_ADMIN = ${JSON.stringify(requireAdmin)};
const KNOWLEDGE_ARTIFACT: Record<string, unknown> | null = ${artifactLiteral};

if (!dev && !REQUIRE_ADMIN) {
  console.warn('[smrt] PUBLIC knowledge API route enabled; unauthenticated responses are sanitized.');
}

export const GET: RequestHandler = async ({ locals, url, setHeaders }) => {
  setHeaders({ 'cache-control': 'private, no-store' });

  if (!dev && REQUIRE_ADMIN && !isKnowledgeAdmin(locals)) {
    throw error(403, 'SMRT knowledge requires dev mode or admin access');
  }

  const artifact = readKnowledgeArtifact();
  const includeDocs = queryBoolean(url, 'includeDocs', INCLUDE_DOCS_BY_DEFAULT);
  const includePrompts = queryBoolean(
    url,
    'includePrompts',
    INCLUDE_PROMPTS_BY_DEFAULT,
  );

  return json(sanitizeKnowledgeArtifact(artifact, {
    includeDocs,
    includePrompts,
    publicAccess: !REQUIRE_ADMIN,
  }));
};

function readKnowledgeArtifact(): Record<string, unknown> {
  if (!KNOWLEDGE_ARTIFACT) throw error(404, 'SMRT knowledge artifact not found');
  return KNOWLEDGE_ARTIFACT;
}

function queryBoolean(url: URL, name: string, defaultValue: boolean): boolean {
  const value = url.searchParams.get(name);
  if (value === null) return defaultValue;
  return value === 'true';
}

function sanitizeKnowledgeArtifact(
  artifact: Record<string, unknown>,
  options: { includeDocs: boolean; includePrompts: boolean; publicAccess: boolean },
): Record<string, unknown> {
  const sanitized = { ...artifact };

  if (!options.includeDocs) {
    delete sanitized.agentDoc;
  }

  if (!options.includePrompts) {
    sanitized.prompts = [];
  }

  if (options.publicAccess) {
    delete sanitized.dependencies;
    delete sanitized.sourceHashes;
    delete sanitized.sourceManifestPath;
    delete sanitized.agentDocPath;
  }

  return sanitized;
}

function recordValue(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object') return undefined;
  return (value as Record<string, unknown>)[key];
}

function isKnowledgeAdmin(locals: unknown): boolean {
  if (!locals || typeof locals !== 'object') return false;
  const localRecord = locals as Record<string, unknown>;
  if (
    localRecord.smrtKnowledgeAdmin === true ||
    localRecord.smrtAdmin === true
  ) {
    return true;
  }

  const userRoles = rolesFrom(localRecord.user);
  const sessionRoles = rolesFrom(recordValue(localRecord.session, 'user'));
  return [...userRoles, ...sessionRoles].some((role) =>
    ['admin', 'owner', 'superadmin'].includes(role),
  );
}

function rolesFrom(value: unknown): string[] {
  if (!value || typeof value !== 'object') return [];
  const roleList = recordValue(value, 'roles');
  const roles = Array.isArray(roleList) ? roleList : [recordValue(value, 'role')];
  return roles
    .filter((role): role is string => typeof role === 'string')
    .map((role) => role.toLowerCase());
}
`;
}

/**
 * Updates .gitignore to exclude auto-generated routes
 */
function updateGitignore(projectRoot: string, options: SvelteKitOptions): void {
  const gitignorePath = join(projectRoot, '.gitignore');

  // Patterns to add
  const patternsToAdd = [
    '# SMRT auto-generated routes (from Vite plugin)',
    `${options.routesDir}/**/+server.ts`,
  ];
  if (options.knowledge?.api?.enabled) {
    const knowledgeRoute = relative(
      projectRoot,
      join(knowledgeRouteDir(projectRoot, options), '+server.ts'),
    ).replaceAll('\\', '/');
    patternsToAdd.push(knowledgeRoute);
  }

  // Read existing .gitignore or create empty string
  let gitignoreContent = '';
  if (existsSync(gitignorePath)) {
    gitignoreContent = readFileSync(gitignorePath, 'utf-8');
  }

  // Check if patterns already exist
  let needsUpdate = false;
  const linesToAdd: string[] = [];

  for (const pattern of patternsToAdd) {
    // Skip if pattern already exists (check for exact match or similar)
    if (!gitignoreContent.includes(pattern)) {
      linesToAdd.push(pattern);
      needsUpdate = true;
    }
  }

  if (needsUpdate) {
    // Ensure file ends with newline before adding
    if (gitignoreContent.length > 0 && !gitignoreContent.endsWith('\n')) {
      gitignoreContent += '\n';
    }

    // Add a blank line before our section if file has content
    if (gitignoreContent.length > 0 && !gitignoreContent.endsWith('\n\n')) {
      gitignoreContent += '\n';
    }

    // Add our patterns
    gitignoreContent += `${linesToAdd.join('\n')}\n`;

    writeFileSync(gitignorePath, gitignoreContent, 'utf-8');
    console.log('[smrt] Updated .gitignore with generated route patterns');
  }
}
