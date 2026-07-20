/**
 * Regression tests for issue #2083: recordClick must be callable inside a
 * caller's transaction. Since #2058 it unconditionally opened its own
 * adapter transaction; nested adapter transactions take an independent
 * connection (happyvertical/sdk#1108), so a caller-wrapped recordClick
 * either hung on caller-held locks or refused links the caller had created
 * but not committed. These tests pin the two participation doors — an
 * explicit `RecordClickInput.transaction` and a collection bound to the
 * caller's transaction database — plus the typed refusal of unusable
 * transaction inputs.
 *
 * Real in-memory SQLite — no mocks of database operations. On SQLite a
 * nested BEGIN on the shared connection throws (and its rollback would
 * destroy the caller's transaction), so plain success inside
 * `db.transaction()` already proves participation; the rollback tests prove
 * the click's writes belong to the caller's transaction.
 */

import { getTestDatabase } from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type RecordClickResult,
  ReferralLinkCollection,
} from '../collections/ReferralLinkCollection.js';
import { ReferralProgramCollection } from '../collections/ReferralProgramCollection.js';
import { ReferralTouchCollection } from '../collections/ReferralTouchCollection.js';
import { ReferrerCollection } from '../collections/ReferrerCollection.js';

interface TransactionDatabase extends DatabaseInterface {
  transaction<T>(fn: (tx: DatabaseInterface) => Promise<T>): Promise<T>;
}

/** Bind a collection to the caller's transaction (the documented pattern). */
async function txLinks(tx: DatabaseInterface): Promise<ReferralLinkCollection> {
  return await ReferralLinkCollection.create({
    db: tx,
    _reuseInitializedDb: true,
    _deferRuntimeInitialization: true,
  });
}

