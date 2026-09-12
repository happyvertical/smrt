import { randomUUID } from 'node:crypto';
import { getDatabase } from '@happyvertical/sql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SqlDataSurfaceActionStateStore } from './sql-data-surface-action-state.js';

const pgUrl = process.env.SMRT_TEST_POSTGRES_URL;
const postgresDescribe = pgUrl ? describe.sequential : describe.skip;

postgresDescribe('SQL data-surface action state on PostgreSQL', () => {
  let db: Awaited<ReturnType<typeof getDatabase>> | undefined;

  beforeAll(async () => {
    db = await getDatabase({
      type: 'postgres',
      url: pgUrl,
      dbid: `smrt-action-state-${randomUUID()}`,
      __smrtSkipVitestSchemaPreparation: true,
    } as Parameters<typeof getDatabase>[0]);
    await db.query('DROP TABLE IF EXISTS _smrt_data_surface_action_tokens');
    await db.query(
      'DROP TABLE IF EXISTS _smrt_data_surface_action_idempotency',
    );
    await db.query(`CREATE TABLE _smrt_data_surface_action_tokens (
      id TEXT PRIMARY KEY, slug TEXT NOT NULL, context TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE, record JSONB NOT NULL,
      consumed_by TEXT NULL
    )`);
    await db.query(`CREATE TABLE _smrt_data_surface_action_idempotency (
      id TEXT PRIMARY KEY, slug TEXT NOT NULL, context TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      key_hash TEXT NOT NULL UNIQUE, status TEXT NOT NULL,
      request_fingerprint TEXT NOT NULL, owner_hash TEXT NULL,
      reserved_at TEXT NULL, result JSONB NULL, recovery JSONB NULL
    )`);
  });

  afterAll(async () => {
    await db?.query('DROP TABLE IF EXISTS _smrt_data_surface_action_tokens');
    await db?.query(
      'DROP TABLE IF EXISTS _smrt_data_surface_action_idempotency',
    );
    await db?.close?.();
  });

  it('atomically consumes and reserves across independent store instances', async () => {
    if (!db) throw new Error('PostgreSQL test database is unavailable');
    const first = new SqlDataSurfaceActionStateStore({ db });
    const second = new SqlDataSurfaceActionStateStore({ db });
    await first.putToken('postgres-secret-token', {
      expiresAt: Date.now() + 60_000,
      actorUserId: 'user-a',
      tenantId: 'tenant-a',
      onBehalfOfUserId: null,
      actsAsProfileId: null,
      agentClass: null,
      identityKey: 'orders',
      actionId: 'archive',
      actionFingerprint: 'action-a',
      revision: 1,
      queryFingerprint: 'query-a',
      selectionFingerprint: 'selection-a',
      resolvedRowsFingerprint: 'rows-a',
      requestFingerprint: 'request-a',
    });
    const consumed = await Promise.all([
      first.markTokenConsumed('postgres-secret-token', 'apply-a'),
      second.markTokenConsumed('postgres-secret-token', 'apply-b'),
    ]);
    expect(consumed.filter(Boolean)).toHaveLength(1);

    const reservedAt = Date.now();
    const reservations = await Promise.all([
      first.reserveIdempotency('postgres-scope', {
        requestFingerprint: 'request-a',
        ownerToken: 'owner-a',
        reservedAt,
      }),
      second.reserveIdempotency('postgres-scope', {
        requestFingerprint: 'request-a',
        ownerToken: 'owner-b',
        reservedAt: reservedAt + 1,
      }),
    ]);
    expect(
      reservations.filter(
        (record) => record.status === 'reserved' && record.ownerToken,
      ),
    ).toHaveLength(1);
    expect(reservations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: 'reserved',
          requestFingerprint: 'request-a',
        }),
      ]),
    );
  });
});
