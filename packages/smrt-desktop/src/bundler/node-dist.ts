import { createHash, randomBytes } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { pipeline, Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import {
  type DesktopFs,
  type FileHandleLike,
  nodeFs,
  O_NOFOLLOW,
  O_NONBLOCK,
  O_RDONLY,
  O_WRONLY_CREATE_EXCL,
} from '../internal/fs-seam.js';
import { NodeDistError } from './node-errors.js';
import { lookupPin, NODE_PINS, type NodePinTable } from './node-pins.js';
import { extractTarMembers } from './tar-member.js';

/**
 * Acquire the official Node.js binary for one target, with provenance.
 *
 * Order of operations (each step fails closed):
 *  1. The version must be a plain `major.minor.patch` and must be pinned in
 *     `node-pins.ts`; an unpinned version or file is refused BEFORE any
 *     network or filesystem access.
 *  2. Cache lookup. A cached file is untrusted: it is read once into memory
 *     and hashed against the pin on EVERY use. A mismatch deletes that cache
 *     entry and fails (`cache_tampered`); it never silently refetches.
 *  3. On a miss, one HTTPS GET to a constant location
 *     (`https://nodejs.org/dist/v<ver>/<file>`), redirects refused, size
 *     capped, streamed through SHA-256 into an `O_EXCL` partial file. The hash
 *     of the WHOLE download must equal the pin before the partial is renamed
 *     into the cache. The cache entry is then re-read and re-verified by the
 *     same path as step 2.
 *  4. Only the verified in-memory bytes are used afterwards: for macOS and
 *     Linux the single `bin/node` (and `LICENSE`) member is extracted with
 *     `tar-member.ts`; for Windows the verified `node.exe` is the binary.
 *  5. Output files are written to a private `O_EXCL` temp next to their
 *     destination and renamed into place. Output names come from the caller,
 *     never from the archive.
 *
 * No GPG at bundle time: pins are produced by the maintainer script
 * (`scripts/update-node-pins.mjs`) which verifies the release signature.
 */

export const NODE_DIST_BASE_URL = 'https://nodejs.org/dist';

/** Structural subset of the target table this module needs. */
export interface NodeDistTarget {
  /** `process.platform` style: `darwin`, `linux` or `win32` (`win` accepted). */
  readonly nodePlatform: string;
  /** `arm64` or `x64`. */
  readonly nodeArch: string;
}

export interface FetchResponseLike {
  readonly status: number;
  readonly redirected?: boolean;
  readonly url?: string;
  readonly headers: { get(name: string): string | null };
  readonly body: AsyncIterable<Uint8Array> | null;
}

export interface FetchInit {
  readonly redirect: 'error';
  readonly signal?: AbortSignal;
}

export type FetchLike = (
  url: string,
  init: FetchInit,
) => Promise<FetchResponseLike>;

/** `DesktopFs` plus the one directory operation the cache needs. */
export interface NodeDistFs extends DesktopFs {
  mkdir(
    path: string,
    options: { recursive: true; mode: number },
  ): Promise<void>;
}

export const nodeDistFs: NodeDistFs = {
  ...nodeFs,
  async mkdir(path, options) {
    await fsp.mkdir(path, options);
  },
};

export interface NodeDistLimits {
  /** Largest accepted download / cached / supplied archive. Default 128 MiB. */
  readonly maxDownloadBytes: number;
  /** Cap on gunzip output. Default 512 MiB. */
  readonly maxExpandedBytes: number;
  /** Largest accepted Node executable. Default 256 MiB. */
  readonly maxBinaryBytes: number;
  /** Largest accepted LICENSE member. Default 1 MiB. */
  readonly maxLicenseBytes: number;
  /** Abort a download after this long. Default 5 minutes. */
  readonly fetchTimeoutMs: number;
}

export const DEFAULT_NODE_DIST_LIMITS: NodeDistLimits = {
  maxDownloadBytes: 128 * 1024 * 1024,
  maxExpandedBytes: 512 * 1024 * 1024,
  maxBinaryBytes: 256 * 1024 * 1024,
  maxLicenseBytes: 1024 * 1024,
  fetchTimeoutMs: 5 * 60 * 1000,
};

export interface AcquireNodeBinaryOptions {
  /** Exact Node version, `26.8.1`. Must be pinned. */
  readonly version: string;
  readonly target: NodeDistTarget;
  /** Absolute cache directory (created 0700). Untrusted on every read. */
  readonly cacheDir: string;
  /** Absolute path the verified executable is created at (must not exist). */
  readonly destination: string;
  /** Absolute path for Node's LICENSE (macOS/Linux archives only). */
  readonly licenseDestination?: string;
  /** Offline input (`--node-archive`): same pin check, no network. */
  readonly archivePath?: string;
  /** Never fetch; fail with `offline_cache_miss` when the cache lacks it. */
  readonly offline?: boolean;
  /**
   * Receives the verified executable bytes; throw or reject to refuse them
   * (nothing is written). May be asynchronous.
   */
  readonly verifyBinary?: (binary: Buffer) => void | Promise<void>;
  readonly fetch?: FetchLike;
  readonly fs?: NodeDistFs;
  /** Test seam; defaults to the committed table. */
  readonly pins?: NodePinTable;
  /** Test seam for the dist base URL; must be https. Not a CLI option. */
  readonly distBaseUrl?: string;
  /** Defaults to `process.env` (read only for the TLS guard). */
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly random?: () => string;
  readonly limits?: Partial<NodeDistLimits>;
}

export interface AcquiredNodeBinary {
  readonly path: string;
  /** SHA-256 of the Node executable that was written. */
  readonly sha256: string;
  readonly version: string;
  /** Dist file name as pinned, e.g. `win-x64/node.exe`. */
  readonly distFile: string;
  /** SHA-256 of the whole verified download (equals the pin). */
  readonly archiveSha256: string;
  /** Present when a license destination was given and the dist carries one. */
  readonly licensePath?: string;
}

const VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const PLATFORMS: Readonly<Record<string, 'darwin' | 'linux' | 'win'>> = {
  darwin: 'darwin',
  linux: 'linux',
  win32: 'win',
  win: 'win',
};
const ARCHES = new Set(['arm64', 'x64']);

export interface NodeDistLayout {
  /** File name in `SHASUMS256.txt`. */
  readonly distFile: string;
  /** Cache entry name: `distFile` with `/` flattened. */
  readonly cacheName: string;
  /** `tar` for macOS/Linux, `exe` for the standalone Windows `node.exe`. */
  readonly kind: 'tar' | 'exe';
  readonly binaryMember?: string;
  readonly licenseMember?: string;
}

/** Derive the dist file layout for a validated version and target. */
export function nodeDistLayout(
  version: string,
  target: NodeDistTarget,
): NodeDistLayout {
  if (!VERSION.test(version)) throw new NodeDistError('invalid_node_version');
  const platform = Object.hasOwn(PLATFORMS, target.nodePlatform)
    ? PLATFORMS[target.nodePlatform]
    : undefined;
  if (platform === undefined || !ARCHES.has(target.nodeArch)) {
    throw new NodeDistError('unsupported_target');
  }
  if (platform === 'win') {
    return {
      distFile: `win-${target.nodeArch}/node.exe`,
      cacheName: `win-${target.nodeArch}-node.exe`,
      kind: 'exe',
    };
  }
  const stem = `node-v${version}-${platform}-${target.nodeArch}`;
  return {
    distFile: `${stem}.tar.gz`,
    cacheName: `${stem}.tar.gz`,
    kind: 'tar',
    binaryMember: `${stem}/bin/node`,
    licenseMember: `${stem}/LICENSE`,
  };
}

function sha256Hex(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

function errnoCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

async function closeQuietly(handle: FileHandleLike | undefined): Promise<void> {
  try {
    await handle?.close();
  } catch {
    // Already failing or already closed.
  }
}

async function unlinkQuietly(fs: DesktopFs, path: string): Promise<void> {
  try {
    await fs.unlink(path);
  } catch {
    // Best effort cleanup of a file this run created or a tampered entry.
  }
}

type ReadOutcome =
  | { kind: 'absent' }
  | { kind: 'untrusted' }
  | { kind: 'ok'; bytes: Buffer };

/**
 * Read a whole file through one descriptor: `O_NOFOLLOW`, `fstat` must say
 * regular file within the cap, and the byte count must match the `fstat` size
 * with nothing left over. The returned bytes are what gets hashed AND used.
 */
async function readWholeFile(
  fs: DesktopFs,
  path: string,
  maxBytes: number,
): Promise<ReadOutcome> {
  let handle: FileHandleLike | undefined;
  try {
    handle = await fs.open(path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
    const stat = await handle.stat();
    const size = Number(stat.size);
    if (!stat.isFile() || !Number.isSafeInteger(size) || size > maxBytes) {
      return { kind: 'untrusted' };
    }
    const bytes = Buffer.allocUnsafe(size);
    let offset = 0;
    while (offset < size) {
      const { bytesRead } = await handle.read(
        bytes,
        offset,
        size - offset,
        null,
      );
      if (bytesRead === 0) return { kind: 'untrusted' };
      offset += bytesRead;
    }
    const probe = Buffer.allocUnsafe(1);
    const extra = await handle.read(probe, 0, 1, null);
    if (extra.bytesRead !== 0) return { kind: 'untrusted' };
    return { kind: 'ok', bytes };
  } catch (error) {
    const code = errnoCode(error);
    if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'absent' };
    if (code === 'ELOOP' || code === 'EMLINK') return { kind: 'untrusted' };
    throw new NodeDistError('io_failed');
  } finally {
    await closeQuietly(handle);
  }
}

/** Create `path` exclusively (`O_EXCL|O_NOFOLLOW`) and write all of `data`. */
async function writeExclusive(
  fs: DesktopFs,
  path: string,
  data: Uint8Array,
  mode: number,
): Promise<'created' | 'exists'> {
  let handle: FileHandleLike;
  try {
    handle = await fs.open(path, O_WRONLY_CREATE_EXCL, mode);
  } catch (error) {
    if (errnoCode(error) === 'EEXIST') return 'exists';
    throw new NodeDistError('io_failed');
  }
  try {
    let offset = 0;
    while (offset < data.length) {
      const { bytesWritten } = await handle.write(
        data,
        offset,
        data.length - offset,
      );
      if (bytesWritten <= 0) throw new NodeDistError('io_failed');
      offset += bytesWritten;
    }
    await handle.sync();
  } catch (error) {
    await closeQuietly(handle);
    await unlinkQuietly(fs, path);
    throw error instanceof NodeDistError
      ? error
      : new NodeDistError('io_failed');
  }
  try {
    await handle.close();
  } catch {
    await unlinkQuietly(fs, path);
    throw new NodeDistError('io_failed');
  }
  return 'created';
}

const MAX_TEMP_ATTEMPTS = 4;

/** Create a fresh `O_EXCL` temp sibling, retrying a colliding random suffix. */
async function createTemp(
  fs: DesktopFs,
  finalPath: string,
  data: Uint8Array,
  mode: number,
  random: () => string,
): Promise<string> {
  for (let attempt = 0; attempt < MAX_TEMP_ATTEMPTS; attempt += 1) {
    const temp = `${finalPath}.partial-${random()}`;
    if ((await writeExclusive(fs, temp, data, mode)) === 'created') return temp;
  }
  throw new NodeDistError('io_failed');
}

async function pathExists(fs: DesktopFs, path: string): Promise<boolean> {
  try {
    await fs.lstat(path);
    return true;
  } catch (error) {
    const code = errnoCode(error);
    if (code === 'ENOENT' || code === 'ENOTDIR') return false;
    throw new NodeDistError('io_failed');
  }
}

function parseBaseUrl(base: string, version: string, distFile: string): string {
  let parsed: URL;
  try {
    parsed = new URL(base);
  } catch {
    throw new NodeDistError('insecure_url');
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    throw new NodeDistError('insecure_url');
  }
  const path = parsed.pathname.replace(/\/+$/, '');
  return `https://${parsed.host}${path}/v${version}/${distFile}`;
}

/** Wrap `globalThis.fetch` into the narrow seam; redirects are always errors. */
export const defaultFetch: FetchLike = async (url, init) => {
  const response = await globalThis.fetch(url, {
    redirect: init.redirect,
    ...(init.signal ? { signal: init.signal } : {}),
  });
  const stream = response.body;
  return {
    status: response.status,
    redirected: response.redirected,
    url: response.url,
    headers: response.headers,
    body: stream
      ? {
          async *[Symbol.asyncIterator]() {
            const reader = stream.getReader();
            try {
              for (;;) {
                const { done, value } = await reader.read();
                if (done) return;
                yield value;
              }
            } finally {
              await reader.cancel().catch(() => undefined);
            }
          },
        }
      : null,
  };
};

interface DownloadContext {
  readonly fs: NodeDistFs;
  readonly fetch: FetchLike;
  readonly limits: NodeDistLimits;
  readonly random: () => string;
}

/**
 * Download into `<cachePath>.partial-<rand>` (O_EXCL), hash the whole body,
 * and rename into the cache only when it equals the pin. Any failure removes
 * the partial file.
 */
async function downloadToCache(
  context: DownloadContext,
  url: string,
  cachePath: string,
  pin: string,
): Promise<void> {
  const { fs, limits } = context;
  const signal = AbortSignal.timeout(limits.fetchTimeoutMs);
  let response: FetchResponseLike;
  try {
    response = await context.fetch(url, { redirect: 'error', signal });
  } catch {
    throw new NodeDistError('fetch_failed');
  }
  if (
    (response.status >= 300 && response.status < 400) ||
    response.redirected === true ||
    (typeof response.url === 'string' &&
      response.url !== '' &&
      response.url !== url)
  ) {
    throw new NodeDistError('redirect_refused');
  }
  if (response.status !== 200) throw new NodeDistError('http_status');
  const declared = response.headers.get('content-length');
  if (declared !== null) {
    if (!/^[0-9]{1,15}$/.test(declared))
      throw new NodeDistError('fetch_failed');
    if (Number.parseInt(declared, 10) > limits.maxDownloadBytes) {
      throw new NodeDistError('download_too_large');
    }
  }
  if (response.body === null) throw new NodeDistError('fetch_failed');

  let partial: string | undefined;
  let handle: FileHandleLike | undefined;
  for (let attempt = 0; attempt < MAX_TEMP_ATTEMPTS && !handle; attempt += 1) {
    const candidate = `${cachePath}.partial-${context.random()}`;
    try {
      handle = await fs.open(candidate, O_WRONLY_CREATE_EXCL, 0o600);
      partial = candidate;
    } catch (error) {
      if (errnoCode(error) !== 'EEXIST') throw new NodeDistError('io_failed');
    }
  }
  if (!handle || partial === undefined) throw new NodeDistError('io_failed');

  try {
    const hash = createHash('sha256');
    let total = 0;
    try {
      for await (const chunk of response.body) {
        total += chunk.length;
        if (total > limits.maxDownloadBytes) {
          throw new NodeDistError('download_too_large');
        }
        hash.update(chunk);
        let offset = 0;
        while (offset < chunk.length) {
          const { bytesWritten } = await handle.write(
            chunk,
            offset,
            chunk.length - offset,
          );
          if (bytesWritten <= 0) throw new NodeDistError('io_failed');
          offset += bytesWritten;
        }
      }
      await handle.sync();
    } catch (error) {
      if (error instanceof NodeDistError) throw error;
      throw new NodeDistError('fetch_failed');
    }
    await handle.close();
    handle = undefined;
    // Hash of the WHOLE download, compared before it can enter the cache.
    if (hash.digest('hex') !== pin)
      throw new NodeDistError('checksum_mismatch');
    try {
      await fs.rename(partial, cachePath);
      partial = undefined;
    } catch {
      // A concurrent run may hold the cache name (Windows cannot replace an
      // open file). The entry is re-verified by the caller either way.
    }
  } finally {
    await closeQuietly(handle);
    if (partial !== undefined) await unlinkQuietly(fs, partial);
  }
}

async function* slices(bytes: Buffer): AsyncGenerator<Buffer> {
  // Small slices keep gunzip's output buffering bounded between awaits.
  const SLICE = 16 * 1024;
  for (let offset = 0; offset < bytes.length; offset += SLICE) {
    yield bytes.subarray(offset, offset + SLICE);
  }
}

async function extractFromArchive(
  archive: Buffer,
  layout: NodeDistLayout,
  wantLicense: boolean,
  limits: NodeDistLimits,
): Promise<{ binary: Buffer; license?: Buffer }> {
  const gunzip = createGunzip();
  pipeline(Readable.from(slices(archive)), gunzip, () => undefined);
  const wanted = [
    {
      name: layout.binaryMember as string,
      maxBytes: limits.maxBinaryBytes,
    },
    ...(wantLicense
      ? [
          {
            name: layout.licenseMember as string,
            maxBytes: limits.maxLicenseBytes,
          },
        ]
      : []),
  ];
  const members = await extractTarMembers(gunzip, wanted, {
    maxArchiveBytes: limits.maxExpandedBytes,
  });
  const binary = members.get(layout.binaryMember as string) as Buffer;
  const license = wantLicense
    ? members.get(layout.licenseMember as string)
    : undefined;
  return license ? { binary, license } : { binary };
}

/**
 * Acquire, verify and write the Node executable for `target`.
 * Throws `NodeDistError` (fixed messages). On any failure nothing is left at
 * `destination` / `licenseDestination` and no partial file remains.
 */
export async function acquireNodeBinary(
  options: AcquireNodeBinaryOptions,
): Promise<AcquiredNodeBinary> {
  const fs = options.fs ?? nodeDistFs;
  const limits: NodeDistLimits = {
    ...DEFAULT_NODE_DIST_LIMITS,
    ...options.limits,
  };
  const random = options.random ?? (() => randomBytes(8).toString('hex'));

  // 1. Version, target, pin. Nothing else is touched before this passes.
  const layout = nodeDistLayout(options.version, options.target);
  const pin = lookupPin(
    options.version,
    layout.distFile,
    options.pins ?? NODE_PINS,
  );
  if (!isAbsolute(options.cacheDir)) throw new NodeDistError('invalid_path');
  if (!isAbsolute(options.destination)) throw new NodeDistError('invalid_path');
  if (options.licenseDestination && !isAbsolute(options.licenseDestination)) {
    throw new NodeDistError('invalid_path');
  }

  // 2. Obtain verified archive bytes.
  let archive: Buffer;
  if (options.archivePath !== undefined) {
    const outcome = await readWholeFile(
      fs,
      options.archivePath,
      limits.maxDownloadBytes,
    );
    if (outcome.kind !== 'ok') throw new NodeDistError('untrusted_file');
    if (sha256Hex(outcome.bytes) !== pin) {
      throw new NodeDistError('checksum_mismatch');
    }
    archive = outcome.bytes;
  } else {
    const versionDir = join(options.cacheDir, options.version);
    const cachePath = join(versionDir, layout.cacheName);
    let cached = await readWholeFile(fs, cachePath, limits.maxDownloadBytes);
    if (cached.kind === 'absent') {
      if (options.offline) throw new NodeDistError('offline_cache_miss');
      const env = options.env ?? process.env;
      if (env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
        throw new NodeDistError('tls_verification_disabled');
      }
      const url = parseBaseUrl(
        options.distBaseUrl ?? NODE_DIST_BASE_URL,
        options.version,
        layout.distFile,
      );
      try {
        await fs.mkdir(options.cacheDir, { recursive: true, mode: 0o700 });
        await fs.mkdir(versionDir, { recursive: true, mode: 0o700 });
      } catch {
        throw new NodeDistError('io_failed');
      }
      await downloadToCache(
        { fs, fetch: options.fetch ?? defaultFetch, limits, random },
        url,
        cachePath,
        pin,
      );
      // Re-read through the same untrusted-cache path as any other use.
      cached = await readWholeFile(fs, cachePath, limits.maxDownloadBytes);
    }
    if (cached.kind === 'absent') throw new NodeDistError('io_failed');
    if (cached.kind === 'untrusted' || sha256Hex(cached.bytes) !== pin) {
      await unlinkQuietly(fs, cachePath);
      throw new NodeDistError('cache_tampered');
    }
    archive = cached.bytes;
  }

  // 3. Extract only from the verified bytes.
  let binary: Buffer;
  let license: Buffer | undefined;
  if (layout.kind === 'exe') {
    binary = archive;
  } else {
    const extracted = await extractFromArchive(
      archive,
      layout,
      options.licenseDestination !== undefined,
      limits,
    );
    binary = extracted.binary;
    license = extracted.license;
  }
  if (options.verifyBinary) {
    try {
      await options.verifyBinary(binary);
    } catch {
      throw new NodeDistError('binary_rejected');
    }
  }

  // 4. Write outputs: private O_EXCL temps, then rename into place.
  if (await pathExists(fs, options.destination)) {
    throw new NodeDistError('destination_exists');
  }
  if (
    license !== undefined &&
    options.licenseDestination !== undefined &&
    (await pathExists(fs, options.licenseDestination))
  ) {
    throw new NodeDistError('destination_exists');
  }
  const created: string[] = [];
  const temps: string[] = [];
  try {
    const binaryTemp = await createTemp(
      fs,
      options.destination,
      binary,
      0o755,
      random,
    );
    temps.push(binaryTemp);
    let licenseTemp: string | undefined;
    if (license !== undefined && options.licenseDestination !== undefined) {
      licenseTemp = await createTemp(
        fs,
        options.licenseDestination,
        license,
        0o644,
        random,
      );
      temps.push(licenseTemp);
    }
    try {
      await fs.rename(binaryTemp, options.destination);
      created.push(options.destination);
      temps.splice(temps.indexOf(binaryTemp), 1);
      if (licenseTemp !== undefined && options.licenseDestination) {
        await fs.rename(licenseTemp, options.licenseDestination);
        created.push(options.licenseDestination);
        temps.splice(temps.indexOf(licenseTemp), 1);
      }
    } catch {
      throw new NodeDistError('io_failed');
    }
  } catch (error) {
    for (const path of [...temps, ...created]) await unlinkQuietly(fs, path);
    throw error;
  }

  return {
    path: options.destination,
    sha256: sha256Hex(binary),
    version: options.version,
    distFile: layout.distFile,
    archiveSha256: pin,
    ...(license !== undefined && options.licenseDestination
      ? { licensePath: options.licenseDestination }
      : {}),
  };
}
