/**
 * ELF header parser: ELF64 little-endian only (the Linux x86_64 and aarch64
 * targets). Reads `e_type`, `e_machine`, the program headers, and from
 * `PT_INTERP` / `PT_DYNAMIC` / `DT_NEEDED` decides which C library the file
 * links against.
 *
 * libc detection is evidence-based and static:
 * - an interpreter or needed library named like musl (`ld-musl-*`,
 *   `libc.musl-*`) means `musl`; musl wins over glibc when both appear;
 * - otherwise an interpreter `ld-linux*`/`ld.so*` or a needed `libc.so.6`
 *   means `glibc`;
 * - an interpreter of any other name means `unknown` (fail closed on a gnu
 *   target);
 * - no interpreter and no libc in `DT_NEEDED` means `none` (static or
 *   libc-free), which a gnu target accepts.
 * Not parsed: `.gnu.version_r` (the highest `GLIBC_2.x` symbol version needed),
 * which requires section headers; the glibc floor is not checked.
 */

import { NativeVerificationError } from './errors.js';
import { type BudgetedReader, safeU64 } from './reader.js';
import type {
  NativeInfo,
  NativeKind,
  NativeLibc,
  NativeMachine,
} from './types.js';

const ELFCLASS32 = 1;
const ELFCLASS64 = 2;
const ELFDATA2LSB = 1;
const ELFDATA2MSB = 2;

const ET_EXEC = 2;
const ET_DYN = 3;

const EM_X86_64 = 62;
const EM_AARCH64 = 183;

const PT_LOAD = 1;
const PT_DYNAMIC = 2;
const PT_INTERP = 3;

const DT_NULL = 0;
const DT_NEEDED = 1;
const DT_STRTAB = 5;
const DT_STRSZ = 10;

const ELF64_EHDR_SIZE = 64;
const ELF64_PHDR_SIZE = 56;
const ELF64_DYN_SIZE = 16;
const MAX_PROGRAM_HEADERS = 64;
const MAX_DYNAMIC_ENTRIES = 512;
const MAX_INTERP_BYTES = 4096;
const MAX_NEEDED_NAME = 256;
const MAX_STRTAB_BYTES = 1024 * 1024;

/** True when `head` begins with the ELF magic. */
export function hasElfMagic(head: Uint8Array): boolean {
  return (
    head.length >= 4 &&
    head[0] === 0x7f &&
    head[1] === 0x45 &&
    head[2] === 0x4c &&
    head[3] === 0x46
  );
}

interface Phdr {
  readonly type: number;
  readonly offset: number;
  readonly vaddr: number;
  readonly filesz: number;
}

function machineOf(machine: number): NativeMachine {
  if (machine === EM_X86_64) return 'x86_64';
  if (machine === EM_AARCH64) return 'arm64';
  return 'other';
}

async function readProgramHeaders(
  reader: BudgetedReader,
  header: Buffer,
): Promise<Phdr[]> {
  const phnum = header.readUInt16LE(56);
  if (phnum === 0) return [];
  if (phnum > MAX_PROGRAM_HEADERS) {
    throw new NativeVerificationError('malformed');
  }
  if (header.readUInt16LE(54) !== ELF64_PHDR_SIZE) {
    throw new NativeVerificationError('malformed');
  }
  const phoff = safeU64(header.readBigUInt64LE(32));
  const table = await reader.bytes(phoff, phnum * ELF64_PHDR_SIZE);
  const out: Phdr[] = [];
  for (let i = 0; i < phnum; i++) {
    const at = i * ELF64_PHDR_SIZE;
    out.push({
      type: table.readUInt32LE(at),
      offset: safeU64(table.readBigUInt64LE(at + 8)),
      vaddr: safeU64(table.readBigUInt64LE(at + 16)),
      filesz: safeU64(table.readBigUInt64LE(at + 32)),
    });
  }
  return out;
}

async function readInterpreter(
  reader: BudgetedReader,
  phdr: Phdr,
): Promise<string> {
  if (phdr.filesz === 0 || phdr.filesz > MAX_INTERP_BYTES) {
    throw new NativeVerificationError('malformed');
  }
  const raw = await reader.bytes(phdr.offset, phdr.filesz);
  const end = raw.indexOf(0);
  if (end < 0) throw new NativeVerificationError('malformed');
  return raw.toString('latin1', 0, end);
}

