/**
 * SlackSender — sends Slack messages via the SDK MessageClient
 *
 * The SDK transport comes from the messaging provider registry (populated by
 * `@happyvertical/smrt-messages/providers/slack`) or constructor injection —
 * never a direct `@happyvertical/messages` import, which would drag the SDK
 * (and transitively googleapis/nodemailer via its email wrapper) into
 * provider-neutral consumer bundles (#1979).
 */

import type { SlackAccount } from '../models/SlackAccount';
import type { SlackMessage } from '../models/SlackMessage';
import { getMessagingProvider } from '../providers.js';
import type {
  MessageClientFactory,
  MessageSenderInterface,
  MessageSendResult,
  SendMessageOptions,
} from '../types';

export class SlackSender implements MessageSenderInterface {
  readonly providerType = 'slack';
  private account: SlackAccount;
  private createMessageClient?: MessageClientFactory;

  constructor(
    account: SlackAccount,
    createMessageClient?: MessageClientFactory,
  ) {
    this.account = account;
    this.createMessageClient = createMessageClient;
  }

  isReady(): boolean {
    return this.account.isActive;
  }

  async send(
    message: SlackMessage,
    _options?: SendMessageOptions,
  ): Promise<MessageSendResult> {
    const createMessageClient =
      this.createMessageClient ??
      getMessagingProvider(this.providerType)?.createMessageClient;
    if (!createMessageClient) {
      return {
        success: false,
        error:
          "Slack provider has no transport registered. Import '@happyvertical/smrt-messages/providers/slack' (or '/providers/all') during server startup.",
        sentAt: new Date(),
      };
    }

    const credentials = await this.account.getCredentials();
    if (!credentials?.botToken) {
      return {
        success: false,
        error: 'No botToken found in account credentials',
        sentAt: new Date(),
      };
    }

    const client = await createMessageClient({
      type: 'slack',
      botToken: credentials.botToken as string,
    });

    try {
      await client.connect();

      const result = await client.send(
        {
          from: { id: this.account.botUserId, name: this.account.name },
          channelId: message.channelId,
          content: message.body,
        },
        {
          replyTo: message.slackThreadTs || undefined,
        },
      );

      await client.disconnect();

      return {
        success: result.success,
        providerMessageId: result.messageId,
        providerResponse: result.providerResponse,
        sentAt: result.timestamp ?? new Date(),
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        sentAt: new Date(),
      };
    }
  }
}
