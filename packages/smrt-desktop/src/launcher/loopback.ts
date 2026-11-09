import { Agent, request } from 'node:http';

/** One agent, never the global one: it consults no proxy setting. */
const agent = new Agent({ keepAlive: false });

/**
 * HTTP status of `GET http://127.0.0.1:<port><route>`.
 *
 * Global `fetch` can be routed through an environment proxy
 * (`NODE_USE_ENV_PROXY`, `HTTP_PROXY`), so the launcher connects to the
 * literal loopback address itself. It resolves no name, follows no redirect
 * (a 3xx is just a status) and never reads the body.
 */
export function loopbackStatus(
  port: number,
  route: string,
  timeoutMs: number,
): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const outgoing = request(
      {
        agent,
        host: '127.0.0.1',
        port,
        path: route,
        method: 'GET',
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      },
      (incoming) => {
        incoming.destroy();
        resolve(incoming.statusCode ?? 0);
      },
    );
    outgoing.once('error', reject);
    outgoing.end();
  });
}
