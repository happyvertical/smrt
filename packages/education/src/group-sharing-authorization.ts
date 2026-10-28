import {
  isEmbeddedDatabase,
  isPostgresDatabase,
  withEmbeddedWriteTransaction,
} from '@happyvertical/smrt-core';
import { getCurrentTenant, withTenant } from '@happyvertical/smrt-tenancy';
import { SessionCollection } from '@happyvertical/smrt-users';
import type { DatabaseInterface } from '@happyvertical/sql';
import { LearnerCollection } from './collections.js';
import {
  type GroupSharingActor,
  GroupSharingAuthorizationError,
  GroupSharingPolicyValidationError,
  type GroupSharingScope,
} from './group-sharing-contracts.js';
import {
  EducationGroupCollection,
  GroupLearnerMembershipCollection,
  GroupSharingPolicyCollection,
} from './group-sharing-models.js';

export type GroupSharingAction =
  | 'education.group.create'
  | 'education.group.manage'
  | 'education.group.read'
  | 'education.group.invite'
  | 'education.group.share'
  | 'education.group.review'
  | 'education.group.comment'
  | 'education.group.child-comments';
export type GroupSharingAuthorizer = (
  request: GroupSharingActor & {
    action: GroupSharingAction;
    executor: DatabaseInterface;
    groupId?: string;
    groupTenantId?: string;
    familyTenantId?: string;
    learnerId?: string;
    /** Host must validate current guardian type and effective terms on this executor. */
    guardianRelationships?: ReadonlyArray<{ id: string; typeId: string }>;
  },
) => boolean | Promise<boolean>;

// Preserve host failures even if a host chooses the service's authorization error type.
const hostFailures = new WeakSet<object>();
/** Internal owning predicate; unavailable individual edges may be omitted, host/DB failures may not. */
export function isGroupSharingScopeDenial(error: unknown): boolean {
  return (
    error instanceof GroupSharingAuthorizationError && !hostFailures.has(error)
  );
}
/** Same connection queue as workbook mutations, with a real rollback boundary. */
export function groupSharingTransaction<T>(
  db: DatabaseInterface,
  operation: (executor: DatabaseInterface) => Promise<T>,
): Promise<T> {
  return withEmbeddedWriteTransaction(db, isEmbeddedDatabase(db), operation);
}

/** Internal owning boundary. Never returned from a public sharing operation. */
export class GroupSharingBoundary {
  constructor(
    readonly db: DatabaseInterface,
    readonly authorize: GroupSharingAuthorizer,
  ) {}

  private async hostDecision(
    request: Parameters<GroupSharingAuthorizer>[0],
  ): Promise<boolean> {
    try {
      return await this.authorize(request);
    } catch (error) {
      if (
        error !== null &&
        (typeof error === 'object' || typeof error === 'function')
      )
        hostFailures.add(error);
      throw error;
    }
  }

  async requireIdentity(
    actor: GroupSharingActor,
  ): Promise<{ id: string; profileId: string }> {
    const context = getCurrentTenant();
    if (
      !context ||
      context.superAdminBypass ||
      context.userId !== actor.actorUserId ||
      !actor.actorUserId ||
      !actor.sessionId
    )
      throw new GroupSharingAuthorizationError();
    const user = await this.db.get('users', {
      id: actor.actorUserId,
      status: 'active',
    });
    const session = await (await SessionCollection.create({ db: this.db })).get(
      { id: actor.sessionId, userId: actor.actorUserId },
      { cache: false },
    );
    if (
      !user?.profile_id ||
      !session?.isValid() ||
      (session.tenantId !== null && session.tenantId !== context.tenantId)
    )
      throw new GroupSharingAuthorizationError();
    return { id: actor.actorUserId, profileId: String(user.profile_id) };
  }

  async check(
    request: GroupSharingActor & {
      groupId?: string;
      familyTenantId?: string;
      learnerId?: string;
    },
    action: GroupSharingAction,
    extra: {
      groupTenantId?: string;
      guardianRelationships?: ReadonlyArray<{ id: string; typeId: string }>;
    } = {},
  ): Promise<void> {
    await this.requireIdentity(request);
    if (
      (await this.hostDecision({
        actorUserId: request.actorUserId,
        sessionId: request.sessionId,
        groupId: request.groupId,
        familyTenantId: request.familyTenantId,
        learnerId: request.learnerId,
        ...extra,
        action,
        executor: this.db,
      })) !== true
    )
      throw new GroupSharingAuthorizationError();
  }

