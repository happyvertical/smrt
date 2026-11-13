/**
 * `runBundle(plan, seams)`: the bundler pipeline (design section 2).
 *
 * Stages run in this order and each one is reported to `seams.onStage`:
 *
 *  1. `inputs`      read and hash `package.json`, the lockfile, the optional
 *                   workspace file, patches and product config; refuse
 *                   non-registry production dependencies.
 *  2. `build_copy`  containment-safe copy of the adapter-node output, secret
 *                   deny-list and content scan, entry script check.
 *  3. `install`     frozen-lockfile production install with the exact argv of
 *                   `install-args.ts`; lifecycle scripts never run.
 *  4. `normalize`   the tree is checked without pnpm state, `.bin` and links.
 *  5. `segment`     dependency graph, feature segmentation, build-step audit.
 *  6. `prune_copy`  pruned, secret-checked copy of `node_modules`.
 *  7. `scan`        import-specifier scan for removed packages.
 *  8. `bridge`      the pre-bundled bridge file, node-only imports.
 *  9. `node`        pinned Node binary, verified against the target.
 * 10. `natives`     every native file in the output against the target.
 * 11. `manifests`   sidecar manifest; re-parsed
 *                   with the contract parsers and cross-checked.
 * 12. `report`      file digests and the report body, size budget.
 * 13. `measure`     optional: host start and cold start timing.
 * 14. `publish`     write `tauri.bundle.json`, `bundle-files.sha256` and the
 *                   report (after the measured start, which must not be able
 *                   to alter them), normalise mtimes, one atomic `rename`.
 *
 * Everything is built in a staging directory beside the output. On any
 * failure staging is removed and the output path is untouched. Every external
 * effect is a seam (`BundleSeams`): the filesystem, pnpm, Node acquisition,
 * measurement (which owns the clock) and the environment, so the whole
 * pipeline runs offline in tests with a fake installer.
 *
 * Secrets: the child environment is an allowlist, the app's `.npmrc` is
 * copied only into the staging install directory, and nothing from the
 * environment or a child's output is written to the report or an error.
 */

import { builtinModules } from 'node:module';
import { posix, win32 } from 'node:path';
import type { FileHandleLike } from '../internal/fs-seam.js';
import { O_NOFOLLOW, O_NONBLOCK, O_RDONLY } from '../internal/fs-seam.js';
import {
  parseSidecarManifest,
  type SidecarManifestV1,
  serializeSidecarManifest,
} from '../sidecar-manifest.js';
import { buildChildEnv } from './child-env.js';
import { BundleError, type BundleStage } from './errors.js';
import {
  assertNoMissingDependencies,
  assertRegistryDependencies,
  buildDependencyGraph,
  computeSegmentation,
  createRemovalChecker,
  entryPathsByDir,
  type InstalledPackage,
  readInstalledPackages,
} from './graph.js';
import {
  assertInstallSafe,
  buildPnpmInstallArgs,
  findBuildStepPackages,
  findDisallowedDependencies,
  findManifestCodeLoading,
  findUnsafeWorkspaceConfig,
  GENERATED_WORKSPACE_YAML,
  type InstalledPackageFacts,
  type StagedNpmrc,
  stageManifest,
  stageNpmrc,
} from './install-args.js';
import { findNonRegistryLockfilePackages } from './lockfile.js';
import {
  assertTreeNatives,
  type NativeRecord,
  type NativeTreeEntry,
  type NativeTreeVerification,
  type NativeTreeWalker,
  verifyNativeFile,
  verifyTreeNatives,
} from './native/classify.js';
import type { NativeFailure } from './native/errors.js';
import { type ClosableByteReader, fileHandleReader } from './native/reader.js';
import type {
  AcquiredNodeBinary,
  AcquireNodeBinaryOptions,
} from './node-dist.js';
import {
  isGpgVerified,
  lookupPinProvenance,
  type NodePinProvenance,
  pinnedVersions,
} from './node-pins.js';
import { type BundlePlan, hostTriple } from './options.js';
import {
  assertResolvesToItself,
  copyTree,
  createStaging,
  disposeStaging,
  ensureDirectories,
  type FilterDecision,
  type FilterEntry,
  hashRegularFile,
  isContained,
  parentPath,
  publishStaging,
  readRegularFile,
  readRegularText,
  resolveInside,
  type TreeFs,
  type TreeHandle,
  type TreeStats,
  walkTree,
  writeNewFile,
} from './paths.js';
import type { PnpmRequest, PnpmResult } from './pnpm-runner.js';
import {
  createBuildFilter,
  createContentScan,
  createNodeModulesFilter,
} from './prune.js';
import { assertNoMissingRelativeImports, scanReachable } from './reach.js';
import {
  BUNDLE_FILES_FILENAME,
  BUNDLE_REPORT_FILENAME,
  type BundleMeasurements,
  type BundleReportV1,
  type FileDigest,
  formatFileList,
  type ReportNative,
  serializeBundleReport,
  sha256Hex,
} from './report.js';
import {
  assertNoRemovedImports,
  extractImports,
  packageNameOf,
} from './scan-imports.js';
import {
  externalBinName,
  parseTargetTriple,
  type TargetSpec,
} from './targets.js';
import { BundleTreeError, toTreeError } from './tree-errors.js';

// ---------------------------------------------------------------------------
// Seams and result
// ---------------------------------------------------------------------------

export interface MeasureInput {
  /** Absolute root of the staged bundle (holds `binaries/` and `resources/`). */
  readonly bundleRoot: string;
  readonly executablePath: string;
  readonly resourcesDir: string;
  readonly sidecar: SidecarManifestV1;
  /** Sanitised base environment for the sidecar. */
  readonly baseEnv: Readonly<Record<string, string>>;
  readonly files: { readonly count: number; readonly bytes: number };
}

