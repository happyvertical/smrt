/**
 * Tests for GlobalInterceptors system
 *
 * @see https://github.com/happyvertical/smrt/issues/675
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SmrtCollection } from '../collection';
import {
  type CollectionInterceptor,
  createInterceptorContext,
  GlobalInterceptors,
  type ListOptions,
} from '../interceptors';
import { SmrtObject } from '../object';
import { smrt } from '../registry';
import { getTestDatabase } from '../testing/database';

// Test classes
@smrt()
class TestProduct extends SmrtObject {
  name: string = '';
  price: number = 0.0;
  tenantId: string = '';
}

class TestProductCollection extends SmrtCollection<TestProduct> {
  static readonly _itemClass = TestProduct;
}

describe('GlobalInterceptors', () => {
  beforeEach(() => {
    // Clear interceptors before each test
    GlobalInterceptors.clear();
  });

  afterEach(() => {
    GlobalInterceptors.clear();
  });

  describe('registration', () => {
    it('should register an interceptor', () => {
      const interceptor: CollectionInterceptor = {
        name: 'test',
        beforeList: vi.fn(),
      };

      GlobalInterceptors.register(interceptor);

      expect(GlobalInterceptors.hasInterceptors()).toBe(true);
      expect(GlobalInterceptors.getAll()).toHaveLength(1);
      expect(GlobalInterceptors.getAll()[0]).toBe(interceptor);
    });

    it('should replace interceptor with same name', () => {
      const interceptor1: CollectionInterceptor = {
        name: 'test',
        beforeList: vi.fn(),
      };
      const interceptor2: CollectionInterceptor = {
        name: 'test',
        afterList: vi.fn(),
      };

      GlobalInterceptors.register(interceptor1);
      GlobalInterceptors.register(interceptor2);

      expect(GlobalInterceptors.getAll()).toHaveLength(1);
      expect(GlobalInterceptors.getAll()[0]).toBe(interceptor2);
    });

    it('should unregister interceptor by name', () => {
      const interceptor: CollectionInterceptor = {
        name: 'test',
        beforeList: vi.fn(),
      };

      GlobalInterceptors.register(interceptor);
      expect(GlobalInterceptors.hasInterceptors()).toBe(true);

      const removed = GlobalInterceptors.unregister('test');
      expect(removed).toBe(true);
      expect(GlobalInterceptors.hasInterceptors()).toBe(false);
    });

    it('should unregister interceptor by reference', () => {
      const interceptor: CollectionInterceptor = {
        beforeList: vi.fn(),
      };

      GlobalInterceptors.register(interceptor);
      expect(GlobalInterceptors.hasInterceptors()).toBe(true);

      const removed = GlobalInterceptors.unregister(interceptor);
      expect(removed).toBe(true);
      expect(GlobalInterceptors.hasInterceptors()).toBe(false);
    });

    it('should return false when unregistering non-existent interceptor', () => {
      const removed = GlobalInterceptors.unregister('non-existent');
      expect(removed).toBe(false);
    });

    it('should sort interceptors by priority (higher first)', () => {
      const low: CollectionInterceptor = { name: 'low', priority: 1 };
      const high: CollectionInterceptor = { name: 'high', priority: 100 };
      const medium: CollectionInterceptor = { name: 'medium', priority: 50 };

      GlobalInterceptors.register(low);
      GlobalInterceptors.register(medium);
      GlobalInterceptors.register(high);

      const all = GlobalInterceptors.getAll();
      expect(all[0].name).toBe('high');
      expect(all[1].name).toBe('medium');
      expect(all[2].name).toBe('low');
    });
  });

  describe('executeBeforeList', () => {
    it('should execute beforeList interceptors in priority order', async () => {
      const callOrder: string[] = [];

      GlobalInterceptors.register({
        name: 'first',
        priority: 100,
        beforeList(className, options) {
          callOrder.push('first');
          return { ...options, where: { ...options.where, first: true } };
        },
      });

      GlobalInterceptors.register({
        name: 'second',
        priority: 50,
        beforeList(className, options) {
          callOrder.push('second');
          return { ...options, where: { ...options.where, second: true } };
        },
      });

      const context = createInterceptorContext('TestProduct', 'list');
      const options: ListOptions = { where: { status: 'active' } };

      const result = await GlobalInterceptors.executeBeforeList(
        'TestProduct',
        options,
        context,
      );

      expect(callOrder).toEqual(['first', 'second']);
      expect(result.where).toEqual({
        status: 'active',
        first: true,
        second: true,
      });
    });

    it('should pass through unchanged if interceptor returns void', async () => {
      GlobalInterceptors.register({
        name: 'logging',
        beforeList(className, options) {
          // Just log, don't modify
          console.log(`Listing ${className}`);
        },
      });

      const context = createInterceptorContext('TestProduct', 'list');
      const options: ListOptions = { where: { status: 'active' } };

      const result = await GlobalInterceptors.executeBeforeList(
        'TestProduct',
        options,
        context,
      );

      expect(result).toEqual(options);
    });

    it('should handle async interceptors', async () => {
      GlobalInterceptors.register({
        name: 'async-interceptor',
        async beforeList(className, options) {
          // Simulate async operation
          await new Promise((resolve) => setTimeout(resolve, 10));
          return { ...options, where: { ...options.where, async: true } };
        },
      });

      const context = createInterceptorContext('TestProduct', 'list');
      const options: ListOptions = { where: {} };

      const result = await GlobalInterceptors.executeBeforeList(
        'TestProduct',
        options,
        context,
      );

      expect(result.where).toEqual({ async: true });
    });
  });

  describe('executeAfterList', () => {
    it('should execute afterList interceptors on results', async () => {
      GlobalInterceptors.register({
        name: 'filter',
        afterList(className, results) {
          // Filter out items with empty names
          return results.filter((item: any) => item.name !== '');
        },
      });

      const context = createInterceptorContext('TestProduct', 'list');
      const mockResults = [
        { id: '1', name: 'Product 1' },
        { id: '2', name: '' },
        { id: '3', name: 'Product 3' },
      ] as any[];

      const result = await GlobalInterceptors.executeAfterList(
        'TestProduct',
        mockResults,
        context,
      );

      expect(result).toHaveLength(2);
      expect(result.map((r: any) => r.name)).toEqual([
        'Product 1',
        'Product 3',
      ]);
    });
  });

  describe('executeBeforeGet', () => {
    it('should transform filter in beforeGet', async () => {
      GlobalInterceptors.register({
        name: 'tenant-filter',
        beforeGet(className, filter, context) {
          if (typeof filter === 'object') {
            return { ...filter, tenantId: 'tenant-123' };
          }
          return filter;
        },
      });

      const context = createInterceptorContext('TestProduct', 'get');

      const result = await GlobalInterceptors.executeBeforeGet(
        'TestProduct',
        { id: 'product-1' },
        context,
      );

      expect(result).toEqual({ id: 'product-1', tenantId: 'tenant-123' });
    });

    it('should pass through string filters', async () => {
      GlobalInterceptors.register({
        name: 'logging',
        beforeGet(className, filter) {
          // Just log, return void to pass through
        },
      });

      const context = createInterceptorContext('TestProduct', 'get');

      const result = await GlobalInterceptors.executeBeforeGet(
        'TestProduct',
        'product-slug',
        context,
      );

      expect(result).toBe('product-slug');
    });
  });

  describe('executeAfterGet', () => {
    it('should allow modifying result in afterGet', async () => {
      GlobalInterceptors.register({
        name: 'enrich',
        afterGet(className, instance) {
          if (instance) {
            (instance as any).enriched = true;
          }
          return instance;
        },
      });

      const context = createInterceptorContext('TestProduct', 'get');
      const mockInstance = { id: '1', name: 'Test' } as any;

      const result = await GlobalInterceptors.executeAfterGet(
        'TestProduct',
        mockInstance,
        context,
      );

      expect((result as any).enriched).toBe(true);
    });

    it('should handle null results', async () => {
      GlobalInterceptors.register({
        name: 'logger',
        afterGet(className, instance) {
          if (!instance) {
            console.log(`${className} not found`);
          }
        },
      });

      const context = createInterceptorContext('TestProduct', 'get');

      const result = await GlobalInterceptors.executeAfterGet(
        'TestProduct',
        null,
        context,
      );

      expect(result).toBeNull();
    });
  });

  describe('executeBeforeQuery', () => {
    it('should allow modifying SQL in beforeQuery', async () => {
      GlobalInterceptors.register({
        name: 'tenant-sql',
        beforeQuery(className, options) {
          // Add tenant filter to WHERE clause
          const tenantWhere = 'tenant_id = $999';
          const sql = options.sql.includes('WHERE')
            ? options.sql.replace('WHERE', `WHERE ${tenantWhere} AND`)
            : `${options.sql} WHERE ${tenantWhere}`;

          return {
            sql,
            params: [...options.params, 'tenant-123'],
          };
        },
      });

      const context = createInterceptorContext('TestProduct', 'query');

      const result = await GlobalInterceptors.executeBeforeQuery(
        'TestProduct',
        {
          sql: 'SELECT * FROM products WHERE status = $1',
          params: ['active'],
        },
        context,
      );

      expect(result.sql).toContain('tenant_id = $999');
      expect(result.params).toContain('tenant-123');
    });

    it('should throw error to block query', async () => {
      GlobalInterceptors.register({
        name: 'block-raw-sql',
        beforeQuery(className, options) {
          if (!options.allowRawOnTenantScoped) {
            throw new Error('Raw SQL not allowed on tenant-scoped classes');
          }
          return { sql: options.sql, params: options.params };
        },
      });

      const context = createInterceptorContext('TestProduct', 'query');

      await expect(
        GlobalInterceptors.executeBeforeQuery(
          'TestProduct',
          { sql: 'SELECT * FROM products', params: [] },
          context,
        ),
      ).rejects.toThrow('Raw SQL not allowed');
    });
  });

  describe('executeBeforeSave', () => {
    it('should allow modifying instance before save', async () => {
      GlobalInterceptors.register({
        name: 'auto-tenant',
        beforeSave(instance) {
          if (!(instance as any).tenantId) {
            (instance as any).tenantId = 'default-tenant';
          }
        },
      });

      const context = createInterceptorContext('TestProduct', 'save');
      const mockInstance = { id: '1', name: 'Test' } as any;

      await GlobalInterceptors.executeBeforeSave(mockInstance, context);

      expect(mockInstance.tenantId).toBe('default-tenant');
    });

    it('should throw to prevent save', async () => {
      GlobalInterceptors.register({
        name: 'validate-tenant',
        beforeSave(instance) {
          if (!(instance as any).tenantId) {
            throw new Error('tenantId is required');
          }
        },
      });

      const context = createInterceptorContext('TestProduct', 'save');
      const mockInstance = { id: '1', name: 'Test' } as any;

      await expect(
        GlobalInterceptors.executeBeforeSave(mockInstance, context),
      ).rejects.toThrow('tenantId is required');
    });
  });

  describe('executeBeforeDelete', () => {
    it('should throw to prevent delete', async () => {
      GlobalInterceptors.register({
        name: 'prevent-cross-tenant',
        beforeDelete(instance, context) {
          const currentTenant = 'tenant-1';
          if ((instance as any).tenantId !== currentTenant) {
            throw new Error('Cannot delete object from different tenant');
          }
        },
      });

      const context = createInterceptorContext('TestProduct', 'delete');
      const mockInstance = { id: '1', tenantId: 'tenant-2' } as any;

      await expect(
        GlobalInterceptors.executeBeforeDelete(mockInstance, context),
      ).rejects.toThrow('Cannot delete object from different tenant');
    });
  });

  describe('createInterceptorContext', () => {
    it('should create context with all fields', () => {
      const context = createInterceptorContext(
        'TestProduct',
        'list',
        'TestProductCollection',
        { tenantId: '123' },
      );

      expect(context.className).toBe('TestProduct');
      expect(context.operation).toBe('list');
      expect(context.collectionName).toBe('TestProductCollection');
      expect(context.metadata).toEqual({ tenantId: '123' });
      expect(context.timestamp).toBeInstanceOf(Date);
    });
  });

  describe('globalThis state sharing', () => {
    it('should share state across imports', () => {
      // Register from this file
      GlobalInterceptors.register({ name: 'test-1' });

      // The global state should be accessible
      expect(globalThis.__smrtInterceptors).toBeDefined();
      expect(globalThis.__smrtInterceptors).toHaveLength(1);
    });
  });
});

describe('Interceptor integration with Collection and Object', () => {
  let collection: TestProductCollection;
  let interceptorCalls: string[];

  beforeEach(async () => {
    GlobalInterceptors.clear();
    interceptorCalls = [];

    // Create collection with in-memory database using getTestDatabase helper
    // which properly sets up schemas for registered SMRT classes
    const db = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      classes: ['TestProduct'],
    });
    collection = await TestProductCollection.create({ db });
  });

  afterEach(() => {
    GlobalInterceptors.clear();
  });

  it('should call interceptors during list()', async () => {
    GlobalInterceptors.register({
      name: 'track-calls',
      beforeList(className, options, context) {
        interceptorCalls.push(`beforeList:${className}`);
        return options;
      },
      afterList(className, results, context) {
        interceptorCalls.push(`afterList:${className}`);
        return results;
      },
    });

    await collection.list({ where: {} });

    expect(interceptorCalls).toContain('beforeList:TestProduct');
    expect(interceptorCalls).toContain('afterList:TestProduct');
  });

  it('should call interceptors during get()', async () => {
    // Create a product first
    const product = await collection.create({ name: 'Test', price: 9.99 });
    await product.save();

    GlobalInterceptors.register({
      name: 'track-calls',
      beforeGet(className, filter, context) {
        interceptorCalls.push(`beforeGet:${className}`);
        return filter;
      },
      afterGet(className, instance, context) {
        interceptorCalls.push(`afterGet:${className}`);
        return instance;
      },
    });

    await collection.get(product.id as string);

    expect(interceptorCalls).toContain('beforeGet:TestProduct');
    expect(interceptorCalls).toContain('afterGet:TestProduct');
  });

  it('should call interceptors during save()', async () => {
    GlobalInterceptors.register({
      name: 'track-calls',
      beforeSave(instance, context) {
        interceptorCalls.push(`beforeSave:${instance.constructor.name}`);
      },
      afterSave(instance, context) {
        interceptorCalls.push(`afterSave:${instance.constructor.name}`);
      },
    });

    const product = await collection.create({ name: 'Test', price: 9.99 });
    await product.save();

    expect(interceptorCalls).toContain('beforeSave:TestProduct');
    expect(interceptorCalls).toContain('afterSave:TestProduct');
  });

  it('should call interceptors during delete()', async () => {
    // Create a product first
    const product = await collection.create({ name: 'Test', price: 9.99 });
    await product.save();

    GlobalInterceptors.register({
      name: 'track-calls',
      beforeDelete(instance, context) {
        interceptorCalls.push(`beforeDelete:${instance.constructor.name}`);
      },
      afterDelete(instance, context) {
        interceptorCalls.push(`afterDelete:${instance.constructor.name}`);
      },
    });

    await product.delete();

    expect(interceptorCalls).toContain('beforeDelete:TestProduct');
    expect(interceptorCalls).toContain('afterDelete:TestProduct');
  });

  it('should allow interceptor to add tenant filter to list()', async () => {
    // Create products for different tenants
    const p1 = await collection.create({
      name: 'Product 1',
      tenantId: 'tenant-1',
    });
    await p1.save();
    const p2 = await collection.create({
      name: 'Product 2',
      tenantId: 'tenant-2',
    });
    await p2.save();

    // Register tenant filtering interceptor
    GlobalInterceptors.register({
      name: 'tenant-filter',
      beforeList(className, options) {
        return {
          ...options,
          where: { ...options.where, tenantId: 'tenant-1' },
        };
      },
    });

    const results = await collection.list({ where: {} });

    // Should only return tenant-1's products
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('Product 1');
  });

  it('should allow interceptor to block save with validation error', async () => {
    // First create a product without the interceptor
    const product = await collection.create({ name: 'Test', price: 9.99 });

    // Now register interceptor that requires tenantId
    GlobalInterceptors.register({
      name: 'require-tenant',
      beforeSave(instance) {
        if (!(instance as any).tenantId) {
          throw new Error('tenantId is required for all products');
        }
      },
    });

    // Update the product and try to save - should fail
    // The error is wrapped by RuntimeError.operationFailed, so check the cause
    product.name = 'Updated';
    try {
      await product.save();
      expect.fail('Expected save to throw');
    } catch (error: any) {
      // The wrapped error should have the original message in its cause
      expect(error.cause?.message || error.message).toContain(
        'tenantId is required',
      );
    }
  });
});
