import { deepFreeze } from '../internal/freeze.js';
import {
  isBundleId,
  isDisplayText,
  isEnvPrefix,
  isLoopbackRoute,
  isPortablePath,
  isSlug,
  isValidText,
} from '../internal/grammar.js';
import {
  hasClosedKeys,
  isRecord,
  parseStrictJson,
} from '../internal/strict-json.js';
import { type DisabledGroup, isPackagePattern } from './graph.js';
import { readRegularText, type TreeFs } from './paths.js';
import type { AcknowledgedImport } from './scan-imports.js';
import { BundleTreeError } from './tree-errors.js';

/**
 * The product's desktop configuration, `smrt-desktop.json` at the
 * application root (design 4.2). One strict-JSON document with a closed
 * schema: unknown keys, duplicate keys, wrong types and out-of-grammar values
 * are rejected, and no error message echoes a value.
 *
 * ```json
 * {
 *   "version": 1,
 *   "productId": "smrt-start",
 *   "bundleId": "com.happyvertical.smrt-start",
 *   "displayName": "SMRT Start",
 *   "bridge": { "envPrefix": "SMRT_START", "mcpPath": "/api/mcp" },
 *   "sidecar": { "healthRoute": "/api/_runtime/health", "dataDirectory": "runtime" },
 *   "features": { "default": [], "custom": {} },
 *   "exclude": [],
 *   "maxSizeMB": 350,
 *   "nativeExceptions": [],
 *   "acknowledgedDynamicImports": []
 * }
 * ```
 */

export const PRODUCT_CONFIG_FILE = 'smrt-desktop.json';
export const PRODUCT_CONFIG_MAX_BYTES = 64 * 1024;

export const DEFAULT_SIDECAR_ARGS: readonly string[] = Object.freeze([
  'app/build/index.js',
]);
export const DEFAULT_HEALTH_ROUTE = '/api/_runtime/health';
export const DEFAULT_DATA_DIRECTORY = 'runtime';

// ---------------------------------------------------------------------------
// Feature catalog
// ---------------------------------------------------------------------------

export interface FeatureDefinition {
  readonly description: string;
  /** Package names or `*` patterns removed unless the feature is enabled. */
  readonly packages: readonly string[];
  /** False for the build toolchain, which a production bundle never carries. */
  readonly enableable: boolean;
}

/**
 * Built-in feature catalog. Everything in a feature is excluded unless the
 * feature is enabled. A product may add features (`features.custom`) but not
 * redefine these.
 */
export const FEATURE_CATALOG: Readonly<Record<string, FeatureDefinition>> =
  deepFreeze({
    toolchain: {
      description: 'Build toolchain that must never ship in a runtime bundle',
      packages: [
        'vite',
        'rolldown',
        '@rolldown/*',
        'esbuild',
        '@esbuild/*',
        'lightningcss*',
        'typescript',
        'tsx',
        // Compile-time only. `@oxc-project/runtime` is NOT here: it holds the
        // decorator helpers that compiled SMRT models import at run time.
        'oxc-*',
        '@oxc-parser/*',
        '@oxc-transform/*',
        '@oxc-resolver/*',
        '@oxc-minify/*',
        '@oxc-project/types',
        '@types/*',
      ],
      enableable: false,
    },
    'google-apis': {
      description: 'Google API client libraries',
      packages: ['googleapis', 'googleapis-common'],
      enableable: true,
    },
    duckdb: {
      description: 'DuckDB engine and its native bindings',
      packages: ['@duckdb/*'],
      enableable: true,
    },
    'vector-sqlite': {
      description: 'SQLite vector search extension',
      packages: ['sqlite-vss*'],
      enableable: true,
    },
    images: {
      description: 'Image processing, vision models and SVG rendering',
      packages: [
        '@happyvertical/images',
        'sharp',
        '@img/*',
        '@resvg/*',
        '@mediapipe/*',
        'jimp',
        '@jimp/*',
        'satori',
      ],
      enableable: true,
    },
    'ai-providers': {
      description: 'All cloud AI provider SDKs (the three below together)',
      packages: ['@google/genai', 'openai', '@anthropic-ai/sdk'],
      enableable: true,
    },
    'ai-anthropic': {
      description: 'Anthropic SDK (Claude), one of ai-providers',
      packages: ['@anthropic-ai/sdk'],
      enableable: true,
    },
    'ai-openai': {
      description: 'OpenAI SDK, one of ai-providers',
      packages: ['openai'],
      enableable: true,
    },
    'ai-google': {
      description: 'Google Gemini SDK, one of ai-providers',
      packages: ['@google/genai'],
      enableable: true,
    },
    ocr: {
      description: 'Optical character recognition',
      packages: ['@happyvertical/ocr', 'tesseract.js*', 'onnxruntime-*'],
      enableable: true,
    },
    pdf: {
      description: 'PDF processing',
      packages: ['@happyvertical/pdf', 'pdfjs-dist'],
      enableable: true,
    },
  });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface NativeException {
  /** Glob under `app/node_modules`; matching files are deleted, never shipped. */
  readonly path: string;
  readonly reason: string;
}

