/**
 * Test for Issue #176: Support for transient (non-persisted) fields
 *
 * Transient fields exist in TypeScript but are not saved to the database.
 * Useful for functions, computed properties, and runtime-only data.
 */

import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SmrtCollection } from '../collection';
import { field } from '../decorators';
import { SmrtObject } from '../object';
import { ObjectRegistry, smrt } from '../registry';
import { generateSchema } from '../schema/utils';
import { getTestDatabase } from '../testing/database';

// Test class with various transient field patterns
@smrt({ tableName: 'transient_test' })
class TransientTest extends SmrtObject {
  // Regular persisted field
  @field({ required: true })
  name: string = '';

  // Function type (automatically transient)
  filterFn: (value: string) => boolean;

  // Arrow function (automatically transient)
  processFn: (data: any) => string;

  // Explicitly transient via @field decorator
  @field({ transient: true })
  computedValue: string = '';

  // Regular field that should be persisted
  status: string = 'active';
}

class TransientTestCollection extends SmrtCollection<TransientTest> {
  static readonly _itemClass = TransientTest;
}

// Test class with explicit transient option
@smrt()
class WithTransientOption extends SmrtObject {
  @field({ required: true })
  name: string = '';

  @field({ transient: true, default: 'temporary' })
  temp: string = 'temporary';
}

describe('Issue #176: Transient fields', () => {
  let db: DatabaseInterface;
  let dbPath: string;

  beforeEach(async () => {
    dbPath = join(tmpdir(), `test-transient-${randomUUID().slice(0, 8)}.db`);
    db = await getTestDatabase({ type: 'sqlite', url: dbPath });
  }, 120000);

  afterEach(async () => {
    if (db && typeof db.close === 'function') {
      await db.close();
    }
  });

  it('should mark function types as transient in manifest', async () => {
    const fields = await ObjectRegistry.getAllFields('TransientTest');

    // Function types should be marked transient
    const filterFn = fields.get('filterFn');
    expect(filterFn).toBeDefined();
    expect(filterFn?.transient).toBe(true);

    const processFn = fields.get('processFn');
    expect(processFn).toBeDefined();
    expect(processFn?.transient).toBe(true);

    // Explicitly transient field
    const computedValue = fields.get('computedValue');
    expect(computedValue).toBeDefined();
    expect(computedValue?.transient).toBe(true);

    // Regular fields should not be transient
    const name = fields.get('name');
    expect(name).toBeDefined();
    expect(name?.transient).toBeUndefined();

    const status = fields.get('status');
    expect(status).toBeDefined();
    expect(status?.transient).toBeUndefined();
  });

  it('should exclude transient fields from schema generation', async () => {
    const schema = await generateSchema(TransientTest);

    // Schema should include persisted fields
    expect(schema).toContain('name');
    expect(schema).toContain('status');

    // Schema should NOT include transient fields
    expect(schema).not.toContain('filterFn');
    expect(schema).not.toContain('processFn');
    expect(schema).not.toContain('computedValue');
  });

  it('should create table without transient fields', async () => {
    const collection = await TransientTestCollection.create({ db });

    // Create instance with transient function
    const instance = await collection.create({
      name: 'test',
      status: 'active',
      filterFn: (value: string) => value.length > 0,
      processFn: (data: any) => String(data),
      computedValue: 'computed',
    });

    // Should save successfully (transient fields excluded from INSERT)
    await instance.save();

    // Verify instance was saved
    expect(instance.id).toBeDefined();
    expect(instance.name).toBe('test');
    expect(instance.status).toBe('active');

    // Transient fields should still be accessible in memory
    expect(instance.filterFn).toBeDefined();
    expect(instance.processFn).toBeDefined();
    expect(instance.computedValue).toBe('computed');
  });

  it('should allow transient fields to be used at runtime', async () => {
    const collection = await TransientTestCollection.create({ db });

    // Create with function fields
    const filterFn = (value: string) => value.startsWith('test');
    const processFn = (data: any) => `processed: ${data}`;

    const instance = await collection.create({
      name: 'test-instance',
      status: 'active',
      filterFn,
      processFn,
      computedValue: 'runtime-computed',
    });

    // Functions should work at runtime
    expect(instance.filterFn('test123')).toBe(true);
    expect(instance.filterFn('other')).toBe(false);
    expect(instance.processFn('data')).toBe('processed: data');

    // Save should work (transient fields ignored)
    await instance.save();
    expect(instance.id).toBeDefined();

    // Reload from database
    const reloaded = await collection.get({ id: instance.id });
    expect(reloaded).toBeDefined();
    expect(reloaded?.name).toBe('test-instance');
    expect(reloaded?.status).toBe('active');

    // Transient fields won't be persisted/restored
    // Function types (no field helper) should be completely undefined
    expect(reloaded?.filterFn).toBeUndefined();
    expect(reloaded?.processFn).toBeUndefined();
    // Field helper with transient option - Field instance exists but value is undefined
    expect(reloaded?.computedValue).toBeDefined(); // Field instance from class definition
    expect(reloaded?.computedValue?.value).toBeUndefined(); // But value not restored
  });

  it('should support field helper with transient option', async () => {
    const fields = await ObjectRegistry.getAllFields('WithTransientOption');
    const tempField = fields.get('temp');

    expect(tempField).toBeDefined();
    expect(tempField?.transient).toBe(true);
    expect(tempField?._meta?.transient).toBe(true);
  });
});
