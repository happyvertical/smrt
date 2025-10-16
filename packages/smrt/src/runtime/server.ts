/**
 * Runtime server implementation for SMRT auto-generated services
 */

import http from 'node:http';
import type { SmrtRequest, SmrtServerOptions } from './types';

export class SmrtServer {
  private options: Required<SmrtServerOptions>;
  private routes: Map<string, (req: SmrtRequest) => Promise<Response>> =
    new Map();

  constructor(options: SmrtServerOptions = {}) {
    this.options = {
      port: 3000,
      hostname: 'localhost',
      basePath: '/api/v1',
      cors: true,
      ...options,
    } as Required<SmrtServerOptions>;
  }

  /**
   * Add a route handler
   */
  addRoute(
    method: string,
    path: string,
    handler: (req: SmrtRequest) => Promise<Response>,
  ) {
    const key = `${method.toUpperCase()} ${path}`;
    this.routes.set(key, handler);
  }

  /**
   * Add GET route handler (RouteApp compatibility)
   */
  get(path: string, handler: (req: any, res: any) => void): void {
    this.addExpressStyleRoute('GET', path, handler);
  }

  /**
   * Add POST route handler (RouteApp compatibility)
   */
  post(path: string, handler: (req: any, res: any) => void): void {
    this.addExpressStyleRoute('POST', path, handler);
  }

  /**
   * Add PUT route handler (RouteApp compatibility)
   */
  put(path: string, handler: (req: any, res: any) => void): void {
    this.addExpressStyleRoute('PUT', path, handler);
  }

  /**
   * Add DELETE route handler (RouteApp compatibility)
   */
  delete(path: string, handler: (req: any, res: any) => void): void {
    this.addExpressStyleRoute('DELETE', path, handler);
  }

  /**
   * Convert Express-style handler to SMRT handler
   */
  private addExpressStyleRoute(
    method: string,
    path: string,
    handler: (req: any, res: any) => void,
  ) {
    const smrtHandler = async (req: SmrtRequest): Promise<Response> => {
      return new Promise((resolve, reject) => {
        // Create Express-style response object
        const res = {
          status: (code: number) => {
            res.statusCode = code;
            return res;
          },
          json: (data: any) => {
            resolve(
              new Response(JSON.stringify(data), {
                status: res.statusCode || 200,
                headers: {
                  'Content-Type': 'application/json',
                  ...res.headers,
                },
              }),
            );
          },
          send: (data: any) => {
            const body = typeof data === 'string' ? data : JSON.stringify(data);
            resolve(
              new Response(body, {
                status: res.statusCode || 200,
                headers: {
                  'Content-Type':
                    typeof data === 'string'
                      ? 'text/plain'
                      : 'application/json',
                  ...res.headers,
                },
              }),
            );
          },
          end: (data?: any) => {
            resolve(
              new Response(data || '', {
                status: res.statusCode || 200,
                headers: res.headers,
              }),
            );
          },
          setHeader: (key: string, value: string) => {
            if (!res.headers) res.headers = {};
            res.headers[key] = value;
            return res;
          },
          statusCode: 200,
          headers: {} as Record<string, string>,
        };

        try {
          handler(req, res);
        } catch (error) {
          reject(error);
        }
      });
    };

    this.addRoute(method, path, smrtHandler);
  }

  /**
   * Start the server
   */
  async start(): Promise<{ server: any; url: string }> {
    const server = http.createServer(async (req, res) => {
      try {
        const request = await this.nodeRequestToWebRequest(req);
        const response = await this.handleRequest(request);
        await this.webResponseToNodeResponse(response, res);
      } catch (error) {
        res.statusCode = 500;
        res.end('Internal Server Error');
      }
    });

    server.listen(this.options.port, this.options.hostname);

    const url = `http://${this.options.hostname}:${this.options.port}`;
    console.log(`[smrt] Server started at ${url}`);

    return { server, url };
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
    const url = `http://${this.options.hostname}:${this.options.port}${req.url}`;
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
   * Handle incoming requests
   */
  private async handleRequest(request: Request): Promise<Response> {
    try {
      // Handle CORS
      if (this.options.cors && request.method === 'OPTIONS') {
        return this.createCorsResponse();
      }

      // Parse request
      const smrtRequest = await this.parseRequest(request);

      // Check authentication
      if (this.options.auth) {
        const authResult = await this.authenticate(smrtRequest);
        if (!authResult) {
          return new Response('Unauthorized', { status: 401 });
        }
      }

      // Find matching route
      const routeKey = `${request.method} ${smrtRequest.url}`;
      const handler = this.findRouteHandler(routeKey);

      if (!handler) {
        return new Response('Not Found', { status: 404 });
      }

      // Execute handler
      const response = await handler(smrtRequest);

      // Add CORS headers if needed
      if (this.options.cors) {
        this.addCorsHeaders(response);
      }

      return response;
    } catch (error) {
      console.error('[smrt] Request error:', error);
      return new Response('Internal Server Error', { status: 500 });
    }
  }

  /**
   * Parse incoming request into SmrtRequest format
   */
  private async parseRequest(request: Request): Promise<SmrtRequest> {
    const url = new URL(request.url);
    const pathname = url.pathname;

    // Remove base path
    const routePath = pathname.startsWith(this.options.basePath)
      ? pathname.slice(this.options.basePath.length)
      : pathname;

    // Parse query parameters
    const query: Record<string, any> = {};
    url.searchParams.forEach((value, key) => {
      query[key] = value;
    });

    // Parse body if present
    let body: any;
    if (
      request.body &&
      (request.method === 'POST' ||
        request.method === 'PUT' ||
        request.method === 'PATCH')
    ) {
      const contentType = request.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        body = await request.json();
      } else {
        body = await request.text();
      }
    }

    // Extract headers
    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => {
      headers[key] = value;
    });

