/** Idempotent Commission Adjustment service coverage on real SQLite. */

import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getSQLFromDiff,
  getTestDatabase,
  ObjectRegistry,
  SchemaComparer,
  type SchemaDefinition,
} from '@happyvertical/smrt-core';
import {
  disableTenancy,
  enableTenancy,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import { type DatabaseInterface, getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CommissionAdjustmentCollection } from '../collections/CommissionAdjustmentCollection.js';
import { CommissionAdjustmentOperationCollection } from '../collections/CommissionAdjustmentOperationCollection.js';
import { CommissionCollection } from '../collections/CommissionCollection.js';
import { CommissionPayoutCollection } from '../collections/CommissionPayoutCollection.js';
import { EarnerCollection } from '../collections/EarnerCollection.js';
import type { Commission } from '../models/Commission.js';
import type { Earner } from '../models/Earner.js';
import {
  CommissionAdjustmentReplayConflictError,
  CommissionAdjustmentService,
  type CommissionAdjustmentValidationError,
  type CreateCommissionAdjustmentInput,
} from '../services/CommissionAdjustmentService.js';
import { CommissionPayoutService } from '../services/CommissionPayoutService.js';

describe('CommissionAdjustmentService', () => {
  let db: DatabaseInterface;
  let tenantId: string;
  let operatorProfileId: string;
  let earners: EarnerCollection;
  let commissions: CommissionCollection;
  let adjustments: CommissionAdjustmentCollection;
  let operations: CommissionAdjustmentOperationCollection;
  let earner: Earner;
  let commission: Commission;
  let service: CommissionAdjustmentService;

  beforeEach(async () => {
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    enableTenancy();
    tenantId = randomUUID();
    operatorProfileId = randomUUID();
    earners = await EarnerCollection.create({ db });
    commissions = await CommissionCollection.create({ db });
    adjustments = await CommissionAdjustmentCollection.create({ db });
    operations = await CommissionAdjustmentOperationCollection.create({ db });
    service = await CommissionAdjustmentService.create({ db });
    await withTenant({ tenantId }, async () => {
      earner = await earners.create({
        profileId: randomUUID(),
        displayName: 'Adjustment earner',
        status: 'active',
        payoutThresholdCents: 1,
        currency: 'USD',
      });
      commission = await commissions.create({
        earnerId: earner.id as string,
        amountCents: 1_000,
        currency: 'USD',
        status: 'payable',
        dedupeKey: `adjustment-parent-${randomUUID()}`,
      });
    });
  });

  afterEach(async () => {
    disableTenancy();
    await db.close?.();
  });

  function intent(
    overrides: Partial<CreateCommissionAdjustmentInput> = {},
  ): CreateCommissionAdjustmentInput {
    return {
      operationId: randomUUID(),
      tenantId,
      commissionId: commission.id as string,
      earnerId: earner.id as string,
      adjustmentKind: 'refund',
      amountCents: -250,
      currency: 'USD',
      reason: 'Customer refund',
      createdByProfileId: operatorProfileId,
      metadata: { ticket: 'SUP-42', nested: { b: 2, a: 1 } },
      ...overrides,
    };
  }

  it('registers no public operation field and an internal primary-key fence', () => {
    expect(
      ObjectRegistry.getFields('CommissionAdjustment').has('operationId'),
    ).toBe(false);
    expect(
      ObjectRegistry.getConfig('CommissionAdjustmentOperation'),
    ).toMatchObject({ api: false, mcp: false, cli: false });
  });

  it('upgrades the pre-operation SQLite schema without constraining legacy rows', async () => {
    const upgradePath = join(
      tmpdir(),
      `smrt-sales-adjustment-upgrade-${randomUUID()}.db`,
    );
    const upgradeDb = await getDatabase({
      type: 'sqlite',
      url: upgradePath,
      __smrtSkipVitestSchemaPreparation: true,
    } as Parameters<typeof getDatabase>[0]);
    try {
      await upgradeDb.query(`CREATE TABLE commission_adjustments (
        id UUID PRIMARY KEY NOT NULL,
        slug TEXT NOT NULL,
        context TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMP NOT NULL DEFAULT current_timestamp,
        updated_at TIMESTAMP NOT NULL DEFAULT current_timestamp,
        tenant_id UUID,
        commission_id UUID NOT NULL,
        earner_id UUID NOT NULL,
        adjustment_kind TEXT DEFAULT 'correction',
        amount_cents INTEGER DEFAULT 0,
        currency TEXT DEFAULT 'USD',
        reason TEXT NOT NULL DEFAULT '',
        created_by_profile_id UUID,
        payout_id UUID,
        metadata TEXT DEFAULT '{}'
      )`);
      for (const amountCents of [10, 20]) {
        const id = randomUUID();
        await upgradeDb.query(
          `INSERT INTO commission_adjustments (
             id, slug, tenant_id, commission_id, earner_id, amount_cents,
             reason
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            id,
            id,
            tenantId,
            commission.id,
            earner.id,
            amountCents,
            `Legacy correction ${amountCents}`,
          ],
        );
      }

      const adjustmentSchema = ObjectRegistry.getSchema('CommissionAdjustment');
      const operationSchema = ObjectRegistry.getSchema(
        'CommissionAdjustmentOperation',
      );
      expect(adjustmentSchema).toBeDefined();
      expect(operationSchema).toBeDefined();

      const comparer = new SchemaComparer(upgradeDb);
      const diff = await comparer.compare({
        commission_adjustments: adjustmentSchema as SchemaDefinition,
      });
      expect(
        diff.changes.some(
          (change) =>
            change.type === 'add_column' && change.name === 'operation_id',
        ),
      ).toBe(false);
      expect((adjustmentSchema as SchemaDefinition).ddl).not.toContain(
        'operation_id',
      );
      for (const sql of getSQLFromDiff(diff)) {
        await upgradeDb.query(sql);
      }

      const legacy = await upgradeDb.list('commission_adjustments', {});
      expect(legacy).toHaveLength(2);
      expect(legacy.every((row) => !Object.hasOwn(row, 'operation_id'))).toBe(
        true,
      );

      await upgradeDb.query((operationSchema as SchemaDefinition).ddl);
      const operationId = randomUUID();
      await upgradeDb.query(
        `INSERT INTO commission_adjustment_operations
           (id, slug, context, tenant_id, adjustment_id)
         VALUES (?, ?, '', ?, ?)`,
        [operationId, operationId, tenantId, randomUUID()],
      );
      await upgradeDb.query(
        `INSERT INTO commission_adjustment_operations
           (id, slug, context, tenant_id, adjustment_id)
         VALUES (?, ?, '', ?, ?)
         ON CONFLICT (id) DO NOTHING`,
        [operationId, operationId, tenantId, randomUUID()],
      );
      expect(
        await upgradeDb.list('commission_adjustment_operations', {}),
      ).toHaveLength(1);
    } finally {
      await upgradeDb.close?.();
      await rm(upgradePath, { force: true });
      await rm(`${upgradePath}-wal`, { force: true });
      await rm(`${upgradePath}-shm`, { force: true });
    }
  });

  it('creates once and returns the exact persisted row on replay', async () => {
    const input = intent();
    const first = await withTenant({ tenantId }, () =>
      service.createAdjustment(input),
    );
    const replay = await withTenant({ tenantId }, () =>
      service.createAdjustment({
        ...input,
        currency: 'usd',
        reason: ' Customer refund ',
        metadata: { nested: { a: 1, b: 2 }, ticket: 'SUP-42' },
      }),
    );

    expect(first.created).toBe(true);
    expect(replay.created).toBe(false);
    expect(replay.adjustment.id).toBe(first.adjustment.id);
    const operation = await withTenant({ tenantId }, () =>
      operations.findByOperationId(input.operationId),
    );
    expect(operation?.adjustmentId).toBe(first.adjustment.id);
  });

  it('preserves __proto__ metadata as immutable replay intent', async () => {
    const input = intent({
      metadata: JSON.parse('{"__proto__":{"case":"original"}}') as Record<
        string,
        unknown
      >,
    });
    const first = await withTenant({ tenantId }, () =>
      service.createAdjustment(input),
    );

    const persistedMetadata = JSON.parse(first.adjustment.metadata) as Record<
      string,
      unknown
    >;
    expect(Object.hasOwn(persistedMetadata, '__proto__')).toBe(true);
    expect(Reflect.get(persistedMetadata, '__proto__')).toEqual({
      case: 'original',
    });
    await expect(
      withTenant({ tenantId }, () =>
        service.createAdjustment({ ...input, metadata: {} }),
      ),
    ).rejects.toMatchObject({
      code: 'COMMISSION_ADJUSTMENT_REPLAY_CONFLICT',
      mismatches: ['metadata'],
    });
  });

  it.each([
    ['commissionId', () => randomUUID()],
    ['earnerId', () => randomUUID()],
    ['adjustmentKind', () => 'credit'],
    ['amountCents', () => -251],
    ['currency', () => 'CAD'],
    ['reason', () => 'Different correction'],
    ['createdByProfileId', () => randomUUID()],
    ['metadata', () => ({ ticket: 'SUP-99' })],
  ] as const)('fails closed when replay changes %s', async (field, replacement) => {
    const input = intent();
    await withTenant({ tenantId }, () => service.createAdjustment(input));
    const replay = { ...input, [field]: replacement() };

    const error = await withTenant({ tenantId }, async () => {
      try {
        await service.createAdjustment(replay);
        return null;
      } catch (caught) {
        return caught;
      }
    });
    expect(error).toBeInstanceOf(CommissionAdjustmentReplayConflictError);
    expect(
      (error as CommissionAdjustmentReplayConflictError).mismatches,
    ).toContain(field);
  });

  it('keeps operation UUIDs globally fail-closed across tenant boundaries', async () => {
    const input = intent();
    await withTenant({ tenantId }, () => service.createAdjustment(input));

    const otherTenantId = randomUUID();
    let otherEarner!: Earner;
    let otherCommission!: Commission;
    await withTenant({ tenantId: otherTenantId }, async () => {
      otherEarner = await earners.create({
        profileId: randomUUID(),
        displayName: 'Other tenant earner',
        status: 'active',
      });
      otherCommission = await commissions.create({
        earnerId: otherEarner.id as string,
        amountCents: 1_000,
        currency: 'USD',
        status: 'payable',
        dedupeKey: `other-parent-${randomUUID()}`,
      });
    });

    const error = await withTenant({ tenantId: otherTenantId }, async () => {
      try {
        await service.createAdjustment({
          ...input,
          tenantId: otherTenantId,
          commissionId: otherCommission.id as string,
          earnerId: otherEarner.id as string,
        });
        return null;
      } catch (caught) {
        return caught;
      }
    });
    expect(error).toBeInstanceOf(CommissionAdjustmentReplayConflictError);
    expect(
      (error as CommissionAdjustmentReplayConflictError).mismatches,
    ).toEqual(['tenantId']);
    expect(
      await withTenant({ tenantId: otherTenantId }, () =>
        operations.findByOperationId(input.operationId),
      ),
    ).toBeNull();
  });

  it('rejects noncanonical tenant UUID casing before any read', async () => {
    const uppercaseTenantId = tenantId.toUpperCase();
    await expect(
      withTenant({ tenantId: uppercaseTenantId }, () =>
        service.createAdjustment(intent({ tenantId: uppercaseTenantId })),
      ),
    ).rejects.toMatchObject<Partial<CommissionAdjustmentValidationError>>({
      reason: 'invalid_tenant_id',
    });
  });

  it('rolls back the operation fence when adjustment persistence fails', async () => {
    const input = intent();
    await db.query(`CREATE TRIGGER fail_commission_adjustment_insert
      BEFORE INSERT ON commission_adjustments
      BEGIN
        SELECT RAISE(ABORT, 'forced adjustment insert failure');
      END`);

    await expect(
      withTenant({ tenantId }, () => service.createAdjustment(input)),
    ).rejects.toThrow(/forced adjustment insert failure/);
    await db.query('DROP TRIGGER fail_commission_adjustment_insert');

    expect(
      await withTenant({ tenantId }, () =>
        operations.findByOperationId(input.operationId),
      ),
    ).toBeNull();
    const retry = await withTenant({ tenantId }, () =>
      service.createAdjustment(input),
    );
    expect(retry.created).toBe(true);
  });

  it('validates parent denormalization and operator UUID before persistence', async () => {
    await expect(
      withTenant({ tenantId }, () =>
        service.createAdjustment(intent({ earnerId: randomUUID() })),
      ),
    ).rejects.toMatchObject<Partial<CommissionAdjustmentValidationError>>({
      reason: 'earner_mismatch',
    });
    await expect(
      withTenant({ tenantId }, () =>
        service.createAdjustment(intent({ currency: 'CAD' })),
      ),
    ).rejects.toMatchObject<Partial<CommissionAdjustmentValidationError>>({
      reason: 'currency_mismatch',
    });
    await expect(
      withTenant({ tenantId }, () =>
        service.createAdjustment(
          intent({ createdByProfileId: 'not-a-profile-uuid' }),
        ),
      ),
    ).rejects.toMatchObject<Partial<CommissionAdjustmentValidationError>>({
      reason: 'invalid_operator_profile_id',
    });
  });

  it('appends distinct operations and settles both', async () => {
    const first = await withTenant({ tenantId }, () =>
      service.createAdjustment(intent({ amountCents: -200 })),
    );
    const second = await withTenant({ tenantId }, () =>
      service.createAdjustment(
        intent({ adjustmentKind: 'credit', amountCents: 50 }),
      ),
    );
    expect(first.adjustment.id).not.toBe(second.adjustment.id);

    const payouts = await CommissionPayoutCollection.create({ db });
    const payoutService = new CommissionPayoutService({
      earners,
      commissions,
      adjustments,
      payouts,
    });
    const batch = await withTenant({ tenantId }, () =>
      payoutService.createPayoutBatch({
        earnerId: earner.id as string,
        currency: 'USD',
        idempotencyKey: `adjustment-settlement-${randomUUID()}`,
      }),
    );
    expect(batch.created).toBe(true);
    expect(batch.settledAdjustmentIds.sort()).toEqual(
      [first.adjustment.id, second.adjustment.id].sort(),
    );
  });

  it('keeps legacy direct creates append-only and distinct', async () => {
    const [first, second] = await withTenant({ tenantId }, async () => [
      await adjustments.create({
        commissionId: commission.id as string,
        earnerId: earner.id as string,
        adjustmentKind: 'correction',
        amountCents: 10,
        currency: 'USD',
        reason: 'Legacy direct correction one',
      }),
      await adjustments.create({
        commissionId: commission.id as string,
        earnerId: earner.id as string,
        adjustmentKind: 'correction',
        amountCents: 20,
        currency: 'USD',
        reason: 'Legacy direct correction two',
      }),
    ]);
    expect(first.id).not.toBe(second.id);
  });

  it('rejects untyped operation IDs on the public collection path', async () => {
    const input = intent();
    const createDirectly = () =>
      withTenant({ tenantId }, () =>
        adjustments.create({
          operationId: input.operationId,
          commissionId: input.commissionId,
          earnerId: input.earnerId,
          adjustmentKind: input.adjustmentKind,
          amountCents: input.amountCents,
          currency: input.currency,
          reason: input.reason,
          createdByProfileId: input.createdByProfileId,
          metadata: JSON.stringify(input.metadata),
        } as unknown as Parameters<typeof adjustments.create>[0]),
      );

    await expect(createDirectly()).rejects.toThrow(
      /has no public operationId field/,
    );
    await expect(createDirectly()).rejects.toThrow(
      /has no public operationId field/,
    );
    const created = await withTenant({ tenantId }, () =>
      service.createAdjustment(input),
    );
    expect(created.created).toBe(true);
    const operation = await withTenant({ tenantId }, () =>
      operations.findByOperationId(input.operationId),
    );
    expect(operation?.adjustmentId).toBe(created.adjustment.id);
    expect(
      await withTenant({ tenantId }, () => adjustments.list()),
    ).toHaveLength(1);
  });
});
