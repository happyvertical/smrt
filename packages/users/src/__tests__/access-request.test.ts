/**
 * AccessRequest lifecycle tests
 *
 * Covers the "request access / waitlist" identity primitive end to end:
 * 1. Public-safe creation (email validation + normalization + dedup)
 * 2. State machine (approve / decline / cancel) with idempotency + invalid-
 *    transition guards
 * 3. Operator reads (list filters / get)
 * 4. Capability gating (authorize hook) — create stays public-safe
 * 5. Lifecycle events (created / approved / declined / graduated), best-effort
 * 6. Graduation across all three tenant paths (new / existing / none),
 *    idempotency, and create-or-link by email
 */

import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MembershipCollection } from '../collections/MembershipCollection.js';
import { RoleCollection } from '../collections/RoleCollection.js';
import { TenantCollection } from '../collections/TenantCollection.js';
import { UserCollection } from '../collections/UserCollection.js';
import {
  ACCESS_REQUEST_CAPABILITIES,
  type AccessRequestAuthorizationContext,
  AccessRequestError,
  type AccessRequestEvent,
  AccessRequestService,
} from '../services/AccessRequestService.js';
import {
  AccessRequestStatus,
  DEFAULT_ROLE_SLUGS,
  MembershipStatus,
  UserStatus,
} from '../types/index.js';

