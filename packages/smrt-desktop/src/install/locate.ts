import { DesktopContractError } from '../errors.js';
import {
  type AbsolutePath,
  appendSegments,
  assertTrustedChain,
  flavorOf,
  formatAbsolutePath,
  isInside,
} from '../internal/abs-path.js';
import { deepFreeze } from '../internal/freeze.js';
import { type DesktopFs, FsTrustError, nodeFs } from '../internal/fs-seam.js';
import { isBundleId, isSlug } from '../internal/grammar.js';
import {
  assertPrivateDirectory,
  type FileCustodyOptions,
  readPrivateFile,
  readTrustedFile,
} from '../internal/private-file.js';
import {
  parseSidecarManifest,
  type SidecarManifestV1,
} from '../sidecar-manifest.js';
import {
  assertBundleMatchesSidecar,
  BUNDLE_MANIFEST_FILENAME,
  type BundleManifestV1,
  parseBundleManifest,
} from './bundle-manifest.js';
import {
  INSTALLATION_RECORD_FILENAME,
  type InstallationRecordV1,
  installationPaths,
  parseInstallationRecord,
} from './installation-record.js';
import { resolveDesktopShellDir } from './locations.js';

export interface LocateInstallationOptions {
  /** Product slug the caller expects, from compiled-in launcher data. */
  readonly productId: string;
  /** Tauri identifier the caller expects. */
  readonly bundleId: string;
  /** Defaults to `process.platform`. */
  readonly platform?: NodeJS.Platform;
  /** Defaults to `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Defaults to `HOME`, then `os.homedir()`. */
  readonly homeDirectory?: string;
  /** Effective uid. Defaults to `process.getuid()`; ignored on Windows. */
  readonly currentUid?: number;
  /** Filesystem seam for tests. Defaults to `node:fs/promises`. */
  readonly fs?: DesktopFs;
}

/**
 * An installation whose identity, layout and filesystem trust were verified
 * by `locateInstallation`. This is what consumers (launcher, rendezvous) use.
 */
export interface VerifiedInstallation {
  readonly platform: NodeJS.Platform;
  readonly bundle: BundleManifestV1;
  readonly sidecar: SidecarManifestV1;
  readonly installRoot: string;
  readonly executableDir: string;
  readonly resourceDir: string;
  readonly shellExecutable: string;
  /** The verified private state directory, `<app_local_data_dir>/.desktop-shell`. */
  readonly shellDirectory: string;
  /** `executableDir/<node.executable>`, with `.exe` appended on Windows. */
  readonly nodePath: string;
  /** `resourceDir/<bridge.entry>`. */
  readonly bridgePath: string;
  /** Sidecar manifest `healthRoute`. */
  readonly healthRoute: string;
}

const maxManifestBytes = 256 * 1024;

/** Map a filesystem failure to this contract's public error. */
function fail(error: unknown): never {
  if (error instanceof FsTrustError) {
    switch (error.kind) {
      case 'absent':
        throw new DesktopContractError('not_installed');
      case 'untrusted':
      case 'unreadable':
        throw new DesktopContractError('untrusted_path');
      default:
        throw new DesktopContractError('invalid_document');
    }
  }
  throw error;
}

/**
 * Find and verify the installed product. Steps:
 *
 * 1. Read `installation.json` from the private state directory (must be a
 *    real 0700 directory owned by the user; the file must be a 0600 regular
 *    file opened without following symlinks). Absent => `not_installed`.
 * 2. Compare its identity and platform with the caller's expectation.
 * 3. Re-read `smrt-bundle.json` and the sidecar manifest from the recorded
 *    resource directory and compare identity and version with the record.
 *    A mismatch => `identity_mismatch` (benign when the app was updated and
 *    has not restarted yet: start the shell and retry).
 * 4. Re-derive `nodePath` and `bridgePath` lexically and require them, the
 *    resource directory and the shell binary to stay inside `installRoot`.
 * 5. Walk every component from `installRoot` to each file: no symlink
 *    anywhere, owned by the user or root, not group/other writable, regular
 *    files, execute bit on the Node sidecar and the shell binary.
 *
 * Throws only `DesktopContractError`: `not_installed`, `identity_mismatch`,
 * `untrusted_path`, `unsupported_contract`, `sidecar_mismatch`, or an
 * `invalid_*` code for a malformed document. Messages are fixed text.
 *
 * There is no scan of well-known install locations, and AppImage is not
 * supported in v1: a credential can only exist after the owner used the app,
 * so the app has necessarily written its record at least once.
 */
