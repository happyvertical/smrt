import { randomUUID } from 'node:crypto';
import { existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getTestDatabase } from '@happyvertical/smrt-core';
import { requireTenant, withTenant } from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ForgeDeliveryCollection,
  type ForgeObservation,
  ForgeProjectionRuntime,
  type ForgeProjector,
} from '../forge-projection.js';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const openDatabases: DatabaseInterface[] = [];
const tempFiles: string[] = [];

afterEach(async () => {
  await Promise.all(openDatabases.splice(0).map((db) => db.close?.()));
  for (const path of tempFiles.splice(0)) {
    unlinkIfExists(path);
    unlinkIfExists(`${path}-shm`);
    unlinkIfExists(`${path}-wal`);
  }
});

describe('durable forge delivery projection', () => {
  it('atomically suppresses the same provider delivery across concurrent inboxes', async () => {
    const path = join(tmpdir(), `forge-dedupe-${randomUUID()}.db`);
    tempFiles.push(path);
    const seed = await testDb(`file:${path}`);
    const peer = await testDb(`file:${path}`);
    const first = await ForgeDeliveryCollection.create({ db: seed });
    const second = await ForgeDeliveryCollection.create({ db: peer });

    const results = await withTenant({ tenantId: TENANT_A }, () =>
      Promise.all([
        first.accept(deliveryInput('same-delivery')),
        second.accept(deliveryInput('same-delivery')),
      ]),
    );

    expect(results.filter((result) => result.accepted)).toHaveLength(1);
    expect(new Set(results.map((result) => result.delivery.id)).size).toBe(1);
    const rows = await seed.query(
      'SELECT COUNT(*) AS count FROM _smrt_forge_deliveries',
    );
    expect(Number((rows.rows[0] as { count: number }).count)).toBe(1);
  });

  it('isolates operator replay by tenant context', async () => {
    const db = await testDb();
    const inbox = await ForgeDeliveryCollection.create({ db });
    const accepted = await withTenant({ tenantId: TENANT_A }, () =>
      inbox.accept({ ...deliveryInput('tenant-delivery'), maxAttempts: 1 }),
    );
    await db.query(
      `UPDATE _smrt_forge_deliveries SET status = 'dead_letter'
        WHERE id = ?`,
      accepted.delivery.id,
    );

    const crossTenant = await withTenant({ tenantId: TENANT_B }, () =>
      inbox.replay(accepted.delivery.id ?? ''),
    );
    expect(crossTenant).toBe(false);
    const ownTenant = await withTenant({ tenantId: TENANT_A }, () =>
      inbox.replay(accepted.delivery.id ?? ''),
    );
    expect(ownTenant).toBe(true);
  });

  it('reclaims expired leases and rejects the stale worker token', async () => {
    const db = await testDb();
    const inbox = await ForgeDeliveryCollection.create({ db });
    const epoch = new Date('2026-07-26T12:00:00.000Z');
    await withTenant({ tenantId: TENANT_A }, () =>
      inbox.accept({ ...deliveryInput('lease-delivery'), receivedAt: epoch }),
    );
    const workerA = await inbox.claimReady({
      workerId: 'worker-a',
      leaseMs: 100,
      now: epoch,
    });
    expect(workerA?.leaseToken).toBeTruthy();
    expect(
      await inbox.claimReady({
        workerId: 'worker-b',
        leaseMs: 100,
        now: new Date(epoch.getTime() + 99),
      }),
    ).toBeNull();
    const workerB = await inbox.claimReady({
      workerId: 'worker-b',
      leaseMs: 100,
      now: new Date(epoch.getTime() + 101),
    });
    expect(workerB?.leaseToken).not.toBe(workerA?.leaseToken);

    const staleWrite = await db.query(
      `UPDATE _smrt_forge_deliveries SET status = 'completed'
        WHERE id = ? AND status = 'leased' AND lease_token = ?
        RETURNING id`,
      workerA?.id,
      workerA?.leaseToken,
    );
    expect(staleWrite.rows).toHaveLength(0);
    const current = await db.query(
      `SELECT lease_owner, status FROM _smrt_forge_deliveries WHERE id = ?`,
      workerB?.id,
    );
    expect(current.rows[0]).toMatchObject({
      lease_owner: 'worker-b',
      status: 'leased',
    });
  });

  it('restores tenant context and ignores delayed older observations', async () => {
    const db = await testDb();
    const inbox = await ForgeDeliveryCollection.create({ db });
    await db.query(
      'CREATE TABLE projection_sink (version INTEGER NOT NULL, tenant_id TEXT NOT NULL)',
    );
    await withTenant({ tenantId: TENANT_A }, () =>
      inbox.accept({
        ...deliveryInput('newer'),
        payload: { version: 2 },
      }),
    );

    const projected: number[] = [];
    const projector = versionProjector(projected);
    const runtime = new ForgeProjectionRuntime({
      db,
      workerId: 'projection-worker',
    });
    await runtime.processNext(projector);

    await withTenant({ tenantId: TENANT_A }, () =>
      inbox.accept({
        ...deliveryInput('older'),
        payload: { version: 1 },
      }),
    );
    await runtime.processNext(projector);

    expect(projected).toEqual([2]);
    const checkpoint = await db.query(
      `SELECT observation_version, delivery_id
         FROM _smrt_forge_projection_checkpoints`,
    );
    expect(checkpoint.rows).toEqual([
      { observation_version: 2, delivery_id: 'newer' },
    ]);
    const sink = await db.query(
      'SELECT version, tenant_id FROM projection_sink',
    );
    expect(sink.rows).toEqual([{ version: 2, tenant_id: TENANT_A }]);
    const statuses = await db.query(
      'SELECT status FROM _smrt_forge_deliveries ORDER BY delivery_id',
    );
    expect(statuses.rows).toEqual([
      { status: 'completed' },
      { status: 'completed' },
    ]);
  });

  it('schedules retries, redacts dead-letter failures, and replays recovery', async () => {
    const db = await testDb();
    const inbox = await ForgeDeliveryCollection.create({ db });
    const start = new Date('2026-07-26T12:00:00.000Z');
    const accepted = await withTenant({ tenantId: TENANT_A }, () =>
      inbox.accept({
        ...deliveryInput('poison'),
        maxAttempts: 2,
        receivedAt: start,
      }),
    );
    const runtime = new ForgeProjectionRuntime({
      db,
      workerId: 'failure-worker',
      retryBaseMs: 100,
      retryMaxMs: 100,
    });
    const failing: ForgeProjector = {
      async observe() {
        throw new Error('provider apiKey=super-secret-value rejected');
      },
      async project() {},
    };

    await runtime.processNext(failing, { now: start });
    const retry = await rowFor(db, accepted.delivery.id ?? '');
    expect(retry).toMatchObject({
      status: 'retry',
      attempts: 1,
      last_error: 'provider apiKey=***REDACTED*** rejected',
      next_attempt_at: new Date(start.getTime() + 100).toISOString(),
    });
    await runtime.processNext(failing, {
      now: new Date(start.getTime() + 100),
    });
    const dead = await rowFor(db, accepted.delivery.id ?? '');
    expect(dead).toMatchObject({
      status: 'dead_letter',
      attempts: 2,
    });

    expect(
      await withTenant({ tenantId: TENANT_A }, () =>
        inbox.replay(accepted.delivery.id ?? ''),
      ),
    ).toBe(true);
    await runtime.processNext({
      async observe(delivery) {
        return {
          projection: 'recovery',
          subjectKey: delivery.deliveryId,
          version: 1,
          value: null,
        };
      },
      async project() {},
    });
    const recovered = await rowFor(db, accepted.delivery.id ?? '');
    expect(recovered).toMatchObject({
      status: 'completed',
      attempts: 1,
      replay_count: 1,
      last_error: null,
    });
  });
});