async function readNeeded(
  reader: BudgetedReader,
  phdrs: readonly Phdr[],
  dynamic: Phdr,
): Promise<string[]> {
  const maxBytes = MAX_DYNAMIC_ENTRIES * ELF64_DYN_SIZE;
  const length = Math.min(dynamic.filesz, maxBytes);
  const whole = length - (length % ELF64_DYN_SIZE);
  if (whole === 0) return [];
  const raw = await reader.bytes(dynamic.offset, whole);

  const needed: number[] = [];
  let strtab: number | undefined;
  let strsz: number | undefined;
  for (let at = 0; at < whole; at += ELF64_DYN_SIZE) {
    const tag = raw.readBigInt64LE(at);
    if (tag === BigInt(DT_NULL)) break;
    const value = raw.readBigUInt64LE(at + 8);
    if (tag === BigInt(DT_NEEDED)) needed.push(safeU64(value));
    else if (tag === BigInt(DT_STRTAB)) strtab = safeU64(value);
    else if (tag === BigInt(DT_STRSZ)) strsz = safeU64(value);
  }
  if (needed.length === 0) return [];
  if (strtab === undefined || strsz === undefined || strsz > MAX_STRTAB_BYTES) {
    throw new NativeVerificationError('malformed');
  }

  // Map the string table's virtual address to a file offset via PT_LOAD.
  const load = phdrs.find(
    (p) =>
      p.type === PT_LOAD &&
      strtab >= p.vaddr &&
      strtab + strsz <= p.vaddr + p.filesz,
  );
  if (load === undefined) throw new NativeVerificationError('malformed');
  const base = load.offset + (strtab - load.vaddr);

  const names: string[] = [];
  for (const nameOffset of needed) {
    if (nameOffset >= strsz) throw new NativeVerificationError('malformed');
    const room = Math.min(MAX_NEEDED_NAME, strsz - nameOffset);
    const raw = await reader.bytes(base + nameOffset, room);
    const end = raw.indexOf(0);
    if (end < 0) throw new NativeVerificationError('malformed');
    names.push(raw.toString('latin1', 0, end));
  }
  return names;
}

function libcOf(interpreter: string | undefined, needed: string[]): NativeLibc {
  const names = interpreter === undefined ? needed : [interpreter, ...needed];
  const isMusl = (name: string) =>
    name.includes('ld-musl-') || /(?:^|\/)libc\.musl-/.test(name);
  if (names.some(isMusl)) return 'musl';
  const isGlibc = (name: string) =>
    /(?:^|\/)ld-linux[^/]*\.so\.\d+$/.test(name) ||
    /(?:^|\/)ld\.so\.\d+$/.test(name) ||
    /(?:^|\/)libc\.so\.6$/.test(name);
  if (names.some(isGlibc)) return 'glibc';
  return interpreter === undefined ? 'none' : 'unknown';
}

/** Parse an ELF64 little-endian file. */
export async function parseElf(reader: BudgetedReader): Promise<NativeInfo> {
  const header = await reader.bytes(0, ELF64_EHDR_SIZE);
  if (!hasElfMagic(header)) throw new NativeVerificationError('malformed');
  const cls = header[4];
  const data = header[5];
  if (cls === ELFCLASS32 || data === ELFDATA2MSB) {
    throw new NativeVerificationError('unsupported_format');
  }
  if (cls !== ELFCLASS64 || data !== ELFDATA2LSB || header[6] !== 1) {
    throw new NativeVerificationError('malformed');
  }
  const type = header.readUInt16LE(16);
  if (type !== ET_EXEC && type !== ET_DYN) {
    throw new NativeVerificationError('unsupported_format');
  }
  const machine = machineOf(header.readUInt16LE(18));

  const phdrs = await readProgramHeaders(reader, header);
  const interp = phdrs.find((p) => p.type === PT_INTERP);
  const dynamic = phdrs.find((p) => p.type === PT_DYNAMIC);
  const interpreter =
    interp === undefined ? undefined : await readInterpreter(reader, interp);
  const needed =
    dynamic === undefined ? [] : await readNeeded(reader, phdrs, dynamic);

  let kind: NativeKind;
  if (type === ET_EXEC) kind = 'executable';
  else kind = interp === undefined ? 'library' : 'either';

  return {
    format: 'elf',
    kind,
    machines: [machine],
    libc: libcOf(interpreter, needed),
  };
}
