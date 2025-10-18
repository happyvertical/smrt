/**
 * High-performance REST API generator for smrt objects using Node.js HTTP server
 *
 * Designed for minimal bundle size and maximum performance
 */

import http from 'node:http';
import type { SmrtCollection } from '../collection';
import type { SmrtObject } from '../object';
import { ObjectRegistry } from '../registry';

export interface APIConfig {
  basePath?: string;
  enableCors?: boolean;
  customRoutes?: Record<string, (req: Request) => Promise<Response>>;
  authMiddleware?: (
    objectName: string,
    action: string,
  ) => (req: Request) => Promise<Request | Response>;
  port?: number;
  hostname?: string;
}

export interface APIContext {
  db?: any;
  ai?: any;
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
  private collections = new Map<string, SmrtCollection<any>>();
  private context: APIContext;

  constructor(config: APIConfig = {}, context: APIContext = {}) {
    this.config = {
      basePath: '/api/v1',
      enableCors: true,
      port: 3000,
      hostname: '0.0.0.0',
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
  registerCollection(name: string, collection: SmrtCollection<any>): void {
    this.collections.set(name, collection);
  }

  /**
   * Create Node.js HTTP server with all routes
   */
  createServer(): { server: any; url: string } {
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
    for (const [key, value] of webResponse.headers.entries()) {
      res.setHeader(key, value);
    }

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
      return this.createCorsResponse();
    }

    // Handle custom routes first
    if (this.config.customRoutes) {
      for (const [path, handler] of Object.entries(this.config.customRoutes)) {
        if (url.pathname === `${this.config.basePath}${path}`) {
          const response = await handler(req);
          return this.addCorsHeaders(response);
        }
      }
    }

    // Handle object routes
    if (url.pathname.startsWith(this.config.basePath || '')) {
      const response = await this.handleObjectRoute(req, url);
      return this.addCorsHeaders(response);
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

    const objectType = pathParts[0];
    const objectId = pathParts[1];

    // Check for explicitly registered collection first
    if (this.collections.has(objectType)) {
      const collection = this.collections.get(objectType);
      if (!collection) throw new Error(`Collection ${objectType} not found`);

      // Apply auth middleware if configured
      if (this.config.authMiddleware) {
        const authCheck = this.config.authMiddleware(
          objectType,
          req.method.toLowerCase(),
        );
        const authResult = await authCheck(req);
        if (authResult instanceof Response) {
          return authResult; // Auth failed
        }
        // Auth passed, use the potentially modified request
        req = authResult;
      }

      // Use registered collection directly
      return await this.executeCrudOperation(req, collection, objectId, url);
    }

    // Fall back to auto-discovery via ObjectRegistry
    const registeredClasses = ObjectRegistry.getAllClasses();
    const pluralName = this.pluralize(objectType);

    let classInfo: any = null;
    for (const [name, info] of registeredClasses) {
      if (this.pluralize(name.toLowerCase()) === pluralName) {
        classInfo = info;
        break;
      }
    }

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
    }

    // Get or create collection
    const collection = this.getCollection(classInfo);

    return await this.executeCrudOperation(req, collection, objectId, url);
  }

  /**
   * Execute CRUD operation on a collection
   */
  private async executeCrudOperation(
    req: Request,
    collection: SmrtCollection<any>,
    objectId: string | undefined,
    url: URL,
  ): Promise<Response> {
    try {
      // Handle special /count endpoint
      if (objectId === 'count' && req.method === 'GET') {
        return await this.handleCount(collection, url.searchParams);
      }

      // Route to appropriate CRUD operation
      switch (req.method) {
        case 'GET':
          return objectId
            ? await this.handleGet(collection, objectId)
            : await this.handleList(collection, url.searchParams);

        case 'POST':
          return await this.handleCreate(collection, req);

        case 'PUT':
        case 'PATCH':
          if (!objectId) {
            return this.createErrorResponse(
              400,
              'Object ID required for update',
            );
          }
          return await this.handleUpdate(collection, objectId, req);

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

  /**
   * Handle GET /objects/:id
   */
  private async handleGet(
    collection: SmrtCollection<any>,
    id: string,
  ): Promise<Response> {
    const object = await collection.get(id);
    if (!object) {
      return this.createErrorResponse(404, 'Object not found');
    }
    return this.createJsonResponse(object);
  }

  /**
   * Handle GET /objects (list with query params)
   */
  private async handleList(
    collection: SmrtCollection<any>,
    params: URLSearchParams,
  ): Promise<Response> {
    const limit = Number.parseInt(params.get('limit') || '50', 10);
    const offset = Number.parseInt(params.get('offset') || '0', 10);
    const orderBy = params.get('orderBy') || 'created_at DESC';

    // Build where clause from query params
    // Convert REST-style operators (price[gt]) to SQL-style (price >)
    const where: any = {};
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

    const objects = await collection.list({
      where: Object.keys(where).length > 0 ? where : undefined,
      limit,
      offset,
      orderBy,
    });

    return this.createJsonResponse(objects);
  }

  /**
   * Handle GET /objects/count
   */
  private async handleCount(
    collection: SmrtCollection<any>,
    params: URLSearchParams,
  ): Promise<Response> {
    // Build where clause from query params (same logic as handleList)
    const where: any = {};
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

    const count = await collection.count({
      where: Object.keys(where).length > 0 ? where : undefined,
    });

    return this.createJsonResponse({ count });
  }

  /**
   * Handle POST /objects
   */
  private async handleCreate(
    collection: SmrtCollection<any>,
    req: Request,
  ): Promise<Response> {
    const data = (await req.json()) as Record<string, any>;
    const object = await collection.create({ ...data, _skipLoad: true });
    await object.save();
    return this.createJsonResponse(object, 201);
  }

  /**
   * Handle PUT/PATCH /objects/:id
   */
  private async handleUpdate(
    collection: SmrtCollection<any>,
    id: string,
    req: Request,
  ): Promise<Response> {
    const data = await req.json();
    const object = await collection.get(id);

    if (!object) {
      return this.createErrorResponse(404, 'Object not found');
    }

    // Update object properties
    Object.assign(object, data);
    await object.save();

    return this.createJsonResponse(object);
  }

  /**
   * Handle DELETE /objects/:id
   */
  private async handleDelete(
    collection: SmrtCollection<any>,
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
   * Get or create collection instance
   */
  private getCollection(classInfo: any): SmrtCollection<any> {
    if (!this.collections.has(classInfo.name)) {
      const collection = new classInfo.collectionConstructor({
        ai: this.context.ai,
        db: this.context.db,
      });
      this.collections.set(classInfo.name, collection);
    }
    const collection = this.collections.get(classInfo.name);
    if (!collection) throw new Error(`Collection ${classInfo.name} not found`);
    return collection;
  }

  /**
   * Create JSON response with proper headers
   */
  private createJsonResponse(data: any, status = 200): Response {
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
   * Create CORS preflight response
   */
  private createCorsResponse(): Response {
    return new Response(null, {
      status: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type,Authorization',
        'Access-Control-Max-Age': '86400',
      },
    });
  }

  /**
   * Add CORS headers to response
   */
  private addCorsHeaders(response: Response): Response {
    if (!this.config.enableCors) return response;

    const headers = new Headers(response.headers);
    headers.set('Access-Control-Allow-Origin', '*');
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
): { server: any; url: string } {
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
        server.stop();
        console.log('✅ Server shut down complete');
        shutdownResolve();
      });
    };

    // Handle shutdown signals
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);

    resolve(shutdown);
  });
}
