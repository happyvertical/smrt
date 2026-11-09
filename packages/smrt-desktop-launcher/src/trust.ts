/**
 * Validation of the provider's installed-runtime description.
 *
 * Shape and contract problems are `unsupported_contract`; a wrong product is
 * `missing_install`; any path or filesystem problem is `untrusted_runtime`.
 * Executables are never resolved through `PATH` and never through a shell.
 *
 * @packageDocumentation
 */

import { access, constants, lstat, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, normalize, parse, relative, sep } from 'node:path';
import { LauncherFailure } from './failure.js';
import type { InstalledRuntime } from './provider.js';

const ENV_PREFIX = /^[A-Z][A-Z0-9_]{0,63}$/u;
const ROUTE_SEGMENT = /^[A-Za-z0-9._~-]+$/u;
const IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/u;
const PRODUCT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const MAX_PATH_LENGTH = 4096;

/** A health route in the sidecar manifest's `healthRoute` form. */
export function isHealthRoute(value: unknown): value is string {
  if (typeof value !== 'string' || !value.startsWith('/')) return false;
  if (value === '/') return true;
  return value
    .slice(1, value.endsWith('/') ? -1 : undefined)
    .split('/')
    .every(
      (segment) =>
        ROUTE_SEGMENT.test(segment) && segment !== '.' && segment !== '..',
    );
}

/** A same-server absolute endpoint path (no `//`, backslash, query or fragment). */
export function isMcpPath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.startsWith('/') &&
    !value.startsWith('//') &&
    !/[\\?#\s%]/u.test(value) &&
    value.length <= 256
  );
}

function fail(code: ConstructorParameters<typeof LauncherFailure>[0]): never {
  throw new LauncherFailure(code);
}

/**
 * Check the provider-supplied description before touching the filesystem.
 * Returns the validated value; throws {@link LauncherFailure}.
 */
export function validateInstall(
  value: unknown,
  expected: {
    readonly productId: string;
    readonly supportedContracts: readonly number[];
  },
): InstalledRuntime {
  if (typeof value !== 'object' || value === null) fail('unsupported_contract');
  const install = value as Record<string, unknown>;
  if (
    typeof install.contract !== 'number' ||
    !expected.supportedContracts.includes(install.contract)
  ) {
    fail('unsupported_contract');
  }
  if (
    typeof install.productId !== 'string' ||
    !PRODUCT_ID.test(install.productId)
  ) {
    fail('unsupported_contract');
  }
  if (install.productId !== expected.productId) fail('missing_install');
  for (const key of ['root', 'nodePath', 'bridgePath'] as const) {
    if (typeof install[key] !== 'string') fail('unsupported_contract');
  }
  if (
    typeof install.envPrefix !== 'string' ||
    !ENV_PREFIX.test(install.envPrefix) ||
    !isHealthRoute(install.healthRoute) ||
    (install.mcpPath !== undefined && !isMcpPath(install.mcpPath))
  ) {
    fail('unsupported_contract');
  }
  for (const key of ['serverName', 'serverVersion'] as const) {
    const identity = install[key];
    if (
      identity !== undefined &&
      (typeof identity !== 'string' || !IDENTITY.test(identity))
    ) {
      fail('unsupported_contract');
    }
  }
  // Snapshot: a provider that keeps a reference cannot change the validated
  // values between the checks and the spawn.
  return Object.freeze({
    contract: install.contract,
    productId: install.productId,
    root: install.root as string,
    nodePath: install.nodePath as string,
    bridgePath: install.bridgePath as string,
    healthRoute: install.healthRoute,
    envPrefix: install.envPrefix,
    ...(install.mcpPath !== undefined
      ? { mcpPath: install.mcpPath as string }
      : {}),
    ...(install.serverName !== undefined
      ? { serverName: install.serverName as string }
      : {}),
    ...(install.serverVersion !== undefined
      ? { serverVersion: install.serverVersion as string }
      : {}),
  });
}

/** An absolute, already-normalised path with no NUL and no relative segments. */
function isCanonicalAbsolute(path: string): boolean {
  return (
    path.length > 0 &&
    path.length <= MAX_PATH_LENGTH &&
    !path.includes('\0') &&
    !path.startsWith('\\\\') &&
    isAbsolute(path) &&
    normalize(path) === path &&
    (path === parse(path).root || !path.endsWith(sep))
  );
}

/** The canonical (symlink-free) locations that were actually verified. */
export interface VerifiedPaths {
  readonly root: string;
  readonly nodePath: string;
  readonly bridgePath: string;
}

/**
 * Verify that the Node executable and the bridge entry are real files inside
 * the trusted install root, reached without a symlink, and (on POSIX) owned
 * by the current user or root and not writable by group or others, as is
 * every directory from the root down to them.
 *
 * Residual risk: a file can still be swapped between this check and the
 * spawn by a process running as the same user. Same-user code can already
 * read the credential, so the check defends against other users and against
 * a mis-provisioned or mis-resolved path, not against a hostile same-user
 * process.
 */
export async function verifyRuntimeFiles(
  install: InstalledRuntime,
  platform: NodeJS.Platform = process.platform,
): Promise<VerifiedPaths> {
  try {
    const { root, nodePath, bridgePath } = install;
    for (const path of [root, nodePath, bridgePath]) {
      if (!isCanonicalAbsolute(path)) fail('untrusted_runtime');
    }
    const posix = platform !== 'win32';
    const uid = posix ? process.getuid?.() : undefined;
    const checkOwnerAndMode = (info: { uid: number; mode: number }) => {
      if (!posix) return;
      if (uid !== undefined && info.uid !== uid && info.uid !== 0) {
        fail('untrusted_runtime');
      }
      if ((info.mode & 0o022) !== 0) fail('untrusted_runtime');
    };

    const realRoot = await realpath(root);
    const rootInfo = await stat(realRoot);
    if (!rootInfo.isDirectory()) fail('untrusted_runtime');
    checkOwnerAndMode(rootInfo);

    const checkedDirectories = new Set<string>();
    const verified: { nodePath?: string; bridgePath?: string } = {};
    for (const [path, executable, key] of [
      [nodePath, true, 'nodePath'],
      [bridgePath, false, 'bridgePath'],
    ] as const) {
      const rel = relative(root, path);
      if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`)) {
        fail('untrusted_runtime');
      }
      if (isAbsolute(rel)) fail('untrusted_runtime');
      // No component below the root may be a symlink.
      if ((await realpath(path)) !== join(realRoot, rel)) {
        fail('untrusted_runtime');
      }
      const segments = rel.split(sep);
      let current = realRoot;
      for (const segment of segments.slice(0, -1)) {
        current = join(current, segment);
        if (checkedDirectories.has(current)) continue;
        const info = await lstat(current);
        if (!info.isDirectory()) fail('untrusted_runtime');
        checkOwnerAndMode(info);
        checkedDirectories.add(current);
      }
      const info = await lstat(join(realRoot, rel));
      if (!info.isFile()) fail('untrusted_runtime');
      checkOwnerAndMode(info);
      if (executable) {
        await access(
          join(realRoot, rel),
          posix ? constants.X_OK : constants.F_OK,
        );
      } else {
        await access(join(realRoot, rel), constants.R_OK);
      }
      verified[key] = join(realRoot, rel);
    }
    return {
      root: realRoot,
      nodePath: verified.nodePath as string,
      bridgePath: verified.bridgePath as string,
    };
  } catch {
    // Collapse fs errors (ENOENT, EACCES, ...) into the one fixed diagnostic.
    fail('untrusted_runtime');
  }
}
