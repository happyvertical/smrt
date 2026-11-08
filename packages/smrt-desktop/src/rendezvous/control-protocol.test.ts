import { describe, expect, it } from 'vitest';
import { DesktopContractError } from '../errors.js';
import {
  CORE_CONTROL_OPS,
  type ControlOpSpec,
  controlErrorCodeFor,
  createControlCodec,
  encodeControlRequest,
  encodeControlResponse,
  MAX_CONTROL_MESSAGE_BYTES,
  MAX_ENSURE_READY_TIMEOUT_MS,
  parseControlRequest,
  parseControlResponse,
} from './control-protocol.js';

const NONCE = '0f1e2d3c4b5a69788796a5b4c3d2e1f0';
const TOKEN = 'smrt_mcp_LEAKCANARY0123456789';

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(DesktopContractError);
    return (error as DesktopContractError).code;
  }
  return 'ok';
}

describe('control requests', () => {
  it('round-trips status and ensure-ready, newline terminated', () => {
    const status = encodeControlRequest({ v: 1, op: 'status' });
    expect(status).toBe('{"v":1,"op":"status"}\n');
    expect(parseControlRequest(status)).toEqual({ v: 1, op: 'status' });

    const ensure = encodeControlRequest({
      v: 1,
      op: 'ensure-ready',
      timeoutMs: 5000,
    });
    expect(ensure).toBe('{"v":1,"op":"ensure-ready","timeoutMs":5000}\n');
    expect(parseControlRequest(ensure)).toEqual({
      v: 1,
      op: 'ensure-ready',
      timeoutMs: 5000,
    });
  });

  it('accepts a line with or without its terminator and freezes the result', () => {
    expect(Object.isFrozen(parseControlRequest('{"v":1,"op":"status"}'))).toBe(
      true,
    );
    expect(parseControlRequest('{"v":1,"op":"status"}\n').op).toBe('status');
  });

  it('canonicalizes key order on encode', () => {
    expect(
      encodeControlRequest({ timeoutMs: 1, op: 'ensure-ready', v: 1 } as never),
    ).toBe('{"v":1,"op":"ensure-ready","timeoutMs":1}\n');
  });

  it('rejects unknown ops and versions, in that precedence over extra keys', () => {
    expect(
      code(() => parseControlRequest('{"v":1,"op":"acquire-credential"}')),
    ).toBe('unsupported_op');
    expect(code(() => parseControlRequest('{"v":1,"op":"nope","x":1}'))).toBe(
      'unsupported_op',
    );
    expect(code(() => parseControlRequest('{"v":2,"op":"status"}'))).toBe(
      'unsupported_contract',
    );
    expect(code(() => parseControlRequest('{"v":"1","op":"status"}'))).toBe(
      'unsupported_contract',
    );
    expect(code(() => parseControlRequest('{"op":"status"}'))).toBe(
      'invalid_control_message',
    );
    expect(code(() => parseControlRequest('{"v":1}'))).toBe(
      'invalid_control_message',
    );
    expect(code(() => parseControlRequest('{"v":1,"op":5}'))).toBe(
      'invalid_control_message',
    );
  });

  it('rejects extra and missing fields', () => {
    expect(code(() => parseControlRequest('{"v":1,"op":"status","x":1}'))).toBe(
      'invalid_control_message',
    );
    expect(code(() => parseControlRequest('{"v":1,"op":"ensure-ready"}'))).toBe(
      'invalid_control_message',
    );
  });

  it.each([
    0,
    -1,
    1.5,
    '5',
    null,
    MAX_ENSURE_READY_TIMEOUT_MS + 1,
  ])('rejects ensure-ready timeoutMs %j', (timeoutMs) => {
    expect(
      code(() =>
        parseControlRequest(
          JSON.stringify({ v: 1, op: 'ensure-ready', timeoutMs }),
        ),
      ),
    ).toBe('invalid_control_message');
  });

  it('rejects duplicate keys, bad JSON and non-objects', () => {
    expect(
      code(() => parseControlRequest('{"v":1,"op":"status","op":"status"}')),
    ).toBe('duplicate_keys');
    expect(code(() => parseControlRequest('{"v":1,'))).toBe('invalid_json');
    expect(code(() => parseControlRequest('[1]'))).toBe(
      'invalid_control_message',
    );
    expect(code(() => parseControlRequest('"status"'))).toBe(
      'invalid_control_message',
    );
    expect(code(() => parseControlRequest(''))).toBe('invalid_json');
    expect(
      code(() => parseControlRequest(undefined as unknown as string)),
    ).toBe('invalid_control_message');
  });

  it('enforces single-line framing', () => {
    expect(code(() => parseControlRequest('{"v":1,\n"op":"status"}'))).toBe(
      'invalid_control_message',
    );
    expect(code(() => parseControlRequest('{"v":1,"op":"status"}\n\n'))).toBe(
      'invalid_control_message',
    );
    expect(code(() => parseControlRequest('{"v":1,"op":"status"}\r\n'))).toBe(
      'invalid_control_message',
    );
  });

  it('caps a message at 4 KiB of UTF-8, excluding the terminator', () => {
    const shell = (pad: string) => `{"v":1,"op":"status","pad":"${pad}"}`;
    const overhead = Buffer.byteLength(shell(''), 'utf8');
    // Exactly at the cap: still rejected, but as an unknown field, not size.
    const atCap = shell('a'.repeat(MAX_CONTROL_MESSAGE_BYTES - overhead));
    expect(Buffer.byteLength(atCap, 'utf8')).toBe(MAX_CONTROL_MESSAGE_BYTES);
    expect(code(() => parseControlRequest(`${atCap}\n`))).toBe(
      'invalid_control_message',
    );
    const over = shell('a'.repeat(MAX_CONTROL_MESSAGE_BYTES - overhead + 1));
    expect(code(() => parseControlRequest(over))).toBe(
      'control_message_too_large',
    );
    // Multi-byte characters count as bytes.
    const wide = shell('é'.repeat(MAX_CONTROL_MESSAGE_BYTES / 2));
    expect(code(() => parseControlRequest(wide))).toBe(
      'control_message_too_large',
    );
  });

  it('maps codec failures to protocol error codes', () => {
    expect(
      controlErrorCodeFor(new DesktopContractError('unsupported_contract')),
    ).toBe('unsupported_version');
    expect(
      controlErrorCodeFor(new DesktopContractError('unsupported_op')),
    ).toBe('unsupported_op');
    expect(
      controlErrorCodeFor(
        new DesktopContractError('control_message_too_large'),
      ),
    ).toBe('too_large');
    expect(controlErrorCodeFor(new DesktopContractError('invalid_json'))).toBe(
      'bad_request',
    );
    expect(controlErrorCodeFor(new Error('x'))).toBe('internal');
  });
});

