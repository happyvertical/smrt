import { describe, expect, it } from 'vitest';
import { TARGETS, type TargetSpec } from '../targets.js';
import {
  classifyNativeFile,
  nativeRoleOfPath,
  verifyNativeFile,
} from './classify.js';
import { NativeVerificationError } from './errors.js';
import { bufferReader } from './reader.js';
import {
  elf,
  javaClass,
  machoFat,
  machoThin,
  pe,
} from './testing/native-fixtures.js';

const target = (triple: string): TargetSpec => {
  const found = TARGETS.find((t) => t.triple === triple);
  if (!found) throw new Error('fixture target missing');
  return found;
};

const MAC_ARM = target('aarch64-apple-darwin');
const MAC_X64 = target('x86_64-apple-darwin');
const LIN_X64 = target('x86_64-unknown-linux-gnu');
const LIN_ARM = target('aarch64-unknown-linux-gnu');
const WIN_X64 = target('x86_64-pc-windows-msvc');
const WIN_ARM = target('aarch64-pc-windows-msvc');

const GLIBC = ['libc.so.6', 'libgcc_s.so.1'];

/** A native of `spec` that must verify, as library or executable. */
function good(spec: TargetSpec, role: 'library' | 'executable'): Buffer {
  const machine = spec.native.machine;
  switch (spec.native.format) {
    case 'macho':
      return machoThin({ cpu: machine, filetype: role === 'library' ? 6 : 2 });
    case 'elf':
      return role === 'library'
        ? elf({
            machine: machine === 'arm64' ? 'aarch64' : 'x86_64',
            needed: GLIBC,
          })
        : elf({
            machine: machine === 'arm64' ? 'aarch64' : 'x86_64',
            type: 2,
            interp: '/lib64/ld-linux-x86-64.so.2',
            needed: GLIBC,
          });
    case 'pe':
      return pe({
        machine: machine === 'arm64' ? 'arm64' : 'x64',
        dll: role === 'library',
      });
  }
}

describe('verifyNativeFile: every target accepts its own natives', () => {
  for (const spec of TARGETS) {
    it(`accepts ${spec.triple} library and executable`, async () => {
      for (const role of ['library', 'executable'] as const) {
        const verdict = await verifyNativeFile(good(spec, role), spec, {
          requireNative: true,
          expectKind: role,
        });
        expect(verdict).toMatchObject({ ok: true, kind: spec.native.format });
      }
    });
  }

  it('also takes a ByteReader and a triple string', async () => {
    const verdict = await verifyNativeFile(
      bufferReader(good(MAC_ARM, 'library')),
      'aarch64-apple-darwin',
    );
    expect(verdict.ok).toBe(true);
  });
});

describe('verifyNativeFile: cross matrix', () => {
  it('rejects every native built for any other target', async () => {
    for (const built of TARGETS) {
      for (const against of TARGETS) {
        if (built === against) continue;
        const verdict = await verifyNativeFile(good(built, 'library'), against);
        expect(verdict.ok, `${built.triple} on ${against.triple}`).toBe(false);
        const sameFormat = built.native.format === against.native.format;
        expect(verdict.reason).toBe(
          sameFormat ? 'wrong_machine' : 'wrong_format',
        );
      }
    }
  });
});

