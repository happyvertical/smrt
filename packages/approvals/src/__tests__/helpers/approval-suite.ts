/**
 * The approval behaviour suite, shared by the SQLite, DuckDB, and PostgreSQL
 * lanes so every adapter proves the same contract: transitions and their
 * refusals, quorum, expiry, revision binding, tenant isolation, the
 * append-only ledger, and concurrent double-approve / double-consume.
 *
 * Every test works in fresh tenants with tenancy enabled, so the PostgreSQL
 * lane can share one migrated database.
 */

import { randomUUID } from 'node:crypto';
import { GlobalInterceptors } from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/smrt-core/migrations';
import {
  disableTenancy,
  enableTenancy,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defineApprovalKind } from '../../kinds.js';
import {
  CANCEL_ANY_APPROVAL_PERMISSION,
  MANAGE_APPROVAL_POLICY_PERMISSION,
} from '../../permissions.js';
import { ApprovalService } from '../../service.js';
import {
  type ApprovalPrincipal,
  type ApprovalPrincipalType,
  approvalPrincipalFromPermissions,
} from '../../types.js';

export const SUBJECT = '@happyvertical/smrt-content:Content';
export const DECIDE = 'content.approve-publish';
export const EXTRA = 'content.approve-legal';
const HOUR = 60 * 60 * 1000;

/** One approver, the default kind. */
export const singleKind = defineApprovalKind({
  key: 'content.publish',
  subject: SUBJECT,
  permission: DECIDE,
  defaults: { requiredApprovals: 1, ttlMs: 24 * HOUR },
});

/** Two distinct approvers. */
export const quorumKind = defineApprovalKind({
  key: 'content.publish-dual',
  subject: SUBJECT,
  permission: DECIDE,
  defaults: { requiredApprovals: 2, ttlMs: 24 * HOUR },
});

/** A mutable clock the service reads on every transition. */
export class TestClock {
  private ms = Date.parse('2026-10-01T12:00:00.000Z');
  now = (): Date => new Date(this.ms);
  advance(ms: number): void {
    this.ms += ms;
  }
}

/** Principals and a service bound to one database and tenant. */
export interface ApprovalWorld {
  db: DatabaseInterface;
  tenantId: string;
  clock: TestClock;
  service: ApprovalService;
  principal(
    type?: ApprovalPrincipalType,
    permissions?: string[],
    tenantId?: string,
  ): ApprovalPrincipal;
  requester: ApprovalPrincipal;
  approverA: ApprovalPrincipal;
  approverB: ApprovalPrincipal;
  approverC: ApprovalPrincipal;
}

/** Build a world over `db` with its own tenant. */
export function createWorld(db: DatabaseInterface): ApprovalWorld {
  const tenantId = randomUUID();
  const clock = new TestClock();
  const principal = (
    type: ApprovalPrincipalType = 'human',
    permissions: string[] = [DECIDE],
    tenant = tenantId,
  ) =>
    approvalPrincipalFromPermissions(permissions, {
      id: randomUUID(),
      tenantId: tenant,
      type,
    });
  return {
    db,
    tenantId,
    clock,
    service: new ApprovalService({ db, now: clock.now }),
    principal,
    requester: principal('human', []),
    approverA: principal(),
    approverB: principal(),
    approverC: principal(),
  };
}

function requestId(result: { request: { id?: string | null } | null }): string {
  const id = result.request?.id;
  if (!id) throw new Error('expected a request');
  return id;
}

