import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { loopbackFetch } from '../loopback-fetch.js';

const run = promisify(execFile);
const servers: Server[] = [];

async function listen(
  handler: (url: string, authorization: string | undefined) => number,
  seen: { url: string; authorization?: string }[],
): Promise<string> {
  const server = createServer((request, response) => {
    seen.push({
      url: request.url ?? '',
      authorization: request.headers.authorization,
    });
    request.resume();
    response.writeHead(
      handler(request.url ?? '', request.headers.authorization),
    );
    response.end();
  });
  servers.push(server);
  await new Promise<void>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve()),
  );
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

describe('loopbackFetch', () => {
  it('reaches 127.0.0.1 directly, returns a redirect instead of following it', async () => {
    const seen: { url: string; authorization?: string }[] = [];
    const origin = await listen((url) => (url === '/moved' ? 302 : 200), seen);
    const ok = await loopbackFetch(`${origin}/ok`, {
      method: 'POST',
      headers: { authorization: 'Bearer abc' },
      body: '{"x":1}',
    });
    expect(ok.status).toBe(200);
    await ok.body?.cancel();
    expect(seen).toEqual([{ url: '/ok', authorization: 'Bearer abc' }]);
    const moved = await loopbackFetch(`${origin}/moved`, { method: 'GET' });
    expect(moved.status).toBe(302);
    expect(seen).toHaveLength(2);
  });

  it('refuses any target other than http://127.0.0.1:<port>', async () => {
    for (const url of [
      'http://localhost:4000/',
      'http://[::1]:4000/',
      'http://127.0.0.2:4000/',
      'http://127.0.0.1/',
      'https://127.0.0.1:4000/',
      'http://example.com:4000/',
      'nonsense',
    ]) {
      await expect(loopbackFetch(url, {})).rejects.toThrow();
    }
  });

  it('aborts on the supplied signal', async () => {
    const origin = await new Promise<string>((resolve) => {
      const server = createServer(() => undefined);
      servers.push(server);
      server.listen(0, '127.0.0.1', () =>
        resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`),
      );
    });
    await expect(
      loopbackFetch(`${origin}/hang`, { signal: AbortSignal.timeout(100) }),
    ).rejects.toThrow();
  });

  it('ignores an environment proxy that global fetch would use', async () => {
    const proxied: { url: string; authorization?: string }[] = [];
    const proxy = await listen(() => 200, proxied);
    const direct: { url: string; authorization?: string }[] = [];
    const origin = await listen(() => 200, direct);
    const { stdout } = await run(
      process.execPath,
      [
        '--import',
        'tsx',
        fileURLToPath(new URL('./proxy-probe.mts', import.meta.url)),
      ],
      {
        cwd: fileURLToPath(new URL('../..', import.meta.url)),
        env: {
          PATH: process.env.PATH,
          PROBE_ORIGIN: origin,
          NODE_USE_ENV_PROXY: '1',
          HTTP_PROXY: proxy,
          http_proxy: proxy,
          NO_PROXY: '',
          no_proxy: '',
        },
      },
    );
    expect(JSON.parse(stdout)).toMatchObject({ direct: 200 });
    // The transport under test reached the origin itself...
    expect(direct).toContainEqual({
      url: '/api/mcp',
      authorization: 'Bearer probe-secret',
    });
    // ...and the proxy only ever saw the control request made with fetch,
    // which proves the proxy environment was live in the child.
    const absolute = `${origin}/api/mcp`;
    expect(proxied.map((request) => request.url)).toEqual([absolute]);
    expect(direct).toHaveLength(1);
  });
});
