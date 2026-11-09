import { describe, expect, it } from 'vitest';
import { NativeVerificationError } from './native/errors.js';
import {
  externalBinName,
  externalBinPath,
  hostTargetTriple,
  isSupportedTarget,
  nodeDistBinaryMember,
  nodeDistFile,
  nodeDistLicenseMember,
  parseTargetTriple,
  SUPPORTED_TARGET_TRIPLES,
  TARGETS,
} from './targets.js';

describe('target table', () => {
  it('lists exactly the six v1 triples', () => {
    expect([...SUPPORTED_TARGET_TRIPLES]).toEqual([
      'aarch64-apple-darwin',
      'x86_64-apple-darwin',
      'x86_64-unknown-linux-gnu',
      'aarch64-unknown-linux-gnu',
      'x86_64-pc-windows-msvc',
      'aarch64-pc-windows-msvc',
    ]);
    expect(TARGETS.map((t) => t.triple)).toEqual([...SUPPORTED_TARGET_TRIPLES]);
  });

  it('maps every triple to the documented node, pnpm and native values', () => {
    const rows = TARGETS.map((t) => [
      t.triple,
      t.nodePlatform,
      t.nodeArch,
      t.pnpm.os,
      t.pnpm.cpu,
      t.pnpm.libc ?? null,
      t.native.format,
      t.native.machine,
      t.native.libc ?? null,
      t.exeSuffix,
    ]);
    expect(rows).toEqual([
      [
        'aarch64-apple-darwin',
        'darwin',
        'arm64',
        'darwin',
        'arm64',
        null,
        'macho',
        'arm64',
        null,
        '',
      ],
      [
        'x86_64-apple-darwin',
        'darwin',
        'x64',
        'darwin',
        'x64',
        null,
        'macho',
        'x86_64',
        null,
        '',
      ],
      [
        'x86_64-unknown-linux-gnu',
        'linux',
        'x64',
        'linux',
        'x64',
        'glibc',
        'elf',
        'x86_64',
        'glibc',
        '',
      ],
      [
        'aarch64-unknown-linux-gnu',
        'linux',
        'arm64',
        'linux',
        'arm64',
        'glibc',
        'elf',
        'arm64',
        'glibc',
        '',
      ],
      [
        'x86_64-pc-windows-msvc',
        'win32',
        'x64',
        'win32',
        'x64',
        null,
        'pe',
        'x86_64',
        null,
        '.exe',
      ],
      [
        'aarch64-pc-windows-msvc',
        'win32',
        'arm64',
        'win32',
        'arm64',
        null,
        'pe',
        'arm64',
        null,
        '.exe',
      ],
    ]);
  });

  it('is deeply frozen', () => {
    const spec = parseTargetTriple('aarch64-apple-darwin');
    expect(Object.isFrozen(TARGETS)).toBe(true);
    expect(Object.isFrozen(spec)).toBe(true);
    expect(Object.isFrozen(spec.pnpm)).toBe(true);
    expect(Object.isFrozen(spec.nodeDist)).toBe(true);
    expect(Object.isFrozen(spec.native)).toBe(true);
  });

  it('accepts only the supported triples', () => {
    for (const triple of SUPPORTED_TARGET_TRIPLES) {
      expect(isSupportedTarget(triple)).toBe(true);
    }
    for (const bad of [
      'universal-apple-darwin',
      'x86_64-unknown-linux-musl',
      'aarch64-unknown-linux-musl',
      'i686-pc-windows-msvc',
      'x86_64-pc-windows-gnu',
      'x86_64-apple-ios',
      'riscv64gc-unknown-linux-gnu',
      '',
      ' x86_64-apple-darwin',
      'X86_64-APPLE-DARWIN',
      '__proto__',
      'constructor',
      'toString',
      'hasOwnProperty',
      null,
      undefined,
      42,
      {},
    ]) {
      expect(isSupportedTarget(bad)).toBe(false);
      expect(() => parseTargetTriple(bad)).toThrowError(
        new NativeVerificationError('unsupported_target').message,
      );
    }
  });

  it('maps host platform and arch pairs', () => {
    expect(hostTargetTriple('darwin', 'arm64')).toBe('aarch64-apple-darwin');
    expect(hostTargetTriple('darwin', 'x64')).toBe('x86_64-apple-darwin');
    expect(hostTargetTriple('linux', 'x64')).toBe('x86_64-unknown-linux-gnu');
    expect(hostTargetTriple('win32', 'arm64')).toBe('aarch64-pc-windows-msvc');
    expect(hostTargetTriple('linux', 'ia32')).toBeUndefined();
    expect(hostTargetTriple('freebsd', 'x64')).toBeUndefined();
  });
});

