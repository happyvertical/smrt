import { resolveOperationPermissionAlias } from '../operation-permission.js';

/**
 * SvelteKit route auto-generation from SMRT objects
 * Generates real TypeScript files in src/routes/api/ based on discovered SMRT objects
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { DomainKnowledgeConfig } from '@happyvertical/smrt-types';
import { generateActivationRegistration } from '../activation/generate.js';
import { publishArtifactFiles } from '../consumer-plugin/artifact-publication.js';
import { generateConditionalGetRouteHelper } from '../generators/conditional-get.js';
import {
  type ApiMethodExposure,
  CRUD_OPERATIONS,
  createManifestClassNamePredicate,
  declaredParameterType,
  declaredTypeAcceptsDate,
  isCrudOperation,
  isFrameworkLifecycleMethod,
  queryStringDecoderFor,
  resolveApiMethodExposure,
  resolveCustomActionNames,
  resolveDeclaredScopeMismatch,
  resolveEffectiveActionMetadata,
  type WireabilityOptions,
} from '../generators/custom-action.js';
import { isReplacedModel } from '../manifest/model-replacements';
import {
  BUILD_SCHEMA_MODULE,
  generateBuildSchemaModule,
} from '../migrations/build-schema.js';
import { resolvePermissionCollection } from '../permission-collection.js';
import {
  buildDefaultListOrderBy,
  DEFAULT_LIST_LIMIT,
  MAX_LIST_LIMIT,
} from '../query-bounds.js';
import { isFrameworkBaseClass } from '../registry/framework-base-classes.js';
import type {
  ApiHttpMethod,
  ApiSerializerReference,
} from '../registry/types.js';
import type {
  MethodDefinition,
  SmartObjectDefinition,
  SmartObjectManifest,
} from '../scanner/types';
import { generateChangesRoute } from './changes-route.js';
import { consumerResolvesImport } from './consumer-import.js';
import {
  generateDevPlaneRoute,
  willGenerateDevPlaneRoute,
} from './dev-plane-route.js';
import { generateEventsRoute } from './events-route.js';
import {
  findUnlistableRouteDirectories,
  isGeneratedRouteFile,
  physicalRouteFileKey,
  type RouteCaseBehaviour,
  RouteFilePlan,
  removeGeneratedRouteFile,
} from './generated-route-files.js';
import {
  generateResourcesRoute,
  reservesResourcesRoute,
} from './resources-route.js';
import { applyRouteCors, type SvelteKitCorsOptions } from './route-cors.js';
import { AUTO_GENERATED_ROUTE_HEADER } from './route-header.js';
import {
  allowsSuperAdminBypass,
  generateRoutePrincipalHelper,
  generateTenantContextHelper,
  getApiConfigObject,
  getApiPublicAccess,
  isTenantScoped,
  manifestTenantColumns,
  usesPrincipalContext,
} from './route-policy.js';
import {
  assertSvelteKitConfigModuleNotReserved,
  generateCollectionAccessImports,
  resolveSvelteKitConfigImport,
} from './sveltekit-config-import.js';
import { canonicalSvelteKitPath } from './sveltekit-path.js';
import {
  collectSyncApplyTargets,
  generateSyncApplyRoute,
} from './sync-apply-route.js';
import {
  computeWebManifestHash,
  findManifestObjectByName,
  isCollectionManifestClass,
  orderedManifestObjectEntries,
  type ResolvedApiActionRouteConfig,
  resolveApiActionRouteConfig,
  resolveApiActionSet,
  resolveApiCustomActions,
  resolveCollectionItemObject,
  resolveCollectionItemTypeName,
  resolveStandardCrudActions,
} from './web-collections.js';

export interface SvelteKitOptions {
  /** Emit deferred model loaders instead of eager registration. Host installs activation coordinator. */
  lazyActivation?: boolean;
  enabled: boolean;
  routesDir: string;
  objectsDir: string;
  configPath?: string; // default: 'src/lib/server'
  configFileName?: string; // default: 'smrt.ts'
  /** Internal absolute consumer registration entrypoints for a coordinated host. */
  consumerRegistrationPaths?: readonly string[];
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
   * Opt-in in-app runtime dev-plane route (`_dev/[...tool]`, #2782). Dev
   * mode only; requires `@happyvertical/smrt-dev-mcp` in the consumer and
   * `SMRT_DEV_MCP_TOKEN` at runtime.
   */
  devPlaneRoute?: { enabled?: boolean };
  /**
   * Cross-origin access (#5195), the same explicit allow-list the runtime REST
   * handler takes. Off by default: no CORS headers, same-origin only. With a
   * non-empty `allowedOrigins`, the generated CRUD, custom action,
   * `sync/apply` and `_changes` routes answer through the shared policy
   * (`generators/cors.ts`): an `OPTIONS` preflight, and `Access-Control-Allow-
   * Origin` (the request's origin, never `*`) with `Vary: Origin` on every
   * response to an allow-listed origin. `allowCredentials: true` also adds
   * `Access-Control-Allow-Credentials: true`. CORS never authorizes.
   *
   * `eventsRoute.allowedOrigins` / `allowCredentials` keep working and take
   * precedence for `_events` alone; `_events` inherits this allow-list when it
   * sets none of its own. `eventsRoute.allowedOrigins: []` sets an empty list
   * of its own, which keeps `_events` same-origin only whatever `cors` allows.
   */
  cors?: SvelteKitCorsOptions;
  /**
   * Live `_events` SSE route generation (#1763). Enabled by default (the route
   * is auth-guarded fail-closed, same-origin only); set `enabled: false` to
   * skip. `maxSubscribers` caps active streams per process (#1860); 0 means
   * unlimited.
   *
   * Cross-origin subscription (#1861) is opt-in and fail-closed: provide
   * `allowedOrigins` (an explicit allowlist — never `*`) and set
   * `allowCredentials: true` so an allow-listed browser client can subscribe
   * with a credentialed `EventSource` (`withCredentials: true`). The generated
   * route echoes the specific request `Origin` only when it is allow-listed,
   * adds `Access-Control-Allow-Credentials: true`, and otherwise stays
   * same-origin only. Auth (an authenticated principal on `locals`, the
   * shared sign-in decision) is unchanged — CORS only lets the cookie reach
   * the guard. The headers and the preflight come from the shared CORS policy
   * (`generators/cors.ts`), as on every other generated route.
   */
  eventsRoute?: {
    enabled?: boolean;
    maxSubscribers?: number;
    allowedOrigins?: string[];
    allowCredentials?: boolean;
  };
  /**
   * CLI discovery `_resources` route generation (#2663). Enabled by default,
   * but only ever emitted when `@happyvertical/smrt-users` is resolvable
   * from the consumer (see `resources-route.ts` for the detection
   * mechanism) — set `enabled: false` to opt out even when it is present. A
   * pre-existing hand-written `_resources` route is always preserved.
   */
  resourcesRoute?: { enabled?: boolean };
  /** Reject route paths owned by distinct selected identities before cleanup. */
  rejectRouteCollisions?: boolean;
}

// Keep this aligned with biome.json formatter.lineWidth.
const BIOME_LINE_WIDTH = 80;

export {
  methodNameToKebab,
  type ResolvedApiActionRouteConfig,
  resolveApiActionRouteConfig,
  resolveApiActionSet,
  resolveApiCustomActions,
} from './web-collections.js';

const GITIGNORE_MANAGED_BLOCK_START =
  '# BEGIN SMRT auto-generated routes (Vite plugin)';
const GITIGNORE_MANAGED_BLOCK_END =
  '# END SMRT auto-generated routes (Vite plugin)';
const LEGACY_GITIGNORE_HEADER =
  '# SMRT auto-generated routes (from Vite plugin)';

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
/**
 * The generated registration's first import: this app build's schema, written
 * beside .smrt/manifest.json from the same merged manifest. Imported first so
 * it is registered before any model module or query runs, and bundled with the
 * app (#4929). Both the eager and the lazy-activation registration use it.
 *
 * The manifest writers publish the module before routes are generated. A
 * direct generator call with no manifest written yet gets one from this
 * manifest so the import resolves; the next manifest write replaces it.
 */
function buildSchemaImportFor(
  projectRoot: string,
  configDir: string,
  manifest: SmartObjectManifest,
): string {
  const buildSchemaFile = join(projectRoot, '.smrt', BUILD_SCHEMA_MODULE);
  const buildSchemaPath = relative(configDir, buildSchemaFile).replace(
    /\\/g,
    '/',
  );
  if (!existsSync(buildSchemaFile)) {
    mkdirSync(join(projectRoot, '.smrt'), { recursive: true });
    writeFileSync(
      buildSchemaFile,
      generateBuildSchemaModule(manifest),
      'utf-8',
    );
  }
  return `import '${buildSchemaPath.startsWith('.') ? buildSchemaPath : `./${buildSchemaPath}`}';`;
}

function extractSimpleClassName(qualifiedName: string): string {
  const colonIndex = qualifiedName.indexOf(':');
  if (colonIndex !== -1) {
    return qualifiedName.substring(colonIndex + 1);
  }
  return qualifiedName;
}

function getRegistrationPackageName(
  manifest: SmartObjectManifest,
  objectDef: SmartObjectDefinition,
  isLocal: boolean,
): string | undefined {
  if (isLocal) {
    return objectDef.packageName ?? manifest.packageName;
  }

  return objectDef.packageName;
}

/** Use the same exact identity for collection registration and route factories. */
function collectionResourceRegistryKey(
  projectRoot: string,
  className: string,
  objectDef: SmartObjectDefinition,
  manifest: SmartObjectManifest,
): string {
  const packageName = getRegistrationPackageName(
    manifest,
    objectDef,
    isLocalObject(projectRoot, objectDef),
  );
  return (
    objectDef.qualifiedName ||
    (className.includes(':')
      ? className
      : packageName
        ? `${packageName}:${extractSimpleClassName(className)}`
        : className)
  );
}

