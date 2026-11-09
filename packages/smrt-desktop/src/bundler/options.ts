import { posix, win32 } from 'node:path';
import { deepFreeze } from '../internal/freeze.js';
import {
  isBundleId,
  isChannel,
  isDisplayText,
  isSemver,
  isSlug,
  isTargetTriple,
} from '../internal/grammar.js';
import type { DisabledGroup } from './graph.js';
import {
  assertRealContained,
  assertReplaceableOutput,
  isContained,
  nodeTreeFs,
  parentPath,
  readRegularText,
  type TreeFs,
} from './paths.js';
import {
  DEFAULT_DATA_DIRECTORY,
  DEFAULT_HEALTH_ROUTE,
  DEFAULT_SIDECAR_ARGS,
  type NativeException,
  PRODUCT_CONFIG_FILE,
  type ProductConfig,
  readProductConfig,
  resolveFeatures,
} from './product-config.js';
import type { SecretContentPolicy } from './prune.js';
import type { AcknowledgedImport } from './scan-imports.js';
import { BundleTreeError, toTreeError } from './tree-errors.js';

/**
 * Validate CLI/config input into a frozen `BundlePlan`.
 *
 * Everything that later stages trust is decided here: canonical absolute
 * paths, the product identity, the target, the Node version string, the
 * feature set and the output directory. Flags win over the product
 * configuration. Errors are value-free `BundleTreeError`s that name the
 * offending option in `field`.
 */

/** The target triples v1 can describe; `targets.ts` is the authority. */
const SUPPORTED_TRIPLE =
  /^(aarch64|x86_64)-(apple-darwin|unknown-linux-gnu|pc-windows-msvc)$/;
const NODE_VERSION = /^\d+\.\d+\.\d+$/;

export interface PlanTarget {
  readonly triple: string;
  readonly os: 'darwin' | 'linux' | 'win32';
  readonly arch: 'x64' | 'arm64';
  readonly libc?: 'glibc';
}

/** Parse a supported triple, or `undefined`. */
export function parseTargetTriple(triple: string): PlanTarget | undefined {
  const match = SUPPORTED_TRIPLE.exec(triple);
  if (match === null) return undefined;
  const arch = match[1] === 'aarch64' ? 'arm64' : 'x64';
  switch (match[2]) {
    case 'apple-darwin':
      return { triple, os: 'darwin', arch };
    case 'unknown-linux-gnu':
      return { triple, os: 'linux', arch, libc: 'glibc' };
    default:
      return { triple, os: 'win32', arch };
  }
}

/** The triple for the machine running the bundler, or `undefined`. */
export function hostTriple(
  platform: NodeJS.Platform,
  arch: string,
): string | undefined {
  const cpu = arch === 'arm64' ? 'aarch64' : arch === 'x64' ? 'x86_64' : '';
  if (cpu === '') return undefined;
  switch (platform) {
    case 'darwin':
      return `${cpu}-apple-darwin`;
    case 'linux':
      return `${cpu}-unknown-linux-gnu`;
    case 'win32':
      return `${cpu}-pc-windows-msvc`;
    default:
      return undefined;
  }
}

export interface BundleOptionsInput {
  /** Application root (contains `package.json` and `pnpm-lock.yaml`). */
  readonly appDir: string;
  /** adapter-node output. Default `<appDir>/build`; must be inside `appDir`. */
  readonly buildDir?: string;
  /** Output directory. Must not exist (or be empty) unless `force`. */
  readonly outDir: string;
  /** Path of `smrt-desktop.json`. Default `<appDir>/smrt-desktop.json`. */
  readonly productConfigPath?: string;
  readonly target?: string;
  readonly productId?: string;
  readonly bundleId?: string;
  readonly displayName?: string;
  readonly productVersion?: string;
  readonly channel?: string;
  readonly nodeVersion?: string;
  readonly nodeArchive?: string;
  readonly nodeCache?: string;
  /**
   * The PRE-BUNDLED single-file MCP bridge (`--bridge`). The bundler does not
   * bundle JavaScript itself; the app-cli publication of this file is a
   * follow-up (see the README).
   */
  readonly bridgeFile?: string;
  /** Extra enabled features, added to the config's `features.default`. */
  readonly features?: readonly string[];
  readonly maxSizeMB?: number;
  readonly keepSourceMaps?: boolean;
  readonly offline?: boolean;
  readonly force?: boolean;
  readonly measure?: boolean;
  /**
   * A prepared (migrated) data directory that `--measure` copies for every
   * run. SMRT apps never create their own schema at run time, so a fresh
   * directory would not start: prepare one with
   * `SMRT_APP_ID=<id> SMRT_DATA_DIR=<dir> smrt app migrate`.
   */
  readonly measureDataDir?: string;
  /** Default `fail` (design O5). */
  readonly secretContentPolicy?: SecretContentPolicy;
  /**
   * The release and signing path (`--require-verified-pins`): refuse a Node
   * pin that is not `gpg-verified` (`node_pin_unverified`, exit 4). Without
   * it an unverified pin only warns.
   */
  readonly requireVerifiedPins?: boolean;
}

