/**
 * TweetSender — sends tweets via the SDK MessageClient
 *
 * The SDK transport comes from the messaging provider registry (populated by
 * `@happyvertical/smrt-messages/providers/twitter`) or constructor injection —
 * never a direct `@happyvertical/messages` import, which would drag the SDK
 * (and transitively googleapis/nodemailer via its email wrapper) into
 * provider-neutral consumer bundles (#1979).
 */

import type { Tweet } from '../models/Tweet';
import type { TwitterAccount } from '../models/TwitterAccount';
import { getMessagingProvider } from '../providers.js';
import type {
  MessageClientFactory,
  MessageSenderInterface,
  MessageSendResult,
  SendMessageOptions,
} from '../types';

export class TweetSender implements MessageSenderInterface {
  readonly providerType = 'twitter';
  private account: TwitterAccount;
  private createMessageClient?: MessageClientFactory;

  constructor(
    account: TwitterAccount,
    createMessageClient?: MessageClientFactory,
  ) {
    this.account = account;
    this.createMessageClient = createMessageClient;
  }

  isReady(): boolean {
    return this.account.isActive;
  }

  async send(
    message: Tweet,
    _options?: SendMessageOptions,
  ): Promise<MessageSendResult> {
    const createMessageClient =
      this.createMessageClient ??
      getMessagingProvider(this.providerType)?.createMessageClient;
    if (!createMessageClient) {
      return {
        success: false,
        error:
          "Twitter provider has no transport registered. Import '@happyvertical/smrt-messages/providers/twitter' (or '/providers/all') during server startup.",
        sentAt: new Date(),
      };
    }

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

    const client = await createMessageClient({
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
