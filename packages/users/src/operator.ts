/**
 * Trusted, offline database administration. Never mount this entrypoint in a
 * request handler or generated REST/MCP surface. Possession of the database
 * connection is the authority; this is deliberately not a session API.
 * @packageDocumentation
 */
import {
  isPostgresDatabase,
  withEmbeddedWriteTransaction,
} from '@happyvertical/smrt-core';
import { withSystemContext } from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { MembershipCollection } from './collections/MembershipCollection.js';
import { UsersPasswordCredentialCollection } from './collections/PasswordCredentialCollection.js';
import { RoleCollection } from './collections/RoleCollection.js';
import { TenantCollection } from './collections/TenantCollection.js';
import { UserCollection } from './collections/UserCollection.js';
import {
  isValidEmail,
  normalizeEmail,
  normalizeUsername,
} from './models/User.js';
import { verifySecretHash } from './services/credential-hash.js';
import {
  PasswordCredentialService,
  type PasswordPolicyOptions,
} from './services/PasswordCredentialService.js';
import { MembershipStatus, TenantStatus, UserStatus } from './types/index.js';

/** Explicit immutable identities make retries safe across operator processes. */
export interface ProvisionPasswordOwnerInput {
  tenantId: string;
  tenantName: string;
  userId: string;
  email?: string;
  username?: string;
  password: string;
}

/** Public-safe result; no credentials, user objects, or session are returned. */
export interface ProvisionPasswordOwnerResult {
  status: 'created' | 'unchanged';
  tenantId: string;
  userId: string;
}

/** No provider, SQL, or password-policy error text crosses this boundary. */
export class OperatorProvisioningError extends Error {
  constructor() {
    super(
      'Owner provisioning refused. Verify the identities, password policy, and database state.',
    );
    this.name = 'OperatorProvisioningError';
  }
}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Provision a new PostgreSQL deployment owner atomically. Existing identities
 * are never adopted or repaired. A complete exact retry verifies the existing
 * password and returns without writing; changed passwords or grants are never
 * reset. The database must already have the application's migrated manifest.
 *
 * Supports PostgreSQL only: the operator lock and atomicity are tested against
 * the deployed dialect. Local bootstrap continues to use its existing API.
 */
export async function provisionPasswordOwner(
  db: DatabaseInterface,
  input: ProvisionPasswordOwnerInput,
  passwordPolicy: PasswordPolicyOptions = {},
): Promise<ProvisionPasswordOwnerResult> {
  try {
    if (
      !isPostgresDatabase(db) ||
      !UUID.test(input.tenantId) ||
      !UUID.test(input.userId) ||
      typeof input.tenantName !== 'string' ||
      !input.tenantName.trim() ||
      input.tenantName.length > 200 ||
      (input.email !== undefined && !isValidEmail(input.email)) ||
      (input.username !== undefined && !normalizeUsername(input.username))
    )
      throw new OperatorProvisioningError();
    const email = normalizeEmail(input.email ?? '');
    const username = normalizeUsername(input.username);
    if (!email && !username) throw new OperatorProvisioningError();
    const tenantId = input.tenantId.toLowerCase();
    const userId = input.userId.toLowerCase();
    const tenantName = input.tenantName.trim();
    // Policy failures and hashing happen before any database mutation.
    const passwordHash = await PasswordCredentialService.preparePasswordHash(
      input.password,
      {
        id: userId,
        email,
        emailKey: email || null,
        username: username || null,
        usernameKey: username || null,
      },
      passwordPolicy,
    );
    return await withSystemContext(() =>
      withEmbeddedWriteTransaction(db, false, async (tx) => {
        // Serialize all operator provisioning, including overlapping identities
        // across tenants. Normal writers remain subject to unique constraints.
        await tx.query('SELECT pg_advisory_xact_lock(4158, 1)');
        const options = { db: tx };
        const users = await UserCollection.create(options);
        const tenants = await TenantCollection.create(options);
        const memberships = await MembershipCollection.create(options);
        const roles = await RoleCollection.create(options);
        const credentials =
          await UsersPasswordCredentialCollection.create(options);
        const tenant = await tenants.get({ id: tenantId });
        const user = await users.get({ id: userId });
        const emailMatches = email
          ? await users.list({ where: { emailKey: email }, limit: 2 })
          : [];
        const usernameMatches = username
          ? await users.list({ where: { usernameKey: username }, limit: 2 })
          : [];
        if (
          emailMatches.some((match) => match.id !== userId) ||
          usernameMatches.some((match) => match.id !== userId)
        )
          throw new OperatorProvisioningError();
        if (user) {
          const role = await roles.findBySlug('owner');
          const membership = await memberships.findByUserAndTenant(
            userId,
            tenantId,
          );
          const credential = await credentials.findByUserId(userId);
          if (
            !tenant ||
            tenant.name !== tenantName ||
            tenant.status !== TenantStatus.ACTIVE ||
            tenant.parentTenantId ||
            user.status !== UserStatus.ACTIVE ||
            (user.emailKey ?? '') !== email ||
            (user.usernameKey ?? '') !== username ||
            !role?.isSystem ||
            role.tenantId ||
            !membership ||
            membership.status !== MembershipStatus.ACTIVE ||
            membership.roleId !== role.id ||
            !credential ||
            credential.mustChange ||
            !(await verifySecretHash(
              input.password.normalize('NFKC'),
              passwordPolicy.pepper ?? '',
              credential.passwordHash,
            ))
          )
            throw new OperatorProvisioningError();
          return { status: 'unchanged', tenantId, userId };
        }
        // Never attach an owner to an occupied or differently configured tenant.
        if (
          tenant &&
          (tenant.name !== tenantName ||
            tenant.status !== TenantStatus.ACTIVE ||
            tenant.parentTenantId ||
            (await memberships.list({ where: { tenantId }, limit: 1 })).length >
              0)
        )
          throw new OperatorProvisioningError();
        let role = await roles.findBySlug('owner');
        if (!role) {
          // Seed only a fresh authority catalog. Provisioning must never
          // re-grant permissions an operator removed from existing roles.
          if ((await roles.list({ limit: 1 })).length > 0)
            throw new OperatorProvisioningError();
          await roles.seedSystemRoles({ seedPermissions: true });
          role = await roles.findBySlug('owner');
        }
        if (!role?.id || !role.isSystem || role.tenantId)
          throw new OperatorProvisioningError();
        if (!tenant)
          await tenants.create({
            id: tenantId,
            slug: `operator-${tenantId}`,
            name: tenantName,
            _insertOnly: true,
          });
        await users.create({
          id: userId,
          slug: `operator-${userId}`,
          email,
          username: username || null,
          _insertOnly: true,
        });
        await memberships.create({
          userId,
          tenantId,
          roleId: role.id,
          _insertOnly: true,
        });
        if (
          !(await credentials.insertIfAbsent(userId, {
            passwordHash,
            mustChange: false,
            rotatedAt: new Date(),
            rotatedBy: 'operator',
          }))
        )
          throw new OperatorProvisioningError();
        return { status: 'created', tenantId, userId };
      }),
    );
  } catch {
    throw new OperatorProvisioningError();
  }
}
