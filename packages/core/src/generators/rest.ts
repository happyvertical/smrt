/**
 * High-performance REST API generator for smrt objects using Node.js HTTP server
 *
 * Designed for minimal bundle size and maximum performance
 */

import http from 'node:http';
import { getTableVersion } from '../change-feed';
import type { SmrtCollection } from '../collection';
import {
  isTenantScopedClassResolved,
  resolveDispatchTenantScope,
} from '../dispatch';
import type { SmrtObject } from '../object';
import { ObjectRegistry } from '../registry';
import type { RegisteredClass, SmrtObjectConstructor } from '../registry/types';
import {
  processSyncApplyBatch,
  SYNC_APPLY_ROUTE_SEGMENTS,
  type SyncApplyOp,
  type SyncApplyTarget,
} from '../sync/apply';
import { handleChangesRoute } from './changes-route';
import {
  canonicalReadRepresentation,
  computeTableVersionEtag,
  ifNoneMatchHasConcreteMatch,
  ifNoneMatchSatisfied,
  resolveReadCacheControl,
  resolveTenantEtagDiscriminator,
  versionConditionalResponse,
  warnIfSharedCacheNeutralized,
  warnIfTenantScopedPublicRead,
} from './conditional-get';

export interface APIConfig {
  basePath?: string;
  enableCors?: boolean;
  /**
   * Explicit CORS origin allowlist (#1540). Required when `enableCors` is true —
   * the generator never emits `Access-Control-Allow-Origin: *`. A request's
   * `Origin` is echoed only when it appears here.
   */
  allowedOrigins?: string[];
  customRoutes?: Record<string, (req: Request) => Promise<Response>>;
  authMiddleware?: (
    objectName: string,
    action: string,
  ) => (req: Request) => Promise<Request | Response>;
  port?: number;
  hostname?: string;
}

export interface APIContext {
  db?: unknown;
  ai?: unknown;
  user?: {
    id: string;
    username?: string;
    roles?: string[];
  };
}

/**
 * High-performance API generator using native Bun
 */