describe('Mach-O', () => {
  it('accepts thin arm64 and x86_64 addons (MH_BUNDLE and MH_DYLIB)', async () => {
    for (const filetype of [6, 8]) {
      expect(
        (await verifyNativeFile(machoThin({ cpu: 'arm64', filetype }), MAC_ARM))
          .ok,
      ).toBe(true);
      expect(
        (
          await verifyNativeFile(
            machoThin({ cpu: 'x86_64', filetype }),
            MAC_X64,
          )
        ).ok,
      ).toBe(true);
    }
  });

  it('rejects the wrong architecture', async () => {
    expect(
      await verifyNativeFile(machoThin({ cpu: 'x86_64' }), MAC_ARM),
    ).toMatchObject({ ok: false, reason: 'wrong_machine', kind: 'macho' });
    expect(
      await verifyNativeFile(machoThin({ cpu: 'arm64' }), MAC_X64),
    ).toMatchObject({ ok: false, reason: 'wrong_machine' });
    expect(
      await verifyNativeFile(machoThin({ cpu: 0x0100000a }), MAC_ARM),
    ).toMatchObject({ ok: false, reason: 'wrong_machine' });
  });

  it('rejects 32-bit and big-endian thin images and non-image file types', async () => {
    expect(
      await verifyNativeFile(machoThin({ width: '32-le' }), MAC_ARM),
    ).toMatchObject({ ok: false, reason: 'unsupported_format' });
    expect(
      await verifyNativeFile(machoThin({ width: '64-be' }), MAC_ARM),
    ).toMatchObject({ ok: false, reason: 'unsupported_format' });
    for (const filetype of [0, 1, 4, 7, 9, 10, 11, 12, 99]) {
      expect(
        await verifyNativeFile(machoThin({ filetype }), MAC_ARM),
      ).toMatchObject({ ok: false, reason: 'unsupported_format' });
    }
  });

  it('accepts a fat Mach-O with the target slice and reports all arches', async () => {
    const fat = machoFat([{ cpu: 'x86_64' }, { cpu: 'arm64' }]);
    const verdict = await verifyNativeFile(fat, MAC_ARM);
    expect(verdict).toMatchObject({ ok: true, kind: 'macho-fat' });
    expect(verdict.info?.machines).toEqual(['x86_64', 'arm64']);
    expect((await verifyNativeFile(fat, MAC_X64)).ok).toBe(true);
    const wide = machoFat([{ cpu: 'arm64' }, { cpu: 'x86_64' }], true);
    expect((await verifyNativeFile(wide, MAC_X64)).ok).toBe(true);
  });

  it('rejects a fat Mach-O that lacks the target slice', async () => {
    const fat = machoFat([{ cpu: 'x86_64' }]);
    expect(await verifyNativeFile(fat, MAC_ARM)).toMatchObject({
      ok: false,
      reason: 'wrong_machine',
    });
  });

  it('rejects a fat header whose slice header disagrees', async () => {
    // Entry says arm64, the slice itself says x86_64.
    const lying = machoFat([
      { cpu: 'x86_64' },
      { cpu: 'arm64', data: machoThin({ cpu: 'x86_64' }) },
    ]);
    expect(await verifyNativeFile(lying, MAC_ARM)).toMatchObject({
      ok: false,
      reason: 'malformed',
    });
    // One slice is a 32-bit image: the whole container fails.
    const wrongSlice = machoFat([
      { cpu: 'arm64' },
      { cpu: 'i386', data: machoThin({ width: '32-le', cpu: 'i386' }) },
    ]);
    expect(await verifyNativeFile(wrongSlice, MAC_ARM)).toMatchObject({
      ok: false,
      reason: 'unsupported_format',
    });
  });

  it('rejects fat containers with duplicate arches, mixed kinds or bad offsets', async () => {
    expect(
      await verifyNativeFile(
        machoFat([{ cpu: 'arm64' }, { cpu: 'arm64' }]),
        MAC_ARM,
      ),
    ).toMatchObject({ ok: false, reason: 'malformed' });
    expect(
      await verifyNativeFile(
        machoFat([
          { cpu: 'arm64', filetype: 6 },
          { cpu: 'x86_64', filetype: 2 },
        ]),
        MAC_ARM,
      ),
    ).toMatchObject({ ok: false, reason: 'malformed' });
    const bad = machoFat([{ cpu: 'arm64' }]);
    bad.writeUInt32BE(0xffffff00, 16); // slice offset far past the end
    expect(await verifyNativeFile(bad, MAC_ARM)).toMatchObject({
      ok: false,
      reason: 'truncated',
    });
    const overlap = machoFat([{ cpu: 'arm64' }]);
    overlap.writeUInt32BE(4, 16); // slice starts inside the fat table
    expect(await verifyNativeFile(overlap, MAC_ARM)).toMatchObject({
      ok: false,
      reason: 'truncated',
    });
  });

  it('rejects a Java class file mistaken for fat Mach-O', async () => {
    expect(await classifyNativeFile(javaClass())).toBeUndefined();
    expect(await verifyNativeFile(javaClass(), MAC_ARM)).toEqual({
      kind: 'not-native',
      ok: true,
    });
    expect(
      await verifyNativeFile(javaClass(), MAC_ARM, { requireNative: true }),
    ).toMatchObject({ ok: false, reason: 'not_native' });
  });

  it('rejects a 64-bit fat slice offset beyond the safe integer range', async () => {
    const wide = machoFat([{ cpu: 'arm64' }], true);
    wide.writeBigUInt64BE(0xffffffffffffffffn, 16);
    expect(await verifyNativeFile(wide, MAC_ARM)).toMatchObject({
      ok: false,
      reason: 'truncated',
    });
  });
});

