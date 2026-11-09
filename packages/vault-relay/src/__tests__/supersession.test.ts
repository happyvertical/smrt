/**
 * Account supersession (#4817): the account layer replaces a vault account
 * after a restart. Threats: a stale device keeps publishing into the old data
 * line, restore-latest is handed the old vault, a stolen device silences or
 * redirects an account, and a hostile target loops accounts back on each other.
 */
import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
let b1: TestDevice;

beforeEach(async () => {
  h = await createHarness();
  a1 = newDevice('acct-a', 'device-a1');
  b1 = newDevice('acct-b', 'device-b1');
  await registerDevice(h, a1);
  await registerDevice(h, b1);
});

afterEach(async () => {
  await h.close();
});

async function supersede(account = 'acct-a', by = 'acct-b') {
  return h.relay.handleAdmin(
    adminRequest('PUT', `/admin/v1/accounts/${account}/superseded-by`, {
      supersededBy: by,
    }),
  );
}

async function errorCode(response: Response): Promise<string> {
  return ((await response.json()) as { error: string }).error;
}

describe('supersession is set by the account layer only', () => {
  it('records, repeats and clears a supersession', async () => {
    expect((await supersede()).status).toBe(201);
    expect((await supersede()).status).toBe(200);
    expect((await h.relay.operatorView('acct-a')).supersededBy).toBe('acct-b');
    expect((await h.relay.operatorView('acct-b')).supersededBy).toBeNull();
    const cleared = await h.relay.handleAdmin(
      adminRequest('DELETE', '/admin/v1/accounts/acct-a/superseded-by'),
    );
    expect(cleared.status).toBe(204);
    expect((await h.relay.operatorView('acct-a')).supersededBy).toBeNull();
    const again = await h.relay.handleAdmin(
      adminRequest('DELETE', '/admin/v1/accounts/acct-a/superseded-by'),
    );
    expect(again.status).toBe(404);
  });

  it('threat: no device route can set, clear or read it', async () => {
    for (const method of ['PUT', 'DELETE', 'GET']) {
      const response = await h.relay.handle(
        signed(h, a1, method, '/v1/accounts/acct-a/superseded-by', {
          body: method === 'PUT' ? '{"supersededBy":"acct-b"}' : undefined,
        }),
      );
      expect(response.status).toBe(404);
    }
    // A device signature is not the operator token on the admin path either.
    const admin = await h.relay.handleAdmin(
      signed(h, a1, 'PUT', '/admin/v1/accounts/acct-a/superseded-by', {
        body: '{"supersededBy":"acct-b"}',
      }),
    );
    expect(admin.status).toBe(401);
    const unauthenticated = await h.relay.handleAdmin(
      adminRequest(
        'PUT',
        '/admin/v1/accounts/acct-a/superseded-by',
        { supersededBy: 'acct-b' },
        'wrong-token-wrong-token-wrong-token-1234',
      ),
    );
    expect(unauthenticated.status).toBe(401);
    expect((await h.relay.operatorView('acct-a')).supersededBy).toBeNull();
  });

  it('threat: a target that is not ready, is itself replaced, or loops is refused', async () => {
    // Unknown source, same account, malformed target, target with no device.
    expect((await supersede('acct-nobody', 'acct-b')).status).toBe(404);
    expect((await supersede('acct-a', 'acct-a')).status).toBe(400);
    expect((await supersede('acct-a', 'not valid!')).status).toBe(400);
    const empty = await supersede('acct-a', 'acct-empty');
    expect(empty.status).toBe(409);
    expect(await errorCode(empty)).toBe('target_not_ready');
    // A revoked-only target is not ready either.
    const c1 = newDevice('acct-c', 'device-c1');
    await registerDevice(h, c1);
    await h.relay.revokeDevice('acct-c', 'device-c1');
    expect(await errorCode(await supersede('acct-a', 'acct-c'))).toBe(
      'target_not_ready',
    );
    // No chains and no loops.
    expect((await supersede('acct-a', 'acct-b')).status).toBe(201);
    // A loop back is refused: acct-b is a replacement itself.
    expect(await errorCode(await supersede('acct-b', 'acct-a'))).toBe(
      'account_is_target',
    );
    const d1 = newDevice('acct-d', 'device-d1');
    await registerDevice(h, d1);
    // One account is replaced by at most one other.
    expect(await errorCode(await supersede('acct-a', 'acct-d'))).toBe(
      'already_superseded',
    );
    expect((await h.relay.operatorView('acct-a')).supersededBy).toBe('acct-b');
    // An account that is someone's replacement cannot itself be replaced.
    const e1 = newDevice('acct-e', 'device-e1');
    await registerDevice(h, e1);
    expect(await errorCode(await supersede('acct-b', 'acct-e'))).toBe(
      'account_is_target',
    );
    // Nor can a replaced account be someone's replacement.
    expect(await errorCode(await supersede('acct-e', 'acct-a'))).toBe(
      'target_superseded',
    );
  });
});

