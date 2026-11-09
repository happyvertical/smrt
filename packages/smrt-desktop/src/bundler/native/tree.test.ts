import { describe, expect, it } from 'vitest';
import { TARGETS, type TargetSpec } from '../targets.js';
import {
  assertTreeNatives,
  type NativeTreeEntry,
  type NativeTreeWalker,
  verifyTreeNatives,
} from './classify.js';
import { NativeVerificationError } from './errors.js';
import { bufferReader } from './reader.js';
import { elf, machoFat, machoThin, pe } from './testing/native-fixtures.js';

const MAC_ARM = TARGETS[0] as TargetSpec;
const LIN_X64 = TARGETS[2] as TargetSpec;
const WIN_X64 = TARGETS[4] as TargetSpec;

interface Spec {
  type?: 'file' | 'symlink' | 'other';
  nlink?: number;
  data?: Buffer;
  /** Report this size instead of the data length (a swapped file). */
  size?: number;
  openFails?: boolean;
}

/** An in-memory walker over `{ path: Spec | Buffer }`, with a delete log. */
function walker(files: Record<string, Spec | Buffer>) {
  const removed: string[] = [];
  const closed: string[] = [];
  const live = new Map(Object.entries(files));
  const api: NativeTreeWalker = {
    *entries(): Iterable<NativeTreeEntry> {
      for (const [path, raw] of live) {
        const spec: Spec = Buffer.isBuffer(raw) ? { data: raw } : raw;
        const data = spec.data ?? Buffer.alloc(0);
        yield {
          path,
          type: spec.type ?? 'file',
          size: spec.size ?? data.length,
          nlink: spec.nlink ?? 1,
          async open() {
            if (spec.openFails) throw new Error('/secret/path EACCES');
            const reader = bufferReader(data);
            return { ...reader, close: async () => void closed.push(path) };
          },
        };
      }
    },
    async remove(path) {
      removed.push(path);
      live.delete(path);
    },
  };
  return { api, removed, closed };
}

const libMac = machoThin({ cpu: 'arm64' });

describe('verifyTreeNatives', () => {
  it('accepts a clean tree and records every native, sorted', async () => {
    const { api, closed } = walker({
      'resources/z/b.node': libMac,
      'resources/a/a.node': machoFat([{ cpu: 'arm64' }, { cpu: 'x86_64' }]),
      'resources/app/build/index.js': Buffer.from('console.log(1)'),
      'resources/app/empty.txt': Buffer.alloc(0),
      'binaries/node': machoThin({ cpu: 'arm64', filetype: 2 }),
    });
    const result = await verifyTreeNatives(api, MAC_ARM);
    expect(result.ok).toBe(true);
    expect(result.filesChecked).toBe(5);
    expect(result.natives.map((n) => [n.path, n.format, n.kind])).toEqual([
      ['binaries/node', 'macho', 'executable'],
      ['resources/a/a.node', 'macho-fat', 'library'],
      ['resources/z/b.node', 'macho', 'library'],
    ]);
    expect(closed).toHaveLength(4); // every opened file is closed
    expect(() => assertTreeNatives(result)).not.toThrow();
  });

  it('fails a wrong-arch native even when it is not named like one', async () => {
    const { api } = walker({
      'a/hidden-tool': machoThin({ cpu: 'x86_64', filetype: 2 }),
      'a/logo.png': Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      ]),
    });
    const result = await verifyTreeNatives(api, MAC_ARM);
    expect(result.failures).toEqual([
      { path: 'a/hidden-tool', reason: 'wrong_machine' },
    ]);
    expect(() => assertTreeNatives(result)).toThrowError(
      'Bundle contains native files that do not match the target',
    );
  });

  it('rejects a .node file that is not a native binary', async () => {
    const { api } = walker({
      'a/truncated.node': Buffer.from('<!doctype html><title>404</title>'),
      'a/empty.node': Buffer.alloc(0),
      'a/lib.so.6': Buffer.from('not elf at all'),
      'a/x.dll': Buffer.from('MZ'),
    });
    const result = await verifyTreeNatives(api, LIN_X64);
    expect(result.failures.map((f) => f.reason)).toEqual([
      'not_native',
      'not_native',
      'not_native',
      'not_native',
    ]);
  });

  it('enforces the extension role: a DLL name needs a DLL, an exe name an exe', async () => {
    const { api } = walker({
      'a/tool.dll': pe(),
      'a/tool.exe': pe({ dll: true }),
      'b/ok.dll': pe({ dll: true }),
      'b/ok.exe': pe(),
    });
    const result = await verifyTreeNatives(api, WIN_X64);
    expect(result.failures).toEqual([
      { path: 'a/tool.dll', reason: 'wrong_kind' },
      { path: 'a/tool.exe', reason: 'wrong_kind' },
    ]);
    expect(result.natives.map((n) => n.path)).toEqual(['b/ok.dll', 'b/ok.exe']);
  });

  it('fails symlinks, special files and hardlinked natives', async () => {
    const { api } = walker({
      'a/link.node': { type: 'symlink', size: 5 },
      'a/plain-link': { type: 'symlink', size: 5 },
      'a/fifo': { type: 'other', size: 0 },
      'a/shared.node': { data: libMac, nlink: 2 },
      'a/shared-js.js': { data: Buffer.from('x'), nlink: 3 },
    });
    const result = await verifyTreeNatives(api, MAC_ARM);
    expect(result.failures).toEqual([
      { path: 'a/fifo', reason: 'special_file' },
      { path: 'a/link.node', reason: 'symlink' },
      { path: 'a/plain-link', reason: 'symlink' },
      { path: 'a/shared.node', reason: 'hardlinked' },
    ]);
    expect(result.natives).toEqual([]);
  });

  it('fails a file whose size changed between listing and open', async () => {
    const { api } = walker({ 'a/x.node': { data: libMac, size: 10 } });
    expect((await verifyTreeNatives(api, MAC_ARM)).failures).toEqual([
      { path: 'a/x.node', reason: 'read_failed' },
    ]);
  });

  it('turns an open error into read_failed without leaking its message', async () => {
    const { api } = walker({ 'a/x.node': { data: libMac, openFails: true } });
    const result = await verifyTreeNatives(api, MAC_ARM);
    expect(result.failures).toEqual([
      { path: 'a/x.node', reason: 'read_failed' },
    ]);
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('rejects entries with unsafe paths without echoing them', async () => {
    const { api } = walker({
      '../escape.node': libMac,
      '/abs.node': libMac,
      'a//b.node': libMac,
      'a\\b.node': libMac,
      'a/./b.node': libMac,
      'nul\0.node': libMac,
    });
    const result = await verifyTreeNatives(api, MAC_ARM);
    expect(result.failures).toHaveLength(6);
    expect(result.failures.every((f) => f.path === '<invalid>')).toBe(true);
    expect(result.failures.every((f) => f.reason === 'invalid_path')).toBe(
      true,
    );
  });

  it('accepts async iterables from the walker', async () => {
    const entries: NativeTreeEntry[] = [
      {
        path: 'a/x.node',
        type: 'file',
        size: libMac.length,
        nlink: 1,
        open: async () => ({ ...bufferReader(libMac), close: async () => {} }),
      },
    ];
    const result = await verifyTreeNatives(
      {
        async *entries() {
          yield* entries;
        },
      },
      'aarch64-apple-darwin',
    );
    expect(result.ok).toBe(true);
  });

  it('rejects a musl addon on a gnu target and an ELF on macOS', async () => {
    const { api } = walker({
      'a/musl.node': elf({ needed: ['libc.musl-x86_64.so.1'] }),
      'a/glibc.node': elf({ needed: ['libc.so.6'] }),
    });
    expect((await verifyTreeNatives(api, LIN_X64)).failures).toEqual([
      { path: 'a/musl.node', reason: 'wrong_libc' },
    ]);
    const { api: other } = walker({
      'a/glibc.node': elf({ needed: ['libc.so.6'] }),
    });
    expect((await verifyTreeNatives(other, MAC_ARM)).failures).toEqual([
      { path: 'a/glibc.node', reason: 'wrong_format' },
    ]);
  });
});

