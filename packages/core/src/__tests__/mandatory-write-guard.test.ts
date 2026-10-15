/**
 * Mandatory write predicates must be part of every final persisted mutation.
 * The raw mode changes below model a policy change after hydration without
 * changing the revision, so a revision CAS alone cannot protect the write.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import { SmrtCollection } from '../collection.js';
import { field } from '../decorators/index.js';
import {
  type CollectionInterceptor,
  GlobalInterceptors,
} from '../interceptors.js';
import { SmrtObject } from '../object.js';
import { ObjectRegistry, smrt } from '../registry.js';
import { getTestDatabase } from '../testing/database.js';

@smrt({ tableName: 'mandatory_write_guard_records' })
class MandatoryWriteGuardRecord extends SmrtObject {
  @field({ type: 'text' })
  name: string = '';

  @field({ type: 'text' })
  accessMode: 'public' | 'private' = 'public';
}

class MandatoryWriteGuardRecords extends SmrtCollection<MandatoryWriteGuardRecord> {
  static readonly _itemClass = MandatoryWriteGuardRecord;
}

@smrt({ tableName: 'mandatory_write_guard_unguarded_records' })
class MandatoryWriteGuardUnguardedRecord extends SmrtObject {
  @field({ type: 'text' })
  name: string = '';
}

class MandatoryWriteGuardUnguardedRecords extends SmrtCollection<MandatoryWriteGuardUnguardedRecord> {
  static readonly _itemClass = MandatoryWriteGuardUnguardedRecord;
}

const mandatoryGuard: CollectionInterceptor = {
  name: 'mandatory-write-guard-test',
  writeGuard(instance) {
    return instance instanceof MandatoryWriteGuardRecord
      ? { access_mode: 'public' }
      : undefined;
  },
};

const dialects = [
  { name: 'SQLite', type: 'sqlite' as const },
  { name: 'DuckDB', type: 'duckdb' as const },
];

describe.each(dialects)('mandatory write guard (%s)', ({ type }) => {
  let db: Awaited<ReturnType<typeof getTestDatabase>>;
  let records: MandatoryWriteGuardRecords;
  let unguarded: MandatoryWriteGuardUnguardedRecords;

  beforeAll(() => {
    ObjectRegistry.registerCollection(
      'MandatoryWriteGuardRecord',
      MandatoryWriteGuardRecords,
    );
    ObjectRegistry.registerCollection(
      'MandatoryWriteGuardUnguardedRecord',
      MandatoryWriteGuardUnguardedRecords,
    );
    GlobalInterceptors.register(mandatoryGuard);
  });

  beforeEach(async () => {
    db = await getTestDatabase({
      type,
      url: ':memory:',
      classes: [
        'MandatoryWriteGuardRecord',
        'MandatoryWriteGuardUnguardedRecord',
      ],
    });
    records = (await MandatoryWriteGuardRecords.create({
      db,
    })) as MandatoryWriteGuardRecords;
    unguarded = (await MandatoryWriteGuardUnguardedRecords.create({
      db,
    })) as MandatoryWriteGuardUnguardedRecords;
  });

  afterEach(async () => {
    await db.close?.();
  });

  afterAll(() => {
    GlobalInterceptors.unregister(mandatoryGuard);
  });

  async function makePrivate(record: MandatoryWriteGuardRecord): Promise<void> {
    await db.update(
      'mandatory_write_guard_records',
      { id: record.id },
      { access_mode: 'private' },
    );
  }

  async function persisted(record: MandatoryWriteGuardRecord) {
    return (
      await db.query(
        'SELECT CAST(id AS VARCHAR) AS id, name, access_mode FROM mandatory_write_guard_records WHERE id = ?',
        record.id,
      )
    ).rows[0];
  }

  it('keeps ordinary public natural-key upserts working', async () => {
    const first = await records.create({
      slug: 'public-natural-key',
      name: 'first',
    });
    const second = await records.create({
      slug: 'public-natural-key',
      name: 'second',
    });

    expect(second.id).toBe(first.id);
    expect(await persisted(first)).toMatchObject({
      id: first.id,
      name: 'second',
      access_mode: 'public',
    });
  });

  it('refuses a public natural-key upsert that collides with a now-private row', async () => {
    const privateRow = await records.create({
      slug: 'private-natural-key',
      name: 'private original',
    });
    await makePrivate(privateRow);

    await expect(
      records.create({ slug: 'private-natural-key', name: 'must not replace' }),
    ).rejects.toThrow(/mandatory write predicate denied mutation/i);
    expect(await persisted(privateRow)).toMatchObject({
      id: privateRow.id,
      name: 'private original',
      access_mode: 'private',
    });
  });

  it('atomically denies ordinary and revision-CAS saves after a late policy change', async () => {
    const ordinary = await records.create({
      slug: 'ordinary-save',
      name: 'old',
    });
    await makePrivate(ordinary);
    ordinary.name = 'ordinary overwrite';
    await expect(ordinary.save()).rejects.toMatchObject({
      code: 'RUNTIME_REVISION_CONFLICT',
    });
    expect(await persisted(ordinary)).toMatchObject({
      name: 'old',
      access_mode: 'private',
    });

    const cas = await records.create({ slug: 'cas-save', name: 'old' });
    const expectedUpdatedAt = cas.updated_at;
    if (!expectedUpdatedAt)
      throw new Error('Persisted CAS fixture needs a revision');
    await makePrivate(cas);
    cas.name = 'cas overwrite';
    await expect(cas.save({ expectedUpdatedAt })).rejects.toMatchObject({
      code: 'RUNTIME_REVISION_CONFLICT',
    });
    expect(await persisted(cas)).toMatchObject({
      name: 'old',
      access_mode: 'private',
    });
  });

  it('atomically denies claimRevision and delete after a late policy change', async () => {
    const claimant = await records.create({ slug: 'claim', name: 'old' });
    const claimedRevision = claimant.updated_at;
    if (!claimedRevision)
      throw new Error('Persisted claim fixture needs a revision');
    await makePrivate(claimant);
    await expect(claimant.claimRevision(claimedRevision)).rejects.toMatchObject(
      {
        code: 'RUNTIME_REVISION_CONFLICT',
      },
    );
    expect(await persisted(claimant)).toMatchObject({ access_mode: 'private' });

    const deleting = await records.create({ slug: 'delete', name: 'old' });
    await makePrivate(deleting);
    await expect(deleting.delete()).rejects.toMatchObject({
      code: 'RUNTIME_REVISION_CONFLICT',
    });
    expect(await persisted(deleting)).toMatchObject({ access_mode: 'private' });
  });

  it('enforces the predicate through a transaction-bound executor', async () => {
    const record = await records.create({ slug: 'transaction', name: 'old' });
    await makePrivate(record);

    await expect(
      record.withTransaction(async (bound) => {
        bound.name = 'transaction overwrite';
        await bound.save();
      }),
    ).rejects.toMatchObject({ code: 'RUNTIME_REVISION_CONFLICT' });
    expect(await persisted(record)).toMatchObject({
      name: 'old',
      access_mode: 'private',
    });
  });

  it('leaves an unrelated unguarded model on its normal natural-key upsert path', async () => {
    const first = await unguarded.create({
      slug: 'unguarded-key',
      name: 'one',
    });
    const second = await unguarded.create({
      slug: 'unguarded-key',
      name: 'two',
    });

    expect(second.id).toBe(first.id);
    expect(
      await db.get('mandatory_write_guard_unguarded_records', { id: first.id }),
    ).toMatchObject({ name: 'two' });
  });
});
