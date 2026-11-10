/**
 * Test-only builders for minimal native binary headers. Nothing here is a
 * runnable program; each builder emits just the bytes the verifier reads, so
 * no binary blob is ever committed. Excluded from published types together
 * with the rest of the testing fixtures.
 */

export type Cpu = 'arm64' | 'x86_64' | 'i386' | number;

const MACH_CPU: Record<string, number> = {
  arm64: 0x0100000c,
  x86_64: 0x01000007,
  i386: 0x00000007,
};

function cpuNumber(cpu: Cpu): number {
  return typeof cpu === 'number' ? cpu : (MACH_CPU[cpu] as number);
}

export interface MachoThinOptions {
  cpu?: Cpu;
  /** 2 executable, 6 dylib, 8 bundle. */
  filetype?: number;
  /** `64-le` (default), `32-le`, `64-be`. */
  width?: '64-le' | '32-le' | '64-be';
  /** Total length; defaults to 64. */
  length?: number;
}

/** A minimal Mach-O header (`mach_header_64`, zero load commands). */
export function machoThin(options: MachoThinOptions = {}): Buffer {
  const { cpu = 'arm64', filetype = 6, width = '64-le' } = options;
  const out = Buffer.alloc(options.length ?? 64);
  if (width === '64-le') {
    out.writeUInt32BE(0xcffaedfe, 0);
    out.writeUInt32LE(cpuNumber(cpu), 4);
    out.writeUInt32LE(filetype, 12);
  } else if (width === '32-le') {
    out.writeUInt32BE(0xcefaedfe, 0);
    out.writeUInt32LE(cpuNumber(cpu) & 0xffffff, 4);
    out.writeUInt32LE(filetype, 12);
  } else {
    out.writeUInt32BE(0xfeedfacf, 0);
    out.writeUInt32BE(cpuNumber(cpu), 4);
    out.writeUInt32BE(filetype, 12);
  }
  return out;
}

export interface FatSlice {
  /** Entry cputype in the fat table. */
  cpu: Cpu;
  /** The slice's own thin header; defaults to one matching `cpu`. */
  data?: Buffer;
  filetype?: number;
}

/** A fat Mach-O container (32-bit offsets, or 64-bit with `wide`). */
export function machoFat(slices: FatSlice[], wide = false): Buffer {
  const entry = wide ? 32 : 20;
  const table = 8 + slices.length * entry;
  const parts = slices.map(
    (s) =>
      s.data ??
      machoThin({
        cpu: s.cpu,
        ...(s.filetype === undefined ? {} : { filetype: s.filetype }),
      }),
  );
  const head = Buffer.alloc(table);
  head.writeUInt32BE(wide ? 0xcafebabf : 0xcafebabe, 0);
  head.writeUInt32BE(slices.length, 4);
  let offset = table;
  slices.forEach((s, i) => {
    const at = 8 + i * entry;
    head.writeUInt32BE(cpuNumber(s.cpu), at);
    head.writeUInt32BE(0, at + 4);
    const part = parts[i] as Buffer;
    if (wide) {
      head.writeBigUInt64BE(BigInt(offset), at + 8);
      head.writeBigUInt64BE(BigInt(part.length), at + 16);
      head.writeUInt32BE(14, at + 24);
    } else {
      head.writeUInt32BE(offset, at + 8);
      head.writeUInt32BE(part.length, at + 12);
      head.writeUInt32BE(14, at + 16);
    }
    offset += part.length;
  });
  return Buffer.concat([head, ...parts]);
}

/** A Java class file header: shares 0xCAFEBABE with fat Mach-O. */
export function javaClass(): Buffer {
  const out = Buffer.alloc(64);
  out.writeUInt32BE(0xcafebabe, 0);
  out.writeUInt16BE(0, 4); // minor
  out.writeUInt16BE(52, 6); // major
  return out;
}

export interface ElfOptions {
  machine?: 'x86_64' | 'aarch64' | 'riscv' | number;
  /** 2 ET_EXEC, 3 ET_DYN. */
  type?: number;
  /** 1 = ELF32, 2 = ELF64. */
  cls?: number;
  /** 1 = LE, 2 = BE. */
  data?: number;
  interp?: string;
  needed?: string[];
  /** Omit PT_DYNAMIC even when `needed` is empty (default: always emit). */
  noDynamic?: boolean;
  /**
   * Zero bytes appended to the dynamic string table (and counted in DT_STRSZ),
   * to model a large `.dynstr`. The official Node 26.8.1 linux-x64 binary has
   * a 2,694,159 byte one (it exports its whole N-API and V8 surface).
   */
  strtabPadding?: number;
}

const ELF_MACHINE: Record<string, number> = {
  x86_64: 62,
  aarch64: 183,
  riscv: 243,
};

/**
 * A minimal ELF64 image: header, program headers (PT_LOAD over the whole
 * file at a non-zero virtual base, optional PT_INTERP, PT_DYNAMIC), the
 * dynamic table with DT_NEEDED/DT_STRTAB/DT_STRSZ, and the string table.
 */
