/**
 * PostgreSQL regression coverage for global CommissionPlan resolution (#1982).
 *
 * The row is inserted independently through SQL, then hydrated through the
 * public collection API. This covers the production migration path that does
 * not have an in-memory model instance available to the resolver.
 */

import { randomUUID } from 'node:crypto';
import {
  createIsolatedTestDbFromManifest,
  type IsolatedTestDbResult,
  isPostgresAvailable,
} from '@happyvertical/smrt-vitest';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CommissionPlanCollection } from '../collections/CommissionPlanCollection.js';

const describePostgres = isPostgresAvailable() ? describe : describe.skip;

describePostgres('CommissionPlan PostgreSQL global resolution (#1982)', () => {
  let isolated: IsolatedTestDbResult | undefined;
  let db: DatabaseInterface;
  let plans: CommissionPlanCollection;

  beforeEach(async () => {
    isolated = await createIsolatedTestDbFromManifest({
      includeObjects: ['CommissionPlan'],
    });
    if (isolated.config.type !== 'postgres') {
      throw new Error('Expected a PostgreSQL test database.');
    }
    db = isolated.db;
    plans = await CommissionPlanCollection.create({ db });
  });

  afterEach(async () => {
    await isolated?.cleanup();
    isolated = undefined;
  });

  async function insertGlobalPlan({
    id = randomUUID(),
    version,
    effectiveFrom,
  }: {
    id?: string;
    version: number;
    effectiveFrom: Date;
  }): Promise<string> {
    await db.query(
      `INSERT INTO commission_plans (
        id, slug, context, tenant_id, plan_key, version,
        name, description, status, effective_from, currency, components, metadata
      ) VALUES (
        $1, $2, '', NULL, 'postgres-global-plan', $3,
        'PostgreSQL global plan', '', 'active', $4, 'CAD', '[]', '{}'
      )`,
      id,
      `postgres-global-plan-v${version}`,
      version,
      effectiveFrom,
    );
    return id;
  }

  it('hydrates and resolves a separately persisted global row', async () => {
    const governingId = await insertGlobalPlan({
      version: 1,
      effectiveFrom: new Date('2026-07-01T00:00:00Z'),
    });
    await insertGlobalPlan({
      version: 2,
      effectiveFrom: new Date('2026-08-01T00:00:00Z'),
    });

    const beforeAmendment = await plans.latestActiveByKey(
      'postgres-global-plan',
      new Date('2026-07-15T00:00:00Z'),
      null,
    );
    expect(beforeAmendment?.id).toBe(governingId);
    expect(beforeAmendment?.tenantId).toBeNull();
    expect(beforeAmendment?.version).toBe(1);

    const afterAmendment = await plans.latestActiveByKey(
      'postgres-global-plan',
      new Date('2026-08-01T00:00:00Z'),
      null,
    );
    expect(afterAmendment?.version).toBe(2);
  });
});
