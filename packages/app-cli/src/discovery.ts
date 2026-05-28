/**
 * Fetches the resource list from `GET /api/_resources` and re-exports
 * the wire types so consumers can build typed extensions on top of the
 * discovery output.
 *
 * @packageDocumentation
 */

import type { CliConfigContext } from './config.js';
import { requestJson } from './config.js';

/* ── re-exported wire types (mirror smrt-users/sveltekit) ─────────────── */

export type CommandKind = 'crud' | 'custom';
export type CommandScope = 'item' | 'collection';

export interface CommandDefinition {
  methodName: string;
  commandName: string;
  kind: CommandKind;
  scope: CommandScope;
  httpMethod: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  pathSegments: string[];
  description?: string;
  parameters?: Record<string, unknown>;
}

export interface CliResource {
  slug: string;
  className: string;
  qualifiedName?: string;
  packageName?: string;
  label: string;
  apiPath: string;
  commands: CommandDefinition[];
}

export interface ResourceListResponse {
  user: { authenticated: boolean; id?: string };
  warnings: string[];
  resources: CliResource[];
}

/* ── fetcher ──────────────────────────────────────────────────────────── */

export interface FetchResourceListOptions {
  /** Endpoint path on the server. Default `/api/_resources`. */
  path?: string;
  /** Custom fetch (tests). */
  fetch?: typeof fetch;
  /** When true, the request fails if no token is available. */
  requireAuth?: boolean;
}

/**
 * Fetch the discovery payload.
 *
 * Translates a 401 into a friendlier error so the CLI can prompt the
 * user to log in rather than dumping a raw HTTP error.
 */
export async function fetchResourceList(
  context: CliConfigContext,
  options: FetchResourceListOptions = {},
): Promise<ResourceListResponse> {
  try {
    return await requestJson<ResourceListResponse>(
      context,
      options.path ?? '/api/_resources',
      { method: 'GET' },
      {
        fetch: options.fetch,
        requireAuth: options.requireAuth,
      },
    );
  } catch (error) {
    if (error instanceof Error && /401|unauthor/i.test(error.message)) {
      throw new Error(
        `Not authenticated to ${context.envPrefix.toLowerCase()}. ` +
          `Run \`${context.envPrefix.toLowerCase()} auth login\` first.`,
      );
    }
    throw error;
  }
}

/**
 * Find a resource by slug in the discovery payload. Returns `undefined`
 * if the slug isn't present.
 */
export function findResourceBySlug(
  response: ResourceListResponse,
  slug: string,
): CliResource | undefined {
  return response.resources.find((r) => r.slug === slug);
}

/**
 * Find a command on a resource by its CLI-facing name. Returns
 * `undefined` if not found.
 */
export function findCommand(
  resource: CliResource,
  commandName: string,
): CommandDefinition | undefined {
  return resource.commands.find((c) => c.commandName === commandName);
}