describe('control responses', () => {
  const ready = {
    v: 1,
    ok: true,
    state: 'ready',
    instanceNonce: NONCE,
    productId: 'smrt-notes',
    origin: 'http://127.0.0.1:49152',
  } as const;

  it('round-trips ready, starting, failed and error answers', () => {
    const starting = {
      v: 1,
      ok: true,
      state: 'starting',
      instanceNonce: NONCE,
      productId: 'smrt-notes',
    } as const;
    const failed = {
      v: 1,
      ok: true,
      state: 'failed',
      instanceNonce: NONCE,
      productId: 'smrt-notes',
      code: 'lease_held',
    } as const;
    const refused = { v: 1, ok: false, code: 'forbidden' } as const;
    for (const response of [ready, starting, failed, refused]) {
      for (const op of ['status', 'ensure-ready'] as const) {
        const line = encodeControlResponse(response);
        expect(line.endsWith('\n')).toBe(true);
        expect(parseControlResponse(op, line)).toEqual(response);
      }
    }
  });

  it('rejects a bad origin, nonce, product, state and failure code', () => {
    const bad = (overrides: Record<string, unknown>) =>
      code(() =>
        parseControlResponse(
          'status',
          JSON.stringify({ ...ready, ...overrides }),
        ),
      );
    expect(bad({ origin: 'http://localhost:49152' })).toBe(
      'invalid_control_message',
    );
    expect(bad({ origin: 'http://127.0.0.1:49152/x' })).toBe(
      'invalid_control_message',
    );
    expect(bad({ instanceNonce: 'abc' })).toBe('invalid_control_message');
    expect(bad({ productId: 'Not A Slug' })).toBe('invalid_control_message');
    expect(bad({ state: 'paused' })).toBe('invalid_control_message');
    expect(
      bad({ state: 'failed', origin: undefined, code: 'launch_failed' }),
    ).toBe('invalid_control_message');
    expect(bad({ token: TOKEN })).toBe('invalid_control_message');
    expect(bad({ ok: 'yes' })).toBe('invalid_control_message');
  });

  it('rejects an unknown error code, extra keys and unknown ops', () => {
    expect(
      code(() =>
        parseControlResponse('status', '{"v":1,"ok":false,"code":"teapot"}'),
      ),
    ).toBe('invalid_control_message');
    expect(
      code(() =>
        parseControlResponse(
          'status',
          `{"v":1,"ok":false,"code":"internal","detail":"${TOKEN}"}`,
        ),
      ),
    ).toBe('invalid_control_message');
    expect(
      code(() => parseControlResponse('nope' as never, JSON.stringify(ready))),
    ).toBe('unsupported_op');
    expect(
      code(() => parseControlResponse('status', '{"v":2,"ok":true}')),
    ).toBe('unsupported_contract');
    expect(
      code(() =>
        parseControlResponse(
          'status',
          JSON.stringify(ready).replace('"ok":true', '"ok":true,"ok":true'),
        ),
      ),
    ).toBe('duplicate_keys');
  });

  it('refuses to encode a response with a bearer-shaped extra field', () => {
    expect(
      code(() => encodeControlResponse({ ...ready, token: TOKEN } as never)),
    ).toBe('invalid_control_message');
  });
});

