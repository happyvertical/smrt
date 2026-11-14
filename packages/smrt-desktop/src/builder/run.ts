/**
 * `runBuild(plan, seams)`: `smrt desktop build` (smrt#4965).
 *
 * Stages, in order, each reported to `seams.onStage`:
 *
 *  1. `inputs`       the product configuration (`smrt-desktop.json`), the
 *                    runtime bundle (report, digest list, fragment), the
 *                    wrapper version against the package version, the Tauri
 *                    CLI version, the output directory.
 *  2. `materialize`  the packaged wrapper is copied into a scratch directory
 *                    beside the output. The installed package is never
 *                    written to.
 *  3. `stage_bundle` the digest-verified bundle files go to `binaries/` and
 *                    `resources/` (what `tauri.bundle.json` points at).
 *  4. `configure`    the product icons are copied in and one config overlay is
 *                    written from the product identity, the icons, the bundle
 *                    fragment and the updater public key. Nothing here
 *                    defaults or generates an owner input.
 *  5. `tauri_build`  `tauri build --no-sign --target <triple> --config ...
 *                    -- --locked`: UNSIGNED. Signing is not part of this
 *                    command (see the README: the signed release path stays
 *                    in desktop-release.yml).
 *  6. `smoke`        optional: debug build of the wrapper plus
 *                    `launch-smoke.mjs` against the bundle (host target only).
 *  7. `collect`      the installer is moved to the output directory.
 *
 * Every external effect is a seam (`BuildSeams`): the filesystem, child
 * processes and the host description, so the pipeline runs offline in tests
 * with fakes and a test never starts tauri or cargo. A failure removes the
 * scratch directory and leaves the output path untouched (it is only written
 * in `collect`). Secrets: the child environment is an allowlist; no signing
 * variable and no token ever reaches tauri or cargo.
 */

import { createHash } from 'node:crypto';
import { join, posix, resolve } from 'node:path';
import { parseProductConfig } from '../bundler/product-config.js';
import {
  BUNDLE_FILES_FILENAME,
  BUNDLE_REPORT_FILENAME,
  type BundleReportV1,
  parseBundleReport,
} from '../bundler/report.js';
import { isSupportedTarget, type TargetTriple } from '../bundler/targets.js';
import { parseStrictJson } from '../internal/strict-json.js';
import {
  INSTALLER_KINDS,
  PRODUCT_ICON_DIR,
  SCRATCH_OVERLAY,
  TAURI_CLI_VERSION,
  WRAPPER_DIRS,
  WRAPPER_FILES,
  WRAPPER_SCRIPTS,
} from './constants.js';
import { BUILD_STAGES, BuildError, type BuildStage } from './errors.js';

// ---------------------------------------------------------------------------
// Seams
// ---------------------------------------------------------------------------

export type EntryKind = 'file' | 'dir' | 'missing' | 'other';

/** The filesystem the build uses. `kind` is `lstat`-based: a symlink is `other`. */
export interface BuildFs {
  kind(path: string): Promise<EntryKind>;
  /** A regular file's bytes; refuses larger than `maxBytes`. */
  readFile(path: string, maxBytes: number): Promise<Uint8Array>;
  /** Entry names of a directory, sorted. */
  readdir(path: string): Promise<string[]>;
  mkdirp(path: string): Promise<void>;
  /** Creates a new file; never overwrites. */
  writeFile(path: string, data: Uint8Array, mode: number): Promise<void>;
  /** A fresh private directory `<parent>/<prefix><random>`. */
  mkdtemp(parent: string, prefix: string): Promise<string>;
  rename(from: string, to: string): Promise<void>;
  /** Removes a directory tree this run created (never follows symlinks). */
  removeTree(path: string): Promise<void>;
}

export interface ChildRequest {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}

