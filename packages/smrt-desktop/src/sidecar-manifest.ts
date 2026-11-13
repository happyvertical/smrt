import {
  asciiLower,
  isLoopbackRoute,
  isPortablePath,
  isPortableSegment,
  isValidText,
} from './internal/grammar.js';
import { hasDuplicateKeys } from './internal/strict-json.js';

/** The version 1 wire contract for a bundled SMRT desktop sidecar. */
export interface SidecarManifestV1 {
  readonly version: 1;
  /** Logical Tauri `externalBin` basename: one portable segment, no suffix. */
  readonly executable: string;
  readonly args: readonly string[];
  /** Run a normal built app from resources/app; absent keeps the resource root. */
  readonly workingDirectory?: 'app';
  readonly healthRoute: string;
  readonly dataDirectory: string;
  /** Extra environment for the sidecar. Reserved names are rejected. */
  readonly env?: Readonly<Record<string, string>>;
  /** Path on the supervisor-selected origin where owner setup lives. */
  readonly ownerClaimRoute?: string;
}

/**
 * Environment variable names the supervisor supplies, matched
 * case-insensitively. A manifest may not set them and they always win.
 */
export const RESERVED_ENV_KEYS = [
  'HOST',
  'PORT',
  'ORIGIN',
  'SMRT_DATA_DIR',
  'SMRT_DESKTOP_OWNER_LINK_SECRET',
] as const;

const requiredKeys = [
  'version',
  'executable',
  'args',
  'healthRoute',
  'dataDirectory',
] as const satisfies readonly (keyof SidecarManifestV1)[];
const optionalKeys = [
  'env',
  'ownerClaimRoute',
  'workingDirectory',
] as const satisfies readonly (keyof SidecarManifestV1)[];
const manifestKeys: ReadonlySet<string> = new Set([
  ...requiredKeys,
  ...optionalKeys,
]);

const envName = /^[A-Za-z_][A-Za-z0-9_]*$/;
const reservedEnvKeys: ReadonlySet<string> = new Set(
  RESERVED_ENV_KEYS.map(asciiLower),
);

/** Validate an `env` value and return its entries in declaration order. */
function envEntries(value: unknown): [string, string][] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Sidecar manifest env must be an object of strings');
  }

  const entries = Object.entries(value);
  const seen = new Set<string>();
  for (const [name, text] of entries) {
    if (!envName.test(name) || !isValidText(text)) {
      throw new Error(
        'Sidecar manifest env requires portable names and valid string values',
      );
    }
    const folded = asciiLower(name);
    if (reservedEnvKeys.has(folded)) {
      throw new Error(
        `Sidecar manifest env must not set supervisor-reserved names (${RESERVED_ENV_KEYS.join(', ')})`,
      );
    }
    if (seen.has(folded)) {
      throw new Error(
        'Sidecar manifest env names must be unique ignoring case',
      );
    }
    seen.add(folded);
  }
  return entries;
}

/** Parse a packaged JSON manifest or throw with a value-free diagnostic. */
export function parseSidecarManifest(json: string): SidecarManifestV1 {
  if (typeof json !== 'string') {
    throw new Error('Sidecar manifest must be JSON text');
  }

  let input: unknown;
  try {
    input = JSON.parse(json);
  } catch {
    throw new Error('Sidecar manifest must be valid JSON');
  }
  if (hasDuplicateKeys(json)) {
    throw new Error('Sidecar manifest must not repeat object keys');
  }

  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Sidecar manifest must be a JSON object');
  }

  const record = input as Record<string, unknown>;
  if (!Object.hasOwn(record, 'version') || record.version !== 1) {
    throw new Error('Sidecar manifest requires supported version 1');
  }
  if (
    !Object.keys(record).every((key) => manifestKeys.has(key)) ||
    !requiredKeys.every((key) => Object.hasOwn(record, key))
  ) {
    throw new Error(
      'Sidecar manifest v1 requires exactly the documented fields',
    );
  }

  const { executable, args, healthRoute, dataDirectory } = record;
  if (!isPortableSegment(executable)) {
    throw new Error(
      'Sidecar manifest executable must be one portable basename',
    );
  }
  if (!Array.isArray(args) || !args.every(isValidText)) {
    throw new Error('Sidecar manifest args must be an array of valid strings');
  }
  if (!isLoopbackRoute(healthRoute)) {
    throw new Error(
      'Sidecar manifest healthRoute must be a local absolute path',
    );
  }
  if (!isPortablePath(dataDirectory)) {
    throw new Error(
      'Sidecar manifest dataDirectory must be a portable relative path',
    );
  }

  const manifest: {
    -readonly [K in keyof SidecarManifestV1]: SidecarManifestV1[K];
  } = {
    version: 1,
    executable,
    args: args as string[],
    healthRoute,
    dataDirectory,
  };
  if (Object.hasOwn(record, 'workingDirectory')) {
    if (record.workingDirectory !== 'app')
      throw new Error('Sidecar manifest workingDirectory must be app');
    manifest.workingDirectory = 'app';
  }
  if (Object.hasOwn(record, 'env')) {
    // fromEntries defines own properties, so a `__proto__` name stays data.
    manifest.env = Object.fromEntries(envEntries(record.env));
  }
  if (Object.hasOwn(record, 'ownerClaimRoute')) {
    if (!isLoopbackRoute(record.ownerClaimRoute)) {
      throw new Error(
        'Sidecar manifest ownerClaimRoute must be a local absolute path',
      );
    }
    manifest.ownerClaimRoute = record.ownerClaimRoute;
  }
  return manifest;
}

