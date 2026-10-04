/**
 * README example parity (TESTING_STANDARD.md): "Record, approve, and correct
 * time" runs as written.
 */
import { getTestDatabase } from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ServiceChargeSnapshotCollection,
  ServiceEvidenceService,
} from '../index.js';

describe('README examples', () => {
  let db: DatabaseInterface;
  const profile = { id: 'profile-framer' };

  beforeEach(async () => {
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
  });

  afterEach(async () => {
    await db.close?.();
  });

  it('records, submits, and approves time', async () => {
    const timesheets = await ServiceEvidenceService.create(
      { db },
      {
        priceClient: async (entry) => ({
          amount: Math.round(entry.durationHours() * 9500),
          version: 'rates-2026',
          terms: { hourlyRate: 9500 },
        }),
        compensateProvider: async (entry) => ({
          amount: Math.round(entry.durationHours() * 6000),
          version: 'pay-2026',
          terms: { hourlyRate: 6000 },
        }),
      },
    );

    const entry = await timesheets.record({
      workRefType: '@acme/jobs:WorkPackage',
      workRefId: 'wp-7',
      participantKind: 'human',
      participantProfileId: profile.id,
      source: 'timer',
      description: 'Framed the north wall',
      startedAt: new Date('2026-07-01T08:00:00Z'),
      endedAt: new Date('2026-07-01T10:30:00Z'),
    });

    await timesheets.submit(entry, profile.id);
    await timesheets.approve(entry, { approvalPath: 'operator' });

    expect(entry.status).toBe('approved');
    const [charge] = await (
      await ServiceChargeSnapshotCollection.create({ db })
    ).list({ where: { timeEntryId: entry.id } });
    // 2.5 h × $95.00/h = $237.50, in cents.
    expect(charge.amount).toBe(23750);
  });
});
