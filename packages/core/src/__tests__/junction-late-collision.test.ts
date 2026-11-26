/**
 * A grouped junction write (`setLinks`) whose natural key is committed by a
 * concurrent writer between the probe and the upsert reports the stored row:
 * hooks, interceptors and the change feed see the row's id that is in the
 * table, as an update. Runs on SQLite by default and on PGlite under
 * `pnpm test:pglite`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getChangesSince,
  registerChangeFeedWriter,
  unregisterChangeFeedWriter,
} from '../change-feed';
import { field } from '../decorators/index';
import { GlobalInterceptors } from '../interceptors';
import { SmrtJunction } from '../junction';
import { SmrtObject } from '../object';
import { ObjectRegistry, smrt } from '../registry';
import { snapshotObjectRegistryState } from '../test-utils';
import { getTestDatabase } from '../testing/database';

@smrt({
  packageName: '@junction-late/links',
  tableName: 'junction_late_links',
  conflictColumns: ['owner_id', 'asset_id'],
})
class JunctionLateLink extends SmrtObject {
  @field({ required: true }) ownerId = '';
  @field({ required: true }) assetId = '';
}

@smrt({ packageName: '@junction-late/links' })
class JunctionLateLinks extends SmrtJunction<JunctionLateLink> {
  static readonly _itemClass = JunctionLateLink;
  protected leftField = 'ownerId';
  protected rightField = 'assetId';
}

// Conflict keys of types the stored-row match cannot compare as text.
@smrt({
  packageName: '@junction-late/links',
  tableName: 'junction_late_flagged',
  conflictColumns: ['owner_id', 'asset_id', 'active'],
})
class JunctionLateFlagged extends SmrtObject {
  @field({ required: true }) ownerId = '';
  @field({ required: true }) assetId = '';
  @field() active = true;
}

@smrt({ packageName: '@junction-late/links' })
class JunctionLateFlaggedLinks extends SmrtJunction<JunctionLateFlagged> {
  static readonly _itemClass = JunctionLateFlagged;
  protected leftField = 'ownerId';
  protected rightField = 'assetId';
}

@smrt({
  packageName: '@junction-late/links',
  tableName: 'junction_late_dated',
  conflictColumns: ['owner_id', 'asset_id', 'linked_on'],
})
class JunctionLateDated extends SmrtObject {
  @field({ required: true }) ownerId = '';
  @field({ required: true }) assetId = '';
  @field({ type: 'datetime' }) linkedOn = new Date('2026-02-03T04:05:06.789Z');
}

@smrt({ packageName: '@junction-late/links' })
class JunctionLateDatedLinks extends SmrtJunction<JunctionLateDated> {
  static readonly _itemClass = JunctionLateDated;
  protected leftField = 'ownerId';
  protected rightField = 'assetId';
}

type Engine = 'sqlite' | 'duckdb' | 'pglite';
// Native DuckDB runs in-process with SQLite (its UUID ids come back from the
// driver as non-string values); PGlite runs under `pnpm test:pglite`.
const engines: Engine[] =
  process.env.SMRT_TEST_PGLITE === '1' ? ['pglite'] : ['sqlite', 'duckdb'];

async function openDatabase(engine: Engine, classes: string[]) {
  return getTestDatabase({
    type: engine,
    ...(engine === 'pglite' ? {} : { url: ':memory:' }),
    classes,
  });
}

/** Ids as canonical text on every engine. */
async function idsIn(
  db: Awaited<ReturnType<typeof getTestDatabase>>,
  table: string,
): Promise<string[]> {
  return (
    await db.query(
      `SELECT CAST(id AS VARCHAR) AS id FROM ${table} WHERE owner_id = 'owner-1'`,
    )
  ).rows
    .map((row: any) => String(row.id).toLowerCase())
    .sort();
}

