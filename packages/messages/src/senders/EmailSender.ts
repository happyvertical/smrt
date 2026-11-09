import {
  assertProtectedEmailAdmission,
  assertProtectedEmailHandoff,
  ProtectedNotificationHandoffError,
} from '../protected-notification-handoff.js';
/**
 * EmailSender — sends email messages via the SDK EmailClient
 */

import type { Attachment, EmailClient } from '@happyvertical/email';
import type { Email } from '../models/Email';
import type { EmailAccount } from '../models/EmailAccount';
import type {
  MessageSenderInterface,
  MessageSendResult,
  SendEmailOptions,
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
    options?: SendEmailOptions,
  ): Promise<MessageSendResult> {
    const toAddresses = message.getToAddresses();
    const ccAddresses = message.getCcAddresses();
    const bccAddresses = message.getBccAddresses();

    // Resolve every attachment before anything reaches the transport: a file
    // that cannot be read fails the send instead of leaving silently (#3808).
    let attachments: Attachment[];
    try {
      await assertProtectedEmailAdmission(message, options);
      attachments = await this.collectAttachments(message, options);
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        sentAt: new Date(),
      };
    }

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
      attachments: attachments.length > 0 ? attachments : undefined,
    };

    try {
      await assertProtectedEmailHandoff(
        message,
        attachments as unknown as NonNullable<SendEmailOptions['attachments']>,
        options,
        emailMessage,
      );
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
        ...(error instanceof ProtectedNotificationHandoffError ||
        isDefiniteSendRejection(error)
          ? {}
          : { outcomeUnknown: true }),
        sentAt: new Date(),
      };
    }
  }

  /**
   * The message's stored `Attachment` rows followed by the send-time bytes.
   *
   * Stored rows are listed through the message's own options, so the lookup
   * runs under the same tenant context as the message. A row's file is read
   * through `Attachment.readContent()`, the package's one attachment-reading
   * seam, so the bytes are handed to the transport rather than a path it
   * would have to resolve itself.
   */
  private async collectAttachments(
    message: Email,
    options?: SendEmailOptions,
  ): Promise<Attachment[]> {
    const resolved: Attachment[] = [];

    // Only a message backed by a row can own attachment rows; an unsaved
    // draft sent directly through the sender has none to look up.
    const stored = message.isPersisted ? await message.getAttachments() : [];
    for (const attachment of stored) {
      if (
        message.tenantId &&
        attachment.tenantId &&
        attachment.tenantId !== message.tenantId
      ) {
        throw new Error(
          `Attachment "${attachment.filename}" belongs to another tenant than its message.`,
        );
      }
      if (!attachment.filePath) {
        throw new Error(
          `Attachment "${attachment.filename}" has no stored file to send` +
            (attachment.sourceUrl
              ? ' (a sourceUrl is not fetched at send time).'
              : '.'),
        );
      }
      const content = await attachment.readContent();
      if (!content) {
        throw new Error(
          `Attachment "${attachment.filename}" could not be read from "${attachment.filePath}": ` +
            'the file is missing or unreadable, or the files SDK is not loaded ' +
            '(see Attachment.readContent()).',
        );
      }
      resolved.push({
        filename: attachment.filename,
        contentType: attachment.contentType || 'application/octet-stream',
        size: content.length,
        content: Buffer.from(content),
        contentId: attachment.contentId || undefined,
        contentDisposition: attachment.contentDisposition,
      });
    }

    for (const attachment of options?.attachments ?? []) {
      if (!attachment.filename) {
        throw new Error('A send-time attachment needs a filename.');
      }
      if (!attachment.content) {
        throw new Error(
          `Send-time attachment "${attachment.filename}" has no content.`,
        );
      }
      // Own the bytes handed to the SDK so callers cannot mutate the approved
      // document while an asynchronous provider send is in flight.
      const content = Buffer.from(attachment.content);
      resolved.push({
        filename: attachment.filename,
        contentType: attachment.contentType || 'application/octet-stream',
        size: content.length,
        content,
        contentId: attachment.contentId,
        contentDisposition: attachment.contentDisposition ?? 'attachment',
      });
    }

    return resolved;
  }
}

/** Error codes the SDK email clients use for a send that was refused. */
const DEFINITE_EMAIL_ERROR_CODES = new Set([
  'AUTHENTICATION_ERROR',
  'AUTHORIZATION_ERROR',
  'INVALID_MESSAGE',
  'ATTACHMENT_ERROR',
]);

/** Socket errors raised before any connection to the server existed. */
const NEVER_CONNECTED_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'EAI_AGAIN',
]);

/**
 * Whether a provider send error proves the message was not accepted: the
 * server answered with an SMTP reply code, the SDK classified it as an
 * authentication/validation failure, a send error accepted no recipient, or
 * the connection was never made. Anything else (a timeout, a reset
 * connection, an unclassified error) may have happened after the server took
 * the message, so its outcome is unknown.
 */
export function isDefiniteSendRejection(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidates = [error, (error as { cause?: unknown }).cause].filter(
    (value): value is Record<string, unknown> =>
      !!value && typeof value === 'object',
  );
  for (const candidate of candidates) {
    if (typeof candidate.responseCode === 'number') return true;
    if (typeof candidate.code === 'string') {
      if (DEFINITE_EMAIL_ERROR_CODES.has(candidate.code)) return true;
      if (NEVER_CONNECTED_CODES.has(candidate.code)) return true;
    }
  }
  const sendError = error as { code?: unknown; accepted?: unknown };
  return (
    sendError.code === 'SEND_ERROR' &&
    Array.isArray(sendError.accepted) &&
    sendError.accepted.length === 0
  );
}
