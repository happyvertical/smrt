import { gzipSync } from 'node:zlib';

/**
 * Tiny tar writer for tests (test-only, not part of the published API).
 * Produces ustar archives with the odd shapes the Node-member reader must
 * survive: pax and GNU long names, symlink/hardlink members, `../` names, bad
 * checksums, size fields that lie, truncation.
 */

export interface TarEntrySpec {
  name: string;
  /** Typeflag character. Default `0` (regular file). */
  type?: string;
  data?: Buffer | string;
  linkName?: string;
  /** Header size field, when it should differ from `data.length`. */
  headerSize?: number;
  /** Emit a pax `x` header with these records before the entry. */
  pax?: Record<string, string>;
  /** Emit a GNU `L` long-name entry carrying this name before the entry. */
  gnuLongName?: string;
  /** Put this into the ustar prefix field (name stays in the name field). */
  prefix?: string;
  badChecksum?: boolean;
  /** `posix` = "ustar\0" + "00" (default), `gnu` = "ustar  \0". */
  magic?: 'posix' | 'gnu' | 'none';
}

const BLOCK = 512;

function octal(value: number, width: number): string {
  return `${value.toString(8).padStart(width - 1, '0')}\0`;
}

function put(buf: Buffer, offset: number, text: string, max: number): void {
  Buffer.from(text, 'utf8').copy(buf, offset, 0, max);
}

export function tarHeader(spec: {
  name: string;
  type: string;
  size: number;
  linkName?: string;
  prefix?: string;
  badChecksum?: boolean;
  magic?: 'posix' | 'gnu' | 'none';
}): Buffer {
  const header = Buffer.alloc(BLOCK);
  put(header, 0, spec.name, 100);
  put(header, 100, octal(0o644, 8), 8);
  put(header, 108, octal(0, 8), 8);
  put(header, 116, octal(0, 8), 8);
  put(header, 124, octal(spec.size, 12), 12);
  put(header, 136, octal(0, 12), 12);
  header.fill(0x20, 148, 156);
  header.write(spec.type, 156, 1, 'latin1');
  if (spec.linkName) put(header, 157, spec.linkName, 100);
  const magic = spec.magic ?? 'posix';
  if (magic === 'posix') {
    header.write('ustar\0', 257, 'latin1');
    header.write('00', 263, 'latin1');
  } else if (magic === 'gnu') {
    header.write('ustar  \0', 257, 'latin1');
  }
  if (spec.prefix) put(header, 345, spec.prefix, 155);
  let sum = 0;
  for (const byte of header) sum += byte;
  const stored = spec.badChecksum ? sum + 1 : sum;
  header.write(`${stored.toString(8).padStart(6, '0')}\0 `, 148, 'latin1');
  return header;
}

function padded(data: Buffer): Buffer {
  const rest = data.length % BLOCK;
  return rest === 0 ? data : Buffer.concat([data, Buffer.alloc(BLOCK - rest)]);
}

export function paxData(records: Record<string, string>): Buffer {
  const parts: Buffer[] = [];
  for (const [key, value] of Object.entries(records)) {
    const body = `${key}=${value}\n`;
    let length = Buffer.byteLength(body) + 2;
    while (String(length).length + 1 + Buffer.byteLength(body) !== length) {
      length = String(length).length + 1 + Buffer.byteLength(body);
    }
    parts.push(Buffer.from(`${length} ${body}`, 'utf8'));
  }
  return Buffer.concat(parts);
}

export function tarEntry(spec: TarEntrySpec): Buffer {
  const data =
    typeof spec.data === 'string'
      ? Buffer.from(spec.data)
      : (spec.data ?? Buffer.alloc(0));
  const blocks: Buffer[] = [];
  if (spec.pax) {
    const body = paxData(spec.pax);
    blocks.push(
      tarHeader({ name: 'PaxHeader/x', type: 'x', size: body.length }),
      padded(body),
    );
  }
  if (spec.gnuLongName !== undefined) {
    const body = Buffer.concat([
      Buffer.from(spec.gnuLongName),
      Buffer.from([0]),
    ]);
    blocks.push(
      tarHeader({
        name: '././@LongLink',
        type: 'L',
        size: body.length,
        magic: 'gnu',
      }),
      padded(body),
    );
  }
  const type = spec.type ?? '0';
  const hasData = !'123456'.includes(type);
  blocks.push(
    tarHeader({
      name: spec.name,
      type,
      size: spec.headerSize ?? data.length,
      ...(spec.linkName ? { linkName: spec.linkName } : {}),
      ...(spec.prefix ? { prefix: spec.prefix } : {}),
      ...(spec.badChecksum ? { badChecksum: true } : {}),
      ...(spec.magic ? { magic: spec.magic } : {}),
    }),
  );
  if (hasData && data.length > 0) blocks.push(padded(data));
  return Buffer.concat(blocks);
}

export function tarArchive(
  entries: readonly TarEntrySpec[],
  options: { terminate?: boolean } = {},
): Buffer {
  const parts = entries.map(tarEntry);
  if (options.terminate !== false) parts.push(Buffer.alloc(BLOCK * 2));
  return Buffer.concat(parts);
}

export function tarGz(
  entries: readonly TarEntrySpec[],
  options: { terminate?: boolean } = {},
): Buffer {
  return gzipSync(tarArchive(entries, options));
}

/** A Node-shaped dist tarball: `node-v<ver>-<plat>-<arch>/{bin/node,LICENSE}`. */
export function nodeTarGz(
  version: string,
  platform: string,
  arch: string,
  files: { binary: Buffer | string; license?: string },
): Buffer {
  const dir = `node-v${version}-${platform}-${arch}`;
  return tarGz([
    { name: `${dir}/`, type: '5' },
    { name: `${dir}/LICENSE`, data: files.license ?? 'Node license text\n' },
    { name: `${dir}/bin/`, type: '5' },
    { name: `${dir}/bin/node`, data: files.binary },
    { name: `${dir}/README.md`, data: 'readme\n' },
  ]);
}

export async function* chunked(
  bytes: Uint8Array,
  size: number,
): AsyncGenerator<Uint8Array> {
  for (let offset = 0; offset < bytes.length; offset += size) {
    yield bytes.subarray(offset, offset + size);
  }
}
