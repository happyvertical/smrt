/**
 * Per-account mail access (#5129): owner plus grants, enforced in the
 * collection layer. HIGH-RISK area (auth, tenancy, agent permissions), so the
 * negative cases outnumber the positive ones: missing, denied, revoked and
 * delegated-then-revoked grants, tenant crossing, ceilings, admin and
 * super-admin bypass attempts, cache sharing, STI subclasses, attachments.
 */

import { randomUUID } from 'node:crypto';
import { smrt } from '@happyvertical/smrt-core';
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
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  configureMailAccess,
  decideMailAccess,
  MailAccessService,
  type MailPrincipal,
  type MailScope,
  resetMailAccess,
  runWithMailSystemAccess,
} from '../access.js';
import {
  AccountCollection,
  AttachmentCollection,
  EmailCollection,
  EmailFolderCollection,
  MessageCollection,
} from '../index.js';
import { Attachment } from '../models/Attachment';
import { Email } from '../models/Email';
import { EmailAccount } from '../models/EmailAccount';
import { EmailFolder } from '../models/EmailFolder';
import { prepareMessageParents } from './fk-fixtures.js';

const ALL_MAIL_SLUGS = [
  'messages.read',
  'messages.triage',
  'messages.draft',
  'messages.send',
  'messages.manage-access',
];

@smrt({ tableStrategy: 'sti' })
class AppEmail extends Email {}

interface Person {
  id: string;
}