function toSingleQuotedStringLiteral(value: string): string {
  const jsonLiteral = JSON.stringify(value);
  const jsonContent = jsonLiteral.slice(1, -1).replaceAll("'", "\\'");
  return `'${jsonContent}'`;
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
  lazyActivation = false,
): ResolvedStandardRouteSerializers {
  const config = getApiConfigObject(apiConfig);
  const itemSerializer = config?.serializers?.item;
  const listItemSerializer =
    config?.serializers?.listItem || config?.serializers?.item;

  const importStatements: string[] = [];
  let itemSerializerName: string | undefined;
  let listItemSerializerName: string | undefined;
  const importSerializer = (
    serializer: ApiSerializerReference,
    name: string,
  ) =>
    lazyActivation
      ? `async function ${name}(...args: Parameters<typeof import('${serializer.importPath}').${serializer.exportName}>) {
  const provider = await import('${serializer.importPath}');
  return provider.${serializer.exportName}(...args);
}`
      : `import { ${serializer.exportName} as ${name} } from '${serializer.importPath}';`;

  if (itemSerializer) {
    itemSerializerName = 'serializeItemResponse';
    importStatements.push(importSerializer(itemSerializer, itemSerializerName));
  }

  if (listItemSerializer) {
    if (isSameSerializerReference(listItemSerializer, itemSerializer)) {
      listItemSerializerName = itemSerializerName;
    } else {
      listItemSerializerName = 'serializeListItemResponse';
      importStatements.push(
        importSerializer(listItemSerializer, listItemSerializerName),
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

  const external =
    !isLocalObject(projectRoot, objectDef) && objectDef.packageName;
  const importPath = external
    ? objectDef.importPath || objectDef.packageName
    : getRouteTypeImportPath(
        projectRoot,
        objectDef,
        options,
        simpleClassName,
        routeDir,
      );
  const exportName = external
    ? objectDef.exportName || simpleClassName
    : simpleClassName;

  return {
    typeName: simpleClassName,
    importStatement: `import type { ${exportName}${exportName === simpleClassName ? '' : ` as ${simpleClassName}`} } from '${importPath}';`,
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
  // An import-qualified parent names its package: a same-named class of
  // another package is not this object's parent (#4176).
  const parentIdentity =
    parent.qualifiedName ??
    (parent.packageName
      ? `${parent.packageName}:${parent.className}`
      : undefined);
  if (typeof extendsQualified === 'string' && parentIdentity) {
    return extendsQualified === parentIdentity;
  }
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

/**
 * The registry keys of the STI family members of `objectDef` this manifest
 * generates, when it has a family: an emitted route serves a member through
 * its base only when the member is one of them (#5375).
 */
function tenancyFamilyScope(
  objectDef: SmartObjectDefinition | undefined,
  manifest?: SmartObjectManifest,
): string[] | undefined {
  if (!objectDef) return undefined;
  const members = collectStiHierarchyObjects(objectDef, manifest);
  // A singleton STI base still carries the boundary: a subtype registered
  // only at run time must not be admitted through it. A plain model stays
  // unchanged.
  const isStiBase =
    manifest !== undefined &&
    objectDef.decoratorConfig?.tableStrategy === 'sti';
  if (members.length < 2 && !isStiBase) return undefined;
  return members.map((member) => readScopeModelName(member, member.className));
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
 * (#1540, 2c). Every generated CRUD/action handler calls `requireRouteAccess`,
 * which asks the shared decision (`authorize`, `generators/route-authz.ts`,
 * #5195) for sign-in (401), the `<collection>.<action>` permission of a write
 * (403) and, with `requireRouteBody`, the tenant a write body names. The
 * emitted file keeps only the model's policy constants; the rule is the one
 * runtime REST applies.
 */
function generateAuthGuardHelper(
  objectDef: SmartObjectDefinition,
  manifest?: SmartObjectManifest,
  permissionObjectDef: SmartObjectDefinition = objectDef,
): string {
  const publicAccess = getApiPublicAccess(objectDef.decoratorConfig?.api);
  const readPermissionFields = collectReadPermissionFields(objectDef, manifest);
  const permissionCollection = resolvePermissionCollection(permissionObjectDef);

  return `
// Fail-closed authorization (#1540): generated routes require an authenticated
// principal on \`locals\` unless explicitly marked \`@smrt({ api: { public } })\`.
import { apiPrincipalFromLocals, authorize, enforceRouteLimits, isRuntimeModelEnabled, stripTenantFilters, publicSerializerOf, toPublicJSONValue } from '@happyvertical/smrt-core';
const RUNTIME_MODEL = ${JSON.stringify({
    qualifiedName:
      permissionObjectDef.qualifiedName ??
      (permissionObjectDef.packageName
        ? `${permissionObjectDef.packageName}:${permissionObjectDef.className}`
        : undefined),
    replacedQualifiedNames: manifest
      ? Object.entries(manifest.objects)
          .filter(
            ([, candidate]) =>
              candidate.replacedBy === permissionObjectDef.qualifiedName,
          )
          .map(([key]) => key)
      : [],
  })};
const PUBLIC_ACCESS: boolean | 'read' = ${JSON.stringify(publicAccess)};
const READ_PERMISSION_FIELDS: Array<[string, string]> = ${JSON.stringify(readPermissionFields)};
// Operation permissions (#2977): mutating handlers require
// \`<collection>.<action>\`, matching the smrt-users permission catalog slug.
const PERMISSION_COLLECTION = ${JSON.stringify(permissionCollection)};
// The decision itself is the shared one (#5195): these constants are the
// model's policy it is given. A super-admin bypass counts only on a model that
// opts in with \`tenantScoped: { allowSuperAdminBypass: true }\`.
const ALLOW_SUPER_ADMIN_BYPASS = ${JSON.stringify(allowsSuperAdminBypass(permissionObjectDef))};
const TENANT_COLUMNS: ReadonlySet<string> = new Set(${JSON.stringify(manifestTenantColumns(permissionObjectDef))});

interface PublicJsonOptions {
  permissions?: Iterable<string>;
}

${generateRoutePrincipalHelper()}
// One decision for the route (#5195), the one REST makes: sign-in (401), the
// \`<collection>.<action>\` permission of a write (403), and, once a body is
// given, the tenant it names (403 \`TENANT_MISMATCH\`).
function routeDecision(locals: unknown, op: string, mutating: boolean, permissionAction?: string, body?: unknown) {
  return authorize({
    principal: routePrincipal(locals),
    op,
    mutating,
    ...(permissionAction ? { permissionAction } : {}),
    permissionCollection: PERMISSION_COLLECTION,
    publicAccess: PUBLIC_ACCESS,
    allowSuperAdminBypass: ALLOW_SUPER_ADMIN_BYPASS,
    tenantColumns: TENANT_COLUMNS,
    ...(body === undefined ? {} : { body }),
  });
}

// Route limits (#5198), the ones REST applies before \`onRequest\`: a caller over
// its limit is answered with the 429 and \`Retry-After\` before authorization
// or a database read. Tenant, user and caller kind are the decided
// principal's; nothing the client sent chooses them.
function routeRateLimit(locals: unknown, request: Request, clientAddress: () => string): Response | undefined {
  const principal = routePrincipal(locals);
  let address: string | null = null;
  try { address = clientAddress(); } catch { /* no peer address: the limiter falls back */ }
  return enforceRouteLimits({
    request,
    clientAddress: address,
    tenantId: principal.tenantId,
    userId: principal.userId ?? null,
    callerKind: principal.callerKind ?? null,
    authenticated: principal.authenticated,
  });
}

function routeDenial(decision: { status: number; code: string; message: string }): never {
  const body: { message: string; code: string } = {
    message: decision.message,
    code: decision.code,
  };
  throw error(decision.status, body);
}

// Authentication first, then the runtime exposure gate for the request's
// tenant (a switched-off model answers 404 only to an admitted caller), then
// the rest of the decision.
function requireRouteAccess(locals: unknown, op: string, mutating: boolean, permissionAction?: string): void {
  const decision = routeDecision(locals, op, mutating, permissionAction);
  if (!decision.allow && decision.status === 401) routeDenial(decision);
  if (!isRuntimeModelEnabled(RUNTIME_MODEL, { surface: 'rest', locals, tenantId: requestTenantOf(locals) })) {
    throw error(404, 'Not found');
  }
  if (!decision.allow) routeDenial(decision);
}

// A write body may not name another tenant (#5195).
function requireRouteBody(locals: unknown, op: string, body: unknown): void {
  const decision = routeDecision(locals, op, true, undefined, body);
  if (!decision.allow) routeDenial(decision);
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
  const serialize = publicSerializerOf(value);
  if (serialize) {
    seen.add(value);
    return applyReadPermissionRedaction(serialize(options), options, seen);
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
// pass through; a cycle guard prevents infinite loops. \`publicSerializerOf\`
// returns the serialiser a value's class provides, never an instance property.
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
  const serialize = publicSerializerOf(value);
  if (serialize) {
    seen.add(value);
    return toPublicResult(serialize(options), options, seen);
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
 * The registry name an emitted route resolves its request tenancy with at
 * request time: the model's qualified name, or its class name.
 *
 * Emitted routes resolve tenancy from the live registry (`enterTenancy`,
 * #5375) rather than from this manifest, so a model whose tenancy or
 * ownership field is registered at runtime is served like one declared in
 * its manifest.
 */
function readScopeModelName(
  objectDef: SmartObjectDefinition | undefined,
  fallback: string,
): string {
  if (!objectDef) return fallback;
  return (
    objectDef.qualifiedName ??
    (objectDef.packageName
      ? `${objectDef.packageName}:${objectDef.className}`
      : objectDef.className || fallback)
  );
}

/**
 * Emit the page-bounds guard and the deterministic ordering constant for a
 * generated list route (#2367).
 *
 * The route used to parse its own bounds with
 * `Number(url.searchParams.get('limit')) || 50`, which has three faults: it
 * accepts `NaN` from any non-numeric input and binds it (PostgreSQL answers
 * `invalid input syntax for type bigint` — a 500 for a caller typo), it folds a
 * deliberate `limit=0` into 50, and it has no ceiling, so `?limit=100000000` is
 * a full table scan plus a full hydration pass on a public endpoint.
 *
 * The helper is emitted into the route rather than imported from
 * `@happyvertical/smrt-core` so the generated file stays readable on its own and
 * the bound is visible at the call site; the constants come from core so there
 * is still one source of truth.
 */
function generateListBoundsHelper(objectDef: SmartObjectDefinition): string {
  const orderBy = resolveDefaultListOrderBy(objectDef);
  return `
/** Deterministic list ordering (#2367); matching index is #2363. */
const LIST_ORDER_BY = ${JSON.stringify(orderBy)};

/**
 * Parse \`?limit\`/\`?offset\` (#2367): default when absent, 400 when malformed,
 * clamped to ${MAX_LIST_LIMIT} when oversized.
 */
function listBounds(url: URL): { limit: number; offset: number } {
  const parse = (name: 'limit' | 'offset', fallback: number, max?: number): number => {
    const raw = url.searchParams.get(name);
    if (raw === null || raw === '') {
      return max === undefined ? fallback : Math.min(fallback, max);
    }
    if (!/^\\d+$/.test(raw.trim())) {
      throw error(400, \`Invalid \${name}: '\${raw}' is not a non-negative integer.\`);
    }
    const value = Number(raw.trim());
    if (!Number.isSafeInteger(value)) {
      throw error(400, \`Invalid \${name}: '\${raw}' is not a non-negative integer.\`);
    }
    return max === undefined ? value : Math.min(value, max);
  };

  return {
    limit: parse('limit', ${DEFAULT_LIST_LIMIT}, ${MAX_LIST_LIMIT}),
    offset: parse('offset', 0),
  };
}
`;
}

/**
 * Deterministic default ordering for a generated list route (#2367).
 *
 * The list route pages with `LIMIT`/`OFFSET` and previously emitted no
 * `ORDER BY` at all. That is not pagination: without an ordering PostgreSQL may
 * return rows in any order and is free to pick a different one per query, so
 * page 2 can repeat rows from page 1 and skip others entirely — silently, and
 * only under concurrency or a plan change, which is why it survived review.
 *
 * `created_at DESC` alone is not enough (rows created in the same tick tie), so
 * the primary key follows as a total-order tiebreak. The matching index is
 * #2363.
 */
function resolveDefaultListOrderBy(
  objectDef: SmartObjectDefinition,
): readonly string[] {
  // A class declaring its own primary key has no `id` column to tie-break on
  // (`id`/`slug`/`context` are omitted for custom-PK classes), so order by the
  // declared key instead.
  //
  // The flag is read from BOTH `_meta.primaryKey` and the top level: scanner
  // manifests — the input this generator actually runs on — carry it under
  // `_meta`, while decorator option bags mirror some flags at the top level.
  // Checking only the top level silently never matches, which is exactly the
  // case that would emit an `id` tiebreak for a table without an `id` column.
  const customPrimaryKey = Object.entries(objectDef.fields ?? {}).find(
    ([, fieldDef]) =>
      fieldDef?._meta?.primaryKey === true ||
      (fieldDef as { primaryKey?: boolean } | undefined)?.primaryKey === true,
  )?.[0];

  return buildDefaultListOrderBy(customPrimaryKey);
}

/**
 * The per-handler guard preamble: the fail-closed auth check (#1540 2c), the
 * permission check of a write, and the request's tenancy for every model
 * (#5375).
 */
function routeGuardPreamble(
  _objectDef: SmartObjectDefinition,
  mutating: boolean,
  permissionAction?: 'create' | 'update' | 'delete',
  readOperation: 'list' | 'get' = 'list',
): string {
  const lines: string[] = [
    // Before any decision, as REST's \`onRequest\` position (#5198).
    '  const limited = routeRateLimit(locals, request, getClientAddress);',
    '  if (limited) return limited;',
  ];
  if (mutating) {
    if (!permissionAction) {
      throw new Error('Mutating generated routes require a permission action');
    }
    lines.push(
      `  requireRouteAccess(locals, ${JSON.stringify(permissionAction)}, true);`,
    );
    // The request's tenancy (#5375): a write needs a tenant, whatever the
    // model's tenancy mode and whether it was declared or registered at run
    // time.
    lines.push(`  enterTenancy(locals, ${JSON.stringify(permissionAction)});`);
  } else {
    lines.push(
      `  requireRouteAccess(locals, ${JSON.stringify(readOperation)}, false);`,
      `  const tenancy = enterTenancy(locals, ${JSON.stringify(readOperation)});`,
    );
  }
  return lines.join('\n');
}

function buildRouteHandlerArgs(
  includeParams: boolean,
  includeRequest: boolean,
): string {
  // `locals` is always destructured so the fail-closed auth guard (#1540) can
  // inspect the authenticated principal.
  const args: string[] = ['locals', 'getClientAddress'];

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
  httpMethod?: string,
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

  return parameters.map((parameter, index) => {
    // Read from the same object the single-options form receives: on a GET
    // action that is the tenant-scoped options, so a named ownership
    // parameter never carries the caller's value.
    const access = buildOptionsPropertyAccess(
      parameter.name,
      optionsIdentifier,
    );
    // A JSON body and a query string can only carry a `Date` as its ISO
    // string, so hydrate it here. The wire-ability gate accepts a `Date`
    // parameter precisely BECAUSE this conversion exists; drop one and the
    // other must go too, or the generator writes a route that 500s on the
    // first `getTime()` (#2686). The cast restores the declared parameter
    // type, which the runtime helper widens to `unknown`.
    // A GET handler builds its options from `URLSearchParams`, so EVERY value
    // is a string and `limit: number` reached the method as `'2'`. A JSON body
    // carries real numbers and booleans, so decode only on GET; `Date` is
    // hydrated on both because a JSON body cannot carry one either (#2686).
    const decoder =
      httpMethod === 'GET'
        ? queryStringDecoderFor(declaredParameterType(parameter))
        : declaredTypeAcceptsDate(declaredParameterType(parameter))
          ? 'toCustomActionDate'
          : undefined;
    return decoder ? `${decoder}(${access}) as ActionArgs[${index}]` : access;
  });
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
        ...(isSingleOptionsParameter
          ? [
              '  const searchParams = new URL(request.url).searchParams;',
              "  const optionsMarker = searchParams.get('__smrt_options');",
              '  const options = (',
              "    optionsMarker === 'undefined' ||",
              '    (optionsMarker === null && searchParams.size === 0)',
              '      ? undefined',
              "      : optionsMarker === 'null'",
              '        ? null',
              "        : optionsMarker === 'object'",
              '          ? {}',
              '          : Object.fromEntries(',
              '              [...searchParams.entries()].filter(',
              "                ([key]) => key !== '__smrt_options',",
              '              ),',
              '            )',
              '  ) as ActionArgs[0];',
            ]
          : [
              '  const options = Object.fromEntries(',
              '    new URL(request.url).searchParams.entries(),',
              '  ) as ActionOptions;',
            ]),
        '',
      );
    }
    return lines.join('\n');
  }

  if (hasPathParams) {
    lines.push(
      `  const pathParams = ${pathParamsObjectLiteral};`,
      '  const rawBody = await request.text();',
      "  const body: unknown = rawBody.trim() === '' ? undefined : JSON.parse(rawBody);",
      '  const options = {',
      '    ...readJsonRecord(body),',
      '    ...pathParams,',
      `  } as ${isSingleOptionsParameter ? 'ActionArgs[0]' : 'ActionOptions'};`,
      '',
    );
    return lines.join('\n');
  }

  lines.push(
    '  const rawBody = await request.text();',
    "  const body: unknown = rawBody.trim() === '' ? undefined : JSON.parse(rawBody);",
  );
  if (isSingleOptionsParameter) {
    lines.push('  const options = body as ActionArgs[0];', '');
  } else {
    lines.push('  const options = readJsonRecord(body) as ActionOptions;', '');
  }
  return lines.join('\n');
}

function buildOptionsPropertyAccess(
  propertyName: string,
  optionsIdentifier = 'options',
): string {
  if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(propertyName)) {
    return `${optionsIdentifier}.${propertyName}`;
  }

  const escapedPropertyName = propertyName
    .replaceAll('\\', '\\\\')
    .replaceAll("'", "\\'");

  return `${optionsIdentifier}['${escapedPropertyName}']`;
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

/**
 * Whether a GET action's options are built through `scopeActionOptions`
 * (every GET action that declares parameters). Whether the scope then reaches
 * the method is `readActionReceivesTenantScope`'s question.
 */
function receivesTenantReadOptions(
  actionDef: MethodDefinition,
  routeConfig: ResolvedApiActionRouteConfig,
): boolean {
  return (
    routeConfig.method === 'GET' &&
    Array.isArray(actionDef.parameters) &&
    actionDef.parameters.length > 0
  );
}

function buildScopedOptionsForTenantRead(
  actionDef: MethodDefinition,
  routeConfig: ResolvedApiActionRouteConfig,
): { source: string; optionsIdentifier: string } {
  // A read action never takes ownership from the caller. Core's
  // `scopeActionOptions` (runtime REST uses it too) drops every ownership key
  // from the request options — `tenantId` and each ownership field under its
  // property or column name — and sets the request's tenant scope under the
  // model's ownership property: the actor's tenant, or null (rows without an
  // owner) for a caller with no tenant. It leaves the options alone for a
  // model that is not tenant-scoped, with tenancy off, or for a system actor
  // or an applicable super-admin bypass, as the request's tenancy decided.
  // Zero-argument methods that perform their own raw reads must infer tenant
  // scope in their implementation or adopt the options contract.
  if (!receivesTenantReadOptions(actionDef, routeConfig)) {
    return { source: '', optionsIdentifier: 'options' };
  }

  return {
    source: `  const scopedOptions = scopeActionOptions(tenancy, options);

`,
    optionsIdentifier: 'scopedOptions',
  };
}

function findItemClassRegistryKey(
  className: string,
  objectDef: SmartObjectDefinition,
  manifest: SmartObjectManifest,
): string {
  const itemObject = resolveCollectionItemObject(manifest, objectDef);
  if (!itemObject) {
    return resolveCollectionItemTypeName(manifest, objectDef) || className;
  }

  const manifestMatch = Object.entries(manifest.objects).find(
    ([, manifestObject]) => manifestObject === itemObject,
  );
  return manifestMatch?.[0] || itemObject.className;
}

type CustomActionRouteGroupSpec = Pick<
  GeneratedActionRouteSpec,
  'actionName' | 'hostType' | 'lookupClassName' | 'routeConfig'
>;

function assertCompatibleCustomActionRouteSpecs(
  routeSpecs: readonly CustomActionRouteGroupSpec[],
): void {
  const [firstSpec] = routeSpecs;
  if (!firstSpec) return;

  const { hostType, lookupClassName, routeConfig } = firstSpec;
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
}

function groupCustomActionRoutes<T extends CustomActionRouteGroupSpec>(
  actionSpecs: Array<{
    routeDir: string;
    spec: T;
  }>,
): Map<string, T[]> {
  const groupedRoutes = new Map<string, T[]>();

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

  for (const routeSpecs of groupedRoutes.values()) {
    assertCompatibleCustomActionRouteSpecs(routeSpecs);
  }

  return groupedRoutes;
}

/** Reject selected identities that would write the same endpoint file. */
export function assertNoCrossObjectRouteCollisions(
  projectRoot: string,
  manifest: SmartObjectManifest,
  options: SvelteKitOptions,
  exposureManifest: SmartObjectManifest,
  reservedRoutePaths: ReadonlySet<string> = new Set(),
): void {
  type RouteWriter =
    | 'crud-collection'
    | 'crud-item'
    | 'custom-action'
    | 'sync-apply'
    | 'changes'
    | 'dev-plane'
    | 'events'
    | 'resources'
    | 'knowledge';
  const claims = new Map<string, { owner: string; writer: RouteWriter }>();
  const caseBehaviours = new Map<string, RouteCaseBehaviour>();
  const claimPath = (
    routePath: string,
    routeDir: string,
    owner: string,
    writer: RouteWriter,
  ) => {
    // The same physical identity the route-file plan uses: case-only aliases
    // are one handler unless the destination is known to be case-sensitive.
    const physical = physicalRouteFileKey(
      dirname(routePath),
      undefined,
      caseBehaviours,
    );
    const canonicalRoutePath =
      physical.behaviour === 'sensitive' ? physical.exact : physical.folded;
    const prior = claims.get(canonicalRoutePath);
    if (prior && (prior.owner !== owner || prior.writer !== writer)) {
      throw new Error(
        `Conflicting SvelteKit route ${routeDir}: ${prior.owner} (${prior.writer}) and ${owner} (${writer}) would write the same handler`,
      );
    }
    claims.set(canonicalRoutePath, { owner, writer });
  };
  const claim = (routeDir: string, owner: string, writer: RouteWriter) =>
    claimPath(
      join(projectRoot, routeDir, '+server.ts'),
      routeDir,
      owner,
      writer,
    );
  for (const routePath of reservedRoutePaths) {
    claimPath(
      resolve(routePath),
      relative(projectRoot, routePath),
      'producer knowledge',
      'knowledge',
    );
  }
  for (const [className, objectDef] of orderedManifestObjectEntries(manifest)) {
    if (isFrameworkBaseClass(objectDef.className, objectDef.packageName))
      continue;
    const routeDir = join(options.routesDir, objectDef.collection);
    if (isCollectionManifestClass(manifest, objectDef)) {
      const actionSpecs = resolveApiCustomActions(
        objectDef,
        exposureManifest,
        true,
      ).exposed.map(([actionName, actionDef]) => {
        const routeConfig = resolveApiActionRouteConfig(
          actionName,
          actionDef,
          objectDef.decoratorConfig?.api,
          { kebabRoutes: options.kebabRoutes },
          'collection',
        );
        return {
          routeDir: join(routeDir, ...routeConfig.pathSegments),
          spec: {
            actionName,
            hostType: 'collection' as const,
            lookupClassName: findItemClassRegistryKey(
              className,
              objectDef,
              manifest,
            ),
            routeConfig,
          },
        };
      });
      for (const [actionRouteDir] of groupCustomActionRoutes(actionSpecs)) {
        claim(actionRouteDir, className, 'custom-action');
      }
      continue;
    }
    const actions = resolveStandardCrudActions(objectDef.decoratorConfig?.api);
    if (actions.some((action) => action === 'list' || action === 'create'))
      claim(routeDir, className, 'crud-collection');
    if (
      actions.some(
        (action) =>
          action === 'get' || action === 'update' || action === 'delete',
      )
    )
      claim(join(routeDir, '[id]'), className, 'crud-item');
    const actionSpecs = resolveApiCustomActions(
      objectDef,
      exposureManifest,
      false,
    ).exposed.map(([actionName, actionDef]) => {
      const routeConfig = resolveApiActionRouteConfig(
        actionName,
        actionDef,
        objectDef.decoratorConfig?.api,
        { kebabRoutes: options.kebabRoutes },
      );
      return {
        routeDir: join(
          routeConfig.scope === 'collection'
            ? routeDir
            : join(routeDir, '[id]'),
          ...routeConfig.pathSegments,
        ),
        spec: {
          actionName,
          hostType: 'item' as const,
          lookupClassName: className,
          routeConfig,
        },
      };
    });
    for (const [actionRouteDir] of groupCustomActionRoutes(actionSpecs)) {
      claim(actionRouteDir, className, 'custom-action');
    }
  }
  // These generator-owned utility files share the same filesystem namespace.
  // Claim only paths their current output predicates can emit.
  if (collectSyncApplyTargets(manifest).length > 0) {
    claim(join(options.routesDir, 'sync', 'apply'), 'sync/apply', 'sync-apply');
  }
  const hasAnchor = Object.values(manifest.objects).some(
    (objectDef) => !isCollectionManifestClass(manifest, objectDef),
  );
  if (hasAnchor && options.changesRoute?.enabled !== false) {
    claim(join(options.routesDir, '_changes'), '_changes', 'changes');
  }
  if (willGenerateDevPlaneRoute(projectRoot, options)) {
    claim(join(options.routesDir, '_dev', '[...tool]'), '_dev', 'dev-plane');
  }
  if (hasAnchor && options.eventsRoute?.enabled !== false) {
    claim(join(options.routesDir, '_events'), '_events', 'events');
  }
  if (reservesResourcesRoute(projectRoot, options)) {
    claim(join(options.routesDir, '_resources'), '_resources', 'resources');
  }
  if (options.knowledge?.api?.enabled) {
    const routeDir = knowledgeRouteDir(projectRoot, options);
    claimPath(join(routeDir, '+server.ts'), routeDir, 'knowledge', 'knowledge');
  }
}

/**
 * Generates SvelteKit API routes from the selected route manifest.
 * `semanticManifest` preserves the complete class inventory for authorization,
 * STI ancestry, cache safety, and custom-action wireability when the route
 * manifest is a deliberately selected output subset.
 */
export interface SvelteKitUtilityManifests {
  sync: SmartObjectManifest;
  changes: SmartObjectManifest;
  events: SmartObjectManifest;
  eventsSemantic: SmartObjectManifest;
  /** Only the contribution that owns knowledge generation may reconcile it. */
  clearKnowledgeRoute?: boolean;
  /** Exact foreign producer outputs that this route root must neither clear nor overwrite. */
  protectedRoutePaths?: ReadonlySet<string>;
  /** Active foreign route roots that cleanup must not traverse through links. */
  protectedRouteRoots?: ReadonlySet<string>;
}

/** Coordinator callbacks that run around validated generated-output mutation. */
export interface SvelteKitGenerationHooks {
  beforeCleanup?: () => void | Promise<void>;
}

export async function generateSvelteKitRoutes(
  projectRoot: string,
  routeManifest: SmartObjectManifest,
  options: SvelteKitOptions,
  semanticManifest: SmartObjectManifest = routeManifest,
  utilityManifests: SvelteKitUtilityManifests = {
    sync: routeManifest,
    changes: routeManifest,
    events: routeManifest,
    eventsSemantic: semanticManifest,
    clearKnowledgeRoute: true,
  },
  registrationManifest: SmartObjectManifest = routeManifest,
  hooks: SvelteKitGenerationHooks = {},
): Promise<void> {
  if (!options.enabled) return;
  // Before any write: the config module must not alias generated output.
  assertSvelteKitConfigModuleNotReserved(options);

  console.log('[smrt] Generating SvelteKit routes...');

  if (options.rejectRouteCollisions) {
    assertNoCrossObjectRouteCollisions(
      projectRoot,
      routeManifest,
      options,
      semanticManifest,
      utilityManifests.protectedRoutePaths,
    );
  }

  if (options.lazyActivation) {
    // A manifest whose registration order is impossible must fail before the
    // generated routes are cleared, so earlier output stays published and
    // consistent with its registration.
    generateActivationRegistration(registrationManifest, {
      projectRoot,
      outputDir: join(projectRoot, options.configPath || 'src/lib/server'),
      splitDeclarations: true,
    });
  }

  // Render every route file into one in-memory plan. Rendering never touches
  // the disk: the plan is checked against the route tree before anything of
  // this invocation changes (#5437).
  const routesRoot = join(projectRoot, options.routesDir);
  const plan = new RouteFilePlan({
    protectedPaths: utilityManifests.protectedRoutePaths,
  });
  let generatedCount = 0;
  let skippedCollections = 0;
  for (const [className, objectDef] of orderedManifestObjectEntries(
    routeManifest,
  )) {
    // The framework's own abstract base classes (SmrtObject,
    // SmrtCollection, ...) are scaffolding, not resources — never generate
    // a route directory for them, regardless of config (#2642).
    if (isFrameworkBaseClass(objectDef.className, objectDef.packageName)) {
      continue;
    }
    if (isCollectionManifestClass(semanticManifest, objectDef)) {
      const collectionRoutePaths = await generateCollectionRoutesForObject(
        projectRoot,
        className,
        objectDef,
        semanticManifest,
        options,
        plan,
      );
      if (collectionRoutePaths.length > 0) {
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
      semanticManifest,
      options,
      plan,
    );
    generatedCount++;
  }

  if (options.knowledge?.api?.enabled) {
    generateKnowledgeRoute(projectRoot, options, plan);
  }

  // Batch write contract route (#1759): {routesDir}/sync/apply/+server.ts.
  generateSyncApplyRoute(projectRoot, utilityManifests.sync, options, plan);
  // Change-feed route (#1758) — cleanup rides the generated-route sweep.
  generateChangesRoute(projectRoot, utilityManifests.changes, options, plan);
  generateDevPlaneRoute(projectRoot, options, plan);
  // Live change-signal SSE route (#1763) — cleanup rides the sweep.
  generateEventsRoute(
    projectRoot,
    utilityManifests.events,
    options,
    plan,
    computeWebManifestHash(utilityManifests.eventsSemantic),
  );
  // CLI discovery route (#2663): a fallback, emitted only when no other route
  // claims its path, and yielding to a hand-written handler.
  generateResourcesRoute(projectRoot, options, plan);

  // Read-only: every planned path is checked before the hooks, the sweep,
  // the config and registration writes, and any route file.
  // Every directory the sweep will walk must be listable, or the sweep could
  // stop part-way after removing earlier generated files.
  plan.preflight(
    findUnlistableRouteDirectories(
      routesRoot,
      utilityManifests.protectedRouteRoots,
    ).map((finding) => ({ ...finding, route: 'generated-route sweep' })),
  );

  await hooks.beforeCleanup?.();

  clearGeneratedSvelteKitRouteFiles(
    routesRoot,
    utilityManifests.protectedRoutePaths,
    utilityManifests.protectedRouteRoots,
  );
  if (utilityManifests.clearKnowledgeRoute !== false) {
    clearGeneratedKnowledgeRoute(projectRoot, options, plan);
  }

  // Generate centralized configuration file first (if it doesn't exist)
  await generateSmrtConfigFile(projectRoot, registrationManifest, options);

  const generatedRoutePaths = plan.commit();

  // Ignore only the concrete route files generated in this pass. This keeps
  // handwritten handlers below routesDir visible to Git.
  updateGitignore(
    projectRoot,
    generatedRoutePaths,
    join(projectRoot, svelteKitRouteRoot(options.routesDir)),
  );

  const skippedMsg =
    skippedCollections > 0
      ? ` (skipped ${skippedCollections} collection classes)`
      : '';
  console.log(
    `[smrt] Generated routes for ${generatedCount} SMRT objects${skippedMsg}`,
  );
}

/** Remove only SMRT header-owned SvelteKit handlers below one route root. */
export function clearGeneratedSvelteKitRouteFiles(
  routesRoot: string,
  excludedPaths: ReadonlySet<string> = new Set(),
  protectedRouteRoots: ReadonlySet<string> = new Set(),
  visitedRoots: Set<string> = new Set(),
): void {
  const canonicalRoot = canonicalSvelteKitPath(routesRoot);
  if (
    protectedRouteRoots.has(canonicalRoot) ||
    visitedRoots.has(canonicalRoot)
  ) {
    return;
  }
  if (!existsSync(routesRoot)) {
    return;
  }
  visitedRoots.add(canonicalRoot);

  for (const entry of readdirSync(routesRoot, { withFileTypes: true })) {
    const entryPath = join(routesRoot, entry.name);

    if (isSvelteKitRouteDirectory(entryPath, entry)) {
      clearGeneratedSvelteKitRouteFiles(
        entryPath,
        excludedPaths,
        protectedRouteRoots,
        visitedRoots,
      );
      continue;
    }

    if (!entry.isFile() || entry.name !== '+server.ts') {
      continue;
    }
    if (excludedPaths.has(canonicalSvelteKitPath(entryPath))) continue;

    // Re-checked immediately before the unlink: only a file that is generated
    // at this moment is removed.
    removeGeneratedRouteFile(entryPath);
  }
}

function isSvelteKitRouteDirectory(
  entryPath: string,
  entry: { isDirectory(): boolean; isSymbolicLink?(): boolean },
): boolean {
  if (entry.isDirectory()) return true;
  if (!entry.isSymbolicLink?.()) return false;
  try {
    return statSync(entryPath).isDirectory();
  } catch {
    return false;
  }
}

/** Refresh the managed ignore block after an externally coordinated cleanup. */
export function reconcileSvelteKitRouteGitignore(
  projectRoot: string,
  routesDir: string,
): void {
  updateGitignore(
    projectRoot,
    [],
    join(projectRoot, svelteKitRouteRoot(routesDir)),
  );
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

/** Exact generated knowledge handler path for coordinator-owned cleanup. */
export function knowledgeRoutePath(
  projectRoot: string,
  options: SvelteKitOptions,
): string {
  return join(knowledgeRouteDir(projectRoot, options), '+server.ts');
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
  plan: RouteFilePlan,
): void {
  // Another producer in this build owns the handler at this path; compared
  // as emission compares it (a case-only alias counts on a volume that is
  // not known to be case-sensitive).
  if (plan.protects(knowledgeRouteDir(projectRoot, options))) return;
  removeGeneratedRouteFile(knowledgeRoutePath(projectRoot, options));
}

function generateKnowledgeRoute(
  projectRoot: string,
  options: SvelteKitOptions,
  plan: RouteFilePlan,
): string {
  const routeDir = knowledgeRouteDir(projectRoot, options);
  const route = generateKnowledgeRouteTemplate(
    options.knowledge ?? {},
    readKnowledgeRouteArtifact(projectRoot),
  );
  return plan.emit({
    root: join(projectRoot, svelteKitRouteRoot(options.routesDir)),
    routeDir,
    content: route,
    label: 'knowledge',
  });
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
  // Collection decorators install their real constructor under the item,
  // but do not register their own discovery metadata. Publish only explicitly
  // exposed HTTP CLI action hosts and the collection ancestry needed to resolve
  // them; ordinary/default collections retain their side-effect-only startup.
  const collectionMetadata = new Map<string, SmartObjectDefinition>();
  const manifestKeys = new Map(
    Object.entries(manifest.objects).map(([key, value]) => [value, key]),
  );
  for (const objectDef of Object.values(manifest.objects)) {
    if (!isCollectionManifestClass(manifest, objectDef)) continue;
    if (!isCollectionActionResource(manifest, objectDef)) continue;
    let current: SmartObjectDefinition | undefined = objectDef;
    const seen = new Set<SmartObjectDefinition>();
    while (
      current &&
      !seen.has(current) &&
      isCollectionManifestClass(manifest, current)
    ) {
      seen.add(current);
      const key = manifestKeys.get(current);
      if (key)
        collectionMetadata.set(
          key,
          portableObjectManifest(projectRoot, current),
        );
      const parent: string | undefined =
        current.extendsQualified || current.extends;
      current = parent
        ? findManifestObjectByName(manifest, parent, current)
        : undefined;
    }
  }
  if (options.lazyActivation) {
    const generated = generateActivationRegistration(manifest, {
      projectRoot,
      outputDir: configDir,
      collectionMetadata: [...collectionMetadata.keys()],
      splitDeclarations: true,
    });
    if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true });
    // JavaScript is valid TypeScript here; generated metadata is deliberately
    // JSON, so large superset schemas are never inferred as TypeScript types.
    for (const file of Object.keys(generated.files))
      mkdirSync(resolve(configDir, file, '..'), { recursive: true });
    const smrtDir = join(projectRoot, '.smrt');
    if (!existsSync(smrtDir)) mkdirSync(smrtDir, { recursive: true });
    publishArtifactFiles([
      ...Object.entries(generated.files).map(([file, content]) => ({
        path: join(configDir, file),
        content,
      })),
      {
        path: join(smrtDir, 'activation-manifest.json'),
        content: JSON.stringify(generated.manifest, null, 2),
      },
      {
        path: registrationFilePath,
        // The build's stamp travels in the lazy registration too (#4929).
        content: `${buildSchemaImportFor(projectRoot, configDir, manifest)}\n${generated.source}`,
      },
    ]);
    return;
  }
  const externalRuntimeDependencies = (manifest.smrtDependencies || []).filter(
    (dependency) => dependency !== '@happyvertical/smrt-core',
  );
  const consumerRegistrationPaths =
    options.consumerRegistrationPaths ??
    (externalRuntimeDependencies.length > 0
      ? [join(projectRoot, '.smrt', 'register.js')]
      : []);
  const consumerOwnsExternalRegistration = consumerRegistrationPaths.length > 0;

  // Group objects by package for efficient imports
  const localObjects: Array<[string, (typeof manifest.objects)[string]]> = [];
  const packageObjects = new Map<
    string,
    {
      objects: Array<{
        simpleName: string;
        bindingName: string;
      }>;
      hasCollectionImport: boolean;
    }
  >();
  const registrationBindings = buildRegistrationBindings(manifest);

  for (const [className, objectDef] of Object.entries(manifest.objects)) {
    if (isLocalObject(projectRoot, objectDef)) {
      // Local object (source in project, not node_modules) - use $lib path
      localObjects.push([className, objectDef]);
    } else if (objectDef.packageName) {
      if (consumerOwnsExternalRegistration) continue;
      // External packages may publish canonical object exports from a subpath
      // under an aliased export name. Registry identity stays keyed by the
      // manifest's qualified class name; only the emitted module binding uses
      // that canonical import contract.
      const externalImportPath = objectDef.importPath || objectDef.packageName;
      const packageEntry = packageObjects.get(externalImportPath) || {
        objects: [],
        hasCollectionImport: false,
      };

      if (
        isCollectionManifestClass(manifest, objectDef) &&
        !hasGeneratedCollectionActions(manifest, objectDef)
      ) {
        packageEntry.hasCollectionImport = true;
      } else {
        packageEntry.objects.push({
          simpleName: objectDef.exportName || extractSimpleClassName(className),
          bindingName:
            registrationBindings.get(className) ||
            extractSimpleClassName(className),
        });
      }

      packageObjects.set(externalImportPath, packageEntry);
    } else {
      // No package name and not local - treat as local fallback
      localObjects.push([className, objectDef]);
    }
  }

  // Generate imports for local objects
  // Issue #870: Extract simple class names from qualified names
  const localNamedImports = new Map<
    string,
    Array<{ simpleName: string; bindingName: string }>
  >();
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

    if (
      isCollectionManifestClass(manifest, objectDef) &&
      !hasGeneratedCollectionActions(manifest, objectDef)
    ) {
      localSideEffectImports.add(importPath);
      continue;
    }

    const existing = localNamedImports.get(importPath) ?? [];
    existing.push({
      simpleName: simpleClassName,
      bindingName: registrationBindings.get(className) || simpleClassName,
    });
    localNamedImports.set(importPath, existing);
  }

  const localImports = [
    ...Array.from(localNamedImports.entries())
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([importPath, importedObjects]) => {
        const sortedNames = importedObjects
          .sort((a, b) => a.bindingName.localeCompare(b.bindingName))
          .map(formatRegistrationImport);
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

      if (packageEntry.objects.length > 0) {
        const simpleNames = packageEntry.objects
          .sort((a, b) => a.bindingName.localeCompare(b.bindingName))
          .map(formatRegistrationImport);
        imports.push(
          `import { ${simpleNames.join(', ')} } from '${packageName}';`,
        );
      }

      return imports;
    })
    .join('\n');

  const imports = [packageImports, localImports].filter(Boolean).join('\n');
  const buildSchemaImport = buildSchemaImportFor(
    projectRoot,
    configDir,
    manifest,
  );
  let consumerRegistrationImport = '';
  if (consumerRegistrationPaths.length > 0) {
    consumerRegistrationImport = [...new Set(consumerRegistrationPaths)]
      .sort()
      .map((registerPath) => {
        const lexicalRegistrationPath = relative(projectRoot, registerPath);
        const registerPathFromProjectRoot =
          lexicalRegistrationPath === '..' ||
          lexicalRegistrationPath.startsWith(`..${sep}`) ||
          isAbsolute(lexicalRegistrationPath)
            ? relative(
                canonicalSvelteKitPath(projectRoot),
                canonicalSvelteKitPath(registerPath),
              )
            : lexicalRegistrationPath;
        const registrationTarget =
          registerPathFromProjectRoot === '..' ||
          registerPathFromProjectRoot.startsWith(`..${sep}`) ||
          isAbsolute(registerPathFromProjectRoot)
            ? registerPath
            : resolve(projectRoot, registerPathFromProjectRoot);
        const consumerRegistrationPath = relative(
          configDir,
          registrationTarget,
        ).replace(/\\/g, '/');
        return `import '${consumerRegistrationPath.startsWith('.') ? consumerRegistrationPath : `./${consumerRegistrationPath}`}';`;
      })
      .join('\n');
  }
  /**
   * Strip machine specifics from an object definition before it is embedded in
   * generated source.
   *
   * `smrt-register.ts` is a tracked file in consumer repositories, and the
   * scanner records `filePath` as an absolute path. Embedding it verbatim wrote
   * the generating machine's home directory into the repository, so the file
   * could never be committed without breaking every other checkout and CI, and
   * every build left a dirty working tree (#2341). The field is only produced
   * at scan time — nothing reads it back through `_manifest` at runtime — so a
   * project-relative path keeps the shape without the machine.
   */
  function portableObjectManifest(
    root: string,
    objectDef: SmartObjectDefinition,
  ): SmartObjectDefinition {
    const { filePath } = objectDef;
    if (typeof filePath !== 'string' || !isAbsolute(filePath)) {
      return objectDef;
    }
    return {
      ...objectDef,
      filePath: relative(root, filePath).split(sep).join('/'),
    };
  }

  // Per-module copies of the manifest never carry the build's stamp: startup
  // reads it from the project manifest, never from a registered copy (#4929).
  // Nor the retired list: the build's description carries it (#5005).
  const {
    schemaFingerprint: _buildStamp,
    retiredTables: _retired,
    ...registrationBase
  } = manifest;
  const collectionMetadataLiteral = JSON.stringify(
    JSON.stringify({
      ...registrationBase,
      objects: Object.fromEntries(collectionMetadata),
    }),
  );

  const registrationManifests = Object.fromEntries(
    Object.entries(manifest.objects).flatMap(([className, objectDef]) => {
      if (isCollectionManifestClass(manifest, objectDef)) return [];
      const localObject = isLocalObject(projectRoot, objectDef);
      if (!localObject && consumerOwnsExternalRegistration) return [];
      const packageName = getRegistrationPackageName(
        manifest,
        objectDef,
        localObject,
      );
      if (!packageName) return [];
      return [
        [
          className,
          {
            packageName,
            objects: {
              [className]: portableObjectManifest(projectRoot, objectDef),
            },
          },
        ],
      ];
    }),
  );
  const registrationManifestLiteral = JSON.stringify(
    JSON.stringify(registrationManifests),
  );
  // Aggregate-level fields are emitted once and merged by reference at load,
  // not repeated per object (#5028).
  const {
    objects: _allObjects,
    packageName: _sharedPackageName,
    ...registrationShared
  } = registrationBase;
  const registrationSharedLiteral = JSON.stringify(
    JSON.stringify(registrationShared),
  );
  const registrations = Object.entries(manifest.objects)
    .map(([className, objectDef]) => {
      if (isCollectionManifestClass(manifest, objectDef)) {
        // Importing the collection class is enough to trigger its decorator.
        // Explicit package-qualified re-registration only applies to object
        // classes, because ObjectRegistry.register() is object-only.
        return null;
      }

      const simpleClassName = extractSimpleClassName(className);
      const bindingName =
        registrationBindings.get(className) || simpleClassName;
      const localObject = isLocalObject(projectRoot, objectDef);
      if (!localObject && consumerOwnsExternalRegistration) return null;
      const packageName = getRegistrationPackageName(
        manifest,
        objectDef,
        localObject,
      );

      if (!packageName) {
        return null;
      }

      const packageNameLiteral = toSingleQuotedStringLiteral(packageName);
      const manifestKeyLiteral = toSingleQuotedStringLiteral(className);
      const singleLineRegistration = `ObjectRegistry.register(${bindingName}, { name: '${simpleClassName}', packageName: ${packageNameLiteral}, _manifest: smrtRegistrationManifests[${manifestKeyLiteral}], _manifestKey: ${manifestKeyLiteral} });`;

      if (singleLineRegistration.length <= BIOME_LINE_WIDTH) {
        return singleLineRegistration;
      }

      return [
        `ObjectRegistry.register(${bindingName}, {`,
        `  name: '${simpleClassName}',`,
        `  packageName: ${packageNameLiteral},`,
        `  _manifest: smrtRegistrationManifests[${manifestKeyLiteral}],`,
        `  _manifestKey: ${manifestKeyLiteral},`,
        `});`,
      ].join('\n');
    })
    .filter((registration): registration is string => registration !== null)
    .join('\n');

  const collectionRegistrations = Object.entries(manifest.objects)
    .filter(
      ([, objectDef]) =>
        hasGeneratedCollectionActions(manifest, objectDef) &&
        (!consumerOwnsExternalRegistration ||
          isLocalObject(projectRoot, objectDef)),
    )
    .map(([className, objectDef]) => {
      const qualifiedName = collectionResourceRegistryKey(
        projectRoot,
        className,
        objectDef,
        manifest,
      );
      const bindingName =
        registrationBindings.get(className) ||
        extractSimpleClassName(className);
      return `ObjectRegistry.registerCollection(${JSON.stringify(qualifiedName)}, ${bindingName});`;
    })
    .join('\n');

  const registrationContent = `/**
 * Auto-generated SMRT object registration
 * DO NOT EDIT - changes will be overwritten
 *
 * Importing these modules triggers their @smrt() decorators, which perform
 * the initial registration. The explicit re-registration below is intentional:
 * it upgrades bundled runtimes to deterministic qualified registrations.
 */

${buildSchemaImport}
import { ObjectRegistry } from '@happyvertical/smrt-core';

${consumerRegistrationImport}
${imports}

const smrtRegistrationManifests = JSON.parse(${registrationManifestLiteral});
const smrtRegistrationShared = JSON.parse(${registrationSharedLiteral});
for (const key of Object.keys(smrtRegistrationManifests)) {
  smrtRegistrationManifests[key] = { ...smrtRegistrationShared, ...smrtRegistrationManifests[key] };
}

// Re-register imported objects with explicit package names for bundled runtimes
${registrations}
${
  collectionMetadata.size > 0
    ? `
// Metadata only: collection constructors were installed by their decorators.
ObjectRegistry.registerPackageManifest(JSON.parse(${collectionMetadataLiteral}));
`
    : ''
}
// Bind every generated REST action receiver, independently of discovery eligibility.
${collectionRegistrations}
`;

  // Create directory if it doesn't exist
  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true });
  }

  writeFileSync(registrationFilePath, registrationContent, 'utf-8');
  console.log(`[smrt] Generated registration file: ${registrationFilePath}`);
}

/** REST action receivers need a live binding even when CLI discovery is closed. */
function hasGeneratedCollectionActions(
  manifest: SmartObjectManifest,
  objectDef: SmartObjectDefinition,
): boolean {
  return (
    isCollectionManifestClass(manifest, objectDef) &&
    resolveApiActionSet(objectDef, manifest).size > 0
  );
}

/** Named HTTP CLI collection actions need metadata and a live receiver binding. */
function isCollectionActionResource(
  manifest: SmartObjectManifest,
  objectDef: SmartObjectDefinition,
): boolean {
  if (!isCollectionManifestClass(manifest, objectDef)) return false;
  const cli = objectDef.decoratorConfig?.cli;
  if (
    !cli ||
    typeof cli !== 'object' ||
    !Array.isArray(cli.include) ||
    cli.http === false ||
    (cli.exclude !== undefined && !Array.isArray(cli.exclude))
  )
    return false;
  const apiActions = resolveApiActionSet(objectDef, manifest);
  const cliActions = resolveCliActionSet(objectDef);
  return cli.include.some(
    (name) => name !== '*' && apiActions.has(name) && cliActions.has(name),
  );
}

function buildRegistrationBindings(
  manifest: SmartObjectManifest,
): Map<string, string> {
  const keysBySimpleName = new Map<string, string[]>();
  const reservedBindings = new Set<string>();
  for (const [manifestKey, objectDef] of Object.entries(manifest.objects)) {
    if (
      isCollectionManifestClass(manifest, objectDef) &&
      !hasGeneratedCollectionActions(manifest, objectDef)
    )
      continue;
    const simpleName = extractSimpleClassName(manifestKey);
    reservedBindings.add(simpleName);
    const keys = keysBySimpleName.get(simpleName) ?? [];
    keys.push(manifestKey);
    keysBySimpleName.set(simpleName, keys);
  }

  const bindings = new Map<string, string>();
  const generatedBindings = new Set<string>();
  for (const [simpleName, keys] of keysBySimpleName) {
    const sortedKeys = keys.sort((a, b) => a.localeCompare(b));
    for (const [index, manifestKey] of sortedKeys.entries()) {
      let bindingName = simpleName;
      if (sortedKeys.length > 1) {
        let suffix = index + 1;
        do {
          bindingName = `__smrt_${simpleName}_${suffix}`;
          suffix += 1;
        } while (
          reservedBindings.has(bindingName) ||
          generatedBindings.has(bindingName)
        );
        generatedBindings.add(bindingName);
      }
      bindings.set(manifestKey, bindingName);
    }
  }
  return bindings;
}

function formatRegistrationImport(importedObject: {
  simpleName: string;
  bindingName: string;
}): string {
  return importedObject.simpleName === importedObject.bindingName
    ? importedObject.simpleName
    : `${importedObject.simpleName} as ${importedObject.bindingName}`;
}

/**
 * Whether `@happyvertical/smrt-app-runtime/sveltekit` resolves from the
 * consumer at `projectRoot` under ESM import conditions (same signal as
 * `consumerHasSmrtUsers`; see `consumer-import.ts`), with an existing file
 * target.
 */
function consumerHasSmrtAppRuntime(projectRoot: string): boolean {
  return consumerResolvesImport(
    projectRoot,
    '@happyvertical/smrt-app-runtime/sveltekit',
  );
}

/** Default config module for apps that install the application runtime. */
const RUNTIME_CONFIG_FILE_CONTENT = `/**
 * The application's SMRT runtime (\`@happyvertical/smrt-app-runtime\`).
 * Generated once by the smrt() Vite plugin because this file was missing; it
 * is never overwritten, so add application options here.
 *
 * The plugin registers the generated objects before this module runs, and
 * generated API routes resolve collections through \`runtime.getCollection()\`
 * (request-scoped). In the local profile the runtime holds the single-writer
 * lease; pass \`acquireWriterLease: false\` to opt out.
 */

import { createProviderReadinessProbe } from '@happyvertical/smrt-app-runtime';
import { createSmrtSvelteKitRuntime } from '@happyvertical/smrt-app-runtime/sveltekit';

export const runtime = createSmrtSvelteKitRuntime({
  providerReadiness: createProviderReadinessProbe,
});
`;

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

  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true });
  }

  // Apps that install the SMRT application runtime get a runtime-shaped
  // config: generated routes resolve collections through `runtime`.
  if (consumerHasSmrtAppRuntime(projectRoot)) {
    writeFileSync(configFilePath, RUNTIME_CONFIG_FILE_CONTENT, 'utf-8');
    console.log(`[smrt] Generated configuration file: ${configFilePath}`);
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

// \`__smrtGetRequestScopedDatabase\` is declared canonically by
// @happyvertical/smrt-core; importing its types above is enough to see it.
// Do not redeclare it here — duplicate \`declare global\` entries must be
// type-identical, and a second declaration broke consumer checks (#2342).

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
  semanticManifest: SmartObjectManifest,
  options: SvelteKitOptions,
  plan: RouteFilePlan,
): Promise<string[]> {
  const collectionName = objectDef.collection;
  const routesRoot = join(projectRoot, options.routesDir);
  const routeDir = join(routesRoot, collectionName);
  const generatedRoutePaths: string[] = [];

  // Check if API is enabled for this object
  const apiConfig = objectDef.decoratorConfig?.api;
  if (apiConfig === false) {
    console.log(`[smrt] Skipping ${className} - API disabled`);
    return generatedRoutePaths;
  }

  // Determine which CRUD actions to include via the shared resolver.
  const includedActions = resolveStandardCrudActions(apiConfig);

  // Generate collection route (list, create)
  if (includedActions.includes('list') || includedActions.includes('create')) {
    const collectionRoute = generateCollectionRouteTemplate(
      projectRoot,
      className,
      objectDef,
      semanticManifest,
      includedActions,
      options,
      routeDir,
    );
    generatedRoutePaths.push(
      plan.emit({
        root: routesRoot,
        routeDir,
        content: applyRouteCors(collectionRoute, options.cors),
        label: `${className} collection`,
      }),
    );
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
      semanticManifest,
      includedActions,
      options,
      join(routeDir, '[id]'),
    );
    generatedRoutePaths.push(
      plan.emit({
        root: routesRoot,
        routeDir: join(routeDir, '[id]'),
        content: applyRouteCors(itemRoute, options.cors),
        label: `${className} item`,
      }),
    );
  }

  // Generate custom action routes. Eligibility -- CRUD reservation, framework
  // lifecycle methods, include/exclude, `@method()` overrides, wire-ability,
  // and the receiver check -- comes from the ONE shared resolver every API
  // consumer reads, so a route is written exactly when `resolveApiActionSet`
  // and the knowledge artifact say one exists (#2686).
  const { exposed: customActions, rejected } = resolveApiCustomActions(
    objectDef,
    semanticManifest,
    false,
  );
  warnUnhostedActions(className, rejected);

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
    warnDeclaredScopeMismatch(
      className,
      actionName,
      actionDef,
      apiConfig,
      routeConfig.scope,
    );

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
      semanticManifest,
      options,
    );
    generatedRoutePaths.push(
      plan.emit({
        root: join(projectRoot, options.routesDir),
        routeDir: actionRouteDir,
        content: applyRouteCors(actionRoute, options.cors),
        label: `${className} action ${routeSpecs.map(({ actionName }) => actionName).join(', ')}`,
      }),
    );
  }

  return generatedRoutePaths;
}

