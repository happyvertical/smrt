/**
 * Runtime server implementation for SMRT auto-generated services
 */

import http from 'node:http';
import { createLogger } from '@happyvertical/logger';
import type { SmrtRequest, SmrtServerOptions } from './types';

const logger = createLogger({ level: 'info' });

/**
 * Express-style response object handed to RouteApp-compatibility handlers
 * (registered via {@link SmrtServer.get}/`post`/`put`/`delete`). It mirrors the
 * subset of the Express `res` API that {@link SmrtServer.addExpressStyleRoute}
 * constructs; each terminal method (`json`/`send`/`end`) resolves the wrapped
 * SMRT handler with a Web {@link Response}.
 */
interface ExpressStyleResponse {
  status(code: number): ExpressStyleResponse;
  json(data: unknown): void;
  send(data?: unknown): void;
  end(data?: string): void;
  setHeader(key: string, value: string): ExpressStyleResponse;
  statusCode: number;
  headers: Record<string, string>;
}

/**
 * Express-style request/response handler accepted by the RouteApp-compatibility
 * route methods. Receives the parsed {@link SmrtRequest} and an
 * {@link ExpressStyleResponse}.
 */
type ExpressStyleHandler = (
  req: SmrtRequest,
  res: ExpressStyleResponse,
) => void;

/**
 * Signals a malformed client request (e.g. invalid JSON body) so that
 * {@link SmrtServer.handleRequest} can answer 400 instead of a generic 500
 * (#1378). Internal to this module.
 */
class BadRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BadRequestError';
  }
}

/** Default request body cap (bytes) when `maxBodyBytes` is not set. */
export const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

/**
 * Thrown by the {@link SmrtServer} constructor for an unsafe or invalid
 * configuration (for example `auth` set without a `verify` function).
 */
export class SmrtServerConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SmrtServerConfigError';
  }
}

/**
 * A request at ingress: method, URL and headers are known, the body is read
 * on demand through `readBody`, which counts bytes as they arrive and throws
 * {@link PayloadTooLargeError} once `maxBodyBytes` is crossed. Internal.
 */
interface IngressRequest {
  /** Method, URL and headers. Its body, if any, is read via `readBody`. */
  request: Request;
  hasBody: boolean;
  /**
   * True when the headers alone bound the body size (a Content-Length the
   * transport enforces), so authentication may run before the body is read.
   */
  lengthBoundByHeaders: boolean;
  readBody(): Promise<Uint8Array>;
}

/** Request body exceeded `maxBodyBytes`; answered with 413. Internal. */
class PayloadTooLargeError extends Error {
  constructor(limit: number) {
    super(`Request body exceeds the ${limit} byte limit`);
    this.name = 'PayloadTooLargeError';
  }
}

/**
 * The request stream closed before its body was complete (for example the
 * client disconnected while authentication was running). Internal.
 */
class RequestClosedError extends Error {
  constructor() {
    super('Request closed before its body was complete');
    this.name = 'RequestClosedError';
  }
}

/** Error codes Node reports when the peer goes away mid-request. */
const DISCONNECT_CODES = new Set([
  'ECONNRESET',
  'ECONNABORTED',
  'ERR_STREAM_PREMATURE_CLOSE',
]);

/**
 * Map a request-stream failure to {@link RequestClosedError} when it is an
 * ordinary premature disconnect (Node destroys the request with an
 * ECONNRESET-style error). Any other stream failure is returned unchanged so it
 * is still reported as a server error. Internal.
 */
function classifyStreamError(error: unknown): unknown {
  if (error instanceof RequestClosedError) return error;
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && DISCONNECT_CODES.has(code)) {
    return new RequestClosedError();
  }
  return error;
}

/** Initial capacity of a {@link BoundedBody}, grown on demand to the cap. */
const BODY_INITIAL_CAPACITY = 16 * 1024;

/**
 * Server-owned storage for a request body that never holds more than `limit`
 * bytes. Received chunks are copied in and not retained, so memory is bounded
 * by the bytes counted (a small view over a large buffer, or an empty chunk,
 * keeps nothing alive). Internal.
 */
