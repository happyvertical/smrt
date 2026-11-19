/**
 * Mail drafts for people and agents (smrt#5141, Epic I).
 *
 * `MailDraftService.save()` creates or updates a local draft `Email` on one
 * mail account, under the host-supplied acting principal:
 *
 * - The principal needs the `draft` scope on the account (and `read` to reply
 *   to a message there). Fail closed, like every mail access decision.
 * - The draft is always from the account's own address: sending as another
 *   person is not possible through this service.
 * - Only an unsent draft (`isDraft`, `sendStatus` `draft`) of the same
 *   account can be updated. Updating a draft that waits for approval changes
 *   its content, so the waiting approval no longer applies to it.
 * - The acting principal is recorded as "handled by".
 *
 * `submit()` sends the draft through `Message.send()`, so the account's agent
 * send policy decides whether an agent's draft leaves or waits for a person.
 * Drafts are local rows; writing them to the mail server is a later step.
 *
 * @packageDocumentation
 */

import {
  ObjectRegistry,
  type SmrtClassOptions,
} from '@happyvertical/smrt-core';
import {
  assertMailAccess,
  MailAccessError,
  resolveMailPrincipal,
  runWithMailSystemAccess,
  withoutListBounds,
} from './access.js';
import type { Email } from './models/Email.js';
import type { EmailAccount } from './models/EmailAccount.js';
import { auditMailAction, stampHandledBy } from './send-approval.js';
import type { MessageSendResult, SendEmailOptions } from './types.js';

type Recipient = { address: string; name?: string };

export interface MailDraftInput {
  /** The mail account the draft is sent from. */
  accountId: string;
  /** Update this draft instead of creating one. */
  draftId?: string;
  /** Create a reply to this message (new drafts only). */
  inReplyToMessageId?: string;
  /** With `inReplyToMessageId`: copy the original To and Cc. */
  replyAll?: boolean;
  subject?: string;
  textBody?: string;
  htmlBody?: string;
  toAddresses?: Recipient[];
  ccAddresses?: Recipient[];
  bccAddresses?: Recipient[];
}

export class MailDraftError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'MailDraftError';
    this.status = status;
  }
}

function assertRecipients(value: unknown, label: string): void {
  if (value === undefined) return;
  if (
    !Array.isArray(value) ||
    value.some(
      (entry) =>
        !entry ||
        typeof entry.address !== 'string' ||
        !entry.address.includes('@') ||
        (entry.name !== undefined && typeof entry.name !== 'string'),
    )
  ) {
    throw new MailDraftError(`${label} must be a list of { address, name? }.`);
  }
}

export class MailDraftService {
  constructor(private readonly options: SmrtClassOptions) {}

  private async account(accountId: string): Promise<EmailAccount> {
    const { EmailAccountCollection } = await import(
      './collections/EmailAccountCollection.js'
    );
    const account = (await runWithMailSystemAccess(async () =>
      (
        await EmailAccountCollection.create(withoutListBounds(this.options))
      ).get({ id: accountId }),
    )) as EmailAccount | null;
    if (!account?.id) {
      throw new MailDraftError('Mail account not found.', 404);
    }
    return account;
  }

  private async stored(id: string): Promise<Email | null> {
    const { EmailCollection } = await import(
      './collections/EmailCollection.js'
    );
    return (await runWithMailSystemAccess(async () =>
      (await EmailCollection.create(this.options as never)).get({ id }),
    )) as Email | null;
  }

  /** Create or update a draft. Returns the saved draft. */
  async save(input: MailDraftInput): Promise<Email> {
    assertRecipients(input.toAddresses, 'toAddresses');
    assertRecipients(input.ccAddresses, 'ccAddresses');
    assertRecipients(input.bccAddresses, 'bccAddresses');
    const account = await this.account(input.accountId);
    const principal = await resolveMailPrincipal();
    if (
      principal &&
      account.tenantId &&
      principal.tenantId !== account.tenantId
    ) {
      throw new MailAccessError('draft', 'tenant_mismatch');
    }
    await assertMailAccess(account, 'draft');

    let draft: Email;
    if (input.draftId) {
      const existing = await this.stored(input.draftId);
      if (!existing || existing.accountId !== account.id) {
        throw new MailDraftError('Draft not found.', 404);
      }
      if (!existing.isDraft || existing.sendStatus !== 'draft') {
        throw new MailDraftError('Only an unsent draft can be changed.', 409);
      }
      draft = existing;
    } else if (input.inReplyToMessageId) {
      await assertMailAccess(account, 'read');
      const original = await this.stored(input.inReplyToMessageId);
      if (!original || original.accountId !== account.id) {
        throw new MailDraftError('Message not found.', 404);
      }
      draft = original.createReply({ replyAll: input.replyAll === true });
      await draft.initialize();
    } else {
      const { Email: EmailClass } = await import('./models/Email.js');
      const Draft = ObjectRegistry.resolveEffectiveConstructor(EmailClass);
      draft = new Draft({
        ...(this.options as Record<string, unknown>),
        tenantId: account.tenantId,
        accountId: account.id as string,
        isDraft: true,
        sendStatus: 'draft',
        isRead: true,
        toAddresses: '[]',
        ccAddresses: '[]',
        bccAddresses: '[]',
      });
      await draft.initialize();
    }

    if (input.subject !== undefined) draft.subject = input.subject;
    if (input.textBody !== undefined) {
      draft.textBody = input.textBody;
      draft.body = input.textBody;
    }
    if (input.htmlBody !== undefined) draft.htmlBody = input.htmlBody;
    if (input.toAddresses !== undefined)
      draft.toAddresses = JSON.stringify(input.toAddresses);
    if (input.ccAddresses !== undefined)
      draft.ccAddresses = JSON.stringify(input.ccAddresses);
    if (input.bccAddresses !== undefined)
      draft.bccAddresses = JSON.stringify(input.bccAddresses);
    // Always from the account's own address (no sending as someone else).
    draft.fromAddress = account.email;
    draft.tenantId = account.tenantId;
    draft.accountId = account.id as string;
    draft.isDraft = true;
    draft.sendStatus = 'draft';
    draft.updatedAt = new Date();
    stampHandledBy(draft, principal);
    await draft.save();
    await auditMailAction('messages.draft.save', draft);
    return draft;
  }

  /**
   * Send a draft. The account's agent send policy applies: an agent's draft
   * normally comes back with `pendingApproval` and waits for a person.
   */
  async submit(
    draftId: string,
    options?: SendEmailOptions,
  ): Promise<MessageSendResult> {
    const draft = await this.stored(draftId);
    if (!draft?.accountId || !draft.isDraft) {
      throw new MailDraftError('Draft not found.', 404);
    }
    const account = await this.account(draft.accountId);
    await assertMailAccess(account, 'draft');
    return await draft.send(options);
  }
}