export interface ProductConfig {
  readonly version: 1;
  readonly productId: string;
  readonly bundleId: string;
  readonly displayName: string;
  readonly bridge?: { readonly envPrefix: string; readonly mcpPath: string };
  readonly sidecar: {
    readonly executable?: string;
    readonly args: readonly string[];
    readonly healthRoute: string;
    readonly dataDirectory: string;
    readonly ownerClaimRoute?: string;
  };
  readonly features: {
    readonly default: readonly string[];
    readonly custom: Readonly<
      Record<string, { readonly packages: readonly string[] }>
    >;
  };
  readonly exclude: readonly string[];
  readonly maxSizeMB?: number;
  readonly nativeExceptions: readonly NativeException[];
  readonly acknowledgedDynamicImports: readonly AcknowledgedImport[];
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function bad(field: string): never {
  throw new BundleTreeError('config_invalid_field', { field });
}

const featureName = /^[a-z][a-z0-9-]{0,31}$/;
const globPath = /^(?:[A-Za-z0-9@._*+~-]+\/)*[A-Za-z0-9@._*+~-]+$/;
const FORBIDDEN_NODE_FLAGS: ReadonlySet<string> = new Set([
  '-e',
  '--eval',
  '-p',
  '--print',
  '-r',
  '--require',
  '--import',
  '--loader',
  '--experimental-loader',
  '--input-type',
  '--env-file',
  '--watch',
  '--test',
  '-i',
  '--interactive',
]);

function stringArray(
  value: unknown,
  field: string,
  max: number,
  accept: (item: unknown) => boolean,
  unique = true,
): string[] {
  if (!Array.isArray(value) || value.length > max) bad(field);
  const items = value as unknown[];
  if (!items.every(accept)) bad(field);
  if (unique && new Set(items).size !== items.length) bad(field);
  return items as string[];
}

function parseArgs(value: unknown): string[] {
  const field = 'sidecar.args';
  const args = stringArray(
    value,
    field,
    16,
    (item) => {
      if (!isValidText(item) || item.length === 0 || item.length > 256) {
        return false;
      }
      if (item.startsWith('-')) {
        const flag = item.split('=')[0] as string;
        return (
          /^-{1,2}[A-Za-z0-9][A-Za-z0-9_.=:,-]*$/.test(item) &&
          !FORBIDDEN_NODE_FLAGS.has(flag) &&
          !flag.startsWith('--inspect')
        );
      }
      return isPortablePath(item) || /^[0-9]+$/.test(item);
    },
    false,
  );
  // At least one non-flag argument: the script node runs.
  if (!args.some((arg) => !arg.startsWith('-'))) bad(field);
  return args;
}

function parseSidecar(value: unknown): ProductConfig['sidecar'] {
  if (value === undefined) {
    return {
      args: DEFAULT_SIDECAR_ARGS,
      healthRoute: DEFAULT_HEALTH_ROUTE,
      dataDirectory: DEFAULT_DATA_DIRECTORY,
    };
  }
  if (!isRecord(value)) bad('sidecar');
  const record = value as Record<string, unknown>;
  if (
    !hasClosedKeys(
      record,
      [],
      ['executable', 'args', 'healthRoute', 'dataDirectory', 'ownerClaimRoute'],
    )
  ) {
    bad('sidecar');
  }
  const healthRoute = record.healthRoute ?? DEFAULT_HEALTH_ROUTE;
  if (!isLoopbackRoute(healthRoute)) bad('sidecar.healthRoute');
  const dataDirectory = record.dataDirectory ?? DEFAULT_DATA_DIRECTORY;
  if (!isPortablePath(dataDirectory)) bad('sidecar.dataDirectory');
  const out: {
    -readonly [K in keyof ProductConfig['sidecar']]: ProductConfig['sidecar'][K];
  } = {
    args:
      record.args === undefined ? DEFAULT_SIDECAR_ARGS : parseArgs(record.args),
    healthRoute,
    dataDirectory,
  };
  if (record.executable !== undefined) {
    if (typeof record.executable !== 'string') bad('sidecar.executable');
    out.executable = record.executable as string;
  }
  if (record.ownerClaimRoute !== undefined) {
    if (!isLoopbackRoute(record.ownerClaimRoute))
      bad('sidecar.ownerClaimRoute');
    out.ownerClaimRoute = record.ownerClaimRoute;
  }
  return out;
}

function parseFeatures(value: unknown): ProductConfig['features'] {
  if (value === undefined) return { default: [], custom: {} };
  if (!isRecord(value)) bad('features');
  const record = value as Record<string, unknown>;
  if (!hasClosedKeys(record, [], ['default', 'custom'])) bad('features');

  const custom: Record<string, { packages: string[] }> = Object.create(null);
  if (record.custom !== undefined) {
    if (!isRecord(record.custom)) bad('features.custom');
    const entries = Object.entries(record.custom as Record<string, unknown>);
    if (entries.length > 32) bad('features.custom');
    for (const [name, definition] of entries) {
      if (!featureName.test(name) || Object.hasOwn(FEATURE_CATALOG, name)) {
        bad('features.custom');
      }
      if (
        !isRecord(definition) ||
        !hasClosedKeys(definition as Record<string, unknown>, ['packages'])
      ) {
        bad('features.custom');
      }
      custom[name] = {
        packages: stringArray(
          (definition as Record<string, unknown>).packages,
          'features.custom',
          200,
          isPackagePattern,
        ),
      };
    }
  }
  const defaults =
    record.default === undefined
      ? []
      : stringArray(record.default, 'features.default', 32, (item) => {
          if (typeof item !== 'string' || !featureName.test(item)) return false;
          const known = FEATURE_CATALOG[item];
          return known !== undefined
            ? known.enableable
            : Object.hasOwn(custom, item);
        });
  return { default: defaults, custom };
}

function parseNativeExceptions(value: unknown): NativeException[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 50) bad('nativeExceptions');
  return (value as unknown[]).map((item) => {
    if (
      !isRecord(item) ||
      !hasClosedKeys(item as Record<string, unknown>, ['path', 'reason'])
    ) {
      bad('nativeExceptions');
    }
    const { path, reason } = item as Record<string, unknown>;
    if (
      typeof path !== 'string' ||
      path.length > 256 ||
      !globPath.test(path) ||
      path.split('/').some((part) => part === '.' || part === '..') ||
      !isDisplayText(reason, 256)
    ) {
      bad('nativeExceptions');
    }
    return { path: path as string, reason: reason as string };
  });
}

