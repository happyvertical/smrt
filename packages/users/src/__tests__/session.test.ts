/**
 * Session Tests
 *
 * Tests for session management:
 * 1. Session model and lifecycle
 * 2. SessionCollection CRUD and queries
 * 3. SessionService with user/permission loading
 */

import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GroupCollection } from '../collections/GroupCollection.js';
import { GroupMemberCollection } from '../collections/GroupMemberCollection.js';
import { GroupRoleCollection } from '../collections/GroupRoleCollection.js';
import { MembershipCollection } from '../collections/MembershipCollection.js';
import { MembershipOverrideCollection } from '../collections/MembershipOverrideCollection.js';
import { PermissionCollection } from '../collections/PermissionCollection.js';
import { RoleCollection } from '../collections/RoleCollection.js';
import { RolePermissionCollection } from '../collections/RolePermissionCollection.js';
import { SessionCollection } from '../collections/SessionCollection.js';
import { TenantCollection } from '../collections/TenantCollection.js';
import { TenantPermissionOverrideCollection } from '../collections/TenantPermissionOverrideCollection.js';
import { UserCollection } from '../collections/UserCollection.js';
import {
  DEFAULT_SESSION_TTL,
  generateSessionId,
  Session,
} from '../models/Session.js';
import { SessionService } from '../services/SessionService.js';
import { SessionStatus } from '../types/index.js';

