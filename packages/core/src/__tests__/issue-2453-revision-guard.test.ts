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
