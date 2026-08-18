/**
 * PostgreSQL lane for support money and rate columns (#2401).
 *
 * Money in this package is **integer minor units** — `$19.99` is `1999` — while
 * the hourly rates stay DECIMAL because a rate is inherently fractional (their
 * *unit* changed to minor units per hour, not their type). SQLite cannot tell
 * the two apart: its affinity stores a REAL in an INTEGER column and truncates
 * nothing, so a money field that reverted to DECIMAL — or a rate that
 * collapsed to INTEGER — passes every SQLite suite. This lane asserts the
 * column types from `information_schema` and exercises values, because either
 * check alone passes for the wrong reason.
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
  SupportChargeCollection,
  SupportCompensationCollection,
} from '../models/support-settlement.js';

const describePostgres = isPostgresAvailable() ? describe : describe.skip;

describePostgres('support money columns on PostgreSQL (#2401)', () => {
  let isolated: IsolatedTestDbResult | undefined;
  let db: DatabaseInterface;

  beforeEach(async () => {
    isolated = await createIsolatedTestDbFromManifest({
      includeObjects: [
        'SupportPlan',
        'SupportCharge',
        'SupportCompensation',
        'SupportCompensationPlan',
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

  it('declares money columns INTEGER and rate columns floating-point', async () => {
    const result = await db.query(
      `SELECT table_name, column_name, data_type FROM information_schema.columns
       WHERE table_name IN ('support_plans', 'support_charges',
                            'support_compensations',
                            'support_compensation_plans')
       ORDER BY table_name, column_name`,
    );

    const byColumn = Object.fromEntries(
      (
        result.rows as {
          table_name: string;
          column_name: string;
          data_type: string;
        }[]
      ).map((row) => [`${row.table_name}.${row.column_name}`, row.data_type]),
    );

    for (const column of [
      'support_plans.availability_fee_amount',
      'support_charges.amount',
      'support_compensations.amount',
    ]) {
      expect(byColumn[column], column).toMatch(/integer|bigint/);
    }

    // Rates stay fractional. INTEGER here would truncate a sub-unit rate to 0,
    // and PostgreSQL would reject a fractional write with 22P02.
    for (const column of [
      'support_plans.overage_hourly_rate',
      'support_plans.on_call_hourly_rate',
      'support_compensation_plans.hourly_rate',
    ]) {
      expect(byColumn[column], column).toMatch(/double precision|real|numeric/);
    }
  });

  it('round-trips a charge/compensation pair as exact integer minor units', async () => {
    const charges = await SupportChargeCollection.create({ db });
    const compensations = await SupportCompensationCollection.create({ db });
    // `timeEntryId` is a foreign key, which is a native `uuid` column on
    // PostgreSQL — a readable slug fails with 22P02.
    const timeEntryId = randomUUID();

    const charge = await charges.create({
      timeEntryId,
      amount: 6000, // $60.00
      currency: 'USD',
      billableSeconds: 1800,
    });
    const compensation = await compensations.create({
      timeEntryId,
      amount: 2250, // $22.50
      currency: 'USD',
      payableSeconds: 1800,
    });

    // Exact equality, not toBeCloseTo — that is the point of minor units.
    expect((await charges.get(String(charge.id)))?.amount).toBe(6000);
    expect((await compensations.get(String(compensation.id)))?.amount).toBe(
      2250,
    );
  });

  it('rejects a fractional major-unit charge rather than storing it', async () => {
    const charges = await SupportChargeCollection.create({ db });
    await expect(
      charges.create({
        timeEntryId: randomUUID(),
        amount: 60.5,
        currency: 'USD',
        billableSeconds: 1800,
      }),
    ).rejects.toThrow();
  });
});
