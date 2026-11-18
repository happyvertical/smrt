/**
 * A change whose feed append fails is still dropped (the user's write wins,
 * #2026), but the gap is recorded: the next append to the same database first
 * writes a table-level entry for the affected table and tenant, so consumers
 * of that table refetch it. Failure logging is rate-limited per table rather
 * than silenced for the process after the first one.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getChangesSince,
  recordInstanceChange,
  registerChangeFeedWriter,
  resetChangeFeedWarnings,
  setChangeFeedGapMarkerLimitForTesting,
} from '../change-feed';
import {
  getAuthorizedChangesSince,
  setChangeFeedEntryVisibility,
} from '../change-feed-authz';
import {
  type ChangeSignal,
  resetChangeSignals,
  subscribeToChangeSignals,
} from '../change-signals';
import { SmrtCollection } from '../collection';
import { withEmbeddedWriteTransaction } from '../embedded-write-queue';
import { buildChangeEventStream } from '../generators/events-route';
import { SmrtObject } from '../object';
import { smrt } from '../registry';
import { getTestDatabase } from '../testing/database';

@smrt()
class AppendGapNote extends SmrtObject {
  title: string = '';
  tenantId: string = '';
}
class AppendGapNoteCollection extends SmrtCollection<AppendGapNote> {
  static readonly _itemClass = AppendGapNote;
}

@smrt()
class AppendGapTag extends SmrtObject {
  label: string = '';
}
class AppendGapTagCollection extends SmrtCollection<AppendGapTag> {
  static readonly _itemClass = AppendGapTag;
}

const NOTES = 'append_gap_notes';
const TAGS = 'append_gap_tags';

async function failAppendsFor(db: DatabaseInterface, table: string) {
  await db.query(
    `CREATE TRIGGER append_gap_fail_${table} BEFORE INSERT ON _smrt_changes ` +
      `WHEN NEW.table_name = '${table}' BEGIN SELECT RAISE(ABORT, 'forced feed failure'); END`,
  );
}

async function restoreAppendsFor(db: DatabaseInterface, table: string) {
  await db.query(`DROP TRIGGER append_gap_fail_${table}`);
}

describe('a failed change-feed append is recorded as a table-level gap', () => {
  let db: DatabaseInterface;

  beforeEach(async () => {
    registerChangeFeedWriter();
    resetChangeFeedWarnings();
    resetChangeSignals();
    db = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      classes: ['AppendGapNote', 'AppendGapTag'],
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    resetChangeSignals();
    await db.close?.();
  });

  it('writes a table-level entry for the lost change on the next append', async () => {
    const notes = await AppendGapNoteCollection.create({ db });
    const tags = await AppendGapTagCollection.create({ db });
    await failAppendsFor(db, NOTES);
    const lost = await notes.create({ title: 'lost', tenantId: 'tenant-a' });
    expect(lost.id).toBeTruthy(); // the user's write still succeeded
    expect((await getChangesSince(db, { since: 0 })).changes).toEqual([]);
    await restoreAppendsFor(db, NOTES);

    const received: ChangeSignal[] = [];
    subscribeToChangeSignals(db, (signal) => received.push(signal));
    const next = await tags.create({ label: 'next' });

    const changes = (await getChangesSince(db, { since: 0 })).changes;
    expect(
      changes.map(({ table, rowId, operation, tenantId }) => ({
        table,
        rowId,
        operation,
        tenantId,
      })),
    ).toEqual([
      { table: NOTES, rowId: null, operation: 'update', tenantId: 'tenant-a' },
      { table: TAGS, rowId: next.id, operation: 'create', tenantId: null },
    ]);
    expect(received.map((signal) => [signal.table, signal.rowId])).toEqual([
      [NOTES, null],
      [TAGS, next.id],
    ]);
  });

  it('records one marker per table and tenant however many changes were lost', async () => {
    const notes = await AppendGapNoteCollection.create({ db });
    const tags = await AppendGapTagCollection.create({ db });
    await failAppendsFor(db, NOTES);
    await notes.create({ title: 'a1', tenantId: 'tenant-a' });
    await notes.create({ title: 'a2', tenantId: 'tenant-a' });
    await notes.create({ title: 'b1', tenantId: 'tenant-b' });
    await restoreAppendsFor(db, NOTES);
    await tags.create({ label: 'next' });

    const markers = (await getChangesSince(db, { since: 0 })).changes.filter(
      (change) => change.table === NOTES,
    );
    expect(markers.map(({ rowId, tenantId }) => ({ rowId, tenantId }))).toEqual(
      [
        { rowId: null, tenantId: 'tenant-a' },
        { rowId: null, tenantId: 'tenant-b' },
      ],
    );
  });

  it('keeps the marker pending while appends keep failing', async () => {
    const notes = await AppendGapNoteCollection.create({ db });
    await failAppendsFor(db, NOTES);
    await notes.create({ title: 'lost-1', tenantId: 'tenant-a' });
    await notes.create({ title: 'lost-2', tenantId: 'tenant-a' });
    expect((await getChangesSince(db, { since: 0 })).changes).toEqual([]);
    await restoreAppendsFor(db, NOTES);
    const kept = await notes.create({ title: 'kept', tenantId: 'tenant-a' });

    const changes = (await getChangesSince(db, { since: 0 })).changes;
    expect(changes.map((change) => change.rowId)).toEqual([null, kept.id]);
  });

  it('logs failures per table, not once per process', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const notes = await AppendGapNoteCollection.create({ db });
    const tags = await AppendGapTagCollection.create({ db });
    await failAppendsFor(db, NOTES);
    await failAppendsFor(db, TAGS);
    await notes.create({ title: 'n1' });
    await notes.create({ title: 'n2' });
    await tags.create({ label: 't1' });

    const feedWarnings = warn.mock.calls
      .map((call) => String(call[0]))
      .filter((message) => message.includes('failed to append'));
    expect(feedWarnings).toHaveLength(2);
    expect(feedWarnings[0]).toContain(NOTES);
    expect(feedWarnings[1]).toContain(TAGS);
  });

  it('appends no marker when nothing was lost', async () => {
    const tags = await AppendGapTagCollection.create({ db });
    const tag = await tags.create({ label: 'only' });
    const changes = (await getChangesSince(db, { since: 0 })).changes;
    expect(changes.map((change) => change.rowId)).toEqual([tag.id]);
  });
});

describe('gap markers survive transactions', () => {
  let db: DatabaseInterface | undefined;
  let dir: string | undefined;

  afterEach(async () => {
    resetChangeSignals();
    await db?.close?.();
    if (dir) rmSync(dir, { recursive: true, force: true });
    db = undefined;
    dir = undefined;
  });

  /** A framework-shaped instance double: the writer only reads these. */
  function instanceOn(handle: DatabaseInterface, table: string, id: string) {
    return {
      tableName: table,
      db: handle,
      id,
      constructor: Object,
    } as unknown as Parameters<typeof recordInstanceChange>[0];
  }

  async function open(url: string): Promise<DatabaseInterface> {
    registerChangeFeedWriter();
    resetChangeFeedWarnings();
    resetChangeSignals();
    db = await getTestDatabase({ type: 'sqlite', url, classes: [] });
    await getChangesSince(db, { since: 0 });
    return db;
  }

  it('keeps the marker when the next append runs in a raw transaction that rolls back', async () => {
    dir = mkdtempSync(join(tmpdir(), 'smrt-gap-raw-'));
    const root = await open(join(dir, 'feed.db'));
    await failAppendsFor(root, NOTES);
    await recordInstanceChange(instanceOn(root, NOTES, 'lost'));
    await restoreAppendsFor(root, NOTES);

    const received: ChangeSignal[] = [];
    subscribeToChangeSignals(root, (signal) => received.push(signal));
    const transaction = root.transaction?.bind(root);
    if (!transaction) throw new Error('sqlite handle without transactions');
    await expect(
      transaction(async (raw: DatabaseInterface) => {
        await recordInstanceChange(instanceOn(raw, TAGS, 'raw-write'));
        throw new Error('roll back');
      }),
    ).rejects.toThrow('roll back');
    // Nothing from the rolled-back transaction was announced.
    expect(received.filter((signal) => signal.rowId === null)).toEqual([]);

    await recordInstanceChange(instanceOn(root, TAGS, 'after'));
    const changes = (await getChangesSince(root, { since: 0 })).changes;
    expect(changes.map(({ table, rowId }) => [table, rowId])).toEqual([
      [NOTES, null],
      [TAGS, 'after'],
    ]);
  });

  it('flushes a marker recorded on a transaction handle of an in-memory database after commit', async () => {
    const root = await open(':memory:');
    // Drop the feed insert without failing the statement, so the append
    // fails in JavaScript (no row returned) and the transaction commits.
    await root.query(
      `CREATE TRIGGER append_gap_ignore BEFORE INSERT ON _smrt_changes ` +
        `WHEN NEW.table_name = '${NOTES}' BEGIN SELECT RAISE(IGNORE); END`,
    );
    await withEmbeddedWriteTransaction(root, true, async (tx) => {
      await recordInstanceChange(instanceOn(tx, NOTES, 'lost-in-tx'));
    });
    await root.query('DROP TRIGGER append_gap_ignore');

    await recordInstanceChange(instanceOn(root, TAGS, 'after'));
    const changes = (await getChangesSince(root, { since: 0 })).changes;
    expect(changes.map(({ table, rowId }) => [table, rowId])).toEqual([
      [NOTES, null],
      [TAGS, 'after'],
    ]);
  });

  it('writes a pending marker after the commit of a framework transaction, not inside it', async () => {
    const root = await open(':memory:');
    await failAppendsFor(root, NOTES);
    await recordInstanceChange(instanceOn(root, NOTES, 'lost'));
    await restoreAppendsFor(root, NOTES);

    await expect(
      withEmbeddedWriteTransaction(root, true, async (tx) => {
        await recordInstanceChange(instanceOn(tx, TAGS, 'rolled-back'));
        throw new Error('roll back');
      }),
    ).rejects.toThrow('roll back');
    expect((await getChangesSince(root, { since: 0 })).changes).toEqual([]);

    await withEmbeddedWriteTransaction(root, true, async (tx) => {
      await recordInstanceChange(instanceOn(tx, TAGS, 'committed'));
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const changes = (await getChangesSince(root, { since: 0 })).changes;
    expect(changes.map(({ table, rowId }) => [table, rowId])).toEqual([
      [TAGS, 'committed'],
      [NOTES, null],
    ]);
  });
});

