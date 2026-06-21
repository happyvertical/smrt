/**
 * Tests for the framework test-utilities (src/test-utils.ts).
 *
 * These cover the pure mock factories and the ObjectRegistry snapshot/restore
 * helper. They exercise real logic — the mock collection's where/orderBy/
 * pagination engine, the data factories, and a genuine snapshot/restore cycle
 * against the live ObjectRegistry — without mocking any framework internals.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { SmrtObject } from './object.js';
import { ObjectRegistry } from './registry.js';
import {
  MockCollectionFactory,
  MockContextFactory,
  type MockObject,
  mockCollectionFactory,
  mockContextFactory,
  snapshotObjectRegistryState,
  TestDataFactory,
  TestSetup,
  testDataFactory,
  testSetup,
} from './test-utils.js';

describe('TestDataFactory', () => {
  it('generates monotonically increasing unique ids', () => {
    const a = TestDataFactory.generateId();
    const b = TestDataFactory.generateId();
    expect(a).not.toBe(b);
    expect(a.startsWith('test-')).toBe(true);
    expect(b.startsWith('test-')).toBe(true);
  });

  it('builds a test user with lifecycle methods and overridable fields', () => {
    const user = TestDataFactory.generateTestUser({ username: 'custom' });
    expect(user.username).toBe('custom');
    expect(user.email).toContain('@example.com');
    expect(user.active).toBe(true);
    expect(typeof user.save).toBe('function');
    expect(typeof user.delete).toBe('function');
    expect(typeof user.initialize).toBe('function');
  });

  it('builds a test product with default price and overridable fields', () => {
    const product = TestDataFactory.generateTestProduct({ price: 5 });
    expect(product.price).toBe(5);
    expect(product.inStock).toBe(true);
    expect(product.slug).toContain('product-');
  });

  it('generates multiple objects with distinct ids', () => {
    const products = TestDataFactory.generateMultiple<MockObject>(
      TestDataFactory.generateTestProduct,
      4,
    );
    expect(products).toHaveLength(4);
    const ids = new Set(products.map((p) => p.id));
    expect(ids.size).toBe(4);
  });

  it('is also exported as the testDataFactory alias', () => {
    expect(testDataFactory).toBe(TestDataFactory);
  });
});

describe('MockCollectionFactory', () => {
  it('pre-populates a collection with three records and lists them', async () => {
    const factory = new MockCollectionFactory();
    const collection = factory.createMockCollection('user');
    const all = await collection.list();
    expect(all).toHaveLength(3);
  });

  it('applies equality where filters', async () => {
    const factory = new MockCollectionFactory();
    const collection = factory.createMockCollection('user');
    await collection.create({ username: 'needle', age: 99 });
    const found = await collection.list({ where: { username: 'needle' } });
    expect(found).toHaveLength(1);
    expect(found[0].username).toBe('needle');
  });

  it('supports comparison, like, and in operators in where', async () => {
    const factory = new MockCollectionFactory();
    const collection = factory.createMockCollection('product');
    factory.clear();
    await collection.create({ productName: 'Alpha', price: 10 });
    await collection.create({ productName: 'Beta', price: 200 });
    await collection.create({ productName: 'Gamma', price: 300 });

    const expensive = await collection.list({ where: { 'price >': 100 } });
    expect(expensive.every((p) => p.price > 100)).toBe(true);

    const cheap = await collection.list({ where: { 'price <': 100 } });
    expect(cheap.every((p) => p.price < 100)).toBe(true);

    const liked = await collection.list({
      where: { 'productName like': '%lph%' },
    });
    expect(liked.some((p) => p.productName === 'Alpha')).toBe(true);

    const inList = await collection.list({
      where: { 'productName in': ['Beta', 'Gamma'] },
    });
    expect(inList).toHaveLength(2);
  });

  it('orders results ascending and descending', async () => {
    const factory = new MockCollectionFactory();
    const collection = factory.createMockCollection('product');
    factory.clear();
    await collection.create({ productName: 'A', price: 3 });
    await collection.create({ productName: 'B', price: 1 });
    await collection.create({ productName: 'C', price: 2 });

    const asc = await collection.list({ orderBy: 'price ASC' });
    expect(asc.map((p) => p.price)).toEqual([1, 2, 3]);

    const desc = await collection.list({ orderBy: 'price DESC' });
    expect(desc.map((p) => p.price)).toEqual([3, 2, 1]);
  });

  it('paginates with offset and limit', async () => {
    const factory = new MockCollectionFactory();
    const collection = factory.createMockCollection('user');
    factory.clear();
    for (let i = 0; i < 5; i++) {
      await collection.create({ username: `u${i}` });
    }
    const page = await collection.list({ offset: 1, limit: 2 });
    expect(page).toHaveLength(2);
  });

  it('gets by id and returns null for unknown ids', async () => {
    const factory = new MockCollectionFactory();
    const collection = factory.createMockCollection('user');
    const created = await collection.create({ username: 'getme' });
    expect(await collection.get(created.id)).toMatchObject({
      username: 'getme',
    });
    expect(await collection.get('does-not-exist')).toBeNull();
  });

  it('updates an existing record and stamps updated_at', async () => {
    const factory = new MockCollectionFactory();
    const collection = factory.createMockCollection('user');
    const created = await collection.create({ username: 'before' });
    const updated = await collection.update(created.id, { username: 'after' });
    expect(updated.username).toBe('after');
    expect(updated.updated_at).toBeDefined();
  });

  it('throws when updating or deleting a missing record', async () => {
    const factory = new MockCollectionFactory();
    const collection = factory.createMockCollection('user');
    await expect(collection.update('nope', {})).rejects.toThrow(/not found/);
    await expect(collection.delete('nope')).rejects.toThrow(/not found/);
  });

  it('deletes a record so it no longer lists', async () => {
    const factory = new MockCollectionFactory();
    const collection = factory.createMockCollection('user');
    const created = await collection.create({ username: 'goner' });
    await collection.delete(created.id);
    expect(await collection.get(created.id)).toBeNull();
  });

  it('saves an object directly into storage', async () => {
    const factory = new MockCollectionFactory();
    const collection = factory.createMockCollection('user');
    const obj = TestDataFactory.generateTestUser({ id: 'saved-1' });
    await collection.save(obj);
    expect(await collection.get('saved-1')).toMatchObject({ id: 'saved-1' });
  });

  it('exposes a defensive copy of storage and clears it', async () => {
    const factory = new MockCollectionFactory();
    factory.createMockCollection('user');
    const snapshot = factory.getStorage();
    expect(snapshot.size).toBe(3);
    // Mutating the returned copy must not affect internal storage.
    snapshot.clear();
    expect(factory.getStorage().size).toBe(3);
    factory.clear();
    expect(factory.getStorage().size).toBe(0);
  });

  it('exposes a shared mockCollectionFactory singleton', () => {
    expect(mockCollectionFactory).toBeInstanceOf(MockCollectionFactory);
  });
});

describe('MockContextFactory', () => {
  it('creates a context with db/ai/user defaults', () => {
    const factory = new MockContextFactory();
    const ctx = factory.createMockContext();
    expect(ctx.db.type).toBe('sqlite');
    expect(ctx.user.roles).toContain('admin');
    expect(typeof ctx.ai.message).toBe('function');
  });

  it('applies db/ai/user overrides', () => {
    const factory = new MockContextFactory();
    const ctx = factory.createMockContext({
      db: { type: 'postgres' },
      user: { id: 'override-id' },
    });
    expect(ctx.db.type).toBe('postgres');
    expect(ctx.user.id).toBe('override-id');
  });

  it('creates named mock collections and clears them', () => {
    const factory = new MockContextFactory();
    const collections = factory.createMockCollections();
    expect(collections.TestUser).toBeDefined();
    expect(collections.TestProduct).toBeDefined();
    // Should not throw.
    factory.clear();
  });

  it('exposes a shared mockContextFactory singleton', () => {
    expect(mockContextFactory).toBeInstanceOf(MockContextFactory);
  });
});

describe('TestSetup', () => {
  it('sets up a full test environment and forces NODE_ENV=test', () => {
    const env = TestSetup.setupTestEnvironment();
    expect(process.env.NODE_ENV).toBe('test');
    expect(env.mockContext).toBeDefined();
    expect(env.mockCollections.TestUser).toBeDefined();
    expect(typeof env.cleanup).toBe('function');
    env.cleanup();
  });

  it('builds a constructor mock that returns a configured collection', () => {
    const collections = new MockContextFactory().createMockCollections();
    const Ctor = TestSetup.mockCollectionConstructors(collections);
    const instance = Ctor({ tenantId: 't1' });
    expect(instance).toBeDefined();
    // Options were merged into the returned mock collection.
    expect((instance as any).tenantId).toBe('t1');
  });

  it('creates realistic database query responses for users and products', () => {
    const userResponses = TestSetup.createDatabaseResponses('user');
    expect(userResponses.list.rows).toHaveLength(3);
    expect(userResponses.get.rows).toHaveLength(1);
    expect(userResponses.empty.rows).toHaveLength(0);

    const productResponses = TestSetup.createDatabaseResponses('product');
    expect(productResponses.create.rows[0].slug).toContain('product-');
  });

  it('is exported as the testSetup alias', () => {
    expect(testSetup).toBe(TestSetup);
  });
});

describe('snapshotObjectRegistryState', () => {
  // Always restore the registry after each test so we never leak a fixture
  // class into sibling suites.
  let restore: (() => void) | undefined;

  afterEach(() => {
    if (restore) {
      restore();
      restore = undefined;
    }
  });

  it('restores the registry to its captured state after mutation', () => {
    restore = snapshotObjectRegistryState();

    class SnapshotProbe extends SmrtObject {
      label = '';
    }
    ObjectRegistry.register(SnapshotProbe, { name: 'SnapshotProbe' });
    expect(ObjectRegistry.getClass('SnapshotProbe')).toBeDefined();

    // Restore should remove the class registered after the snapshot.
    restore();
    restore = undefined;
    expect(ObjectRegistry.getClass('SnapshotProbe')).toBeUndefined();
  });

  it('returns an independent restore function each call', () => {
    const first = snapshotObjectRegistryState();
    const second = snapshotObjectRegistryState();
    expect(first).not.toBe(second);
    // Calling both restores is harmless (idempotent enough for cleanup).
    first();
    second();
  });
});
