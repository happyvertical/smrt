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

  /** A stored received email (isDraft false), written by trusted code. */
  async function seedReceived(accountId: string) {
    return withTenant({ tenantId }, () =>
      runWithMailSystemAccess(async () => {
        const email = new Email({
          ...options,
          tenantId,
          accountId,
          subject: `received-${randomUUID()}`,
          messageId: `<${randomUUID()}@example.com>`,
        });
        await email.initialize();
        await email.save();
        return email.id as string;
      }),
    );
  }

  const countBySubject = async (subject: string) =>
    withTenant({ tenantId }, () =>
      runWithMailSystemAccess(async () => {
        const { EmailCollection } = await import(
          '../collections/EmailCollection.js'
        );
        return (
          await (
            await EmailCollection.create(options)
          ).list({
            where: { subject },
          })
        ).length;
      }),
    );

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
      current = capped;
      const { decideMailAccess } = await import('../access.js');
      expect((await decideMailAccess(account, 'read')).allowed).toBe(true);
      expect((await decideMailAccess(account, 'draft')).reason).toBe('ceiling');
      const noRead = principal(stranger, { scopes: ['send'] });
      current = noRead;
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
      await as(principal(stranger), async () => {
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

    it('leaves sent mail and unflagged queued mail alone', async () => {
      const sent = await seedFlagged('sent');
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
      it('leaves attachments of unowned drafts and sent mail alone', async () => {
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
          for (const messageId of [openDraft, sent]) {
            const row = await addAttachment(messageId);
            await row.delete();
          }
        });
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
        await as(principal(stranger), async () => {
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
    await as(principal(stranger), async () => {
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
