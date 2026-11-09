/**
 * Client lease keeper (#4805): acquire from the local base, renew ahead of
 * the monotonic deadline, and degrade to read-only on loss or divergence.
 */

import {
  chmodSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  VaultLeaseClient,
  VaultLeaseError,
  VaultLeaseKeeper,
  type VaultLeaseState,
  type VaultRelayResponse,
} from './vault-lease.js';
import {
  readVaultSyncRecord,
  VAULT_SYNC_FILE,
  writeVaultSyncRecord,
} from './vault-sync-state.js';

let stateRoot: string;
let clock: number;
let pending: Array<{ callback: () => void; at: number }>;
let calls: Array<{ path: string; body?: Record<string, unknown> }>;
let replies: Array<VaultRelayResponse | Error>;

const timers = {
  set(callback: () => void, delayMs: number) {
    const entry = { callback, at: clock + delayMs };
    pending.push(entry);
    return entry;
  },
  clear(handle: unknown) {
    pending = pending.filter((entry) => entry !== handle);
  },
};

const client = new VaultLeaseClient({
  async send(_method, path, body) {
    calls.push({ path, body });
    const reply = replies.shift();
    if (!reply) throw new Error(`unexpected call ${path}`);
    if (reply instanceof Error) throw reply;
    return reply;
  },
});

function granted(fencingToken: number, headSequence = 0): VaultRelayResponse {
  return { status: 200, body: { fencingToken, ttlMs: 30_000, headSequence } };
}

function keeper(states: VaultLeaseState[] = []) {
  return new VaultLeaseKeeper({
    client,
    stateRoot,
    accountId: 'acct-a',
    monotonicNow: () => clock,
    timers,
    onChange: (state) => states.push(state),
  });
}

async function runTimers(): Promise<void> {
  const due = pending.filter((entry) => entry.at <= clock);
  pending = pending.filter((entry) => entry.at > clock);
  for (const entry of due) entry.callback();
  await new Promise((resolve) => setImmediate(resolve));
}

beforeEach(() => {
  stateRoot = mkdtempSync(join(realpathSync(tmpdir()), 'smrt-vault-lease-'));
  clock = 1_000;
  pending = [];
  calls = [];
  replies = [];
});

afterEach(() => {
  rmSync(stateRoot, { recursive: true, force: true });
});