export function elf(options: ElfOptions = {}): Buffer {
  const {
    machine = 'x86_64',
    type = 3,
    cls = 2,
    data = 1,
    interp,
    needed = [],
    noDynamic = false,
    strtabPadding = 0,
  } = options;
  const le = data !== 2;
  const w16 = (b: Buffer, v: number, at: number) =>
    le ? b.writeUInt16LE(v, at) : b.writeUInt16BE(v, at);

  const strtabParts: Buffer[] = [Buffer.from([0])];
  const nameOffsets: number[] = [];
  let strLen = 1;
  for (const name of needed) {
    nameOffsets.push(strLen);
    const b = Buffer.from(`${name}\0`, 'latin1');
    strtabParts.push(b);
    strLen += b.length;
  }
  if (strtabPadding > 0) strtabParts.push(Buffer.alloc(strtabPadding));
  const strtab = Buffer.concat(strtabParts);

  const emitDynamic = !noDynamic;
  const phnum = 1 + (interp === undefined ? 0 : 1) + (emitDynamic ? 1 : 0);
  const phoff = 64;
  const interpOff = phoff + phnum * 56;
  const interpBytes =
    interp === undefined ? Buffer.alloc(0) : Buffer.from(`${interp}\0`);
  const dynOff = interpOff + interpBytes.length;
  const dynCount = needed.length + 3; // NEEDED*, STRTAB, STRSZ, NULL
  const dynBytes = dynCount * 16;
  const strOff = dynOff + (emitDynamic ? dynBytes : 0);
  const total = strOff + strtab.length;
  const vbase = 0x1000;

  const out = Buffer.alloc(total);
  out.set([0x7f, 0x45, 0x4c, 0x46, cls, data, 1], 0);
  w16(out, type, 16);
  w16(
    out,
    typeof machine === 'number' ? machine : (ELF_MACHINE[machine] as number),
    18,
  );
  if (le) {
    out.writeUInt32LE(1, 20);
    out.writeBigUInt64LE(BigInt(phoff), 32);
  } else {
    out.writeUInt32BE(1, 20);
    out.writeBigUInt64BE(BigInt(phoff), 32);
  }
  w16(out, 64, 52);
  w16(out, 56, 54);
  w16(out, phnum, 56);

  const ph = (
    index: number,
    ptype: number,
    offset: number,
    vaddr: number,
    size: number,
  ) => {
    const at = phoff + index * 56;
    out.writeUInt32LE(ptype, at);
    out.writeBigUInt64LE(BigInt(offset), at + 8);
    out.writeBigUInt64LE(BigInt(vaddr), at + 16);
    out.writeBigUInt64LE(BigInt(size), at + 32);
    out.writeBigUInt64LE(BigInt(size), at + 40);
  };
  let index = 0;
  ph(index++, 1, 0, vbase, total);
  if (interp !== undefined) {
    ph(index++, 3, interpOff, vbase + interpOff, interpBytes.length);
    out.set(interpBytes, interpOff);
  }
  if (emitDynamic) {
    ph(index++, 2, dynOff, vbase + dynOff, dynBytes);
    let at = dynOff;
    const dyn = (tag: number, value: number) => {
      out.writeBigInt64LE(BigInt(tag), at);
      out.writeBigUInt64LE(BigInt(value), at + 8);
      at += 16;
    };
    for (const off of nameOffsets) dyn(1, off);
    dyn(5, vbase + strOff);
    dyn(10, strtab.length);
    dyn(0, 0);
  }
  out.set(strtab, strOff);
  return out;
}

export interface PeOptions {
  machine?: 'x64' | 'arm64' | 'i386' | 'arm64ec' | number;
  /** PE32+ (default) or PE32. */
  pe32plus?: boolean;
  dll?: boolean;
  lfanew?: number;
  /** Override raw Characteristics. */
  characteristics?: number;
  length?: number;
}

const PE_MACHINE: Record<string, number> = {
  x64: 0x8664,
  arm64: 0xaa64,
  i386: 0x14c,
  arm64ec: 0xa641,
};

/** A minimal PE image: DOS stub, COFF header, optional-header magic. */
export function pe(options: PeOptions = {}): Buffer {
  const { machine = 'x64', pe32plus = true, dll = false } = options;
  const lfanew = options.lfanew ?? 0x80;
  const optionalSize = pe32plus ? 240 : 224;
  const out = Buffer.alloc(options.length ?? lfanew + 24 + optionalSize);
  out.write('MZ', 0, 'latin1');
  out.writeUInt32LE(lfanew, 0x3c);
  if (lfanew + 26 <= out.length) {
    out.write('PE\0\0', lfanew, 'latin1');
    out.writeUInt16LE(
      typeof machine === 'number' ? machine : (PE_MACHINE[machine] as number),
      lfanew + 4,
    );
    out.writeUInt16LE(optionalSize, lfanew + 20);
    out.writeUInt16LE(
      options.characteristics ?? 0x0022 | (dll ? 0x2000 : 0),
      lfanew + 22,
    );
    out.writeUInt16LE(pe32plus ? 0x20b : 0x10b, lfanew + 24);
  }
  return out;
}