export interface BuildSeams {
  readonly fs: BuildFs;
  /** Runs a child with inherited output; resolves its exit code. */
  run(request: ChildRequest): Promise<number>;
  /** Runs a child and returns its trimmed stdout (for `tauri --version`). */
  capture(request: ChildRequest): Promise<{ code: number; stdout: string }>;
  /** Absolute path of the packaged `wrapper/` directory. */
  readonly wrapperRoot: string;
  /** Absolute path of the Node binary that runs the smoke script. */
  readonly nodePath: string;
  readonly platform: NodeJS.Platform;
  /** The host environment; only the allowlist reaches a child. */
  readonly env: Readonly<Record<string, string | undefined>>;
  onStage?(stage: BuildStage): void;
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

export interface BuildOptionsInput {
  /** Application directory with `smrt-desktop.json`. */
  readonly appDir: string;
  /** Output of `smrt desktop bundle` for the same target. */
  readonly bundleDir: string;
  /** Directory the installer is written to (new or empty). */
  readonly outDir: string;
  /** Rust triple (default: this machine). */
  readonly target?: string;
  /** Run the launch smoke against the bundle (host target only). */
  readonly smoke?: boolean;
}

export interface BuildPlan {
  readonly appDir: string;
  readonly bundleDir: string;
  readonly outDir: string;
  readonly target: TargetTriple;
  readonly smoke: boolean;
}

/** Same mapping as the bundler's `hostTriple`, restricted to supported ones. */
function hostTarget(
  platform: NodeJS.Platform,
  arch: string,
): string | undefined {
  const cpu = arch === 'arm64' ? 'aarch64' : arch === 'x64' ? 'x86_64' : '';
  if (cpu === '') return undefined;
  if (platform === 'darwin') return `${cpu}-apple-darwin`;
  if (platform === 'linux') return `${cpu}-unknown-linux-gnu`;
  if (platform === 'win32') return `${cpu}-pc-windows-msvc`;
  return undefined;
}

export function createBuildPlan(
  input: BuildOptionsInput,
  host: { platform: NodeJS.Platform; arch: string; cwd: string },
): BuildPlan {
  for (const [field, value] of [
    ['app', input.appDir],
    ['bundle', input.bundleDir],
    ['out', input.outDir],
  ] as const) {
    if (typeof value !== 'string' || value.length === 0) {
      throw new BuildError('invalid_option', { field });
    }
  }
  const hostTriple = hostTarget(host.platform, host.arch);
  const target = input.target ?? hostTriple;
  if (target === undefined || !isSupportedTarget(target)) {
    throw new BuildError('unsupported_target', { field: 'target' });
  }
  const smoke = input.smoke === true;
  if (smoke && target !== hostTriple) {
    throw new BuildError('smoke_needs_host_target', { field: 'smoke' });
  }
  return {
    // Absolute: the child processes run in a scratch directory, so a relative
    // path would resolve against the wrong place.
    appDir: resolve(host.cwd, input.appDir),
    bundleDir: resolve(host.cwd, input.bundleDir),
    outDir: resolve(host.cwd, input.outDir),
    target,
    smoke,
  };
}

/** The OS family a triple builds on. */
export function installerKindFor(target: string) {
  if (target.endsWith('-apple-darwin')) return INSTALLER_KINDS.darwin;
  if (target.endsWith('-pc-windows-msvc')) return INSTALLER_KINDS.win32;
  return INSTALLER_KINDS.linux;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MAX_SMALL = 8 * 1024 * 1024;
const MAX_FILE = 1024 * 1024 * 1024;
const SHA256_LINE = /^([0-9a-f]{64}) {2}(.+)$/;
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

const sha256 = (bytes: Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex');
const decode = (bytes: Uint8Array) => new TextDecoder('utf-8').decode(bytes);
const encode = (text: string) => new TextEncoder().encode(text);

/** Environment names a child may see: build tools and a display, no secrets. */
export const TOOLCHAIN_ENV_ALLOWLIST: readonly string[] = Object.freeze([
  'APPDATA',
  'CARGO_HOME',
  'CI',
  'ComSpec',
  'DEVELOPER_DIR',
  'DISPLAY',
  'HOME',
  'LOCALAPPDATA',
  'MACOSX_DEPLOYMENT_TARGET',
  'PATH',
  'PATHEXT',
  'PKG_CONFIG_PATH',
  'ProgramData',
  'ProgramFiles',
  'ProgramFiles(x86)',
  'RUSTUP_HOME',
  'RUSTUP_TOOLCHAIN',
  'SDKROOT',
  'SystemDrive',
  'SystemRoot',
  'TEMP',
  'TMP',
  'TMPDIR',
  'USERPROFILE',
  'WAYLAND_DISPLAY',
  'WINDIR',
  'XDG_RUNTIME_DIR',
  'windir',
]);

/** The child environment: allowlisted names only, plus fixed cargo settings. */
export function buildToolchainEnv(
  base: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of TOOLCHAIN_ENV_ALLOWLIST) {
    const value = base[name];
    if (typeof value === 'string' && value.length > 0) out[name] = value;
  }
  out.CARGO_TERM_COLOR = 'never';
  out.CARGO_INCREMENTAL = '0';
  return out;
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** The `[package]` version of a Cargo.toml (first `version =` in that table). */
export function cargoPackageVersion(toml: string): string | undefined {
  const lines = toml.split('\n');
  let inPackage = false;
  for (const line of lines) {
    const header = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (header) {
      inPackage = header[1] === 'package';
      continue;
    }
    if (inPackage) {
      const match = /^\s*version\s*=\s*"([^"]+)"\s*(?:#.*)?$/.exec(line);
      if (match) return match[1];
    }
  }
  return undefined;
}

/** The version recorded for the wrapper crate in Cargo.lock. */
export function cargoLockWrapperVersion(
  lock: string,
  name = 'smrt-desktop-wrapper',
): string | undefined {
  const pattern = new RegExp(
    `\\[\\[package\\]\\]\\nname = "${name}"\\nversion = "([^"]+)"`,
  );
  return pattern.exec(lock)?.[1];
}

/** Files under `dir`: relative posix paths, regular files only. */
async function listFiles(
  fs: BuildFs,
  dir: string,
  stage: BuildStage,
  fail: BuildError['code'],
): Promise<string[]> {
  const out: string[] = [];
  const walk = async (absolute: string, relative: string): Promise<void> => {
    for (const name of await fs.readdir(absolute)) {
      const child = join(absolute, name);
      const rel = relative === '' ? name : `${relative}/${name}`;
      const kind = await fs.kind(child);
      if (kind === 'dir') await walk(child, rel);
      else if (kind === 'file') out.push(rel);
      else throw new BuildError(fail, { stage, subjects: [rel] });
    }
  };
  await walk(dir, '');
  return out.sort();
}

async function readJsonRecord(
  fs: BuildFs,
  path: string,
  fail: BuildError['code'],
  stage: BuildStage,
): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = decode(await fs.readFile(path, MAX_SMALL));
  } catch {
    throw new BuildError(fail, { stage });
  }
  const parsed = parseStrictJson(text);
  const record = parsed.ok ? recordOf(parsed.value) : undefined;
  if (record === undefined) throw new BuildError(fail, { stage });
  return record;
}

