/**
 * Explicit Twitter provider entry point (#1979).
 *
 * Importing this module registers the Twitter messaging provider with a
 * functional transport backed by `@happyvertical/messages`. Until a server
 * imports it, provider-neutral consumers carry zero Twitter-SDK weight and
 * `TweetSender.send()` returns an actionable failure result.
 *
 * @example
 * ```ts
 * // hooks.server.ts / server bootstrap
 * import '@happyvertical/smrt-messages/providers/twitter';
 * ```
 */
import type { GetMessageClientOptions } from '@happyvertical/messages';
import type { TwitterAccount } from '../models/TwitterAccount.js';
import {
  ensureBuiltinMessagingProvidersRegistered,
  registerMessagingProvider,
} from '../providers.js';
import type { MessagingTransportClient } from '../types.js';

let registered = false;

/** Idempotently registers the Twitter provider with its SDK transport. */
export function ensureTwitterMessagingProvider(): void {
  if (registered) return;
  registered = true;

  ensureBuiltinMessagingProvidersRegistered();
  registerMessagingProvider({
    id: 'twitter',
    label: 'Twitter / X',
    channel: 'twitter',
    available: true,
    configurationFields: [],
    credentialFields: [
      { id: 'apiKey', label: 'API key', type: 'password', required: true },
      {
        id: 'apiSecret',
        label: 'API secret',
        type: 'password',
        required: true,
      },
      {
        id: 'accessToken',
        label: 'Access token',
        type: 'password',
        required: true,
      },
      {
        id: 'accessSecret',
        label: 'Access token secret',
        type: 'password',
        required: true,
      },
    ],
    endpointFields: [],
    createSender: async (account) => {
      const { TweetSender } = await import('../senders/TweetSender.js');
      return new TweetSender(account as TwitterAccount);
    },
    createMessageClient: async (config) => {
      const { getMessageClient } = await import('@happyvertical/messages');
      return (await getMessageClient(
        config as unknown as GetMessageClientOptions,
      )) as unknown as MessagingTransportClient;
    },
  });
}

ensureTwitterMessagingProvider();
