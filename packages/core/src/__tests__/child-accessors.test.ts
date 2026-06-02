/**
 * R10 — generated child accessors for `@oneToMany` relationships.
 *
 * Verifies that the `@smrt()` decorator installs a consistent `getX()` instance
 * method for every `@oneToMany` field (delegating to `loadRelatedMany`), that
 * the generation is purely additive (never shadows a hand-rolled accessor), and
 * that an explicit `{ foreignKey }` disambiguates a target with multiple FKs
 * back to the parent.
 */

import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  childAccessorName,
  foreignKey,
  ObjectRegistry,
  oneToMany,
  SmrtObject,
  smrt,
} from '../index';
import { getTestDatabase } from '../testing/database';

// --- Basic one-to-many ------------------------------------------------------

@smrt()
class R10Child extends SmrtObject {
  @foreignKey('R10Parent')
  r10ParentId: string = '';

  title: string = '';

  constructor(options: any = {}) {
    super(options);
    if (options.r10ParentId) this.r10ParentId = options.r10ParentId;
    if (options.title) this.title = options.title;
  }
}

@smrt()
class R10Parent extends SmrtObject {
  name: string = '';

  @oneToMany('R10Child')
  items: any[] = [];

  constructor(options: any = {}) {
    super(options);
    if (options.name) this.name = options.name;
  }
}

// --- Hand-rolled accessor must be preserved (additive only) -----------------

@smrt()
class R10CustomParent extends SmrtObject {
  name: string = '';

  @oneToMany('R10Child')
  items: any[] = [];

  // Pre-existing hand-rolled accessor — generation must NOT overwrite it.
  async getItems(): Promise<string[]> {
    return ['hand-rolled-sentinel'];
  }
}

// --- Multiple FKs back to the same parent (explicit foreignKey) -------------

@smrt()
class R10Edge extends SmrtObject {
  @foreignKey('R10Pair')
  leftId: string = '';

  @foreignKey('R10Pair')
  rightId: string = '';

  label: string = '';

  constructor(options: any = {}) {
    super(options);
    if (options.leftId) this.leftId = options.leftId;
    if (options.rightId) this.rightId = options.rightId;
    if (options.label) this.label = options.label;
  }
}

@smrt()
class R10Pair extends SmrtObject {
  name: string = '';

  @oneToMany('R10Edge', { foreignKey: 'leftId' })
  asLeft: any[] = [];

  @oneToMany('R10Edge', { foreignKey: 'rightId' })
  asRight: any[] = [];

  constructor(options: any = {}) {
    super(options);
    if (options.name) this.name = options.name;
  }
}

// --- STI: a child class inherits the base's generated @oneToMany accessor ---

@smrt({ tableStrategy: 'sti' })
class R10StiBase extends SmrtObject {
  name: string = '';

  @oneToMany('R10StiChild')
  kids: any[] = [];

  constructor(options: any = {}) {
    super(options);
    if (options.name) this.name = options.name;
  }
}

@smrt()
class R10StiLeaf extends R10StiBase {
  extra: string = '';
}

@smrt()
class R10StiChild extends SmrtObject {
  @foreignKey('R10StiBase')
  baseId: string = '';

  title: string = '';

  constructor(options: any = {}) {
    super(options);
    if (options.baseId) this.baseId = options.baseId;
    if (options.title) this.title = options.title;
  }
}

// --- Invalid explicit { foreignKey } must fail in both loaders -------------

@smrt()
class R10BadFkChild extends SmrtObject {
  @foreignKey('R10BadFkParent')
  parentId: string = '';

  constructor(options: any = {}) {
    super(options);
    if (options.parentId) this.parentId = options.parentId;
  }
}

@smrt()
class R10BadFkParent extends SmrtObject {
  name: string = '';

  @oneToMany('R10BadFkChild', { foreignKey: 'doesNotExist' })
  kids: any[] = [];

  constructor(options: any = {}) {
    super(options);
    if (options.name) this.name = options.name;
  }
}

describe('R10: childAccessorName', () => {
  it('derives getX() from the field name', () => {
    expect(childAccessorName('items')).toBe('getItems');
    expect(childAccessorName('terms')).toBe('getTerms');
    expect(childAccessorName('relationshipsFrom')).toBe('getRelationshipsFrom');
  });
});

