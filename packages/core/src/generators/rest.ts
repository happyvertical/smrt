import { getRegistryGeneration } from '../registry/generation.js';
/**
 * High-performance REST API generator for smrt objects using Node.js HTTP server
 *
 * Designed for minimal bundle size and maximum performance
 */

import http from 'node:http';
import { getTableVersion } from '../change-feed';
import type { SmrtCollection } from '../collection';
import {
  assertCreateTargetSurface,
  CreateTargetError,
  type FamilyRowOperation,
  familyCreateTargets,
  familyMembersInScope,
  isFamilyRowServed,
  servedFamilyTypes,
  syncCreateSelectsOwnType,
} from '../create-target';
import { resolveDispatchTenantId } from '../dispatch';
import { ConfigurationError } from '../errors';
import { resolveGetStringFilter } from '../interceptors';
import type { PublicJsonOptions, SmrtObject } from '../object';
import { publicSerializerOf } from '../public-json';
import { assertQueryAccess, parseRestListWhere } from '../query-access';
import {
  buildDefaultListOrderBy,
  resolveListLimit,
  resolveListOffset,
} from '../query-bounds';
import { ObjectRegistry } from '../registry';
import { isFrameworkBaseClass } from '../registry/framework-base-classes.js';
import type {
  ApiCustomRouteConfig,
  RegisteredClass,
  RegisteredField,
  SmrtObjectConstructor,
} from '../registry/types';
import { resolveRequestActor } from '../request-actor';
import {
  applyUpdateInput,
  assertCreateInput,
  assertUpdateInput,
  modelOfInstance,
} from '../request-input';
import {
  customActionScope,
  etagDiscriminator,
  type RequestTenancy,
  RequestTenancyError,
  readScope,
  resolveRequestTenancy,
  scopeActionOptions,
  scopedOptionProperties,
  throwIfRefused,
  withResolvedTenancy,
  writeGate,
} from '../request-tenancy';
import {
  hasRuntimeExposureGate,
  isRuntimeModelEnabled,
} from '../runtime-exposure.js';
import type {
  FieldDefinition,
  MethodDefinition,
  SmartObjectDefinition,
  SmartObjectManifest,
} from '../scanner/types';
import {
  processSyncApplyBatch,
  SYNC_APPLY_ROUTE_SEGMENTS,
  type SyncApplyOp,
  SyncApplyRejection,
  type SyncApplyTarget,
} from '../sync/apply';
import {
  DISPLAY_LABEL_FIELD,
  resolveDisplayLabelProjection,
} from '../ui-metadata';
import { computeWebManifestHash } from '../vite-plugin/web-collections';
import { applyWhereScope } from '../where-keys';
import { handleChangesRoute } from './changes-route';
import {
  cachePolicy,
  canonicalReadRepresentation,
  computeTableVersionEtag,
  conditionalJsonResponse,
  ifNoneMatchHasConcreteMatch,
  ifNoneMatchSatisfied,
  versionConditionalResponse,
  warnIfSharedCacheNeutralized,
  warnIfTenantScopedPublicRead,
} from './conditional-get';
import {
  buildCustomActionInvocationArgs,
  customActionParameterInputName,
  declaresRuntimeRestRouteShape,
  normalizeCustomActionFailure,
  readMethodDecoratorConfig,
  resolveCustomActionMetadata,
  resolveEffectiveActionMetadata,
} from './custom-action';
import { handleEventsRoute } from './events-route';
import { handleInferenceStatusRoute } from './inference-status-route';
import {
  handlePlaybookPreflightRoute,
  isApiActionEnabledForObject,
  isRestRoutePublic,
  PLAYBOOK_PREFLIGHT_ROUTE_SEGMENT,
  type PlaybookPreflightProvider,
} from './preflight-route';
import { reportUnexpectedHttpError } from './route-error';
import { normalizeTypedHttpError } from './typed-http-error';

export interface APIConfig {
  basePath?: string;
  enableCors?: boolean;
  /**
   * Explicit CORS origin allowlist (#1540). Required when `enableCors` is true —
   * the generator never emits `Access-Control-Allow-Origin: *`. A request's
   * `Origin` is echoed only when it appears here.
   */
  allowedOrigins?: string[];
  /**
   * Opt into credentialed CORS (#1861). When true, CORS responses to an
   * allow-listed origin also carry `Access-Control-Allow-Credentials: true`, so
   * a cross-origin browser client may send cookies (the only auth an
   * `EventSource` can carry — it cannot set an `Authorization` header). Requires
   * `enableCors` + a non-empty `allowedOrigins`: credentials are NEVER paired
   * with a wildcard origin, and the origin is still echoed only when it is
   * explicitly allow-listed. Fail-closed default (`false`): same-origin only,
   * even when CORS is otherwise enabled, so a plain `enableCors` never silently
   * starts flowing cookies cross-origin.
   */
  allowCredentials?: boolean;
  customRoutes?: Record<string, (req: Request) => Promise<Response>>;
  authMiddleware?: (
    objectName: string,
    action: string,
  ) => (req: Request) => Promise<Request | Response>;
  port?: number;
  hostname?: string;
  /**
   * Live `_events` route options. `maxSubscribers` caps active SSE streams per
   * process (#1860); over-cap connections receive a retryable 503. Set to 0
   * for no cap.
   */
  eventsRoute?: {
    maxSubscribers?: number;
  };
  /**
   * The build's web-collection SHAPE digest (#1764) — the same value the
   * generated `@happyvertical/smrt-virt-web` module exports. When supplied it is
   * folded into every read ETag via {@link computeTableVersionEtag}, so a
   * shape-only deploy (no table write) busts every read validator, closing
   * the documented v2 staleness gap. When omitted, APIGenerator computes the
   * same digest from the runtime registry on first read (#1862). The generated
   * SvelteKit routes bake the same constant in directly rather than going
   * through this runtime server.
   */
  manifestHash?: string;
  /**
   * Browser-plane playbook preflight provider (#2590), wired from
   * `@happyvertical/smrt-playbooks`. When omitted the `_preflight` route is not
   * served at all.
   *
   * The provider receives only the requested key, the caller's published
   * permission slugs, the database handle, and the boolean
   * `appAuthConfigured`. It never receives {@link APIConfig.authMiddleware},
   * which preflight must never invoke.
   */
  playbookPreflight?: PlaybookPreflightProvider;
  /**
   * The tenant each request acts for.
   *
   * Every operation on a tenant-scoped model runs inside the tenant gate, the
   * same one the in-process MCP generator uses. The gate needs to know, per
   * request, which tenant the caller belongs to; the generator cannot derive
   * that from a `Request`, so the host says. It is called once for every
   * admitted request (and once per sync item), whatever the model, after
   * `authMiddleware` admitted it, with the request that middleware returned:
   * the runtime exposure gate and STI create targets read the same tenant.
   * Return `{}` for a caller with no tenant; do not throw.
   *
   * - `{ tenantId }` runs the operation inside that tenant.
   * - `{ allowCrossTenant: true }` runs it across tenants. Only for a
   *   principal that is explicitly cross-tenant (an operator).
   * - Neither: a read of an optional-mode model serves global rows only, and
   *   every write is refused with 403 (401 for an anonymous caller).
   *
   * Take the tenant from the principal your authentication verified, never
   * from request input. When omitted, the fixed {@link APIContext.tenantId} /
   * {@link APIContext.allowCrossTenant} are used, which suits a server that
   * serves one tenant. A host that already runs the handler inside a tenant
   * context (`withTenant(...)`) needs neither: an active context is kept, and
   * the exposure gate reads it too. Naming a different tenant than that
   * context is refused with 403.
   *
   * @example
   * ```typescript
   * new APIGenerator({
   *   authMiddleware: () => async (req) => (await verify(req)) ? req : deny(),
   *   resolveTenant: async (req) => ({ tenantId: (await sessionOf(req)).tenantId }),
   * });
   * ```
   */
  resolveTenant?: (
    req: Request,
  ) =>
    | APIRequestTenant
    | null
    | undefined
    | Promise<APIRequestTenant | null | undefined>;
}

/** The tenant one request acts for; see {@link APIConfig.resolveTenant}. */
export interface APIRequestTenant {
  /** Tenant the caller belongs to. */
  tenantId?: string | null;
  /** The caller is explicitly cross-tenant (an operator). */
  allowCrossTenant?: boolean;
  /**
   * Whether the caller is signed in. Decides between 403 and 401 when the
   * gate refuses. Defaults to whether an `authMiddleware` admitted the
   * request.
   */
  authenticated?: boolean;
}

export interface APIContext {
  tenantId?: string;
  /**
   * The server's fixed principal is explicitly cross-tenant. Used with
   * `tenantId` when no {@link APIConfig.resolveTenant} is configured.
   */
  allowCrossTenant?: boolean;
  db?: unknown;
  ai?: unknown;
  user?: {
    id: string;
    username?: string;
    roles?: string[];
  };
  /** Resolved permission slugs held by the caller. */
  permissions?: Iterable<string>;
}

function registeredFieldsToManifest(
  fields: Map<string, RegisteredField>,
): Record<string, FieldDefinition> {
  const result: Record<string, FieldDefinition> = {};
  for (const [name, field] of fields) {
    if (!field || typeof field.type !== 'string') continue;
    const defaultValue =
      field.default !== undefined ? field.default : field._meta?.default;
    result[name] = {
      type: field.type as FieldDefinition['type'],
      ...(field.required !== undefined ? { required: field.required } : {}),
      ...(defaultValue !== undefined ? { default: defaultValue } : {}),
      ...(field.related !== undefined ? { related: field.related } : {}),
      ...(field.transient !== undefined ? { transient: field.transient } : {}),
      ...(field.sensitive !== undefined ? { sensitive: field.sensitive } : {}),
      ...(field.readonly !== undefined ? { readonly: field.readonly } : {}),
      ...(field.readPermission !== undefined
        ? { readPermission: field.readPermission }
        : {}),
      ...(field._meta !== undefined ? { _meta: field._meta } : {}),
      ...((field.sensitive ?? field._meta?.sensitive) === true
        ? { sensitive: true }
        : {}),
      ...((field.transient ?? field._meta?.transient) === true
        ? { transient: true }
        : {}),
    };
  }
  return result;
}

function registeredMethodsToManifest(
  methods: Map<string, MethodDefinition> | undefined,
): Record<string, MethodDefinition> {
  return Object.fromEntries(methods ?? []);
}

function pluralizeRuntimeCollectionName(className: string): string {
  const lower = className.toLowerCase();
  if (lower.endsWith('y')) return `${lower.slice(0, -1)}ies`;
  if (lower.endsWith('s') || lower.endsWith('x') || lower.endsWith('z')) {
    return `${lower}es`;
  }
  if (lower.endsWith('ch') || lower.endsWith('sh')) return `${lower}es`;
  return `${lower}s`;
}

function runtimeObjectDefinition(
  key: string,
  info: RegisteredClass,
): SmartObjectDefinition {
  const className = info.name || key;
  const displayLabelProjection = resolveDisplayLabelProjection(
    ObjectRegistry.getConfig(key).display?.label,
  );
  return {
    ...(ObjectRegistry.getConfig(key).writeThrough
      ? { writeThroughFields: ObjectRegistry.getWriteThroughFields(key) }
      : {}),
    ...(displayLabelProjection
      ? { displayLabelProjection, displayLabelField: DISPLAY_LABEL_FIELD }
      : {}),
    className,
    name: className.toLowerCase(),
    collection: info.collection || pluralizeRuntimeCollectionName(className),
    filePath: info.sourceFilePath || '',
    fields: registeredFieldsToManifest(info.inheritedFields || info.fields),
    methods: registeredMethodsToManifest(info.inheritedMethods || info.methods),
    // Replacement selection needs physical identity even when the provider's
    // decorator leaves its table name implicit.
    decoratorConfig: {
      ...info.config,
      ...(info.schema?.tableName ? { tableName: info.schema.tableName } : {}),
    },
    ...(info.qualifiedName ? { qualifiedName: info.qualifiedName } : {}),
    ...(info.packageName ? { packageName: info.packageName } : {}),
    ...(info.visibility ? { visibility: info.visibility } : {}),
    ...(info.extends ? { extends: info.extends } : {}),
    ...(info.extendsTypeArg ? { extendsTypeArg: info.extendsTypeArg } : {}),
    ...(info.tools ? { tools: info.tools } : {}),
  };
}

