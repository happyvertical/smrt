import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DesktopContractError } from '../errors.js';
import {
  parseInstallationRecord,
  serializeInstallationRecord,
} from './installation-record.js';

const example = readFileSync(
  new URL('../../examples/installation.json', import.meta.url),
  'utf8',
);
const base = JSON.parse(example) as Record<string, unknown>;
const TOKEN = 'smrt_mcp_LEAKCANARY0123456789';

const linux = {
  platform: 'linux',
  installRoot: '/usr',
  executableDir: '/usr/bin',
  resourceDir: '/usr/lib/smrt-notes',
  shellExecutable: '/usr/bin/smrt-notes',
};
const windows = {
  platform: 'win32',
  installRoot: 'C:\\Users\\u\\AppData\\Local\\Programs\\SMRT Notes',
  executableDir: 'C:\\Users\\u\\AppData\\Local\\Programs\\SMRT Notes',
  resourceDir: 'C:\\Users\\u\\AppData\\Local\\Programs\\SMRT Notes',
  shellExecutable:
    'C:\\Users\\u\\AppData\\Local\\Programs\\SMRT Notes\\smrt-notes.exe',
};

function parse(overrides: Record<string, unknown>) {
  return parseInstallationRecord(JSON.stringify({ ...base, ...overrides }));
}
function failure(fn: () => unknown): DesktopContractError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(DesktopContractError);
    return error as DesktopContractError;
  }
  throw new Error('expected a DesktopContractError');
}