export interface BundleSeams {
  readonly fs: TreeFs;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  /** The environment the child allowlist is built from (never copied whole). */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** `@happyvertical/smrt-desktop` version recorded in the report. */
  readonly toolVersion: string;
  /** The running Node version, `26.8.1` form, recorded in the report. */
  readonly nodeVersion: string;
  /** Used when the plan names no `--node-cache`. */
  readonly defaultNodeCacheDir: string;
  acquireNode(options: AcquireNodeBinaryOptions): Promise<AcquiredNodeBinary>;
  runPnpm(request: PnpmRequest): Promise<PnpmResult>;
  pnpmVersion(
    env: Readonly<Record<string, string>>,
    cwd: string,
  ): Promise<string>;
  /** Required when `plan.measure` is set. Owns the clock and the process. */
  measure?(input: MeasureInput): Promise<BundleMeasurements>;
  /**
   * The provenance of a pinned Node release (default: the committed table).
   * A test seam; production uses `lookupPinProvenance`.
   */
  nodePinProvenance?(version: string): NodePinProvenance;
  /** Called when a stage starts. A throw fails that stage (test seam). */
  onStage?(stage: BundleStage): void | Promise<void>;
  /** Keep the staging directory on failure (debugging only). */
  readonly keepStaging?: boolean;
  /** `SOURCE_DATE_EPOCH` seconds; default 315532800 (1980-01-01). */
  readonly sourceDateEpoch?: number;
}

export interface BundleResult {
  readonly report: BundleReportV1;
  readonly outDir: string;
  /** Non-fatal notices; plain text without secrets. */
  readonly warnings: readonly string[];
  /** Stages that ran, in order. */
  readonly stages: readonly BundleStage[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const EPOCH_1980 = 315_532_800;
const MAX_PACKAGE_JSON = 4 * 1024 * 1024;
const MAX_LOCKFILE = 64 * 1024 * 1024;
const MAX_SMALL_TEXT = 1024 * 1024;
const MAX_BRIDGE_BYTES = 16 * 1024 * 1024;
const MAX_OUTPUT_FILE = 512 * 1024 * 1024;
const WARN_BYTES = 400 * 1024 * 1024;
const BRIDGE_ENTRY = 'bridge/smrt-mcp-bridge.mjs';
/**
 * Environment every sidecar manifest carries. `NODE_OPTIONS` and `NODE_PATH`
 * are emptied because the wrapper passes the parent's environment through.
 * `SMRT_APP_ID` fixes the application identity: the runtime otherwise reads
 * `package.json` from its working directory, which is the resource root and
 * holds none (the app's lives under `app/`).
 */
function sidecarEnv(productId: string): Record<string, string> {
  return {
    NODE_ENV: 'production',
    NODE_OPTIONS: '',
    NODE_PATH: '',
    SMRT_APP_ID: productId,
  };
}

const ROOT_STATE = [
  /^\.modules\.yaml$/,
  /^\.pnpm-workspace-state[^/]*\.json$/,
  /^\.package-lock\.json$/,
  /^\.pnpm$/,
];

/** pnpm output markers used only to classify a failed install. */
const DRIFT = /ERR_PNPM_OUTDATED_LOCKFILE|ERR_PNPM_LOCKFILE_CONFIG_MISMATCH/;
const INTEGRITY =
  /ERR_PNPM_TARBALL_INTEGRITY|EINTEGRITY|ERR_PNPM_BAD_TARBALL_SIZE/;

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function lstatOrUndefined(
  fs: TreeFs,
  path: string,
): Promise<TreeStats | undefined> {
  try {
    return await fs.lstat(path);
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === 'ENOENT') {
      return undefined;
    }
    throw toTreeError(error);
  }
}

/** Skip pnpm state, `.bin` directories and root state files. */
function normalizationFilter(entry: FilterEntry): FilterDecision {
  if (entry.name === '.bin') return 'skip';
  if (
    !entry.rel.includes('/') &&
    ROOT_STATE.some((rule) => rule.test(entry.name))
  ) {
    return 'skip';
  }
  return 'keep';
}

function manifestRecord(text: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    throw new BundleTreeError('invalid_package_json');
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new BundleTreeError('invalid_package_json');
  }
  return value as Record<string, unknown>;
}

function stringMap(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const [name, spec] of Object.entries(value)) {
      if (typeof spec === 'string') out[name] = spec;
    }
  }
  return out;
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function toFileHandleLike(handle: TreeHandle): FileHandleLike {
  return {
    stat: async () => {
      const stats = await handle.stat();
      return { ...stats, uid: 0 } as never;
    },
    read: (buffer, offset, length, position) =>
      handle.read(buffer, offset, length, position),
    write: (data, offset, length) => handle.write(data, offset, length),
    sync: async () => undefined,
    close: () => handle.close(),
  };
}

/** True when a package directory ships any `.node` file (bounded search). */
async function shipsPrebuiltAddon(
  fs: TreeFs,
  root: string,
  platform: NodeJS.Platform,
): Promise<boolean> {
  let budget = 5000;
  const visit = async (dir: string, depth: number): Promise<boolean> => {
    if (depth > 8 || budget <= 0) return false;
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch {
      return false;
    }
    for (const name of names.sort(compare)) {
      budget -= 1;
      if (name.endsWith('.node')) return true;
      let child: string;
      try {
        child = resolveInside(dir, [name], platform);
      } catch {
        continue;
      }
      let stats: TreeStats;
      try {
        stats = await fs.lstat(child);
      } catch {
        continue;
      }
      if (stats.isDirectory() && (await visit(child, depth + 1))) return true;
    }
    return false;
  };
  return visit(root, 0);
}

/** A kept package that would have needed an install-time build step. */
interface BuildCandidate {
  readonly name: string;
  /** Package directory relative to `node_modules`. */
  readonly dir: string;
  readonly scripts: Readonly<Record<string, string>>;
  readonly gypfile: boolean;
  readonly hasBindingGyp: boolean;
}

async function isRegularFile(fs: TreeFs, path: string): Promise<boolean> {
  try {
    return (await fs.lstat(path)).isFile();
  } catch {
    return false;
  }
}

/** `node:fs` or a bare built-in name such as `fs` or `fs/promises`. */
function isNodeBuiltin(specifier: string): boolean {
  return specifier.startsWith('node:') || builtinModules.includes(specifier);
}

function hostMatches(plan: BundlePlan, seams: BundleSeams): boolean {
  return hostTriple(seams.platform, seams.arch) === plan.target.triple;
}

/** A `NativeTreeWalker` over a real directory tree (lstat walk, no-follow open). */
function createWalker(
  fs: TreeFs,
  platform: NodeJS.Platform,
  root: string,
): NativeTreeWalker {
  return {
    async *entries(): AsyncGenerator<NativeTreeEntry> {
      const walk = await walkTree({ root, fs, platform });
      for (const entry of walk.entries) {
        if (entry.kind !== 'file') continue;
        const absolute = resolveInside(root, entry.rel.split('/'), platform);
        yield {
          path: entry.rel,
          type: 'file',
          size: entry.size,
          nlink: entry.nlink,
          async open(): Promise<ClosableByteReader> {
            const handle = await fs.open(
              absolute,
              O_RDONLY | O_NOFOLLOW | O_NONBLOCK,
            );
            try {
              // The root is canonical, so the file must resolve to itself.
              await assertResolvesToItself(fs, absolute, absolute, entry.rel);
              return await fileHandleReader(toFileHandleLike(handle));
            } catch (error) {
              await handle.close().catch(() => undefined);
              throw error;
            }
          },
        };
      }
    },
    async remove(path: string): Promise<void> {
      await fs.unlink(resolveInside(root, path.split('/'), platform));
    },
  };
}

