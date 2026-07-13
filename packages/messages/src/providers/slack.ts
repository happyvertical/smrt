/**
 * Explicit Slack provider entry point (#1979).
 *
 * Importing this module registers the Slack messaging provider with a
 * functional transport backed by `@happyvertical/messages` (@slack/web-api).
 * Until a server imports it, provider-neutral consumers carry zero Slack-SDK
 * weight and `SlackSender.send()` returns an actionable failure result.
 *
 * @example
 * ```ts
 * // hooks.server.ts / server bootstrap
 * import '@happyvertical/smrt-messages/providers/slack';
 * ```
 */
import type { GetMessageClientOptions } from '@happyvertical/messages';
import type { SlackAccount } from '../models/SlackAccount.js';
import {
  ensureBuiltinMessagingProvidersRegistered,
  registerMessagingProvider,
} from '../providers.js';
import type { MessagingTransportClient } from '../types.js';

let registered = false;

/** Idempotently registers the Slack provider with its SDK transport. */
export function ensureSlackMessagingProvider(): void {
  if (registered) return;
  registered = true;

  ensureBuiltinMessagingProvidersRegistered();
  registerMessagingProvider({
    id: 'slack',
    label: 'Slack',
    channel: 'slack',
    available: true,
    configurationFields: [],
    credentialFields: [
      {
        id: 'botToken',
        label: 'Bot token',
        type: 'password',
        required: true,
      },
    ],
    endpointFields: [
      {
        id: 'channelId',
        label: 'Channel ID',
        type: 'string',
        required: true,
      },
    ],
    createSender: async (account) => {
      const { SlackSender } = await import('../senders/SlackSender.js');
      return new SlackSender(account as SlackAccount);
    },
    createMessageClient: async (config) => {
      const { getMessageClient } = await import('@happyvertical/messages');
      return (await getMessageClient(
        config as unknown as GetMessageClientOptions,
      )) as unknown as MessagingTransportClient;
    },
  });
}

ensureSlackMessagingProvider();