describe('Session Model', () => {
  it('should generate unique session IDs', () => {
    const id1 = generateSessionId();
    const id2 = generateSessionId();

    expect(id1).toBeDefined();
    expect(id2).toBeDefined();
    expect(id1).not.toBe(id2);
    // UUID format check
    expect(id1).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('should have correct default TTL', () => {
    // 7 days in seconds
    expect(DEFAULT_SESSION_TTL).toBe(7 * 24 * 60 * 60);
  });

  it('should check if session is valid', () => {
    const validSession = new Session({
      userId: 'user-1',
      status: SessionStatus.ACTIVE,
      expiresAt: new Date(Date.now() + 60000), // 1 minute in future
    });

    const expiredSession = new Session({
      userId: 'user-2',
      status: SessionStatus.ACTIVE,
      expiresAt: new Date(Date.now() - 60000), // 1 minute in past
    });

    const revokedSession = new Session({
      userId: 'user-3',
      status: SessionStatus.REVOKED,
      expiresAt: new Date(Date.now() + 60000),
    });

    expect(validSession.isValid()).toBe(true);
    expect(expiredSession.isValid()).toBe(false);
    expect(revokedSession.isValid()).toBe(false);
  });

  it('should touch session to update lastAccessedAt', () => {
    const session = new Session({
      userId: 'user-1',
      lastAccessedAt: new Date(Date.now() - 60000),
    });

    const oldTime = session.lastAccessedAt.getTime();
    session.touch();
    const newTime = session.lastAccessedAt.getTime();

    expect(newTime).toBeGreaterThan(oldTime);
  });

  it('should extend session expiration', () => {
    const session = new Session({
      userId: 'user-1',
      expiresAt: new Date(Date.now() + 60000),
    });

    const oldExpiry = session.expiresAt.getTime();
    session.extend(3600); // 1 hour
    const newExpiry = session.expiresAt.getTime();

    expect(newExpiry).toBeGreaterThan(oldExpiry);
    // Should be approximately 1 hour from now
    expect(newExpiry).toBeGreaterThan(Date.now() + 3500 * 1000);
  });

  it('should revoke session', () => {
    const session = new Session({
      userId: 'user-1',
      status: SessionStatus.ACTIVE,
    });

    expect(session.isRevoked()).toBe(false);
    session.revoke();
    expect(session.isRevoked()).toBe(true);
    expect(session.status).toBe(SessionStatus.REVOKED);
  });

  it('should manage custom session data', () => {
    const session = new Session({
      userId: 'user-1',
      data: { theme: 'dark' },
    });

    expect(session.getData<string>('theme')).toBe('dark');
    expect(session.getData<string>('missing')).toBeUndefined();

    session.setData('locale', 'en-US');
    expect(session.getData<string>('locale')).toBe('en-US');

    session.removeData('theme');
    expect(session.getData<string>('theme')).toBeUndefined();
  });
});

describe('SessionCollection', () => {
  let dbPath: string;
  let sessions: SessionCollection;
  let users: UserCollection;

  beforeEach(async () => {
    dbPath = join(tmpdir(), `smrt-session-test-${Date.now()}.db`);
    const options = { db: { type: 'sqlite' as const, url: dbPath } };

    sessions = await SessionCollection.create(options);
    users = await UserCollection.create(options);
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

  it('should create a session with secure ID', async () => {
    const user = await users.create({ email: 'session@example.com' });
    await user.save();

    const session = await sessions.createSession({
      userId: user.id!,
      userAgent: 'Mozilla/5.0',
      ipAddress: '127.0.0.1',
    });

    expect(session.id).toBeDefined();
    expect(session.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(session.userId).toBe(user.id);
    expect(session.status).toBe(SessionStatus.ACTIVE);
    expect(session.userAgent).toBe('Mozilla/5.0');
    expect(session.ipAddress).toBe('127.0.0.1');
    expect(session.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('should find valid session by ID', async () => {
    const user = await users.create({ email: 'find@example.com' });
    await user.save();

    const session = await sessions.createSession({ userId: user.id! });

    const found = await sessions.findValidSession(session.id!);
    expect(found).toBeDefined();
    expect(found?.id).toBe(session.id);
  });

  it('should return null for invalid session', async () => {
    const notFound = await sessions.findValidSession('non-existent-id');
    expect(notFound).toBeNull();
  });

  it('should touch session to update lastAccessedAt', async () => {
    const user = await users.create({ email: 'touch@example.com' });
    await user.save();

    const session = await sessions.createSession({ userId: user.id! });
    const originalTime = session.lastAccessedAt.getTime();

    // Wait a bit to ensure time difference
    await new Promise((resolve) => setTimeout(resolve, 10));

    const touched = await sessions.touch(session.id!);
    expect(touched).toBe(true);

    const updated = await sessions.findValidSession(session.id!);
    expect(updated?.lastAccessedAt.getTime()).toBeGreaterThan(originalTime);
  });

  it('should find all sessions for a user', async () => {
    const user = await users.create({ email: 'multi@example.com' });
    await user.save();

    // Create multiple sessions
    await sessions.createSession({
      userId: user.id!,
      userAgent: 'Browser 1',
    });
    await sessions.createSession({
      userId: user.id!,
      userAgent: 'Browser 2',
    });

    const userSessions = await sessions.findByUser(user.id!);
    expect(userSessions.length).toBe(2);
  });

  it('should revoke a session', async () => {
    const user = await users.create({ email: 'revoke@example.com' });
    await user.save();

    const session = await sessions.createSession({ userId: user.id! });

    const revoked = await sessions.revokeSession(session.id!);
    expect(revoked).toBe(true);

    const found = await sessions.findValidSession(session.id!);
    expect(found).toBeNull();
  });

  it('should revoke all user sessions', async () => {
    const user = await users.create({ email: 'revokeall@example.com' });
    await user.save();

    await sessions.createSession({ userId: user.id! });
    await sessions.createSession({ userId: user.id! });
    await sessions.createSession({ userId: user.id! });

    const count = await sessions.revokeUserSessions(user.id!);
    expect(count).toBe(3);

    const remaining = await sessions.findByUser(user.id!);
    expect(remaining.length).toBe(0);
  });

  it('should delete expired sessions', async () => {
    const user = await users.create({ email: 'expire@example.com' });
    await user.save();

    // Create an already-expired session
    const expiredSession = await sessions.create({
      id: generateSessionId(),
      userId: user.id!,
      status: SessionStatus.ACTIVE,
      expiresAt: new Date(Date.now() - 60000), // 1 minute ago
    });
    await expiredSession.save();

    // Create a valid session
    await sessions.createSession({ userId: user.id! });

    const deletedCount = await sessions.deleteExpired();
    expect(deletedCount).toBeGreaterThanOrEqual(1);

    // Valid session should still exist
    const remaining = await sessions.findByUser(user.id!);
    expect(remaining.length).toBe(1);
  });

  it('should set tenant context for session', async () => {
    const user = await users.create({ email: 'tenant@example.com' });
    await user.save();

    const session = await sessions.createSession({ userId: user.id! });
    expect(session.tenantId).toBeNull();

    await sessions.setSessionTenant(session.id!, 'tenant-123');

    const updated = await sessions.findValidSession(session.id!);
    expect(updated?.tenantId).toBe('tenant-123');
  });

  it('should manage session data', async () => {
    const user = await users.create({ email: 'data@example.com' });
    await user.save();

    const session = await sessions.createSession({ userId: user.id! });

    await sessions.setSessionData(session.id!, 'preference', 'dark-mode');

    const value = await sessions.getSessionData<string>(
      session.id!,
      'preference',
    );
    expect(value).toBe('dark-mode');
  });
});

describe('SessionService', () => {
  let dbPath: string;
  let users: UserCollection;
  let tenants: TenantCollection;
  let roles: RoleCollection;
  let permissions: PermissionCollection;
  let memberships: MembershipCollection;
  let rolePermissions: RolePermissionCollection;
  // Additional collections needed for PermissionResolver
  let groups: GroupCollection;
  let groupMembers: GroupMemberCollection;
  let groupRoles: GroupRoleCollection;
  let membershipOverrides: MembershipOverrideCollection;
  let tenantOverrides: TenantPermissionOverrideCollection;

  beforeEach(async () => {
    dbPath = join(tmpdir(), `smrt-session-service-test-${Date.now()}.db`);
    const options = { db: { type: 'sqlite' as const, url: dbPath } };

    users = await UserCollection.create(options);
    tenants = await TenantCollection.create(options);
    roles = await RoleCollection.create(options);
    permissions = await PermissionCollection.create(options);
    memberships = await MembershipCollection.create(options);
    rolePermissions = await RolePermissionCollection.create(options);
    // Initialize collections needed by PermissionResolver
    groups = await GroupCollection.create(options);
    groupMembers = await GroupMemberCollection.create(options);
    groupRoles = await GroupRoleCollection.create(options);
    membershipOverrides = await MembershipOverrideCollection.create(options);
    tenantOverrides = await TenantPermissionOverrideCollection.create(options);
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

  it('should create and load session context', async () => {
    // Setup user
    const user = await users.create({ email: 'context@example.com' });
    await user.save();

    // Create session service
    const sessionService = await SessionService.create({
      db: { type: 'sqlite', url: dbPath },
    });

    // Create session
    const sessionId = await sessionService.createSession(user.id!);
    expect(sessionId).toBeDefined();

    // Load context
    const context = await sessionService.loadSessionContext(sessionId);
    expect(context).toBeDefined();
    expect(context?.user.id).toBe(user.id);
    expect(context?.user.email).toBe('context@example.com');
    expect(context?.sessionId).toBe(sessionId);
  });

  it('should load permissions when tenant context exists', async () => {
    // Setup user and tenant
    const user = await users.create({ email: 'perm@example.com' });
    await user.save();

    const tenant = await tenants.create({ name: 'Test Org' });
    await tenant.save();

    const role = await roles.create({ name: 'Editor' });
    await role.save();

    const perm = await permissions.create({
      slug: 'articles.create',
      name: 'Create Articles',
    });
    await perm.save();

    await rolePermissions.addPermission(role.id!, perm.id!);

    const membership = await memberships.create({
      userId: user.id!,
      tenantId: tenant.id!,
      roleId: role.id!,
    });
    await membership.save();

    // Create session service
    const sessionService = await SessionService.create({
      db: { type: 'sqlite', url: dbPath },
    });

    // Create session with tenant context
    const sessionId = await sessionService.createSession(user.id!, tenant.id!);

    // Load context
    const context = await sessionService.loadSessionContext(sessionId);
    expect(context).toBeDefined();
    expect(context?.tenantId).toBe(tenant.id);
    expect(context?.permissions).toContain('articles.create');
  });

  it('should include inherited tenant permissions in session context', async () => {
    const parent = await tenants.create({
      cascadePermissions: true,
      name: 'Parent Org',
    });
    await parent.save();

    const child = await tenants.create({
      inheritPermissions: true,
      name: 'Child Org',
      parentTenantId: parent.id!,
    });
    await child.save();

    const user = await users.create({ email: 'tenant-session@example.com' });
    await user.save();

    const role = await roles.create({ name: 'Editor' });
    await role.save();

    const inheritedPermission = await permissions.create({
      slug: 'articles.read',
      name: 'Read Articles',
    });
    await inheritedPermission.save();

    const rolePermission = await permissions.create({
      slug: 'articles.create',
      name: 'Create Articles',
    });
    await rolePermission.save();

    await tenantOverrides.grantPermission(parent.id!, inheritedPermission.id!);
    await rolePermissions.addPermission(role.id!, rolePermission.id!);

    const membership = await memberships.create({
      roleId: role.id!,
      tenantId: child.id!,
      userId: user.id!,
    });
    await membership.save();

    const sessionService = await SessionService.create({
      db: { type: 'sqlite', url: dbPath },
    });
    const sessionId = await sessionService.createSession(user.id!, child.id!);
    const context = await sessionService.loadSessionContext(sessionId);

    expect(context?.permissions).toContain('articles.read');
    expect(context?.permissions).toContain('articles.create');
  });

  it('should destroy session', async () => {
    const user = await users.create({ email: 'destroy@example.com' });
    await user.save();

    const sessionService = await SessionService.create({
      db: { type: 'sqlite', url: dbPath },
    });

    const sessionId = await sessionService.createSession(user.id!);

    // Verify session exists
    let context = await sessionService.loadSessionContext(sessionId);
    expect(context).toBeDefined();

    // Destroy session
    const destroyed = await sessionService.destroySession(sessionId);
    expect(destroyed).toBe(true);

    // Session should no longer be valid
    context = await sessionService.loadSessionContext(sessionId);
    expect(context).toBeNull();
  });

  it('should destroy all user sessions', async () => {
    const user = await users.create({ email: 'destroyall@example.com' });
    await user.save();

    const sessionService = await SessionService.create({
      db: { type: 'sqlite', url: dbPath },
    });

    // Create multiple sessions
    await sessionService.createSession(user.id!);
    await sessionService.createSession(user.id!);
    await sessionService.createSession(user.id!);

    // Destroy all
    const count = await sessionService.destroyAllUserSessions(user.id!);
    expect(count).toBe(3);

    // Check all are gone
    const userSessions = await sessionService.getUserSessions(user.id!);
    expect(userSessions.length).toBe(0);
  });

  it('should switch tenant context', async () => {
    const user = await users.create({ email: 'switch@example.com' });
    await user.save();

    const tenant1 = await tenants.create({ name: 'Org 1' });
    await tenant1.save();

    const tenant2 = await tenants.create({ name: 'Org 2' });
    await tenant2.save();

    // #1400: switchTenant fail-closes on missing membership, so the user must
    // be an active member of the tenant they switch into.
    const role = await roles.create({ name: 'Member' });
    await role.save();
    await (
      await memberships.create({
        userId: user.id!,
        tenantId: tenant2.id!,
        roleId: role.id!,
      })
    ).save();

    const sessionService = await SessionService.create({
      db: { type: 'sqlite', url: dbPath },
    });

    const sessionId = await sessionService.createSession(user.id!, tenant1.id!);

    // Check initial tenant
    let context = await sessionService.loadSessionContext(sessionId);
    expect(context?.tenantId).toBe(tenant1.id);

    // Switch tenant
    const switched = await sessionService.switchTenant(sessionId, tenant2.id!);
    expect(switched).toBe(true);

    // Check new tenant
    context = await sessionService.loadSessionContext(sessionId);
    expect(context?.tenantId).toBe(tenant2.id);
  });

  it('should check hasPermission', async () => {
    // Setup
    const user = await users.create({ email: 'hasperm@example.com' });
    await user.save();

    const tenant = await tenants.create({ name: 'Perm Org' });
    await tenant.save();

    const role = await roles.create({ name: 'Writer' });
    await role.save();

    const writePerm = await permissions.create({
      slug: 'articles.write',
      name: 'Write',
    });
    await writePerm.save();

    await rolePermissions.addPermission(role.id!, writePerm.id!);

    const membership = await memberships.create({
      userId: user.id!,
      tenantId: tenant.id!,
      roleId: role.id!,
    });
    await membership.save();

    const sessionService = await SessionService.create({
      db: { type: 'sqlite', url: dbPath },
    });

    const sessionId = await sessionService.createSession(user.id!, tenant.id!);

    expect(
      await sessionService.hasPermission(sessionId, 'articles.write'),
    ).toBe(true);
    expect(
      await sessionService.hasPermission(sessionId, 'articles.delete'),
    ).toBe(false);
  });

  it('should manage session data through service', async () => {
    const user = await users.create({ email: 'servicedata@example.com' });
    await user.save();

    const sessionService = await SessionService.create({
      db: { type: 'sqlite', url: dbPath },
    });

    const sessionId = await sessionService.createSession(user.id!);

    await sessionService.setSessionData(sessionId, 'theme', 'dark');

    const value = await sessionService.getSessionData<string>(
      sessionId,
      'theme',
    );
    expect(value).toBe('dark');
  });

  it('should return null for inactive user', async () => {
    const user = await users.create({
      email: 'inactive@example.com',
      status: 'suspended',
    });
    await user.save();

    const sessionService = await SessionService.create({
      db: { type: 'sqlite', url: dbPath },
    });

    const sessionId = await sessionService.createSession(user.id!);

    // Should return null because user is not active
    const context = await sessionService.loadSessionContext(sessionId);
    expect(context).toBeNull();
  });
});
