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

  it('splits participant requests through the participant path with stable retries', async () => {
    const service = await ParticipantDevelopmentRequestService.create({ db });
    const request = await service.submit(input);
    const triage = await DevelopmentRequestService.create({ db });
    const split = {
      decision: 'split' as const,
      actorRef: 'triager',
      reason: 'Separate scope',
      split: [
        { description: 'First feature' },
        { description: 'Second feature' },
      ],
    };
    const result = await triage.triage(request, split);
    expect(result.splitRequests).toHaveLength(2);
    expect(
      result.splitRequests.every((part) => part.integrationId === null),
    ).toBe(true);
    const retry = await triage.triage(request, split);
    expect(retry.splitRequests.map((part) => part.id)).toEqual(
      result.splitRequests.map((part) => part.id),
    );
  });
});
