/**
 * The `draft` scope on message writes (#5616): creating, changing or deleting
 * a draft on an owned account needs the scope, whichever route the write takes
 * (the model, a reply or forward, or a generated create/update/delete). HIGH
 * RISK (authorization), so denials come first; system paths are regression
 * cases because they run with no principal.
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

describe('draft scope on message writes (#5616)', () => {
  const f = useMailDraftScopeFixture();
  const {
    principal,
    as,
    newDraft,
    seedDraft,
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

  describe('without the draft scope', () => {
    it.each([
      ['a stranger', () => principal(stranger)],
      ['a sender without draft', () => principal(sender)],
      ['no principal', () => null],
      [
        'a drafter capped below draft',
        () => principal(drafter, { scopes: ['read', 'send'] }),
      ],
      [
        'a drafter capped to another account',
        () => principal(drafter, { accountIds: [openId] }),
      ],
    ])('refuses to create a draft as %s', async (_label, who) => {
      await expect(
        as(who(), async () => (await newDraft(ownedId)).save()),
      ).rejects.toBeInstanceOf(MailAccessError);
    });

    it('refuses a reply and a forward saved onto an owned account', async () => {
      const received = await withTenant({ tenantId }, () =>
        runWithMailSystemAccess(async () => {
          const email = new Email({
            ...options,
            tenantId,
            accountId: ownedId,
            subject: 'hello',
            fromAddress: 'ada@example.com',
          });
          await email.initialize();
          await email.save();
          return email;
        }),
      );
      for (const make of [
        () => received.createReply(),
        () => received.createForward(),
      ]) {
        await expect(
          as(principal(sender), async () => {
            const draft = make();
            await draft.initialize();
            return draft.save();
          }),
        ).rejects.toBeInstanceOf(MailAccessError);
      }
    });

    it('refuses to change a stored draft and leaves it as it was', async () => {
      const id = await seedDraft(ownedId);
      await expect(
        as(principal(stranger), async () => {
          const draft = await load(id);
          draft.subject = 'changed';
          return draft.save();
        }),
      ).rejects.toBeInstanceOf(MailAccessError);
      expect((await load(id)).subject).toBe('seeded');
    });

    it('refuses to relabel a stored draft so it can be edited', async () => {
      const id = await seedDraft(ownedId);
      await expect(
        as(principal(stranger), async () => {
          const draft = await load(id);
          draft.isDraft = false;
          draft.subject = 'changed';
          return draft.save();
        }),
      ).rejects.toBeInstanceOf(MailAccessError);
      await expect(
        as(principal(stranger), async () => {
          const draft = await load(id);
          draft.sendStatus = 'pending';
          return draft.save();
        }),
      ).rejects.toBeInstanceOf(MailAccessError);
      expect((await load(id)).isDraft).toBe(true);
    });

    it('refuses to move a draft onto or off an owned account', async () => {
      const onto = await seedDraft(openId);
      await expect(
        as(principal(stranger), async () => {
          const draft = await load(onto);
          draft.accountId = ownedId;
          return draft.save();
        }),
      ).rejects.toBeInstanceOf(MailAccessError);
      const off = await seedDraft(ownedId);
      await expect(
        as(principal(stranger), async () => {
          const draft = await load(off);
          draft.accountId = openId;
          return draft.save();
        }),
      ).rejects.toBeInstanceOf(MailAccessError);
    });

    it.each([
      ['an owned account', () => ownedId],
      ['an unowned account', () => openId],
      ['an unowned account, no explicit tenant', () => openId, false],
    ] as Array<
      [string, () => string, boolean?]
    >)('refuses a fresh email whose natural key matches a stored draft (%s)', async (_label, target, explicitTenant = true) => {
      const id = await withTenant({ tenantId }, () =>
        runWithMailSystemAccess(async () => {
          const draft = await newDraft(ownedId, 'seeded');
          draft.slug = 'keyed-draft';
          await draft.save();
          return draft.id as string;
        }),
      );
      await expect(
        as(principal(stranger), async () => {
          const fresh = new Email({
            ...options,
            ...(explicitTenant ? { tenantId } : {}),
            accountId: target(),
            subject: 'overwritten',
            isDraft: false,
          });
          await fresh.initialize();
          fresh.slug = 'keyed-draft';
          return fresh.save();
        }),
      ).rejects.toBeInstanceOf(MailAccessError);
      const stored = await load(id);
      expect(stored.subject).toBe('seeded');
      expect(stored.accountId).toBe(ownedId);
      expect(stored.isDraft).toBe(true);
    });

    it('refuses a collection upsert on the key of a stored draft', async () => {
      const id = await withTenant({ tenantId }, () =>
        runWithMailSystemAccess(async () => {
          const draft = await newDraft(ownedId, 'seeded');
          draft.slug = 'upsert-draft';
          await draft.save();
          return draft.id as string;
        }),
      );
      await expect(
        as(principal(stranger), async () => {
          const { EmailCollection } = await import(
            '../collections/EmailCollection.js'
          );
          return (await EmailCollection.create(options)).getOrUpsert({
            tenantId,
            accountId: openId,
            slug: 'upsert-draft',
            subject: 'overwritten',
          });
        }),
      ).rejects.toBeInstanceOf(MailAccessError);
      expect((await load(id)).subject).toBe('seeded');
    });

    it('refuses the collection delete of a draft', async () => {
      const id = await seedDraft(ownedId);
      await expect(
        as(principal(drafter, { scopes: ['read'] }), async () => {
          const { EmailCollection } = await import(
            '../collections/EmailCollection.js'
          );
          return (await EmailCollection.create(options)).delete(id);
        }),
      ).rejects.toBeInstanceOf(MailAccessError);
      expect(await exists(id)).toBe(true);
    });

    it('refuses to delete a draft and keeps it', async () => {
      const id = await seedDraft(ownedId);
      await expect(
        as(principal(stranger), async () => (await load(id)).delete()),
      ).rejects.toBeInstanceOf(MailAccessError);
      expect(await exists(id)).toBe(true);
    });

    it('refuses an edit carried by a failed send of a draft', async () => {
      const id = await seedDraft(ownedId);
      const result = await as(
        principal(drafter, { scopes: ['read'] }),
        async () => {
          const draft = await load(id);
          draft.subject = 'rewritten';
          draft.accountId = '';
          return draft.send();
        },
      ).catch((error) => error);
      expect(result).toBeInstanceOf(MailAccessError);
      const stored = await load(id);
      expect(stored.subject).toBe('seeded');
      expect(stored.accountId).toBe(ownedId);
      expect(stored.sendStatus).toBe('draft');
    });

    it('refuses an edit to any field carried by a failed send of a draft', async () => {
      const id = await seedDraft(ownedId);
      await withTenant({ tenantId }, () =>
        runWithMailSystemAccess(async () => {
          const { EmailAccountCollection } = await import(
            '../collections/EmailAccountCollection.js'
          );
          const account = await (
            await EmailAccountCollection.create(options)
          ).get({ id: ownedId });
          if (!account) throw new Error('no account');
          account.isActive = false;
          await account.save();
        }),
      );
      const result = await as(
        principal(drafter, { scopes: ['read'] }),
        async () => {
          const draft = await load(id);
          draft.replyToAddress = 'elsewhere@example.com';
          draft.isFlagged = true;
          return draft.send();
        },
      ).catch((error) => error);
      expect(result).toBeInstanceOf(MailAccessError);
      const stored = await load(id);
      expect(stored.replyToAddress).toBe('');
      expect(stored.isFlagged).toBe(false);
      expect(stored.sendStatus).toBe('draft');
    });

    it('does not let a held send carry an edit', async () => {
      const id = await withTenant({ tenantId }, () =>
        runWithMailSystemAccess(async () => {
          const draft = await newDraft(ownedId, 'queued');
          draft.sendStatus = 'draft';
          draft.fromAddress = 'owned@example.com';
          await draft.save();
          return draft.id as string;
        }),
      );
      const result = await as(
        principal(sender, { kind: 'agent', id: 'agent-credential' }),
        async () => {
          const draft = await load(id);
          draft.subject = 'rewritten';
          return draft.send();
        },
      ).catch((error) => error);
      // The hold itself refuses changed content, and nothing is written.
      expect(result).toMatchObject({ success: false });
      expect(providerSend).not.toHaveBeenCalled();
      expect((await load(id)).subject).toBe('queued');
    });

    it('refuses the generated collection create, update and delete', async () => {
      // The generated routes read through the collection, then call the
      // model's save and delete, so a reader can reach exactly this path.
      const id = await seedDraft(ownedId);
      const reader = principal(drafter, { scopes: ['read'] });
      await expect(
        as(reader, async () => {
          const { EmailCollection } = await import(
            '../collections/EmailCollection.js'
          );
          const collection = await EmailCollection.create(options);
          const created = await collection.create({
            tenantId,
            accountId: ownedId,
            subject: 'created',
            isDraft: true,
            sendStatus: 'draft',
          });
          return created.save();
        }),
      ).rejects.toBeInstanceOf(MailAccessError);
      await expect(
        as(reader, async () => {
          const { EmailCollection } = await import(
            '../collections/EmailCollection.js'
          );
          const row = await (await EmailCollection.create(options)).get({ id });
          if (!row) throw new Error('reader should see the draft');
          row.subject = 'x';
          return row.save();
        }),
      ).rejects.toBeInstanceOf(MailAccessError);
      await expect(
        as(reader, async () => {
          const { EmailCollection } = await import(
            '../collections/EmailCollection.js'
          );
          const row = await (await EmailCollection.create(options)).get({ id });
          if (!row) throw new Error('reader should see the draft');
          return row.delete();
        }),
      ).rejects.toBeInstanceOf(MailAccessError);
      expect(await exists(id)).toBe(true);
    });
  });

  describe('with the draft scope', () => {
    it('lets the owner create, change and delete a draft', async () => {
      const id = await as(principal(owner), async () => {
        const draft = await newDraft(ownedId);
        await draft.save();
        draft.subject = 'owner edit';
        await draft.save();
        return draft.id as string;
      });
      expect((await load(id)).subject).toBe('owner edit');
      await as(principal(owner), async () => (await load(id)).delete());
      expect(await exists(id)).toBe(false);
    });

    it('lets a draft grantee create, change and delete a draft', async () => {
      const id = await as(principal(drafter), async () => {
        const draft = await newDraft(ownedId);
        await draft.save();
        draft.subject = 'grantee edit';
        await draft.save();
        return draft.id as string;
      });
      expect((await load(id)).subject).toBe('grantee edit');
      await as(principal(drafter), async () => (await load(id)).delete());
      expect(await exists(id)).toBe(false);
    });

    it('lets a draft grantee save a reply', async () => {
      const draft = await as(principal(drafter), async () => {
        const reply = new Email({
          ...options,
          tenantId,
          accountId: ownedId,
          subject: 'hello',
          fromAddress: 'ada@example.com',
        }).createReply();
        await reply.initialize();
        return reply.save();
      });
      expect(draft.id).toBeTruthy();
    });
  });

  describe('unchanged behaviour', () => {
    it('leaves an unowned account open to everyone', async () => {
      for (const who of [null, principal(stranger)]) {
        const id = await as(who, async () => {
          const draft = await newDraft(openId);
          await draft.save();
          draft.subject = 'edit';
          await draft.save();
          return draft.id as string;
        });
        await as(who, async () => (await load(id)).delete());
        expect(await exists(id)).toBe(false);
      }
    });

    it('applies a principal ceiling to draft writes on an unowned account, as for read and send', async () => {
      const capped = principal(stranger, { scopes: ['read', 'send'] });
      await expect(
        as(capped, async () => (await newDraft(openId)).save()),
      ).rejects.toBeInstanceOf(MailAccessError);
      // The same ceiling already closes the other scopes on that account.
      const account = { id: openId, tenantId, ownerUserId: null };
      f.setCurrent(capped);
      const { decideMailAccess } = await import('../access.js');
      expect((await decideMailAccess(account, 'read')).allowed).toBe(true);
      expect((await decideMailAccess(account, 'draft')).reason).toBe('ceiling');
      const noRead = principal(stranger, { scopes: ['send'] });
      f.setCurrent(noRead);
      expect((await decideMailAccess(account, 'read')).reason).toBe('ceiling');
      // Within the ceiling it stays open.
      const id = await as(
        principal(stranger, { scopes: ['draft'] }),
        async () => {
          const draft = await newDraft(openId);
          await draft.save();
          return draft.id as string;
        },
      );
      expect(await exists(id)).toBe(true);
    });

    it('does not treat received mail or non-draft writes as draft writes', async () => {
      const id = await withTenant({ tenantId }, () =>
        runWithMailSystemAccess(async () => {
          // Received mail carries the default `draft` status, isDraft false,
          // and the provider's message id.
          const email = new Email({
            ...options,
            tenantId,
            accountId: ownedId,
            subject: 'received',
            messageId: '<received@example.com>',
          });
          await email.initialize();
          await email.save();
          return email.id as string;
        }),
      );
      await as(principal(owner), async () => {
        const email = await load(id);
        email.isRead = true;
        await email.save();
      });
      // Queued outgoing mail needs the draft scope from its first write (#5657).
      await expect(
        as(principal(stranger), async () => {
          const queued = new Email({
            ...options,
            tenantId,
            accountId: ownedId,
            subject: 'queued',
            sendStatus: 'pending',
          });
          await queued.initialize();
          return queued.save();
        }),
      ).rejects.toBeInstanceOf(MailAccessError);
    });
  });

  describe('draft flag in any stored form', () => {
    const FORMS: Array<[string, unknown]> = [
      ['1', 1],
      ["'1'", '1'],
      ["'true'", 'true'],
    ];

    const collection = async () =>
      (
        await import('../collections/EmailCollection.js')
      ).EmailCollection.create(options);

    it.each(FORMS)('refuses to create a draft flagged %s', async (_l, flag) => {
      const subject = `flag-${randomUUID()}`;
      await expect(
        as(principal(stranger), async () => {
          const created = await (await collection()).create({
            tenantId,
            accountId: ownedId,
            subject,
            isDraft: flag as never,
            sendStatus: 'draft',
          });
          return created.save();
        }),
      ).rejects.toBeInstanceOf(MailAccessError);
      expect(await countBySubject(subject)).toBe(0);
    });

    it.each(
      FORMS,
    )('refuses an upsert of a draft flagged %s', async (_l, flag) => {
      const subject = `upsert-${randomUUID()}`;
      await expect(
        as(principal(stranger), async () =>
          (await collection()).getOrUpsert({
            tenantId,
            accountId: ownedId,
            slug: subject,
            subject,
            isDraft: flag as never,
            sendStatus: 'draft',
          }),
        ),
      ).rejects.toBeInstanceOf(MailAccessError);
      expect(await countBySubject(subject)).toBe(0);
    });

    it.each(
      FORMS,
    )('refuses to turn stored mail into a draft flagged %s', async (_l, flag) => {
      const id = await seedReceived(ownedId);
      await expect(
        as(principal(stranger), async () => {
          const email = await load(id);
          email.isDraft = flag as never;
          email.sendStatus = 'draft';
          return email.save();
        }),
      ).rejects.toBeInstanceOf(MailAccessError);
      expect((await load(id)).isDraft).toBe(false);
    });

    it.each(
      FORMS,
    )('lets the owner write a draft flagged %s', async (_l, flag) => {
      await as(principal(owner), async () => {
        const created = await (await collection()).create({
          tenantId,
          accountId: ownedId,
          subject: 'owner-flag',
          isDraft: flag as never,
          sendStatus: 'draft',
        });
        await created.save();
      });
    });
  });

  describe('unsent mail flagged as a draft', () => {
    const UNSENT = ['failed', 'pending', 'scheduled'] as const;

    const seedFlagged = (sendStatus: string, accountId = ownedId) =>
      withTenant({ tenantId }, () =>
        runWithMailSystemAccess(async () => {
          const email = await newDraft(accountId, `flagged-${sendStatus}`);
          email.sendStatus = sendStatus as never;
          await email.save();
          return email.id as string;
        }),
      );

    it.each(
      UNSENT,
    )('refuses to create, edit or delete a %s draft', async (status) => {
      await expect(
        as(principal(stranger), async () => {
          const email = await newDraft(ownedId);
          email.sendStatus = status;
          return email.save();
        }),
      ).rejects.toBeInstanceOf(MailAccessError);
      const id = await seedFlagged(status);
      await expect(
        as(principal(stranger), async () => {
          const email = await load(id);
          email.subject = 'rewritten';
          return email.save();
        }),
      ).rejects.toBeInstanceOf(MailAccessError);
      await expect(
        as(principal(stranger), async () => (await load(id)).delete()),
      ).rejects.toBeInstanceOf(MailAccessError);
      expect((await load(id)).subject).toBe(`flagged-${status}`);
    });

    it.each(
      UNSENT,
    )('refuses to turn a %s draft into a plain draft', async (status) => {
      const id = await seedFlagged(status);
      await expect(
        as(principal(stranger), async () => {
          const email = await load(id);
          email.sendStatus = 'draft';
          return email.save();
        }),
      ).rejects.toBeInstanceOf(MailAccessError);
      expect((await load(id)).sendStatus).toBe(status);
    });

    it.each(UNSENT)('lets a draft grantee edit a %s draft', async (status) => {
      const id = await seedFlagged(status);
      await as(principal(drafter), async () => {
        const email = await load(id);
        email.subject = 'edited';
        await email.save();
      });
      expect((await load(id)).subject).toBe('edited');
    });

    it('lets a triage grantee mark sent mail read (#5696)', async () => {
      const sent = await seedFlagged('sent');
      await f.grant(stranger.id, 'read');
      await f.grant(stranger.id, 'triage');
      await as(principal(stranger), async () => {
        const email = await load(sent);
        email.isRead = true;
        await email.save();
      });
    });

    it('lets a held send move a queued draft back to draft', async () => {
      const id = await seedFlagged('pending');
      await withTenant({ tenantId }, () =>
        runWithMailSystemAccess(async () => {
          const email = await load(id);
          email.fromAddress = 'owned@example.com';
          await email.save();
        }),
      );
      const held = await as(
        principal(sender, { kind: 'agent', id: 'agent-credential' }),
        async () => (await load(id)).send(),
      );
      expect(held.pendingApproval?.created).toBe(true);
      expect((await load(id)).sendStatus).toBe('draft');
    });
  });

  describe('the send path carries nothing else', () => {
    it.each([
      ['tenantId', (e: Email) => (e.tenantId = null)],
      [
        'context',
        (e: Email) => ((e as never as { context: string }).context = 'other'),
      ],
      ['slug', (e: Email) => (e.slug = 'renamed')],
    ])('refuses a changed %s on a failed send of a draft', async (_name, edit) => {
      const id = await seedDraft(ownedId);
      await withTenant({ tenantId }, () =>
        runWithMailSystemAccess(async () => {
          const { EmailAccountCollection } = await import(
            '../collections/EmailAccountCollection.js'
          );
          const account = await (
            await EmailAccountCollection.create(options)
          ).get({ id: ownedId });
          if (!account) throw new Error('no account');
          account.isActive = false;
          await account.save();
        }),
      );
      const before = await load(id);
      const result = await as(
        principal(drafter, { scopes: ['read'] }),
        async () => {
          const draft = await load(id);
          edit(draft);
          return draft.send();
        },
      ).catch((error) => error);
      expect(result).toBeInstanceOf(MailAccessError);
      const stored = await load(id);
      expect(stored.sendStatus).toBe('draft');
      expect(stored.slug).toBe(before.slug);
      expect(stored.tenantId).toBe(before.tenantId);
    });
  });

  describe('natural-key takeover and other handles', () => {
    it('refuses a new email whose id-derived slug is a stored draft', async () => {
      const id = await seedDraft(ownedId);
      const stored = await load(id);
      await expect(
        as(principal(drafter, { scopes: ['read'] }), async () => {
          const email = new Email({
            ...options,
            id: id.toUpperCase(),
            tenantId,
            accountId: openId,
            isDraft: false,
            subject: 'taken',
          });
          await email.initialize();
          return email.save();
        }),
      ).rejects.toBeInstanceOf(MailAccessError);
      const after = await load(id);
      expect(after.subject).toBe(stored.subject);
      expect(after.accountId).toBe(ownedId);
      expect(after.isDraft).toBe(true);
    });

    it('refuses to delete a stored draft through a base Message handle', async () => {
      const id = await seedDraft(ownedId);
      await expect(
        as(null, async () => {
          const handle = new Message({
            ...options,
            id,
            _skipLoad: true,
          } as never);
          await handle.initialize();
          return handle.delete();
        }),
      ).rejects.toBeInstanceOf(MailAccessError);
      expect(await exists(id)).toBe(true);
    });

    it('refuses a read-only principal marking a stored draft failed or retrying it', async () => {
      const id = await seedDraft(ownedId);
      const reader = principal(drafter, { scopes: ['read'] });
      await expect(
        as(reader, async () => {
          const draft = await load(id);
          draft.sendStatus = 'failed';
          return draft.retrySend();
        }),
      ).rejects.toBeInstanceOf(MailAccessError);
      const stored = await load(id);
      expect(stored.sendStatus).toBe('draft');
      expect(stored.retryCount).toBe(0);
    });

    it('refuses a subject edit hidden behind a date-like prefix on a failed send', async () => {
      const id = await withTenant({ tenantId }, () =>
        runWithMailSystemAccess(async () => {
          const draft = await newDraft(ownedId, '2026-01-01 10:00 (pay alice)');
          await draft.save();
          const { EmailAccountCollection } = await import(
            '../collections/EmailAccountCollection.js'
          );
          const account = await (
            await EmailAccountCollection.create(options)
          ).get({ id: ownedId });
          if (!account) throw new Error('no account');
          account.isActive = false;
          await account.save();
          return draft.id as string;
        }),
      );
      const result = await as(
        principal(drafter, { scopes: ['read'] }),
        async () => {
          const draft = await load(id);
          draft.subject = '2026-01-01 10:00 (pay mallory)';
          return draft.send();
        },
      ).catch((error) => error);
      expect(result).toBeInstanceOf(MailAccessError);
      expect((await load(id)).subject).toBe('2026-01-01 10:00 (pay alice)');
    });
  });

  describe('attachments of a draft', () => {
    const attachments = async () =>
      (
        await import('../collections/AttachmentCollection.js')
      ).AttachmentCollection.create(options);

    const seedAttachment = (messageId: string, filename = 'seed.txt') =>
      withTenant({ tenantId }, () =>
        runWithMailSystemAccess(async () => {
          const row = new Attachment({
            ...options,
            tenantId,
            messageId,
            filename,
          });
          await row.initialize();
          await row.save();
          return row.id as string;
        }),
      );

    const loadAttachment = (id: string) =>
      withTenant({ tenantId }, () =>
        runWithMailSystemAccess(async () => (await attachments()).get({ id })),
      );

    const addAttachment = async (messageId: string, filename = 'new.txt') => {
      const row = await (await attachments()).create({
        tenantId,
        messageId,
        filename,
      });
      return row.save();
    };

    describe('without the draft scope', () => {
      it.each([
        ['a stranger', () => principal(stranger)],
        ['a sender without draft', () => principal(sender)],
        ['no principal', () => null],
        [
          'a drafter capped below draft',
          () => principal(drafter, { scopes: ['read'] }),
        ],
      ])('refuses to add, change or delete one as %s', async (_l, who) => {
        const draftId = await seedDraft(ownedId);
        const existing = await seedAttachment(draftId);
        await expect(
          as(who(), () => addAttachment(draftId)),
        ).rejects.toBeInstanceOf(MailAccessError);
        await expect(
          as(who(), async () => {
            const row = await (await attachments()).get({ id: existing });
            if (!row) throw new MailAccessError('draft', 'denied');
            row.filename = 'changed.txt';
            return row.save();
          }),
        ).rejects.toBeInstanceOf(MailAccessError);
        await expect(
          as(who(), async () => {
            const row = await (await attachments()).get({ id: existing });
            if (!row) throw new MailAccessError('draft', 'denied');
            return row.delete();
          }),
        ).rejects.toBeInstanceOf(MailAccessError);
        const stored = await loadAttachment(existing);
        expect(stored?.filename).toBe('seed.txt');
        expect(
          (
            await withTenant({ tenantId }, () =>
              runWithMailSystemAccess(async () =>
                (await attachments()).list({ where: { messageId: draftId } }),
              ),
            )
          ).length,
        ).toBe(1);
      });

      it('refuses the collection delete by id', async () => {
        const draftId = await seedDraft(ownedId);
        const existing = await seedAttachment(draftId);
        await expect(
          as(principal(drafter, { scopes: ['read'] }), async () =>
            (await attachments()).delete(existing),
          ),
        ).rejects.toBeInstanceOf(MailAccessError);
        expect(await loadAttachment(existing)).toBeTruthy();
      });

      it('refuses to move an attachment onto or off a draft', async () => {
        const draftId = await seedDraft(ownedId);
        const openDraft = await seedDraft(openId);
        const onto = await seedAttachment(openDraft);
        const off = await seedAttachment(draftId);
        await expect(
          as(principal(stranger), async () => {
            const row = await (await attachments()).get({ id: onto });
            if (!row) throw new Error('open attachment should be visible');
            row.messageId = draftId;
            return row.save();
          }),
        ).rejects.toBeInstanceOf(MailAccessError);
        await expect(
          as(principal(drafter, { scopes: ['read'] }), async () => {
            const row = await (await attachments()).get({ id: off });
            if (!row) throw new Error('reader should see the attachment');
            row.messageId = openDraft;
            return row.save();
          }),
        ).rejects.toBeInstanceOf(MailAccessError);
        expect((await loadAttachment(onto))?.messageId).toBe(openDraft);
        expect((await loadAttachment(off))?.messageId).toBe(draftId);
      });

      it('refuses a new attachment that takes over the key of a stored one', async () => {
        const draftId = await seedDraft(ownedId);
        const openDraft = await seedDraft(openId);
        const existing = await withTenant({ tenantId }, () =>
          runWithMailSystemAccess(async () => {
            const row = new Attachment({
              ...options,
              tenantId,
              messageId: draftId,
              filename: 'keyed.txt',
            });
            row.slug = 'keyed-attachment';
            await row.initialize();
            await row.save();
            return row.id as string;
          }),
        );
        await expect(
          as(principal(stranger), async () => {
            const row = new Attachment({
              ...options,
              tenantId,
              messageId: openDraft,
              filename: 'taken.txt',
            });
            row.slug = 'keyed-attachment';
            await row.initialize();
            return row.save();
          }),
        ).rejects.toBeInstanceOf(MailAccessError);
        expect((await loadAttachment(existing))?.messageId).toBe(draftId);
      });

      it('refuses a new attachment whose id-derived slug is a stored one', async () => {
        const draftId = await seedDraft(ownedId);
        const received = await seedReceived(ownedId);
        const existing = await seedAttachment(draftId);
        await expect(
          as(principal(drafter, { scopes: ['read'] }), async () => {
            const row = new Attachment({
              ...options,
              id: existing.toUpperCase(),
              tenantId,
              messageId: received,
              filename: 'taken.txt',
            });
            await row.initialize();
            return row.save();
          }),
        ).rejects.toBeInstanceOf(MailAccessError);
        expect((await loadAttachment(existing))?.messageId).toBe(draftId);
      });
    });

    describe('with the draft scope', () => {
      it.each([
        ['the owner', () => principal(owner)],
        ['a draft grantee', () => principal(drafter)],
      ])('lets %s add, change and delete one', async (_l, who) => {
        const draftId = await seedDraft(ownedId);
        await as(who(), async () => {
          const row = await addAttachment(draftId);
          row.filename = 'renamed.txt';
          await row.save();
          expect(row.accountId).toBe(ownedId);
          await row.delete();
        });
      });
    });

    describe('unchanged behaviour', () => {
      it('leaves attachments of unowned drafts alone and gates those of sent mail (#5696)', async () => {
        const openDraft = await seedDraft(openId);
        const sent = await withTenant({ tenantId }, () =>
          runWithMailSystemAccess(async () => {
            const email = await newDraft(ownedId, 'sent');
            email.sendStatus = 'sent';
            await email.save();
            return email.id as string;
          }),
        );
        await as(principal(stranger), async () => {
          const row = await addAttachment(openDraft);
          await row.delete();
        });
        await expect(
          as(principal(stranger), async () => addAttachment(sent)),
        ).rejects.toBeInstanceOf(MailAccessError);
      });

      it('lets trusted sync and ingest write attachments with no principal', async () => {
        const draftId = await seedDraft(ownedId);
        const id = await seedAttachment(draftId);
        await withTenant({ tenantId }, () =>
          runWithMailSystemAccess(async () => {
            const row = await (await attachments()).get({ id });
            if (!row) throw new Error('missing');
            row.filename = 'synced.txt';
            await row.save();
            await row.delete();
          }),
        );
        expect(await loadAttachment(id)).toBeNull();
      });

      it('lets a sender send a draft that has attachments', async () => {
        const draftId = await seedDraft(ownedId);
        await seedAttachment(draftId);
        const result = await as(
          principal(sender, { kind: 'person' }),
          async () =>
            (await load(draftId)).send({
              attachments: [
                {
                  filename: 'late.txt',
                  content: new Uint8Array([1, 2, 3]),
                  contentType: 'text/plain',
                },
              ],
            } as never),
        );
        expect(result.success).toBe(true);
        expect((await load(draftId)).sendStatus).toBe('sent');
      });
    });
  });

  describe('the scope check runs inside the write', () => {
    it('reads the stored row through the transaction handle', async () => {
      const id = await seedDraft(ownedId);
      const seen: boolean[] = [];
      const original = (
        Email.prototype as unknown as {
          getCanonicalPersistedRow: (f: unknown) => Promise<unknown>;
        }
      ).getCanonicalPersistedRow;
      vi.spyOn(
        Email.prototype as never,
        'getCanonicalPersistedRow' as never,
      ).mockImplementation(async function (this: Email, filter: unknown) {
        seen.push(this.db !== db);
        return original.call(this, filter);
      } as never);
      await as(principal(drafter), async () => {
        const email = await load(id);
        seen.length = 0;
        email.subject = 'in tx';
        await email.save();
      });
      // Read once for the decision on the root handle, once more inside the
      // write on the transaction's handle.
      expect(seen[0]).toBe(false);
      expect(seen.at(-1)).toBe(true);
    });
  });

  it('treats a class without a draft flag by its status and provider id', async () => {
    const { Tweet } = await import('../models/Tweet');
    // Unsent, so a later send would transmit it: the scope applies.
    await expect(
      as(principal(stranger), async () => {
        const tweet = new Tweet({ ...options, tenantId, accountId: ownedId });
        await tweet.initialize();
        return tweet.save();
      }),
    ).rejects.toBeInstanceOf(MailAccessError);
    // A received tweet (provider id set) is a record; triage fields pass.
    const id = await withTenant({ tenantId }, () =>
      runWithMailSystemAccess(async () => {
        const tweet = new Tweet({
          ...options,
          tenantId,
          accountId: ownedId,
          tweetId: '1234',
        });
        await tweet.initialize();
        await tweet.save();
        return tweet.id as string;
      }),
    );
    const tweet = await withTenant({ tenantId }, () =>
      runWithMailSystemAccess(async () => {
        const row = new Tweet({ ...options, id });
        await row.initialize();
        return row;
      }),
    );
    await as(principal(owner), async () => {
      tweet.isRead = true;
      await tweet.save();
      await tweet.delete();
    });
  });

  describe('trusted and service paths keep working', () => {
    it('lets system access write and delete drafts with no principal', async () => {
      const id = await seedDraft(ownedId);
      await withTenant({ tenantId }, () =>
        runWithMailSystemAccess(async () => {
          const draft = await load(id);
          draft.subject = 'system edit';
          await draft.save();
          await draft.delete();
        }),
      );
      expect(await exists(id)).toBe(false);
    });

    it('lets mail sync store mail with no principal', async () => {
      const id = await withTenant({ tenantId }, async () => {
        const { applyServerMessage } = await import('../mail-sync.js');
        return runWithMailSystemAccess(async () => {
          const email = new Email({ ...options, tenantId, accountId: ownedId });
          await email.initialize();
          applyServerMessage(
            email,
            { id: 'p1', subject: 'synced', flags: ['\\Draft'] } as never,
            { folderId: '', folderPath: 'Drafts' },
            { deriveState: true },
          );
          await email.save();
          email.subject = 'synced again';
          await email.save();
          return email.id as string;
        });
      });
      expect((await load(id)).isDraft).toBe(true);
    });

    it('lets MailDraftService save and submit for a draft grantee', async () => {
      const grantee = principal(drafter, { kind: 'person' });
      const saved = await as(grantee, () =>
        new MailDraftService(options).save({
          accountId: ownedId,
          subject: 'via service',
          textBody: 'hi',
          toAddresses: [{ address: 'ada@example.com' }],
        }),
      );
      const updated = await as(grantee, () =>
        new MailDraftService(options).save({
          accountId: ownedId,
          draftId: saved.id as string,
          subject: 'via service 2',
        }),
      );
      expect(updated.subject).toBe('via service 2');
    });

    it('refuses MailDraftService without the scope', async () => {
      await expect(
        as(principal(sender), () =>
          new MailDraftService(options).save({
            accountId: ownedId,
            subject: 'no',
          }),
        ),
      ).rejects.toBeInstanceOf(MailAccessError);
    });

    it('lets a person with only send send a draft (Message.send)', async () => {
      const id = await seedDraft(ownedId);
      const result = await as(principal(sender, { kind: 'person' }), async () =>
        (await load(id)).send(),
      );
      expect(result.success).toBe(true);
      expect(providerSend).toHaveBeenCalledTimes(1);
      expect((await load(id)).sendStatus).toBe('sent');
    });

    it('lets a sender send a reply that was never saved', async () => {
      const result = await as(
        principal(sender, { kind: 'person' }),
        async () => {
          const reply = new Email({
            ...options,
            tenantId,
            accountId: ownedId,
            subject: 'hello',
            fromAddress: 'ada@example.com',
          }).createReply();
          await reply.initialize();
          reply.fromAddress = 'owned@example.com';
          return reply.send();
        },
      );
      expect(result.success).toBe(true);
      expect(providerSend).toHaveBeenCalledTimes(1);
    });

    it('refuses to send a reply that was never saved without the send scope', async () => {
      const result = await as(principal(drafter), async () => {
        const reply = new Email({
          ...options,
          tenantId,
          accountId: ownedId,
          subject: 'hello',
        }).createReply();
        await reply.initialize();
        return reply.send();
      });
      expect(result.success).toBe(false);
      expect(providerSend).not.toHaveBeenCalled();
    });

    it('holds an agent send for approval without needing the draft scope', async () => {
      // A queued message by an agent with send but not draft: the hold moves
      // it back to draft with the agent as the actor.
      const id = await withTenant({ tenantId }, () =>
        runWithMailSystemAccess(async () => {
          const draft = await newDraft(ownedId, 'queued');
          draft.sendStatus = 'pending';
          draft.fromAddress = 'owned@example.com';
          await draft.save();
          return draft.id as string;
        }),
      );
      const held = await as(
        principal(sender, { kind: 'agent', id: 'agent-credential' }),
        async () => (await load(id)).send(),
      );
      expect(held.pendingApproval?.created).toBe(true);
      expect(providerSend).not.toHaveBeenCalled();
      expect((await load(id)).sendStatus).toBe('draft');
    });

    it('leaves an inactive account failure on a draft to the send path', async () => {
      const id = await seedDraft(ownedId);
      await withTenant({ tenantId }, () =>
        runWithMailSystemAccess(async () => {
          const { EmailAccountCollection } = await import(
            '../collections/EmailAccountCollection.js'
          );
          const account = await (
            await EmailAccountCollection.create(options)
          ).get({ id: ownedId });
          if (!account) throw new Error('no account');
          account.isActive = false;
          await account.save();
        }),
      );
      const result = await as(principal(sender), async () =>
        (await load(id)).send(),
      );
      expect(result.success).toBe(false);
      expect((await load(id)).sendStatus).toBe('failed');
    });
  });
});
