import { randomUUID } from 'node:crypto';
import { getTestDatabase } from '@happyvertical/smrt-core';
import {
  disableTenancy,
  enableTenancy,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DevelopmentRequestHistoryCollection } from '../collections/DevelopmentRequestHistories.js';
import { DevelopmentRequestCollection } from '../collections/DevelopmentRequests.js';
import { DevelopmentRequestService } from '../services/development-request-service.js';
import { ParticipantDevelopmentRequestService } from '../services/participant-development-request-service.js';

const [tenantA, tenantB, projectA, projectB, userA, userB] = Array.from(
  { length: 6 },
  () => randomUUID(),
);
const input = {
  tenantId: tenantA,
  projectId: projectA,
  requesterId: userA,
  requestKey: 'key-a',
  type: 'feature' as const,
  description: 'Add a useful feature',
};

describe('participant development request intake', () => {
  let db: DatabaseInterface;
  beforeEach(async () => {
    db = await getTestDatabase(
      process.env.SMRT_TEST_POSTGRES_URL
        ? { type: 'postgres', url: process.env.SMRT_TEST_POSTGRES_URL }
        : { type: 'sqlite', url: ':memory:' },
    );
  });
  afterEach(async () => {
    disableTenancy();
    await db.query(
      'DELETE FROM development_request_histories WHERE request_id IN (SELECT id FROM development_requests WHERE requester_id IN (?, ?))',
      userA,
      userB,
    );
    await db.query(
      'DELETE FROM development_requests WHERE requester_id IN (?, ?)',
      userA,
      userB,
    );
    await db.close?.();
  });

  it('stores truthful participant provenance and retries without duplicate history', async () => {
    const service = await ParticipantDevelopmentRequestService.create({ db });
    const first = await service.submit(input);
    const retry = await service.submit(input);
    expect(retry.id).toBe(first.id);
    expect(first.integrationId).toBeNull();
    expect(first.origin).toBe('participant');
    expect(first.visibility).toBe('requester');
    const history = await (
      await DevelopmentRequestHistoryCollection.create({ db })
    ).listForRequest(input.tenantId, first.id!);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      actorType: 'participant',
      actorId: userA,
      toStatus: 'submitted',
    });
  });

  it('scopes keys to tenant, project and requester and rejects changed payload', async () => {
    const service = await ParticipantDevelopmentRequestService.create({ db });
    const first = await service.submit(input);
    for (const changed of [
      { tenantId: tenantB },
      { projectId: projectB },
      { requesterId: userB },
    ]) {
      expect((await service.submit({ ...input, ...changed })).id).not.toBe(
        first.id,
      );
    }
    await expect(
      service.submit({ ...input, description: 'Different content' }),
    ).rejects.toMatchObject({
      name: 'ParticipantDevelopmentRequestConflictError',
    });
  });

  it('rejects foreign active tenant and malformed public inputs', async () => {
    const service = await ParticipantDevelopmentRequestService.create({ db });
    enableTenancy({ mode: 'required' });
    await expect(
      withTenant({ tenantId: tenantB }, () => service.submit(input)),
    ).rejects.toThrow();
    for (const bad of [
      { requesterId: '' },
      { type: 'unknown' },
      { description: '' },
      { visibility: 'unknown' },
    ]) {
      await expect(
        withTenant({ tenantId: tenantA }, () =>
          service.submit({ ...input, ...bad } as never),
        ),
      ).rejects.toThrow();
    }
  });

  it('rolls request creation back if history fails on its transaction executor', async () => {
    const service = await ParticipantDevelopmentRequestService.create({ db });
    const original = db.transaction!.bind(db);
    const transactionSpy = vi
      .spyOn(db, 'transaction')
      .mockImplementationOnce((callback) =>
        original(async (tx) =>
          callback(
            new Proxy(tx, {
              get(target, property) {
                if (property === 'query')
                  return (sql: string, ...params: unknown[]) => {
                    if (
                      sql.includes('INSERT INTO development_request_histories')
                    )
                      throw new Error('history failed');
                    return target.query(sql, ...params);
                  };
                const value = Reflect.get(target, property);
                return typeof value === 'function' ? value.bind(target) : value;
              },
            }),
          ),
        ),
      );
    await expect(service.submit(input)).rejects.toThrow('history failed');
    transactionSpy.mockRestore();
    const rows = await db.query(
      'SELECT id FROM development_requests WHERE requester_id = ?',
      userA,
    );
    expect(rows.rows).toHaveLength(0);
    expect((await service.submit(input)).id).toBeTruthy();
  });

  it('keeps managed creation requiring an integration', async () => {
    const requests = await DevelopmentRequestCollection.create({ db });
    await expect(
      requests.createManaged({ ...input, integrationId: '' }),
    ).rejects.toThrow('require an integration');
  });

  it('preserves persisted split provenance and triager history across reordered retries', async () => {
    const service = await ParticipantDevelopmentRequestService.create({ db });
    const created = await service.submit(input);
    const parentRequests = await DevelopmentRequestCollection.create({ db });
    const request = await withTenant({ tenantId: tenantA }, () =>
      parentRequests.get({ id: created.id! }),
    );
    if (!request) throw new Error('Parent request was not persisted.');
    request.participantId = userB;
    request.setEvidence([
      { url: 'https://example.com/evidence', label: 'Original report' },
    ]);
    await withTenant({ tenantId: tenantA }, () => request.save());
    const triage = await DevelopmentRequestService.create({ db });
    const split = {
      decision: 'split' as const,
      actorRef: 'triager',
      reason: 'Separate scope',
      split: [
        { description: 'First feature', type: 'feature' },
        { description: 'Second bug', type: 'bug' },
      ],
    };
    const result = await triage.triage(request, split);
    expect(result.splitRequests).toHaveLength(2);
    const requests = await DevelopmentRequestCollection.create({ db });
    const histories = await DevelopmentRequestHistoryCollection.create({ db });
    for (const child of result.splitRequests) {
      const reloaded = await withTenant({ tenantId: tenantA }, () =>
        requests.get({ id: child.id! }),
      );
      expect(reloaded).toMatchObject({
        tenantId: tenantA,
        projectId: projectA,
        integrationId: null,
        requesterId: userA,
        participantId: userB,
        origin: `split:${request.id}`,
        discussion: split.reason,
        visibility: request.visibility,
      });
      expect(reloaded?.getEvidence()).toEqual(request.getEvidence());
      const history = await histories.listForRequest(tenantA, child.id!);
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({
        actorType: 'system',
        actorId: 'triager',
        note: split.reason,
        toStatus: 'submitted',
      });
    }
    const retry = await triage.triage(request, {
      ...split,
      split: [...split.split].reverse(),
    });
    expect(retry.splitRequests.map((part) => part.id)).toEqual(
      result.splitRequests.map((part) => part.id).reverse(),
    );
    const persisted = await withTenant({ tenantId: tenantA }, () =>
      requests.list({ where: { origin: `split:${request.id}` } }),
    );
    expect(persisted).toHaveLength(2);
  });

  it('validates every participant split type before inserting any child', async () => {
    const service = await ParticipantDevelopmentRequestService.create({ db });
    const request = await service.submit(input);
    const triage = await DevelopmentRequestService.create({ db });
    await expect(
      triage.triage(request, {
        decision: 'split',
        actorRef: 'triager',
        reason: 'Separate scope',
        split: [
          { description: 'Valid first part', type: 'feature' },
          { description: 'Invalid second part', type: 'unknown' },
        ],
      }),
    ).rejects.toThrow('valid participant split');
    const requests = await DevelopmentRequestCollection.create({ db });
    const children = await withTenant({ tenantId: tenantA }, () =>
      requests.list({ where: { origin: `split:${request.id}` } }),
    );
    expect(children).toHaveLength(0);
    const reloaded = await withTenant({ tenantId: tenantA }, () =>
      requests.get({ id: request.id! }),
    );
    expect(reloaded?.status).toBe('submitted');
    expect(
      await (
        await DevelopmentRequestHistoryCollection.create({ db })
      ).listForRequest(tenantA, request.id!),
    ).toHaveLength(1);
  });

  it('keeps identical duplicate parts separate and stable on retry', async () => {
    const request = await (
      await ParticipantDevelopmentRequestService.create({ db })
    ).submit(input);
    const triage = await DevelopmentRequestService.create({ db });
    const split = {
      decision: 'split' as const,
      actorRef: 'triager',
      reason: 'Two occurrences',
      split: [
        { description: 'Same content', type: 'feature' },
        { description: 'Same content', type: 'feature' },
      ],
    };
    const first = await triage.triage(request, split);
    expect(new Set(first.splitRequests.map((child) => child.id)).size).toBe(2);
    const retry = await triage.triage(request, split);
    expect(retry.splitRequests.map((child) => child.id)).toEqual(
      first.splitRequests.map((child) => child.id),
    );
  });
});
