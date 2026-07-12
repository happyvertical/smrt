import type { Account } from '../models/Account.js';
import type { Message } from '../models/Message.js';
import type {
  MessageSenderInterface,
  MessageSendResult,
  SendMessageOptions,
} from '../types.js';

export class TelegramSender implements MessageSenderInterface {
  readonly providerType = 'telegram';

  constructor(
    private readonly account: Account,
    private readonly fetcher: typeof fetch = globalThis.fetch,
  ) {}

  isReady(): boolean {
    return this.account.isActive && this.account.hasCredentials;
  }

  async send(
    input: unknown,
    _options?: SendMessageOptions,
  ): Promise<MessageSendResult> {
    const message = input as Message;
    const endpoint = await message.getEndpoint();
    if (endpoint?.channel !== 'telegram' || !endpoint.isActive) {
      return failed(
        'No active Telegram endpoint is associated with this message',
      );
    }

    const credentials = await this.account.getCredentials();
    const botToken =
      typeof credentials?.botToken === 'string' ? credentials.botToken : '';
    if (!botToken || !/^[A-Za-z0-9:_-]+$/.test(botToken)) {
      return failed('Telegram bot token is missing or invalid');
    }

    const address = endpoint.getAddress<{
      chatId?: string;
      threadId?: string | number;
    }>();
    if (!address.chatId)
      return failed('Telegram endpoint is missing a chat ID');

    const payload: Record<string, unknown> = {
      chat_id: address.chatId,
      text: message.body,
    };
    if (address.threadId !== undefined && address.threadId !== '') {
      const threadId = Number(address.threadId);
      if (!Number.isInteger(threadId) || threadId <= 0) {
        return failed('Telegram endpoint has an invalid topic/thread ID');
      }
      payload.message_thread_id = threadId;
    }

    try {
      const response = await this.fetcher(
        `https://api.telegram.org/bot${botToken}/sendMessage`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        },
      );
      const result = (await response.json()) as Record<string, unknown>;
      if (!response.ok || result.ok !== true) {
        return failed(
          typeof result.description === 'string'
            ? result.description
            : `Telegram returned ${response.status}`,
          result,
        );
      }
      const responseMessage = result.result as
        | Record<string, unknown>
        | undefined;
      return {
        success: true,
        providerMessageId: String(responseMessage?.message_id ?? ''),
        providerResponse: result,
        sentAt: new Date(),
      };
    } catch (error) {
      return failed(error instanceof Error ? error.message : String(error));
    }
  }
}

function failed(
  error: string,
  providerResponse?: Record<string, unknown>,
): MessageSendResult {
  return { success: false, error, providerResponse, sentAt: new Date() };
}
