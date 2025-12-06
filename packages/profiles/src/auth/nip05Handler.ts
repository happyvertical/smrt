/**
 * NIP-05 Handler
 *
 * Provides a helper for serving the /.well-known/nostr.json endpoint
 * for NIP-05 identity verification.
 *
 * @see https://github.com/nostr-protocol/nips/blob/master/05.md
 */

import type { SmrtObjectOptions } from '@happyvertical/smrt-core';
import {
  type Nip05Response,
  NostrIdentityCollection,
} from '../collections/NostrIdentityCollection';

export interface Nip05HandlerConfig {
  /** Database options */
  db: SmrtObjectOptions['db'];
  /** Optional: Additional relays to include for all users */
  defaultRelays?: string[];
  /** Optional: Cache TTL in seconds (default: 300 = 5 minutes) */
  cacheTtlSeconds?: number;
}

export interface Nip05Request {
  /** The 'name' query parameter from the request */
  name?: string | null;
}

export interface Nip05HandlerResult {
  /** The NIP-05 response body */
  body: Nip05Response;
  /** Suggested headers for the response */
  headers: Record<string, string>;
  /** HTTP status code */
  status: number;
}

/**
 * Create a NIP-05 handler
 *
 * @example
 * // SvelteKit
 * import { createNip05Handler } from '@happyvertical/smrt-profiles';
 *
 * const handler = createNip05Handler({ db: { type: 'postgres', url: DATABASE_URL } });
 *
 * export async function GET({ url }) {
 *   const result = await handler({ name: url.searchParams.get('name') });
 *   return new Response(JSON.stringify(result.body), {
 *     status: result.status,
 *     headers: result.headers,
 *   });
 * }
 *
 * @example
 * // Express
 * import { createNip05Handler } from '@happyvertical/smrt-profiles';
 *
 * const handler = createNip05Handler({ db: { type: 'postgres', url: DATABASE_URL } });
 *
 * app.get('/.well-known/nostr.json', async (req, res) => {
 *   const result = await handler({ name: req.query.name });
 *   res.status(result.status).set(result.headers).json(result.body);
 * });
 */
export function createNip05Handler(config: Nip05HandlerConfig) {
  const { db, defaultRelays = [], cacheTtlSeconds = 300 } = config;

  return async function handleNip05Request(
    request: Nip05Request,
  ): Promise<Nip05HandlerResult> {
    const { name } = request;

    const collection = await NostrIdentityCollection.create({ db });
    const response = await collection.getNip05Response(name || undefined);

    // Add default relays if configured
    if (defaultRelays.length > 0 && Object.keys(response.names).length > 0) {
      response.relays = {};
      for (const pubkey of Object.values(response.names)) {
        response.relays[pubkey] = defaultRelays;
      }
    }

    // If specific name requested but not found, return empty names
    if (name && Object.keys(response.names).length === 0) {
      return {
        body: { names: {} },
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': `public, max-age=${cacheTtlSeconds}`,
        },
        status: 200, // NIP-05 spec says return 200 with empty names, not 404
      };
    }

    return {
      body: response,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': `public, max-age=${cacheTtlSeconds}`,
      },
      status: 200,
    };
  };
}

/**
 * Validate a NIP-05 identifier format
 * @param identifier - The identifier to validate (e.g., "alice@example.com")
 */
export function isValidNip05Identifier(identifier: string): boolean {
  // NIP-05 format: <local-part>@<domain>
  const parts = identifier.split('@');
  if (parts.length !== 2) {
    return false;
  }

  const [localPart, domain] = parts;

  // Local part: alphanumeric, _, -
  if (!/^[a-z0-9_-]+$/i.test(localPart)) {
    return false;
  }

  // Domain: basic domain validation
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain)) {
    return false;
  }

  return true;
}

/**
 * Parse a NIP-05 identifier into its parts
 * @param identifier - The identifier to parse (e.g., "alice@example.com")
 */
export function parseNip05Identifier(identifier: string): {
  localPart: string;
  domain: string;
} | null {
  if (!isValidNip05Identifier(identifier)) {
    return null;
  }

  const [localPart, domain] = identifier.split('@');
  return { localPart, domain };
}