describe('node distribution names', () => {
  it('builds the SHASUMS file names and archive members', () => {
    const mac = parseTargetTriple('aarch64-apple-darwin');
    expect(nodeDistFile(mac, '26.8.1')).toBe(
      'node-v26.8.1-darwin-arm64.tar.gz',
    );
    expect(nodeDistBinaryMember(mac, '26.8.1')).toBe(
      'node-v26.8.1-darwin-arm64/bin/node',
    );
    expect(nodeDistLicenseMember(mac, '26.8.1')).toBe(
      'node-v26.8.1-darwin-arm64/LICENSE',
    );
    const linux = parseTargetTriple('x86_64-unknown-linux-gnu');
    expect(nodeDistFile(linux, '26.8.1')).toBe('node-v26.8.1-linux-x64.tar.gz');
    const win = parseTargetTriple('x86_64-pc-windows-msvc');
    expect(nodeDistFile(win, '26.8.1')).toBe('win-x64/node.exe');
    expect(nodeDistBinaryMember(win, '26.8.1')).toBeUndefined();
    expect(nodeDistLicenseMember(win, '26.8.1')).toBeUndefined();
    expect(
      nodeDistFile(parseTargetTriple('aarch64-pc-windows-msvc'), '26.8.1'),
    ).toBe('win-arm64/node.exe');
  });

  it('rejects versions that are not plain MAJOR.MINOR.PATCH', () => {
    const spec = parseTargetTriple('aarch64-apple-darwin');
    for (const bad of [
      '',
      '26',
      '26.8',
      'v26.8.1',
      '26.8.1-rc.1',
      '01.2.3',
      '26.8.1/../../x',
      '26.8.1\n',
      '26.8.1 ',
      '1.2.3.4',
      undefined,
      26,
    ]) {
      expect(() => nodeDistFile(spec, bad as string)).toThrowError(
        'Node version must be MAJOR.MINOR.PATCH',
      );
    }
  });
});

describe('Tauri externalBin names', () => {
  it('appends the triple and the Windows suffix', () => {
    expect(externalBinName('smrt-start-node', 'aarch64-apple-darwin')).toBe(
      'smrt-start-node-aarch64-apple-darwin',
    );
    expect(externalBinName('smrt-start-node', 'x86_64-pc-windows-msvc')).toBe(
      'smrt-start-node-x86_64-pc-windows-msvc.exe',
    );
    expect(externalBinPath('smrt-start-node', 'x86_64-unknown-linux-gnu')).toBe(
      'binaries/smrt-start-node-x86_64-unknown-linux-gnu',
    );
  });

  it('rejects names that are not slugs', () => {
    for (const bad of [
      '',
      'Node',
      '../node',
      'a/b',
      'a\\b',
      'node.exe',
      'a b',
      'a--b',
      '-a',
      'a'.repeat(65),
      'node\0',
    ]) {
      expect(() => externalBinName(bad, 'aarch64-apple-darwin')).toThrowError(
        'Sidecar product name is not a valid portable name',
      );
    }
  });

  it('rejects an unsupported triple at runtime', () => {
    expect(() =>
      externalBinName('smrt-start-node', 'universal-apple-darwin' as never),
    ).toThrowError('Bundle target is not supported');
  });
});
