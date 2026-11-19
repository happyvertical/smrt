/**
 * Non-login service principals (#5245).
 *
 * A service principal is a User plus one Membership in exactly one tenant
 * that an automated actor (an agent, an integration) holds grants as. It can
 * never sign in: it has no email or username, and every session mint
 * (`SessionCollection.createSession`) and every session resolution
 * (`findValidSession`, `loadSessionContext`) refuses it, so hosts need no
 * per-path refusals.
 *
 * @packageDocumentation
 */
import { randomUUID } from 'node:crypto';
import {
  isPostgresDatabase,
  ObjectRegistry,
  type SmrtClassOptions,
} from '@happyvertical/smrt-core';
import {
  AGENT_PROFILE_TYPE_SLUG,
  Profile,
  ProfileTypeCollection,
} from '@happyvertical/smrt-profiles';
import { withSystemContext } from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { MembershipCollection } from '../collections/MembershipCollection.js';
import { RoleCollection } from '../collections/RoleCollection.js';
import { SessionCollection } from '../collections/SessionCollection.js';
import { TenantCollection } from '../collections/TenantCollection.js';
import { UserCollection } from '../collections/UserCollection.js';
import type { Membership } from '../models/Membership.js';
import {
  SERVICE_PRINCIPAL_KIND,
  ServicePrincipalError,
  type User,
} from '../models/User.js';
import { MembershipStatus, TenantStatus, UserStatus } from '../types/index.js';

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
// Printable, no surrounding whitespace, bounded: a key is an identifier the
// host derives (a credential id, an agent slug), never free text.
const KEY = /^[\x21-\x7e](?:[\x20-\x7e]{0,198}[\x21-\x7e])?$/u;

/** Options for {@link ServicePrincipalService.create}. */
export interface ServicePrincipalServiceOptions extends SmrtClassOptions {
  /**
   * The service never opens or nests a transaction; it runs on the executor
   * it is given. Pass the caller's transaction for `create`/`retire` so the
   * user, profile and membership commit or roll back together.
   */
  transaction: 'caller';
}

/** Host-authorized creation input. The caller authorizes tenant and role. */
export type CreateServicePrincipalInput = {
  tenantId: string;
  /**
   * Caller-supplied idempotency key, unique within the tenant (1-200
   * printable ASCII characters, no surrounding whitespace). Replaying a key
   * returns the same principal; a retired key is never reused.
   */
  key: string;
  /** Display name for the principal's `bot` profile. Defaults to `key`. */
  displayName?: string;
} & (
  | { roleSlug: string; roleId?: never }
  | { roleId: string; roleSlug?: never }
);

/** A service principal as the host sees it. */
export interface ServicePrincipalRecord {
  userId: string;
  profileId: string;
  membershipId: string;
  tenantId: string;
  key: string;
  roleId: string;
  /** `active` only when the user and membership are active and not retired. */
  status: 'active' | 'retired' | 'inactive';
  retiredAt: Date | null;
}

/** Result of {@link ServicePrincipalService.createServicePrincipal}. */
export interface CreatedServicePrincipal extends ServicePrincipalRecord {
  /** False when the key was replayed and the existing principal returned. */
  created: boolean;
}

/**
 * Trusted host integration seam for non-login service principals (#5245),
 * never a public endpoint. The host authorizes the tenant and role and owns
 * the transaction; this service performs no permission check of its own.
 *
 * - `createServicePrincipal` is idempotent per `(tenantId, key)`.
 * - `retireServicePrincipal` is permanent: the user is suspended and stamped
 *   `retiredAt` (the model then refuses any save that reactivates it), the
 *   membership goes inactive, and any session row is revoked. There is no
 *   reactivation API; create a new principal under a new key instead.
 * - `isActiveServicePrincipal` is the per-call validity check: a service
 *   principal, bound to exactly that tenant, not retired, with an active
 *   user and an active membership in that tenant.
 */
export class ServicePrincipalService {
  private constructor(private readonly options: SmrtClassOptions) {}

  /** Bind an already-initialized executor; never opens a transaction. */
  static async create(
    options: ServicePrincipalServiceOptions,
  ): Promise<ServicePrincipalService> {
    if (!options.db || options.transaction !== 'caller')
      throw new Error(
        'ServicePrincipalService requires an explicit caller-owned executor',
      );
    return new ServicePrincipalService({
      db: options.db,
      _reuseInitializedDb: true,
      _deferRuntimeInitialization: true,
    });
  }