describe.each(engines)('junction late collision on %s', (engine) => {
  let restore: () => void;
  let db: Awaited<ReturnType<typeof getTestDatabase>>;
  const seen: string[] = [];

  beforeEach(async () => {
    restore = snapshotObjectRegistryState();
    ObjectRegistry.registerCollection('JunctionLateLinks', JunctionLateLinks);
    db = await openDatabase(engine, ['JunctionLateLink']);
    registerChangeFeedWriter();
    seen.length = 0;
    GlobalInterceptors.register({
      name: 'junction-late-observer',
      priority: 50,
      bulkMutation: {
        compatible: () => true,
        async afterSave(entries: any[]) {
          for (const entry of entries) seen.push(String(entry.instance.id));
        },
      },
    } as never);
  });

  afterEach(async () => {
    GlobalInterceptors.unregister('junction-late-observer');
    unregisterChangeFeedWriter();
    await db?.close?.();
    restore();
  });

  const storedIds = () => idsIn(db, 'junction_late_links');
  const feedFor = async (since: number) =>
    (await getChangesSince(db, { since })).changes
      .filter((change) => change.table === 'junction_late_links')
      .map((change) => `${change.operation}:${change.rowId?.toLowerCase()}`);

  it('reports the stored row id when a concurrent writer wins the natural key', async () => {
    const links = (await JunctionLateLinks.create({ db })) as JunctionLateLinks;
    const other = (await JunctionLateLinks.create({ db })) as JunctionLateLinks;
    const startCursor = (await getChangesSince(db, { since: 0 })).cursor;

    // Right after the natural-key probe returns no row, another writer
    // commits the same pair.
    let winnerId = '';
    const original = db.query.bind(db);
    (db as any).query = async (sql: string, ...args: unknown[]) => {
      const result = await original(sql, ...args);
      if (
        !winnerId &&
        sql.startsWith('SELECT "id" FROM "junction_late_links" WHERE (')
      ) {
        winnerId = 'pending';
        winnerId = String((await other.attach('owner-1', 'asset-x')).id);
      }
      return result;
    };
    await links.setLinks('owner-1', ['asset-x']);
    (db as any).query = original;

    const winner = winnerId.toLowerCase();
    expect(await storedIds()).toEqual([winner]);
    expect(seen.map((id) => id.toLowerCase())).toEqual([winner]);
    expect(await feedFor(startCursor)).toEqual([
      `create:${winner}`,
      `update:${winner}`,
    ]);
  });

  it('keeps two links whose keys differ only by letter case apart', async () => {
    const links = (await JunctionLateLinks.create({ db })) as JunctionLateLinks;
    const startCursor = (await getChangesSince(db, { since: 0 })).cursor;

    await links.setLinks('owner-1', ['Asset-A', 'asset-a']);

    const stored = await storedIds();
    expect(stored).toHaveLength(2);
    const byAsset = new Map(
      (
        await db.query(
          `SELECT CAST(id AS VARCHAR) AS id, asset_id FROM junction_late_links WHERE owner_id = 'owner-1'`,
        )
      ).rows.map((row: any) => [row.asset_id, String(row.id).toLowerCase()]),
    );
    expect([...seen].map((id) => id.toLowerCase()).sort()).toEqual(stored);
    expect((await feedFor(startCursor)).sort()).toEqual(
      [
        `create:${byAsset.get('Asset-A')}`,
        `create:${byAsset.get('asset-a')}`,
      ].sort(),
    );
  });

  it('control: without a race the new row keeps its own id and is a create', async () => {
    const links = (await JunctionLateLinks.create({ db })) as JunctionLateLinks;
    const startCursor = (await getChangesSince(db, { since: 0 })).cursor;

    await links.setLinks('owner-1', ['asset-x']);

    const stored = await storedIds();
    expect(stored).toHaveLength(1);
    expect(seen.map((id) => id.toLowerCase())).toEqual(stored);
    expect(await feedFor(startCursor)).toEqual([`create:${stored[0]}`]);
  });
});

describe.each(
  engines,
)('junction late collision with non-text keys on %s', (engine) => {
  let restore: () => void;
  let db: Awaited<ReturnType<typeof getTestDatabase>>;

  beforeEach(async () => {
    restore = snapshotObjectRegistryState();
    ObjectRegistry.registerCollection(
      'JunctionLateFlaggedLinks',
      JunctionLateFlaggedLinks,
    );
    ObjectRegistry.registerCollection(
      'JunctionLateDatedLinks',
      JunctionLateDatedLinks,
    );
    db = await openDatabase(engine, [
      'JunctionLateFlagged',
      'JunctionLateDated',
    ]);
    registerChangeFeedWriter();
  });

  afterEach(async () => {
    unregisterChangeFeedWriter();
    await db?.close?.();
    restore();
  });

  it.each([
    ['boolean', 'junction_late_flagged', JunctionLateFlaggedLinks],
    ['date', 'junction_late_dated', JunctionLateDatedLinks],
  ] as const)('a %s conflict key takes the per-item path and never reports an id that is not stored', async (_kind, table, Links) => {
    const Junction = Links as unknown as typeof JunctionLateFlaggedLinks;
    const links = (await Junction.create({
      db,
    })) as unknown as SmrtJunction<SmrtObject>;
    const other = (await Junction.create({
      db,
    })) as unknown as SmrtJunction<SmrtObject>;
    const startCursor = (await getChangesSince(db, { since: 0 })).cursor;

    // If the grouped path ran, another writer would commit the same natural
    // key right after its probe; the grouped path cannot match a stored row
    // by such a key, so it must not run at all.
    let probed = false;
    const original = db.query.bind(db);
    (db as any).query = async (sql: string, ...args: unknown[]) => {
      const result = await original(sql, ...args);
      if (!probed && sql.startsWith(`SELECT "id" FROM "${table}" WHERE (`)) {
        probed = true;
        await other.attach('owner-1', 'asset-x');
      }
      return result;
    };
    try {
      await links.setLinks('owner-1', ['asset-x']);
    } finally {
      (db as any).query = original;
    }

    const stored = await idsIn(db, table);
    expect(probed).toBe(false);
    expect(stored).toHaveLength(1);
    const feedIds = (await getChangesSince(db, { since: startCursor })).changes
      .filter((change) => change.table === table)
      .map((change) => change.rowId?.toLowerCase());
    expect(feedIds.length).toBeGreaterThan(0);
    expect(feedIds.every((id) => id === stored[0])).toBe(true);
  });
});
