import { SmrtClientOptions } from './types';
export declare class SmrtClient {
    private options;
    constructor(options?: SmrtClientOptions);
    /**
     * Make an authenticated request
     */
    request(method: string, path: string, data?: any): Promise<any>;
    /**
     * GET request
     */
    get(path: string, params?: Record<string, any>): Promise<any>;
    /**
     * POST request
     */
    post(path: string, data?: any): Promise<any>;
    /**
     * PUT request
     */
    put(path: string, data?: any): Promise<any>;
    /**
     * PATCH request
     */
    patch(path: string, data?: any): Promise<any>;
    /**
     * DELETE request
     */
    delete(path: string): Promise<any>;
}
/**
 * Create a new SMRT client instance
 */
export declare function createSmrtClient(options?: SmrtClientOptions): SmrtClient;
//# sourceMappingURL=client.d.ts.map