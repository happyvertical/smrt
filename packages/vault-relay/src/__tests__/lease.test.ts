import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sha256Hex } from '../encoding.js';
import { VaultRelayLeaseStore } from '../lease-store.js';
import {
  acquireRequest,
  adminRequest,
  createHarness,
  type Harness,
  leaseStatus,
  newDevice,
  registerDevice,
  signed,
  type TestDevice,
  uploadSnapshot,
} from './helpers.js';

let h: Harness;
let a1: TestDevice;
let a2: TestDevice;

beforeEach(async () => {
  h = await createHarness();
  a1 = newDevice('acct-a', 'device-a1');
  a2 = newDevice('acct-a', 'device-a2');
  for (const device of [a1, a2]) await registerDevice(h, device);
});

afterEach(async () => {
  await h.close();
});

async function body(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

async function acquire(
  device: TestDevice,
  baseSequence: number,
  extra: Record<string, unknown> = {},
) {
  const response = await h.relay.handle(
    acquireRequest(h, device, baseSequence, extra),
  );
  return { status: response.status, body: await body(response) };
}

async function token(device: TestDevice, base: number): Promise<number> {
  const result = await acquire(device, base);
  expect(result.status).toBe(200);
  return result.body.fencingToken as number;
}

function leaseCall(
  device: TestDevice,
  action: 'renew' | 'release',
  fencingToken: number,
) {
  return h.relay.handle(
    signed(h, device, 'POST', `/v1/lease/${action}`, {
      body: JSON.stringify({ fencingToken }),
    }),
  );
}

async function begin(
  device: TestDevice,
  sequence: number,
  fencingToken: number,
  blob: Uint8Array,
) {
  const response = await h.relay.handle(
    signed(h, device, 'POST', '/v1/uploads', {
      body: JSON.stringify({
        fencingToken,
        sequence,
        byteSize: blob.length,
        chunkSize: 4096,
        sha256: sha256Hex(blob),
      }),
    }),
  );
  return { status: response.status, body: await body(response) };
}

async function put(device: TestDevice, uploadId: string, blob: Uint8Array) {
  const response = await h.relay.handle(
    signed(h, device, 'PUT', `/v1/uploads/${uploadId}/chunks/0`, {
      body: blob,
    }),
  );
  expect(response.status).toBe(200);
}

async function commit(device: TestDevice, uploadId: string) {
  const response = await h.relay.handle(
    signed(h, device, 'POST', `/v1/uploads/${uploadId}/commit`),
  );
  return { status: response.status, body: await body(response) };
}

describe('primary-writer lease', () => {
  it('lets one device write and makes the other restore first', async () => {
    const t1 = await token(a1, 0);
    expect(t1).toBe(1);
    const held = await acquire(a2, 0);
    expect(held.status).toBe(409);
    expect(held.body).toMatchObject({
      error: 'lease_held',
      holder: 'device-a1',
    });

    expect(
      (await uploadSnapshot(h, a1, 1, randomBytes(50), 4096, t1)).status,
    ).toBe(201);
    expect((await leaseCall(a1, 'release', t1)).status).toBe(204);

    // a2 is still at sequence 0: divergence is refused, not merged.
    const stale = await acquire(a2, 0);
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({
      error: 'must_restore_first',
      headSequence: 1,
      latestSequence: 1,
    });
    const t2 = await token(a2, 1);
    expect(t2).toBe(2);
    expect(await leaseStatus(h, a1)).toMatchObject({
      holder: 'device-a2',
      headSequence: 1,
      latestCommittedSequence: 1,
      headIsHole: false,
    });
  });

  it('never returns the fencing token in the public status', async () => {
    await token(a1, 0);
    const status = await leaseStatus(h, a2);
    expect(status).not.toHaveProperty('fencingToken');
  });

  it('expires on the relay clock, refuses renewal after expiry, and allows takeover', async () => {
    const t1 = await token(a1, 0);
    h.clock.now += 20_000;
    expect((await leaseCall(a1, 'renew', t1)).status).toBe(200);
    h.clock.now += 31_000;
    const late = await leaseCall(a1, 'renew', t1);
    expect(late.status).toBe(409);
    expect((await body(late)).error).toBe('lease_lost');

    const t2 = await token(a2, 0);
    expect(t2).toBeGreaterThan(t1);
    // The old holder's token is fenced for writes and for release.
    const refused = await begin(a1, 1, t1, randomBytes(10));
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe('must_restore_first');
    expect((await leaseCall(a1, 'release', t1)).status).toBe(204);
    expect((await leaseStatus(h, a1)).holder).toBe('device-a2');
    expect((await acquire(a1, 0)).body.error).toBe('lease_held');
  });

  it('fences an earlier process of the same device on re-acquire', async () => {
    const first = await token(a1, 0);
    const second = await token(a1, 0);
    expect(second).toBe(first + 1);
    const stale = await begin(a1, 1, first, randomBytes(10));
    expect(stale.status).toBe(409);
    expect(stale.body.error).toBe('must_restore_first');
    expect((await begin(a1, 1, second, randomBytes(10))).status).toBe(201);
  });

  it('refuses a publish without the lease or with a forged token', async () => {
    const noLease = await begin(a2, 1, 1, randomBytes(10));
    expect(noLease.status).toBe(409);
    expect(noLease.body.error).toBe('must_restore_first');
    const t1 = await token(a1, 0);
    const forged = await begin(a2, 1, t1, randomBytes(10));
    expect(forged.status).toBe(409);
    expect(forged.body.error).toBe('must_restore_first');
    const missing = await h.relay.handle(
      signed(h, a1, 'POST', '/v1/uploads', {
        body: JSON.stringify({
          sequence: 1,
          byteSize: 10,
          chunkSize: 4096,
          sha256: sha256Hex('x'),
        }),
      }),
    );
    expect(missing.status).toBe(400);
  });

  it('discards a stale holder commit after a takeover and publish', async () => {
    const t1 = await token(a1, 0);
    const blob = randomBytes(20);
    const started = await begin(a1, 1, t1, blob);
    const uploadId = started.body.uploadId as string;
    await put(a1, uploadId, blob);

    h.clock.now += 31_000;
    const t2 = await token(a2, 0);
    expect(
      (await uploadSnapshot(h, a2, 2, randomBytes(30), 4096, t2)).status,
    ).toBe(201);

    const stale = await commit(a1, uploadId);
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({
      error: 'must_restore_first',
      headSequence: 2,
    });
    const view = await h.relay.operatorView('acct-a');
    expect(view.snapshots.map((s) => [s.sequence, s.status])).toEqual([
      [2, 'committed'],
    ]);
  });

  it('refuses a commit after the holder lease expired, even with nobody else', async () => {
    const t1 = await token(a1, 0);
    const blob = randomBytes(20);
    const started = await begin(a1, 1, t1, blob);
    await put(a1, started.body.uploadId as string, blob);
    h.clock.now += 31_000;
    const late = await commit(a1, started.body.uploadId as string);
    expect(late.status).toBe(409);
    expect(late.body.error).toBe('must_restore_first');
  });

  it('blocks takeover while a publish is in flight at the head, and lets the holder finish it', async () => {
    const t1 = await token(a1, 0);
    const blob = randomBytes(20);
    const started = await begin(a1, 1, t1, blob);
    const uploadId = started.body.uploadId as string;
    await put(a1, uploadId, blob);
    // The relay advanced the head, then failed before publishing.
    const leases = new VaultRelayLeaseStore(h.db);
    expect(
      await leases.advanceHead(
        'acct-a',
        'device-a1',
        uploadId,
        t1,
        1,
        h.clock.now,
      ),
    ).toBe(true);

    h.clock.now += 31_000;
    const blocked = await acquire(a2, 0);
    expect(blocked.status).toBe(409);
    expect(blocked.body).toMatchObject({
      error: 'publish_in_progress',
      headSequence: 1,
    });
    // The retry completes even after expiry: nobody could take over.
    expect((await commit(a1, uploadId)).status).toBe(201);
    expect((await acquire(a2, 0)).body.error).toBe('must_restore_first');
    expect((await acquire(a2, 1)).status).toBe(200);
  });

  it('treats an abandoned head as a hole and accepts the latest committed base', async () => {
    const t1 = await token(a1, 0);
    expect(
      (await uploadSnapshot(h, a1, 1, randomBytes(10), 4096, t1)).status,
    ).toBe(201);
    const blob = randomBytes(20);
    const started = await begin(a1, 2, t1, blob);
    const uploadId = started.body.uploadId as string;
    await put(a1, uploadId, blob);
    const leases = new VaultRelayLeaseStore(h.db);
    await leases.advanceHead(
      'acct-a',
      'device-a1',
      uploadId,
      t1,
      2,
      h.clock.now,
    );

    h.clock.now += 61_000;
    await h.relay.sweepExpired();
    expect(await leaseStatus(h, a2)).toMatchObject({
      headSequence: 2,
      latestCommittedSequence: 1,
      headIsHole: true,
    });
    expect((await acquire(a2, 0)).body.error).toBe('must_restore_first');
    const t2 = await token(a2, 1);
    expect(
      (await uploadSnapshot(h, a2, 3, randomBytes(10), 4096, t2)).status,
    ).toBe(201);
    expect(await leaseStatus(h, a2)).toMatchObject({
      headSequence: 3,
      headIsHole: false,
    });
  });

  it('grants one of two interleaved acquires (true races run in postgres.optional)', async () => {
    const results = await Promise.all([acquire(a1, 0), acquire(a2, 0)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
  });

  it('refuses a replayed acquire', async () => {
    const nonce = randomBytes(18).toString('base64url');
    const body = JSON.stringify({ baseSequence: 0 });
    const first = await h.relay.handle(
      signed(h, a1, 'POST', '/v1/lease/acquire', { body, nonce }),
    );
    expect(first.status).toBe(200);
    const replay = await h.relay.handle(
      signed(h, a1, 'POST', '/v1/lease/acquire', { body, nonce }),
    );
    expect(replay.status).toBe(401);
    expect((await leaseStatus(h, a1)).holder).toBe('device-a1');
  });

  it('clears and fences the lease of a revoked device', async () => {
    const t1 = await token(a1, 0);
    const revoked = await h.relay.handleAdmin(
      adminRequest('DELETE', '/admin/v1/accounts/acct-a/devices/device-a1'),
    );
    expect(revoked.status).toBe(204);
    expect((await leaseStatus(h, a2)).holder).toBeNull();
    const t2 = await token(a2, 0);
    expect(t2).toBeGreaterThan(t1 + 1);
  });

  it('clamps the requested lifetime to the policy bounds', async () => {
    const short = await acquire(a1, 0, { ttlSeconds: 1 });
    expect(short.body.ttlMs).toBe(30_000);
    const long = await acquire(a1, 0, { ttlSeconds: 10_000 });
    expect(long.body.ttlMs).toBe(30_000);
    const invalid = await acquire(a1, -1);
    expect(invalid.status).toBe(400);
  });

  it('never deletes the head or the latest committed snapshot', async () => {
    const t1 = await token(a1, 0);
    await uploadSnapshot(h, a1, 1, randomBytes(10), 4096, t1);
    await uploadSnapshot(h, a1, 2, randomBytes(10), 4096, t1);
    const head = await h.relay.handle(
      signed(h, a1, 'DELETE', '/v1/snapshots/2'),
    );
    expect(head.status).toBe(409);
    expect((await body(head)).error).toBe('head_snapshot');
    expect(
      (await h.relay.handle(signed(h, a1, 'DELETE', '/v1/snapshots/1'))).status,
    ).toBe(204);
  });
});