async function generateCollectionRoutesForObject(
  projectRoot: string,
  className: string,
  objectDef: SmartObjectDefinition,
  semanticManifest: SmartObjectManifest,
  options: SvelteKitOptions,
  plan: RouteFilePlan,
): Promise<string[]> {
  const generatedRoutePaths: string[] = [];
  const apiConfig = objectDef.decoratorConfig?.api;
  if (apiConfig === false) {
    console.log(`[smrt] Skipping ${className} - API disabled`);
    return generatedRoutePaths;
  }

  const routeDir = join(projectRoot, options.routesDir, objectDef.collection);
  const lookupClassName = findItemClassRegistryKey(
    className,
    objectDef,
    semanticManifest,
  );
  const lookupObjectDef = findObjectDefByRegistryKey(
    semanticManifest,
    lookupClassName,
  );
  const { exposed: customActions, rejected } = resolveApiCustomActions(
    objectDef,
    semanticManifest,
    true,
  );
  warnUnhostedActions(className, rejected);

  if (customActions.length === 0) {
    return generatedRoutePaths;
  }
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
    warnDeclaredScopeMismatch(
      className,
      actionName,
      actionDef,
      apiConfig,
      routeConfig.scope,
    );

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
      semanticManifest,
      options,
    );
    generatedRoutePaths.push(
      plan.emit({
        root: join(projectRoot, options.routesDir),
        routeDir: actionRouteDir,
        content: applyRouteCors(actionRoute, options.cors),
        label: `${className} action ${routeSpecs.map(({ actionName }) => actionName).join(', ')}`,
      }),
    );
  }

  return generatedRoutePaths;
}

