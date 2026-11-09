import { NodeDistError } from './node-errors.js';

/**
 * Streaming tar reader that extracts EXACTLY the named members.
 *
 * Feed it the output of a gunzip stream (any async iterable of bytes). It
 * understands ustar headers, pax extended headers (`x`, for `path` and `size`
 * overrides) and GNU long names (`L`). Everything else is skipped without ever
 * being interpreted.
 *
 * Safety properties:
 * - Nothing is written to a filesystem. Members are returned as buffers; the
 *   caller chooses the output path, so tar-slip is structurally impossible.
 * - A member is selected by EXACT string equality with the requested name.
 *   `../x`, absolute names and `./`-prefixed names never match and are skipped.
 * - A wanted name whose entry is a symlink, hardlink, directory, device or
 *   anything but a regular file is refused (`member_unsafe`), never followed.
 * - A wanted name that appears twice is refused (`member_ambiguous`): a later
 *   entry must not silently replace the one that was seen first.
 * - Every header checksum is verified; truncation at any point is an error.
 * - The total number of bytes pulled from the source is capped
 *   (`maxArchiveBytes`), which bounds gzip bombs and entries whose size
 *   field claims more than the archive holds; each wanted member has its own
 *   cap and its size is checked before any of its data is read.
 * - pax/GNU metadata blocks are capped at 64 KiB. Global pax headers (`g`) are
 *   skipped, and refused when they try to set `path`, `linkpath` or `size`.
 *
 * Reading stops as soon as every wanted member has been read, so trailing
 * entries (and their bytes) are never examined.
 */

const BLOCK = 512;
const MAX_METADATA_BYTES = 64 * 1024;

export interface TarMemberRequest {
  /** Exact member name, e.g. `node-v26.8.1-darwin-arm64/bin/node`. */
  readonly name: string;
  /** Maximum size of the member's data. */
  readonly maxBytes: number;
}

export interface TarLimits {
  /** Cap on bytes pulled from the (decompressed) source. */
  readonly maxArchiveBytes: number;
}

export const DEFAULT_TAR_LIMITS: TarLimits = {
  maxArchiveBytes: 512 * 1024 * 1024,
};

type ByteSource = AsyncIterable<Uint8Array>;

/** Buffered pull reader over an async byte source with a total-bytes cap. */
class ByteReader {
  private readonly iterator: AsyncIterator<Uint8Array>;
  private chunks: Buffer[] = [];
  private buffered = 0;
  private pulled = 0;
  private done = false;

  constructor(
    source: ByteSource,
    private readonly maxTotal: number,
  ) {
    this.iterator = source[Symbol.asyncIterator]();
  }

  private async fill(): Promise<boolean> {
    if (this.done) return false;
    let result: IteratorResult<Uint8Array>;
    try {
      result = await this.iterator.next();
    } catch (error) {
      throw mapSourceError(error);
    }
    if (result.done) {
      this.done = true;
      return false;
    }
    const value = result.value;
    if (!(value instanceof Uint8Array))
      throw new NodeDistError('archive_invalid');
    this.pulled += value.length;
    if (this.pulled > this.maxTotal)
      throw new NodeDistError('archive_too_large');
    if (value.length > 0) {
      this.chunks.push(
        Buffer.from(value.buffer, value.byteOffset, value.byteLength),
      );
      this.buffered += value.length;
    }
    return true;
  }

  /** Take up to `n` buffered bytes (fewer only at end of input). */
  private async take(n: number): Promise<Buffer[]> {
    const out: Buffer[] = [];
    let need = n;
    while (need > 0) {
      if (this.buffered === 0 && !(await this.fill())) break;
      const head = this.chunks[0] as Buffer;
      if (head.length <= need) {
        out.push(head);
        this.chunks.shift();
        this.buffered -= head.length;
        need -= head.length;
      } else {
        out.push(head.subarray(0, need));
        this.chunks[0] = head.subarray(need);
        this.buffered -= need;
        need = 0;
      }
    }
    return out;
  }

  /**
   * Exactly `n` bytes. `null` only when the input ended before the first byte
   * and `allowEof` is set; any other shortfall is a truncation error.
   */
  async read(n: number, allowEof = false): Promise<Buffer | null> {
    const parts = await this.take(n);
    const got = parts.reduce((sum, part) => sum + part.length, 0);
    if (got === n)
      return parts.length === 1
        ? (parts[0] as Buffer)
        : Buffer.concat(parts, n);
    if (got === 0 && allowEof) return null;
    throw new NodeDistError('archive_truncated');
  }