export interface BundleEnvironment {
  readonly fs?: TreeFs;
  /** Selects the path flavor and host triple. Default `process.platform`. */
  readonly platform?: NodeJS.Platform;
  /** Default `process.arch`. */
  readonly arch?: string;
  /** Base for relative inputs. Default `process.cwd()`. */
  readonly cwd?: string;
}

export interface BundlePlan {
  readonly version: 1;
  readonly appDir: string;
  readonly buildDir: string;
  readonly outDir: string;
  /** Present when a product configuration file was read. */
  readonly productConfigPath?: string;
  readonly target: PlanTarget;
  readonly product: {
    readonly productId: string;
    readonly bundleId: string;
    readonly displayName: string;
    readonly productVersion: string;
    readonly channel: string;
  };
  readonly sidecar: {
    /** Product-scoped: `<productId>-node`. */
    readonly executable: string;
    readonly args: readonly string[];
    readonly healthRoute: string;
    readonly dataDirectory: string;
    readonly ownerClaimRoute?: string;
  };
  readonly bridge?: { readonly envPrefix: string; readonly mcpPath: string };
  /** Absolute path of the pre-bundled bridge file, when supplied. */
  readonly bridgeFile?: string;
  readonly node: {
    readonly version?: string;
    readonly archive?: string;
    readonly cache?: string;
  };
  readonly features: {
    readonly enabled: readonly string[];
    readonly disabled: readonly DisabledGroup[];
  };
  readonly acknowledgedDynamicImports: readonly AcknowledgedImport[];
  readonly nativeExceptions: readonly NativeException[];
  readonly maxSizeBytes?: number;
  readonly keepSourceMaps: boolean;
  readonly offline: boolean;
  readonly force: boolean;
  readonly measure: boolean;
  /** Absolute path of the prepared data directory `--measure` copies. */
  readonly measureDataDir?: string;
  readonly secretContentPolicy: SecretContentPolicy;
  /** Refuse a Node pin that is not gpg-verified (release and signing path). */
  readonly requireVerifiedPins: boolean;
}

function invalid(field: string): never {
  throw new BundleTreeError('invalid_option', { field });
}

async function lstatOrUndefined(fs: TreeFs, path: string) {
  try {
    return await fs.lstat(path);
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    if (code === 'ENOENT') return undefined;
    throw toTreeError(error);
  }
}

/**
 * Canonicalise a path whose last components may not exist yet: `realpath` of
 * the deepest existing ancestor plus the remaining segments.
 */
async function canonicalLoose(
  fs: TreeFs,
  path: string,
  flavor: typeof posix,
): Promise<string> {
  const rest: string[] = [];
  let current = path;
  for (;;) {
    try {
      const real = await fs.realpath(current);
      return rest.length === 0 ? real : flavor.join(real, ...rest.reverse());
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      if (code !== 'ENOENT') throw toTreeError(error);
    }
    const parent = flavor.dirname(current);
    if (parent === current) throw new BundleTreeError('invalid_option');
    rest.push(flavor.basename(current));
    current = parent;
  }
}

function checkVersionedString(
  value: string | undefined,
  field: string,
  accept: (candidate: unknown) => boolean,
): string | undefined {
  if (value === undefined) return undefined;
  if (!accept(value)) invalid(field);
  return value;
}

/**
 * Resolve and validate `input` into a frozen plan. Reads the application's
 * `package.json` and optional `smrt-desktop.json` and inspects (never
 * modifies) the output directory.
 */
