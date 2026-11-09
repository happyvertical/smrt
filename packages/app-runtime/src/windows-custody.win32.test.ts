/**
 * Windows custody rule on a real Windows machine (smrt#4837).
 *
 * These tests need the real `GetFinalPathNameByHandleW`, NTFS file ids,
 * reparse points, DACL inheritance and Windows PowerShell, none of which any
 * fake can reproduce, so they are gated on `process.platform === 'win32'` and
 * run only in the `app-runtime-windows` workflow. They use the runner user's
 * real `%LOCALAPPDATA%`, never the checkout (`D:\a\...` carries a permissive
 * ACL) and clean up after themselves.
 *
 * UNVERIFIED: this file was written without access to a Windows machine and
 * has never been run. Expect to adjust it on its first CI run.
 */

import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  prepareApplicationStateRoot,
  prepareLocalDatabaseStorage,
  processExists,
  WindowsDatabaseAcquisitionUnsupportedError,
} from './index.js';
import { acquireInitializationLock } from './local-custody.js';
import {
  createNodeWindowsRuntime,
  preparePrivateWindowsTree,
  walkWindowsChain,
} from './windows-custody.js';

const onWindows = process.platform === 'win32';
const localAppData = process.env.LOCALAPPDATA ?? '';
const created: string[] = [];

function unique(prefix = 'smrt-test'): string {
  const path = join(
    localAppData,
    `${prefix}-${randomBytes(6).toString('hex')}`,
  );
  created.push(path);
  return path;
}