/**
 * Warn about the one rejection class that would be a structural failure rather
 * than a configuration choice: an action whose declared scope has no receiver
 * to bind. Both emitters carried this warning before #2686 moved the check into
 * the shared resolver, and the message text is preserved.
 *
 * It cannot currently fire — `resolveCustomActionMetadata` collapses a
 * contradicting scope back to the receiver-derived one, as it did before this
 * change; see `resolveActionReceiver` in `generators/custom-action.ts`. The
 * warning a developer actually sees for a contradicting declaration is
 * `warnDeclaredScopeMismatch` below.
 *
 * Every other rejection is silent here and reported with its reason through
 * the knowledge artifact instead, so a normal build is not buried in output
 * for the 2% of methods the heuristic legitimately withholds.
 */
function warnUnhostedActions(
  className: string,
  rejected: Array<[string, ApiMethodExposure]>,
): void {
  for (const [actionName, decision] of rejected) {
    if (decision.code !== 'no-receiver') continue;
    console.warn(
      `[smrt] Skipping ${className}.${actionName} - ${decision.reason}`,
    );
  }
}

/**
 * Report a declared `scope` that contradicts the method's actual receiver.
 *
 * The declaration is honored only where it AGREES; nothing in config can move
 * an instance method onto the class. Warning is the whole remedy — the route
 * is still emitted at the receiver-derived URL, so an author who expected the
 * other one learns why it is missing instead of silently getting nothing at
 * either address (#2686).
 */
