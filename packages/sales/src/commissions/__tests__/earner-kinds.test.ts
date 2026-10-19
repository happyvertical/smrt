/**
 * Organisation and treasury earners plus Stripe Connect / crypto payout
 * descriptors (#3834). Real in-memory SQLite — no database mocks.
 *
 * Fixture: a farm co-operative pays a member farm (organisation) and keeps
 * retained funds in its own treasury account; neither has a person Profile.
 */

import { getTestDatabase } from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CommissionAdjustmentCollection } from '../collections/CommissionAdjustmentCollection.js';
import { CommissionCollection } from '../collections/CommissionCollection.js';
import { CommissionPayoutCollection } from '../collections/CommissionPayoutCollection.js';
import { EarnerCollection } from '../collections/EarnerCollection.js';
import { Earner, validatePayoutDestination } from '../models/Earner.js';
import { CommissionPayoutService } from '../services/CommissionPayoutService.js';
import type { PayoutDestination } from '../types.js';

describe('Earner kinds and payout destinations (#3834)', () => {
  let db: DatabaseInterface;
  let earners: EarnerCollection;
  let commissions: CommissionCollection;
  let payoutService: CommissionPayoutService;

  beforeEach(async () => {
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    earners = await EarnerCollection.create({ db });
    commissions = await CommissionCollection.create({ db });
    payoutService = new CommissionPayoutService({
      earners,
      commissions,
      adjustments: await CommissionAdjustmentCollection.create({ db }),
      payouts: await CommissionPayoutCollection.create({ db }),
    });
  });

  afterEach(async () => {
    await db?.close?.();
  });

  it('defaults existing-style earners to person with no destination', async () => {
    const person = await earners.create({
      profileId: 'profile-7',
      status: 'active',
    });
    const loaded = await earners.get({ id: person.id as string });
    expect(loaded?.kind).toBe('person');
    expect(loaded?.payoutMethod).toBe('bank_transfer');
    expect(loaded?.getPayoutDestination()).toBeNull();
  });

  for (const kind of ['organisation', 'treasury'] as const) {
    it(`runs a ${kind} earner without a person Profile from creation to paid`, async () => {
      const earner = await earners.create({
        kind,
        displayName:
          kind === 'treasury' ? 'Valley Co-op Treasury' : 'Birch Farm',
        payoutThresholdCents: 0,
      });
      expect(earner.profileId).toBe('');
      expect(earner.isPending()).toBe(true);
      earner.status = 'active';
      await earner.save();

      const reloaded = await earners.get({ id: earner.id as string });
      expect(reloaded?.kind).toBe(kind);
      expect(reloaded?.isOrganisation()).toBe(kind === 'organisation');
      expect(reloaded?.isTreasury()).toBe(kind === 'treasury');
      expect(reloaded?.isActive()).toBe(true);

      const commission = await commissions.create({
        earnerId: earner.id as string,
        amountCents: 4500,
        currency: 'USD',
        status: 'payable',
        dedupeKey: `${kind}-harvest-share`,
      });
      const { payout } = await payoutService.createPayoutBatch({
        earnerId: earner.id as string,
        currency: 'USD',
        idempotencyKey: `${kind}-batch`,
      });
      if (!payout) throw new Error('expected payout');
      expect(payout.totalAmountCents).toBe(4500);
      payout.approve();
      await payout.save();
      payout.markProcessing();
      await payout.save();
      const completed = await payoutService.completePayout(
        payout.id as string,
        `${kind}-transfer-1`,
      );
      expect(completed.status).toBe('completed');
      expect((await commissions.get({ id: commission.id }))?.status).toBe(
        'paid',
      );

      earner.status = 'suspended';
      await earner.save();
      expect((await earners.get({ id: earner.id as string }))?.status).toBe(
        'suspended',
      );
    });
  }

  it('rejects an unknown kind or payout method at save', async () => {
    const earner = new Earner({ db, kind: 'robot' as never });
    await expect(earner.save()).rejects.toThrow(/unknown kind 'robot'/);
    const method = new Earner({ db, payoutMethod: 'cash' as never });
    await expect(method.save()).rejects.toThrow(/unknown payoutMethod 'cash'/);
  });

  it('stores a Stripe Connect destination and settles through it', async () => {
    const earner = await earners.create({
      kind: 'organisation',
      displayName: 'Birch Farm',
      payoutThresholdCents: 0,
    });
    earner.setPayoutDestination({
      method: 'stripe_connect',
      connectedAccountId: 'acct_1BirchFarm',
    });
    expect(earner.payoutMethod).toBe('stripe_connect');
    earner.status = 'active';
    await earner.save();

    const loaded = await earners.get({ id: earner.id as string });
    expect(loaded?.getPayoutDestination()).toEqual({
      method: 'stripe_connect',
      connectedAccountId: 'acct_1BirchFarm',
    });
    await commissions.create({
      earnerId: earner.id as string,
      amountCents: 1200,
      currency: 'USD',
      status: 'payable',
      dedupeKey: 'connect-share',
    });
    const { payout } = await payoutService.createPayoutBatch({
      earnerId: earner.id as string,
      currency: 'USD',
      idempotencyKey: 'connect-batch',
    });
    expect(payout?.payoutMethod).toBe('stripe_connect');
  });

  it('refuses a Connect or crypto batch override without a matching destination', async () => {
    const earner = await earners.create({
      kind: 'organisation',
      status: 'active',
      payoutMethod: 'paypal',
      payoutThresholdCents: 0,
    });
    await commissions.create({
      earnerId: earner.id as string,
      amountCents: 800,
      currency: 'USD',
      status: 'payable',
      dedupeKey: 'override-share',
    });
    for (const payoutMethod of ['crypto', 'stripe_connect'] as const) {
      await expect(
        payoutService.createPayoutBatch({
          earnerId: earner.id as string,
          currency: 'USD',
          idempotencyKey: `override-${payoutMethod}`,
          payoutMethod,
        }),
      ).rejects.toThrow(new RegExp(`has no ${payoutMethod} payoutDestination`));
    }
    earner.setPayoutDestination({
      method: 'crypto',
      network: 'bitcoin',
      asset: 'BTC',
      address: 'bc1qbirchfarm',
    });
    await earner.save();
    // A crypto destination does not make a Connect override routeable.
    await expect(
      payoutService.createPayoutBatch({
        earnerId: earner.id as string,
        currency: 'USD',
        idempotencyKey: 'override-connect-after',
        payoutMethod: 'stripe_connect',
      }),
    ).rejects.toThrow(/has no stripe_connect payoutDestination/);
    const { payout } = await payoutService.createPayoutBatch({
      earnerId: earner.id as string,
      currency: 'USD',
      idempotencyKey: 'override-crypto-after',
    });
    expect(payout?.payoutMethod).toBe('crypto');
  });

  it('stores a crypto destination', async () => {
    const earner = await earners.create({ kind: 'organisation' });
    earner.setPayoutDestination({
      method: 'crypto',
      network: 'lightning',
      asset: 'BTC',
      address: 'growers@pay.example',
    });
    earner.status = 'active';
    await earner.save();
    const loaded = await earners.get({ id: earner.id as string });
    expect(loaded?.payoutMethod).toBe('crypto');
    expect(loaded?.getPayoutDestination()).toMatchObject({
      network: 'lightning',
      asset: 'BTC',
    });
    loaded?.setPayoutDestination(null);
    expect(loaded?.getPayoutDestination()).toBeNull();
    await expect(loaded?.save()).rejects.toThrow(
      /active crypto earner requires a payoutDestination/,
    );
  });

  it('requires a destination before a Connect or crypto earner is active', async () => {
    const pending = await earners.create({
      kind: 'organisation',
      payoutMethod: 'stripe_connect',
    });
    expect(pending.isPending()).toBe(true);
    pending.status = 'active';
    await expect(pending.save()).rejects.toThrow(
      /active stripe_connect earner requires a payoutDestination/,
    );
  });

  it('refuses a destination that disagrees with payoutMethod or is malformed', async () => {
    const earner = await earners.create({ kind: 'organisation' });
    earner.setPayoutDestination({
      method: 'stripe_connect',
      connectedAccountId: 'acct_123',
    });
    earner.payoutMethod = 'paypal';
    await expect(earner.save()).rejects.toThrow(/does not match payoutMethod/);

    const raw = new Earner({ db, payoutDestination: 'not json' });
    await expect(raw.save()).rejects.toThrow(/valid JSON/);
    const array = new Earner({ db, payoutDestination: '[]' });
    await expect(array.save()).rejects.toThrow(/JSON object/);

    const invalid: unknown[] = [
      { method: 'stripe_connect', connectedAccountId: '' },
      { method: 'stripe_connect', connectedAccountId: 'sk_live_secret' },
      {
        method: 'stripe_connect',
        connectedAccountId: 'acct_1',
        apiKey: 'sk_live_x',
      },
      { method: 'crypto', network: 'bitcoin', asset: 'BTC' },
      {
        method: 'crypto',
        network: 'bitcoin',
        asset: 'BTC',
        address: 'bc1',
        memo: 7,
      },
      { method: 'bank_transfer' },
      null,
    ];
    for (const destination of invalid) {
      expect(() =>
        validatePayoutDestination(destination as PayoutDestination),
      ).toThrow();
    }
  });
});