/**
 * Serialize a manifest as canonical JSON (fixed key order: version,
 * executable, args, healthRoute, dataDirectory, env, ownerClaimRoute;
 * two-space indent; trailing newline). The input is validated first by
 * parsing its own JSON, so a bundler cannot write a document the parser would
 * reject (reserved or duplicate env names, bad routes, bad basenames).
 */
export function serializeSidecarManifest(manifest: SidecarManifestV1): string {
  const checked = parseSidecarManifest(JSON.stringify(manifest));
  return `${JSON.stringify(
    {
      version: checked.version,
      executable: checked.executable,
      args: checked.args,
      healthRoute: checked.healthRoute,
      dataDirectory: checked.dataDirectory,
      ...(checked.workingDirectory === undefined
        ? {}
        : { workingDirectory: checked.workingDirectory }),
      ...(checked.env === undefined ? {} : { env: checked.env }),
      ...(checked.ownerClaimRoute === undefined
        ? {}
        : { ownerClaimRoute: checked.ownerClaimRoute }),
    },
    null,
    2,
  )}\n`;
}

const posixAbsolute = /^\/[^\0]*$/;
const windowsAbsolute = /^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/]+[^\\/])/;

function isAbsoluteDirectory(value: unknown): value is string {
  return (
    isValidText(value) &&
    value.length > 0 &&
    (posixAbsolute.test(value) || windowsAbsolute.test(value))
  );
}

/**
 * Build the sidecar environment. Starts from `base`, drops its reserved
 * names (case-insensitively), layers the manifest `env`, then applies the
 * supervisor-supplied reserved values last so they always win. Parsed
 * manifests never contain reserved names; a hand-built one has them ignored.
 * Entries whose value is `undefined` in `base` are omitted.
 */
export function buildSidecarEnv(
  manifest: Pick<SidecarManifestV1, 'env'>,
  supplied: {
    readonly port: number;
    readonly dataDirectory: string;
    /**
     * The per-launch owner-link secret. The Rust wrapper generates and sets it;
     * pass one only for a test harness. Without it the variable is absent and
     * the app's owner link answers 403.
     */
    readonly ownerLinkSecret?: string;
  },
  base: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const { port, dataDirectory } = supplied;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Sidecar port must be an integer from 1 to 65535');
  }
  if (!isAbsoluteDirectory(dataDirectory)) {
    throw new Error('Sidecar data directory must be a non-empty absolute path');
  }

  const env = new Map<string, string>();
  for (const [name, value] of Object.entries(base)) {
    if (value !== undefined && !reservedEnvKeys.has(asciiLower(name))) {
      env.set(name, value);
    }
  }
  if (manifest.env !== undefined) {
    for (const [name, value] of Object.entries(manifest.env)) {
      if (!reservedEnvKeys.has(asciiLower(name))) env.set(name, value);
    }
  }
  env.set('HOST', '127.0.0.1');
  env.set('PORT', String(port));
  env.set('ORIGIN', `http://127.0.0.1:${port}`);
  env.set('SMRT_DATA_DIR', dataDirectory);
  if (supplied.ownerLinkSecret !== undefined) {
    env.set('SMRT_DESKTOP_OWNER_LINK_SECRET', supplied.ownerLinkSecret);
  }
  return Object.fromEntries(env);
}