describe('extending the protocol with another op', () => {
  interface PingRequest {
    readonly v: 1;
    readonly op: 'ping';
    readonly n: number;
  }
  interface PingResponse {
    readonly v: 1;
    readonly ok: true;
    readonly n: number;
  }
  const ping: ControlOpSpec<PingRequest, PingResponse> = {
    op: 'ping',
    parseRequest(fields) {
      const keys = Object.keys(fields).sort().join(',');
      if (keys !== 'n,op,v' || typeof fields.n !== 'number') {
        throw new DesktopContractError('invalid_control_message');
      }
      return { v: 1, op: 'ping', n: fields.n };
    },
    parseResponse(fields) {
      if (Object.keys(fields).sort().join(',') !== 'n,ok,v') {
        throw new DesktopContractError('invalid_control_message');
      }
      return { v: 1, ok: true, n: fields.n as number };
    },
  };

  it('keeps the core ops and adds the new one and its error code', () => {
    const codec = createControlCodec<
      { readonly op: string },
      { readonly ok: boolean }
    >([...CORE_CONTROL_OPS, ping], ['internal', 'instance_mismatch']);
    expect(codec.ops).toEqual(['status', 'ensure-ready', 'ping']);
    expect(codec.parseRequest('{"v":1,"op":"ping","n":2}')).toEqual({
      v: 1,
      op: 'ping',
      n: 2,
    });
    expect(codec.parseRequest('{"v":1,"op":"status"}').op).toBe('status');
    expect(codec.parseResponse('ping', '{"v":1,"ok":true,"n":2}')).toEqual({
      v: 1,
      ok: true,
      n: 2,
    });
    expect(
      codec.parseResponse(
        'ping',
        '{"v":1,"ok":false,"code":"instance_mismatch"}',
      ),
    ).toEqual({ v: 1, ok: false, code: 'instance_mismatch' });
    expect(
      code(() =>
        codec.parseResponse('ping', '{"v":1,"ok":false,"code":"forbidden"}'),
      ),
    ).toBe('invalid_control_message');
    expect(codec.encodeResponse({ v: 1, ok: true, n: 3 } as never)).toBe(
      '{"v":1,"ok":true,"n":3}\n',
    );
  });

  it('does not let a codec register an op twice', () => {
    expect(() => createControlCodec([ping, ping])).toThrow(
      DesktopContractError,
    );
  });

  it('leaves the default codec untouched', () => {
    expect(code(() => parseControlRequest('{"v":1,"op":"ping","n":1}'))).toBe(
      'unsupported_op',
    );
  });
});
