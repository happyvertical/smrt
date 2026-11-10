// Test helper: the shell's real `/mcp` route (merged server, one policy,
// bearer-token auth) on a loopback HTTP port, for CLI stubs or a real CLI to
// call. The token check is the test's: one token is valid at a time.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createLocalMcpTokenAuth } from '@happyvertical/smrt-app-mcp/auth';
import { mountMcpRoute } from '@happyvertical/smrt-app-mcp/sveltekit';
import { createShellMcpServer, type ScopeResolver } from '../mcp-server.ts';
import { type Principal, runAs } from '../owner.ts';

export interface TestMcp {
  /** `http://127.0.0.1:<port>/mcp` */
  url: string;
  /** The only token accepted from now on (`null`: none). */
  setToken(token: string | null): void;
  token(): string | null;
  close(): Promise<void>;
}

/**
 * `resolve` is the copy the URL names (default live); `assistantScope` is
 * what `/mcp?scope=assistant` uses.
 */
export async function startTestMcp(
  owner: Principal,
  resolve?: ScopeResolver,
): Promise<TestMcp> {
  let live: string | null = null;
  let url = '';
  const handler = mountMcpRoute(createShellMcpServer(resolve), {
    checkOrigin: true,
    auth: () =>
      createLocalMcpTokenAuth({
        verify: async (token) =>
          live && token === live
            ? {
                id: owner.id,
                tenantId: owner.tenantId,
                // `kind: 'human'` is what app-runtime's token verify returns.
                kind: 'human' as const,
                scopes: ['assistant.use'],
              }
            : null,
      }),
    bindPrincipal: (p, run) =>
      runAs({ id: p.id as string, tenantId: p.tenantId as string }, () =>
        run(p),
      ),
  });
  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const target = new URL(req.url ?? '/', url);
    const response = await handler({
      request: new Request(target, {
        method: req.method,
        headers: req.headers as Record<string, string>,
        body: chunks.length ? Buffer.concat(chunks) : undefined,
      }),
      url: target,
      locals: {},
    } as never);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  return {
    url,
    setToken: (token) => {
      live = token;
    },
    token: () => live,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
