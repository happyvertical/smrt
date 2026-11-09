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
 * 11. `manifests`   sidecar manifest, `smrt-bundle.json`, overlay; re-parsed
 *                   with the contract parsers and cross-checked.
 * 12. `report`      file digests, `bundle-files.sha256`, report, size budget.
 * 13. `measure`     optional: host start and cold start timing.
 * 14. `publish`     write the report, normalise mtimes, one atomic `rename`.
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

import {
  assertBundleMatchesSidecar,
  type BundleManifestV1,
  parseBundleManifest,
  serializeBundleManifest,
} from '../install/bundle-manifest.js';
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
  stripLifecycleScripts,
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
import { pinnedVersions } from './node-pins.js';
import { type BundlePlan, hostTriple } from './options.js';
import {
  copyTree,
  createStaging,
  disposeStaging,
  ensureDirectories,
  type FilterDecision,
  type FilterEntry,
  hashRegularFile,
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
  type ImportScanReport,
  packageNameOf,
  scanDirectory,
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
const SIDECAR_ENV = Object.freeze({
  NODE_ENV: 'production',
  NODE_OPTIONS: '',
  NODE_PATH: '',
});

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
      return { packageJson, lockfile, workspace, npmrc, config, manifest };
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
      const entry = plan.sidecar.args.find((arg) => !arg.startsWith('-'));
      const entryStats =
        entry === undefined
          ? undefined
          : await lstatOrUndefined(fs, at(resourcesDir, ...entry.split('/')));
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
        }),
        0o644,
        { fs, platform },
      );
    });

    // -- 3. install --------------------------------------------------------
    const childEnv = buildChildEnv(seams.env, {}, { platform });
    const pnpmVersion = await stage('install', async () => {
      await fs.mkdir(installDir, 0o700);
      await writeNewFile(
        at(installDir, 'package.json'),
        json(stripLifecycleScripts(inputs.manifest)),
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
      if (inputs.workspace !== undefined) {
        await writeNewFile(
          at(installDir, 'pnpm-workspace.yaml'),
          inputs.workspace,
          0o600,
          { fs, platform },
        );
      }
      if (inputs.npmrc !== undefined) {
        // Used by pnpm for scoped registries; never copied to the output.
        await writeNewFile(at(installDir, '.npmrc'), inputs.npmrc, 0o600, {
          fs,
          platform,
        });
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

      const version = await seams.pnpmVersion(childEnv, installDir);
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
      assertNoMissingDependencies(graph);
      const result = computeSegmentation(graph, plan.features.disabled);

      const candidates = packages.filter(
        (pkg) =>
          result.keep.has(pkg.id) &&
          (pkg.installScripts.length > 0 || pkg.gypfile),
      );
      const facts = [];
      for (const pkg of candidates) {
        facts.push({
          name: pkg.name,
          scripts: Object.fromEntries(
            pkg.installScripts.map((script) => [script, 'present']),
          ),
          gypfile: pkg.gypfile,
          hasPrebuiltNode: await shipsPrebuiltAddon(
            fs,
            at(installModules, ...pkg.dir.split('/')),
            platform,
          ),
        });
      }
      const needBuild = findBuildStepPackages(facts);
      if (needBuild.length > 0) {
        throw new BundleError('build_step_required', { subjects: needBuild });
      }
      for (const orphan of result.orphans) {
        warnings.push(
          `package not reachable from direct dependencies: ${orphan}`,
        );
      }
      return { packages, graph, result };
    });

    // -- 6. prune_copy -----------------------------------------------------
    let removedFiles = 0;
    let removedBytes = 0;
    await stage('prune_copy', async () => {
      const prune = createNodeModulesFilter({
        keepSourceMaps: plan.keepSourceMaps,
        target: {
          platform: spec.nodePlatform,
          arch: spec.nodeArch,
          ...(spec.pnpm.libc === undefined ? {} : { libc: spec.pnpm.libc }),
        },
        entryPaths: entryPathsByDir(segmentation.packages),
        removedDirs: segmentation.result.removedDirs,
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
    });

    // -- 7. scan -----------------------------------------------------------
    const acknowledged: { from: string; specifier: string }[] = [];
    await stage('scan', async () => {
      const isRemoved = createRemovalChecker(
        segmentation.graph,
        segmentation.result,
      );
      const reports: ImportScanReport[] = [];
      reports.push(
        await scanDirectory({
          root: buildDest,
          kind: 'app-build',
          isRemoved,
          acknowledged: plan.acknowledgedDynamicImports,
          fs,
          platform,
        }),
      );
      reports.push(
        await scanDirectory({
          root: modulesDest,
          kind: 'node-modules',
          isRemoved,
          acknowledged: plan.acknowledgedDynamicImports,
          fs,
          platform,
        }),
      );
      for (const report of reports) assertNoRemovedImports(report);
      for (const report of reports) {
        for (const finding of report.acknowledged) {
          acknowledged.push({
            from: finding.path,
            specifier: finding.specifier,
          });
        }
        if (report.nonLiteral.length > 0) {
          warnings.push(
            `${report.nonLiteral.length} non-literal import(s) cannot be checked statically`,
          );
        }
        if (report.unscanned.length > 0) {
          warnings.push(`${report.unscanned.length} file(s) were not scanned`);
        }
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
      const foreign = found.refs.filter(
        (ref) => !ref.specifier.startsWith('node:'),
      );
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
      const version =
        plan.node.version ??
        pinnedVersions().find((candidate) => candidate.startsWith('26.')) ??
        pinnedVersions()[0];
      if (version === undefined) throw new BundleError('internal');
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
      healthRoute: plan.sidecar.healthRoute,
      dataDirectory: plan.sidecar.dataDirectory,
      env: { ...SIDECAR_ENV },
      ...(plan.sidecar.ownerClaimRoute === undefined
        ? {}
        : { ownerClaimRoute: plan.sidecar.ownerClaimRoute }),
    };
    await stage('manifests', async () => {
      const bundle: BundleManifestV1 = {
        version: 1,
        productId: plan.product.productId,
        bundleId: plan.product.bundleId,
        displayName: plan.product.displayName,
        productVersion: plan.product.productVersion,
        channel: plan.product.channel,
        target: plan.target.triple,
        sidecarManifest: 'sidecar-manifest.json',
        node: { executable: plan.sidecar.executable },
        bridge: {
          entry: BRIDGE_ENTRY,
          envPrefix: bridgeConfig.envPrefix,
          mcpPath: bridgeConfig.mcpPath,
          serverName: plan.product.productId,
          serverVersion: plan.product.productVersion,
        },
      };
      const sidecarPath = at(resourcesDir, 'sidecar-manifest.json');
      const bundlePath = at(resourcesDir, 'smrt-bundle.json');
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
        await writeNewFile(bundlePath, serializeBundleManifest(bundle), 0o644, {
          fs,
          platform,
        });
        const sidecarText = await readRegularText(sidecarPath, MAX_SMALL_TEXT, {
          fs,
        });
        const bundleText = await readRegularText(bundlePath, MAX_SMALL_TEXT, {
          fs,
        });
        const parsedSidecar = parseSidecarManifest(sidecarText);
        const parsedBundle = parseBundleManifest(bundleText);
        assertBundleMatchesSidecar(parsedBundle, parsedSidecar);
        if (
          serializeSidecarManifest(parsedSidecar) !== sidecarText ||
          serializeBundleManifest(parsedBundle) !== bundleText
        ) {
          throw new BundleError('manifest_round_trip');
        }
      } catch (error) {
        if (error instanceof BundleError || error instanceof BundleTreeError) {
          throw error;
        }
        throw new BundleError('manifest_round_trip');
      }
      await writeNewFile(
        at(outRoot, 'tauri.bundle.json'),
        json({
          bundle: {
            externalBin: [`binaries/${plan.sidecar.executable}`],
            resources: { 'resources/': './' },
          },
        }),
        0o644,
        { fs, platform },
      );
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
      await writeNewFile(at(outRoot, BUNDLE_FILES_FILENAME), list, 0o644, {
        fs,
        platform,
      });

      const removedPackages = segmentation.result.removed
        .map((item) => ({
          name: item.name,
          version: item.version,
          path: `resources/app/node_modules/${item.dir}`,
          reason: item.reason,
        }))
        .sort((a, b) => compare(a.path, b.path));
      const keptPackages = segmentation.packages
        .filter((pkg) => segmentation.result.keep.has(pkg.id))
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
          `installed size is ${Math.round(digests.bytes / 1024 / 1024)} MB; set maxSizeMB to enforce a budget`,
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