  /** Loading a group reveals no family data; its users tenant must remain active. */
  async loadGroup(groupId: string, allowInactive = false) {
    const row = await this.db.get('education_groups', {
      id: groupId,
      ...(allowInactive ? {} : { active: true }),
    });
    if (
      !row ||
      !(await this.db.get('tenants', { id: row.tenant_id, status: 'active' }))
    )
      throw new GroupSharingAuthorizationError();
    const group = await withTenant(
      { tenantId: String(row.tenant_id), userId: getCurrentTenant()?.userId },
      async () =>
        (await EducationGroupCollection.create({ db: this.db })).get(
          {
            id: groupId,
            tenantId: String(row.tenant_id),
            ...(allowInactive ? {} : { active: true }),
          },
          { cache: false },
        ),
    );
    if (
      !group ||
      typeof group.active !== 'boolean' ||
      (!allowInactive && !group.active)
    )
      throw new GroupSharingAuthorizationError();
    return group;
  }

  async requireGroup(
    request: GroupSharingActor & { groupId: string },
    action: GroupSharingAction = 'education.group.read',
  ) {
    await this.requireIdentity(request);
    const group = await this.loadGroup(
      request.groupId,
      action === 'education.group.manage',
    );
    if (getCurrentTenant()?.tenantId !== group.tenantId)
      throw new GroupSharingAuthorizationError();
    const membership = await this.db.get('memberships', {
      tenant_id: group.tenantId,
      user_id: request.actorUserId,
      status: 'active',
    });
    const role =
      membership && (await this.db.get('roles', { id: membership.role_id }));
    if (!role || (role.tenant_id != null && role.tenant_id !== group.tenantId))
      throw new GroupSharingAuthorizationError();
    await this.check(request, action, { groupTenantId: group.tenantId });
    return group;
  }

  /** Discover only this actor's group metadata while retaining their authenticated session context. */
  async discoverGroup(request: GroupSharingActor & { groupId: string }) {
    await this.requireIdentity(request);
    const raw = await this.db.get('education_groups', { id: request.groupId });
    if (
      !raw ||
      !(await this.db.get('tenants', { id: raw.tenant_id, status: 'active' }))
    )
      return null;
    const member = await this.db.get('memberships', {
      tenant_id: raw.tenant_id,
      user_id: request.actorUserId,
      status: 'active',
    });
    const role = member && (await this.db.get('roles', { id: member.role_id }));
    if (!role || (role.tenant_id != null && role.tenant_id !== raw.tenant_id))
      return null;
    const group = await this.loadGroup(request.groupId, true);
    const action = group.active
      ? 'education.group.read'
      : 'education.group.manage';
    if (
      (await this.hostDecision({
        actorUserId: request.actorUserId,
        sessionId: request.sessionId,
        groupId: request.groupId,
        groupTenantId: group.tenantId,
        action,
        executor: this.db,
      })) !== true
    )
      return null;
    await this.requireIdentity(request);
    return group;
  }

  /** Own-learner navigation is a separate capability and never synthesizes guardian authority. */
  async requireOwnLearner(request: Omit<GroupSharingScope, 'groupId'>) {
    await this.requireIdentity(request);
    if (getCurrentTenant()?.tenantId !== request.familyTenantId)
      throw new GroupSharingAuthorizationError();
    const scope = { ...request, groupId: '' };
    const learner = await this.loadLearner(scope);
    if (learner.userId !== request.actorUserId)
      throw new GroupSharingAuthorizationError();
    await this.check(scope, 'education.group.child-comments');
    return learner;
  }

  async requireGuardian(
    request: Omit<GroupSharingScope, 'groupId'> & { groupId?: string },
    action: GroupSharingAction = 'education.group.share',
  ) {
    const user = await this.requireIdentity(request);
    if (getCurrentTenant()?.tenantId !== request.familyTenantId)
      throw new GroupSharingAuthorizationError();
    const learner = await this.loadLearner({
      ...request,
      groupId: request.groupId ?? '',
    });
    if (
      learner.userId === request.actorUserId ||
      !(await this.db.get('memberships', {
        tenant_id: request.familyTenantId,
        user_id: request.actorUserId,
        status: 'active',
      }))
    )
      throw new GroupSharingAuthorizationError();
    const relationships = await this.db.list('profile_relationships', {
      tenant_id: request.familyTenantId,
      from_profile_id: user.profileId,
      to_profile_id: learner.profileId,
    });
    if (!relationships.length) throw new GroupSharingAuthorizationError();
    await this.check(request, action, {
      guardianRelationships: relationships.map((row) => ({
        id: String(row.id),
        typeId: String(row.type_id),
      })),
    });
    return learner;
  }