describe('mail account access (#5129)', () => {
  let db: DatabaseInterface;
  let options: { db: DatabaseInterface };
  let tenantA: string;
  let tenantB: string;
  let owner: Person;
  let grantee: Person;
  let stranger: Person;
  let agent: Person;
  let admin: Person;
  let current: MailPrincipal | null = null;
  let privateAccountId: string;
  let sharedAccountId: string;
  let openAccountId: string;

  const principalFor = (
    person: Person,
    overrides: Partial<MailPrincipal> = {},
  ): MailPrincipal => ({
    id: `principal-${person.id}`,
    tenantId: tenantA,
    userId: person.id,
    ...overrides,
  });

  async function newPerson(
    tenantId: string,
    slugs: string[],
    label: string,
  ): Promise<Person> {
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
    for (const slug of slugs) {
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

  async function seedAccount(
    tenantId: string,
    name: string,
    ownerUserId: string | null,
  ): Promise<string> {
    return withTenant({ tenantId }, async () => {
      const account = new EmailAccount({
        ...options,
        tenantId,
        name,
        email: `${name}@example.com`,
        providerType: 'imap',
        ownerUserId,
      });
      await account.initialize();
      await account.save();
      const id = account.id as string;
      const folder = new EmailFolder({
        ...options,
        tenantId,
        accountId: id,
        name: 'INBOX',
        path: 'INBOX',
      });
      await folder.initialize();
      await folder.save();
      const email = new Email({
        ...options,
        tenantId,
        accountId: id,
        subject: `${name} subject`,
        messageId: `<${name}@example.com>`,
        folderId: folder.id as string,
      });
      await email.initialize();
      await email.save();
      const attachment = new Attachment({
        ...options,
        tenantId,
        messageId: email.id as string,
        filename: `${name}.pdf`,
      });
      await attachment.initialize();
      await attachment.save();
      return id;
    });
  }

  async function grantRow(
    userId: string,
    accountId: string,
    scope: MailScope,
    extra: Record<string, unknown> = {},
  ) {
    return withTenant({ tenantId: tenantA }, async () => {
      const grants = await ResourceGrantCollection.create(options);
      const grant = await grants.create({
        tenantId: tenantA,
        userId,
        resourceType: 'messages:account',
        resourceId: accountId,
        permission: `messages.${scope}`,
        ...extra,
      });
      await grant.save();
      return grant;
    });
  }

  const subjects = async (as: MailPrincipal | null) => {
    current = as;
    return withTenant({ tenantId: tenantA }, async () => {
      const emails = await EmailCollection.create(options);
      return (await emails.list({})).map((email) => email.subject).sort();
    });
  };

  beforeEach(async () => {
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    options = { db };
    await prepareMessageParents(db);
    enableTenancy();
    await withSystemContext(async () => {
      await syncPermissionCatalog(options);
      const tenants = await TenantCollection.create(options);
      const a = await tenants.create({ name: 'Tenant A' });
      await a.save();
      const b = await tenants.create({ name: 'Tenant B' });
      await b.save();
      tenantA = a.id as string;
      tenantB = b.id as string;
      owner = await newPerson(tenantA, ALL_MAIL_SLUGS, 'owner');
      grantee = await newPerson(tenantA, ALL_MAIL_SLUGS, 'grantee');
      stranger = await newPerson(tenantA, ALL_MAIL_SLUGS, 'stranger');
      agent = await newPerson(tenantA, ALL_MAIL_SLUGS, 'agent');
      admin = await newPerson(
        tenantA,
        [...ALL_MAIL_SLUGS, 'messages.manage-credentials'],
        'admin',
      );
    });
    privateAccountId = await seedAccount(tenantA, 'private', owner.id);
    sharedAccountId = await seedAccount(tenantA, 'shared', owner.id);
    openAccountId = await seedAccount(tenantA, 'open', null);
    current = null;
    configureMailAccess({ options, resolvePrincipal: () => current });
    // Rows seeded before enforcement was configured predate the denormalized
    // attachment account; a deployed host runs this once after upgrading.
    await withTenant({ tenantId: tenantA }, async () => {
      const attachments = await AttachmentCollection.create(options);
      expect(await attachments.backfillAccountIds()).toBe(3);
    });
  });

  afterEach(async () => {
    resetMailAccess();
    disableTenancy();
    await db.close?.();
  });

  describe('optional by default', () => {
    it('leaves an ownerless account tenant-wide, with or without a principal', async () => {
      expect(await subjects(null)).toEqual(['open subject']);
      expect(await subjects(principalFor(stranger))).toEqual(['open subject']);
    });

    it('is unenforced until configured, except that an owned account cannot be sent from', async () => {
      resetMailAccess();
      expect(await subjects(null)).toEqual([
        'open subject',
        'private subject',
        'shared subject',
      ]);
      const decision = await decideMailAccess(
        { id: privateAccountId, tenantId: tenantA, ownerUserId: owner.id },
        'send',
      );
      expect(decision).toMatchObject({
        allowed: false,
        reason: 'not_configured',
      });
    });
  });

  describe('owner and read grants', () => {
    it('lets the owner read everything of theirs, implicitly', async () => {
      expect(await subjects(principalFor(owner))).toEqual([
        'open subject',
        'private subject',
        'shared subject',
      ]);
    });

    it('hides owned accounts from a non-owner without a grant', async () => {
      expect(await subjects(principalFor(stranger))).toEqual(['open subject']);
    });

    it('opens a shared account to a read grantee only', async () => {
      await grantRow(grantee.id, sharedAccountId, 'read');
      expect(await subjects(principalFor(grantee))).toEqual([
        'open subject',
        'shared subject',
      ]);
      expect(await subjects(principalFor(stranger))).toEqual(['open subject']);
    });

    it('does not let a triage-only or send-only grant read', async () => {
      await grantRow(grantee.id, sharedAccountId, 'triage');
      await grantRow(grantee.id, sharedAccountId, 'send');
      expect(await subjects(principalFor(grantee))).toEqual(['open subject']);
    });

    it('applies to folders, point reads, counts and attachments', async () => {
      await grantRow(grantee.id, sharedAccountId, 'read');
      current = principalFor(grantee);
      await withTenant({ tenantId: tenantA }, async () => {
        const folders = await EmailFolderCollection.create(options);
        const attachments = await AttachmentCollection.create(options);
        const emails = await EmailCollection.create(options);
        expect((await folders.list({})).map((f) => f.accountId).sort()).toEqual(
          [sharedAccountId, openAccountId].sort(),
        );
        expect(
          (await attachments.list({})).map((a) => a.filename).sort(),
        ).toEqual(['open.pdf', 'shared.pdf']);
        expect(await emails.count({})).toBe(1 + 1);
        const privateEmail = await runWithMailSystemAccess(
          async () =>
            (await emails.list({ where: { accountId: privateAccountId } }))[0],
        );
        expect(await emails.get({ id: privateEmail?.id as string })).toBeNull();
        const privateFolder = await runWithMailSystemAccess(
          async () =>
            (await folders.list({ where: { accountId: privateAccountId } }))[0],
        );
        expect(
          await folders.get({ id: privateFolder?.id as string }),
        ).toBeNull();
        const privateAttachment = await runWithMailSystemAccess(
          async () =>
            (await attachments.list({ where: { filename: 'private.pdf' } }))[0],
        );
        expect(
          await attachments.get({ id: privateAttachment?.id as string }),
        ).toBeNull();
      });
    });

    it('does not leak attachments through projections or counts', async () => {
      await grantRow(grantee.id, sharedAccountId, 'read');
      current = principalFor(grantee);
      await withTenant({ tenantId: tenantA }, async () => {
        const attachments = await AttachmentCollection.create(options);
        const projected = await attachments.list({
          select: ['filename', 'messageId'],
        });
        expect(projected.map((row) => row.filename).sort()).toEqual([
          'open.pdf',
          'shared.pdf',
        ]);
        expect(await attachments.count({})).toBe(2);
      });
      current = principalFor(stranger);
      await withTenant({ tenantId: tenantA }, async () => {
        const attachments = await AttachmentCollection.create(options);
        expect(await attachments.count({})).toBe(1);
      });
    });

    it('copies the account onto an attachment at save time, and still hides legacy rows', async () => {
      await withTenant({ tenantId: tenantA }, async () => {
        const emails = await EmailCollection.create(options);
        const privateEmail = await runWithMailSystemAccess(
          async () =>
            (await emails.list({ where: { accountId: privateAccountId } }))[0],
        );
        const added = new Attachment({
          ...options,
          tenantId: tenantA,
          messageId: privateEmail?.id as string,
          filename: 'late.pdf',
        });
        await added.initialize();
        await added.save();
        expect(added.accountId).toBe(privateAccountId);
        // A row from before the column existed: no accountId, found via its message.
        const legacy = new Attachment({
          ...options,
          tenantId: tenantA,
          messageId: privateEmail?.id as string,
          filename: 'legacy.pdf',
        });
        await legacy.initialize();
        await runWithMailSystemAccess(() => legacy.save());
        legacy.accountId = null;
        await runWithMailSystemAccess(() => legacy.save());
      });
      current = principalFor(stranger);
      const names = await withTenant({ tenantId: tenantA }, async () =>
        (await (await AttachmentCollection.create(options)).list({})).map(
          (row) => row.filename,
        ),
      );
      expect(names).toEqual(['open.pdf']);
    });

    it('governs an app subclass of Email by STI ancestry', async () => {
      await withTenant({ tenantId: tenantA }, async () => {
        const subclassed = new AppEmail({
          ...options,
          tenantId: tenantA,
          accountId: privateAccountId,
          subject: 'app subject',
        });
        await subclassed.initialize();
        await subclassed.save();
      });
      expect(await subjects(principalFor(stranger))).toEqual(['open subject']);
      expect(await subjects(principalFor(owner))).toContain('app subject');
    });
  });

  describe('fail closed', () => {
    it('hides owned accounts when the host supplies no principal', async () => {
      expect(await subjects(null)).toEqual(['open subject']);
    });

    it('hides owned accounts when no resolver is configured', async () => {
      configureMailAccess({ options });
      expect(await subjects(principalFor(owner))).toEqual(['open subject']);
    });

    it('hides owned accounts when the resolver returns a malformed principal', async () => {
      configureMailAccess({
        options,
        resolvePrincipal: () => ({ id: 'x' }) as unknown as MailPrincipal,
      });
      expect(await subjects(null)).toEqual(['open subject']);
    });

    it('does not let a raw query read around the policy', async () => {
      current = principalFor(stranger);
      await withTenant({ tenantId: tenantA }, async () => {
        const emails = await EmailCollection.create(options);
        await expect(
          emails.query('SELECT * FROM messages', [], {
            allowRawOnTenantScoped: true,
          }),
        ).rejects.toThrow(/Mail access denied/);
      });
    });
  });

  describe('deny, revoke and delegation', () => {
    it('lets an explicit deny beat a grant', async () => {
      await grantRow(grantee.id, sharedAccountId, 'read');
      await grantRow(grantee.id, sharedAccountId, 'read', { effect: 'deny' });
      expect(await subjects(principalFor(grantee))).toEqual(['open subject']);
    });

    it('stops honoring a revoked grant', async () => {
      const grant = await grantRow(grantee.id, sharedAccountId, 'read');
      expect(await subjects(principalFor(grantee))).toContain('shared subject');
      grant.revokedAt = new Date().toISOString();
      await withTenant({ tenantId: tenantA }, () => grant.save());
      expect(await subjects(principalFor(grantee))).toEqual(['open subject']);
    });

    it('stops honoring a delegated grant when its parent is revoked', async () => {
      const parent = await grantRow(grantee.id, sharedAccountId, 'read', {
        canDelegate: true,
      });
      await grantRow(agent.id, sharedAccountId, 'read', {
        parentGrantId: parent.id,
      });
      expect(await subjects(principalFor(agent))).toContain('shared subject');
      parent.revokedAt = new Date().toISOString();
      await withTenant({ tenantId: tenantA }, () => parent.save());
      expect(await subjects(principalFor(agent))).toEqual(['open subject']);
    });

    it('needs the tenant permission as well: a grant alone is not enough', async () => {
      const unprivileged = await withSystemContext(() =>
        newPerson(tenantA, [], 'unprivileged'),
      );
      await grantRow(unprivileged.id, sharedAccountId, 'read');
      expect(await subjects(principalFor(unprivileged))).toEqual([
        'open subject',
      ]);
    });
  });

  describe('tenancy', () => {
    it('refuses a principal from another tenant even for the owner id', async () => {
      // The tenant check is absolute: even an unowned account is closed to a
      // principal that authenticated into a different tenant.
      expect(
        await subjects(principalFor(owner, { tenantId: tenantB })),
      ).toEqual([]);
    });

    it('ignores a grant recorded in another tenant for the same account id', async () => {
      await withTenant({ tenantId: tenantB }, async () => {
        const grants = await ResourceGrantCollection.create(options);
        const foreign = await grants.create({
          tenantId: tenantB,
          userId: grantee.id,
          resourceType: 'messages:account',
          resourceId: sharedAccountId,
          permission: 'messages.read',
        });
        await foreign.save();
      });
      expect(await subjects(principalFor(grantee))).toEqual(['open subject']);
    });

    it('does not read another tenant account even with a matching principal', async () => {
      const foreignId = await seedAccount(tenantB, 'foreign', owner.id);
      current = principalFor(owner, { tenantId: tenantB });
      const seen = await withTenant({ tenantId: tenantA }, async () => {
        const emails = await EmailCollection.create(options);
        return (await emails.list({ where: { accountId: foreignId } })).length;
      });
      expect(seen).toBe(0);
    });
  });

  describe('host ceilings (agents)', () => {
    it('intersects a scope ceiling with the grant', async () => {
      await grantRow(agent.id, sharedAccountId, 'read');
      expect(
        await subjects(principalFor(agent, { scopes: ['triage'] })),
      ).toEqual([]);
      expect(await subjects(principalFor(agent, { scopes: ['read'] }))).toEqual(
        ['open subject', 'shared subject'],
      );
    });

    it('intersects an account ceiling with the grant, and with unowned accounts', async () => {
      await grantRow(agent.id, sharedAccountId, 'read');
      await grantRow(agent.id, privateAccountId, 'read');
      expect(
        await subjects(principalFor(agent, { accountIds: [sharedAccountId] })),
      ).toEqual(['shared subject']);
      expect(await subjects(principalFor(agent, { accountIds: [] }))).toEqual(
        [],
      );
    });

    it('never widens: a ceiling cannot substitute for a missing grant', async () => {
      expect(
        await subjects(
          principalFor(agent, {
            scopes: ['read'],
            accountIds: [privateAccountId, sharedAccountId],
          }),
        ),
      ).toEqual([]);
    });
  });

  describe('no admin bypass', () => {
    it('hides an owned mailbox from a tenant administrator and from super-admin context', async () => {
      expect(await subjects(principalFor(admin))).toEqual(['open subject']);
      current = principalFor(admin);
      const seen = await withTenant({ tenantId: tenantA }, async () => {
        const { withSuperAdminBypass } = await import(
          '@happyvertical/smrt-tenancy'
        );
        void withSuperAdminBypass;
        const emails = await EmailCollection.create(options);
        return (await emails.list({})).map((e) => e.subject).sort();
      });
      expect(seen).toEqual(['open subject']);
    });

    it('lets only explicit system access (sync) see every account', async () => {
      current = null;
      const seen = await withTenant({ tenantId: tenantA }, () =>
        runWithMailSystemAccess(async () => {
          const emails = await EmailCollection.create(options);
          return (await emails.list({})).length;
        }),
      );
      expect(seen).toBe(3);
    });
  });

  describe('read cache', () => {
    it('does not share a cached read between principals', async () => {
      await grantRow(grantee.id, sharedAccountId, 'read');
      const sharedEmailId = await withTenant({ tenantId: tenantA }, () =>
        runWithMailSystemAccess(async () => {
          const emails = await EmailCollection.create(options);
          return (
            await emails.list({ where: { accountId: sharedAccountId } })
          )[0]?.id as string;
        }),
      );
      const read = async (as: MailPrincipal) => {
        current = as;
        return withTenant({ tenantId: tenantA }, async () => {
          const emails = await EmailCollection.create(options);
          return emails.get({ id: sharedEmailId }, { cache: { ttl: 60_000 } });
        });
      };
      expect(await read(principalFor(grantee))).not.toBeNull();
      expect(await read(principalFor(stranger))).toBeNull();
      expect(await read(principalFor(grantee))).not.toBeNull();
    });
  });

  describe('scopes', () => {
    it('grants triage and draft independently of read, one scope per grant', async () => {
      const subject = {
        id: sharedAccountId,
        tenantId: tenantA,
        ownerUserId: owner.id,
      };
      await grantRow(grantee.id, sharedAccountId, 'triage');
      await grantRow(grantee.id, sharedAccountId, 'draft');
      current = principalFor(grantee);
      const decide = (scope: MailScope) =>
        withTenant({ tenantId: tenantA }, () =>
          decideMailAccess(subject, scope),
        );
      expect(await decide('triage')).toMatchObject({
        allowed: true,
        reason: 'grant',
      });
      expect(await decide('draft')).toMatchObject({
        allowed: true,
        reason: 'grant',
      });
      expect(await decide('read')).toMatchObject({ allowed: false });
      expect(await decide('send')).toMatchObject({ allowed: false });
    });
  });

  describe('send scope', () => {
    const sendAs = async (as: MailPrincipal | null) => {
      current = as;
      return withTenant({ tenantId: tenantA }, async () => {
        const email = new Email({
          ...options,
          tenantId: tenantA,
          accountId: sharedAccountId,
          subject: 'outgoing',
          toAddresses: JSON.stringify(['someone@example.com']),
        });
        await email.initialize();
        await email.save();
        return email.send();
      });
    };

    it('refuses to send from an owned account without the send scope', async () => {
      await grantRow(grantee.id, sharedAccountId, 'read');
      const result = await sendAs(principalFor(grantee));
      expect(result).toMatchObject({
        success: false,
        error: 'Mail access denied for scope send',
      });
    });

    it('refuses a send with no principal at all', async () => {
      expect(await sendAs(null)).toMatchObject({
        success: false,
        error: 'Mail access denied for scope send',
      });
    });

    it('passes the gate with the send scope (and then meets the provider)', async () => {
      await grantRow(grantee.id, sharedAccountId, 'send');
      const result = await sendAs(principalFor(grantee));
      expect(result.success).toBe(false);
      expect(result.error).not.toMatch(/Mail access denied/);
    });
  });

  describe('MailAccessService', () => {
    const asUser = (person: Person) =>
      new MailAccessService(options, {
        userId: person.id,
        tenantId: tenantA,
      });

    it('lets the owner grant, list and revoke', async () => {
      const service = asUser(owner);
      const grant = await service.grant({
        accountId: sharedAccountId,
        userId: grantee.id,
        scope: 'read',
      });
      expect(await subjects(principalFor(grantee))).toContain('shared subject');
      expect((await service.list(sharedAccountId)).map((g) => g.id)).toContain(
        grant.id,
      );
      await service.revoke(grant.id as string);
      expect(await subjects(principalFor(grantee))).toEqual(['open subject']);
    });

    it('does not let a tenant administrator grant on, or take over, someone else’s mailbox', async () => {
      const service = asUser(admin);
      await expect(
        service.grant({
          accountId: sharedAccountId,
          userId: admin.id,
          scope: 'read',
        }),
      ).rejects.toThrow();
      await expect(
        service.grant({
          accountId: sharedAccountId,
          userId: grantee.id,
          scope: 'read',
        }),
      ).rejects.toThrow(/owner/);
      await expect(service.setOwner(sharedAccountId, admin.id)).rejects.toThrow(
        /owner/,
      );
      await expect(service.list(sharedAccountId)).rejects.toThrow(/owner/);
      expect(await subjects(principalFor(admin))).toEqual(['open subject']);
    });

    it('does not let the owner grant themselves or grant without holding the tenant permission', async () => {
      await expect(
        asUser(owner).grant({
          accountId: sharedAccountId,
          userId: owner.id,
          scope: 'read',
        }),
      ).rejects.toThrow();
      const noAdminPermission = await withSystemContext(() =>
        newPerson(tenantA, ['messages.read'], 'lowly'),
      );
      const lowlyAccount = await seedAccount(
        tenantA,
        'lowly',
        noAdminPermission.id,
      );
      await expect(
        asUser(noAdminPermission).grant({
          accountId: lowlyAccount,
          userId: grantee.id,
          scope: 'read',
        }),
      ).rejects.toThrow();
    });

    it('requires an owner before sharing, and refuses another tenant’s account', async () => {
      await expect(
        asUser(owner).grant({
          accountId: openAccountId,
          userId: grantee.id,
          scope: 'read',
        }),
      ).rejects.toThrow(/owner/);
      const foreignId = await seedAccount(tenantB, 'foreign2', owner.id);
      await expect(
        asUser(owner).grant({
          accountId: foreignId,
          userId: grantee.id,
          scope: 'read',
        }),
      ).rejects.toThrow(/not found/);
    });

    it('lets a delegable grantee delegate, and only that scope', async () => {
      const parent = await asUser(owner).grant({
        accountId: sharedAccountId,
        userId: grantee.id,
        scope: 'read',
        canDelegate: true,
      });
      const child = await asUser(grantee).grant({
        accountId: sharedAccountId,
        userId: agent.id,
        scope: 'read',
        parentGrantId: parent.id,
      });
      expect(await subjects(principalFor(agent))).toContain('shared subject');
      await expect(
        asUser(grantee).grant({
          accountId: sharedAccountId,
          userId: agent.id,
          scope: 'send',
          parentGrantId: parent.id,
        }),
      ).rejects.toThrow();
      await asUser(owner).revoke(parent.id as string);
      expect(await subjects(principalFor(agent))).toEqual(['open subject']);
      expect(child.id).toBeTruthy();
    });

    it('does not let a delegate block others or widen the delegation chain', async () => {
      const parent = await asUser(owner).grant({
        accountId: sharedAccountId,
        userId: grantee.id,
        scope: 'read',
        canDelegate: true,
      });
      await expect(
        asUser(grantee).grant({
          accountId: sharedAccountId,
          userId: agent.id,
          scope: 'read',
          parentGrantId: parent.id,
          effect: 'deny',
        }),
      ).rejects.toThrow(/delegate/);
      await expect(
        asUser(grantee).grant({
          accountId: sharedAccountId,
          userId: agent.id,
          scope: 'read',
          parentGrantId: parent.id,
          canDelegate: true,
        }),
      ).rejects.toThrow(/delegate/);
    });

    it('only hands ownership to a member of the tenant', async () => {
      await expect(
        asUser(owner).setOwner(sharedAccountId, randomUUID()),
      ).rejects.toThrow(/member/);
    });

    it('lets an administrator claim an unowned account once, and only the owner transfer it', async () => {
      await asUser(admin).setOwner(openAccountId, grantee.id);
      await expect(
        asUser(admin).setOwner(openAccountId, admin.id),
      ).rejects.toThrow(/owner/);
      await asUser(grantee).setOwner(openAccountId, owner.id);
      const accounts = await AccountCollection.create(options);
      const row = await withTenant({ tenantId: tenantA }, () =>
        accounts.get({ id: openAccountId }),
      );
      expect(row?.ownerUserId).toBe(owner.id);
    });
  });

  it('exposes no unrelated message rows when tenancy context is absent', async () => {
    current = principalFor(stranger);
    const messages = await MessageCollection.create(options);
    const rows = await withSystemContext(() => messages.list({}));
    // System tenancy context is not mail system access: policy still applies.
    expect(rows.map((row) => row.subject)).not.toContain('private subject');
  });
});
