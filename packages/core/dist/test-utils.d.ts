/**
 * Comprehensive test utilities for SMRT framework testing
 *
 * Provides unified mocking for collections, objects, and database operations
 * to support both CLI and API generator testing scenarios.
 */
/**
 * Mock object instance with all required lifecycle methods
 */
export interface MockObject {
    id: string;
    slug?: string;
    created_at?: string;
    updated_at?: string;
    [key: string]: any;
    save: () => Promise<MockObject>;
    delete: () => Promise<void>;
    initialize: () => Promise<void>;
}
/**
 * Mock collection with all CRUD operations
 */
export interface MockCollection {
    list: (options?: any) => Promise<MockObject[]>;
    get: (id: string) => Promise<MockObject | null>;
    create: (data: any) => Promise<MockObject>;
    update: (id: string, data: any) => Promise<MockObject>;
    delete: (id: string) => Promise<void>;
    initialize: () => Promise<void>;
    save: (object: MockObject) => Promise<MockObject>;
}
/**
 * Test data factory for generating consistent mock data
 */
export declare class TestDataFactory {
    private static idCounter;
    static generateId(): string;
    static generateTestUser(overrides?: Partial<MockObject>): MockObject;
    static generateTestProduct(overrides?: Partial<MockObject>): MockObject;
    /**
     * Generate multiple test objects
     */
    static generateMultiple<T extends MockObject>(generator: (overrides?: Partial<T>) => T, count: number, overrides?: Partial<T>): T[];
}
/**
 * Mock collection factory with comprehensive CRUD support
 */
export declare class MockCollectionFactory {
    private storage;
    /**
     * Create a mock collection with realistic behavior
     */
    createMockCollection(objectType?: 'user' | 'product'): MockCollection;
    /**
     * Clear all mock data
     */
    clear(): void;
    /**
     * Get current storage for inspection
     */
    getStorage(): Map<string, MockObject>;
}
/**
 * Complete mock context factory for CLI and API testing
 */
export declare class MockContextFactory {
    private collectionFactory;
    /**
     * Create a comprehensive mock context with database and AI
     */
    createMockContext(overrides?: any): any;
    /**
     * Create mock collections for testing
     */
    createMockCollections(): {
        TestUser: MockCollection;
        TestProduct: MockCollection;
    };
    /**
     * Clear all mock data
     */
    clear(): void;
}
/**
 * Enhanced test setup utilities
 */
export declare class TestSetup {
    private static mockFactory;
    /**
     * Set up complete test environment
     */
    static setupTestEnvironment(): {
        mockContext: any;
        mockCollections: {
            TestUser: MockCollection;
            TestProduct: MockCollection;
        };
        cleanup: () => void;
    };
    /**
     * Mock collection constructor to return mock instances
     */
    static mockCollectionConstructors(mockCollections: any): import('vitest').Mock<(...args: any[]) => any>;
    /**
     * Create realistic database query responses
     */
    static createDatabaseResponses(objectType?: 'user' | 'product'): {
        list: {
            rows: MockObject[];
        };
        get: {
            rows: MockObject[];
        };
        create: {
            rows: MockObject[];
        };
        update: {
            rows: MockObject[];
        };
        delete: {
            rows: never[];
        };
        empty: {
            rows: never[];
        };
    };
}
/**
 * Export commonly used mock instances for convenience
 */
export declare const mockContextFactory: MockContextFactory;
export declare const testDataFactory: typeof TestDataFactory;
export declare const mockCollectionFactory: MockCollectionFactory;
export declare const testSetup: typeof TestSetup;
//# sourceMappingURL=test-utils.d.ts.map