function warnDeclaredScopeMismatch(
  className: string,
  actionName: string,
  actionDef: MethodDefinition,
  apiConfig: unknown,
  effectiveScope: 'item' | 'collection',
): void {
  const declared = resolveDeclaredScopeMismatch({
    actionName,
    method: actionDef,
    apiConfig,
    effectiveScope,
  });
  if (!declared) return;
  console.warn(
    `[smrt] ${className}.${actionName} declares scope '${declared}' but its receiver is ` +
      `${effectiveScope}-scoped, so the declared scope is ignored. A scope describes where a ` +
      `method already lives; it cannot move it. Make ${actionName} static to reach it on the ` +
      'collection, or drop the scope option.',
  );
}

/**
 * Detail for a single cli-vs-api coherence violation.
 */
export interface CliApiCoherenceViolation {
  className: string;
  unreachable: string[];
  /**
   * Names in `cli.skipApiCheck`'s array form that aren't a CRUD verb or a
   * scanned public method on this class -- a typo, most likely. Checked
   * against that real command inventory rather than the (possibly
   * `cli.include`-typo'd) effective CLI command set on purpose: an explicit
   * `cli.include` trusts its own entries verbatim (see `resolveCliActionSet`'s
   * doc comment -- catching an include typo is `unreachable`'s job), so an
   * identical typo duplicated into `skipApiCheck` must not "recognize"
   * itself via that untrusted echo (PR #2860 review). Always a build error
   * (smrt#2857): an unrecognized name grants no exemption at all, which
   * would silently reproduce the exact class-wide-waiver drift this check
   * exists to prevent. Present only when non-empty.
   */
  invalidSkipApiCheck?: string[];
}

/**
 * Resolve the effective CLI command set for an object, for the cli↔api
 * coherence lint. Two distinct resolutions, chosen by whether `cli.include`
 * is spelled out:
 *
 * **Explicit `cli.include`** (preserves the lint's exact pre-#2638
 * algorithm): the literal `include − exclude`, verbatim, whether or not an
 * entry resolves to a real CRUD verb or a scanned public method. This is
 * deliberate, not an oversight -- an `include` entry that names a typo, a
 * getter (never in the manifest's `methods` map), or a private/protected
 * method (the scanner drops these rather than recording `isPublic: false`,
 * so nothing else catches it) must still surface as "unreachable" so the
 * build fails loudly on the config mistake, the same way it always has.
 * Resolving it instead through `resolveCustomActionNames` -- which only
 * iterates real scanned methods -- would silently drop such an entry with no
 * error at all (final review, #2638).
 *
 * **Bare `cli: true`/`cli: {}`** (#2638, the new case this lint now
 * inspects): every public custom method minus exclude, exactly the "every
 * public method minus exclude" resolution this function shares with
 * `packages/core/src/generators/custom-action.ts`'s `resolveCustomActionNames`
 * -- lifecycle methods excluded, same as everywhere else. (Pre-#2664, core's
 * now-retired `CLIGenerator.listCommands()` applied the same resolution via
 * that helper too.)
 * CRUD verbs are NOT checked in this branch: a class that closes its API
 * entirely (`api: false`) while keeping a default-open, CLI/MCP-only admin
 * surface (`cli: true`/omitted) is a common, intentional combination (see
 * `cli.skipApiCheck`'s own "in-process, no HTTP" doc comment); blanket-
 * checking CRUD reachability for every such class would flag that existing,
 * legitimate pattern across the whole codebase, not just the #2638 defect
 * (confirmed by running this against the full monorepo build during
 * development — it did exactly that).
 */
function resolveCliActionSet(objectDef: SmartObjectDefinition): Set<string> {
  const cliConfig = objectDef.decoratorConfig?.cli;
  if (cliConfig === false) return new Set();

  const included: string[] | undefined =
    typeof cliConfig === 'object' && cliConfig !== null
      ? cliConfig.include
      : undefined;
  const excluded: string[] =
    typeof cliConfig === 'object' &&
    cliConfig !== null &&
    Array.isArray(cliConfig.exclude)
      ? cliConfig.exclude
      : [];

  if (included) {
    return new Set(included.filter((cmd) => !excluded.includes(cmd)));
  }

  return resolveCustomActionNames(
    Object.entries(objectDef.methods || {}),
    { include: undefined, exclude: excluded },
    CRUD_OPERATIONS,
  );
}

/**
 * Inspect a manifest and return classes whose effective CLI command set —
 * `cli.include`/`cli.exclude` when spelled out, or (#2638) the same "every
 * public method minus exclude" default `cli: true`/`cli: {}` resolves to —
 * references a command not exposed via the API. `cli: { skipApiCheck: true }`
 * skips the whole class; `cli: { skipApiCheck: [...] }` (smrt#2857) skips
 * only the named commands, leaving every other command in the class's
 * effective set checked. So does a class with `cli: false` (no CLI surface
 * at all).
 *
 * A name in the array form that isn't a CRUD verb or a scanned public
 * method on the class is reported back via `invalidSkipApiCheck` on the
 * violation entry -- see `validateCliIncludeAgainstApi`, which always
 * throws for it regardless of that gate's narrower `cli.include` filter.
 *
 * Throws nothing else; returns the violation list so callers can choose to
 * throw or warn.
 */