describe('ELF', () => {
  const x64 = (extra = {}) =>
    elf({ machine: 'x86_64', needed: GLIBC, ...extra });

  it('accepts glibc x86_64 and aarch64 shared objects', async () => {
    expect((await verifyNativeFile(x64(), LIN_X64)).ok).toBe(true);
    expect(
      (
        await verifyNativeFile(
          elf({ machine: 'aarch64', needed: GLIBC }),
          LIN_ARM,
        )
      ).ok,
    ).toBe(true);
  });

  it('rejects aarch64 on an x86_64 target and the reverse', async () => {
    const arm = elf({ machine: 'aarch64', needed: GLIBC });
    expect(await verifyNativeFile(arm, LIN_X64)).toMatchObject({
      ok: false,
      reason: 'wrong_machine',
    });
    expect(await verifyNativeFile(x64(), LIN_ARM)).toMatchObject({
      ok: false,
      reason: 'wrong_machine',
    });
    expect(
      await verifyNativeFile(elf({ machine: 'riscv', needed: GLIBC }), LIN_X64),
    ).toMatchObject({ ok: false, reason: 'wrong_machine' });
  });

  it('accepts an official-Node-shaped linux executable with a 2.7 MB .dynstr', async () => {
    // Node 26.8.1 linux-x64: ET_EXEC, PT_INTERP /lib64/ld-linux-x86-64.so.2,
    // glibc DT_NEEDED entries, DT_STRSZ 2,694,159. A 1 MiB cap on the declared
    // size rejected every official Node binary as malformed.
    const node = elf({
      type: 2,
      interp: '/lib64/ld-linux-x86-64.so.2',
      needed: [
        'libdl.so.2',
        'libstdc++.so.6',
        'libm.so.6',
        'libgcc_s.so.1',
        'libpthread.so.0',
        'libc.so.6',
      ],
      strtabPadding: 2_694_159 - 200,
    });
    const verdict = await verifyNativeFile(node, LIN_X64, {
      requireNative: true,
      expectKind: 'executable',
    });
    expect(verdict).toMatchObject({ ok: true });
  });

  it('still rejects an absurd declared string table size', async () => {
    const huge = elf({
      type: 2,
      interp: '/lib64/ld-linux-x86-64.so.2',
      needed: ['libc.so.6'],
      strtabPadding: 300 * 1024 * 1024,
    });
    const verdict = await verifyNativeFile(huge, LIN_X64);
    expect(verdict).toMatchObject({ ok: false });
  });

  it('rejects a musl addon on a gnu target (DT_NEEDED)', async () => {
    const musl = elf({ needed: ['libc.musl-x86_64.so.1'] });
    const verdict = await verifyNativeFile(musl, LIN_X64);
    expect(verdict).toMatchObject({ ok: false, reason: 'wrong_libc' });
    expect(verdict.info?.libc).toBe('musl');
  });

  it('rejects a musl addon that needs the unversioned libc.so on a gnu target', async () => {
    // No PT_INTERP: a shared object built against musl outside Alpine.
    const musl = elf({ needed: ['libstdc++.so.6', 'libc.so'] });
    const verdict = await verifyNativeFile(musl, LIN_X64);
    expect(verdict).toMatchObject({ ok: false, reason: 'wrong_libc' });
    expect(verdict.info?.libc).toBe('musl');
  });

  it('fails closed on an addon whose needed libraries name no recognised libc', async () => {
    for (const needed of [
      ['libfoo.so.1'],
      ['libssl.so.3', 'libz.so.1'],
      ['libm.so.6', 'libfoo.so.1'],
    ]) {
      const odd = elf({ needed });
      const verdict = await verifyNativeFile(odd, LIN_X64);
      expect(verdict, needed.join()).toMatchObject({
        ok: false,
        reason: 'wrong_libc',
      });
      expect(verdict.info?.libc).toBe('unknown');
    }
  });

  it('keeps accepting addons that need only glibc companions or the GCC runtime', async () => {
    for (const needed of [
      ['libm.so.6'],
      ['libstdc++.so.6', 'libgcc_s.so.1', 'libm.so.6'],
      ['libdl.so.2', 'libpthread.so.0', 'librt.so.1'],
      ['libc.so.6', 'libssl.so.3'],
    ]) {
      const addon = elf({ needed });
      expect((await verifyNativeFile(addon, LIN_X64)).ok, needed.join()).toBe(
        true,
      );
    }
    expect((await classifyNativeFile(elf({ needed: [] })))?.libc).toBe('none');
  });

  it('detects musl through the interpreter and prefers musl over glibc', async () => {
    expect(
      (
        await classifyNativeFile(
          elf({ type: 2, interp: '/lib/ld-musl-x86_64.so.1' }),
        )
      )?.libc,
    ).toBe('musl');
    expect(
      (
        await classifyNativeFile(
          elf({ needed: ['libc.so.6', 'libc.musl-aarch64.so.1'] }),
        )
      )?.libc,
    ).toBe('musl');
  });

  it('detects glibc through the interpreter', async () => {
    const info = await classifyNativeFile(
      elf({ type: 2, interp: '/lib/ld-linux-aarch64.so.1' }),
    );
    expect(info).toMatchObject({ libc: 'glibc', kind: 'executable' });
  });

  it('accepts libc-free and static files, rejects unknown interpreters', async () => {
    const free = elf({ needed: ['libm.so.6'] });
    expect((await classifyNativeFile(free))?.libc).toBe('none');
    expect((await verifyNativeFile(free, LIN_X64)).ok).toBe(true);
    expect((await verifyNativeFile(elf({ noDynamic: true }), LIN_X64)).ok).toBe(
      true,
    );
    const odd = elf({ type: 2, interp: '/opt/custom/loader.so' });
    expect((await classifyNativeFile(odd))?.libc).toBe('unknown');
    expect(await verifyNativeFile(odd, LIN_X64)).toMatchObject({
      ok: false,
      reason: 'wrong_libc',
    });
  });

  it('classifies kinds: ET_EXEC, PIE with interpreter, plain shared object', async () => {
    expect((await classifyNativeFile(elf({ type: 2 })))?.kind).toBe(
      'executable',
    );
    expect(
      (await classifyNativeFile(elf({ interp: '/lib64/ld-linux-x86-64.so.2' })))
        ?.kind,
    ).toBe('either');
    expect((await classifyNativeFile(elf()))?.kind).toBe('library');
    expect(
      (await verifyNativeFile(elf(), LIN_X64, { expectKind: 'executable' }))
        .reason,
    ).toBe('wrong_kind');
  });

  it('rejects big-endian, ELF32 and relocatable files', async () => {
    expect(await verifyNativeFile(elf({ data: 2 }), LIN_X64)).toMatchObject({
      ok: false,
      reason: 'unsupported_format',
    });
    expect(await verifyNativeFile(elf({ cls: 1 }), LIN_X64)).toMatchObject({
      ok: false,
      reason: 'unsupported_format',
    });
    expect(await verifyNativeFile(elf({ type: 1 }), LIN_X64)).toMatchObject({
      ok: false,
      reason: 'unsupported_format',
    });
    expect(await verifyNativeFile(elf({ cls: 7 }), LIN_X64)).toMatchObject({
      ok: false,
      reason: 'malformed',
    });
  });

  it('rejects out-of-bounds program headers, strtab and names', async () => {
    const hugePhoff = elf();
    hugePhoff.writeBigUInt64LE(0x7fffffffffffffffn, 32);
    expect(await verifyNativeFile(hugePhoff, LIN_X64)).toMatchObject({
      ok: false,
      reason: 'truncated',
    });
    const manyHeaders = elf();
    manyHeaders.writeUInt16LE(65, 56);
    expect(await verifyNativeFile(manyHeaders, LIN_X64)).toMatchObject({
      ok: false,
      reason: 'malformed',
    });
    const badEntSize = elf();
    badEntSize.writeUInt16LE(32, 54);
    expect(await verifyNativeFile(badEntSize, LIN_X64)).toMatchObject({
      ok: false,
      reason: 'malformed',
    });
    // Point DT_STRTAB outside every PT_LOAD segment.
    const lostStrtab = elf({ needed: GLIBC });
    const dynAt = 64 + 2 * 56;
    lostStrtab.writeBigUInt64LE(0x900000n, dynAt + GLIBC.length * 16 + 8);
    expect(await verifyNativeFile(lostStrtab, LIN_X64)).toMatchObject({
      ok: false,
      reason: 'malformed',
    });
    // A DT_NEEDED offset beyond DT_STRSZ.
    const badName = elf({ needed: GLIBC });
    badName.writeBigUInt64LE(0x10000n, dynAt + 8);
    expect(await verifyNativeFile(badName, LIN_X64)).toMatchObject({
      ok: false,
      reason: 'malformed',
    });
    // An interpreter path with no NUL terminator.
    const noNul = elf({ type: 2, interp: '/lib64/ld-linux-x86-64.so.2' });
    const interpEnd = 64 + 3 * 56 + '/lib64/ld-linux-x86-64.so.2'.length;
    noNul[interpEnd] = 0x41;
    expect(await verifyNativeFile(noNul, LIN_X64)).toMatchObject({
      ok: false,
      reason: 'malformed',
    });
  });
});

