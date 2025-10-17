import { ApiEndpoint, PreviewApiEndpointsInput } from '../types.js';
/**
 * Preview API endpoints that would be generated for a class
 */
export declare function previewApiEndpoints(input: PreviewApiEndpointsInput): Promise<{
    endpoints: ApiEndpoint[];
    basePath: string;
}>;
//# sourceMappingURL=preview-api-endpoints.d.ts.map