/**
 * Remembered tenant (#5358): record on switch, resume, stale fail-closed,
 * cross-user isolation, tenantless switch keeps it.
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
import { SessionService } from '../services/SessionService.js';
import { MembershipStatus, TenantStatus } from '../types/index.js';

describe('SessionService.lastActiveTenantFor', () => {
  let dbPath: string;
  let options: { db: { type: 'sqlite'; url: string } };
  let service: SessionService;
  let users: UserCollection;
  let tenants: TenantCollection;
  let roles: RoleCollection;
  let memberships: MembershipCollection;
  let sessions: SessionCollection;

  beforeEach(async () => {
    dbPath = join(tmpdir(), `smrt-last-tenant-${randomUUID()}.db`);
    options = { db: { type: 'sqlite' as const, url: dbPath } };
    users = await UserCollection.create(options);
    tenants = await TenantCollection.create(options);
    roles = await RoleCollection.create(options);
    memberships = await MembershipCollection.create(options);
    sessions = await SessionCollection.create(options);
    service = new SessionService(options);
    await service.initialize();
  });

  afterEach(() => {
    if (existsSync(dbPath)) rmSync(dbPath, { force: true });
  });

  async function user() {
    const u = await users.create({ email: `${randomUUID()}@example.com` });
    await u.save();
    return u;
  }
  async function join_(userId: string, name: string) {
    const t = await tenants.create({ name });
    await t.save();
    const r = await roles.create({ name: `Member ${name}` });
    await r.save();
    const m = await memberships.create({
      userId,
      tenantId: t.id!,
      roleId: r.id!,
    });
    await m.save();
    return { tenant: t, membership: m };
  }
  async function switchTo(userId: string, tenantId: string | null) {
    const session = await sessions.createSession({ userId });
    return service.switchTenant(session.id!, tenantId);
  }

  it('returns null before any switch', async () => {
    const u = await user();
    await join_(u.id!, 'A');
    expect(await service.lastActiveTenantFor(u.id!)).toBeNull();
  });

  it('remembers the last tenant switched into and resumes the latest', async () => {
    const u = await user();
    const a = await join_(u.id!, 'A');
    const b = await join_(u.id!, 'B');
    await switchTo(u.id!, a.tenant.id!);
    expect(await service.lastActiveTenantFor(u.id!)).toBe(a.tenant.id);
    await new Promise((r) => setTimeout(r, 5));
    await switchTo(u.id!, b.tenant.id!);
    expect(await service.lastActiveTenantFor(u.id!)).toBe(b.tenant.id);
  });

  it('does not record a failed (non-member) switch', async () => {
    const u = await user();
    const other = await user();
    const foreign = await join_(other.id!, 'Foreign');
    const result = await switchTo(u.id!, foreign.tenant.id!);
    expect(result.switched).toBe(false);
    expect(await service.lastActiveTenantFor(u.id!)).toBeNull();
  });

  it('returns null when the membership is no longer active', async () => {
    const u = await user();
    const a = await join_(u.id!, 'A');
    await switchTo(u.id!, a.tenant.id!);
    const fresh = (await memberships.findByUserAndTenant(u.id!, a.tenant.id!))!;
    fresh.status = MembershipStatus.SUSPENDED;
    await fresh.save();
    expect(await service.lastActiveTenantFor(u.id!)).toBeNull();
  });

  it('returns null when the tenant is not active', async () => {
    const u = await user();
    const a = await join_(u.id!, 'A');
    await switchTo(u.id!, a.tenant.id!);
    const fresh = (await tenants.get({ id: a.tenant.id! }))!;
    fresh.status = TenantStatus.SUSPENDED;
    await fresh.save();
    expect(await service.lastActiveTenantFor(u.id!)).toBeNull();
  });

  it("never leaks one user's tenant to another user", async () => {
    const alice = await user();
    const bob = await user();
    const a = await join_(alice.id!, 'A');
    await join_(bob.id!, 'B');
    await switchTo(alice.id!, a.tenant.id!);
    expect(await service.lastActiveTenantFor(alice.id!)).toBe(a.tenant.id);
    expect(await service.lastActiveTenantFor(bob.id!)).toBeNull();
  });

  it('keeps the remembered tenant when a session clears its tenant', async () => {
    const u = await user();
    const a = await join_(u.id!, 'A');
    const first = await switchTo(u.id!, a.tenant.id!);
    await service.switchTenant(first.sessionId!, null);
    expect(await service.lastActiveTenantFor(u.id!)).toBe(a.tenant.id);
  });
});
