/**
 * `smrt desktop bundle`: build the runtime bundle of an SMRT desktop app
 * (the Node sidecar, the production dependencies, the adapter-node build, the
 * bridge and the contract manifests) for one target.
 *
 * This file is deliberately thin. Parsing and exit-code mapping live here;
 * the pipeline lives in `@happyvertical/smrt-desktop/bundler`, which is
 * imported lazily so that no other `smrt` command pays for it. See that
 * package's README for the layout, the report and the threat model.
 */

import type { CLICommand } from '../cli-generator.js';

/** Raw option bag as the CLI parser yields it. */
export interface DesktopBundleCliOptions {
  app?: string;
  build?: string;
  config?: string;
  target?: string;
  out?: string;
  'product-id'?: string;
  'bundle-id'?: string;
  'display-name'?: string;
  'product-version'?: string;
  channel?: string;
  'node-version'?: string;
  'node-archive'?: string;
  'node-cache'?: string;
  bridge?: string;
  features?: string;
  'max-size'?: string | number;
  measure?: boolean;
  offline?: boolean;
  'keep-sourcemaps'?: boolean;
  'require-verified-pins'?: boolean;
  force?: boolean;
  json?: boolean;
}

type BundlerModule = typeof import('@happyvertical/smrt-desktop/bundler');
type BundleOptionsInput =
  import('@happyvertical/smrt-desktop/bundler').BundleOptionsInput;

/** Everything the command touches outside its own logic. */
export interface DesktopBundleIo {
  loadBundler(): Promise<BundlerModule>;
  stdout(text: string): void;
  stderr(text: string): void;
}

const defaultIo: DesktopBundleIo = {
  loadBundler: () => import('@happyvertical/smrt-desktop/bundler'),
  stdout: (text) => {
    process.stdout.write(text);
  },
  stderr: (text) => {
    process.stderr.write(text);
  },
};

/** A bad flag: reported as a usage error (exit 2) by the bundler's table. */
export class DesktopBundleUsageError extends Error {
  constructor(readonly field: string) {
    super(`Invalid or missing option: --${field}`);
    this.name = 'DesktopBundleUsageError';
  }
}

/** The result of parsing: bundler input plus the CLI-only switches. */
export interface ParsedDesktopBundle {
  readonly input: BundleOptionsInput;
  readonly json: boolean;
}

function text(
  options: DesktopBundleCliOptions,
  key: keyof DesktopBundleCliOptions,
): string | undefined {
  const value = options[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0) {
    throw new DesktopBundleUsageError(key);
  }
  return value;
}

/**
 * Turn the positional arguments and raw options into `BundleOptionsInput`.
 * Throws `DesktopBundleUsageError` for anything malformed; everything else
 * (slugs, triples, versions, paths) is validated by the bundler's own plan.
 */
export function parseDesktopBundleOptions(
  args: readonly string[],
  options: DesktopBundleCliOptions,
): ParsedDesktopBundle {
  if (args.length > 0) throw new DesktopBundleUsageError('(arguments)');
  const out = text(options, 'out');
  if (out === undefined) throw new DesktopBundleUsageError('out');

  let maxSizeMB: number | undefined;
  const rawMax = options['max-size'];
  if (rawMax !== undefined) {
    const parsed = typeof rawMax === 'number' ? rawMax : Number(rawMax);
    if (!Number.isInteger(parsed) || parsed < 1) {
      throw new DesktopBundleUsageError('max-size');
    }
    maxSizeMB = parsed;
  }

  let features: string[] | undefined;
  const rawFeatures = text(options, 'features');
  if (rawFeatures !== undefined) {
    features = rawFeatures.split(',').map((name) => name.trim());
    if (features.some((name) => name.length === 0)) {
      throw new DesktopBundleUsageError('features');
    }
  }

  const flag = (key: keyof DesktopBundleCliOptions): boolean | undefined => {
    const value = options[key];
    if (value === undefined) return undefined;
    if (typeof value !== 'boolean') throw new DesktopBundleUsageError(key);
    return value;
  };

  const optional = <T>(name: string, value: T | undefined) =>
    value === undefined ? {} : { [name]: value };

  const input: BundleOptionsInput = {
    appDir: text(options, 'app') ?? '.',
    outDir: out,
    ...optional('buildDir', text(options, 'build')),
    ...optional('productConfigPath', text(options, 'config')),
    ...optional('target', text(options, 'target')),
    ...optional('productId', text(options, 'product-id')),
    ...optional('bundleId', text(options, 'bundle-id')),
    ...optional('displayName', text(options, 'display-name')),
    ...optional('productVersion', text(options, 'product-version')),
    ...optional('channel', text(options, 'channel')),
    ...optional('nodeVersion', text(options, 'node-version')),
    ...optional('nodeArchive', text(options, 'node-archive')),
    ...optional('nodeCache', text(options, 'node-cache')),
    ...optional('bridgeFile', text(options, 'bridge')),
    ...optional('features', features),
    ...optional('maxSizeMB', maxSizeMB),
    ...optional('keepSourceMaps', flag('keep-sourcemaps')),
    ...optional('offline', flag('offline')),
    ...optional('force', flag('force')),
    ...optional('requireVerifiedPins', flag('require-verified-pins')),
    ...optional('measure', flag('measure')),
  };
  return { input, json: flag('json') === true };
}

function formatBytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

/**
 * Run the command and return its process exit code. Never throws: every
 * failure is mapped through `bundleExitCode` (the closed table in
 * `@happyvertical/smrt-desktop/bundler`).
 */
export async function runDesktopBundle(
  args: readonly string[],
  options: DesktopBundleCliOptions,
  io: DesktopBundleIo = defaultIo,
): Promise<number> {
  let bundler: BundlerModule;
  try {
    bundler = await io.loadBundler();
  } catch {
    io.stderr('smrt desktop bundle: the bundler could not be loaded\n');
    return 1;
  }
  const json = options.json === true;

  const fail = (error: unknown): number => {
    const known = error instanceof DesktopBundleUsageError;
    const bundleError = known
      ? new bundler.BundleError(
          'invalid_option',
          { field: error.field },
          'tree',
        )
      : bundler.BundleError.from(error);
    const exitCode = bundleError.exitCode;
    if (json) {
      io.stdout(
        `${JSON.stringify(bundler.bundleFailureDocument(bundleError))}\n`,
      );
    }
    const where =
      bundleError.stage === undefined ? '' : ` (${bundleError.stage})`;
    io.stderr(
      `smrt desktop bundle: ${bundleError.message}${where} [${bundleError.code}, exit ${exitCode}]\n`,
    );
    if (bundleError.field !== undefined) {
      io.stderr(`  option: ${bundleError.field}\n`);
    }
    for (const subject of bundleError.subjects) io.stderr(`  - ${subject}\n`);
    for (const failure of bundleError.failures) {
      io.stderr(`  - ${failure.path}: ${failure.reason}\n`);
    }
    if (bundleError.report !== undefined && !json) {
      io.stderr(
        `  installed size: ${formatBytes(bundleError.report.files.bytes)} (${bundleError.report.files.count} files); nothing was published\n`,
      );
    }
    return exitCode;
  };

  try {
    const parsed = parseDesktopBundleOptions(args, options);
    const plan = await bundler.createBundlePlan(parsed.input);
    let step = 0;
    const seams = bundler.createBundleSeams({
      onStage: (stage) => {
        step += 1;
        if (!parsed.json) {
          io.stderr(
            `[${step}/${bundler.BUNDLE_STAGES.length}] ${stage.replace('_', ' ')}\n`,
          );
        }
      },
    });
    const result = await bundler.runBundle(plan, seams);
    const { report } = result;
    if (parsed.json) {
      io.stdout(bundler.serializeBundleReport(report));
      for (const warning of result.warnings) io.stderr(`warning: ${warning}\n`);
      return 0;
    }
    for (const warning of result.warnings) io.stderr(`warning: ${warning}\n`);
    const { breakdown } = report.files;
    io.stdout(
      [
        `Bundle written to ${result.outDir}`,
        `  product   ${report.product.productId}@${report.product.productVersion} (${report.target})`,
        `  node      ${report.node.version} (${report.node.distFile}, pin ${report.node.pin.verification})`,
        `  size      ${formatBytes(report.files.bytes)} in ${report.files.count} files`,
        `            node ${formatBytes(breakdown.nodeBinary)}, node_modules ${formatBytes(breakdown.nodeModules)}, app build ${formatBytes(breakdown.appBuild)}, other ${formatBytes(breakdown.other)}`,
        `  packages  ${report.packages.length} kept, ${report.features.removedPackages.length} removed`,
        `  natives   ${report.natives.length}`,
        ...(report.measurements === undefined
          ? []
          : [
              `  cold start  first run ${report.measurements.coldStart.firstRun.medianMs} ms, warm ${report.measurements.coldStart.warm.medianMs} ms (median)`,
            ]),
        `  report    ${result.outDir}/bundle-report.json`,
        '',
      ].join('\n'),
    );
    return 0;
  } catch (error) {
    return fail(error);
  }
}