export async function locateInstallation(
  options: LocateInstallationOptions,
): Promise<VerifiedInstallation> {
  const platform = options.platform ?? process.platform;
  const flavor = flavorOf(platform);
  if (!isSlug(options.productId)) {
    throw new DesktopContractError('invalid_field', { field: 'productId' });
  }
  if (!isBundleId(options.bundleId)) {
    throw new DesktopContractError('invalid_field', { field: 'bundleId' });
  }

  const fs = options.fs ?? nodeFs;
  const custody: FileCustodyOptions = {
    fs,
    platform,
    currentUid:
      'currentUid' in options ? options.currentUid : process.getuid?.(),
    maxBytes: maxManifestBytes,
  };
  const uid = custody.currentUid;
  const separator = flavor === 'win32' ? '\\' : '/';

  const shellDirectory = resolveDesktopShellDir(options.bundleId, {
    platform,
    env: options.env,
    home: options.homeDirectory,
  });

  let record: InstallationRecordV1;
  try {
    await assertPrivateDirectory(shellDirectory, custody);
    record = parseInstallationRecord(
      await readPrivateFile(
        `${shellDirectory}${separator}${INSTALLATION_RECORD_FILENAME}`,
        custody,
      ),
    );
  } catch (error) {
    return fail(error);
  }
  if (
    record.productId !== options.productId ||
    record.bundleId !== options.bundleId ||
    record.platform !== platform
  ) {
    throw new DesktopContractError('identity_mismatch');
  }

  const paths = installationPaths(record);
  const { installRoot } = paths;
  const readInside = async (path: AbsolutePath): Promise<string> => {
    try {
      await assertTrustedChain(installRoot, path, {
        fs,
        platform,
        uid,
        leaf: 'file',
      });
      return await readTrustedFile(formatAbsolutePath(path), custody);
    } catch (error) {
      return fail(error);
    }
  };

  const bundle = parseBundleManifest(
    await readInside(
      appendSegments(paths.resourceDir, [BUNDLE_MANIFEST_FILENAME]),
    ),
  );
  if (
    bundle.productId !== record.productId ||
    bundle.bundleId !== record.bundleId ||
    bundle.productVersion !== record.productVersion ||
    bundle.target !== record.target
  ) {
    throw new DesktopContractError('identity_mismatch');
  }

  const sidecarPath = appendSegments(
    paths.resourceDir,
    bundle.sidecarManifest.split('/'),
  );
  if (!isInside(installRoot, sidecarPath)) {
    throw new DesktopContractError('untrusted_path');
  }
  let sidecar: SidecarManifestV1;
  try {
    sidecar = parseSidecarManifest(await readInside(sidecarPath));
  } catch (error) {
    if (error instanceof DesktopContractError) throw error;
    throw new DesktopContractError('invalid_document', {
      field: 'sidecarManifest',
    });
  }
  assertBundleMatchesSidecar(bundle, sidecar);

  const nodeName = `${bundle.node.executable}${platform === 'win32' ? '.exe' : ''}`;
  const nodePath = appendSegments(paths.executableDir, [nodeName]);
  const bridgePath = appendSegments(
    paths.resourceDir,
    bundle.bridge.entry.split('/'),
  );
  for (const derived of [nodePath, bridgePath]) {
    if (!isInside(installRoot, derived)) {
      throw new DesktopContractError('untrusted_path');
    }
  }

  try {
    const base = { fs, platform, uid, leaf: 'file' } as const;
    await assertTrustedChain(installRoot, nodePath, {
      ...base,
      executable: true,
    });
    await assertTrustedChain(installRoot, bridgePath, base);
    await assertTrustedChain(installRoot, paths.shellExecutable, {
      ...base,
      executable: true,
    });
  } catch (error) {
    return fail(error);
  }

  return deepFreeze({
    platform,
    bundle,
    sidecar: {
      ...sidecar,
      args: [...sidecar.args],
      ...(sidecar.env === undefined ? {} : { env: { ...sidecar.env } }),
    },
    installRoot: record.installRoot,
    executableDir: record.executableDir,
    resourceDir: record.resourceDir,
    shellExecutable: record.shellExecutable,
    shellDirectory,
    nodePath: formatAbsolutePath(nodePath),
    bridgePath: formatAbsolutePath(bridgePath),
    healthRoute: sidecar.healthRoute,
  });
}