export function findCliApiCoherenceViolations(
  manifest: SmartObjectManifest,
): CliApiCoherenceViolation[] {
  const violations: CliApiCoherenceViolation[] = [];

  for (const [className, objectDef] of Object.entries(manifest.objects)) {
    const cliConfig = objectDef.decoratorConfig?.cli;
    if (cliConfig === false) continue;

    const skipApiCheck: boolean | string[] | undefined =
      typeof cliConfig === 'object' && cliConfig !== null
        ? cliConfig.skipApiCheck
        : undefined;

    if (skipApiCheck === true) continue;

    const effectiveCliCommands = resolveCliActionSet(objectDef);

    let invalidSkipApiCheck: string[] = [];
    let skipNames: Set<string> = new Set();
    if (Array.isArray(skipApiCheck) && skipApiCheck.length > 0) {
      // The *typo/stale-entry* check validates against the class's real
      // command inventory -- CRUD verbs plus scanned PUBLIC methods --
      // deliberately NOT against `effectiveCliCommands` for an explicit
      // `cli.include` (PR #2860 review, GitHub Copilot). `resolveCliActionSet`
      // trusts an explicit `cli.include` verbatim, typos included (see its
      // own doc comment: catching that kind of typo is `unreachable`'s job,
      // not this one's) -- so if `knownNames` were `effectiveCliCommands`
      // there, a name mistyped identically in BOTH `cli.include` and
      // `skipApiCheck` (e.g. `include: ['reconclieGame']`,
      // `skipApiCheck: ['reconclieGame']`) would be "recognized" only
      // because it's an unverified echo of itself, get silently exempted
      // via `skipNames` below, and never surface as `unreachable` OR
      // `invalidSkipApiCheck` -- defeating the very guarantee this array
      // form exists to provide.
      //
      // A non-public method is excluded from `knownNames` too (recall
      // finding, smrt#2857 review): it is not part of the real CLI surface,
      // so naming one is still a genuine mistake, not a name this lint's
      // narrower `effectiveCliCommands` resolution merely declines to check.
      const knownNames = new Set([
        ...CRUD_OPERATIONS,
        ...Object.entries(objectDef.methods || {})
          .filter(([, method]) => method.isPublic)
          .map(([name]) => name),
      ]);

      // Being a real command isn't enough on its own (PR #2860 review,
      // second pass): a name can be a genuine public method yet no longer
      // part of THIS class's effective CLI command set -- e.g. `audit` was
      // dropped from `cli.include` (or moved to `cli.exclude`) after the
      // `skipApiCheck: ['audit']` waiver was written, and nobody removed
      // the now-stale entry. Require membership in `effectiveCliCommands`
      // too, so that case is still an error -- restoring the exact
      // detection the first Copilot-driven fix (5a8f09929) accidentally
      // dropped by switching validity off `effectiveCliCommands` entirely.
      // The carve-out: the bare `cli: true`/`cli: {}` resolution
      // deliberately excludes CRUD verbs AND framework-lifecycle method
      // overrides from `effectiveCliCommands` (see `resolveCliActionSet`'s
      // own doc comment, and `resolveCustomActionNames`'s
      // `isFrameworkLifecycleMethod` skip) -- that omission is this lint's
      // own narrower check declining to look at them there (recall
      // finding, third pass), not a sign that such a name is stale, so
      // neither is ever "stale" on that branch.
      const hasExplicitInclude =
        typeof cliConfig === 'object' &&
        cliConfig !== null &&
        Array.isArray(cliConfig.include);
      const isInEffectiveSurface = (name: string) =>
        effectiveCliCommands.has(name) ||
        (!hasExplicitInclude &&
          ((CRUD_OPERATIONS as readonly string[]).includes(name) ||
            isFrameworkLifecycleMethod(name)));

      invalidSkipApiCheck = skipApiCheck
        .filter((name) => !knownNames.has(name) || !isInEffectiveSurface(name))
        .sort();
      skipNames = new Set(
        skipApiCheck.filter((name) => effectiveCliCommands.has(name)),
      );
    }

    if (effectiveCliCommands.size === 0) {
      if (invalidSkipApiCheck.length > 0) {
        violations.push({ className, unreachable: [], invalidSkipApiCheck });
      }
      continue;
    }

    const apiActionSet = resolveApiActionSet(objectDef, manifest);
    // A collection class has no CRUD routes of its own: its CRUD commands
    // run the model's operations, so they are reachable exactly where the
    // model's API routes them. Collections inherit their model's `cli`
    // include list (`registry/collection-exposure.ts`), so without this
    // every inherited CRUD verb would read as unreachable.
    if (isCollectionManifestClass(manifest, objectDef)) {
      const item = resolveCollectionItemObject(manifest, objectDef);
      if (item && item !== objectDef) {
        for (const action of resolveStandardCrudActions(
          item.decoratorConfig?.api,
        )) {
          apiActionSet.add(action);
        }
      }
    }
    const unreachable = [...effectiveCliCommands]
      .filter((action) => !apiActionSet.has(action) && !skipNames.has(action))
      .sort();

    if (unreachable.length > 0 || invalidSkipApiCheck.length > 0) {
      violations.push({
        className,
        unreachable,
        ...(invalidSkipApiCheck.length > 0 ? { invalidSkipApiCheck } : {}),
      });
    }
  }

  return violations;
}

/**
 * Throw if any class in the manifest has an EXPLICIT `cli.include` command
 * that isn't reachable via the API. Default build-time gate; opt-out
 * per-class via `cli: { skipApiCheck: true }` (or globally via the vite
 * plugin option `validateCliApiCoherence: false`).
 *
 * This is deliberately narrower than `findCliApiCoherenceViolations` above.
 * That function is now fully correct for the broader `cli: true`/`cli: {}`
 * default surface too (#2638: same "every public method minus exclude"
 * resolution core's now-retired `CLIGenerator.listCommands()` used (#2664),
 * so a bare `cli: true` is inspected the same as an explicit `include`).
 * But `smrtPlugin()`'s default
 * `validateCliApiCoherence: true` calls this THROWING gate unconditionally
 * from every consuming package's own build (`configResolved`,
 * `vite-plugin/index.ts`) -- and a full-monorepo build during #2638
 * development showed that broader surface has thousands of pre-existing
 * public getters/business-logic methods (e.g.
 * `@happyvertical/smrt-ads:AdGroup.hasStarted`,
 * `@happyvertical/smrt-tags:Tag.getParent`) across ~28 packages that were
 * never meant to be REST-reachable and have no API route today. That
 * over-exposure is real, pre-existing, and unrelated to #2638's framework-
 * lifecycle-method defect -- flipping this gate to enforce it unconditionally
 * would break every one of those packages' builds today, which is a
 * repo-wide triage effort (add routes, or an explicit `cli.exclude`/
 * `skipApiCheck` per owner) this PR did not undertake and is out of its
 * file boundary. So the gate keeps its pre-#2638 blast radius -- classes
 * that spell out a non-empty `cli.include` -- while `findCliApiCoherenceViolations`
 * is complete and available (and covered by its own tests) for the broader
 * check once that pre-existing surface is triaged.
 */
export function validateCliIncludeAgainstApi(
  manifest: SmartObjectManifest,
): void {
  const allViolations = findCliApiCoherenceViolations(manifest);

  // An invalid `cli.skipApiCheck` array entry (smrt#2857) is a config bug in
  // its own right -- a typo or stale name grants no exemption at all, which
  // would silently reintroduce the class-wide-waiver drift this check
  // exists to prevent. Always throw for it, independent of the narrower
  // explicit-`cli.include` filter below (that filter exists only to avoid
  // breaking pre-existing broad-surface classes; there is no such
  // pre-existing usage of the array form to protect).
  const invalidSkipApiCheckMessages = allViolations.flatMap(
    ({ className, invalidSkipApiCheck }) =>
      (invalidSkipApiCheck ?? []).map(
        (name) =>
          `[smrt] ${className}: cli.skipApiCheck names '${name}', which isn't a\n` +
          `  CRUD verb or a scanned public method on this class, or isn't part of\n` +
          `  its current cli.include/cli.exclude surface (a typo, or a stale\n` +
          `  entry left behind after the command was dropped from cli.include).\n` +
          `  Fix the typo, or remove '${name}' from cli.skipApiCheck -- an\n` +
          `  unrecognized or stale name grants no exemption at all.`,
      ),
  );

  const violations = allViolations.filter(({ className, unreachable }) => {
    if (unreachable.length === 0) return false;
    const cliConfig = manifest.objects[className]?.decoratorConfig?.cli;
    return (
      typeof cliConfig === 'object' &&
      cliConfig !== null &&
      Array.isArray(cliConfig.include) &&
      cliConfig.include.length > 0
    );
  });

  if (violations.length === 0 && invalidSkipApiCheckMessages.length === 0) {
    return;
  }

  const messages = [
    ...invalidSkipApiCheckMessages,
    ...violations.flatMap(({ className, unreachable }) => {
      // Only suggest the narrow `skipApiCheck: ['<action>']` form when
      // `<action>` would actually be accepted by it (PR #2860 review, F1):
      // `unreachable` can also contain a `cli.include` entry that names no
      // real CRUD verb or scanned public method at all (a typo, or a
      // getter -- see `resolveCliActionSet`'s doc comment), and suggesting
      // the array form for THAT case would just route the developer into
      // `invalidSkipApiCheck`'s contradictory-sounding second failure.
      const methods = manifest.objects[className]?.methods ?? {};
      const isRealCommandName = (name: string) =>
        (CRUD_OPERATIONS as readonly string[]).includes(name) ||
        methods[name]?.isPublic === true;

      return unreachable.map((action) => {
        const skipApiCheckSuggestion = isRealCommandName(action)
          ? ` (or \`skipApiCheck: ['${action}']\` to acknowledge only this command)`
          : '';
        return (
          `[smrt] ${className}.${action} is exposed as a CLI command but is not exposed via the api.\n` +
          `  Either:\n` +
          `    - Decorate '${action}' with @method({ expose: true }) to route it, or\n` +
          `    - Add '${action}' to api.include, or\n` +
          `    - Remove '${action}' from cli.include / add it to cli.exclude.\n` +
          `  The CLI invokes methods over HTTP; methods without API routes are unreachable.\n` +
          `  A public method is routed by default only when every parameter can be\n` +
          `  built from JSON; @method({ expose: true }) overrides that for one method\n` +
          `  without widening api.include. See withheldSurfaces in the knowledge\n` +
          `  artifact for the reason this one was withheld (#2686).\n` +
          `  If this CLI is intentionally invoked in-process (no HTTP), set\n` +
          `  \`cli: { skipApiCheck: true }\`${skipApiCheckSuggestion} on the\n` +
          `  @smrt() decorator.`
        );
      });
    }),
  ];

  throw new Error(messages.join('\n\n'));
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
function generateTypedRouteErrorHelper(): string {
  return `
function smrtRouteErrorResponse(cause: unknown, request: Request) {
  const failure = normalizeTypedHttpError(cause);
  if (failure) return json({ error: failure }, { status: failure.status });
  return json(reportUnexpectedHttpError(cause, request), { status: 500 });
}
`;
}

/**
 * The policy of every member of a model's STI family, keyed by the member's
 * registry key (and its simple name), read from the manifest: what the shared
 * decision is told about a subtype that is selected through its base (a create
 * target) or that a row loaded through the base belongs to. The manifest knows
 * what the registry does not (a hosted subclass moved to its own route keeps
 * the base's `<collection>` slugs, #3770). Empty for a model with no family.
 */
function familyPolicyOf(
  objectDef: SmartObjectDefinition,
  manifest: SmartObjectManifest | undefined,
): Record<
  string,
  {
    publicAccess: boolean | 'read';
    permissionCollection: string;
    allowSuperAdminBypass: boolean;
    tenantColumns: string[];
  }
> {
  const policy: ReturnType<typeof familyPolicyOf> = {};
  if (!tenancyFamilyScope(objectDef, manifest)) return policy;
  for (const member of collectStiHierarchyObjects(objectDef, manifest)) {
    const entry = {
      publicAccess: getApiPublicAccess(member.decoratorConfig?.api),
      permissionCollection: resolvePermissionCollection(member),
      allowSuperAdminBypass: allowsSuperAdminBypass(member),
      tenantColumns: manifestTenantColumns(member),
    };
    policy[readScopeModelName(member, member.className)] = entry;
    policy[member.className] ??= entry;
  }
  return policy;
}

/**
 * Emit the decision for the model a write lands in when that is not the
 * route's own model (an STI subtype selected through its base on create, or
 * the subtype a loaded row belongs to on update and delete, #5195). The
 * subtype decides under its own `api.public`, `<collection>.<action>` slug,
 * super-admin opt-in and tenant columns, as REST's `authorizeRowModel` and
 * `assertWriteBody` do: from the manifest when it lists the member, else from
 * the same registry read REST uses (`modelRoutePolicy`), so a subtype
 * registered at run time is decided like any other.
 */
function generateFamilyAccessHelper(
  objectDef: SmartObjectDefinition,
  manifest: SmartObjectManifest | undefined,
  options: { rowAccess: boolean },
): string {
  return `${options.rowAccess ? "\nimport { foreignRowModel, modelRoutePolicy } from '@happyvertical/smrt-core';" : "\nimport { modelRoutePolicy, RequestPrincipalRefusal } from '@happyvertical/smrt-core';"}

// Policy of each STI family member the manifest lists (#5195).
const FAMILY_POLICY: Record<string, { publicAccess: boolean | 'read'; permissionCollection: string; allowSuperAdminBypass: boolean; tenantColumns: string[] }> = ${JSON.stringify(familyPolicyOf(objectDef, manifest))};

// A write that lands in an STI subtype is decided under the subtype's own
// policy, as the runtime REST handler does.
function modelDecision(locals: unknown, model: string, op: string, body?: unknown) {
  const listed = FAMILY_POLICY[model];
  return authorize({
    principal: routePrincipal(locals),
    op,
    mutating: true,
    ...(listed ? { ...listed, tenantColumns: new Set(listed.tenantColumns) } : modelRoutePolicy(model)),
    ...(body === undefined ? {} : { body }),
  });
}
${
  options.rowAccess
    ? `
// A row loaded through the base that belongs to a subtype is written under the
// subtype's policy too.
function requireRowAccess(locals: unknown, row: object, op: string, body?: unknown): void {
  const model = foreignRowModel(row, TENANCY_MODEL);
  // A row whose own model cannot be resolved is refused, never decided under
  // the route's policy.
  if (model === null) routeDenial({ status: 403, code: 'PERMISSION_DENIED', message: 'Permission denied.' });
  if (!model) return;
  const decision = modelDecision(locals, model, op, body);
  if (!decision.allow) routeDenial(decision);
}
`
    : `
// The create target is decided inside the handler's try block, so a refusal is
// thrown as the typed error the block answers, with REST's envelope and code.
function requireCreateTargetAccess(locals: unknown, model: string, body: unknown): void {
  const decision = modelDecision(locals, model, 'create', body);
  if (!decision.allow) throw new RequestPrincipalRefusal(decision.status, decision.code, decision.message);
}
`
}`;
}

/**
 * Emit `rejectRouteRead(cause)`: a lookup the collection or the tenancy
 * interceptor refuses (a typed 4xx, a tenant isolation or missing-tenant
 * refusal) answers with its status; any other failure is rethrown.
 */
function generateRouteReadErrorHelper(): string {
  return `
function rejectRouteRead(cause: unknown): never {
  const failure = normalizeTypedHttpError(cause);
  if (failure) {
    // A variable: the body of error() is typed App.Error, which has no code.
    const body: { message: string; code: string } = { message: failure.message, code: failure.code };
    throw error(failure.status, body);
  }
  throw cause;
}
`;
}

/**
 * Emit the list route's query helpers.
 *
 * `listQuery` reads the caller's filter and ordering and refuses any that
 * names a field the caller may not read, with the same `assertQueryAccess`
 * rule and the same projection options the runtime REST route uses.
 * `rejectListQuery` answers a query the route or the collection refuses (a
 * typed 4xx) with that status. Every other failure is rethrown unchanged.
 */
function generateListQueryHelper(className: string): string {
  return `
// A query the route or the collection refuses is a client error, not a
// server fault. The public body keeps the refusal's code.
function rejectListQuery(cause: unknown): never {
  const failure = normalizeTypedHttpError(cause);
  if (failure) {
    const body: { message: string; code: string } = {
      message: failure.message,
      code: failure.code,
    };
    throw error(failure.status, body);
  }
  throw cause;
}

// The caller's filter and ordering. Both may name only fields this caller
// may read: the permissions the rows are projected with. A repeated query
// parameter is refused (400) rather than read as one of its values.
function listQuery(
  url: URL,
  options: PublicJsonOptions,
): { where: Record<string, unknown>; orderBy: string | null } {
  const orderBy = url.searchParams.get('orderBy');
  try {
    const where = parseRestListWhere(url.searchParams, ${JSON.stringify(className)});
    assertQueryAccess(${JSON.stringify(className)}, { where, orderBy }, options);
    return { where, orderBy };
  } catch (cause) {
    rejectListQuery(cause);
  }
}
`;
}

function generateCollectionRouteTemplate(
  projectRoot: string,
  className: string,
  objectDef: SmartObjectDefinition,
  semanticManifest: SmartObjectManifest,
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
    options.lazyActivation,
  );
  const serializerImports = serializers.importStatements.join('\n');
  // A custom list serializer can render related-table data the per-table
  // change-feed version cannot observe (#1765), so such routes keep the v1
  // body-hash ETag; the default toPublicJSON path uses the v2 version source.
  const listUsesSerializer = !!serializers.listItemSerializerName;
  const readPermissionFields = collectReadPermissionFields(
    objectDef,
    semanticManifest,
  );
  const listUsesPermissionScopedBody =
    readPermissionFields.length > 0 || !!objectDef.displayLabelProjection;
  const listUsesBodyHash = listUsesSerializer || listUsesPermissionScopedBody;
  // The build-time web-collection shape digest (#1764) salts the v2 read ETag so
  // a shape-only deploy (no table write) busts every read validator. Deterministic
  // for a given manifest — same value the generated virt-web module exports and
  // the client persistence namespace keys on.
  const webManifestHash = computeWebManifestHash(semanticManifest);
  const collectionAccessImports = generateCollectionAccessImports(
    projectRoot,
    routeDir,
    options,
    ['getCollection'],
  );

  const imports = `${AUTO_GENERATED_ROUTE_HEADER}
// DO NOT EDIT - changes will be overwritten

import { error${hasPost ? ', json' : ''} } from '@sveltejs/kit';
${hasGet ? "import { assertQueryAccess, parseRestListWhere } from '@happyvertical/smrt-core';\n" : ''}${hasGet ? "import { applyWhereScope, tenancyReadScope } from '@happyvertical/smrt-core';\n" : ''}${hasGet && !hasPost ? "import { normalizeTypedHttpError } from '@happyvertical/smrt-core';\n" : ''}
${serializerImports ? `${serializerImports}\n` : ''}${hasPost ? "import { assertCreateInput, assertCreateTargetSurface, ObjectRegistry, normalizeTypedHttpError, prepareWriteInput, reportUnexpectedHttpError } from '@happyvertical/smrt-core';\n" : ''}
${modelType.importStatement ? `${modelType.importStatement}\n` : ''}import type { RequestHandler } from './$types';
${collectionAccessImports}
// Note: ${className} is auto-registered by the Vite plugin scanner
${generateAuthGuardHelper(objectDef, semanticManifest)}${generateTenantContextHelper(usesPrincipalContext(objectDef), readScopeModelName(objectDef, className), tenancyFamilyScope(objectDef, semanticManifest))}${hasPost ? generateTypedRouteErrorHelper() : ''}${hasPost ? generateFamilyAccessHelper(objectDef, semanticManifest, { rowAccess: false }) : ''}${hasGet ? generateListBoundsHelper(objectDef) : ''}${hasGet ? generateListQueryHelper(className) : ''}${hasGet ? generateConditionalGetRouteHelper(objectDef.decoratorConfig?.api, { runtimeExposure: true, tenantScoped: isTenantScoped(objectDef), permissionScoped: listUsesPermissionScopedBody, modelName: className, readScopeModel: readScopeModelName(objectDef, className), useBodyHash: listUsesBodyHash, manifestHash: webManifestHash }) : ''}`;

  // #1782: tenant-scoped reads fail closed to global (NULL-tenant) rows when no
  // tenant context is active (public/anonymous read). The scope is resolved at
  // request time from the live registry, as runtime REST resolves it, so
  // tenancy registered after generation is honoured; it is `undefined` for a
  // model that is not tenant-scoped. `applyWhereScope` drops every query filter
  // on the ownership column, under any spelling of the key, before adding the
  // scope, so the scope is the only ownership predicate in the query.
  // #2367: every generated page is ordered. `LIST_ORDER_BY` is emitted as a
  // module constant so the ordering is visible in the generated file rather
  // than implied by the database's row order.
  // `query` is the caller's filter and ordering, already checked against the
  // fields this caller may read (`listQuery`), before any ETag or table work.
  const listWhere =
    'applyWhereScope(stripTenantFilters(routePrincipal(locals), TENANT_COLUMNS, query.where), tenancyReadScope(tenancy)) ?? {}';
  const listAndCount = `  const where = ${listWhere};
  const orderBy = query.orderBy || LIST_ORDER_BY;
  const items = await collection.list({ limit, offset, orderBy, where${objectDef.displayLabelProjection ? ', displayLabel: true' : ''} }).catch(rejectListQuery);
  const count = await collection.count({ where }).catch(rejectListQuery);`;

  const getHandler = hasGet
    ? `
// List all ${className.toLowerCase()}s
export const GET: RequestHandler = async ({ locals, url, request, getClientAddress }) => {
${routeGuardPreamble(objectDef, false, undefined, 'list')}
  const publicJsonOptions = getPublicJsonOptions(locals);
  const { limit, offset } = listBounds(url);
  const query = listQuery(url, publicJsonOptions);

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
  const items_public = items.map((item) => toPublicJSONValue(item, publicJsonOptions));
  return conditionalJson(request, { items: items_public, count, limit, offset });`
      : `  // ETag v2 (#1765): the table-version ETag is checked first; on a concrete
  // If-None-Match the list query below never runs (zero-query 304).
  return conditionalVersionedRead(request, collection.db, collection.tableName, async () => {
${listAndCount}
    const items_public = items.map((item) => toPublicJSONValue(item, publicJsonOptions));
    return { items: items_public, count, limit, offset };
  });`
}
};
`
    : '';

  const postHandler = hasPost
    ? `
