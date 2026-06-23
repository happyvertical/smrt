/**
 * SvelteKit switchSessionTenant tests
 *
 * Verifies the sveltekit helper rotates the session COOKIE to the new id on a
 * successful tenant switch (#1354 follow-up) and fail-closes for a non-member.
 */

import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MembershipCollection } from '../collections/MembershipCollection.js';
import { RoleCollection } from '../collections/RoleCollection.js';
import { SessionCollection } from '../collections/SessionCollection.js';
import { TenantCollection } from '../collections/TenantCollection.js';
import { UserCollection } from '../collections/UserCollection.js';
import { switchSessionTenant } from '../sveltekit/index.js';

interface CookieSetCall {
  name: string;
  value: string;
  options?: Record<string, unknown>;
}

function createCookieJar(initialValues: Record<string, string> = {}) {
  const values = new Map(Object.entries(initialValues));
  const setCalls: CookieSetCall[] = [];

  return {
    setCalls,
    delete(name: string) {
      values.delete(name);
    },
    get(name: string) {
      return values.get(name);
    },
    set(name: string, value: string, options?: Record<string, unknown>) {
      values.set(name, value);
      setCalls.push({ name, value, options });
    },
  };
}

describe('switchSessionTenant (sveltekit)', () => {
  let dbPath: string;
  let users: UserCollection;
  let tenants: TenantCollection;
  let roles: RoleCollection;
  let memberships: MembershipCollection;
  let sessions: SessionCollection;
  let options: { db: { type: 'sqlite'; url: string } };

  beforeEach(async () => {
    // Unique db path per test — switchSessionTenant caches its SessionService
    // keyed by db config, so a fresh url avoids cross-test cache reuse.
    dbPath = join(tmpdir(), `smrt-sveltekit-switch-${randomUUID()}.db`);
    options = { db: { type: 'sqlite' as const, url: dbPath } };

    users = await UserCollection.create(options);
    tenants = await TenantCollection.create(options);
    roles = await RoleCollection.create(options);
    memberships = await MembershipCollection.create(options);
    sessions = await SessionCollection.create(options);
  });

  afterEach(() => {
    if (existsSync(dbPath)) {
      try {
        rmSync(dbPath, { force: true });
      } catch {
        // ignore cleanup errors
      }
    }
  });

  async function seedMember() {
    const user = await users.create({ email: `${randomUUID()}@example.com` });
    await user.save();
    const tenant = await tenants.create({ name: 'Target Org' });
    await tenant.save();
    const role = await roles.create({ name: 'Member' });
    await role.save();
    const membership = await memberships.create({
      userId: user.id!,
      tenantId: tenant.id!,
      roleId: role.id!,
    });
    await membership.save();
    return { user, tenant };
  }

  it('rotates the session cookie to the new id on a successful switch', async () => {
    const { user, tenant } = await seedMember();
    const session = await sessions.createSession({ userId: user.id! });
    const oldId = session.id!;

    const cookies = createCookieJar({ sid: oldId });
    const event = {
      cookies,
      locals: {} as Record<string, unknown>,
      url: { pathname: '/switch', protocol: 'https:' },
      request: { headers: new Headers() },
    };

    const switched = await switchSessionTenant(event, tenant.id!, options);

    expect(switched).toBe(true);

    // The cookie now holds a DIFFERENT (rotated) id...
    const newId = cookies.get('sid');
    expect(newId).toBeDefined();
    expect(newId).not.toBe(oldId);

    // ...set with preserved security flags...
    expect(cookies.setCalls).toHaveLength(1);
    expect(cookies.setCalls[0].name).toBe('sid');
    expect(cookies.setCalls[0].options).toMatchObject({
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
    });

    // ...the old session id is revoked...
    expect(await sessions.findValidSession(oldId)).toBeNull();

    // ...and the new session id is valid with the new tenant.
    const rotated = await sessions.findValidSession(newId as string);
    expect(rotated?.tenantId).toBe(tenant.id);
  });

  it('fail-closes and does not touch the cookie for a non-member switch', async () => {
    const { user } = await seedMember();
    const foreign = await tenants.create({ name: 'Foreign Org' });
    await foreign.save();

    const session = await sessions.createSession({ userId: user.id! });
    const oldId = session.id!;

    const cookies = createCookieJar({ sid: oldId });
    const event = {
      cookies,
      locals: {} as Record<string, unknown>,
      url: { pathname: '/switch', protocol: 'https:' },
      request: { headers: new Headers() },
    };

    const switched = await switchSessionTenant(event, foreign.id!, options);

    expect(switched).toBe(false);
    // Cookie unchanged, no rotation, original session intact.
    expect(cookies.setCalls).toHaveLength(0);
    expect(cookies.get('sid')).toBe(oldId);
    expect(await sessions.findValidSession(oldId)).not.toBeNull();
  });

  it('returns false when there is no session cookie', async () => {
    const { tenant } = await seedMember();
    const cookies = createCookieJar();
    const event = {
      cookies,
      locals: {} as Record<string, unknown>,
      url: { pathname: '/switch', protocol: 'https:' },
      request: { headers: new Headers() },
    };

    const switched = await switchSessionTenant(event, tenant.id!, options);
    expect(switched).toBe(false);
    expect(cookies.setCalls).toHaveLength(0);
  });
});
