import { createHash, randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import type { DataSurfaceActionResult } from '@happyvertical/smrt-ui/data';
import type { DatabaseInterface } from '@happyvertical/sql';
import { getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DataSurfacePreviewTokenRecord } from './data-surface-actions.js';
import {
  DataSurfaceActionStateCorruptionError,
  SqlDataSurfaceActionStateStore,
} from './sql-data-surface-action-state.js';

describe('SqlDataSurfaceActionStateStore', () => {
  let db: DatabaseInterface;
  let path: string;

  beforeEach(async () => {
    path = `/tmp/smrt-action-state-${randomUUID()}.sqlite`;
    db = await getDatabase({ type: 'sqlite', url: path });
  });

  afterEach(async () => {
    await db.close?.();
    await rm(path, { force: true });
  });

  it('shares a preview token across instances and consumes it exactly once', async () => {
    const first = new SqlDataSurfaceActionStateStore({ db });
    const second = new SqlDataSurfaceActionStateStore({ db });
    await first.putToken('secret-preview-token', tokenRecord());

    await expect(
      second.getToken('secret-preview-token'),
    ).resolves.toMatchObject({
      actorUserId: 'user-a',
      tenantId: 'tenant-a',
    });
    const consumed = await Promise.all([
      first.markTokenConsumed('secret-preview-token', 'apply-a'),
      second.markTokenConsumed('secret-preview-token', 'apply-b'),
    ]);
    expect(consumed.filter(Boolean)).toHaveLength(1);
    await expect(first.getToken('secret-preview-token')).resolves.toMatchObject(
      {
        consumedBy: createHash('sha256')
          .update(consumed[0] ? 'apply-a' : 'apply-b')
          .digest('hex'),
      },
    );

    const persisted = await db.query(
      'SELECT token_hash FROM _smrt_data_surface_action_tokens',
    );
    expect(persisted.rows[0]?.token_hash).not.toBe('secret-preview-token');
  });

  it('rolls token consumption back when its reservation cannot commit', async () => {
    const store = new SqlDataSurfaceActionStateStore({ db });
    await store.putToken('transactional-token', tokenRecord());
    await db.query(
      `CREATE TRIGGER reject_action_reservation
       BEFORE INSERT ON _smrt_data_surface_action_idempotency
       BEGIN SELECT RAISE(ABORT, 'forced reservation failure'); END`,
    );

    await expect(
      store.consumeTokenAndReserveIdempotency(
        'transactional-token',
        'apply-transactional',
        'scope-transactional',
        {
          requestFingerprint: 'request-transactional',
          ownerToken: 'owner-transactional',
          reservedAt: 100,
        },
      ),
    ).rejects.toThrow('forced reservation failure');
    await expect(
      store.getToken('transactional-token'),
    ).resolves.not.toHaveProperty('consumedBy');
    await expect(
      store.getIdempotency('scope-transactional'),
    ).resolves.toBeUndefined();
  });

  it('selects one reservation owner and conditionally completes for restart replay', async () => {
    const first = new SqlDataSurfaceActionStateStore({ db });
    const second = new SqlDataSurfaceActionStateStore({ db });
    const [left, right] = await Promise.all([
      first.reserveIdempotency('scope-a', {
        requestFingerprint: 'request-a',
        ownerToken: 'owner-a',
        reservedAt: 100,
      }),
      second.reserveIdempotency('scope-a', {
        requestFingerprint: 'request-a',
        ownerToken: 'owner-b',
        reservedAt: 101,
      }),
    ]);
    const owner =
      left.status === 'reserved' && left.ownerToken ? 'owner-a' : 'owner-b';
    expect(
      [left, right].filter(
        (record) => record.status === 'reserved' && record.ownerToken,
      ),
    ).toHaveLength(1);
    await expect(
      first.completeIdempotency('scope-a', 'wrong-owner', actionResult()),
    ).resolves.toBe(false);
    await expect(
      first.completeIdempotency('scope-a', owner, actionResult()),
    ).resolves.toBe(true);

    await db.close?.();
    db = await getDatabase({ type: 'sqlite', url: path });
    const restarted = new SqlDataSurfaceActionStateStore({ db });
    await expect(restarted.getIdempotency('scope-a')).resolves.toEqual({
      status: 'completed',
      requestFingerprint: 'request-a',
      result: actionResult(),
    });
  });

  it('keeps an orphaned reservation until authorized evidence reconciles a terminal result', async () => {
    let authorized = false;
    const store = new SqlDataSurfaceActionStateStore({
      db,
      now: () => 500,
      authorizeRecovery: ({ authorizedBy, evidence }) =>
        authorized &&
        authorizedBy === 'operator-a' &&
        evidence === 'provider-event-42',
    });
    await store.reserveIdempotency('scope-recovery', {
      requestFingerprint: 'request-recovery',
      ownerToken: 'crashed-owner',
      reservedAt: 400,
    });

    const restarted = new SqlDataSurfaceActionStateStore({ db });
    await expect(
      restarted.reserveIdempotency('scope-recovery', {
        requestFingerprint: 'request-recovery',
        ownerToken: 'new-owner',
        reservedAt: 500,
      }),
    ).resolves.toMatchObject({
      status: 'reserved',
      ownerToken: '',
      reservedAt: 400,
    });

    const recovery = {
      requestFingerprint: 'request-recovery',
      reservedAt: 400,
      result: actionResult(),
      authorizedBy: 'operator-a',
      evidence: 'provider-event-42',
    };
    await expect(
      store.reconcileIdempotency('scope-recovery', recovery),
    ).resolves.toBe(false);
    authorized = true;
    await expect(
      store.reconcileIdempotency('scope-recovery', recovery),
    ).resolves.toBe(true);
    await expect(store.getIdempotency('scope-recovery')).resolves.toMatchObject(
      {
        status: 'completed',
        result: actionResult(),
        recovery: {
          authorizedBy: 'operator-a',
          evidence: 'provider-event-42',
          reconciledAt: 500,
        },
      },
    );
  });

  it('fails closed on malformed persisted state', async () => {
    const now = new Date().toISOString();
    await db.query(
      `INSERT INTO _smrt_data_surface_action_idempotency
        (id, slug, context, created_at, updated_at, key_hash, status,
         request_fingerprint, owner_hash, reserved_at, result, recovery)
       VALUES (?, ?, '', ?, ?, ?, 'completed', ?, NULL, NULL, ?, NULL)`,
      randomUUID(),
      'corrupt',
      now,
      now,
      createHash('sha256').update('scope-corrupt').digest('hex'),
      'request-corrupt',
      'not-json',
    );
    const store = new SqlDataSurfaceActionStateStore({ db });
    await expect(store.getIdempotency('scope-corrupt')).rejects.toBeInstanceOf(
      DataSurfaceActionStateCorruptionError,
    );
  });
});

function tokenRecord(): DataSurfacePreviewTokenRecord {
  return {
    expiresAt: 1_000,
    actorUserId: 'user-a',
    tenantId: 'tenant-a',
    onBehalfOfUserId: null,
    actsAsProfileId: null,
    agentClass: null,
    identityKey: 'report-a',
    actionId: 'refresh',
    actionFingerprint: 'action-a',
    revision: 1,
    queryFingerprint: 'query-a',
    selectionFingerprint: 'selection-a',
    resolvedRowsFingerprint: 'rows-a',
    requestFingerprint: 'request-a',
  };
}

function actionResult(): DataSurfaceActionResult {
  return {
    version: 1,
    requestId: 'request-a',
    identity: { kind: 'report', surfaceId: 'report-a' },
    actionId: 'refresh',
    phase: 'apply',
    ok: true,
  };
}
