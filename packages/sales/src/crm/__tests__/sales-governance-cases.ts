/** Authority, exact terms, lease fencing and executor-affinity acceptance tests. */
import { randomUUID } from 'node:crypto';
import { getTestDatabase } from '@happyvertical/smrt-core';
import {
  disableTenancy,
  enableTenancy,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SalesGovernanceEventCollection } from '../collections/SalesGovernanceEventCollection.js';
import { SalesGovernanceStateCollection } from '../collections/SalesGovernanceStateCollection.js';
import { SalesRepresentativeCollection } from '../collections/SalesRepresentativeCollection.js';
import { SalesGovernanceService } from '../services/SalesGovernanceService.js';
import type {
  SalesGovernanceDatabaseConfig,
  SalesGovernanceHost,
  SalesQuoteTerms,
} from '../services/sales-governance-types.js';

export function salesGovernanceCases(
  label: string,
  createConfig: () => Promise<SalesGovernanceDatabaseConfig>,
  cleanup?: () => Promise<void>,
) {
  describe(`seller governance (${label})`, () => {
    let db: DatabaseInterface;
    let service: SalesGovernanceService;
    let reps: SalesRepresentativeCollection;
    let tenantId: string;
    let actor: string;
    let sellerId: string;
    let checker: string;
    let now: number;
    let host: SalesGovernanceHost;
    let terms: SalesQuoteTerms;
    const scope = <T>(fn: () => Promise<T>) => withTenant({ tenantId }, fn);
    const op = () => ({
      tenantId,
      actorProfileId: actor,
      operationId: randomUUID(),
    });
    const quoteOp = () => ({
      ...op(),
      quoteId: terms.quoteId,
      revision: terms.revision,
    });
    const leaseOp = () => ({
      ...op(),
      sellerId,
      advertiserId: terms.advertiserId,
    });

    beforeEach(async () => {
      enableTenancy();
      const database = await createConfig();
      tenantId = randomUUID();
      actor = randomUUID();
      checker = randomUUID();
      now = 100000;
      host = {
        isMember: vi.fn(async () => true),
        isUnsuspended: vi.fn(async () => true),
        canSell: vi.fn(async () => true),
        canApprove: vi.fn(async () => true),
        advertiserExists: vi.fn(async () => true),
        validateQuote: vi.fn(async () => true),
        policy: vi.fn(async () => ({
          version: 'v1',
          maxDiscountBps: 1000,
          leaseDurationMs: 1000,
          approvalDurationMs: 2000,
        })),
      };
      service = await SalesGovernanceService.create({
        database,
        host,
        now: () => new Date(now),
      });
      db = service.database;
      await getTestDatabase({
        db,
        classes: [
          'SalesGovernanceState',
          'SalesGovernanceEvent',
          'SalesRepresentative',
          'Earner',
        ],
      });
      reps = await SalesRepresentativeCollection.create({ db });
      // Canonical optional FK absence; older SalesRepresentative's legacy empty
      // default is unrelated to governance and invalid on native UUID adapters.
      sellerId = randomUUID();
      await db.insert(reps.tableName, {
        id: sellerId,
        slug: sellerId,
        context: '',
        tenant_id: tenantId,
        profile_id: actor,
        earner_id: null,
        status: 'active',
        title: '',
        metadata: '{}',
      });
      terms = {
        quoteId: randomUUID(),
        revision: 1,
        sellerId,
        advertiserId: randomUUID(),
        rateCardVersion: 'rate-v1',
        subtotalCents: 10000,
        totalCents: 9000,
        currency: 'CAD',
        inventoryVersion: 'inventory-v1',
      };
    });
    afterEach(async () => {
      disableTenancy();
      if (cleanup) await cleanup();
      await db?.close?.();
    });

    if (label === 'PostgreSQL')
      it('arbitrates competing sellers on independent pooled transaction connections', async () => {
        const otherSeller = randomUUID();
        const otherActor = randomUUID();
        await db.insert(reps.tableName, {
          id: otherSeller,
          slug: otherSeller,
          context: '',
          tenant_id: tenantId,
          profile_id: otherActor,
          earner_id: null,
          status: 'active',
          title: '',
          metadata: '{}',
        });
        const pids = new Set<number>();
        host.isMember = async (_context, tx) => {
          const result = await tx.query('SELECT pg_backend_pid() AS pid');
          pids.add(result.rows[0].pid);
          return true;
        };
        const inputs = [
          leaseOp(),
          { ...leaseOp(), sellerId: otherSeller, actorProfileId: otherActor },
        ];
        const results = await Promise.allSettled(
          inputs.map((input) => scope(() => service.acquireLease(input))),
        );
        expect(pids.size).toBe(2);
        expect(
          results.filter((result) => result.status === 'fulfilled'),
        ).toHaveLength(1);
        const loser = results.findIndex(
          (result) => result.status === 'rejected',
        );
        await expect(
          scope(() => service.acquireLease(inputs[loser])),
        ).rejects.toThrow('already_registered');
      });

    it('closes direct collection/model mutation bypasses', async () => {
      const input = leaseOp();
      await scope(() => service.acquireLease(input));
      const states = await SalesGovernanceStateCollection.create({ db });
      const events = await SalesGovernanceEventCollection.create({ db });
      const state = (await scope(() => states.list({ limit: 100 })))[0];
      await expect(
        scope(() => states.create({ tenantId, payload: '{}' })),
      ).rejects.toThrow('service-owned');
      await expect(scope(() => states.ensure(randomUUID()))).rejects.toThrow(
        'service-owned',
      );
      await expect(scope(() => states.lock(state.id!))).rejects.toThrow(
        'service-owned',
      );
      await expect(
        scope(() => states.compareAndSwap(state.id!, state.revision, '{}')),
      ).rejects.toThrow('service-owned');
      await expect(
        scope(() => states.update(state.id!, { payload: '{}' })),
      ).rejects.toThrow('service-owned');
      await expect(scope(() => states.delete(state.id!))).rejects.toThrow(
        'service-owned',
      );
      await expect(scope(() => state.save())).rejects.toThrow('service-owned');
      await expect(
        scope(() => events.create({ tenantId, intent: 'fake', result: '{}' })),
      ).rejects.toThrow('service-owned');
      await expect(
        scope(() => events.delete(input.operationId)),
      ).rejects.toThrow('cannot be deleted');
      await scope(() =>
        service.withTransaction(async (tx) => {
          const direct = await SalesGovernanceStateCollection.create({
            db: tx,
          });
          await expect(
            direct.create({ tenantId, payload: '{}' }),
          ).rejects.toThrow('service-owned');
        }),
      );
    });

    it('requires actor, active tenant, owned active role and all host guards', async () => {
      const input = { ...op(), terms };
      await expect(service.createQuote(input)).rejects.toThrow();
      await expect(
        scope(() => service.createQuote({ ...input, actorProfileId: '' })),
      ).rejects.toThrow();
      await expect(
        withTenant({ tenantId: randomUUID() }, () =>
          service.createQuote(input),
        ),
      ).rejects.toThrow();
      await expect(
        scope(() =>
          service.createQuote({ ...input, actorProfileId: randomUUID() }),
        ),
      ).rejects.toThrow('seller_unauthorized');
      for (const field of [
        'isMember',
        'isUnsuspended',
        'canSell',
        'advertiserExists',
        'validateQuote',
      ] as const) {
        const previous = host[field];
        host[field] = vi.fn(async () => false);
        await expect(scope(() => service.createQuote(input))).rejects.toThrow();
        Object.assign(host, { [field]: previous });
      }
      host.validateQuote = vi.fn(async () => {
        throw new Error('inventory offline');
      });
      await expect(scope(() => service.createQuote(input))).rejects.toThrow(
        'inventory offline',
      );
      host.validateQuote = vi.fn(async () => true);
      await db.query(
        `UPDATE ${reps.tableName} SET status = 'inactive' WHERE id = ?`,
        sellerId,
      );
      await expect(scope(() => service.createQuote(input))).rejects.toThrow(
        'seller_unauthorized',
      );
    });

    it('preserves lease expiry on retry, rejects conflicting replay, and fences expiry/release/renewal', async () => {
      const input = leaseOp();
      const lease = await scope(() => service.acquireLease(input));
      now += 100;
      expect(await scope(() => service.acquireLease(input))).toEqual(lease);
      await expect(
        scope(() =>
          service.acquireLease({ ...input, advertiserId: randomUUID() }),
        ),
      ).rejects.toThrow('replay_conflict');
      await expect(
        scope(() => service.acquireLease(leaseOp())),
      ).rejects.toThrow('already_registered');
      await expect(
        scope(() =>
          service.releaseLease({ ...leaseOp(), leaseId: randomUUID() }),
        ),
      ).rejects.toThrow('owner_mismatch');
      const renewed = await scope(() =>
        service.renewLease({ ...leaseOp(), leaseId: lease.leaseId }),
      );
      expect(renewed.expiresAtMs).toBe(now + 1000);
      now = renewed.expiresAtMs;
      await expect(
        scope(() =>
          service.renewLease({ ...leaseOp(), leaseId: lease.leaseId }),
        ),
      ).rejects.toThrow('lease_expired');
      const replacement = await scope(() => service.acquireLease(leaseOp()));
      await expect(
        scope(() =>
          service.releaseLease({ ...leaseOp(), leaseId: lease.leaseId }),
        ),
      ).rejects.toThrow('owner_mismatch');
      await scope(() =>
        service.releaseLease({ ...leaseOp(), leaseId: replacement.leaseId }),
      );
      expect(
        (await scope(() => service.acquireLease(leaseOp()))).leaseId,
      ).not.toBe(replacement.leaseId);
    });

    it('issues exact boundary cents, rejects malformed values and rechecks seller revocation at sign', async () => {
      await scope(() => service.createQuote({ ...op(), terms }));
      await scope(() => service.issueQuote(quoteOp()));
      await db.query(
        `UPDATE ${reps.tableName} SET status = 'inactive' WHERE id = ?`,
        sellerId,
      );
      await expect(scope(() => service.signQuote(quoteOp()))).rejects.toThrow(
        'seller_unauthorized',
      );
      for (const totalCents of [-1, 1.1, Number.MAX_SAFE_INTEGER + 1, 10001]) {
        await expect(
          scope(() =>
            service.createQuote({ ...op(), terms: { ...terms, totalCents } }),
          ),
        ).rejects.toThrow();
      }
    });

    it('binds approval to exact revision/policy and requires distinct current authorized finance', async () => {
      terms.totalCents = 8999;
      await scope(() => service.createQuote({ ...op(), terms }));
      await expect(scope(() => service.issueQuote(quoteOp()))).rejects.toThrow(
        'approval_required',
      );
      const request = await scope(() => service.requestApproval(quoteOp()));
      const decision = {
        ...quoteOp(),
        requestId: request.approval!.requestId,
        decision: 'approved' as const,
        reason: 'approved exception',
      };
      await expect(
        scope(() => service.decideApproval(decision)),
      ).rejects.toThrow('self_approval');
      host.canApprove = vi.fn(async () => false);
      await expect(
        scope(() =>
          service.decideApproval({ ...decision, actorProfileId: checker }),
        ),
      ).rejects.toThrow('finance_unauthorized');
      host.canApprove = vi.fn(async () => true);
      await expect(
        scope(() =>
          service.decideApproval({
            ...decision,
            actorProfileId: checker,
            requestId: randomUUID(),
          }),
        ),
      ).rejects.toThrow('approval_mismatch');
      await scope(() =>
        service.decideApproval({ ...decision, actorProfileId: checker }),
      );
      await scope(() => service.issueQuote(quoteOp()));
      host.canApprove = vi.fn(async () => false);
      await expect(scope(() => service.signQuote(quoteOp()))).rejects.toThrow(
        'finance_unauthorized',
      );
      host.canApprove = vi.fn(async () => true);
      await scope(() =>
        service.decideApproval({
          ...quoteOp(),
          actorProfileId: checker,
          requestId: decision.requestId,
          decision: 'revoked',
          reason: 'revoked',
        }),
      );
      await expect(scope(() => service.signQuote(quoteOp()))).rejects.toThrow(
        'approval_required',
      );
    });

    it.each([
      'pending',
      'rejected',
      'expired',
      'policy',
      'revision',
    ] as const)('denies stale approval state: %s', async (kind) => {
      terms.totalCents = 8000;
      await scope(() => service.createQuote({ ...op(), terms }));
      const requested = await scope(() => service.requestApproval(quoteOp()));
      if (kind !== 'pending') {
        await scope(() =>
          service.decideApproval({
            ...quoteOp(),
            actorProfileId: checker,
            requestId: requested.approval!.requestId,
            decision: kind === 'rejected' ? 'rejected' : 'approved',
            reason: 'reviewed',
          }),
        );
      }
      if (kind === 'expired') now += 2000;
      if (kind === 'policy')
        host.policy = vi.fn(async () => ({
          version: 'v2',
          maxDiscountBps: 1000,
          leaseDurationMs: 1000,
          approvalDurationMs: 2000,
        }));
      if (kind === 'revision')
        await scope(() =>
          service.createQuote({ ...op(), terms: { ...terms, revision: 2 } }),
        );
      await expect(
        scope(() => service.issueQuote(quoteOp())),
      ).rejects.toThrow();
    });

    it.each([
      'totalCents',
      'subtotalCents',
      'currency',
      'rateCardVersion',
      'inventoryVersion',
      'advertiserId',
      'makerProfileId',
    ] as const)('rejects altered approved binding: %s', async (field) => {
      terms.totalCents = 8000;
      await scope(() => service.createQuote({ ...op(), terms }));
      const requested = await scope(() => service.requestApproval(quoteOp()));
      await scope(() =>
        service.decideApproval({
          ...quoteOp(),
          actorProfileId: checker,
          requestId: requested.approval!.requestId,
          decision: 'approved',
          reason: 'reviewed',
        }),
      );
      const states = await SalesGovernanceStateCollection.create({ db });
      const rows = await scope(() => states.list({ limit: 100 }));
      const state = rows.find(
        (row) => JSON.parse(row.payload).quoteId === terms.quoteId,
      )!;
      const payload = JSON.parse(state.payload);
      payload[field] =
        typeof payload[field] === 'number' ? payload[field] + 1 : randomUUID();
      state.payload = JSON.stringify(payload);
      // Corruption simulation uses the fixture's privileged SQL owner; the
      // public collection/model write paths are independently refused below.
      await db.query(
        `UPDATE ${states.tableName} SET payload = ? WHERE id = ?`,
        state.payload,
        state.id,
      );
      await expect(scope(() => service.issueQuote(quoteOp()))).rejects.toThrow(
        'approval_required',
      );
    });

    it('rejects unknown policy values and honors host failure without partial state', async () => {
      const previous = host.policy;
      for (const maxDiscountBps of [-1, 10001, 0.5, NaN]) {
        host.policy = async (...args) => ({
          ...(await previous(...args)),
          maxDiscountBps,
        });
        await expect(
          scope(() => service.createQuote({ ...op(), terms })),
        ).rejects.toThrow('invalid_numeric_value');
      }
      host.policy = previous;
      expect(
        await scope(() =>
          service.getLease({
            tenantId,
            actorProfileId: actor,
            advertiserId: terms.advertiserId,
          }),
        ),
      ).toBeNull();
    });

    it('commits sign authority and preflight rechecks even exact historical replay', async () => {
      const create = { ...op(), terms };
      await scope(() => service.createQuote(create));
      await scope(() => service.issueQuote(quoteOp()));
      const sign = quoteOp();
      await scope(() => service.signQuote(sign));
      await scope(() => service.assertCanSign(sign));
      host.isUnsuspended = vi.fn(async () => false);
      expect((await scope(() => service.signQuote(sign))).status).toBe(
        'signed',
      ); // evidence replay only
      await expect(scope(() => service.assertCanSign(sign))).rejects.toThrow(
        'suspended',
      );
    });

    it('binds host writes to one transaction and rolls back lease, event and host mutation', async () => {
      const input = leaseOp();
      await expect(
        scope(() => service.acquireLease(input, db)),
      ).rejects.toThrow('transaction_executor_required');
      await expect(
        scope(() =>
          service.withTransaction(async (tx) => {
            await service.acquireLease(input, tx);
            expect(host.canSell).toHaveBeenCalledWith(
              expect.objectContaining({ sellerId }),
              tx,
            );
            await tx.query(
              `UPDATE ${reps.tableName} SET title = 'rolled back' WHERE id = ?`,
              sellerId,
            );
            throw new Error('rollback');
          }),
        ),
      ).rejects.toThrow('rollback');
      const events = await SalesGovernanceEventCollection.create({ db });
      expect(
        await scope(() => events.get({ id: input.operationId })),
      ).toBeNull();
      expect(
        (await scope(() => reps.get({ id: sellerId }, { cache: false })))
          ?.title,
      ).toBe('');
      expect(await scope(() => service.acquireLease(input))).toMatchObject({
        leaseId: input.operationId,
      });
      const audit = await scope(() =>
        events.get({ id: input.operationId }, { cache: false }),
      );
      audit!.result = '{}';
      await expect(scope(() => audit!.save())).rejects.toThrow('immutable');
      await expect(scope(() => audit!.delete())).rejects.toThrow(
        'cannot be deleted',
      );
    });
  });
}