describe('PE', () => {
  it('accepts PE32+ x64 and arm64 DLLs and executables', async () => {
    expect((await verifyNativeFile(pe({ dll: true }), WIN_X64)).ok).toBe(true);
    expect(
      (await verifyNativeFile(pe(), WIN_X64, { expectKind: 'executable' })).ok,
    ).toBe(true);
    expect(
      (await verifyNativeFile(pe({ machine: 'arm64', dll: true }), WIN_ARM)).ok,
    ).toBe(true);
  });

  it('rejects the wrong machine, including i386 and ARM64EC', async () => {
    for (const machine of ['arm64', 'i386', 'arm64ec', 0x1c0] as const) {
      expect(await verifyNativeFile(pe({ machine }), WIN_X64)).toMatchObject({
        ok: false,
        reason: 'wrong_machine',
      });
    }
    expect(
      await verifyNativeFile(pe({ machine: 'arm64ec' }), WIN_ARM),
    ).toMatchObject({
      ok: false,
      reason: 'wrong_machine',
    });
    expect(
      await verifyNativeFile(pe({ machine: 'x64' }), WIN_ARM),
    ).toMatchObject({
      ok: false,
      reason: 'wrong_machine',
    });
  });

  it('rejects PE32 (even with an x64 machine) and ARM64EC DLLs', async () => {
    expect(
      await verifyNativeFile(pe({ pe32plus: false, machine: 'x64' }), WIN_X64),
    ).toMatchObject({ ok: false, reason: 'unsupported_format', kind: 'pe' });
    expect(
      await verifyNativeFile(
        pe({ pe32plus: false, machine: 'i386', dll: true }),
        WIN_X64,
      ),
    ).toMatchObject({ ok: false, reason: 'unsupported_format' });
  });

  it('enforces the DLL flag per role', async () => {
    expect(
      (await verifyNativeFile(pe(), WIN_X64, { expectKind: 'library' })).reason,
    ).toBe('wrong_kind');
    expect(
      (
        await verifyNativeFile(pe({ dll: true }), WIN_X64, {
          expectKind: 'executable',
        })
      ).reason,
    ).toBe('wrong_kind');
  });

  it('treats a bare MZ stub as not native but fails when a PE name demands it', async () => {
    const stub = Buffer.alloc(128);
    stub.write('MZ');
    stub.writeUInt32LE(0x80, 0x3c);
    expect(await classifyNativeFile(stub)).toBeUndefined();
    const bareMz = Buffer.from('MZ is a fine start for a text file');
    expect(await classifyNativeFile(bareMz)).toBeUndefined();
    expect(
      await verifyNativeFile(stub, WIN_X64, { requireNative: true }),
    ).toMatchObject({ ok: false, reason: 'not_native' });
  });

  it('rejects out-of-bounds e_lfanew and truncated optional headers', async () => {
    expect(
      await classifyNativeFile(pe({ lfanew: 0x10000 + 4, length: 0x20000 })),
    ).toBeUndefined();
    expect(await classifyNativeFile(pe({ lfanew: 0x20 }))).toBeUndefined();
    const lying = pe();
    lying.writeUInt16LE(60000, 0x80 + 20); // SizeOfOptionalHeader past EOF
    expect(await verifyNativeFile(lying, WIN_X64)).toMatchObject({
      ok: false,
      reason: 'truncated',
    });
    const notImage = pe({ characteristics: 0x2000 });
    expect(await verifyNativeFile(notImage, WIN_X64)).toMatchObject({
      ok: false,
      reason: 'malformed',
    });
    const magic = pe();
    magic.writeUInt16LE(0x107, 0x80 + 24);
    expect(await verifyNativeFile(magic, WIN_X64)).toMatchObject({
      ok: false,
      reason: 'malformed',
    });
  });
});