  /** Create, or replay by key, a service principal in one tenant. */
  async createServicePrincipal(
    input: CreateServicePrincipalInput,
  ): Promise<CreatedServicePrincipal> {
    const tenantId = requireUuid(input?.tenantId, 'tenant');
    const key = requireKey(input?.key);
    if (
      (input.roleSlug !== undefined && input.roleId !== undefined) ||
      (!input.roleSlug?.trim() && !input.roleId?.trim()) ||
      (input.roleId !== undefined && !UUID.test(input.roleId))
    )
      throw new ServicePrincipalError(
        'Exactly one valid roleSlug or roleId is required',
        400,
      );
    const displayName =
      typeof input.displayName === 'string' && input.displayName.trim()
        ? input.displayName.trim().slice(0, 200)
        : key;
    return await withSystemContext(async () => {
      const db = this.options.db as DatabaseInterface;
      const tenant = await (await TenantCollection.create(this.options)).get(
        { id: tenantId },
        { cache: false },
      );
      if (!tenant || tenant.status !== TenantStatus.ACTIVE)
        throw new ServicePrincipalError(
          'Service principal tenant is unavailable',
          400,
        );
      // Serialize creation per tenant; the unique (tenant, key) index is the
      // arbiter on every engine, this lock only turns a race into a replay.
      if (isPostgresDatabase(db))
        await db.query(
          'SELECT id FROM tenants WHERE id = ? FOR UPDATE',
          tenantId,
        );
      const roles = await RoleCollection.create(this.options);
      const role = input.roleId
        ? await roles.get({ id: input.roleId }, { cache: false })
        : await roles.findSystemRoleBySlug(input.roleSlug as string);
      if (
        !role?.id ||
        (role.tenantId !== tenantId &&
          !(role.tenantId == null && role.isSystem))
      )
        throw new ServicePrincipalError(
          'Service principal role is unavailable',
          400,
        );

      const existing = await this.findUserByKey(tenantId, key);
      if (existing) {
        const record = await this.recordFor(existing, tenantId);
        if (!record)
          throw new ServicePrincipalError(
            'Service principal is inconsistent',
            409,
          );
        if (record.status === 'retired')
          throw new ServicePrincipalError(
            'Service principal key is retired; use a new key',
            409,
          );
        if (record.roleId !== role.id)
          throw new ServicePrincipalError(
            'Service principal key exists with a different role',
            409,
          );
        return { ...record, created: false };
      }

      const types = await ProfileTypeCollection.create(this.options);
      const botType = await types.getOrCreateGlobalBySlug(
        AGENT_PROFILE_TYPE_SLUG,
        {
          name: 'Bot',
          description: 'Automated agents, bots, and AI entities',
        },
      );
      const profile = new (ObjectRegistry.resolveEffectiveConstructor(Profile))(
        {
          ...this.options,
          tenantId,
          typeId: requiredId(botType.id),
          slug: `service-principal-${randomUUID()}`,
          name: displayName,
        },
      );
      await profile.initialize();
      await profile.save();
      const profileId = requiredId(profile.id);

      const users = await UserCollection.create(this.options);
      const user = await users.create({
        profileId,
        email: '',
        username: null,
        status: UserStatus.ACTIVE,
        principalKind: SERVICE_PRINCIPAL_KIND,
        servicePrincipalTenantId: tenantId,
        servicePrincipalKey: key,
        retiredAt: null,
      });
      const userId = requiredId(user.id);
      const membership = await (
        await MembershipCollection.create(this.options)
      ).create({
        userId,
        tenantId,
        roleId: role.id,
        status: MembershipStatus.ACTIVE,
      });
      return {
        userId,
        profileId,
        membershipId: requiredId(membership.id),
        tenantId,
        key,
        roleId: role.id,
        status: 'active',
        retiredAt: null,
        created: true,
      };
    });
  }

  /**
   * Permanently retire a service principal of `tenantId`. Idempotent: a
   * second call returns the already-retired record. Null when `userId` is not
   * a service principal bound to that tenant (a person is never touched).
   */
  async retireServicePrincipal(input: {
    tenantId: string;
    userId: string;
  }): Promise<ServicePrincipalRecord | null> {
    const tenantId = requireUuid(input?.tenantId, 'tenant');
    const userId = requireUuid(input?.userId, 'user');
    return await withSystemContext(async () => {
      const db = this.options.db as DatabaseInterface;
      if (isPostgresDatabase(db))
        await db.query('SELECT id FROM users WHERE id = ? FOR UPDATE', userId);
      const user = await this.boundUser(userId, tenantId);
      if (!user) return null;
      if (user.retiredAt === null) user.retiredAt = new Date();
      user.status = UserStatus.SUSPENDED;
      await user.save();
      const membership = await this.homeMembership(user, tenantId);
      if (membership && membership.status !== MembershipStatus.INACTIVE) {
        membership.status = MembershipStatus.INACTIVE;
        await membership.save();
      }
      // No session can exist (mint refuses it); revoke any planted row anyway.
      await (await SessionCollection.create(this.options)).revokeUserSessions(
        userId,
      );
      return await this.recordFor(user, tenantId);
    });
  }

  /** The service principal of `tenantId` with this key, retired or not. */
  async findServicePrincipal(input: {
    tenantId: string;
    key: string;
  }): Promise<ServicePrincipalRecord | null> {
    const tenantId = requireUuid(input?.tenantId, 'tenant');
    const key = requireKey(input?.key);
    return await withSystemContext(async () => {
      const user = await this.findUserByKey(tenantId, key);
      return user ? await this.recordFor(user, tenantId) : null;
    });
  }

