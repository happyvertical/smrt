/**
 * The draft scope on unsent outgoing mail that is not flagged as a draft (#5657): attachments and messages by status.
 */

import { randomUUID } from 'node:crypto';
import {
  ApprovalService,
  createApprovalMailSendGate,
} from '@happyvertical/smrt-approvals';
import { getTestDatabase } from '@happyvertical/smrt-core/testing';
import {
  disableTenancy,
  enableTenancy,
  withSystemContext,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import {
  MembershipCollection,
  PermissionCollection,
  ResourceGrantCollection,
  RoleCollection,
  RolePermissionCollection,
  syncPermissionCatalog,
  TenantCollection,
  UserCollection,
} from '@happyvertical/smrt-users';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, type vi } from 'vitest';
import {
  configureMailAccess,
  MailAccessError,
  type MailPrincipal,
  type MailScope,
  resetMailAccess,
  runWithMailSystemAccess,
} from '../access.js';
import '../index.js';
import { MailDraftService } from '../mail-drafts.js';
import { Attachment } from '../models/Attachment';
import { Email } from '../models/Email';
import { EmailAccount } from '../models/EmailAccount';
import { Message } from '../models/Message';
import {
  configureMailSendApprovals,
  resetMailSendApprovals,
} from '../send-approval.js';
import { prepareMessageParents } from './fk-fixtures.js';

import {
  type Person,
  useMailDraftScopeFixture,
} from './helpers/mail-draft-scope-fixture.js';