describe('a superseded account takes no writes and offers no restore', () => {
  async function publishedThenSuperseded() {
    const blob = randomBytes(300);
    expect((await uploadSnapshot(h, a1, 1, blob)).status).toBe(201);
    expect((await supersede()).status).toBe(201);
    return blob;
  }

  it('threat: a stale device cannot lease, begin, upload or commit into the old line', async () => {
    // A pending upload exists when the account is replaced.
    const blob = randomBytes(300);
    const status = await leaseStatus(h, a1);
    expect(status.headSequence).toBe(0);
    const acquired = await h.relay.handle(acquireRequest(h, a1, 0));
    const { fencingToken } = (await acquired.json()) as {
      fencingToken: number;
    };
    expect((await supersede()).status).toBe(201);
    const begin = await h.relay.handle(
      signed(h, a1, 'POST', '/v1/uploads', {
        body: JSON.stringify({
          fencingToken,
          sequence: 1,
          byteSize: blob.length,
          chunkSize: 4096,
          sha256: 'a'.repeat(64),
        }),
      }),
    );
    expect(begin.status).toBe(409);
    expect(await errorCode(begin)).toBe('account_superseded');
    for (const [method, path, body] of [
      ['POST', '/v1/lease/acquire', JSON.stringify({ baseSequence: 0 })],
      ['POST', '/v1/lease/renew', JSON.stringify({ fencingToken })],
      ['PUT', '/v1/uploads/00000000-0000-4000-8000-000000000000/chunks/0', 'x'],
      ['POST', '/v1/uploads/00000000-0000-4000-8000-000000000000/commit', ''],
    ] as const) {
      const response = await h.relay.handle(
        signed(h, a1, method, path, { body: body || undefined }),
      );
      expect(response.status).toBe(409);
      expect(await errorCode(response)).toBe('account_superseded');
    }
    expect((await h.relay.operatorView('acct-a')).snapshots).toEqual([]);
  });

  it('threat: restore-latest is not offered the old vault, but the new one is', async () => {
    await publishedThenSuperseded();
    for (const path of ['/v1/snapshots', '/v1/snapshots/latest']) {
      const response = await h.relay.handle(signed(h, a1, 'GET', path));
      expect(response.status).toBe(409);
      expect(await errorCode(response)).toBe('account_superseded');
    }
    // The new account serves its own latest as usual.
    expect((await uploadSnapshot(h, b1, 1, randomBytes(200))).status).toBe(201);
    const latest = await h.relay.handle(
      signed(h, b1, 'GET', '/v1/snapshots/latest'),
    );
    expect(latest.status).toBe(200);
    expect(((await latest.json()) as { sequence: number }).sequence).toBe(1);
  });

  it('keeps reads by explicit sequence, state removal and lease status open', async () => {
    await publishedThenSuperseded();
    const meta = await h.relay.handle(signed(h, a1, 'GET', '/v1/snapshots/1'));
    expect(meta.status).toBe(200);
    const chunk = await h.relay.handle(
      signed(h, a1, 'GET', '/v1/snapshots/1/chunks/0'),
    );
    expect(chunk.status).toBe(200);
    expect(
      (await h.relay.handle(signed(h, a1, 'GET', '/v1/lease'))).status,
    ).toBe(200);
    const release = await h.relay.handle(
      signed(h, a1, 'POST', '/v1/lease/release', {
        body: JSON.stringify({ fencingToken: 1 }),
      }),
    );
    expect(release.status).toBe(204);
    // Deleting is a write: refused.
    const del = await h.relay.handle(
      signed(h, a1, 'DELETE', '/v1/snapshots/1'),
    );
    expect(del.status).toBe(409);
    expect(await errorCode(del)).toBe('account_superseded');
  });

  it('lets an upload begun earlier be aborted, so its quota is released', async () => {
    const blob = randomBytes(300);
    const token = (await (
      await h.relay.handle(acquireRequest(h, a1, 0))
    ).json()) as { fencingToken: number };
    const begin = await h.relay.handle(
      signed(h, a1, 'POST', '/v1/uploads', {
        body: JSON.stringify({
          fencingToken: token.fencingToken,
          sequence: 1,
          byteSize: blob.length,
          chunkSize: 4096,
          sha256: 'b'.repeat(64),
        }),
      }),
    );
    expect(begin.status).toBe(201);
    const { uploadId } = (await begin.json()) as { uploadId: string };
    expect((await supersede()).status).toBe(201);
    const abort = await h.relay.handle(
      signed(h, a1, 'DELETE', `/v1/uploads/${uploadId}`),
    );
    expect(abort.status).toBe(204);
    expect((await h.relay.operatorView('acct-a')).usage?.usedSnapshots).toBe(0);
  });

  it('threat: the refusal names no other account, and clearing it restores service', async () => {
    await publishedThenSuperseded();
    const refused = await h.relay.handle(
      signed(h, a1, 'GET', '/v1/snapshots/latest'),
    );
    expect(await refused.text()).not.toContain('acct-b');
    await h.relay.handleAdmin(
      adminRequest('DELETE', '/admin/v1/accounts/acct-a/superseded-by'),
    );
    const restored = await h.relay.handle(
      signed(h, a1, 'GET', '/v1/snapshots/latest'),
    );
    expect(restored.status).toBe(200);
  });

  it('does not touch the new account, nor other accounts', async () => {
    await publishedThenSuperseded();
    const other = newDevice('acct-b', 'device-b2');
    await registerDevice(h, other);
    expect((await uploadSnapshot(h, b1, 1, randomBytes(100))).status).toBe(201);
    expect(
      (await h.relay.handle(signed(h, other, 'GET', '/v1/snapshots'))).status,
    ).toBe(200);
  });
});
