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
  const segments: string[] = ['api', resource.apiPath];

  if (command.scope === 'item') {
    if (!id) {
      throw new Error(
        `Command \`${resource.slug} ${command.commandName}\` requires an id positional argument.`,
      );
    }
    segments.push(encodeURIComponent(id));
  }

  for (const seg of command.pathSegments) {
    segments.push(seg);
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
