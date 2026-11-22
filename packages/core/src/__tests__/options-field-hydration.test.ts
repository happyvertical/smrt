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

@smrt({ packageName: '@optfield/models', tableName: 'optfield_readonly' })
class OptFieldReadonly extends SmrtObject {
  @field({ type: 'text' }) title = '';
  @field({ type: 'text', readonly: true }) declare options: any;
}
class OptFieldReadonlyCollection extends SmrtCollection<OptFieldReadonly> {
  static readonly _itemClass = OptFieldReadonly;
}

/** Used only by the getDiff test, so no earlier test has warned for it. */
@smrt({ packageName: '@optfield/models', tableName: 'optfield_diff_plain' })
class OptFieldDiffPlain extends SmrtObject {
  @field({ type: 'text' }) title = '';
  @field({ type: 'text' }) note = '';
}
class OptFieldDiffPlainCollection extends SmrtCollection<OptFieldDiffPlain> {
  static readonly _itemClass = OptFieldDiffPlain;
}

/** A class named OptFieldTwin in the given package (same simple name each time). */
function defineTwin(packageName: string) {
  @smrt({
    packageName,
    tableName: `optfield_twin_${packageName.slice(-1)}`,
  } as any)
  class OptFieldTwin extends SmrtObject {
    static readonly __package__ = packageName;
    @field({ type: 'text' }) title = '';
    @field({ type: 'text' }) declare options: any;
  }
  return OptFieldTwin;
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
    ObjectRegistry.registerCollection(
      'OptFieldReadonly',
      OptFieldReadonlyCollection,
    );
    ObjectRegistry.registerCollection(
      'OptFieldDiffPlain',
      OptFieldDiffPlainCollection,
    );
    db = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      classes: [
        'OptFieldDeclared',
        'OptFieldPlain',
        'OptFieldWarned',
        'OptFieldReadonly',
        'OptFieldDiffPlain',
      ],
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

  it('getFields() returns no value for a field named options', async () => {
    const collection = (await OptFieldDeclaredCollection.create({
      db,
    })) as OptFieldDeclaredCollection;
    const created = await collection.create({ title: 't' } as never);
    const loaded = (await collection.get(String(created.id)))!;

    const fields = await loaded.getFields();

    expect(fields.title.value).toBe('t');
    expect(fields.options?.value).toBeUndefined();
    // The service options themselves are untouched.
    expect(loaded.options.db).toBe(db);
  });

  it('collection.update() never assigns a field named options onto the instance', async () => {
    const collection = (await OptFieldDeclaredCollection.create({
      db,
    })) as OptFieldDeclaredCollection;
    const created = await collection.create({ title: 't' } as never);

    const updated = await collection.update(String(created.id), {
      title: 'renamed',
      options: 'replacement',
    } as never);

    expect(updated?.title).toBe('renamed');
    expect(updated?.options).not.toBe('replacement');
    expect(updated?.options.db).toBe(db);
    expect((await collection.get(String(created.id)))?.title).toBe('renamed');
  });

  it('getOrUpsert() never assigns a field named options onto the found instance', async () => {
    const collection = (await OptFieldDeclaredCollection.create({
      db,
    })) as OptFieldDeclaredCollection;
    const created = await collection.create({ title: 't' } as never);

    const found = await collection.getOrUpsert({
      id: created.id,
      title: 'upserted',
      options: 'replacement',
    });

    expect(found.title).toBe('upserted');
    expect(found.options).not.toBe('replacement');
    expect(found.options.db).toBe(db);
  });

  it('warns once for each of two same-named classes, naming each model', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const [first, second] = [
        defineTwin('@optfield/a'),
        defineTwin('@optfield/b'),
      ];
      await new first({}).getFields();
      await new second({}).getFields();
      await new first({}).getFields();
      const messages = warn.mock.calls
        .map((call) => call.join(' '))
        .filter((text) => text.includes('OptFieldTwin'));
      expect(messages).toHaveLength(2);
      expect(messages[0]).toContain('@optfield/a:OptFieldTwin');
      expect(messages[1]).toContain('@optfield/b:OptFieldTwin');
    } finally {
      warn.mockRestore();
    }
  });

  /** The stored row, read straight from the table. */
  async function storedRow(table: string, id: unknown) {
    return (await db.get(table, { id: String(id) })) as Record<string, unknown>;
  }

  it('collection.update() still refuses an options key on a model that does not declare it, without writing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const collection = (await OptFieldPlainCollection.create({
      db,
    })) as OptFieldPlainCollection;
    const created = await collection.create({
      title: 't',
      note: 'n',
    } as never);
    const before = await storedRow('optfield_plain', created.id);
    const save = vi.spyOn(OptFieldPlain.prototype, 'save');
    try {
      await expect(
        collection.update(String(created.id), {
          note: 'changed',
          options: 'replacement',
        } as never),
      ).rejects.toMatchObject({
        code: 'VALIDATION_UNKNOWN_FIELD',
        details: { field: 'options' },
      });

      expect(save).not.toHaveBeenCalled();
      const after = await storedRow('optfield_plain', created.id);
      expect(after.note).toBe('n');
      expect(after.updated_at).toEqual(before.updated_at);
      expect(
        warn.mock.calls
          .map((call) => call.join(' '))
          .filter((text) => text.includes('OptFieldPlain')),
      ).toEqual([]);
    } finally {
      save.mockRestore();
      warn.mockRestore();
    }
  });

  it('collection.update() still refuses an options field declared read-only, without writing', async () => {
    const collection = (await OptFieldReadonlyCollection.create({
      db,
    })) as OptFieldReadonlyCollection;
    const created = await collection.create({ title: 't' } as never);
    const before = await storedRow('optfield_readonly', created.id);
    const save = vi.spyOn(OptFieldReadonly.prototype, 'save');
    try {
      await expect(
        collection.update(String(created.id), {
          title: 'renamed',
          options: 'replacement',
        } as never),
      ).rejects.toMatchObject({
        code: 'VALIDATION_UNKNOWN_FIELD',
        details: { field: 'options' },
      });

      expect(save).not.toHaveBeenCalled();
      const after = await storedRow('optfield_readonly', created.id);
      expect(after.title).toBe('t');
      expect(after.updated_at).toEqual(before.updated_at);
    } finally {
      save.mockRestore();
    }
  });

  it('getDiff() ignores an options key on a model that does not declare it, without a warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const collection = (await OptFieldDiffPlainCollection.create({
        db,
      })) as OptFieldDiffPlainCollection;

      const diff = await collection.getDiff(
        { title: 't', note: 'n' },
        { title: 't', note: 'n', options: 'replacement' },
      );

      expect(diff).toBeNull();
      expect(
        warn.mock.calls
          .map((call) => call.join(' '))
          .filter((text) => text.includes('OptFieldDiffPlain')),
      ).toEqual([]);
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
