import { randomUUID } from 'node:crypto';
import {
  createIsolatedTestDbFromManifest,
  type IsolatedTestDbResult,
  isPostgresAvailable,
} from '@happyvertical/smrt-vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MembershipCollection } from '../collections/MembershipCollection.js';
import { UsersPasswordCredentialCollection } from '../collections/PasswordCredentialCollection.js';
import { RoleCollection } from '../collections/RoleCollection.js';
import { TenantCollection } from '../collections/TenantCollection.js';
import { TenantPermissionOverrideCollection } from '../collections/TenantPermissionOverrideCollection.js';
import { UserCollection } from '../collections/UserCollection.js';
import { provisionPasswordOwner } from '../operator.js';
import { checkReadiness } from '../password-readiness.js';
import { PasswordCredentialService } from '../services/PasswordCredentialService.js';
import { SessionService } from '../services/SessionService.js';

const postgres = isPostgresAvailable() ? describe : describe.skip;
const password = 'a durable operator password';
const policy = { scrypt: { N: 1024 } };
const input = () => ({
  tenantId: randomUUID(),
  tenantName: 'Operator test',
  userId: randomUUID(),
  email: `${randomUUID()}@example.test`,
  username: `guardian-${randomUUID()}`,
  password,
});
const objects = [
  'User',
  'Tenant',
  'Role',
  'Permission',
  'RolePermission',
  'Membership',
  'MembershipOverride',
  'TenantPermissionOverride',
  'Group',
  'GroupMember',
  'GroupRole',
  'Session',
  'UsersPasswordCredential',
  'UsersLoginAttempt',
  'UsersLoginAuditEvent',
];

