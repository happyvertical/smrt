/**
 * The relay's schema and conditional statements on PostgreSQL. Runs only when
 * `SMRT_TEST_POSTGRES_URL` is set (`pnpm test:postgres` provides a disposable
 * database); skipped otherwise.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type DatabaseInterface, getDatabase } from '@happyvertical/sql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sha256Hex } from '../encoding.js';
import {
  migrateVaultRelayLeasesV1,
  VaultRelayLeaseStore,
} from '../lease-store.js';
import { migrateVaultRelayV1, VaultRelayStore } from '../metadata-store.js';
import { FilesystemObjectStore } from '../object-store.js';
import { VaultRelay } from '../relay.js';
import {
  acquireRequest,
  captureLogger,
  type Harness,
  leaseStatus,
  leaseToken,
  newDevice,
  signed,
  stubEntitlements,
  uploadSnapshot,
} from './helpers.js';

const url = process.env.SMRT_TEST_POSTGRES_URL;

describe.skipIf(!url)('vault relay on PostgreSQL', () => {
  let db: DatabaseInterface;
  let root: string;
  let h: Harness;
  const account = `acct-${randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    db = await getDatabase({
      type: 'postgres',
      url: String(url),
      cache: false,
    });
    await migrateVaultRelayV1(db);
    await migrateVaultRelayLeasesV1(db);
    // Idempotent: a second run is a no-op.
    await migrateVaultRelayV1(db);
    await migrateVaultRelayLeasesV1(db);
    root = await mkdtemp(join(tmpdir(), 'vault-relay-pg-'));
    const clock = { now: Date.now() };
    const logger = captureLogger();
    const entitlements = stubEntitlements(new Set([account]));
    const relay = new VaultRelay({
      store: new VaultRelayStore(db),
      objects: new FilesystemObjectStore(root),
      entitlements,
      policy: {
        quota: { maxBytes: 100_000, maxSnapshots: 3 },
        retention: { keepLast: 2, keepWithinMs: 0 },
        limits: { maxChunkBytes: 4096 },
      },
      logger,
      now: () => clock.now,
    });
    h = {
      relay,
      db,
      storeRoot: root,
      logger,
      entitlements,
      clock,
      close: async () => {},
    };
  });

  afterAll(async () => {
    await db?.close?.();
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('runs the upload, publish, retention, and sequence rules', async () => {
    const device = newDevice(account, 'device-1');
    expect(
      await h.relay.registerDevice(account, 'device-1', device.publicKey),
    ).toBe('registered');
    expect((await h.relay.ready()).ready).toBe(true);

    for (let sequence = 1; sequence <= 3; sequence++) {
      h.clock.now += 1000;
      const blob = randomBytes(5000);
      expect((await uploadSnapshot(h, device, sequence, blob)).status).toBe(
        201,
      );
    }
    const view = await h.relay.operatorView(account);
    expect(view.snapshots.map((s) => s.sequence)).toEqual([3, 2]);
    expect(view.usage).toMatchObject({
      highWaterSequence: 3,
      usedBytes: 10_000,
      usedSnapshots: 2,
    });

    const stale = await uploadSnapshot(h, device, 2, randomBytes(10));
    expect(stale.status).toBe(409);

    const nonce = randomBytes(18).toString('base64url');
    const first = await h.relay.handle(
      signed(h, device, 'GET', '/v1/snapshots', { nonce }),
    );
    expect(first.status).toBe(200);
    const replay = await h.relay.handle(
      signed(h, device, 'GET', '/v1/snapshots', { nonce }),
    );
    expect(replay.status).toBe(401);

    const tooBig = await h.relay.handle(
      signed(h, device, 'POST', '/v1/uploads', {
        body: JSON.stringify({
          fencingToken: await leaseToken(h, device),
          sequence: 9,
          byteSize: 95_000,
          chunkSize: 4096,
          sha256: sha256Hex('x'),
        }),
      }),
    );
    expect(tooBig.status).toBe(413);

    // Expiry sweep (LIMIT parameter) and usage repair (SUM/COUNT subqueries).
    const pending = await h.relay.handle(
      signed(h, device, 'POST', '/v1/uploads', {
        body: JSON.stringify({
          fencingToken: await leaseToken(h, device),
          sequence: 10,
          byteSize: 100,
          chunkSize: 100,
          sha256: sha256Hex('x'),
        }),
      }),
    );
    expect(pending.status).toBe(201);
    h.clock.now += 25 * 60 * 60 * 1000;
    expect(await h.relay.sweepExpired()).toBeGreaterThanOrEqual(1);
    await db.query(
      'UPDATE vault_relay_accounts SET used_bytes = 1 WHERE account_id = ?',
      account,
    );
    await new VaultRelayStore(db).reconcileUsage(account);
    expect((await h.relay.operatorView(account)).usage).toMatchObject({
      usedBytes: 10_000,
      usedSnapshots: 2,
    });

    await h.relay.revokeDevice(account, 'device-1');
    const revoked = await h.relay.handle(
      signed(h, device, 'GET', '/v1/snapshots'),
    );
    expect(revoked.status).toBe(401);
  });

  it('runs the primary-writer lease statements on PostgreSQL', async () => {
    const d2 = newDevice(account, 'device-2');
    const d3 = newDevice(account, 'device-3');
    for (const device of [d2, d3]) {
      await h.relay.registerDevice(account, device.deviceId, device.publicKey);
    }
    const head = (await leaseStatus(h, d2)).headSequence;
    const acquire = async (device: typeof d2, base: number) => {
      const response = await h.relay.handle(acquireRequest(h, device, base));
      return {
        status: response.status,
        body: (await response.json()) as Record<string, unknown>,
      };
    };
    // Concurrent acquires from two devices: exactly one wins the row.
    const raced = await Promise.all([acquire(d2, head), acquire(d3, head)]);
    expect(raced.map((r) => r.status).sort()).toEqual([200, 409]);
    const winner = raced[0].status === 200 ? d2 : d3;
    const loser = winner === d2 ? d3 : d2;
    const token = (raced[0].status === 200 ? raced[0] : raced[1]).body
      .fencingToken as number;

    const next = head + 10;
    expect(
      (await uploadSnapshot(h, winner, next, randomBytes(10), 4096, token))
        .status,
    ).toBe(201);
    // Begin under the lease, then lose it to the other device.
    const blob = randomBytes(10);
    const begun = await h.relay.handle(
      signed(h, winner, 'POST', '/v1/uploads', {
        body: JSON.stringify({
          fencingToken: token,
          sequence: next + 1,
          byteSize: blob.length,
          chunkSize: 4096,
          sha256: sha256Hex(blob),
        }),
      }),
    );
    const { uploadId } = (await begun.json()) as { uploadId: string };
    await h.relay.handle(
      signed(h, winner, 'PUT', `/v1/uploads/${uploadId}/chunks/0`, {
        body: blob,
      }),
    );
    h.clock.now += 301_000;
    expect((await acquire(loser, head)).body.error).toBe('must_restore_first');
    expect((await acquire(loser, next)).status).toBe(200);
    const stale = await h.relay.handle(
      signed(h, winner, 'POST', `/v1/uploads/${uploadId}/commit`),
    );
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as { error: string }).error).toBe(
      'must_restore_first',
    );
    // The head is never deleted.
    const removeHead = await h.relay.handle(
      signed(h, loser, 'DELETE', `/v1/snapshots/${next}`),
    );
    expect(removeHead.status).toBe(409);

    // A hole: the head advanced, then its upload expired.
    const t = (await acquire(loser, next)).body.fencingToken as number;
    const holeBlob = randomBytes(10);
    const hole = await h.relay.handle(
      signed(h, loser, 'POST', '/v1/uploads', {
        body: JSON.stringify({
          fencingToken: t,
          sequence: next + 5,
          byteSize: holeBlob.length,
          chunkSize: 4096,
          sha256: sha256Hex(holeBlob),
        }),
      }),
    );
    const holeId = ((await hole.json()) as { uploadId: string }).uploadId;
    expect(
      await new VaultRelayLeaseStore(db).advanceHead(
        account,
        loser.deviceId,
        holeId,
        t,
        next + 5,
        h.clock.now,
      ),
    ).toBe(true);
    h.clock.now += 25 * 60 * 60 * 1000;
    await h.relay.sweepExpired();
    expect(await leaseStatus(h, winner)).toMatchObject({
      headSequence: next + 5,
      latestCommittedSequence: next,
      headIsHole: true,
    });
    expect((await acquire(winner, next)).status).toBe(200);
  });

  it('runs the lapse and audit statements on PostgreSQL (#4819)', async () => {
    const store = new VaultRelayStore(db);
    const lapsed = `lapse-${randomUUID().slice(0, 8)}`;
    expect(await store.getLapse(lapsed)).toBeNull();
    const first = await store.recordLapse(lapsed, 1000);
    expect(first).toEqual({ accountId: lapsed, lapsedAt: 1000, sweptAt: null });
    // The first observation wins; the window never slides.
    expect((await store.recordLapse(lapsed, 9000)).lapsedAt).toBe(1000);
    const due = await store.listDueLapses(1000, 100);
    expect(due.map((lapse) => lapse.accountId)).toContain(lapsed);
    expect(await store.markLapseSwept(lapsed, 2000)).toBe(true);
    expect(await store.markLapseSwept(lapsed, 3000)).toBe(false);
    expect(
      (await store.listDueLapses(1000, 100)).map((lapse) => lapse.accountId),
    ).not.toContain(lapsed);
    expect(await store.clearLapse(lapsed)).toBe(true);
    expect(await store.clearLapse(lapsed)).toBe(false);

    expect(Array.isArray(await store.listUnrecordedAccounts('', 5))).toBe(true);
    expect(await store.hasCommitted(`none-${randomUUID()}`)).toBe(false);

    const id = randomUUID();
    await store.appendAudit({
      id,
      at: 5000,
      action: 'lapse_sweep_completed',
      operator: 'ops/token:abc',
      accountHandle: 'deadbeef',
      snapshots: 2,
      bytes: 16,
      detail: '{}',
    });
    const audit = await store.listAudit(1000);
    expect(audit.find((entry) => entry.id === id)).toMatchObject({
      action: 'lapse_sweep_completed',
      snapshots: 2,
      bytes: 16,
    });
  });
});