  /** Discard exactly `n` bytes (counted against the total cap). */
  async skip(n: number): Promise<void> {
    let left = n;
    while (left > 0) {
      if (this.buffered === 0 && !(await this.fill())) {
        throw new NodeDistError('archive_truncated');
      }
      const head = this.chunks[0] as Buffer;
      if (head.length <= left) {
        this.chunks.shift();
        this.buffered -= head.length;
        left -= head.length;
      } else {
        this.chunks[0] = head.subarray(left);
        this.buffered -= left;
        left = 0;
      }
    }
  }

  /** Read exactly `n` bytes without allocating `n` bytes up front. */
  async readLarge(n: number): Promise<Buffer> {
    const parts = await this.take(n);
    const got = parts.reduce((sum, part) => sum + part.length, 0);
    if (got !== n) throw new NodeDistError('archive_truncated');
    return Buffer.concat(parts, n);
  }

  async close(): Promise<void> {
    try {
      await this.iterator.return?.();
    } catch {
      // Closing is best effort; the result or error is already decided.
    }
  }
}

function mapSourceError(error: unknown): NodeDistError {
  if (error instanceof NodeDistError) return error;
  const code = (error as { code?: unknown } | null)?.code;
  return new NodeDistError(
    code === 'Z_BUF_ERROR' ? 'archive_truncated' : 'archive_invalid',
  );
}

function isZeroBlock(block: Buffer): boolean {
  for (let i = 0; i < BLOCK; i += 1) if (block[i] !== 0) return false;
  return true;
}

/** Octal numeric field: spaces, digits 0-7, NUL/space terminator. */
function parseOctal(field: Buffer): number {
  let text = '';
  let ended = false;
  for (let i = 0; i < field.length; i += 1) {
    const c = field[i] as number;
    if (c === 0 || c === 0x20) {
      if (text.length > 0) ended = true;
      continue;
    }
    if (ended || c < 0x30 || c > 0x37)
      throw new NodeDistError('archive_invalid');
    text += String.fromCharCode(c);
  }
  if (text.length === 0) return 0;
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new NodeDistError('archive_invalid');
  }
  return value;
}

/** GNU base-256 (high bit set) or octal size. */
function parseSize(field: Buffer): number {
  if (((field[0] as number) & 0x80) === 0) return parseOctal(field);
  if (((field[0] as number) & 0x40) !== 0)
    throw new NodeDistError('archive_invalid');
  let value = BigInt((field[0] as number) & 0x3f);
  for (let i = 1; i < field.length; i += 1) {
    value = (value << 8n) | BigInt(field[i] as number);
  }
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new NodeDistError('archive_invalid');
  }
  return Number(value);
}

function cString(field: Buffer): Buffer {
  const nul = field.indexOf(0);
  return nul === -1 ? field : field.subarray(0, nul);
}

function verifyChecksum(header: Buffer): void {
  const stored = parseOctal(header.subarray(148, 156));
  let sum = 0;
  for (let i = 0; i < BLOCK; i += 1) {
    sum += i >= 148 && i < 156 ? 0x20 : (header[i] as number);
  }
  if (sum !== stored) throw new NodeDistError('archive_invalid');
}

function decodeName(bytes: Buffer): string {
  if (bytes.includes(0)) throw new NodeDistError('archive_invalid');
  return bytes.toString('utf8');
}

/** Parse pax records `"<len> <key>=<value>\n"`. Later keys win. */
function parsePax(data: Buffer): Map<string, string> {
  const records = new Map<string, string>();
  let offset = 0;
  while (offset < data.length) {
    let space = -1;
    for (let i = offset; i < data.length && i < offset + 10; i += 1) {
      if (data[i] === 0x20) {
        space = i;
        break;
      }
      if ((data[i] as number) < 0x30 || (data[i] as number) > 0x39) {
        throw new NodeDistError('archive_invalid');
      }
    }
    if (space === -1 || space === offset)
      throw new NodeDistError('archive_invalid');
    const length = Number.parseInt(data.toString('latin1', offset, space), 10);
    const end = offset + length;
    if (
      !Number.isSafeInteger(length) ||
      length <= space - offset + 1 ||
      end > data.length ||
      data[end - 1] !== 0x0a
    ) {
      throw new NodeDistError('archive_invalid');
    }
    const body = data.subarray(space + 1, end - 1);
    const eq = body.indexOf(0x3d);
    if (eq <= 0) throw new NodeDistError('archive_invalid');
    records.set(body.toString('utf8', 0, eq), body.toString('utf8', eq + 1));
    offset = end;
  }
  return records;
}

