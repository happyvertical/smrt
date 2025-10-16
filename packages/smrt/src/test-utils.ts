/**
 * Comprehensive test utilities for SMRT framework testing
 *
 * Provides unified mocking for collections, objects, and database operations
 * to support both CLI and API generator testing scenarios.
 */

import { vi } from 'vitest';

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
export class TestDataFactory {
  private static idCounter = 1;

  static generateId(): string {
    return `test-${TestDataFactory.idCounter++}`;
  }

  static generateTestUser(overrides: Partial<MockObject> = {}): MockObject {
    const id = TestDataFactory.generateId();
    return {
      id,
      slug: `user-${id}`,
      username: `testuser${id}`,
      email: `test${id}@example.com`,
      age: 25,
      active: true,
      created_at: '2023-01-01T00:00:00Z',
      updated_at: '2023-01-01T00:00:00Z',
      ...overrides,
      save: vi.fn().mockResolvedValue(TestDataFactory),
      delete: vi.fn().mockResolvedValue(undefined),
      initialize: vi.fn().mockResolvedValue(undefined),
    };
  }

  static generateTestProduct(overrides: Partial<MockObject> = {}): MockObject {
    const id = TestDataFactory.generateId();
    return {
      id,
      slug: `product-${id}`,
      productName: `Test Product ${id}`,
      price: 99.99,
      inStock: true,
      created_at: '2023-01-01T00:00:00Z',
      updated_at: '2023-01-01T00:00:00Z',
      ...overrides,
      save: vi.fn().mockResolvedValue(TestDataFactory),
      delete: vi.fn().mockResolvedValue(undefined),
      initialize: vi.fn().mockResolvedValue(undefined),
    };
  }

  /**
   * Generate multiple test objects
   */
  static generateMultiple<T extends MockObject>(
    generator: (overrides?: Partial<T>) => T,
    count: number,
    overrides: Partial<T> = {},
  ): T[] {
    return Array.from({ length: count }, (_, _i) =>
      generator({
        ...overrides,
        id: TestDataFactory.generateId(),
      }),
    );
  }
}

/**
 * Mock collection factory with comprehensive CRUD support
 */
export class MockCollectionFactory {
  private storage = new Map<string, MockObject>();

  /**
   * Create a mock collection with realistic behavior
   */
  createMockCollection(
    objectType: 'user' | 'product' = 'user',
  ): MockCollection {
    const generator =
      objectType === 'user'
        ? TestDataFactory.generateTestUser
        : TestDataFactory.generateTestProduct;

    // Pre-populate with some test data
    for (let i = 0; i < 3; i++) {
      const obj = generator();
      this.storage.set(obj.id, obj);
    }

    return {
      list: vi.fn().mockImplementation(async (options: any = {}) => {
        let results = Array.from(this.storage.values());

        // Apply where filters
        if (options.where) {
          results = results.filter((obj) => {
            return Object.entries(options.where).every(
              ([key, value]: [string, any]) => {
                if (key.includes(' >')) {
                  const field = key.replace(' >', '');
                  return obj[field] > (value as number);
                }
                if (key.includes(' <')) {
                  const field = key.replace(' <', '');
                  return obj[field] < (value as number);
                }
                if (key.includes(' >=')) {
                  const field = key.replace(' >=', '');
                  return obj[field] >= (value as number);
                }
                if (key.includes(' like')) {
                  const field = key.replace(' like', '');
                  return obj[field]
                    ?.toString()
                    .includes((value as string).replace(/%/g, ''));
                }
                if (key.includes(' in')) {
                  const field = key.replace(' in', '');
                  return (
                    Array.isArray(value) &&
                    (value as any[]).includes(obj[field])
                  );
                }
                return obj[key] === value;
              },
            );
          });
        }

        // Apply ordering
        if (options.orderBy) {
          const [field, direction] = options.orderBy.split(' ');
          results.sort((a, b) => {
            const comparison = a[field] > b[field] ? 1 : -1;
            return direction === 'DESC' ? -comparison : comparison;
          });
        }

        // Apply pagination
        const offset = options.offset || 0;
        const limit = options.limit || 50;
        results = results.slice(offset, offset + limit);

        return results;
      }),

      get: vi.fn().mockImplementation(async (id: string) => {
        return this.storage.get(id) || null;
      }),

      create: vi.fn().mockImplementation(async (data: any) => {
        const obj = generator({ ...data, id: TestDataFactory.generateId() });
        this.storage.set(obj.id, obj);
        return obj;
      }),

      update: vi.fn().mockImplementation(async (id: string, data: any) => {
        const existing = this.storage.get(id);
        if (!existing) {
          throw new Error(`Object with id ${id} not found`);
        }
        const updated = {
          ...existing,
          ...data,
          updated_at: new Date().toISOString(),
        };
        this.storage.set(id, updated);
        return updated;
      }),

      delete: vi.fn().mockImplementation(async (id: string) => {
        const deleted = this.storage.delete(id);
        if (!deleted) {
          throw new Error(`Object with id ${id} not found`);
        }
      }),

      initialize: vi.fn().mockResolvedValue(undefined),

      save: vi.fn().mockImplementation(async (object: MockObject) => {
        this.storage.set(object.id, object);
        return object;
      }),
    };
  }

