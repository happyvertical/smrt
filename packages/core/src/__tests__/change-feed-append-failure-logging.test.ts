/**
 * A change whose feed append fails is dropped and never fails the user's
 * write (#2026). Its warning is rate-limited per table — at most once a minute
 * per database and table, with a count of what was suppressed — rather than
 * logged once for the whole process and then silenced.
 */
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getChangesSince,
  registerChangeFeedWriter,
  resetChangeFeedWarnings,
} from '../change-feed';
import { resetChangeSignals } from '../change-signals';
import { SmrtCollection } from '../collection';
import { SmrtObject } from '../object';
import { smrt } from '../registry';
import { getTestDatabase } from '../testing/database';

@smrt()
class AppendFailureNote extends SmrtObject {
  title: string = '';
}
class AppendFailureNoteCollection extends SmrtCollection<AppendFailureNote> {
  static readonly _itemClass = AppendFailureNote;
}

@smrt()
class AppendFailureTag extends SmrtObject {
  label: string = '';
}
class AppendFailureTagCollection extends SmrtCollection<AppendFailureTag> {
  static readonly _itemClass = AppendFailureTag;
}

const NOTES = 'append_failure_notes';
const TAGS = 'append_failure_tags';

async function failAppendsFor(db: DatabaseInterface, table: string) {
  await db.query(
    `CREATE TRIGGER append_failure_${table} BEFORE INSERT ON _smrt_changes ` +
      `WHEN NEW.table_name = '${table}' BEGIN SELECT RAISE(ABORT, 'forced feed failure'); END`,
  );
}

describe('a failed change-feed append is dropped with a rate-limited warning', () => {
  let db: DatabaseInterface;

  beforeEach(async () => {
    registerChangeFeedWriter();
    resetChangeFeedWarnings();
    resetChangeSignals();
    db = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      classes: ['AppendFailureNote', 'AppendFailureTag'],
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    resetChangeSignals();
    await db.close?.();
  });

  it('keeps the user write when the feed append fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const notes = await AppendFailureNoteCollection.create({ db });
    await failAppendsFor(db, NOTES);
    const note = await notes.create({ title: 'kept' });
    expect(note.id).toBeTruthy();
    expect(await notes.get({ id: note.id })).toBeTruthy();
    expect((await getChangesSince(db, { since: 0 })).changes).toEqual([]);
  });

  it('logs failures per table, not once per process', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const notes = await AppendFailureNoteCollection.create({ db });
    const tags = await AppendFailureTagCollection.create({ db });
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
});
