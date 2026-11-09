import { randomBytes } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HEADER_SIGNATURE } from '../auth.js';
import { sha256Hex } from '../encoding.js';
import { VaultRelayStore } from '../metadata-store.js';
import {
  adminRequest,
  BASE,
  createHarness,
  DEFAULT_POLICY,
  downloadSnapshot,
  type Harness,
  leaseToken,
  newDevice,
  registerDevice,
  signed,
  type TestDevice,
  uploadSnapshot,
} from './helpers.js';

let h: Harness;
let a1: TestDevice;
let a2: TestDevice;
let b1: TestDevice;

beforeEach(async () => {
  h = await createHarness();
  a1 = newDevice('acct-a', 'device-a1');
  a2 = newDevice('acct-a', 'device-a2');
  b1 = newDevice('acct-b', 'device-b1');
  for (const device of [a1, a2, b1]) await registerDevice(h, device);
});

afterEach(async () => {
  await h.close();
});

async function errorCode(response: Response): Promise<string> {
  return ((await response.json()) as { error: string }).error;
}

describe('round trip', () => {
  it('stores, lists, and returns a multi-chunk blob byte for byte', async () => {
    const blob = randomBytes(10_000);
    const commit = await uploadSnapshot(h, a1, 1, blob);
    expect(commit.status).toBe(201);
    const latest = await h.relay.handle(
      signed(h, a2, 'GET', '/v1/snapshots/latest'),
    );
    expect(latest.status).toBe(200);
    const meta = (await latest.json()) as Record<string, unknown>;
    expect(meta).toMatchObject({
      sequence: 1,
      byteSize: 10_000,
      chunkCount: 3,
      sha256: sha256Hex(blob),
      deviceId: 'device-a1',
    });
    expect(Buffer.from(await downloadSnapshot(h, a2, 1))).toEqual(blob);
  });

  it('serves health and readiness without authentication', async () => {
    expect((await h.relay.handle(new Request(`${BASE}/healthz`))).status).toBe(
      200,
    );
    expect((await h.relay.handle(new Request(`${BASE}/readyz`))).status).toBe(
      200,
    );
  });

  it('reports not ready when the schema is missing', async () => {
    await h.db.query('DROP TABLE vault_relay_nonces');
    const response = await h.relay.handle(new Request(`${BASE}/readyz`));
    expect(response.status).toBe(503);
  });
});

describe('authentication', () => {
  it('rejects an unsigned request', async () => {
    const response = await h.relay.handle(new Request(`${BASE}/v1/snapshots`));
    expect(response.status).toBe(401);
    expect(h.entitlements.calls).toEqual([]);
  });

  it('rejects a replayed request', async () => {
    const nonce = randomBytes(18).toString('base64url');
    const first = await h.relay.handle(
      signed(h, a1, 'GET', '/v1/snapshots', { nonce }),
    );
    expect(first.status).toBe(200);
    const replay = await h.relay.handle(
      signed(h, a1, 'GET', '/v1/snapshots', { nonce }),
    );
    expect(replay.status).toBe(401);
  });

  it('rejects a timestamp outside the skew window', async () => {
    for (const offset of [-30_001, 30_001]) {
      const response = await h.relay.handle(
        signed(h, a1, 'GET', '/v1/snapshots', {
          timestamp: h.clock.now + offset,
        }),
      );
      expect(response.status).toBe(401);
    }
  });

  it('rejects a signature over a different path or a forged signature', async () => {
    const otherPath = await h.relay.handle(
      signed(h, a1, 'GET', '/v1/snapshots', { signedPath: '/v1/snapshots/1' }),
    );
    expect(otherPath.status).toBe(401);
    const forged = signed(h, a1, 'GET', '/v1/snapshots');
    forged.headers.set(
      HEADER_SIGNATURE,
      Buffer.alloc(64).toString('base64url'),
    );
    expect((await h.relay.handle(forged)).status).toBe(401);
  });

  it('binds the body: a body that differs from the signed digest is refused', async () => {
    const body = JSON.stringify({
      sequence: 1,
      byteSize: 10,
      chunkSize: 10,
      sha256: sha256Hex('x'),
    });
    const response = await h.relay.handle(
      signed(h, a1, 'POST', '/v1/uploads', {
        body,
        signedDigest: sha256Hex('something else'),
      }),
    );
    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe('content_digest_mismatch');
  });

  it('rejects a revoked device from the next request on', async () => {
    expect(
      (await h.relay.handle(signed(h, a2, 'GET', '/v1/snapshots'))).status,
    ).toBe(200);
    expect(await h.relay.revokeDevice('acct-a', 'device-a2')).toBe(true);
    expect(
      (await h.relay.handle(signed(h, a2, 'GET', '/v1/snapshots'))).status,
    ).toBe(401);
    // A revoked id cannot be re-activated, even with its old key.
    expect(
      await h.relay.registerDevice('acct-a', 'device-a2', a2.publicKey),
    ).toBe('conflict');
  });

  it('rejects a device signing as another account', async () => {
    const response = await h.relay.handle(
      signed(h, b1, 'GET', '/v1/snapshots', { claimAccount: 'acct-a' }),
    );
    expect(response.status).toBe(401);
  });

  it('rejects a key registered under the same device id in another account', async () => {
    const impostor = newDevice('acct-a', 'device-b1');
    const response = await h.relay.handle(
      signed(h, { ...impostor, accountId: 'acct-a' }, 'GET', '/v1/snapshots'),
    );
    expect(response.status).toBe(401);
  });

  it('rejects malformed identity headers before any lookup', async () => {
    const response = await h.relay.handle(
      signed(h, a1, 'GET', '/v1/snapshots', {
        headers: { 'x-vault-account': '../acct-a' },
      }),
    );
    expect(response.status).toBe(401);
  });
});