// Create new ${className.toLowerCase()}
export const POST: RequestHandler = async ({ locals, request, getClientAddress }) => {
${routeGuardPreamble(objectDef, true, 'create')}
  const publicJsonOptions = getPublicJsonOptions(locals);
  const body: unknown = await request.json();
  requireRouteBody(locals, 'create', body);
  try {
    const target = ObjectRegistry.resolveCreateTarget('${className}', body, {
      surface: 'rest', tenantId: requestTenantOf(locals), locals, request,
    });
    // A subtype whose own surface closes create is not a target here, and
    // a subtype authorizes its own create as well as the base.
    assertCreateTargetSurface('${className}', target, 'api');
    if (target.collectionName !== '${className}') requireCreateTargetAccess(locals, target.name, body);
    // A create sets no field the caller may not write: server-managed keys
    // are skipped, a protected field sent with a value is refused.
    const data = prepareWriteInput(target.collectionName, target.data);
    const collection = await getCollection${modelType.typeName ? `<${modelType.typeName}>` : ''}(target.collectionName);
    // Create input names declared fields and settable accessors only.
    assertCreateInput(target.collectionName, data, collection);
    const item = await collection.create(data);
${
  serializers.itemSerializerName
    ? `
    const serializedItem = await ${serializers.itemSerializerName}(item);

    return json(
      applyReadPermissionRedaction(serializedItem, publicJsonOptions),
      { status: 201 },
    );`
    : `
    return json(toPublicJSONValue(item, publicJsonOptions), { status: 201 });`
}
  } catch (cause) {
    return smrtRouteErrorResponse(cause, request);
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
  semanticManifest: SmartObjectManifest,
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
    options.lazyActivation,
  );
  const serializerImports = serializers.importStatements.join('\n');
  // A custom item serializer can render related-table data the per-table
  // change-feed version cannot observe (#1765), so such routes keep the v1
  // body-hash ETag; the default toPublicJSON path uses the v2 version source.
  const getUsesSerializer = !!serializers.itemSerializerName;
  const readPermissionFields = collectReadPermissionFields(
    objectDef,
    semanticManifest,
  );
  const getUsesPermissionScopedBody =
    readPermissionFields.length > 0 || !!objectDef.displayLabelProjection;
  const getUsesBodyHash = getUsesSerializer || getUsesPermissionScopedBody;
  // The build-time web-collection shape digest (#1764) salts the v2 read ETag —
  // same value as the list route and the generated virt-web module (see above).
  const webManifestHash = computeWebManifestHash(semanticManifest);
  const collectionAccessImports = generateCollectionAccessImports(
    projectRoot,
    routeDir,
    options,
    ['getCollection'],
  );

  const imports = `${AUTO_GENERATED_ROUTE_HEADER}
// DO NOT EDIT - changes will be overwritten

import { error${hasPut || hasDelete ? ', json' : ''} } from '@sveltejs/kit';
${serializerImports ? `${serializerImports}\n` : ''}${hasGet || hasPut || hasDelete ? "import { normalizeTypedHttpError, reportUnexpectedHttpError } from '@happyvertical/smrt-core';\n" : ''}${hasPut ? "import { applyUpdateInput, prepareWriteInput, ObjectRegistry } from '@happyvertical/smrt-core';\n" : ''}${hasGet ? "import { tenancyReadScope } from '@happyvertical/smrt-core';\n" : ''}
${modelType.importStatement ? `${modelType.importStatement}\n` : ''}import type { RequestHandler } from './$types';
${collectionAccessImports}
${generateAuthGuardHelper(objectDef, semanticManifest)}${generateTenantContextHelper(usesPrincipalContext(objectDef), readScopeModelName(objectDef, className), tenancyFamilyScope(objectDef, semanticManifest))}${hasPut || hasDelete ? generateTypedRouteErrorHelper() : ''}${hasGet || hasPut || hasDelete ? generateRouteReadErrorHelper() : ''}${hasPut || hasDelete ? generateFamilyAccessHelper(objectDef, semanticManifest, { rowAccess: true }) : ''}${hasGet ? generateConditionalGetRouteHelper(objectDef.decoratorConfig?.api, { runtimeExposure: true, tenantScoped: isTenantScoped(objectDef), permissionScoped: getUsesPermissionScopedBody, modelName: className, readScopeModel: readScopeModelName(objectDef, className), useBodyHash: getUsesBodyHash, manifestHash: webManifestHash }) : ''}`;

  // #1782: a tenant-scoped single read fails closed to global (NULL-tenant)
  // rows when no tenant context is active, so a public/anonymous GET /:id can't
  // fetch another tenant's row by id. The scope is resolved at request time
  // from the live registry (undefined for a model that is not tenant-scoped).
  // Mutations (PUT/DELETE) require auth, so they keep the plain id lookup and
  // rely on the interceptor.
  const getForRead = `  const readScope = tenancyReadScope(tenancy);
  const item = await collection.get(
    readScope ? { id: params.id, ...readScope } : params.id,${objectDef.displayLabelProjection ? '\n    { displayLabel: true },' : ''}
  ).catch(rejectRouteRead);`;

  const getHandler = hasGet
    ? `
// Get single ${simpleClassName.toLowerCase()}
export const GET: RequestHandler = async ({ locals, params, request, getClientAddress }) => {
${routeGuardPreamble(objectDef, false, undefined, 'get')}
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
  return conditionalJson(request, toPublicJSONValue(item, publicJsonOptions));`
      : `  // ETag v2 (#1765): a concrete If-None-Match answers 304 without the row fetch
  // (a delete advances the version, so a since-deleted row can't false-match);
  // a wildcard \`*\` is deferred until the fetch confirms the row exists.
  return conditionalVersionedRead(request, collection.db, collection.tableName, async () => {
${getForRead}
${generateNotFoundError(className)}
    return toPublicJSONValue(item, publicJsonOptions);
  });`
}
};
`
    : '';

  const putHandler = hasPut
    ? `
// Update ${simpleClassName.toLowerCase()}
export const PUT: RequestHandler = async ({ locals, params, request, getClientAddress }) => {
${routeGuardPreamble(objectDef, true, 'update')}
  const publicJsonOptions = getPublicJsonOptions(locals);
${generateCollectionLoad(className, { typeName: modelType.typeName })}
  const item = await collection.get(params.id).catch(rejectRouteRead);
${generateNotFoundError(className)}

  const body: unknown = await request.json();
  requireRouteBody(locals, 'update', body);
  requireRowAccess(locals, item, 'update', body);
  try {
    // A field the caller may not write is compared with the loaded row: an
    // unchanged value is accepted, a changed one refused.
    const data = prepareWriteInput(${JSON.stringify(className)}, body, item, publicJsonOptions);
    await collection.withAuditMutation(item, 'updated', async (bound) => {
      // The body sets declared fields and settable accessors, nothing else.
      applyUpdateInput(bound, data, ${JSON.stringify(className)});
      await bound.save();
    });
  } catch (cause) {
    return smrtRouteErrorResponse(cause, request);
  }
${
  serializers.itemSerializerName
    ? `
  const serializedItem = await ${serializers.itemSerializerName}(item);

  return json(applyReadPermissionRedaction(serializedItem, publicJsonOptions));`
    : `
  return json(toPublicJSONValue(item, publicJsonOptions));`
}
};
`
    : '';

  const deleteHandler = hasDelete
    ? `
