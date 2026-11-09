import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ORIGIN_FILE,
  parseLoopbackOrigin,
  publishLocalOrigin,
  readOriginFile,
  removeOriginFile,
  writeOriginFile,
} from './origin-file.js';

const posix = process.platform !== 'win32';
const itPosix = posix ? it : it.skip;
const ORIGIN = 'http://127.0.0.1:43111';

let stateRoot: string;
let file: string;

beforeEach(() => {
  stateRoot = mkdtempSync(join(tmpdir(), 'smrt-origin-file-'));
  file = join(stateRoot, ORIGIN_FILE);
});

afterEach(() => {
  rmSync(stateRoot, { recursive: true, force: true });
});

describe('parseLoopbackOrigin', () => {
  it.each([
    'http://127.0.0.1:1',
    'http://127.0.0.1:65535',
    ORIGIN,
  ])('accepts %s', (origin) => {
    expect(parseLoopbackOrigin(origin)).toBe(origin);
  });

  it.each([
    'http://localhost:43111',
    'http://[::1]:43111',
    'http://127.0.0.2:43111',
    'https://127.0.0.1:43111',
    'http://127.0.0.1',
    'http://127.0.0.1:0',
    'http://127.0.0.1:65536',
    'http://127.0.0.1:043111',
    'http://127.0.0.1:43111/',
    'http://127.0.0.1:43111/x',
    'http://user@127.0.0.1:43111',
    ' http://127.0.0.1:43111',
    '',
    undefined,
    42,
  ])('refuses %s', (origin) => {
    expect(parseLoopbackOrigin(origin)).toBeNull();
  });
});

describe('the origin file', () => {
  it('round-trips a record written by this process', async () => {
    const written = writeOriginFile(stateRoot, ORIGIN);
    expect(written).toMatchObject({
      version: 1,
      origin: ORIGIN,
      pid: process.pid,
    });
    expect(await readOriginFile(stateRoot)).toEqual(written);
    if (posix) expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('writes nothing for an origin that is not exact loopback', () => {
    expect(writeOriginFile(stateRoot, 'http://localhost:43111')).toBeNull();
    expect(writeOriginFile(stateRoot, undefined)).toBeNull();
    expect(existsSync(file)).toBe(false);
  });

  it('reads null for an absent file and never creates the directory', async () => {
    const missing = join(stateRoot, 'not-there');
    expect(await readOriginFile(missing)).toBeNull();
    expect(existsSync(missing)).toBe(false);
  });

  it.each([
    ['malformed JSON', '{'],
    ['an array', '[]'],
    [
      'a non-loopback origin',
      JSON.stringify({
        version: 1,
        origin: 'http://localhost:43111',
        pid: process.pid,
        startedAt: 'now',
      }),
    ],
    [
      'an extra field',
      JSON.stringify({
        version: 1,
        origin: ORIGIN,
        pid: process.pid,
        startedAt: 'now',
        token: 'x',
      }),
    ],
    [
      'another version',
      JSON.stringify({
        version: 2,
        origin: ORIGIN,
        pid: process.pid,
        startedAt: 'now',
      }),
    ],
    [
      'a pid that is not a number',
      JSON.stringify({
        version: 1,
        origin: ORIGIN,
        pid: '1',
        startedAt: 'now',
      }),
    ],
    ['an oversized file', ' '.repeat(2048)],
  ])('reads null for %s', async (_name, contents) => {
    writeFileSync(file, contents, { mode: 0o600 });
    expect(await readOriginFile(stateRoot)).toBeNull();
  });

  it('reads null when the process that wrote it is gone', async () => {
    // Pid space is bounded well below this on every supported platform.
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        origin: ORIGIN,
        pid: 2 ** 31 - 2,
        startedAt: 'then',
      }),
      { mode: 0o600 },
    );
    expect(await readOriginFile(stateRoot)).toBeNull();
  });

  itPosix('reads null for a file other users can read', async () => {
    writeOriginFile(stateRoot, ORIGIN);
    chmodSync(file, 0o644);
    expect(await readOriginFile(stateRoot)).toBeNull();
  });

  itPosix('does not follow a symbolic link', async () => {
    const target = join(stateRoot, 'elsewhere.json');
    writeFileSync(
      target,
      JSON.stringify({
        version: 1,
        origin: ORIGIN,
        pid: process.pid,
        startedAt: 'now',
      }),
      { mode: 0o600 },
    );
    symlinkSync(target, file);
    expect(await readOriginFile(stateRoot)).toBeNull();
  });

  it('removes the record, or only the one a given pid wrote', () => {
    writeOriginFile(stateRoot, ORIGIN);
    removeOriginFile(stateRoot, process.pid + 1);
    expect(existsSync(file)).toBe(true);
    removeOriginFile(stateRoot, process.pid);
    expect(existsSync(file)).toBe(false);
    writeOriginFile(stateRoot, ORIGIN);
    removeOriginFile(stateRoot);
    expect(existsSync(file)).toBe(false);
    removeOriginFile(stateRoot);
  });
});

describe('publishLocalOrigin', () => {
  it('does nothing, and never resolves the state root, without an exact origin', () => {
    let resolved = 0;
    const resolve = () => {
      resolved += 1;
      return stateRoot;
    };
    for (const ORIGIN_ENV of [
      undefined,
      'http://localhost:43111',
      'http://127.0.0.1',
    ]) {
      expect(
        publishLocalOrigin({ ORIGIN: ORIGIN_ENV }, resolve),
      ).toBeUndefined();
    }
    expect(resolved).toBe(0);
    expect(existsSync(file)).toBe(false);
  });

  it('writes the record and removes it on dispose, leaving no handlers behind', () => {
    const before = [
      process.listenerCount('exit'),
      process.listenerCount('SIGTERM'),
      process.listenerCount('SIGINT'),
    ];
    const dispose = publishLocalOrigin({ ORIGIN }, () => stateRoot);
    expect(dispose).toBeTypeOf('function');
    expect(JSON.parse(readFileSync(file, 'utf8')).origin).toBe(ORIGIN);
    expect(process.listenerCount('exit')).toBe(before[0] + 1);
    expect(process.listenerCount('SIGTERM')).toBe(before[1] + 1);
    dispose?.();
    expect(existsSync(file)).toBe(false);
    expect([
      process.listenerCount('exit'),
      process.listenerCount('SIGTERM'),
      process.listenerCount('SIGINT'),
    ]).toEqual(before);
  });

  it('survives an unusable state root', () => {
    const blocked = join(stateRoot, 'file');
    writeFileSync(blocked, '');
    expect(
      publishLocalOrigin({ ORIGIN }, () => join(blocked, 'child')),
    ).toBeUndefined();
    mkdirSync(join(stateRoot, 'ok'));
  });
});
