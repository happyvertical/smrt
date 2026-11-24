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
import { Email } from '../models/Email';
import { EmailAccount } from '../models/EmailAccount';
import {
  configureMailSendApprovals,
  resetMailSendApprovals,
} from '../send-approval.js';
import { prepareMessageParents } from './fk-fixtures.js';

const ALL_MAIL_SLUGS = [
  'messages.read',
  'messages.triage',
  'messages.draft',
  'messages.send',
];

interface Person {
  id: string;
}

describe('draft scope on message writes (#5616)', () => {
  let db: DatabaseInterface;
  let options: { db: DatabaseInterface };
  let tenantId: string;
  let owner: Person;
  let drafter: Person;
  let sender: Person;
  let stranger: Person;
  let current: MailPrincipal | null = null;
  let ownedId: string;
  let openId: string;
  let providerSend: ReturnType<typeof vi.fn>;

  const principal = (
    p: Person,
    overrides: Partial<MailPrincipal> = {},
  ): MailPrincipal => ({
    id: `principal-${p.id}`,
    tenantId,
    userId: p.id,
    kind: 'person',
    ...overrides,
  });

  const as = <T>(who: MailPrincipal | null, fn: () => Promise<T>) => {
    current = who;
    return withTenant({ tenantId }, fn);
  };

  async function newPerson(label: string): Promise<Person> {
    const users = await UserCollection.create(options);
    const user = await users.create({
      email: `${label}-${randomUUID()}@example.com`,
    });
    await user.save();
    const roles = await RoleCollection.create(options);
    const role = await roles.create({
      name: `role ${randomUUID()}`,
      slug: `role-${randomUUID()}`,
    });
    await role.save();
    const permissions = await PermissionCollection.create(options);
    const rolePermissions = await RolePermissionCollection.create(options);
    for (const slug of ALL_MAIL_SLUGS) {
      const permission = await permissions.findBySlug(slug);
      if (!permission?.id) throw new Error(`missing permission ${slug}`);
      await rolePermissions.addPermission(role.id as string, permission.id);
    }
    const memberships = await MembershipCollection.create(options);
    const membership = await memberships.create({
      roleId: role.id as string,
      tenantId,
      userId: user.id as string,
    });
    await membership.save();
    return { id: user.id as string };
  }

  async function grant(userId: string, scope: MailScope) {
    await withTenant({ tenantId }, async () => {
      const grants = await ResourceGrantCollection.create(options);
      const row = await grants.create({
        tenantId,
        userId,
        resourceType: 'messages:account',
        resourceId: ownedId,
        permission: `messages.${scope}`,
      });
      await row.save();
    });
  }

  async function seedAccount(
    name: string,
    ownerUserId: string | null,
  ): Promise<string> {
    return withTenant({ tenantId }, async () => {
      const account = new EmailAccount({
        ...options,
        tenantId,
        name,
        email: `${name}@example.com`,
        providerType: 'smtp',
        ownerUserId,
      });
      await account.initialize();
      await account.save();
      return account.id as string;
    });
  }

  const newDraft = async (accountId: string, subject = 'draft') => {
    const draft = new Email({
      ...options,
      tenantId,
      accountId,
      subject,
      isDraft: true,
      sendStatus: 'draft',
    });
    await draft.initialize();
    return draft;
  };

  /** A stored draft written by trusted code, as a fixture. */
  async function seedDraft(accountId: string, subject = 'seeded') {
    return withTenant({ tenantId }, () =>
      runWithMailSystemAccess(async () => {
        const draft = await newDraft(accountId, subject);
        await draft.save();
        return draft.id as string;
      }),
    );
  }

  const load = async (id: string) =>
    withTenant({ tenantId }, () =>
      runWithMailSystemAccess(async () => {
        const email = new Email({ ...options, id });
        await email.initialize();
        return email;
      }),
    );

  const exists = async (id: string) =>
    withTenant({ tenantId }, () =>
      runWithMailSystemAccess(async () => {
        const { EmailCollection } = await import(
          '../collections/EmailCollection.js'
        );
        return Boolean(
          await (await EmailCollection.create(options)).get({ id }),
        );
      }),
    );

  beforeEach(async () => {
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    options = { db };
    await prepareMessageParents(db);
    enableTenancy();
    await withSystemContext(async () => {
      await syncPermissionCatalog(options);
      const tenants = await TenantCollection.create(options);
      const t = await tenants.create({ name: 'Tenant' });
      await t.save();
      tenantId = t.id as string;
      owner = await newPerson('owner');
      drafter = await newPerson('drafter');
      sender = await newPerson('sender');
      stranger = await newPerson('stranger');
    });
    ownedId = await seedAccount('owned', owner.id);
    openId = await seedAccount('open', null);
    await grant(drafter.id, 'read');
    await grant(drafter.id, 'draft');
    await grant(sender.id, 'read');
    await grant(sender.id, 'send');
    current = null;
    configureMailAccess({ options, resolvePrincipal: () => current });
    configureMailSendApprovals({
      gate: createApprovalMailSendGate({
        service: new ApprovalService({ db }),
      }),
    });
    providerSend = vi.fn(async () => ({
      success: true,
      providerMessageId: `sent-${randomUUID()}`,
      sentAt: new Date(),
    }));
    vi.spyOn(EmailAccount.prototype, 'createSender').mockResolvedValue({
      providerType: 'smtp',
      isReady: () => true,
      send: providerSend,
    } as never);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    resetMailSendApprovals();
    resetMailAccess();
    disableTenancy();
    await db.close?.();
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

    it('refuses to delete a draft and keeps it', async () => {
      const id = await seedDraft(ownedId);
      await expect(
        as(principal(stranger), async () => (await load(id)).delete()),
      ).rejects.toBeInstanceOf(MailAccessError);
      expect(await exists(id)).toBe(true);
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

    it('does not treat received mail or non-draft writes as draft writes', async () => {
      const id = await withTenant({ tenantId }, () =>
        runWithMailSystemAccess(async () => {
          // Received mail carries the default `draft` status, isDraft false.
          const email = new Email({
            ...options,
            tenantId,
            accountId: ownedId,
            subject: 'received',
          });
          await email.initialize();
          await email.save();
          return email.id as string;
        }),
      );
      await as(principal(stranger), async () => {
        const email = await load(id);
        email.isRead = true;
        await email.save();
        const sent = new Email({
          ...options,
          tenantId,
          accountId: ownedId,
          subject: 'queued',
          sendStatus: 'pending',
        });
        await sent.initialize();
        await sent.save();
        sent.subject = 'queued again';
        await sent.save();
        await sent.delete();
      });
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