describe('cross-account isolation', () => {
  it("never serves or deletes another account's snapshot", async () => {
    expect((await uploadSnapshot(h, a1, 1, randomBytes(100))).status).toBe(201);
    for (const [method, path] of [
      ['GET', '/v1/snapshots/1'],
      ['GET', '/v1/snapshots/1/chunks/0'],
      ['DELETE', '/v1/snapshots/1'],
    ] as const) {
      const response = await h.relay.handle(signed(h, b1, method, path));
      expect(response.status).toBe(404);
    }
    const list = await h.relay.handle(signed(h, b1, 'GET', '/v1/snapshots'));
    expect(await list.json()).toEqual({ snapshots: [] });
    expect(
      (await h.relay.handle(signed(h, a1, 'GET', '/v1/snapshots/1'))).status,
    ).toBe(200);
  });

  it("cannot write into or commit another account's upload", async () => {
    const begin = await h.relay.handle(
      signed(h, a1, 'POST', '/v1/uploads', {
        body: JSON.stringify({
          fencingToken: await leaseToken(h, a1),
          sequence: 1,
          byteSize: 4,
          chunkSize: 4,
          sha256: sha256Hex('abcd'),
        }),
      }),
    );
    const { uploadId } = (await begin.json()) as { uploadId: string };
    const put = await h.relay.handle(
      signed(h, b1, 'PUT', `/v1/uploads/${uploadId}/chunks/0`, {
        body: 'abcd',
      }),
    );
    expect(put.status).toBe(404);
    const commit = await h.relay.handle(
      signed(h, b1, 'POST', `/v1/uploads/${uploadId}/commit`),
    );
    expect(commit.status).toBe(404);
    const abort = await h.relay.handle(
      signed(h, b1, 'DELETE', `/v1/uploads/${uploadId}`),
    );
    expect(abort.status).toBe(404);
  });
});

describe('quotas and request bounds', () => {
  it('refuses a snapshot larger than the byte quota', async () => {
    const response = await h.relay.handle(
      signed(h, a1, 'POST', '/v1/uploads', {
        body: JSON.stringify({
          fencingToken: await leaseToken(h, a1),
          sequence: 1,
          byteSize: 1_000_001,
          chunkSize: 4096,
          sha256: sha256Hex('x'),
        }),
      }),
    );
    expect(response.status).toBe(413);
    expect(await errorCode(response)).toBe('quota_exceeded');
  });

  it('counts pending uploads against the byte quota', async () => {
    const fencingToken = await leaseToken(h, a1);
    const begin = (sequence: number) =>
      h.relay.handle(
        signed(h, a1, 'POST', '/v1/uploads', {
          body: JSON.stringify({
            fencingToken,
            sequence,
            byteSize: 600_000,
            chunkSize: 4096,
            sha256: sha256Hex('x'),
          }),
        }),
      );
    expect((await begin(1)).status).toBe(201);
    const second = await begin(2);
    expect(second.status).toBe(413);
    expect(await errorCode(second)).toBe('quota_exceeded');
  });

  it('enforces the snapshot-count quota', async () => {
    const policy = {
      quota: { maxBytes: 1_000_000, maxSnapshots: 2 },
      retention: { keepLast: 1, keepWithinMs: 60 * 60 * 1000 },
      limits: { maxChunkBytes: 4096 },
    };
    const local = await createHarness({ policy });
    try {
      const device = newDevice('acct-a', 'device-a1');
      await registerDevice(local, device);
      expect(
        (await uploadSnapshot(local, device, 1, randomBytes(10))).status,
      ).toBe(201);
      expect(
        (await uploadSnapshot(local, device, 2, randomBytes(10))).status,
      ).toBe(201);
      const third = await uploadSnapshot(local, device, 3, randomBytes(10));
      expect(third.status).toBe(413);
    } finally {
      await local.close();
    }
  });

  it('refuses a chunk size above the configured bound', async () => {
    const response = await h.relay.handle(
      signed(h, a1, 'POST', '/v1/uploads', {
        body: JSON.stringify({
          fencingToken: await leaseToken(h, a1),
          sequence: 1,
          byteSize: 10_000,
          chunkSize: 4097,
          sha256: sha256Hex('x'),
        }),
      }),
    );
    expect(response.status).toBe(413);
    expect(await errorCode(response)).toBe('chunk_too_large');
  });

  it('refuses a chunk whose declared length is not the expected size, before reading it', async () => {
    const begin = await h.relay.handle(
      signed(h, a1, 'POST', '/v1/uploads', {
        body: JSON.stringify({
          fencingToken: await leaseToken(h, a1),
          sequence: 1,
          byteSize: 100,
          chunkSize: 100,
          sha256: sha256Hex('x'),
        }),
      }),
    );
    const { uploadId } = (await begin.json()) as { uploadId: string };
    const tooBig = await h.relay.handle(
      signed(h, a1, 'PUT', `/v1/uploads/${uploadId}/chunks/0`, {
        body: randomBytes(100),
        headers: { 'content-length': '1000000000' },
      }),
    );
    expect(tooBig.status).toBe(413);
    const wrong = await h.relay.handle(
      signed(h, a1, 'PUT', `/v1/uploads/${uploadId}/chunks/0`, {
        body: randomBytes(99),
      }),
    );
    expect(wrong.status).toBe(400);
    expect(await errorCode(wrong)).toBe('unexpected_body_length');
    const outOfRange = await h.relay.handle(
      signed(h, a1, 'PUT', `/v1/uploads/${uploadId}/chunks/1`, {
        body: randomBytes(100),
      }),
    );
    expect(outOfRange.status).toBe(404);
  });

  it('requires a declared length for a request body', async () => {
    const request = signed(h, a1, 'POST', '/v1/uploads', {
      body: '{}',
    });
    const stream = new Request(request.url, {
      method: 'POST',
      headers: [...request.headers].filter(
        ([name]) => name !== 'content-length',
      ),
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{}'));
          controller.close();
        },
      }),
      duplex: 'half',
    } as RequestInit);
    const response = await h.relay.handle(stream);
    expect(response.status).toBe(411);
  });

  it('refuses a body on a bodiless route', async () => {
    const response = await h.relay.handle(
      signed(
        h,
        a1,
        'POST',
        '/v1/uploads/00000000-0000-4000-8000-000000000000/commit',
        { body: 'x' },
      ),
    );
    expect(response.status).toBe(413);
    expect(await errorCode(response)).toBe('body_too_large');
  });
});

