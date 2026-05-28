/**
 * Maps a parsed `(resource, command, argv)` triple to the actual HTTP
 * request. Single dispatcher for both CRUD and custom commands.
 *
 * @packageDocumentation
 */

import type { CliConfigContext } from './config.js';
import { getServerUrl, getStoredToken } from './config.js';
import type { CliResource, CommandDefinition } from './discovery.js';
import type { ParsedArgs } from './parser.js';

export interface InvokeOptions {
  context: CliConfigContext;
  resource: CliResource;
  command: CommandDefinition;
  parsed: ParsedArgs;
  /** Positional `<id>` argument — only meaningful for item-scope commands. */
  id?: string;
  /** Custom fetch (tests). */
  fetch?: typeof fetch;
}

/**
 * Build the URL the CLI should hit for this command, plus the fetch init
 * (headers, body) it should pass. Returns enough so callers can stream
 * the response — they decide how to render it (see `output.ts`).
 */
export async function invokeCommand(options: InvokeOptions): Promise<Response> {
  const { context, resource, command, parsed, fetch: fetchImpl } = options;
  const url = await buildUrl(context, resource, command, parsed, options.id);

  const headers = new Headers();
  const token = await getStoredToken(context);
  if (token) headers.set('authorization', `Bearer ${token}`);

  let body: string | undefined;
  if (command.httpMethod !== 'GET' && command.httpMethod !== 'DELETE') {
    if (Object.keys(parsed.body).length > 0 || parsed.fromPositional) {
      headers.set('content-type', 'application/json');
      body = JSON.stringify(parsed.body);
    }
  }

  const impl = fetchImpl ?? fetch;
  return impl(url, {
    method: command.httpMethod,
    headers,
    body,
  });
}

/**
 * Build only the URL — exposed for tests.
 */
export async function buildUrl(
  context: CliConfigContext,
  resource: CliResource,
  command: CommandDefinition,
  parsed: ParsedArgs,
  id?: string,
): Promise<string> {
  const serverUrl = await getServerUrl(context);
  const segments: string[] = ['api'];

  // `apiPath` is typically a single segment (e.g. `praecos`) but defense
  // in depth: split on `/` so an apiPath like `v1/items` or `/v1/items`
  // doesn't produce a double slash or smash everything into one segment.
  // Each piece is URL-encoded individually. (#1311 review A2/C3.)
  for (const piece of splitPath(resource.apiPath)) {
    segments.push(encodeURIComponent(piece));
  }

  if (command.scope === 'item') {
    if (!id) {
      throw new Error(
        `Command \`${resource.slug} ${command.commandName}\` requires an id positional argument.`,
      );
    }
    segments.push(encodeURIComponent(id));
  }

  // `pathSegments` come from the server's resolved-route config, but a
  // misconfigured `api.routes[x].path` could contain `/`, `..`, or
  // reserved characters. Encode each segment so the CLI never silently
  // path-traverses or sends ambiguous URLs. (#1311 review A2.)
  for (const seg of command.pathSegments) {
    for (const piece of splitPath(seg)) {
      segments.push(encodeURIComponent(piece));
    }
  }

  const base = `${serverUrl}/${segments.join('/')}`;
  if (command.httpMethod === 'GET' && Object.keys(parsed.query).length > 0) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(parsed.query)) {
      if (Array.isArray(v)) {
        for (const x of v) params.append(k, x);
      } else {
        params.set(k, v);
      }
    }
    return `${base}?${params.toString()}`;
  }
  return base;
}

/**
 * Split a URL path string into clean segments, stripping leading/trailing
 * slashes and any empty pieces. Defends against `apiPath` overrides like
 * `/v1/items/` or `pathSegments` like `users/` that would otherwise
 * produce double slashes or trailing nothings in the final URL.
 */
function splitPath(s: string): string[] {
  if (typeof s !== 'string') return [];
  return s.split('/').filter((p) => p.length > 0);
}