/** Register the suite. `getDb` returns the lane's database. */
export function defineApprovalSuite(getDb: () => DatabaseInterface): void {
  const world = () => createWorld(getDb());

  beforeAll(() => {
    enableTenancy();
  });
  afterAll(() => {
    disableTenancy();
  });

  async function open(
    w: ApprovalWorld,
    kind = singleKind,
    hash = 'rev-1',
    requester = w.requester,
  ): Promise<string> {
    const result = await w.service.requestApproval(requester, {
      kind,
      subjectId: randomUUID(),
      subjectRevisionHash: hash,
      summary: 'Publish the launch post',
    });
    expect(result.outcome).toBe('transitioned');
    return requestId(result);
  }

  async function approved(w: ApprovalWorld, hash = 'rev-1'): Promise<string> {
    const id = await open(w, singleKind, hash);
    const result = await w.service.decide(w.approverA, id, {
      decision: 'approve',
    });
    expect(result.outcome).toBe('transitioned');
    return id;
  }

  async function eventTypes(w: ApprovalWorld, id: string): Promise<string[]> {
    const events = await w.service.listEvents(w.requester, id);
    return events.map((event) => event.type);
  }

  describe('requestApproval', () => {
    it('opens a pending request with the kind defaults and a created event', async () => {
      const w = world();
      const result = await w.service.requestApproval(w.requester, {
        kind: singleKind,
        subjectId: 'post-1',
        subjectRevisionHash: 'rev-1',
      });
      expect(result.outcome).toBe('transitioned');
      const request = result.request;
      expect(request).toMatchObject({
        tenantId: w.tenantId,
        kind: 'content.publish',
        subjectType: SUBJECT,
        subjectId: 'post-1',
        subjectRevisionHash: 'rev-1',
        requestedBy: w.requester.id,
        requestedByType: 'human',
        status: 'pending',
        requiredApprovals: 1,
        approvalCount: 0,
      });
      expect(Number(request?.version)).toBe(1);
      expect(request?.getRequiredPermissions()).toEqual([DECIDE]);
      expect(request?.expiresAtMs()).toBe(w.clock.now().getTime() + 24 * HOUR);
      const events = await w.service.listEvents(w.requester, requestId(result));
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'created',
        actorId: w.requester.id,
        sequence: 1,
        voteKey: null,
      });
    });

    it('lets an agent request', async () => {
      const w = world();
      const agent = w.principal('agent', []);
      const result = await w.service.requestApproval(agent, {
        kind: singleKind.key,
        subjectId: 'post-1',
        subjectRevisionHash: 'rev-1',
      });
      expect(result.outcome).toBe('transitioned');
      expect(result.request?.requestedByType).toBe('agent');
    });

    it('replays an idempotent requestKey and refuses a conflicting reuse', async () => {
      const w = world();
      const input = {
        kind: singleKind,
        subjectId: 'post-1',
        subjectRevisionHash: 'rev-1',
        requestKey: 'publish:post-1:rev-1',
      };
      const first = await w.service.requestApproval(w.requester, input);
      const replay = await w.service.requestApproval(w.requester, input);
      expect(replay.outcome).toBe('already_applied');
      expect(replay.request?.id).toBe(first.request?.id);

      const conflict = await w.service.requestApproval(w.requester, {
        ...input,
        subjectRevisionHash: 'rev-2',
      });
      expect(conflict.outcome).toBe('refused');
      expect(conflict.refusal?.reason).toBe('request_key_conflict');
      expect(await eventTypes(w, requestId(first))).toEqual(['created']);
    });

    it('resolves concurrent creates with one requestKey to one request', async () => {
      const w = world();
      const input = {
        kind: singleKind,
        subjectId: 'post-1',
        subjectRevisionHash: 'rev-1',
        requestKey: 'same-key',
      };
      const results = await Promise.all(
        [1, 2, 3].map(() => w.service.requestApproval(w.requester, input)),
      );
      expect(results.map((r) => r.outcome).sort()).toEqual([
        'already_applied',
        'already_applied',
        'transitioned',
      ]);
      expect(new Set(results.map((r) => r.request?.id)).size).toBe(1);
    });

    it('refuses unknown kinds and malformed principals', async () => {
      const w = world();
      await expect(
        w.service.requestApproval(w.requester, {
          kind: 'content.unknown',
          subjectId: 'x',
          subjectRevisionHash: 'h',
        }),
      ).rejects.toMatchObject({ code: 'APPROVAL_KIND_UNKNOWN' });
      await expect(
        w.service.requestApproval(
          { ...w.requester, tenantId: 'not-a-uuid' },
          { kind: singleKind, subjectId: 'x', subjectRevisionHash: 'h' },
        ),
      ).rejects.toMatchObject({ code: 'APPROVAL_INVALID' });
      await expect(
        w.service.requestApproval(
          { ...w.requester, type: 'robot' as never },
          { kind: singleKind, subjectId: 'x', subjectRevisionHash: 'h' },
        ),
      ).rejects.toMatchObject({ code: 'APPROVAL_INVALID' });
      await expect(
        w.service.requestApproval(w.requester, {
          kind: singleKind,
          subjectId: 'x',
          subjectRevisionHash: '',
        }),
      ).rejects.toMatchObject({ code: 'APPROVAL_INVALID' });
    });
  });

  describe('decide', () => {
    it('approves at quorum 1 and records a decision event', async () => {
      const w = world();
      const id = await open(w);
      const result = await w.service.decide(w.approverA, id, {
        decision: 'approve',
        reason: 'looks good',
      });
      expect(result.outcome).toBe('transitioned');
      expect(result.request).toMatchObject({
        status: 'approved',
        approvalCount: 1,
      });
      expect(result.request?.decidedAt).toBeTruthy();
      const events = await w.service.listEvents(w.requester, id);
      expect(
        events.map((e) => [e.type, Number(e.sequence), e.voteKey]),
      ).toEqual([
        ['created', 1, null],
        ['approved', 2, w.approverA.id],
      ]);
    });

    it('needs distinct approvers for quorum 2 and refuses a second vote', async () => {
      const w = world();
      const id = await open(w, quorumKind);
      const first = await w.service.decide(w.approverA, id, {
        decision: 'approve',
      });
      expect(first.outcome).toBe('transitioned');
      expect(first.request).toMatchObject({
        status: 'pending',
        approvalCount: 1,
      });
      expect(first.request?.decidedAt).toBeFalsy();

      const again = await w.service.decide(w.approverA, id, {
        decision: 'approve',
      });
      expect(again.refusal?.reason).toBe('already_decided');
      const flip = await w.service.decide(w.approverA, id, {
        decision: 'reject',
        reason: 'changed my mind',
      });
      expect(flip.refusal?.reason).toBe('already_decided');

      const second = await w.service.decide(w.approverB, id, {
        decision: 'approve',
      });
      expect(second.outcome).toBe('transitioned');
      expect(second.request).toMatchObject({
        status: 'approved',
        approvalCount: 2,
      });
      expect(await eventTypes(w, id)).toEqual([
        'created',
        'approved',
        'approved',
      ]);
    });

    it('rejects and requests changes, each needing a reason', async () => {
      const w = world();
      const rejected = await open(w);
      await expect(
        w.service.decide(w.approverA, rejected, { decision: 'reject' }),
      ).rejects.toMatchObject({ code: 'APPROVAL_INVALID' });
      const r = await w.service.decide(w.approverA, rejected, {
        decision: 'reject',
        reason: 'off brand',
      });
      expect(r.request?.status).toBe('rejected');

      const changes = await open(w, quorumKind);
      const c = await w.service.decide(w.approverA, changes, {
        decision: 'request_changes',
        reason: 'fix the headline',
      });
      expect(c.request?.status).toBe('changes_requested');
      const events = await w.service.listEvents(w.requester, changes);
      expect(events.at(-1)).toMatchObject({
        type: 'changes_requested',
        reason: 'fix the headline',
      });

      // A terminal request takes no further decision.
      const late = await w.service.decide(w.approverB, changes, {
        decision: 'approve',
      });
      expect(late.refusal?.reason).toBe('not_pending');
    });

    it('refuses self-approval, agents, services, and missing permissions', async () => {
      const w = world();
      const selfApprover = w.principal('human', [DECIDE]);
      const id = await open(w, singleKind, 'rev-1', selfApprover);

      const self = await w.service.decide(selfApprover, id, {
        decision: 'approve',
      });
      expect(self.refusal?.reason).toBe('self_approval');

      const agent = await w.service.decide(w.principal('agent', [DECIDE]), id, {
        decision: 'approve',
      });
      expect(agent.refusal?.reason).toBe('not_human');

      const job = await w.service.decide(w.principal('service', [DECIDE]), id, {
        decision: 'approve',
      });
      expect(job.refusal?.reason).toBe('not_human');

      const viewer = await w.service.decide(w.principal('human', []), id, {
        decision: 'reject',
        reason: 'no',
      });
      expect(viewer.refusal?.reason).toBe('forbidden');

      const fresh = await w.service.getRequest(w.requester, id);
      expect(fresh?.status).toBe('pending');
      expect(await eventTypes(w, id)).toEqual(['created']);
    });

    it('refuses a decision after expiry, even before the sweep runs', async () => {
      const w = world();
      const id = await open(w);
      w.clock.advance(24 * HOUR);
      const result = await w.service.decide(w.approverA, id, {
        decision: 'approve',
      });
      expect(result.refusal?.reason).toBe('expired');
      expect(result.request?.status).toBe('pending');
    });

    it('resolves the policy permission at decision time', async () => {
      const w = world();
      const id = await open(w);
      const admin = w.principal('human', [MANAGE_APPROVAL_POLICY_PERMISSION]);
      await w.service.setPolicy(admin, singleKind, {
        requiredPermission: EXTRA,
      });

      const plain = await w.service.decide(w.approverA, id, {
        decision: 'approve',
      });
      expect(plain.refusal?.reason).toBe('forbidden');
      const legal = w.principal('human', [DECIDE, EXTRA]);
      const ok = await w.service.decide(legal, id, { decision: 'approve' });
      expect(ok.outcome).toBe('transitioned');
    });
  });

  describe('cancel', () => {
    it('lets the requester cancel and others only with cancel-any', async () => {
      const w = world();
      const id = await open(w);
      const stranger = await w.service.cancel(w.approverA, id);
      expect(stranger.refusal?.reason).toBe('forbidden');

      const own = await w.service.cancel(w.requester, id, { reason: 'typo' });
      expect(own.request?.status).toBe('cancelled');
      expect(await eventTypes(w, id)).toEqual(['created', 'cancelled']);

      const other = await open(w);
      const admin = w.principal('human', [CANCEL_ANY_APPROVAL_PERMISSION]);
      expect((await w.service.cancel(admin, other)).request?.status).toBe(
        'cancelled',
      );
      const again = await w.service.cancel(admin, other);
      expect(again.refusal?.reason).toBe('not_pending');
    });
  });

  describe('expire', () => {
    it('expires only after the deadline and records the event', async () => {
      const w = world();
      const job = w.principal('service', []);
      const id = await open(w);
      const early = await w.service.expire(job, id);
      expect(early.refusal?.reason).toBe('not_expired');

      w.clock.advance(24 * HOUR);
      const result = await w.service.expire(job, id);
      expect(result.outcome).toBe('transitioned');
      expect(result.request?.status).toBe('expired');
      expect(await eventTypes(w, id)).toEqual(['created', 'expired']);
      expect((await w.service.expire(job, id)).refusal?.reason).toBe(
        'not_pending',
      );
    });

    it('expires an unconsumed approval but never a consumed one', async () => {
      const w = world();
      const job = w.principal('service', []);
      const unused = await approved(w, 'rev-1');
      const used = await approved(w, 'rev-2');
      expect((await w.service.consume(job, used, 'rev-2')).outcome).toBe(
        'transitioned',
      );

      w.clock.advance(24 * HOUR);
      expect((await w.service.expire(job, unused)).request?.status).toBe(
        'expired',
      );
      const consumed = await w.service.expire(job, used);
      expect(consumed.refusal?.reason).toBe('not_pending');
      expect(consumed.request?.status).toBe('approved');
    });

    it('sweeps due requests in the tenant with expireDue', async () => {
      const w = world();
      const job = w.principal('service', []);
      const a = await open(w);
      const b = await approved(w);
      w.clock.advance(HOUR);
      const late = await open(w);
      w.clock.advance(23 * HOUR);

      const expired = await w.service.expireDue(job);
      expect(expired.sort()).toEqual([a, b].sort());
      expect((await w.service.getRequest(job, late))?.status).toBe('pending');
    });
    it('is not starved by a full batch of consumed past-deadline approvals', async () => {
      const w = world();
      const job = w.principal('service', []);
      for (const hash of ['c-1', 'c-2', 'c-3']) {
        const id = await approved(w, hash);
        expect((await w.service.consume(job, id, hash)).outcome).toBe(
          'transitioned',
        );
      }
      w.clock.advance(HOUR);
      const pending = await open(w);
      w.clock.advance(24 * HOUR);

      // The consumed approvals expire first and fill a limit-3 batch unless
      // the query itself excludes them.
      expect(await w.service.expireDue(job, { limit: 3 })).toEqual([pending]);
      expect((await w.service.getRequest(job, pending))?.status).toBe(
        'expired',
      );
    });
  });

  describe('consume', () => {
    it('consumes once, bound to the approved revision hash', async () => {
      const w = world();
      const executor = w.principal('agent', []);
      const id = await approved(w, 'rev-1');

      const changed = await w.service.consume(executor, id, 'rev-2');
      expect(changed.refusal?.reason).toBe('revision_mismatch');

      const used = await w.service.consume(executor, id, 'rev-1');
      expect(used.outcome).toBe('transitioned');
      expect(used.request?.consumedBy).toBe(executor.id);
      expect(used.request?.isConsumed()).toBe(true);
      expect(used.request?.status).toBe('approved');

      const twice = await w.service.consume(executor, id, 'rev-1');
      expect(twice.refusal?.reason).toBe('already_consumed');
      expect(await eventTypes(w, id)).toEqual([
        'created',
        'approved',
        'consumed',
      ]);
    });

    it('refuses an unapproved or expired approval', async () => {
      const w = world();
      const executor = w.principal('service', []);
      const pending = await open(w);
      expect(
        (await w.service.consume(executor, pending, 'rev-1')).refusal?.reason,
      ).toBe('not_approved');

      const id = await approved(w);
      w.clock.advance(24 * HOUR);
      expect(
        (await w.service.consume(executor, id, 'rev-1')).refusal?.reason,
      ).toBe('expired');
    });

    it('rolls back with the caller transaction', async () => {
      const w = world();
      const executor = w.principal('service', []);
      const id = await approved(w);
      const db = w.db as DatabaseInterface & {
        transaction: <T>(
          fn: (tx: DatabaseInterface) => Promise<T>,
        ) => Promise<T>;
      };
      await expect(
        withTenant({ tenantId: w.tenantId }, () =>
          db.transaction(async (tx) => {
            const result = await w.service.consume(executor, id, 'rev-1', {
              transaction: tx,
            });
            expect(result.outcome).toBe('transitioned');
            throw new Error('domain write failed');
          }),
        ),
      ).rejects.toThrow('domain write failed');
      expect((await w.service.getRequest(executor, id))?.isConsumed()).toBe(
        false,
      );
      expect(await eventTypes(w, id)).toEqual(['created', 'approved']);
      expect((await w.service.consume(executor, id, 'rev-1')).outcome).toBe(
        'transitioned',
      );
    });
  });

  describe('concurrency', () => {
    it('lets exactly one of two concurrent approvers win at quorum 1', async () => {
      const w = world();
      const id = await open(w);
      const results = await Promise.all([
        w.service.decide(w.approverA, id, { decision: 'approve' }),
        w.service.decide(w.approverB, id, { decision: 'approve' }),
      ]);
      expect(results.map((r) => r.outcome).sort()).toEqual([
        'refused',
        'transitioned',
      ]);
      expect(
        results.find((r) => r.outcome === 'refused')?.refusal?.reason,
      ).toBe('not_pending');
      const request = await w.service.getRequest(w.requester, id);
      expect(request).toMatchObject({ status: 'approved', approvalCount: 1 });
      expect(await eventTypes(w, id)).toEqual(['created', 'approved']);
    });

    it('counts one vote when one approver double-submits at quorum 2', async () => {
      const w = world();
      const id = await open(w, quorumKind);
      const results = await Promise.all([
        w.service.decide(w.approverA, id, { decision: 'approve' }),
        w.service.decide(w.approverA, id, { decision: 'approve' }),
      ]);
      expect(results.map((r) => r.outcome).sort()).toEqual([
        'refused',
        'transitioned',
      ]);
      expect(
        results.find((r) => r.outcome === 'refused')?.refusal?.reason,
      ).toBe('already_decided');
      const request = await w.service.getRequest(w.requester, id);
      expect(request).toMatchObject({ status: 'pending', approvalCount: 1 });
    });

    it('stops counting at quorum when many approvers race', async () => {
      const w = world();
      const id = await open(w, quorumKind);
      const approvers = [1, 2, 3, 4, 5].map(() => w.principal());
      const results = await Promise.all(
        approvers.map((p) => w.service.decide(p, id, { decision: 'approve' })),
      );
      expect(results.filter((r) => r.outcome === 'transitioned')).toHaveLength(
        2,
      );
      expect(
        results.filter((r) => r.refusal?.reason === 'not_pending'),
      ).toHaveLength(3);
      const request = await w.service.getRequest(w.requester, id);
      expect(request).toMatchObject({ status: 'approved', approvalCount: 2 });
      expect(await eventTypes(w, id)).toEqual([
        'created',
        'approved',
        'approved',
      ]);
    });

    it('consumes exactly once under a concurrent double consume', async () => {
      const w = world();
      const id = await approved(w);
      const executors = [w.principal('service', []), w.principal('agent', [])];
      const results = await Promise.all(
        executors.map((p) => w.service.consume(p, id, 'rev-1')),
      );
      expect(results.map((r) => r.outcome).sort()).toEqual([
        'refused',
        'transitioned',
      ]);
      expect(
        results.find((r) => r.outcome === 'refused')?.refusal?.reason,
      ).toBe('already_consumed');
      expect(await eventTypes(w, id)).toEqual([
        'created',
        'approved',
        'consumed',
      ]);
    });

    it('treats the guarded UPDATE as the arbiter when the row moves underneath', async () => {
      const w = world();
      const id = await open(w);
      const db = w.db;
      let armed = 0;
      const name = `approvals-race-${randomUUID()}`;
      // Between the transition's read and its guarded UPDATE, a concurrent
      // writer bumps the version. The UPDATE must match nothing and write
      // nothing; the service then retries from a fresh read.
      GlobalInterceptors.register({
        name,
        async beforeList(className: string) {
          if (armed > 0 && className.includes('ApprovalEvent')) {
            armed--;
            await db.query(
              'UPDATE approval_requests SET version = version + 1 WHERE id = ?',
              id,
            );
          }
        },
      });
      try {
        const once = new ApprovalService({
          db,
          now: w.clock.now,
          maxAttempts: 1,
        });
        armed = 1;
        const lost = await once.decide(w.approverA, id, {
          decision: 'approve',
        });
        expect(lost.refusal?.reason).toBe('contention');
        expect(lost.request?.status).toBe('pending');
        expect(await eventTypes(w, id)).toEqual(['created']);

        armed = 1;
        const retried = await w.service.decide(w.approverA, id, {
          decision: 'approve',
        });
        expect(retried.outcome).toBe('transitioned');
        expect(retried.request?.status).toBe('approved');
        expect(await eventTypes(w, id)).toEqual(['created', 'approved']);
      } finally {
        GlobalInterceptors.unregister(name);
      }
    });
  });

  describe('tenant isolation', () => {
    it('refuses every operation on another tenant’s request id', async () => {
      const w = world();
      const id = await approved(w);
      const otherTenant = randomUUID();
      const foreign = w.principal(
        'human',
        [DECIDE, CANCEL_ANY_APPROVAL_PERMISSION],
        otherTenant,
      );
      expect(await w.service.getRequest(foreign, id)).toBeNull();
      expect(await w.service.listEvents(foreign, id)).toEqual([]);
      for (const result of [
        await w.service.decide(foreign, id, { decision: 'approve' }),
        await w.service.cancel(foreign, id),
        await w.service.expire(foreign, id),
        await w.service.consume(foreign, id, 'rev-1'),
      ]) {
        expect(result.outcome).toBe('refused');
        expect(result.refusal?.reason).toBe('not_found');
        expect(result.request).toBeNull();
      }
      const own = await w.service.getRequest(w.requester, id);
      expect(own?.isConsumed()).toBe(false);
      expect(await eventTypes(w, id)).toEqual(['created', 'approved']);
    });

    it('refuses a principal whose tenant differs from the active context', async () => {
      const w = world();
      const id = await open(w);
      const result = await withTenant({ tenantId: randomUUID() }, () =>
        w.service.decide(w.approverA, id, { decision: 'approve' }),
      );
      expect(result.refusal?.reason).toBe('tenant_mismatch');
      await expect(
        withTenant({ tenantId: randomUUID() }, () =>
          w.service.getRequest(w.approverA, id),
        ),
      ).rejects.toMatchObject({ code: 'APPROVAL_FORBIDDEN' });
    });

    it('keeps requestKey idempotency per tenant', async () => {
      const a = world();
      const b = createWorld(a.db);
      const input = {
        kind: singleKind,
        subjectId: 'post-1',
        subjectRevisionHash: 'rev-1',
        requestKey: 'shared-key',
      };
      const first = await a.service.requestApproval(a.requester, input);
      const second = await b.service.requestApproval(b.requester, input);
      expect(second.outcome).toBe('transitioned');
      expect(second.request?.id).not.toBe(first.request?.id);
    });
  });

  describe('policy', () => {
    it('applies a tightened quorum and expiry to new requests', async () => {
      const w = world();
      const admin = w.principal('human', [MANAGE_APPROVAL_POLICY_PERMISSION]);
      const before = await open(w);
      await w.service.setPolicy(admin, singleKind, {
        requiredApprovals: 2,
        ttlMs: HOUR,
      });
      expect(await w.service.rulesFor(admin, singleKind)).toEqual({
        requiredApprovals: 2,
        ttlMs: HOUR,
        requiredPermissions: [DECIDE],
      });
      const after = await open(w);
      const request = await w.service.getRequest(admin, after);
      expect(request?.requiredApprovals).toBe(2);
      expect(request?.expiresAtMs()).toBe(w.clock.now().getTime() + HOUR);
      expect(
        (await w.service.getRequest(admin, before))?.requiredApprovals,
      ).toBe(1);

      // Updating the row in place, and clearing back to the defaults.
      await w.service.setPolicy(admin, singleKind, { requiredApprovals: 3 });
      expect(
        (await w.service.rulesFor(admin, singleKind)).requiredApprovals,
      ).toBe(3);
      await w.service.setPolicy(admin, singleKind, {});
      expect(await w.service.rulesFor(admin, singleKind)).toEqual({
        requiredApprovals: 1,
        ttlMs: 24 * HOUR,
        requiredPermissions: [DECIDE],
      });
    });

    it('refuses loosening and unauthorized policy writes', async () => {
      const w = world();
      const admin = w.principal('human', [MANAGE_APPROVAL_POLICY_PERMISSION]);
      await expect(
        w.service.setPolicy(admin, quorumKind, { requiredApprovals: 1 }),
      ).rejects.toMatchObject({ code: 'APPROVAL_POLICY_LOOSENS' });
      await expect(
        w.service.setPolicy(admin, quorumKind, { ttlMs: 48 * HOUR }),
      ).rejects.toMatchObject({ code: 'APPROVAL_POLICY_LOOSENS' });
      await expect(
        w.service.setPolicy(admin, quorumKind, {
          requiredPermission: 'Not A Slug',
        }),
      ).rejects.toMatchObject({ code: 'APPROVAL_INVALID' });
      await expect(
        w.service.setPolicy(w.approverA, quorumKind, { requiredApprovals: 3 }),
      ).rejects.toMatchObject({ code: 'APPROVAL_FORBIDDEN' });
      const agentAdmin = w.principal('agent', [
        MANAGE_APPROVAL_POLICY_PERMISSION,
      ]);
      await expect(
        w.service.setPolicy(agentAdmin, quorumKind, { requiredApprovals: 3 }),
      ).rejects.toMatchObject({ code: 'APPROVAL_FORBIDDEN' });
    });
  });
}
