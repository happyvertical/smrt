/** Real two-transaction PostgreSQL proof for adjustment operation replay. */

import { randomUUID } from 'node:crypto';
import {
  disableTenancy,
  enableTenancy,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import {
  createIsolatedTestDbFromManifest,
  type IsolatedTestDbResult,
  isPostgresAvailable,
} from '@happyvertical/smrt-vitest';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CommissionAdjustmentCollection } from '../collections/CommissionAdjustmentCollection.js';
import { CommissionAdjustmentOperationCollection } from '../collections/CommissionAdjustmentOperationCollection.js';
import { CommissionCollection } from '../collections/CommissionCollection.js';
import { EarnerCollection } from '../collections/EarnerCollection.js';
import {
  CommissionAdjustmentService,
  type CreateCommissionAdjustmentInput,
} from '../services/CommissionAdjustmentService.js';

interface TransactionDatabase extends DatabaseInterface {
  transaction<T>(fn: (tx: DatabaseInterface) => Promise<T>): Promise<T>;
}

const describePostgres = isPostgresAvailable() ? describe : describe.skip;

describePostgres('CommissionAdjustmentService on PostgreSQL', () => {
  let isolated: IsolatedTestDbResult | undefined;
  let db: TransactionDatabase;

  beforeEach(async () => {
    enableTenancy();
    isolated = await createIsolatedTestDbFromManifest({
      includeObjects: [
        'Earner',
        'Commission',
        'CommissionAdjustment',
        'CommissionAdjustmentOperation',
      ],
    });
    if (isolated.config.type !== 'postgres') {
      throw new Error('Expected a PostgreSQL test database');
    }
    db = isolated.baseDb as TransactionDatabase;
    if (typeof db.transaction !== 'function') {
      throw new Error('PostgreSQL test database must expose transaction()');
    }
  });

  afterEach(async () => {
    disableTenancy();
    await isolated?.cleanup();
    isolated = undefined;
  });

  it.each(
    Array.from({ length: 12 }, (_, index) => index),
  )('serializes concurrent transactions as one create and one exact replay (%i)', async () => {
    const tenantId = randomUUID();
    const baseEarners = await EarnerCollection.create({ db });
    const baseCommissions = await CommissionCollection.create({ db });
    const baseAdjustments = await CommissionAdjustmentCollection.create({ db });
    const { earnerId, commissionId } = await withTenant(
      { tenantId },
      async () => {
        const earner = await baseEarners.create({
          profileId: randomUUID(),
          displayName: 'Concurrent PG earner',
          status: 'active',
        });
        const commission = await baseCommissions.create({
          earnerId: earner.id as string,
          amountCents: 4_000,
          currency: 'USD',
          status: 'payable',
          dedupeKey: `pg-adjustment-parent-${randomUUID()}`,
        });
        return {
          earnerId: earner.id as string,
          commissionId: commission.id as string,
        };
      },
    );
    const input: CreateCommissionAdjustmentInput = {
      operationId: randomUUID(),
      tenantId,
      commissionId,
      earnerId,
      adjustmentKind: 'chargeback',
      amountCents: -1_250,
      currency: 'USD',
      reason: 'Processor chargeback',
      createdByProfileId: randomUUID(),
      metadata: { providerCase: 'cb-2044' },
    };

    let ready = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const invoke = async () => {
      ready += 1;
      if (ready === 2) release();
      await gate;
      return await withTenant({ tenantId }, async () => {
        const service = await CommissionAdjustmentService.create({ db });
        return await service.createAdjustment(input);
      });
    };

    const results = await Promise.all([invoke(), invoke()]);
    expect(results.map((result) => result.created).sort()).toEqual([
      false,
      true,
    ]);
    expect(results[0].adjustment.id).toBe(results[1].adjustment.id);

    const persisted = await withTenant({ tenantId }, () =>
      baseAdjustments.list(),
    );
    expect(persisted).toHaveLength(1);
    expect(persisted[0].amountCents).toBe(-1_250);
    expect(persisted[0].reason).toBe('Processor chargeback');

    const service = await CommissionAdjustmentService.create({ db });
    await expect(
      withTenant({ tenantId }, () =>
        service.createAdjustment({ ...input, amountCents: -900 }),
      ),
    ).rejects.toMatchObject({
      code: 'COMMISSION_ADJUSTMENT_REPLAY_CONFLICT',
      mismatches: ['amountCents'],
    });
    const otherTenantId = randomUUID();
    await withTenant({ tenantId: otherTenantId }, async () => {
      const earner = await baseEarners.create({
        profileId: randomUUID(),
        displayName: 'Other tenant',
        status: 'active',
      });
      const commission = await baseCommissions.create({
        earnerId: earner.id as string,
        amountCents: 4000,
        currency: 'USD',
        status: 'payable',
        dedupeKey: randomUUID(),
      });
      await expect(
        service.createAdjustment({
          ...input,
          tenantId: otherTenantId,
          earnerId: earner.id as string,
          commissionId: commission.id as string,
        }),
      ).rejects.toMatchObject({
        code: 'COMMISSION_ADJUSTMENT_REPLAY_CONFLICT',
        mismatches: ['tenantId'],
      });
      expect(await baseAdjustments.list()).toHaveLength(0);
    });
  });

  it('keeps a transaction usable when the slug/context arbiter wins', async () => {
    const tenantId = randomUUID();
    const operationId = randomUUID();
    const existingId = randomUUID();
    await db.query(
      `INSERT INTO commission_adjustment_operations
         (id, slug, context, tenant_id, adjustment_id)
       VALUES (?, ?, '', ?, ?)`,
      [existingId, operationId, tenantId, randomUUID()],
    );
    await withTenant({ tenantId }, () =>
      db.transaction(async (tx) => {
        const operations = await CommissionAdjustmentOperationCollection.create(
          {
            db: tx,
          },
        );
        const result = await operations.claim({
          operationId,
          tenantId,
          adjustmentId: randomUUID(),
        });
        // A conflicting slug is never authority to return another operation.
        expect(result).toEqual({ claimed: false, operation: null });
        expect(await operations.findByOperationId(existingId)).not.toBeNull();
      }),
    );
  });
});