  private async loadLearner(request: GroupSharingScope) {
    if (
      !request.familyTenantId ||
      !request.learnerId ||
      !(await this.db.get('tenants', {
        id: request.familyTenantId,
        status: 'active',
      }))
    )
      throw new GroupSharingAuthorizationError();
    const learner = await withTenant(
      { tenantId: request.familyTenantId, userId: request.actorUserId },
      async () =>
        (await LearnerCollection.create({ db: this.db })).get(
          { id: request.learnerId, tenantId: request.familyTenantId },
          { cache: false },
        ),
    );
    if (
      !learner ||
      !(await this.db.get('memberships', {
        tenant_id: request.familyTenantId,
        user_id: learner.userId,
        status: 'active',
      })) ||
      !(await this.db.get('users', {
        id: learner.userId,
        profile_id: learner.profileId,
        status: 'active',
      })) ||
      !(await this.db.get('profiles', {
        id: learner.profileId,
        _meta_type: '@happyvertical/smrt-profiles:Person',
      }))
    )
      throw new GroupSharingAuthorizationError();
    return learner;
  }

  async requireScope(
    request: GroupSharingScope,
    action: GroupSharingAction = 'education.group.review',
    mode: 'supervisor' | 'guardian' | 'child' = 'supervisor',
  ) {
    await this.requireIdentity(request);
    const group =
      mode === 'supervisor'
        ? await this.requireGroup(request, action)
        : await this.loadGroup(request.groupId);
    const learner =
      mode === 'guardian'
        ? await this.requireGuardian(request, action)
        : await this.loadLearner(request);
    if (mode === 'child') {
      if (
        getCurrentTenant()?.tenantId !== request.familyTenantId ||
        learner.userId !== request.actorUserId
      )
        throw new GroupSharingAuthorizationError();
      await this.check(request, action, { groupTenantId: group.tenantId });
    }
    const owned = await withTenant(
      { tenantId: request.familyTenantId, userId: request.actorUserId },
      async () => {
        const membership = await (
          await GroupLearnerMembershipCollection.create({ db: this.db })
        ).get(
          {
            tenantId: request.familyTenantId,
            learnerId: request.learnerId,
            groupId: request.groupId,
            status: 'active',
          },
          { cache: false },
        );
        const policyRecord =
          membership &&
          (await (
            await GroupSharingPolicyCollection.create({ db: this.db })
          ).get(
            {
              tenantId: request.familyTenantId,
              membershipId: String(membership.id),
              version: membership.policyVersion,
            },
            { cache: false },
          ));
        if (
          !membership ||
          !Number.isSafeInteger(membership.policyVersion) ||
          membership.policyVersion < 1 ||
          !policyRecord ||
          !Number.isSafeInteger(policyRecord.version) ||
          policyRecord.version < 1 ||
          policyRecord.schemaVersion !== 1
        )
          throw new GroupSharingAuthorizationError();
        try {
          return { membership, policyRecord, policy: policyRecord.getPolicy() };
        } catch (error) {
          if (
            error instanceof SyntaxError ||
            error instanceof GroupSharingPolicyValidationError
          )
            throw new GroupSharingAuthorizationError(
              'Stored sharing policy is unavailable',
            );
          throw error;
        }
      },
    );
    return { group, learner, ...owned };
  }
}

/** Fixed lock order shared with workbook: learner, exact group edge, then invitation/comment. */
export async function lockGroupSharingScope(
  db: DatabaseInterface,
  request: Pick<GroupSharingScope, 'familyTenantId' | 'learnerId' | 'groupId'>,
): Promise<void> {
  if (!isPostgresDatabase(db)) return;
  await db.query(
    'SELECT id FROM learners WHERE id = ? AND tenant_id = ? FOR UPDATE',
    [request.learnerId, request.familyTenantId],
  );
  await db.query(
    'SELECT id FROM group_learner_memberships WHERE tenant_id = ? AND learner_id = ? AND group_id = ? FOR UPDATE',
    [request.familyTenantId, request.learnerId, request.groupId],
  );
}
