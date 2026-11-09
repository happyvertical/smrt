/** Shared result types of the native header parsers. */

/** Container format, as identified from the header bytes. */
export type NativeFormat = 'macho' | 'macho-fat' | 'elf' | 'pe';

/** Instruction set a native file targets; `other` is any unlisted machine. */
export type NativeMachine = 'arm64' | 'x86_64' | 'other';

/**
 * What the file is. `either` is an ELF `ET_DYN` that carries a `PT_INTERP`:
 * a position-independent executable and a shared object that has an
 * interpreter look the same in the headers, so it satisfies both roles.
 */
export type NativeKind = 'executable' | 'library' | 'either';

/** C library an ELF file links against; `none` is static or libc-free. */
export type NativeLibc = 'glibc' | 'musl' | 'none' | 'unknown';

/** What a header parser learned about one native file. */
export interface NativeInfo {
  readonly format: NativeFormat;
  readonly kind: NativeKind;
  /** One machine for thin files; one per slice for a fat Mach-O. */
  readonly machines: readonly NativeMachine[];
  /** ELF only. */
  readonly libc?: NativeLibc;
}
