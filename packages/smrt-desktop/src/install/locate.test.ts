import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DesktopContractError } from '../errors.js';
import { MemoryFs } from '../testing/memory-fs.js';
import {
  type BundleManifestV1,
  serializeBundleManifest,
} from './bundle-manifest.js';
import {
  type InstallationRecordV1,
  serializeInstallationRecord,
} from './installation-record.js';
import {
  type LocateInstallationOptions,
  locateInstallation,
} from './locate.js';

const PRODUCT = 'smrt-notes';
const BUNDLE = 'com.happyvertical.smrt-notes';
const RECORDED = '2026-11-01T12:00:00Z';

const bundleBase: BundleManifestV1 = {
  version: 1,
  productId: PRODUCT,
  bundleId: BUNDLE,
  displayName: 'SMRT Notes',
  productVersion: '1.4.0',
  channel: 'stable',
  target: 'x86_64-unknown-linux-gnu',
  sidecarManifest: 'sidecar-manifest.json',
  node: { executable: 'smrt-start-node' },
  bridge: {
    entry: 'bridge/smrt-mcp-bridge.mjs',
    envPrefix: 'SMRT_NOTES',
    mcpPath: '/api/mcp',
  },
};
const sidecarText = JSON.stringify({
  version: 1,
  executable: 'smrt-start-node',
  args: ['build/index.js'],
  healthRoute: '/api/_runtime/health',
  dataDirectory: 'runtime',
});

async function code(
  promise: Promise<unknown>,
  leaks: string[] = [],
): Promise<string> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(DesktopContractError);
    const e = error as DesktopContractError;
    const text = `${e.message}\n${e.stack}\n${JSON.stringify(e)}\n${e.field ?? ''}`;
    for (const leak of leaks) expect(text).not.toContain(leak);
    return e.code;
  }
  return 'ok';
}

const posixOnly = process.platform === 'win32' ? describe.skip : describe;

