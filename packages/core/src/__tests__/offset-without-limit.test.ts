/**
 * `list({ offset })`, `listWithLatestRelated({ offset })` and
 * `listAiUsage({ offset })` without a `limit` skip rows and return the rest,
 * on every engine: SQLite needs a LIMIT before OFFSET, and the unbounded LIMIT
 * must be one DuckDB accepts too. Runs on SQLite, native DuckDB and the JSON
 * adapter by default and on PGlite under `pnpm test:pglite`.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SmrtClass } from '../class';
import { SmrtCollection } from '../collection';
import { field, foreignKey, oneToMany } from '../decorators';
import { SmrtObject } from '../object';
import { ObjectRegistry, smrt } from '../registry';
import { snapshotObjectRegistryState } from '../test-utils';
import { getTestDatabase } from '../testing/database';
import { cleanupDirectoryDatabase } from '../testing/file-cleanup';

@smrt({ packageName: '@offset-no-limit/items' })
class OffsetNoLimitItem extends SmrtObject {
  @field({ type: 'text' })
  label = '';

  constructor(options: any = {}) {
    super(options);
    if (options.label !== undefined) this.label = options.label;
  }
}

class OffsetNoLimitItemCollection extends SmrtCollection<OffsetNoLimitItem> {
  static readonly _itemClass = OffsetNoLimitItem;
}

@smrt({ packageName: '@offset-no-limit/items' })
class OffsetNoLimitHolder extends SmrtObject {
  @field({ type: 'text' })
  label = '';

  @oneToMany('OffsetNoLimitHolderNote')
  notes: OffsetNoLimitHolderNote[] = [];

  constructor(options: any = {}) {
    super(options);
    if (options.label !== undefined) this.label = options.label;
  }
}

@smrt({ packageName: '@offset-no-limit/items' })
class OffsetNoLimitHolderNote extends SmrtObject {
  @foreignKey(OffsetNoLimitHolder)
  holderId = '';

  @field()
  sequence = 0;

  constructor(options: any = {}) {
    super(options);
    if (options.holderId !== undefined) this.holderId = options.holderId;
    if (options.sequence !== undefined) this.sequence = options.sequence;
  }
}

class OffsetNoLimitHolderCollection extends SmrtCollection<OffsetNoLimitHolder> {
  static readonly _itemClass = OffsetNoLimitHolder;
}

class OffsetNoLimitHolderNoteCollection extends SmrtCollection<OffsetNoLimitHolderNote> {
  static readonly _itemClass = OffsetNoLimitHolderNote;
}

type Engine = 'sqlite' | 'duckdb' | 'json' | 'pglite';
// Native DuckDB and the JSON adapter (DuckDB underneath) run in-process with
// SQLite; PGlite runs under `pnpm test:pglite`.
const engines: Engine[] =
  process.env.SMRT_TEST_PGLITE === '1'
    ? ['pglite']
    : ['sqlite', 'duckdb', 'json'];

type TestDb = Awaited<ReturnType<typeof getTestDatabase>>;

async function openDatabase(
  engine: Engine,
  classes: string[],
): Promise<{ db: TestDb; close: () => Promise<void> }> {
  if (engine === 'json') {
    const directory = mkdtempSync(join(tmpdir(), 'offset-no-limit-'));
    const db = await getTestDatabase({
      type: 'json',
      url: directory,
      classes,
      // The subject is the LIMIT/OFFSET clause; DuckDB cannot enforce the
      // generated ON UPDATE CASCADE foreign-key action (#2413).
      omitForeignKeyConstraints: true,
    });
    return { db, close: () => cleanupDirectoryDatabase(db, directory) };
  }
  const db = await getTestDatabase({
    classes,
    type: engine,
    ...(engine === 'sqlite' || engine === 'duckdb' ? { url: ':memory:' } : {}),
    ...(engine === 'duckdb' ? { omitForeignKeyConstraints: true } : {}),
  });
  return { db, close: async () => db.close?.() };
}

describe.each(engines)('offset without limit on %s', (engine) => {
  let restore: () => void;
  let db: TestDb;
  let close: () => Promise<void>;
  let collection: OffsetNoLimitItemCollection;

  beforeEach(async () => {
    restore = snapshotObjectRegistryState();
    ObjectRegistry.registerCollection(
      'OffsetNoLimitItem',
      OffsetNoLimitItemCollection,
    );
    ({ db, close } = await openDatabase(engine, ['OffsetNoLimitItem']));
    collection = await OffsetNoLimitItemCollection.create({ db });
    for (const label of ['a', 'b', 'c']) {
      await (await collection.create({ label })).save();
    }
  });

  afterEach(async () => {
    await close?.();
    restore();
  });

  const labels = (rows: OffsetNoLimitItem[]) => rows.map((row) => row.label);

  it('skips the offset rows and returns the rest', async () => {
    const rows = await collection.list({ orderBy: 'label ASC', offset: 1 });
    expect(labels(rows)).toEqual(['b', 'c']);
  });

  it('returns nothing when the offset passes the last row', async () => {
    expect(await collection.list({ offset: 10 })).toEqual([]);
  });

  it('keeps offset with an explicit limit unchanged', async () => {
    const rows = await collection.list({
      orderBy: 'label ASC',
      offset: 1,
      limit: 1,
    });
    expect(labels(rows)).toEqual(['b']);
  });

  it('keeps a list with neither bound unchanged', async () => {
    expect(await collection.list({})).toHaveLength(3);
  });
});

describe.each(
  engines,
)('listWithLatestRelated offset without limit on %s', (engine) => {
  let restore: () => void;
  let db: TestDb;
  let close: () => Promise<void>;
  let holders: OffsetNoLimitHolderCollection;

  beforeEach(async () => {
    restore = snapshotObjectRegistryState();
    ObjectRegistry.registerCollection(
      'OffsetNoLimitHolder',
      OffsetNoLimitHolderCollection,
    );
    ObjectRegistry.registerCollection(
      'OffsetNoLimitHolderNote',
      OffsetNoLimitHolderNoteCollection,
    );
    ({ db, close } = await openDatabase(engine, [
      'OffsetNoLimitHolder',
      'OffsetNoLimitHolderNote',
    ]));
    holders = await OffsetNoLimitHolderCollection.create({ db });
    const notes = await OffsetNoLimitHolderNoteCollection.create({ db });
    for (const label of ['a', 'b', 'c']) {
      const holder = await holders.create({ label });
      await holder.save();
      await (
        await notes.create({ holderId: String(holder.id), sequence: 1 })
      ).save();
    }
  });

  afterEach(async () => {
    await close?.();
    restore();
  });

  const latest = (options: { offset?: number; limit?: number }) =>
    holders.listWithLatestRelated({
      latestRelated: {
        relation: 'notes',
        orderBy: 'sequence DESC',
        select: ['sequence'],
      },
      orderBy: 'label ASC',
      ...options,
    });

  it('skips the offset rows and returns the rest', async () => {
    const page = await latest({ offset: 1 });
    expect(page.map((row) => row.parent.label)).toEqual(['b', 'c']);
    expect(page.every((row) => row.latestRelated !== null)).toBe(true);
  });

  it('keeps offset with an explicit limit unchanged', async () => {
    const page = await latest({ offset: 1, limit: 1 });
    expect(page.map((row) => row.parent.label)).toEqual(['b']);
  });
});

describe.each(engines)('listAiUsage offset without limit on %s', (engine) => {
  let instance: SmrtClass;
  let close: () => Promise<void>;

  beforeEach(async () => {
    let db: TestDb;
    ({ db, close } = await openDatabase(engine, []));
    instance = new SmrtClass({ db });
    await (instance as any).initialize();
    for (const id of ['u1', 'u2', 'u3']) {
      await instance.db.query(
        `INSERT INTO _smrt_ai_usage
           (id, provider, model, operation, duration, created_at)
         VALUES ($1, 'p', 'm', 'op', 1, $2)`,
        id,
        `2026-01-0${id.slice(1)}T00:00:00.000Z`,
      );
    }
  });

  afterEach(async () => {
    await close?.();
  });

  it('skips the offset records and returns the rest', async () => {
    const records = await instance.listAiUsage({
      orderBy: 'timestamp ASC',
      offset: 1,
    });
    expect(records.map((record) => record.id)).toEqual(['u2', 'u3']);
  });

  it('keeps offset with an explicit limit unchanged', async () => {
    const records = await instance.listAiUsage({
      orderBy: 'timestamp ASC',
      offset: 1,
      limit: 1,
    });
    expect(records.map((record) => record.id)).toEqual(['u2']);
  });
});
