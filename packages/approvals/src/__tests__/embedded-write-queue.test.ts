/**
 * Approval transitions share core's embedded write queue (#3741 review).
 *
 * On file-backed SQLite a transaction that writes models must take the
 * embedded write queue BEFORE the adapter's connection lock. Otherwise an
 * unrelated NULL-tenant save (which holds the queue and then opens its own
 * write transaction) and an approval transition (which holds the connection
 * lock and then queues its event insert) wait on each other until the
 * transaction-queue timeout, and the unrelated save fails.
 */

import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  field,
  getTestDatabase,
  SmrtCollection,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/smrt-core/migrations';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApprovalService } from '../service.js';
import { approvalPrincipalFromPermissions } from '../types.js';
import { DECIDE, singleKind } from './helpers/approval-suite.js';
import { APPROVAL_CLASSES } from './helpers/classes.js';

/** A global (NULL-tenant) record: its save takes the null-aware upsert path. */
@TenantScoped({ mode: 'optional' })
@smrt({ tableName: 'approvals_race_notes', api: false, mcp: false, cli: false })
class ApprovalsRaceNote extends SmrtObject {
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  @field({ type: 'text' })
  body: string = '';
}

class ApprovalsRaceNoteCollection extends SmrtCollection<ApprovalsRaceNote> {
  static readonly _itemClass = ApprovalsRaceNote;
}

/** Reject when `promise` has not settled within `ms`. */
function within<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${label} did not finish within ${ms} ms`)),
        ms,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

describe('approvals on file-backed SQLite share the embedded write queue', () => {
  let dir = '';
  let db: DatabaseInterface;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'smrt-approvals-3741-'));
    db = await getTestDatabase({
      type: 'sqlite',
      url: join(dir, 'approvals.db'),
      classes: [
        ...APPROVAL_CLASSES,
        '@happyvertical/smrt-approvals:ApprovalsRaceNote',
      ],
    });
  });

  afterAll(async () => {
    await (db as { close?: () => Promise<void> }).close?.();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('races transitions against NULL-tenant saves without deadlock or loss', async () => {
    const tenant = randomUUID();
    const service = new ApprovalService({ db });
    const notes = await ApprovalsRaceNoteCollection.create({ db });
    const requester = approvalPrincipalFromPermissions([], {
      id: randomUUID(),
      tenantId: tenant,
      type: 'human',
    });
    const approver = approvalPrincipalFromPermissions([DECIDE], {
      id: randomUUID(),
      tenantId: tenant,
      type: 'human',
    });

    const started = Date.now();
    const rounds = 8;
    const bodies: string[] = [];
    const decidedIds: string[] = [];
    await within(
      (async () => {
        for (let round = 0; round < rounds; round++) {
          const body = `note-${round}-${randomUUID()}`;
          bodies.push(body);
          const [opened] = await Promise.all([
            service.requestApproval(requester, {
              kind: singleKind,
              subjectId: `post-${round}`,
              subjectRevisionHash: 'rev-1',
            }),
            notes.create({ body }),
          ]);
          const id = String(opened.request?.id);
          const [decided] = await Promise.all([
            service.decide(approver, id, { decision: 'approve' }),
            notes.create({ body: `${body}-b` }),
          ]);
          expect(decided.outcome).toBe('transitioned');
          bodies.push(`${body}-b`);
          decidedIds.push(id);
        }
      })(),
      10_000,
      'the raced writes',
    );
    expect(Date.now() - started).toBeLessThan(10_000);

    const saved = await notes.list({ where: { tenantId: null }, limit: 100 });
    expect(saved.map((note) => note.body).sort()).toEqual([...bodies].sort());
    for (const id of decidedIds) {
      expect((await service.getRequest(requester, id))?.status).toBe(
        'approved',
      );
      const events = await service.listEvents(requester, id);
      expect(events.map((event) => event.type)).toEqual([
        'created',
        'approved',
      ]);
    }
  }, 60_000);
});