describe('native exceptions', () => {
  const foreign = machoThin({ cpu: 'x86_64' });

  it('deletes a matching failing file and records it; never ships it', async () => {
    const { api, removed } = walker({
      'app/node_modules/vendor/prebuilds/linux-x64/x.node': foreign,
      'app/node_modules/other/y.node': foreign,
      'app/node_modules/vendor/ok.node': libMac,
    });
    const result = await verifyTreeNatives(api, MAC_ARM, {
      exceptions: [
        {
          pattern: 'app/node_modules/vendor/**/*.node',
          reason: 'all-platform prebuilds',
        },
      ],
    });
    expect(removed).toEqual([
      'app/node_modules/vendor/prebuilds/linux-x64/x.node',
    ]);
    expect(result.removed).toEqual([
      {
        path: 'app/node_modules/vendor/prebuilds/linux-x64/x.node',
        pattern: 'app/node_modules/vendor/**/*.node',
        reason: 'all-platform prebuilds',
        cause: 'wrong_machine',
      },
    ]);
    // The non-matching foreign file still fails; the matching good one stays.
    expect(result.failures).toEqual([
      { path: 'app/node_modules/other/y.node', reason: 'wrong_machine' },
    ]);
    expect(result.natives.map((n) => n.path)).toEqual([
      'app/node_modules/vendor/ok.node',
    ]);
  });

  it('never deletes a file that verified, or an entry that is structurally bad', async () => {
    const { api, removed } = walker({
      'a/ok.node': libMac,
      'a/link.node': { type: 'symlink', size: 1 },
      'a/hard.node': { data: foreign, nlink: 2 },
    });
    const result = await verifyTreeNatives(api, MAC_ARM, {
      exceptions: [{ pattern: 'a/*.node', reason: 'test' }],
    });
    // hard.node fails content (wrong machine) first, so it is removed;
    // the symlink and the good file are untouched.
    expect(removed).toEqual(['a/hard.node']);
    expect(result.failures).toEqual([
      { path: 'a/link.node', reason: 'symlink' },
    ]);
    expect(result.natives.map((n) => n.path)).toEqual(['a/ok.node']);
  });

  it('requires a remove seam and valid patterns', async () => {
    const noRemove: NativeTreeWalker = { entries: () => [] };
    await expect(
      verifyTreeNatives(noRemove, MAC_ARM, {
        exceptions: [{ pattern: 'a/*.node', reason: 'x' }],
      }),
    ).rejects.toThrowError('Native exception pattern is not valid');
    for (const pattern of [
      '',
      '**',
      '*',
      'a/**',
      '../a.node',
      '/a.node',
      'a\\b.node',
      'a/b**.node',
      'a//b.node',
      `${'a/'.repeat(300)}b.node`,
    ]) {
      await expect(
        verifyTreeNatives(walker({}).api, MAC_ARM, {
          exceptions: [{ pattern, reason: 'x' }],
        }),
      ).rejects.toBeInstanceOf(NativeVerificationError);
    }
    await expect(
      verifyTreeNatives(walker({}).api, MAC_ARM, {
        exceptions: [{ pattern: 'a/b.node', reason: '' }],
      }),
    ).rejects.toThrowError('Native exception pattern is not valid');
  });
});
