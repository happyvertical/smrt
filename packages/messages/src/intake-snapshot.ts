import type { EmailMessage } from '@happyvertical/email';

/** Full-message byte snapshot for an already authorized, configured account. */
export interface EmailIntakeSnapshot {
  accountId: string;
  messageId: string;
  threadId: string;
  inReplyTo: string;
  subject: string;
  text: string;
  html: string;
  date: string;
  attachments: Array<{
    partId: string;
    filename: string;
    mediaType: string;
    bytes: Uint8Array;
  }>;
}

/** Safe machine-readable snapshot failure; never contains provider error details. */
export class EmailIntakeSnapshotError extends Error {
  override readonly name = 'EmailIntakeSnapshotError';
  constructor(
    public readonly category: 'invalid' | 'limit' | 'unavailable_bytes',
    message: string,
  ) {
    super(message);
  }
}

/** Copies actual provider bytes; missing bytes fail closed, never read provider-supplied paths. */
export function snapshotEmailForIntake(
  accountId: string,
  message: EmailMessage,
  maxBytes: number,
): EmailIntakeSnapshot {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
    throw new EmailIntakeSnapshotError('limit', 'Invalid email byte limit');
  if (!message.date || !Number.isFinite(message.date.getTime()))
    throw new EmailIntakeSnapshotError(
      'invalid',
      'Email capture date unavailable',
    );
  const body = {
    accountId,
    messageId: message.messageId || '',
    threadId: message.threadId || '',
    inReplyTo: message.inReplyTo || '',
    subject: message.subject || '',
    text: message.text || '',
    html: message.html || '',
    date: message.date.toISOString(),
  };
  let size = 0;
  const attachments = (message.attachments || []).map((attachment, index) => {
    if (!(attachment.content instanceof Uint8Array))
      throw new EmailIntakeSnapshotError(
        'unavailable_bytes',
        'Email attachment bytes unavailable',
      );
    size += attachment.content.byteLength;
    if (size > maxBytes)
      throw new EmailIntakeSnapshotError('limit', 'Email byte limit exceeded');
    return {
      partId: String(index),
      filename: attachment.filename || '',
      mediaType: attachment.contentType,
      bytes: attachment.content,
    };
  });
  // Match the message part preserved by EmailSourceAdapter, including JSON
  // delimiters, escaped/UTF-8 descriptors and the empty attachments array.
  size += Buffer.byteLength(
    JSON.stringify({
      ...body,
      attachments: attachments.map(({ partId, filename, mediaType }) => ({
        partId,
        filename,
        mediaType,
      })),
    }),
  );
  if (size > maxBytes)
    throw new EmailIntakeSnapshotError('limit', 'Email byte limit exceeded');
  return {
    ...body,
    attachments: attachments.map((attachment) => ({
      ...attachment,
      bytes: Buffer.from(attachment.bytes),
    })),
  };
}