/** Set every file and directory time to `ms` (reproducible archives). */
async function normalizeMetadata(
  fs: TreeFs,
  platform: NodeJS.Platform,
  root: string,
  ms: number,
): Promise<void> {
  if (fs.utimes === undefined) return;
  const time = new Date(ms);
  const walk = await walkTree({ root, fs, platform });
  for (const entry of [...walk.entries].reverse()) {
    await fs.utimes(resolveInside(root, entry.rel.split('/'), platform), time);
  }
  await fs.utimes(root, time);
}

interface Digests {
  readonly entries: readonly FileDigest[];
  readonly bytes: number;
  readonly breakdown: BundleReportV1['files']['breakdown'];
}

// ---------------------------------------------------------------------------
// runBundle
// ---------------------------------------------------------------------------

export async function runBundle(
  plan: BundlePlan,
  seams: BundleSeams,
): Promise<BundleResult> {
  const { fs, platform } = seams;
  const spec: TargetSpec = parseTargetTriple(plan.target.triple);
  const warnings: string[] = [];
  const ran: BundleStage[] = [];

  const at = (base: string, ...segments: string[]): string =>
    resolveInside(base, segments, platform);

  // Preconditions that need no staging.
  if (plan.measure && !hostMatches(plan, seams)) {
    throw new BundleError('measure_needs_host_target');
  }
  if (plan.bridgeFile === undefined) throw new BundleError('bridge_missing');
  if (plan.bridge === undefined) throw new BundleError('bridge_config_missing');
  const bridgeConfig = plan.bridge;
  const bridgeFile = plan.bridgeFile;

  // The Node pin: its provenance is recorded in the report, a release or
  // signing bundle (`requireVerifiedPins`) refuses one that was never
  // verified against the release signature, and any other bundle warns. This
  // runs before any work so a refusal costs nothing.
  const nodeVersion =
    plan.node.version ??
    pinnedVersions().find((candidate) => candidate.startsWith('26.')) ??
    pinnedVersions()[0];
  if (nodeVersion === undefined) throw new BundleError('internal');
  const nodePin: NodePinProvenance = (() => {
    try {
      return (seams.nodePinProvenance ?? lookupPinProvenance)(nodeVersion);
    } catch (error) {
      throw BundleError.from(error, 'node');
    }
  })();
  if (!isGpgVerified(nodePin)) {
    if (plan.requireVerifiedPins) {
      throw new BundleError('node_pin_unverified', { stage: 'node' }, 'node');
    }
    warnings.push(
      `WARNING: the Node ${nodeVersion} pin is NOT verified against the Node.js release signature (gpg). Do not release or sign this bundle; build it with --require-verified-pins to refuse unverified pins`,
    );
  }

  const parent = parentPath(plan.outDir, platform);
  if (parent === null) throw new BundleTreeError('invalid_option');

  async function stage<T>(
    name: BundleStage,
    work: () => Promise<T>,
  ): Promise<T> {
    ran.push(name);
    try {
      await seams.onStage?.(name);
      return await work();
    } catch (error) {
      throw BundleError.from(error, name);
    }
  }

  const staging = await createStaging(parent, { fs, platform }).catch(
    (error: unknown) => {
      throw BundleError.from(error);
    },
  );

  try {
    const stagingRoot = staging.path;
    const outRoot = at(stagingRoot, 'out');
    const installDir = at(stagingRoot, 'install');
    const binariesDir = at(outRoot, 'binaries');
    const resourcesDir = at(outRoot, 'resources');
    const appDir = at(resourcesDir, 'app');
    const buildDest = at(appDir, 'build');
    const modulesDest = at(appDir, 'node_modules');
    const installModules = at(installDir, 'node_modules');

    // -- 1. inputs ---------------------------------------------------------
    const inputs = await stage('inputs', async () => {
      const packageJson = await readRegularFile(
        at(plan.appDir, 'package.json'),
        MAX_PACKAGE_JSON,
        { fs },
      );
      const lockfile = await readRegularFile(
        at(plan.appDir, 'pnpm-lock.yaml'),
        MAX_LOCKFILE,
        { fs },
      );
      const workspaceStats = await lstatOrUndefined(
        fs,
        at(plan.appDir, 'pnpm-workspace.yaml'),
      );
      const workspace =
        workspaceStats === undefined
          ? undefined
          : await readRegularFile(
              at(plan.appDir, 'pnpm-workspace.yaml'),
              MAX_SMALL_TEXT,
              { fs },
            );
      const npmrcStats = await lstatOrUndefined(fs, at(plan.appDir, '.npmrc'));
      const npmrc =
        npmrcStats === undefined
          ? undefined
          : await readRegularFile(at(plan.appDir, '.npmrc'), 64 * 1024, { fs });
      const config =
        plan.productConfigPath === undefined
          ? undefined
          : await readRegularFile(plan.productConfigPath, 64 * 1024, { fs });

      const manifest = manifestRecord(
        Buffer.from(packageJson).toString('utf8'),
      );
      const disallowed = findDisallowedDependencies({
        dependencies: stringMap(manifest.dependencies),
        optionalDependencies: stringMap(manifest.optionalDependencies),
      });
      if (disallowed.length > 0) {
        throw new BundleTreeError('unsupported_resolution', {
          subjects: disallowed.map((item) => item.name),
        });
      }
      // The workspace file is staged only when every top-level key is on the
      // allowlist: pnpm loads JavaScript for some settings (which
      // `--ignore-scripts` does not cover) and honours path and TLS settings
      // the command line cannot override. Refuse before any work.
      const workspaceHooks =
        workspace === undefined
          ? []
          : findUnsafeWorkspaceConfig(Buffer.from(workspace).toString('utf8'));
      if (workspaceHooks.length > 0) {
        throw new BundleTreeError('unsafe_install_config', {
          field: 'pnpm-workspace.yaml',
          subjects: workspaceHooks,
        });
      }
      const manifestHooks = findManifestCodeLoading(manifest);
      if (manifestHooks.length > 0) {
        throw new BundleTreeError('unsafe_install_config', {
          field: 'package.json',
          subjects: manifestHooks,
        });
      }
      const stagedNpmrc: StagedNpmrc | undefined =
        npmrc === undefined
          ? undefined
          : stageNpmrc(Buffer.from(npmrc).toString('utf8'));
      return {
        packageJson,
        lockfile,
        workspace,
        stagedNpmrc,
        config,
        manifest,
      };
    });

    const dependencies = {
      ...stringMap(inputs.manifest.optionalDependencies),
      ...stringMap(inputs.manifest.dependencies),
    };

    // -- 2. build_copy -----------------------------------------------------
    let buildTreeSha256 = '';
    let patchesDigest: string | undefined;
    let prunedFiles = 0;
    let prunedBytes = 0;
    await stage('build_copy', async () => {
      await ensureDirectories(stagingRoot, ['out', 'resources', 'app'], {
        fs,
        platform,
      });
      const filter = createBuildFilter({ keepSourceMaps: plan.keepSourceMaps });
      const scan = createContentScan({ policy: plan.secretContentPolicy });
      const copy = await copyTree({
        root: plan.buildDir,
        destRoot: buildDest,
        createRoot: true,
        fs,
        platform,
        filter: filter.filter,
        inspect: scan.inspect,
        accountSkipped: true,
      });
      buildTreeSha256 = sha256Hex(
        formatFileList(
          copy.copied.map((file) => ({ path: file.rel, sha256: file.sha256 })),
        ),
      );
      prunedFiles += copy.skipped.files;
      prunedBytes += copy.skipped.bytes;
      for (const finding of scan.findings) {
        warnings.push(`secret-looking content in build output: ${finding.rel}`);
      }
      const runtimeFiles = new Set(plan.runtimeFiles ?? []);
      if (runtimeFiles.size > 0) {
        // Runtime data is explicit; never sweep the source tree or its config.
        for (const file of runtimeFiles) {
          if (
            ['package.json', 'build', 'node_modules'].some(
              (reserved) =>
                file === reserved || file.startsWith(`${reserved}/`),
            )
          ) {
            throw new BundleTreeError('config_invalid_field', {
              field: 'runtimeFiles',
            });
          }
        }
        const runtimeCopy = await copyTree({
          root: plan.appDir,
          destRoot: appDir,
          fs,
          platform,
          filter(entry) {
            if (
              !runtimeFiles.has(entry.rel) &&
              ![...runtimeFiles].some((file) =>
                file.startsWith(`${entry.rel}/`),
              )
            )
              return 'skip';
            return filter.filter(entry);
          },
          inspect: scan.inspect,
        });
        if (
          runtimeCopy.copied.length !== runtimeFiles.size ||
          runtimeCopy.copied.some((file) => !runtimeFiles.has(file.rel))
        ) {
          throw new BundleTreeError('missing_app_file', {
            field: 'runtimeFiles',
          });
        }
      }
      const entry = plan.sidecar.args.find((arg) => !arg.startsWith('-'));
      const entryStats =
        entry === undefined
          ? undefined
          : await lstatOrUndefined(
              fs,
              at(
                plan.sidecar.workingDirectory === 'app' ? appDir : resourcesDir,
                ...entry.split('/'),
              ),
            );
      if (entryStats === undefined || !entryStats.isFile()) {
        throw new BundleError('entry_missing');
      }
      await writeNewFile(
        at(appDir, 'package.json'),
        json({
          name: plan.product.productId,
          version: plan.product.productVersion,
          private: true,
          type: 'module',
          ...(plan.sidecar.workingDirectory === 'app' ? { dependencies } : {}),
        }),
        0o644,
        { fs, platform },
      );
    });

    // -- 3. install --------------------------------------------------------
    const childEnv = buildChildEnv(seams.env, {}, { platform });
    let npmrcSha256: string | undefined;
    const pnpmVersion = await stage('install', async () => {
      await fs.mkdir(installDir, 0o700);
      await writeNewFile(
        at(installDir, 'package.json'),
        json(stageManifest(inputs.manifest)),
        0o600,
        { fs, platform },
      );
      await writeNewFile(
        at(installDir, 'pnpm-lock.yaml'),
        inputs.lockfile,
        0o600,
        {
          fs,
          platform,
        },
      );
      // Always a workspace file here: pnpm searches the directory and then
      // every parent for one, and an ancestor's would apply to the install.
      await writeNewFile(
        at(installDir, 'pnpm-workspace.yaml'),
        inputs.workspace ?? GENERATED_WORKSPACE_YAML,
        0o600,
        { fs, platform },
      );
      if (inputs.stagedNpmrc !== undefined) {
        // Registry and boolean resolution lines only (credentials and every
        // other key are not staged); never copied to the output.
        if (inputs.stagedNpmrc.text.length > 0) {
          await writeNewFile(
            at(installDir, '.npmrc'),
            inputs.stagedNpmrc.text,
            0o600,
            { fs, platform },
          );
          npmrcSha256 = sha256Hex(inputs.stagedNpmrc.text);
        }
        if (inputs.stagedNpmrc.dropped > 0) {
          warnings.push(
            `${inputs.stagedNpmrc.dropped} .npmrc line(s) were not used: only registry and a few boolean resolution settings are staged; credentials come from the user-level .npmrc`,
          );
        }
      }
      const patchesStats = await lstatOrUndefined(
        fs,
        at(plan.appDir, 'patches'),
      );
      if (patchesStats?.isDirectory()) {
        const patches = await copyTree({
          root: at(plan.appDir, 'patches'),
          destRoot: at(installDir, 'patches'),
          createRoot: true,
          fs,
          platform,
        });
        patchesDigest = sha256Hex(
          formatFileList(
            patches.copied.map((file) => ({
              path: file.rel,
              sha256: file.sha256,
            })),
          ),
        );
      }

      // Probe from a directory that holds only a workspace file and a bare
      // manifest: inside the install directory pnpm would honour the app's
      // packageManager and report the pnpm it switched to, and without the
      // workspace file an ancestor's `package.json` `packageManager` would do
      // the same.
      await fs.mkdir(at(stagingRoot, 'probe'), 0o700);
      await writeNewFile(
        at(stagingRoot, 'probe', 'pnpm-workspace.yaml'),
        GENERATED_WORKSPACE_YAML,
        0o600,
        { fs, platform },
      );
      await writeNewFile(
        at(stagingRoot, 'probe', 'package.json'),
        json({ name: 'smrt-desktop-probe', private: true }),
        0o600,
        { fs, platform },
      );
      const version = await seams.pnpmVersion(
        childEnv,
        at(stagingRoot, 'probe'),
      );
      const wanted = inputs.manifest.packageManager;
      if (
        typeof wanted === 'string' &&
        wanted.startsWith('pnpm@') &&
        version !== 'unknown' &&
        wanted.slice(5).split('+')[0] !== version
      ) {
        warnings.push(
          `pnpm ${version} differs from the app's packageManager (${wanted.slice(0, 40)})`,
        );
      }

      const args = buildPnpmInstallArgs({
        target: spec,
        offline: plan.offline,
      });
      assertInstallSafe(args, childEnv);
      const result = await seams.runPnpm({
        cwd: installDir,
        args,
        env: childEnv,
      });
      if (result.exitCode !== 0) {
        if (DRIFT.test(result.output)) throw new BundleError('lockfile_drift');
        if (INTEGRITY.test(result.output)) {
          throw new BundleError('integrity_failure');
        }
        throw new BundleError('pnpm_failed');
      }
      return version;
    });

    // -- 4. normalize ------------------------------------------------------
    await stage('normalize', async () => {
      const stats = await lstatOrUndefined(fs, installModules);
      if (stats === undefined || !stats.isDirectory()) {
        throw new BundleTreeError('missing_app_file', {
          subjects: ['node_modules'],
        });
      }
      // Any link, junction or special file left after the pnpm state and
      // `.bin` directories are skipped fails here, before any copying.
      await walkTree({
        root: installModules,
        fs,
        platform,
        filter: normalizationFilter,
        policy: { hardlinks: 'allow' },
      });
    });

    // -- 5. segment --------------------------------------------------------
    const segmentation = await stage('segment', async () => {
      const packages = await readInstalledPackages(installModules, {
        fs,
        platform,
      });
      assertRegistryDependencies(packages, dependencies);
      const installedNames = new Set(packages.map((pkg) => pkg.name));
      const offending = findNonRegistryLockfilePackages(
        Buffer.from(inputs.lockfile).toString('utf8'),
      ).filter((name) => installedNames.has(name));
      if (offending.length > 0) {
        throw new BundleError('lockfile_non_registry', { subjects: offending });
      }
      const graph = buildDependencyGraph(packages, Object.keys(dependencies));
      const result = computeSegmentation(graph, plan.features.disabled);
      assertNoMissingDependencies(graph, result.keep);

      // Packages that would have needed a build step (an install script,
      // `gypfile`, or a root `binding.gyp`, which npm builds without any
      // script). Whether each ships an addon is decided AFTER pruning, on what
      // survives: an addon for another platform is dropped as foreign and
      // must not count.
      const buildCandidates: BuildCandidate[] = [];
      for (const pkg of packages) {
        if (!result.keep.has(pkg.id)) continue;
        const hasBindingGyp = await isRegularFile(
          fs,
          at(installModules, ...pkg.dir.split('/'), 'binding.gyp'),
        );
        if (pkg.installScripts.length > 0 || pkg.gypfile || hasBindingGyp) {
          buildCandidates.push({
            name: pkg.name,
            dir: pkg.dir,
            scripts: Object.fromEntries(
              pkg.installScripts.map((script) => [script, 'present']),
            ),
            gypfile: pkg.gypfile,
            hasBindingGyp,
          });
        }
      }
      for (const orphan of result.orphans) {
        warnings.push(
          `package not reachable from direct dependencies: ${orphan}`,
        );
      }
      return { packages, graph, result, buildCandidates };
    });

    // -- 6. prune_copy -----------------------------------------------------
    let removedFiles = 0;
    let removedBytes = 0;
    const foreignNativeDirs = new Set<string>();
    await stage('prune_copy', async () => {
      // Which files do reached modules refer to? Follow the module graph over
      // the UNPRUNED install tree first, so the file rules below can never
      // delete a file the sidecar loads (a relative import's target, a
      // `new URL('./x', import.meta.url)` asset). The scan stage then checks
      // the pruned copy again.
      const entryScript = plan.sidecar.args.find((arg) => !arg.startsWith('-'));
      if (entryScript === undefined) throw new BundleError('entry_missing');
      const beforePruning = await scanReachable({
        buildRoot: buildDest,
        modulesRoot: installModules,
        entry: at(
          plan.sidecar.workingDirectory === 'app' ? appDir : resourcesDir,
          ...entryScript.split('/'),
        ),
        graph: segmentation.graph,
        keep: segmentation.result.keep,
        fs,
        platform,
      });
      const relativeSet = (absolutes: readonly string[]): Set<string> => {
        const out = new Set<string>();
        for (const absolute of absolutes) {
          if (!isContained(installModules, absolute, platform)) continue;
          const flavor = platform === 'win32' ? win32 : posix;
          out.add(
            flavor
              .relative(installModules, absolute)
              .split(flavor.sep)
              .join('/'),
          );
        }
        return out;
      };
      const protectedPaths = relativeSet(beforePruning.protectedPaths);
      const protectedSubtrees = relativeSet(beforePruning.protectedSubtrees);

      // Some native-only optional packages omit libc metadata (libsql), so
      // pnpm installs both variants. Use actual headers, never package names
      // or native exceptions. Direct roots, required/peer edges and ambiguous
      // binaries stay in the tree and must pass the unchanged native gate.
      const required = new Set(segmentation.graph.roots);
      const optional = new Set<string>();
      for (const pkg of segmentation.packages) {
        if (!segmentation.result.keep.has(pkg.id)) continue;
        for (const name of Object.keys(pkg.optionalDependencies)) {
          const id = segmentation.graph.resolve(pkg.id, name);
          if (id) optional.add(id);
        }
        for (const name of Object.keys(pkg.dependencies)) {
          if (name in pkg.optionalDependencies) continue;
          const id = segmentation.graph.resolve(pkg.id, name);
          if (id) required.add(id);
        }
        for (const name of Object.keys(pkg.peerDependencies)) {
          const id = segmentation.graph.resolve(pkg.id, name);
          if (id) required.add(id);
        }
      }
      for (const pkg of segmentation.packages) {
        if (
          !segmentation.result.keep.has(pkg.id) ||
          required.has(pkg.id) ||
          !optional.has(pkg.id)
        )
          continue;
        if (
          pkg.entryPaths.length !== 1 ||
          !pkg.entryPaths[0]?.endsWith('.node')
        )
          continue;
        const entryPath = `${pkg.dir}/${pkg.entryPaths[0]}`;
        // A native entrypoint does not prove that a separately reached subpath
        // or asset is disposable. Preserve those packages and let validation fail.
        if (
          [...protectedPaths].some(
            (path) => path.startsWith(`${pkg.dir}/`) && path !== entryPath,
          )
        )
          continue;
        if (
          [...protectedSubtrees].some(
            (path) =>
              path === pkg.dir ||
              path.startsWith(`${pkg.dir}/`) ||
              pkg.dir.startsWith(`${path}/`),
          )
        )
          continue;
        const walker = createWalker(
          fs,
          platform,
          at(installModules, ...pkg.dir.split('/')),
        );
        for await (const entry of walker.entries()) {
          if (entry.path !== pkg.entryPaths[0] || entry.type !== 'file')
            continue;
          const reader = await entry.open();
          try {
            const verdict = await verifyNativeFile(reader, spec, {
              requireNative: true,
              expectKind: 'library',
            });
            if (
              !verdict.ok &&
              verdict.info &&
              verdict.info.libc !== 'unknown' &&
              verdict.info.kind !== 'executable' &&
              !verdict.info.machines.includes('other') &&
              (verdict.reason === 'wrong_format' ||
                verdict.reason === 'wrong_machine' ||
                verdict.reason === 'wrong_libc')
            ) {
              foreignNativeDirs.add(pkg.dir);
            }
          } finally {
            await reader.close();
          }
        }
      }

      const prune = createNodeModulesFilter({
        keepSourceMaps: plan.keepSourceMaps,
        target: {
          platform: spec.nodePlatform,
          arch: spec.nodeArch,
          ...(spec.pnpm.libc === undefined ? {} : { libc: spec.pnpm.libc }),
        },
        entryPaths: entryPathsByDir(segmentation.packages),
        removedDirs: segmentation.result.removedDirs,
        protectedPaths,
        protectedSubtrees,
        foreignNativeDirs,
      });
      const copy = await copyTree({
        root: installModules,
        destRoot: modulesDest,
        createRoot: true,
        fs,
        platform,
        filter: (entry) =>
          normalizationFilter(entry) === 'skip' ? 'skip' : prune.filter(entry),
        policy: { hardlinks: 'allow' },
        accountSkipped: true,
        onSkip: (skipped) => {
          if (
            skipped.kind === 'dir' &&
            segmentation.result.removedDirs.has(skipped.rel)
          ) {
            removedFiles += skipped.files;
            removedBytes += skipped.bytes;
          } else if (
            !skipped.rel.includes('/') &&
            ROOT_STATE.some((rule) => rule.test(skipped.rel))
          ) {
            // pnpm state is not package content.
          } else if (skipped.rel.split('/').includes('.bin')) {
            // Binary link directories are not package content.
          } else {
            prunedFiles += skipped.files;
            prunedBytes += skipped.bytes;
          }
        },
      });
      void copy;

      // The build-step audit, on what SURVIVED pruning: a candidate whose
      // only addon was for another platform (dropped as foreign above) ships
      // nothing for the target, and `--ignore-scripts` never builds one.
      const facts: InstalledPackageFacts[] = [];
      for (const candidate of segmentation.buildCandidates) {
        if (foreignNativeDirs.has(candidate.dir)) continue;
        facts.push({
          name: candidate.name,
          scripts: candidate.scripts,
          gypfile: candidate.gypfile,
          hasBindingGyp: candidate.hasBindingGyp,
          hasPrebuiltNode: await shipsPrebuiltAddon(
            fs,
            at(modulesDest, ...candidate.dir.split('/')),
            platform,
          ),
        });
      }
      const needBuild = findBuildStepPackages(facts);
      if (needBuild.length > 0) {
        throw new BundleError('build_step_required', { subjects: needBuild });
      }
    });

    // -- 7. scan -----------------------------------------------------------
    const acknowledged: { from: string; specifier: string }[] = [];
    let importScan: BundleReportV1['importScan'] | undefined;
    await stage('scan', async () => {
      const entry = plan.sidecar.args.find((arg) => !arg.startsWith('-'));
      if (entry === undefined) throw new BundleError('entry_missing');
      const reach = await scanReachable({
        buildRoot: buildDest,
        modulesRoot: modulesDest,
        entry: at(
          plan.sidecar.workingDirectory === 'app' ? appDir : resourcesDir,
          ...entry.split('/'),
        ),
        graph: segmentation.graph,
        keep: segmentation.result.keep,
        acknowledged: plan.acknowledgedDynamicImports,
        fs,
        platform,
      });
      assertNoRemovedImports(reach);
      assertNoMissingRelativeImports(reach);
      importScan = {
        filesReached: reach.staticFiles + reach.lazyFiles,
        loadTimeFiles: reach.staticFiles,
        unresolvedBareImports: reach.unresolved,
        nonLiteralImports: reach.nonLiteral.length,
        unscannedFiles: reach.unscanned.length,
      };
      if (reach.unresolved > 0) {
        warnings.push(
          `${reach.unresolved} bare import(s) resolve to nothing installed (optional dependencies, or a missing package); they are counted in the report and only a start with --measure would show whether one is needed`,
        );
      }
      for (const finding of reach.acknowledged) {
        acknowledged.push({
          from: finding.path,
          specifier: finding.specifier,
        });
      }
      if (reach.nonLiteral.length > 0) {
        warnings.push(
          `${reach.nonLiteral.length} non-literal import(s) cannot be checked statically`,
        );
      }
      if (reach.unscanned.length > 0) {
        warnings.push(`${reach.unscanned.length} file(s) were not scanned`);
      }
    });

    // -- 8. bridge ---------------------------------------------------------
    let bridgeSha256 = '';
    let bridgeBytes = 0;
    await stage('bridge', async () => {
      const bytes = await readRegularFile(bridgeFile, MAX_BRIDGE_BYTES, { fs });
      let source: string;
      try {
        source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch {
        throw new BundleError('bridge_not_self_contained');
      }
      const found = extractImports(source);
      const foreign = found.refs.filter((ref) => !isNodeBuiltin(ref.specifier));
      if (foreign.length > 0) {
        throw new BundleError('bridge_not_self_contained', {
          subjects: [
            ...new Set(
              foreign.map(
                (ref) => packageNameOf(ref.specifier) ?? '(relative import)',
              ),
            ),
          ].sort(),
        });
      }
      if (found.nonLiteral.length > 0) {
        warnings.push('the bridge file has non-literal imports');
      }
      const bridgeDir = await ensureDirectories(resourcesDir, ['bridge'], {
        fs,
        platform,
      });
      await writeNewFile(at(bridgeDir, 'smrt-mcp-bridge.mjs'), bytes, 0o644, {
        fs,
        platform,
      });
      bridgeSha256 = sha256Hex(bytes);
      bridgeBytes = bytes.length;
    });

    // -- 9. node -----------------------------------------------------------
    const nodeInfo = await stage('node', async () => {
      const version = nodeVersion;
      await ensureDirectories(outRoot, ['binaries'], { fs, platform });
      const destination = at(
        binariesDir,
        externalBinName(plan.sidecar.executable, spec.triple),
      );
      const withLicense = spec.nodeDist.format === 'tar.gz';
      if (withLicense) {
        await ensureDirectories(resourcesDir, ['licenses'], { fs, platform });
      }
      const acquired = await seams.acquireNode({
        version,
        target: spec,
        cacheDir: plan.node.cache ?? seams.defaultNodeCacheDir,
        destination,
        ...(withLicense
          ? {
              licenseDestination: at(resourcesDir, 'licenses', 'node-LICENSE'),
            }
          : {}),
        ...(plan.node.archive === undefined
          ? {}
          : { archivePath: plan.node.archive }),
        offline: plan.offline,
        env: seams.env,
        verifyBinary: async (binary) => {
          const verdict = await verifyNativeFile(binary, spec, {
            requireNative: true,
            expectKind: 'executable',
          });
          if (!verdict.ok) throw new BundleError('internal');
        },
      });
      return { acquired, version };
    });

    // -- 10. natives -------------------------------------------------------
    const nativeSummary = await stage('natives', async () => {
      const exceptions = plan.nativeExceptions.map((item) => ({
        pattern: item.path,
        reason: item.reason,
      }));
      const verifyRoot = async (
        root: string,
        prefix: string,
        withExceptions: boolean,
      ): Promise<NativeTreeVerification> => {
        const walker = createWalker(fs, platform, root);
        return verifyTreeNatives(
          walker,
          spec,
          withExceptions ? { exceptions } : {},
        ).then((result) => ({
          ...result,
          natives: result.natives.map((item) => ({
            ...item,
            path: `${prefix}${item.path}`,
          })),
          failures: result.failures.map((item) => ({
            ...item,
            path: `${prefix}${item.path}`,
          })),
          removed: result.removed.map((item) => ({
            ...item,
            path: `${prefix}${item.path}`,
          })),
        }));
      };
      const resources = await verifyRoot(resourcesDir, 'resources/', true);
      const binaries = await verifyRoot(binariesDir, 'binaries/', false);
      const failures: NativeFailure[] = [
        ...resources.failures,
        ...binaries.failures,
      ];
      assertTreeNatives({
        ok: failures.length === 0,
        filesChecked: resources.filesChecked + binaries.filesChecked,
        natives: [],
        failures,
        removed: [],
      });
      const natives: NativeRecord[] = [
        ...binaries.natives,
        ...resources.natives,
      ].sort((a, b) => compare(a.path, b.path));
      const removed = [...resources.removed].sort((a, b) =>
        compare(a.path, b.path),
      );
      return { natives, removed };
    });

    // -- 11. manifests -----------------------------------------------------
    const sidecar: SidecarManifestV1 = {
      version: 1,
      executable: plan.sidecar.executable,
      args: plan.sidecar.args,
      ...(plan.sidecar.workingDirectory === undefined
        ? {}
        : { workingDirectory: plan.sidecar.workingDirectory }),
      healthRoute: plan.sidecar.healthRoute,
      dataDirectory: plan.sidecar.dataDirectory,
      env: sidecarEnv(plan.product.productId),
      ...(plan.sidecar.ownerClaimRoute === undefined
        ? {}
        : { ownerClaimRoute: plan.sidecar.ownerClaimRoute }),
    };
    // `tauri.bundle.json` and `bundle-files.sha256` are written at publish,
    // AFTER the measured start: the started app runs with the bundle root as
    // its parent and must not be able to alter either.
    const tauriBundleText = json({
      bundle: {
        externalBin: [`binaries/${plan.sidecar.executable}`],
        resources: { 'resources/': './' },
      },
    });
    let fileListText = '';
    await stage('manifests', async () => {
      const sidecarPath = at(resourcesDir, 'sidecar-manifest.json');
      try {
        await writeNewFile(
          sidecarPath,
          serializeSidecarManifest(sidecar),
          0o644,
          {
            fs,
            platform,
          },
        );
        const sidecarText = await readRegularText(sidecarPath, MAX_SMALL_TEXT, {
          fs,
        });
        const parsedSidecar = parseSidecarManifest(sidecarText);
        if (serializeSidecarManifest(parsedSidecar) !== sidecarText) {
          throw new BundleError('manifest_round_trip');
        }
      } catch (error) {
        if (error instanceof BundleError || error instanceof BundleTreeError) {
          throw error;
        }
        throw new BundleError('manifest_round_trip');
      }
    });

    // -- 12. report --------------------------------------------------------
    const digestOutput = async (): Promise<Digests> => {
      const entries: FileDigest[] = [];
      let bytes = 0;
      const breakdown = {
        nodeBinary: 0,
        nodeModules: 0,
        appBuild: 0,
        other: 0,
      };
      for (const top of ['binaries', 'resources'] as const) {
        const root = at(outRoot, top);
        const walk = await walkTree({ root, fs, platform });
        for (const entry of walk.entries) {
          if (entry.kind !== 'file') continue;
          const sha256 = await hashRegularFile(
            at(root, ...entry.rel.split('/')),
            MAX_OUTPUT_FILE,
            { fs },
          );
          const path = `${top}/${entry.rel}`;
          entries.push({ path, sha256 });
          bytes += entry.size;
          if (top === 'binaries') breakdown.nodeBinary += entry.size;
          else if (path.startsWith('resources/app/node_modules/')) {
            breakdown.nodeModules += entry.size;
          } else if (path.startsWith('resources/app/build/')) {
            breakdown.appBuild += entry.size;
          } else breakdown.other += entry.size;
        }
      }
      return { entries, bytes, breakdown };
    };

    let report = await stage('report', async () => {
      const digests = await digestOutput();
      const list = formatFileList(digests.entries);
      fileListText = list;

      const removedPackages = segmentation.result.removed
        .map((item) => ({
          name: item.name,
          version: item.version,
          path: `resources/app/node_modules/${item.dir}`,
          reason: item.reason,
        }))
        .sort((a, b) => compare(a.path, b.path));
      const keptPackages = segmentation.packages
        .filter(
          (pkg) =>
            segmentation.result.keep.has(pkg.id) &&
            !foreignNativeDirs.has(pkg.dir),
        )
        .map((pkg: InstalledPackage) => ({
          name: pkg.name,
          version: pkg.version,
          path: `resources/app/node_modules/${pkg.dir}`,
        }))
        .sort((a, b) => compare(a.path, b.path));
      const acks = [
        ...new Map(
          acknowledged.map((item) => [`${item.from}\0${item.specifier}`, item]),
        ).values(),
      ].sort(
        (a, b) => compare(a.from, b.from) || compare(a.specifier, b.specifier),
      );

      const natives: ReportNative[] = nativeSummary.natives.map((item) => ({
        path: item.path,
        format: item.format,
        kind: item.kind,
        machines: [...item.machines],
        ...(item.libc === undefined ? {} : { libc: item.libc }),
      }));

      const built: BundleReportV1 = {
        version: 1,
        tool: {
          name: '@happyvertical/smrt-desktop',
          version: seams.toolVersion,
        },
        product: { ...plan.product },
        target: plan.target.triple,
        host: {
          platform: seams.platform,
          arch: seams.arch,
          node: seams.nodeVersion,
          pnpm: pnpmVersion,
        },
        inputs: {
          packageJsonSha256: sha256Hex(inputs.packageJson),
          lockfileSha256: sha256Hex(inputs.lockfile),
          ...(inputs.workspace === undefined
            ? {}
            : { workspaceYamlSha256: sha256Hex(inputs.workspace) }),
          ...(npmrcSha256 === undefined ? {} : { npmrcSha256 }),
          ...(patchesDigest === undefined
            ? {}
            : { patchesSha256: patchesDigest }),
          ...(inputs.config === undefined
            ? {}
            : { productConfigSha256: sha256Hex(inputs.config) }),
          buildTreeSha256,
        },
        node: {
          version: nodeInfo.version,
          distFile: nodeInfo.acquired.distFile,
          archiveSha256: nodeInfo.acquired.archiveSha256,
          binarySha256: nodeInfo.acquired.sha256,
          machine: spec.native.machine,
          pin: {
            verification: isGpgVerified(nodePin)
              ? 'gpg-verified'
              : 'unverified',
            source: nodePin.source,
            retrieved: nodePin.retrieved,
            shasumsSha256: nodePin.shasumsSha256,
            signerFingerprints: [...nodePin.signerFingerprints].sort(),
          },
        },
        bridge: {
          file: BRIDGE_ENTRY,
          sha256: bridgeSha256,
          bytes: bridgeBytes,
        },
        features: {
          enabled: [...plan.features.enabled],
          removedPackages,
          acknowledgedDynamicImports: acks,
        },
        importScan: importScan as BundleReportV1['importScan'],
        packages: keptPackages,
        natives,
        nativeExceptions: nativeSummary.removed.map((item) => ({
          path: item.path,
          pattern: item.pattern,
          reason: item.reason,
        })),
        pruned: {
          files: prunedFiles,
          bytes: prunedBytes,
          removedPackageFiles: removedFiles,
          removedPackageBytes: removedBytes,
        },
        files: {
          count: digests.entries.length,
          bytes: digests.bytes,
          listSha256: sha256Hex(list),
          tauriBundleSha256: sha256Hex(tauriBundleText),
          breakdown: digests.breakdown,
        },
      };
      serializeBundleReport(built); // validates the closed schema

      if (
        plan.maxSizeBytes !== undefined &&
        digests.bytes > plan.maxSizeBytes
      ) {
        throw new BundleError('size_budget_exceeded', { report: built });
      }
      if (plan.maxSizeBytes === undefined && digests.bytes > WARN_BYTES) {
        warnings.push(
          `installed size is ${Math.round(digests.bytes / 1024 / 1024)} MiB; set maxSizeMB to enforce a budget`,
        );
      }
      return built;
    });

    // -- 13. measure -------------------------------------------------------
    if (plan.measure) {
      report = await stage('measure', async () => {
        if (seams.measure === undefined) throw new BundleError('internal');
        const measured = await seams.measure({
          bundleRoot: outRoot,
          executablePath: at(
            binariesDir,
            externalBinName(plan.sidecar.executable, spec.triple),
          ),
          resourcesDir,
          sidecar,
          baseEnv: childEnv,
          files: { count: report.files.count, bytes: report.files.bytes },
        });
        // The start may have written into the bundle; refuse a changed bundle.
        // Nothing but binaries/ and resources/ exists in the root yet, so
        // anything else there was planted by the measured app.
        const rootNames = (await fs.readdir(outRoot)).sort(compare);
        if (rootNames.join('/') !== 'binaries/resources') {
          throw new BundleError('bundle_changed_while_measuring');
        }
        const after = await digestOutput();
        if (
          sha256Hex(formatFileList(after.entries)) !== report.files.listSha256
        ) {
          throw new BundleError('bundle_changed_while_measuring');
        }
        return { ...report, measurements: measured };
      });
    }

    // -- 14. publish -------------------------------------------------------
    await stage('publish', async () => {
      await writeNewFile(
        at(outRoot, 'tauri.bundle.json'),
        tauriBundleText,
        0o644,
        {
          fs,
          platform,
        },
      );
      await writeNewFile(
        at(outRoot, BUNDLE_FILES_FILENAME),
        fileListText,
        0o644,
        {
          fs,
          platform,
        },
      );
      await writeNewFile(
        at(outRoot, BUNDLE_REPORT_FILENAME),
        serializeBundleReport(report),
        0o644,
        { fs, platform },
      );
      await normalizeMetadata(
        fs,
        platform,
        outRoot,
        (seams.sourceDateEpoch ?? EPOCH_1980) * 1000,
      );
      await publishStaging(staging, plan.outDir, {
        fs,
        platform,
        source: 'out',
        existing: plan.force ? 'replace' : 'empty-only',
      });
    });

    return { report, outDir: plan.outDir, warnings, stages: ran };
  } catch (error) {
    if (seams.keepStaging !== true) {
      await disposeStaging(staging, { fs, platform }).catch(() => undefined);
    }
    throw BundleError.from(error);
  }
}