    return {
      params: {}, // Will be populated by route matching
      query,
      body,
      headers,
      method: request.method,
      url: routePath,
      json: async () => body,
    };
  }

  /**
   * Find route handler with parameter extraction
   */
  private findRouteHandler(
    routeKey: string,
  ): ((req: SmrtRequest) => Promise<Response>) | undefined {
    // First try exact match
    if (this.routes.has(routeKey)) {
      return this.routes.get(routeKey);
    }

    // Try parameter matching
    const [method, path] = routeKey.split(' ', 2);

    for (const [key, handler] of this.routes.entries()) {
      const [routeMethod, routePath] = key.split(' ', 2);

      if (method === routeMethod) {
        const params = this.matchRoute(path, routePath);
        if (params !== null) {
          // Return wrapped handler that injects params
          return async (req: SmrtRequest) => {
            req.params = params;
            return handler(req);
          };
        }
      }
    }

    return undefined;
  }

  /**
   * Match route path with parameters (e.g., /users/:id)
   */
  private matchRoute(
    requestPath: string,
    routePath: string,
  ): Record<string, string> | null {
    const requestSegments = requestPath.split('/').filter((s) => s);
    const routeSegments = routePath.split('/').filter((s) => s);

    if (requestSegments.length !== routeSegments.length) {
      return null;
    }

    const params: Record<string, string> = {};

    for (let i = 0; i < routeSegments.length; i++) {
      const routeSegment = routeSegments[i];
      const requestSegment = requestSegments[i];

      if (routeSegment.startsWith(':')) {
        // Parameter segment
        const paramName = routeSegment.slice(1);
        params[paramName] = requestSegment;
      } else if (routeSegment !== requestSegment) {
        // Literal segment mismatch
        return null;
      }
    }

    return params;
  }

  /**
   * Handle authentication
   */
  private async authenticate(request: SmrtRequest): Promise<boolean> {
    if (!this.options.auth) return true;

    const authHeader = request.headers.authorization;
    if (!authHeader) return false;

    switch (this.options.auth.type) {
      case 'bearer': {
        const token = authHeader.replace('Bearer ', '');
        return this.options.auth.verify
          ? await this.options.auth.verify(token)
          : true;
      }

      case 'basic': {
        const credentials = authHeader.replace('Basic ', '');
        return this.options.auth.verify
          ? await this.options.auth.verify(credentials)
          : true;
      }

      case 'custom':
        return this.options.auth.verify
          ? await this.options.auth.verify(authHeader)
          : true;

      default:
        return false;
    }
  }

  /**
   * Create CORS preflight response
   */
  private createCorsResponse(): Response {
    return new Response(null, {
      status: 204,
      headers: this.getCorsHeaders(),
    });
  }

  /**
   * Add CORS headers to response
   */
  private addCorsHeaders(response: Response): void {
    const corsHeaders = this.getCorsHeaders();
    Object.entries(corsHeaders).forEach(([key, value]) => {
      response.headers.set(key, value);
    });
  }

  /**
   * Get CORS headers
   */
  private getCorsHeaders(): Record<string, string> {
    const corsConfig = this.options.cors;

    if (typeof corsConfig === 'boolean') {
      return {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      };
    }

    return {
      'Access-Control-Allow-Origin': Array.isArray(corsConfig.origin)
        ? corsConfig.origin.join(', ')
        : corsConfig.origin || '*',
      'Access-Control-Allow-Methods':
        corsConfig.methods?.join(', ') || 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers':
        corsConfig.headers?.join(', ') || 'Content-Type, Authorization',
    };
  }
}

/**
 * Create a new SMRT server instance
 */
export function createSmrtServer(options?: SmrtServerOptions): SmrtServer {
  return new SmrtServer(options);
}
