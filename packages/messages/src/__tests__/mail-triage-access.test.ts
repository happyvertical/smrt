/**
 * Triage write-back access (#5131, on #5129). HIGH-RISK (auth, tenancy, agent
 * permissions), so denials outnumber grants: every refused call must leave the
 * mail server and the local rows untouched.
 */

import { randomUUID } from 'node:crypto';
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
import { EmailAccountCollection, EmailCollection } from '../index.js';
import { inLane } from '../mail-sync.js';
import type { Email } from '../models/Email';
import { EmailAccount } from '../models/EmailAccount';
import { prepareMessageParents } from './fk-fixtures.js';
import { FakeMailServer } from './helpers/fake-mail-server';

const ALL_MAIL_SLUGS = [
  'messages.read',
  'messages.triage',
  'messages.draft',
  'messages.send',
  'messages.manage-access',
];

interface Person {
  id: string;
}

describe('mail triage access (#5131)', () => {
  let db: DatabaseInterface;
  let options: { db: DatabaseInterface };
  let tenantA: string;
  let tenantB: string;
  let owner: Person;
  let grantee: Person;
  let stranger: Person;
  let current: MailPrincipal | null = null;
  let server: FakeMailServer;
  let clientBuiltFor: EmailAccount[] = [];
  let ownedId: string;
  let openId: string;
  let ownedEmailId: string;
  let openEmailId: string;

  const principalFor = (
    person: Person,
    overrides: Partial<MailPrincipal> = {},
  ): MailPrincipal => ({
    id: `principal-${person.id}`,
    tenantId: tenantA,
    userId: person.id,
    ...overrides,
  });

  async function newPerson(slugs: string[], label: string): Promise<Person> {
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
      tenantId: tenantA,
      userId: user.id as string,
    });
    await membership.save();
    return { id: user.id as string };
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

  async function seedAccount(
    name: string,
    ownerUserId: string | null,
    providerId: string,
  ): Promise<{ accountId: string; emailId: string }> {
    return withTenant({ tenantId: tenantA }, async () => {
      const account = new EmailAccount({
        ...options,
        tenantId: tenantA,
        name,
        email: `${name}@example.com`,
        providerType: 'jmap',
        ownerUserId,
      });
      await account.initialize();
      await account.save();
      const accounts = await EmailAccountCollection.create(options);
      server.add(providerId);
      const stored = (await runWithMailSystemAccess(() =>
        accounts.get({ id: account.id }),
      )) as EmailAccount;
      await stored.syncChanges();
      const emails = await EmailCollection.create(options);
      const list = await runWithMailSystemAccess(
        async () =>
          (await emails.list({
            where: { accountId: account.id },
          })) as Email[],
      );
      return { accountId: account.id as string, emailId: list[0].id as string };
    });
  }

  /** Run triage as `as`, loading the account the way a host would. */
  async function triageAs(
    as: MailPrincipal | null,
    accountId: string,
    emailId: string,
    tenantId: string = tenantA,
  ) {
    current = as;
    return withTenant({ tenantId }, async () => {
      const account = (await runWithMailSystemAccess(async () =>
        (await EmailAccountCollection.create(options)).get({ id: accountId }),
      )) as EmailAccount;
      return account.triage({ kind: 'markRead' }, [emailId]);
    });
  }

  const isRead = async (emailId: string) =>
    runWithMailSystemAccess(async () => {
      const emails = await EmailCollection.create(options);
      return ((await emails.get({ id: emailId })) as Email).isRead;
    });

  /** The call is refused, nothing reaches the server, and the row is as it was. */
  async function expectDenied(
    run: () => Promise<unknown>,
    reason?: string,
  ): Promise<void> {
    const before = server.calls.length;
    const error = await run().then(
      () => null,
      (e) => e,
    );
    expect(error).toBeInstanceOf(MailAccessError);
    if (reason) expect((error as MailAccessError).reason).toBe(reason);
    expect(server.calls.length).toBe(before);
    expect(server.messages.get('own1')?.flags).toEqual([]);
    expect(await isRead(ownedEmailId)).toBe(false);
  }

  beforeEach(async () => {
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    options = { db };
    await prepareMessageParents(db);
    enableTenancy();
    server = new FakeMailServer();
    clientBuiltFor = [];
    vi.spyOn(EmailAccount.prototype, 'createClient').mockImplementation(
      async function (this: EmailAccount) {
        clientBuiltFor.push(this);
        return server.client as never;
      },
    );
    await withSystemContext(async () => {
      await syncPermissionCatalog(options);
      const tenants = await TenantCollection.create(options);
      const a = await tenants.create({ name: 'Tenant A' });
      await a.save();
      const b = await tenants.create({ name: 'Tenant B' });
      await b.save();
      tenantA = a.id as string;
      tenantB = b.id as string;
      owner = await newPerson(ALL_MAIL_SLUGS, 'owner');
      grantee = await newPerson(ALL_MAIL_SLUGS, 'grantee');
      stranger = await newPerson(ALL_MAIL_SLUGS, 'stranger');
    });
    current = null;
    ({ accountId: ownedId, emailId: ownedEmailId } = await seedAccount(
      'owned',
      owner.id,
      'own1',
    ));
    ({ accountId: openId, emailId: openEmailId } = await seedAccount(
      'open',
      null,
      'open1',
    ));
    configureMailAccess({ options, resolvePrincipal: () => current });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    resetMailAccess();
    disableTenancy();
    await db.close?.();
  });

  it('lets the owner triage their own account, without a grant', async () => {
    const result = await triageAs(principalFor(owner), ownedId, ownedEmailId);
    expect(result.updated).toEqual([ownedEmailId]);
    expect(await isRead(ownedEmailId)).toBe(true);
  });

  it('lets a grantee with read and triage grants triage', async () => {
    await grantRow(grantee.id, ownedId, 'read');
    await grantRow(grantee.id, ownedId, 'triage');
    const result = await triageAs(
      principalFor(grantee, { kind: 'agent' }),
      ownedId,
      ownedEmailId,
    );
    expect(result.updated).toEqual([ownedEmailId]);
    expect(await isRead(ownedEmailId)).toBe(true);
    // The acting principal is recorded as "handled by" (#5141).
    const handled = await runWithMailSystemAccess(async () => {
      const emails = await EmailCollection.create(options);
      return ((await emails.get({ id: ownedEmailId })) as Email).getHandledBy();
    });
    expect(handled).toMatchObject({ id: grantee.id, kind: 'agent' });
  });

  it('refuses a stranger with no grant', async () => {
    await expectDenied(
      () => triageAs(principalFor(stranger), ownedId, ownedEmailId),
      'denied',
    );
  });

  it('refuses a reader who holds no triage grant', async () => {
    await grantRow(grantee.id, ownedId, 'read');
    await expectDenied(
      () => triageAs(principalFor(grantee), ownedId, ownedEmailId),
      'denied',
    );
  });

  it('refuses a triage grant without the read scope (fails closed)', async () => {
    await grantRow(grantee.id, ownedId, 'triage');
    await expectDenied(() =>
      triageAs(principalFor(grantee), ownedId, ownedEmailId),
    );
  });

  it('refuses draft and send grants as a substitute for triage', async () => {
    await grantRow(grantee.id, ownedId, 'read');
    await grantRow(grantee.id, ownedId, 'draft');
    await grantRow(grantee.id, ownedId, 'send');
    await expectDenied(() =>
      triageAs(principalFor(grantee), ownedId, ownedEmailId),
    );
  });

  it('refuses a missing principal and an unconfigured host', async () => {
    await expectDenied(
      () => triageAs(null, ownedId, ownedEmailId),
      'no_principal',
    );
    // Without a host policy an owned account cannot be checked: closed.
    resetMailAccess();
    await expectDenied(() =>
      triageAs(principalFor(owner), ownedId, ownedEmailId),
    );
  });

  it('refuses a revoked grant', async () => {
    await grantRow(grantee.id, ownedId, 'read');
    const grant = await grantRow(grantee.id, ownedId, 'triage');
    await triageAs(principalFor(grantee), ownedId, ownedEmailId);
    await withTenant({ tenantId: tenantA }, async () => {
      await grant.delete();
    });
    await runWithMailSystemAccess(async () => {
      const emails = await EmailCollection.create(options);
      const row = (await emails.get({ id: ownedEmailId })) as Email;
      row.isRead = false;
      await row.save();
    });
    server.messages.get('own1')!.flags = [];
    await expectDenied(() =>
      triageAs(principalFor(grantee), ownedId, ownedEmailId),
    );
  });

  it('re-authorizes against the stored account: ownership changed after load', async () => {
    // Loaded while ownerless (tenant-wide), then claimed by someone else.
    const stale = (await runWithMailSystemAccess(async () =>
      (await EmailAccountCollection.create(options)).get({ id: openId }),
    )) as EmailAccount;
    await runWithMailSystemAccess(async () => {
      const fresh = (await (
        await EmailAccountCollection.create(options)
      ).get({ id: openId })) as EmailAccount;
      fresh.ownerUserId = owner.id;
      await fresh.save();
    });
    current = principalFor(stranger);
    const before = server.calls.length;
    const error = await withTenant({ tenantId: tenantA }, () =>
      stale.triage({ kind: 'markRead' }, [openEmailId]),
    ).then(
      () => null,
      (e) => e,
    );
    expect(error).toBeInstanceOf(MailAccessError);
    expect(server.calls.length).toBe(before);
    expect(server.messages.get('open1')?.flags).toEqual([]);
  });

  it('re-authorizes inside the lane: grant revoked while queued', async () => {
    await grantRow(grantee.id, ownedId, 'read');
    const grant = await grantRow(grantee.id, ownedId, 'triage');
    current = principalFor(grantee);
    let release!: () => void;
    const held = inLane(
      ownedId,
      () => new Promise<void>((resolve) => (release = resolve)),
    );
    const before = server.calls.length;
    const pending = withTenant({ tenantId: tenantA }, async () => {
      const account = (await runWithMailSystemAccess(async () =>
        (await EmailAccountCollection.create(options)).get({ id: ownedId }),
      )) as EmailAccount;
      return account.triage({ kind: 'markRead' }, [ownedEmailId]);
    }).then(
      () => null,
      (e) => e,
    );
    await new Promise((r) => setTimeout(r, 50));
    await withTenant({ tenantId: tenantA }, async () => {
      await grant.delete();
    });
    release();
    await held;
    const error = await pending;
    expect(error).toBeInstanceOf(MailAccessError);
    expect(server.calls.length).toBe(before);
    expect(await isRead(ownedEmailId)).toBe(false);
  });

  /** Queue a triage behind a held lane, change the stored row, then release. */
  async function triageWhileStoredChanges(
    accountId: string,
    emailId: string,
    mutate: (stored: EmailAccount) => void,
  ) {
    let release!: () => void;
    const held = inLane(
      accountId,
      () => new Promise<void>((resolve) => (release = resolve)),
    );
    const pending = withTenant({ tenantId: tenantA }, async () => {
      const account = (await runWithMailSystemAccess(async () =>
        (await EmailAccountCollection.create(options)).get({ id: accountId }),
      )) as EmailAccount;
      return account.triage({ kind: 'markRead' }, [emailId]);
    }).then(
      (value) => ({ value, error: null as unknown }),
      (error) => ({ value: null, error }),
    );
    await new Promise((r) => setTimeout(r, 50));
    await runWithMailSystemAccess(async () => {
      const row = (await (
        await EmailAccountCollection.create(options)
      ).get({ id: accountId })) as EmailAccount;
      mutate(row);
      await row.save();
    });
    release();
    await held;
    return pending;
  }

  it('denies when the stored owner changes while queued, with no server call', async () => {
    current = principalFor(owner);
    const before = server.calls.length;
    const { error } = await triageWhileStoredChanges(
      ownedId,
      ownedEmailId,
      (row) => {
        row.ownerUserId = stranger.id;
      },
    );
    expect(error).toBeInstanceOf(MailAccessError);
    expect(server.calls.length).toBe(before);
    expect(await isRead(ownedEmailId)).toBe(false);
  });

  it('builds the client from the stored row, not the caller instance', async () => {
    current = principalFor(owner);
    clientBuiltFor = [];
    const { value, error } = await triageWhileStoredChanges(
      ownedId,
      ownedEmailId,
      (row) => {
        row.name = 'reconnected-while-queued';
      },
    );
    expect(error).toBeNull();
    expect(value?.updated).toEqual([ownedEmailId]);
    expect(clientBuiltFor).toHaveLength(1);
    expect(clientBuiltFor[0].name).toBe('reconnected-while-queued');
  });

  it('refuses a principal whose host ceiling excludes triage or the account', async () => {
    await grantRow(grantee.id, ownedId, 'read');
    await grantRow(grantee.id, ownedId, 'triage');
    await expectDenied(
      () =>
        triageAs(
          principalFor(grantee, { scopes: ['read', 'draft'] }),
          ownedId,
          ownedEmailId,
        ),
      'ceiling',
    );
    await expectDenied(
      () =>
        triageAs(
          principalFor(grantee, { accountIds: [openId] }),
          ownedId,
          ownedEmailId,
        ),
      'ceiling',
    );
    await expectDenied(
      () =>
        triageAs(principalFor(grantee, { scopes: [] }), ownedId, ownedEmailId),
      'ceiling',
    );
  });

  it('refuses a principal from another tenant', async () => {
    await expectDenied(
      () =>
        triageAs(
          principalFor(owner, { tenantId: tenantB }),
          ownedId,
          ownedEmailId,
        ),
      'tenant_mismatch',
    );
  });

  it('keeps a granted principal inside the account it was granted', async () => {
    await grantRow(grantee.id, openId, 'read');
    await grantRow(grantee.id, openId, 'triage');
    // The grant on the open account does not carry to the owned one, and an
    // email id from the owned account is not reachable through the open one.
    await expectDenied(() =>
      triageAs(principalFor(grantee), ownedId, ownedEmailId),
    );
    current = principalFor(grantee);
    const crossed = await withTenant({ tenantId: tenantA }, async () => {
      const account = (await runWithMailSystemAccess(async () =>
        (await EmailAccountCollection.create(options)).get({ id: openId }),
      )) as EmailAccount;
      return account.triage({ kind: 'markRead' }, [ownedEmailId]);
    });
    expect(crossed.updated).toEqual([]);
    expect(crossed.failed).toEqual([{ id: ownedEmailId, code: 'notFound' }]);
    expect(await isRead(ownedEmailId)).toBe(false);
  });

  it('keeps an ownerless account tenant-wide, as before', async () => {
    const result = await triageAs(principalFor(stranger), openId, openEmailId);
    expect(result.updated).toEqual([openEmailId]);
  });

  it("does not let a tenant administrator triage someone else's mailbox", async () => {
    const admin = await withSystemContext(() =>
      newPerson([...ALL_MAIL_SLUGS, 'messages.manage-credentials'], 'admin'),
    );
    await expectDenied(() =>
      triageAs(principalFor(admin), ownedId, ownedEmailId),
    );
  });

  it('is not bypassed by Email.triage', async () => {
    current = principalFor(stranger);
    const error = await withTenant({ tenantId: tenantA }, async () => {
      const row = await runWithMailSystemAccess(async () => {
        const emails = await EmailCollection.create(options);
        return (await emails.get({ id: ownedEmailId })) as Email;
      });
      return row.triage({ kind: 'markRead' }).catch((e) => e);
    });
    expect(error).toBeInstanceOf(Error);
    expect(server.calls.filter((c) => c.method === 'updateFlags')).toEqual([]);
    expect(await isRead(ownedEmailId)).toBe(false);
  });
});
