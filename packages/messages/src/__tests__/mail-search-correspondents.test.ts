/**
 * Mail search and private correspondents (#5132). HIGH-RISK (authorization,
 * privacy): denials and isolation outnumber the happy paths.
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
  learnMailAccessOptions,
  type MailScope,
  resetMailAccess,
  runWithMailSystemAccess,
} from '../access.js';
import { EmailCollection } from '../collections/EmailCollection';
import { Email } from '../models/Email';
import { EmailAccount } from '../models/EmailAccount';
import {
  ensureMessagingPermissionsRegistered,
  messagingPrincipalFromPermissions,
} from '../permissions.js';
import { CorrespondentService } from '../services/CorrespondentService.js';
import { MailSearchService } from '../services/MailSearchService.js';
import { prepareMessageParents } from './fk-fixtures.js';

const SLUGS = [
  'messages.read',
  'messages.triage',
  'messages.draft',
  'messages.send',
];

describe('mail search and correspondents (#5132)', () => {
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

  const opts = (
    userId: string | undefined,
    tenantId = tenantA,
    principalTenantId: string | undefined = tenantId,
    extra: { scopes?: MailScope[]; accountIds?: string[] } = {},
  ) => ({
    db,
    tenantId,
    principal: messagingPrincipalFromPermissions([], {
      id: userId,
      userId,
      tenantId: principalTenantId,
      ...extra,
    }),
  });
  const search = (
    userId: string | undefined,
    ...rest: [] | [string, string?]
  ) => new MailSearchService(opts(userId, ...rest));
  const people = (
    userId: string | undefined,
    ...rest: [] | [string, string?]
  ) => new CorrespondentService(opts(userId, ...rest));

  let counter = 0;
  async function seedEmail(
    accountId: string,
    fields: Record<string, unknown> = {},
    tenantId = tenantA,
  ) {
    counter += 1;
    return withTenant({ tenantId }, async () => {
      const emails = await EmailCollection.create(options);
      const email = new Email({
        ...options,
        tenantId,
        accountId,
        subject: `Subject ${counter}`,
        fromAddress: 'alice@acme.test',
        fromName: 'Alice',
        toAddresses: '[]',
        textBody: `Body ${counter}`,
        body: `Body ${counter}`,
        providerMessageId: `pm-${counter}`,
        date: new Date(Date.UTC(2026, 0, counter)),
        ...fields,
      } as never);
      await email.initialize();
      await runWithMailSystemAccess(() => email.save());
      void emails;
      return email.id as string;
    });
  }

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

  it('searches only accounts the principal may read, owner and grantee', async () => {
    const mine = await seedAccount(tenantA, 'mine', owner);
    const shared = await seedAccount(tenantA, 'shared', stranger);
    const closed = await seedAccount(tenantA, 'closed', stranger);
    await grant(owner, shared, 'read');
    await seedEmail(mine, { subject: 'invoice alpha' });
    await seedEmail(shared, { subject: 'invoice beta' });
    await seedEmail(closed, { subject: 'invoice secret' });
    const page = await search(owner).search({ text: 'invoice' });
    expect(page.hits.map((h) => h.subject).sort()).toEqual([
      'invoice alpha',
      'invoice beta',
    ]);
    expect(page.accountIds.sort()).toEqual([mine, shared].sort());
    const nobody = await search(grantee).search({ text: 'invoice' });
    expect(nobody.hits).toEqual([]);
  });

  it('an account filter can only narrow, never widen, the readable set', async () => {
    const mine = await seedAccount(tenantA, 'mine', owner);
    const closed = await seedAccount(tenantA, 'closed', stranger);
    await seedEmail(mine, { subject: 'a' });
    await seedEmail(closed, { subject: 'b' });
    const page = await search(owner).search({ accountIds: [closed] });
    expect(page.hits).toEqual([]);
    expect(page.accountIds).toEqual([]);
    const both = await search(owner).search({ accountIds: [closed, mine] });
    expect(both.hits.map((h) => h.subject)).toEqual(['a']);
  });

  it('read scope is required: triage-only grants, deny grants and revoked grants search nothing', async () => {
    const a = await seedAccount(tenantA, 'a', owner);
    await seedEmail(a, { subject: 'hidden' });
    await grant(grantee, a, 'triage');
    expect((await search(grantee).search({})).hits).toEqual([]);
    await grant(stranger, a, 'read', tenantA, { effect: 'deny' });
    expect((await search(stranger).search({})).hits).toEqual([]);
    const row = await grant(noCeiling, a, 'read');
    expect((await search(noCeiling).search({})).hits).toHaveLength(1);
    await withTenant({ tenantId: tenantA }, async () => {
      row.revokedAt = new Date();
      await row.save();
    });
    expect((await search(noCeiling).search({})).hits).toEqual([]);
  });

  it('fails closed: no principal user, foreign tenant, no access policy, tenant isolation', async () => {
    const a = await seedAccount(tenantA, 'a', owner);
    await seedEmail(a, { subject: 'x' });
    const b = await seedAccount(tenantB, 'b', ownerB);
    await seedEmail(b, { subject: 'y' }, tenantB);
    expect((await search(undefined).search({})).hits).toEqual([]);
    expect((await search(owner, tenantA, tenantB).search({})).hits).toEqual([]);
    expect((await search(ownerB).search({})).hits).toEqual([]);
    expect(
      (await search(ownerB, tenantB).search({})).hits.map((h) => h.subject),
    ).toEqual(['y']);
    resetMailAccess();
    expect((await search(owner).search({})).hits).toEqual([]);
  });

  it('honours an agent ceiling on scopes and account ids', async () => {
    const a = await seedAccount(tenantA, 'a', owner);
    const b = await seedAccount(tenantA, 'b', owner);
    await seedEmail(a, { subject: 'in a' });
    await seedEmail(b, { subject: 'in b' });
    const only = new MailSearchService(
      opts(owner, tenantA, tenantA, { accountIds: [a] }),
    );
    expect((await only.search({})).hits.map((h) => h.subject)).toEqual([
      'in a',
    ]);
    const noRead = new MailSearchService(
      opts(owner, tenantA, tenantA, { scopes: ['triage'] }),
    );
    expect((await noRead.search({})).hits).toEqual([]);
  });

  it('keyword filters: text, from, to, subject, label, date, flags, case-insensitively', async () => {
    const a = await seedAccount(tenantA, 'a', owner);
    await seedEmail(a, {
      subject: 'Quarterly Report',
      fromAddress: 'bob@corp.test',
      fromName: 'Bob',
      toAddresses: JSON.stringify([{ address: 'carol@corp.test' }]),
      labels: JSON.stringify(['Finance']),
      hasAttachments: true,
      isFlagged: true,
      date: new Date('2026-03-01'),
    });
    await seedEmail(a, {
      subject: 'Lunch',
      textBody: 'noodles at noon',
      body: 'noodles at noon',
      date: new Date('2026-04-01'),
    });
    const s = search(owner);
    expect((await s.search({ text: 'QUARTERLY report' })).hits).toHaveLength(1);
    expect(
      (await s.search({ text: 'NOODLES' })).hits.map((h) => h.subject),
    ).toEqual(['Lunch']);
    expect((await s.search({ from: 'BOB' })).hits).toHaveLength(1);
    expect((await s.search({ to: 'carol@' })).hits).toHaveLength(1);
    expect((await s.search({ subject: 'lunch' })).hits).toHaveLength(1);
    expect((await s.search({ label: 'finance' })).hits).toHaveLength(1);
    expect((await s.search({ hasAttachment: true })).hits).toHaveLength(1);
    expect((await s.search({ isFlagged: true })).hits).toHaveLength(1);
    expect(
      (await s.search({ since: new Date('2026-03-15') })).hits.map(
        (h) => h.subject,
      ),
    ).toEqual(['Lunch']);
    expect(
      (await s.search({ before: new Date('2026-03-15') })).hits.map(
        (h) => h.subject,
      ),
    ).toEqual(['Quarterly Report']);
    // LIKE wildcards in user text are literal.
    expect((await s.search({ text: '%' })).hits).toEqual([]);
  });

  it('pages newest first with a cursor and no duplicates', async () => {
    const a = await seedAccount(tenantA, 'a', owner);
    for (let i = 0; i < 5; i += 1)
      await seedEmail(a, {
        subject: `m${i}`,
        date: new Date(Date.UTC(2026, 1, i + 1)),
      });
    const s = search(owner);
    const p1 = await s.search({ limit: 2 });
    const p2 = await s.search({ limit: 2, cursor: p1.nextCursor });
    const p3 = await s.search({ limit: 2, cursor: p2.nextCursor });
    expect([...p1.hits, ...p2.hits, ...p3.hits].map((h) => h.subject)).toEqual([
      'm4',
      'm3',
      'm2',
      'm1',
      'm0',
    ]);
    expect(p3.nextCursor).toBeNull();
    await expect(s.search({ cursor: 'x' })).rejects.toThrow(/cursor/);
    await expect(s.search({ limit: 0 })).rejects.toThrow(/limit/);
  });

  it('semantic mode scopes the ranking to readable accounts and falls back when unavailable', async () => {
    const mine = await seedAccount(tenantA, 'mine', owner);
    const closed = await seedAccount(tenantA, 'closed', stranger);
    const id = await seedEmail(mine, { subject: 'budget forecast' });
    await seedEmail(closed, { subject: 'budget secret' });
    const spy = vi
      .spyOn(EmailCollection.prototype, 'semanticMatches')
      .mockResolvedValueOnce([{ id, similarity: 0.9 }]);
    const ranked = await search(owner).search({
      text: 'money plan',
      mode: 'semantic',
    });
    expect(ranked.semanticUsed).toBe(true);
    expect(ranked.hits.map((h) => h.subject)).toEqual(['budget forecast']);
    const where = spy.mock.calls[0][1] as Record<string, unknown>;
    expect(where['accountId in']).toEqual([mine]);
    spy.mockResolvedValueOnce(null);
    const fell = await search(owner).search({
      text: 'budget',
      mode: 'semantic',
    });
    expect(fell.semanticUsed).toBe(false);
    expect(fell.hits.map((h) => h.subject)).toEqual(['budget forecast']);
    spy.mockRestore();
  });

  it('provider search asks each readable account, falls back locally per account, never touches unreadable ones', async () => {
    const good = await seedAccount(tenantA, 'good', owner);
    const bad = await seedAccount(tenantA, 'bad', owner);
    const closed = await seedAccount(tenantA, 'closed', stranger);
    await seedEmail(good, {
      subject: 'synced one',
      providerMessageId: 'srv-1',
    });
    await seedEmail(bad, { subject: 'local only' });
    const touched: string[] = [];
    const spy = vi
      .spyOn(EmailAccount.prototype, 'createClient')
      .mockImplementation(async function (this: EmailAccount) {
        touched.push(this.id as string);
        if (this.id === bad) throw new Error('boom');
        return {
          connect: async () => undefined,
          disconnect: async () => undefined,
          getCapabilities: async () => ({ search: true }),
          search: async () => [
            {
              id: 'srv-1',
              subject: 'synced one',
              from: { address: 'a@b.test' },
              to: [],
              date: new Date('2026-05-01'),
            },
            {
              id: 'srv-2',
              subject: 'server only',
              from: { address: 'c@d.test' },
              to: [],
              date: new Date('2026-05-02'),
            },
          ],
        } as never;
      });
    const res = await search(owner).searchProvider({});
    expect(touched.sort()).toEqual([good, bad].sort());
    expect(touched).not.toContain(closed);
    expect(res.providerAccountIds).toEqual([good]);
    expect(res.fallbackAccounts.map((f) => f.accountId)).toEqual([bad]);
    const bySubject = new Map(res.hits.map((h) => [h.subject, h]));
    expect(bySubject.get('synced one')?.emailId).toBeTruthy();
    expect(bySubject.get('server only')?.emailId).toBeNull();
    expect(bySubject.get('local only')?.source).toBe('local');
    spy.mockRestore();
  });

  it('provider search applies label, flagged:false and read filters, fills the page after filtering, and hides provider error text', async () => {
    const good = await seedAccount(tenantA, 'good', owner);
    const bad = await seedAccount(tenantA, 'bad', owner);
    const mk = (i: number, extra: Record<string, unknown> = {}) => ({
      id: `srv-${i}`,
      subject: `s${i}`,
      from: { address: 'a@b.test' },
      to: [],
      date: new Date(Date.UTC(2026, 4, i + 1)),
      ...extra,
    });
    const spy = vi
      .spyOn(EmailAccount.prototype, 'createClient')
      .mockImplementation(async function (this: EmailAccount) {
        if (this.id === bad) throw new Error('secret-host.internal refused');
        return {
          connect: async () => undefined,
          disconnect: async () => undefined,
          getCapabilities: async () => ({ search: true }),
          search: async () => [
            mk(1, { flags: ['\\Flagged'], labels: ['Work'] }),
            mk(2, { labels: ['Work'] }),
            mk(3, { labels: ['Home'] }),
            mk(4, { labels: ['Work'] }),
          ],
        } as never;
      });
    const s = search(owner);
    const unflagged = await s.searchProvider({
      accountIds: [good],
      isFlagged: false,
      label: 'work',
      limit: 2,
    });
    expect(unflagged.hits.map((h) => h.subject)).toEqual(['s4', 's2']);
    const flagged = await s.searchProvider({
      accountIds: [good],
      isFlagged: true,
    });
    expect(flagged.hits.map((h) => h.subject)).toEqual(['s1']);
    const failed = await s.searchProvider({ accountIds: [bad] });
    expect(failed.fallbackAccounts).toEqual([
      { accountId: bad, reason: 'provider search failed' },
    ]);
    spy.mockRestore();
  });

  describe('correspondents', () => {
    it('derives private correspondents from readable mail, with counts and the latest name', async () => {
      const a = await seedAccount(tenantA, 'a', owner);
      await seedEmail(a, {
        fromAddress: 'Alice@Acme.test',
        fromName: 'Alice A',
        date: new Date('2026-01-01'),
      });
      await seedEmail(a, {
        fromAddress: 'alice@acme.test',
        fromName: 'Alice Acme',
        date: new Date('2026-02-01'),
      });
      await seedEmail(a, {
        fromAddress: 'a@example.com',
        toAddresses: JSON.stringify([
          { address: 'bob@corp.test', name: 'Bob' },
        ]),
        date: new Date('2026-03-01'),
      });
      const svc = people(owner);
      const r = await svc.refresh();
      expect(r.scanned).toBe(3);
      const { correspondents } = await svc.list();
      const alice = correspondents.find((c) => c.address === 'alice@acme.test');
      expect(alice).toMatchObject({
        displayName: 'Alice Acme',
        sentCount: 2,
        messageCount: 2,
        profileId: null,
      });
      expect(correspondents.map((c) => c.address)).not.toContain(
        'me@example.com',
      );
      expect(
        correspondents.find((c) => c.address === 'bob@corp.test')
          ?.receivedCount,
      ).toBe(1);
      // idempotent
      await svc.refresh();
      expect(
        (await svc.list()).correspondents.find(
          (c) => c.address === 'alice@acme.test',
        )?.messageCount,
      ).toBe(2);
    });

    it('is owner-private: another reader of the same account sees only their own set', async () => {
      const a = await seedAccount(tenantA, 'a', owner);
      await grant(grantee, a, 'read');
      await seedEmail(a, { fromAddress: 'zed@z.test' });
      await people(owner).refresh();
      expect((await people(grantee).list()).correspondents).toEqual([]);
      const id = (await people(owner).list()).correspondents[0].id;
      expect(await people(grantee).get(id)).toBeNull();
      await expect(
        people(grantee).linkProfile(id, randomUUID()),
      ).rejects.toThrow();
      await people(grantee).refresh();
      expect((await people(grantee).list()).correspondents).toHaveLength(1);
      expect((await people(stranger).list()).correspondents).toEqual([]);
      expect((await people(undefined).list()).correspondents).toEqual([]);
      expect((await people(ownerB, tenantB).list()).correspondents).toEqual([]);
    });

    it('hides correspondents once read access to their accounts is revoked', async () => {
      const a = await seedAccount(tenantA, 'a', owner);
      const row = await grant(grantee, a, 'read');
      await seedEmail(a, { fromAddress: 'zed@z.test' });
      await people(grantee).refresh();
      expect((await people(grantee).list()).correspondents).toHaveLength(1);
      await withTenant({ tenantId: tenantA }, async () => {
        row.revokedAt = new Date();
        await row.save();
      });
      expect((await people(grantee).list()).correspondents).toEqual([]);
      expect(await people(grantee).suggest('zed')).toEqual([]);
      await people(grantee).refresh();
    });

    it('refresh never erases data it could not scan: no policy, tenant mismatch, no read scope', async () => {
      const a = await seedAccount(tenantA, 'a', owner);
      await seedEmail(a, { fromAddress: 'zed@z.test' });
      const svc = people(owner);
      await svc.refresh();
      resetMailAccess();
      expect(await people(owner).refresh()).toMatchObject({
        upserted: 0,
        removed: 0,
      });
      configureMailAccess({ options, resolvePrincipal: () => null });
      expect(await people(owner, tenantA, tenantB).refresh()).toMatchObject({
        upserted: 0,
        removed: 0,
      });
      expect((await svc.list()).correspondents).toHaveLength(1);
    });

    it('delegated principals (agent ceilings, triage-only) cannot read, refresh or link; data is untouched', async () => {
      const a = await seedAccount(tenantA, 'a', owner);
      const b = await seedAccount(tenantA, 'b', owner);
      await seedEmail(a, { fromAddress: 'zed@z.test' });
      await seedEmail(b, { fromAddress: 'yan@y.test' });
      await people(owner).refresh();
      const id = (await people(owner).list()).correspondents[0].id;
      for (const extra of [
        { accountIds: [a] },
        { scopes: ['triage'] as MailScope[] },
        { scopes: ['read'] as MailScope[] },
      ]) {
        const agent = new CorrespondentService(
          opts(owner, tenantA, tenantA, extra),
        );
        await expect(agent.refresh()).rejects.toThrow(/private/);
        await expect(agent.linkProfile(id, randomUUID())).rejects.toThrow(
          /private/,
        );
        await expect(agent.unlinkProfile(id)).rejects.toThrow(/private/);
        expect((await agent.list()).correspondents).toEqual([]);
        expect(await agent.suggest('zed')).toEqual([]);
        expect(await agent.get(id)).toBeNull();
      }
      expect((await people(owner).list()).correspondents).toHaveLength(2);
      // Explicit owner consent lifts the gate; a narrower scan keeps the rest.
      const consented = new CorrespondentService({
        ...opts(owner, tenantA, tenantA, { accountIds: [a] }),
        allowDelegated: true,
      });
      await consented.refresh();
      expect((await people(owner).list()).correspondents).toHaveLength(2);
      expect(
        (await consented.list()).correspondents.map((c) => c.address),
      ).toEqual(['zed@z.test']);
    });

    it("a correspondent seen in a readable and a revoked account shows only the readable account's numbers", async () => {
      const a = await seedAccount(tenantA, 'a', owner);
      const b = await seedAccount(tenantA, 'b', owner);
      await grant(grantee, a, 'read');
      const rowB = await grant(grantee, b, 'read');
      await seedEmail(a, {
        fromAddress: 'zed@z.test',
        fromName: 'Zed Public',
        date: new Date('2026-01-01'),
      });
      await seedEmail(b, {
        fromAddress: 'zed@z.test',
        fromName: 'Zed Secret',
        date: new Date('2026-06-01'),
      });
      await seedEmail(b, {
        fromAddress: 'zed@z.test',
        fromName: '',
        date: new Date('2026-07-01'),
      });
      const svc = people(grantee);
      await svc.refresh();
      const both = (await svc.list()).correspondents[0];
      expect(both).toMatchObject({
        messageCount: 3,
        displayName: 'Zed Secret',
      });
      await withTenant({ tenantId: tenantA }, async () => {
        rowB.revokedAt = new Date();
        await rowB.save();
      });
      const only = (await svc.list()).correspondents[0];
      expect(only).toMatchObject({
        messageCount: 1,
        sentCount: 1,
        displayName: 'Zed Public',
        accountIds: [a],
      });
      expect(only.lastContactAt).toEqual(new Date('2026-01-01'));
      expect((await svc.suggest('zed'))[0].messageCount).toBe(1);
      expect((await svc.get(only.id))?.messageCount).toBe(1);
      // Refresh keeps what it could not scan, and a re-grant restores it.
      await svc.refresh();
      await withTenant({ tenantId: tenantA }, async () => {
        rowB.revokedAt = null;
        await rowB.save();
      });
      expect((await svc.list()).correspondents[0].messageCount).toBe(3);
    });

    it('a mailbox that no longer mentions an address drops it on refresh, unless it is linked', async () => {
      const a = await seedAccount(tenantA, 'a', owner);
      const id1 = await seedEmail(a, { fromAddress: 'gone@g.test' });
      await seedEmail(a, { fromAddress: 'stay@s.test' });
      const svc = people(owner);
      await svc.refresh();
      await withTenant({ tenantId: tenantA }, async () => {
        const emails = await EmailCollection.create(options);
        const row = (
          await runWithMailSystemAccess(() =>
            emails.list({ where: { id: id1 }, limit: 1 }),
          )
        )[0];
        await runWithMailSystemAccess(() => row.delete());
      });
      const r = await svc.refresh();
      expect(r.removed).toBe(1);
      expect((await svc.list()).correspondents.map((c) => c.address)).toEqual([
        'stay@s.test',
      ]);
    });

    it('suggests for recipient autocomplete: address or name prefix, best first', async () => {
      const a = await seedAccount(tenantA, 'a', owner);
      await seedEmail(a, {
        fromAddress: 'sam@one.test',
        fromName: 'Samantha Jones',
      });
      await seedEmail(a, {
        fromAddress: 'sam@one.test',
        fromName: 'Samantha Jones',
      });
      await seedEmail(a, { fromAddress: 'bob@two.test', fromName: 'Bob Sam' });
      const svc = people(owner);
      await svc.refresh();
      expect((await svc.suggest('sam')).map((c) => c.address)).toEqual([
        'sam@one.test',
        'bob@two.test',
      ]);
      expect(await svc.suggest('  ')).toEqual([]);
      expect(await svc.suggest('nomatch')).toEqual([]);
    });

    it("links and unlinks a profile only on the owner's choice, within the tenant", async () => {
      const a = await seedAccount(tenantA, 'a', owner);
      await seedEmail(a, { fromAddress: 'zed@z.test' });
      const svc = people(owner);
      await svc.refresh();
      const id = (await svc.list()).correspondents[0].id;
      await expect(svc.linkProfile(id, randomUUID())).rejects.toThrow(
        /Profile not found/,
      );
      const { Profile, ProfileType } = await import(
        '@happyvertical/smrt-profiles'
      );
      const type = new ProfileType({
        db,
        name: 'Person',
        slug: `person-${randomUUID()}`,
      });
      await type.initialize();
      await type.save();
      const profileId = await withTenant({ tenantId: tenantA }, async () => {
        const p = new Profile({
          db,
          tenantId: tenantA,
          name: 'Zed',
          email: 'zed@z.test',
          typeId: type.id as string,
        });
        await p.initialize();
        await p.save();
        return p.id as string;
      });
      expect((await svc.linkProfile(id, profileId)).profileId).toBe(profileId);
      await svc.refresh();
      expect((await svc.get(id))?.profileId).toBe(profileId);
      expect((await svc.unlinkProfile(id)).profileId).toBeNull();
    });
  });
});
