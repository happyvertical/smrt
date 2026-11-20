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

type Engine = 'sqlite' | 'pglite';
const engines: Engine[] =
  process.env.SMRT_TEST_PGLITE === '1' ? ['pglite'] : ['sqlite'];

describe.each(engines)('junction late collision on %s', (engine) => {
  let restore: () => void;
  let db: Awaited<ReturnType<typeof getTestDatabase>>;
  const seen: string[] = [];

  beforeEach(async () => {
    restore = snapshotObjectRegistryState();
    ObjectRegistry.registerCollection('JunctionLateLinks', JunctionLateLinks);
    db = await getTestDatabase({
      type: engine,
      ...(engine === 'sqlite' ? { url: ':memory:' } : {}),
      classes: ['JunctionLateLink'],
    });
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

  const storedIds = async () =>
    (
      await db.query(
        `SELECT id FROM junction_late_links WHERE owner_id = 'owner-1'`,
      )
    ).rows.map((row: any) => String(row.id));

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

    const stored = await storedIds();
    expect(stored).toEqual([winnerId]);
    expect(seen.map((id) => id.toLowerCase())).toEqual([
      winnerId.toLowerCase(),
    ]);
    const feed = (
      await getChangesSince(db, { since: startCursor })
    ).changes.filter((change) => change.table === 'junction_late_links');
    expect(feed.map((change) => `${change.operation}:${change.rowId}`)).toEqual(
      [`create:${winnerId}`, `update:${winnerId}`],
    );
  });

  it('control: without a race the new row keeps its own id and is a create', async () => {
    const links = (await JunctionLateLinks.create({ db })) as JunctionLateLinks;
    const startCursor = (await getChangesSince(db, { since: 0 })).cursor;

    await links.setLinks('owner-1', ['asset-x']);

    const stored = await storedIds();
    expect(stored).toHaveLength(1);
    expect(seen.map((id) => id.toLowerCase())).toEqual(stored);
    const feed = (
      await getChangesSince(db, { since: startCursor })
    ).changes.filter((change) => change.table === 'junction_late_links');
    expect(feed.map((change) => change.operation)).toEqual(['create']);
    expect(feed[0].rowId?.toLowerCase()).toBe(stored[0].toLowerCase());
  });
});