describe('draft scope on unsent outgoing mail (#5657)', () => {
  const f = useMailDraftScopeFixture();
  const { principal, as, grant, seedReceived, load, exists } = f;
  let options: { db: DatabaseInterface };
  let tenantId: string;
  let owner: Person;
  let drafter: Person;
  let sender: Person;
  let stranger: Person;
  let ownedId: string;
  let openId: string;
  let providerSend: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    options = f.options;
    tenantId = f.tenantId;
    owner = f.owner;
    drafter = f.drafter;
    sender = f.sender;
    stranger = f.stranger;
    ownedId = f.ownedId;
    openId = f.openId;
    providerSend = f.providerSend;
  });

  describe('unsent outgoing mail that is not flagged as a draft (#5657)', () => {
    // The outbox and persona routes create these as `pending`; a failed send
    // keeps its row. `queued` stands for any status the package does not know.
    const STATES = ['pending', 'scheduled', 'sending', 'failed', 'queued'];

    const seedUnsent = (
      accountId: string,
      sendStatus: string,
      cls: 'email' | 'tweet' = 'email',
    ) =>
      withTenant({ tenantId }, () =>
        runWithMailSystemAccess(async () => {
          if (cls === 'tweet') {
            const { Tweet } = await import('../models/Tweet');
            const tweet = new Tweet({
              ...options,
              tenantId,
              accountId,
              sendStatus: sendStatus as never,
            });
            await tweet.initialize();
            await tweet.save();
            return tweet.id as string;
          }
          const email = new Email({
            ...options,
            tenantId,
            accountId,
            subject: `unsent-${sendStatus}`,
            isDraft: false,
            sendStatus: sendStatus as never,
          });
          await email.initialize();
          await email.save();
          return email.id as string;
        }),
      );

    const collection = () =>
      import('../collections/AttachmentCollection.js').then((m) =>
        m.AttachmentCollection.create(options),
      );

    const seedAttachment = (messageId: string, slug?: string) =>
      withTenant({ tenantId }, () =>
        runWithMailSystemAccess(async () => {
          const row = new Attachment({
            ...options,
            tenantId,
            messageId,
            filename: 'seed.txt',
          });
          if (slug) row.slug = slug;
          await row.initialize();
          await row.save();
          return row.id as string;
        }),
      );

    /** A handle loaded by trusted code; the write is then made as a principal. */
    const handle = (id: string) =>
      withTenant({ tenantId }, () =>
        runWithMailSystemAccess(async () => {
          const row = await (await collection()).get({ id });
          if (!row) throw new Error('missing attachment');
          return row;
        }),
      );

    const stored = (id: string) =>
      withTenant({ tenantId }, () =>
        runWithMailSystemAccess(async () => (await collection()).get({ id })),
      );

    const WITHOUT: Array<[string, () => MailPrincipal | null]> = [
      ['a principal with no grant', () => principal(stranger)],
      ['a reader', () => principal(drafter, { scopes: ['read'] })],
      ['a sender', () => principal(sender)],
      ['no principal', () => null],
    ];

    describe.each([
      ...STATES.map((s) => [s, 'email'] as const),
      ['pending', 'tweet'] as const,
    ])('attachments of a %s %s', (status, cls) => {
      describe.each(WITHOUT)('for %s', (_l, who) => {
        it('refuses to add one', async () => {
          const messageId = await seedUnsent(ownedId, status, cls);
          await expect(
            as(who(), async () => {
              const row = await (await collection()).create({
                tenantId,
                messageId,
                filename: 'added.txt',
              });
              return row.save();
            }),
          ).rejects.toBeInstanceOf(MailAccessError);
        });

        it('refuses to change one', async () => {
          const messageId = await seedUnsent(ownedId, status, cls);
          const row = await handle(await seedAttachment(messageId));
          await expect(
            as(who(), async () => {
              row.filename = 'changed.txt';
              return row.save();
            }),
          ).rejects.toBeInstanceOf(MailAccessError);
          expect((await stored(row.id as string))?.filename).toBe('seed.txt');
        });

        it('refuses to delete one', async () => {
          const messageId = await seedUnsent(ownedId, status, cls);
          const id = await seedAttachment(messageId);
          const row = await handle(id);
          await expect(as(who(), () => row.delete())).rejects.toBeInstanceOf(
            MailAccessError,
          );
          // A row closed to the principal is not even found by id.
          await as(who(), async () => (await collection()).delete(id)).catch(
            () => undefined,
          );
          expect(await stored(id)).toBeTruthy();
        });
      });

      it.each([
        ['the owner', () => principal(owner)],
        ['a draft grantee', () => principal(drafter)],
      ])('lets %s add, change and delete one', async (_l, who) => {
        const messageId = await seedUnsent(ownedId, status, cls);
        await as(who(), async () => {
          const row = await (await collection()).create({
            tenantId,
            messageId,
            filename: 'ok.txt',
          });
          await row.save();
          row.filename = 'renamed.txt';
          await row.save();
          await row.delete();
        });
      });
    });

    it('refuses to move an attachment onto or off an unsent message', async () => {
      const pending = await seedUnsent(ownedId, 'pending');
      const open = await seedUnsent(openId, 'pending');
      const onto = await handle(await seedAttachment(open));
      const off = await handle(await seedAttachment(pending));
      await expect(
        as(principal(stranger), async () => {
          onto.messageId = pending;
          return onto.save();
        }),
      ).rejects.toBeInstanceOf(MailAccessError);
      await expect(
        as(principal(drafter, { scopes: ['read'] }), async () => {
          off.messageId = open;
          return off.save();
        }),
      ).rejects.toBeInstanceOf(MailAccessError);
      expect((await stored(onto.id as string))?.messageId).toBe(open);
      expect((await stored(off.id as string))?.messageId).toBe(pending);
    });

    it('refuses a new attachment that takes over the key of a stored one', async () => {
      const pending = await seedUnsent(ownedId, 'pending');
      const open = await seedUnsent(openId, 'pending');
      const existing = await seedAttachment(pending, 'keyed-unsent');
      await expect(
        as(principal(stranger), async () => {
          const row = new Attachment({
            ...options,
            tenantId,
            messageId: open,
            filename: 'taken.txt',
          });
          row.slug = 'keyed-unsent';
          await row.initialize();
          return row.save();
        }),
      ).rejects.toBeInstanceOf(MailAccessError);
      expect((await stored(existing))?.messageId).toBe(pending);
    });

    it('refuses an attachment saved before its message exists', async () => {
      await expect(
        as(principal(stranger), async () => {
          const row = await (await collection()).create({
            tenantId,
            messageId: randomUUID(),
            filename: 'early.txt',
          });
          return row.save();
        }),
      ).rejects.toThrow();
    });

    it('leaves unowned and sent mail alone', async () => {
      const openPending = await seedUnsent(openId, 'pending');
      const sent = await seedUnsent(ownedId, 'sent');
      await as(principal(stranger), async () => {
        for (const messageId of [openPending, sent]) {
          const row = await (await collection()).create({
            tenantId,
            messageId,
            filename: 'ok.txt',
          });
          await row.save();
          await row.delete();
        }
      });
    });

    it('lets trusted work write attachments of unsent messages', async () => {
      const pending = await seedUnsent(ownedId, 'pending');
      const id = await seedAttachment(pending);
      await withTenant({ tenantId }, () =>
        runWithMailSystemAccess(async () => {
          const row = await (await collection()).get({ id });
          if (!row) throw new Error('missing');
          row.filename = 'synced.txt';
          await row.save();
          await row.delete();
        }),
      );
      expect(await stored(id)).toBeNull();
    });

    describe('the message itself', () => {
      it.each(
        WITHOUT.filter(([l]) => l !== 'no principal'),
      )('refuses %s an edit, a relabel or a delete of a stored one', async (_l, who) => {
        for (const status of STATES) {
          const id = await seedUnsent(ownedId, status);
          const email = await load(id);
          await expect(
            as(who(), async () => {
              email.subject = 'rewritten';
              return email.save();
            }),
          ).rejects.toBeInstanceOf(MailAccessError);
          for (const relabel of ['sent', 'draft']) {
            const again = await load(id);
            await expect(
              as(who(), async () => {
                again.sendStatus = relabel as never;
                return again.save();
              }),
            ).rejects.toBeInstanceOf(MailAccessError);
          }
          await expect(
            as(who(), async () => (await load(id)).delete()),
          ).rejects.toBeInstanceOf(MailAccessError);
          const row = await load(id);
          expect(row.subject).toBe(`unsent-${status}`);
          expect(row.sendStatus).toBe(status);
        }
      });

      it('refuses to move a stored plain row into an outgoing status', async () => {
        const id = await seedUnsent(ownedId, 'draft');
        await expect(
          as(principal(drafter, { scopes: ['read'] }), async () => {
            const email = await load(id);
            email.sendStatus = 'pending';
            return email.save();
          }),
        ).rejects.toBeInstanceOf(MailAccessError);
        expect((await load(id)).sendStatus).toBe('draft');
      });

      it('lets a draft grantee and the owner edit one', async () => {
        for (const who of [principal(drafter), principal(owner)]) {
          const id = await seedUnsent(ownedId, 'pending');
          await as(who, async () => {
            const email = await load(id);
            email.subject = 'edited';
            await email.save();
          });
          expect((await load(id)).subject).toBe('edited');
        }
      });

      it('leaves received and sent mail alone', async () => {
        const received = await seedReceived(ownedId);
        const sent = await seedUnsent(ownedId, 'sent');
        await as(principal(owner), async () => {
          for (const id of [received, sent]) {
            const email = await load(id);
            email.isRead = true;
            await email.save();
          }
        });
      });

      it('lets a sender send a queued message and record its failure', async () => {
        const id = await seedUnsent(ownedId, 'pending');
        await withTenant({ tenantId }, () =>
          runWithMailSystemAccess(async () => {
            const email = await load(id);
            email.fromAddress = 'owned@example.com';
            email.setToAddresses([{ address: 'to@example.com' }]);
            await email.save();
          }),
        );
        const result = await as(principal(sender), async () =>
          (await load(id)).send(),
        );
        expect(result.success).toBe(true);
        expect((await load(id)).sendStatus).toBe('sent');

        const failing = await seedUnsent(ownedId, 'pending');
        providerSend.mockResolvedValueOnce({
          success: false,
          error: 'refused',
          sentAt: new Date(),
        });
        await withTenant({ tenantId }, () =>
          runWithMailSystemAccess(async () => {
            const email = await load(failing);
            email.fromAddress = 'owned@example.com';
            email.setToAddresses([{ address: 'to@example.com' }]);
            await email.save();
          }),
        );
        await as(principal(sender), async () => (await load(failing)).send());
        expect((await load(failing)).sendStatus).toBe('failed');
      });

      it('holds an agent send of a queued message and of a fresh one', async () => {
        const agent = principal(sender, { kind: 'agent', id: 'agent' });
        const stored = await seedUnsent(ownedId, 'pending');
        await withTenant({ tenantId }, () =>
          runWithMailSystemAccess(async () => {
            const email = await load(stored);
            email.fromAddress = 'owned@example.com';
            await email.save();
          }),
        );
        const held = await as(agent, async () => (await load(stored)).send());
        expect(held.pendingApproval?.created).toBe(true);
        expect((await load(stored)).sendStatus).toBe('draft');
        // The held message is a flagged draft, so it stays under the scope.
        expect((await load(stored)).isDraft).toBe(true);
        await expect(
          as(principal(drafter, { scopes: ['read'] }), async () => {
            const row = await (await collection()).create({
              tenantId,
              messageId: stored,
              filename: 'late.txt',
            });
            return row.save();
          }),
        ).rejects.toBeInstanceOf(MailAccessError);
        // An agent with only the send scope cannot create the row to hold.
        await expect(
          as(agent, async () => {
            const email = new Email({
              ...options,
              tenantId,
              accountId: ownedId,
              subject: 'fresh',
              fromAddress: 'owned@example.com',
              sendStatus: 'pending',
            });
            await email.initialize();
            return email.save();
          }),
        ).rejects.toBeInstanceOf(MailAccessError);
        expect(providerSend).not.toHaveBeenCalled();
      });
    });
  });
});