describe('ReferralLinkCollection.recordClick inside a caller transaction', () => {
  let db: TransactionDatabase;
  let links: ReferralLinkCollection;
  let touches: ReferralTouchCollection;
  let referrerId: string;
  let programId: string;

  beforeEach(async () => {
    db = (await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
    })) as TransactionDatabase;
    if (typeof db.transaction !== 'function') {
      throw new Error('Test database must expose transaction()');
    }
    links = await ReferralLinkCollection.create({ db });
    touches = await ReferralTouchCollection.create({ db });
    const referrers = await ReferrerCollection.create({ db });
    const programs = await ReferralProgramCollection.create({ db });
    referrerId =
      (
        await referrers.create({
          profileId: 'profile-tx',
          displayName: 'Tx Partner',
          status: 'active',
        })
      ).id ?? '';
    programId =
      (await programs.create({ key: 'tx-partners', name: 'Tx program' })).id ??
      '';
  });

  afterEach(async () => {
    if (db && typeof db.close === 'function') {
      await db.close();
    }
  });

  it('participates in the transaction passed as input.transaction and commits with it', async () => {
    const link = await links.createWithUniqueCode({ referrerId, programId });

    const inTx = await db.transaction(async (tx) => {
      const result = await links.recordClick({
        code: link.code,
        idempotencyKey: 'tx-input-commit',
        evidence: { via: 'input.transaction' },
        transaction: tx,
      });
      expect(result.refused).toBeUndefined();
      expect(result.replayed).toBe(false);
      // Participation binds result models to the caller's transaction, not
      // the collection's pool database.
      expect((result.link as unknown as { db: DatabaseInterface }).db).toBe(tx);
      expect((result.touch as unknown as { db: DatabaseInterface }).db).toBe(
        tx,
      );
      // The click is already visible to the transaction's own reads.
      const seen = await (await txLinks(tx)).get({ id: link.id });
      expect(seen?.clickCount).toBe(1);
      return result;
    });

    expect(inTx.link?.clickCount).toBe(1);
    expect((await links.get({ id: link.id }))?.clickCount).toBe(1);
    expect(await touches.findByReferrer(referrerId)).toHaveLength(1);
  });

  it('sees links the caller transaction created but has not committed', async () => {
    const clicked = await db.transaction(async (tx) => {
      const uncommitted = await (await txLinks(tx)).createWithUniqueCode({
        referrerId,
        programId,
      });
      // Since #2058 this was refused as unknown_code: the nested
      // transaction could not see the caller's uncommitted link.
      return await links.recordClick({
        code: uncommitted.code,
        idempotencyKey: 'tx-uncommitted-link',
        transaction: tx,
      });
    });

    expect(clicked.refused).toBeUndefined();
    expect(clicked.link?.clickCount).toBe(1);
    expect(await touches.findByReferrer(referrerId)).toHaveLength(1);
  });

  it('rolls back the click with the caller transaction — nothing persists', async () => {
    const link = await links.createWithUniqueCode({ referrerId, programId });

    await expect(
      db.transaction(async (tx) => {
        const result = await links.recordClick({
          code: link.code,
          idempotencyKey: 'tx-rollback',
          transaction: tx,
        });
        expect(result.link?.clickCount).toBe(1);
        throw new Error('caller aborts after the click');
      }),
    ).rejects.toThrow('caller aborts after the click');

    // Counter, touch, and the replay fence all rolled back with the caller.
    expect((await links.get({ id: link.id }))?.clickCount).toBe(0);
    expect(await touches.findByReferrer(referrerId)).toHaveLength(0);
    const retried = await links.recordClick({
      code: link.code,
      idempotencyKey: 'tx-rollback',
    });
    expect(retried.replayed).toBe(false);
    expect(retried.link?.clickCount).toBe(1);
  });

  it('participates when the collection itself is bound to the caller transaction', async () => {
    const link = await links.createWithUniqueCode({ referrerId, programId });

    await expect(
      db.transaction(async (tx) => {
        const bound = await txLinks(tx);
        // No input.transaction: the collection's own database IS the
        // caller's transaction, and recordClick must join it, not nest.
        const result = await bound.recordClick({
          code: link.code,
          idempotencyKey: 'tx-bound-collection',
        });
        expect(result.refused).toBeUndefined();
        expect(result.link?.clickCount).toBe(1);
        expect((result.link as unknown as { db: DatabaseInterface }).db).toBe(
          tx,
        );
        throw new Error('caller aborts after the click');
      }),
    ).rejects.toThrow('caller aborts after the click');

    expect((await links.get({ id: link.id }))?.clickCount).toBe(0);
    expect(await touches.findByReferrer(referrerId)).toHaveLength(0);
  });

  it('replays exactly within one caller transaction', async () => {
    const link = await links.createWithUniqueCode({ referrerId, programId });

    const { first, replay } = await db.transaction(async (tx) => {
      const input = {
        code: link.code,
        idempotencyKey: 'tx-replay',
        occurredAt: new Date('2026-07-20T12:00:00.000Z'),
        transaction: tx,
      };
      return {
        first: await links.recordClick(input),
        replay: await links.recordClick(input),
      };
    });

    expect(first.replayed).toBe(false);
    expect(replay.replayed).toBe(true);
    expect(replay.touch?.id).toBe(first.touch?.id);
    expect((await links.get({ id: link.id }))?.clickCount).toBe(1);
    expect(await touches.findByReferrer(referrerId)).toHaveLength(1);
  });

  it('returns typed refusals inside the caller transaction without writing', async () => {
    const disabled = await links.createWithUniqueCode({
      referrerId,
      programId,
    });
    disabled.status = 'disabled';
    await disabled.save();

    const { unknown, refusedDisabled } = await db.transaction(async (tx) => ({
      unknown: await links.recordClick({
        code: 'nosuchcode',
        transaction: tx,
      }),
      refusedDisabled: await links.recordClick({
        code: disabled.code,
        transaction: tx,
      }),
    }));

    expect(unknown).toMatchObject<Partial<RecordClickResult>>({
      link: null,
      touch: null,
      refused: 'unknown_code',
    });
    expect(refusedDisabled.refused).toBe('link_disabled');
    expect(refusedDisabled.link?.id).toBe(disabled.id);
    expect((await links.get({ id: disabled.id }))?.clickCount).toBe(0);
    expect(await touches.findByReferrer(referrerId)).toHaveLength(0);
  });

  it('refuses a pool-level database passed as the transaction', async () => {
    const link = await links.createWithUniqueCode({ referrerId, programId });

    await expect(
      links.recordClick({
        code: link.code,
        // Deliberate misuse: the pool database, not a transaction view —
        // accepting it would run the click's writes untransacted.
        transaction: db,
      }),
    ).rejects.toMatchObject({
      code: 'REFERRAL_CLICK_VALIDATION_ERROR',
      reason: 'invalid_transaction',
    });
    expect((await links.get({ id: link.id }))?.clickCount).toBe(0);
  });

  it('refuses junk and ended transactions with the typed error', async () => {
    const link = await links.createWithUniqueCode({ referrerId, programId });

    await expect(
      links.recordClick({
        code: link.code,
        transaction: {} as DatabaseInterface,
      }),
    ).rejects.toMatchObject({ reason: 'invalid_transaction' });

    if (typeof db.beginTransaction === 'function') {
      const handle = await db.beginTransaction();
      await handle.rollback();
      await expect(
        links.recordClick({ code: link.code, transaction: handle }),
      ).rejects.toMatchObject({ reason: 'invalid_transaction' });
    }
    expect((await links.get({ id: link.id }))?.clickCount).toBe(0);
  });

  it('participates when the collection is bound to a beginTransaction() handle', async () => {
    if (typeof db.beginTransaction !== 'function') {
      throw new Error('Test database must expose beginTransaction()');
    }
    const link = await links.createWithUniqueCode({ referrerId, programId });

    const handle = await db.beginTransaction();
    try {
      // Handles are recognized by their own lifecycle surface
      // (commit/rollback/isActive), independent of the transaction()
      // fingerprint — the bound collection must join, not nest or refuse.
      const bound = await txLinks(handle);
      const result = await bound.recordClick({
        code: link.code,
        idempotencyKey: 'tx-handle-bound',
      });
      expect(result.refused).toBeUndefined();
      expect(result.link?.clickCount).toBe(1);
      await handle.rollback();
    } catch (error) {
      if (handle.isActive()) await handle.rollback();
      throw error;
    }

    expect((await links.get({ id: link.id }))?.clickCount).toBe(0);
    expect(await touches.findByReferrer(referrerId)).toHaveLength(0);
  });

  it('an active beginTransaction() handle participates and persists on commit', async () => {
    if (typeof db.beginTransaction !== 'function') {
      throw new Error('Test database must expose beginTransaction()');
    }
    const link = await links.createWithUniqueCode({ referrerId, programId });

    const handle = await db.beginTransaction();
    try {
      const result = await links.recordClick({
        code: link.code,
        idempotencyKey: 'tx-handle-commit',
        transaction: handle,
      });
      expect(result.refused).toBeUndefined();
      await handle.commit();
    } catch (error) {
      if (handle.isActive()) await handle.rollback();
      throw error;
    }

    expect((await links.get({ id: link.id }))?.clickCount).toBe(1);
    expect(await touches.findByReferrer(referrerId)).toHaveLength(1);
  });

  it('keeps self-transacting for a minimal pool adapter without beginTransaction', async () => {
    // A conforming-but-minimal pool adapter over the real database:
    // transaction() without beginTransaction/acquireSession. Its close()
    // marks it pool-level, so recordClick must keep the atomic
    // self-transacting default rather than silently running the click's
    // writes untransacted.
    const minimalPool = { ...db, close: async () => {} } as TransactionDatabase;
    delete (minimalPool as { beginTransaction?: unknown }).beginTransaction;
    delete (minimalPool as { acquireSession?: unknown }).acquireSession;
    expect(typeof minimalPool.transaction).toBe('function');

    const link = await links.createWithUniqueCode({ referrerId, programId });
    const bound = await ReferralLinkCollection.create({ db: minimalPool });
    const result = await bound.recordClick({
      code: link.code,
      idempotencyKey: 'minimal-pool-selftransact',
    });
    expect(result.refused).toBeUndefined();
    expect(result.link?.clickCount).toBe(1);
    expect((await links.get({ id: link.id }))?.clickCount).toBe(1);
  });

  it('still self-transacts and rehydrates on the pool database when unwrapped', async () => {
    const link = await links.createWithUniqueCode({ referrerId, programId });
    const result = await links.recordClick({
      code: link.code,
      idempotencyKey: 'pool-selftransact',
    });
    expect(result.refused).toBeUndefined();
    // The historical contract: results rebind to the collection's database
    // after the click's own transaction commits.
    expect((result.link as unknown as { db: DatabaseInterface }).db).toBe(db);
    expect((result.touch as unknown as { db: DatabaseInterface }).db).toBe(db);
    expect(result.link?.clickCount).toBe(1);
  });
});
