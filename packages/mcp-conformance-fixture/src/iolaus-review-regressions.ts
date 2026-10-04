/** Real SQL fault injection at the boundary between revision acquisition and review. */
import { createHash, randomUUID } from 'node:crypto';
import type { DataSurfaceServerActionRequest } from '@happyvertical/smrt-agents/server';
import type { DatabaseInterface } from '@happyvertical/sql';
import { expect } from 'vitest';
import { createIolausHumanReview } from './iolaus-human-review.js';
import { IolausApplicationCollection } from './iolaus-workload.js';

export async function exerciseReviewAtomicity(
  db: DatabaseInterface,
  dialect: 'sqlite' | 'postgres',
  alice: { id: string; tenantId: string },
  bob: { id: string; tenantId: string },
  authorize: (
    principal: { id?: string; tenantId?: string } | null,
  ) => Promise<boolean>,
) {
  const applications = await IolausApplicationCollection.create({ db });
  // Trigger execution is an actual competing SQL mutation after the read, not
  // a mocked row count. All changes must share the action's transaction.
  for (const mutation of [
    'owner_id',
    'tenant_id',
    'materials_digest',
    'abort',
  ] as const) {
    const materials = JSON.stringify({ synthetic: randomUUID(), revision: 1 });
    const row = await applications.create({
      ownerId: alice.id,
      tenantId: alice.tenantId,
      materials,
      materialsDigest: createHash('sha256').update(materials).digest('hex'),
    });
    const review = createIolausHumanReview(db, authorize);
    const request: DataSurfaceServerActionRequest = {
      version: 1,
      requestId: `boundary-preview-${mutation}`,
      identity: {
        surfaceId: 'iolaus',
        kind: 'table',
        subject: { type: 'tenant', id: alice.tenantId },
      },
      actionId: 'open_review',
      phase: 'preview',
      selection: { scope: 'explicit-ids', rowIds: [String(row.id)] },
      expectedRevision: 1,
      payload: { sha256: row.materialsDigest },
    };
    const preview = await review.preview(request, alice);
    expect(preview.ok).toBe(true);
    const before = await db.query(
      'SELECT * FROM iolaus_applications WHERE id = ?',
      row.id,
    );
    const value =
      mutation === 'owner_id'
        ? bob.id
        : mutation === 'tenant_id'
          ? bob.tenantId
          : '0'.repeat(64);
    // Values originate solely in this fixture (UUIDs or fixed hex), never user input.
    if (dialect === 'sqlite') {
      await db.query(
        mutation === 'abort'
          ? "CREATE TRIGGER iolaus_boundary BEFORE UPDATE OF human_review_opened ON iolaus_applications BEGIN SELECT RAISE(ABORT, 'review write failed'); END"
          : `CREATE TRIGGER iolaus_boundary AFTER UPDATE OF updated_at ON iolaus_applications BEGIN UPDATE iolaus_applications SET ${mutation} = '${value}' WHERE id = NEW.id; END`,
      );
    } else {
      await db.query(
        mutation === 'abort'
          ? "CREATE OR REPLACE FUNCTION pg_temp.iolaus_boundary() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'review write failed'; END $$"
          : `CREATE OR REPLACE FUNCTION pg_temp.iolaus_boundary() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.${mutation} := '${value}'; RETURN NEW; END $$`,
      );
      await db.query(
        `CREATE TRIGGER iolaus_boundary BEFORE UPDATE OF ${mutation === 'abort' ? 'human_review_opened' : 'updated_at'} ON iolaus_applications FOR EACH ROW EXECUTE FUNCTION pg_temp.iolaus_boundary()`,
      );
    }
    try {
      const outcome = await review.apply(
        {
          ...request,
          phase: 'apply',
          requestId: `boundary-apply-${mutation}`,
          idempotencyKey: `boundary-${mutation}`,
          confirmationToken: preview.confirmationToken,
        },
        alice,
      );
      expect(outcome, `${dialect} ${mutation} must deny review`).toMatchObject({
        details: {
          accepted: 0,
          failed: 1,
          outcomes: [{ status: 'failed', reason: 'execution_failed' }],
        },
      });
    } finally {
      await db.query(
        dialect === 'sqlite'
          ? 'DROP TRIGGER iolaus_boundary'
          : 'DROP TRIGGER iolaus_boundary ON iolaus_applications',
      );
    }
    const after = await db.query(
      'SELECT * FROM iolaus_applications WHERE id = ?',
      row.id,
    );
    // Includes updated_at: a claim on a root executor would leak despite rollback.
    expect(after.rows).toEqual(before.rows);
    expect((await applications.get(String(row.id)))?.humanReviewOpened).toBe(
      false,
    );
    expect((await applications.get(String(row.id)))?.reviewCount).toBe(0);
    // A fresh preview after rollback remains usable and opens exactly once.
    const retry = {
      ...request,
      requestId: `boundary-retry-preview-${mutation}`,
    };
    const retriedPreview = await review.preview(retry, alice);
    const retriedApply = {
      ...retry,
      phase: 'apply' as const,
      requestId: `boundary-retry-${mutation}`,
      idempotencyKey: `boundary-retry-${mutation}`,
      confirmationToken: retriedPreview.confirmationToken,
    };
    expect((await review.apply(retriedApply, alice)).ok).toBe(true);
    expect((await review.apply(retriedApply, alice)).ok).toBe(true);
    const updated = await applications.get(String(row.id));
    expect(updated?.reviewCount).toBe(1);
    expect(updated?.revision).toBe(1);
    expect(updated?.materialsDigest).toBe(row.materialsDigest);
    expect(updated?.materials).toBe(materials);
    await applications.delete(String(row.id));
  }
}