/**
 * Compute the runtime REST web-manifest hash from the registered object graph
 * (#1862). This mirrors the Vite/SvelteKit source (`computeWebManifestHash`)
 * but builds the manifest from `ObjectRegistry` for APIGenerator deployments.
 */
export function getRuntimeManifest(
  classes: Iterable<[string, RegisteredClass]> = ObjectRegistry.getAllClasses(),
): SmartObjectManifest {
  const objects: SmartObjectManifest['objects'] = {};
  const seen = new Set<RegisteredClass>();
  for (const [key, info] of classes) {
    if (info.generatedFields?.error || seen.has(info)) continue;
    seen.add(info);
    const manifestKey = info.qualifiedName || key;
    objects[manifestKey] = runtimeObjectDefinition(key, info);
    for (const previous of info.replacedQualifiedNames ?? []) {
      const declaration = ObjectRegistry.getDeclaredClass(previous);
      if (declaration)
        objects[previous] = {
          ...runtimeObjectDefinition(previous, declaration),
          replacedBy: manifestKey,
        };
    }
  }
  return { version: 'runtime', timestamp: 0, objects };
}

export function computeRuntimeWebManifestHash(
  classes: Iterable<[string, RegisteredClass]> = ObjectRegistry.getAllClasses(),
): string {
  return computeWebManifestHash(getRuntimeManifest(classes));
}

/** What one collection segment resolves to; see `collectionSegmentIndex()`. */
interface CollectionSegmentEntry {
  /** Distinct models serving the segment, by registry key. */
  models: Map<string, RegisteredClass>;
  /** A registered class of the segment whose generated fields failed. */
  error?: unknown;
}

/**
 * Restricts auto-discovery to a set of registry keys. Set only by
 * `createRestServer(objects)`; not part of {@link APIConfig}.
 */
const MODEL_SCOPE = Symbol('smrt.rest.modelScope');
type ScopedAPIConfig = APIConfig & { [MODEL_SCOPE]?: ReadonlySet<string> };

function ambiguousSegmentError(
  ambiguous: Map<string, CollectionSegmentEntry>,
): ConfigurationError {
  const segments = Object.fromEntries(
    [...ambiguous].map(([segment, entry]) => [
      segment,
      [...entry.models.keys()],
    ]),
  );
  const listed = Object.entries(segments)
    .map(([segment, models]) => `'${segment}' (${models.join(', ')})`)
    .join('; ');
  return new ConfigurationError(
    `REST collection segment resolves to more than one model: ${listed}. ` +
      'Give each model a distinct `collection`, or serve one of them with `api: false`.',
    'REST_COLLECTION_SEGMENT_AMBIGUOUS',
    { segments },
  );
}

/** The registry key policy lookups use: the qualified name when there is one. */
function registryKeyOf(info: RegisteredClass): string {
  return info.qualifiedName || info.name;
}

/** A request's tenant after defaults; see {@link APIConfig.resolveTenant}. */
interface ResolvedRequestTenant {
  tenantId: string | null;
  allowCrossTenant: boolean;
  authenticated: boolean;
  /**
   * The tenant the request acts in: `tenantId`, else the tenant context the
   * host already entered. What the exposure gate and create targets read, so
   * they see the tenant persistence runs in.
   */
  effectiveTenantId: string | null;
}

/**
 * The answer to an operation the tenant gate (or the tenancy interceptor)
 * refused for want of a tenant: 403 for a signed-in caller, 401 for an
 * anonymous one. Matched by error code, so it holds across copies of the
 * tenancy package. `undefined` for any other error.
 */
function tenantRefusal(
  error: unknown,
  authenticated = true,
): { code: string; message: string; ok: false; status: number } | undefined {
  if (
    !error ||
    typeof error !== 'object' ||
    (error as { code?: unknown }).code !== 'TENANT_CONTEXT_REQUIRED'
  ) {
    return undefined;
  }
  return {
    code: 'TENANT_CONTEXT_REQUIRED',
    message: 'Tenant context required.',
    ok: false,
    status: authenticated ? 403 : 401,
  };
}

/**
 * High-performance API generator using native Bun
 */
export class APIGenerator {
  private config: APIConfig;
  private collections = new Map<string, SmrtCollection<SmrtObject>>();
  private context: APIContext;
  private runtimeManifestHash: string | undefined;
  private manifestGeneration = -1;
  /** Models auto-discovery may serve; every registered model when unset. */
  private readonly modelScope: ReadonlySet<string> | undefined;
  /** Per-request tenant answers; see `requestTenant()`. */
  private readonly requestTenants = new WeakMap<
    Request,
    Promise<ResolvedRequestTenant>
  >();
  /**
   * Per-request admission of STI family members read through a base: the
   * caller may read the member and it is switched on for the request's
   * tenant. See `settleFamilyAdmission()`.
   */
  private readonly familyAdmission = new WeakMap<
    Request,
    Map<string, (key: string) => boolean>
  >();
  private segmentIndex:
    | { generation: number; entries: Map<string, CollectionSegmentEntry> }
    | undefined;
  /** The tenancy each admitted CRUD request resolved; see `tenancyOf()`. */
  private readonly requestTenancies = new WeakMap<Request, RequestTenancy>();

  constructor(config: APIConfig = {}, context: APIContext = {}) {
    this.config = {
      basePath: '/api/v1',
      // Security defaults (#1540): bind to loopback and keep CORS off unless an
      // explicit origin allowlist is supplied. No `Access-Control-Allow-Origin: *`.
      enableCors: false,
      port: 3000,
      hostname: '127.0.0.1',
      ...config,
    };
    this.context = context;
    this.modelScope = (config as ScopedAPIConfig)[MODEL_SCOPE];
    // A server given its models (`createRestServer(objects)`) must be able to
    // serve each of them: two of them on one collection segment is a
    // configuration error now. Without a list, auto-discovery spans the whole
    // registry, which may hold models the host never serves (a run-time
    // subclass reached through `registerCollection`, a dependency's model), so
    // an ambiguous segment is refused when a request names it.
    if (this.modelScope) {
      const ambiguous = new Map(
        [...this.collectionSegmentIndex()].filter(
          ([, entry]) => entry.models.size > 1,
        ),
      );
      if (ambiguous.size > 0) throw ambiguousSegmentError(ambiguous);
    }
  }

  /**
   * Register a pre-configured collection instance for API exposure
   *
   * @param name - URL path segment for the collection (e.g., 'products' for /api/products)
   * @param collection - Pre-initialized SmrtCollection instance
   */
  registerCollection(
    name: string,
    collection: SmrtCollection<SmrtObject>,
  ): void {
    this.collections.set(name, collection);
    this.runtimeManifestHash = undefined;
  }

  /**
   * Resolve the database for generator-level routes that are not object-scoped
   * (currently the `_changes` feed, #1758).
   *
   * Prefers the explicit `APIContext.db`, but falls back to the first
   * registered collection's live handle so the feed works under the documented
   * `registerCollection()` wiring, where callers configure collections with a
   * database but never populate `APIContext.db`. Without the fallback the feed
   * would 503 even though the database is reachable.
   */
  private resolveContextDb(): unknown {
    return (
      this.context.db ?? this.collections.values().next().value?.db ?? undefined
    );
  }

  /**
   * Create Node.js HTTP server with all routes
   */
  createServer(): { server: http.Server; url: string } {
    const server = http.createServer(async (req, res) => {
      try {
        const request = await this.nodeRequestToWebRequest(req);
        const response = await this.handleRequest(request);
        await this.webResponseToNodeResponse(response, res);
      } catch (_error) {
        res.statusCode = 500;
        res.end('Internal Server Error');
      }
    });

    server.listen(this.config.port, this.config.hostname);

    return {
      server,
      url: `http://${this.config.hostname}:${this.config.port}`,
    };
  }

  /**
   * Convert stream to string
   */
  private async streamToString(stream: http.IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString('utf-8');
  }

  /**
   * Convert Node.js IncomingMessage to Web Request
   */
  private async nodeRequestToWebRequest(
    req: http.IncomingMessage,
  ): Promise<Request> {
    const url = `http://${this.config.hostname}:${this.config.port}${req.url}`;
    const method = req.method || 'GET';
    const headers = new Headers();

    for (const [key, value] of Object.entries(req.headers)) {
      if (value) {
        headers.set(key, Array.isArray(value) ? value[0] : value);
      }
    }

    let body: string | undefined;
    if (method !== 'GET' && method !== 'HEAD') {
      body = await this.streamToString(req);
    }

    return new Request(url, {
      method,
      headers,
      body,
    });
  }