function parseAcknowledged(value: unknown): AcknowledgedImport[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100) {
    bad('acknowledgedDynamicImports');
  }
  const accept = (text: unknown) =>
    isValidText(text) &&
    text.length > 0 &&
    text.length <= 214 &&
    !/[\p{Cc}\s]/u.test(text);
  return (value as unknown[]).map((item) => {
    if (
      !isRecord(item) ||
      !hasClosedKeys(item as Record<string, unknown>, ['from', 'specifier'])
    ) {
      bad('acknowledgedDynamicImports');
    }
    const { from, specifier } = item as Record<string, unknown>;
    if (!accept(from) || !accept(specifier)) bad('acknowledgedDynamicImports');
    return { from: from as string, specifier: specifier as string };
  });
}

/**
 * Parse `smrt-desktop.json` text. Throws `BundleTreeError`:
 * `config_invalid_json`, `config_duplicate_keys`, `invalid_product_config`
 * (not an object, unknown or missing top-level keys),
 * `config_unsupported_version` or `config_invalid_field` (with `field`).
 */
export function parseProductConfig(text: string): ProductConfig {
  if (typeof text !== 'string')
    throw new BundleTreeError('config_invalid_json');
  const parsed = parseStrictJson(
    text.charCodeAt(0) === 0xfeff ? text.slice(1) : text,
  );
  if (!parsed.ok) {
    throw new BundleTreeError(
      parsed.reason === 'syntax'
        ? 'config_invalid_json'
        : 'config_duplicate_keys',
    );
  }
  if (!isRecord(parsed.value))
    throw new BundleTreeError('invalid_product_config');
  const record = parsed.value as Record<string, unknown>;
  if (Object.hasOwn(record, 'version') && record.version !== 1) {
    throw new BundleTreeError('config_unsupported_version');
  }
  if (
    !hasClosedKeys(
      record,
      ['version', 'productId', 'bundleId', 'displayName'],
      [
        'bridge',
        'sidecar',
        'features',
        'exclude',
        'maxSizeMB',
        'nativeExceptions',
        'acknowledgedDynamicImports',
      ],
    )
  ) {
    throw new BundleTreeError('invalid_product_config');
  }

  if (!isSlug(record.productId)) bad('productId');
  if (!isBundleId(record.bundleId)) bad('bundleId');
  if (!isDisplayText(record.displayName)) bad('displayName');

  let bridge: ProductConfig['bridge'];
  if (record.bridge !== undefined) {
    if (
      !isRecord(record.bridge) ||
      !hasClosedKeys(record.bridge as Record<string, unknown>, [
        'envPrefix',
        'mcpPath',
      ])
    ) {
      bad('bridge');
    }
    const { envPrefix, mcpPath } = record.bridge as Record<string, unknown>;
    if (!isEnvPrefix(envPrefix)) bad('bridge.envPrefix');
    if (!isLoopbackRoute(mcpPath)) bad('bridge.mcpPath');
    bridge = { envPrefix: envPrefix as string, mcpPath: mcpPath as string };
  }

  const sidecar = parseSidecar(record.sidecar);
  if (
    sidecar.executable !== undefined &&
    sidecar.executable !== `${record.productId}-node`
  ) {
    bad('sidecar.executable');
  }

  const exclude =
    record.exclude === undefined
      ? []
      : stringArray(record.exclude, 'exclude', 200, isPackagePattern);

  let maxSizeMB: number | undefined;
  if (record.maxSizeMB !== undefined) {
    if (
      typeof record.maxSizeMB !== 'number' ||
      !Number.isInteger(record.maxSizeMB) ||
      record.maxSizeMB < 1 ||
      record.maxSizeMB > 100_000
    ) {
      bad('maxSizeMB');
    }
    maxSizeMB = record.maxSizeMB as number;
  }

  const config: ProductConfig = {
    version: 1,
    productId: record.productId as string,
    bundleId: record.bundleId as string,
    displayName: record.displayName as string,
    ...(bridge === undefined ? {} : { bridge }),
    sidecar,
    features: parseFeatures(record.features),
    exclude,
    ...(maxSizeMB === undefined ? {} : { maxSizeMB }),
    nativeExceptions: parseNativeExceptions(record.nativeExceptions),
    acknowledgedDynamicImports: parseAcknowledged(
      record.acknowledgedDynamicImports,
    ),
  };
  return deepFreeze(config);
}