posixOnly.each(['linux', 'darwin'] as const)(
  'locateInstallation on a real filesystem (%s layout)',
  (platform) => {
    let base: string;
    let home: string;
    let installRoot: string;
    let executableDir: string;
    let resourceDir: string;
    let shellDir: string;
    let options: LocateInstallationOptions;
    let leaks: string[];

    // Create missing directories and give each new one an explicit mode, so
    // the fixture does not depend on the umask. Existing ones keep theirs.
    const dir = (path: string, mode = 0o755) => {
      if (existsSync(path)) return;
      dir(dirname(path));
      mkdirSync(path);
      chmodSync(path, mode);
    };
    const put = (path: string, text: string, mode: number) => {
      dir(dirname(path));
      writeFileSync(path, text);
      chmodSync(path, mode);
    };
    const record = (overrides: Partial<InstallationRecordV1> = {}) =>
      serializeInstallationRecord({
        version: 1,
        productId: PRODUCT,
        bundleId: BUNDLE,
        productVersion: '1.4.0',
        target: 'x86_64-unknown-linux-gnu',
        platform,
        installRoot,
        executableDir,
        resourceDir,
        shellExecutable: join(executableDir, 'smrt-notes'),
        recordedAt: RECORDED,
        ...overrides,
      });
    const writeRecord = (text = record()) =>
      put(join(shellDir, 'installation.json'), text, 0o600);
    const writeBundle = (overrides: Record<string, unknown> = {}) =>
      put(
        join(resourceDir, 'smrt-bundle.json'),
        JSON.stringify({ ...bundleBase, ...overrides }),
        0o644,
      );
    const locate = () => locateInstallation(options);

    beforeEach(() => {
      base = realpathSync(mkdtempSync(join(tmpdir(), 'smrt-desktop-locate-')));
      chmodSync(base, 0o700);
      home = join(base, 'home');
      dir(home, 0o700);
      if (platform === 'darwin') {
        installRoot = join(base, 'Applications', 'SMRT Notes.app');
        executableDir = join(installRoot, 'Contents', 'MacOS');
        resourceDir = join(installRoot, 'Contents', 'Resources');
        shellDir = join(
          home,
          'Library',
          'Application Support',
          BUNDLE,
          '.desktop-shell',
        );
      } else {
        installRoot = join(base, 'usr');
        executableDir = join(installRoot, 'bin');
        resourceDir = join(installRoot, 'lib', PRODUCT);
        shellDir = join(home, '.local', 'share', BUNDLE, '.desktop-shell');
      }
      dir(dirname(installRoot));
      dir(shellDir, 0o700);
      put(join(executableDir, 'smrt-notes'), '', 0o755);
      put(join(executableDir, 'smrt-start-node'), '', 0o755);
      put(join(resourceDir, 'sidecar-manifest.json'), sidecarText, 0o644);
      put(join(resourceDir, 'bridge', 'smrt-mcp-bridge.mjs'), '', 0o644);
      writeBundle();
      writeRecord();
      options = {
        productId: PRODUCT,
        bundleId: BUNDLE,
        platform,
        env: {},
        homeDirectory: home,
      };
      leaks = [base, tmpdir(), 'smrt-desktop-locate'];
    });
    afterEach(() => rmSync(base, { recursive: true, force: true }));

    it('verifies a clean installation and returns frozen, derived paths', async () => {
      const found = await locate();
      expect(found.installRoot).toBe(installRoot);
      expect(found.executableDir).toBe(executableDir);
      expect(found.resourceDir).toBe(resourceDir);
      expect(found.shellExecutable).toBe(join(executableDir, 'smrt-notes'));
      expect(found.nodePath).toBe(join(executableDir, 'smrt-start-node'));
      expect(found.bridgePath).toBe(
        join(resourceDir, 'bridge', 'smrt-mcp-bridge.mjs'),
      );
      expect(found.shellDirectory).toBe(shellDir);
      expect(found.healthRoute).toBe('/api/_runtime/health');
      expect(found.bundle.productId).toBe(PRODUCT);
      expect(found.sidecar.executable).toBe('smrt-start-node');
      expect(found.platform).toBe(platform);
      expect(Object.isFrozen(found)).toBe(true);
      expect(Object.isFrozen(found.sidecar.args)).toBe(true);
    });

    describe('not_installed', () => {
      it('when the app never started', async () => {
        rmSync(join(home, platform === 'darwin' ? 'Library' : '.local'), {
          recursive: true,
        });
        expect(await code(locate(), leaks)).toBe('not_installed');
      });

      it('when the record is missing', async () => {
        rmSync(join(shellDir, 'installation.json'));
        expect(await code(locate(), leaks)).toBe('not_installed');
      });

      it('when the app was uninstalled or moved', async () => {
        rmSync(installRoot, { recursive: true });
        expect(await code(locate(), leaks)).toBe('not_installed');
      });

      it('when the node sidecar is gone', async () => {
        rmSync(join(executableDir, 'smrt-start-node'));
        expect(await code(locate(), leaks)).toBe('not_installed');
      });

      it('when the bridge is gone', async () => {
        rmSync(join(resourceDir, 'bridge'), { recursive: true });
        expect(await code(locate(), leaks)).toBe('not_installed');
      });
    });

    describe('untrusted_path', () => {
      it.each([
        0o750, 0o755, 0o770,
      ])('private directory mode %o', async (mode) => {
        chmodSync(shellDir, mode);
        expect(await code(locate(), leaks)).toBe('untrusted_path');
      });

      it.each([
        0o640, 0o644, 0o666,
      ])('installation.json mode %o', async (mode) => {
        chmodSync(join(shellDir, 'installation.json'), mode);
        expect(await code(locate(), leaks)).toBe('untrusted_path');
      });

      it('installation.json that is a symlink', async () => {
        const real = join(base, 'elsewhere.json');
        put(real, record(), 0o600);
        rmSync(join(shellDir, 'installation.json'));
        symlinkSync(real, join(shellDir, 'installation.json'));
        expect(await code(locate(), leaks)).toBe('untrusted_path');
      });

      it('private directory that is a symlink', async () => {
        const real = join(base, 'real-shell');
        renameSync(shellDir, real);
        symlinkSync(real, shellDir);
        expect(await code(locate(), leaks)).toBe('untrusted_path');
      });

      it('installRoot that is a symlink', async () => {
        const moved = join(base, 'moved-root');
        renameSync(installRoot, moved);
        symlinkSync(moved, installRoot);
        expect(await code(locate(), leaks)).toBe('untrusted_path');
      });

      it('an intermediate directory that is a symlink', async () => {
        const moved = join(base, 'moved-resources');
        renameSync(resourceDir, moved);
        symlinkSync(moved, resourceDir);
        expect(await code(locate(), leaks)).toBe('untrusted_path');
      });

      it.each([
        ['node sidecar', () => join(executableDir, 'smrt-start-node')],
        ['bridge', () => join(resourceDir, 'bridge', 'smrt-mcp-bridge.mjs')],
        ['shell binary', () => join(executableDir, 'smrt-notes')],
        ['bundle manifest', () => join(resourceDir, 'smrt-bundle.json')],
        ['sidecar manifest', () => join(resourceDir, 'sidecar-manifest.json')],
      ])('a symlinked %s', async (_name, target) => {
        const file = target();
        const decoy = join(base, 'decoy');
        renameSync(file, decoy);
        symlinkSync(decoy, file);
        expect(await code(locate(), leaks)).toBe('untrusted_path');
      });

      it('a group-writable directory in the chain', async () => {
        chmodSync(executableDir, 0o775);
        expect(await code(locate(), leaks)).toBe('untrusted_path');
      });

      it('a world-writable installRoot', async () => {
        chmodSync(installRoot, 0o757);
        expect(await code(locate(), leaks)).toBe('untrusted_path');
      });

      it('a writable or non-executable binary', async () => {
        const node = join(executableDir, 'smrt-start-node');
        chmodSync(node, 0o775);
        expect(await code(locate(), leaks)).toBe('untrusted_path');
        chmodSync(node, 0o644);
        expect(await code(locate(), leaks)).toBe('untrusted_path');
      });

      it('a group-writable bridge', async () => {
        chmodSync(join(resourceDir, 'bridge', 'smrt-mcp-bridge.mjs'), 0o664);
        expect(await code(locate(), leaks)).toBe('untrusted_path');
      });

      it('a foreign owner', async () => {
        const mine = process.getuid?.() as number;
        expect(
          await code(locateInstallation({ ...options, currentUid: mine })),
        ).toBe('ok');
        expect(
          await code(
            locateInstallation({ ...options, currentUid: mine + 1 }),
            leaks,
          ),
        ).toBe('untrusted_path');
      });

      it('a recorded layout that escapes installRoot', async () => {
        writeRecord(
          JSON.stringify({
            ...JSON.parse(record()),
            executableDir: dirname(installRoot),
            shellExecutable: join(dirname(installRoot), 'smrt-notes'),
          }),
        );
        expect(await code(locate(), leaks)).toBe('untrusted_path');
      });

      it('a sidecarManifest that names a non-manifest file', async () => {
        writeBundle({ sidecarManifest: 'bridge/smrt-mcp-bridge.mjs' });
        // A regular file, so this fails on content rather than on trust.
        expect(await code(locate(), leaks)).toBe('invalid_document');
      });
    });

    describe('identity', () => {
      it('rejects a record for another product', async () => {
        writeRecord(record({ productId: 'other-product' }));
        expect(await code(locate(), leaks)).toBe('identity_mismatch');
      });

      it('rejects a bundle for another product', async () => {
        writeBundle({ productId: 'other-product' });
        expect(await code(locate(), leaks)).toBe('identity_mismatch');
      });

      it.each([
        ['productVersion', { productVersion: '1.5.0' }],
        ['target', { target: 'aarch64-unknown-linux-gnu' }],
        ['bundleId', { bundleId: 'com.example.other' }],
      ])('rejects an updated-but-not-restarted bundle (%s)', async (_name, change) => {
        writeBundle(change);
        expect(await code(locate(), leaks)).toBe('identity_mismatch');
      });

      it('rejects a record for another platform', async () => {
        const other = platform === 'linux' ? 'darwin' : 'linux';
        expect(
          await code(
            locateInstallation({ ...options, platform: other }),
            leaks,
          ),
        ).not.toBe('ok');
      });

      it('rejects invalid caller input', async () => {
        expect(
          await code(locateInstallation({ ...options, productId: 'Bad Id' })),
        ).toBe('invalid_field');
        expect(
          await code(locateInstallation({ ...options, bundleId: 'bad' })),
        ).toBe('invalid_field');
      });
    });

    describe('documents', () => {
      it('rejects a future record version', async () => {
        writeRecord(JSON.stringify({ ...JSON.parse(record()), version: 2 }));
        expect(await code(locate(), leaks)).toBe('unsupported_contract');
      });

      it('rejects a future bundle version', async () => {
        writeBundle({ version: 2 });
        expect(await code(locate(), leaks)).toBe('unsupported_contract');
      });

      it('rejects a malformed record and an oversized one', async () => {
        writeRecord('{ not json');
        expect(await code(locate(), leaks)).toBe('invalid_json');
        writeRecord(`{"x":"${'a'.repeat(300 * 1024)}"}`);
        expect(await code(locate(), leaks)).toBe('invalid_document');
      });

      it('rejects a bundle whose executable differs from the sidecar', async () => {
        writeBundle({ node: { executable: 'other-node' } });
        expect(await code(locate(), leaks)).toBe('sidecar_mismatch');
      });

      it('rejects an invalid sidecar manifest without echoing it', async () => {
        put(
          join(resourceDir, 'sidecar-manifest.json'),
          '{"secret":"TOKEN-XYZ"}',
          0o644,
        );
        expect(await code(locate(), [...leaks, 'TOKEN-XYZ'])).toBe(
          'invalid_document',
        );
      });
    });
  },
);

