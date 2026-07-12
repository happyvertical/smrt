import type { Account } from '../models/Account.js';
import type { Message } from '../models/Message.js';
import type {
  MessageSenderInterface,
  MessageSendResult,
  SendMessageOptions,
} from '../types.js';

export class ZulipSender implements MessageSenderInterface {
  readonly providerType = 'zulip';

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
    if (endpoint?.channel !== 'zulip' || !endpoint.isActive) {
      return failed('No active Zulip endpoint is associated with this message');
    }

    const configuration = this.account.getConfiguration();
    const credentials = await this.account.getCredentials();
    const site =
      typeof configuration.site === 'string' ? configuration.site : '';
    const email =
      typeof configuration.email === 'string' ? configuration.email : '';
    const apiKey =
      typeof credentials?.apiKey === 'string' ? credentials.apiKey : '';
    if (!site || !email || !apiKey)
      return failed('Zulip account is not configured');

    let apiUrl: URL;
    try {
      apiUrl = new URL('/api/v1/messages', site);
      if (!['http:', 'https:'].includes(apiUrl.protocol)) throw new Error();
    } catch {
      return failed('Zulip site must be a valid HTTP(S) URL');
    }

    const address = endpoint.getAddress<{
      type?: string;
      to?: string;
      topic?: string;
    }>();
    if (
      (address.type !== 'stream' && address.type !== 'private') ||
      !address.to
    ) {
      return failed('Zulip endpoint is missing a valid type or destination');
    }

    const form = new URLSearchParams({
      type: address.type,
      to: address.to,
      content: message.body,
    });
    if (address.type === 'stream') {
      form.set('topic', address.topic || message.subject || 'Agent message');
    }

    try {
      const response = await this.fetcher(apiUrl, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${Buffer.from(`${email}:${apiKey}`).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: form,
      });
      const payload = (await response.json()) as Record<string, unknown>;
      if (!response.ok || payload.result !== 'success') {
        return failed(
          typeof payload.msg === 'string'
            ? payload.msg
            : `Zulip returned ${response.status}`,
          payload,
        );
      }
      return {
        success: true,
        providerMessageId: String(payload.id ?? ''),
        providerResponse: payload,
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
