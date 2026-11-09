import { DesktopContractError } from '../errors.js';
import {
  type AbsolutePath,
  appendSegments,
  flavorOf,
  isInside,
  parentOf,
  parseAbsolutePath,
  samePath,
} from '../internal/abs-path.js';
import { deepFreeze } from '../internal/freeze.js';
import {
  isBundleId,
  isIsoUtcTimestamp,
  isSemver,
  isSlug,
  isTargetTriple,
} from '../internal/grammar.js';
import {
  hasClosedKeys,
  isRecord,
  parseStrictJson,
} from '../internal/strict-json.js';

/** File name of the installation record in the private state directory. */
export const INSTALLATION_RECORD_FILENAME = 'installation.json';

export type InstallationPlatform = 'darwin' | 'win32' | 'linux';

const platforms: readonly string[] = ['darwin', 'win32', 'linux'];

/**
 * Absolute paths the desktop shell is running from, written by the shell on
 * every start into `<app_local_data_dir>/.desktop-shell/installation.json`.
 * It is a pointer and a hint, never trusted on its own: consumers re-read the
 * bundle manifest from `resourceDir` and verify every path.
 */
export interface InstallationRecordV1 {
  readonly version: 1;
  readonly productId: string;
  readonly bundleId: string;
  readonly productVersion: string;
  readonly target: string;
  readonly platform: InstallationPlatform;
  /** `X.app`, the install directory, or `/usr` for `.deb` and `.rpm`. */
  readonly installRoot: string;
  /** Directory of the shell binary and the `externalBin` sidecars. */
  readonly executableDir: string;
  /** Tauri resource directory. */
  readonly resourceDir: string;
  /** The shell binary, used to start the app without a window. */
  readonly shellExecutable: string;
  /** ISO-8601 UTC. Informational only. */
  readonly recordedAt: string;
}

const requiredKeys = [
  'version',
  'productId',
  'bundleId',
  'productVersion',
  'target',
  'platform',
  'installRoot',
  'executableDir',
  'resourceDir',
  'shellExecutable',
  'recordedAt',
] as const satisfies readonly (keyof InstallationRecordV1)[];
const pathFields = [
  'installRoot',
  'executableDir',
  'resourceDir',
  'shellExecutable',
] as const;

function invalid(field: string): DesktopContractError {
  return new DesktopContractError('invalid_field', { field });
}

/** The four record paths, parsed for the record's platform. */
export interface InstallationPaths {
  readonly installRoot: AbsolutePath;
  readonly executableDir: AbsolutePath;
  readonly resourceDir: AbsolutePath;
  readonly shellExecutable: AbsolutePath;
}

/**
 * Parse the record's paths lexically and enforce the layout rules:
 * `executableDir` and `resourceDir` are inside `installRoot` (or equal to it),
 * `shellExecutable` is a direct child of `executableDir`, `installRoot` is not
 * a filesystem root, and on macOS the layout is exactly
 * `X.app/Contents/{MacOS,Resources}`. Throws `invalid_field` for a malformed
 * path and `untrusted_path` for a layout violation.
 */
export function installationPaths(
  record: Pick<InstallationRecordV1, (typeof pathFields)[number] | 'platform'>,
): InstallationPaths {
  const flavor = flavorOf(record.platform);
  const parsed: Partial<Record<(typeof pathFields)[number], AbsolutePath>> = {};
  for (const field of pathFields) {
    const path = parseAbsolutePath(record[field], flavor);
    if (path === null) throw invalid(field);
    parsed[field] = path;
  }
  const { installRoot, executableDir, resourceDir, shellExecutable } =
    parsed as InstallationPaths;

  const untrusted = () => new DesktopContractError('untrusted_path');
  if (installRoot.segments.length === 0) throw untrusted();
  if (!isInside(installRoot, executableDir, true)) throw untrusted();
  if (!isInside(installRoot, resourceDir, true)) throw untrusted();
  const shellParent = parentOf(shellExecutable);
  if (shellParent === null || !samePath(shellParent, executableDir)) {
    throw untrusted();
  }

  if (record.platform === 'darwin') {
    const name = installRoot.segments[installRoot.segments.length - 1] ?? '';
    if (!name.endsWith('.app') || name.length <= '.app'.length) {
      throw untrusted();
    }
    const macOs = appendSegments(installRoot, ['Contents', 'MacOS']);
    const resources = appendSegments(installRoot, ['Contents', 'Resources']);
    if (!samePath(executableDir, macOs) || !samePath(resourceDir, resources)) {
      throw untrusted();
    }
  }
  return { installRoot, executableDir, resourceDir, shellExecutable };
}

function validateInstallationRecord(input: unknown): InstallationRecordV1 {
  if (!isRecord(input)) throw new DesktopContractError('invalid_document');
  if (!Object.hasOwn(input, 'version')) {
    throw new DesktopContractError('invalid_document');
  }
  if (input.version !== 1) {
    throw new DesktopContractError('unsupported_contract');
  }
  if (!hasClosedKeys(input, requiredKeys)) {
    throw new DesktopContractError('invalid_document');
  }

  const { productId, bundleId, productVersion, target, platform, recordedAt } =
    input;
  if (!isSlug(productId)) throw invalid('productId');
  if (!isBundleId(bundleId)) throw invalid('bundleId');
  if (!isSemver(productVersion)) throw invalid('productVersion');
  if (!isTargetTriple(target)) throw invalid('target');
  if (typeof platform !== 'string' || !platforms.includes(platform)) {
    throw invalid('platform');
  }
  if (!isIsoUtcTimestamp(recordedAt)) throw invalid('recordedAt');

  const record = {
    version: 1,
    productId,
    bundleId,
    productVersion,
    target,
    platform: platform as InstallationPlatform,
    installRoot: input.installRoot as string,
    executableDir: input.executableDir as string,
    resourceDir: input.resourceDir as string,
    shellExecutable: input.shellExecutable as string,
    recordedAt,
  } as const;
  installationPaths(record);
  return deepFreeze(record);
}

/**
 * Parse `installation.json`. Throws a `DesktopContractError` with a fixed,
 * value-free message: `invalid_json`, `duplicate_keys`, `unsupported_contract`,
 * `invalid_document`, `invalid_field` or `untrusted_path` (layout violation).
 */
export function parseInstallationRecord(json: string): InstallationRecordV1 {
  if (typeof json !== 'string') {
    throw new DesktopContractError('invalid_json');
  }
  const parsed = parseStrictJson(json);
  if (!parsed.ok) {
    throw new DesktopContractError(
      parsed.reason === 'syntax' ? 'invalid_json' : 'duplicate_keys',
    );
  }
  return validateInstallationRecord(parsed.value);
}

/** Serialize a validated record as canonical JSON with a trailing newline. */
export function serializeInstallationRecord(
  record: InstallationRecordV1,
): string {
  const r = validateInstallationRecord(record);
  return `${JSON.stringify(
    {
      version: r.version,
      productId: r.productId,
      bundleId: r.bundleId,
      productVersion: r.productVersion,
      target: r.target,
      platform: r.platform,
      installRoot: r.installRoot,
      executableDir: r.executableDir,
      resourceDir: r.resourceDir,
      shellExecutable: r.shellExecutable,
      recordedAt: r.recordedAt,
    },
    null,
    2,
  )}\n`;
}
