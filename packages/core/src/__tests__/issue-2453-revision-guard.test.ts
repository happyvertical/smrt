import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SmrtCollection } from '../collection';
import { field } from '../decorators';
import { GlobalInterceptors } from '../interceptors';
import { SmrtObject } from '../object';
import { ObjectRegistry, smrt } from '../registry';
import { getTestDatabase } from '../testing/database';

@smrt({ tableName: 'issue_2453_revision_rows' })
class Issue2453RevisionRow extends SmrtObject {
  @field()
  title: string = '';

  // Existing domain models may still expose these legacy camelCase aliases.
  // They share database columns with the framework timestamps and must not
  // prevent the framework revision token from hydrating.
  @field({ type: 'datetime' })
  createdAt = new Date();

  @field({ type: 'datetime' })
  updatedAt = new Date();
}

class Issue2453RevisionRows extends SmrtCollection<Issue2453RevisionRow> {
  static readonly _itemClass = Issue2453RevisionRow;
}

describe('issue #2453 revision-guarded saves', () => {
  let db: Awaited<ReturnType<typeof getTestDatabase>>;
  let rows: Issue2453RevisionRows;

  beforeEach(async () => {
    db = await getTestDatabase({ classes: ['Issue2453RevisionRow'] });
    ObjectRegistry.registerCollection(
      'Issue2453RevisionRow',
      Issue2453RevisionRows,
    );
    rows = (await Issue2453RevisionRows.create({
      db,
    })) as Issue2453RevisionRows;
  });

  afterEach(async () => {
    vi.useRealTimers();
    await db.close?.();
  });

  it('atomically rejects an update after another writer changes the row', async () => {
    const created = await rows.create({ title: 'original' });
    const first = await rows.get(String(created.id));
    if (!first) throw new Error('expected persisted row');

    const expectedUpdatedAt = first.updated_at;
    await db.update(
      'issue_2453_revision_rows',
      { id: created.id },
      {
        title: 'concurrent',
        updated_at: '2026-08-27T22:30:00.000Z',
      },
    );
    const [concurrentRow] = await db.list('issue_2453_revision_rows', {});
    expect((concurrentRow as Record<string, unknown>).updated_at).toBe(
      '2026-08-27T22:30:00.000Z',
    );

    first.title = 'stale overwrite';
    await expect(first.save({ expectedUpdatedAt })).rejects.toMatchObject({
      code: 'RUNTIME_REVISION_CONFLICT',
    });

    const stored = await rows.get(String(created.id));
    expect(stored?.title).toBe('concurrent');
  });

  it('hydrates the framework revision alongside legacy timestamp aliases', async () => {
    const created = await rows.create({ title: 'legacy timestamp model' });
    const hydrated = await rows.get(String(created.id));

    expect(hydrated?.updatedAt).toBeInstanceOf(Date);
    expect(hydrated?.updated_at).toBeInstanceOf(Date);
    expect(hydrated?.updated_at?.getTime()).toBe(hydrated?.updatedAt.getTime());
  });

  it('canonicalizes native DuckDB UUIDs for guarded saves and revision claims', async () => {
    const duckDb = await getTestDatabase({
      type: 'duckdb',
      url: ':memory:',
      classes: ['Issue2453RevisionRow'],
    });
    try {
      const duckRows = (await Issue2453RevisionRows.create({
        db: duckDb,
      })) as Issue2453RevisionRows;
      const created = await duckRows.create({ title: 'duckdb original' });
      const loaded = await duckRows.get(String(created.id));
      if (!loaded?.updated_at) throw new Error('expected persisted DuckDB row');

      expect(typeof loaded.id).toBe('string');
      loaded.title = 'duckdb guarded update';
      await loaded.save({ expectedUpdatedAt: loaded.updated_at });
      expect((await duckRows.get(String(created.id)))?.title).toBe(
        'duckdb guarded update',
      );

      const claimant = await duckRows.get(String(created.id));
      if (!claimant?.updated_at) throw new Error('expected updated DuckDB row');
      claimant.title = 'must not persist';
      await claimant.claimRevision(claimant.updated_at);
      expect((await duckRows.get(String(created.id)))?.title).toBe(
        'duckdb guarded update',
      );

      const direct = new Issue2453RevisionRow({
        db: duckDb,
        id: String(created.id),
      });
      await direct.initialize();
      expect(typeof direct.id).toBe('string');

      const bySlug = new Issue2453RevisionRow({
        db: duckDb,
        slug: created.slug,
        context: created.context,
      });
      await bySlug.initialize();
      expect(typeof bySlug.id).toBe('string');
      bySlug.title = 'duckdb slug update';
      await bySlug.save();

      const savedIdProbe = new Issue2453RevisionRow({ db: duckDb });
      await savedIdProbe.initialize();
      savedIdProbe.slug = created.slug;
      savedIdProbe.context = created.context;
      expect(typeof (await savedIdProbe.getSavedId())).toBe('string');
      expect(typeof (await savedIdProbe.getId())).toBe('string');

      const [rawHydrated] = await duckRows.query(
        'SELECT * FROM issue_2453_revision_rows WHERE id = ?',
        [String(created.id)],
      );
      expect(typeof rawHydrated.id).toBe('string');
      rawHydrated.title = 'duckdb raw query update';
      await rawHydrated.save();
      expect((await duckRows.get(String(created.id)))?.title).toBe(
        'duckdb raw query update',
      );

      await duckDb.query('CREATE SEQUENCE issue_2453_read_once START 1');
      const [commented] = await duckRows.query(
        `/* caller-authored query */ SELECT *, nextval('issue_2453_read_once') AS observed_sequence
         FROM issue_2453_revision_rows WHERE id = ?`,
        [String(created.id)],
      );
      expect(typeof commented.id).toBe('string');
      const [{ sequence_value: sequenceValue }] = await duckDb
        .query(`SELECT currval('issue_2453_read_once') AS sequence_value`)
        .then((result) => result.rows);
      expect(
        Number(
          sequenceValue && typeof sequenceValue === 'object'
            ? (sequenceValue as { hugeint?: number }).hugeint
            : sequenceValue,
        ),
      ).toBe(1);
    } finally {
      await duckDb.close?.();
    }
  });

  it('hydrates one coherent DuckDB natural-key snapshot after replacement', async () => {
    const duckDb = await getTestDatabase({
      type: 'duckdb',
      url: ':memory:',
      classes: ['Issue2453RevisionRow'],
    });
    try {
      const duckRows = (await Issue2453RevisionRows.create({
        db: duckDb,
      })) as Issue2453RevisionRows;
      const original = await duckRows.create({ title: 'old snapshot' });
      const replacementId = '77777777-7777-4777-8777-777777777777';
      const rawQuery = duckDb.query.bind(duckDb);
      let replaced = false;
      vi.spyOn(duckDb, 'query').mockImplementation(async (sql, ...params) => {
        if (
          !replaced &&
          sql.startsWith('DESCRIBE SELECT * FROM') &&
          params[0] === original.slug
        ) {
          replaced = true;
          await rawQuery(
            `UPDATE issue_2453_revision_rows
             SET id = CAST(? AS UUID), title = ?
             WHERE id = CAST(? AS UUID)`,
            replacementId,
            'new snapshot',
            String(original.id),
          );
        }
        return await rawQuery(sql, ...params);
      });

      const loaded = new Issue2453RevisionRow({
        db: duckDb,
        slug: original.slug,
        context: original.context,
      });
      await loaded.initialize();

      expect(replaced).toBe(true);
      expect(loaded.id).toBe(replacementId);
      expect(loaded.title).toBe('new snapshot');
    } finally {
      await duckDb.close?.();
    }
  });

  it('uses conditional updates for remote LibSQL revision guards', async () => {
    const created = await rows.create({ title: 'original' });
    const first = await rows.get(String(created.id));
    const stale = await rows.get(String(created.id));
    if (!first?.updated_at || !stale?.updated_at) {
      throw new Error('expected two persisted snapshots');
    }
    const expectedUpdatedAt = first.updated_at;
    const originalUrl = db.url;
    db.url = 'libsql://shared.turso.io';
    const update = vi.spyOn(db, 'update');
    const upsert = vi.spyOn(db, 'upsert');

    try {
      first.title = 'winner';
      await first.save({ expectedUpdatedAt });
      stale.title = 'stale overwrite';
      await expect(stale.save({ expectedUpdatedAt })).rejects.toMatchObject({
        code: 'RUNTIME_REVISION_CONFLICT',
      });
      const claimant = await rows.get(String(created.id));
      if (!claimant?.updated_at) throw new Error('expected winning revision');
      claimant.title = 'claim must not persist this';
      await claimant.claimRevision(claimant.updated_at);

      expect(update).toHaveBeenCalledWith(
        'issue_2453_revision_rows',
        {
          id: created.id,
          updated_at: expectedUpdatedAt.toISOString(),
        },
        expect.objectContaining({ title: 'winner' }),
      );
      expect(
        upsert.mock.calls.some(
          ([table]) => table === 'issue_2453_revision_rows',
        ),
      ).toBe(false);
      expect((await rows.get(String(created.id)))?.title).toBe('winner');
    } finally {
      db.url = originalUrl;
    }
  });

  it('advances an ordinary save so a same-millisecond stale writer is rejected', async () => {
    const created = await rows.create({ title: 'original' });
    const first = await rows.get(String(created.id));
    const stale = await rows.get(String(created.id));
    if (!first || !stale || !first.updated_at) {
      throw new Error('expected two persisted snapshots');
    }
    const expectedUpdatedAt = first.updated_at;
    const expectedTime = new Date(expectedUpdatedAt).getTime();
    vi.useFakeTimers();
    vi.setSystemTime(expectedTime);

    first.title = 'first writer';
    await first.save();

    expect((await rows.get(String(created.id)))?.updated_at?.getTime()).toBe(
      expectedTime + 1,
    );

    stale.title = 'second ordinary writer';
    await expect(stale.save()).rejects.toMatchObject({
      code: 'RUNTIME_REVISION_CONFLICT',
    });
    expect((await rows.get(String(created.id)))?.updated_at?.getTime()).toBe(
      expectedTime + 1,
    );

    stale.title = 'stale overwrite';
    await expect(stale.save({ expectedUpdatedAt })).rejects.toMatchObject({
      code: 'RUNTIME_REVISION_CONFLICT',
    });
    expect((await rows.get(String(created.id)))?.title).toBe('first writer');
  });

  it('restores the loaded revision after a failed write so the same instance can retry', async () => {
    const first = await rows.create({ title: 'first' });
    const second = await rows.create({ title: 'second' });
    const retrying = await rows.get(String(second.id));
    if (!first.slug || !retrying?.updated_at) {
      throw new Error('expected persisted rows');
    }
    const loadedRevision = retrying.updated_at.getTime();

    retrying.slug = first.slug;
    await expect(retrying.save()).rejects.toMatchObject({
      code: 'VALIDATION_UNIQUE_CONSTRAINT',
    });
    expect(retrying.updated_at.getTime()).toBe(loadedRevision);

    retrying.slug = 'retry-after-unique-conflict';
    retrying.title = 'retried';
    await expect(retrying.save()).resolves.toBe(retrying);
    expect((await rows.get(String(second.id)))?.title).toBe('retried');
  });

  it('does not advance unrelated revisions after a future-dated CAS fails', async () => {
    const staleTarget = await rows.create({ title: 'stale target' });
    const unrelated = await rows.create({ title: 'unrelated' });
    const claimant = await rows.get(String(staleTarget.id));
    const writer = await rows.get(String(unrelated.id));
    if (!claimant?.updated_at || !writer?.updated_at) {
      throw new Error('expected persisted rows');
    }
    const writerRevision = writer.updated_at.getTime();
    vi.useFakeTimers();
    vi.setSystemTime(writerRevision);

    await expect(
      claimant.claimRevision('2999-01-01T00:00:00.000Z'),
    ).rejects.toMatchObject({ code: 'RUNTIME_REVISION_CONFLICT' });

    writer.title = 'unrelated update';
    await writer.save();
    expect(writer.updated_at.getTime()).toBe(writerRevision + 1);
  });

  it('claims a revision without persisting other in-memory mutations', async () => {
    const created = await rows.create({ title: 'original' });
    const claimant = await rows.get(String(created.id));
    if (!claimant?.updated_at) {
      throw new Error('expected persisted row');
    }
    const expectedUpdatedAt = claimant.updated_at;
    const expectedTime = new Date(expectedUpdatedAt).getTime();
    vi.useFakeTimers();
    vi.setSystemTime(expectedTime);
    claimant.title = 'must not persist';

    await claimant.claimRevision(expectedUpdatedAt);

    const stored = await rows.get(String(created.id));
    expect(stored?.title).toBe('original');
    expect(stored?.updated_at?.getTime()).toBe(expectedTime + 1);
  });

  it('runs tenant save interception before claiming a revision', async () => {
    const created = await rows.create({ title: 'original' });
    const claimant = await rows.get(String(created.id));
    if (!claimant?.updated_at) {
      throw new Error('expected persisted row');
    }
    const originalRevision = claimant.updated_at.getTime();
    GlobalInterceptors.register({
      name: 'issue-2453-tenant-denial',
      beforeSave() {
        throw Object.assign(new Error('tenant denied'), {
          code: 'TENANT_ISOLATION_VIOLATION',
        });
      },
    });

    try {
      await expect(
        claimant.claimRevision(claimant.updated_at),
      ).rejects.toMatchObject({ code: 'TENANT_ISOLATION_VIOLATION' });
    } finally {
      GlobalInterceptors.unregister('issue-2453-tenant-denial');
    }

    const stored = await rows.get(String(created.id));
    expect(stored?.updated_at?.getTime()).toBe(originalRevision);
  });
});