describe('atomic publish and sequences', () => {
  async function beginUpload(
    device: TestDevice,
    sequence: number,
    blob: Uint8Array,
  ) {
    const response = await h.relay.handle(
      signed(h, device, 'POST', '/v1/uploads', {
        body: JSON.stringify({
          fencingToken: await leaseToken(h, device),
          sequence,
          byteSize: blob.length,
          chunkSize: 4096,
          sha256: sha256Hex(blob),
        }),
      }),
    );
    return {
      response,
      body: (await response.clone().json()) as { uploadId: string },
    };
  }

  it('never makes a partial upload latest', async () => {
    expect((await uploadSnapshot(h, a1, 1, randomBytes(100))).status).toBe(201);
    const blob = randomBytes(5000);
    const { body } = await beginUpload(a1, 2, blob);
    const first = await h.relay.handle(
      signed(h, a1, 'PUT', `/v1/uploads/${body.uploadId}/chunks/0`, {
        body: blob.subarray(0, 4096),
      }),
    );
    expect(first.status).toBe(200);
    const commit = await h.relay.handle(
      signed(h, a1, 'POST', `/v1/uploads/${body.uploadId}/commit`),
    );
    expect(commit.status).toBe(409);
    expect(await errorCode(commit)).toBe('incomplete_upload');
    const latest = await h.relay.handle(
      signed(h, a1, 'GET', '/v1/snapshots/latest'),
    );
    expect(((await latest.json()) as { sequence: number }).sequence).toBe(1);
    expect(
      (await h.relay.handle(signed(h, a1, 'GET', '/v1/snapshots/2'))).status,
    ).toBe(404);
    const list = (await (
      await h.relay.handle(signed(h, a1, 'GET', '/v1/snapshots'))
    ).json()) as { snapshots: Array<{ sequence: number }> };
    expect(list.snapshots.map((s) => s.sequence)).toEqual([1]);
  });

  it('refuses to publish a blob whose ciphertext digest differs from the declared one', async () => {
    const blob = randomBytes(100);
    const response = await h.relay.handle(
      signed(h, a1, 'POST', '/v1/uploads', {
        body: JSON.stringify({
          fencingToken: await leaseToken(h, a1),
          sequence: 1,
          byteSize: 100,
          chunkSize: 100,
          sha256: sha256Hex('not the blob'),
        }),
      }),
    );
    const { uploadId } = (await response.json()) as { uploadId: string };
    await h.relay.handle(
      signed(h, a1, 'PUT', `/v1/uploads/${uploadId}/chunks/0`, { body: blob }),
    );
    const commit = await h.relay.handle(
      signed(h, a1, 'POST', `/v1/uploads/${uploadId}/commit`),
    );
    expect(commit.status).toBe(422);
    expect(
      (await h.relay.handle(signed(h, a1, 'GET', '/v1/snapshots/latest')))
        .status,
    ).toBe(404);
  });

  it('refuses to overwrite or roll back a sequence', async () => {
    expect((await uploadSnapshot(h, a1, 4, randomBytes(10))).status).toBe(201);
    expect((await uploadSnapshot(h, a1, 5, randomBytes(10))).status).toBe(201);
    for (const sequence of [5, 3]) {
      const response = await uploadSnapshot(h, a1, sequence, randomBytes(10));
      expect(response.status).toBe(409);
      expect(await errorCode(response)).toBe('stale_sequence');
    }
    // The head is never deleted (#4805).
    const head = await h.relay.handle(
      signed(h, a1, 'DELETE', '/v1/snapshots/5'),
    );
    expect(head.status).toBe(409);
    expect(await errorCode(head)).toBe('head_snapshot');
    expect((await uploadSnapshot(h, a1, 6, randomBytes(10))).status).toBe(201);
    // Deleting an older snapshot does not lower the high-water mark.
    expect(
      (await h.relay.handle(signed(h, a1, 'DELETE', '/v1/snapshots/5'))).status,
    ).toBe(204);
    const again = await uploadSnapshot(h, a1, 5, randomBytes(10));
    expect(again.status).toBe(409);
    expect((await uploadSnapshot(h, a1, 7, randomBytes(10))).status).toBe(201);
  });

  it('refuses a duplicate pending sequence and a stale commit after a newer publish', async () => {
    const older = randomBytes(10);
    const { body: first } = await beginUpload(a1, 7, older);
    // a1's lease lapses (its upload has not); a2 takes over at the head.
    h.clock.now += 31_000;
    const { response: dup } = await beginUpload(a2, 7, randomBytes(10));
    expect(dup.status).toBe(409);
    expect(await errorCode(dup)).toBe('sequence_exists');

    expect((await uploadSnapshot(h, a2, 8, randomBytes(10))).status).toBe(201);
    await h.relay.handle(
      signed(h, a1, 'PUT', `/v1/uploads/${first.uploadId}/chunks/0`, {
        body: older,
      }),
    );
    const stale = await h.relay.handle(
      signed(h, a1, 'POST', `/v1/uploads/${first.uploadId}/commit`),
    );
    expect(stale.status).toBe(409);
    expect(await errorCode(stale)).toBe('must_restore_first');
    const latest = await h.relay.handle(
      signed(h, a1, 'GET', '/v1/snapshots/latest'),
    );
    expect(((await latest.json()) as { sequence: number }).sequence).toBe(8);
  });
});

