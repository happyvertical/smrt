/**
 * Minimal test to debug race condition in foreign key queries
 */

import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseInterface } from '@happyvertical/sql';
import { getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { foreignKey, SmrtObject, smrt } from '../index.js';
import { ObjectRegistry } from '../registry';

@smrt({ tableStrategy: 'sti' })
class RaceTestParent extends SmrtObject {
  name: string = '';
  constructor(options: any = {}) {
    super(options);
    if (options.name) this.name = options.name;
  }
}

@smrt({ tableStrategy: 'sti' })
class RaceTestBase extends SmrtObject {
  title: string = '';
  constructor(options: any = {}) {
    super(options);
    if (options.title) this.title = options.title;
  }
}

@smrt()
class RaceTestChild extends RaceTestBase {
  @foreignKey('RaceTestParent')
  parentId?: string;

  constructor(options: any = {}) {
    super(options);
    if (options.parentId) this.parentId = options.parentId;
  }
}

describe('Race Condition Debug', () => {
  let db: DatabaseInterface;

  beforeEach(async () => {
    const dbPath = join(tmpdir(), `race-debug-${randomUUID().slice(0, 8)}.db`);
    db = await getDatabase({ type: 'sqlite', url: dbPath });
  });

  afterEach(async () => {
    if (db && typeof db.close === 'function') {
      await db.close();
    }
  });

  it('Test 1: should query by foreign key', async () => {
    const parent = new RaceTestParent({ name: 'P1', db });
    await parent.initialize();
    await parent.save();

    const child = new RaceTestChild({ parentId: parent.id, title: 'C1', db });
    await child.initialize();
    await child.save();

    const collection = await ObjectRegistry.getCollection<
      typeof RaceTestChild.prototype
    >('RaceTestChild', { db });

    const found = await collection.findOne({ where: { parentId: parent.id } });
    expect(found).not.toBeNull();
  });

  it('Test 2: should query by foreign key', async () => {
    const parent = new RaceTestParent({ name: 'P2', db });
    await parent.initialize();
    await parent.save();

    const child = new RaceTestChild({ parentId: parent.id, title: 'C2', db });
    await child.initialize();
    await child.save();

    const collection = await ObjectRegistry.getCollection<
      typeof RaceTestChild.prototype
    >('RaceTestChild', { db });

    const found = await collection.findOne({ where: { parentId: parent.id } });
    expect(found).not.toBeNull();
  });

  it('Test 3: should query by foreign key', async () => {
    const parent = new RaceTestParent({ name: 'P3', db });
    await parent.initialize();
    await parent.save();

    const child = new RaceTestChild({ parentId: parent.id, title: 'C3', db });
    await child.initialize();
    await child.save();

    const collection = await ObjectRegistry.getCollection<
      typeof RaceTestChild.prototype
    >('RaceTestChild', { db });

    const found = await collection.findOne({ where: { parentId: parent.id } });
    expect(found).not.toBeNull();
  });
});
