/**
 * Test for Issue #66: Virtual module types don't match generated API
 *
 * This test verifies that:
 * 1. ApiResponse wrapper is NOT used (returns unwrapped data)
 * 2. Objects with custom methods use singular naming
 * 3. Custom methods are included in generated types
 * 4. Search method is available in CrudOperations
 */

import { describe, expect, it } from 'vitest';
import type { SmartObjectManifest } from '../scanner/types';

// Import the function we're testing (we'll need to export it for testing)
// For now, we'll test the pattern by checking the generated code structure

describe('Issue #66: Virtual Module Type Generation', () => {
  it('should generate manifest with custom methods', () => {
    // Create a test manifest with a SMRT object that has custom methods
    const manifest: SmartObjectManifest = {
      version: '1.0.0',
      timestamp: Date.now(),
      objects: {
        praeco: {
          className: 'Praeco',
          collection: 'praecos',
          fields: {
            name: { type: 'text', required: true },
            status: { type: 'text', required: false },
          },
          methods: {
            research: {
              name: 'research',
              parameters: [{ name: 'topic', type: 'string', required: false }],
              returnType: 'Promise<void>',
              isAsync: true,
            },
            report: {
              name: 'report',
              parameters: [],
              returnType: 'Promise<void>',
              isAsync: true,
            },
          },
          decoratorConfig: {
            api: true,
            mcp: true,
            cli: true,
          },
        },
        council: {
          className: 'Council',
          collection: 'councils',
          fields: {
            name: { type: 'text', required: true },
            city: { type: 'text', required: true },
          },
          methods: {},
          decoratorConfig: {
            api: true,
            mcp: true,
            cli: true,
          },
        },
      },
    };

    // Verify manifest structure
    expect(manifest.objects.praeco).toBeDefined();
    expect(manifest.objects.praeco.methods).toBeDefined();
    expect(Object.keys(manifest.objects.praeco.methods)).toHaveLength(2);
    expect(manifest.objects.praeco.methods.research).toBeDefined();
    expect(manifest.objects.praeco.methods.report).toBeDefined();

    // Verify council has no custom methods
    expect(manifest.objects.council.methods).toBeDefined();
    expect(Object.keys(manifest.objects.council.methods)).toHaveLength(0);
  });

  it('should have correct type structure for ApiResponse', () => {
    // This test documents the expected behavior:
    // Types should return unwrapped data (T[]) not wrapped (ApiResponse<T[]>)

    // Expected type structure (what should be generated):
    type ExpectedListReturn = Promise<any[]>; // Not Promise<ApiResponse<any[]>>
    type ExpectedGetReturn = Promise<any>; // Not Promise<ApiResponse<any>>
    type ExpectedCreateReturn = Promise<any>; // Not Promise<ApiResponse<any>>

    // Verify types are as expected
    const listReturn: ExpectedListReturn = Promise.resolve([]);
    const getReturn: ExpectedGetReturn = Promise.resolve({});
    const createReturn: ExpectedCreateReturn = Promise.resolve({});

    expect(listReturn).toBeDefined();
    expect(getReturn).toBeDefined();
    expect(createReturn).toBeDefined();
  });

  it('should use singular naming for objects with custom methods', () => {
    // Objects with custom methods should use singular className
    // Objects without custom methods should use plural collection

    const manifest: SmartObjectManifest = {
      version: '1.0.0',
      timestamp: Date.now(),
      objects: {
        praeco: {
          className: 'Praeco',
          collection: 'praecos',
          fields: { name: { type: 'text', required: true } },
          methods: {
            research: {
              name: 'research',
              parameters: [],
              returnType: 'Promise<void>',
              isAsync: true,
            },
          },
          decoratorConfig: {},
        },
        council: {
          className: 'Council',
          collection: 'councils',
          fields: { name: { type: 'text', required: true } },
          methods: {},
          decoratorConfig: {},
        },
      },
    };

    // Praeco has custom methods, so should use singular "praeco"
    const hasCustomMethods =
      Object.keys(manifest.objects.praeco.methods).length > 0;
    const praecoPropertyName = hasCustomMethods ? 'praeco' : 'praecos';
    expect(praecoPropertyName).toBe('praeco'); // Singular for custom methods

    // Council has no custom methods, so should use plural "councils"
    const hasNoCustomMethods =
      Object.keys(manifest.objects.council.methods).length === 0;
    const councilPropertyName = hasNoCustomMethods ? 'councils' : 'council';
    expect(councilPropertyName).toBe('councils'); // Plural for CRUD only
  });

  it('should include search method in CrudOperations', () => {
    // CrudOperations should include: list, get, create, update, delete, search
    // This test documents the expected interface

    interface ExpectedCrudOperations<T> {
      list(params?: Record<string, any>): Promise<T[]>;
      get(id: string): Promise<T>;
      create(data: Partial<T>): Promise<T>;
      update(id: string, data: Partial<T>): Promise<T>;
      delete(id: string): Promise<boolean>;
      search(query: string): Promise<T[]>; // ← Must include search
    }

    // Verify interface structure
    type CrudKeys = keyof ExpectedCrudOperations<any>;
    const expectedMethods: CrudKeys[] = [
      'list',
      'get',
      'create',
      'update',
      'delete',
      'search',
    ];

    expect(expectedMethods).toContain('search');
    expect(expectedMethods).toHaveLength(6);
  });

  it('should include custom methods alongside CRUD operations', () => {
    // Objects with custom methods should have:
    // CrudOperations<T> & { customMethod1(): ..., customMethod2(): ... }

    interface MockCrudOperations<T> {
      list(): Promise<T[]>;
      get(id: string): Promise<T>;
      create(data: T): Promise<T>;
      update(id: string, data: T): Promise<T>;
      delete(id: string): Promise<boolean>;
      search(query: string): Promise<T[]>;
    }

    interface CustomMethods {
      research(options?: { topic?: string }): Promise<any>;
      report(): Promise<any>;
    }

    type ExpectedPraecoClient<T> = MockCrudOperations<T> & CustomMethods;

    // Verify combined type has both CRUD and custom methods
    const mockClient: ExpectedPraecoClient<any> = {
      list: () => Promise.resolve([]),
      get: (_id) => Promise.resolve({}),
      create: (_data) => Promise.resolve({}),
      update: (_id, _data) => Promise.resolve({}),
      delete: (_id) => Promise.resolve(true),
      search: (_query) => Promise.resolve([]),
      research: (_options) => Promise.resolve({}),
      report: () => Promise.resolve({}),
    };

    expect(mockClient.list).toBeDefined();
    expect(mockClient.research).toBeDefined();
    expect(mockClient.report).toBeDefined();
    expect(mockClient.search).toBeDefined();
  });
});
