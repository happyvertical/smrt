/**
 * Vault restart orchestrator and rotation-then-backup (#4838, #4834) against
 * the real key lifecycle and the real `vault-sync.json`; only the relay, the
 * host configuration and the backup are injected. Threats: an interrupted
 * restart left unnoticed or repeated unsafely, a restart that moves a store
 * out of order, a rotation without its immediate backup, and secrets in
 * reports.
 */

import { chmodSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readVaultSyncRecord,
  writeVaultSyncRecord,
} from '@happyvertical/smrt-app-runtime';
import { createVaultKeyLifecycle } from '@happyvertical/smrt-app-runtime/vault-key-lifecycle';
import type { VaultKeyStore } from '@happyvertical/smrt-app-runtime/vault-key-store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  inspectVaultRestart,
  restartVault,
  rotateVaultKeys,
  type VaultHostConfig,
} from '../vault-restart.js';

const OLD = 'vault-account-a';
const NEW = 'vault-account-b';
const OLD_SECRET = 'synthetic old recovery credential';
const NEW_SECRET = 'synthetic new recovery credential';

let stateRoot: string;

beforeEach(() => {
  stateRoot = realpathSync(
    mkdtempSync(join(realpathSync(tmpdir()), 'smrt-vault-restart-cli-')),
  );
  chmodSync(stateRoot, 0o700);
});

afterEach(() => {
  rmSync(stateRoot, { recursive: true, force: true });
});

interface MemoryStore extends VaultKeyStore {
  items: Map<string, Uint8Array>;
  failOnSet?: (name: string) => boolean;
}

function memoryStore(): MemoryStore {
  const store: MemoryStore = {
    items: new Map(),
    async get(name) {
      const value = store.items.get(name);
      return value ? new Uint8Array(value) : null;
    },
    async set(name, value) {
      if (store.failOnSet?.(name)) throw new Error('simulated crash');
      store.items.set(name, new Uint8Array(value));
    },
    async delete(name) {
      store.items.delete(name);
    },
  };
  return store;
}

/** A device that follows OLD everywhere, with one published snapshot. */
async function harness() {
  const store = memoryStore();
  const lifecycle = createVaultKeyLifecycle({ store });
  await lifecycle.initializeAccount({
    accountId: OLD,
    deviceId: 'laptop',
    recoverySecret: OLD_SECRET,
  });
  writeVaultSyncRecord(stateRoot, {
    accountId: OLD,
    baseSequence: 5,
    highestSeenSequence: 7,
    localWritesPending: false,
  });
  let followed: string | null = OLD;
  const config: VaultHostConfig = {
    followedAccount: async () => followed,
    followAccount: async (account) => {
      followed = account;
    },
  };
  const restartAccount = vi.spyOn(lifecycle, 'restartAccount');
  const faults: Partial<
    Record<'publish' | 'lease' | 'follow' | 'backup', unknown>
  > = {};
  const fault = (name: keyof typeof faults) => {
    const error = faults[name];
    delete faults[name];
    if (error !== undefined) throw error;
  };
  const publish = vi.fn(async () => fault('publish'));
  const backup = vi.fn(async () => {
    fault('backup');
    writeVaultSyncRecord(stateRoot, {
      accountId: NEW,
      baseSequence: 1,
      highestSeenSequence: 1,
      localWritesPending: false,
    });
  });
  const followAccount = vi.spyOn(config, 'followAccount');
  followAccount.mockImplementation(async (account) => {
    fault('follow');
    followed = account;
  });
  const options = {
    from: OLD,
    to: NEW,
    deviceId: 'laptop-b',
    recoverySecret: NEW_SECRET,
    stateRoot,
    lifecycle,
    hostConfig: config,
    lease: {
      status: async () => {
        fault('lease');
        return {
          holder: null,
          headSequence: 0,
          latestCommittedSequence: 0,
          headIsHole: false,
        };
      },
    },
    publish,
    backup,
    now: () => new Date('2026-11-09T12:00:00.000Z'),
  };
  return {
    store,
    lifecycle,
    options,
    restartAccount,
    publish,
    backup,
    followAccount,
    faults,
    followed: () => followed,
    setFollowed: (account: string | null) => {
      followed = account;
    },
  };
}

const outcomes = (report: { steps: Array<{ outcome: string }> }) =>
  report.steps.map((step) => step.outcome);

