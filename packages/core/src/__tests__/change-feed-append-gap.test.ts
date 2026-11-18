/**
 * A change whose feed append fails is still dropped (the user's write wins,
 * #2026), but the gap is recorded: the next append to the same database first
 * writes a table-level entry for the affected table and tenant, so consumers
 * of that table refetch it. Failure logging is rate-limited per table rather
 * than silenced for the process after the first one.
 */
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getChangesSince,
  registerChangeFeedWriter,
  resetChangeFeedWarnings,
} from '../change-feed';
import {
  type ChangeSignal,
  resetChangeSignals,
  subscribeToChangeSignals,
} from '../change-signals';
import { SmrtCollection } from '../collection';
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
