import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DesktopContractError } from '../errors.js';
import {
  controlSocketDirectory,
  deriveControlEndpoint,
  isControlPipeName,
  isControlSocketPath,
  MAX_UNIX_SOCKET_PATH_BYTES,
  parseControlEndpoint,
} from './endpoint.js';

const HEX32 = '00112233445566778899aabbccddeeff';
const bytes = (hex: string) => Uint8Array.from(Buffer.from(hex, 'hex'));

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(DesktopContractError);
    return (error as DesktopContractError).code;
  }
  return 'ok';
}

describe('control endpoint grammar', () => {
  it('accepts the exact socket and pipe forms', () => {
    expect(isControlSocketPath(`/run/user/1000/c-${HEX32}.sock`)).toBe(true);
    expect(
      isControlPipeName(`\\\\.\\pipe\\smrt-0123456789abcdef-${HEX32}`),
    ).toBe(true);
  });

  it.each([
    ['relative', `c-${HEX32}.sock`],
    ['root level', `/c-${HEX32}.sock`],
    ['wrong leaf', '/run/user/c-abc.sock'],
    ['uppercase hex', `/run/c-${HEX32.toUpperCase()}.sock`],
    ['dot segment', `/run/../c-${HEX32}.sock`],
    ['backslash', `/run\\x/c-${HEX32}.sock`],
    ['nul', `/run/\0/c-${HEX32}.sock`],
    ['too long', `/${'a'.repeat(MAX_UNIX_SOCKET_PATH_BYTES)}/c-${HEX32}.sock`],
  ])('rejects a socket path that is %s', (_name, value) => {
    expect(isControlSocketPath(value)).toBe(false);
  });

  it.each([
    ['foreign prefix', `\\\\.\\pipe\\other-0123456789abcdef-${HEX32}`],
    ['remote pipe', `\\\\server\\pipe\\smrt-0123456789abcdef-${HEX32}`],
    ['short random part', '\\\\.\\pipe\\smrt-0123456789abcdef-00'],
    ['extra segment', `\\\\.\\pipe\\smrt-0123456789abcdef-${HEX32}\\x`],
    ['forward slashes', `//./pipe/smrt-0123456789abcdef-${HEX32}`],
  ])('rejects a pipe name that is %s', (_name, value) => {
    expect(isControlPipeName(value)).toBe(false);
  });

  it('parses and freezes a valid endpoint, closed schema', () => {
    const unix = parseControlEndpoint({
      kind: 'unix',
      path: `/run/c-${HEX32}.sock`,
    });
    expect(Object.isFrozen(unix)).toBe(true);
    expect(
      code(() =>
        parseControlEndpoint({
          kind: 'unix',
          path: unix.kind === 'unix' ? unix.path : '',
          extra: 1,
        }),
      ),
    ).toBe('invalid_endpoint');
    expect(code(() => parseControlEndpoint({ kind: 'tcp', port: 1 }))).toBe(
      'invalid_endpoint',
    );
    expect(code(() => parseControlEndpoint(null))).toBe('invalid_endpoint');
  });
});

describe('deriveControlEndpoint', () => {
  it('uses the injected random bytes verbatim', () => {
    const endpoint = deriveControlEndpoint({
      platform: 'darwin',
      bundleId: 'com.example.app',
      directory: '/var/folders/zz/T/',
      randomBytes: () => bytes(HEX32),
    });
    expect(endpoint).toEqual({
      kind: 'unix',
      path: `/var/folders/zz/T/c-${HEX32}.sock`,
    });
    expect(
      controlSocketDirectory(endpoint.kind === 'unix' ? endpoint.path : ''),
    ).toBe('/var/folders/zz/T');
  });

  it('derives a Windows pipe scoped by the bundle id, with a random tail', () => {
    const scope = createHash('sha256')
      .update('com.example.app')
      .digest('hex')
      .slice(0, 16);
    const endpoint = deriveControlEndpoint({
      platform: 'win32',
      bundleId: 'com.example.app',
      randomBytes: () => bytes(HEX32),
    });
    expect(endpoint).toEqual({
      kind: 'pipe',
      name: `\\\\.\\pipe\\smrt-${scope}-${HEX32}`,
    });
  });

  it('never repeats a name', () => {
    const names = new Set(
      Array.from({ length: 50 }, () =>
        JSON.stringify(
          deriveControlEndpoint({
            platform: 'linux',
            bundleId: 'com.example.app',
            directory: '/run/user/1000',
          }),
        ),
      ),
    );
    expect(names.size).toBe(50);
  });

  it('rejects a relative, missing or over-long directory', () => {
    const base = { platform: 'linux' as const, bundleId: 'com.example.app' };
    expect(
      code(() => deriveControlEndpoint({ ...base, directory: 'run' })),
    ).toBe('invalid_endpoint');
    expect(code(() => deriveControlEndpoint(base))).toBe('invalid_endpoint');
    expect(
      code(() =>
        deriveControlEndpoint({ ...base, directory: `/${'a'.repeat(100)}` }),
      ),
    ).toBe('invalid_endpoint');
  });

  it('rejects a short random source', () => {
    expect(
      code(() =>
        deriveControlEndpoint({
          platform: 'win32',
          bundleId: 'com.example.app',
          randomBytes: () => new Uint8Array(4),
        }),
      ),
    ).toBe('invalid_endpoint');
  });
});
