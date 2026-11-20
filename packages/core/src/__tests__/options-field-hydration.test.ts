/**
 * A registered field named `options` never replaces the instance's service
 * options when a row is loaded, and a save that skips it says so instead of
 * dropping the value silently.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SmrtCollection } from '../collection';
import { field } from '../decorators';
import { SmrtObject } from '../object';
import { ObjectRegistry, smrt } from '../registry';
import { snapshotObjectRegistryState } from '../test-utils';
import { getTestDatabase } from '../testing/database';

@smrt({ packageName: '@optfield/models', tableName: 'optfield_declared' })
class OptFieldDeclared extends SmrtObject {
  @field({ type: 'text' }) title = '';
  @field({ type: 'text' }) declare options: any;
}
class OptFieldDeclaredCollection extends SmrtCollection<OptFieldDeclared> {
  static readonly _itemClass = OptFieldDeclared;
}

@smrt({ packageName: '@optfield/models', tableName: 'optfield_warned' })
class OptFieldWarned extends SmrtObject {
  @field({ type: 'text' }) title = '';
  @field({ type: 'text' }) declare options: any;
}
class OptFieldWarnedCollection extends SmrtCollection<OptFieldWarned> {
  static readonly _itemClass = OptFieldWarned;
}

@smrt({ packageName: '@optfield/models', tableName: 'optfield_plain' })
class OptFieldPlain extends SmrtObject {
  @field({ type: 'text' }) title = '';
  @field({ type: 'text' }) note = '';
}
class OptFieldPlainCollection extends SmrtCollection<OptFieldPlain> {
  static readonly _itemClass = OptFieldPlain;
}

describe('field named options', () => {
  let restore: () => void;
  let db: Awaited<ReturnType<typeof getTestDatabase>>;

  beforeEach(async () => {
    restore = snapshotObjectRegistryState();
    ObjectRegistry.registerCollection(
      'OptFieldDeclared',
      OptFieldDeclaredCollection,
    );
    ObjectRegistry.registerCollection('OptFieldPlain', OptFieldPlainCollection);
    ObjectRegistry.registerCollection(
      'OptFieldWarned',
      OptFieldWarnedCollection,
    );
    db = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      classes: ['OptFieldDeclared', 'OptFieldPlain', 'OptFieldWarned'],
    });
  });

  afterEach(async () => {
    await db?.close?.();
    restore();
  });

  it('keeps the instance service options when a stored column has that name', async () => {
    const collection = (await OptFieldDeclaredCollection.create({
      db,
    })) as OptFieldDeclaredCollection;
    const created = await collection.create({ title: 't' } as never);
    await db.query(`UPDATE optfield_declared SET options = 'blue'`);

    const loaded = (await collection.get(String(created.id)))!;

    expect(loaded.title).toBe('t');
    expect(typeof loaded.options).toBe('object');
    expect(loaded.options).not.toBe('blue');
    // The instance keeps working against its database after the load.
    loaded.title = 'renamed';
    await loaded.save();
    expect((await collection.get(String(created.id)))?.title).toBe('renamed');
  });

  it('warns once per class that the options field is not saved', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const collection = (await OptFieldWarnedCollection.create({
        db,
      })) as OptFieldWarnedCollection;
      await collection.create({ title: 'a' } as never);
      await collection.create({ title: 'b' } as never);
      const messages = warn.mock.calls
        .map((call) => call.join(' '))
        .filter((text) => text.includes('OptFieldWarned'));
      expect(messages).toHaveLength(1);
      expect(messages[0]).toContain('options');
    } finally {
      warn.mockRestore();
    }
  });

  it('control: a class without that field loads and saves without a warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const collection = (await OptFieldPlainCollection.create({
        db,
      })) as OptFieldPlainCollection;
      const created = await collection.create({
        title: 't',
        note: 'n',
      } as never);
      const loaded = (await collection.get(String(created.id)))!;
      expect(loaded.note).toBe('n');
      expect(
        warn.mock.calls
          .map((call) => call.join(' '))
          .filter((text) => text.includes('OptFieldPlain')),
      ).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });
});
