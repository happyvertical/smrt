/**
 * PostgreSQL lane for the Professional Service evidence money columns (#2401).
 *
 * `ServiceChargeSnapshot.amount` and `ServiceCompensationSnapshot.amount` are
 * **integer minor units** — `$19.99` is `1999` — and the delivery margin is the
 * exact integer difference between them. SQLite's type affinity would store a
 * REAL in either column without complaint, so the column *type* is asserted
 * from `information_schema` here and the values are exercised alongside it:
 * either check alone passes for the wrong reason.
 *
 * Named `*.optional.test.ts` because it needs a real external service: the
 * package's `test:postgres` script runs `vitest run optional.test.ts` as a
 * positional filter, so a new PostgreSQL suite needs no script edit and
 * concurrent PRs never conflict on the same one-line script. Without a
 * PostgreSQL URL the whole file skips itself.
 */

import { randomUUID } from 'node:crypto';
import {
  createIsolatedTestDbFromManifest,
  type IsolatedTestDbResult,
  isPostgresAvailable,
} from '@happyvertical/smrt-vitest';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ServiceChargeSnapshotCollection,
  ServiceCompensationSnapshotCollection,
  ServiceTimeEntryCollection,
} from '../models/service-evidence.js';

const describePostgres = isPostgresAvailable() ? describe : describe.skip;

describePostgres('projects money columns on PostgreSQL (#2401)', () => {
  let isolated: IsolatedTestDbResult | undefined;
  let db: DatabaseInterface;

  beforeEach(async () => {
    isolated = await createIsolatedTestDbFromManifest({
      includeObjects: [
        'ServiceTimeEntry',
        'ServiceChargeSnapshot',
        'ServiceCompensationSnapshot',
      ],
    });
    if (isolated.config.type !== 'postgres') {
      throw new Error('Expected a PostgreSQL test database');
    }
    db = isolated.baseDb;
  });

  afterEach(async () => {
    await isolated?.cleanup();
    isolated = undefined;
  });

  it('declares both snapshot amount columns INTEGER', async () => {
    const result = await db.query(
      `SELECT table_name, column_name, data_type FROM information_schema.columns
       WHERE table_name IN ('service_charge_snapshots',
                            'service_compensation_snapshots')
         AND column_name = 'amount'`,
    );

    const rows = result.rows as {
      table_name: string;
      data_type: string;
    }[];
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.data_type, row.table_name).toMatch(/integer|bigint/);
    }
  });

  it('round-trips a charge/compensation pair and computes an exact margin', async () => {
    const entries = await ServiceTimeEntryCollection.create({ db });
    const entry = await entries.create({
      workRefType: '@happyvertical/smrt-projects:DevelopmentRequest',
      workRefId: 'request-pg-1',
      participantKind: 'human',
      // Profile references are native `uuid` columns on PostgreSQL, so a
      // readable slug fails with 22P02.
      participantProfileId: randomUUID(),
      source: 'manual',
      description: 'Planning',
      durationSeconds: 3600,
    });

    const charges = await ServiceChargeSnapshotCollection.create({ db });
    const compensations = await ServiceCompensationSnapshotCollection.create({
      db,
    });
    const charge = await charges.create({
      timeEntryId: String(entry.id),
      amount: 15000, // $150.00
      currency: 'USD',
      pricingVersion: 'pricing-v2',
    });
    const compensation = await compensations.create({
      timeEntryId: String(entry.id),
      amount: 9000, // $90.00
      currency: 'USD',
      termsVersion: 'provider-v1',
    });

    const reloadedCharge = await charges.get(String(charge.id));
    const reloadedCompensation = await compensations.get(
      String(compensation.id),
    );
    // Exact equality, not toBeCloseTo — that is the point of minor units.
    expect(reloadedCharge?.amount).toBe(15000);
    expect(reloadedCompensation?.amount).toBe(9000);
    expect(
      (reloadedCharge?.amount ?? 0) - (reloadedCompensation?.amount ?? 0),
    ).toBe(6000);
  });

  it('rejects a fractional major-unit amount rather than storing it', async () => {
    const entries = await ServiceTimeEntryCollection.create({ db });
    const entry = await entries.create({
      workRefType: '@happyvertical/smrt-projects:DevelopmentRequest',
      workRefId: 'request-pg-2',
      participantKind: 'human',
      participantProfileId: randomUUID(),
      source: 'manual',
      description: 'Planning',
      durationSeconds: 3600,
    });

    const charges = await ServiceChargeSnapshotCollection.create({ db });
    await expect(
      charges.create({
        timeEntryId: String(entry.id),
        amount: 150.5,
        currency: 'USD',
        pricingVersion: 'pricing-v2',
      }),
    ).rejects.toThrow();
  });
});