describe('sequence step cap and high-water reset', () => {
  const MAX = Number.MAX_SAFE_INTEGER;

  async function begin(device: TestDevice, sequence: number) {
    return h.relay.handle(
      signed(h, device, 'POST', '/v1/uploads', {
        body: JSON.stringify({
          fencingToken: await leaseToken(h, device),
          sequence,
          byteSize: 10,
          chunkSize: 4096,
          sha256: sha256Hex('x'),
        }),
      }),
    );
  }

  it('refuses a sequence more than the step cap above the high-water mark', async () => {
    // New account: the mark is 0, so 1000 is the largest first sequence.
    const far = await begin(a1, 1001);
    expect(far.status).toBe(400);
    expect(await far.json()).toEqual({
      error: 'sequence_too_far',
      highWaterSequence: 0,
      maxSequenceJump: 1000,
    });
    for (const sequence of [MAX, MAX - 1, 2 ** 40]) {
      expect((await begin(a1, sequence)).status).toBe(400);
    }
    // The refusal reserved nothing and poisoned nothing.
    expect(await h.relay.operatorView('acct-a')).toMatchObject({
      usage: { highWaterSequence: 0, usedBytes: 0, usedSnapshots: 0 },
      snapshots: [],
    });

    expect((await uploadSnapshot(h, a1, 1000, randomBytes(10))).status).toBe(
      201,
    );
    expect((await begin(a1, 2001)).status).toBe(400);
    expect((await uploadSnapshot(h, a1, 2000, randomBytes(10))).status).toBe(
      201,
    );
    expect((await uploadSnapshot(h, a1, 2001, randomBytes(10))).status).toBe(
      201,
    );
    expect(await h.relay.operatorView('acct-a')).toMatchObject({
      usage: { highWaterSequence: 2001 },
    });
  });

  it('keeps the account usable after an attempt at the maximum sequence', async () => {
    expect((await begin(a1, MAX)).status).toBe(400);
    expect((await uploadSnapshot(h, a1, 1, randomBytes(10))).status).toBe(201);
    expect((await uploadSnapshot(h, a1, 2, randomBytes(10))).status).toBe(201);
  });

  it('applies the configured step cap', async () => {
    const local = await createHarness({
      policy: {
        ...DEFAULT_POLICY,
        limits: { ...DEFAULT_POLICY.limits, maxSequenceJump: 3 },
      },
    });
    try {
      const device = newDevice('acct-a', 'device-a1');
      await registerDevice(local, device);
      expect(local.relay.policy.limits.maxSequenceJump).toBe(3);
      expect(
        (await uploadSnapshot(local, device, 4, randomBytes(10))).status,
      ).toBe(400);
      expect(
        (await uploadSnapshot(local, device, 3, randomBytes(10))).status,
      ).toBe(201);
      expect(
        (await uploadSnapshot(local, device, 7, randomBytes(10))).status,
      ).toBe(400);
      expect(
        (await uploadSnapshot(local, device, 6, randomBytes(10))).status,
      ).toBe(201);
    } finally {
      await local.close();
    }
  });

  it('enforces the cap again at commit, in the same statement as the advance', async () => {
    const store = new VaultRelayStore(h.db);
    await store.ensureAccount('acct-a', h.clock.now);
    expect(await store.advanceHighWater('acct-a', 1001, 1000)).toBe(false);
    expect(await store.advanceHighWater('acct-a', MAX, 1000)).toBe(false);
    expect((await store.getUsage('acct-a'))?.highWaterSequence).toBe(0);
    expect(await store.advanceHighWater('acct-a', 1000, 1000)).toBe(true);
    expect(await store.advanceHighWater('acct-a', 999, 1000)).toBe(false);

    // A pending upload that was begun under a larger cap cannot slip past a
    // smaller one at commit: the pending row is dropped, nothing advances.
    const { relay } = h;
    const begun = await begin(a2, 1500);
    expect(begun.status).toBe(201);
    const { uploadId } = (await begun.json()) as { uploadId: string };
    const blob = new Uint8Array(10);
    await h.db.query(
      'UPDATE vault_relay_snapshots SET sha256 = ? WHERE upload_id = ?',
      sha256Hex(blob),
      uploadId,
    );
    await relay.handle(
      signed(h, a2, 'PUT', `/v1/uploads/${uploadId}/chunks/0`, { body: blob }),
    );
    // Simulate the cap having been lowered after begin.
    (relay.policy.limits as { maxSequenceJump: number }).maxSequenceJump = 100;
    const commit = await relay.handle(
      signed(h, a2, 'POST', `/v1/uploads/${uploadId}/commit`),
    );
    expect(commit.status).toBe(400);
    expect(await errorCode(commit)).toBe('sequence_too_far');
    expect((await store.getUsage('acct-a'))?.highWaterSequence).toBe(1000);
    expect((await relay.operatorView('acct-a')).snapshots).toEqual([]);
  });

  async function poison() {
    // A mark that is already out of reach, as left by a relay that predates
    // the cap: one committed snapshot at the largest safe integer.
    expect((await uploadSnapshot(h, a1, 1, randomBytes(10))).status).toBe(201);
    await h.db.query(
      'UPDATE vault_relay_snapshots SET sequence = ? WHERE account_id = ?',
      MAX,
      'acct-a',
    );
    await h.db.query(
      'UPDATE vault_relay_accounts SET high_water_sequence = ? WHERE account_id = ?',
      MAX,
      'acct-a',
    );
    const stuck = await uploadSnapshot(h, a1, 2, randomBytes(10));
    expect(stuck.status).toBe(409);
    expect(await errorCode(stuck)).toBe('stale_sequence');
  }

  it('recovers a poisoned account through the admin reset, audited', async () => {
    await poison();
    h.logger.lines.length = 0;

    // Nothing is deleted by accident: the snapshot above the new mark blocks.
    const refused = await h.relay.handleAdmin(
      adminRequest('POST', '/admin/v1/accounts/acct-a/high-water', {
        highWaterSequence: 0,
      }),
    );
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({
      error: 'snapshots_above_high_water',
      sequences: [MAX],
    });
    expect((await h.relay.operatorView('acct-a')).snapshots).toHaveLength(1);
    expect(h.logger.lines.some((l) => l.event === 'high_water_reset')).toBe(
      false,
    );

    const reset = await h.relay.handleAdmin(
      adminRequest('POST', '/admin/v1/accounts/acct-a/high-water', {
        highWaterSequence: 0,
        removeSnapshotsAbove: true,
      }),
    );
    expect(reset.status).toBe(200);
    expect(await reset.json()).toEqual({
      previous: MAX,
      highWaterSequence: 0,
      removed: [MAX],
    });
    const view = await h.relay.operatorView('acct-a');
    expect(view).toMatchObject({
      usage: { highWaterSequence: 0, usedBytes: 0, usedSnapshots: 0 },
      snapshots: [],
    });
    const files = await readdir(h.storeRoot, {
      recursive: true,
      withFileTypes: true,
    });
    expect(files.filter((entry) => entry.isFile())).toEqual([]);
    expect((await uploadSnapshot(h, a1, 1, randomBytes(10))).status).toBe(201);

    const audit = h.logger.lines.filter((l) => l.event === 'high_water_reset');
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      level: 'warn',
      fields: { previous: MAX, to: 0, removed: 1, removedSequences: `${MAX}` },
    });
    // The audit line carries the hashed handle, never the account id.
    expect(JSON.stringify(h.logger.lines)).not.toContain('acct-a');
  });

  it('resets to a mark that keeps the snapshots at or below it', async () => {
    for (const sequence of [5, 6, 7]) {
      expect(
        (await uploadSnapshot(h, a1, sequence, randomBytes(10))).status,
      ).toBe(201);
    }
    const reset = await h.relay.handleAdmin(
      adminRequest('POST', '/admin/v1/accounts/acct-a/high-water', {
        highWaterSequence: 6,
        removeSnapshotsAbove: true,
      }),
    );
    expect(await reset.json()).toEqual({
      previous: 7,
      highWaterSequence: 6,
      removed: [7],
    });
    const view = await h.relay.operatorView('acct-a');
    expect(view.snapshots.map((s) => s.sequence)).toEqual([6, 5]);
    expect(view.usage).toMatchObject({ highWaterSequence: 6 });
    expect((await uploadSnapshot(h, a1, 6, randomBytes(10))).status).toBe(409);
    expect((await uploadSnapshot(h, a1, 7, randomBytes(10))).status).toBe(201);
  });

  it('keeps the reset to the admin listener and validates it', async () => {
    expect((await uploadSnapshot(h, a1, 3, randomBytes(10))).status).toBe(201);
    const path = '/admin/v1/accounts/acct-a/high-water';
    // Not reachable by a device, not by a wrong token, not without a token.
    expect(
      (
        await h.relay.handle(
          signed(h, a1, 'POST', path, {
            body: JSON.stringify({ highWaterSequence: 0 }),
          }),
        )
      ).status,
    ).toBe(404);
    for (const token of ['', 'wrong-token-wrong-token-wrong-token-1234']) {
      expect(
        (
          await h.relay.handleAdmin(
            adminRequest('POST', path, { highWaterSequence: 0 }, token),
          )
        ).status,
      ).toBe(401);
    }
    for (const [body, status] of [
      [{}, 400],
      [{ highWaterSequence: -1 }, 400],
      [{ highWaterSequence: 1.5 }, 400],
      [{ highWaterSequence: '0' }, 400],
      [{ highWaterSequence: 1, removeSnapshotsAbove: 'yes' }, 400],
      // Raising is not a reset.
      [{ highWaterSequence: 4 }, 409],
    ] as const) {
      const response = await h.relay.handleAdmin(
        adminRequest('POST', path, body),
      );
      expect(response.status, JSON.stringify(body)).toBe(status);
    }
    expect(
      (
        await h.relay.handleAdmin(
          adminRequest('POST', '/admin/v1/accounts/unknown/high-water', {
            highWaterSequence: 0,
          }),
        )
      ).status,
    ).toBe(404);
    expect((await h.relay.handleAdmin(adminRequest('GET', path))).status).toBe(
      404,
    );
    expect((await h.relay.operatorView('acct-a')).usage).toMatchObject({
      highWaterSequence: 3,
    });
  });
});