// Delete ${simpleClassName.toLowerCase()}
export const DELETE: RequestHandler = async ({ request, locals, params, getClientAddress }) => {
${routeGuardPreamble(objectDef, true, 'delete')}
${generateCollectionLoad(className, { typeName: modelType.typeName })}
  const item = await collection.get(params.id).catch(rejectRouteRead);
${generateNotFoundError(className)}
  requireRowAccess(locals, item, 'delete');

  try {
    await collection.delete(params.id);
  } catch (cause) {
    return smrtRouteErrorResponse(cause, request);
  }
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
  semanticManifest: SmartObjectManifest,
  options: SvelteKitOptions,
): string {
  if (routeSpecs.length === 0) {
    throw new Error('Cannot generate a custom action route without handlers');
  }

  const [firstSpec] = routeSpecs;
  const { lookupClassName, routeConfig, hostType } = firstSpec;
  assertCompatibleCustomActionRouteSpecs(routeSpecs);
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

  // Import only the decoders a handler in this file actually calls -- an
  // unconditional import would leave unused symbols in every generated action
  // route. A GET handler may need the number/boolean query-string decoders too,
  // since `URLSearchParams` hands it strings for both (#2686).
  const decoderImports = new Set<string>();
  for (const spec of routeSpecs) {
    if (hasSingleOptionsParameter(spec.actionDef)) continue;
    for (const parameter of spec.actionDef.parameters ?? []) {
      const decoder =
        spec.routeConfig?.method === 'GET'
          ? queryStringDecoderFor(declaredParameterType(parameter))
          : declaredTypeAcceptsDate(declaredParameterType(parameter))
            ? 'toCustomActionDate'
            : undefined;
      if (decoder) decoderImports.add(decoder);
    }
  }
  const readsItemScope = routeSpecs.some(
    (spec) =>
      spec.routeConfig.method === 'GET' &&
      spec.hostType !== 'collection' &&
      spec.routeConfig.scope !== 'collection',
  );
  const readsOptionsScope = routeSpecs.some((spec) =>
    receivesTenantReadOptions(spec.actionDef, spec.routeConfig),
  );
  const coreImports = [
    'normalizeCustomActionFailure',
    'normalizeTypedHttpError',
    'reportUnexpectedHttpError',
    ...(readsItemScope ? ['tenancyReadScope'] : []),
    ...(readsOptionsScope ? ['scopeActionOptions'] : []),
    ...[...decoderImports].sort(),
  ].join(', ');
  const usesCollection =
    hostType === 'collection' || routeConfig.scope !== 'collection';
  const configImport = resolveSvelteKitConfigImport(
    projectRoot,
    routeDir,
    options,
  );
  const registerImport = resolveSvelteKitConfigImport(projectRoot, routeDir, {
    configPath: options.configPath,
    configFileName: 'smrt-register.ts',
  });
  const importBlock = [
    "import { error, json } from '@sveltejs/kit';",
    `import { ${coreImports} } from '@happyvertical/smrt-core';`,
    usesCollection
      ? null
      : [
          `import '${registerImport}';`,
          `import '${configImport}';`,
          "import { ObjectRegistry } from '@happyvertical/smrt-core';",
        ].join('\n'),
    typeImports,
    "import type { RequestHandler } from './$types';",
    usesCollection
      ? generateCollectionAccessImports(projectRoot, routeDir, options, [
          'getCollection',
        ])
      : null,
  ]
    .filter(Boolean)
    .join('\n');

  const principalContext =
    usesPrincipalContext(objectDef) ||
    routeSpecs.some(
      (spec) =>
        !!spec.lookupObjectDef && usesPrincipalContext(spec.lookupObjectDef),
    );
  const handlers = routeSpecs
    .map((spec) =>
      generateActionRouteHandler(
        spec.lookupClassName,
        spec.actionName,
        spec.actionDef,
        spec.routeConfig,
        spec.hostType,
        lookupModelType.typeName,
        hostModelType.typeName,
        resolveOperationPermissionAlias(
          objectDef.decoratorConfig,
          spec.actionName,
        )?.action,
        spec.hostType === 'collection'
          ? collectionResourceRegistryKey(
              projectRoot,
              spec.hostClassName,
              objectDef,
              semanticManifest,
            )
          : undefined,
      ),
    )
    .join('\n');

  return `${AUTO_GENERATED_ROUTE_HEADER}
// DO NOT EDIT - changes will be overwritten

${importBlock}
${generateAuthGuardHelper(
  objectDef,
  semanticManifest,
  // Collection-class hosted actions are gated on the item collection's slug,
  // matching the smrt-users permission catalog (#2977).
  hostType === 'collection' &&
    firstSpec.lookupObjectDef &&
    isCollectionManifestClass(semanticManifest, objectDef)
    ? firstSpec.lookupObjectDef
    : objectDef,
)}${generateTenantContextHelper(principalContext, readScopeModelName(firstSpec.lookupObjectDef, firstSpec.lookupClassName), tenancyFamilyScope(firstSpec.lookupObjectDef, semanticManifest))}
${generateTypedRouteErrorHelper()}
${handlers}`;
}

function generateActionRouteHandler(
  lookupClassName: string,
  actionName: string,
  actionDef: MethodDefinition,
  routeConfig: ResolvedApiActionRouteConfig,
  hostType: 'item' | 'collection',
  lookupTypeName: string,
  hostTypeName: string,
  permissionAction?: string,
  collectionRegistryKey = lookupClassName,
): string {
  const successResponse = `  return json({
    action: '${actionName}',
    result: toPublicResult(result, publicJsonOptions),
  });`;
  const handlerName = routeConfig.method;
  // Mutating verbs require auth even when reads are public (#1540).
  const mutating = routeConfig.method !== 'GET';
  // Sign-in and, on a mutating action, `<collection>.<method>` (#2977) are one
  // shared decision (#5195).
  const guardLines = [
    '  const limited = routeRateLimit(locals, request, getClientAddress);',
    '  if (limited) return limited;',
    `  requireRouteAccess(locals, ${JSON.stringify(actionName)}, ${mutating}${mutating ? `, ${JSON.stringify(permissionAction ?? actionName)}` : ''});`,
  ];
  // The request's tenancy (#5375), decided for this action at request time:
  // a mutating action needs a tenant; a collection-scoped read whose scanned
  // parameters do not carry the scope (an options bag, or parameters named
  // after every ownership property) is refused to a caller with no tenant;
  // an item action reads its row under the read scope. Every collection call
  // in the body is held to the bound decision, whatever it does with its
  // options.
  const collectionScoped = hostType === 'collection' || !!actionDef.isStatic;
  const parameterNames = (
    Array.isArray(actionDef.parameters) ? actionDef.parameters : []
  ).map((parameter) => parameter.name);
  const actionShape = [
    `mutating: ${mutating}`,
    ...(Array.isArray(actionDef.parameters)
      ? [`parameters: ${JSON.stringify(parameterNames)}`]
      : []),
    ...(collectionScoped ? [] : ['itemScoped: true']),
  ].join(', ');
  guardLines.push(
    `  const tenancy = enterTenancy(locals, 'action', { ${actionShape} });`,
  );
  const authGuardLine = guardLines.join('\n');
  // Even input-free actions need request context for failure correlation.
  const needsRequest = true;
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
    );
    const invocationArgs = buildActionInvocationArgs(
      actionDef,
      scopedOptions.optionsIdentifier,
      routeConfig.method,
    );

    return `// Custom collection method: ${actionName}
export const ${handlerName}: RequestHandler = async (${collectionHandlerArgs}) => {
${authGuardLine}
  const publicJsonOptions = getPublicJsonOptions(locals);
${generateCollectionLoad(collectionRegistryKey, { typeName: lookupTypeName })}
  const typedCollection = collection as unknown as ${hostTypeName};
${generateCollectionNotRegisteredError(collectionRegistryKey)}
${staticTargetLoad}

${optionsLoad}${scopedOptions.source}  let result: unknown;
  try {
    result = ${buildActionInvocationExpression(
      receiverExpression,
      actionName,
      invocationArgs,
    )};
  } catch (cause) {
    return smrtRouteErrorResponse(cause, request);
  }

  const failure = normalizeCustomActionFailure(result);
  if (failure) {
    return json({ error: failure }, { status: failure.status });
  }

${successResponse}
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
    );
    const invocationArgs = buildActionInvocationArgs(
      actionDef,
      scopedOptions.optionsIdentifier,
      routeConfig.method,
    );
    return `// Custom collection action: ${actionName}
export const ${handlerName}: RequestHandler = async (${collectionHandlerArgs}) => {
${authGuardLine}
  const publicJsonOptions = getPublicJsonOptions(locals);
  const registered = ObjectRegistry.getClass('${lookupClassName}');
${generateClassNotRegisteredError(lookupClassName)}

${optionsLoad}${scopedOptions.source}  const ClassRef = registered.constructor as typeof ${hostTypeName};
  let result: unknown;
  try {
    result = ${buildActionInvocationExpression(
      'ClassRef',
      actionName,
      invocationArgs,
    )};
  } catch (cause) {
    return smrtRouteErrorResponse(cause, request);
  }

  const failure = normalizeCustomActionFailure(result);
  if (failure) {
    return json({ error: failure }, { status: failure.status });
  }

${successResponse}
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
    routeConfig.method === 'GET'
      ? `  const readScope = tenancyReadScope(tenancy);
  const item = await collection.get(
    readScope ? { id: params.id, ...readScope } : params.id,
  );`
      : '  const item = await collection.get(params.id);';
  const itemScopedOptions = buildScopedOptionsForTenantRead(
    actionDef,
    routeConfig,
  );
  const invocationArgs = buildActionInvocationArgs(
    actionDef,
    itemScopedOptions.optionsIdentifier,
    routeConfig.method,
  );
  return `// Custom action: ${actionName}
export const ${handlerName}: RequestHandler = async (${itemHandlerArgs}) => {
${authGuardLine}
  const publicJsonOptions = getPublicJsonOptions(locals);
${generateCollectionLoad(lookupClassName, { typeName: lookupTypeName })}
${scopedItemLoad}
${generateNotFoundError(lookupClassName)}

${optionsLoad}${itemScopedOptions.source}  let result: unknown;
  try {
    result = ${buildActionInvocationExpression(
      'item',
      actionName,
      invocationArgs,
    )};
  } catch (cause) {
    return smrtRouteErrorResponse(cause, request);
  }

  const failure = normalizeCustomActionFailure(result);
  if (failure) {
    return json({ error: failure }, { status: failure.status });
  }

${successResponse}
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
    // Linked module docs (#2108) are the same authored prose as agentDoc, just
    // split across siblings — they must drop with it, not leak past the flag.
    delete sanitized.moduleDocs;
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
function updateGitignore(
  projectRoot: string,
  generatedRoutePaths: readonly string[],
  routeRoot: string,
): void {
  const gitignorePath = join(projectRoot, '.gitignore');

  // Read existing .gitignore or create empty string
  let gitignoreContent = '';
  if (existsSync(gitignorePath)) {
    gitignoreContent = readFileSync(gitignorePath, 'utf-8');
  }

  const generatedPaths = [
    ...new Set(
      [...generatedRoutePaths, ...findGeneratedRouteFiles(routeRoot)].map(
        (path) => gitignorePatternForPath(relative(projectRoot, path)),
      ),
    ),
  ].sort((a, b) => a.localeCompare(b));
  const updatedContent = updateGeneratedRouteIgnoreBlock(
    gitignoreContent,
    generatedPaths,
  );

  if (updatedContent !== gitignoreContent) {
    writeFileSync(gitignorePath, updatedContent, 'utf-8');
    console.log('[smrt] Updated .gitignore with generated route paths');
  }
}

function findGeneratedRouteFiles(routeRoot: string): string[] {
  if (!existsSync(routeRoot)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(routeRoot, { withFileTypes: true })) {
    const path = join(routeRoot, entry.name);
    if (entry.isDirectory()) {
      files.push(...findGeneratedRouteFiles(path));
    } else if (
      entry.isFile() &&
      entry.name === '+server.ts' &&
      isGeneratedRouteFile(path)
    ) {
      files.push(path);
    }
  }
  return files;
}

function gitignorePatternForPath(path: string): string {
  // Generated SvelteKit item routes include literal `[id]` segments. Escape
  // every Git pattern metacharacter so the managed block ignores files, not
  // glob expressions that happen to resemble their paths.
  return path.replaceAll('\\', '/').replaceAll(/([*?[\]\\!#])/g, '\\$1');
}

/**
 * Whether a line has the shape versions before #2185 wrote beneath the legacy
 * header: a recursive `+server.ts` wildcard, optionally negated. The pattern is
 * matched by shape rather than against the currently configured `routesDir`,
 * because a project that moved `routesDir` after adopting the plugin (as
 * `@happyvertical/smrt-content` did, `src/routes/api` -> `src/routes/api/v1`)
 * still carries the pair its earlier `routesDir` produced.
 */
function isLegacyGeneratedRoutePattern(line: string): boolean {
  // A comment is a boundary, never part of the run — otherwise a note that
  // happens to end in the same suffix would be swallowed with it.
  if (line.startsWith('#')) {
    return false;
  }
  return /^!?[^\s].*\/\*\*\/\+server\.ts$/.test(line);
}

/**
 * Drop the generator-owned legacy header together with the contiguous run of
 * legacy-shaped patterns directly beneath it. Only that recognized run is
 * migrated: the first line that is not legacy-shaped ends it, so an application
 * rule — including an identical broad pattern the project owns elsewhere in the
 * file — survives untouched.
 */
function stripLegacyGeneratedRouteIgnores(lines: string[]): void {
  const headerIndex = lines.indexOf(LEGACY_GITIGNORE_HEADER);
  if (headerIndex === -1) {
    return;
  }

  let end = headerIndex + 1;
  while (end < lines.length && isLegacyGeneratedRoutePattern(lines[end])) {
    end += 1;
  }

  // A header with nothing recognizable beneath it is left alone rather than
  // guessed at, matching the bounded-marker handling above.
  if (end > headerIndex + 1) {
    lines.splice(headerIndex, end - headerIndex);
  }
}

function updateGeneratedRouteIgnoreBlock(
  gitignoreContent: string,
  generatedPaths: readonly string[],
): string {
  const lines = gitignoreContent.split('\n');
  const managedBlock = [
    GITIGNORE_MANAGED_BLOCK_START,
    ...generatedPaths,
    GITIGNORE_MANAGED_BLOCK_END,
  ];

  if (
    lines.includes(GITIGNORE_MANAGED_BLOCK_START) ||
    lines.includes(GITIGNORE_MANAGED_BLOCK_END)
  ) {
    // Migration runs even once the bounded block exists: a project generated by
    // the first #2185 release kept its unmatched legacy pair, and the negation
    // in that pair silently re-includes anything the bounded block stops
    // listing. Strip it before locating the markers so the indices stay valid.
    stripLegacyGeneratedRouteIgnores(lines);

    const startIndex = lines.indexOf(GITIGNORE_MANAGED_BLOCK_START);
    const endIndex = lines.indexOf(GITIGNORE_MANAGED_BLOCK_END);
    if (startIndex === -1 || endIndex < startIndex) {
      // An incomplete marker pair may have been authored by a consumer. Do
      // not guess at its boundary or remove any user-managed ignore rules.
      return gitignoreContent;
    }

    lines.splice(
      startIndex,
      endIndex - startIndex + 1,
      ...(generatedPaths.length > 0 ? managedBlock : []),
    );
    return lines.join('\n');
  }

  stripLegacyGeneratedRouteIgnores(lines);

  if (generatedPaths.length === 0) {
    return lines.join('\n');
  }

  let updatedContent = lines.join('\n');
  if (updatedContent.length > 0 && !updatedContent.endsWith('\n')) {
    updatedContent += '\n';
  }
  if (updatedContent.length > 0 && !updatedContent.endsWith('\n\n')) {
    updatedContent += '\n';
  }

  return `${updatedContent}${managedBlock.join('\n')}\n`;
}
