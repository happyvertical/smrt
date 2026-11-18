/**
 * `MessagingSettingsService.listAccounts()` (#5162): principal-scoped account
 * discovery. HIGH-RISK (auth, tenancy): denials and isolation outnumber the
 * happy paths. Everything goes through `decideMailAccess`, so these tests pin
 * that the listing never shows more than the access policy would.
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
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  configureMailAccess,
  type MailScope,
  resetMailAccess,
} from '../access.js';
import { EmailAccount } from '../models/EmailAccount';
import {
  ensureMessagingPermissionsRegistered,
  messagingPrincipalFromPermissions,
} from '../permissions.js';
import { MessagingSettingsService } from '../services/MessagingSettingsService.js';
import { prepareMessageParents } from './fk-fixtures.js';

const SLUGS = [
  'messages.read',
  'messages.triage',
  'messages.draft',
  'messages.send',
];

describe('MessagingSettingsService.listAccounts (#5162)', () => {
  let db: DatabaseInterface;
  let options: { db: DatabaseInterface };
  let tenantA: string;
  let tenantB: string;
  let owner: string;
  let grantee: string;
  let stranger: string;
  let noCeiling: string;
  let ownerB: string;

  async function newUser(tenantId: string, slugs: string[], label: string) {
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
    await (
      await memberships.create({
        roleId: role.id as string,
        tenantId,
        userId: user.id as string,
      })
    ).save();
    return user.id as string;
  }

  async function seedAccount(
    tenantId: string,
    name: string,
    ownerUserId: string | null,
  ) {
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
      return account.id as string;
    });
  }

  async function grant(
    userId: string,
    accountId: string,
    scope: MailScope,
    tenantId = tenantA,
    extra: Record<string, unknown> = {},
  ) {
    return withTenant({ tenantId }, async () => {
      const grants = await ResourceGrantCollection.create(options);
      const row = await grants.create({
        tenantId,
        userId,
        resourceType: 'messages:account',
        resourceId: accountId,
        permission: `messages.${scope}`,
        ...extra,
      });
      await row.save();
      return row;
    });
  }

  const service = (
    userId: string | undefined,
    tenantId = tenantA,
    principalTenantId: string | undefined = tenantId,
  ) =>
    new MessagingSettingsService({
      db,
      tenantId,
      principal: messagingPrincipalFromPermissions([], {
        id: userId,
        userId,
        tenantId: principalTenantId,
      }),
      resolvePersonaTenantId: async () => null,
    });

  beforeEach(async () => {
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    options = { db };
    await prepareMessageParents(db);
    enableTenancy();
    ensureMessagingPermissionsRegistered();
    await withSystemContext(async () => {
      await syncPermissionCatalog(options);
      const tenants = await TenantCollection.create(options);
      const a = await tenants.create({ name: 'Tenant A' });
      await a.save();
      const b = await tenants.create({ name: 'Tenant B' });
      await b.save();
      tenantA = a.id as string;
      tenantB = b.id as string;
      owner = await newUser(tenantA, SLUGS, 'owner');
      grantee = await newUser(tenantA, SLUGS, 'grantee');
      stranger = await newUser(tenantA, SLUGS, 'stranger');
      noCeiling = await newUser(tenantA, ['messages.read'], 'noceiling');
      ownerB = await newUser(tenantB, SLUGS, 'owner-b');
    });
    // The listing decides with the service's principal; the resolver is only
    // there because enabling the policy needs one.
    configureMailAccess({ options, resolvePrincipal: () => null });
  });

  afterEach(async () => {
    resetMailAccess();
    disableTenancy();
    await db.close?.();
  });

  it('lists the owner their own accounts with every scope', async () => {
    const a = await seedAccount(tenantA, 'mine', owner);
    await seedAccount(tenantA, 'theirs', stranger);
    const { accounts, nextCursor } = await service(owner).listAccounts();
    expect(nextCursor).toBeNull();
    expect(accounts.map((x) => x.id)).toEqual([a]);
    expect(accounts[0]).toMatchObject({
      relation: 'owner',
      scopes: ['read', 'triage', 'draft', 'send'],
      ownerUserId: owner,
    });
    expect(JSON.stringify(accounts)).not.toMatch(/password|secret/i);
  });

  it('lists a grantee only the scopes their grants and ceiling allow', async () => {
    const a = await seedAccount(tenantA, 'shared', owner);
    await grant(grantee, a, 'read');
    await grant(grantee, a, 'draft');
    const { accounts } = await service(grantee).listAccounts();
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({
      id: a,
      relation: 'shared',
      scopes: ['read', 'draft'],
    });
  });

  it('applies the tenant ceiling: a grant without the matching permission is not an effective scope', async () => {
    const a = await seedAccount(tenantA, 'shared', owner);
    await grant(noCeiling, a, 'read');
    await grant(noCeiling, a, 'send');
    const { accounts } = await service(noCeiling).listAccounts();
    expect(accounts[0].scopes).toEqual(['read']);
  });

  it('omits unowned accounts, accounts with no grant, and revoked or denying grants', async () => {
    await seedAccount(tenantA, 'unowned', null);
    const other = await seedAccount(tenantA, 'other', owner);
    const denied = await seedAccount(tenantA, 'denied', owner);
    await grant(grantee, denied, 'read', tenantA, { effect: 'deny' });
    const revoked = await seedAccount(tenantA, 'revoked', owner);
    const row = await grant(grantee, revoked, 'read');
    await withTenant({ tenantId: tenantA }, async () => {
      row.revokedAt = new Date();
      await row.save();
    });
    expect(other).toBeTruthy();
    expect((await service(grantee).listAccounts()).accounts).toEqual([]);
    expect((await service(stranger).listAccounts()).accounts).toEqual([]);
  });

  it('fails closed with no principal user, a foreign-tenant principal, or no access policy', async () => {
    const a = await seedAccount(tenantA, 'mine', owner);
    await grant(grantee, a, 'read');
    expect((await service(undefined).listAccounts()).accounts).toEqual([]);
    expect(
      (await service(owner, tenantA, tenantB).listAccounts()).accounts,
    ).toEqual([]);
    resetMailAccess();
    expect((await service(owner).listAccounts()).accounts).toEqual([]);
    expect((await service(grantee).listAccounts()).accounts).toEqual([]);
  });

  it('isolates tenants: another tenant never leaks in, and a grant in another tenant does not count', async () => {
    const inB = await seedAccount(tenantB, 'b-mine', ownerB);
    await grant(grantee, inB, 'read', tenantB);
    const a = await seedAccount(tenantA, 'a-mine', owner);
    expect(
      (await service(owner).listAccounts()).accounts.map((x) => x.id),
    ).toEqual([a]);
    // A tenant A user asking for tenant A sees nothing of B, even with a stray grant row.
    expect((await service(grantee).listAccounts()).accounts).toEqual([]);
    // Tenant B's owner asking as tenant A is refused (principal tenant mismatch).
    expect(
      (await service(ownerB, tenantA, tenantB).listAccounts()).accounts,
    ).toEqual([]);
    expect(
      (await service(ownerB, tenantB).listAccounts()).accounts.map((x) => x.id),
    ).toEqual([inB]);
  });

  it('pages by cursor within a bounded page size', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push(await seedAccount(tenantA, `m${i}`, owner));
    }
    const svc = service(owner);
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page = await svc.listAccounts({ limit: 2, cursor });
      expect(page.accounts.length).toBeLessThanOrEqual(2);
      seen.push(...page.accounts.map((x) => x.id));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor && pages < 10);
    expect(pages).toBe(3);
    expect([...seen].sort()).toEqual([...ids].sort());
    expect(new Set(seen).size).toBe(5);
    // Out-of-range limits are clamped, never unbounded.
    expect((await svc.listAccounts({ limit: 0 })).accounts).toHaveLength(1);
    expect((await svc.listAccounts({ limit: 1e9 })).accounts).toHaveLength(5);
  });
});
