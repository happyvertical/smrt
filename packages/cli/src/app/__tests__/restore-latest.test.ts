/**
 * `smrt app restore-latest` (#4805) end to end in-process: real local
 * installations, real encrypted snapshots, the real custody records and state
 * roots, and an in-memory relay that follows the lease rules (base must be
 * the head; one holder; fencing token per grant). Fixtures:
 * `restore-test-support.ts`.
 */

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  INSTALLATION_CUSTODY_FILE,
  inspectInstallationCustody,
  readVaultSyncRecord,
  restoreInstallation,
  retireInstallation,
  writeVaultSyncRecord,
} from '@happyvertical/smrt-app-runtime';
import { describe, expect, it } from 'vitest';
import {
  ACCOUNT,
  APP_ID,
  harness,
  installRestoreHooks,
  keyring,
  marker,
  setMarker,
  siblings,
} from './restore-test-support.js';

installRestoreHooks();

describe('smrt app restore-latest', () => {
  it('restores the latest snapshot onto a new machine and moves custody there', async () => {
    const h = await harness();
    const laptop = join(h.root, 'laptop');
    await h.boot(laptop, 'laptop v1');
    await h.relay.publish(laptop, 'device-laptop', h.keys);

    const desktop = join(h.root, 'desktop');
    const result = await h.run(desktop, 'device-desktop', ['--origin-retired']);
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: 'restored',
      sequence: 1,
      custody: 'moved',
      previousRoot: null,
    });
    // A fresh connection sees the restored data (no stale second view).
    expect(marker(desktop)).toBe('laptop v1');
    expect(readVaultSyncRecord(h.stateRootOf(desktop))).toMatchObject({
      accountId: ACCOUNT,
      baseSequence: 1,
      highestSeenSequence: 1,
      localWritesPending: false,
    });
    h.use(desktop);
    const custody = await inspectInstallationCustody({
      appId: APP_ID,
      dataDirectory: desktop,
      sourceRoot: h.app,
    });
    expect(custody.status).toBe('in-custody');
    // The relay lease was taken at the target and released afterwards.
    expect(h.relay.state.calls).toContain('/v1/lease/acquire');
    expect(h.relay.state.holder).toBeNull();
    expect(siblings(h.root, desktop)).toEqual([]);
  });

  it('replaces a stale data root on a second device of the same installation', async () => {
    const h = await harness();
    const laptop = join(h.root, 'laptop');
    await h.boot(laptop, 'v1');
    await h.relay.publish(laptop, 'device-laptop', h.keys);
    const desktop = join(h.root, 'desktop');
    expect((await h.run(desktop, 'device-desktop')).code).toBe(0);

    setMarker(laptop, 'v2');
    await h.relay.publish(laptop, 'device-laptop', h.keys);
    const again = await h.run(desktop, 'device-desktop');
    expect(again.code).toBe(0);
    expect(JSON.parse(again.stdout)).toMatchObject({ sequence: 2 });
    expect(marker(desktop)).toBe('v2');
    // The replaced root is always kept: the record says nothing is pending,
    // but the app does not yet mark writes made after the last publish.
    const kept = JSON.parse(again.stdout).previousRoot;
    expect(marker(kept)).toBe('v1');
    expect(siblings(h.root, desktop)).toEqual([kept.slice(h.root.length + 1)]);

    const current = await h.run(desktop, 'device-desktop');
    expect(JSON.parse(current.stdout).status).toBe('up-to-date');
  });

  it('refuses while another writer holds the local lease (two SQLite writers, smrt#3379)', async () => {
    const h = await harness();
    const laptop = join(h.root, 'laptop');
    await h.boot(laptop, 'v1');
    await h.relay.publish(laptop, 'device-laptop', h.keys);
    const desktop = join(h.root, 'desktop');
    await h.boot(desktop, 'desktop local');
    // The running web process: it holds writer.lease and has the database
    // open. Restore must not replace the file underneath that connection.
    const state = h.stateRootOf(desktop);
    writeFileSync(
      join(state, 'writer.lease'),
      `${JSON.stringify({ schemaVersion: 1, pid: process.ppid, instance: randomBytes(16).toString('hex') })}\n`,
      { mode: 0o600 },
    );
    const web = new DatabaseSync(join(desktop, 'application.sqlite'));
    try {
      const result = await h.run(desktop, 'device-desktop', [
        '--replace-installation',
      ]);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('Another application writer is active');
      expect(h.relay.state.calls).toEqual([]);
      const row = web
        .prepare("SELECT value FROM restore_marker WHERE name = 'marker'")
        .get() as { value: string };
      expect(row.value).toBe('desktop local');
    } finally {
      web.close();
      rmSync(join(state, 'writer.lease'), { force: true });
    }
  });

  it('refuses a downgrade below the highest sequence this device has seen', async () => {
    const h = await harness();
    const laptop = join(h.root, 'laptop');
    await h.boot(laptop, 'v1');
    await h.relay.publish(laptop, 'device-laptop', h.keys);
    await h.relay.publish(laptop, 'device-laptop', h.keys);
    const desktop = join(h.root, 'desktop');
    expect((await h.run(desktop, 'device-desktop')).code).toBe(0);
    // A hostile relay now presents the older snapshot as latest.
    h.relay.state.latestOverride = 1;
    const result = await h.run(desktop, 'device-desktop', ['--discard-local']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('older than sequence 2');
  });

  it('refuses to discard unpublished local writes unless asked, then keeps the previous root', async () => {
    const h = await harness();
    const laptop = join(h.root, 'laptop');
    await h.boot(laptop, 'v1');
    await h.relay.publish(laptop, 'device-laptop', h.keys);
    const desktop = join(h.root, 'desktop');
    expect((await h.run(desktop, 'device-desktop')).code).toBe(0);
    const state = h.stateRootOf(desktop);
    const sync = readVaultSyncRecord(state);
    writeVaultSyncRecord(state, {
      ...(sync as NonNullable<typeof sync>),
      localWritesPending: true,
    });
    setMarker(desktop, 'unpublished edit');

    const refused = await h.run(desktop, 'device-desktop');
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain('--discard-local');
    expect(marker(desktop)).toBe('unpublished edit');

    const replaced = await h.run(desktop, 'device-desktop', [
      '--discard-local',
    ]);
    expect(replaced.code).toBe(0);
    const report = JSON.parse(replaced.stdout);
    expect(marker(desktop)).toBe('v1');
    expect(marker(report.previousRoot)).toBe('unpublished edit');
  });

  it('refuses a snapshot sealed for another account and leaves the live root alone', async () => {
    const h = await harness();
    const other = join(h.root, 'other');
    await h.boot(other, 'other family');
    // Same key material and an equal-length account id: only the envelope's
    // authenticated account binding can tell the snapshots apart.
    await h.relay.publish(other, 'device-other', h.keys, 'acct-others');
    const desktop = join(h.root, 'desktop');
    await h.boot(desktop, 'desktop local');

    const result = await h.run(desktop, 'device-desktop', [
      '--discard-local',
      '--replace-installation',
    ]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('failed authentication');
    expect(marker(desktop)).toBe('desktop local');
    expect(siblings(h.root, desktop)).toEqual([]);
    expect(h.relay.state.holder).toBeNull();
  });

  it('refuses a snapshot of a different installation without --replace-installation', async () => {
    const h = await harness();
    const laptop = join(h.root, 'laptop');
    await h.boot(laptop, 'v1');
    await h.relay.publish(laptop, 'device-laptop', h.keys);
    const desktop = join(h.root, 'desktop');
    await h.boot(desktop, 'independent install');

    const refused = await h.run(desktop, 'device-desktop', ['--discard-local']);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain('different installation');
    expect(marker(desktop)).toBe('independent install');
    expect(siblings(h.root, desktop)).toEqual([]);

    const replaced = await h.run(desktop, 'device-desktop', [
      '--discard-local',
      '--replace-installation',
    ]);
    expect(replaced.code).toBe(0);
    expect(marker(desktop)).toBe('v1');
    // The replaced installation was never published: it is kept.
    expect(marker(JSON.parse(replaced.stdout).previousRoot)).toBe(
      'independent install',
    );
  });

  it('treats a data root with no recorded vault position as unpublished', async () => {
    const h = await harness();
    const laptop = join(h.root, 'laptop');
    await h.boot(laptop, 'v1');
    await h.relay.publish(laptop, 'device-laptop', h.keys);
    // The same installation copied here earlier, then edited offline.
    const desktop = join(h.root, 'desktop');
    const { cpSync } = await import('node:fs');
    cpSync(laptop, desktop, { recursive: true });
    setMarker(desktop, 'offline edit');
    const refused = await h.run(desktop, 'device-desktop');
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain('--discard-local');
    expect(marker(desktop)).toBe('offline edit');
    expect(h.relay.state.calls).toEqual([]);
  });

  it('leaves custody pending without --origin-retired', async () => {
    const h = await harness();
    const laptop = join(h.root, 'laptop');
    await h.boot(laptop, 'v1');
    await h.relay.publish(laptop, 'device-laptop', h.keys);
    const desktop = join(h.root, 'desktop');
    const result = await h.run(desktop, 'device-desktop');
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).custody).toBe('pending');
    h.use(desktop);
    const custody = await inspectInstallationCustody({
      appId: APP_ID,
      dataDirectory: desktop,
      sourceRoot: h.app,
    });
    expect(custody.status).not.toBe('in-custody');
    expect(custody.resolutions).toContain('restore');
  });

  it('threat: refuses to restore over a retired location, even with --origin-retired, until the retirement is reversed explicitly', async () => {
    const h = await harness();
    const laptop = join(h.root, 'laptop');
    await h.boot(laptop, 'v1');
    await h.relay.publish(laptop, 'device-laptop', h.keys);
    const desktop = join(h.root, 'desktop');
    expect(
      (await h.run(desktop, 'device-desktop', ['--origin-retired'])).code,
    ).toBe(0);
    setMarker(laptop, 'v2');
    await h.relay.publish(laptop, 'device-laptop', h.keys);

    // This location's installation moves away (a move, or a cloud migration).
    h.use(desktop);
    const options = {
      appId: APP_ID,
      dataDirectory: desktop,
      sourceRoot: h.app,
    };
    await retireInstallation(options);
    const callsBefore = h.relay.state.calls.length;

    for (const argv of [[], ['--origin-retired'], ['--discard-local']]) {
      const refused = await h.run(desktop, 'device-desktop', argv);
      expect(refused.code).toBe(1);
      expect(refused.stderr).toContain('retired');
      expect(refused.stderr).toContain('installation restore --origin-retired');
    }
    // Nothing was contacted, replaced or un-retired.
    expect(h.relay.state.calls.length).toBe(callsBefore);
    expect(marker(desktop)).toBe('v1');
    expect((await inspectInstallationCustody(options)).status).toBe('retired');

    // Reversing the retirement is its own explicit declaration; then the
    // restore proceeds as on any other location.
    await restoreInstallation({ ...options, originRetired: true });
    const result = await h.run(desktop, 'device-desktop');
    expect(result.code).toBe(0);
    expect(marker(desktop)).toBe('v2');
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: 'restored',
      sequence: 2,
    });
  });

  it('threat: an unreadable custody record refuses the restore instead of overwriting around it', async () => {
    const h = await harness();
    const laptop = join(h.root, 'laptop');
    await h.boot(laptop, 'v1');
    await h.relay.publish(laptop, 'device-laptop', h.keys);
    const desktop = join(h.root, 'desktop');
    await h.boot(desktop, 'desktop local');
    writeFileSync(
      join(h.stateRootOf(desktop), INSTALLATION_CUSTODY_FILE),
      'not a record',
      { mode: 0o600 },
    );
    const result = await h.run(desktop, 'device-desktop', [
      '--discard-local',
      '--replace-installation',
    ]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('custody record');
    expect(marker(desktop)).toBe('desktop local');
    expect(h.relay.state.calls).toEqual([]);
  });

  it('removes plaintext leftovers of a restore that crashed before its journal', async () => {
    const h = await harness();
    const desktop = join(h.root, 'desktop');
    await h.boot(desktop, 'original');
    const hex = () => randomBytes(8).toString('hex');
    const candidate = join(h.root, `.desktop.restore-${hex()}`);
    const staging = join(
      h.root,
      `..desktop.restore-${hex()}.123.${hex()}.partial`,
    );
    const download = join(h.root, `.desktop.download-${hex()}`);
    const kept = join(h.root, `.desktop.previous-${hex()}`);
    for (const path of [candidate, staging, kept]) mkdirSync(path);
    writeFileSync(download, 'ciphertext');
    const result = await h.run(desktop, 'device-desktop', ['--recover']);
    expect(result.code).toBe(0);
    for (const path of [candidate, staging, download]) {
      expect(existsSync(path)).toBe(false);
    }
    expect(existsSync(kept)).toBe(true);
    expect(marker(desktop)).toBe('original');
  });

  it('refuses a snapshot whose database fails its integrity check', async () => {
    const h = await harness();
    const laptop = join(h.root, 'laptop');
    await h.boot(laptop, 'v1');
    writeFileSync(join(laptop, 'application.sqlite'), randomBytes(8192), {
      mode: 0o600,
    });
    await h.relay.publish(laptop, 'device-laptop', h.keys);
    const desktop = join(h.root, 'desktop');
    const result = await h.run(desktop, 'device-desktop');
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('integrity check');
    expect(existsSync(desktop)).toBe(false);
    expect(siblings(h.root, desktop)).toEqual([]);
  });

  it('aborts without swapping when the relay lease is lost mid-restore', async () => {
    const h = await harness();
    const laptop = join(h.root, 'laptop');
    await h.boot(laptop, 'v1');
    await h.relay.publish(laptop, 'device-laptop', h.keys);
    const desktop = join(h.root, 'desktop');
    h.relay.state.loseLeaseOnRenew = true;
    const result = await h.run(desktop, 'device-desktop');
    expect(result.code).toBe(1);
    expect(existsSync(desktop)).toBe(false);
    expect(siblings(h.root, desktop)).toEqual([]);
    expect(readVaultSyncRecord(h.stateRootOf(desktop))).toBeNull();
  });

  it('refuses when another device holds the relay lease', async () => {
    const h = await harness();
    const laptop = join(h.root, 'laptop');
    await h.boot(laptop, 'v1');
    await h.relay.publish(laptop, 'device-laptop', h.keys);
    h.relay.state.holder = 'device-laptop';
    const desktop = join(h.root, 'desktop');
    const result = await h.run(desktop, 'device-desktop');
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Another device is writing');
    expect(existsSync(desktop)).toBe(false);
  });

  it('settles an interrupted swap with --recover before anything can write', async () => {
    const h = await harness();
    const desktop = join(h.root, 'desktop');
    await h.boot(desktop, 'original');
    const state = h.stateRootOf(desktop);
    const previous = join(
      h.root,
      `.desktop.previous-${randomBytes(8).toString('hex')}`,
    );
    const candidate = join(
      h.root,
      `.desktop.restore-${randomBytes(8).toString('hex')}`,
    );
    mkdirSync(candidate, { mode: 0o700 });
    writeFileSync(
      join(state, 'data-root-swap.json'),
      `${JSON.stringify({ schemaVersion: 1, phase: 'swapped', live: desktop, candidate, previous, keepPrevious: false })}\n`,
      { mode: 0o600 },
    );
    const { renameSync } = await import('node:fs');
    renameSync(desktop, previous);
    renameSync(candidate, desktop);

    const recovered = await h.run(desktop, 'device-desktop', ['--recover']);
    expect(recovered.code).toBe(0);
    expect(JSON.parse(recovered.stdout)).toMatchObject({
      status: 'recovered',
      recovery: 'rolled-back',
    });
    expect(marker(desktop)).toBe('original');
  });
});