describe('locateInstallation on win32 (in-memory filesystem)', () => {
  const local = 'C:\\Users\\u\\AppData\\Local';
  const shellDir = `${local}\\${BUNDLE}\\.desktop-shell`;
  const root = `${local}\\Programs\\SMRT Notes`;
  const target = 'x86_64-pc-windows-msvc';
  const winRecord = (overrides: Record<string, unknown> = {}) =>
    JSON.stringify({
      version: 1,
      productId: PRODUCT,
      bundleId: BUNDLE,
      productVersion: '1.4.0',
      target,
      platform: 'win32',
      installRoot: root,
      executableDir: root,
      resourceDir: root,
      shellExecutable: `${root}\\smrt-notes.exe`,
      recordedAt: RECORDED,
      ...overrides,
    });
  const options = (fs: MemoryFs): LocateInstallationOptions => ({
    productId: PRODUCT,
    bundleId: BUNDLE,
    platform: 'win32',
    env: { LOCALAPPDATA: local },
    homeDirectory: 'C:\\Users\\u',
    fs,
  });
  const build = () => {
    const fs = new MemoryFs()
      .set(`${local}\\${BUNDLE}`, 'dir', { mode: 0o777 })
      .set(shellDir, 'dir', { mode: 0o777 })
      .set(`${shellDir}\\installation.json`, 'file', {
        mode: 0o666,
        content: winRecord(),
      })
      .set(`${local}\\Programs`, 'dir')
      .set(root, 'dir', { uid: 77 })
      .set(`${root}\\bridge`, 'dir')
      .set(`${root}\\smrt-notes.exe`, 'file', { mode: 0o666 })
      .set(`${root}\\smrt-start-node.exe`, 'file', { mode: 0o666 })
      .set(`${root}\\bridge\\smrt-mcp-bridge.mjs`, 'file')
      .set(`${root}\\sidecar-manifest.json`, 'file', { content: sidecarText })
      .set(`${root}\\smrt-bundle.json`, 'file', {
        content: serializeBundleManifest({ ...bundleBase, target }),
      });
    return fs;
  };

  it('verifies lexically, appends .exe and ignores POSIX ownership bits', async () => {
    const found = await locateInstallation(options(build()));
    expect(found.nodePath).toBe(`${root}\\smrt-start-node.exe`);
    expect(found.bridgePath).toBe(`${root}\\bridge\\smrt-mcp-bridge.mjs`);
    expect(found.shellExecutable).toBe(`${root}\\smrt-notes.exe`);
    expect(found.shellDirectory).toBe(shellDir);
    expect(found.platform).toBe('win32');
  });

  it('reports a missing sidecar executable as not_installed', async () => {
    const fs = build();
    fs.nodes.delete(`${root}\\smrt-start-node.exe`);
    expect(await code(locateInstallation(options(fs)))).toBe('not_installed');
  });

  it('rejects a junction or symlink anywhere in the chain', async () => {
    const fs = build();
    fs.set(`${root}\\bridge`, 'symlink');
    expect(await code(locateInstallation(options(fs)))).toBe('untrusted_path');
  });

  it.each([
    ['UNC', '\\\\server\\share\\App'],
    ['device', '\\\\?\\C:\\App'],
    ['drive-relative', 'C:App'],
    ['forward slashes', 'C:/App'],
  ])('rejects a %s recorded path', async (_name, installRoot) => {
    const fs = build();
    fs.set(`${shellDir}\\installation.json`, 'file', {
      mode: 0o666,
      content: winRecord({ installRoot }),
    });
    expect(await code(locateInstallation(options(fs)))).toBe('invalid_field');
  });

  it('rejects a record whose platform is not win32', async () => {
    const fs = build();
    fs.set(`${shellDir}\\installation.json`, 'file', {
      content: JSON.stringify({
        ...JSON.parse(winRecord()),
        platform: 'linux',
        installRoot: '/usr',
        executableDir: '/usr/bin',
        resourceDir: '/usr/lib/x',
        shellExecutable: '/usr/bin/smrt-notes',
      }),
    });
    expect(await code(locateInstallation(options(fs)))).toBe(
      'identity_mismatch',
    );
  });

  it('requires LOCALAPPDATA', async () => {
    const fs = build();
    expect(
      await code(
        locateInstallation({ ...options(fs), env: { APPDATA: 'C:\\Roaming' } }),
      ),
    ).toBe('invalid_environment');
  });

  it('does not leak recorded paths in errors', async () => {
    const fs = build();
    fs.nodes.delete(`${root}\\smrt-start-node.exe`);
    expect(
      await code(locateInstallation(options(fs)), [
        'SMRT Notes',
        'AppData',
        'smrt-start-node',
      ]),
    ).toBe('not_installed');
  });
});