export const desktopCommands: Record<string, CLICommand> = {
  'desktop bundle': {
    name: 'desktop bundle',
    description:
      'Bundle a built SMRT app with its own Node sidecar for a desktop target (run `smrt app build` first; exit codes: 0 ok, 2 usage, 3 invalid input, 4 provenance, 5 verification, 6 size budget, 7 child failed, 8 io)',
    args: [],
    options: {
      app: {
        type: 'string',
        description:
          'Application directory with package.json and pnpm-lock.yaml (default: .)',
      },
      build: {
        type: 'string',
        description:
          'adapter-node output directory inside --app (default: <app>/build)',
      },
      config: {
        type: 'string',
        description:
          'Product configuration inside --app (default: <app>/smrt-desktop.json)',
      },
      target: {
        type: 'string',
        description:
          'Rust target triple: aarch64-apple-darwin, x86_64-apple-darwin, x86_64-unknown-linux-gnu, aarch64-unknown-linux-gnu, x86_64-pc-windows-msvc or aarch64-pc-windows-msvc (default: this machine)',
      },
      out: {
        type: 'string',
        description:
          'Output directory (required); it must not exist or be empty unless --force',
      },
      bridge: {
        type: 'string',
        description:
          'The pre-bundled single-file MCP bridge (.mjs; node: imports only)',
      },
      'product-id': {
        type: 'string',
        description:
          'Product slug (default: smrt-desktop.json); names the sidecar <product-id>-node',
      },
      'bundle-id': {
        type: 'string',
        description:
          'Reverse-DNS application identifier (default: smrt-desktop.json)',
      },
      'display-name': {
        type: 'string',
        description: 'Product display name (default: smrt-desktop.json)',
      },
      'product-version': {
        type: 'string',
        description:
          'Semantic product version (default: the app package.json version)',
      },
      channel: {
        type: 'string',
        description: 'Release channel (default: stable)',
      },
      'node-version': {
        type: 'string',
        description:
          'Exact Node version; it must be pinned in the bundler (default: newest pinned 26.x)',
      },
      'node-archive': {
        type: 'string',
        description:
          'Offline Node distribution file; it is checked against the committed pin',
      },
      'node-cache': {
        type: 'string',
        description:
          'Directory caching Node downloads (default: the OS cache directory)',
      },
      features: {
        type: 'string',
        description:
          'Comma-separated feature groups to keep in addition to the product defaults (google-apis, duckdb, vector-sqlite, images, ai-providers, ocr, pdf, or product-defined)',
      },
      'max-size': {
        type: 'string',
        description:
          'Installed size budget in MiB (1024 x 1024 bytes); exceeding it exits 6 and publishes nothing',
      },
      measure: {
        type: 'boolean',
        description:
          'Start the bundled app on this machine from an empty data directory (it creates its own schema) and record installed size and cold start (host target only)',
        default: false,
      },
      offline: {
        type: 'boolean',
        description:
          'Install with pnpm --offline and never download Node (needs the pnpm store and the Node cache)',
        default: false,
      },
      'keep-sourcemaps': {
        type: 'boolean',
        description: 'Keep *.map files',
        default: false,
      },
      'require-verified-pins': {
        type: 'boolean',
        description:
          'Release and signing path: refuse a Node pin that is not verified against the Node.js release signature with gpg (exit 4); without it an unverified pin only warns',
        default: false,
      },
      force: {
        type: 'boolean',
        description:
          'Replace an earlier bundle (or an empty directory) at --out: moved aside, removed after success; any other directory is refused',
        default: false,
      },
      json: {
        type: 'boolean',
        description:
          'Print the bundle report (or a failure document) as JSON on stdout; progress goes to stderr',
        default: false,
      },
    },
    handler: async (args: string[], options: DesktopBundleCliOptions) => {
      const code = await runDesktopBundle(args, options);
      if (code !== 0) process.exitCode = code;
    },
  },
};
