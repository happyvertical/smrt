import type { IntakePart } from '../server.js';
import {
  deliver,
  type SourceBinding,
  SourceInputError,
  type SourceResult,
  safeFailure,
  text,
} from './common.js';

/** Structural messages-owner seam; EmailAccount.readIntakeMessage implements this contract. */
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
export interface EmailDelivery {
  /** Provider/account-unique locator (e.g. folder + UIDVALIDITY + UID), not sender Message-ID alone. */
  locator: string;
  /** Explicit immutable source revision, never an automatically substituted content hash. */
  revision: string;
  checkpoint: string;
}
export interface EmailSourceOptions {
  binding: SourceBinding;
  accountId: string;
  readMessage(delivery: EmailDelivery): Promise<EmailIntakeSnapshot>;
  /** Durable host checkpoint; called in input order only after accepted/duplicate. */
  acknowledge(checkpoint: string): Promise<void>;
}
/** Opt-in intake: hosts enumerate configured accounts and supply resumable provider locators. */
export class EmailSourceAdapter {
  constructor(private readonly options: EmailSourceOptions) {}
  async receive(delivery: EmailDelivery): Promise<SourceResult> {
    const { binding } = this.options;
    if (!binding.enabled)
      return { kind: 'rejected', category: 'authentication' };
    try {
      text(delivery.locator);
      text(delivery.revision);
      text(delivery.checkpoint);
      const snapshot = await this.options.readMessage(delivery);
      if (snapshot.accountId !== this.options.accountId)
        return { kind: 'rejected', category: 'authentication' };
      const { attachments } = snapshot;
      // Transport objects may carry additional provider fields. Preserve only the contract.
      const body = {
        accountId: snapshot.accountId,
        messageId: snapshot.messageId,
        threadId: snapshot.threadId,
        inReplyTo: snapshot.inReplyTo,
        subject: snapshot.subject,
        text: snapshot.text,
        html: snapshot.html,
        date: snapshot.date,
      };
      if (Object.values(body).some((value) => typeof value !== 'string')) {
        throw new SourceInputError('invalid');
      }
      const parts: IntakePart[] = [
        {
          partId: 'message',
          mediaType: 'application/json',
          bytes: Buffer.from(JSON.stringify(body)),
          sourceReference: {
            owner: 'message',
            id: delivery.locator,
            version: delivery.revision,
          },
        },
      ];
      for (const attachment of attachments) {
        if (!(attachment.bytes instanceof Uint8Array))
          throw new SourceInputError('unavailable_bytes');
        parts.push({
          partId: `attachment:${text(attachment.partId)}`,
          parentPartId: 'message',
          mediaType: attachment.mediaType,
          bytes: attachment.bytes,
          sourceReference: {
            owner: 'message-attachment',
            id: `${delivery.locator}:${attachment.partId}`,
            version: delivery.revision,
          },
        });
      }
      // Filename and part mapping are retained alongside message/thread identity.
      parts[0].bytes = Buffer.from(
        JSON.stringify({
          ...body,
          attachments: attachments.map(({ partId, filename, mediaType }) => ({
            partId,
            filename,
            mediaType,
          })),
        }),
      );
      const result = await deliver(
        binding,
        JSON.stringify([
          this.options.accountId,
          delivery.locator,
          delivery.revision,
        ]),
        new Date(snapshot.date),
        parts,
      );
      if (result.kind === 'accepted' || result.kind === 'duplicate')
        await this.options.acknowledge(delivery.checkpoint);
      return result;
    } catch (error) {
      if (
        error instanceof Error &&
        error.name === 'EmailIntakeSnapshotError' &&
        'category' in error
      ) {
        const category = error.category;
        if (
          category === 'invalid' ||
          category === 'limit' ||
          category === 'unavailable_bytes'
        ) {
          return { kind: 'rejected', category };
        }
      }
      return safeFailure(error);
    }
  }
  async receiveBatch(
    deliveries: readonly EmailDelivery[],
  ): Promise<SourceResult[]> {
    const results: SourceResult[] = [];
    for (const delivery of deliveries) {
      const result = await this.receive(delivery);
      results.push(result);
      if (result.kind !== 'accepted' && result.kind !== 'duplicate') break;
    }
    return results;
  }
}
