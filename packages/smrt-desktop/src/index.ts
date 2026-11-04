/** The version 1 wire contract for a bundled SMRT desktop sidecar. */
export interface SidecarManifestV1 {
  readonly version: 1;
  readonly executable: string;
  readonly args: readonly string[];
  readonly healthRoute: string;
  readonly dataDirectory: string;
}

const manifestKeys = [
  'version',
  'executable',
  'args',
  'healthRoute',
  'dataDirectory',
] as const satisfies readonly (keyof SidecarManifestV1)[];

const portableSegment = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;
const windowsDevice = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i;
const routeSegment = /^[A-Za-z0-9._~-]+$/;
const unpairedSurrogate = /\p{Surrogate}/u;

function isPortablePath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value
      .split('/')
      .every(
        (segment) =>
          portableSegment.test(segment) &&
          !segment.endsWith('.') &&
          !windowsDevice.test(segment),
      )
  );
}

function isHealthRoute(value: unknown): value is string {
  if (typeof value !== 'string' || !value.startsWith('/')) return false;
  if (value === '/') return true;

  return value
    .slice(1, value.endsWith('/') ? -1 : undefined)
    .split('/')
    .every(
      (segment) =>
        routeSegment.test(segment) && segment !== '.' && segment !== '..',
    );
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

  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Sidecar manifest must be a JSON object');
  }

  const record = input as Record<string, unknown>;
  if (!Object.hasOwn(record, 'version') || record.version !== 1) {
    throw new Error('Sidecar manifest requires supported version 1');
  }
  if (
    Object.keys(record).length !== manifestKeys.length ||
    !manifestKeys.every((key) => Object.hasOwn(record, key))
  ) {
    throw new Error(
      'Sidecar manifest v1 requires exactly the documented fields',
    );
  }

  const { executable, args, healthRoute, dataDirectory } = record;
  if (!isPortablePath(executable)) {
    throw new Error(
      'Sidecar manifest executable must be a portable relative path',
    );
  }
  if (
    !Array.isArray(args) ||
    !args.every(
      (arg): arg is string =>
        typeof arg === 'string' &&
        !arg.includes('\0') &&
        !unpairedSurrogate.test(arg),
    )
  ) {
    throw new Error('Sidecar manifest args must be an array of valid strings');
  }
  if (!isHealthRoute(healthRoute)) {
    throw new Error(
      'Sidecar manifest healthRoute must be a local absolute path',
    );
  }
  if (!isPortablePath(dataDirectory)) {
    throw new Error(
      'Sidecar manifest dataDirectory must be a portable relative path',
    );
  }

  return { version: 1, executable, args, healthRoute, dataDirectory };
}