describe('installation record v1', () => {
  it('accepts the packaged macOS example', () => {
    expect(parseInstallationRecord(example)).toEqual(base);
    expect(Object.isFrozen(parseInstallationRecord(example))).toBe(true);
  });

  it.each([
    ['linux deb layout', { ...linux, target: 'x86_64-unknown-linux-gnu' }],
    [
      'linux user install',
      {
        platform: 'linux',
        target: 'x86_64-unknown-linux-gnu',
        installRoot: '/home/u/Apps/notes',
        executableDir: '/home/u/Apps/notes',
        resourceDir: '/home/u/Apps/notes/resources',
        shellExecutable: '/home/u/Apps/notes/smrt-notes',
      },
    ],
    ['windows layout', { ...windows, target: 'x86_64-pc-windows-msvc' }],
  ])('accepts a %s', (_name, overrides) => {
    expect(parse(overrides)).toEqual({ ...base, ...overrides });
  });

  it('round-trips through the canonical serializer', () => {
    const parsed = parseInstallationRecord(example);
    const text = serializeInstallationRecord(parsed);
    expect(parseInstallationRecord(text)).toEqual(parsed);
    expect(text.endsWith('}\n')).toBe(true);
    expect(Object.keys(JSON.parse(text))).toEqual(Object.keys(base));
  });

  it('refuses to serialize an invalid record', () => {
    const bad = {
      ...parseInstallationRecord(example),
      installRoot: 'relative',
    };
    expect(failure(() => serializeInstallationRecord(bad)).code).toBe(
      'invalid_field',
    );
  });

  it.each([
    ['{ "TOKEN":', 'invalid_json'],
    ['null', 'invalid_document'],
    ['[]', 'invalid_document'],
    ['{}', 'invalid_document'],
  ])('rejects the envelope %j', (json, code) => {
    expect(failure(() => parseInstallationRecord(json)).code).toBe(code);
  });

  it('rejects duplicate keys, unknown fields and unknown versions', () => {
    expect(
      failure(() =>
        parseInstallationRecord(
          example.replace('"version": 1,', '"version": 1, "version": 1,'),
        ),
      ).code,
    ).toBe('duplicate_keys');
    expect(failure(() => parse({ extra: 1 })).code).toBe('invalid_document');
    expect(failure(() => parse({ version: 2 })).code).toBe(
      'unsupported_contract',
    );
    expect(failure(() => parse({ version: undefined })).code).toBe(
      'invalid_document',
    );
    expect(failure(() => parse({ shellExecutable: undefined })).code).toBe(
      'invalid_document',
    );
  });

  it.each([
    ['productId', 'Notes'],
    ['bundleId', 'single'],
    ['productVersion', '1.0'],
    ['target', 'darwin'],
    ['platform', 'freebsd'],
    ['platform', 7],
    ['recordedAt', '2026-11-01'],
    ['recordedAt', '2026-02-30T00:00:00Z'],
    ['recordedAt', '2026-11-01T12:00:00+00:00'],
  ])('rejects an invalid %s: %j', (field, value) => {
    const error = failure(() => parse({ [field]: value }));
    expect(error.code).toBe('invalid_field');
    expect(error.field).toBe(field);
  });

  const badPosix = [
    'Applications/X.app',
    './X.app',
    '/Applications/X.app/',
    '/Applications//X.app',
    '/Applications/./X.app',
    '/Applications/../X.app',
    '/Applications/X.app/Contents/MacOS/../MacOS',
    '\\\\server\\share\\X.app',
    'C:\\X.app',
    '/Applications/X\\.app',
    '/Applications/X\0.app',
    '',
  ];
  it.each(badPosix)('rejects the POSIX path %j', (installRoot) => {
    const error = failure(() => parse({ installRoot }));
    expect(error.code).toBe('invalid_field');
    expect(error.field).toBe('installRoot');
  });

  const badWindows = [
    '\\\\server\\share\\App',
    '\\\\?\\C:\\App',
    '\\\\.\\C:\\App',
    'C:App',
    'C:',
    'C:/App',
    'App\\Product',
    '\\App',
    'C:\\App\\',
    'C:\\App\\..\\Other',
    'C:\\App\\.\\x',
    'C:\\App\\CON',
    'C:\\App\\aux.txt',
    'C:\\App\\x:ads',
    'C:\\App\\x.',
    '/usr/bin',
  ];
  it.each(badWindows)('rejects the Windows path %j', (installRoot) => {
    const error = failure(() =>
      parse({ ...windows, installRoot, target: 'x86_64-pc-windows-msvc' }),
    );
    expect(error.code).toBe('invalid_field');
    expect(error.field).toBe('installRoot');
  });

  it('rejects a Windows-flavored path in a POSIX record and vice versa', () => {
    expect(failure(() => parse({ ...windows, platform: 'linux' })).field).toBe(
      'installRoot',
    );
    expect(failure(() => parse({ ...linux, platform: 'win32' })).field).toBe(
      'installRoot',
    );
  });

  describe('layout', () => {
    it.each([
      [
        'executableDir outside installRoot',
        { executableDir: '/Applications/Other.app/Contents/MacOS' },
      ],
      ['resourceDir outside installRoot', { resourceDir: '/etc' }],
      [
        'prefix sibling of installRoot',
        { installRoot: '/Applications/SMRT Notes.ap' },
      ],
      [
        'shell binary outside executableDir',
        {
          shellExecutable:
            '/Applications/SMRT Notes.app/Contents/Resources/smrt-notes',
        },
      ],
      [
        'shell binary equal to executableDir',
        { shellExecutable: '/Applications/SMRT Notes.app/Contents/MacOS' },
      ],
      [
        'shell binary nested below executableDir',
        {
          shellExecutable:
            '/Applications/SMRT Notes.app/Contents/MacOS/x/smrt-notes',
        },
      ],
      [
        'installRoot not an .app bundle',
        {
          installRoot: '/Applications/Notes',
          executableDir: '/Applications/Notes/Contents/MacOS',
          resourceDir: '/Applications/Notes/Contents/Resources',
          shellExecutable: '/Applications/Notes/Contents/MacOS/smrt-notes',
        },
      ],
      [
        'bare .app name',
        {
          installRoot: '/Applications/.app',
          executableDir: '/Applications/.app/Contents/MacOS',
          resourceDir: '/Applications/.app/Contents/Resources',
          shellExecutable: '/Applications/.app/Contents/MacOS/smrt-notes',
        },
      ],
      [
        'macOS executableDir not Contents/MacOS',
        {
          executableDir: '/Applications/SMRT Notes.app/Contents',
          shellExecutable: '/Applications/SMRT Notes.app/Contents/smrt-notes',
        },
      ],
      [
        'macOS resourceDir not Contents/Resources',
        { resourceDir: '/Applications/SMRT Notes.app/Contents/Frameworks' },
      ],
      [
        'filesystem root as installRoot',
        {
          installRoot: '/',
          executableDir: '/bin',
          resourceDir: '/lib',
          shellExecutable: '/bin/smrt-notes',
        },
      ],
    ])('rejects %s', (_name, overrides) => {
      expect(failure(() => parse(overrides)).code).toBe('untrusted_path');
    });

    it('rejects an escaping executableDir on Linux and Windows too', () => {
      expect(
        failure(() =>
          parse({
            ...linux,
            target: 'x86_64-unknown-linux-gnu',
            executableDir: '/opt/bin',
            shellExecutable: '/opt/bin/smrt-notes',
          }),
        ).code,
      ).toBe('untrusted_path');
      expect(
        failure(() =>
          parse({
            ...windows,
            target: 'x86_64-pc-windows-msvc',
            resourceDir: 'D:\\Other',
          }),
        ).code,
      ).toBe('untrusted_path');
    });

    it('treats Windows paths case-insensitively for containment', () => {
      expect(
        parse({
          ...windows,
          target: 'x86_64-pc-windows-msvc',
          executableDir: windows.executableDir.toUpperCase(),
          shellExecutable: `${windows.executableDir.toUpperCase()}\\smrt-notes.exe`,
        }).platform,
      ).toBe('win32');
    });
  });

  it('never echoes input in errors', () => {
    const inputs = [
      `{"${TOKEN}":1}`,
      JSON.stringify({ ...base, productId: TOKEN }),
      JSON.stringify({ ...base, installRoot: `/${TOKEN}/x` }),
      JSON.stringify({ ...base, installRoot: `/Applications/${TOKEN}.app` }),
      JSON.stringify({ ...base, platform: TOKEN }),
      JSON.stringify({ ...base, recordedAt: TOKEN }),
      JSON.stringify({ ...base, version: TOKEN }),
      `{"${TOKEN}": 1, "${TOKEN}": 2}`,
    ];
    for (const json of inputs) {
      const error = failure(() => parseInstallationRecord(json));
      const text = `${error.message}\n${error.stack}\n${JSON.stringify(error)}\n${error.field ?? ''}`;
      expect(text).not.toContain('LEAKCANARY');
      expect(text).not.toContain('Applications');
    }
  });
});