class BoundedBody {
  private storage: Uint8Array;
  private size = 0;

  constructor(private readonly limit: number) {
    this.storage = new Uint8Array(Math.min(limit, BODY_INITIAL_CAPACITY));
  }

  /** Copy `chunk` in. Returns false, copying nothing, if it would cross the cap. */
  append(chunk: Uint8Array): boolean {
    const length = chunk.byteLength;
    if (length === 0) return true;
    const needed = this.size + length;
    if (needed > this.limit) return false;
    if (needed > this.storage.byteLength) {
      const grown = new Uint8Array(
        Math.min(this.limit, Math.max(needed, this.storage.byteLength * 2)),
      );
      grown.set(this.storage.subarray(0, this.size));
      this.storage = grown;
    }
    this.storage.set(chunk, this.size);
    this.size = needed;
    return true;
  }

  /** The bytes received so far. */
  bytes(): Buffer {
    return Buffer.from(this.storage.buffer, this.storage.byteOffset, this.size);
  }
}

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
      maxBodyBytes: DEFAULT_MAX_BODY_BYTES,
      ...options,
    } as Required<SmrtServerOptions>;

    // Only an omitted (undefined) `auth` means "no authentication". Any other
    // value, falsy ones such as `null` included, must be a valid auth config;
    // otherwise construction fails rather than opening every route.
    const auth = this.options.auth as unknown;
    if (auth !== undefined) {
      if (auth === null || typeof auth !== 'object' || Array.isArray(auth)) {
        throw new SmrtServerConfigError(
          'SmrtServer: auth must be an object with type and verify. ' +
            'Omit `auth` entirely to run without authentication.',
        );
      }
      const { type, verify } = auth as { type?: unknown; verify?: unknown };
      if (type !== 'bearer' && type !== 'basic' && type !== 'custom') {
        throw new SmrtServerConfigError(
          "SmrtServer: auth.type must be 'bearer', 'basic' or 'custom'.",
        );
      }
      if (typeof verify !== 'function') {
        throw new SmrtServerConfigError(
          `SmrtServer: auth.type '${type}' requires an auth.verify function. ` +
            'Omit `auth` entirely to run without authentication.',
        );
      }
    }
    const max = this.options.maxBodyBytes;
    if (!Number.isInteger(max) || max < 0) {
      throw new SmrtServerConfigError(
        'SmrtServer: maxBodyBytes must be a non-negative integer.',
      );
    }
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
  get(path: string, handler: ExpressStyleHandler): void {
    this.addExpressStyleRoute('GET', path, handler);
  }

  /**
   * Add POST route handler (RouteApp compatibility)
   */
  post(path: string, handler: ExpressStyleHandler): void {
    this.addExpressStyleRoute('POST', path, handler);
  }

  /**
   * Add PUT route handler (RouteApp compatibility)
   */
  put(path: string, handler: ExpressStyleHandler): void {
    this.addExpressStyleRoute('PUT', path, handler);
  }

  /**
   * Add DELETE route handler (RouteApp compatibility)
   */
  delete(path: string, handler: ExpressStyleHandler): void {
    this.addExpressStyleRoute('DELETE', path, handler);
  }

  /**
   * Convert Express-style handler to SMRT handler
   */
  private addExpressStyleRoute(
    method: string,
    path: string,
    handler: ExpressStyleHandler,
  ) {
    const smrtHandler = async (req: SmrtRequest): Promise<Response> => {
      return new Promise((resolve, reject) => {
        // Tracks whether the handler ever produced a response. A handler that
        // returns/resolves without calling json/send/end would otherwise leave
        // this promise pending forever (server hang) — we 500 instead (#1378).
        let settled = false;
        const settle = (response: Response) => {
          if (settled) return;
          settled = true;
          resolve(response);
        };
        const fail = (error: unknown) => {
          if (settled) return;
          settled = true;
          reject(error);
        };
        // Create Express-style response object
        const res: ExpressStyleResponse = {
          status: (code: number) => {
            res.statusCode = code;
            return res;
          },
          json: (data: unknown) => {
            settle(
              new Response(JSON.stringify(data), {
                status: res.statusCode || 200,
                headers: {
                  'Content-Type': 'application/json',
                  ...res.headers,
                },
              }),
            );
          },
          send: (data?: unknown) => {
            const body = typeof data === 'string' ? data : JSON.stringify(data);
            settle(
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
          end: (data?: string) => {
            settle(
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

        // Await the handler so async rejections propagate. Express-style
        // handlers signal completion via res.json/send/end; a sync throw or an
        // async rejection is surfaced as 500 by handleRequest. Promise.resolve
        // wraps both sync and async handlers uniformly (#1378).
        Promise.resolve()
          .then(() => handler(req, res))
          .then(() => {
            // Handler completed without producing a response (never called
            // json/send/end). Resolve a 500 rather than hanging forever.
            if (!settled) {
              settle(
                new Response('Internal Server Error', {
                  status: 500,
                }),
              );
            }
          })
          .catch((error) => fail(error));
      });
    };

    this.addRoute(method, path, smrtHandler);
  }

  /**
   * Start the server
   */
  async start(): Promise<{ server: http.Server; url: string }> {
    const server = http.createServer(async (req, res) => {
      try {
        const response = await this.handleRequest(this.nodeIngress(req));
        if (response.status === 413 && !req.complete) {
          // The rest of the upload is not read; close after the 413 instead
          // of draining it for keep-alive.
          res.setHeader('Connection', 'close');
        }
        await this.webResponseToNodeResponse(response, res);
      } catch {
        res.statusCode = 500;
        res.end('Internal Server Error');
      }
    });

    server.listen(this.options.port, this.options.hostname);

    const url = `http://${this.options.hostname}:${this.options.port}`;
    logger.info(`[smrt] Server started at ${url}`);

    return { server, url };
  }

  /**
   * Dispatch a request in-process and return the Response, without binding a
   * socket. Supported public entry point for embedding the router and for
   * tests that exercise routing/auth/CORS without spawning an HTTP server.
   */
  async dispatch(request: Request): Promise<Response> {
    return this.handleRequest(this.webIngress(request));
  }

  /**
   * Ingress view of a Web Request. Its Content-Length header is not binding
   * (the stream may carry more), so the body is never header-bounded.
   */
  private webIngress(request: Request): IngressRequest {
    return {
      request,
      hasBody: request.body !== null,
      lengthBoundByHeaders: false,
      readBody: () => this.readBodyCapped(request),
    };
  }

  /**
   * Read a request stream as raw bytes. The bytes are handed on undecoded so
   * the cap counts what arrived on the wire and decoding happens exactly once.
   */
  private streamToBuffer(stream: http.IncomingMessage): Promise<Buffer> {
    const limit = this.options.maxBodyBytes;
    return new Promise<Buffer>((resolve, reject) => {
      // The read may start after the stream already finished (authentication
      // can run first and the client may disconnect meanwhile). Its terminal
      // events have then been emitted, so settle from its state now.
      if (stream.readableEnded) {
        resolve(Buffer.alloc(0));
        return;
      }
      if (stream.destroyed || stream.errored) {
        reject(
          stream.errored
            ? classifyStreamError(stream.errored)
            : new RequestClosedError(),
        );
        return;
      }
      const body = new BoundedBody(limit);
      const detach = () => {
        stream.off('data', onData);
        stream.off('end', onEnd);
        stream.off('error', onError);
        stream.off('close', onClose);
      };
      const onData = (chunk: Buffer | string) => {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        if (!body.append(buf)) {
          // Stop buffering as soon as the cap is crossed (never more than
          // limit bytes in memory), but leave the request and its socket
          // open: the caller still has to write the 413, which closes the
          // connection afterwards. Later data is discarded unbuffered.
          detach();
          stream.resume();
          reject(new PayloadTooLargeError(limit));
        }
      };
      const onEnd = () => {
        detach();
        resolve(body.bytes());
      };
      const onError = (error: Error) => {
        detach();
        reject(classifyStreamError(error));
      };
      // 'close' without a prior 'end' is a premature close: settle, since no
      // 'end' will follow.
      const onClose = () => {
        detach();
        reject(new RequestClosedError());
      };
      stream.on('data', onData);
      stream.on('end', onEnd);
      stream.on('error', onError);
      stream.on('close', onClose);
    });
  }

  /**
   * Reject early on a declared Content-Length above the cap (413), or one that
   * is not a decimal length (400). The digits are compared as a string, so a
   * length beyond the floating-point range is still over the cap.
   */
  private assertDeclaredLengthWithinLimit(
    declared: string | null | undefined,
  ): void {
    if (declared === undefined || declared === null) return;
    const value = declared.trim();
    if (value === '') return;
    if (!/^[0-9]+$/.test(value)) {
      throw new BadRequestError('Invalid Content-Length');
    }
    const digits = value.replace(/^0+(?=.)/, '');
    const limit = String(this.options.maxBodyBytes);
    if (
      digits.length > limit.length ||
      (digits.length === limit.length && digits > limit)
    ) {
      throw new PayloadTooLargeError(this.options.maxBodyBytes);
    }
  }

  /**
   * Ingress view of a Node.js IncomingMessage. node:http enforces
   * Content-Length framing, so a declared length (without Transfer-Encoding)
   * bounds the body and authentication runs on the headers before the body
   * is read. A chunked body is read, up to the cap, before authentication.
   */
  private nodeIngress(req: http.IncomingMessage): IngressRequest {
    const url = `http://${this.options.hostname}:${this.options.port}${req.url}`;
    const method = req.method || 'GET';
    const headers = new Headers();

    for (const [key, value] of Object.entries(req.headers)) {
      if (value) {
        headers.set(key, Array.isArray(value) ? value[0] : value);
      }
    }

    // A Request built with a body (as this adapter did before bodies were
    // read at ingress) defaults Content-Type to text/plain;charset=UTF-8;
    // routes keep seeing that default.
    if (method !== 'GET' && method !== 'HEAD' && !headers.has('content-type')) {
      headers.set('content-type', 'text/plain;charset=UTF-8');
    }

    const declared = req.headers['content-length'];
    const chunked = req.headers['transfer-encoding'] !== undefined;
    return {
      request: new Request(url, { method, headers }),
      hasBody: chunked || (declared !== undefined && Number(declared) > 0),
      lengthBoundByHeaders: !chunked && declared !== undefined,
      readBody: () => this.streamToBuffer(req),
    };
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
   * Handle incoming requests
   */
  private async handleRequest(ingress: IngressRequest): Promise<Response> {
    const { request } = ingress;
    try {
      // The body cap is enforced at ingress, ahead of the CORS preflight,
      // authentication and routing, so an over-limit body always answers 413
      // (never 401) and `verify` never runs for one:
      // 1. A declared Content-Length over the cap is refused from the headers.
      this.assertDeclaredLengthWithinLimit(
        request.headers.get('content-length'),
      );

      // 2. A body the headers cannot bound (no or non-binding length) is read
      //    now, counted as it arrives and never buffered past the cap.
      let body: Uint8Array | undefined;
      if (ingress.hasBody && !ingress.lengthBoundByHeaders) {
        body = await ingress.readBody();
      }

      if (this.options.cors && request.method === 'OPTIONS') {
        return this.createCorsResponse();
      }

      if (this.options.auth) {
        const authResult = await this.authenticate(
          request.headers.get('authorization'),
        );
        if (!authResult) {
          return new Response('Unauthorized', { status: 401 });
        }
      }

      // 3. A header-bounded body is read only once authentication passed.
      if (ingress.hasBody && body === undefined) {
        body = await ingress.readBody();
      }

      // Parse request
      const smrtRequest = this.parseRequest(request, body);

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
      // A malformed request (e.g. invalid JSON body) is the client's fault →
      // 400, not 500 (#1378).
      if (error instanceof PayloadTooLargeError) {
        return new Response('Payload Too Large', { status: 413 });
      }
      if (error instanceof BadRequestError) {
        return new Response(error.message, { status: 400 });
      }
      if (error instanceof RequestClosedError) {
        // The client is gone; nothing will read this response.
        return new Response('Bad Request', { status: 400 });
      }
      logger.error('[smrt] Request error', { error });
      return new Response('Internal Server Error', { status: 500 });
    }
  }

  /** Read a request body's bytes, aborting once `maxBodyBytes` is crossed. */
  private async readBodyCapped(request: Request): Promise<Uint8Array> {
    const limit = this.options.maxBodyBytes;
    const reader = request.body?.getReader();
    if (!reader) return new Uint8Array(0);
    // Bytes are copied into server-owned storage bounded by the cap; chunk
    // objects are never retained. Each chunk is handled in its own frame so
    // this loop holds no chunk while waiting for the next one.
    const body = new BoundedBody(limit);
    const readNext = (): Promise<'more' | 'done' | 'over'> =>
      reader
        .read()
        .then(({ done, value }) =>
          done ? 'done' : body.append(value) ? 'more' : 'over',
        );
    while (true) {
      const step = await readNext();
      if (step === 'done') break;
      if (step === 'over') {
        // Start cancellation but do not wait for it: a source's cancel can
        // stay pending indefinitely, and the 413 must not depend on it.
        reader.cancel().catch(() => undefined);
        throw new PayloadTooLargeError(limit);
      }
    }
    return body.bytes();
  }

  /**
   * Parse incoming request into SmrtRequest format. `bodyBytes` is the body
   * already read (and size-checked) at ingress.
   */
  private parseRequest(request: Request, bodyBytes?: Uint8Array): SmrtRequest {
    const url = new URL(request.url);
    const pathname = url.pathname;

    // Remove base path
    const routePath = pathname.startsWith(this.options.basePath)
      ? pathname.slice(this.options.basePath.length)
      : pathname;

    // Parse query parameters into a null-prototype dictionary so untrusted
    // keys (`__proto__`, `constructor`) can't pollute Object.prototype.
    const query: Record<string, string> = Object.create(null);
    url.searchParams.forEach((value, key) => {
      query[key] = value;
    });

    // Parse body if present. Decoding to text first lets us treat an empty
    // body as "no body" (undefined) and surface only genuinely malformed JSON
    // as a 400 rather than a generic 500 (#1378).
    let body: unknown;
    if (
      bodyBytes &&
      (request.method === 'POST' ||
        request.method === 'PUT' ||
        request.method === 'PATCH')
    ) {
      const contentType = request.headers.get('content-type') || '';
      // Same decoding as Request.text(): UTF-8, leading BOM stripped, invalid
      // sequences replaced.
      const rawBody = new TextDecoder('utf-8').decode(bodyBytes);
      if (rawBody.trim() === '') {
        // Empty body → no body. Leave `body` undefined.
      } else if (contentType.includes('application/json')) {
        try {
          body = JSON.parse(rawBody);
        } catch (error) {
          throw new BadRequestError(
            `Invalid JSON request body: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      } else {
        body = rawBody;
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
  private async authenticate(authHeader: string | null): Promise<boolean> {
    const auth = this.options.auth;
    if (!auth) return true;
    if (!authHeader) return false;

    // bearer/basic: the declared scheme must be present; `verify` only ever
    // sees the credential after it. custom: `verify` gets the raw header.
    const schemes = { bearer: 'Bearer', basic: 'Basic' } as const;
    if (auth.type === 'custom') {
      return Boolean(await auth.verify(authHeader));
    }
    const scheme = schemes[auth.type];
    if (!scheme) return false;
    const match = /^(\S+)[ \t]+(\S.*)$/.exec(authHeader.trim());
    if (!match || match[1].toLowerCase() !== scheme.toLowerCase()) {
      return false;
    }
    return Boolean(await auth.verify(match[2]));
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
