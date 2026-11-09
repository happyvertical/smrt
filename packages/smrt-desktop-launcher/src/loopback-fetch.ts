/**
 * The default probe client: HTTP to `127.0.0.1` only, over a dedicated
 * `node:http` agent.
 *
 * Global `fetch` can be routed through an environment proxy
 * (`NODE_USE_ENV_PROXY`, `HTTP_PROXY`), which would hand the bearer token of
 * the credential probe to whatever the proxy variables name. This client
 * connects straight to the loopback address it was given: a fresh
 * {@link Agent} is created without `proxyEnv`, so no proxy setting is ever
 * consulted, and it never resolves a name. Redirects are not followed; a
 * 3xx answer is returned as is for the caller to refuse.
 *
 * @packageDocumentation
 */

import { Agent, request } from 'node:http';

/** The slice of `RequestInit` the probes use. */
export interface ProbeInit {
  readonly method?: string;
  readonly headers?: Record<string, string>;
  readonly body?: string;
  readonly redirect?: 'error' | 'follow' | 'manual';
  readonly signal?: AbortSignal;
}

/** The slice of `Response` the probes read. */
export interface ProbeResponse {
  readonly status: number;
  readonly body?: { cancel(): Promise<unknown> } | null;
}

/** Probe transport. Global `fetch` satisfies it, and so does {@link loopbackFetch}. */
export type ProbeFetch = (
  url: string,
  init: ProbeInit,
) => Promise<ProbeResponse>;

/** One agent, never the global one, never configured from the environment. */
const agent = new Agent({ keepAlive: false });

/** `fetch`-shaped GET/POST to `http://127.0.0.1:<port>` that ignores proxies. */
export const loopbackFetch: ProbeFetch = (url, init) =>
  new Promise<ProbeResponse>((resolve, reject) => {
    let target: URL;
    try {
      target = new URL(url);
    } catch (error) {
      reject(error);
      return;
    }
    if (
      target.protocol !== 'http:' ||
      target.hostname !== '127.0.0.1' ||
      target.port === ''
    ) {
      reject(new TypeError('loopbackFetch only connects to http://127.0.0.1'));
      return;
    }
    const outgoing = request(
      {
        agent,
        host: '127.0.0.1',
        port: Number(target.port),
        path: `${target.pathname}${target.search}`,
        method: init.method ?? 'GET',
        headers: {
          ...init.headers,
          ...(init.body === undefined
            ? {}
            : { 'content-length': String(Buffer.byteLength(init.body)) }),
        },
        signal: init.signal,
      },
      (incoming) => {
        // The probes only read the status; never buffer a body.
        resolve({
          status: incoming.statusCode ?? 0,
          body: {
            cancel: async () => {
              incoming.destroy();
            },
          },
        });
      },
    );
    outgoing.once('error', reject);
    outgoing.end(init.body);
  });
