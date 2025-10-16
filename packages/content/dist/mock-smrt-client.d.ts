/**
 * Mock SMRT Client for Content Service - Temporary implementation for demo purposes
 *
 * This replaces the missing @smrt/client virtual module with a working implementation
 * that demonstrates the intended functionality.
 */
export interface ContentData {
    id?: string;
    references?: any;
    type?: any;
    fileKey?: any;
    author?: any;
    title?: any;
    description?: any;
    body?: any;
    publish_date?: any;
    url?: any;
    source?: any;
    status?: any;
    state?: any;
    createdAt?: string;
    updatedAt?: string;
}
export interface ApiResponse<T> {
    data: T;
    success: boolean;
    message?: string;
}
declare class MockApiClient {
    contents: {
        list(): Promise<ApiResponse<ContentData[]>>;
        get(id: string): Promise<ApiResponse<ContentData>>;
        create(contentData: Partial<ContentData>): Promise<ApiResponse<ContentData>>;
        update(id: string, updates: Partial<ContentData>): Promise<ApiResponse<ContentData>>;
        delete(id: string): Promise<ApiResponse<void>>;
    };
}
export declare function createClient(_baseUrl?: string): MockApiClient;
export default createClient;
//# sourceMappingURL=mock-smrt-client.d.ts.map