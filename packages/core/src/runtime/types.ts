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
  auth?: {
    type: 'bearer' | 'basic' | 'custom';
    // App-provided verifier: may resolve a literal boolean OR a truthy
    // decoded user/session object. `authenticate()` consumes it for
    // truthiness only, so the public return stays permissive (not `boolean`).
    verify?: (token: string) => Promise<unknown>;
  };
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
    where?: Record<string, unknown>;
    orderBy?: string | string[];
    limit?: number;
    offset?: number;
    select?: readonly string[];
  }): Promise<unknown[]>;

  get(id: string): Promise<unknown | null>;

  create(data: unknown): Promise<unknown>;

  update(id: string, data: unknown): Promise<unknown | null>;

  delete(id: string): Promise<boolean>;

  count(options?: { where?: Record<string, unknown> }): Promise<number>;
}
