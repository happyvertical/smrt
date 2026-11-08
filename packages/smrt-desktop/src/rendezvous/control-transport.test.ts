import { chmodSync, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { createConnection, createServer, type Server } from 'node:net';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DesktopContractError } from '../errors.js';
import {
  CORE_CONTROL_OPS,
  type ControlOpSpec,
  createControlCodec,
} from './control-protocol.js';
import {
  type ControlServer,
  createControlHandlerRegistry,
  sendControlRequest,
  serveControlChannel,
} from './control-transport.js';
import { type ControlEndpoint, deriveControlEndpoint } from './endpoint.js';

const NONCE = '0f1e2d3c4b5a69788796a5b4c3d2e1f0';
const ORIGIN = 'http://127.0.0.1:49152';
const SECRET = 'smrt_mcp_LEAKCANARY0123456789';

// Unix domain sockets and POSIX modes: these tests cannot run on Windows,
// where the same contract uses a named pipe the Rust shell owns.
const posixOnly = process.platform === 'win32' ? describe.skip : describe;

const ready = {
  v: 1,
  ok: true,
  state: 'ready',
  instanceNonce: NONCE,
  productId: 'smrt-notes',
  origin: ORIGIN,
} as const;

async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(DesktopContractError);
    return (error as DesktopContractError).code;
  }
  return 'ok';
}

/** Send raw bytes, return everything the server wrote until it closed. */
function raw(path: string, bytes: string | Buffer): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ path });
    const chunks: Buffer[] = [];
    socket.on('data', (c: Buffer) => chunks.push(c));
    socket.on('error', reject);
    socket.on('close', () => resolve(Buffer.concat(chunks).toString('utf8')));
    socket.on('connect', () => socket.write(bytes));
  });
}