describe('classification by bytes, not extension', () => {
  it('treats a non-native-named file with native bytes as a native', async () => {
    expect(
      await verifyNativeFile(machoThin({ cpu: 'x86_64' }), MAC_ARM),
    ).toMatchObject({
      ok: false,
      reason: 'wrong_machine',
    });
    expect(nativeRoleOfPath('app/node_modules/x/index.js')).toBeUndefined();
  });

  it('classifies text, empty and tiny files as not native', async () => {
    for (const bytes of [
      Buffer.alloc(0),
      Buffer.from('abc'),
      Buffer.from('#!/usr/bin/env node\n'),
      Buffer.from('<html>404 Not Found</html>'),
      Buffer.from('{"name":"x"}'),
    ]) {
      expect(await verifyNativeFile(bytes, MAC_ARM)).toEqual({
        kind: 'not-native',
        ok: true,
      });
      expect(
        await verifyNativeFile(bytes, MAC_ARM, { requireNative: true }),
      ).toMatchObject({ ok: false, reason: 'not_native' });
    }
  });

  it('names the roles of native file names', () => {
    for (const name of [
      'a.node',
      'dir/b.NODE',
      'libvips.dylib',
      'libc.so',
      'libc.so.6',
      'libz.so.1.2.13',
      'x.dll',
      'x.DLL',
    ]) {
      expect(nativeRoleOfPath(name)).toBe('library');
    }
    expect(nativeRoleOfPath('bin/tool.exe')).toBe('executable');
    for (const name of [
      'a.so.txt',
      'libso',
      'a.nodejs',
      'node',
      'x.dll.map',
      'so',
    ]) {
      expect(nativeRoleOfPath(name)).toBeUndefined();
    }
  });
});

