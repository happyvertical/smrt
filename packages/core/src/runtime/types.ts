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
    verify?: (token: string) => Promise<boolean | any>;
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
  query: Record<string, any>;
  body?: any;
  headers: Record<string, string>;
  method: string;
  url: string;
  json(): Promise<any>;
}

export interface SmrtResponse {
  json(data: any, init?: ResponseInit): Response;
  status(code: number): SmrtResponse;
  send(data?: any): Response;
}

export interface CollectionInterface {
  list(options?: {
    where?: Record<string, any>;
    orderBy?: string | string[];
    limit?: number;
    offset?: number;
  }): Promise<any[]>;

  get(id: string): Promise<any | null>;

  create(data: any): Promise<any>;

  update(id: string, data: any): Promise<any | null>;

  delete(id: string): Promise<boolean>;

  count(options?: { where?: Record<string, any> }): Promise<number>;
}