describe('device deletes', () => {
  const del = (device: TestDevice, sequence: number) =>
    h.relay.handle(signed(h, device, 'DELETE', `/v1/snapshots/${sequence}`));

  it('refuses to delete the last committed snapshot and audits the attempt', async () => {
    const blob = randomBytes(150);
    expect((await uploadSnapshot(h, a1, 4, blob)).status).toBe(201);
    h.logger.lines.length = 0;

    const refused = await del(a2, 4);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({
      error: 'last_snapshot',
      sequence: 4,
    });
    // Still listed, downloadable, and counted.
    expect(Buffer.from(await downloadSnapshot(h, a1, 4))).toEqual(blob);
    expect((await h.relay.operatorView('acct-a')).usage).toMatchObject({
      usedBytes: 150,
      usedSnapshots: 1,
    });
    const audit = h.logger.lines.filter(
      (line) => line.event === 'snapshot_delete_refused',
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      level: 'warn',
      fields: {
        device: 'device-a2',
        sequence: 4,
        reason: 'last_committed',
      },
    });
    expect(JSON.stringify(h.logger.lines)).not.toContain('acct-a');
  });

  it('deletes an older snapshot, audits it, then protects the one that remains', async () => {
    for (const sequence of [1, 2]) {
      expect(
        (await uploadSnapshot(h, a1, sequence, randomBytes(20))).status,
      ).toBe(201);
    }
    h.logger.lines.length = 0;
    expect((await del(a1, 1)).status).toBe(204);
    expect(
      h.logger.lines.filter((line) => line.event === 'snapshot_deleted'),
    ).toEqual([
      expect.objectContaining({
        level: 'info',
        fields: expect.objectContaining({ device: 'device-a1', sequence: 1 }),
      }),
    ]);
    const last = await del(a1, 2);
    expect(last.status).toBe(409);
    expect(await errorCode(last)).toBe('last_snapshot');
    expect(
      (await h.relay.operatorView('acct-a')).snapshots.map((s) => s.sequence),
    ).toEqual([2]);
    // A missing snapshot is still a plain 404, with no refusal audit.
    h.logger.lines.length = 0;
    expect((await del(a1, 1)).status).toBe(404);
    expect(
      h.logger.lines.some((line) => line.event === 'snapshot_delete_refused'),
    ).toBe(false);
  });

  it('composes the last-snapshot rule with the head rule: distinct refusals, each audited', async () => {
    for (const sequence of [1, 2]) {
      await uploadSnapshot(h, a1, sequence, randomBytes(20));
    }
    h.logger.lines.length = 0;
    // The newest of several is the lease head: a different refusal from the
    // sole-snapshot one, and the older one stays deletable.
    const head = await del(a1, 2);
    expect(head.status).toBe(409);
    expect(await head.json()).toEqual({ error: 'head_snapshot', sequence: 2 });
    expect((await del(a1, 1)).status).toBe(204);
    // Now it is the only committed snapshot (and the head).
    const last = await del(a1, 2);
    expect(last.status).toBe(409);
    expect(await last.json()).toEqual({ error: 'last_snapshot', sequence: 2 });
    const latest = await h.relay.handle(
      signed(h, a1, 'GET', '/v1/snapshots/latest'),
    );
    expect(((await latest.json()) as { sequence: number }).sequence).toBe(2);
    expect(
      h.logger.lines
        .filter((line) => line.event === 'snapshot_delete_refused')
        .map((line) => ({ level: line.level, reason: line.fields?.reason })),
    ).toEqual([
      { level: 'warn', reason: 'head' },
      { level: 'warn', reason: 'last_committed' },
    ]);
    expect(
      h.logger.lines.filter((line) => line.event === 'snapshot_deleted'),
    ).toHaveLength(1);
  });

  it('judges each account separately and does not count pending uploads', async () => {
    await uploadSnapshot(h, a1, 1, randomBytes(20));
    await uploadSnapshot(h, b1, 1, randomBytes(20));
    // A pending upload of the same account is not a restorable snapshot.
    const begin = await h.relay.handle(
      signed(h, a1, 'POST', '/v1/uploads', {
        body: JSON.stringify({
          fencingToken: await leaseToken(h, a1),
          sequence: 2,
          byteSize: 10,
          chunkSize: 4096,
          sha256: sha256Hex('x'),
        }),
      }),
    );
    expect(begin.status).toBe(201);
    expect((await del(a1, 1)).status).toBe(409);
    expect((await del(b1, 1)).status).toBe(409);
    // Another account's snapshots never count as "another" one.
    const store = new VaultRelayStore(h.db);
    const first = await store.latestCommitted('acct-a');
    expect(
      await store.deleteCommittedUnlessLast(
        'acct-a',
        first?.uploadId as string,
      ),
    ).toBeNull();
    expect(await store.latestCommitted('acct-a')).not.toBeNull();
  });

  it('leaves operator recovery and retention able to remove snapshots', async () => {
    for (const sequence of [1, 2, 3, 4, 5]) {
      h.clock.now += 1000;
      await uploadSnapshot(h, a1, sequence, randomBytes(20));
    }
    // Retention keeps three and never touches the last committed snapshot.
    expect(
      (await h.relay.operatorView('acct-a')).snapshots.map((s) => s.sequence),
    ).toEqual([5, 4, 3]);
    const reset = await h.relay.handleAdmin(
      adminRequest('POST', '/admin/v1/accounts/acct-a/high-water', {
        highWaterSequence: 2,
        removeSnapshotsAbove: true,
      }),
    );
    expect(reset.status).toBe(200);
    expect((await h.relay.operatorView('acct-a')).snapshots).toEqual([]);
  });
});