export async function createBundlePlan(
  input: BundleOptionsInput,
  environment: BundleEnvironment = {},
): Promise<BundlePlan> {
  const fs = environment.fs ?? nodeTreeFs;
  const platform = environment.platform ?? process.platform;
  const flavor = platform === 'win32' ? win32 : posix;
  const cwd = environment.cwd ?? process.cwd();
  const resolvePath = (value: unknown, field: string): string => {
    if (
      typeof value !== 'string' ||
      value.length === 0 ||
      value.includes('\0')
    ) {
      invalid(field);
    }
    return flavor.resolve(cwd, value as string);
  };

  // --- Application ---------------------------------------------------------
  const appResolved = resolvePath(input.appDir, 'app');
  let appDir: string;
  try {
    appDir = await fs.realpath(appResolved);
  } catch {
    return invalid('app');
  }
  const appStats = await lstatOrUndefined(fs, appDir);
  if (appStats === undefined || !appStats.isDirectory()) invalid('app');

  const requireFile = async (name: string): Promise<string> => {
    const path = flavor.join(appDir, name);
    const stats = await lstatOrUndefined(fs, path);
    if (stats === undefined || !stats.isFile()) {
      throw new BundleTreeError('missing_app_file', { subjects: [name] });
    }
    return path;
  };
  const packageJsonPath = await requireFile('package.json');
  await requireFile('pnpm-lock.yaml');

  let appManifest: unknown;
  try {
    appManifest = JSON.parse(
      await readRegularText(packageJsonPath, 1024 * 1024, { fs }),
    );
  } catch (error) {
    if (error instanceof BundleTreeError) throw error;
    throw new BundleTreeError('invalid_package_json');
  }
  const appVersion =
    appManifest !== null && typeof appManifest === 'object'
      ? (appManifest as Record<string, unknown>).version
      : undefined;

  // --- Build directory -----------------------------------------------------
  const buildResolved =
    input.buildDir === undefined
      ? flavor.join(appDir, 'build')
      : resolvePath(input.buildDir, 'build');
  if (!isContained(appDir, buildResolved, platform)) {
    throw new BundleTreeError('build_outside_app');
  }
  let buildDir: string;
  try {
    buildDir = await fs.realpath(buildResolved);
  } catch {
    throw new BundleTreeError('missing_app_file', { subjects: ['build'] });
  }
  try {
    await assertRealContained(appDir, buildDir, { fs, platform });
  } catch {
    throw new BundleTreeError('build_outside_app');
  }
  const buildStats = await lstatOrUndefined(fs, buildDir);
  if (buildStats === undefined || !buildStats.isDirectory()) {
    throw new BundleTreeError('missing_app_file', { subjects: ['build'] });
  }

  // --- Product configuration ----------------------------------------------
  let config: ProductConfig | undefined;
  let productConfigPath: string | undefined;
  const explicitConfig = input.productConfigPath !== undefined;
  const configResolved = explicitConfig
    ? resolvePath(input.productConfigPath, 'productConfig')
    : flavor.join(appDir, PRODUCT_CONFIG_FILE);
  if (!isContained(appDir, configResolved, platform)) {
    invalid('productConfig');
  }
  const configStats = await lstatOrUndefined(fs, configResolved);
  if (configStats === undefined) {
    if (explicitConfig) {
      throw new BundleTreeError('missing_app_file', {
        subjects: [PRODUCT_CONFIG_FILE],
      });
    }
  } else {
    config = await readProductConfig(configResolved, { fs });
    productConfigPath = configResolved;
  }

  // --- Identity (flags win) ------------------------------------------------
  const productId = input.productId ?? config?.productId;
  if (!isSlug(productId)) invalid('productId');
  const bundleId = input.bundleId ?? config?.bundleId;
  if (!isBundleId(bundleId)) invalid('bundleId');
  const displayName = input.displayName ?? config?.displayName;
  if (!isDisplayText(displayName)) invalid('displayName');
  const productVersion = input.productVersion ?? appVersion;
  if (!isSemver(productVersion)) invalid('productVersion');
  const channel = input.channel ?? 'stable';
  if (!isChannel(channel)) invalid('channel');

  // --- Target and Node -----------------------------------------------------
  const triple =
    input.target ?? hostTriple(platform, environment.arch ?? process.arch);
  if (triple === undefined || !isTargetTriple(triple)) invalid('target');
  const target = parseTargetTriple(triple as string);
  if (target === undefined) throw new BundleTreeError('unsupported_target');

  const nodeVersion = checkVersionedString(
    input.nodeVersion,
    'nodeVersion',
    (value) => typeof value === 'string' && NODE_VERSION.test(value),
  );
  const nodeArchive =
    input.nodeArchive === undefined
      ? undefined
      : resolvePath(input.nodeArchive, 'nodeArchive');
  const nodeCache =
    input.nodeCache === undefined
      ? undefined
      : resolvePath(input.nodeCache, 'nodeCache');

  const measureDataDir =
    input.measureDataDir === undefined
      ? undefined
      : resolvePath(input.measureDataDir, 'measureData');
  const bridgeFile =
    input.bridgeFile === undefined
      ? undefined
      : resolvePath(input.bridgeFile, 'bridge');

  // --- Features and size ---------------------------------------------------
  const effective: Pick<ProductConfig, 'features' | 'exclude'> = config ?? {
    features: { default: [], custom: {} },
    exclude: [],
  };
  const requestedFeatures = input.features ?? [];
  if (
    !Array.isArray(requestedFeatures) ||
    requestedFeatures.some((name) => typeof name !== 'string')
  ) {
    invalid('features');
  }
  const features = resolveFeatures(effective, requestedFeatures);

  const maxSizeMB = input.maxSizeMB ?? config?.maxSizeMB;
  if (
    maxSizeMB !== undefined &&
    (typeof maxSizeMB !== 'number' ||
      !Number.isInteger(maxSizeMB) ||
      maxSizeMB < 1 ||
      maxSizeMB > 100_000)
  ) {
    invalid('maxSizeMB');
  }

  const secretContentPolicy = input.secretContentPolicy ?? 'fail';
  if (secretContentPolicy !== 'fail' && secretContentPolicy !== 'warn') {
    invalid('secretContentPolicy');
  }

  if (
    input.requireVerifiedPins !== undefined &&
    typeof input.requireVerifiedPins !== 'boolean'
  ) {
    invalid('requireVerifiedPins');
  }

  // --- Output directory ----------------------------------------------------
  const outResolved = resolvePath(input.outDir, 'out');
  // The final component is never followed: a symlink there is refused, only
  // its ancestors are canonicalised.
  const outParentResolved = flavor.dirname(outResolved);
  if (outParentResolved === outResolved) invalid('out');
  const outDir = flavor.join(
    await canonicalLoose(fs, outParentResolved, flavor),
    flavor.basename(outResolved),
  );
  if (
    isContained(appDir, outDir, platform, true) ||
    isContained(outDir, appDir, platform, true)
  ) {
    throw new BundleTreeError('out_dir_inside_source');
  }
  const outParent = parentPath(outDir, platform);
  if (outParent === null) invalid('out');
  const parentStats = await lstatOrUndefined(fs, outParent as string);
  if (parentStats === undefined || !parentStats.isDirectory()) invalid('out');
  const outStats = await lstatOrUndefined(fs, outDir);
  if (outStats !== undefined) {
    if (outStats.isSymbolicLink() || !outStats.isDirectory()) {
      throw new BundleTreeError('destination_exists');
    }
    if (input.force === true) {
      // `--force` replaces an earlier bundle, never arbitrary files.
      await assertReplaceableOutput(outDir, { fs, platform });
    } else if ((await fs.readdir(outDir)).length > 0) {
      throw new BundleTreeError('out_dir_not_empty');
    }
  }

  const sidecarConfig = config?.sidecar;
  const plan: BundlePlan = {
    version: 1,
    appDir,
    buildDir,
    outDir,
    ...(productConfigPath === undefined ? {} : { productConfigPath }),
    target,
    product: {
      productId: productId as string,
      bundleId: bundleId as string,
      displayName: displayName as string,
      productVersion: productVersion as string,
      channel,
    },
    sidecar: {
      executable: `${productId}-node`,
      args: sidecarConfig?.args ?? DEFAULT_SIDECAR_ARGS,
      healthRoute: sidecarConfig?.healthRoute ?? DEFAULT_HEALTH_ROUTE,
      dataDirectory: sidecarConfig?.dataDirectory ?? DEFAULT_DATA_DIRECTORY,
      ...(sidecarConfig?.ownerClaimRoute === undefined
        ? {}
        : { ownerClaimRoute: sidecarConfig.ownerClaimRoute }),
    },
    ...(config?.bridge === undefined ? {} : { bridge: config.bridge }),
    ...(bridgeFile === undefined ? {} : { bridgeFile }),
    node: {
      ...(nodeVersion === undefined ? {} : { version: nodeVersion }),
      ...(nodeArchive === undefined ? {} : { archive: nodeArchive }),
      ...(nodeCache === undefined ? {} : { cache: nodeCache }),
    },
    features: { enabled: features.enabled, disabled: features.disabled },
    acknowledgedDynamicImports: config?.acknowledgedDynamicImports ?? [],
    nativeExceptions: config?.nativeExceptions ?? [],
    ...(maxSizeMB === undefined
      ? {}
      : { maxSizeBytes: maxSizeMB * 1024 * 1024 }),
    keepSourceMaps: input.keepSourceMaps === true,
    offline: input.offline === true,
    force: input.force === true,
    measure: input.measure === true,
    ...(measureDataDir === undefined ? {} : { measureDataDir }),
    secretContentPolicy,
    requireVerifiedPins: input.requireVerifiedPins === true,
  };
  return deepFreeze(plan);
}
