/**
 * Tests for Earner collection queries (findByProfile / findActive), the
 * EarningEvent idempotent-ingestion helper, and tenant isolation for Earner
 * and Commission (tenant A rows invisible to tenant B). Mirrors the
 * commerce/ledgers tenancy test setup: tenancy enabled with the default
 * policy, real in-memory SQLite, no DB mocking.
 */

import { getTestDatabase } from '@happyvertical/smrt-core';
import {
  disableTenancy,
  enableTenancy,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CommissionCollection } from '../collections/CommissionCollection.js';
import { EarnerCollection } from '../collections/EarnerCollection.js';
import { EarningEventCollection } from '../collections/EarningEventCollection.js';

describe('Earner queries', () => {
  let db: DatabaseInterface;
  let earners: EarnerCollection;

  beforeEach(async () => {
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    earners = await EarnerCollection.create({ db });
  });

  afterEach(async () => {
    if (db && typeof db.close === 'function') {
      await db.close();
    }
  });

  it('findByProfile returns the profile’s earners; findActive filters status', async () => {
    const active = await earners.create({
      profileId: 'profile-1',
      displayName: 'Active earner',
      status: 'active',
    });
    const pending = await earners.create({
      profileId: 'profile-1',
      displayName: 'Pending earner',
    });
    await earners.create({
      profileId: 'profile-2',
      displayName: 'Someone else',
      status: 'suspended',
    });

    const byProfile = await earners.findByProfile('profile-1');
    expect(byProfile.map((e) => e.id).sort()).toEqual(
      [active.id, pending.id].sort(),
    );

    const actives = await earners.findActive();
    expect(actives.map((e) => e.id)).toEqual([active.id]);
    expect(pending.status).toBe('pending'); // default status
    expect(pending.payoutMethod).toBe('bank_transfer'); // default method
    expect(pending.payoutThresholdCents).toBe(5000); // default threshold
    expect(pending.payoutScheduleKey).toBe('manual'); // default schedule
  });
});

describe('EarningEvent idempotent ingestion', () => {
  let db: DatabaseInterface;
  let events: EarningEventCollection;

  beforeEach(async () => {
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    events = await EarningEventCollection.create({ db });
  });

  afterEach(async () => {
    if (db && typeof db.close === 'function') {
      await db.close();
    }
  });

  it('getOrCreateByDedupeKey creates once and replays the stored row untouched', async () => {
    const first = await events.getOrCreateByDedupeKey({
      eventKind: 'invoice_payment',
      sourceKind: 'agreement',
      sourceId: 'agr-1',
      grossAmountCents: 12500,
      currency: 'USD',
      dedupeKey: 't1:agreement:agr-1:invoice_payment:1',
    });
    expect(first.created).toBe(true);

    const replay = await events.getOrCreateByDedupeKey({
      eventKind: 'invoice_payment',
      sourceKind: 'agreement',
      sourceId: 'agr-1',
      // A drifted replay payload must NOT overwrite the stored evidence.
      grossAmountCents: 99999,
      currency: 'USD',
      dedupeKey: 't1:agreement:agr-1:invoice_payment:1',
    });
    expect(replay.created).toBe(false);
    expect(replay.event.id).toBe(first.event.id);
    expect(replay.event.grossAmountCents).toBe(12500);

    await expect(
      events.getOrCreateByDedupeKey({ eventKind: 'conversion' }),
    ).rejects.toThrow(/requires a dedupeKey/);

    const bySource = await events.findBySource('agreement', 'agr-1');
    expect(bySource).toHaveLength(1);
  });
});

describe('tenant isolation', () => {
  let db: DatabaseInterface;

  beforeEach(async () => {
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    enableTenancy();
  });

  afterEach(async () => {
    disableTenancy();
    if (db && typeof db.close === 'function') {
      await db.close();
    }
  });

  it('Earner rows are invisible across tenants and auto-stamped with the active tenant', async () => {
    const earners = await EarnerCollection.create({ db });

    const earnerA = await withTenant({ tenantId: 'tenant-a' }, async () => {
      return await earners.create({
        profileId: 'profile-a',
        displayName: 'Tenant A earner',
        status: 'active',
      });
    });
    await withTenant({ tenantId: 'tenant-b' }, async () => {
      await earners.create({
        profileId: 'profile-b',
        displayName: 'Tenant B earner',
        status: 'active',
      });
    });

    expect(earnerA.tenantId).toBe('tenant-a');

    const seenByA = await withTenant({ tenantId: 'tenant-a' }, () =>
      earners.list({}),
    );
    expect(seenByA.map((e) => e.displayName)).toEqual(['Tenant A earner']);

    const seenByB = await withTenant({ tenantId: 'tenant-b' }, () =>
      earners.list({}),
    );
    expect(seenByB.map((e) => e.displayName)).toEqual(['Tenant B earner']);

    // The scoped helpers are tenant-aware too.
    const activeSeenByA = await withTenant({ tenantId: 'tenant-a' }, () =>
      earners.findActive(),
    );
    expect(activeSeenByA.map((e) => e.id)).toEqual([earnerA.id]);
  });

  it('Commission rows are invisible across tenants', async () => {
    const earners = await EarnerCollection.create({ db });
    const commissions = await CommissionCollection.create({ db });

    const commissionA = await withTenant({ tenantId: 'tenant-a' }, async () => {
      const earner = await earners.create({
        profileId: 'profile-a',
        status: 'active',
      });
      return await commissions.create({
        earnerId: earner.id as string,
        amountCents: 1234,
        currency: 'USD',
        dedupeKey: 'tenant-a-comm-1',
      });
    });
    await withTenant({ tenantId: 'tenant-b' }, async () => {
      const earner = await earners.create({
        profileId: 'profile-b',
        status: 'active',
      });
      await commissions.create({
        earnerId: earner.id as string,
        amountCents: 5678,
        currency: 'USD',
        dedupeKey: 'tenant-b-comm-1',
      });
    });

    expect(commissionA.tenantId).toBe('tenant-a');

    const seenByA = await withTenant({ tenantId: 'tenant-a' }, () =>
      commissions.list({}),
    );
    expect(seenByA.map((c) => c.dedupeKey)).toEqual(['tenant-a-comm-1']);

    const seenByB = await withTenant({ tenantId: 'tenant-b' }, () =>
      commissions.list({}),
    );
    expect(seenByB.map((c) => c.dedupeKey)).toEqual(['tenant-b-comm-1']);

    // Cross-tenant sums stay scoped as well.
    const sumForB = await withTenant({ tenantId: 'tenant-b' }, () =>
      commissions.findByEarner(commissionA.earnerId),
    );
    expect(sumForB).toEqual([]);
  });
});
