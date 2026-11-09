import { chmodSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type DesktopFs, FsTrustError, nodeFs } from '../internal/fs-seam.js';
import { BUNDLE, ORIGIN, PRODUCT } from '../testing/rendezvous-fixture.js';
import { INSTANCE_RECORD_FILENAME } from './instance-record.js';
import { type ReferenceShell, startReferenceShell } from './reference-shell.js';

const posixOnly = process.platform === 'win32' ? describe.skip : describe;

posixOnly('reference shell record writes', () => {
  let dir: string;
  const shells: ReferenceShell[] = [];
  beforeEach(() => {
    dir = mkdtempSync('/tmp/smrt-ref-');
    chmodSync(dir, 0o700);
  });
  afterEach(async () => {
    for (const shell of shells.splice(0)) await shell.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });

  /** A filesystem whose `rename` (the commit of a record write) can fail. */
  const flakyFs = () => {
    const state = { failRenames: 0 };
    const fs: DesktopFs = {
      ...nodeFs,
      async rename(from, to) {
        if (state.failRenames > 0) {
          state.failRenames--;
          throw new Error('disk full');
        }
        return nodeFs.rename(from, to);
      },
    };
    return { fs, state };
  };
  const onDisk = () =>
    JSON.parse(readFileSync(`${dir}/${INSTANCE_RECORD_FILENAME}`, 'utf8')) as {
      state: string;
      failure?: string;
    };

  it('keeps publishing after one write fails, and surfaces the error to its owner', async () => {
    const { fs, state } = flakyFs();
    const onWriteError = vi.fn();
    const shell = await startReferenceShell({
      shellDirectory: dir,
      productId: PRODUCT,
      bundleId: BUNDLE,
      fs,
      onWriteError,
    });
    shells.push(shell);
    expect(onDisk().state).toBe('starting');

    // The write for `ready` is lost...
    state.failRenames = 1;
    shell.supervisor.ready(ORIGIN);
    await expect(shell.flush()).rejects.toBeInstanceOf(FsTrustError);
    expect(onWriteError).toHaveBeenCalledTimes(1);
    expect(onDisk().state).toBe('starting');

    // ...and the next phase change is still published, not skipped forever.
    shell.supervisor.fail('lease_held');
    await shell.flush();
    expect(onDisk()).toMatchObject({ state: 'failed', failure: 'lease_held' });
    expect(onWriteError).toHaveBeenCalledTimes(1);
  });

  it('reports a failure only once, and close() rethrows an unreported one', async () => {
    const { fs, state } = flakyFs();
    const shell = await startReferenceShell({
      shellDirectory: dir,
      productId: PRODUCT,
      bundleId: BUNDLE,
      fs,
    });
    shells.push(shell);
    state.failRenames = 1;
    shell.supervisor.ready(ORIGIN);
    await expect(shell.flush()).rejects.toBeInstanceOf(FsTrustError);
    await shell.flush();

    state.failRenames = 1;
    shell.supervisor.fail('unknown');
    await expect(shell.close()).rejects.toBeInstanceOf(FsTrustError);
  });

  it('does not leave a listener behind when the first publish fails', async () => {
    const { fs, state } = flakyFs();
    state.failRenames = 1;
    await expect(
      startReferenceShell({
        shellDirectory: dir,
        productId: PRODUCT,
        bundleId: BUNDLE,
        fs,
      }),
    ).rejects.toBeInstanceOf(FsTrustError);
  });
});
