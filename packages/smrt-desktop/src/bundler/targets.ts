/**
 * The closed table of bundle targets (design section 2.1, v1).
 *
 * Supported: macOS arm64 and x64, Linux x64 and arm64 on glibc, Windows x64
 * and arm64. Not supported, by design: musl (Node publishes no official musl
 * build), `universal-apple-darwin` (Node ships no universal binary), 32-bit
 * anything. `aarch64-pc-windows-msvc` is in the table but a product only
 * bundles when every native dependency publishes win32-arm64 prebuilds; the
 * native verifier is what reports that.
 *
 * Everything here is pure data plus string builders. User strings never reach
 * a URL or path unvalidated: the version must be `MAJOR.MINOR.PATCH`, the
 * triple must be a key of the table, and the sidecar name must be a slug.
 */

import { isSlug } from '../internal/grammar.js';
import { NativeVerificationError } from './native/errors.js';
import type { NativeFormat } from './native/types.js';

/** Every supported Rust target triple. */
export const SUPPORTED_TARGET_TRIPLES = [
  'aarch64-apple-darwin',
  'x86_64-apple-darwin',
  'x86_64-unknown-linux-gnu',
  'aarch64-unknown-linux-gnu',
  'x86_64-pc-windows-msvc',
  'aarch64-pc-windows-msvc',
] as const;

export type TargetTriple = (typeof SUPPORTED_TARGET_TRIPLES)[number];

/** What a bundle target requires of every native file in the output. */
export interface NativeExpectation {
  /** Container format; a fat Mach-O satisfies `macho` when it has the slice. */
  readonly format: Exclude<NativeFormat, 'macho-fat'>;
  readonly machine: 'arm64' | 'x86_64';
  /** Linux only: the C library the target runs on. */
  readonly libc?: 'glibc';
}

/** One row of the target table. */
export interface TargetSpec {
  readonly triple: TargetTriple;
  readonly nodePlatform: 'darwin' | 'linux' | 'win32';
  readonly nodeArch: 'arm64' | 'x64';
  /** The `--os/--cpu/--libc` values pnpm takes. */
  readonly pnpm: {
    readonly os: 'darwin' | 'linux' | 'win32';
    readonly cpu: 'arm64' | 'x64';
    readonly libc?: 'glibc';
  };
  /**
   * How nodejs.org distributes Node for this target: a `.tar.gz` holding the
   * `bin/node` member, or a standalone `node.exe`.
   */
  readonly nodeDist: {
    readonly format: 'tar.gz' | 'exe';
    /** `darwin-arm64`, `linux-x64`, `win-x64`, ... */
    readonly platformDir: string;
  };
  readonly exeSuffix: '' | '.exe';
  readonly native: NativeExpectation;
}

function row(spec: TargetSpec): TargetSpec {
  return Object.freeze({
    ...spec,
    pnpm: Object.freeze({ ...spec.pnpm }),
    nodeDist: Object.freeze({ ...spec.nodeDist }),
    native: Object.freeze({ ...spec.native }),
  });
}

const TABLE: Readonly<Record<TargetTriple, TargetSpec>> = Object.freeze({
  'aarch64-apple-darwin': row({
    triple: 'aarch64-apple-darwin',
    nodePlatform: 'darwin',
    nodeArch: 'arm64',
    pnpm: { os: 'darwin', cpu: 'arm64' },
    nodeDist: { format: 'tar.gz', platformDir: 'darwin-arm64' },
    exeSuffix: '',
    native: { format: 'macho', machine: 'arm64' },
  }),
  'x86_64-apple-darwin': row({
    triple: 'x86_64-apple-darwin',
    nodePlatform: 'darwin',
    nodeArch: 'x64',
    pnpm: { os: 'darwin', cpu: 'x64' },
    nodeDist: { format: 'tar.gz', platformDir: 'darwin-x64' },
    exeSuffix: '',
    native: { format: 'macho', machine: 'x86_64' },
  }),
  'x86_64-unknown-linux-gnu': row({
    triple: 'x86_64-unknown-linux-gnu',
    nodePlatform: 'linux',
    nodeArch: 'x64',
    pnpm: { os: 'linux', cpu: 'x64', libc: 'glibc' },
    nodeDist: { format: 'tar.gz', platformDir: 'linux-x64' },
    exeSuffix: '',
    native: { format: 'elf', machine: 'x86_64', libc: 'glibc' },
  }),
  'aarch64-unknown-linux-gnu': row({
    triple: 'aarch64-unknown-linux-gnu',
    nodePlatform: 'linux',
    nodeArch: 'arm64',
    pnpm: { os: 'linux', cpu: 'arm64', libc: 'glibc' },
    nodeDist: { format: 'tar.gz', platformDir: 'linux-arm64' },
    exeSuffix: '',
    native: { format: 'elf', machine: 'arm64', libc: 'glibc' },
  }),
  'x86_64-pc-windows-msvc': row({
    triple: 'x86_64-pc-windows-msvc',
    nodePlatform: 'win32',
    nodeArch: 'x64',
    pnpm: { os: 'win32', cpu: 'x64' },
    nodeDist: { format: 'exe', platformDir: 'win-x64' },
    exeSuffix: '.exe',
    native: { format: 'pe', machine: 'x86_64' },
  }),
  'aarch64-pc-windows-msvc': row({
    triple: 'aarch64-pc-windows-msvc',
    nodePlatform: 'win32',
    nodeArch: 'arm64',
    pnpm: { os: 'win32', cpu: 'arm64' },
    nodeDist: { format: 'exe', platformDir: 'win-arm64' },
    exeSuffix: '.exe',
    native: { format: 'pe', machine: 'arm64' },
  }),
});

