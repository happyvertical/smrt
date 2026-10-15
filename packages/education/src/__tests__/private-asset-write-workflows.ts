import { randomUUID } from 'node:crypto';
import {
  AssetCollection,
  withPrivateAssetAccess,
} from '@happyvertical/smrt-assets';
import { SmrtObject } from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/sql';
import { expect } from 'vitest';
import type { learnerFixture } from './learner-workflows.js';

type Fixture = Awaited<ReturnType<typeof learnerFixture>>;

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason?: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function privateAccess(f: Fixture, assetIds: readonly string[]) {
  return {
    tenantId: f.own.tenantId,
    actorUserId: f.own.actorUserId,
    ownerProfileId: String(f.alice.profile.id),
    assetIds,
  };
}

async function createPrivateAsset(
  f: Fixture,
  assets: AssetCollection,
  input: { id: string; slug: string; name: string; sourceUri: string },
) {
  return f.as(f.own, () =>
    withPrivateAssetAccess(privateAccess(f, [input.id]), () =>
      assets.create({
        ...input,
        accessMode: 'private',
        tenantId: f.own.tenantId,
        ownerProfileId: String(f.alice.profile.id),
      }),
    ),
  );
}

function insertSignalDb(
  db: DatabaseInterface,
  beforeAssetInsert: () => Promise<void>,
): DatabaseInterface {
  return new Proxy(db, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (property === 'insert') {
        return async (table: string, data: Record<string, unknown>) => {
          if (table === 'assets') await beforeAssetInsert();
          return Reflect.apply(value, target, [table, data]);
        };
      }
      if (property === 'query') {
        return async (sql: string, ...params: unknown[]) => {
          if (/^\s*INSERT\s+INTO\s+"assets"(?:\s|\()/i.test(sql))
            await beforeAssetInsert();
          return Reflect.apply(value, target, [sql, ...params]);
        };
      }
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as DatabaseInterface;
}

async function awaitBarrier<T>(
  promise: Promise<T>,
  label: string,
  timeoutMs = 5_000,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`Timed out waiting for ${label}`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

/**
 * Regression coverage for mandatory write predicates on private Asset rows.
 * The caller supplies the fixture's actual SQLite or PostgreSQL executor.
 */
export async function assertPrivateAssetWriteGuard(
  f: Fixture,
  dialect: 'sqlite' | 'postgres',
): Promise<void> {
  const assets = await AssetCollection.create({ db: f.db });
  const publicSlug = `public-natural-${randomUUID()}`;
  const publicFirst = await f.as(f.own, () =>
    assets.create({
      slug: publicSlug,
      name: 'public first',
      sourceUri: 'file:///public-first.bin',
      tenantId: f.own.tenantId,
      ownerProfileId: String(f.alice.profile.id),
    }),
  );
  const publicSecond = await f.as(f.own, () =>
    assets.create({
      slug: publicSlug,
      name: 'public second',
      sourceUri: 'file:///public-second.bin',
      tenantId: f.own.tenantId,
      ownerProfileId: String(f.alice.profile.id),
    }),
  );
  expect(publicSecond.id).toBe(publicFirst.id);
  expect(
    (await f.as(f.own, () => assets.get(String(publicFirst.id))))?.name,
  ).toBe('public second');

  const privateId = randomUUID();
  const privateSlug = `private-collision-${randomUUID()}`;
  const privateAsset = await createPrivateAsset(f, assets, {
    id: privateId,
    slug: privateSlug,
    name: 'private original',
    sourceUri: 'file:///private-original.bin',
  });
  const original = await f.db.get('assets', { id: privateId });
  if (!original) throw new Error('Expected private Asset row');

  await expect(
    f.as(f.own, () =>
      assets.create({
        slug: privateSlug,
        name: 'forged public collision',
        sourceUri: 'file:///forged-public.bin',
        tenantId: f.own.tenantId,
        ownerProfileId: String(f.alice.profile.id),
      }),
    ),
  ).rejects.toThrow();
  expect(await f.db.get('assets', { id: privateId })).toMatchObject({
    access_mode: 'private',
    owner_profile_id: String(f.alice.profile.id),
    source_uri: 'file:///private-original.bin',
  });

  await f.as(f.own, () =>
    withPrivateAssetAccess(privateAccess(f, [privateId]), () =>
      privateAsset.withTransaction(async (bound) => {
        bound.name = 'private transaction update';
        await bound.save();
      }),
    ),
  );
  expect((await f.db.get('assets', { id: privateId }))?.name).toBe(
    'private transaction update',
  );

  expect(await SmrtObject.tryJunctionBatch([privateAsset], [])).toBe(false);
  await expect(f.as(f.own, () => privateAsset.delete())).rejects.toThrow(
    /private asset access denied/i,
  );

  if (dialect === 'sqlite') {
    const seedId = randomUUID();
    const seed = await createPrivateAsset(f, assets, {
      id: seedId,
      slug: `sqlite-seed-${randomUUID()}`,
      name: 'sqlite private seed',
      sourceUri: 'file:///sqlite-private-seed.bin',
    });
    const seedRow = await f.db.get('assets', { id: seed.id });
    if (!seedRow) throw new Error('Expected SQLite private seed');
    const lateSlug = `sqlite-late-${randomUUID()}`;
    let inserted = false;
    const lateDb = insertSignalDb(f.db, async () => {
      if (inserted) return;
      inserted = true;
      await f.db.insert('assets', {
        ...seedRow,
        id: randomUUID(),
        slug: lateSlug,
        name: 'late private collision',
        source_uri: 'file:///late-private.bin',
      });
    });
    const lateAssets = await AssetCollection.create({ db: lateDb });
    await expect(
      f.as(f.own, () =>
        lateAssets.create({
          slug: lateSlug,
          name: 'late public collision',
          sourceUri: 'file:///late-public.bin',
          tenantId: f.own.tenantId,
          ownerProfileId: String(f.alice.profile.id),
        }),
      ),
    ).rejects.toThrow();
    expect(inserted).toBe(true);
    expect(
      await f.db.get('assets', {
        tenant_id: f.own.tenantId,
        slug: lateSlug,
      }),
    ).toMatchObject({
      access_mode: 'private',
      source_uri: 'file:///late-private.bin',
      owner_profile_id: String(f.alice.profile.id),
    });
    return;
  }

  const transaction = f.db.transaction;
  if (!transaction)
    throw new Error('PostgreSQL write-guard test requires transaction()');
  const lateId = randomUUID();
  const lateSlug = `postgres-late-${randomUUID()}`;
  const privateInserted = deferred<void>();
  const releasePrivate = deferred<void>();
  const finalInsertReached = deferred<void>();
  let finalInsertSignaled = false;
  const privateTransaction = transaction.call(f.db, async (tx) => {
    const txAssets = await AssetCollection.create({ db: tx });
    await createPrivateAsset(f, txAssets, {
      id: lateId,
      slug: lateSlug,
      name: 'postgres late private',
      sourceUri: 'file:///postgres-late-private.bin',
    });
    privateInserted.resolve();
    await releasePrivate.promise;
  });
  void privateTransaction.catch((error: unknown) =>
    privateInserted.reject(error),
  );
  let publicWrite: Promise<unknown> | undefined;
  try {
    await awaitBarrier(privateInserted.promise, 'private Asset insert');
    const publicDb = insertSignalDb(f.db, async () => {
      if (!finalInsertSignaled) {
        finalInsertSignaled = true;
        finalInsertReached.resolve();
      }
    });
    const publicAssets = await AssetCollection.create({ db: publicDb });
    publicWrite = f.as(f.own, () =>
      publicAssets.create({
        slug: lateSlug,
        name: 'postgres late public',
        sourceUri: 'file:///postgres-late-public.bin',
        tenantId: f.own.tenantId,
        ownerProfileId: String(f.alice.profile.id),
      }),
    );
    void publicWrite.catch((error: unknown) =>
      finalInsertReached.reject(error),
    );
    await awaitBarrier(finalInsertReached.promise, 'final public Asset INSERT');
    releasePrivate.resolve();
    await privateTransaction;
    await expect(publicWrite).rejects.toThrow();
    expect(await f.db.get('assets', { id: lateId })).toMatchObject({
      access_mode: 'private',
      owner_profile_id: String(f.alice.profile.id),
      source_uri: 'file:///postgres-late-private.bin',
    });
  } finally {
    releasePrivate.resolve();
    await Promise.allSettled([
      privateTransaction,
      ...(publicWrite ? [publicWrite] : []),
    ]);
  }
}
