/**
 * Runtime type definitions for SMRT services
 */

export interface SmrtServerOptions {
  port?: number;
  hostname?: string;
  basePath?: string;
  cors?:
    | boolean
    | {
        origin?: string | string[];
        methods?: string[];
        headers?: string[];
      };
  /**
   * Authentication. Omit to run the server with NO authentication (every
   * request reaches the routes). Any other value, `null` included, must be a
   * valid config with `verify`: the server fails closed and refuses to
   * construct otherwise.
   */
  auth?: {
    type: 'bearer' | 'basic' | 'custom';
    // App-provided verifier: may resolve a literal boolean OR a truthy
    // decoded user/session object. `authenticate()` consumes it for
    // truthiness only, so the public return stays permissive (not `boolean`).
    // `bearer`/`basic` receive the credential after the scheme prefix (the
    // request is rejected before `verify` runs when the scheme is missing or
    // wrong); `custom` receives the whole Authorization header value.
    verify: (token: string) => Promise<unknown>;
  };
  /**
   * Maximum request body size in bytes. A larger body is answered with 413,
   * never 401, before the CORS preflight, authentication or routing, and is
   * never buffered past the limit. On `start()`'s listener a request with a
   * declared Content-Length is authenticated before its body is read; a
   * chunked body there, and every `dispatch()` body, is read up to the limit
   * before `verify` runs.
   * Default: 1048576 (1 MiB).
   */
  maxBodyBytes?: number;
}

export interface SmrtClientOptions {
  baseUrl?: string;
  basePath?: string;
  auth?: {
    type: 'bearer' | 'basic';
    token?: string;
    username?: string;
    password?: string;
  };
  fetch?: typeof fetch;
}

export interface SmrtRequest {
  params: Record<string, string>;
  query: Record<string, string>;
  body?: unknown;
  headers: Record<string, string>;
  method: string;
  url: string;
  json(): Promise<unknown>;
}

export interface SmrtResponse {
  json(data: unknown, init?: ResponseInit): Response;
  status(code: number): SmrtResponse;
  send(data?: unknown): Response;
}

export interface CollectionInterface {
  list(options?: {
    where?: Record<string, unknown> | Record<string, unknown>[][];
    orderBy?: string | string[];
    limit?: number;
    offset?: number;
    select?: readonly string[];
  }): Promise<unknown[]>;

  get(id: string): Promise<unknown | null>;

  create(data: unknown): Promise<unknown>;

  update(id: string, data: unknown): Promise<unknown | null>;

  delete(id: string): Promise<boolean>;

  count(options?: {
    where?: Record<string, unknown> | Record<string, unknown>[][];
  }): Promise<number>;
}
