/**
 * Performance benchmark tests for SMRT framework
 *
 * Tests the framework's performance with large datasets and
 * ensures it meets production-ready performance standards.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { faker } from '@faker-js/faker';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SmrtCollection } from './collection';
import { SmrtObject } from './object';

// Performance test objects
class PerfTestUser extends SmrtObject {
  static tableName = 'perf_test_users';

  declare username?: string;
  declare email?: string;
  declare age?: number;
  declare active?: boolean;
  declare createdAt?: Date;
  declare lastLogin?: Date;
  declare profileData?: string;

  constructor(options: any = {}) {
    super({
      ai: { type: 'openai', apiKey: 'test-key' },
      db: { url: getTestDbUrl() },
      ...options,
    });
    // Remove Object.assign - let SmrtObject handle property assignment
  }

  static async create(options: any): Promise<PerfTestUser> {
    const user = new PerfTestUser(options);
    await user.initialize();
    return user;
  }
}

class PerfTestUsers extends SmrtCollection<PerfTestUser> {
  static readonly _itemClass = PerfTestUser;

  constructor(options: any = {}) {
    super({
      ai: { type: 'openai', apiKey: 'test-key' },
      db: { url: getTestDbUrl() },
      ...options,
    });
  }

  static async create(options: any): Promise<PerfTestUsers> {
    const collection = new PerfTestUsers(options);
    await collection.initialize();
    return collection;
  }
}

// Utility functions
const TMP_DIR = path.resolve(`${os.tmpdir()}/.have-sdk-perf-tests`);
fs.mkdirSync(TMP_DIR, { recursive: true });

function getTestDbUrl(): string {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(7);
  return `file:${TMP_DIR}/perf-test-${timestamp}-${random}.db`;
}

function generateLargeText(size: number): string {
  let text = '';
  while (text.length < size) {
    text += `${faker.lorem.paragraphs(10)}\n`;
  }
  return text.substring(0, size);
}

async function measureTime<T>(
  operation: () => Promise<T>,
): Promise<{ result: T; duration: number }> {
  const start = performance.now();
  const result = await operation();
  const duration = performance.now() - start;
  return { result, duration };
}

function generateTestUser(overrides: any = {}): any {
  return {
    username: faker.person.fullName(),
    email: faker.internet.email(),
    age: faker.number.int({ min: 18, max: 80 }),
    active: faker.datatype.boolean(),
    createdAt: faker.date.past(),
    lastLogin: faker.date.recent(),
    profileData: generateLargeText(1000), // 1KB of profile data
    ...overrides,
  };
}

describe.skip('Performance Benchmarks', () => {
  let collection: PerfTestUsers;

  beforeEach(async () => {
    collection = await PerfTestUsers.create({});
  });

  afterEach(async () => {
    // Clean up resources - database connections are managed automatically
    if (collection?.db) {
      // Note: DatabaseInterface doesn't have a close() method
      // Connections are managed by the underlying client
    }
  });

  describe('Object Creation Performance', () => {
    it('should create single object in under 100ms', async () => {
      const userData = generateTestUser();

      const { duration } = await measureTime(async () => {
        return await collection.create(userData);
      });

      expect(duration).toBeLessThan(100);
    });

    it('should create 100 objects in under 5 seconds', async () => {
      const users = Array.from({ length: 100 }, () => generateTestUser());

      const { duration } = await measureTime(async () => {
        for (const userData of users) {
          await collection.create(userData);
        }
      });

      expect(duration).toBeLessThan(5000);
      console.log(
        `Created 100 objects in ${duration.toFixed(2)}ms (${(duration / 100).toFixed(2)}ms per object)`,
      );
    });

    it('should handle bulk creation efficiently', async () => {
      const users = Array.from({ length: 50 }, () => generateTestUser());

      const { duration } = await measureTime(async () => {
        // Create all users concurrently (limited concurrency)
        const batches = [];
        for (let i = 0; i < users.length; i += 10) {
          const batch = users.slice(i, i + 10);
          batches.push(
            Promise.all(batch.map((userData) => collection.create(userData))),
          );
        }
        await Promise.all(batches);
      });

      expect(duration).toBeLessThan(3000);
      console.log(`Bulk created 50 objects in ${duration.toFixed(2)}ms`);
    });
  });

  describe('Query Performance', () => {
    beforeEach(async () => {
      // Pre-populate with test data
      const users = Array.from({ length: 200 }, (_, i) =>
        generateTestUser({
          email: `user${i}@example.com`,
          age: 20 + (i % 60), // Ages from 20-79
        }),
      );

      for (const userData of users) {
        await collection.create(userData);
      }
    });

    it('should list all objects in under 500ms', async () => {
      const { result, duration } = await measureTime(async () => {
        return await collection.list({});
      });

      expect(duration).toBeLessThan(500);
      expect(result.length).toBe(200);
      console.log(`Listed 200 objects in ${duration.toFixed(2)}ms`);
    });

    it('should perform filtered queries efficiently', async () => {
      const { result, duration } = await measureTime(async () => {
        return await collection.list({
          where: { 'age >=': 30, 'age <=': 50, active: true },
          limit: 50,
        });
      });

      expect(duration).toBeLessThan(200);
      expect(result.length).toBeGreaterThan(0);
      console.log(
        `Filtered query returned ${result.length} objects in ${duration.toFixed(2)}ms`,
      );
    });

    it('should handle pagination efficiently', async () => {
      const pageSize = 20;
      let totalDuration = 0;
      let totalItems = 0;

      for (let page = 0; page < 5; page++) {
        const { result, duration } = await measureTime(async () => {
          return await collection.list({
            limit: pageSize,
            offset: page * pageSize,
            orderBy: 'created_at DESC',
          });
        });

        totalDuration += duration;
        totalItems += result.length;

        expect(duration).toBeLessThan(100);
      }

      expect(totalItems).toBe(100); // 5 pages * 20 items
      console.log(
        `Paginated through 100 objects in ${totalDuration.toFixed(2)}ms total`,
      );
    });

    it('should find objects by ID quickly', async () => {
      // Get a random object first
      const [firstUser] = await collection.list({ limit: 1 });
      expect(firstUser).toBeDefined();

      const { result, duration } = await measureTime(async () => {
        return await collection.get(firstUser.id!);
      });

      expect(duration).toBeLessThan(50);
      expect(result).toBeDefined();
      expect(result?.id).toBe(firstUser.id);
    });

    it('should handle complex queries with joins efficiently', async () => {
      const { result, duration } = await measureTime(async () => {
        return await collection.list({
          where: {
            'age >': 25,
            active: true,
            'name like': '%John%',
          },
          orderBy: ['age DESC', 'created_at ASC'],
          limit: 10,
        });
      });

      expect(duration).toBeLessThan(150);
      console.log(
        `Complex query returned ${result.length} objects in ${duration.toFixed(2)}ms`,
      );
    });
  });

  describe('Update Performance', () => {
    let testUsers: PerfTestUser[];

    beforeEach(async () => {
      // Create test users for updates
      const userData = Array.from({ length: 50 }, () => generateTestUser());
      testUsers = [];

      for (const data of userData) {
        const user = await collection.create(data);
        testUsers.push(user);
      }
    });

    it('should update single object quickly', async () => {
      const user = testUsers[0];

      const { duration } = await measureTime(async () => {
        user.username = 'Updated Name';
        await user.save();
      });

      expect(duration).toBeLessThan(100);
    });

    it('should handle batch updates efficiently', async () => {
      const { duration } = await measureTime(async () => {
        // Update all users concurrently
        await Promise.all(
          testUsers.map(async (user, index) => {
            user.username = `Updated User ${index}`;
            await user.save();
          }),
        );
      });

      expect(duration).toBeLessThan(2000);
      console.log(`Updated 50 objects in ${duration.toFixed(2)}ms`);
    });

    it('should handle large object updates', async () => {
      const user = testUsers[0];
      const largeProfileData = generateLargeText(10000); // 10KB

      const { duration } = await measureTime(async () => {
        user.profileData = largeProfileData;
        await user.save();
      });

      expect(duration).toBeLessThan(200);
    });
  });

  describe('Memory Usage', () => {
    it('should not leak memory during large operations', async () => {
      const initialMemory = process.memoryUsage();

      // Perform memory-intensive operations
      for (let batch = 0; batch < 5; batch++) {
        const users = Array.from({ length: 50 }, () => generateTestUser());

        for (const userData of users) {
          const user = await collection.create(userData);
          // Immediately query it back
          await collection.get(user.id!);
        }

        // Force garbage collection if available
        if (global.gc) {
          global.gc();
        }
      }

      const finalMemory = process.memoryUsage();
      const memoryIncrease = finalMemory.heapUsed - initialMemory.heapUsed;
      const memoryIncreaseMB = memoryIncrease / 1024 / 1024;

      // Memory increase should be reasonable (less than 50MB)
      expect(memoryIncreaseMB).toBeLessThan(50);
      console.log(
        `Memory increased by ${memoryIncreaseMB.toFixed(2)}MB during test`,
      );
    });

    it('should handle large result sets without excessive memory usage', async () => {
      // Create many objects
      const users = Array.from({ length: 500 }, () => generateTestUser());

      for (const userData of users) {
        await collection.create(userData);
      }

      const beforeQuery = process.memoryUsage();

      // Query all objects
      const results = await collection.list({});

      const afterQuery = process.memoryUsage();
      const queryMemoryIncrease =
        (afterQuery.heapUsed - beforeQuery.heapUsed) / 1024 / 1024;

      expect(results.length).toBe(500);
      expect(queryMemoryIncrease).toBeLessThan(20); // Less than 20MB for 500 objects
      console.log(
        `Queried 500 objects using ${queryMemoryIncrease.toFixed(2)}MB additional memory`,
      );
    });
  });

  describe('Database Schema Performance', () => {
    it('should create tables efficiently', async () => {
      // Test creating multiple object types
      class TestProduct extends SmrtObject {
        static tableName = 'test_products';
        productName?: string;
        price?: number;

        constructor(options: any = {}) {
          super({
            ai: { type: 'openai', apiKey: 'test-key' },
            db: { url: getTestDbUrl() },
            ...options,
          });
        }

        static async create(options: any): Promise<TestProduct> {
          const product = new TestProduct(options);
          await product.initialize();
          return product;
        }
      }

      class TestOrder extends SmrtObject {
        static tableName = 'test_orders';
        total?: number;
        status?: string;

        constructor(options: any = {}) {
          super({
            ai: { type: 'openai', apiKey: 'test-key' },
            db: { url: getTestDbUrl() },
            ...options,
          });
        }

        static async create(options: any): Promise<TestOrder> {
          const order = new TestOrder(options);
          await order.initialize();
          return order;
        }
      }

      const { duration } = await measureTime(async () => {
        // Creating instances should trigger table creation via static create methods
        const product = await TestProduct.create({
          productName: 'Test Product',
          price: 100,
        });
        await product.save();

        const order = await TestOrder.create({ total: 150, status: 'pending' });
        await order.save();
      });

      expect(duration).toBeLessThan(1000);
    });
  });

  describe('Concurrent Operations', () => {
    it('should handle concurrent reads efficiently', async () => {
      // Pre-populate data
      const users = Array.from({ length: 100 }, () => generateTestUser());
      const createdUsers: PerfTestUser[] = [];

      for (const userData of users) {
        const user = await collection.create(userData);
        createdUsers.push(user);
      }

      // Perform concurrent reads
      const { duration } = await measureTime(async () => {
        const promises = createdUsers.map((user) => collection.get(user.id!));
        await Promise.all(promises);
      });

      expect(duration).toBeLessThan(1000);
      console.log(`100 concurrent reads completed in ${duration.toFixed(2)}ms`);
    });

    it('should handle concurrent writes with reasonable performance', async () => {
      const users = Array.from({ length: 20 }, () => generateTestUser());

      const { duration } = await measureTime(async () => {
        // Create users concurrently
        await Promise.all(users.map((userData) => collection.create(userData)));
      });

      expect(duration).toBeLessThan(2000);
      console.log(`20 concurrent writes completed in ${duration.toFixed(2)}ms`);
    });
  });

  describe('Performance Regression Tests', () => {
    it('should maintain query performance as data grows', async () => {
      const queryTimes: number[] = [];

      // Test with increasing data sizes
      for (const size of [10, 50, 100, 200]) {
        // Add more data
        const additionalUsers = Array.from(
          { length: size - queryTimes.length * 10 },
          () => generateTestUser(),
        );
        for (const userData of additionalUsers) {
          await collection.create(userData);
        }

        // Measure query time
        const { duration } = await measureTime(async () => {
          await collection.list({ limit: 10, orderBy: 'created_at DESC' });
        });

        queryTimes.push(duration);
      }

      // Query times shouldn't increase dramatically
      const firstTime = queryTimes[0];
      const lastTime = queryTimes[queryTimes.length - 1];

      // Last query should not be more than 3x slower than first
      expect(lastTime).toBeLessThan(firstTime * 3);
      console.log(
        `Query times: ${queryTimes.map((t) => t.toFixed(2)).join('ms, ')}ms`,
      );
    });
  });
});
