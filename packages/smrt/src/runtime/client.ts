/**
 * Runtime client implementation for SMRT auto-generated services
 */

import type { SmrtClientOptions } from './types';

export class SmrtClient {
  private options: Required<SmrtClientOptions>;

  constructor(options: SmrtClientOptions = {}) {
    this.options = {
      baseUrl: 'http://localhost:3000',
      basePath: '/api/v1',
      fetch: globalThis.fetch,
      ...options,
    } as Required<SmrtClientOptions>;
  }

  /**
   * Make an authenticated request
   */
  async request(method: string, path: string, data?: any): Promise<any> {
    const url = `${this.options.baseUrl}${this.options.basePath}${path}`;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    // Add authentication headers
    if (this.options.auth) {
      switch (this.options.auth.type) {
        case 'bearer':
          if (this.options.auth.token) {
            headers.Authorization = `Bearer ${this.options.auth.token}`;
          }
          break;
        case 'basic':
          if (this.options.auth.username && this.options.auth.password) {
            const credentials = btoa(
              `${this.options.auth.username}:${this.options.auth.password}`,
            );
            headers.Authorization = `Basic ${credentials}`;
          }
          break;
      }
    }

    const requestOptions: RequestInit = {
      method,
      headers,
    };

    if (data && (method === 'POST' || method === 'PUT' || method === 'PATCH')) {
      requestOptions.body = JSON.stringify(data);
    }

    const response = await this.options.fetch(url, requestOptions);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    // Handle empty responses
    if (
      response.status === 204 ||
      response.headers.get('content-length') === '0'
    ) {
      return null;
    }

    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      return response.json();
    }

    return response.text();
  }

  /**
   * GET request
   */
  async get(path: string, params?: Record<string, any>): Promise<any> {
    let url = path;
    if (params && Object.keys(params).length > 0) {
      const searchParams = new URLSearchParams();
      Object.entries(params).forEach(([key, value]) => {
        if (value !== undefined && value !== null) {
          searchParams.append(key, String(value));
        }
      });
      url += `?${searchParams.toString()}`;
    }

    return this.request('GET', url);
  }

  /**
   * POST request
   */
  async post(path: string, data?: any): Promise<any> {
    return this.request('POST', path, data);
  }

  /**
   * PUT request
   */
  async put(path: string, data?: any): Promise<any> {
    return this.request('PUT', path, data);
  }

  /**
   * PATCH request
   */
  async patch(path: string, data?: any): Promise<any> {
    return this.request('PATCH', path, data);
  }

  /**
   * DELETE request
   */
  async delete(path: string): Promise<any> {
    return this.request('DELETE', path);
  }
}

/**
 * Create a new SMRT client instance
 */
export function createSmrtClient(options?: SmrtClientOptions): SmrtClient {
  return new SmrtClient(options);
}