describe('restartVault', () => {
  it('sequences the three stores and takes the first backup once', async () => {
    const h = await harness();
    const report = await restartVault(h.options);

    expect(report).toMatchObject({
      state: 'complete',
      from: OLD,
      to: NEW,
      repairable: true,
      backupAfterRotation: 'done',
      at: '2026-11-09T12:00:00.000Z',
      stores: { keyLifecycle: 'to', syncPosition: 'to', hostConfig: 'to' },
    });
    expect(report.steps.map((step) => step.step)).toEqual([
      'key-lifecycle',
      'publish',
      'sync-position',
      'host-config',
      'backup',
    ]);
    expect(outcomes(report)).toEqual(['done', 'done', 'done', 'done', 'done']);
    expect((await h.lifecycle.status())?.accountId).toBe(NEW);
    expect(await h.lifecycle.previousAccount()).toEqual({
      accountId: OLD,
      interrupted: false,
    });
    expect(readVaultSyncRecord(stateRoot)).toMatchObject({ accountId: NEW });
    expect(h.followed()).toBe(NEW);
    expect(h.publish).toHaveBeenCalledTimes(1);
    expect(h.backup).toHaveBeenCalledTimes(1);
    // The old account is parked, not discarded: that is the caller's call.
    expect((await h.lifecycle.previousAccount())?.accountId).toBe(OLD);
  });

  it('is a no-op when run again, and needs no secret then', async () => {
    const h = await harness();
    await restartVault(h.options);
    const restarts = h.restartAccount.mock.calls.length;

    const again = await restartVault({
      ...h.options,
      recoverySecret: 'not the secret',
    });
    expect(again.state).toBe('complete');
    expect(outcomes(again)).toEqual(Array(5).fill('already-done'));
    expect(again.backupAfterRotation).toBe('skipped');
    expect(h.restartAccount).toHaveBeenCalledTimes(restarts);
    expect(h.publish).toHaveBeenCalledTimes(1);
    expect(h.backup).toHaveBeenCalledTimes(1);
    expect(h.followAccount).toHaveBeenCalledTimes(1);
  });

  it('reports a mismatch without running anything when a store follows another account', async () => {
    const h = await harness();
    h.setFollowed('vault-account-z');
    const report = await restartVault(h.options);
    expect(report).toMatchObject({
      state: 'mismatch',
      repairable: false,
      stores: { hostConfig: 'other' },
    });
    expect(outcomes(report)).toEqual(Array(5).fill('not-run'));
    expect(h.restartAccount).not.toHaveBeenCalled();
    expect(h.publish).not.toHaveBeenCalled();
    expect((await h.lifecycle.status())?.accountId).toBe(OLD);
  });

  it('treats a lifecycle that was never restarted from the old account as unrecognised', async () => {
    const h = await harness();
    const stranger = createVaultKeyLifecycle({ store: memoryStore() });
    await stranger.initializeAccount({
      accountId: NEW,
      deviceId: 'laptop',
      recoverySecret: NEW_SECRET,
    });
    const report = await restartVault({ ...h.options, lifecycle: stranger });
    expect(report.state).toBe('mismatch');
    expect(report.repairable).toBe(false);
    expect(report.stores.keyLifecycle).toBe('other');
  });

  describe('interruption', () => {
    const cases: Array<{
      name: 'publish' | 'lease' | 'follow' | 'backup';
      step: string;
      state: 'mismatch' | 'backup_failed';
      stores: [string, string, string];
    }> = [
      {
        name: 'publish',
        step: 'publish',
        state: 'mismatch',
        stores: ['to', 'from', 'from'],
      },
      {
        name: 'lease',
        step: 'sync-position',
        state: 'mismatch',
        stores: ['to', 'from', 'from'],
      },
      {
        name: 'follow',
        step: 'host-config',
        state: 'mismatch',
        stores: ['to', 'to', 'from'],
      },
      {
        name: 'backup',
        step: 'backup',
        state: 'backup_failed',
        stores: ['to', 'to', 'to'],
      },
    ];

    for (const point of cases) {
      it(`detects a stop at ${point.step} and resumes it to complete`, async () => {
        const h = await harness();
        h.faults[point.name] = new Error('network down');

        const stopped = await restartVault(h.options);
        expect(stopped.state).toBe(point.state);
        expect([
          stopped.stores.keyLifecycle,
          stopped.stores.syncPosition,
          stopped.stores.hostConfig,
        ]).toEqual(point.stores);
        const failedStep = stopped.steps.find(
          (step) => step.outcome === 'failed',
        );
        expect(failedStep?.step).toBe(point.step);
        expect(failedStep?.error?.message).toBe('network down');
        // Detectable without running anything.
        const inspected = await inspectVaultRestart(h.options);
        expect(inspected).toMatchObject({
          finished: false,
          started: true,
          repairable: true,
        });
        expect(stopped.message).toContain('restartVault');

        const resumed = await restartVault(h.options);
        expect(resumed.state).toBe('resumed');
        expect(resumed.stores).toEqual({
          keyLifecycle: 'to',
          syncPosition: 'to',
          hostConfig: 'to',
        });
        expect(resumed.steps.some((step) => step.outcome === 'failed')).toBe(
          false,
        );
        expect(outcomes(resumed)[0]).toBe('already-done');

        const calls = {
          publish: h.publish.mock.calls.length,
          backup: h.backup.mock.calls.length,
          follow: h.followAccount.mock.calls.length,
        };
        const settled = await restartVault(h.options);
        expect(settled.state).toBe('complete');
        expect(outcomes(settled)).toEqual(Array(5).fill('already-done'));
        expect({
          publish: h.publish.mock.calls.length,
          backup: h.backup.mock.calls.length,
          follow: h.followAccount.mock.calls.length,
        }).toEqual(calls);
        // Backup ran once successfully (plus the failed attempt, if any).
        expect(h.backup).toHaveBeenCalledTimes(point.name === 'backup' ? 2 : 1);
      });
    }

    it('detects a crash inside the key lifecycle and resumes it', async () => {
      const h = await harness();
      h.store.failOnSet = (name) => name === 'registry';
      const stopped = await restartVault(h.options);
      h.store.failOnSet = undefined;
      expect(stopped.state).toBe('mismatch');
      expect(stopped.stores.keyLifecycle).toBe('none');
      expect(stopped.steps[0]).toMatchObject({
        step: 'key-lifecycle',
        outcome: 'failed',
      });
      expect(h.publish).not.toHaveBeenCalled();
      expect(await inspectVaultRestart(h.options)).toMatchObject({
        started: true,
        finished: false,
      });

      const resumed = await restartVault(h.options);
      expect(resumed.state).toBe('resumed');
      expect(h.backup).toHaveBeenCalledTimes(1);
      expect((await h.lifecycle.status())?.accountId).toBe(NEW);
    });

    it('republishes when the restart stopped before the host could, with the same secret', async () => {
      const h = await harness();
      h.faults.publish = new Error('network down');
      await restartVault(h.options);
      // The lifecycle is on the new account but the relay never got it.
      expect(h.publish).toHaveBeenCalledTimes(1);
      const resumed = await restartVault(h.options);
      expect(resumed.state).toBe('resumed');
      expect(h.publish).toHaveBeenCalledTimes(2);
      // A wrong secret cannot fetch the publication again.
      const h2 = await harness();
      h2.faults.publish = new Error('network down');
      await restartVault(h2.options);
      const wrong = await restartVault({
        ...h2.options,
        recoverySecret: 'a different credential',
      });
      expect(wrong.state).toBe('mismatch');
      expect(wrong.steps[1]).toMatchObject({
        step: 'publish',
        outcome: 'failed',
        error: { code: 'recovery_rejected' },
      });
    });

    it('leaves the sync position and the host on the old account while the relay check fails', async () => {
      const h = await harness();
      // vault-sync.json still follows OLD when the relay-empty check fails.
      h.faults.lease = new Error('relay unreachable');
      await restartVault(h.options);
      expect(readVaultSyncRecord(stateRoot)).toMatchObject({ accountId: OLD });
      expect(h.followed()).toBe(OLD);
    });
  });

  describe('first backup', () => {
    it('is loud when it fails, and says what is refused until it succeeds', async () => {
      const h = await harness();
      h.faults.backup = new Error('target unreachable');
      const report = await restartVault(h.options);
      expect(report.state).toBe('backup_failed');
      expect(report.backupAfterRotation).toBe('failed');
      expect(report.message).toMatch(/no snapshot yet/);
      expect(report.message).toMatch(/until a backup succeeds/);
      // Everything else did move: the failure is the backup alone.
      expect(report.stores).toEqual({
        keyLifecycle: 'to',
        syncPosition: 'to',
        hostConfig: 'to',
      });
    });

    it('does not count a backup that recorded no published sequence', async () => {
      const h = await harness();
      h.backup.mockImplementationOnce(async () => undefined);
      const report = await restartVault(h.options);
      expect(report.state).toBe('backup_failed');
      expect(report.steps[4].error?.code).toBe('backup_not_recorded');
      expect((await restartVault(h.options)).state).toBe('resumed');
      expect(h.backup).toHaveBeenCalledTimes(2);
    });

    it('does not trust a host that did not start following the account', async () => {
      const h = await harness();
      h.followAccount.mockImplementationOnce(async () => undefined);
      const report = await restartVault(h.options);
      expect(report.state).toBe('mismatch');
      expect(report.steps[3].error?.code).toBe('host_config_unchanged');
      expect(h.backup).not.toHaveBeenCalled();
    });
  });

  describe('secrets', () => {
    it('keeps the recovery secret and every key out of reports and errors', async () => {
      const h = await harness();
      const sealing = await h.lifecycle.openSealingKey();
      const oldKey = Buffer.from(sealing.key).toString('base64');
      sealing.key.fill(0);
      h.faults.backup = new Error(
        `target rejected ${NEW_SECRET} for https://user:hunter2hunter@example.test/x`,
      );
      const failed = await restartVault(h.options);
      const resumed = await restartVault(h.options);
      for (const report of [failed, resumed]) {
        const text = JSON.stringify(report);
        expect(text).not.toContain(NEW_SECRET);
        expect(text).not.toContain(OLD_SECRET);
        expect(text).not.toContain(oldKey);
        expect(text).not.toContain('hunter2hunter');
      }
      expect(failed.steps[4].error?.message).toContain('target rejected');
    });

    it('writes no secret into vault-sync.json', async () => {
      const h = await harness();
      await restartVault(h.options);
      expect(JSON.stringify(readVaultSyncRecord(stateRoot))).not.toContain(
        NEW_SECRET,
      );
    });
  });
});

