/**
 * The draft scope on fresh outgoing rows, received mail, sent records, triage and orphaned queued rows (#5657).
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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

describe('draft scope on queued, received and sent mail (#5657)', () => {
  const f = useMailDraftScopeFixture();
  const {
    principal,
    as,
    grant,
    seedAccount,
    seedReceived,
    countBySubject,
    load,
    exists,
  } = f;
  let db: DatabaseInterface;
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
    db = f.db;
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

  describe('fresh outgoing rows, received mail and triage (#5657)', () => {
    const FRESH = [
      'draft',
      'pending',
      'scheduled',
      'sending',
      'failed',
      'queued',
    ];
    const DENIED: Array<[string, () => MailPrincipal | null]> = [
      ['a principal with no grant', () => principal(stranger)],
      ['a reader', () => principal(drafter, { scopes: ['read'] })],
      ['a sender', () => principal(sender)],
      ['no principal', () => null],
    ];
    const emails = async () =>
      (
        await import('../collections/EmailCollection.js')
      ).EmailCollection.create(options);
    const system = <T>(fn: () => Promise<T>) =>
      withTenant({ tenantId }, () => runWithMailSystemAccess(fn));

    const seed = (fields: Record<string, unknown>) =>
      system(async () => {
        const email = new Email({
          ...options,
          tenantId,
          accountId: ownedId,
          fromAddress: 'owned@example.com',
          ...fields,
        } as never);
        await email.initialize();
        await email.save();
        return email.id as string;
      });

    describe.each(DENIED)('fresh rows for %s', (_label, who) => {
      it.each(
        FRESH,
      )('refuses a fresh %s row by instance save and collection create', async (status) => {
        const subject = `fresh-${status}`;
        await expect(
          as(who(), async () => {
            const email = new Email({
              ...options,
              tenantId,
              accountId: ownedId,
              subject,
              sendStatus: status as never,
            });
            await email.initialize();
            return email.save();
          }),
        ).rejects.toBeInstanceOf(MailAccessError);
        await expect(
          as(who(), async () =>
            (
              await (
                await emails()
              ).create({
                tenantId,
                accountId: ownedId,
                subject,
                sendStatus: status,
              })
            ).save(),
          ),
        ).rejects.toBeInstanceOf(MailAccessError);
        expect(await countBySubject(subject)).toBe(0);
      });
    });

    it.each(
      FRESH,
    )('lets the owner and a draft grantee create a fresh %s row', async (status) => {
      for (const who of [principal(owner), principal(drafter)]) {
        const subject = `ok-${status}-${randomUUID()}`;
        await as(who, async () => {
          const email = new Email({
            ...options,
            tenantId,
            accountId: ownedId,
            subject,
            sendStatus: status as never,
          });
          await email.initialize();
          await email.save();
        });
        expect(await countBySubject(subject)).toBe(1);
      }
    });

    it('lets trusted work and unowned accounts create queued rows', async () => {
      await seed({ subject: 'trusted', sendStatus: 'pending' });
      await as(principal(stranger), async () => {
        const email = new Email({
          ...options,
          tenantId,
          accountId: openId,
          subject: 'open-queued',
          sendStatus: 'pending',
        });
        await email.initialize();
        await email.save();
      });
    });

    describe('the persona route', () => {
      const route = async () => {
        const { MessagingEndpoint } = await import(
          '../models/MessagingEndpoint.js'
        );
        const { PersonaMessageRoute } = await import(
          '../models/PersonaMessageRoute.js'
        );
        const personaId = randomUUID();
        await withTenant({ tenantId }, async () => {
          const endpoint = new MessagingEndpoint({
            ...options,
            tenantId,
            label: 'Me',
            channel: 'email',
            address: JSON.stringify({ email: 'to@example.com' }),
          });
          await endpoint.initialize();
          await endpoint.save();
          const row = new PersonaMessageRoute({
            ...options,
            tenantId,
            personaId,
            accountId: ownedId,
            endpointId: endpoint.id as string,
            purpose: 'default',
            priority: 1,
          });
          await row.initialize();
          await row.save();
        });
        return personaId;
      };
      const service = async () => {
        const { PersonaMessagingService } = await import(
          '../services/PersonaMessagingService.js'
        );
        const { messagingPrincipalFromPermissions, SEND_MESSAGES_PERMISSION } =
          await import('../permissions.js');
        return new PersonaMessagingService({
          ...options,
          tenantId,
          principal: messagingPrincipalFromPermissions(
            [SEND_MESSAGES_PERMISSION],
            { tenantId },
          ),
        });
      };

      it('queues and sends for a principal with the send scope only', async () => {
        const personaId = await route();
        const result = await as(principal(sender), async () =>
          (await service()).send({ personaId, body: 'hello' }),
        );
        expect(result.messageId).toBeTruthy();
        expect(await exists(result.messageId)).toBe(true);
      });

      it.each(
        DENIED.filter(([l]) => l !== 'a sender'),
      )('stores nothing for %s', async (_l, who) => {
        const personaId = await route();
        await expect(
          as(who(), async () =>
            (await service()).send({ personaId, body: 'never stored' }),
          ),
        ).rejects.toBeInstanceOf(MailAccessError);
        expect(await countBySubject('')).toBe(await countBySubject(''));
        expect(providerSend).not.toHaveBeenCalled();
      });

      it('does not let the queued-create path overwrite a stored row', async () => {
        const id = await seed({ subject: 'stored', sendStatus: 'pending' });
        const { saveQueuedForSend } = await import('../models/Message.js');
        await expect(
          as(principal(sender), async () => {
            const email = new Email({ ...options, id, tenantId });
            await email.initialize();
            email.subject = 'overwritten';
            return saveQueuedForSend(email);
          }),
        ).rejects.toBeInstanceOf(MailAccessError);
        expect((await load(id)).subject).toBe('stored');
      });
    });

    describe('sent mail is a record', () => {
      it.each([
        ['a reader', () => principal(drafter, { scopes: ['read'] })],
        ['a draft grantee', () => principal(drafter)],
        ['the owner', () => principal(owner)],
        ['a sender', () => principal(sender)],
      ])('refuses %s moving a stored sent row out of sent', async (_l, who) => {
        for (const status of ['draft', 'pending', 'failed']) {
          const id = await seed({ subject: 'record', sendStatus: 'sent' });
          await expect(
            as(who(), async () => {
              const email = await load(id);
              email.sendStatus = status as never;
              email.subject = 'rewritten';
              return email.save();
            }),
          ).rejects.toBeInstanceOf(MailAccessError);
          // The same through a new object that carries the stored id.
          await expect(
            as(who(), async () => {
              const email = new Email({ ...options, id, tenantId });
              await email.initialize();
              email.sendStatus = status as never;
              return email.save();
            }),
          ).rejects.toBeInstanceOf(MailAccessError);
          const row = await load(id);
          expect(row.sendStatus).toBe('sent');
          expect(row.subject).toBe('record');
        }
      });

      it('does not let sync-style system work be refused', async () => {
        const id = await seed({ subject: 'record', sendStatus: 'sent' });
        await system(async () => {
          const email = await load(id);
          email.sendStatus = 'failed';
          await email.save();
        });
        expect((await load(id)).sendStatus).toBe('failed');
      });
    });

    describe('received mail', () => {
      const rewrite = async (id: string, who: MailPrincipal | null) =>
        as(who, async () => {
          const email = await load(id);
          email.body = 'rewritten';
          email.setToAddresses([{ address: 'attacker@example.com' }]);
          return email.save();
        });

      it('cannot be rewritten without the draft scope', async () => {
        const id = await seedReceived(ownedId);
        for (const who of [
          principal(stranger),
          principal(drafter, { scopes: ['read'] }),
          principal(sender),
        ]) {
          await expect(rewrite(id, who)).rejects.toBeInstanceOf(
            MailAccessError,
          );
        }
        expect((await load(id)).body).not.toBe('rewritten');
      });

      it('takes no attachment without the draft scope, but may lose one', async () => {
        const id = await seedReceived(ownedId);
        const attachments = await import(
          '../collections/AttachmentCollection.js'
        );
        await expect(
          as(principal(drafter, { scopes: ['read'] }), async () =>
            (
              await (
                await attachments.AttachmentCollection.create(options)
              ).create({
                tenantId,
                messageId: id,
                filename: 'planted.txt',
              })
            ).save(),
          ),
        ).rejects.toBeInstanceOf(MailAccessError);
      });

      it('is never sent, by any principal', async () => {
        const id = await seedReceived(ownedId);
        const result = await as(principal(sender), async () =>
          (await load(id)).send(),
        );
        expect(result.success).toBe(false);
        expect(providerSend).not.toHaveBeenCalled();
        const again = await system(async () => (await load(id)).send());
        expect(again.success).toBe(false);
        expect(providerSend).not.toHaveBeenCalled();
      });

      it('cannot be made sendable without the draft scope', async () => {
        for (const change of [
          (e: Email) => {
            e.sendStatus = 'pending';
          },
          (e: Email) => {
            e.isDraft = true;
          },
          (e: Email) => {
            e.messageId = '';
            e.folderId = '';
          },
        ]) {
          const id = await seedReceived(ownedId);
          await expect(
            as(principal(drafter, { scopes: ['read'] }), async () => {
              const email = await load(id);
              email.body = 'rewritten';
              change(email);
              return email.save();
            }),
          ).rejects.toBeInstanceOf(MailAccessError);
          expect((await load(id)).body).not.toBe('rewritten');
        }
      });

      it('lets a draft grantee turn it into a reply draft they then own', async () => {
        const id = await seedReceived(ownedId);
        await as(principal(drafter), async () => {
          const email = await load(id);
          email.isDraft = true;
          await email.save();
        });
        expect((await load(id)).isDraft).toBe(true);
      });

      it('cannot be forged without the draft scope', async () => {
        await expect(
          as(principal(stranger), async () => {
            const email = new Email({
              ...options,
              tenantId,
              accountId: ownedId,
              subject: 'forged',
              messageId: '<forged@example.com>',
            });
            await email.initialize();
            return email.save();
          }),
        ).rejects.toBeInstanceOf(MailAccessError);
      });

      it('may be deleted by a reader, and a provider-id-only row counts as received', async () => {
        const id = await seed({
          subject: 'synced',
          providerMessageId: 'uid-1',
        });
        await as(principal(drafter, { scopes: ['read'] }), async () =>
          (await load(id)).delete(),
        );
        expect(await exists(id)).toBe(false);
      });

      it('keeps a plain row with no provider id under the scope', async () => {
        const id = await seed({ subject: 'plain' });
        await expect(
          rewrite(id, principal(drafter, { scopes: ['read'] })),
        ).rejects.toBeInstanceOf(MailAccessError);
        await expect(rewrite(id, principal(sender))).rejects.toBeInstanceOf(
          MailAccessError,
        );
        await rewrite(id, principal(drafter));
        expect((await load(id)).body).toBe('rewritten');
      });

      it('still sends a draft synced with a provider id', async () => {
        const id = await seed({
          subject: 'synced draft',
          isDraft: true,
          messageId: '<draft@example.com>',
          folderId: 'drafts',
        });
        const result = await as(principal(sender), async () => {
          const email = await load(id);
          email.setToAddresses([{ address: 'to@example.com' }]);
          return email.send();
        });
        expect(result.success).toBe(true);
      });
    });

    describe('triage fields on queued rows', () => {
      const reader = () => principal(drafter, { scopes: ['read'] });
      const ROWS: Array<[string, Record<string, unknown>]> = [
        ['pending', { sendStatus: 'pending' }],
        ['failed', { sendStatus: 'failed' }],
        ['scheduled', { sendStatus: 'scheduled' }],
        ['flagged draft', { isDraft: true }],
        ['plain draft', {}],
      ];

      it.each(
        ROWS,
      )('lets a reader mark a %s row read and flag it', async (_l, fields) => {
        const id = await seed({ subject: 'triaged', ...fields });
        await as(reader(), async () => {
          const email = await load(id);
          await email.markRead();
          await email.toggleFlagged();
        });
        const row = await load(id);
        expect(row.isRead).toBe(true);
        expect(row.isFlagged).toBe(true);
        expect(row.subject).toBe('triaged');
        expect(row.sendStatus).toBe(fields.sendStatus ?? 'draft');
      });

      it.each(
        ROWS,
      )('still refuses a reader changing content of a %s row with a read mark', async (_l, fields) => {
        const id = await seed({ subject: 'triaged', ...fields });
        await expect(
          as(reader(), async () => {
            const email = await load(id);
            email.isRead = true;
            email.subject = 'rewritten';
            return email.save();
          }),
        ).rejects.toBeInstanceOf(MailAccessError);
        expect((await load(id)).subject).toBe('triaged');
      });

      it('does not let a triage-only save pass for a delete', async () => {
        const id = await seed({ subject: 'triaged', sendStatus: 'pending' });
        await expect(
          as(reader(), async () => (await load(id)).delete()),
        ).rejects.toBeInstanceOf(MailAccessError);
      });

      it('marks a whole thread read without failing partway', async () => {
        const ids = [
          await seed({ subject: 'a', sendStatus: 'pending' }),
          await seed({ subject: 'b', sendStatus: 'failed' }),
          await seed({ subject: 'c', isDraft: true }),
          await seedReceived(ownedId),
        ];
        await as(reader(), async () => {
          const { EmailCollection } = await import(
            '../collections/EmailCollection.js'
          );
          await (await EmailCollection.create(options)).markAllRead(ids);
        });
        for (const id of ids) expect((await load(id)).isRead).toBe(true);
      });

      it('tries every row and then raises the first failure', async () => {
        const ids = [
          await seed({ subject: 'a', sendStatus: 'pending' }),
          await seed({ subject: 'b', sendStatus: 'pending' }),
          await seed({ subject: 'c', sendStatus: 'pending' }),
        ];
        const original = Email.prototype.markRead;
        let calls = 0;
        vi.spyOn(Email.prototype, 'markRead').mockImplementation(
          async function (this: Email) {
            calls += 1;
            if (calls === 1) throw new Error('boom');
            return original.call(this);
          },
        );
        await expect(
          as(reader(), async () => {
            const { EmailCollection } = await import(
              '../collections/EmailCollection.js'
            );
            return (await EmailCollection.create(options)).markAllRead(ids);
          }),
        ).rejects.toThrow('boom');
        expect(calls).toBe(3);
      });
    });

    describe('a stale instance of a row that was sent meanwhile', () => {
      it('cannot write the row back to unsent', async () => {
        const id = await seed({ subject: 'racing', sendStatus: 'pending' });
        const stale = await load(id);
        await system(async () => {
          const email = await load(id);
          email.sendStatus = 'sent';
          await email.save();
        });
        for (const who of [
          principal(owner),
          principal(drafter, { scopes: ['read'] }),
        ]) {
          await expect(
            as(who, async () => {
              stale.isRead = true;
              return stale.save();
            }),
          ).rejects.toBeInstanceOf(MailAccessError);
        }
        expect((await load(id)).sendStatus).toBe('sent');
      });

      it('may still be deleted by a principal with the draft scope', async () => {
        const id = await seed({ subject: 'racing', sendStatus: 'pending' });
        const stale = await load(id);
        await system(async () => {
          const email = await load(id);
          email.sendStatus = 'sent';
          await email.save();
        });
        await as(principal(owner), () => stale.delete());
        expect(await exists(id)).toBe(false);
      });
    });

    describe('a queued row whose account was deleted', () => {
      const deleteAccount = (accountId: string) =>
        system(async () => {
          const { EmailAccountCollection } = await import(
            '../collections/EmailAccountCollection.js'
          );
          const accounts = await EmailAccountCollection.create(options);
          const account = await accounts.get({ id: accountId });
          if (!account) throw new Error('no account');
          // The engine's own delete refuses while rows reference the account;
          // an account can still vanish (restore, another service).
          await db.query('PRAGMA foreign_keys=OFF');
          await db.delete(accounts.tableName, { id: accountId });
        });

      afterEach(async () => {
        await db.query('PRAGMA foreign_keys=ON');
      });

      it('is marked failed with a clear error, as before', async () => {
        const accountId = await seedAccount('doomed', owner.id);
        const id = await system(async () => {
          const email = new Email({
            ...options,
            tenantId,
            accountId,
            subject: 'orphan',
            sendStatus: 'pending',
          });
          await email.initialize();
          await email.save();
          return email.id as string;
        });
        await deleteAccount(accountId);
        const result = await as(principal(sender), async () =>
          (await load(id)).send(),
        );
        expect(result.success).toBe(false);
        const row = await load(id);
        expect(row.sendStatus).toBe('failed');
        expect(row.sendError).toBe('No account associated with this message');
        expect(providerSend).not.toHaveBeenCalled();
      });

      it('lets an unsaved message to a missing account fail without a scope', async () => {
        // The engine's foreign key would refuse the row; take it out of the way.
        await db.query('PRAGMA foreign_keys=OFF');
        const result = await as(principal(sender), async () => {
          const email = new Email({
            ...options,
            tenantId,
            accountId: randomUUID(),
            subject: 'nowhere',
          });
          await email.initialize();
          return email.send();
        });
        expect(result.success).toBe(false);
        expect(result.error).toBe('No account associated with this message');
      });

      it('still refuses a content change on it without the scope', async () => {
        const accountId = await seedAccount('doomed2', owner.id);
        const id = await system(async () => {
          const email = new Email({
            ...options,
            tenantId,
            accountId,
            subject: 'orphan',
            sendStatus: 'pending',
          });
          await email.initialize();
          await email.save();
          return email.id as string;
        });
        await deleteAccount(accountId);
        await expect(
          as(principal(stranger), async () => {
            const email = await load(id);
            email.subject = 'rewritten';
            return email.save();
          }),
        ).rejects.toBeInstanceOf(MailAccessError);
        await expect(
          as(principal(stranger), async () => {
            const email = await load(id);
            email.sendStatus = 'failed';
            email.subject = 'rewritten';
            return email.save();
          }),
        ).rejects.toBeInstanceOf(MailAccessError);
        expect((await load(id)).subject).toBe('orphan');
      });
    });
  });
});
