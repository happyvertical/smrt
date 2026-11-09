/**
 * Validation and probing of the local instance endpoint.
 *
 * The credential is only ever sent to an origin that passed
 * {@link validateOrigin}: plain HTTP to the literal `127.0.0.1` with an
 * explicit port and nothing else (the same target the Rust supervisor probes;
 * `localhost` and `[::1]` are refused because another local user can listen
 * on them while the product's instance does not). Redirects are never
 * followed, and the default transport ignores proxy settings.
 *
 * @packageDocumentation
 */

import { LauncherFailure } from './failure.js';
import type { ProbeFetch, ProbeInit, ProbeResponse } from './loopback-fetch.js';
import type { InstalledRuntime, InstanceEndpoint } from './provider.js';

const LOOPBACK_HOST = '127.0.0.1';

/** Per-request probe budget in milliseconds. */
export const PROBE_TIMEOUT_MS = 5_000;

/** Require exactly `http://127.0.0.1:<port>`; returns the origin. */
export function validateOrigin(value: unknown): string {
  const invalid = (): never => {
    throw new LauncherFailure('unexpected_endpoint');
  };
  if (typeof value !== 'object' || value === null) return invalid();
  const origin = (value as Partial<InstanceEndpoint>).origin;
  if (typeof origin !== 'string' || origin.length > 64) return invalid();
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return invalid();
  }
  if (
    url.protocol !== 'http:' ||
    url.hostname !== LOOPBACK_HOST ||
    url.port === '' ||
    url.port === '0' ||
    url.username ||
    url.password ||
    url.origin !== origin
  ) {
    return invalid();
  }
  return origin;
}

/** Fetch with no redirects and a hard timeout; any failure is `stale_instance`. */
async function probe(
  fetchImpl: ProbeFetch,
  url: string,
  init: ProbeInit,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<ProbeResponse> {
  try {
    return await fetchImpl(url, {
      ...init,
      redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
    });
  } catch {
    throw new LauncherFailure('stale_instance');
  }
}

async function drain(response: ProbeResponse): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

/**
 * `GET <origin><healthRoute>` must answer 2xx. A failed connection, a timeout,
 * a redirect or any other status means the rendezvous points at an instance
 * that is gone: `stale_instance`.
 */
export async function probeHealth(
  fetchImpl: ProbeFetch,
  origin: string,
  install: InstalledRuntime,
  signal: AbortSignal,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<void> {
  const response = await probe(
    fetchImpl,
    `${origin}${install.healthRoute}`,
    { method: 'GET', headers: { accept: 'application/json' } },
    signal,
    timeoutMs,
  );
  await drain(response);
  if (response.status < 200 || response.status > 299) {
    throw new LauncherFailure('stale_instance');
  }
}

/**
 * Check, before any child is started, that the instance accepts the
 * credential: an authenticated JSON-RPC `ping` to the MCP endpoint.
 *
 * - 401 / 403: `credential_invalid` (revoked, expired or minted elsewhere)
 * - 404 / 405: `unexpected_endpoint` (not this product's MCP route)
 * - 5xx or connection failure: `stale_instance`
 * - anything else: the credential was authenticated; the bridge takes over
 */
export async function probeCredential(
  fetchImpl: ProbeFetch,
  origin: string,
  install: InstalledRuntime,
  token: string,
  signal: AbortSignal,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<void> {
  const response = await probe(
    fetchImpl,
    `${origin}${install.mcpPath ?? '/api/mcp'}`,
    {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    },
    signal,
    timeoutMs,
  );
  await drain(response);
  // The default transport returns a redirect instead of failing on it, and
  // `fetch` with `redirect: 'error'` throws; both mean the credential was
  // not accepted by the route it was meant for.
  if (response.status >= 300 && response.status <= 399) {
    throw new LauncherFailure('stale_instance');
  }
  if (response.status === 401 || response.status === 403) {
    throw new LauncherFailure('credential_invalid');
  }
  if (response.status === 404 || response.status === 405) {
    throw new LauncherFailure('unexpected_endpoint');
  }
  if (response.status >= 500) throw new LauncherFailure('stale_instance');
}