/** Read and parse a product configuration file (regular file, 64 KiB cap). */
export async function readProductConfig(
  path: string,
  options: { fs?: TreeFs } = {},
): Promise<ProductConfig> {
  return parseProductConfig(
    await readRegularText(path, PRODUCT_CONFIG_MAX_BYTES, options),
  );
}

// ---------------------------------------------------------------------------
// Feature resolution
// ---------------------------------------------------------------------------

export interface ResolvedFeatures {
  /** Enabled feature names, sorted and unique. */
  readonly enabled: readonly string[];
  /** One group per disabled feature, in catalog-then-custom name order. */
  readonly disabled: readonly DisabledGroup[];
}

/**
 * Combine the config's default features with the requested ones and return
 * the groups to remove. Unknown feature names, and enabling `toolchain`, are
 * `invalid_option` (field `features`).
 */
export function resolveFeatures(
  config: Pick<ProductConfig, 'features' | 'exclude'>,
  requested: readonly string[],
): ResolvedFeatures {
  const definitions = new Map<string, FeatureDefinition>(
    Object.entries(FEATURE_CATALOG),
  );
  for (const [name, definition] of Object.entries(config.features.custom)) {
    definitions.set(name, {
      description: 'Product feature',
      packages: definition.packages,
      enableable: true,
    });
  }
  const enabled = [
    ...new Set([...config.features.default, ...requested]),
  ].sort();
  for (const name of enabled) {
    const definition = definitions.get(name);
    if (definition === undefined || !definition.enableable) {
      throw new BundleTreeError('invalid_option', { field: 'features' });
    }
  }
  // A pattern that an enabled feature keeps is never removed by another
  // feature that lists it too (`ai-anthropic` inside `ai-providers`).
  const kept = new Set<string>();
  for (const name of enabled) {
    for (const pattern of definitions.get(name)?.packages ?? []) {
      kept.add(pattern);
    }
  }
  const disabled: DisabledGroup[] = [...definitions]
    .filter(([name]) => !enabled.includes(name))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, definition]) => ({
      label: `feature:${name}`,
      patterns: definition.packages.filter((pattern) => !kept.has(pattern)),
    }))
    .filter((group) => group.patterns.length > 0);
  if (config.exclude.length > 0) {
    disabled.push({ label: 'exclude', patterns: config.exclude });
  }
  return deepFreeze({ enabled, disabled });
}
