import { type DatabaseInterface, getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pruneChangeFeed } from './change-feed';
import { SmrtCollection } from './collection';
import { SmrtObject } from './object';
import { smrt } from './registry';
import { getTestDatabase } from './testing/database';

@smrt()
class SyncNote extends SmrtObject {
  title = '';
}

class SyncNotes extends SmrtCollection<SyncNote> {
  static readonly _itemClass = SyncNote;
}

@smrt({ tableStrategy: 'sti' })
class SyncEntry extends SmrtObject {
  title = '';
}

@smrt()
class SyncDraft extends SyncEntry {
  text = '';
}

class SyncEntries extends SmrtCollection<SyncEntry> {
  static readonly _itemClass = SyncEntry;
}

const postgresUrl = process.env.SMRT_TEST_POSTGRES_URL;
const dialects: ('sqlite' | 'duckdb' | 'postgres')[] = ['sqlite', 'duckdb'];
if (postgresUrl) dialects.push('postgres');

describe.each(dialects)('%s base-object sync metadata', (type) => {
  let db: DatabaseInterface;
  let notes: SyncNotes;

  beforeEach(async () => {
    db = await getTestDatabase({
      ...(type === 'postgres'
        ? {
            db: await getDatabase({
              type,
              url: postgresUrl,
              dbid: crypto.randomUUID(),
            }),
          }
        : { type }),
      classes: ['SyncNote', 'SyncEntry', 'SyncDraft'],
    });
    notes = await SyncNotes.create({ db });
  });

  afterEach(async () => {
    if (type === 'postgres') {
      await db?.query('DROP TABLE IF EXISTS sync_notes, sync_entries');
    }
    await db?.close?.();
  });

  it('advances local revisions, preserves incoming revisions and guards stale writers', async () => {
    const note = await notes.create({ title: 'note' });
    expect(note.syncMetadata).toBeNull();
    await note.save({ sync: { originDeviceId: 'device-a' } });
    expect(note.syncMetadata?.revision).toBe(1);

    const loaded = await notes.get({ id: note.id });
    const stale = await notes.get({ id: note.id });
    if (!loaded || !stale) throw new Error('Expected persisted note');
    expect(loaded.syncMetadata).toEqual({
      originDeviceId: 'device-a',
      revision: 1,
      tombstone: false,
    });
    await loaded.save();
    expect(loaded.syncMetadata?.revision).toBe(2);
    await loaded.save({
      sync: { originDeviceId: 'device-b', revision: 712, tombstone: true },
    });
    await expect(stale.save()).rejects.toMatchObject({
      code: 'RUNTIME_REVISION_CONFLICT',
    });
    expect(stale.syncMetadata?.revision).toBe(1);
    const tombstone = await notes.get({ id: note.id });
    if (!tombstone) throw new Error('Expected persisted tombstone');
    expect(tombstone.syncMetadata).toEqual({
      originDeviceId: 'device-b',
      revision: 712,
      tombstone: true,
    });
    if (type !== 'postgres') await pruneChangeFeed(db, { maxRows: 1 });
    expect((await notes.get({ id: note.id }))?.syncMetadata?.tombstone).toBe(
      true,
    );
    await tombstone.save();
    expect(tombstone.syncMetadata).toMatchObject({
      revision: 713,
      tombstone: true,
    });
    await tombstone.delete();
    expect(await notes.get({ id: note.id })).toBeNull();
  });

  it('strictly inserts tracked identities and restores metadata on rollback', async () => {
    const id = crypto.randomUUID();
    const note = new SyncNote({
      db,
      _skipLoad: true,
      id,
      title: 'incoming',
      slug: 'incoming',
    });
    await note.initialize();
    await expect(
      note.save({ sync: { originDeviceId: 'a', revision: 0 } }),
    ).rejects.toMatchObject({
      code: 'VALIDATION_SYNC_METADATA',
    });
    await note.save({ sync: { originDeviceId: 'a', revision: 81 } });
    const duplicate = new SyncNote({
      db,
      _skipLoad: true,
      id,
      title: 'duplicate',
      slug: 'duplicate',
    });
    await duplicate.initialize();
    await expect(
      duplicate.save({ sync: { originDeviceId: 'b', revision: 82 } }),
    ).rejects.toThrow();
    await expect(
      note.withTransaction(async (bound) => {
        await bound.save();
        expect(bound.syncMetadata?.revision).toBe(82);
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    expect(note.syncMetadata?.revision).toBe(81);
    expect((await notes.get({ id }))?.syncMetadata?.revision).toBe(81);
  });
  it('hydrates sync metadata from an STI row through the base collection', async () => {
    const id = crypto.randomUUID();
    const draft = new SyncDraft({ db, id, _skipLoad: true });
    await draft.initialize();
    await draft.save({ sync: { originDeviceId: 'device-b', revision: 99 } });
    const entries = await SyncEntries.create({ db });
    const loaded = await entries.get({ id });
    expect(loaded).toBeInstanceOf(SyncDraft);
    expect(loaded?.syncMetadata).toEqual({
      originDeviceId: 'device-b',
      revision: 99,
      tombstone: false,
    });
  });
});