describe('retention and expiry', () => {
  it('keeps the newest snapshots and frees quota for pruned ones', async () => {
    for (let sequence = 1; sequence <= 5; sequence++) {
      h.clock.now += 1000;
      expect(
        (await uploadSnapshot(h, a1, sequence, randomBytes(100))).status,
      ).toBe(201);
    }
    const list = (await (
      await h.relay.handle(signed(h, a1, 'GET', '/v1/snapshots'))
    ).json()) as { snapshots: Array<{ sequence: number }> };
    expect(list.snapshots.map((s) => s.sequence)).toEqual([5, 4, 3]);
    const view = await h.relay.operatorView('acct-a');
    expect(view.usage).toMatchObject({ usedBytes: 300, usedSnapshots: 3 });
  });

  it('keeps snapshots inside the age window beyond keepLast', async () => {
    const local = await createHarness({
      policy: {
        quota: { maxBytes: 1_000_000, maxSnapshots: 10 },
        retention: { keepLast: 1, keepWithinMs: 10_000 },
        limits: { maxChunkBytes: 4096 },
      },
    });
    try {
      const device = newDevice('acct-a', 'device-a1');
      await registerDevice(local, device);
      await uploadSnapshot(local, device, 1, randomBytes(10));
      local.clock.now += 20_000;
      await uploadSnapshot(local, device, 2, randomBytes(10));
      local.clock.now += 1_000;
      await uploadSnapshot(local, device, 3, randomBytes(10));
      const view = await local.relay.operatorView('acct-a');
      expect(view.snapshots.map((s) => s.sequence)).toEqual([3, 2]);
    } finally {
      await local.close();
    }
  });

  it('expires abandoned uploads and releases their reservation', async () => {
    await h.relay.handle(
      signed(h, a1, 'POST', '/v1/uploads', {
        body: JSON.stringify({
          fencingToken: await leaseToken(h, a1),
          sequence: 1,
          byteSize: 900_000,
          chunkSize: 4096,
          sha256: sha256Hex('x'),
        }),
      }),
    );
    h.clock.now += 60_001;
    expect(await h.relay.sweepExpired()).toBe(1);
    const view = await h.relay.operatorView('acct-a');
    expect(view.usage).toMatchObject({ usedBytes: 0, usedSnapshots: 0 });
    expect((await uploadSnapshot(h, a1, 2, randomBytes(10))).status).toBe(201);
  });

  it('removes chunk objects when a snapshot is deleted', async () => {
    await uploadSnapshot(h, a1, 1, randomBytes(9000));
    // A second snapshot keeps the first deletable (the last one is not).
    await uploadSnapshot(h, a1, 2, randomBytes(100));
    expect(
      (await h.relay.handle(signed(h, a1, 'DELETE', '/v1/snapshots/1'))).status,
    ).toBe(204);
    const files = await readdir(h.storeRoot, {
      recursive: true,
      withFileTypes: true,
    });
    // Only the single chunk of the 100-byte snapshot is left.
    expect(files.filter((entry) => entry.isFile())).toHaveLength(1);
    expect((await h.relay.operatorView('acct-a')).usage).toMatchObject({
      usedBytes: 100,
      usedSnapshots: 1,
    });
  });
});