async function copyFile(
  fs: BuildFs,
  from: string,
  to: string,
  mode: number,
  stage: BuildStage,
): Promise<void> {
  try {
    await fs.mkdirp(join(to, '..'));
    await fs.writeFile(to, await fs.readFile(from, MAX_FILE), mode);
  } catch (error) {
    throw error instanceof BuildError
      ? error
      : new BuildError('io_failed', { stage });
  }
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

export interface BuildResult {
  readonly outDir: string;
  readonly target: TargetTriple;
  readonly product: {
    readonly productId: string;
    readonly bundleId: string;
    readonly displayName: string;
    readonly productVersion: string;
  };
  readonly wrapperVersion: string;
  /** Installer names (single level, relative to `outDir`). */
  readonly installers: readonly string[];
  readonly signed: false;
  readonly smoke: boolean;
  readonly warnings: readonly string[];
}

// ---------------------------------------------------------------------------
// The pipeline
// ---------------------------------------------------------------------------

export async function runBuild(
  plan: BuildPlan,
  seams: BuildSeams,
): Promise<BuildResult> {
  const { fs } = seams;
  const warnings: string[] = [];
  let current: BuildStage = 'inputs';
  const stage = (name: BuildStage) => {
    current = name;
    seams.onStage?.(name);
  };
  let scratch: string | undefined;

  try {
    // ---- inputs ----------------------------------------------------------
    stage('inputs');
    let config: ReturnType<typeof parseProductConfig>;
    try {
      config = parseProductConfig(
        decode(
          await fs.readFile(join(plan.appDir, 'smrt-desktop.json'), 65536),
        ),
      );
    } catch {
      throw new BuildError('app_invalid', { stage: current });
    }
    if (config.icons === undefined || config.icons.length === 0) {
      throw new BuildError('identity_missing', {
        stage: current,
        field: 'icons',
      });
    }
    if (config.updaterPublicKey === undefined) {
      warnings.push(
        'smrt-desktop.json has no updaterPublicKey: the installer carries the wrapper placeholder and cannot be released',
      );
    }

    let report: BundleReportV1;
    try {
      report = parseBundleReport(
        decode(
          await fs.readFile(
            join(plan.bundleDir, BUNDLE_REPORT_FILENAME),
            MAX_SMALL,
          ),
        ),
      );
    } catch {
      throw new BuildError('bundle_invalid', { stage: current });
    }
    if (
      report.target !== plan.target ||
      report.product.productId !== config.productId ||
      report.product.bundleId !== config.bundleId ||
      report.product.displayName !== config.displayName
    ) {
      throw new BuildError('bundle_mismatch', { stage: current });
    }

    // The fragment must be exactly what the bundler writes.
    const fragment = await readJsonRecord(
      fs,
      join(plan.bundleDir, 'tauri.bundle.json'),
      'bundle_invalid',
      current,
    );
    const fragmentBundle = recordOf(fragment.bundle);
    const externalBin = fragmentBundle?.externalBin;
    const resources = recordOf(fragmentBundle?.resources);
    const sidecarName = `binaries/${config.productId}-node`;
    if (
      Object.keys(fragment).length !== 1 ||
      fragmentBundle === undefined ||
      Object.keys(fragmentBundle).length !== 2 ||
      !Array.isArray(externalBin) ||
      externalBin.length !== 1 ||
      externalBin[0] !== sidecarName ||
      resources === undefined ||
      Object.keys(resources).length !== 1 ||
      resources['resources/'] !== './'
    ) {
      throw new BuildError('bundle_invalid', { stage: current });
    }

    // Every listed digest matches and nothing else is on disk.
    let listText: string;
    try {
      listText = decode(
        await fs.readFile(
          join(plan.bundleDir, BUNDLE_FILES_FILENAME),
          MAX_SMALL,
        ),
      );
    } catch {
      throw new BuildError('bundle_invalid', { stage: current });
    }
    const listed = new Map<string, string>();
    for (const line of listText.split('\n')) {
      if (line === '') continue;
      const match = SHA256_LINE.exec(line);
      const path = match?.[2];
      if (
        match === null ||
        path === undefined ||
        !/^(?:binaries|resources)\//.test(path) ||
        path
          .split('/')
          .some((part) => part === '' || part === '.' || part === '..') ||
        listed.has(path)
      ) {
        throw new BuildError('bundle_invalid', { stage: current });
      }
      listed.set(path, match[1] as string);
    }
    if (listed.size === 0) {
      throw new BuildError('bundle_invalid', { stage: current });
    }
    const onDisk: string[] = [];
    for (const top of ['binaries', 'resources']) {
      for (const rel of await listFiles(
        fs,
        join(plan.bundleDir, top),
        current,
        'bundle_mismatch',
      )) {
        onDisk.push(`${top}/${rel}`);
      }
    }
    const extra = onDisk.filter((path) => !listed.has(path));
    const missing = [...listed.keys()].filter((path) => !onDisk.includes(path));
    if (extra.length > 0 || missing.length > 0) {
      throw new BuildError('bundle_mismatch', {
        stage: current,
        subjects: [...extra, ...missing],
      });
    }
    const bundleBytes = new Map<string, Uint8Array>();
    for (const [path, digest] of listed) {
      const bytes = await fs.readFile(
        join(plan.bundleDir, ...path.split('/')),
        MAX_FILE,
      );
      if (sha256(bytes) !== digest) {
        throw new BuildError('bundle_mismatch', {
          stage: current,
          subjects: [path],
        });
      }
      bundleBytes.set(path, bytes);
    }
    if (
      !listed.has(
        `${sidecarName}-${plan.target}${plan.target.includes('windows') ? '.exe' : ''}`,
      )
    ) {
      throw new BuildError('bundle_mismatch', { stage: current });
    }

    // Wrapper and package versions cannot drift.
    const packageJson = await readJsonRecord(
      fs,
      join(seams.wrapperRoot, '..', 'package.json'),
      'wrapper_missing',
      current,
    );
    const packageVersion = packageJson.version;
    if (typeof packageVersion !== 'string' || !SEMVER.test(packageVersion)) {
      throw new BuildError('wrapper_missing', { stage: current });
    }
    const wrapperBytes = new Map<string, Uint8Array>();
    try {
      for (const file of WRAPPER_FILES) {
        wrapperBytes.set(
          file,
          await fs.readFile(join(seams.wrapperRoot, file), MAX_FILE),
        );
      }
      for (const file of WRAPPER_SCRIPTS) {
        wrapperBytes.set(
          file,
          await fs.readFile(join(seams.wrapperRoot, file), MAX_FILE),
        );
      }
      for (const dir of WRAPPER_DIRS) {
        const files = await listFiles(
          fs,
          join(seams.wrapperRoot, dir),
          current,
          'wrapper_missing',
        );
        if (files.length === 0)
          throw new BuildError('wrapper_missing', { stage: current });
        for (const rel of files) {
          const path = `${dir}/${rel}`;
          wrapperBytes.set(
            path,
            await fs.readFile(join(seams.wrapperRoot, path), MAX_FILE),
          );
        }
      }
    } catch (error) {
      throw error instanceof BuildError
        ? error
        : new BuildError('wrapper_missing', { stage: current });
    }
    const cargoVersion = cargoPackageVersion(
      decode(wrapperBytes.get('Cargo.toml') as Uint8Array),
    );
    const lockVersion = cargoLockWrapperVersion(
      decode(wrapperBytes.get('Cargo.lock') as Uint8Array),
    );
    if (cargoVersion !== packageVersion || lockVersion !== packageVersion) {
      throw new BuildError('wrapper_version_drift', { stage: current });
    }

    // The pinned Tauri CLI.
    const childEnv = buildToolchainEnv(seams.env);
    let tauriVersion: string;
    try {
      const probe = await seams.capture({
        command: 'tauri',
        args: ['--version'],
        cwd: plan.appDir,
        env: childEnv,
      });
      tauriVersion = probe.code === 0 ? probe.stdout.trim() : '';
    } catch {
      tauriVersion = '';
    }
    if (
      !tauriVersion.endsWith(` ${TAURI_CLI_VERSION}`) &&
      tauriVersion !== TAURI_CLI_VERSION
    ) {
      throw new BuildError('tauri_version_mismatch', { stage: current });
    }

    // The output directory is new or empty.
    const outKind = await fs.kind(plan.outDir);
    if (outKind === 'other' || outKind === 'file') {
      throw new BuildError('output_exists', { stage: current });
    }
    if (outKind === 'dir' && (await fs.readdir(plan.outDir)).length > 0) {
      throw new BuildError('output_exists', { stage: current });
    }

    // ---- materialize -----------------------------------------------------
    stage('materialize');
    const parent = join(plan.outDir, '..');
    try {
      await fs.mkdirp(parent);
      scratch = await fs.mkdtemp(parent, '.smrt-desktop-build-');
    } catch {
      throw new BuildError('io_failed', { stage: current });
    }
    for (const [path, bytes] of wrapperBytes) {
      const to = join(scratch, ...path.split('/'));
      try {
        await fs.mkdirp(join(to, '..'));
        await fs.writeFile(to, bytes, 0o644);
      } catch {
        throw new BuildError('io_failed', { stage: current });
      }
    }

    // ---- stage_bundle ----------------------------------------------------
    stage('stage_bundle');
    for (const [path, bytes] of bundleBytes) {
      const to = join(scratch, ...path.split('/'));
      try {
        await fs.mkdirp(join(to, '..'));
        await fs.writeFile(
          to,
          bytes,
          path.startsWith('binaries/') ? 0o755 : 0o644,
        );
      } catch {
        throw new BuildError('io_failed', { stage: current });
      }
    }

    // ---- configure -------------------------------------------------------
    stage('configure');
    const iconNames: string[] = [];
    for (const icon of config.icons) {
      const name = posix.basename(icon);
      if (iconNames.includes(name)) {
        throw new BuildError('icons_invalid', {
          stage: current,
          field: 'icons',
        });
      }
      const from = join(plan.appDir, ...icon.split('/'));
      if ((await fs.kind(from)) !== 'file') {
        throw new BuildError('icons_invalid', {
          stage: current,
          field: 'icons',
        });
      }
      iconNames.push(name);
      await copyFile(
        fs,
        from,
        join(scratch, ...PRODUCT_ICON_DIR.split('/'), name),
        0o644,
        current,
      );
    }
    const overlay = {
      productName: report.product.displayName,
      identifier: report.product.bundleId,
      version: report.product.productVersion,
      bundle: {
        icon: iconNames.map((name) => `${PRODUCT_ICON_DIR}/${name}`),
        externalBin: [sidecarName],
        resources: { 'resources/': './' },
      },
      ...(config.updaterPublicKey === undefined
        ? {}
        : { plugins: { updater: { pubkey: config.updaterPublicKey } } }),
    };
    try {
      await fs.writeFile(
        join(scratch, SCRATCH_OVERLAY),
        encode(`${JSON.stringify(overlay, null, 2)}\n`),
        0o644,
      );
    } catch {
      throw new BuildError('io_failed', { stage: current });
    }

    // ---- tauri_build -----------------------------------------------------
    stage('tauri_build');
    const kind = installerKindFor(plan.target);
    const buildCode = await seams.run({
      command: 'tauri',
      args: [
        'build',
        '--no-sign',
        '--target',
        plan.target,
        '--config',
        SCRATCH_OVERLAY,
        '--bundles',
        kind.bundles,
        '--',
        '--locked',
      ],
      cwd: scratch,
      env: childEnv,
    });
    if (buildCode !== 0)
      throw new BuildError('tauri_failed', { stage: current });

    // ---- smoke -----------------------------------------------------------
    if (plan.smoke) {
      stage('smoke');
      const cargoCode = await seams.run({
        command: 'cargo',
        args: ['build', '--locked'],
        cwd: scratch,
        env: childEnv,
      });
      if (cargoCode !== 0)
        throw new BuildError('smoke_failed', { stage: current });
      const binary = `smrt-desktop-wrapper${seams.platform === 'win32' ? '.exe' : ''}`;
      const smokeCode = await seams.run({
        command: seams.nodePath,
        args: [
          'scripts/launch-smoke.mjs',
          '--wrapper',
          join(scratch, 'target', 'debug', binary),
          '--bundle',
          plan.bundleDir,
          '--triple',
          plan.target,
        ],
        cwd: scratch,
        env: childEnv,
      });
      if (smokeCode !== 0)
        throw new BuildError('smoke_failed', { stage: current });
    }

    // ---- collect ---------------------------------------------------------
    stage('collect');
    const bundleRoot = join(
      scratch,
      'target',
      plan.target,
      'release',
      'bundle',
      kind.directory,
    );
    let produced: string[];
    try {
      produced = (await fs.readdir(bundleRoot)).filter((name) =>
        kind.match.test(name),
      );
    } catch {
      produced = [];
    }
    if (produced.length === 0)
      throw new BuildError('no_installer', { stage: current });
    try {
      await fs.mkdirp(plan.outDir);
      for (const name of produced) {
        await fs.rename(join(bundleRoot, name), join(plan.outDir, name));
      }
    } catch {
      throw new BuildError('io_failed', { stage: current });
    }
    return {
      outDir: plan.outDir,
      target: plan.target,
      product: {
        productId: report.product.productId,
        bundleId: report.product.bundleId,
        displayName: report.product.displayName,
        productVersion: report.product.productVersion,
      },
      wrapperVersion: packageVersion,
      installers: produced,
      signed: false,
      smoke: plan.smoke,
      warnings,
    };
  } catch (error) {
    throw BuildError.from(error, current);
  } finally {
    if (scratch !== undefined) {
      try {
        await fs.removeTree(scratch);
      } catch {
        // Cleanup is best effort; the scratch directory name is not secret.
      }
    }
  }
}

export { BUILD_STAGES };
