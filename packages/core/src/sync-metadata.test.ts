import { type DatabaseInterface, getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

@smrt({ conflictColumns: ['id'] })
class SyncIdRecord extends SmrtObject {
  title = '';
}

class SyncIdRecords extends SmrtCollection<SyncIdRecord> {
  static readonly _itemClass = SyncIdRecord;
}

@smrt({ conflictColumns: ['external_key'] })
class SyncOptionalKey extends SmrtObject {
  externalKey?: string | null;
  title = '';

  protected override transformJSON(data: Record<string, unknown>) {
    if (this.externalKey === undefined) delete data.externalKey;
    return super.transformJSON(data);
  }
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
const dialects: ('sqlite' | 'libsql' | 'duckdb' | 'postgres')[] = [
  'sqlite',
  'libsql',
  'duckdb',
];
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
        : { type: type === 'libsql' ? 'sqlite' : type }),
      classes: [
        'SyncNote',
        'SyncEntry',
        'SyncDraft',
        'SyncIdRecord',
        'SyncOptionalKey',
      ],
    });
    // Exercise the remote selection against a real SQLite executor without
    // requiring a Turso service.
    if (type === 'libsql') db.url = 'libsql://sync-test.invalid';
    notes = await SyncNotes.create({ db });
  });

  afterEach(async () => {
    if (type === 'postgres') {
      await db?.query(
        'DROP TABLE IF EXISTS sync_notes, sync_entries, sync_id_records, sync_optional_keys',
      );
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
  it('rejects unloaded ID writes to tracked rows and retains ordinary ID upserts', async () => {
    const records = await SyncIdRecords.create({ db });
    const id = crypto.randomUUID();
    const original = await records.create({ id, title: 'original' });
    await records.create({ id, title: 'ordinary update' });
    const untracked = await records.get({ id });
    expect(untracked?.title).toBe('ordinary update');
    expect(untracked?.syncMetadata).toBeNull();
    if (!untracked) throw new Error('Expected persisted record');
    await untracked.save({
      sync: { originDeviceId: 'device-a', revision: 10 },
    });

    const unloaded = new SyncIdRecord({
      db,
      id,
      _skipLoad: true,
      title: 'raw overwrite',
    });
    await unloaded.initialize();
    await expect(unloaded.save()).rejects.toMatchObject({
      code: 'RUNTIME_INVALID_STATE',
    });
    await expect(
      records.create({ id, title: 'collection overwrite' }),
    ).rejects.toMatchObject({
      code: 'RUNTIME_INVALID_STATE',
    });
    expect(await records.get({ id: original.id })).toMatchObject({
      title: 'ordinary update',
      syncMetadata: {
        originDeviceId: 'device-a',
        revision: 10,
        tombstone: false,
      },
    });
  });

  it('rejects unloaded writes when the natural conflict value is missing', async () => {
    const id = crypto.randomUUID();
    const tracked = new SyncOptionalKey({
      db,
      id,
      _skipLoad: true,
      title: 'original',
      externalKey: 'key',
    });
    await tracked.initialize();
    await tracked.save({ sync: { originDeviceId: 'device-a' } });
    const unloaded = new SyncOptionalKey({
      db,
      id,
      _skipLoad: true,
      title: 'overwrite',
    });
    await unloaded.initialize();
    await expect(unloaded.save()).rejects.toMatchObject({
      code: 'RUNTIME_INVALID_STATE',
    });
    const persisted = new SyncOptionalKey({ db, id });
    await persisted.initialize();
    expect(persisted).toMatchObject({
      title: 'original',
      syncMetadata: { revision: 1 },
    });
  });

  it('keeps ID upserts working on tables without sync metadata columns', async () => {
    const records = await SyncIdRecords.create({ db });
    await db.query('DROP TABLE sync_id_records');
    await db.query(`CREATE TABLE sync_id_records (
      id ${type === 'sqlite' || type === 'libsql' ? 'TEXT' : 'UUID'} PRIMARY KEY,
      slug TEXT, context TEXT, created_at TIMESTAMP, updated_at TIMESTAMP, title TEXT
    )`);
    const id = crypto.randomUUID();
    await records.create({ id, title: 'original' });
    await records.create({ id, title: 'ordinary update' });
    expect(await records.get({ id })).toMatchObject({
      title: 'ordinary update',
      syncMetadata: null,
    });
  });

  if (type === 'postgres' || type === 'libsql') {
    it('rolls back a nullable-key upsert when a tracked row appears after its probe', async () => {
      const writer =
        type === 'postgres'
          ? await getDatabase({
              type,
              url: postgresUrl,
              dbid: crypto.randomUUID(),
            })
          : db;
      let interleaved = false;
      const trackedId = crypto.randomUUID();
      const tracked = new SyncOptionalKey({
        db: writer,
        id: trackedId,
        _skipLoad: true,
        title: 'tracked',
        externalKey: null,
      });
      await tracked.initialize();
      const attacker = new SyncOptionalKey({
        db,
        id: crypto.randomUUID(),
        _skipLoad: true,
        title: 'overwrite',
        externalKey: null,
      });
      await attacker.initialize();
      const get = db.get.bind(db);
      const spy = vi
        .spyOn(db, 'get')
        .mockImplementation(async (table, filter) => {
          const result = await get(table, filter);
          if (
            table === 'sync_optional_keys' &&
            !Array.isArray(filter) &&
            filter.external_key === null &&
            !result &&
            !interleaved
          ) {
            interleaved = true;
            await tracked.save({ sync: { originDeviceId: 'other-device' } });
          }
          return result;
        });
      try {
        await expect(attacker.save()).rejects.toMatchObject({
          code: 'RUNTIME_INVALID_STATE',
        });
        expect(tracked.isPersisted).toBe(true);
        expect(await db.list('sync_optional_keys', {})).toEqual([
          expect.objectContaining({
            id: trackedId,
            title: 'tracked',
            _sync_origin_device_id: 'other-device',
            _sync_revision: expect.anything(),
          }),
        ]);
        expect(
          Number(
            (await db.get('sync_optional_keys', { id: trackedId }))
              ?._sync_revision,
          ),
        ).toBe(1);
      } finally {
        spy.mockRestore();
        if (writer !== db) await writer.close?.();
      }
    });
  }

  if (type === 'libsql') {
    it('guards an adopted row that becomes tracked between read and update', async () => {
      const existing = await notes.create({
        slug: 'shared',
        title: 'original',
      });
      const update = db.update.bind(db);
      let interleaved = false;
      const spy = vi
        .spyOn(db, 'update')
        .mockImplementation(async (table, filter, data) => {
          if (table === 'sync_notes') {
            await db.query(
              'UPDATE sync_notes SET _sync_origin_device_id = ?, _sync_revision = ?, title = ? WHERE id = ?',
              'other-device',
              1,
              'tracked update',
              existing.id,
            );
            interleaved = true;
          }
          return update(table, filter, data);
        });
      try {
        await expect(
          notes.create({ slug: 'shared', title: 'overwrite' }),
        ).rejects.toMatchObject({
          code: 'RUNTIME_INVALID_STATE',
        });
        expect(interleaved).toBe(true);
        expect(await notes.get({ id: existing.id })).toMatchObject({
          title: 'tracked update',
          syncMetadata: { originDeviceId: 'other-device', revision: 1 },
        });
      } finally {
        spy.mockRestore();
      }
    });
  }

  if (type === 'postgres') {
    it('guards the conflicting row if another connection begins tracking it before the write', async () => {
      const records = await SyncIdRecords.create({ db });
      const { id } = await records.create({ title: 'original' });
      const writer = await getDatabase({
        type,
        url: postgresUrl,
        dbid: crypto.randomUUID(),
      });
      const query = db.query.bind(db);
      const spy = vi.spyOn(db, 'query');
      let interleaved = false;
      spy.mockImplementation(async (sql, ...params) => {
        if (
          sql.startsWith('INSERT INTO "sync_id_records"') &&
          sql.includes('DO UPDATE SET')
        ) {
          const otherRecords = await SyncIdRecords.create({ db: writer });
          const row = await otherRecords.get({ id });
          if (!row) throw new Error('Expected persisted record');
          row.title = 'tracked update';
          await row.save({ sync: { originDeviceId: 'other-device' } });
          interleaved = true;
        }
        return query(sql, ...params);
      });
      try {
        await expect(
          records.create({ id, title: 'unloaded overwrite' }),
        ).rejects.toMatchObject({
          code: 'RUNTIME_INVALID_STATE',
        });
        expect(interleaved).toBe(true);
        expect(await records.get({ id })).toMatchObject({
          title: 'tracked update',
          syncMetadata: { originDeviceId: 'other-device', revision: 1 },
        });
      } finally {
        spy.mockRestore();
        await writer.close?.();
      }
    });
  }

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
