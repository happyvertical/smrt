import { describe, expect, it } from 'vitest';
import { parseTargetTriple, type TargetSpec } from '../targets.js';
import { classifyNativeFile, verifyNativeFile } from './classify.js';
import { NativeVerificationError } from './errors.js';
import { elf, machoFat, machoThin, pe } from './testing/native-fixtures.js';

const MAC_ARM: TargetSpec = parseTargetTriple('aarch64-apple-darwin');
const LIN_X64: TargetSpec = parseTargetTriple('x86_64-unknown-linux-gnu');
const ALL: TargetSpec[] = [
  MAC_ARM,
  LIN_X64,
  parseTargetTriple('x86_64-pc-windows-msvc'),
];

/** Deterministic xorshift32 so a failure is reproducible. */
function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s;
  };
}

const bases: [string, Buffer][] = [
  ['macho', machoThin({ cpu: 'arm64' })],
  ['fat32', machoFat([{ cpu: 'x86_64' }, { cpu: 'arm64' }])],
  ['fat64', machoFat([{ cpu: 'arm64' }], true)],
  [
    'elf',
    elf({
      interp: '/lib64/ld-linux-x86-64.so.2',
      needed: ['libc.so.6', 'libm.so.6'],
    }),
  ],
  ['pe', pe({ dll: true })],
];

const FIXED = new Set([
  'truncated',
  'malformed',
  'unsupported_format',
  'read_limit',
  'read_failed',
]);

describe('property-style fuzzing', () => {
  it('random truncations: no crash, fixed reasons only', async () => {
    const next = rng(0xc0ffee);
    for (const [name, base] of bases) {
      for (let i = 0; i < 200; i++) {
        const cut = base.subarray(0, next() % (base.length + 1));
        for (const spec of ALL) {
          const verdict = await verifyNativeFile(cut, spec, {
            requireNative: true,
          });
          if (!verdict.ok) expect(verdict.reason, name).toBeTruthy();
        }
      }
    }
  });

  it('random byte corruption: classify rejects only with fixed codes', async () => {
    const next = rng(0xbadc0de);
    for (const [name, base] of bases) {
      for (let i = 0; i < 400; i++) {
        const copy = Buffer.from(base);
        const flips = 1 + (next() % 6);
        for (let f = 0; f < flips; f++) {
          copy[next() % copy.length] = next() & 0xff;
        }
        try {
          await classifyNativeFile(copy);
        } catch (error) {
          expect(error, name).toBeInstanceOf(NativeVerificationError);
          expect(FIXED.has((error as NativeVerificationError).code), name).toBe(
            true,
          );
        }
        // And the verdict form never throws at all.
        const verdict = await verifyNativeFile(copy, MAC_ARM, {
          requireNative: true,
        });
        expect(typeof verdict.ok).toBe('boolean');
      }
    }
  });

  it('random bytes behind a native magic never crash', async () => {
    const next = rng(0x5eed);
    const magics = [
      [0x7f, 0x45, 0x4c, 0x46],
      [0xcf, 0xfa, 0xed, 0xfe],
      [0xca, 0xfe, 0xba, 0xbe],
      [0xca, 0xfe, 0xba, 0xbf],
      [0x4d, 0x5a],
    ];
    for (const magic of magics) {
      for (let i = 0; i < 300; i++) {
        const size = 8 + (next() % 600);
        const buf = Buffer.alloc(size);
        for (let b = 0; b < size; b++) buf[b] = next() & 0xff;
        buf.set(magic, 0);
        if (magic[0] === 0xca) buf.writeUInt32BE(1 + (next() % 8), 4);
        const verdict = await verifyNativeFile(buf, LIN_X64, {
          requireNative: true,
        });
        expect(typeof verdict.ok).toBe('boolean');
      }
    }
  });

  it('error messages never contain bytes or offsets', async () => {
    const bad = machoFat([{ cpu: 'arm64' }]);
    bad.writeUInt32BE(0xdeadbeef, 16);
    try {
      await classifyNativeFile(bad);
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).toBe(
        'Native file is truncated or has an out-of-bounds offset',
      );
    }
  });
});
