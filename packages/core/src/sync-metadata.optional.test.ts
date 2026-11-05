import { type DatabaseInterface, getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pruneChangeFeed } from './change-feed';
import { SmrtCollection } from './collection';
import { crossPackageRef } from './decorators';
import { GlobalInterceptors } from './interceptors';
import { generateSchemaDiff, getSQLFromDiff } from './migrations/differ';
import { SmrtObject } from './object';
import { smrt } from './registry';
import { setDatabaseSyncDeviceId } from './sync-device';
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

@smrt()
class SyncCascadeChild extends SmrtObject {
  @crossPackageRef('@happyvertical/smrt-core:SyncNote', { onDelete: 'CASCADE' })
  noteId?: string;
}

@smrt()
class SyncNullableChild extends SmrtObject {
  @crossPackageRef('@happyvertical/smrt-core:SyncNote', {
    onDelete: 'SET NULL',
  })
  noteId?: string;
}

@smrt({ tableStrategy: 'sti' })
class SyncEntry extends SmrtObject {
  tenantId?: string;
  title = '';
}

@smrt()
class SyncDraft extends SyncEntry {
  text = '';
}

class SyncEntries extends SmrtCollection<SyncEntry> {
  static readonly _itemClass = SyncEntry;
}

const localDeviceId = '58bcae20-95bc-4e4f-8349-8779ed18dce4';
const libsqlUrl = process.env.SMRT_TEST_LIBSQL_URL;
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
        : type === 'libsql' && libsqlUrl
          ? { db: await getDatabase({ type: 'sqlite', url: libsqlUrl }) }
          : { type: type === 'libsql' ? 'sqlite' : type }),
      classes: [
        'SyncNote',
        'SyncEntry',
        'SyncDraft',
        'SyncIdRecord',
        'SyncOptionalKey',
        'SyncCascadeChild',
        'SyncNullableChild',
      ],
    });
    // Exercise the remote selection against a real SQLite executor without
    // requiring a Turso service.
    if (type === 'libsql' && !libsqlUrl) db.url = 'libsql://sync-test.invalid';
    setDatabaseSyncDeviceId(db, localDeviceId);
    notes = await SyncNotes.create({ db });
  });

  afterEach(async () => {
    if (type === 'libsql' && libsqlUrl) {
      for (const table of [
        'sync_cascade_children',
        'sync_nullable_children',
        'sync_notes',
        'sync_entries',
        'sync_id_records',
        'sync_optional_keys',
      ]) {
        await db?.query(`DROP TABLE IF EXISTS ${table}`);
      }
    }
    if (type === 'postgres') {
      await db?.query(
        'DROP TABLE IF EXISTS sync_cascade_children, sync_nullable_children, sync_notes, sync_entries, sync_id_records, sync_optional_keys, sync_wide_migration',
      );
    }
    await db?.close?.();
  });

  it('advances local revisions, preserves incoming revisions and guards stale writers', async () => {
    const note = await notes.create({ title: 'note' });
    expect(note.syncMetadata).toBeNull();
    await note.save({ trackSync: true });
    expect(note.syncMetadata?.revision).toBe(1);

    const loaded = await notes.get({ id: note.id });
    const stale = await notes.get({ id: note.id });
    if (!loaded || !stale) throw new Error('Expected persisted note');
    expect(loaded.syncMetadata).toEqual({
      originDeviceId: localDeviceId,
      revision: 1,
      tombstone: false,
    });
    await loaded.save();
    expect(loaded.syncMetadata).toMatchObject({
      originDeviceId: localDeviceId,
      revision: 2,
    });
    await loaded.save({
      sync: { originDeviceId: 'device-b', revision: 712 },
    });
    await expect(stale.save()).rejects.toMatchObject({
      code: 'RUNTIME_REVISION_CONFLICT',
    });
    expect(stale.syncMetadata?.revision).toBe(1);
    await expect(
      loaded.save({ sync: { originDeviceId: 'device-a', revision: 712 } }),
    ).rejects.toMatchObject({
      code: 'RUNTIME_SYNC_REVISION_CONFLICT',
    });
    if (!loaded.updated_at) throw new Error('Expected row timestamp');
    await loaded.claimRevision(loaded.updated_at);
    expect(loaded.syncMetadata).toMatchObject({
      revision: 713,
      originDeviceId: localDeviceId,
    });
    await loaded.delete();
    expect(await notes.get({ id: note.id })).toBeNull();
    if (type !== 'postgres') await pruneChangeFeed(db, { maxRows: 1 });
    const tombstone = await db.get('_smrt_sync_tombstones', {
      table_name: 'sync_notes',
      row_id: note.id,
    });
    expect(Number(tombstone?.revision)).toBe(714);
    expect(tombstone?.origin_device_id).toBe(localDeviceId);
    const replacement = await notes.create({
      title: 'replacement',
      slug: note.slug,
    });
    expect(replacement.id).not.toBe(note.id);
  });

  it('records tracked cascades and advances tracked SET NULL references', async () => {
    const note = await notes.create({ title: 'parent' });
    const cascade = new SyncCascadeChild({
      db,
      id: crypto.randomUUID(),
      _skipLoad: true,
    });
    const nullable = new SyncNullableChild({
      db,
      id: crypto.randomUUID(),
      _skipLoad: true,
    });
    await cascade.initialize();
    await nullable.initialize();
    cascade.noteId = note.id as string;
    nullable.noteId = note.id as string;
    await cascade.save({ sync: { originDeviceId: 'remote', revision: 12 } });
    await nullable.save({ sync: { originDeviceId: 'remote', revision: 21 } });
    await note.delete();
    expect(await db.get(cascade.tableName, { id: cascade.id })).toBeNull();
    expect(
      await db.get('_smrt_sync_tombstones', {
        table_name: cascade.tableName,
        row_id: cascade.id,
      }),
    ).toMatchObject({ origin_device_id: localDeviceId });
    const updated = await db.get(nullable.tableName, { id: nullable.id });
    expect(updated).toMatchObject({
      note_id: null,
      _sync_origin_device_id: localDeviceId,
    });
    expect(Number(updated?._sync_revision)).toBe(22);
    await expect(nullable.save()).rejects.toMatchObject({
      code: 'RUNTIME_REVISION_CONFLICT',
    });
  });

  if (type === 'duckdb' || type === 'postgres') {
    it('creates and adds wide revision columns on the native backend', async () => {
      const revision = 2 ** 32 + 19;
      const note = await notes.create({ title: 'wide revision' });
      await note.save({ sync: { originDeviceId: 'remote', revision } });
      expect((await notes.get({ id: note.id }))?.syncMetadata?.revision).toBe(
        revision,
      );
      const table = 'sync_wide_migration';
      await db.query('CREATE TABLE sync_wide_migration (id TEXT PRIMARY KEY)');
      const diff = await generateSchemaDiff(db, {
        [table]: {
          tableName: table,
          indexes: [],
          triggers: [],
          foreignKeys: [],
          version: 'test',
          dependencies: [],
          columns: {
            id: { type: 'TEXT', primaryKey: true },
            _sync_revision: { type: 'INTEGER' },
          },
        },
      });
      for (const statement of getSQLFromDiff(diff)) await db.query(statement);
      await db.insert(table, {
        id: 'wide',
        _sync_revision: type === 'duckdb' ? BigInt(revision) : revision,
      });
      expect(
        Number((await db.get(table, { id: 'wide' }))?._sync_revision),
      ).toBe(revision);
      const { rows } = await db.query(
        "SELECT table_name, data_type FROM information_schema.columns WHERE table_name IN ('sync_notes', 'sync_wide_migration') AND column_name = '_sync_revision' ORDER BY table_name",
      );
      expect(rows.map((row) => String(row.data_type).toUpperCase())).toEqual([
        'BIGINT',
        'BIGINT',
      ]);
    });
  }

  it('records an absent incoming tombstone and rejects same-id snapshots', async () => {
    const id = crypto.randomUUID();
    const make = async () => {
      const note = new SyncNote({ db, _skipLoad: true, id, title: 'snapshot' });
      await note.initialize();
      return note;
    };
    await (await make()).delete({
      sync: { originDeviceId: 'remote', revision: 12 },
    });
    for (const revision of [11, 13]) {
      await expect(
        (await make()).save({ sync: { originDeviceId: 'remote', revision } }),
      ).rejects.toMatchObject({
        code: 'RUNTIME_SYNC_REVISION_CONFLICT',
      });
    }
    await expect((await make()).save()).rejects.toMatchObject({
      code: 'RUNTIME_SYNC_REVISION_CONFLICT',
    });
    const reassigned = new SyncNote({ db, _skipLoad: true });
    await reassigned.initialize();
    reassigned.id = id;
    reassigned.id = id;
    await expect(reassigned.save()).rejects.toMatchObject({
      code: 'RUNTIME_SYNC_REVISION_CONFLICT',
    });
    expect(await notes.get({ id })).toBeNull();
    const local = await notes.create({ title: 'local' });
    await local.save({ trackSync: true });
    await local.save();
    expect(local.syncMetadata).toMatchObject({
      originDeviceId: localDeviceId,
      revision: 2,
    });
  });

  it('denies a guarded absent incoming delete without reserving the identity', async () => {
    const id = crypto.randomUUID();
    const note = new SyncNote({ db, id, _skipLoad: true, title: 'allowed' });
    await note.initialize();
    const interceptor = {
      name: 'sync-note-title-guard',
      writeGuard: (instance: SmrtObject) =>
        instance instanceof SyncNote ? { title: 'allowed' } : undefined,
    };
    GlobalInterceptors.register(interceptor);
    try {
      await expect(
        note.delete({ sync: { originDeviceId: 'remote', revision: 12 } }),
      ).rejects.toMatchObject({ code: 'RUNTIME_REVISION_CONFLICT' });
      expect(
        await db.get('_smrt_sync_tombstones', {
          table_name: note.tableName,
          row_id: id,
        }),
      ).toBeNull();
      await note.save({ sync: { originDeviceId: 'remote', revision: 11 } });
      expect(await notes.get({ id })).toMatchObject({
        title: 'allowed',
        syncMetadata: { revision: 11 },
      });
    } finally {
      GlobalInterceptors.unregister(interceptor);
    }
  });

  it('retains the tenant and qualified model of an incoming tombstone', async () => {
    const id = crypto.randomUUID();
    const owner = crypto.randomUUID();
    const incoming = new SyncDraft({ db, id, _skipLoad: true });
    await incoming.initialize();
    incoming.tenantId = owner;
    await incoming.delete({ sync: { originDeviceId: 'remote', revision: 11 } });

    const wrongTenant = new SyncDraft({ db, id, _skipLoad: true });
    await wrongTenant.initialize();
    wrongTenant.tenantId = crypto.randomUUID();
    await expect(
      wrongTenant.delete({ sync: { originDeviceId: 'remote', revision: 12 } }),
    ).rejects.toMatchObject({ code: 'RUNTIME_SYNC_REVISION_CONFLICT' });

    const wrongModel = new SyncEntry({ db, id, _skipLoad: true });
    await wrongModel.initialize();
    wrongModel.tenantId = owner;
    await expect(
      wrongModel.delete({ sync: { originDeviceId: 'remote', revision: 12 } }),
    ).rejects.toMatchObject({ code: 'RUNTIME_SYNC_REVISION_CONFLICT' });
    const tombstone = await db.get('_smrt_sync_tombstones', {
      table_name: 'sync_entries',
      row_id: id,
    });
    expect(tombstone).toMatchObject({
      model: '@happyvertical/smrt-core:SyncDraft',
      tenant_id: owner,
    });
    expect(Number(tombstone?.revision)).toBe(11);
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
    await tracked.save({ sync: { originDeviceId: 'device-a', revision: 1 } });
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

  if (type === 'postgres' || type === 'libsql') {
    it('refuses a nullable-key write when a tracked row appears after its probe', async () => {
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
        _skipLoad: true,
        title: 'overwrite',
        externalKey: null,
      });
      await attacker.initialize();
      const observeProbe = (reader: DatabaseInterface) => {
        const get = reader.get.bind(reader);
        return vi
          .spyOn(reader, 'get')
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
              await tracked.save({
                sync: { originDeviceId: 'other-device', revision: 1 },
              });
            }
            return result;
          });
      };
      const transaction = db.transaction?.bind(db);
      if (!transaction) throw new Error('Transaction support is required');
      // PostgreSQL rechecks under the advisory lock. Inject after that
      // bound probe so the insert must decline the racing tracked row.
      const spy =
        type === 'postgres'
          ? vi.spyOn(db, 'transaction').mockImplementation((work) =>
              transaction(async (tx) => {
                const probe = observeProbe(tx);
                try {
                  return await work(tx);
                } finally {
                  probe.mockRestore();
                }
              }),
            )
          : observeProbe(db);
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
    it('returns one canonical identity for parallel nullable-key saves', async () => {
      const inputs = await Promise.all(
        Array.from({ length: 8 }, (_, index) =>
          new SyncOptionalKey({
            db,
            id: crypto.randomUUID(),
            _skipLoad: true,
            externalKey: null,
            title: `writer ${index}`,
            created_at: new Date(Date.UTC(2026, 0, index + 1)),
          }).initialize(),
        ),
      );
      await Promise.all(inputs.map((row) => row.save()));
      const stored = await db.list('sync_optional_keys', {
        external_key: null,
      });
      expect(stored).toHaveLength(1);
      expect(new Set(inputs.map((row) => row.id))).toEqual(
        new Set([stored[0].id]),
      );
      const createdAt = new Date(stored[0].created_at).toISOString();
      expect(
        new Set(inputs.map((row) => row.created_at?.toISOString())),
      ).toEqual(new Set([createdAt]));
    });

    it('guards the conflicting row if another connection begins tracking it before the write', async () => {
      const records = await SyncIdRecords.create({ db });
      const { id } = await records.create({ title: 'original' });
      const writer = await getDatabase({
        type,
        url: postgresUrl,
        dbid: crypto.randomUUID(),
      });
      const transaction = db.transaction?.bind(db);
      if (!transaction) throw new Error('Transaction support is required');
      let interleaved = false;
      const spy = vi.spyOn(db, 'transaction').mockImplementation((work) =>
        transaction(async (tx) => {
          const query = tx.query.bind(tx);
          const probe = vi
            .spyOn(tx, 'query')
            .mockImplementation(async (sql, ...params) => {
              if (
                sql.startsWith('INSERT INTO "sync_id_records"') &&
                sql.includes('DO UPDATE SET') &&
                !interleaved
              ) {
                const otherRecords = await SyncIdRecords.create({ db: writer });
                const row = await otherRecords.get({ id });
                if (!row) throw new Error('Expected persisted record');
                row.title = 'tracked update';
                await row.save({
                  sync: { originDeviceId: 'other-device', revision: 1 },
                });
                interleaved = true;
              }
              return query(sql, ...params);
            });
          try {
            return await work(tx);
          } finally {
            probe.mockRestore();
          }
        }),
      );
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