  /** The service principal `userId` of `tenantId`, retired or not. */
  async getServicePrincipal(input: {
    tenantId: string;
    userId: string;
  }): Promise<ServicePrincipalRecord | null> {
    const tenantId = requireUuid(input?.tenantId, 'tenant');
    if (typeof input?.userId !== 'string' || !UUID.test(input.userId))
      return null;
    return await withSystemContext(async () => {
      const user = await this.boundUser(input.userId, tenantId);
      return user ? await this.recordFor(user, tenantId) : null;
    });
  }

  /**
   * Fresh per-call validity check: `userId` is a service principal bound to
   * exactly `tenantId`, not retired, with an active user and an active
   * membership there. False for a person, another tenant, or anything
   * malformed; never throws for a well-formed miss.
   */
  async isActiveServicePrincipal(input: {
    tenantId: string;
    userId: string;
  }): Promise<boolean> {
    if (
      typeof input?.tenantId !== 'string' ||
      !UUID.test(input.tenantId) ||
      typeof input.userId !== 'string' ||
      !UUID.test(input.userId)
    )
      return false;
    return (await this.getServicePrincipal(input))?.status === 'active';
  }

  /** Every service principal of `tenantId` (active first-class records only unless asked). */
  async listServicePrincipals(input: {
    tenantId: string;
    includeRetired?: boolean;
  }): Promise<ServicePrincipalRecord[]> {
    const tenantId = requireUuid(input?.tenantId, 'tenant');
    return await withSystemContext(async () => {
      const db = this.options.db as DatabaseInterface;
      // Unbounded raw id read: a caller's list limits must never hide one.
      const result = await db.query(
        'SELECT id FROM users WHERE service_principal_tenant_id = ? AND principal_kind = ? ORDER BY created_at ASC, id ASC',
        tenantId,
        SERVICE_PRINCIPAL_KIND,
      );
      const users = await UserCollection.create(this.options);
      const records: ServicePrincipalRecord[] = [];
      for (const row of result.rows ?? []) {
        const user = await users.get({ id: String(row.id) }, { cache: false });
        if (!user || user.servicePrincipalTenantId !== tenantId) continue;
        const record = await this.recordFor(user, tenantId);
        if (!record) continue;
        if (record.status === 'retired' && !input.includeRetired) continue;
        records.push(record);
      }
      return records;
    });
  }

  private async findUserByKey(
    tenantId: string,
    key: string,
  ): Promise<User | null> {
    const users = await UserCollection.create(this.options);
    const matches = await users.list({
      where: { servicePrincipalTenantId: tenantId, servicePrincipalKey: key },
      limit: 2,
    });
    if (matches.length > 1)
      throw new ServicePrincipalError(
        'Service principal key is ambiguous',
        409,
      );
    const user = matches[0];
    return user?.isServicePrincipal() ? user : null;
  }

  private async boundUser(
    userId: string,
    tenantId: string,
  ): Promise<User | null> {
    const user = await (await UserCollection.create(this.options)).get(
      { id: userId },
      { cache: false },
    );
    return user?.isServicePrincipal() &&
      user.servicePrincipalTenantId === tenantId
      ? user
      : null;
  }

  private async homeMembership(
    user: User,
    tenantId: string,
  ): Promise<Membership | null> {
    const matches = await (
      await MembershipCollection.create(this.options)
    ).list({ where: { userId: user.id, tenantId }, limit: 2 });
    return matches.length === 1 ? matches[0] : null;
  }

  private async recordFor(
    user: User,
    tenantId: string,
  ): Promise<ServicePrincipalRecord | null> {
    if (
      !user.isServicePrincipal() ||
      user.servicePrincipalTenantId !== tenantId ||
      !user.servicePrincipalKey
    )
      return null;
    const membership = await this.homeMembership(user, tenantId);
    if (!membership?.id || !membership.roleId) return null;
    const status =
      user.retiredAt !== null
        ? 'retired'
        : user.status === UserStatus.ACTIVE &&
            membership.status === MembershipStatus.ACTIVE
          ? 'active'
          : 'inactive';
    return {
      userId: requiredId(user.id),
      profileId: user.profileId,
      membershipId: requiredId(membership.id),
      tenantId,
      key: user.servicePrincipalKey,
      roleId: membership.roleId,
      status,
      retiredAt: user.retiredAt,
    };
  }
}

function requireUuid(value: unknown, label: string): string {
  if (typeof value !== 'string' || !UUID.test(value))
    throw new ServicePrincipalError(`A valid ${label} id is required`, 400);
  return value;
}

function requireKey(value: unknown): string {
  if (typeof value !== 'string' || !KEY.test(value))
    throw new ServicePrincipalError(
      'Service principal key must be 1-200 printable characters',
      400,
    );
  return value;
}

function requiredId(id: unknown): string {
  if (typeof id !== 'string' || !id)
    throw new Error('Service principal record has no id');
  return id;
}
