/**
 * Mach-O header parser: thin 64-bit little-endian images and fat (universal)
 * containers. Only the fields the verifier needs are read (`cputype`,
 * `filetype`); 32-bit, big-endian thin and non-image file types are rejected
 * (`unsupported_format`), garbage and out-of-range offsets are `malformed` or
 * `truncated`. Every read goes through a `BudgetedReader`.
 */

import { NativeVerificationError } from './errors.js';
import { type BudgetedReader, safeU64 } from './reader.js';
import type { NativeInfo, NativeKind, NativeMachine } from './types.js';

const MH_MAGIC_64 = 0xfeedfacf;
const MH_CIGAM_64 = 0xcffaedfe;
const MH_MAGIC_32 = 0xfeedface;
const MH_CIGAM_32 = 0xcefaedfe;
const FAT_MAGIC = 0xcafebabe;
const FAT_MAGIC_64 = 0xcafebabf;

const CPU_TYPE_X86_64 = 0x01000007;
const CPU_TYPE_ARM64 = 0x0100000c;

const MH_EXECUTE = 2;
const MH_DYLIB = 6;
const MH_BUNDLE = 8;

/** Size of `mach_header_64`. */
const HEADER_SIZE = 32;
const MAX_FAT_ARCHES = 8;

/** True when `head` begins with a Mach-O thin magic (any width or order). */
export function hasThinMachoMagic(head: Uint8Array): boolean {
  if (head.length < 4) return false;
  const be = Buffer.from(head.buffer, head.byteOffset, 4).readUInt32BE(0);
  return (
    be === MH_CIGAM_64 || // bytes CF FA ED FE: 64-bit little-endian
    be === MH_MAGIC_64 || // bytes FE ED FA CF: 64-bit big-endian
    be === MH_CIGAM_32 ||
    be === MH_MAGIC_32
  );
}

/**
 * True when `head` begins like a fat Mach-O: the fat magic and a slice count
 * of 1..8. Java class files share 0xCAFEBABE but carry a version above 8 in
 * the same field, so they are not fat.
 */
export function hasFatMachoMagic(head: Uint8Array): boolean {
  if (head.length < 8) return false;
  const buf = Buffer.from(head.buffer, head.byteOffset, 8);
  const magic = buf.readUInt32BE(0);
  if (magic !== FAT_MAGIC && magic !== FAT_MAGIC_64) return false;
  const count = buf.readUInt32BE(4);
  return count >= 1 && count <= MAX_FAT_ARCHES;
}

function machineOf(cputype: number): NativeMachine {
  if (cputype === CPU_TYPE_ARM64) return 'arm64';
  if (cputype === CPU_TYPE_X86_64) return 'x86_64';
  return 'other';
}

function kindOf(filetype: number): NativeKind {
  if (filetype === MH_EXECUTE) return 'executable';
  if (filetype === MH_DYLIB || filetype === MH_BUNDLE) return 'library';
  throw new NativeVerificationError('unsupported_format');
}

interface Thin {
  readonly cputype: number;
  readonly kind: NativeKind;
}

async function readThin(
  reader: BudgetedReader,
  offset: number,
  length: number,
): Promise<Thin> {
  if (length < HEADER_SIZE) throw new NativeVerificationError('truncated');
  const head = await reader.bytes(offset, HEADER_SIZE);
  const magic = head.readUInt32BE(0);
  if (magic !== MH_CIGAM_64) {
    // 32-bit and big-endian thin images are not supported targets.
    if (
      magic === MH_MAGIC_64 ||
      magic === MH_MAGIC_32 ||
      magic === MH_CIGAM_32
    ) {
      throw new NativeVerificationError('unsupported_format');
    }
    throw new NativeVerificationError('malformed');
  }
  return { cputype: head.readUInt32LE(4), kind: kindOf(head.readUInt32LE(12)) };
}

/** Parse a thin 64-bit little-endian Mach-O. */
export async function parseThinMacho(
  reader: BudgetedReader,
): Promise<NativeInfo> {
  const thin = await readThin(reader, 0, reader.size);
  return {
    format: 'macho',
    kind: thin.kind,
    machines: [machineOf(thin.cputype)],
  };
}

/** Parse a fat Mach-O and the thin header of every slice. */
export async function parseFatMacho(
  reader: BudgetedReader,
): Promise<NativeInfo> {
  const head = await reader.bytes(0, 8);
  const wide = head.readUInt32BE(0) === FAT_MAGIC_64;
  if (!wide && head.readUInt32BE(0) !== FAT_MAGIC) {
    throw new NativeVerificationError('malformed');
  }
  const count = head.readUInt32BE(4);
  if (count < 1 || count > MAX_FAT_ARCHES) {
    throw new NativeVerificationError('malformed');
  }
  const entrySize = wide ? 32 : 20;
  const tableEnd = 8 + count * entrySize;
  if (tableEnd > reader.size) throw new NativeVerificationError('truncated');
  const table = await reader.bytes(8, count * entrySize);

  const machines: NativeMachine[] = [];
  const seen = new Set<number>();
  let kind: NativeKind | undefined;
  for (let i = 0; i < count; i++) {
    const at = i * entrySize;
    const cputype = table.readUInt32BE(at);
    const offset = wide
      ? safeU64(table.readBigUInt64BE(at + 8))
      : table.readUInt32BE(at + 8);
    const size = wide
      ? safeU64(table.readBigUInt64BE(at + 16))
      : table.readUInt32BE(at + 12);
    if (seen.has(cputype)) throw new NativeVerificationError('malformed');
    seen.add(cputype);
    // A slice must lie after the table and inside the file.
    if (offset < tableEnd || offset + size > reader.size) {
      throw new NativeVerificationError('truncated');
    }
    const thin = await readThin(reader, offset, size);
    if (thin.cputype !== cputype) {
      throw new NativeVerificationError('malformed');
    }
    if (kind !== undefined && kind !== thin.kind) {
      throw new NativeVerificationError('malformed');
    }
    kind = thin.kind;
    machines.push(machineOf(cputype));
  }
  return { format: 'macho-fat', kind: kind ?? 'library', machines };
}
