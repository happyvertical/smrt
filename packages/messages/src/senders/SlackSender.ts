/**
 * SlackSender — sends Slack messages via the SDK MessageClient
 */

import type { SlackAccount } from '../models/SlackAccount';
import type { SlackMessage } from '../models/SlackMessage';
import type {
  MessageSenderInterface,
  MessageSendResult,
  SendMessageOptions,
} from '../types';

export class SlackSender implements MessageSenderInterface {
  readonly providerType = 'slack';
  private account: SlackAccount;

  constructor(account: SlackAccount) {
    this.account = account;
  }

  isReady(): boolean {
    return this.account.isActive;
  }

  async send(
    message: SlackMessage,
    _options?: SendMessageOptions,
  ): Promise<MessageSendResult> {
    const { getMessageClient } = await import('@happyvertical/messages');

    const credentials = await this.account.getCredentials();
    if (!credentials?.botToken) {
      return {
        success: false,
        error: 'No botToken found in account credentials',
        sentAt: new Date(),
      };
    }

    const client = await getMessageClient({
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
        sentAt: result.timestamp,
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
