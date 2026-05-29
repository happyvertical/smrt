/**
 * Fetches the resource list from `GET /api/_resources` and re-exports the
 * wire types so consumers can build typed extensions on top of the discovery
 * output.
 *
 * Types are imported type-only from `@happyvertical/smrt-users/sveltekit`
 * — the single source of truth for the wire contract. The CLI does not
 * depend on smrt-users at runtime (the peer dep is `optional` in the
 * package.json) so importing types is free of bundle cost.
 *
 * Importing type-only means a new field added to `CommandDefinition` /
 * `CliResource` on the handler side automatically propagates to the CLI's
 * typecheck — no manual mirror-update required. (#1311 review D-1.)
 *
 * @packageDocumentation
 */

import type {
  CliResource as HandlerCliResource,
  CommandDefinition as HandlerCommandDefinition,
  CommandKind as HandlerCommandKind,
  CommandScope as HandlerCommandScope,
  ResourceListResponseBody,
} from '@happyvertical/smrt-users/sveltekit';
import type { CliConfigContext } from './config.js';
import { requestJson } from './config.js';

export type CommandKind = HandlerCommandKind;
export type CommandScope = HandlerCommandScope;
export type CommandDefinition = HandlerCommandDefinition;
export type CliResource = HandlerCliResource;
export type ResourceListResponse = ResourceListResponseBody;

/* ── fetcher ──────────────────────────────────────────────────────────── */

export interface FetchResourceListOptions {
  /** Endpoint path on the server. Default `/api/_resources`. */
  path?: string;
  /** Custom fetch (tests). */
  fetch?: typeof fetch;
  /** When true, the request fails if no token is available. */
  requireAuth?: boolean;
  /**
   * Pre-loaded config to avoid re-reading from disk. Set by
   * `buildAppContext`, which has already loaded it. (#1311 review P2.)
   */
  loadedConfig?: import('./config.js').CliConfig;
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
        loadedConfig: options.loadedConfig,
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
