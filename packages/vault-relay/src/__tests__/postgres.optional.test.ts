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
import { migrateVaultRelayV1, VaultRelayStore } from '../metadata-store.js';
import { FilesystemObjectStore } from '../object-store.js';
import { VaultRelay } from '../relay.js';
import {
  captureLogger,
  type Harness,
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
    // Idempotent: a second run is a no-op.
    await migrateVaultRelayV1(db);
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
});