describe('R10: generated @oneToMany child accessors', () => {
  let db: DatabaseInterface;
  let dbPath: string;

  beforeEach(async () => {
    dbPath = join(tmpdir(), `test-r10-${randomUUID().slice(0, 8)}.db`);
    db = await getTestDatabase({ type: 'sqlite', url: dbPath });
  });

  afterEach(async () => {
    if (db && typeof db.close === 'function') {
      await db.close();
    }
  });

  it('installs a non-enumerable getX() method on the prototype', () => {
    expect(typeof (R10Parent.prototype as any).getItems).toBe('function');
    const descriptor = Object.getOwnPropertyDescriptor(
      R10Parent.prototype,
      'getItems',
    );
    expect(descriptor?.enumerable).toBe(false);
  });

  it('does not leak the accessor into instance enumeration', async () => {
    const parent = new R10Parent({ name: 'Enumerable?', db });
    await parent.initialize();
    expect(Object.keys(parent)).not.toContain('getItems');
  });

  it('loads the related children through the generated accessor', async () => {
    const parent = new R10Parent({ name: 'Has children', db });
    await parent.initialize();
    await parent.save();

    const other = new R10Parent({ name: 'Other', db });
    await other.initialize();
    await other.save();

    for (const title of ['a', 'b']) {
      const child = new R10Child({ r10ParentId: parent.id, title, db });
      await child.initialize();
      await child.save();
    }
    const stray = new R10Child({ r10ParentId: other.id, title: 'c', db });
    await stray.initialize();
    await stray.save();

    const items = (await (parent as any).getItems()) as R10Child[];
    expect(items).toHaveLength(2);
    expect(items.map((c) => c.title).sort()).toEqual(['a', 'b']);

    // Delegates to the same resolver as loadRelatedMany.
    const viaLoader = (await parent.loadRelatedMany('items')) as R10Child[];
    expect(viaLoader.map((c) => c.id).sort()).toEqual(
      items.map((c) => c.id).sort(),
    );
  });

  it('preserves a hand-rolled accessor of the same name (additive only)', async () => {
    const parent = new R10CustomParent({ name: 'Custom', db });
    await parent.initialize();
    const result = await (parent as any).getItems();
    expect(result).toEqual(['hand-rolled-sentinel']);
  });

  it('inherited accessor resolves children when called on an STI child', async () => {
    const leaf = new R10StiLeaf({ name: 'Leaf', db });
    await leaf.initialize();
    await leaf.save();

    for (const title of ['x', 'y']) {
      const child = new R10StiChild({ baseId: leaf.id, title, db });
      await child.initialize();
      await child.save();
    }

    // getKids() is generated on R10StiBase.prototype and inherited by the leaf.
    const kids = (await (leaf as any).getKids()) as R10StiChild[];
    expect(kids.map((k) => k.title).sort()).toEqual(['x', 'y']);
  });

  it('disambiguates multiple FKs via explicit { foreignKey }', async () => {
    const pair = new R10Pair({ name: 'Node', db });
    await pair.initialize();
    await pair.save();

    const partner = new R10Pair({ name: 'Partner', db });
    await partner.initialize();
    await partner.save();

    // Edge where `pair` is on the left side.
    const leftEdge = new R10Edge({
      leftId: pair.id,
      rightId: partner.id,
      label: 'L',
      db,
    });
    await leftEdge.initialize();
    await leftEdge.save();

    // Edge where `pair` is on the right side.
    const rightEdge = new R10Edge({
      leftId: partner.id,
      rightId: pair.id,
      label: 'R',
      db,
    });
    await rightEdge.initialize();
    await rightEdge.save();

    const asLeft = (await (pair as any).getAsLeft()) as R10Edge[];
    const asRight = (await (pair as any).getAsRight()) as R10Edge[];

    expect(asLeft.map((e) => e.label)).toEqual(['L']);
    expect(asRight.map((e) => e.label)).toEqual(['R']);
  });

  it('fails the same way in both loaders for an invalid explicit foreignKey', async () => {
    const parent = new R10BadFkParent({ name: 'Bad', db });
    await parent.initialize();
    await parent.save();
    // A child row so the table exists and eager loading has something to scan.
    const child = new R10BadFkChild({ parentId: parent.id, db });
    await child.initialize();
    await child.save();

    // Lazy path (generated accessor → loadRelatedMany).
    await expect((parent as any).getKids()).rejects.toThrow(
      /foreignKey 'doesNotExist'/,
    );

    // Eager path (include: ['kids'] → batchLoadOneToMany) must fail the same way.
    const collection = await ObjectRegistry.getCollection('R10BadFkParent', {
      db,
    });
    await expect(collection.list({ include: ['kids'] })).rejects.toThrow(
      /foreignKey 'doesNotExist'/,
    );
  });
});