afterEach(() => {
  for (const path of created.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe.runIf(onWindows)('real Windows machine', () => {
  const rt = createNodeWindowsRuntime();

  it('the stock ancestors of %LOCALAPPDATA% pass the ancestor rule; the real DACLs are printed for the fixtures', () => {
    const drive = localAppData.slice(0, 3);
    const paths = [drive, join(drive, 'Users'), localAppData];
    const inspection = rt.inspectAcl(paths);
    // Print the descriptors so the fake-machine fixtures can be re-captured.
    console.info(
      JSON.stringify(
        { userSid: inspection.userSid, records: inspection.records },
        null,
        2,
      ),
    );
    expect(() =>
      preparePrivateWindowsTree(rt, { directory: unique() }),
    ).not.toThrow();
  });

  it('accepts a fresh directory under %LOCALAPPDATA% and verifies it again', () => {
    const directory = unique();
    const first = preparePrivateWindowsTree(rt, { directory });
    expect(first.createdDirectories).toContain(directory);
    expect(
      preparePrivateWindowsTree(rt, { directory }).createdDirectories,
    ).toEqual([]);
  });

  it('refuses a directory under C:\\ (it inherits Authenticated Users: Modify) and removes it', () => {
    const directory = `C:\\smrt-test-${randomBytes(6).toString('hex')}`;
    created.push(directory);
    expect(() => preparePrivateWindowsTree(rt, { directory })).toThrow(
      /lacks Windows custody/,
    );
    expect(existsSync(directory)).toBe(false);
  });

  it('refuses a directory that was later opened to the Users group', () => {
    const directory = unique();
    preparePrivateWindowsTree(rt, { directory });
    execFileSync('icacls', [directory, '/grant', '*S-1-5-32-545:(OI)(CI)R']);
    expect(() => preparePrivateWindowsTree(rt, { directory })).toThrow(
      /lacks Windows custody/,
    );
  });

  it('refuses a junction at an ancestor and at the root (WT2)', () => {
    const base = unique();
    const target = join(base, 'target');
    mkdirSync(target, { recursive: true });
    const junction = join(base, 'junction');
    symlinkSync(target, junction, 'junction');
    expect(() =>
      preparePrivateWindowsTree(rt, { directory: join(junction, 'child') }),
    ).toThrow(/link or reparse point|reparse point/);
    expect(() =>
      preparePrivateWindowsTree(rt, { directory: junction }),
    ).toThrow(/link or reparse point|reparse point/);
  });

  it('refuses a file symbolic link (needs developer mode or elevation)', ({
    skip,
  }) => {
    const directory = unique();
    preparePrivateWindowsTree(rt, { directory });
    const target = join(directory, 'target.txt');
    writeFileSync(target, '');
    const link = join(directory, 'link.txt');
    try {
      symlinkSync(target, link, 'file');
    } catch {
      skip();
    }
    expect(() => walkWindowsChain(rt, link, 'file')).toThrow(
      /link or reparse point/,
    );
  });

  it('refuses a subst drive (WT7)', ({ skip }) => {
    const directory = unique();
    preparePrivateWindowsTree(rt, { directory });
    try {
      execFileSync('subst', ['S:', directory]);
    } catch {
      skip();
    }
    try {
      expect(() => walkWindowsChain(rt, 'S:\\', 'directory')).toThrow(
        /redirected|reparse/,
      );
    } finally {
      execFileSync('subst', ['S:', '/d']);
    }
  });

  it('refuses an 8.3 short-name spelling of a long directory (WT5)', ({
    skip,
  }) => {
    const directory = join(unique(), 'a-directory-with-a-long-name');
    mkdirSync(directory, { recursive: true });
    const short = execFileSync(
      'cmd',
      ['/d', '/c', `for %I in ("${directory}") do @echo %~sI`],
      { encoding: 'utf8' },
    ).trim();
    if (short.toLowerCase() === directory.toLowerCase()) skip();
    expect(() => walkWindowsChain(rt, short, 'directory')).toThrow(
      /redirected|not in canonical/,
    );
  });

  it('inspects a path full of shell and wildcard characters literally (WT9)', () => {
    const directory = join(unique(), "a'b $(x) [y] \u00e9 `n");
    expect(() => preparePrivateWindowsTree(rt, { directory })).not.toThrow();
    expect(existsSync(directory)).toBe(true);
  });

  it('refuses to rename over a marker while another handle holds it open', () => {
    const directory = unique();
    preparePrivateWindowsTree(rt, { directory });
    const marker = join(directory, 'marker');
    writeFileSync(marker, '');
    const replacement = join(directory, 'replacement');
    writeFileSync(replacement, '');
    const handle = openSync(marker, 'r');
    try {
      expect(() => renameSync(replacement, marker)).toThrow(/EPERM|EBUSY/);
    } finally {
      closeSync(handle);
    }
  });

  it('takes and releases the initialization lease with the real lock-only worker', async () => {
    const leases = () =>
      readdirSync(localAppData).filter((name) =>
        name.startsWith('.smrt-lease-'),
      );
    const before = new Set(leases());
    const lock = await acquireInitializationLock(unique());
    try {
      const fresh = leases().filter((name) => !before.has(name));
      expect(fresh).toHaveLength(1);
      created.push(join(localAppData, fresh[0]));
    } finally {
      await lock.release();
    }
  });

  it('prepares the operator state root and a repeatable marker', () => {
    const options = {
      appId: 'win32-custody-test',
      dataDirectory: unique(),
      sourceRoot: process.cwd(),
    };
    const stateRoot = prepareApplicationStateRoot(options);
    created.push(stateRoot);
    expect(prepareApplicationStateRoot(options)).toBe(stateRoot);
  });

  it('reaches the SDK gate with the read-only preflight done and nothing created', async () => {
    const dataDirectory = unique();
    await expect(
      prepareLocalDatabaseStorage({
        appId: 'win32-custody-test',
        dataDirectory,
        sourceRoot: process.cwd(),
      }),
    ).rejects.toBeInstanceOf(WindowsDatabaseAcquisitionUnsupportedError);
    expect(existsSync(dataDirectory)).toBe(false);
  });

  it('recognises live and dead processes', () => {
    expect(processExists(process.pid)).toBe(true);
    expect(processExists(0x7ffffff0)).toBe(false);
  });
});
