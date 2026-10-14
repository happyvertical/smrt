import { createRuntimeReportsHttpClient } from './client.js';
import type { RuntimeReportsClient } from './types.js';

let client: RuntimeReportsClient | undefined;
let identityKey = '';

export interface RuntimeReportsBrowserClientOptions {
  /** Opaque host key for the active tenant/session; carries no request authority. */
  scopeKey?: string;
  currentUserId?: string;
  canArchive?: boolean;
}

/** One client per browser session so non-persistent last-run hints survive navigation. */
export function getRuntimeReportsBrowserClient(
  options: RuntimeReportsBrowserClientOptions = {},
): RuntimeReportsClient {
  if (typeof window === 'undefined')
    throw new Error(
      'The runtime reports browser client is unavailable during SSR',
    );
  // Route hosts pass server-derived identity and capability hints. Recreate the
  // session client when that principal changes so hints never cross sessions.
  const nextIdentityKey = `${options.scopeKey ?? ''}:${options.currentUserId ?? ''}:${options.canArchive === true}`;
  if (!client || identityKey !== nextIdentityKey) {
    client = createRuntimeReportsHttpClient(options);
    identityKey = nextIdentityKey;
  }
  return client;
}