describe('gap markers: commit ordering, database identity, authorization and overflow', () => {
  let db: DatabaseInterface | undefined;
  let dir: string | undefined;
  let previousLimit: number | undefined;

  afterEach(async () => {
    setChangeFeedEntryVisibility(undefined);
    if (previousLimit !== undefined) {
      setChangeFeedGapMarkerLimitForTesting(previousLimit);
      previousLimit = undefined;
    }
    resetChangeSignals();
    await db?.close?.();
    if (dir) rmSync(dir, { recursive: true, force: true });
    db = undefined;
    dir = undefined;
  });

  function instanceOn(
    handle: DatabaseInterface,
    table: string,
    id: string,
    tenantId: string | null = null,
  ) {
    return {
      tableName: table,
      db: handle,
      id,
      tenantId,
      constructor: Object,
    } as unknown as Parameters<typeof recordInstanceChange>[0];
  }

  async function open(url: string): Promise<DatabaseInterface> {
    registerChangeFeedWriter();
    resetChangeFeedWarnings();
    resetChangeSignals();
    db = await getTestDatabase({ type: 'sqlite', url, classes: [] });
    await getChangesSince(db, { since: 0 });
    return db;
  }

  /** Drop the feed insert for `table` without failing the statement. */
  async function ignoreAppendsFor(handle: DatabaseInterface, table: string) {
    await handle.query(
      `CREATE TRIGGER append_gap_ignore_${table} BEFORE INSERT ON _smrt_changes ` +
        `WHEN NEW.table_name = '${table}' BEGIN SELECT RAISE(IGNORE); END`,
    );
  }

  async function restoreIgnoredAppendsFor(
    handle: DatabaseInterface,
    table: string,
  ) {
    await handle.query(`DROP TRIGGER append_gap_ignore_${table}`);
  }

  const settle = () => new Promise((resolve) => setTimeout(resolve, 40));

  it('writes a post-commit marker outside the next queued transaction, which then rolls back', async () => {
    const real = await open(':memory:');
    // Slow the marker insert down so the next queued transaction has begun
    // by the time it is issued — the interleaving the post-commit flush must
    // survive.
    const root = new Proxy(real, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (prop === 'query' && typeof value === 'function') {
          return async (sql: string, ...args: unknown[]) => {
            if (
              /json_each/.test(sql) &&
              String(args[0]).includes('"rowId":null')
            ) {
              await new Promise((resolve) => setTimeout(resolve, 60));
            }
            return value.call(target, sql, ...args);
          };
        }
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as DatabaseInterface;
    await failAppendsFor(root, NOTES);
    await recordInstanceChange(instanceOn(root, NOTES, 'lost'));
    await restoreAppendsFor(root, NOTES);

    const first = withEmbeddedWriteTransaction(root, true, async (tx) => {
      await recordInstanceChange(instanceOn(tx, TAGS, 'committed'));
    });
    const second = withEmbeddedWriteTransaction(root, true, async (tx) => {
      await recordInstanceChange(instanceOn(tx, TAGS, 'rolled-back'));
      await new Promise((resolve) => setTimeout(resolve, 120));
      throw new Error('roll back');
    });
    await first;
    await expect(second).rejects.toThrow('roll back');
    await new Promise((resolve) => setTimeout(resolve, 150));

    const changes = (await getChangesSince(root, { since: 0 })).changes;
    expect(changes.map(({ table, rowId }) => [table, rowId])).toEqual([
      [TAGS, 'committed'],
      [NOTES, null],
    ]);
  });

  it('recovers a gap recorded on a raw transaction handle through the root, after that handle is gone', async () => {
    dir = mkdtempSync(join(tmpdir(), 'smrt-gap-identity-'));
    const root = await open(join(dir, 'feed.db'));
    await recordInstanceChange(instanceOn(root, TAGS, 'before'));
    await ignoreAppendsFor(root, NOTES);
    const transaction = root.transaction?.bind(root);
    if (!transaction) throw new Error('sqlite handle without transactions');
    await transaction(async (raw: DatabaseInterface) => {
      await recordInstanceChange(instanceOn(raw, NOTES, 'lost-in-raw'));
    });
    await restoreIgnoredAppendsFor(root, NOTES);

    await recordInstanceChange(instanceOn(root, TAGS, 'after'));
    const changes = (await getChangesSince(root, { since: 0 })).changes;
    expect(changes.map(({ table, rowId }) => [table, rowId])).toEqual([
      [TAGS, 'before'],
      [NOTES, null],
      [TAGS, 'after'],
    ]);
  });

  it('delivers a marker to a principal whose row hook allows only its own row ids', async () => {
    const root = await open(':memory:');
    await recordInstanceChange(instanceOn(root, NOTES, 'own-row'));
    await failAppendsFor(root, NOTES);
    await recordInstanceChange(instanceOn(root, NOTES, 'own-row'));
    await restoreAppendsFor(root, NOTES);
    await recordInstanceChange(instanceOn(root, NOTES, 'other-row'));
    setChangeFeedEntryVisibility(({ entry }) => entry.rowId === 'own-row');

    const page = await getAuthorizedChangesSince(root, {
      since: 0,
      locals: undefined,
    });
    expect(page.changes.map((change) => change.rowId)).toEqual([
      'own-row',
      null,
    ]);

    const stream = buildChangeEventStream(root, {
      cursor: 0,
      tenantScope: { enforced: false, tenantId: null },
    });
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let text = '';
    const deadline = Date.now() + 2000;
    while (!text.includes('"rowId":null') && Date.now() < deadline) {
      const result = await Promise.race([
        reader.read(),
        new Promise<'timeout'>((resolve) =>
          setTimeout(() => resolve('timeout'), 200),
        ),
      ]);
      if (result === 'timeout' || result.done) continue;
      text += decoder.decode(result.value, { stream: true });
    }
    await reader.cancel();
    expect(text).toContain('"rowId":null');
    expect(text).not.toContain('other-row');
  });

  it('past the bound, keeps one marker per table for every tenant instead of dropping pairs', async () => {
    const root = await open(':memory:');
    previousLimit = setChangeFeedGapMarkerLimitForTesting(2);
    await failAppendsFor(root, NOTES);
    await failAppendsFor(root, TAGS);
    await recordInstanceChange(instanceOn(root, NOTES, 'a', 'tenant-a'));
    await recordInstanceChange(instanceOn(root, NOTES, 'b', 'tenant-b'));
    // The third distinct pair is over the bound.
    await recordInstanceChange(instanceOn(root, NOTES, 'c', 'tenant-c'));
    await recordInstanceChange(instanceOn(root, TAGS, 'd', 'tenant-d'));
    await restoreAppendsFor(root, NOTES);
    await restoreAppendsFor(root, TAGS);
    await recordInstanceChange(instanceOn(root, 'append_gap_other', 'next'));

    const changes = (await getChangesSince(root, { since: 0 })).changes;
    expect(
      changes
        .filter((change) => change.rowId === null)
        .map(({ table, tenantId }) => [table, tenantId])
        .sort(),
    ).toEqual([
      [NOTES, null],
      [TAGS, null],
    ]);
    // A tenant first lost past the bound still gets a refetch notice.
    const tenantC = await getChangesSince(root, {
      since: 0,
      tenantId: 'tenant-c',
    });
    expect(
      tenantC.changes.some(
        (change) => change.table === NOTES && change.rowId === null,
      ),
    ).toBe(true);
  });
});
