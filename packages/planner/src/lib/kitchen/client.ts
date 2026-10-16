/**
 * Send to kitchen: the hand-off to `smrt kitchen`, the CLI that serves this
 * app on localhost and turns the cookbook into a project. The CLI announces
 * itself in `planner.config.json` with where to send, and in the address it
 * opens with the one-time token, as a fragment (`fragment.ts`):
 *
 *   planner.config.json  { "kitchen": { "endpoint": "/api/kitchen/cookbook" } }
 *   address              http://127.0.0.1:<port>/#kitchen=<token>
 *
 * The config never carries a token (any local process sending the right Host
 * header could read it); a `token` in the file is ignored (and reported, see
 * `tokenInConfig`). The page POSTs the
 * cookbook to the endpoint with the token in `x-kitchen-token`. Wire contract,
 * version 1:
 *
 * - `200 { ok: true, dir, mode, installed, added, nextSteps }`: the project
 *   was written (`mode` is `new` or `update`).
 * - `4xx/5xx { ok: false, errors: string[] }`: the cookbook was not applied;
 *   the server keeps listening, so the visitor can fix it and send again.
 */
import { serializeCookbook } from '../cookbook/file.ts';
import type { Cookbook } from '../cookbook/types.ts';

/** Where to send, from the config. Absent from the config means no kitchen. */
export interface KitchenEndpoint {
  endpoint: string;
  /**
   * True when the file still carried a `token`: an older `smrt` CLI that serves
   * it where any local process can read it. The value is never kept, and
   * sending is off until the CLI is updated.
   */
  tokenInConfig?: true;
}

/** Where and how to send: the config's endpoint and the address's token. */
export interface KitchenConfig extends KitchenEndpoint {
  token: string;
}

/** The header the CLI checks the one-time token in. */
export const KITCHEN_TOKEN_HEADER = 'x-kitchen-token';

/** What the kitchen reports after writing the project. */
export interface KitchenResult {
  dir: string;
  mode: 'new' | 'update';
  installed: boolean;
  added: string[];
  nextSteps: string[];
}

export type KitchenOutcome =
  | { ok: true; result: KitchenResult }
  | { ok: false; errors: string[] };

const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

/** An http(s) URL, or a path on the page's own origin. */
function usableEndpoint(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const text = value.trim();
  try {
    const relative = text.startsWith('/') && !text.startsWith('//');
    const url = new URL(text, relative ? 'https://planner.invalid' : undefined);
    if (!relative && url.protocol !== 'http:' && url.protocol !== 'https:') {
      return false;
    }
    if (url.username || url.password) return false;
    if (url.hash) return false;
    return ![...url.searchParams.keys()].some((name) =>
      /^(?:api[-_]?key|key|token|authorization|secret|password)$/i.test(name),
    );
  } catch {
    return false;
  }
}

/**
 * Validate the config's `kitchen` block. Anything unusable means no kitchen.
 * Only the endpoint is read: a `token` here is ignored, never used.
 */
export function parseKitchenConfig(
  value: unknown,
): KitchenEndpoint | undefined {
  if (!isObject(value)) return undefined;
  const { endpoint } = value;
  if (!usableEndpoint(endpoint)) return undefined;
  return {
    endpoint: endpoint.trim(),
    ...(Object.hasOwn(value, 'token') ? { tokenInConfig: true as const } : {}),
  };
}

const strings = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((x): x is string => typeof x === 'string')
    : [];

/** POST the cookbook to the kitchen. Never throws; a failure is an outcome. */
export async function sendToKitchen(
  config: KitchenConfig,
  cookbook: Cookbook,
  fetcher: typeof fetch = fetch,
): Promise<KitchenOutcome> {
  let response: Response;
  try {
    response = await fetcher(config.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        [KITCHEN_TOKEN_HEADER]: config.token,
      },
      body: serializeCookbook(cookbook),
    });
  } catch {
    return {
      ok: false,
      errors: [
        'The kitchen could not be reached. Is `smrt kitchen` still running?',
      ],
    };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  if (response.ok && isObject(body) && body.ok === true) {
    return {
      ok: true,
      result: {
        dir: typeof body.dir === 'string' ? body.dir : '',
        mode: body.mode === 'update' ? 'update' : 'new',
        installed: body.installed === true,
        added: strings(body.added),
        nextSteps: strings(body.nextSteps),
      },
    };
  }
  const errors = isObject(body) ? strings(body.errors) : [];
  if (isObject(body) && typeof body.error === 'string') {
    errors.push(body.error);
  }
  return {
    ok: false,
    errors: errors.length
      ? errors
      : [`The kitchen answered ${response.status}.`],
  };
}
