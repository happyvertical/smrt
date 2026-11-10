import { describe, expect, it } from 'vitest';
import {
  appendSegments,
  formatAbsolutePath,
  isInside,
  parentOf,
  parseAbsolutePath,
  samePath,
} from './abs-path.js';

const posix = (value: unknown) => parseAbsolutePath(value, 'posix');
const win = (value: unknown) => parseAbsolutePath(value, 'win32');

describe('parseAbsolutePath (posix)', () => {
  it.each([
    '/',
    '/usr',
    '/usr/bin/node',
    '/Applications/My App.app/Contents/MacOS',
    '/home/u/.local/share/com.example.app',
    '/a/b.c/..d/e..',
  ])('accepts %j and round-trips', (value) => {
    const parsed = posix(value);
    expect(parsed).not.toBeNull();
    expect(formatAbsolutePath(parsed as never)).toBe(value);
  });

  it.each([
    '',
    'relative/path',
    './a',
    '//a',
    '/a//b',
    '/a/',
    '/a/./b',
    '/a/../b',
    '/..',
    '/a/..',
    '/a\\b',
    'C:\\a',
    '\\\\server\\share',
    '/a\0b',
    '/\ud800',
    42,
    null,
    undefined,
  ])('rejects %j', (value) => {
    expect(posix(value)).toBeNull();
  });
});

describe('parseAbsolutePath (win32)', () => {
  it.each([
    'C:\\',
    'c:\\Program Files\\Product',
    'D:\\Apps\\a.b\\c',
    'C:\\Users\\u\\AppData\\Local\\Programs\\Product',
  ])('accepts %j and round-trips', (value) => {
    const parsed = win(value);
    expect(parsed).not.toBeNull();
    expect(formatAbsolutePath(parsed as never)).toBe(value);
  });

  it.each([
    '',
    'C:',
    'C:foo',
    'C:foo\\bar',
    '\\\\server\\share\\x',
    '\\\\?\\C:\\x',
    '\\\\.\\C:\\x',
    '\\\\.\\pipe\\x',
    '\\rooted',
    'C:/Program Files',
    'C:\\Program Files/x',
    'C:\\a\\\\b',
    'C:\\a\\',
    'C:\\a\\.\\b',
    'C:\\a\\..\\b',
    'C:\\a\\CON',
    'C:\\a\\nul.txt',
    'C:\\a\\COM1',
    'C:\\a\\x:stream',
    'C:\\a\\x?',
    'C:\\a\\x*',
    'C:\\a\\x.',
    'C:\\a\\x ',
    'C:\\a\0',
    '/usr/bin',
    'relative\\path',
    7,
  ])('rejects %j', (value) => {
    expect(win(value)).toBeNull();
  });
});

describe('containment', () => {
  it('compares whole segments, never prefixes', () => {
    const root = posix('/opt/app') as never;
    expect(isInside(root, posix('/opt/app/bin') as never)).toBe(true);
    expect(isInside(root, posix('/opt/app-evil/bin') as never)).toBe(false);
    expect(isInside(root, posix('/opt/app') as never)).toBe(false);
    expect(isInside(root, posix('/opt/app') as never, true)).toBe(true);
    expect(isInside(root, posix('/opt') as never, true)).toBe(false);
    expect(isInside(posix('/') as never, posix('/x') as never)).toBe(true);
  });

  it('is case-sensitive on posix and ASCII-insensitive on win32', () => {
    expect(isInside(posix('/Opt') as never, posix('/opt/x') as never)).toBe(
      false,
    );
    const root = win('C:\\Program Files\\App') as never;
    expect(isInside(root, win('c:\\PROGRAM files\\app\\Bin') as never)).toBe(
      true,
    );
    expect(isInside(root, win('D:\\Program Files\\App\\Bin') as never)).toBe(
      false,
    );
  });

  it('never relates different flavors', () => {
    expect(isInside(posix('/') as never, win('C:\\x') as never)).toBe(false);
  });

  it('exposes parent, append and equality helpers', () => {
    const a = posix('/a/b') as never;
    expect(formatAbsolutePath(parentOf(a) as never)).toBe('/a');
    expect(parentOf(posix('/') as never)).toBeNull();
    expect(formatAbsolutePath(appendSegments(a, ['c', 'd']))).toBe('/a/b/c/d');
    expect(samePath(a, posix('/a/b') as never)).toBe(true);
    expect(samePath(a, posix('/a') as never)).toBe(false);
  });
});
