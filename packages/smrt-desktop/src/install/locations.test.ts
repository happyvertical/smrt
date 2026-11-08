import { isAbsolute } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DesktopContractError } from '../errors.js';
import {
  DESKTOP_SHELL_DIRNAME,
  resolveAppLocalDataDir,
  resolveDesktopShellDir,
} from './locations.js';

const ID = 'com.happyvertical.smrt-notes';

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(DesktopContractError);
    return (error as DesktopContractError).code;
  }
  return 'none';
}

describe('resolveAppLocalDataDir', () => {
  it('matches Tauri on macOS', () => {
    expect(
      resolveAppLocalDataDir(ID, {
        platform: 'darwin',
        env: {},
        home: '/Users/will',
      }),
    ).toBe(`/Users/will/Library/Application Support/${ID}`);
  });

  it('matches Tauri on Linux, with and without XDG_DATA_HOME', () => {
    const home = '/home/will';
    expect(
      resolveAppLocalDataDir(ID, { platform: 'linux', env: {}, home }),
    ).toBe(`/home/will/.local/share/${ID}`);
    expect(
      resolveAppLocalDataDir(ID, {
        platform: 'linux',
        env: { XDG_DATA_HOME: '/data/xdg' },
        home,
      }),
    ).toBe(`/data/xdg/${ID}`);
  });

  it.each([
    '',
    'relative/dir',
    '~/data',
    './data',
    '/data/../etc',
  ])('ignores an unusable XDG_DATA_HOME %j', (XDG_DATA_HOME) => {
    expect(
      resolveAppLocalDataDir(ID, {
        platform: 'linux',
        env: { XDG_DATA_HOME },
        home: '/home/will',
      }),
    ).toBe(`/home/will/.local/share/${ID}`);
  });

  it('uses LOCALAPPDATA and never the roaming APPDATA on Windows', () => {
    const env = {
      LOCALAPPDATA: 'C:\\Users\\will\\AppData\\Local',
      APPDATA: 'C:\\Users\\will\\AppData\\Roaming',
    };
    const path = resolveAppLocalDataDir(ID, { platform: 'win32', env });
    expect(path).toBe(`C:\\Users\\will\\AppData\\Local\\${ID}`);
    expect(path).not.toContain('Roaming');
  });

  it.each([
    ['missing', {}],
    ['only APPDATA', { APPDATA: 'C:\\Users\\will\\AppData\\Roaming' }],
    ['relative', { LOCALAPPDATA: 'AppData\\Local' }],
    ['UNC', { LOCALAPPDATA: '\\\\server\\share' }],
    ['forward slashes', { LOCALAPPDATA: 'C:/Users/will/AppData/Local' }],
    ['empty', { LOCALAPPDATA: '' }],
  ])('rejects a %s LOCALAPPDATA', (_name, env) => {
    expect(
      code(() => resolveAppLocalDataDir(ID, { platform: 'win32', env })),
    ).toBe('invalid_environment');
  });

  it('tolerates trailing separators in environment values', () => {
    expect(
      resolveAppLocalDataDir(ID, {
        platform: 'darwin',
        env: {},
        home: '/Users/will/',
      }),
    ).toBe(`/Users/will/Library/Application Support/${ID}`);
    expect(
      resolveAppLocalDataDir(ID, {
        platform: 'win32',
        env: { LOCALAPPDATA: 'C:\\Users\\will\\AppData\\Local\\' },
      }),
    ).toBe(`C:\\Users\\will\\AppData\\Local\\${ID}`);
    expect(
      resolveAppLocalDataDir(ID, {
        platform: 'linux',
        env: { XDG_DATA_HOME: '/data/xdg/' },
        home: '/h',
      }),
    ).toBe(`/data/xdg/${ID}`);
  });

  it('falls back to HOME from the environment', () => {
    expect(
      resolveAppLocalDataDir(ID, {
        platform: 'linux',
        env: { HOME: '/home/env' },
      }),
    ).toBe(`/home/env/.local/share/${ID}`);
  });

  it.each([
    '',
    'single',
    'a..b',
    '../a.b',
    'a/b.c',
    'a.b c',
    'aux.example.app',
    'a.b\0',
  ])('rejects the bundleId %j', (bundleId) => {
    for (const platform of ['darwin', 'linux', 'win32'] as const) {
      expect(
        code(() =>
          resolveAppLocalDataDir(bundleId, {
            platform,
            env: { LOCALAPPDATA: 'C:\\L' },
            home: '/home/will',
          }),
        ),
      ).toBe('invalid_field');
    }
  });

  it('rejects unsupported platforms and a relative home', () => {
    expect(
      code(() =>
        resolveAppLocalDataDir(ID, {
          platform: 'freebsd',
          env: {},
          home: '/home/w',
        }),
      ),
    ).toBe('unsupported_platform');
    expect(
      code(() =>
        resolveAppLocalDataDir(ID, {
          platform: 'linux',
          env: {},
          home: 'home/w',
        }),
      ),
    ).toBe('invalid_environment');
  });

  it('resolves an absolute path for the real host by default', () => {
    expect(isAbsolute(resolveAppLocalDataDir(ID, { env: process.env }))).toBe(
      true,
    );
  });
});

describe('resolveDesktopShellDir', () => {
  it('is the private directory inside app_local_data_dir', () => {
    expect(DESKTOP_SHELL_DIRNAME).toBe('.desktop-shell');
    expect(
      resolveDesktopShellDir(ID, {
        platform: 'darwin',
        env: {},
        home: '/Users/will',
      }),
    ).toBe(`/Users/will/Library/Application Support/${ID}/.desktop-shell`);
    expect(
      resolveDesktopShellDir(ID, {
        platform: 'win32',
        env: { LOCALAPPDATA: 'C:\\L' },
      }),
    ).toBe(`C:\\L\\${ID}\\.desktop-shell`);
    expect(
      resolveDesktopShellDir(ID, {
        platform: 'linux',
        env: {},
        home: '/home/w',
      }),
    ).toBe(`/home/w/.local/share/${ID}/.desktop-shell`);
  });

  it('propagates the same errors', () => {
    expect(
      code(() =>
        resolveDesktopShellDir('x', { platform: 'linux', env: {}, home: '/h' }),
      ),
    ).toBe('invalid_field');
  });
});
