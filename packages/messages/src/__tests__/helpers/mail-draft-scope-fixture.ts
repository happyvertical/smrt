import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
import { afterAll, afterEach, beforeAll, beforeEach, vi } from 'vitest';
import {
  configureMailAccess,
  MailAccessError,
  type MailPrincipal,
  type MailScope,
  resetMailAccess,
  runWithMailSystemAccess,
} from '../../access.js';
import '../../index.js';
import { MailDraftService } from '../../mail-drafts.js';
import { Attachment } from '../../models/Attachment';
import { Email } from '../../models/Email';
import { EmailAccount } from '../../models/EmailAccount';
import { Message } from '../../models/Message';
import {
  configureMailSendApprovals,
  resetMailSendApprovals,
} from '../../send-approval.js';
import { prepareMessageParents } from '../fk-fixtures.js';

const ALL_MAIL_SLUGS = [
  'messages.read',
  'messages.triage',
  'messages.draft',
  'messages.send',
];

export interface Person {
  id: string;
}

/**
 * The shared fixture of the draft-scope suites: one tenant, an owner, a
 * drafter, a sender and a stranger, an owned and an open account, and a
 * principal the tests switch with `as()`. Registers its own hooks, so call it
 * inside a `describe`. The suites are split across files because a single
 * file holds the memory of all of them.
 *
 * The schema, permission catalog, tenant, people, accounts and grants are
 * built once per file into a template SQLite file; each test copies it, so a
 * test gets a fresh, isolated database without paying for the schema again
 * (#5723).
 */
export function useMailDraftScopeFixture() {
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
          '../../collections/EmailCollection.js'
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
          '../../collections/EmailCollection.js'
        );
        return Boolean(
          await (await EmailCollection.create(options)).get({ id }),
        );
      }),
    );

  let scratchDir: string;
  let templatePath: string;
  let testPath: string | undefined;
  let testCount = 0;

  beforeAll(async () => {
    scratchDir = await mkdtemp(join(tmpdir(), 'mail-draft-scope-'));
    templatePath = join(scratchDir, 'template.db');
    const template = await getTestDatabase({
      type: 'sqlite',
      url: templatePath,
    });
    db = template;
    options = { db: template };
    try {
      await prepareMessageParents(template);
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
    } finally {
      disableTenancy();
      await template.close?.();
    }
  });

  afterAll(async () => {
    await rm(scratchDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    testPath = join(scratchDir, `test-${testCount++}.db`);
    await copyFile(templatePath, testPath);
    db = await getTestDatabase({ type: 'sqlite', url: testPath });
    options = { db };
    enableTenancy();
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
    if (testPath) await rm(testPath, { force: true });
  });

  return {
    get db() {
      return db;
    },
    get options() {
      return options;
    },
    get tenantId() {
      return tenantId;
    },
    get owner() {
      return owner;
    },
    get drafter() {
      return drafter;
    },
    get sender() {
      return sender;
    },
    get stranger() {
      return stranger;
    },
    get ownedId() {
      return ownedId;
    },
    get openId() {
      return openId;
    },
    get providerSend() {
      return providerSend;
    },
    setCurrent(who: MailPrincipal | null) {
      current = who;
    },
    principal,
    as,
    grant,
    seedAccount,
    newDraft,
    seedDraft,
    seedReceived,
    countBySubject,
    load,
    exists,
  };
}