function deliveryInput(deliveryId: string) {
  return {
    provider: 'github',
    deliveryId,
    installationKey: 'installation:42',
    repositoryKey: 'happyvertical/example',
    eventName: 'pull_request',
    payload: { version: 1 },
  };
}

function versionProjector(projected: number[]): ForgeProjector {
  return {
    async observe(delivery) {
      expect(requireTenant().tenantId).toBe(delivery.tenantId);
      return {
        projection: 'pull-request-revision',
        subjectKey: 'repo:pr:7',
        version: Number(delivery.payload.version),
        value: delivery.payload,
      } satisfies ForgeObservation;
    },
    async project(observation, context) {
      expect(requireTenant().tenantId).toBe(context.tenantId);
      await context.db.query(
        'INSERT INTO projection_sink (version, tenant_id) VALUES (?, ?)',
        observation.version,
        context.tenantId,
      );
      projected.push(observation.version);
    },
  };
}

async function testDb(url = ':memory:'): Promise<DatabaseInterface> {
  const db = await getTestDatabase({ type: 'sqlite', url });
  openDatabases.push(db);
  return db;
}

async function rowFor(db: DatabaseInterface, id: string) {
  const result = await db.query(
    'SELECT * FROM _smrt_forge_deliveries WHERE id = ?',
    id,
  );
  return result.rows[0];
}

function unlinkIfExists(path: string): void {
  if (existsSync(path)) unlinkSync(path);
}
