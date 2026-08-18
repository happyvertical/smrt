/**
 * PostgreSQL lane for subscriptions money columns (#2401).
 *
 * Money in this package is **integer minor units** — `$19.99` is `1999`. SQLite
 * cannot hold the line here: its type affinity stores a REAL in an INTEGER
 * column without complaint, so a money field that silently reverted to DECIMAL
 * passes every SQLite suite and only misbehaves in production. This lane
 * asserts the column *type* from `information_schema` and exercises values,
 * because either alone passes for the wrong reason.
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
  ClientChargeCollection,
  SpendingPolicyCollection,
} from '../models/commercial.js';

const describePostgres = isPostgresAvailable() ? describe : describe.skip;

const TENANT_ID = '11111111-1111-4111-8111-111111111111';

describePostgres('subscriptions money columns on PostgreSQL (#2401)', () => {
  let isolated: IsolatedTestDbResult | undefined;
  let db: DatabaseInterface;

  beforeEach(async () => {
    isolated = await createIsolatedTestDbFromManifest({
      includeObjects: [
        'SubscriptionPlan',
        'ClientCharge',
        'BillingAdjustment',
        'SpendingPolicy',
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

  it('declares money columns INTEGER and metered quantity floating-point', async () => {
    const result = await db.query(
      `SELECT table_name, column_name, data_type FROM information_schema.columns
       WHERE table_name IN ('_smrt_subscription_plans', '_smrt_client_charges',
                            '_smrt_billing_adjustments', '_smrt_spending_policies')
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
      '_smrt_subscription_plans.price_amount',
      '_smrt_client_charges.amount',
      '_smrt_billing_adjustments.amount',
      '_smrt_spending_policies.limit_amount',
    ]) {
      expect(byColumn[column], column).toMatch(/integer|bigint/);
    }

    // A metered quantity is genuinely fractional (duration.seconds, scaled
    // token counts); INTEGER here would truncate every partial unit.
    expect(byColumn['_smrt_client_charges.quantity']).toMatch(
      /double precision|real|numeric/,
    );
  });

  it('round-trips charge amounts as exact integer minor units', async () => {
    const charges = await ClientChargeCollection.create({ db });
    const charge = await charges.create({
      tenantId: TENANT_ID,
      // `usageEventId` is a foreign key, which is a native `uuid` column on
      // PostgreSQL — a readable slug fails with 22P02.
      usageEventId: randomUUID(),
      quantity: 1.5,
      amount: 2159, // $21.59
      currency: 'USD',
    });

    const reloaded = await charges.get(String(charge.id));
    // Exact equality, not toBeCloseTo — that is the point of minor units.
    expect(reloaded?.amount).toBe(2159);
    expect(reloaded?.quantity).toBeCloseTo(1.5, 6);
  });

  it('rejects a fractional major-unit spending limit rather than storing it', async () => {
    const policies = await SpendingPolicyCollection.create({ db });
    await expect(
      policies.create({
        tenantId: TENANT_ID,
        name: 'fractional',
        metricKey: 'ai.tokens',
        period: 'month',
        limitAmount: 19.99,
        currency: 'USD',
      }),
    ).rejects.toThrow();
  });
});
