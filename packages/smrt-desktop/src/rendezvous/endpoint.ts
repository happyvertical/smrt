import { createHash, randomBytes } from 'node:crypto';
import { DesktopContractError } from '../errors.js';
import { flavorOf, parseAbsolutePath } from '../internal/abs-path.js';
import { hasClosedKeys, isRecord } from '../internal/strict-json.js';

/**
 * Where the owner-only control channel listens. A Unix domain socket on
 * macOS and Linux, a named pipe on Windows. The name contains 128 random bits
 * chosen per shell start and is published only inside the 0700 private state
 * directory, so there is no well-known name. A name proves nothing about who
 * listens behind it: the client still vets the endpoint.
 *
 * @experimental
 */
export type ControlEndpoint =
  | { readonly kind: 'unix'; readonly path: string }
  | { readonly kind: 'pipe'; readonly name: string };

/**
 * `sockaddr_un.sun_path` holds 104 bytes on macOS and 108 on Linux, including
 * the terminating NUL. Anything longer cannot be bound or connected.
 *
 * @experimental
 */
export const MAX_UNIX_SOCKET_PATH_BYTES = 103;

const pipeName = /^\\\\\.\\pipe\\smrt-[0-9a-f]{16}-[0-9a-f]{32}$/;
const socketLeaf = /^c-[0-9a-f]{32}\.sock$/;

/**
 * True for a named pipe path of the exact form the shell derives.
 *
 * @experimental
 */
export function isControlPipeName(value: unknown): value is string {
  return typeof value === 'string' && pipeName.test(value);
}

/**
 * True for an absolute POSIX socket path short enough for `sun_path` whose
 * last segment is `c-<32 lowercase hex>.sock`.
 *
 * @experimental
 */
export function isControlSocketPath(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (Buffer.byteLength(value, 'utf8') > MAX_UNIX_SOCKET_PATH_BYTES) {
    return false;
  }
  const parsed = parseAbsolutePath(value, 'posix');
  if (parsed === null || parsed.segments.length < 2) return false;
  return socketLeaf.test(parsed.segments[parsed.segments.length - 1] ?? '');
}

/**
 * Validate an endpoint object (closed schema). Throws `invalid_endpoint`.
 *
 * @experimental
 */
export function parseControlEndpoint(input: unknown): ControlEndpoint {
  const invalid = () =>
    new DesktopContractError('invalid_endpoint', { field: 'control' });
  if (!isRecord(input)) throw invalid();
  if (input.kind === 'unix') {
    if (!hasClosedKeys(input, ['kind', 'path'])) throw invalid();
    if (!isControlSocketPath(input.path)) throw invalid();
    return Object.freeze({ kind: 'unix', path: input.path });
  }
  if (input.kind === 'pipe') {
    if (!hasClosedKeys(input, ['kind', 'name'])) throw invalid();
    if (!isControlPipeName(input.name)) throw invalid();
    return Object.freeze({ kind: 'pipe', name: input.name });
  }
  throw invalid();
}

/** @experimental */
export interface DeriveControlEndpointOptions {
  /** Defaults to `process.platform`. */
  readonly platform?: NodeJS.Platform;
  /** Tauri identifier; its SHA-256 prefix scopes a Windows pipe name. */
  readonly bundleId: string;
  /**
   * POSIX only: an absolute directory owned by the user with mode 0700 in
   * which the socket is created. Keep it short: `sun_path` is 104 bytes, so
   * the private state directory under `~/Library/Application Support` is
   * usually too long on macOS (use the per-user temp directory there and
   * `$XDG_RUNTIME_DIR` on Linux).
   */
  readonly directory?: string;
  /** Test seam. Defaults to 16 random bytes (128 bits). */
  readonly randomBytes?: (size: number) => Uint8Array;
}

/**
 * Derive a fresh, unguessable endpoint: 128 random bits per call.
 * POSIX: `<directory>/c-<32 hex>.sock`. Windows:
 * `\\.\pipe\smrt-<16 hex of sha256(bundleId)>-<32 hex>`.
 * Throws `invalid_endpoint` when the result would not satisfy the grammar
 * (relative or over-long directory).
 *
 * @experimental
 */
export function deriveControlEndpoint(
  options: DeriveControlEndpointOptions,
): ControlEndpoint {
  const platform = options.platform ?? process.platform;
  const random = Buffer.from(
    (options.randomBytes ?? ((size) => randomBytes(size)))(16),
  ).toString('hex');
  if (random.length !== 32) {
    throw new DesktopContractError('invalid_endpoint');
  }
  if (platform === 'win32') {
    const scope = createHash('sha256')
      .update(options.bundleId, 'utf8')
      .digest('hex')
      .slice(0, 16);
    return parseControlEndpoint({
      kind: 'pipe',
      name: `\\\\.\\pipe\\smrt-${scope}-${random}`,
    });
  }
  // A single trailing separator is tolerated (`$TMPDIR` usually has one).
  const directory =
    options.directory !== undefined &&
    options.directory.length > 1 &&
    options.directory.endsWith('/')
      ? options.directory.slice(0, -1)
      : options.directory;
  if (
    directory === undefined ||
    parseAbsolutePath(directory, flavorOf(platform)) === null
  ) {
    throw new DesktopContractError('invalid_endpoint');
  }
  const base = directory === '/' ? '/' : `${directory}/`;
  return parseControlEndpoint({
    kind: 'unix',
    path: `${base}c-${random}.sock`,
  });
}

/**
 * The directory containing a unix socket path.
 *
 * @experimental
 */
export function controlSocketDirectory(path: string): string {
  const cut = path.lastIndexOf('/');
  return cut <= 0 ? '/' : path.slice(0, cut);
}
