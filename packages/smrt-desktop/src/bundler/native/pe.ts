/**
 * PE/COFF header parser: PE32+ images only. Reads the DOS header, `e_lfanew`,
 * the COFF file header (`Machine`, `Characteristics`) and the optional header
 * magic. PE32, i386, ARM64EC and every other machine are rejected or reported
 * as `other`, so a mismatching image fails the target check.
 */

import { NativeVerificationError } from './errors.js';
import type { BudgetedReader } from './reader.js';
import type { NativeInfo, NativeMachine } from './types.js';

const E_LFANEW_OFFSET = 0x3c;
const MIN_LFANEW = 0x40;
const MAX_LFANEW = 64 * 1024;
const COFF_HEADER_BYTES = 26; // signature, file header, optional magic

const MACHINE_AMD64 = 0x8664;
const MACHINE_ARM64 = 0xaa64;

const IMAGE_FILE_EXECUTABLE_IMAGE = 0x0002;
const IMAGE_FILE_DLL = 0x2000;
const OPTIONAL_MAGIC_PE32 = 0x10b;
const OPTIONAL_MAGIC_PE32_PLUS = 0x20b;

/**
 * The `PE\0\0` offset when `head` is a DOS stub that could introduce a PE
 * image, else `undefined`. `head` must hold at least the first 64 bytes of the
 * file (or all of it when shorter).
 */
export function peSignatureOffset(
  head: Uint8Array,
  fileSize: number,
): number | undefined {
  if (
    head.length < E_LFANEW_OFFSET + 4 ||
    head[0] !== 0x4d ||
    head[1] !== 0x5a
  ) {
    return undefined;
  }
  const buf = Buffer.from(head.buffer, head.byteOffset, head.length);
  const lfanew = buf.readUInt32LE(E_LFANEW_OFFSET);
  if (
    lfanew < MIN_LFANEW ||
    lfanew > MAX_LFANEW ||
    lfanew + COFF_HEADER_BYTES > fileSize
  ) {
    return undefined;
  }
  return lfanew;
}

function machineOf(machine: number): NativeMachine {
  if (machine === MACHINE_AMD64) return 'x86_64';
  if (machine === MACHINE_ARM64) return 'arm64';
  return 'other';
}

/** Parse a PE image (the DOS stub must already look like one). */
export async function parsePe(reader: BudgetedReader): Promise<NativeInfo> {
  const dos = await reader.bytes(0, Math.min(64, reader.size));
  const lfanew = peSignatureOffset(dos, reader.size);
  if (lfanew === undefined) throw new NativeVerificationError('malformed');

  const coff = await reader.bytes(lfanew, COFF_HEADER_BYTES);
  if (
    coff[0] !== 0x50 ||
    coff[1] !== 0x45 ||
    coff[2] !== 0x00 ||
    coff[3] !== 0x00
  ) {
    throw new NativeVerificationError('malformed');
  }
  const machine = coff.readUInt16LE(4);
  const optionalSize = coff.readUInt16LE(20);
  const characteristics = coff.readUInt16LE(22);
  const magic = coff.readUInt16LE(24);
  if (optionalSize < 2 || lfanew + 24 + optionalSize > reader.size) {
    throw new NativeVerificationError('truncated');
  }
  if ((characteristics & IMAGE_FILE_EXECUTABLE_IMAGE) === 0) {
    throw new NativeVerificationError('malformed');
  }
  if (magic === OPTIONAL_MAGIC_PE32) {
    throw new NativeVerificationError('unsupported_format');
  }
  if (magic !== OPTIONAL_MAGIC_PE32_PLUS) {
    throw new NativeVerificationError('malformed');
  }
  return {
    format: 'pe',
    kind: (characteristics & IMAGE_FILE_DLL) === 0 ? 'executable' : 'library',
    machines: [machineOf(machine)],
  };
}