postgres('trusted operator provisioning on PostgreSQL', () => {
  let isolated: IsolatedTestDbResult | undefined;
  afterEach(async () => {
    vi.restoreAllMocks();
    await isolated?.cleanup();
    isolated = undefined;
  });

  async function fixture() {
    isolated = await createIsolatedTestDbFromManifest({
      includeObjects: objects,
    });
    return isolated;
  }

  it('creates atomically, retries without writes, and signs in by email and username with tenant authority', async () => {
    const { db } = await fixture();
    // Probe before the fixture takes write locks: the Vitest database hook
    // prepares schemas on every new connection. Production readiness is read-only.
    await expect(
      checkReadiness({
        component: 'authentication',
        profile: 'self-hosted',
        provider: 'password',
      }),
    ).resolves.toBe(true);
    const owner = input();
    expect(await provisionPasswordOwner(db, owner, policy)).toEqual({
      status: 'created',
      tenantId: owner.tenantId,
      userId: owner.userId,
    });
    const credentials = await UsersPasswordCredentialCollection.create({ db });
    const before = await credentials.findByUserId(owner.userId);
    expect(before?.version).toBe(1);
    const query = vi.spyOn(db, 'query');
    expect((await provisionPasswordOwner(db, owner, policy)).status).toBe(
      'unchanged',
    );
    expect(
      query.mock.calls
        .map(([sql]) => sql)
        .filter((sql) => /^\s*(INSERT|UPDATE|DELETE)/i.test(sql)),
    ).toEqual([]);
    expect((await credentials.findByUserId(owner.userId))?.passwordHash).toBe(
      before?.passwordHash,
    );
    query.mockRestore();
    const passwords = await PasswordCredentialService.create({
      db,
      password: policy,
    });
    const sessions = await SessionService.create({ db });
    for (const identifier of [
      owner.email.toUpperCase(),
      owner.username.toUpperCase(),
    ]) {
      const signedIn = await passwords.signIn({
        identifier,
        password,
        tenantId: owner.tenantId,
      });
      const context = await sessions.loadSessionContext(signedIn.sessionId);
      expect(context?.user.id).toBe(owner.userId);
      expect(context?.tenantId).toBe(owner.tenantId);
      expect(context?.authMethod).toBe('password');
      expect(context?.permissions.length).toBeGreaterThan(0);
      expect(context?.parent).toBeNull();
    }
    await expect(
      passwords.signIn({
        identifier: owner.email,
        password,
        tenantId: randomUUID(),
      }),
    ).rejects.toThrow('Invalid credentials.');
    await expect(
      passwords.signIn({
        identifier: owner.username,
        password: 'incorrect password',
        tenantId: owner.tenantId,
      }),
    ).rejects.toThrow('Invalid credentials.');
    await expect(
      passwords.signIn({
        identifier: 'unknown.person',
        password,
        tenantId: owner.tenantId,
      }),
    ).rejects.toThrow('Invalid credentials.');
    await expect(
      provisionPasswordOwner(
        db,
        { ...owner, password: 'another valid password' },
        policy,
      ),
    ).rejects.toThrow('Owner provisioning refused.');
    await expect(
      provisionPasswordOwner(db, { ...owner, tenantId: randomUUID() }, policy),
    ).rejects.toThrow('Owner provisioning refused.');
    expect((await credentials.findByUserId(owner.userId))?.passwordHash).toBe(
      before?.passwordHash,
    );
  });

  it('preserves existing grants when provisioning another tenant and permits a username-only owner', async () => {
    const { db } = await fixture();
    await provisionPasswordOwner(db, input(), policy);
    const grants = await db.query(
      'SELECT id FROM role_permissions ORDER BY id',
    );
    expect(grants.rows.length).toBeGreaterThan(0);
    await db.query(
      'DELETE FROM role_permissions WHERE id = ?',
      grants.rows[0].id,
    );
    const remaining = await db.query(
      'SELECT id FROM role_permissions ORDER BY id',
    );
    const owner = { ...input(), email: undefined };
    await provisionPasswordOwner(db, owner, policy);
    expect(
      (await db.query('SELECT id FROM role_permissions ORDER BY id')).rows,
    ).toEqual(remaining.rows);
    const passwords = await PasswordCredentialService.create({
      db,
      password: policy,
    });
    const signedIn = await passwords.signIn({
      identifier: owner.username,
      password,
      tenantId: owner.tenantId,
    });
    const sessions = await SessionService.create({ db });
    expect(
      (await sessions.loadSessionContext(signedIn.sessionId))?.user.id,
    ).toBe(owner.userId);
  });

  it('refuses an unseeded owner role without durable writes, then permits explicitly authorized grant recovery', async () => {
    const { db } = await fixture();
    const roles = await RoleCollection.create({ db });
    await roles.seedSystemRoles();
    const owner = input();
    const snapshot = async () => {
      const rows = [];
      for (const table of [
        'roles',
        'role_permissions',
        'tenants',
        'users',
        'memberships',
        'users_password_credentials',
      ])
        rows.push((await db.query(`SELECT * FROM ${table} ORDER BY id`)).rows);
      return rows;
    };
    const before = await snapshot();
    await expect(provisionPasswordOwner(db, owner, policy)).rejects.toThrow(
      'Owner provisioning refused.',
    );
    expect(await snapshot()).toEqual(before);
    // Recovery is an explicit authority-administration decision, never an
    // automatic side effect of provisioning an existing role.
    await roles.seedSystemRoles({ seedPermissions: true });
    expect((await provisionPasswordOwner(db, owner, policy)).status).toBe(
      'created',
    );
    const grants = await db.query('SELECT * FROM role_permissions ORDER BY id');
    await db.query('DELETE FROM role_permissions');
    const revoked = await snapshot();
    await expect(provisionPasswordOwner(db, owner, policy)).rejects.toThrow(
      'Owner provisioning refused.',
    );
    expect(await snapshot()).toEqual(revoked);
    expect(grants.rows.length).toBeGreaterThan(0);
  });

  it('refuses an existing tenant whose DENY overrides remove all owner permissions', async () => {
    const { db } = await fixture();
    const roles = await RoleCollection.create({ db });
    await roles.seedSystemRoles({ seedPermissions: true });
    const owner = input();
    const tenants = await TenantCollection.create({ db });
    await tenants.create({ id: owner.tenantId, name: owner.tenantName });
    const overrides = await TenantPermissionOverrideCollection.create({ db });
    const permissions = await db.query('SELECT id FROM permissions');
    expect(permissions.rows.length).toBeGreaterThan(0);
    for (const permission of permissions.rows)
      await overrides.denyPermission(owner.tenantId, permission.id);
    const grants = await db.query('SELECT * FROM role_permissions ORDER BY id');
    await expect(provisionPasswordOwner(db, owner, policy)).rejects.toThrow(
      'Owner provisioning refused.',
    );
    expect(
      await (await UserCollection.create({ db })).get({ id: owner.userId }),
    ).toBeNull();
    expect(
      await (await MembershipCollection.create({ db })).findByUserAndTenant(
        owner.userId,
        owner.tenantId,
      ),
    ).toBeNull();
    expect(
      await (
        await UsersPasswordCredentialCollection.create({ db })
      ).findByUserId(owner.userId),
    ).toBeNull();
    expect(await tenants.get({ id: owner.tenantId })).not.toBeNull();
    expect(
      (await db.query('SELECT * FROM role_permissions ORDER BY id')).rows,
    ).toEqual(grants.rows);
  });

  it('rolls back identity, tenant, membership and grants on credential-write failure, then permits a clean retry', async () => {
    const { db } = await fixture();
    const owner = input();
    const write = vi
      .spyOn(UsersPasswordCredentialCollection.prototype, 'insertIfAbsent')
      .mockRejectedValueOnce(new Error(`driver ${password}`));
    const rolesBefore = await db.query('SELECT id FROM roles');
    await expect(provisionPasswordOwner(db, owner, policy)).rejects.toThrow(
      /^Owner provisioning refused\./,
    );
    write.mockRestore();
    expect((await db.query('SELECT id FROM roles')).rows).toEqual(
      rolesBefore.rows,
    );
    expect(
      await (await UserCollection.create({ db })).get({ id: owner.userId }),
    ).toBeNull();
    expect(
      await (await TenantCollection.create({ db })).get({ id: owner.tenantId }),
    ).toBeNull();
    expect(
      await (await MembershipCollection.create({ db })).findByUserAndTenant(
        owner.userId,
        owner.tenantId,
      ),
    ).toBeNull();
    expect((await provisionPasswordOwner(db, owner, policy)).status).toBe(
      'created',
    );
  });

  it('refuses identity collisions, partial accounts, occupied tenants, inactive ownership and malformed input', async () => {
    const { db } = await fixture();
    const owner = input();
    const users = await UserCollection.create({ db });
    await users.create({
      id: owner.userId,
      email: owner.email,
      username: owner.username,
    });
    await expect(provisionPasswordOwner(db, owner, policy)).rejects.toThrow(
      'Owner provisioning refused.',
    );
    await expect(
      provisionPasswordOwner(db, { ...owner, userId: randomUUID() }, policy),
    ).rejects.toThrow('Owner provisioning refused.');
    const complete = input();
    await provisionPasswordOwner(db, complete, policy);
    await expect(
      provisionPasswordOwner(
        db,
        { ...input(), tenantId: complete.tenantId },
        policy,
      ),
    ).rejects.toThrow('Owner provisioning refused.');
    const memberships = await MembershipCollection.create({ db });
    const membership = await memberships.findByUserAndTenant(
      complete.userId,
      complete.tenantId,
    );
    if (!membership) throw new Error('missing test membership');
    membership.status = 'inactive' as typeof membership.status;
    await membership.save();
    await expect(provisionPasswordOwner(db, complete, policy)).rejects.toThrow(
      'Owner provisioning refused.',
    );
    for (const invalid of [
      { ...input(), tenantId: 'not-a-uuid' },
      { ...input(), email: undefined, username: undefined },
      { ...input(), username: 'invalid@username' },
      { ...input(), email: 'not-an-email' },
      { ...input(), password: 'short' },
    ])
      await expect(provisionPasswordOwner(db, invalid, policy)).rejects.toThrow(
        'Owner provisioning refused.',
      );
  });
});
