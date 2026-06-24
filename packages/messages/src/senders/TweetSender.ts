/**
 * TweetSender — sends tweets via the SDK MessageClient
 */

import type { Tweet } from '../models/Tweet';
import type { TwitterAccount } from '../models/TwitterAccount';
import type {
  MessageSenderInterface,
  MessageSendResult,
  SendMessageOptions,
} from '../types';

export class TweetSender implements MessageSenderInterface {
  readonly providerType = 'twitter';
  private account: TwitterAccount;

  constructor(account: TwitterAccount) {
    this.account = account;
  }

  isReady(): boolean {
    return this.account.isActive;
  }

  async send(
    message: Tweet,
    _options?: SendMessageOptions,
  ): Promise<MessageSendResult> {
    const { getMessageClient } = await import('@happyvertical/messages');

    const credentials = await this.account.getCredentials();
    if (
      !credentials?.apiKey ||
      !credentials?.apiSecret ||
      !credentials?.accessToken ||
      !credentials?.accessSecret
    ) {
      return {
        success: false,
        error: 'Missing Twitter API credentials in account',
        sentAt: new Date(),
      };
    }

    const client = await getMessageClient({
      type: 'twitter',
      apiKey: credentials.apiKey as string,
      apiSecret: credentials.apiSecret as string,
      accessToken: credentials.accessToken as string,
      accessSecret: credentials.accessSecret as string,
    });

    try {
      const sendOptions: Record<string, string> = {};
      if (message.isReply && message.inReplyToMessageId) {
        sendOptions.replyTo = message.inReplyToMessageId;
      }

      const result = await client.send(
        {
          from: { id: this.account.twitterUserId, name: this.account.handle },
          content: message.body,
        },
        sendOptions.replyTo ? { replyTo: sendOptions.replyTo } : undefined,
      );

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