describe('VaultLeaseKeeper', () => {
  it('acquires from the local base and marks local writes pending', async () => {
    writeVaultSyncRecord(stateRoot, {
      accountId: 'acct-a',
      baseSequence: 4,
      highestSeenSequence: 4,
      localWritesPending: false,
    });
    replies.push(granted(7, 4));
    const lease = keeper();
    expect(await lease.start()).toBe('held');
    expect(calls[0]).toEqual({
      path: '/v1/lease/acquire',
      body: { baseSequence: 4 },
    });
    expect(lease.fencingToken).toBe(7);
    expect(() => lease.assertWritable()).not.toThrow();
    expect(readVaultSyncRecord(stateRoot)?.localWritesPending).toBe(true);
  });

  it('stops, without retrying, when the relay says the account was replaced (#4817)', async () => {
    replies.push({ status: 409, body: { error: 'account_superseded' } });
    const states: VaultLeaseState[] = [];
    const lease = keeper(states);
    expect(await lease.start()).toBe('superseded');
    expect(states).toEqual(['superseded']);
    expect(() => lease.assertWritable()).toThrow();
    // Nothing is scheduled: a replaced account is not retried.
    expect(pending).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it('does not raise the downgrade floor to a granted head that is a hole', async () => {
    writeVaultSyncRecord(stateRoot, {
      accountId: 'acct-a',
      baseSequence: 4,
      highestSeenSequence: 4,
      localWritesPending: false,
    });
    // The relay head moved to 9 for an upload that never committed; this
    // device (at the latest committed sequence 4) is allowed to acquire past
    // it. A hostile relay can also just claim a huge head.
    replies.push(granted(7, 9));
    expect(await keeper().start()).toBe('held');
    expect(readVaultSyncRecord(stateRoot)).toMatchObject({
      baseSequence: 4,
      highestSeenSequence: 4,
      localWritesPending: true,
    });
    replies.push(granted(8, 2 ** 40));
    await keeper().start();
    expect(readVaultSyncRecord(stateRoot)?.highestSeenSequence).toBe(4);
  });

  it('renews ahead of expiry and stays writable', async () => {
    replies.push(granted(1), granted(1));
    const lease = keeper();
    await lease.start();
    clock += 10_000;
    await runTimers();
    expect(calls.map((call) => call.path)).toEqual([
      '/v1/lease/acquire',
      '/v1/lease/renew',
    ]);
    clock += 20_000;
    expect(lease.writable()).toBe(true);
  });

  it('degrades to read-only at the monotonic deadline without a renewal', async () => {
    const states: VaultLeaseState[] = [];
    replies.push(granted(1));
    const lease = keeper(states);
    await lease.start();
    clock += 25_000; // 30 s lease minus the 5 s safety margin.
    expect(lease.writable()).toBe(false);
    expect(states).toEqual(['held', 'lost']);
    expect(lease.fencingToken).toBeNull();
    let error: unknown;
    try {
      lease.assertWritable();
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(VaultLeaseError);
    expect((error as VaultLeaseError).code).toBe('vault_lease_lost');
  });

  it('keeps the lease through a transient relay failure, then loses it at the deadline', async () => {
    replies.push(granted(1), new VaultLeaseError('relay_error'));
    const lease = keeper();
    await lease.start();
    clock += 10_000;
    await runTimers();
    expect(lease.state).toBe('held');
    clock += 16_000;
    expect(lease.state).toBe('lost');
  });

  it('goes read-only when the relay reports the lease lost', async () => {
    replies.push(granted(1), {
      status: 409,
      body: { error: 'lease_lost' },
    });
    const lease = keeper();
    await lease.start();
    expect(await lease.renew()).toBe('lost');
  });

  it('reports must-restore when the account moved on', async () => {
    replies.push({
      status: 409,
      body: { error: 'must_restore_first', headSequence: 9, latestSequence: 9 },
    });
    const states: VaultLeaseState[] = [];
    const lease = keeper(states);
    expect(await lease.start()).toBe('must-restore');
    expect(lease.writable()).toBe(false);
    expect(states).toEqual(['must-restore']);
    expect(readVaultSyncRecord(stateRoot)).toBeNull();
  });

  it('reports another holder distinctly', async () => {
    replies.push({
      status: 409,
      body: { error: 'lease_held', holder: 'device-b', expiresAt: 'x' },
    });
    expect(await keeper().start()).toBe('held-elsewhere');
  });

  it('treats a malformed grant as unavailable', async () => {
    replies.push({ status: 200, body: { fencingToken: 'one' } });
    expect(await keeper().start()).toBe('unavailable');
  });

  it('records a publish and clears pending writes', async () => {
    replies.push(granted(1));
    const lease = keeper();
    await lease.start();
    lease.recordPublished(1);
    expect(readVaultSyncRecord(stateRoot)).toMatchObject({
      baseSequence: 1,
      highestSeenSequence: 1,
      localWritesPending: false,
    });
    expect(() => lease.recordPublished(1)).toThrow('advance');
  });

  it('releases the granted lease when the position cannot be recorded', async () => {
    replies.push(granted(5), { status: 204, body: null });
    chmodSync(stateRoot, 0o500);
    try {
      await expect(keeper().start()).rejects.toThrow();
    } finally {
      chmodSync(stateRoot, 0o700);
    }
    expect(calls.at(-1)).toEqual({
      path: '/v1/lease/release',
      body: { fencingToken: 5 },
    });
  });

  it('releases on stop', async () => {
    replies.push(granted(3), { status: 204, body: null });
    const lease = keeper();
    await lease.start();
    await lease.stop();
    expect(calls.at(-1)).toEqual({
      path: '/v1/lease/release',
      body: { fencingToken: 3 },
    });
    expect(lease.state).toBe('stopped');
  });
});

describe('vault sync record', () => {
  it('refuses a record of another account', async () => {
    writeVaultSyncRecord(stateRoot, {
      accountId: 'acct-b',
      baseSequence: 0,
      highestSeenSequence: 0,
      localWritesPending: false,
    });
    await expect(keeper().start()).rejects.toThrow('different vault account');
  });

  it('refuses a damaged or non-private record', () => {
    writeFileSync(join(stateRoot, VAULT_SYNC_FILE), '{"schemaVersion":1}', {
      mode: 0o600,
    });
    expect(() => readVaultSyncRecord(stateRoot)).toThrow('cannot be verified');
    rmSync(join(stateRoot, VAULT_SYNC_FILE));
    writeFileSync(
      join(stateRoot, VAULT_SYNC_FILE),
      JSON.stringify({
        schemaVersion: 1,
        accountId: 'acct-a',
        baseSequence: 0,
        highestSeenSequence: 0,
        localWritesPending: false,
      }),
      { mode: 0o644 },
    );
    expect(() => readVaultSyncRecord(stateRoot)).toThrow('cannot be verified');
  });
});
