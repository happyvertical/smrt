import { describe, expect, it } from 'vitest';
import {
  isBundleId,
  isChannel,
  isDisplayText,
  isEnvPrefix,
  isIsoUtcTimestamp,
  isLoopbackOrigin,
  isLoopbackRoute,
  isPortablePath,
  isSemver,
  isSlug,
  isTargetTriple,
  isUuidV4,
  parseLoopbackOrigin,
} from './grammar.js';

const cases: [string, (value: unknown) => boolean, unknown[], unknown[]][] = [
  [
    'slug',
    isSlug,
    ['notes', 'smrt-notes', 'a1-b2-c3', 'a'.repeat(64)],
    ['', 'Notes', '-a', 'a-', 'a--b', 'a_b', 'a.b', 'a'.repeat(65), 1, null],
  ],
  [
    'bundleId',
    isBundleId,
    ['com.example.notes', 'a.b', 'com.my-co.app-1', 'X.Y.Z'],
    [
      '',
      'single',
      '.a.b',
      'a..b',
      'a.b.',
      'a.b c',
      'a/b.c',
      'a.b_c',
      'com.example.n\u00f6tes',
      'aux.example.app',
      'NUL.example',
      `${'a.b.'.repeat(80)}c`,
      42,
    ],
  ],
  [
    'semver',
    isSemver,
    [
      '0.0.0',
      '1.2.3',
      '1.0.0-rc.1',
      '1.0.0-0.3.7',
      '1.0.0+build.5',
      '1.0.0-a+b',
    ],
    [
      '',
      '1',
      '1.2',
      '01.2.3',
      '1.2.3.4',
      'v1.2.3',
      '1.2.3-',
      '1.2.3-01',
      '1.2.3+',
      null,
    ],
  ],
  [
    'targetTriple',
    isTargetTriple,
    [
      'aarch64-apple-darwin',
      'x86_64-pc-windows-msvc',
      'x86_64-unknown-linux-gnu',
      'armv7-unknown-linux-gnueabihf',
    ],
    [
      '',
      'darwin',
      'a-b',
      'A-b-c',
      'a-b-c-d-e',
      'x86_64 pc windows',
      'a-b-../c',
    ],
  ],
  [
    'channel',
    isChannel,
    ['stable', 'beta', 'rc-1', 'a'],
    ['', '1beta', 'Stable', '-x', 'a'.repeat(33), 'a_b'],
  ],
  [
    'envPrefix',
    isEnvPrefix,
    ['SMRT', 'SMRT_NOTES', 'A1'],
    ['', 'smrt', '1A', '_A', 'A-B', 'A'.repeat(33)],
  ],
  [
    'uuidV4',
    isUuidV4,
    ['3f1c9c2e-5b7a-4d3e-9a1b-0c2d3e4f5a6b'],
    [
      '',
      '3F1C9C2E-5B7A-4D3E-9A1B-0C2D3E4F5A6B',
      '3f1c9c2e-5b7a-1d3e-9a1b-0c2d3e4f5a6b',
      '3f1c9c2e-5b7a-4d3e-ca1b-0c2d3e4f5a6b',
      '3f1c9c2e5b7a4d3e9a1b0c2d3e4f5a6b',
    ],
  ],
  [
    'loopbackRoute',
    isLoopbackRoute,
    ['/', '/api/mcp', '/api/_runtime/health', '/a/b/', '/~v1/x.y'],
    [
      '',
      'api',
      '//host',
      '/a//b',
      '/a/./b',
      '/a/../b',
      '/a?x=1',
      '/a#f',
      '/a%2e',
      '/a\\b',
      'http://x/',
    ],
  ],
  [
    'portablePath',
    isPortablePath,
    ['a', 'a/b.js', 'bridge/index.mjs'],
    [
      '',
      '/a',
      'a/',
      'a//b',
      '../a',
      'a/../b',
      'a\\b',
      'C:/a',
      'con/x',
      'a/nul.txt',
      '.hidden',
    ],
  ],
  [
    'displayText',
    (value) => isDisplayText(value),
    ['Notes', 'My Notes 2', 'Caf\u00e9 \ud83e\udeb4', 'a'.repeat(128)],
    [
      '',
      ' Notes',
      'Notes ',
      'a\nb',
      'a\u0000b',
      'a\u202eb',
      'a\u2028b',
      'a'.repeat(129),
      'x\ud800',
      7,
    ],
  ],
  [
    'isoUtc',
    isIsoUtcTimestamp,
    [
      '2026-01-02T03:04:05Z',
      '2026-01-02T03:04:05.123Z',
      '2024-02-29T00:00:00Z',
    ],
    [
      '',
      '2026-01-02',
      '2026-01-02T03:04:05',
      '2026-01-02T03:04:05+00:00',
      '2026-02-30T00:00:00Z',
      '2026-13-01T00:00:00Z',
      '2026-01-02T25:00:00Z',
      5,
    ],
  ],
];

describe.each(cases)('%s grammar', (_name, predicate, valid, invalid) => {
  it.each(valid)('accepts %j', (value) => {
    expect(predicate(value)).toBe(true);
  });
  it.each(invalid)('rejects %j', (value) => {
    expect(predicate(value)).toBe(false);
  });
});

describe('loopback origin', () => {
  it.each([
    ['http://127.0.0.1:1', 1],
    ['http://127.0.0.1:8080', 8080],
    ['http://127.0.0.1:65535', 65535],
  ])('accepts %s', (origin, port) => {
    expect(parseLoopbackOrigin(origin)).toBe(port);
    expect(isLoopbackOrigin(origin)).toBe(true);
  });

  it.each([
    'http://localhost:8080',
    'http://[::1]:8080',
    'http://127.0.0.2:8080',
    'https://127.0.0.1:8080',
    'http://127.0.0.1',
    'http://127.0.0.1:',
    'http://127.0.0.1:0',
    'http://127.0.0.1:00080',
    'http://127.0.0.1:65536',
    'http://127.0.0.1:99999',
    'http://127.0.0.1:123456',
    'http://127.0.0.1:8080/',
    'http://127.0.0.1:8080/x',
    'http://127.0.0.1:8080?x=1',
    'http://127.0.0.1:8080#f',
    'http://user@127.0.0.1:8080',
    'http://127.0.0.1:8080 ',
    ' http://127.0.0.1:8080',
    'HTTP://127.0.0.1:8080',
    'http://0x7f.0.0.1:8080',
    '',
    8080,
    null,
  ])('rejects %j', (origin) => {
    expect(parseLoopbackOrigin(origin)).toBeNull();
    expect(isLoopbackOrigin(origin)).toBe(false);
  });
});
