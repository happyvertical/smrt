/**
 * Switching a location to a restarted vault account (#4817). Threats: a
 * rollback by resetting the downgrade floor, following an account the key
 * lifecycle never restarted into, adopting a non-empty account, and reviving
 * a retired location.
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
import { createVaultKeyLifecycle } from './vault-key-lifecycle.js';
import type { VaultKeyStore } from './vault-key-store.js';
import {
  switchVaultAccount,
  VaultAccountSwitchError,
} from './vault-restart.js';
import {
  readVaultSyncRecord,
  vaultSyncFor,
  writeVaultSyncRecord,
} from './vault-sync-state.js';

const OLD = 'vault-account-a';
const NEW = 'vault-account-b';

let stateRoot: string;

beforeEach(() => {
  stateRoot = realpathSync(
    mkdtempSync(join(realpathSync(tmpdir()), 'smrt-vault-restart-')),
  );
  chmodSync(stateRoot, 0o700);
});

afterEach(() => {
  rmSync(stateRoot, { recursive: true, force: true });
});

function memoryStore(): VaultKeyStore {
  const items = new Map<string, Uint8Array>();
  return {
    async get(name) {
      const value = items.get(name);
      return value ? new Uint8Array(value) : null;
    },
    async set(name, value) {
      items.set(name, new Uint8Array(value));
    },
    async delete(name) {
      items.delete(name);
    },
  };
}

const fresh = { status: async () => relay(0, 0) };

function relay(headSequence: number, latestCommittedSequence: number) {
  return {
    holder: null,
    headSequence,
    latestCommittedSequence,
    headIsHole: false,
  };
}

async function restarted() {
  const lifecycle = createVaultKeyLifecycle({ store: memoryStore() });
  await lifecycle.initializeAccount({
    accountId: OLD,
    deviceId: 'laptop',
    recoverySecret: 'synthetic recovery credential',
  });
  await lifecycle.restartAccount({
    accountId: NEW,
    deviceId: 'laptop-b',
    recoverySecret: 'a replacement credential',
    confirmRestart: true,
  });
  return lifecycle;
}

function follow(account: string, baseSequence = 5) {
  writeVaultSyncRecord(stateRoot, {
    accountId: account,
    baseSequence,
    highestSeenSequence: baseSequence + 2,
    localWritesPending: false,
  });
}

describe('switchVaultAccount', () => {
  it('moves the location to the new account at sequence zero with a baseline pending', async () => {
    follow(OLD);
    // The old account's position cannot be switched in place.
    expect(() => vaultSyncFor(stateRoot, NEW)).toThrow(
      /different vault account/,
    );
    const record = await switchVaultAccount({
      stateRoot,
      lifecycle: await restarted(),
      from: OLD,
      to: NEW,
      lease: fresh,
    });
    expect(record).toMatchObject({
      accountId: NEW,
      baseSequence: 0,
      highestSeenSequence: 0,
      localWritesPending: true,
    });
    expect(readVaultSyncRecord(stateRoot)).toEqual(record);
    expect(vaultSyncFor(stateRoot, NEW).accountId).toBe(NEW);
  });

  it('works for a location that never recorded a position, and repeats harmlessly', async () => {
    const lifecycle = await restarted();
    const options = { stateRoot, lifecycle, from: OLD, to: NEW, lease: fresh };
    await switchVaultAccount(options);
    // After progress on the new account a repeat changes nothing.
    writeVaultSyncRecord(stateRoot, {
      accountId: NEW,
      baseSequence: 3,
      highestSeenSequence: 3,
      localWritesPending: false,
    });
    expect((await switchVaultAccount(options)).baseSequence).toBe(3);
  });

  it('threat: it cannot reset the downgrade floor without a recorded restart', async () => {
    follow(OLD);
    const lifecycle = createVaultKeyLifecycle({ store: memoryStore() });
    await lifecycle.initializeAccount({
      accountId: NEW,
      deviceId: 'laptop',
      recoverySecret: 'synthetic recovery credential',
    });
    // The lifecycle holds NEW but never parked OLD.
    await expect(
      switchVaultAccount({
        stateRoot,
        lifecycle,
        from: OLD,
        to: NEW,
        lease: fresh,
      }),
    ).rejects.toMatchObject({ code: 'restart_not_recorded' });
    // A lifecycle still on the old account is no restart either.
    const same = createVaultKeyLifecycle({ store: memoryStore() });
    await same.initializeAccount({
      accountId: OLD,
      deviceId: 'laptop',
      recoverySecret: 'synthetic recovery credential',
    });
    await expect(
      switchVaultAccount({
        stateRoot,
        lifecycle: same,
        from: OLD,
        to: NEW,
        lease: fresh,
      }),
    ).rejects.toBeInstanceOf(VaultAccountSwitchError);
    expect(readVaultSyncRecord(stateRoot)).toMatchObject({
      accountId: OLD,
      baseSequence: 5,
      highestSeenSequence: 7,
    });
  });

  it('lets a device that left the old account and enrolled follow a non-empty new account', async () => {
    follow(OLD);
    const restarter = await restarted();
    const follower = createVaultKeyLifecycle({ store: memoryStore() });
    await follower.initializeAccount({
      accountId: OLD,
      deviceId: 'phone',
      recoverySecret: 'synthetic recovery credential',
    });
    await follower.leaveAccount({ confirmLeave: true });
    const { request, deviceCode } = await follower.createEnrollmentRequest({
      accountId: NEW,
      deviceId: 'phone-b',
    });
    const { grant, accountCode } = await restarter.enrollDevice(request, {
      confirmationCode: deviceCode,
      recoverySecret: 'a replacement credential',
    });
    await follower.acceptEnrollment(grant, { confirmationCode: accountCode });
    const taken = { status: async () => relay(4, 4) };
    // Without the role, a non-empty account is not adopted.
    await expect(
      switchVaultAccount({
        stateRoot,
        lifecycle: follower,
        from: OLD,
        to: NEW,
        lease: taken,
      }),
    ).rejects.toMatchObject({ code: 'account_not_fresh' });
    const record = await switchVaultAccount({
      stateRoot,
      lifecycle: follower,
      from: OLD,
      to: NEW,
      lease: taken,
      role: 'follower',
    });
    // Nothing pending: the next step is a restore, not a backup baseline.
    expect(record).toMatchObject({
      accountId: NEW,
      baseSequence: 0,
      highestSeenSequence: 0,
      localWritesPending: false,
    });
    // A device that never enrolled cannot claim the follower role.
    const stranger = createVaultKeyLifecycle({ store: memoryStore() });
    await stranger.initializeAccount({
      accountId: OLD,
      deviceId: 'tablet',
      recoverySecret: 'synthetic recovery credential',
    });
    writeVaultSyncRecord(stateRoot, {
      accountId: OLD,
      baseSequence: 5,
      highestSeenSequence: 7,
      localWritesPending: false,
    });
    await expect(
      switchVaultAccount({
        stateRoot,
        lifecycle: stranger,
        from: OLD,
        to: NEW,
        lease: taken,
        role: 'follower',
      }),
    ).rejects.toMatchObject({ code: 'restart_not_recorded' });
  });

  it('refuses an interrupted restart, where the device holds no account yet', async () => {
    follow(OLD);
    const lifecycle = createVaultKeyLifecycle({ store: memoryStore() });
    await lifecycle.initializeAccount({
      accountId: OLD,
      deviceId: 'laptop',
      recoverySecret: 'synthetic recovery credential',
    });
    await lifecycle.leaveAccount({ confirmLeave: true });
    await expect(
      switchVaultAccount({
        stateRoot,
        lifecycle,
        from: OLD,
        to: NEW,
        lease: fresh,
      }),
    ).rejects.toMatchObject({ code: 'restart_not_recorded' });
  });

  it('threat: an account that already holds snapshots is not adopted', async () => {
    follow(OLD);
    for (const lease of [
      { status: async () => relay(3, 3) },
      { status: async () => relay(2, 0) },
      { status: async () => relay(0, 1) },
    ]) {
      await expect(
        switchVaultAccount({
          stateRoot,
          lifecycle: await restarted(),
          from: OLD,
          to: NEW,
          lease,
        }),
      ).rejects.toMatchObject({ code: 'account_not_fresh' });
    }
    expect(readVaultSyncRecord(stateRoot)?.accountId).toBe(OLD);
  });

  it('refuses a location that follows some other account', async () => {
    follow('vault-account-x');
    await expect(
      switchVaultAccount({
        stateRoot,
        lifecycle: await restarted(),
        from: OLD,
        to: NEW,
        lease: fresh,
      }),
    ).rejects.toMatchObject({ code: 'not_following_from' });
  });

  it('threat: a retired location never starts following a vault account', async () => {
    follow(OLD);
    writeFileSync(
      join(stateRoot, 'installation.json'),
      JSON.stringify({
        schemaVersion: 1,
        installationId: '11111111-1111-4111-8111-111111111111',
        epoch: 2,
        activationId: 'a'.repeat(32),
        previousInstallationId: null,
        status: 'retired',
      }),
      { mode: 0o600 },
    );
    await expect(
      switchVaultAccount({
        stateRoot,
        lifecycle: await restarted(),
        from: OLD,
        to: NEW,
        lease: fresh,
      }),
    ).rejects.toMatchObject({ code: 'location_retired' });
    expect(readVaultSyncRecord(stateRoot)?.accountId).toBe(OLD);
  });

  it('refuses a location whose custody record cannot be verified', async () => {
    follow(OLD);
    writeFileSync(join(stateRoot, 'installation.json'), '{not json', {
      mode: 0o600,
    });
    await expect(
      switchVaultAccount({
        stateRoot,
        lifecycle: await restarted(),
        from: OLD,
        to: NEW,
        lease: fresh,
      }),
    ).rejects.toMatchObject({ code: 'custody_unusable' });
    expect(readVaultSyncRecord(stateRoot)?.accountId).toBe(OLD);
  });
});