describe('rotateVaultKeys', () => {
  async function rotating() {
    const lifecycle = createVaultKeyLifecycle({ store: memoryStore() });
    await lifecycle.initializeAccount({
      accountId: OLD,
      deviceId: 'laptop',
      recoverySecret: OLD_SECRET,
    });
    const publish = vi.fn(async () => undefined);
    const backup = vi.fn(async () => undefined);
    return {
      lifecycle,
      publish,
      backup,
      options: {
        lifecycle,
        recoverySecret: OLD_SECRET,
        publish,
        backup,
        now: () => new Date('2026-11-09T12:00:00.000Z'),
      },
    };
  }

  it('backs up exactly once, right after publishing the rotation', async () => {
    const r = await rotating();
    const order: string[] = [];
    r.publish.mockImplementation(async () => {
      order.push('publish');
    });
    r.backup.mockImplementation(async () => {
      order.push('backup');
    });
    const report = await rotateVaultKeys(r.options);
    expect(report).toMatchObject({
      state: 'complete',
      generation: '2',
      backupAfterRotation: 'done',
    });
    expect(order).toEqual(['publish', 'backup']);
    expect(r.backup).toHaveBeenCalledTimes(1);
    expect((await r.lifecycle.status())?.currentGeneration).toBe(2n);
  });

  it('is loud when the immediate backup fails and does not rotate again', async () => {
    const r = await rotating();
    r.backup.mockRejectedValueOnce(new Error(`rejected ${OLD_SECRET}`));
    const report = await rotateVaultKeys(r.options);
    expect(report).toMatchObject({
      state: 'backup_failed',
      generation: '2',
      backupAfterRotation: 'failed',
    });
    expect(report.message).toMatch(/older generation are refused on restore/);
    expect(JSON.stringify(report)).not.toContain(OLD_SECRET);
    expect((await r.lifecycle.status())?.currentGeneration).toBe(2n);
  });

  it('takes no backup when publishing the rotation fails, and says so', async () => {
    const r = await rotating();
    r.publish.mockRejectedValueOnce(new Error('relay down'));
    const report = await rotateVaultKeys(r.options);
    expect(report).toMatchObject({
      state: 'publish_failed',
      backupAfterRotation: 'skipped',
    });
    expect(r.backup).not.toHaveBeenCalled();
  });

  it('throws a lifecycle refusal unchanged and backs up nothing', async () => {
    const r = await rotating();
    await expect(
      rotateVaultKeys({ ...r.options, recoverySecret: 'wrong' }),
    ).rejects.toMatchObject({ code: 'recovery_rejected' });
    expect(r.publish).not.toHaveBeenCalled();
    expect(r.backup).not.toHaveBeenCalled();
  });
});