describe('admin surface', () => {
  it('requires the operator token', async () => {
    for (const token of ['', 'wrong-token-wrong-token-wrong-token-1234']) {
      const response = await h.relay.handleAdmin(
        adminRequest('GET', '/admin/v1/accounts/acct-a', undefined, token),
      );
      expect(response.status).toBe(401);
    }
    // Device routes never answer admin paths.
    const response = await h.relay.handle(
      adminRequest('GET', '/admin/v1/accounts/acct-a'),
    );
    expect(response.status).toBe(404);
  });

  it('registers and revokes devices for the account layer', async () => {
    const device = newDevice('acct-c', 'device-c1');
    const put = await h.relay.handleAdmin(
      adminRequest('PUT', '/admin/v1/accounts/acct-c/devices/device-c1', {
        publicKey: device.publicKey,
      }),
    );
    expect(put.status).toBe(201);
    const again = await h.relay.handleAdmin(
      adminRequest('PUT', '/admin/v1/accounts/acct-c/devices/device-c1', {
        publicKey: device.publicKey,
      }),
    );
    expect(again.status).toBe(200);
    const other = newDevice('acct-c', 'device-c1');
    const conflict = await h.relay.handleAdmin(
      adminRequest('PUT', '/admin/v1/accounts/acct-c/devices/device-c1', {
        publicKey: other.publicKey,
      }),
    );
    expect(conflict.status).toBe(409);
    const revoke = await h.relay.handleAdmin(
      adminRequest('DELETE', '/admin/v1/accounts/acct-c/devices/device-c1'),
    );
    expect(revoke.status).toBe(204);
  });

  it('reconciles usage counters from snapshot rows', async () => {
    await uploadSnapshot(h, a1, 1, randomBytes(100));
    await h.db.query(
      "UPDATE vault_relay_accounts SET used_bytes = 999999 WHERE account_id = 'acct-a'",
    );
    const response = await h.relay.handleAdmin(
      adminRequest('POST', '/admin/v1/accounts/acct-a/reconcile'),
    );
    expect(await response.json()).toMatchObject({
      usage: { usedBytes: 100, usedSnapshots: 1 },
    });
  });
});