  /**
   * Clear all mock data
   */
  clear(): void {
    this.storage.clear();
  }

  /**
   * Get current storage for inspection
   */
  getStorage(): Map<string, MockObject> {
    return new Map(this.storage);
  }
}

/**
 * Complete mock context factory for CLI and API testing
 */
export class MockContextFactory {
  private collectionFactory = new MockCollectionFactory();

  /**
   * Create a comprehensive mock context with database and AI
   */
  createMockContext(overrides: any = {}) {
    return {
      db: {
        query: vi.fn().mockResolvedValue({ rows: [] }),
        close: vi.fn().mockResolvedValue(undefined),
        type: 'sqlite',
        database: ':memory:',
        ...overrides.db,
      },
      ai: {
        message: vi.fn().mockResolvedValue('AI response'),
        ...overrides.ai,
      },
      user: {
        id: 'test-user-123',
        username: 'testuser',
        roles: ['admin'],
        ...overrides.user,
      },
      ...overrides,
    };
  }

  /**
   * Create mock collections for testing
   */
  createMockCollections() {
    return {
      TestUser: this.collectionFactory.createMockCollection('user'),
      TestProduct: this.collectionFactory.createMockCollection('product'),
    };
  }

  /**
   * Clear all mock data
   */
  clear(): void {
    this.collectionFactory.clear();
  }
}

/**
 * Enhanced test setup utilities
 */
export class TestSetup {
  private static mockFactory = new MockContextFactory();

  /**
   * Set up complete test environment
   */
  static setupTestEnvironment() {
    // Ensure test environment
    process.env.NODE_ENV = 'test';

    return {
      mockContext: TestSetup.mockFactory.createMockContext(),
      mockCollections: TestSetup.mockFactory.createMockCollections(),
      cleanup: () => TestSetup.mockFactory.clear(),
    };
  }

  /**
   * Mock collection constructor to return mock instances
   */
  static mockCollectionConstructors(mockCollections: any) {
    return vi.fn().mockImplementation((options: any) => {
      const mockCollection =
        mockCollections.TestUser || mockCollections.TestProduct;
      // Add context options to mock if needed
      if (options) {
        Object.assign(mockCollection, options);
      }
      return mockCollection;
    });
  }

  /**
   * Create realistic database query responses
   */
  static createDatabaseResponses(objectType: 'user' | 'product' = 'user') {
    const generator =
      objectType === 'user'
        ? TestDataFactory.generateTestUser
        : TestDataFactory.generateTestProduct;

    return {
      list: { rows: TestDataFactory.generateMultiple(generator, 3) },
      get: { rows: [generator()] },
      create: { rows: [generator()] },
      update: { rows: [generator()] },
      delete: { rows: [] },
      empty: { rows: [] },
    };
  }
}

/**
 * Export commonly used mock instances for convenience
 */
export const mockContextFactory = new MockContextFactory();
export const testDataFactory = TestDataFactory;
export const mockCollectionFactory = new MockCollectionFactory();
export const testSetup = TestSetup;