posixOnly('control transport over a unix socket', () => {
  let dir: string;
  let endpoint: ControlEndpoint & { kind: 'unix' };
  const servers: ControlServer[] = [];
  const rawServers: Server[] = [];

  beforeEach(() => {
    // /tmp keeps the socket path under sun_path (104 bytes on macOS).
    dir = mkdtempSync('/tmp/smrt-rdv-');
    chmodSync(dir, 0o700);
    endpoint = deriveControlEndpoint({
      platform: process.platform,
      bundleId: 'com.happyvertical.smrt-notes',
      directory: dir,
    }) as typeof endpoint;
  });
  afterEach(async () => {
    for (const server of servers.splice(0)) await server.close();
    for (const server of rawServers.splice(0)) server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const serve = async (
    handler: Parameters<typeof serveControlChannel>[1],
    options: Parameters<typeof serveControlChannel>[2] = {},
  ) => {
    const server = await serveControlChannel(endpoint, handler, options);
    servers.push(server);
    return server;
  };

  it('answers a request and closes, with the socket mode 0600', async () => {
    await serve(() => ready);
    expect(statSync(endpoint.path).mode & 0o777).toBe(0o600);
    const answer = await sendControlRequest(
      endpoint,
      { v: 1, op: 'status' },
      { timeoutMs: 1000 },
    );
    expect(answer).toEqual(ready);
  });

  it('passes the parsed request to the handler', async () => {
    const seen: unknown[] = [];
    await serve((request) => {
      seen.push(request);
      return ready;
    });
    await sendControlRequest(
      endpoint,
      { v: 1, op: 'ensure-ready', timeoutMs: 1234 },
      { timeoutMs: 1000 },
    );
    expect(seen).toEqual([{ v: 1, op: 'ensure-ready', timeoutMs: 1234 }]);
  });

  it('removes the socket on close and never unlinks an existing path first', async () => {
    const server = await serve(() => ready);
    await server.close();
    expect(existsSync(endpoint.path)).toBe(false);

    const holder = createServer();
    await new Promise<void>((resolve) => holder.listen(endpoint.path, resolve));
    rawServers.push(holder);
    expect(await code(serveControlChannel(endpoint, () => ready))).toBe(
      'control_server_failed',
    );
    expect(existsSync(endpoint.path)).toBe(true);
  });

  it('refuses to listen in a directory that is not private', async () => {
    chmodSync(dir, 0o755);
    expect(await code(serveControlChannel(endpoint, () => ready))).toBe(
      'untrusted_endpoint',
    );
    chmodSync(dir, 0o700);
    expect(
      await code(serveControlChannel(endpoint, () => ready, { currentUid: 0 })),
    ).toBe(process.getuid?.() === 0 ? 'ok' : 'untrusted_endpoint');
  });

  it('refuses an endpoint of the wrong kind for the platform', async () => {
    const pipe: ControlEndpoint = {
      kind: 'pipe',
      name: `\\\\.\\pipe\\smrt-0123456789abcdef-${NONCE}`,
    };
    expect(await code(serveControlChannel(pipe, () => ready))).toBe(
      'invalid_endpoint',
    );
    expect(
      await code(
        sendControlRequest(pipe, { v: 1, op: 'status' }, { timeoutMs: 100 }),
      ),
    ).toBe('invalid_endpoint');
  });

  it('answers malformed requests with a protocol error, never calling the handler', async () => {
    let calls = 0;
    await serve(() => {
      calls++;
      return ready;
    });
    const parse = (text: string) => JSON.parse(text.trim());
    expect(parse(await raw(endpoint.path, '{"v":2,"op":"status"}\n'))).toEqual({
      v: 1,
      ok: false,
      code: 'unsupported_version',
    });
    expect(parse(await raw(endpoint.path, '{"v":1,"op":"nope"}\n'))).toEqual({
      v: 1,
      ok: false,
      code: 'unsupported_op',
    });
    expect(
      parse(await raw(endpoint.path, '{"v":1,"op":"status","op":"status"}\n')),
    ).toEqual({ v: 1, ok: false, code: 'bad_request' });
    expect(
      parse(await raw(endpoint.path, '{"v":1,"op":"status","x":1}\n')),
    ).toEqual({
      v: 1,
      ok: false,
      code: 'bad_request',
    });
    expect(parse(await raw(endpoint.path, 'not json\n'))).toEqual({
      v: 1,
      ok: false,
      code: 'bad_request',
    });
    expect(
      parse(await raw(endpoint.path, Buffer.from([0xff, 0xfe, 0x0a]))),
    ).toEqual({ v: 1, ok: false, code: 'bad_request' });
    expect(calls).toBe(0);
  });

  it('answers an oversized request with too_large, even without a newline', async () => {
    await serve(() => ready);
    const big = `{"v":1,"op":"status","pad":"${'a'.repeat(5000)}"}`;
    expect(JSON.parse(await raw(endpoint.path, `${big}\n`))).toEqual({
      v: 1,
      ok: false,
      code: 'too_large',
    });
    expect(JSON.parse(await raw(endpoint.path, big))).toEqual({
      v: 1,
      ok: false,
      code: 'too_large',
    });
  });

  it('serves one request per connection and ignores trailing bytes', async () => {
    let calls = 0;
    await serve(() => {
      calls++;
      return ready;
    });
    const text = await raw(
      endpoint.path,
      '{"v":1,"op":"status"}\n{"v":1,"op":"status"}\n',
    );
    expect(text.split('\n').filter(Boolean)).toHaveLength(1);
    expect(calls).toBe(1);
  });

  it('answers internal, without the thrown text, when the handler throws', async () => {
    await serve(() => {
      throw new Error(`boom ${SECRET}`);
    });
    const text = await raw(endpoint.path, '{"v":1,"op":"status"}\n');
    expect(JSON.parse(text)).toEqual({ v: 1, ok: false, code: 'internal' });
    expect(text).not.toContain(SECRET);
  });

  it('answers internal when the handler returns something off-schema', async () => {
    await serve(() => ({ ...ready, token: SECRET }) as never);
    const text = await raw(endpoint.path, '{"v":1,"op":"status"}\n');
    expect(JSON.parse(text)).toEqual({ v: 1, ok: false, code: 'internal' });
    expect(text).not.toContain(SECRET);
  });

  it('drops a peer that never finishes its request line', async () => {
    await serve(() => ready, { requestReadTimeoutMs: 80 });
    const closed = await new Promise<string>((resolve) => {
      const socket = createConnection({ path: endpoint.path });
      const chunks: Buffer[] = [];
      socket.on('data', (c: Buffer) => chunks.push(c));
      socket.on('close', () => resolve(Buffer.concat(chunks).toString()));
      socket.on('connect', () => socket.write('{"v":1,'));
    });
    expect(closed).toBe('');
  });

  it('aborts the handler signal when the peer disconnects', async () => {
    let aborted: () => void = () => {};
    const sawAbort = new Promise<void>((resolve) => {
      aborted = resolve;
    });
    await serve(
      (_request, context) =>
        new Promise((resolve) => {
          context.signal.addEventListener('abort', () => {
            aborted();
            resolve(ready);
          });
        }),
    );
    const controller = new AbortController();
    const pending = sendControlRequest(
      endpoint,
      { v: 1, op: 'status' },
      { timeoutMs: 5000, signal: controller.signal },
    );
    setTimeout(() => controller.abort(), 40);
    expect(await code(pending)).toBe('control_aborted');
    await sawAbort;
  });

  it('reports an absent or refused listener as control_unreachable', async () => {
    expect(
      await code(
        sendControlRequest(
          endpoint,
          { v: 1, op: 'status' },
          { timeoutMs: 200 },
        ),
      ),
    ).toBe('control_unreachable');
  });

  it('times out on a listener that never answers', async () => {
    const hung = createServer((socket) => socket.on('error', () => {}));
    await new Promise<void>((resolve) => hung.listen(endpoint.path, resolve));
    rawServers.push(hung);
    expect(
      await code(
        sendControlRequest(endpoint, { v: 1, op: 'status' }, { timeoutMs: 60 }),
      ),
    ).toBe('control_timeout');
  });

  it('rejects a pre-aborted signal without connecting', async () => {
    const controller = new AbortController();
    controller.abort();
    expect(
      await code(
        sendControlRequest(
          endpoint,
          { v: 1, op: 'status' },
          { timeoutMs: 200, signal: controller.signal },
        ),
      ),
    ).toBe('control_aborted');
  });

  it('rejects an oversized, garbled or silent answer from a hostile listener', async () => {
    const reply = (payload: string | Buffer) => {
      const server = createServer((socket) => {
        socket.on('error', () => {});
        socket.on('data', () => socket.end(payload));
      });
      return new Promise<void>((resolve) => {
        server.listen(endpoint.path, () => {
          rawServers.push(server);
          resolve();
        });
      });
    };
    const ask = () =>
      sendControlRequest(endpoint, { v: 1, op: 'status' }, { timeoutMs: 500 });
    const stop = async () => {
      rawServers.pop()?.close();
      await new Promise((r) => setTimeout(r, 10));
    };

    await reply(`${'a'.repeat(5000)}\n`);
    expect(await code(ask())).toBe('control_message_too_large');
    await stop();

    await reply(
      `{"v":1,"ok":true,"state":"ready","instanceNonce":"${NONCE}","productId":"smrt-notes","origin":"http://localhost:1"}\n`,
    );
    expect(await code(ask())).toBe('invalid_control_message');
    await stop();

    await reply('{"v":1,"ok":true');
    expect(await code(ask())).toBe('control_unreachable');
    await stop();

    await reply(Buffer.from([0xff, 0x0a]));
    expect(await code(ask())).toBe('invalid_control_message');
  });

  it('returns a protocol-level refusal as data', async () => {
    await serve(() => ({ v: 1, ok: false, code: 'forbidden' }));
    expect(
      await sendControlRequest(
        endpoint,
        { v: 1, op: 'status' },
        { timeoutMs: 500 },
      ),
    ).toEqual({ v: 1, ok: false, code: 'forbidden' });
  });

  describe('handler registry', () => {
    it('routes by op and answers unsupported_op for an unregistered op', async () => {
      const registry = createControlHandlerRegistry();
      registry.register('status', () => ready);
      expect(registry.has('status')).toBe(true);
      expect(registry.has('ensure-ready')).toBe(false);
      await serve(registry.handler);
      expect(
        await sendControlRequest(
          endpoint,
          { v: 1, op: 'status' },
          { timeoutMs: 500 },
        ),
      ).toEqual(ready);
      expect(
        JSON.parse(
          await raw(
            endpoint.path,
            '{"v":1,"op":"ensure-ready","timeoutMs":5}\n',
          ),
        ),
      ).toEqual({ v: 1, ok: false, code: 'unsupported_op' });
    });

    it('rejects registering an op twice', () => {
      const registry = createControlHandlerRegistry();
      registry.register('status', () => ready);
      expect(() => registry.register('status', () => ready)).toThrow(
        DesktopContractError,
      );
    });

    it('serves an op added by another contract through a custom codec', async () => {
      interface Ping {
        readonly v: 1;
        readonly op: 'ping';
      }
      interface Pong {
        readonly v: 1;
        readonly ok: true;
        readonly pong: true;
      }
      const ping: ControlOpSpec<Ping, Pong> = {
        op: 'ping',
        parseRequest: () => ({ v: 1, op: 'ping' }),
        parseResponse: () => ({ v: 1, ok: true, pong: true }),
      };
      const codec = createControlCodec<
        { readonly op: string },
        { readonly ok: boolean }
      >([...CORE_CONTROL_OPS, ping]);
      const registry = createControlHandlerRegistry<
        { readonly op: string },
        { readonly ok: boolean }
      >();
      registry.register('ping', () => ({ v: 1, ok: true, pong: true }) as Pong);
      await serve(registry.handler as never, { codec: codec as never });
      const answer = await sendControlRequest(
        endpoint,
        { v: 1, op: 'ping' },
        { timeoutMs: 500, codec: codec as never },
      );
      expect(answer).toEqual({ v: 1, ok: true, pong: true });
      // The default codec on the same server rejects it.
      expect(
        JSON.parse(await raw(endpoint.path, '{"v":1,"op":"ping"}\n')).ok,
      ).toBe(true);
    });
  });

  it('never puts a path in a thrown error', async () => {
    const failures = [
      sendControlRequest(endpoint, { v: 1, op: 'status' }, { timeoutMs: 100 }),
      serveControlChannel(
        { ...endpoint, path: `/nonexistent-${SECRET}/c-${NONCE}.sock` },
        () => ready,
      ),
    ];
    for (const failure of failures) {
      try {
        await failure;
      } catch (error) {
        const text = `${(error as Error).message}${(error as Error).stack}`;
        expect(text).not.toContain(dir);
        expect(text).not.toContain(SECRET);
        expect(text).not.toContain('smrt-rdv');
      }
    }
  });
});
