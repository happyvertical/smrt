/**
 * Only ApprovalService may insert approval requests and events (#3745
 * review). Rows built from plain options, through the exported collections,
 * or as forged ledger entries are refused at the model layer and nothing is
 * written; consume() also refuses an approval its ledger does not back.
 */

import { randomUUID } from 'node:crypto';
import { getTestDatabase } from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/smrt-core/migrations';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApprovalEventCollection } from '../collections/ApprovalEventCollection.js';
import { ApprovalRequestCollection } from '../collections/ApprovalRequestCollection.js';
import { ApprovalEvent } from '../models/ApprovalEvent.js';
import { ApprovalRequest } from '../models/ApprovalRequest.js';
import { ApprovalService } from '../service.js';
import { approvalPrincipalFromPermissions } from '../types.js';
import {
  DECIDE,
  quorumKind,
  SUBJECT,
  singleKind,
} from './helpers/approval-suite.js';
import { APPROVAL_CLASSES } from './helpers/classes.js';

const FUTURE = new Date(Date.now() + 24 * 60 * 60 * 1000);

describe('approval write capability', () => {
  let db: DatabaseInterface;

  beforeAll(async () => {
    db = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      classes: APPROVAL_CLASSES,
    });
  });

  afterAll(async () => {
    await (db as { close?: () => Promise<void> }).close?.();
  });

  function actors(tenantId = randomUUID()) {
    const make = (
      permissions: string[],
      type: 'human' | 'agent' | 'service' = 'human',
    ) =>
      approvalPrincipalFromPermissions(permissions, {
        id: randomUUID(),
        tenantId,
        type,
      });
    return {
      tenantId,
      service: new ApprovalService({ db }),
      requester: make([]),
      approverA: make([DECIDE]),
      approverB: make([DECIDE]),
      executor: make([], 'service'),
    };
  }

  async function count(table: string, tenantId: string): Promise<number> {
    const result = await db.query(
      `SELECT COUNT(*) AS n FROM ${table} WHERE tenant_id = ?`,
      tenantId,
    );
    return Number((result.rows[0] as { n: number | string }).n);
  }

  const forgedRequest = (tenantId: string) => ({
    tenantId,
    kind: singleKind.key,
    subjectType: SUBJECT,
    subjectId: 'post-1',
    subjectRevisionHash: 'rev-1',
    requestKey: randomUUID(),
    requestedBy: 'mallory',
    status: 'approved' as const,
    requiredApprovals: 1,
    approvalCount: 1,
    requiredPermissions: JSON.stringify([DECIDE]),
    version: 1,
    expiresAt: FUTURE,
  });

  it('refuses a request built from plain options', async () => {
    const { tenantId } = actors();
    const forged = new ApprovalRequest({ db, ...forgedRequest(tenantId) });
    await expect(forged.save()).rejects.toMatchObject({
      code: 'APPROVAL_FORBIDDEN',
    });
    expect(await count('approval_requests', tenantId)).toBe(0);
  });

  it('refuses a request created through the exported collection', async () => {
    const { tenantId } = actors();
    const requests = await ApprovalRequestCollection.create({ db });
    await expect(
      requests.create(forgedRequest(tenantId)),
    ).rejects.toMatchObject({ code: 'APPROVAL_FORBIDDEN' });
    expect(await count('approval_requests', tenantId)).toBe(0);
  });

  it('refuses to consume an approval its ledger does not back', async () => {
    const { tenantId, service, requester, executor } = actors();
    const opened = await service.requestApproval(requester, {
      kind: singleKind,
      subjectId: 'post-1',
      subjectRevisionHash: 'rev-1',
    });
    const id = String(opened.request?.id);
    // An out-of-band write (raw SQL around the service) flips the status.
    await db.query(
      `UPDATE approval_requests SET status = 'approved', approval_count = 1 WHERE id = ?`,
      id,
    );
    const result = await service.consume(executor, id, 'rev-1');
    expect(result.outcome).toBe('refused');
    expect(result.refusal?.reason).toBe('unbacked_approval');
    expect(result.request?.isConsumed()).toBe(false);
    expect(await count('approval_requests', tenantId)).toBe(1);
  });

  it('still lets the service open, decide, and consume', async () => {
    const { service, requester, approverA, executor } = actors();
    const opened = await service.requestApproval(requester, {
      kind: singleKind,
      subjectId: 'post-1',
      subjectRevisionHash: 'rev-1',
    });
    const id = String(opened.request?.id);
    expect(
      (await service.decide(approverA, id, { decision: 'approve' })).outcome,
    ).toBe('transitioned');
    expect((await service.consume(executor, id, 'rev-1')).outcome).toBe(
      'transitioned',
    );
  });
});
