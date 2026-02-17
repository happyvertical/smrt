/**
 * EmailSender — sends email messages via the SDK EmailClient
 */

import type { EmailClient } from '@happyvertical/email';
import type { Email } from '../models/Email';
import type { EmailAccount } from '../models/EmailAccount';
import type {
  MessageSenderInterface,
  MessageSendResult,
  SendMessageOptions,
} from '../types';

export class EmailSender implements MessageSenderInterface {
  readonly providerType = 'email';
  private client: EmailClient;
  private account: EmailAccount;

  constructor(client: EmailClient, account: EmailAccount) {
    this.client = client;
    this.account = account;
  }

  isReady(): boolean {
    return this.client.isConnected();
  }

  async send(
    message: Email,
    _options?: SendMessageOptions,
  ): Promise<MessageSendResult> {
    const toAddresses = message.getToAddresses();
    const ccAddresses = message.getCcAddresses();
    const bccAddresses = message.getBccAddresses();

    const emailMessage = {
      from: {
        name: message.fromName || this.account.name,
        address: message.fromAddress || this.account.email,
      },
      to: toAddresses.map((r) => ({
        name: r.name,
        address: r.address,
      })),
      cc:
        ccAddresses.length > 0
          ? ccAddresses.map((r) => ({ name: r.name, address: r.address }))
          : undefined,
      bcc:
        bccAddresses.length > 0
          ? bccAddresses.map((r) => ({ name: r.name, address: r.address }))
          : undefined,
      subject: message.subject,
      text: message.textBody || message.body,
      html: message.htmlBody || undefined,
      inReplyTo: message.inReplyTo || undefined,
    };

    try {
      const result = await this.client.send(emailMessage);

      return {
        success: true,
        providerMessageId: result.messageId,
        accepted: result.accepted,
        rejected: result.rejected,
        providerResponse: { response: result.response },
        sentAt: new Date(),
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