describe('concurrent writes', () => {
  async function begin(
    harness: Harness,
    device: TestDevice,
    sequence: number,
    blob: Uint8Array,
  ): Promise<string> {
    const response = await harness.relay.handle(
      signed(harness, device, 'POST', '/v1/uploads', {
        body: JSON.stringify({
          fencingToken: await leaseToken(harness, device),
          sequence,
          byteSize: blob.length,
          chunkSize: 4096,
          sha256: sha256Hex(blob),
        }),
      }),
    );
    expect(response.status).toBe(201);
    return ((await response.json()) as { uploadId: string }).uploadId;
  }

  it('discards a chunk that lands after its upload was aborted', async () => {
    let onPut: (() => Promise<void>) | null = null;
    const local = await createHarness({
      wrapObjects: (store) => ({
        ...store,
        get: (key) => store.get(key),
        delete: (key) => store.delete(key),
        check: () => store.check(),
        async put(key, data) {
          await store.put(key, data);
          const hook = onPut;
          onPut = null;
          await hook?.();
        },
      }),
    });
    try {
      const device = newDevice('acct-a', 'device-a1');
      await registerDevice(local, device);
      const blob = randomBytes(100);
      const uploadId = await begin(local, device, 1, blob);
      onPut = async () => {
        const abort = await local.relay.handle(
          signed(local, device, 'DELETE', `/v1/uploads/${uploadId}`),
        );
        expect(abort.status).toBe(204);
      };
      const put = await local.relay.handle(
        signed(local, device, 'PUT', `/v1/uploads/${uploadId}/chunks/0`, {
          body: blob,
        }),
      );
      expect(put.status).toBe(404);
      const files = await readdir(local.storeRoot, {
        recursive: true,
        withFileTypes: true,
      });
      expect(files.filter((entry) => entry.isFile())).toEqual([]);
      const rows = await local.db.query('SELECT * FROM vault_relay_chunks');
      expect(rows.rows).toEqual([]);
      const view = await local.relay.operatorView('acct-a');
      expect(view.usage).toMatchObject({ usedBytes: 0, usedSnapshots: 0 });
    } finally {
      await local.close();
    }
  });

  it('cleans up a chunk recorded while a concurrent removal missed it', async () => {
    // Simulates PostgreSQL READ COMMITTED: the remover deletes the upload and
    // lists chunk rows before this insert commits, so it never sees the row.
    class RacingStore extends VaultRelayStore {
      override async addChunk(
        ...args: Parameters<VaultRelayStore['addChunk']>
      ): Promise<boolean> {
        const added = await super.addChunk(...args);
        const [accountId, uploadId] = args;
        await this.deleteSnapshotRow(accountId, uploadId, 'pending');
        return added;
      }
    }
    const local = await createHarness({
      createStore: (db) => new RacingStore(db),
    });
    try {
      const device = newDevice('acct-a', 'device-a1');
      await registerDevice(local, device);
      const blob = randomBytes(100);
      const uploadId = await begin(local, device, 1, blob);
      const put = await local.relay.handle(
        signed(local, device, 'PUT', `/v1/uploads/${uploadId}/chunks/0`, {
          body: blob,
        }),
      );
      expect(put.status).toBe(404);
      const files = await readdir(local.storeRoot, {
        recursive: true,
        withFileTypes: true,
      });
      expect(files.filter((entry) => entry.isFile())).toEqual([]);
      const rows = await local.db.query('SELECT * FROM vault_relay_chunks');
      expect(rows.rows).toEqual([]);
    } finally {
      await local.close();
    }
  });

  it('never replaces a chunk once stored; an identical retry is idempotent', async () => {
    const blob = randomBytes(100);
    const uploadId = await begin(h, a1, 1, blob);
    const put = (body: Uint8Array) =>
      h.relay.handle(
        signed(h, a1, 'PUT', `/v1/uploads/${uploadId}/chunks/0`, { body }),
      );
    expect((await put(blob)).status).toBe(200);
    expect((await put(blob)).status).toBe(200);
    const other = await put(randomBytes(100));
    expect(other.status).toBe(409);
    expect(await errorCode(other)).toBe('chunk_exists');
    expect(
      (
        await h.relay.handle(
          signed(h, a1, 'POST', `/v1/uploads/${uploadId}/commit`),
        )
      ).status,
    ).toBe(201);
    // After publish the upload is gone: no write reaches the snapshot.
    const late = await put(randomBytes(100));
    expect(late.status).toBe(404);
    expect(Buffer.from(await downloadSnapshot(h, a1, 1))).toEqual(blob);
    const files = await readdir(h.storeRoot, {
      recursive: true,
      withFileTypes: true,
    });
    expect(files.filter((entry) => entry.isFile())).toHaveLength(1);
  });

  it('cannot delete a snapshot that was published while its removal was pending', async () => {
    const blob = randomBytes(10);
    const uploadId = await begin(h, a1, 1, blob);
    await h.relay.handle(
      signed(h, a1, 'PUT', `/v1/uploads/${uploadId}/chunks/0`, { body: blob }),
    );
    const store = new VaultRelayStore(h.db);
    const [stale] = await store.stalePending(h.clock.now + 1, 10);
    expect(stale.uploadId).toBe(uploadId);
    // The commit wins the race against an expiry sweep that already listed it.
    await h.relay.handle(
      signed(h, a1, 'POST', `/v1/uploads/${uploadId}/commit`),
    );
    expect(
      await store.deleteSnapshotRow('acct-a', uploadId, 'pending'),
    ).toBeNull();
    expect(
      (await h.relay.handle(signed(h, a1, 'GET', '/v1/snapshots/1'))).status,
    ).toBe(200);
  });

  it('refuses to re-create a published and deleted sequence at the store', async () => {
    expect((await uploadSnapshot(h, a1, 2, randomBytes(10))).status).toBe(201);
    expect((await uploadSnapshot(h, a1, 3, randomBytes(10))).status).toBe(201);
    expect((await uploadSnapshot(h, a1, 4, randomBytes(10))).status).toBe(201);
    await h.relay.handle(signed(h, a1, 'DELETE', '/v1/snapshots/3'));
    const store = new VaultRelayStore(h.db);
    const created = await store.createPending({
      accountId: 'acct-a',
      sequence: 3,
      uploadId: '00000000-0000-4000-8000-000000000003',
      deviceId: 'device-a1',
      byteSize: 10,
      chunkSize: 10,
      chunkCount: 1,
      sha256: sha256Hex('x'),
      createdAt: h.clock.now,
    });
    expect(created).toBe(false);
    const view = await h.relay.operatorView('acct-a');
    expect(view.usage).toMatchObject({ usedBytes: 20, usedSnapshots: 2 });
  });
});