describe('AccessRequest', () => {
  let dbPath: string;
  let db: { type: 'sqlite'; url: string };
  let events: AccessRequestEvent[];
  let service: AccessRequestService;
  let users: UserCollection;
  let tenants: TenantCollection;
  let roles: RoleCollection;
  let memberships: MembershipCollection;

  beforeEach(async () => {
    dbPath = join(tmpdir(), `smrt-access-request-${randomUUID()}.db`);
    db = { type: 'sqlite', url: dbPath };
    events = [];
    service = await AccessRequestService.create({
      db,
      onEvent: (event) => {
        events.push(event);
      },
    });
    users = await UserCollection.create({ db });
    tenants = await TenantCollection.create({ db });
    roles = await RoleCollection.create({ db });
    memberships = await MembershipCollection.create({ db });
  });

  afterEach(() => {
    if (existsSync(dbPath)) {
      try {
        rmSync(dbPath, { force: true });
      } catch (err) {
        console.warn(`Test cleanup warning: failed to remove ${dbPath}:`, err);
      }
    }
  });

  const eventTypes = () => events.map((e) => e.type);

  describe('createAccessRequest (public-safe)', () => {
    it('creates a REQUESTED record, normalizing the email and storing context', async () => {
      const request = await service.createAccessRequest({
        email: '  Jane@Example.COM ',
        name: 'Jane Doe',
        source: 'www',
        context: { company: 'Acme', intendedUse: 'evaluation' },
        tenantHint: { org: 'acme' },
      });

      expect(request.email).toBe('jane@example.com');
      expect(request.name).toBe('Jane Doe');
      expect(request.source).toBe('www');
      expect(request.status).toBe(AccessRequestStatus.REQUESTED);
      expect(request.isOpen()).toBe(true);
      expect(request.getRequestContext()).toEqual({
        company: 'Acme',
        intendedUse: 'evaluation',
      });
      expect(request.getTenantHint()).toEqual({ org: 'acme' });
      expect(request.requestedAt).toBeInstanceOf(Date);
      expect(eventTypes()).toEqual(['access-request.created']);
    });

    it('rejects an invalid email', async () => {
      await expect(
        service.createAccessRequest({ email: 'not-an-email' }),
      ).rejects.toMatchObject({
        name: 'AccessRequestError',
        code: 'INVALID_EMAIL',
      });
      expect(events).toHaveLength(0);
    });

    it('is idempotent on an open email: merges context, no duplicate, no second event', async () => {
      const first = await service.createAccessRequest({
        email: 'dup@example.com',
        context: { a: 1 },
      });
      const second = await service.createAccessRequest({
        email: 'DUP@example.com',
        name: 'Filled Later',
        context: { b: 2 },
      });

      expect(second.id).toBe(first.id);
      expect(second.name).toBe('Filled Later');
      expect(second.getRequestContext()).toEqual({ a: 1, b: 2 });

      const all = await service.collection.findByEmail('dup@example.com');
      expect(all).toHaveLength(1);
      // Only the first creation emits `created`.
      expect(eventTypes()).toEqual(['access-request.created']);
    });

    it('keeps separate rows for different emails that share a display name', async () => {
      // Regression: slug derives from `name`, so without an id-based conflict key
      // two "Jane Doe" submissions would upsert over each other.
      const a = await service.createAccessRequest({
        email: 'jane1@example.com',
        name: 'Jane Doe',
      });
      const b = await service.createAccessRequest({
        email: 'jane2@example.com',
        name: 'Jane Doe',
      });

      expect(b.id).not.toBe(a.id);
      const all = await service.listAccessRequests({});
      const janes = all.filter((r) => r.name === 'Jane Doe');
      expect(janes).toHaveLength(2);
      expect(janes.map((r) => r.email).sort()).toEqual([
        'jane1@example.com',
        'jane2@example.com',
      ]);
    });

    it('does not dedup against a non-open (decided) request', async () => {
      const first = await service.createAccessRequest({
        email: 'reopen@example.com',
      });
      await service.declineAccessRequest(first.id as string);

      const second = await service.createAccessRequest({
        email: 'reopen@example.com',
      });

      expect(second.id).not.toBe(first.id);
      expect(second.status).toBe(AccessRequestStatus.REQUESTED);
      const all = await service.collection.findByEmail('reopen@example.com');
      expect(all).toHaveLength(2);
    });
  });

  describe('state machine', () => {
    it('approves REQUESTED → APPROVED and records the operator', async () => {
      const request = await service.createAccessRequest({
        email: 'approve@example.com',
      });
      const approved = await service.approveAccessRequest(
        request.id as string,
        {
          by: 'operator-1',
          note: 'looks legit',
        },
      );

      expect(approved.status).toBe(AccessRequestStatus.APPROVED);
      expect(approved.decidedBy).toBe('operator-1');
      expect(approved.note).toBe('looks legit');
      expect(approved.decidedAt).toBeInstanceOf(Date);
      expect(eventTypes()).toContain('access-request.approved');
    });

    it('approve is idempotent', async () => {
      const request = await service.createAccessRequest({
        email: 'idem-approve@example.com',
      });
      await service.approveAccessRequest(request.id as string);
      const again = await service.approveAccessRequest(request.id as string);
      expect(again.status).toBe(AccessRequestStatus.APPROVED);
      // Only one approved event (the second call is a no-op).
      expect(
        eventTypes().filter((t) => t === 'access-request.approved'),
      ).toHaveLength(1);
    });

    it('declines from REQUESTED and from APPROVED', async () => {
      const a = await service.createAccessRequest({ email: 'd1@example.com' });
      const declinedFromRequested = await service.declineAccessRequest(
        a.id as string,
        { by: 'op', reason: 'spam' },
      );
      expect(declinedFromRequested.status).toBe(AccessRequestStatus.DECLINED);
      expect(declinedFromRequested.note).toBe('spam');

      const b = await service.createAccessRequest({ email: 'd2@example.com' });
      await service.approveAccessRequest(b.id as string);
      const declinedFromApproved = await service.declineAccessRequest(
        b.id as string,
      );
      expect(declinedFromApproved.status).toBe(AccessRequestStatus.DECLINED);
    });

    it('cancels from REQUESTED', async () => {
      const request = await service.createAccessRequest({
        email: 'cancel@example.com',
      });
      const canceled = await service.cancelAccessRequest(request.id as string, {
        reason: 'changed mind',
      });
      expect(canceled.status).toBe(AccessRequestStatus.CANCELED);
      expect(canceled.note).toBe('changed mind');
      expect(eventTypes()).toContain('access-request.canceled');
    });

    it('throws on invalid transitions from a terminal state', async () => {
      const request = await service.createAccessRequest({
        email: 'terminal@example.com',
      });
      await service.declineAccessRequest(request.id as string);

      await expect(
        service.approveAccessRequest(request.id as string),
      ).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
      await expect(
        service.cancelAccessRequest(request.id as string),
      ).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
    });

    it('throws NOT_FOUND for an unknown id', async () => {
      await expect(
        service.approveAccessRequest('does-not-exist'),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });
  });

  describe('operator reads', () => {
    it('lists with status, email, and source filters', async () => {
      const r1 = await service.createAccessRequest({
        email: 'list1@example.com',
        source: 'www',
      });
      await service.createAccessRequest({
        email: 'list2@example.com',
        source: 'sdk',
      });
      await service.approveAccessRequest(r1.id as string);

      const requested = await service.listAccessRequests({
        status: AccessRequestStatus.REQUESTED,
      });
      expect(requested.map((r) => r.email)).toEqual(['list2@example.com']);

      const bySource = await service.listAccessRequests({ source: 'www' });
      expect(bySource.map((r) => r.email)).toEqual(['list1@example.com']);

      const byEmail = await service.listAccessRequests({
        email: 'LIST2@example.com',
      });
      expect(byEmail).toHaveLength(1);

      const multi = await service.listAccessRequests({
        status: [AccessRequestStatus.REQUESTED, AccessRequestStatus.APPROVED],
      });
      expect(multi).toHaveLength(2);
    });

    it('gets a request by id', async () => {
      const created = await service.createAccessRequest({
        email: 'get@example.com',
      });
      const fetched = await service.getAccessRequest(created.id as string);
      expect(fetched?.id).toBe(created.id);
      expect(await service.getAccessRequest('nope')).toBeNull();
    });
  });

  describe('capability gating', () => {
    it('gates operator methods but leaves create public-safe', async () => {
      const calls: AccessRequestAuthorizationContext[] = [];
      let deny = false;
      const gated = await AccessRequestService.create({
        db,
        authorize: (ctx) => {
          calls.push(ctx);
          if (deny) throw new Error('forbidden');
        },
      });

      // create() never calls the authorizer.
      const request = await gated.createAccessRequest({
        email: 'gate@example.com',
      });
      expect(calls).toHaveLength(0);

      // read → access-requests:read
      await gated.listAccessRequests({ by: 'op' });
      expect(calls.at(-1)).toMatchObject({
        capability: ACCESS_REQUEST_CAPABILITIES.READ,
        by: 'op',
      });

      // manage → access-requests:manage
      await gated.approveAccessRequest(request.id as string, { by: 'op' });
      expect(calls.at(-1)).toMatchObject({
        capability: ACCESS_REQUEST_CAPABILITIES.MANAGE,
        by: 'op',
        accessRequestId: request.id,
      });

      // a throwing authorizer denies operator methods…
      deny = true;
      await expect(
        gated.declineAccessRequest(request.id as string),
      ).rejects.toThrow('forbidden');
      // …but create remains callable.
      await expect(
        gated.createAccessRequest({ email: 'still-open@example.com' }),
      ).resolves.toBeDefined();
    });
  });

  describe('events are best-effort', () => {
    it('swallows a throwing event handler so the transition still persists', async () => {
      const svc = await AccessRequestService.create({
        db,
        onEvent: () => {
          throw new Error('handler boom');
        },
      });
      const request = await svc.createAccessRequest({
        email: 'besteffort@example.com',
      });
      expect(request.status).toBe(AccessRequestStatus.REQUESTED);
      // The record is persisted despite the handler throwing.
      const fetched = await svc.getAccessRequest(request.id as string);
      expect(fetched).not.toBeNull();
    });
  });

  describe('graduation', () => {
    it('new-tenant path: creates user + tenant + owner membership', async () => {
      const request = await service.createAccessRequest({
        email: 'newtenant@example.com',
        name: 'New Tenant Owner',
      });
      await service.approveAccessRequest(request.id as string, { by: 'op' });

      const result = await service.graduateAccessRequest(request.id as string, {
        by: 'op',
        tenant: { create: { name: 'Acme Inc' } },
      });

      expect(result.created).toBe(true);
      expect(result.user.email).toBe('newtenant@example.com');
      expect(result.user.status).toBe(UserStatus.ACTIVE);
      expect(result.tenant?.name).toBe('Acme Inc');
      expect(result.membership).toBeDefined();

      const ownerRole = await roles.findBySlug(DEFAULT_ROLE_SLUGS.OWNER);
      expect(result.membership?.roleId).toBe(ownerRole?.id);
      expect(result.membership?.status).toBe(MembershipStatus.ACTIVE);

      expect(result.accessRequest.status).toBe(AccessRequestStatus.GRADUATED);
      expect(result.accessRequest.resultingUserId).toBe(result.user.id);
      expect(eventTypes()).toContain('access-request.graduated');

      // No duplicate user.
      const allUsers = await users.findByEmail('newtenant@example.com');
      expect(allUsers).not.toBeNull();
    });

    it('existing-tenant path: enrolls the user with the requested role', async () => {
      const tenant = await tenants.create({ name: 'Existing Org' });
      await tenant.save();

      const request = await service.createAccessRequest({
        email: 'existing@example.com',
      });
      await service.approveAccessRequest(request.id as string);

      const result = await service.graduateAccessRequest(request.id as string, {
        tenant: {
          tenantId: tenant.id as string,
          role: DEFAULT_ROLE_SLUGS.ADMIN,
        },
      });

      expect(result.tenant?.id).toBe(tenant.id);
      const adminRole = await roles.findBySlug(DEFAULT_ROLE_SLUGS.ADMIN);
      expect(result.membership?.roleId).toBe(adminRole?.id);
      expect(result.membership?.tenantId).toBe(tenant.id);
    });

    it('existing-tenant path defaults to the member role', async () => {
      const tenant = await tenants.create({ name: 'Default Role Org' });
      await tenant.save();

      const request = await service.createAccessRequest({
        email: 'defaultrole@example.com',
      });
      await service.approveAccessRequest(request.id as string);
      const result = await service.graduateAccessRequest(request.id as string, {
        tenant: { tenantId: tenant.id as string },
      });

      const memberRole = await roles.findBySlug(DEFAULT_ROLE_SLUGS.MEMBER);
      expect(result.membership?.roleId).toBe(memberRole?.id);
    });

    it('no-tenant path: user only, no membership', async () => {
      const request = await service.createAccessRequest({
        email: 'notenant@example.com',
      });
      await service.approveAccessRequest(request.id as string);

      const result = await service.graduateAccessRequest(request.id as string, {
        tenant: 'none',
      });

      expect(result.user.email).toBe('notenant@example.com');
      expect(result.membership).toBeUndefined();
      expect(result.tenant).toBeUndefined();

      const userMemberships = await memberships.findByUser(
        result.user.id as string,
      );
      expect(userMemberships).toHaveLength(0);
    });

    it('defaults to the no-tenant path when no tenant option is given', async () => {
      const request = await service.createAccessRequest({
        email: 'implicitnone@example.com',
      });
      await service.approveAccessRequest(request.id as string);
      const result = await service.graduateAccessRequest(request.id as string);
      expect(result.membership).toBeUndefined();
      expect(result.tenant).toBeUndefined();
    });

    it('is idempotent: a second graduate returns the same user without duplicating', async () => {
      const request = await service.createAccessRequest({
        email: 'idem-grad@example.com',
      });
      await service.approveAccessRequest(request.id as string);

      const first = await service.graduateAccessRequest(request.id as string, {
        tenant: 'none',
      });
      const second = await service.graduateAccessRequest(request.id as string, {
        tenant: 'none',
      });

      expect(second.user.id).toBe(first.user.id);
      expect(second.created).toBe(false);
      // Only one graduated event (the second call short-circuits).
      expect(
        eventTypes().filter((t) => t === 'access-request.graduated'),
      ).toHaveLength(1);
    });

    it('idempotent re-graduation returns the existing membership for an existing tenant', async () => {
      const tenant = await tenants.create({ name: 'Idem Tenant' });
      await tenant.save();
      const request = await service.createAccessRequest({
        email: 'idem-tenant@example.com',
      });
      await service.approveAccessRequest(request.id as string);

      const first = await service.graduateAccessRequest(request.id as string, {
        tenant: { tenantId: tenant.id as string },
      });
      const second = await service.graduateAccessRequest(request.id as string, {
        tenant: { tenantId: tenant.id as string },
      });

      expect(second.membership?.id).toBe(first.membership?.id);
      const all = await memberships.findByUserAndTenant(
        first.user.id as string,
        tenant.id as string,
      );
      expect(all).not.toBeNull();
    });

    it('links an existing user by email instead of creating a duplicate', async () => {
      const existing = await users.create({
        email: 'preexisting@example.com',
        status: UserStatus.PENDING,
      });

      const request = await service.createAccessRequest({
        email: 'preexisting@example.com',
      });
      await service.approveAccessRequest(request.id as string);

      const result = await service.graduateAccessRequest(request.id as string, {
        tenant: 'none',
        activate: UserStatus.ACTIVE,
      });

      expect(result.created).toBe(false);
      expect(result.user.id).toBe(existing.id);
      expect(result.user.status).toBe(UserStatus.ACTIVE);
    });

    it('does not silently change an existing linked user status without explicit activate', async () => {
      const existing = await users.create({
        email: 'suspended@example.com',
        status: UserStatus.SUSPENDED,
      });

      const request = await service.createAccessRequest({
        email: 'suspended@example.com',
      });
      await service.approveAccessRequest(request.id as string);

      // No `activate` passed → the existing suspended account is left untouched.
      const result = await service.graduateAccessRequest(request.id as string, {
        tenant: 'none',
      });

      expect(result.created).toBe(false);
      expect(result.user.id).toBe(existing.id);
      expect(result.user.status).toBe(UserStatus.SUSPENDED);
    });

    it('requires approval before graduation unless allowFromRequested is set', async () => {
      const request = await service.createAccessRequest({
        email: 'fromrequested@example.com',
      });

      await expect(
        service.graduateAccessRequest(request.id as string, { tenant: 'none' }),
      ).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });

      const result = await service.graduateAccessRequest(request.id as string, {
        tenant: 'none',
        allowFromRequested: true,
      });
      expect(result.user.email).toBe('fromrequested@example.com');
      expect(result.accessRequest.status).toBe(AccessRequestStatus.GRADUATED);
    });

    it('throws when graduating a declined request', async () => {
      const request = await service.createAccessRequest({
        email: 'declined-grad@example.com',
      });
      await service.declineAccessRequest(request.id as string);
      await expect(
        service.graduateAccessRequest(request.id as string, {
          tenant: 'none',
          allowFromRequested: true,
        }),
      ).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
    });

    it('throws TENANT_NOT_FOUND for an unknown existing tenant', async () => {
      const request = await service.createAccessRequest({
        email: 'badtenant@example.com',
      });
      await service.approveAccessRequest(request.id as string);
      await expect(
        service.graduateAccessRequest(request.id as string, {
          tenant: { tenantId: 'no-such-tenant' },
        }),
      ).rejects.toMatchObject({ code: 'TENANT_NOT_FOUND' });
    });

    it('rejects an invalid role without leaving an orphan tenant or user', async () => {
      // codex review #1713: a bad role slug used to create the tenant first, then
      // throw ROLE_NOT_FOUND — orphaning the tenant (and the just-created user).
      // Tenant option is now validated before any write.
      const request = await service.createAccessRequest({
        email: 'badrole@example.com',
      });
      await service.approveAccessRequest(request.id as string);

      const tenantsBefore = (await tenants.findActive()).length;
      const usersBefore = await users.findByEmail('badrole@example.com');

      await expect(
        service.graduateAccessRequest(request.id as string, {
          tenant: {
            create: { name: 'Should Not Persist' },
            role: 'nonexistent',
          },
        }),
      ).rejects.toMatchObject({ code: 'ROLE_NOT_FOUND' });

      // No orphan tenant, no orphan user, and the request is still ungraduated.
      expect((await tenants.findActive()).length).toBe(tenantsBefore);
      expect(await tenants.findBySlug('should-not-persist')).toBeNull();
      expect(usersBefore).toBeNull();
      expect(await users.findByEmail('badrole@example.com')).toBeNull();
      const reloaded = await service.getAccessRequest(request.id as string);
      expect(reloaded?.status).toBe(AccessRequestStatus.APPROVED);
    });

    it('exposes AccessRequestError for instanceof checks', async () => {
      const error = await service
        .approveAccessRequest('missing')
        .catch((e) => e);
      expect(error).toBeInstanceOf(AccessRequestError);
    });
  });
});