export class APIGenerator {
  private config: APIConfig;
  private collections = new Map<string, SmrtCollection<SmrtObject>>();
  private context: APIContext;

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
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
    }

    res.end();
  }

  /**
   * Generate fetch handler function (for serverless environments)
   */
  generateHandler(): (req: Request) => Promise<Response> {
    return (req) => this.handleRequest(req);
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

      // Apply auth middleware if configured
      if (this.config.authMiddleware) {
        const authCheck = this.config.authMiddleware(
          objectName,
          req.method.toLowerCase(),
        );
        const authResult = await authCheck(req);
        if (authResult instanceof Response) {
          return authResult; // Auth failed
        }
        // Auth passed, use the potentially modified request
        req = authResult;
      } else if (!this.isRoutePublic(objectName, req.method)) {
        // Fail-closed (#1540): no auth middleware wired and the object isn't
        // marked `@smrt({ api: { public } })` → refuse rather than serve open.
        return this.createErrorResponse(401, 'Authentication required');
      }

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

    // Apply auth middleware if configured
    if (this.config.authMiddleware) {
      const authCheck = this.config.authMiddleware(
        classInfo.name,
        req.method.toLowerCase(),
      );
      const authResult = await authCheck(req);
      if (authResult instanceof Response) {
        return authResult; // Auth failed
      }
      // Auth passed, use the potentially modified request
      req = authResult;
    } else if (!this.isRoutePublic(classInfo.name, req.method)) {
      // Fail-closed (#1540): see registered-collection branch above.
      return this.createErrorResponse(401, 'Authentication required');
    }

    // Get or create collection
    const collection = await this.getCollection(classInfo);

    return await this.executeCrudOperation(
      req,
      collection,
      objectId,
      url,
      classInfo.name,
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
    try {
      const action = this.getCrudAction(req.method, objectId);
      if (action && !this.isApiActionEnabled(objectName, action)) {
        return this.createErrorResponse(405, 'Method not allowed');
      }

      // Handle special /count endpoint
      if (objectId === 'count' && req.method === 'GET') {
        return await this.handleCount(collection, url.searchParams, objectName);
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
            return this.createErrorResponse(
              400,
              'Object ID required for update',
            );
          }
          return await this.handleUpdate(collection, objectId, req, objectName);

        case 'DELETE':
          if (!objectId) {
            return this.createErrorResponse(
              400,
              'Object ID required for delete',
            );
          }
          return await this.handleDelete(collection, objectId);

        default:
          return this.createErrorResponse(405, 'Method not allowed');
      }
    } catch (error) {
      console.error('API Error:', error);
      return this.createErrorResponse(500, 'Internal server error');
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
    if (!objectName) return false;
    const apiConfig = ObjectRegistry.getConfig(objectName)?.api;
    if (!apiConfig || typeof apiConfig !== 'object') return false;
    const publicAccess = (apiConfig as { public?: boolean | 'read' }).public;
    if (publicAccess === true) return true;
    if (publicAccess === 'read') return method.toUpperCase() === 'GET';
    return false;
  }

  private isApiActionEnabled(
    objectName: string | undefined,
    action: 'list' | 'get' | 'create' | 'update' | 'delete',
  ): boolean {
    if (!objectName) {
      return true;
    }

    const config = ObjectRegistry.getConfig(objectName);
    const apiConfig = config.api;

    if (apiConfig === false) {
      return false;
    }

    if (apiConfig && typeof apiConfig === 'object') {
      if (apiConfig.include && !apiConfig.include.includes(action)) {
        return false;
      }

      if (apiConfig.exclude?.includes(action)) {
        return false;
      }
    }

    return true;
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
   * Fail-closed tenant read scope (#1782).
   *
   * A `@TenantScoped` model served over a public/anonymous read has no ambient
   * tenant context, so the tenancy interceptor (optional mode) passes the query
   * through UNFILTERED and returns every tenant's rows. When tenancy is enabled
   * but no tenant is active, this returns a `{ tenantId: null }` filter so reads
   * fail closed to NULL-tenant (global) rows only — mirroring the dispatch
   * resolver's "enforced, no active tenant → global rows only" convention
   * (`resolveDispatchTenantScope` is the core-level trust anchor tenancy fills
   * in; core cannot import tenancy directly). Returns undefined when a tenant IS
   * active (the interceptor filters by it) or tenancy is disabled (no isolation
   * to enforce).
   *
   * Tenant scoping is recognized across BOTH registration forms (#1782): the
   * `@smrt({ tenantScoped })` config / manifest-merged form via
   * `ObjectRegistry.isTenantScoped`, and the standalone `@TenantScoped()`
   * decorator via the tenancy-filled `isTenantScopedClassResolved` hook — so a
   * `@TenantScoped()`-only public model can't slip past the guard regardless of
   * manifest timing.
   */
  private resolveTenantReadScope(
    objectName?: string,
  ): { tenantId: null } | undefined {
    if (
      !objectName ||
      !(
        ObjectRegistry.isTenantScoped(objectName) ||
        !!ObjectRegistry.getConfig(objectName)?.tenantScoped ||
        isTenantScopedClassResolved(objectName)
      )
    ) {
      return undefined;
    }
    const scope = resolveDispatchTenantScope();
    return scope.enforced && scope.tenantId === null
      ? { tenantId: null }
      : undefined;
  }

  /**
   * Merge the fail-closed tenant read scope (#1782) into a query's WHERE clause.
   * When the scope is active (global-only), any client-supplied tenant filter is
   * dropped first so a `?tenantId=...` / `?tenant_id[ne]=...` query param can
   * never widen the scope, then NULL-tenant is forced. Returns the original
   * `where` untouched when the scope is inactive.
   */
  private applyTenantReadScope(
    objectName: string | undefined,
    where: Record<string, string | string[]> | undefined,
  ): Record<string, unknown> | undefined {
    const scope = this.resolveTenantReadScope(objectName);
    if (!scope) {
      return where;
    }
    const cleaned: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(where ?? {})) {
      // A key may carry an operator suffix, e.g. "tenant_id !=" — match on the
      // field portion so no operator variant slips a client tenant filter past.
      const field = key.split(/\s+/)[0];
      if (field === 'tenantId' || field === 'tenant_id') {
        continue;
      }
      cleaned[key] = value;
    }
    cleaned.tenantId = null;
    return cleaned;
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
    // ETag v2 (#1765): compute the table-version ETag first. A CONCRETE
    // If-None-Match short-circuits into a 304 BEFORE the row is fetched — a
    // delete advances the table version (tombstone), so a stale cached
    // representation of a since-deleted row can never concretely match. A
    // wildcard `*` is deferred until AFTER the fetch confirms the row exists,
    // so a missing row still returns 404 (not a false 304).
    const cacheControl = this.resolveReadCachePolicy(objectName);
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
    const scope = this.resolveTenantReadScope(objectName);
    const object = scope
      ? await collection.get({ id, ...scope })
      : await collection.get(id);
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
    // ETag v2 (#1765): resolve the policy + table-version ETag first, then
    // hand the list query to versionConditionalResponse as a thunk. On a
    // matching If-None-Match it returns a 304 and the thunk — the collection
    // query — never runs, so an unchanged table revalidates with no table scan.
    const cacheControl = this.resolveReadCachePolicy(objectName);
    const etag = await this.computeReadEtag(collection, req, objectName);

    return versionConditionalResponse(req, etag, cacheControl, async () => {
      const limit = Number.parseInt(params.get('limit') || '50', 10);
      const offset = Number.parseInt(params.get('offset') || '0', 10);
      const orderBy = params.get('orderBy') || 'created_at DESC';

      // Build where clause from query params
      // Convert REST-style operators (price[gt]) to SQL-style (price >)
      const where: Record<string, string | string[]> = {};
      for (const [key, value] of params.entries()) {
        if (!['limit', 'offset', 'orderBy'].includes(key)) {
          // Parse REST operator format: field[operator]
          const match = key.match(/^(.+)\[(.+)\]$/);
          if (match) {
            const field = match[1];
            const operator = match[2];
            // Map REST operators to SQL operators
            const operatorMap: Record<string, string> = {
              gt: '>',
              gte: '>=',
              lt: '<',
              lte: '<=',
              ne: '!=',
              in: 'in',
              like: 'like',
            };
            const sqlOperator = operatorMap[operator] || operator;
            const sqlKey = `${field} ${sqlOperator}`;
            // Handle 'in' operator - convert comma-separated string to array
            where[sqlKey] = operator === 'in' ? value.split(',') : value;
          } else {
            where[key] = value;
          }
        }
      }

      // #1782: fail closed to global (NULL-tenant) rows for a public/anonymous
      // read of a tenant-scoped model with no active tenant context.
      const scopedWhere = this.applyTenantReadScope(objectName, where);

      const objects = await collection.list({
        where:
          scopedWhere && Object.keys(scopedWhere).length > 0
            ? scopedWhere
            : undefined,
        limit,
        offset,
        orderBy,
      });

      return objects.map((object: SmrtObject) => this.toPublicData(object));
    });
  }

  /**
   * Handle GET /objects/count
   */
  private async handleCount(
    collection: SmrtCollection<SmrtObject>,
    params: URLSearchParams,
    objectName?: string,
  ): Promise<Response> {
    // Build where clause from query params (same logic as handleList)
    const where: Record<string, string | string[]> = {};
    for (const [key, value] of params.entries()) {
      // Parse REST operator format: field[operator]
      const match = key.match(/^(.+)\[(.+)\]$/);
      if (match) {
        const field = match[1];
        const operator = match[2];
        // Map REST operators to SQL operators
        const operatorMap: Record<string, string> = {
          gt: '>',
          gte: '>=',
          lt: '<',
          lte: '<=',
          ne: '!=',
          in: 'in',
          like: 'like',
        };
        const sqlOperator = operatorMap[operator] || operator;
        const sqlKey = `${field} ${sqlOperator}`;
        // Handle 'in' operator - convert comma-separated string to array
        where[sqlKey] = operator === 'in' ? value.split(',') : value;
      } else {
        where[key] = value;
      }
    }

    // #1782: a count leaks cross-tenant cardinality just as a list leaks rows,
    // so apply the same fail-closed global scope for anonymous tenant reads.
    const scopedWhere = this.applyTenantReadScope(objectName, where);

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
    const data = this.applyWritablePolicy(objectName, await req.json());
    const object = await collection.create({ ...data, _skipLoad: true });
    await object.save();
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
    const data = this.applyWritablePolicy(objectName, await req.json());
    const object = await collection.get(id);

    if (!object) {
      return this.createErrorResponse(404, 'Object not found');
    }

    // Update object properties
    Object.assign(object, data);
    await object.save();

    return this.createJsonResponse(this.toPublicData(object));
  }

  /**
   * Handle DELETE /objects/:id
   */
  private async handleDelete(
    collection: SmrtCollection<SmrtObject>,
    id: string,
  ): Promise<Response> {
    const object = await collection.get(id);

    if (!object) {
      return this.createErrorResponse(404, 'Object not found');
    }

    await object.delete();
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
      if (info) {
        collection = await this.getCollection(info);
        objectName = info.name;
      }
    }

    if (!collection || !objectName) {
      return null;
    }

    const resolvedName = objectName;
    const resolvedCollection = collection;
    return {
      objectName: resolvedName,
      collection: resolvedCollection,
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
    if (!this.collections.has(classInfo.name)) {
      // `collectionConstructor` is typed optional on RegisteredClass, but the
      // auto-discovery path only reaches here for classes that declare one.
      // Narrow to the non-optional constructor type before instantiating.
      const ctor = classInfo.collectionConstructor as NonNullable<
        RegisteredClass['collectionConstructor']
      >;
      const collection = new ctor({
        ai: this.context.ai,
        db: this.context.db,
      });
      // Await initialize() so the auto-discovered collection is actually usable
      // (its DB is wired). Without this, list()/get() throw "Database accessed
      // before initialization" — a latent bug that was masked while the
      // generated client's plural URLs never matched the singular-only
      // auto-discovery segment (#1794). The explicit-registerCollection() path
      // receives an already-initialized collection from the caller, so this
      // only affects the auto-discovery factory.
      await collection.initialize();
      this.collections.set(classInfo.name, collection);
    }
    const collection = this.collections.get(classInfo.name);
    if (!collection) throw new Error(`Collection ${classInfo.name} not found`);
    return collection;
  }

  /**
   * Mass-assignment guard (#1540): strip framework/server-managed and
   * `@field({ readonly: true })` fields from a create/update body, and — when an
   * `@smrt({ api: { writable: [...] } })` allowlist is set — intersect with it.
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

      for (const [name, def] of ObjectRegistry.getFields(objectName)) {
        if (def && (def.readonly === true || def._meta?.readonly === true)) {
          readonly.add(name);
        }
      }
    }

    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) {
      if (key.startsWith('_')) continue;
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
   */
  private toPublicData(object: unknown): unknown {
    const serializable = object as { toPublicJSON?: () => unknown } | null;
    return typeof serializable?.toPublicJSON === 'function'
      ? serializable.toPublicJSON()
      : object;
  }

  /**
   * Resolve the Cache-Control policy for a generated read and fire the
   * one-time policy warnings (#1757): private + revalidatable by default;
   * shared `s-maxage` only for public models that opt in; always private for
   * tenant-scoped models, whose bodies vary with tenant context that URL-keyed
   * shared caches cannot see.
   */
  private resolveReadCachePolicy(objectName: string | undefined): string {
    const config = objectName
      ? ObjectRegistry.getConfig(objectName)
      : undefined;
    const apiConfig = config?.api;
    // Canonical accessor covers both `@smrt({ tenantScoped })` and the
    // manifest-merged `@TenantScoped()` decorator form; the raw config flag is
    // a belt-and-braces fallback for registrations not yet normalized.
    const tenantScoped = objectName
      ? ObjectRegistry.isTenantScoped(objectName) || !!config?.tenantScoped
      : false;
    if (objectName) {
      warnIfSharedCacheNeutralized(objectName, apiConfig, tenantScoped);
      warnIfTenantScopedPublicRead(objectName, apiConfig, tenantScoped);
    }
    return resolveReadCacheControl(apiConfig, { tenantScoped });
  }

  /**
   * Compute the ETag v2 (#1765) for a generated read: the table's change-feed
   * version ({@link getTableVersion}) keyed by the request representation, so a
   * matching `If-None-Match` can short-circuit into a 304 BEFORE the collection
   * query runs. The representation folds in the active tenant for tenant-scoped
   * models so one tenant's cached ETag never satisfies another's read.
   */
  private async computeReadEtag(
    collection: SmrtCollection<SmrtObject>,
    req: Request,
    objectName: string | undefined,
  ): Promise<string> {
    const version = await getTableVersion(collection.db, collection.tableName);
    const representation = canonicalReadRepresentation(
      req,
      this.readTenantDiscriminator(objectName),
    );
    return computeTableVersionEtag(version, representation);
  }

  /**
   * A per-tenant ETag discriminator for tenant-scoped models: the active tenant
   * id (or `global`) so tenant A's cached ETag never satisfies tenant B's read
   * of the same table and params. `undefined` for non-tenant-scoped models,
   * whose bodies do not vary by tenant.
   */
  private readTenantDiscriminator(objectName?: string): string | undefined {
    if (!objectName) return undefined;
    const tenantScoped =
      ObjectRegistry.isTenantScoped(objectName) ||
      !!ObjectRegistry.getConfig(objectName)?.tenantScoped ||
      isTenantScopedClassResolved(objectName);
    if (!tenantScoped) return undefined;
    // Shared with the generated SvelteKit route so both transports key the ETag
    // on the active tenant identically (cross-tenant false-304 guard).
    return resolveTenantEtagDiscriminator();
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
   * Create CORS preflight response
   */
  private createCorsResponse(req: Request): Response {
    const headers: Record<string, string> = {
      'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization',
      'Access-Control-Max-Age': '86400',
    };
    const origin = this.resolveAllowedOrigin(req);
    if (origin) {
      headers['Access-Control-Allow-Origin'] = origin;
      headers.Vary = 'Origin';
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
    headers.set('Access-Control-Allow-Headers', 'Content-Type,Authorization');

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
    for (const [key, info] of ObjectRegistry.getAllClasses()) {
      // Primary match: the canonical manifest `collection` segment.
      if (info.collection === segment) {
        return info;
      }
      // Back-compat fallback for classes registered without a `collection`
      // (inline/test stubs): derive the plural segment from the simple name and
      // compare to the raw URL segment. Issue #951: use the simple name
      // (info.name), not the qualified map key.
      if (
        !info.collection &&
        this.pluralize((info.name || key).toLowerCase()) === segment
      ) {
        return info;
      }
    }
    return null;
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
 * Create REST server with health checks using Bun
 */
export function createRestServer(
  objects: (typeof SmrtObject)[],
  context: APIContext = {},
  config: RestServerConfig = {},
): { server: http.Server; url: string } {
  // Register objects if not already registered
  objects.forEach((obj) => {
    if (!ObjectRegistry.hasClass(obj.name)) {
      console.warn(`Object ${obj.name} not registered with @smrt decorator`);
    }
  });

  const generator = new APIGenerator(config, context);
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