function paddedSize(size: number): number {
  return Math.ceil(size / BLOCK) * BLOCK;
}

const TYPE_REGULAR = new Set(['0', '\0']);
/** Hardlink, symlink, char/block device, directory, FIFO: no data blocks. */
const NO_DATA_TYPES = new Set(['1', '2', '3', '4', '5', '6']);

/**
 * Extract the requested members. Rejects with a fixed-message `NodeDistError`;
 * the returned map holds exactly the requested names.
 */
export async function extractTarMembers(
  source: ByteSource,
  wanted: readonly TarMemberRequest[],
  limits: TarLimits = DEFAULT_TAR_LIMITS,
): Promise<Map<string, Buffer>> {
  const requests = new Map<string, number>();
  for (const request of wanted) {
    if (
      request.name.length === 0 ||
      requests.has(request.name) ||
      !Number.isSafeInteger(request.maxBytes) ||
      request.maxBytes < 0
    ) {
      throw new NodeDistError('archive_invalid');
    }
    requests.set(request.name, request.maxBytes);
  }
  const found = new Map<string, Buffer>();
  const reader = new ByteReader(source, limits.maxArchiveBytes);
  try {
    let longName: string | undefined;
    let paxName: string | undefined;
    let paxSize: number | undefined;
    while (found.size < requests.size) {
      const header = await reader.read(BLOCK, true);
      if (header === null || isZeroBlock(header)) {
        throw new NodeDistError('member_missing');
      }
      verifyChecksum(header);
      const magic = header.toString('latin1', 257, 262);
      if (magic !== 'ustar') throw new NodeDistError('archive_invalid');
      const type = String.fromCharCode(header[156] as number);
      let size = parseSize(header.subarray(124, 136));

      if (type === 'x' || type === 'g' || type === 'L' || type === 'K') {
        if (size > MAX_METADATA_BYTES)
          throw new NodeDistError('archive_invalid');
        const data = (await reader.read(paddedSize(size))) as Buffer;
        const body = data.subarray(0, size);
        if (type === 'x') {
          const records = parsePax(body);
          const path = records.get('path');
          if (path !== undefined)
            paxName = decodeName(Buffer.from(path, 'utf8'));
          const paxSizeText = records.get('size');
          if (paxSizeText !== undefined) {
            if (!/^[0-9]{1,15}$/.test(paxSizeText)) {
              throw new NodeDistError('archive_invalid');
            }
            paxSize = Number.parseInt(paxSizeText, 10);
          }
        } else if (type === 'g') {
          const records = parsePax(body);
          if (
            records.has('path') ||
            records.has('linkpath') ||
            records.has('size')
          ) {
            throw new NodeDistError('archive_invalid');
          }
        } else if (type === 'L') {
          longName = decodeName(cString(body));
        }
        // 'K' (GNU long link name) is irrelevant: links are never followed.
        continue;
      }

      let name: string;
      if (paxName !== undefined) name = paxName;
      else if (longName !== undefined) name = longName;
      else {
        const base = cString(header.subarray(0, 100));
        const posix = magic === 'ustar' && header[262] === 0;
        const prefix = posix
          ? cString(header.subarray(345, 500))
          : Buffer.alloc(0);
        name = decodeName(
          prefix.length > 0
            ? Buffer.concat([prefix, Buffer.from('/'), base])
            : base,
        );
      }
      if (paxSize !== undefined) size = paxSize;
      longName = undefined;
      paxName = undefined;
      paxSize = undefined;

      const limit = requests.get(name);
      if (limit === undefined) {
        // Not requested: never interpreted, only skipped.
        await reader.skip(NO_DATA_TYPES.has(type) ? 0 : paddedSize(size));
        continue;
      }
      if (found.has(name)) throw new NodeDistError('member_ambiguous');
      if (!TYPE_REGULAR.has(type)) throw new NodeDistError('member_unsafe');
      if (size > limit) throw new NodeDistError('member_too_large');
      const data = await reader.readLarge(size);
      await reader.skip(paddedSize(size) - size);
      found.set(name, data);
    }
    return found;
  } finally {
    await reader.close();
  }
}

/** Extract one member. Same guarantees as `extractTarMembers`. */
export async function extractTarMember(
  source: ByteSource,
  request: TarMemberRequest,
  limits: TarLimits = DEFAULT_TAR_LIMITS,
): Promise<Buffer> {
  const members = await extractTarMembers(source, [request], limits);
  return members.get(request.name) as Buffer;
}