  /**
   * Convert Web Response to Node.js ServerResponse
   */
  private async webResponseToNodeResponse(
    webResponse: Response,
    res: http.ServerResponse,
  ): Promise<void> {
    res.statusCode = webResponse.status;

    // Set headers
    webResponse.headers.forEach((value, key) => {
      res.setHeader(key, value);
    });

    // Send body
    if (webResponse.body) {
      const reader = webResponse.body.getReader();

      // Client disconnect handling — essential for the long-lived `_events` SSE
      // stream (#1763): a never-ending stream is only torn down when its reader
      // is cancelled, and nothing cancels it unless we detect the socket close.
      // On `res`/socket 'close' before the response finished, cancel the reader
      // so the source stream's `cancel()` fires (unsubscribe + clear heartbeat).
      let clientGone = false;
      const onClose = () => {
        if (res.writableFinished) return; // normal completion, not a disconnect
        clientGone = true;
        void reader.cancel().catch(() => {});
      };
      res.on('close', onClose);

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done || clientGone) break;
          if (!res.write(value)) {
            // Respect back-pressure so a slow/absent consumer can't unbounded-
            // buffer in the Node socket. Resolve on 'drain' OR on 'close'/
            // 'error' — a disconnect while back-pressured never fires 'drain',
            // so waiting only for it would hang this frame forever (leaking it
            // and pinning the reader for the long-lived `_events` stream). Race
            // the three and remove the losers so one-shot listeners don't pile
            // up across many drains.
            await new Promise<void>((resolve) => {
              const settle = () => {
                res.off('drain', settle);
                res.off('close', settle);
                res.off('error', settle);
                resolve();
              };
              res.once('drain', settle);
              res.once('close', settle);
              res.once('error', settle);
            });
            if (clientGone) break;
          }
        }
      } catch {
        // Reader cancelled (client gone) or write failed — stop streaming.
      } finally {
        res.off('close', onClose);
      }
    }

    if (!res.writableEnded) {
      res.end();
    }
  }

  /**
   * Generate fetch handler function (for serverless environments)
   */
  generateHandler(): (req: Request) => Promise<Response> {
    return async (req) => {
      try {
        return await this.handleRequest(req);
      } catch (cause) {
        const failure = normalizeTypedHttpError(cause);
        if (failure)
          return this.createJsonResponse({ error: failure }, failure.status);
        return this.createJsonResponse(
          reportUnexpectedHttpError(cause, req),
          500,
        );
      }
    };
  }

  /**
   * Main request handler using native Bun APIs
   */
  private async handleRequest(req: Request): Promise<Response> {
    const url = new URL(req.url);

    // Handle CORS preflight
    if (req.method === 'OPTIONS' && this.config.enableCors) {
      return this.createCorsResponse(req);
    }

    // Handle custom routes first
    if (this.config.customRoutes) {
      for (const [path, handler] of Object.entries(this.config.customRoutes)) {
        if (url.pathname === `${this.config.basePath}${path}`) {
          const response = await handler(req);
          return this.addCorsHeaders(response, req);
        }
      }
    }

    // Change-feed route (#1758): auth-guarded, tenant-scoped cursor read
    // over the _smrt_changes log. Logic lives in ./changes-route.ts.
    if (url.pathname === `${this.config.basePath}/_changes`) {
      const response = await handleChangesRoute(req, {
        authMiddleware: this.config.authMiddleware,
        db: this.resolveContextDb(),
      });
      return this.addCorsHeaders(response, req);
    }

    // Live change-signal SSE route (#1763): auth-guarded, tenant-scoped
    // Server-Sent-Events stream of coarse signals (no row payloads). Logic
    // lives in ./events-route.ts. Wrapped in addCorsHeaders so a cross-origin
    // credentialed EventSource can subscribe when `allowCredentials` + an
    // allow-listed origin are configured (#1861); with the fail-closed default
    // (`allowCredentials: false`) this stays same-origin only, exactly as
    // before. The stream body passes through untouched — addCorsHeaders only
    // re-wraps headers. Fail-closed auth is unchanged: the CORS layer never
    // authorizes; it only lets an already-authorized cookie reach the guard.
    if (url.pathname === `${this.config.basePath}/_events`) {
      const response = await handleEventsRoute(req, {
        authMiddleware: this.config.authMiddleware,
        db: this.resolveContextDb(),
        manifestHash: this.resolveManifestHash(),
        maxSubscribers: this.config.eventsRoute?.maxSubscribers,
      });
      return this.addCorsHeaders(response, req);
    }

    // Inference availability (#4757): `{ available, mode, reason?, tier? }`
    // for the ambient principal; never a key. Auth-guarded when the app
    // configures `authMiddleware`. Logic lives in ./inference-status-route.ts.
    if (url.pathname === `${this.config.basePath}/_inference`) {
      const response = await handleInferenceStatusRoute(req, {
        authMiddleware: this.config.authMiddleware,
      });
      return this.addCorsHeaders(response, req);
    }

    // Browser-plane playbook preflight (#2590): advisory, read-effect,
    // idempotent. `authMiddleware` is deliberately NOT passed here and is never
    // invoked by preflight — the route options carry only the boolean
    // `appAuthConfigured`, so the app-auth layer reports `unknown`.
    if (
      url.pathname ===
      `${this.config.basePath}/${PLAYBOOK_PREFLIGHT_ROUTE_SEGMENT}`
    ) {
      const response = await handlePlaybookPreflightRoute(req, {
        provider: this.config.playbookPreflight,
        ...(this.context.permissions
          ? { permissions: this.context.permissions }
          : {}),
        appAuthConfigured: Boolean(this.config.authMiddleware),
        db: this.resolveContextDb(),
      });
      return this.addCorsHeaders(response, req);
    }

    // Handle object routes
    if (url.pathname.startsWith(this.config.basePath || '')) {
      const response = await this.handleObjectRoute(req, url);
      return this.addCorsHeaders(response, req);
    }

    // Not found
    return this.createErrorResponse(404, 'Not found');
  }

  /**
   * Handle CRUD routes for SMRT objects
   */
  private async handleObjectRoute(req: Request, url: URL): Promise<Response> {
    const pathParts = url.pathname
      .replace(this.config.basePath || '', '')
      .split('/')
      .filter(Boolean);

    if (pathParts.length === 0) {
      return this.createErrorResponse(400, 'Object type required');
    }

    // Reserved batch write contract route (#1759): POST {basePath}/sync/apply.
    if (
      pathParts.length === SYNC_APPLY_ROUTE_SEGMENTS.length &&
      SYNC_APPLY_ROUTE_SEGMENTS.every((segment, i) => pathParts[i] === segment)
    ) {
      if (req.method !== 'POST') {
        return this.createErrorResponse(405, 'Method not allowed');
      }
      return await this.handleSyncApply(req);
    }

    const objectType = pathParts[0];
    const objectId = pathParts[1];

    // Check for explicitly registered collection first
    if (this.collections.has(objectType)) {
      const collection = this.collections.get(objectType);
      if (!collection) throw new Error(`Collection ${objectType} not found`);

      const objectName = this.getCollectionObjectName(collection) || objectType;

      const admitted = await this.admitObjectRequest(
        req,
        objectName,
        ObjectRegistry.getExposureModel(objectName),
      );
      if (admitted instanceof Response) return admitted;
      req = admitted;

      // Use registered collection directly
      return await this.executeCrudOperation(
        req,
        collection,
        objectId,
        url,
        objectName,
      );
    }

    // Fall back to auto-discovery via ObjectRegistry, matching the URL segment
    // against the canonical manifest `collection` value (#1794).
    const classInfo = this.findClassByCollectionSegment(objectType);

    if (!classInfo) {
      return this.createErrorResponse(
        404,
        `Object type '${objectType}' not found`,
      );
    }

    // Every policy lookup below uses the model's qualified registry key. Two
    // packages may declare models with the same simple name; a simple name
    // resolves to whichever registered first.
    const objectName = registryKeyOf(classInfo);
    const admitted = await this.admitObjectRequest(req, objectName, classInfo);
    if (admitted instanceof Response) return admitted;
    req = admitted;

    // Get or create collection
    const collection = await this.getCollection(classInfo);

    return await this.executeCrudOperation(
      req,
      collection,
      objectId,
      url,
      objectName,
    );
  }

  /**
   * Execute CRUD operation on a collection
   */
  private async executeCrudOperation(
    req: Request,
    collection: SmrtCollection<SmrtObject>,
    objectId: string | undefined,
    url: URL,
    objectName?: string,
  ): Promise<Response> {
    // Every operation runs inside the tenancy the request resolved for its
    // model (#5375): the actor's tenant or system context, with the decision
    // bound for the collection interceptor.
    let authenticated: boolean | undefined;
    try {
      if (!objectName) {
        return await this.routeCrudOperation(
          req,
          collection,
          objectId,
          url,
          objectName,
        );
      }
      const read = req.method === 'GET' || req.method === 'HEAD';
      await this.settleFamilyAdmission(req, objectName, read);
      const tenancy = await this.resolveTenancy(
        req,
        objectName,
        read ? (objectId && objectId !== 'count' ? 'get' : 'list') : req.method,
      );
      this.requestTenancies.set(req, tenancy);
      authenticated = tenancy.actor.authenticated;
      return await withResolvedTenancy(tenancy, () =>
        this.routeCrudOperation(req, collection, objectId, url, objectName),
      );
    } catch (error) {
      const refusal = tenantRefusal(error, authenticated);
      if (refusal) {
        return this.createJsonResponse({ error: refusal }, refusal.status);
      }
      const failure = normalizeTypedHttpError(error);
      if (failure) {
        return this.createJsonResponse({ error: failure }, failure.status);
      }
      return this.createJsonResponse(
        reportUnexpectedHttpError(error, req),
        500,
      );
    }
  }

  /**
   * Resolve the tenancy of an operation on `objectName` (#5375): the actor
   * from the tenant the host settled for the admitted request (asked once
   * per request object, see `requestTenant()`), the STI members this route
   * serves for the operation, and the policy of each.
   *
   * @param req - The request the auth middleware returned: never a copy, so
   *   the host's answer is the one it gave for that request
   * @param operation - The family operation of a read, or the HTTP method of
   *   a write (`POST`, `PUT`, `PATCH`, `DELETE`)
   */
  private async resolveTenancy(
    req: Request,
    objectName: string,
    operation: FamilyRowOperation | string,
  ): Promise<RequestTenancy> {
    const tenant = await this.requestTenant(req);
    const write = operation !== 'list' && operation !== 'get';
    const actor = resolveRequestActor({
      principal: {
        tenantId: tenant.tenantId,
        allowCrossTenant: tenant.allowCrossTenant,
        authenticated: tenant.authenticated,
      },
      operation: write ? 'write' : 'read',
    });
    const admits = this.familyAdmission.get(req)?.get(objectName);
    const servedFor = (op: FamilyRowOperation) =>
      servedFamilyTypes(objectName, 'api', op, this.modelScope, admits);
    // Reads find rows among the members the route reads: an update or delete
    // finds its row there, and its own model then decides the write (405
    // when it does not enable it, else its authorization), as on the sync
    // path; a POST (a create, a sync create's replay lookup, a POST action)
    // reads the same set. The members a create may select are a separate
    // set, never read through the route.
    const served = servedFor(operation === 'list' ? 'list' : 'get');
    const tenancy = resolveRequestTenancy({
      model: objectName,
      ...(served ? { served: served.filter((key) => key !== objectName) } : {}),
      ...(operation === 'POST'
        ? {
            creatable: familyCreateTargets(objectName, 'api', this.modelScope),
          }
        : {}),
      actor,
    });
    return tenancy;
  }

  /**
   * Admit a request to an object route: authentication (or the model's public
   * access), then the runtime exposure gate, evaluated for the tenant the
   * admitted request acts for. Returns the admitted request, or the answer
   * that refuses it.
   */
  private async admitObjectRequest(
    req: Request,
    objectName: string,
    exposureModel: RegisteredClass | undefined,
  ): Promise<Request | Response> {
    if (this.config.authMiddleware) {
      const authResult = await this.config.authMiddleware(
        objectName,
        req.method.toLowerCase(),
      )(req);
      if (authResult instanceof Response) return authResult;
      req = authResult;
    } else if (!this.isRoutePublic(objectName, req.method)) {
      // Fail-closed (#1540): no auth middleware wired and the object isn't
      // marked `@smrt({ api: { public } })` → refuse rather than serve open.
      return this.createErrorResponse(401, 'Authentication required');
    }
    let tenant: ResolvedRequestTenant;
    try {
      tenant = await this.requestTenant(req);
    } catch (error) {
      const failure = normalizeTypedHttpError(error);
      if (failure) {
        return this.createJsonResponse({ error: failure }, failure.status);
      }
      return this.createJsonResponse(
        reportUnexpectedHttpError(error, req),
        500,
      );
    }
    if (
      !isRuntimeModelEnabled(exposureModel, {
        surface: 'rest',
        tenantId: tenant.effectiveTenantId ?? undefined,
        request: req,
      })
    ) {
      return this.createErrorResponse(404, 'Not found');
    }
    return req;
  }

  /**
   * Authorize an operation on a row whose type is not the route's model: an
   * STI subtype created, updated or deleted through its base. The subtype's
   * own action gate and authorization apply as well as the base's: its
   * `authMiddleware` decision (with the subtype's name), or its public access
   * when no middleware is configured. Returns the refusal, or `undefined`.
   *
   * @param req - The admitted request, with a readable body
   * @param rowModel - Registry key of the row's own model
   * @param action - The CRUD action performed
   */
  private async authorizeRowModel(
    req: Request,
    rowModel: string,
    action: 'create' | 'update' | 'delete',
    admitted: Request = req,
  ): Promise<Response | undefined> {
    if (!this.isApiActionEnabled(rowModel, action)) {
      return this.createErrorResponse(405, 'Method not allowed');
    }
    // The subtype is switched on for the tenant the request acts for.
    const tenant = await this.requestTenant(admitted);
    if (
      !isRuntimeModelEnabled(
        ObjectRegistry.getExposureModel(rowModel) ?? rowModel,
        {
          surface: 'rest',
          tenantId: tenant.effectiveTenantId ?? undefined,
          request: admitted,
        },
      )
    ) {
      return this.createErrorResponse(404, 'Not found');
    }
    if (this.config.authMiddleware) {
      const decision = await this.config.authMiddleware(
        rowModel,
        req.method.toLowerCase(),
      )(req);
      return decision instanceof Response ? decision : undefined;
    }
    return this.isRoutePublic(rowModel, req.method)
      ? undefined
      : this.createErrorResponse(401, 'Authentication required');
  }

  /**
   * Which STI subtypes of `objectName` this admitted request may reach rows
   * of through the base: each subtype must be switched on for the request's
   * tenant (the runtime exposure gate), and a read needs the caller to be
   * allowed to read the subtype itself -- its `authMiddleware` decision under
   * its own name, or its `api.public` when no middleware is configured. A
   * write's row is authorized under its own model by `authorizeRowModel`.
   * Settled once per admitted request and route model, before any read is
   * scoped (a sync batch's items share the request but not the model).
   */
  private async settleFamilyAdmission(
    req: Request,
    objectName: string,
    read: boolean,
  ): Promise<void> {
    if (this.familyAdmission.get(req)?.has(objectName)) return;
    if (ObjectRegistry.getTableStrategy(objectName) !== 'sti') return;
    if (ObjectRegistry.getDescendants(objectName).length === 0) return;
    // Only members this server could serve for the request are put to the
    // host's exposure gate and middleware: a subtype outside its model list,
    // or one that opens none of the operations, is never served, and a host
    // need not have a policy for it.
    const members = familyMembersInScope(
      objectName,
      'api',
      read ? ['list', 'get'] : ['get', 'update', 'delete'],
      this.modelScope,
    );
    const tenant = await this.requestTenant(req);
    const admitted = new Set<string>();
    for (const key of members) {
      if (
        !isRuntimeModelEnabled(ObjectRegistry.getExposureModel(key) ?? key, {
          surface: 'rest',
          tenantId: tenant.effectiveTenantId ?? undefined,
          request: req,
        })
      ) {
        continue;
      }
      if (read) {
        if (this.config.authMiddleware) {
          const decision = await this.config.authMiddleware(
            key,
            req.method.toLowerCase(),
          )(req);
          if (decision instanceof Response) continue;
        } else if (!this.isRoutePublic(key, req.method)) {
          continue;
        }
      }
      admitted.add(key);
    }
    let byModel = this.familyAdmission.get(req);
    if (!byModel) {
      byModel = new Map();
      this.familyAdmission.set(req, byModel);
    }
    byModel.set(objectName, (key) => admitted.has(key));
  }

  /**
   * Whether the rows a read through `objectName` serves depend on who asks:
   * an STI base with subtypes, read under an auth middleware, admits each
   * subtype by the caller's own authorization.
   */
  private hasCallerDependentFamily(objectName: string | undefined): boolean {
    return (
      !!objectName &&
      !!this.config.authMiddleware &&
      ObjectRegistry.getTableStrategy(objectName) === 'sti' &&
      ObjectRegistry.getDescendants(objectName).length > 0
    );
  }

  /**
   * The tenant a request acts for: what the host's `resolveTenant` says for
   * the admitted request, or the server's fixed context. Resolved once per
   * request; the exposure gate, create targets and the tenant gate all read
   * this answer.
   */
  private requestTenant(req: Request): Promise<ResolvedRequestTenant> {
    let pending = this.requestTenants.get(req);
    if (!pending) {
      pending = (async () => {
        const resolved = this.config.resolveTenant
          ? ((await this.config.resolveTenant(req)) ?? {})
          : {
              tenantId: this.context.tenantId,
              allowCrossTenant: this.context.allowCrossTenant,
            };
        const tenantId =
          typeof resolved.tenantId === 'string' && resolved.tenantId
            ? resolved.tenantId
            : null;
        const ambient = resolveDispatchTenantId();
        const answer: ResolvedRequestTenant = {
          tenantId,
          allowCrossTenant: resolved.allowCrossTenant === true,
          authenticated:
            resolved.authenticated ?? Boolean(this.config.authMiddleware),
          effectiveTenantId:
            tenantId ??
            (typeof ambient === 'string' && ambient ? ambient : null),
        };
        return answer;
      })();
      this.requestTenants.set(req, pending);
    }
    return pending;
  }

  /** Route one request to its custom action or CRUD handler. */
  private async routeCrudOperation(
    req: Request,
    collection: SmrtCollection<SmrtObject>,
    objectId: string | undefined,
    url: URL,
    objectName: string | undefined,
  ): Promise<Response> {
    // Decorator-declared custom collection actions dispatch BEFORE CRUD
    // routing: without this, `POST /<collection>/<action>` would fall into
    // `handleCreate` with the action segment silently discarded (#2047).
    if (objectId && objectName) {
      const customResponse = await this.dispatchCustomCollectionAction(
        req,
        collection,
        objectId,
        url,
        objectName,
      );
      if (customResponse) {
        return customResponse;
      }
    }

    const action = this.getCrudAction(req.method, objectId);
    if (action && !this.isApiActionEnabled(objectName, action)) {
      return this.createErrorResponse(405, 'Method not allowed');
    }

    // Handle special /count endpoint
    if (objectId === 'count' && req.method === 'GET') {
      return await this.handleCount(
        collection,
        url.searchParams,
        req,
        objectName,
      );
    }

    // Route to appropriate CRUD operation
    switch (req.method) {
      case 'GET':
        return objectId
          ? await this.handleGet(collection, objectId, req, objectName)
          : await this.handleList(
              collection,
              url.searchParams,
              req,
              objectName,
            );

      case 'POST':
        return await this.handleCreate(collection, req, objectName);

      case 'PUT':
      case 'PATCH':
        if (!objectId) {
          return this.createErrorResponse(400, 'Object ID required for update');
        }
        return await this.handleUpdate(collection, objectId, req, objectName);

      case 'DELETE':
        if (!objectId) {
          return this.createErrorResponse(400, 'Object ID required for delete');
        }
        return await this.handleDelete(collection, objectId, req, objectName);

      default:
        return this.createErrorResponse(405, 'Method not allowed');
    }
  }

  private getCrudAction(
    method: string,
    objectId: string | undefined,
  ): 'list' | 'get' | 'create' | 'update' | 'delete' | null {
    switch (method) {
      case 'GET':
        return objectId && objectId !== 'count' ? 'get' : 'list';
      case 'POST':
        return 'create';
      case 'PUT':
      case 'PATCH':
        return 'update';
      case 'DELETE':
        return 'delete';
      default:
        return null;
    }
  }

  /**
   * Fail-closed authorization posture (#1540). Returns true only when the
   * object opts out of auth via `@smrt({ api: { public } })`:
   * - `public: true` → all methods are public.
   * - `public: 'read'` → only safe (GET) methods are public.
   * Everything else requires an `authMiddleware` to be configured.
   */
  private isRoutePublic(
    objectName: string | undefined,
    method: string,
  ): boolean {
    // Single source of truth, shared with browser-plane preflight (#2590): the
    // route and the prediction of the route must never drift.
    return isRestRoutePublic(objectName, method);
  }

  private isApiActionEnabled(
    objectName: string | undefined,
    action: 'list' | 'get' | 'create' | 'update' | 'delete',
  ): boolean {
    return isApiActionEnabledForObject(objectName, action);
  }

  private getCollectionObjectName(
    collection: SmrtCollection<SmrtObject>,
  ): string | undefined {
    // `_itemClass` lives on the instance (protected getter) or the collection
    // constructor (static). Read it through a structural shape rather than the
    // class's private surface; behavior is unchanged.
    const itemClass: SmrtObjectConstructor | undefined =
      (collection as unknown as { _itemClass?: SmrtObjectConstructor })
        ._itemClass ||
      (
        collection.constructor as unknown as {
          _itemClass?: SmrtObjectConstructor;
        }
      )?._itemClass;

    if (!itemClass) {
      return undefined;
    }

    const registered = ObjectRegistry.getClassByConstructor(itemClass);
    return registered?.qualifiedName || registered?.name || itemClass.name;
  }

  /**
   * Dispatch a decorator-declared custom COLLECTION-scoped action —
   * `@smrt({ api: { include: [...], routes: { action: { scope: 'collection',
   * method, path } } } })` — on the runtime transport (#2047). The generated
   * SvelteKit transport already dispatches these routes; this keeps the two
   * transports coherent for the same decorator metadata.
   *
   * Deliberately narrow, matching this router's URL shape: single-segment
   * collection-scoped paths only (multi-segment custom paths remain a
   * SvelteKit-transport feature), the action must be exposed by `api.include`
   * (and not excluded), and the HTTP method must match the route metadata.
   * Non-matching requests fall through to CRUD handling unchanged.
   *
   * Scope is resolved through the shared `resolveCustomActionMetadata`
   * contract, not read off the route alone: `scope` is OPTIONAL and defaults
   * to `collection` for statics and `item` for instance methods, so requiring
   * a literal `scope: 'collection'` would skip a valid static action and let
   * `POST /<collection>/<action>` fall through into `create`. The receiver
   * decides — a route-only scope cannot manufacture one — so an action with no
   * collection-hosted receiver falls through unless the route explicitly
   * declared `scope: 'collection'`, in which case it is declared-but-missing
   * and returns 501 rather than degrading into a malformed CRUD write.
   *
   * Arguments, failures, and result shaping all reuse the shared custom-action
   * helpers so this transport matches generated REST/CLI/MCP exactly: declared
   * parameters are projected (a zero-parameter action takes no body at all, an
   * `options` bag is passed through, named parameters are read off the body),
   * a returned `{ ok: false, ... }` failure becomes its requested non-2xx
   * status with a redacted payload, and success wraps as `{ action, result }`.
   */
  /**
   * Every action this transport treats as DECLARED for a collection route,
   * paired with its manifest method definition when one is known.
   *
   * The union of two declaration sources, so migrating a route entry onto its
   * method does not silently drop the route here (#2686):
   *
   * - a `api.routes[action]` entry, this transport's only source before;
   * - a method whose `@method()` supplies route-shaping metadata
   *   (`httpMethod`, `path`, or `scope`).
   *
   * Deliberately still DECLARATION-gated rather than adopting the generated
   * transport's default-route heuristic: this router's URL shape supports only
   * single-segment collection paths, and widening it to every wire-able public
   * method would publish endpoints that have never existed here. That is a
   * separate contract change, not a compatibility fix.
   *
   * `declaresRuntimeRestRoute` is shared with `isRestActionRoutable`, the
   * browser-plane preflight prediction of this same dispatch, so the route and
   * the prediction of the route cannot drift.
   */
  private declaredCollectionActions(
    objectName: string,
    apiConfig: { routes?: Record<string, ApiCustomRouteConfig> },
  ): Array<[string, MethodDefinition | undefined]> {
    const names = new Set<string>(Object.keys(apiConfig.routes ?? {}));
    // `listDecoratedMethodNames` reads the manifest AND the live decorator
    // store, so a decorator-declared route survives in an unscanned project
    // where `getMethods()` is empty (#2686).
    for (const name of ObjectRegistry.listDecoratedMethodNames(objectName)) {
      // The SHAPE predicate, not the routable one: a withheld declaration must
      // stay a candidate so the loop can refuse it with a 404 instead of
      // letting the segment fall through into `create`.
      if (declaresRuntimeRestRouteShape(this.runtimeMethod(objectName, name))) {
        names.add(name);
      }
    }
    return [...names].map((name) => [
      name,
      this.runtimeMethod(objectName, name),
    ]);
  }

  /**
   * The method view a RUNTIME transport should read for one action: the
   * manifest entry when the project was scanned, with its `@method()` config
   * backfilled from the live decorator store when it is not.
   */
  private runtimeMethod(
    objectName: string,
    methodName: string,
  ): MethodDefinition | undefined {
    return ObjectRegistry.resolveRuntimeMethod(objectName, methodName).method;
  }

  /**
   * Refuse a request that matched a DECLARED action's own path and verb but
   * whose action is withheld — or return `null` to let it fall through.
   *
   * Only `POST` is refused, and the asymmetry is the whole point.
   * `getCrudAction` maps `POST` to `create` and DISCARDS the path segment, so
   * falling through writes a row and answers 201 for a request aimed at an
   * operation the author withheld: silent, mutating, and the opposite of what
   * the generated SvelteKit surface does for the same URL, which 404s because
   * it wrote no route file. Every other verb carries the segment into a by-id
   * operation that 404s on its own when the segment is not an id — and that
   * fall-through is load-bearing, because an object's id may legitimately equal
   * a declared action's path, and `GET /<collection>/<id>` must keep resolving
   * to that object (#2686).
   */
  private refuseWithheldAction(
    req: Request,
    actionName: string,
    withheldBy: string,
  ): Response | null {
    if (req.method.toUpperCase() !== 'POST') return null;
    return this.createErrorResponse(
      404,
      `Custom action '${actionName}' is not exposed (${withheldBy})`,
    );
  }

  private async dispatchCustomCollectionAction(
    req: Request,
    collection: SmrtCollection<SmrtObject>,
    pathSegment: string,
    url: URL,
    objectName: string,
  ): Promise<Response | null> {
    const apiConfig = ObjectRegistry.getConfig(objectName)?.api;
    if (!apiConfig || typeof apiConfig !== 'object') {
      return null;
    }

    const declaredActions = this.declaredCollectionActions(
      objectName,
      apiConfig,
    );
    if (declaredActions.length === 0) {
      return null;
    }

    for (const [actionName, declaredMethod] of declaredActions) {
      // One view of the method for the whole loop: the item class's manifest
      // entry, else the collection class's (where a collection-hosted action's
      // parameters live), else the live `@method()` store.
      const effective = resolveEffectiveActionMetadata({
        actionName,
        ...(declaredMethod ? { method: declaredMethod } : {}),
        apiConfig,
      });
      const routePath = effective.path || actionName;
      if (routePath.includes('/') || routePath !== pathSegment) {
        continue;
      }
      const routeMethod = (effective.httpMethod || 'POST').toUpperCase();
      if (routeMethod !== req.method.toUpperCase()) {
        continue;
      }
      if (ObjectRegistry.getConfig(objectName).abstract) {
        const refusal = this.refuseWithheldAction(req, actionName, 'abstract');
        if (refusal) return refusal;
        continue;
      }
      // Past this point the request matched a DECLARATION's own path and verb,
      // so it was aimed at that action and nothing else. Withholding it must
      // not silently become a CRUD write -- see `refuseWithheldAction` (#2686).
      // Explicit exposure only: the same include/exclude gating the SvelteKit
      // generator applies, plus `@method({ expose: false })`, which outranks a
      // legacy route entry for the same method.
      if (apiConfig.include && !apiConfig.include.includes(actionName)) {
        const refusal = this.refuseWithheldAction(
          req,
          actionName,
          'api.include',
        );
        if (refusal) return refusal;
        continue;
      }
      if (apiConfig.exclude?.includes(actionName)) {
        const refusal = this.refuseWithheldAction(
          req,
          actionName,
          'api.exclude',
        );
        if (refusal) return refusal;
        continue;
      }
      if (readMethodDecoratorConfig(declaredMethod)?.expose === false) {
        const refusal = this.refuseWithheldAction(
          req,
          actionName,
          '@method({ expose: false })',
        );
        if (refusal) return refusal;
        continue;
      }

      // Receiver: an instance method on the registered collection, or a
      // static on the item class (the two hosts the generators support).
      const collectionMethod = (
        collection as unknown as Record<string, unknown>
      )[actionName];
      const itemConstructor = ObjectRegistry.getClass(objectName)
        ?.constructor as unknown as Record<string, unknown> | undefined;
      const staticMethod = itemConstructor?.[actionName];
      const isCollectionHosted = typeof collectionMethod === 'function';
      const isStaticHosted =
        !isCollectionHosted && typeof staticMethod === 'function';

      if (!isCollectionHosted && !isStaticHosted) {
        // A DECLARED action must never degrade into a CRUD write. The segment
        // matched a declaration's own path and verb, so `POST` on it resolving
        // to `create` silently inserts a row and answers 201 for a request
        // aimed at an action -- the #2047 failure this dispatch exists to
        // prevent, and the same argument the `expose: false` 404 above rests
        // on.
        //
        // Split by cause so the caller can tell them apart: a
        // collection-scoped declaration with no receiver is a 501 (declared but
        // not implemented, the historical message), while an ITEM-scoped one is
        // a 404 -- this transport only serves collection-scoped custom actions,
        // so that URL genuinely has no route here even though the generated
        // SvelteKit surface writes one under `[id]`. #2686 widened the
        // population reaching this branch by admitting `@method()`
        // declarations, and the item-scoped shape is the decorator's most
        // common one.
        if (effective.scope === 'collection') {
          // Declared-but-unimplemented is a server-side defect, reported on
          // every verb: unlike the withheld cases, there is no reading of this
          // request under which falling through was the caller's intent.
          return this.createErrorResponse(
            501,
            `Custom action '${actionName}' is declared but not implemented`,
          );
        }
        const refusal = this.refuseWithheldAction(
          req,
          actionName,
          'an item-scoped declaration, which this transport does not serve',
        );
        if (refusal) return refusal;
        continue;
      }

      const metadata = resolveCustomActionMetadata({
        actionName,
        apiConfig,
        ...(declaredMethod ? { method: declaredMethod } : {}),
        // A collection instance method is collection-hosted even when it is
        // not static; a static on the item class already defaults the same
        // way. Either receiver makes this route collection-targeted.
        defaultScope: 'collection',
      });
      if (metadata.scope !== 'collection') {
        continue;
      }

      const invoke = isCollectionHosted
        ? (args: unknown[]) =>
            (collectionMethod as (...a: unknown[]) => unknown).apply(
              collection,
              args,
            )
        : (args: unknown[]) =>
            (staticMethod as (...a: unknown[]) => unknown).apply(
              itemConstructor,
              args,
            );

      // An ABSENT body is "no input", not a malformed one — a zero-parameter
      // action is legitimately called with no body at all. A body that is
      // present but unparseable stays a 400 rather than degrading into a CRUD
      // write. GET reads the query string instead.
      let options: unknown;
      if (routeMethod === 'GET') {
        const isOptionsBag =
          metadata.parameters === undefined ||
          (metadata.parameters.length === 1 &&
            metadata.parameters[0]?.name === 'options');
        if (isOptionsBag) {
          const optionsMarker = url.searchParams.get('__smrt_options');
          if (optionsMarker === 'undefined') {
            options = undefined;
          } else if (optionsMarker === 'null') {
            options = null;
          } else if (optionsMarker === 'object') {
            options = {};
          } else {
            const entries = [...url.searchParams.entries()].filter(
              ([key]) => key !== '__smrt_options',
            );
            options =
              entries.length > 0 ? Object.fromEntries(entries) : undefined;
          }
        } else {
          options = Object.fromEntries(url.searchParams.entries());
        }
        // A read action never takes ownership from the caller: ownership keys
        // in the query are dropped and the request's tenant scope is set under
        // the model's ownership field(s), as every other dispatch site does.
        options = scopeActionOptions(this.tenancyOf(req), options);
      } else {
        let rawBody = '';
        try {
          rawBody = await req.text();
        } catch {
          rawBody = '';
        }
        if (rawBody.trim() !== '') {
          try {
            options = JSON.parse(rawBody);
          } catch {
            return this.createErrorResponse(400, 'Invalid JSON body');
          }
        }
      }

      // Project declared parameters only when the registry actually knows
      // them. Without metadata the historical single-options call is kept
      // verbatim, so an opaque body (an array, or any non-record payload an
      // existing action already accepts) still arrives unchanged rather than
      // being silently normalized away.
      const actionInput: Record<string, unknown> = {
        ...(options && typeof options === 'object' && !Array.isArray(options)
          ? (options as Record<string, unknown>)
          : {}),
        options,
      };
      if (routeMethod === 'GET' && metadata.parameters) {
        // A parameter named after an ownership property is handed the scope
        // value set above, never a caller value: flat transports read a
        // parameter under its transport name (`id` as `actionId`), which the
        // scoping step does not know about, so the scoped value is written
        // under that name too. The properties are the ones the scope set;
        // none when tenancy is off or a super-admin bypass applies.
        const scopedProperties = new Set(
          scopedOptionProperties(this.tenancyOf(req)),
        );
        for (const parameter of metadata.parameters) {
          if (!scopedProperties.has(parameter.name)) continue;
          actionInput[
            customActionParameterInputName(metadata, parameter.name)
          ] = actionInput[parameter.name];
        }
      }
      const invocationArgs = metadata.parameters
        ? buildCustomActionInvocationArgs(metadata, actionInput)
        : [options];

      // A caller with no tenant is refused every custom collection action of
      // a tenant-scoped model, GET actions included, whatever the method's
      // parameters; the CRUD list, get and count reads are the ones that serve
      // it rows without an owner. A caller with a tenant, or an explicitly
      // cross-tenant one, runs the action inside the bound request tenancy,
      // whose interceptor holds every collection call to the admitted rows.
      // A mutating action needs the write gate (#5375).
      throwIfRefused(
        customActionScope(this.tenancyOf(req), {
          mutating: routeMethod !== 'GET',
          receivesScope: false,
        }),
      );
      const result = await invoke(invocationArgs);

      const failure = normalizeCustomActionFailure(result);
      if (failure) {
        return this.createJsonResponse({ error: failure }, failure.status);
      }

      return this.createJsonResponse({
        action: actionName,
        result: this.sanitizeActionResult(result),
      });
    }

    return null;
  }

  /**
   * Public-safe projection for custom-action results, mirroring the generated
   * SvelteKit routes' `toPublicResult`: a `SmrtObject` (anything exposing
   * `toPublicJSON`) becomes its public projection with the caller's
   * permissions, arrays and plain objects are walked, non-plain instances and
   * primitives pass through, and a cycle guard breaks reference loops.
   */
  private sanitizeActionResult(
    value: unknown,
    seen: WeakSet<object> = new WeakSet(),
  ): unknown {
    if (value === null || typeof value !== 'object') {
      return value;
    }
    if (seen.has(value)) {
      return null;
    }
    const serialize = publicSerializerOf(value);
    if (serialize) {
      seen.add(value);
      return this.sanitizeActionResult(
        serialize(this.getPublicJsonOptions()),
        seen,
      );
    }
    if (Array.isArray(value)) {
      seen.add(value);
      return value.map((entry) => this.sanitizeActionResult(entry, seen));
    }
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      return value;
    }
    seen.add(value);
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = this.sanitizeActionResult(entry, seen);
    }
    return out;
  }

  /**
   * The tenancy this request resolved (#5375). Every handler below runs
   * inside `executeCrudOperation`, which resolved it.
   */
  private tenancyOf(req: Request): RequestTenancy {
    const tenancy = this.requestTenancies.get(req);
    if (!tenancy) {
      throw new RequestTenancyError(
        403,
        'TENANT_POLICY_UNRESOLVED',
        'The tenancy of this model could not be resolved.',
      );
    }
    return tenancy;
  }

  /**
   * The read scope of this request (#1782, #5375): refused when its tenancy
   * refuses the read, `{ <ownership field>: null }` for a caller with no
   * tenant of an optional-mode model (rows without an owner only), else
   * `undefined` (the interceptor filters by the active tenant, or nothing
   * restricts the read).
   */
  private readScopeOf(req: Request): Record<string, null> | undefined {
    const decision = readScope(this.tenancyOf(req));
    throwIfRefused(decision);
    return decision.kind === 'global-only' ? decision.scope : undefined;
  }

  /**
   * Merge the read scope into a query's WHERE clause. When it is active
   * (rows without an owner), every client filter on an ownership column is
   * dropped first, under any spelling and operator, then the scope is set.
   * The stored types a route serves are enforced by the bound interceptor,
   * which intersects any caller type filter with the admitted types.
   */
  private applyTenantReadScope(
    where: Record<string, unknown> | undefined,
    req: Request,
  ): Record<string, unknown> | undefined {
    return applyWhereScope(where, this.readScopeOf(req));
  }

  /** A point-read filter for `id` under this request's read scope. */
  private pointReadFilter(
    id: string,
    req: Request,
  ): string | Record<string, unknown> {
    const scope = this.readScopeOf(req);
    // The id resolves as `collection.get(id)` would resolve it (a UUID, else
    // the slug in the default context), then takes the scope.
    return scope ? { ...resolveGetStringFilter(id), ...scope } : id;
  }

  /**
   * Handle GET /objects/:id
   */
  private async handleGet(
    collection: SmrtCollection<SmrtObject>,
    id: string,
    req: Request,
    objectName?: string,
  ): Promise<Response> {
    const cacheControl = this.resolveReadCachePolicy(objectName, req);

    const displayLabel = !!(
      objectName &&
      resolveDisplayLabelProjection(
        ObjectRegistry.getConfig(objectName).display?.label,
      )
    );
    if (
      this.hasReadPermissionFields(objectName) ||
      this.hasCallerDependentFamily(objectName) ||
      displayLabel
    ) {
      // Caller-specific fields and linked names can change without a parent
      // table write. Validate the actual public body in both cases.
      const filter = this.pointReadFilter(id, req);
      const object = displayLabel
        ? await collection.get(filter, { displayLabel: true })
        : await collection.get(filter);
      if (!object) {
        return this.createErrorResponse(404, 'Object not found');
      }
      return conditionalJsonResponse(
        req,
        this.toPublicData(object),
        cacheControl,
      );
    }

    // ETag v2 (#1765): compute the table-version ETag first. A CONCRETE
    // If-None-Match short-circuits into a 304 BEFORE the row is fetched — a
    // delete advances the table version (tombstone), so a stale cached
    // representation of a since-deleted row can never concretely match. A
    // wildcard `*` is deferred until AFTER the fetch confirms the row exists,
    // so a missing row still returns 404 (not a false 304).
    const etag = await this.computeReadEtag(collection, req, objectName);
    const ifNoneMatch = req.headers.get('if-none-match');
    const notModified = (): Response =>
      new Response(null, {
        status: 304,
        headers: { 'Cache-Control': cacheControl, ETag: etag },
      });
    if (ifNoneMatchHasConcreteMatch(ifNoneMatch, etag)) {
      return notModified();
    }

    // #1782: scope a public/anonymous read of a tenant-scoped model to global
    // (NULL-tenant) rows when no tenant context is active.
    const object = await collection.get(this.pointReadFilter(id, req));
    if (!object) {
      return this.createErrorResponse(404, 'Object not found');
    }
    // Row exists → a wildcard `*` may now be honored as a 304.
    if (ifNoneMatchSatisfied(ifNoneMatch, etag)) {
      return notModified();
    }
    return new Response(JSON.stringify(this.toPublicData(object)), {
      status: 200,
      headers: {
        'Cache-Control': cacheControl,
        'Content-Type': 'application/json',
        ETag: etag,
      },
    });
  }

  /**
   * Handle GET /objects (list with query params)
   */
  private async handleList(
    collection: SmrtCollection<SmrtObject>,
    params: URLSearchParams,
    req: Request,
    objectName?: string,
  ): Promise<Response> {
    const cacheControl = this.resolveReadCachePolicy(objectName, req);

    // #2367: parse the page bounds BEFORE any ETag/version work, and outside
    // `buildPayload`, so a malformed `?limit=abc` costs one rejection rather
    // than a table-version read plus a `LIMIT NaN` round-trip to the driver.
    // `resolveListLimit` throws a 400-typed `QueryBoundsError`, which
    // `handleRequest`'s `normalizeTypedHttpError` catch renders as a structured
    // client error instead of the 500 `Number.parseInt('abc')` used to produce.
    const limit = resolveListLimit(params.get('limit'));
    const offset = resolveListOffset(params.get('offset'));

    // A filter or ordering may name only fields this caller may read: the
    // same permissions the rows are projected with. Checked here, with the
    // bounds, so a refused query is answered before any ETag or table work.
    const where = parseRestListWhere(params, objectName);
    const orderByParam = params.get('orderBy');
    assertQueryAccess(
      objectName,
      { where, orderBy: orderByParam },
      this.getPublicJsonOptions(),
    );

    const displayLabel = !!(
      objectName &&
      resolveDisplayLabelProjection(
        ObjectRegistry.getConfig(objectName).display?.label,
      )
    );
    const buildPayload = async () => {
      // #2367: the default ordering carries a primary-key tiebreak. Rows sharing
      // a `created_at` tick tie under `created_at DESC` alone, and a tie leaves
      // the order unspecified — so successive LIMIT/OFFSET pages could repeat
      // and skip those rows. An explicit `?orderBy` still wins.
      const orderBy: string | string[] = orderByParam
        ? orderByParam
        : this.resolveDefaultListOrderBy(objectName);

      // #1782: fail closed to global (NULL-tenant) rows for a public/anonymous
      // read of a tenant-scoped model with no active tenant context.
      const scopedWhere = this.applyTenantReadScope(where, req);

      const objects = await collection.list({
        ...(displayLabel ? { displayLabel: true } : {}),
        where:
          scopedWhere && Object.keys(scopedWhere).length > 0
            ? scopedWhere
            : undefined,
        limit,
        offset,
        orderBy,
      });

      return objects.map((object: SmrtObject) => this.toPublicData(object));
    };

    if (
      this.hasReadPermissionFields(objectName) ||
      this.hasCallerDependentFamily(objectName) ||
      (objectName &&
        typeof ObjectRegistry.getConfig(objectName).display?.label === 'object')
    ) {
      // Hash the public payload: permissions and linked-table writes can
      // change it without advancing the parent table version.
      return conditionalJsonResponse(req, await buildPayload(), cacheControl);
    }

    // ETag v2 (#1765): resolve the policy + table-version ETag first, then
    // hand the list query to versionConditionalResponse as a thunk. On a
    // matching If-None-Match it returns a 304 and the thunk — the collection
    // query — never runs, so an unchanged table revalidates with no table scan.
    const etag = await this.computeReadEtag(collection, req, objectName);
    return versionConditionalResponse(req, etag, cacheControl, buildPayload);
  }

  /**
   * Handle GET /objects/count
   */
  private async handleCount(
    collection: SmrtCollection<SmrtObject>,
    params: URLSearchParams,
    req: Request,
    objectName?: string,
  ): Promise<Response> {
    const where = parseRestListWhere(params, objectName);

    // A count answers the same question a filtered list does, so its filter
    // is held to the same rule: fields this caller may read.
    assertQueryAccess(objectName, { where }, this.getPublicJsonOptions());

    // #1782: a count leaks cross-tenant cardinality just as a list leaks rows,
    // so apply the same fail-closed global scope for anonymous tenant reads.
    const scopedWhere = this.applyTenantReadScope(where, req);

    const count = await collection.count({
      where:
        scopedWhere && Object.keys(scopedWhere).length > 0
          ? scopedWhere
          : undefined,
    });

    return this.createJsonResponse({ count });
  }

  /**
   * Handle POST /objects
   */
  private async handleCreate(
    collection: SmrtCollection<SmrtObject>,
    req: Request,
    objectName?: string,
  ): Promise<Response> {
    if (objectName) throwIfRefused(writeGate(this.tenancyOf(req)));
    const rawBody = await req.text();
    const body = rawBody.trim() === '' ? {} : JSON.parse(rawBody);
    let targetName = objectName;
    let data = body;
    if (objectName) {
      const tenant = await this.requestTenant(req);
      const target = ObjectRegistry.resolveCreateTarget(objectName, body, {
        surface: 'rest',
        tenantId: tenant.effectiveTenantId ?? undefined,
        request: req,
      });
      // A subtype whose own surface closes create is not a target here.
      assertCreateTargetSurface(objectName, target, 'api');
      // A server given its models creates only those models. A subtype of a
      // served base is a model of its own: served when it was given too.
      if (
        this.modelScope &&
        target.collectionName !== objectName &&
        !this.modelScope.has(
          registryKeyOf(
            ObjectRegistry.getExposureModel(target.name) ??
              ({ name: target.name } as RegisteredClass),
          ),
        )
      ) {
        throw new CreateTargetError(target.name, objectName);
      }
      targetName = target.collectionName;
      if (target.collectionName !== objectName) {
        // The subtype authorizes its own create too.
        const refusal = await this.authorizeRowModel(
          new Request(req.url, {
            method: req.method,
            headers: req.headers,
            body: rawBody,
          }),
          target.collectionName,
          'create',
          req,
        );
        if (refusal) return refusal;
        const info = ObjectRegistry.getClass(targetName);
        if (!info)
          return this.createErrorResponse(404, 'Create target unavailable');
        collection = await this.getCollection(info);
      }
      data = target.data;
    }
    const writable = this.applyWritablePolicy(targetName, data);
    // Create input names declared fields and settable accessors only.
    if (targetName) assertCreateInput(targetName, writable, collection);
    // A subtype the route does not admit (its tenancy differs) is refused
    // by the bound interceptor when the row is saved.
    const object = await collection.create({ ...writable, _skipLoad: true });
    return this.createJsonResponse(this.toPublicData(object), 201);
  }

  /**
   * Handle PUT/PATCH /objects/:id
   */
  private async handleUpdate(
    collection: SmrtCollection<SmrtObject>,
    id: string,
    req: Request,
    objectName?: string,
  ): Promise<Response> {
    if (objectName) throwIfRefused(writeGate(this.tenancyOf(req)));
    const rawBody = await req.text();
    const data = this.applyWritablePolicy(
      objectName,
      rawBody.trim() === '' ? {} : JSON.parse(rawBody),
    );
    const object = await collection.get(this.pointReadFilter(id, req));

    if (!object) {
      return this.createErrorResponse(404, 'Object not found');
    }
    const rowModel = modelOfInstance(object);
    if (objectName && rowModel && rowModel !== objectName) {
      const refusal = await this.authorizeRowModel(
        new Request(req.url, {
          method: req.method,
          headers: req.headers,
          body: rawBody,
        }),
        rowModel,
        'update',
        req,
      );
      if (refusal) return refusal;
    }

    // The body sets declared fields and settable accessors, nothing else.
    await collection.withAuditMutation(object, 'updated', async (bound) => {
      applyUpdateInput(bound, data, objectName);
      await bound.save();
    });

    return this.createJsonResponse(this.toPublicData(object));
  }

  /**
   * Handle DELETE /objects/:id
   */
  private async handleDelete(
    collection: SmrtCollection<SmrtObject>,
    id: string,
    req: Request,
    objectName?: string,
  ): Promise<Response> {
    if (objectName) throwIfRefused(writeGate(this.tenancyOf(req)));
    const object = await collection.get(this.pointReadFilter(id, req));

    if (!object) {
      return this.createErrorResponse(404, 'Object not found');
    }
    const rowModel = modelOfInstance(object);
    if (objectName && rowModel && rowModel !== objectName) {
      const refusal = await this.authorizeRowModel(req, rowModel, 'delete');
      if (refusal) return refusal;
    }

    await collection.delete(id);
    return new Response(null, { status: 204 });
  }

  /**
   * Handle POST /sync/apply — the idempotent batch write contract (#1759).
   * All processing lives in `sync/apply.ts`; this method only adapts the
   * generator's existing collection resolution, auth, action gating, and
   * writable policy into a {@link SyncApplyTarget} per item.
   */
  private async handleSyncApply(req: Request): Promise<Response> {
    // Buffer the body once. Request bodies are single-read streams, and the
    // per-item auth middleware below must receive a readable body exactly as
    // it does on CRUD routes (where auth runs before parsing) — so each
    // middleware invocation gets a fresh Request rebuilt from this buffer.
    let rawBody: string;
    let body: unknown;
    try {
      rawBody = await req.text();
      body = JSON.parse(rawBody);
    } catch {
      return this.createErrorResponse(400, 'Invalid JSON body');
    }

    const outcome = await processSyncApplyBatch(body, {
      resolveTarget: (objectSegment) =>
        this.resolveSyncApplyTarget(objectSegment, req, rawBody),
    });
    return this.createJsonResponse(outcome.body, outcome.status);
  }

  /**
   * Resolve a sync item's `object` segment exactly like `handleObjectRoute`
   * resolves a CRUD URL segment (registered collections first, then registry
   * auto-discovery), and wrap the generator's per-object machinery.
   */
  private async resolveSyncApplyTarget(
    objectSegment: string,
    req: Request,
    rawBody: string,
  ): Promise<SyncApplyTarget | null> {
    let collection: SmrtCollection<SmrtObject> | null = null;
    let objectName: string | null = null;

    const registered = this.collections.get(objectSegment);
    if (registered) {
      collection = registered;
      objectName = this.getCollectionObjectName(registered) || objectSegment;
    } else {
      // Same canonical-`collection` match as the CRUD path so a client and the
      // batch contract resolve identical segments (#1794).
      const info = this.findClassByCollectionSegment(objectSegment);
      if (info) objectName = registryKeyOf(info);
    }

    if (!objectName) return null;
    const exposureModel = ObjectRegistry.getExposureModel(objectName);
    const exposedFor = (
      tenantId: string | null | undefined,
      request: Request,
    ) =>
      isRuntimeModelEnabled(exposureModel, {
        surface: 'rest',
        tenantId: tenantId ?? undefined,
        request,
      });
    // The exposure gate runs once the item's request was admitted (in `run`),
    // with or without `resolveTenant`: a caller that authorization refuses
    // never learns whether a model is switched on.
    if (!collection) {
      const info = ObjectRegistry.getClass(objectName);
      if (!info) return null;
      collection = await this.getCollection(info);
    }

    const resolvedName = objectName;
    const resolvedCollection = collection;
    // The request `authMiddleware` admitted for this item; the tenant gate
    // reads the caller's tenant from it.
    let admitted = req;
    return {
      objectName: resolvedName,
      // The row an item names is looked up as this route reads it: a row of
      // a subtype the route does not serve is not found (an update or delete
      // is `not_found`; a create collides opaquely as `id_conflict`).
      collection: {
        get: (id: string) => resolvedCollection.get(id),
        create: (options: Record<string, unknown>) =>
          resolvedCollection.create(options),
      },
      // Every sync item is a write: it runs inside the tenant gate, like the
      // CRUD route it mirrors. A refusal rejects the item.
      // Each item resolves its target's tenancy (#5375) and runs inside it:
      // the item's lookup and write see only the rows and types the route
      // serves, under the policy it was admitted with.
      run: async (op, apply) => {
        const requestTenant = await this.requestTenant(admitted);
        if (!exposedFor(requestTenant.effectiveTenantId, admitted)) {
          throw new SyncApplyRejection('unknown_object');
        }
        let authenticated = requestTenant.authenticated;
        try {
          // The actor is the one the host settled for the request its
          // middleware admitted (the exposure gate above read the same
          // answer); the item's operation is passed on its own.
          await this.settleFamilyAdmission(admitted, resolvedName, false);
          const tenancy = await this.resolveTenancy(
            admitted,
            resolvedName,
            op === 'create' ? 'POST' : op === 'update' ? 'PUT' : 'DELETE',
          );
          authenticated = tenancy.actor.authenticated;
          throwIfRefused(writeGate(tenancy));
          return await withResolvedTenancy(tenancy, apply);
        } catch (error) {
          const refusal =
            tenantRefusal(error, authenticated) ??
            (error instanceof RequestTenancyError ? error : undefined);
          if (!refusal) throw error;
          throw new SyncApplyRejection(
            refusal.status === 401 ? 'auth_required' : 'forbidden',
          );
        }
      },
      // A row through a base route: its type must be served on this route,
      // and its own model authorizes the write too.
      admitRow: async (row, op) => {
        const rowModel = modelOfInstance(row);
        if (!rowModel || rowModel === resolvedName) return;
        // A row the route does not read is not found; a row it reads but
        // whose own model refuses the operation is refused below.
        if (
          !isFamilyRowServed(
            resolvedName,
            rowModel,
            'api',
            'get',
            this.modelScope,
          )
        ) {
          throw new SyncApplyRejection('not_found');
        }
        if (!this.isApiActionEnabled(rowModel, op)) {
          throw new SyncApplyRejection('op_not_allowed');
        }
        const refusal = await this.authorizeRowModel(
          new Request(admitted.url, {
            method: op === 'update' ? 'PUT' : 'DELETE',
            headers: admitted.headers,
            body: op === 'update' ? rawBody : undefined,
          }),
          rowModel,
          op,
          admitted,
        );
        if (refusal) {
          throw new SyncApplyRejection(
            refusal.status === 401
              ? 'auth_required'
              : refusal.status === 404
                ? 'not_found'
                : 'forbidden',
          );
        }
      },
      assertUpdate: (row, data) => assertUpdateInput(row, data, resolvedName),
      assertCreate: (data) =>
        assertCreateInput(resolvedName, data, resolvedCollection),
      acceptsCreateType: (payload) =>
        syncCreateSelectsOwnType(resolvedName, payload),
      // A tenant-scoped subtype row through an unscoped base is written
      // inside the subtype's tenant gate.
      mutate: async (row, op, data) => {
        await resolvedCollection.withAuditMutation(
          row as SmrtObject,
          op === 'update' ? 'updated' : 'deleted',
          async (bound) => {
            if (op === 'update') {
              applyUpdateInput(bound, data, resolvedName);
              await bound.save();
            } else {
              await bound.delete({
                expectedUpdatedAt: bound.updated_at ?? undefined,
              });
            }
          },
        );
      },
      isOpAllowed: (op: SyncApplyOp) =>
        this.isApiActionEnabled(resolvedName, op),
      authorize: async (op: SyncApplyOp) => {
        if (this.config.authMiddleware) {
          const verb =
            op === 'create' ? 'post' : op === 'update' ? 'put' : 'delete';
          const authCheck = this.config.authMiddleware(resolvedName, verb);
          // Fresh Request per invocation: the batch handler already consumed
          // the original body, and middleware may read it (body-based auth,
          // request signing) exactly as it can on CRUD routes.
          const authResult = await authCheck(
            new Request(req.url, {
              method: req.method,
              headers: req.headers,
              body: rawBody,
            }),
          );
          if (authResult instanceof Response) {
            return authResult.status === 401 ? 'auth_required' : 'forbidden';
          }
          admitted = authResult;
          return 'ok';
        }
        // Fail-closed (#1540): every sync op is mutating, so only
        // `@smrt({ api: { public: true } })` objects apply without auth.
        return this.isRoutePublic(resolvedName, 'POST')
          ? 'ok'
          : 'auth_required';
      },
      prepare: (payload) => this.applyWritablePolicy(resolvedName, payload),
    };
  }

  /**
   * Get or create collection instance
   */
  private async getCollection(
    classInfo: RegisteredClass,
  ): Promise<SmrtCollection<SmrtObject>> {
    return ObjectRegistry.getCollection(registryKeyOf(classInfo), {
      ai: this.context.ai,
      db: this.context.db,
    } as Parameters<typeof ObjectRegistry.getCollection>[1]);
  }

  /**
   * Mass-assignment guard (#1540): strip framework/server-managed and
   * `@field({ readonly: true })` fields from a create/update body, and — when an
   * `@smrt({ api: { writable: [...] } })` allowlist is set — intersect with it.
   *
   * A body sets fields and nothing else: `_`-prefixed keys and the keys that
   * configure a service of the object (`ObjectRegistry.isServiceOptionInput`)
   * never reach construction or a loaded instance.
   */
  private applyWritablePolicy(
    objectName: string | undefined,
    data: unknown,
  ): Record<string, unknown> {
    if (!data || typeof data !== 'object') {
      return {};
    }

    const serverManaged = new Set([
      'id',
      'tenantId',
      'tenant_id',
      'createdAt',
      'created_at',
      'updatedAt',
      'updated_at',
    ]);

    const readonly = new Set<string>();
    let writable: string[] | null = null;

    if (objectName) {
      const apiConfig = ObjectRegistry.getConfig(objectName)?.api;
      if (
        apiConfig &&
        typeof apiConfig === 'object' &&
        Array.isArray((apiConfig as { writable?: unknown }).writable)
      ) {
        writable = (apiConfig as { writable: string[] }).writable;
      }

      if (
        typeof ObjectRegistry.getConfig(objectName).display?.label === 'object'
      )
        readonly.add('displayLabel');
      for (const [name, def] of ObjectRegistry.getFields(objectName)) {
        if (def && (def.readonly === true || def._meta?.readonly === true)) {
          readonly.add(name);
        }
      }
    }

    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) {
      if (key.startsWith('_')) continue;
      if (ObjectRegistry.isServiceOptionInput(objectName, key)) continue;
      if (serverManaged.has(key)) continue;
      if (readonly.has(key)) continue;
      if (writable && !writable.includes(key)) continue;
      result[key] = value;
    }
    return result;
  }

  /**
   * Serialize a SmrtObject for a network response, excluding sensitive fields
   * (#1540). Falls back to the value unchanged for non-SmrtObject payloads.
   *
   * The serialiser is the one the object's class provides
   * (`publicSerializerOf`), never a property read from the instance.
   */
  private toPublicData(object: unknown): unknown {
    const serialize = publicSerializerOf(object);
    return serialize ? serialize(this.getPublicJsonOptions()) : object;
  }

  private getPublicJsonOptions(): PublicJsonOptions {
    return { permissions: this.context.permissions };
  }

  /**
   * Resolve the Cache-Control policy for a generated read and fire the
   * one-time policy warnings (#1757): private + revalidatable by default;
   * shared `s-maxage` only for public models that opt in; always private for
   * tenant-scoped models, whose bodies vary with tenant context that URL-keyed
   * shared caches cannot see. Field read-permission models are also private
   * because the body varies by caller permissions.
   */
  private resolveReadCachePolicy(
    objectName: string | undefined,
    req: Request,
  ): string {
    if (hasRuntimeExposureGate()) return 'private, no-store';
    const config = objectName
      ? ObjectRegistry.getConfig(objectName)
      : undefined;
    const apiConfig = config?.api;
    const tenancy = this.tenancyOf(req);
    const permissionScoped =
      this.hasReadPermissionFields(objectName) ||
      this.hasCallerDependentFamily(objectName);
    const cacheControl = cachePolicy(tenancy, apiConfig, permissionScoped);
    if (objectName) {
      // The decision of the request's tenancy (#5375): shared caching only
      // when no member the read may return is tenant-scoped.
      const tenantScoped =
        cacheControl !== cachePolicy(tenancy, apiConfig, false) ||
        tenancy.route.scoped;
      warnIfSharedCacheNeutralized(
        objectName,
        apiConfig,
        tenantScoped,
        permissionScoped,
      );
      warnIfTenantScopedPublicRead(objectName, apiConfig, tenancy.route.scoped);
    }
    return cacheControl;
  }

  /**
   * Deterministic default ordering for a generated list page (#2367).
   *
   * The tiebreak follows the model's actual primary key. A class declaring
   * `@field({ primaryKey: true })` has no synthetic `id` column — schema
   * generation omits `id`/`slug`/`context` for custom-primary-key classes — so a
   * hard-coded `id ASC` would name a column that does not exist and fail every
   * unqualified list request for that model.
   *
   * The flag is read from both `_meta.primaryKey` and the top level: manifest
   * field definitions carry it under `_meta`, decorator option bags mirror some
   * flags at the top level.
   *
   * Deliberately reads only this object's own + inherited fields, NOT
   * `getFieldMapsForPublicPolicy()`. That helper unions the STI base and every
   * descendant because it answers a union question ("does any variant carry a
   * read-permission field?"). Used here it would let a *sibling's* primary key
   * become this object's tiebreak — and since STI variants share one table, the
   * query would still succeed while tie-breaking on a mostly-NULL sibling
   * column, silently defeating the total ordering this exists to provide.
   */
  private resolveDefaultListOrderBy(objectName: string | undefined): string[] {
    if (!objectName) return buildDefaultListOrderBy();
    const registered = ObjectRegistry.getClass(objectName);
    const className =
      registered?.qualifiedName ?? registered?.name ?? objectName;
    const fields =
      registered?.inheritedFields || ObjectRegistry.getFields(className);
    for (const [fieldName, def] of fields) {
      if (def?._meta?.primaryKey === true || def?.primaryKey === true) {
        return buildDefaultListOrderBy(fieldName);
      }
    }
    return buildDefaultListOrderBy();
  }

  private hasReadPermissionFields(objectName: string | undefined): boolean {
    if (!objectName) return false;
    for (const fields of this.getFieldMapsForPublicPolicy(objectName)) {
      for (const [, def] of fields) {
        if (
          typeof def?.readPermission === 'string' ||
          typeof def?._meta?.readPermission === 'string'
        ) {
          return true;
        }
      }
    }
    return false;
  }

  private getFieldMapsForPublicPolicy(
    objectName: string,
  ): Array<ReturnType<typeof ObjectRegistry.getFields>> {
    const registered = ObjectRegistry.getClass(objectName);
    const className =
      registered?.qualifiedName ?? registered?.name ?? objectName;
    const fieldMaps: Array<ReturnType<typeof ObjectRegistry.getFields>> = [
      registered?.inheritedFields || ObjectRegistry.getFields(className),
    ];
    const stiBase = ObjectRegistry.getSTIBase(className);
    if (stiBase) {
      fieldMaps.push(
        ObjectRegistry.getClass(stiBase)?.inheritedFields ||
          ObjectRegistry.getFields(stiBase),
      );
      for (const descendant of ObjectRegistry.getDescendants(stiBase)) {
        fieldMaps.push(
          ObjectRegistry.getClass(descendant)?.inheritedFields ||
            ObjectRegistry.getFields(descendant),
        );
      }
    }
    return fieldMaps;
  }

  /**
   * Compute the ETag v2 (#1765) for a generated read: the table's change-feed
   * version ({@link getTableVersion}) keyed by the request representation, so a
   * matching `If-None-Match` can short-circuit into a 304 BEFORE the collection
   * query runs. The representation folds in the active tenant for tenant-scoped
   * models so one tenant's cached ETag never satisfies another's read. When an
   * web-collection manifest hash is folded into the digest (#1764), so a
   * shape-only deploy busts every read validator. An explicit
   * `APIConfig.manifestHash` wins; otherwise the hash is computed from the
   * runtime registry on first use (#1862).
   */
  private async computeReadEtag(
    collection: SmrtCollection<SmrtObject>,
    req: Request,
    objectName: string | undefined,
  ): Promise<string> {
    const version = await getTableVersion(collection.db, collection.tableName);
    const representation = canonicalReadRepresentation(
      req,
      objectName ? etagDiscriminator(this.tenancyOf(req)) : undefined,
    );
    // Salt the ETag with the web-collection shape digest (#1764) so a
    // shape-only deploy busts every read validator. Runtime APIGenerator
    // deployments compute the hash from ObjectRegistry when no explicit override
    // is configured (#1862).
    return computeTableVersionEtag(
      version,
      representation,
      this.resolveManifestHash(),
    );
  }

  private resolveManifestHash(): string {
    if (this.config.manifestHash !== undefined) {
      return this.config.manifestHash;
    }
    const generation = getRegistryGeneration();
    if (this.manifestGeneration !== generation) {
      this.runtimeManifestHash = undefined;
      this.manifestGeneration = generation;
    }
    this.runtimeManifestHash ??= computeRuntimeWebManifestHash();
    return this.runtimeManifestHash;
  }

  /**
   * Create JSON response with proper headers
   */
  private createJsonResponse(data: unknown, status = 200): Response {
    return new Response(JSON.stringify(data), {
      status,
      headers: {
        'Content-Type': 'application/json',
      },
    });
  }

  /**
   * Create error response
   */
  private createErrorResponse(status: number, message: string): Response {
    return new Response(JSON.stringify({ error: message }), {
      status,
      headers: {
        'Content-Type': 'application/json',
      },
    });
  }

  /**
   * Resolve the allowed `Access-Control-Allow-Origin` for a request (#1540).
   * Returns the request's `Origin` only when it is in the configured allowlist;
   * never `*`. Returns null when CORS should not be applied.
   */
  private resolveAllowedOrigin(req: Request): string | null {
    if (!this.config.enableCors) return null;
    const allowed = this.config.allowedOrigins;
    if (!allowed || allowed.length === 0) return null;
    const origin = req.headers.get('origin');
    return origin && allowed.includes(origin) ? origin : null;
  }

  /**
   * Whether to emit `Access-Control-Allow-Credentials: true` (#1861). Only when
   * explicitly opted in AND an origin actually resolved — credentials are never
   * paired with a wildcard/absent origin (`resolveAllowedOrigin` already never
   * returns `*`).
   */
  private shouldAllowCredentials(): boolean {
    return this.config.allowCredentials === true;
  }

  /**
   * Create CORS preflight response
   */
  private createCorsResponse(req: Request): Response {
    const headers: Record<string, string> = {
      'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
      // `Last-Event-ID` is allow-listed for the `_events` SSE route (#1861): a
      // fetch-based cross-origin SSE client that resumes from a cursor sends it
      // as a request header, which is not CORS-safelisted and would otherwise
      // fail preflight. Harmless on the other routes, which ignore it.
      'Access-Control-Allow-Headers':
        'Content-Type,Authorization,Last-Event-ID',
      'Access-Control-Max-Age': '86400',
    };
    const origin = this.resolveAllowedOrigin(req);
    if (origin) {
      headers['Access-Control-Allow-Origin'] = origin;
      headers.Vary = 'Origin';
      if (this.shouldAllowCredentials()) {
        headers['Access-Control-Allow-Credentials'] = 'true';
      }
    }
    return new Response(null, { status: 200, headers });
  }

  /**
   * Add CORS headers to response
   */
  private addCorsHeaders(response: Response, req: Request): Response {
    const origin = this.resolveAllowedOrigin(req);
    if (!origin) return response;

    const headers = new Headers(response.headers);
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Vary', 'Origin');
    headers.set(
      'Access-Control-Allow-Methods',
      'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    );
    // `Last-Event-ID` so a fetch-based cross-origin SSE client can resume the
    // `_events` stream from a cursor (#1861); see createCorsResponse.
    headers.set(
      'Access-Control-Allow-Headers',
      'Content-Type,Authorization,Last-Event-ID',
    );
    // Credentialed CORS (#1861): only when opted in, and only alongside a
    // concrete echoed origin (never `*`) so cookies can flow to an allow-listed
    // cross-origin client (e.g. a credentialed EventSource on `_events`).
    if (this.shouldAllowCredentials()) {
      headers.set('Access-Control-Allow-Credentials', 'true');
    }

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  /**
   * Resolve a URL/collection segment to a registered class via auto-discovery.
   *
   * The segment IS the canonical `collection` value from the manifest
   * (`RegisteredClass.collection`, e.g. `products` for `Product`) — the same
   * value the generated client, the SvelteKit route generator, and the registry
   * all derive. Match it VERBATIM; do not re-pluralize. The previous
   * implementation pluralized both the URL segment and the class name and
   * compared them, turning an already-plural client URL (`/products`) into
   * `productses`, so the generated client 404'd against auto-discovered routes
   * (#1794). Shared by the CRUD path and the `sync/apply` batch path so they can
   * never drift.
   *
   * @param segment - The URL/collection path segment (e.g. `products`).
   * @returns The matching registered class, or null if none matches.
   */
  private findClassByCollectionSegment(
    segment: string,
  ): RegisteredClass | null {
    const entry = this.collectionSegmentIndex().get(segment);
    if (!entry) return null;
    if (entry.error) throw entry.error;
    if (entry.models.size > 1) {
      throw ambiguousSegmentError(new Map([[segment, entry]]));
    }
    return entry.models.values().next().value ?? null;
  }

  /**
   * Every collection segment auto-discovery can serve, with the model each
   * resolves to. Rebuilt when the registry generation moves.
   *
   * A segment resolves to one model or to none. Two distinct models that
   * resolve to the same segment (for example same-named models of two
   * packages that derive the same collection) are ambiguous: a lookup of the
   * segment throws {@link ConfigurationError} instead of picking one by
   * registration order, and a `createRestServer(objects)` server refuses to
   * start. Models with `api: false`, and models outside a
   * `createRestServer(objects)` scope, are not candidates.
   */
  private collectionSegmentIndex(): Map<string, CollectionSegmentEntry> {
    const generation = ObjectRegistry.getGeneration();
    if (this.segmentIndex?.generation === generation) {
      return this.segmentIndex.entries;
    }
    const entries = new Map<string, CollectionSegmentEntry>();
    const entryFor = (segment: string): CollectionSegmentEntry => {
      let entry = entries.get(segment);
      if (!entry) {
        entry = { models: new Map() };
        entries.set(segment, entry);
      }
      return entry;
    };
    for (const [key, info] of ObjectRegistry.getAllClasses()) {
      // The framework's own abstract base classes are scaffolding, not
      // resources — never resolve a request to one of them, regardless of
      // config (#2642).
      if (isFrameworkBaseClass(info.name || key, info.packageName)) continue;
      // The segment IS the canonical manifest `collection` value; match it
      // verbatim (#1794). Classes registered without a `collection`
      // (inline/test stubs) derive the plural segment from the simple name
      // (#951).
      const segment =
        info.collection || this.pluralize((info.name || key).toLowerCase());
      if (info.generatedFields?.error) {
        entryFor(segment).error ??= info.generatedFields.error;
        continue;
      }
      const model = this.segmentModel(info, key, segment);
      if (!model) continue;
      const modelKey = registryKeyOf(model);
      if (this.modelScope && !this.modelScope.has(modelKey)) continue;
      if (ObjectRegistry.getConfig(modelKey).api === false) continue;
      entryFor(segment).models.set(modelKey, model);
    }
    this.segmentIndex = { generation, entries };
    return entries;
  }

  /**
   * The model a class registered under `segment` serves. Collections and
   * their row models share a URL, and STI subtypes that keep their base's
   * collection resolve to the ancestor that owns it, so every gate, policy
   * check and execution uses the effective row identity, independent of
   * registration order.
   */
  private segmentModel(
    info: RegisteredClass,
    key: string,
    segment: string,
  ): RegisteredClass | null {
    const model = ObjectRegistry.getExposureModel(info.qualifiedName || key);
    if (!model) return null;
    if (!info.collection) return model;
    const modelKey = registryKeyOf(model);
    if (ObjectRegistry.getSTIBase(modelKey)) {
      const owner = ObjectRegistry.getInheritanceChain(modelKey)
        .map((ancestor) => ObjectRegistry.getClass(ancestor))
        .find((ancestor) => ancestor?.collection === segment);
      if (owner) return owner;
    }
    return model;
  }

  /**
   * Simple pluralization (basic implementation)
   */
  private pluralize(word: string): string {
    if (word.endsWith('y')) {
      return `${word.slice(0, -1)}ies`;
    }
    if (word.endsWith('s') || word.endsWith('sh') || word.endsWith('ch')) {
      return `${word}es`;
    }
    return `${word}s`;
  }
}

// REST Server Utilities

export interface RestServerConfig extends APIConfig {
  healthCheck?: {
    enabled?: boolean;
    path?: string;
    customChecks?: (() => Promise<boolean>)[];
  };
}

/**
 * Create a Node HTTP REST server for `objects`.
 *
 * The server serves the models in `objects` and no other registered model:
 * auto-discovery resolves a collection segment only to one of them (an STI
 * base also serves the subtypes that share its collection). A class that is
 * not registered with `@smrt()` is not served, and is reported with a
 * warning.
 *
 * @param objects - The `@smrt()` classes to serve
 * @param context - Fixed request context (database, tenant, permissions)
 * @param config - Server and route configuration
 * @throws {ConfigurationError} when two of `objects` resolve to one segment
 */
export function createRestServer(
  objects: (typeof SmrtObject)[],
  context: APIContext = {},
  config: RestServerConfig = {},
): { server: http.Server; url: string } {
  const scope = new Set<string>();
  for (const obj of objects) {
    // The class a provider exported may have been replaced by an app's
    // same-name class; the replacement serves its rows.
    const registered = ObjectRegistry.getEffectiveClassByConstructor(
      obj as unknown as SmrtObjectConstructor,
    );
    if (!registered) {
      console.warn(`Object ${obj.name} not registered with @smrt decorator`);
      continue;
    }
    // The model that serves the class's rows (a replacement, if any).
    scope.add(
      registryKeyOf(
        ObjectRegistry.getExposureModel(registryKeyOf(registered)) ??
          registered,
      ),
    );
  }

  const generator = new APIGenerator(
    { ...config, [MODEL_SCOPE]: scope } as ScopedAPIConfig,
    context,
  );
  const { server, url } = generator.createServer();

  console.log(`🚀 smrt REST API server running at ${url}`);

  return { server, url };
}

/**
 * Start server with graceful shutdown
 */
export function startRestServer(
  objects: (typeof SmrtObject)[],
  context: APIContext = {},
  config: RestServerConfig = {},
): Promise<() => Promise<void>> {
  return new Promise((resolve) => {
    const { server, url } = createRestServer(objects, context, config);

    // Graceful shutdown function
    const shutdown = (): Promise<void> => {
      return new Promise((shutdownResolve) => {
        console.log('🛑 Shutting down server gracefully...');
        // Node's http.Server#close stops accepting new connections and invokes
        // the callback once in-flight ones drain. (The prior `.stop()` was a
        // Bun-era API absent on http.Server — it would have thrown.)
        server.close(() => {
          console.log('✅ Server shut down complete');
          shutdownResolve();
        });
      });
    };

    // Handle shutdown signals
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);

    resolve(shutdown);
  });
}