describe('truncated input never throws a raw error', () => {
  const samples: Buffer[] = [
    machoThin({ cpu: 'arm64' }),
    machoFat([{ cpu: 'x86_64' }, { cpu: 'arm64' }]),
    machoFat([{ cpu: 'x86_64' }, { cpu: 'arm64' }], true),
    elf({ needed: GLIBC, interp: '/lib64/ld-linux-x86-64.so.2' }),
    pe({ dll: true }),
  ];

  it('returns a fixed reason for every prefix of every sample', async () => {
    for (const sample of samples) {
      for (let length = 0; length < sample.length; length++) {
        const verdict = await verifyNativeFile(
          sample.subarray(0, length),
          MAC_ARM,
        );
        if (!verdict.ok) {
          expect([
            'truncated',
            'malformed',
            'unsupported_format',
            'wrong_format',
            'wrong_machine',
            'wrong_libc',
            'wrong_kind',
          ]).toContain(verdict.reason);
        }
      }
    }
  });

  it('classifyNativeFile only rejects with NativeVerificationError', async () => {
    for (const sample of samples) {
      for (let length = 0; length < sample.length; length++) {
        try {
          await classifyNativeFile(sample.subarray(0, length));
        } catch (error) {
          expect(error).toBeInstanceOf(NativeVerificationError);
          expect(['truncated', 'malformed', 'unsupported_format']).toContain(
            (error as NativeVerificationError).code,
          );
        }
      }
    }
  });
});
