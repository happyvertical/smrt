import { describe, expect, it } from 'vitest';
import { DesktopContractError } from '../errors.js';
import { SecretString } from '../secret-string.js';
import {
  CANARY_BODY,
  CANARY_TOKEN,
  FUTURE,
  leaks,
  ORIGIN,
  thrown,
} from '../testing/credentials.js';
import {
  containsSecret,
  encodeHandoffFrame,
  HANDOFF_FRAME_MAX_BYTES,
  type HandoffFrame,
  HandoffFrameDecoder,
  parseHandoffFrame,
} from './handoff-frame.js';

const credentialFrame = (
  overrides: Partial<Record<string, unknown>> = {},
): HandoffFrame =>
  ({
    v: 1,
    type: 'credential',
    seq: 0,
    origin: ORIGIN,
    token: new SecretString(CANARY_TOKEN),
    expiresAt: FUTURE,
    ...overrides,
  }) as HandoffFrame;

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(DesktopContractError);
    expect(leaks(error)).toBe(false);
    return (error as DesktopContractError).code;
  }
  return 'none';
}

const wire = (value: unknown) => `${JSON.stringify(value)}\n`;

describe('handoff frame codec', () => {
  it('encodes the initial frame as one NDJSON line and parses it back', () => {
    const line = encodeHandoffFrame(credentialFrame(), 'to-bridge');
    expect(line.endsWith('\n')).toBe(true);
    expect(line.indexOf('\n')).toBe(line.length - 1);
    expect(JSON.parse(line)).toEqual({
      v: 1,
      type: 'credential',
      seq: 0,
      origin: ORIGIN,
      token: CANARY_TOKEN,
      expiresAt: FUTURE,
    });
    expect(Buffer.byteLength(line)).toBeLessThanOrEqual(
      HANDOFF_FRAME_MAX_BYTES,
    );
    const parsed = parseHandoffFrame(line, 'to-bridge');
    expect(parsed.type).toBe('credential');
    if (parsed.type === 'credential') {
      expect(parsed.token).toBeInstanceOf(SecretString);
      expect(parsed.token.reveal()).toBe(CANARY_TOKEN);
      expect(parsed.seq).toBe(0);
    }
  });

  it('encodes a refresh frame after rotation or a port change', () => {
    const line = encodeHandoffFrame(
      credentialFrame({ seq: 3, origin: 'http://127.0.0.1:4700' }),
      'to-bridge',
    );
    const parsed = parseHandoffFrame(line, 'to-bridge');
    expect(parsed).toMatchObject({ seq: 3, origin: 'http://127.0.0.1:4700' });
  });

  it('round-trips unavailable and the bridge refresh request', () => {
    for (const code of [
      'credential_invalid',
      'credential_unavailable',
      'instance_mismatch',
    ] as const) {
      const frame: HandoffFrame = { v: 1, type: 'unavailable', seq: 1, code };
      expect(
        parseHandoffFrame(encodeHandoffFrame(frame, 'to-bridge'), 'to-bridge'),
      ).toEqual(frame);
    }
    const refresh: HandoffFrame = { v: 1, type: 'refresh' };
    expect(encodeHandoffFrame(refresh, 'to-launcher')).toBe(
      '{"v":1,"type":"refresh"}\n',
    );
    expect(
      parseHandoffFrame('{"v":1,"type":"refresh"}', 'to-launcher'),
    ).toEqual(refresh);
  });

  it("is directional: each side accepts only the other side's frames", () => {
    expect(
      code(() => parseHandoffFrame('{"v":1,"type":"refresh"}', 'to-bridge')),
    ).toBe('invalid_handoff_frame');
    expect(
      code(() =>
        parseHandoffFrame(
          encodeHandoffFrame(credentialFrame(), 'to-bridge'),
          'to-launcher',
        ),
      ),
    ).toBe('invalid_handoff_frame');
    expect(
      code(() => encodeHandoffFrame(credentialFrame(), 'to-launcher')),
    ).toBe('invalid_handoff_frame');
  });

  it('caps a frame at 2 KiB including the newline', () => {
    expect(HANDOFF_FRAME_MAX_BYTES).toBe(2048);
    const padded = `${JSON.stringify({ v: 1, type: 'refresh' })}${' '.repeat(2048)}\n`;
    expect(code(() => parseHandoffFrame(padded, 'to-launcher'))).toBe(
      'handoff_frame_too_large',
    );
    const exactly = `{"v":1,"type":"refresh"}${' '.repeat(2048 - 25)}\n`;
    expect(Buffer.byteLength(exactly)).toBe(2048);
    expect(parseHandoffFrame(exactly, 'to-launcher').type).toBe('refresh');
  });

  it('is versioned', () => {
    expect(
      code(() => parseHandoffFrame('{"v":2,"type":"refresh"}', 'to-launcher')),
    ).toBe('unsupported_contract');
    expect(
      code(() => parseHandoffFrame('{"type":"refresh"}', 'to-launcher')),
    ).toBe('invalid_handoff_frame');
  });

  it.each([
    ['unknown key', credentialFrameJson({ extra: 1 })],
    ['missing seq', credentialFrameJson({ seq: undefined })],
    ['negative seq', credentialFrameJson({ seq: -1 })],
    ['fractional seq', credentialFrameJson({ seq: 1.5 })],
    ['huge seq', credentialFrameJson({ seq: 2 ** 40 })],
    ['bad token', credentialFrameJson({ token: 'smrt_mcp_short' })],
    ['bad expiry', credentialFrameJson({ expiresAt: 'x' })],
    ['unknown type', credentialFrameJson({ type: 'hello' })],
    ['unknown code', wire({ v: 1, type: 'unavailable', seq: 0, code: 'nope' })],
    [
      'token on unavailable',
      wire({
        v: 1,
        type: 'unavailable',
        seq: 0,
        code: 'credential_invalid',
        token: CANARY_TOKEN,
      }),
    ],
    ['array', '[]\n'],
    ['not JSON', `${CANARY_TOKEN}\n`],
    ['empty', '\n'],
    ['embedded newline', `{"v":1,\n"type":"refresh"}\n`],
    ['carriage return', `{"v":1,"type":"refresh"}\r\n`],
    ['duplicate keys', '{"v":1,"v":1,"type":"credential"}\n'],
  ])('rejects %s', (_name, line) => {
    expect(['invalid_handoff_frame', 'handoff_frame_too_large']).toContain(
      code(() => parseHandoffFrame(line, 'to-bridge')),
    );
  });

  it('T13: only the exact loopback origin grammar is accepted', () => {
    for (const origin of [
      'http://localhost:4678',
      'http://[::1]:4678',
      'https://127.0.0.1:4678',
      'http://127.0.0.1:4678/',
      'http://user@127.0.0.1:4678',
      'http://127.0.0.1:0',
      'http://127.0.0.1:65536',
      'http://127.0.0.1:04678',
      'http://127.0.0.1',
      'http://10.0.0.1:4678',
    ]) {
      expect(
        code(() =>
          encodeHandoffFrame(credentialFrame({ origin }), 'to-bridge'),
        ),
      ).toBe('invalid_handoff_frame');
      expect(
        code(() =>
          parseHandoffFrame(credentialFrameJson({ origin }), 'to-bridge'),
        ),
      ).toBe('invalid_handoff_frame');
    }
    expect(
      parseHandoffFrame(
        credentialFrameJson({ origin: 'http://127.0.0.1:65535' }),
        'to-bridge',
      ).type,
    ).toBe('credential');
  });

  it('refuses to encode a frame whose token is not a SecretString', () => {
    expect(
      code(() =>
        encodeHandoffFrame(
          credentialFrame({ token: CANARY_TOKEN }),
          'to-bridge',
        ),
      ),
    ).toBe('invalid_handoff_frame');
  });

  it('containsSecret finds the token anywhere in argv or env values', () => {
    const secret = new SecretString(CANARY_TOKEN);
    expect(containsSecret(secret, ['--credential-fd=3', '/usr/bin/node'])).toBe(
      false,
    );
    expect(containsSecret(secret, ['a', `--token=${CANARY_TOKEN}`])).toBe(true);
  });

  describe('incremental decoder', () => {
    it('reassembles frames split across chunks and several per chunk', () => {
      const decoder = new HandoffFrameDecoder('to-bridge');
      const a = encodeHandoffFrame(credentialFrame({ seq: 0 }), 'to-bridge');
      const b = encodeHandoffFrame(credentialFrame({ seq: 1 }), 'to-bridge');
      const bytes = new TextEncoder().encode(a + b);
      const out: HandoffFrame[] = [];
      for (let i = 0; i < bytes.length; i += 7) {
        out.push(...decoder.push(bytes.subarray(i, i + 7)));
      }
      expect(
        out.map((frame) => (frame.type === 'credential' ? frame.seq : -1)),
      ).toEqual([0, 1]);
      expect(decoder.push(a + b)).toHaveLength(2);
    });

    it('handles a multi-byte character split across chunks', () => {
      const decoder = new HandoffFrameDecoder('to-launcher');
      const bytes = new TextEncoder().encode('{"v":1,"type":"refresh"}\n');
      expect(decoder.push(bytes.subarray(0, 5))).toEqual([]);
      expect(decoder.push(bytes.subarray(5))).toHaveLength(1);
    });

    it('bounds buffering: an overlong line without a newline poisons it', () => {
      const decoder = new HandoffFrameDecoder('to-bridge');
      expect(code(() => decoder.push('x'.repeat(2048)))).toBe(
        'handoff_frame_too_large',
      );
      expect(code(() => decoder.push('\n'))).toBe('invalid_handoff_frame');
    });

    it('an invalid frame poisons it and leaks nothing', async () => {
      const decoder = new HandoffFrameDecoder('to-bridge');
      const error = await thrown(() =>
        decoder.push(`{"v":1,"type":"credential","token":"${CANARY_TOKEN}"}\n`),
      );
      expect(leaks(error)).toBe(false);
      expect(
        code(() =>
          decoder.push(encodeHandoffFrame(credentialFrame(), 'to-bridge')),
        ),
      ).toBe('invalid_handoff_frame');
    });

    it('rejects invalid UTF-8', () => {
      const decoder = new HandoffFrameDecoder('to-bridge');
      expect(code(() => decoder.push(new Uint8Array([0xff, 0x0a])))).toBe(
        'invalid_handoff_frame',
      );
    });
  });

  it('does not echo the token when the codec rejects a token-bearing frame', async () => {
    const lines = [
      credentialFrameJson({ seq: 'x' }),
      `${credentialFrameJson({}).trim()}${' '.repeat(3000)}\n`,
      `{"v":9,"token":"${CANARY_TOKEN}"}\n`,
    ];
    for (const line of lines) {
      const error = await thrown(() => parseHandoffFrame(line, 'to-bridge'));
      expect(error).toBeInstanceOf(DesktopContractError);
      expect(leaks(error, CANARY_BODY)).toBe(false);
    }
  });
});

function credentialFrameJson(overrides: Record<string, unknown>): string {
  const base: Record<string, unknown> = {
    v: 1,
    type: 'credential',
    seq: 0,
    origin: ORIGIN,
    token: CANARY_TOKEN,
    expiresAt: FUTURE,
    ...overrides,
  };
  for (const key of Object.keys(base)) {
    if (base[key] === undefined) delete base[key];
  }
  return wire(base);
}