/** The full target table, frozen. */
export const TARGETS: readonly TargetSpec[] = Object.freeze(
  SUPPORTED_TARGET_TRIPLES.map((triple) => TABLE[triple]),
);

/** True when `value` is exactly one of the supported triples. */
export function isSupportedTarget(value: unknown): value is TargetTriple {
  return (
    typeof value === 'string' &&
    Object.hasOwn(TABLE, value) &&
    (SUPPORTED_TARGET_TRIPLES as readonly string[]).includes(value)
  );
}

/** The table row for a supported triple; throws `unsupported_target`. */
export function parseTargetTriple(value: unknown): TargetSpec {
  if (!isSupportedTarget(value)) {
    throw new NativeVerificationError('unsupported_target');
  }
  return TABLE[value];
}

/**
 * The triple for a Node `platform`/`arch` pair, or `undefined` when it is not
 * a supported target. Linux maps to the glibc triple: a caller on a musl host
 * must refuse it itself, because the platform string does not say.
 */
export function hostTargetTriple(
  platform: string,
  arch: string,
): TargetTriple | undefined {
  return TARGETS.find(
    (spec) => spec.nodePlatform === platform && spec.nodeArch === arch,
  )?.triple;
}

const nodeVersion = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;

function assertNodeVersion(version: unknown): asserts version is string {
  if (
    typeof version !== 'string' ||
    version.length > 32 ||
    !nodeVersion.test(version)
  ) {
    throw new NativeVerificationError('invalid_node_version');
  }
}

/**
 * The file name as listed in nodejs.org's `SHASUMS256.txt`:
 * `node-v26.8.1-darwin-arm64.tar.gz` or `win-x64/node.exe`.
 */
export function nodeDistFile(spec: TargetSpec, version: string): string {
  assertNodeVersion(version);
  return spec.nodeDist.format === 'exe'
    ? `${spec.nodeDist.platformDir}/node.exe`
    : `node-v${version}-${spec.nodeDist.platformDir}.tar.gz`;
}

/** The archive member that is the Node binary; `undefined` for a bare exe. */
export function nodeDistBinaryMember(
  spec: TargetSpec,
  version: string,
): string | undefined {
  assertNodeVersion(version);
  return spec.nodeDist.format === 'exe'
    ? undefined
    : `node-v${version}-${spec.nodeDist.platformDir}/bin/node`;
}

/** The archive member holding Node's LICENSE; `undefined` for a bare exe. */
export function nodeDistLicenseMember(
  spec: TargetSpec,
  version: string,
): string | undefined {
  assertNodeVersion(version);
  return spec.nodeDist.format === 'exe'
    ? undefined
    : `node-v${version}-${spec.nodeDist.platformDir}/LICENSE`;
}

/**
 * The Tauri `externalBin` file name for a sidecar: tauri-build requires
 * `<name>-<target-triple>[.exe]` next to the config's `binaries/` entry.
 * `productNodeName` is the sidecar manifest `executable` (a slug such as
 * `smrt-start-node`).
 */
export function externalBinName(
  productNodeName: string,
  triple: TargetTriple,
): string {
  if (!isSlug(productNodeName)) {
    throw new NativeVerificationError('invalid_product_name');
  }
  const spec = parseTargetTriple(triple);
  return `${productNodeName}-${spec.triple}${spec.exeSuffix}`;
}

/** `binaries/<externalBinName>`, relative to the bundle output root. */
export function externalBinPath(
  productNodeName: string,
  triple: TargetTriple,
): string {
  return `binaries/${externalBinName(productNodeName, triple)}`;
}
