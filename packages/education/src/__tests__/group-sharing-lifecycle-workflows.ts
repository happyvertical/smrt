import { randomUUID } from 'node:crypto';
import { withTenant } from '@happyvertical/smrt-tenancy';
import { MembershipStatus, SessionCollection } from '@happyvertical/smrt-users';
import type { DatabaseInterface } from '@happyvertical/sql';
import { expect } from 'vitest';
import {
  type GroupSharingAuthorizer,
  GroupSharingBoundary,
} from '../group-sharing-authorization.js';
import {
  GroupSharingAuthorizationError,
  GroupSharingConflictError,
  type GroupSharingPolicyV1,
} from '../group-sharing-contracts.js';
import { GroupSharingService } from '../group-sharing-service.js';
import '../group-sharing-models.js';
import { learnerClasses, learnerFixture } from './learner-workflows.js';

export const groupSharingLifecycleClasses = [
  ...learnerClasses,
  'Session',
  'EducationGroup',
  'GroupLearnerInvitation',
  'GroupLearnerMembership',
  'GroupSharingPolicy',
  'GroupLearnerRosterEntry',
];
export const sharingPolicy: GroupSharingPolicyV1 = {
  schemaVersion: 1,
  shareWork: true,
  shareMedia: true,
  shareFeedback: false,
  shareProgress: true,
  parentReviewedOnly: false,
  historyFrom: '2020-01-01T00:00:00.000Z',
  subjects: { mode: 'all' },
  courseIds: { mode: 'all' },
  commentVisibility: 'parent-only',
};

export async function groupSharingLifecycleFixture(db: DatabaseInterface) {
  const family = await learnerFixture(db);
  const sessions = await SessionCollection.create({ db });
  async function actor(userId: string) {
    const session = await sessions.create({
      userId,
      tenantId: null,
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    return { actorUserId: userId, sessionId: String(session.id) };
  }
  const parent = await actor(String(family.guardian.user.id));
  const supervisor = await actor(String(family.stranger.user.id));
  const child = await actor(String(family.alice.user.id));
  const calls: Array<{ executor: DatabaseInterface; action: string }> = [];
  const authorize: GroupSharingAuthorizer = async (request) => {
    calls.push({ executor: request.executor, action: request.action });
    if (request.action === 'education.group.child-comments')
      return (
        request.actorUserId === child.actorUserId &&
        request.learnerId === String(family.learner.id)
      );
    if (
      request.action === 'education.group.review' &&
      !request.guardianRelationships
    )
      return request.actorUserId === supervisor.actorUserId;
    if (
      request.action === 'education.group.share' ||
      request.action === 'education.group.review'
    ) {
      return (
        request.actorUserId === parent.actorUserId &&
        (!request.guardianRelationships ||
          request.guardianRelationships.some(
            (r) =>
              r.id === family.relationship.id &&
              r.typeId === family.guardianType.id,
          ))
      );
    }
    return request.actorUserId === supervisor.actorUserId;
  };
  const service = new GroupSharingService(db, authorize);
  const asParent = <T>(fn: () => Promise<T>) =>
    withTenant(
      { tenantId: family.parent.tenantId, userId: parent.actorUserId },
      fn,
    );
  const group = await withTenant(
    {
      tenantId: String(family.stranger.user.id),
      userId: supervisor.actorUserId,
    },
    () => service.createGroup({ ...supervisor, name: `Group ${randomUUID()}` }),
  );
  const asSupervisor = <T>(fn: () => Promise<T>) =>
    withTenant(
      { tenantId: group.tenantId, userId: supervisor.actorUserId },
      fn,
    );
  const scope = {
    ...parent,
    groupId: group.id,
    familyTenantId: family.parent.tenantId,
    learnerId: String(family.learner.id),
  };
  const invite = () =>
    asSupervisor(() =>
      service.inviteLearner({
        ...scope,
        ...supervisor,
        invitedParentUserId: parent.actorUserId,
        expiresAt: new Date(Date.now() + 60_000),
      }),
    );
  return {
    ...family,
    calls,
    sessions,
    parentActor: parent,
    childActor: child,
    supervisor,
    group,
    scope,
    asParent,
    asSupervisor,
    sharingService: service,
    authorize,
    invite,
  };
}
type Fixture = Awaited<ReturnType<typeof groupSharingLifecycleFixture>>;

export async function assertGroupSharingLifecycle(f: Fixture) {
  const invitation = await f.invite();
  const accepted = await f.asParent(() =>
    f.sharingService.acceptInvitation({
      ...f.parentActor,
      invitationId: invitation.id,
      policy: sharingPolicy,
    }),
  );
  expect(accepted.status).toBe('active');
  expect(accepted.familyTenantId).toBe(f.scope.familyTenantId);
  expect(
    await f.db.get('memberships', {
      tenant_id: f.scope.familyTenantId,
      user_id: f.supervisor.actorUserId,
    }),
  ).toBeNull();
  const next = await f.asParent(() =>
    f.sharingService.setSharingPolicy({
      ...f.scope,
      expectedVersion: 1,
      policy: { ...sharingPolicy, shareWork: false },
    }),
  );
  expect(next.policyVersion).toBe(2);
  const retry = await f.asParent(() =>
    f.sharingService.acceptInvitation({
      ...f.parentActor,
      invitationId: invitation.id,
      policy: sharingPolicy,
    }),
  );
  expect(retry.id).toBe(accepted.id);
  expect(retry.policyVersion).toBe(2);
  await expect(
    f.asParent(() =>
      f.sharingService.setSharingPolicy({
        ...f.scope,
        expectedVersion: 1,
        policy: sharingPolicy,
      }),
    ),
  ).rejects.toBeInstanceOf(GroupSharingConflictError);
  expect(
    (await f.db.list('group_sharing_policies', { membership_id: accepted.id }))
      .length,
  ).toBe(2);
  await f.asParent(() => f.sharingService.revokeMembership(f.scope));
  await expect(
    f.asParent(() =>
      f.sharingService.acceptInvitation({
        ...f.parentActor,
        invitationId: invitation.id,
        policy: sharingPolicy,
      }),
    ),
  ).rejects.toBeInstanceOf(GroupSharingConflictError);
  const fresh = await f.invite();
  const rejoined = await f.asParent(() =>
    f.sharingService.acceptInvitation({
      ...f.parentActor,
      invitationId: fresh.id,
      policy: sharingPolicy,
    }),
  );
  expect(rejoined.id).toBe(accepted.id);
  expect(rejoined.policyVersion).toBe(3);
}

export async function assertGroupSharingTargeting(f: Fixture) {
  const opaque = await f.asSupervisor(() =>
    f.sharingService.inviteLearner({
      ...f.scope,
      ...f.supervisor,
      learnerId: randomUUID(),
      familyTenantId: randomUUID(),
      invitedParentUserId: f.parentActor.actorUserId,
      expiresAt: new Date(Date.now() + 60_000),
    }),
  );
  expect(opaque.status).toBe('pending');
  await expect(
    f.asParent(() =>
      f.sharingService.acceptInvitation({
        ...f.parentActor,
        invitationId: opaque.id,
        policy: sharingPolicy,
      }),
    ),
  ).rejects.toBeInstanceOf(GroupSharingAuthorizationError);
  const invitation = await f.invite();
  await expect(
    f.asSupervisor(() =>
      f.sharingService.acceptInvitation({
        ...f.supervisor,
        invitationId: invitation.id,
        policy: sharingPolicy,
      }),
    ),
  ).rejects.toBeInstanceOf(GroupSharingAuthorizationError);
  await f.asParent(() =>
    f.sharingService.declineInvitation({
      ...f.parentActor,
      invitationId: invitation.id,
    }),
  );
  await expect(
    f.asParent(() =>
      f.sharingService.acceptInvitation({
        ...f.parentActor,
        invitationId: invitation.id,
        policy: sharingPolicy,
      }),
    ),
  ).rejects.toBeInstanceOf(GroupSharingConflictError);
  const revoked = await f.invite();
  await f.asSupervisor(() =>
    f.sharingService.revokeInvitation({
      ...f.supervisor,
      invitationId: revoked.id,
    }),
  );
  await expect(
    f.asParent(() =>
      f.sharingService.acceptInvitation({
        ...f.parentActor,
        invitationId: revoked.id,
        policy: sharingPolicy,
      }),
    ),
  ).rejects.toBeInstanceOf(GroupSharingConflictError);
}

export async function assertGroupSharingAtomicity(f: Fixture) {
  const invitation = await f.invite();
  const accepted = await Promise.all(
    [1, 2].map(() =>
      f.asParent(() =>
        f.sharingService.acceptInvitation({
          ...f.parentActor,
          invitationId: invitation.id,
          policy: sharingPolicy,
        }),
      ),
    ),
  );
  expect(accepted[0].id).toBe(accepted[1].id);
  expect(
    (
      await f.db.list('group_sharing_policies', {
        membership_id: accepted[0].id,
      })
    ).length,
  ).toBe(1);
  let closed: GroupSharingService | undefined;
  await expect(
    f.asParent(() =>
      f.sharingService.withTransaction(async (tx) => {
        closed = tx;
        await tx.setSharingPolicy({
          ...f.scope,
          expectedVersion: 1,
          policy: { ...sharingPolicy, shareMedia: false },
        });
        try {
          await tx.setSharingPolicy({
            ...f.scope,
            expectedVersion: 1,
            policy: sharingPolicy,
          });
        } catch {
          /* poisoned scope must still roll back */
        }
      }),
    ),
  ).rejects.toBeInstanceOf(GroupSharingConflictError);
  expect(
    (
      await f.db.list('group_sharing_policies', {
        membership_id: accepted[0].id,
      })
    ).length,
  ).toBe(1);
  await expect(
    f.asParent(() => {
      if (!closed) throw new Error('Missing closed scope');
      return closed.revokeMembership(f.scope);
    }),
  ).rejects.toThrow('scope is closed');
  expect(f.calls.every((call) => call.executor !== f.db)).toBe(true);
}

export async function assertGroupSharingCurrentAuthority(f: Fixture) {
  const invitation = await f.invite();
  await f.asParent(() =>
    f.sharingService.acceptInvitation({
      ...f.parentActor,
      invitationId: invitation.id,
      policy: sharingPolicy,
    }),
  );
  const supervisorScope = { ...f.scope, ...f.supervisor };
  const boundary = new GroupSharingBoundary(f.db, f.authorize);
  await f.asSupervisor(() => boundary.requireScope(supervisorScope));
  await f.db.update(
    'sessions',
    { id: f.supervisor.sessionId },
    { status: 'revoked' },
  );
  await expect(
    f.asSupervisor(() => boundary.requireScope(supervisorScope)),
  ).rejects.toBeInstanceOf(GroupSharingAuthorizationError);
  await expect(
    f.asSupervisor(() =>
      f.sharingService.getGroup({ ...f.supervisor, groupId: f.group.id }),
    ),
  ).rejects.toBeInstanceOf(GroupSharingAuthorizationError);
}

export async function assertGroupSharingValidation(f: Fixture) {
  const invitation = await f.invite();
  for (const policy of [
    undefined,
    { ...sharingPolicy, shareWork: 'true' },
    { ...sharingPolicy, schemaVersion: 2 },
    { ...sharingPolicy, historyFrom: '2026-02-30T00:00:00.000Z' },
  ]) {
    await expect(
      f.asParent(() =>
        f.sharingService.acceptInvitation({
          ...f.parentActor,
          invitationId: invitation.id,
          policy: policy as GroupSharingPolicyV1,
        }),
      ),
    ).rejects.toThrow();
  }
  expect(
    await f.db.list('group_learner_memberships', { group_id: f.group.id }),
  ).toHaveLength(0);
  expect(
    (await f.db.get('group_learner_invitations', { id: invitation.id }))
      ?.status,
  ).toBe('pending');
  await f.db.update(
    'group_learner_invitations',
    { id: invitation.id },
    { expires_at: new Date(Date.now() - 1_000) },
  );
  await expect(
    f.asParent(() =>
      f.sharingService.acceptInvitation({
        ...f.parentActor,
        invitationId: invitation.id,
        policy: sharingPolicy,
      }),
    ),
  ).rejects.toBeInstanceOf(GroupSharingConflictError);
  let checks = 0;
  const fail = new GroupSharingService(f.db, async (request) => {
    if (request.action === 'education.group.create' && ++checks === 2)
      throw new Error('final host check failed');
    return f.authorize(request);
  });
  const before = await f.db.list('tenants', {});
  await expect(
    f.asSupervisor(() =>
      fail.createGroup({ ...f.supervisor, name: 'Must roll back' }),
    ),
  ).rejects.toThrow('final host check failed');
  expect(await f.db.list('tenants', {})).toHaveLength(before.length);
}

export async function assertGroupSharingRosterAndRevocation(f: Fixture) {
  const invitation = await f.invite();
  const accepted = await f.asParent(() =>
    f.sharingService.acceptInvitation({
      ...f.parentActor,
      invitationId: invitation.id,
      policy: sharingPolicy,
    }),
  );
  const roster = await f.asSupervisor(() =>
    f.sharingService.listMemberships({ ...f.supervisor, groupId: f.group.id }),
  );
  expect(roster).toEqual([
    { ...accepted, learnerDisplayName: f.learner.displayName },
  ]);
  expect(roster.map((entry) => entry.learnerDisplayName)).not.toContain(
    f.sibling.displayName,
  );
  expect(roster.map((entry) => entry.learnerDisplayName)).not.toContain(
    f.foreign.displayName,
  );
  expect(
    await f.asParent(() =>
      f.sharingService.listLearnerMemberships({
        ...f.parentActor,
        familyTenantId: f.scope.familyTenantId,
        learnerId: f.scope.learnerId,
      }),
    ),
  ).toEqual([{ ...accepted, groupName: f.group.name, groupActive: true }]);
  await f.asSupervisor(() =>
    f.sharingService.removeLearner({ ...f.scope, ...f.supervisor }),
  );
  expect(
    await f.asSupervisor(() =>
      f.sharingService.listMemberships({
        ...f.supervisor,
        groupId: f.group.id,
      }),
    ),
  ).toEqual([]);
  const familyHistory = await f.asParent(() =>
    f.sharingService.listLearnerMemberships({
      ...f.parentActor,
      familyTenantId: f.scope.familyTenantId,
      learnerId: f.scope.learnerId,
    }),
  );
  expect(familyHistory[0].status).toBe('revoked');
  expect(
    await f.db.get('learners', {
      id: f.scope.learnerId,
      tenant_id: f.scope.familyTenantId,
    }),
  ).toBeTruthy();
  expect(
    await f.db.list('group_sharing_policies', { membership_id: accepted.id }),
  ).toHaveLength(1);
}

export async function assertGroupSharingPersistedAuthority(f: Fixture) {
  const invitation = await f.invite();
  const accepted = await f.asParent(() =>
    f.sharingService.acceptInvitation({
      ...f.parentActor,
      invitationId: invitation.id,
      policy: sharingPolicy,
    }),
  );
  const scope = { ...f.scope, ...f.supervisor };
  const boundary = new GroupSharingBoundary(f.db, f.authorize);
  const member = await f.db.get('memberships', {
    tenant_id: f.group.tenantId,
    user_id: f.supervisor.actorUserId,
  });
  if (!member) throw new Error('Missing supervisor membership');
  await f.db.update('memberships', { id: member.id }, { status: 'suspended' });
  await expect(
    f.asSupervisor(() => boundary.requireScope(scope)),
  ).rejects.toBeInstanceOf(GroupSharingAuthorizationError);
  if (!member) throw new Error('Missing supervisor membership');
  await f.db.update('memberships', { id: member.id }, { status: 'active' });
  await f.db.update('education_groups', { id: f.group.id }, { active: false });
  await expect(
    f.asSupervisor(() => boundary.requireScope(scope)),
  ).rejects.toBeInstanceOf(GroupSharingAuthorizationError);
  await f.db.update('education_groups', { id: f.group.id }, { active: true });
  await f.db.update(
    'group_learner_memberships',
    { id: accepted.id },
    { policy_version: 0 },
  );
  await expect(
    f.asSupervisor(() => boundary.requireScope(scope)),
  ).rejects.toBeInstanceOf(GroupSharingAuthorizationError);
  await f.db.update(
    'group_learner_memberships',
    { id: accepted.id },
    { policy_version: 1 },
  );
  await f.db.delete('profile_relationships', { id: String(f.relationship.id) });
  await expect(
    f.asParent(() =>
      f.sharingService.setSharingPolicy({
        ...f.scope,
        policy: sharingPolicy,
        expectedVersion: 1,
      }),
    ),
  ).rejects.toBeInstanceOf(GroupSharingAuthorizationError);
}

export async function assertGroupSharingAdministration(f: Fixture) {
  const invitation = await f.invite();
  const accepted = await f.asParent(() =>
    f.sharingService.acceptInvitation({
      ...f.parentActor,
      invitationId: invitation.id,
      policy: sharingPolicy,
    }),
  );
  const disabled = await f.asSupervisor(() =>
    f.sharingService.updateGroup({
      ...f.supervisor,
      groupId: f.group.id,
      name: 'Renamed group',
      active: false,
    }),
  );
  expect(disabled.name).toBe('Renamed group');
  expect(disabled.active).toBe(false);
  await expect(
    f.asSupervisor(() =>
      f.sharingService.getGroup({ ...f.supervisor, groupId: f.group.id }),
    ),
  ).rejects.toBeInstanceOf(GroupSharingAuthorizationError);
  await expect(
    f.asSupervisor(() =>
      new GroupSharingBoundary(f.db, f.authorize).requireScope({
        ...f.scope,
        ...f.supervisor,
      }),
    ),
  ).rejects.toBeInstanceOf(GroupSharingAuthorizationError);
  expect(
    (await f.db.get('group_learner_memberships', { id: accepted.id }))?.status,
  ).toBe('active');
  const enabled = await f.asSupervisor(() =>
    f.sharingService.updateGroup({
      ...f.supervisor,
      groupId: f.group.id,
      active: true,
    }),
  );
  expect(enabled.active).toBe(true);
  await f.asSupervisor(() =>
    f.sharingService.getGroup({ ...f.supervisor, groupId: f.group.id }),
  );
  const denied = new GroupSharingService(
    f.db,
    async (request) =>
      request.action !== 'education.group.manage' && f.authorize(request),
  );
  await expect(
    f.asSupervisor(() =>
      denied.updateGroup({
        ...f.supervisor,
        groupId: f.group.id,
        active: false,
      }),
    ),
  ).rejects.toBeInstanceOf(GroupSharingAuthorizationError);
}

export async function assertGroupSharingHostContracts(f: Fixture) {
  const invitation = await f.invite();
  const detail = await f.asParent(() =>
    f.sharingService.getInvitation({
      ...f.parentActor,
      invitationId: invitation.id,
      access: 'parent',
    }),
  );
  expect(detail).toEqual({
    ...invitation,
    groupName: f.group.name,
    learnerDisplayName: f.learner.displayName,
  });
  expect(
    await f.db.get('memberships', {
      tenant_id: f.group.tenantId,
      user_id: f.parentActor.actorUserId,
    }),
  ).toBeNull();
  expect(
    await f.asSupervisor(() =>
      f.sharingService.getInvitation({
        ...f.supervisor,
        invitationId: invitation.id,
        access: 'staff',
      }),
    ),
  ).toEqual(invitation);
  await expect(
    f.asSupervisor(() =>
      f.sharingService.getInvitation({
        ...f.supervisor,
        invitationId: invitation.id,
        access: 'parent',
      }),
    ),
  ).rejects.toBeInstanceOf(GroupSharingAuthorizationError);
  const opaque = await f.asSupervisor(() =>
    f.sharingService.inviteLearner({
      ...f.scope,
      ...f.supervisor,
      learnerId: randomUUID(),
      familyTenantId: randomUUID(),
      invitedParentUserId: f.parentActor.actorUserId,
      expiresAt: new Date(Date.now() + 60_000),
    }),
  );
  expect(
    await f.asSupervisor(() =>
      f.sharingService.getInvitation({
        ...f.supervisor,
        invitationId: opaque.id,
        access: 'staff',
      }),
    ),
  ).toEqual(opaque);
  await expect(
    f.asParent(() =>
      f.sharingService.getInvitation({
        ...f.parentActor,
        invitationId: opaque.id,
        access: 'parent',
      }),
    ),
  ).rejects.toBeInstanceOf(GroupSharingAuthorizationError);
  const listed = await f.asSupervisor(() =>
    f.sharingService.listInvitations({ ...f.supervisor, groupId: f.group.id }),
  );
  expect(listed).toHaveLength(2);
  expect(listed).toEqual(expect.arrayContaining([invitation, opaque]));
  expect(
    listed.every(
      (row) => !('learnerDisplayName' in row) && !('groupName' in row),
    ),
  ).toBe(true);
  await expect(
    f.asParent(() =>
      f.sharingService.listInvitations({
        ...f.parentActor,
        groupId: f.group.id,
      }),
    ),
  ).rejects.toBeInstanceOf(GroupSharingAuthorizationError);
  const accepted = await f.asParent(() =>
    f.sharingService.acceptInvitation({
      ...f.parentActor,
      invitationId: invitation.id,
      policy: sharingPolicy,
    }),
  );
  await f.asParent(() =>
    f.sharingService.setSharingPolicy({
      ...f.scope,
      expectedVersion: 1,
      policy: { ...sharingPolicy, shareWork: false },
    }),
  );
  await f.asParent(() => f.sharingService.leaveGroup(f.scope));
  await f.asSupervisor(() =>
    f.sharingService.updateGroup({
      ...f.supervisor,
      groupId: f.group.id,
      active: false,
    }),
  );
  const memberships = await f.asParent(() =>
    f.sharingService.listLearnerMemberships({
      ...f.parentActor,
      familyTenantId: f.scope.familyTenantId,
      learnerId: f.scope.learnerId,
    }),
  );
  expect(memberships).toEqual([
    {
      ...accepted,
      status: 'revoked',
      policyVersion: 2,
      groupName: f.group.name,
      groupActive: false,
    },
  ]);
  const first = await f.asParent(() =>
    f.sharingService.getSharingPolicyHistory({ ...f.scope, limit: 1 }),
  );
  expect(first.policies).toHaveLength(1);
  expect(first.policies[0]).toMatchObject({
    membershipId: accepted.id,
    familyTenantId: f.scope.familyTenantId,
    version: 1,
    schemaVersion: 1,
    policy: sharingPolicy,
    actorUserId: f.parentActor.actorUserId,
  });
  expect(Number.isFinite(Date.parse(first.policies[0].recordedAt))).toBe(true);
  expect(first.nextAfterVersion).toBe(1);
  const second = await f.asParent(() =>
    f.sharingService.getSharingPolicyHistory({
      ...f.scope,
      afterVersion: 1,
      limit: 1,
    }),
  );
  expect(second.policies[0].version).toBe(2);
  expect(second.policies[0].policy.shareWork).toBe(false);
  expect(second.nextAfterVersion).toBeNull();
  expect(
    await f.asParent(() =>
      f.sharingService.getSharingPolicyHistory({ ...f.scope, limit: 1 }),
    ),
  ).toEqual(first);
  await expect(
    f.asParent(() =>
      f.sharingService.getSharingPolicyHistory({
        ...f.scope,
        learnerId: String(f.sibling.id),
      }),
    ),
  ).rejects.toBeInstanceOf(GroupSharingAuthorizationError);
  await expect(
    f.asSupervisor(() =>
      f.sharingService.getSharingPolicyHistory({ ...f.scope, ...f.supervisor }),
    ),
  ).rejects.toBeInstanceOf(GroupSharingAuthorizationError);
  for (const pagination of [
    { limit: 0 },
    { limit: 101 },
    { afterVersion: -1 },
    { afterVersion: 1.5 },
  ])
    await expect(
      f.asParent(() =>
        f.sharingService.getSharingPolicyHistory({ ...f.scope, ...pagination }),
      ),
    ).rejects.toThrow('pagination');
}

export async function assertGroupSharingDiscovery(f: Fixture) {
  const second = await f.asSupervisor(() =>
    f.sharingService.createGroup({ ...f.supervisor, name: 'Second group' }),
  );
  const asSecond = <T>(operation: () => Promise<T>) =>
    withTenant(
      { tenantId: second.tenantId, userId: f.supervisor.actorUserId },
      operation,
    );
  const invitation = await f.invite();
  await f.asParent(() =>
    f.sharingService.acceptInvitation({
      ...f.parentActor,
      invitationId: invitation.id,
      policy: sharingPolicy,
    }),
  );
  const secondInvitation = await asSecond(() =>
    f.sharingService.inviteLearner({
      ...f.scope,
      ...f.supervisor,
      groupId: second.id,
      invitedParentUserId: f.parentActor.actorUserId,
      expiresAt: new Date(Date.now() + 60_000),
    }),
  );
  await f.asParent(() =>
    f.sharingService.acceptInvitation({
      ...f.parentActor,
      invitationId: secondInvitation.id,
      policy: sharingPolicy,
    }),
  );
  // Discovery keeps the original stored session context while deriving each group scope internally.
  await f.db.update(
    'sessions',
    { id: f.supervisor.sessionId },
    { tenant_id: f.group.tenantId },
  );
  const groups = await f.asSupervisor(() =>
    f.sharingService.listMyGroups(f.supervisor),
  );
  expect(groups.map((group) => group.id).sort()).toEqual(
    [f.group.id, second.id].sort(),
  );
  expect(
    await f.asParent(() => f.sharingService.listMyGroups(f.parentActor)),
  ).toEqual([]);
  await expect(
    f.asSupervisor(() => f.sharingService.listMyGroups(f.parentActor)),
  ).rejects.toBeInstanceOf(GroupSharingAuthorizationError);
  // Clear the active tenant before the host switches the same supervisor's context for management.
  await f.db.update(
    'sessions',
    { id: f.supervisor.sessionId },
    { tenant_id: null },
  );
  await asSecond(() =>
    f.sharingService.updateGroup({
      ...f.supervisor,
      groupId: second.id,
      active: false,
    }),
  );
  expect(
    (await f.asSupervisor(() => f.sharingService.listMyGroups(f.supervisor)))
      .map((group) => group.id)
      .sort(),
  ).toEqual([f.group.id, second.id].sort());
  const readOnly = new GroupSharingService(
    f.db,
    async (request) =>
      request.action !== 'education.group.manage' && f.authorize(request),
  );
  expect(
    (await f.asSupervisor(() => readOnly.listMyGroups(f.supervisor))).map(
      (group) => group.id,
    ),
  ).toEqual([f.group.id]);
  const asChild = <T>(operation: () => Promise<T>) =>
    withTenant(
      { tenantId: f.scope.familyTenantId, userId: f.childActor.actorUserId },
      operation,
    );
  const childRequest = {
    ...f.scope,
    ...f.childActor,
    access: 'child' as const,
  };
  const memberships = await asChild(() =>
    f.sharingService.listLearnerMemberships(childRequest),
  );
  expect(memberships).toHaveLength(1);
  expect(memberships[0]).toMatchObject({
    groupId: f.group.id,
    learnerId: f.scope.learnerId,
    status: 'active',
    groupActive: true,
  });
  await expect(
    asChild(() =>
      f.sharingService.listLearnerMemberships({
        ...childRequest,
        learnerId: String(f.sibling.id),
      }),
    ),
  ).rejects.toBeInstanceOf(GroupSharingAuthorizationError);
  await expect(
    f.asParent(() =>
      f.sharingService.listLearnerMemberships({
        ...childRequest,
        ...f.parentActor,
      }),
    ),
  ).rejects.toBeInstanceOf(GroupSharingAuthorizationError);
  await expect(
    asChild(() =>
      f.sharingService.getSharingPolicyHistory({ ...f.scope, ...f.childActor }),
    ),
  ).rejects.toBeInstanceOf(GroupSharingAuthorizationError);
  await expect(
    asChild(() =>
      f.sharingService.setSharingPolicy({
        ...f.scope,
        ...f.childActor,
        expectedVersion: 1,
        policy: sharingPolicy,
      }),
    ),
  ).rejects.toBeInstanceOf(GroupSharingAuthorizationError);
  await f.asParent(() => f.sharingService.leaveGroup(f.scope));
  expect(
    await asChild(() => f.sharingService.listLearnerMemberships(childRequest)),
  ).toEqual([]);
  await f.db.update(
    'memberships',
    { tenant_id: second.tenantId, user_id: f.supervisor.actorUserId },
    { status: 'suspended' },
  );
  expect(
    (
      await f.asSupervisor(() => f.sharingService.listMyGroups(f.supervisor))
    ).map((group) => group.id),
  ).toEqual([f.group.id]);
}

export async function assertGroupSharingRosterAvailability(f: Fixture) {
  const invite = await f.invite();
  await f.asParent(() =>
    f.sharingService.acceptInvitation({
      ...f.parentActor,
      invitationId: invite.id,
      policy: sharingPolicy,
    }),
  );
  const other = await groupSharingLifecycleFixture(f.db);
  const otherInvite = await f.asSupervisor(() =>
    f.sharingService.inviteLearner({
      ...other.scope,
      ...f.supervisor,
      groupId: f.group.id,
      invitedParentUserId: other.parentActor.actorUserId,
      expiresAt: new Date(Date.now() + 60_000),
    }),
  );
  const otherSharing = new GroupSharingService(f.db, other.authorize);
  const otherEdge = await other.asParent(() =>
    otherSharing.acceptInvitation({
      ...other.parentActor,
      invitationId: otherInvite.id,
      policy: sharingPolicy,
    }),
  );
  const roster = () =>
    f.asSupervisor(() =>
      f.sharingService.listMemberships({
        ...f.supervisor,
        groupId: f.group.id,
      }),
    );
  const healthyOnly = async () =>
    expect((await roster()).map((row) => row.learnerId)).toEqual([
      f.scope.learnerId,
    ]);
  expect(await roster()).toHaveLength(2);
  await f.db.update(
    'tenants',
    { id: other.scope.familyTenantId },
    { status: 'suspended' },
  );
  await healthyOnly();
  await f.db.update(
    'tenants',
    { id: other.scope.familyTenantId },
    { status: 'active' },
  );
  await f.db.update(
    'users',
    { id: other.learner.userId },
    { status: 'suspended' },
  );
  await healthyOnly();
  await f.db.update(
    'users',
    { id: other.learner.userId },
    { status: 'active' },
  );
  for (const policyJson of [
    '{',
    JSON.stringify({ ...sharingPolicy, shareWork: 'invalid' }),
  ]) {
    await f.db.update(
      'group_sharing_policies',
      { membership_id: otherEdge.id, version: 1 },
      { policy_json: policyJson },
    );
    await healthyOnly();
  }
  await f.db.update(
    'group_sharing_policies',
    { membership_id: otherEdge.id, version: 1 },
    { policy_json: JSON.stringify(sharingPolicy) },
  );
  const hostFailure = new GroupSharingAuthorizationError(
    'host authorization failure must propagate',
  );
  const hostThrows = new GroupSharingService(f.db, async (request) => {
    if (request.familyTenantId === other.scope.familyTenantId)
      throw hostFailure;
    return f.authorize(request);
  });
  await expect(
    f.asSupervisor(() =>
      hostThrows.listMemberships({ ...f.supervisor, groupId: f.group.id }),
    ),
  ).rejects.toBe(hostFailure);
  const databaseFailure = new GroupSharingService(f.db, async (request) => {
    if (request.familyTenantId === other.scope.familyTenantId)
      await request.executor.query(
        'SELECT * FROM group_sharing_missing_infrastructure_table',
      );
    return f.authorize(request);
  });
  await expect(
    f.asSupervisor(() =>
      databaseFailure.listMemberships({ ...f.supervisor, groupId: f.group.id }),
    ),
  ).rejects.toThrow();
  const losesAuthority = new GroupSharingService(f.db, async (request) => {
    if (request.familyTenantId)
      await request.executor.update(
        'memberships',
        { tenant_id: f.group.tenantId, user_id: f.supervisor.actorUserId },
        { status: 'suspended' },
      );
    return f.authorize(request);
  });
  await expect(
    f.asSupervisor(() =>
      losesAuthority.listMemberships({ ...f.supervisor, groupId: f.group.id }),
    ),
  ).rejects.toBeInstanceOf(GroupSharingAuthorizationError);
  expect(await roster()).toHaveLength(2);
}

export async function assertGroupSharingRetainedAvailability(f: Fixture) {
  const firstInvite = await f.invite();
  const first = await f.asParent(() =>
    f.sharingService.acceptInvitation({
      ...f.parentActor,
      invitationId: firstInvite.id,
      policy: sharingPolicy,
    }),
  );
  const second = await f.asSupervisor(() =>
    f.sharingService.createGroup({
      ...f.supervisor,
      name: 'Healthy other group',
    }),
  );
  const secondInvite = await withTenant(
    { tenantId: second.tenantId, userId: f.supervisor.actorUserId },
    () =>
      f.sharingService.inviteLearner({
        ...f.scope,
        ...f.supervisor,
        groupId: second.id,
        invitedParentUserId: f.parentActor.actorUserId,
        expiresAt: new Date(Date.now() + 60_000),
      }),
  );
  await f.asParent(() =>
    f.sharingService.acceptInvitation({
      ...f.parentActor,
      invitationId: secondInvite.id,
      policy: sharingPolicy,
    }),
  );
  const parentGroups = () =>
    f.asParent(() => f.sharingService.listLearnerMemberships(f.scope));
  const childGroups = () =>
    withTenant(
      { tenantId: f.scope.familyTenantId, userId: f.childActor.actorUserId },
      () =>
        f.sharingService.listLearnerMemberships({
          ...f.scope,
          ...f.childActor,
          access: 'child',
        }),
    );
  await f.db.update(
    'tenants',
    { id: f.group.tenantId },
    { status: 'suspended' },
  );
  const retained = await parentGroups();
  expect(retained).toHaveLength(2);
  expect(retained.find((row) => row.groupId === f.group.id)).toMatchObject({
    groupName: f.group.name,
    groupActive: false,
  });
  expect(retained.find((row) => row.groupId === second.id)).toMatchObject({
    groupName: second.name,
    groupActive: true,
  });
  expect((await childGroups()).map((row) => row.groupId)).toEqual([second.id]);
  await f.db.update('tenants', { id: f.group.tenantId }, { status: 'active' });
  await f.db.update(
    'group_sharing_policies',
    { membership_id: first.id, version: 1 },
    { policy_json: '{' },
  );
  expect((await childGroups()).map((row) => row.groupId)).toEqual([second.id]);
  expect(await parentGroups()).toHaveLength(2);
}

export async function assertGroupSharingCapabilityIsolation(f: Fixture) {
  const invitation = await f.invite();
  await f.asParent(() =>
    f.sharingService.acceptInvitation({
      ...f.parentActor,
      invitationId: invitation.id,
      policy: sharingPolicy,
    }),
  );
  const familyMember = await f.db.get('memberships', {
    tenant_id: f.scope.familyTenantId,
    user_id: f.parentActor.actorUserId,
    status: 'active',
  });
  if (!familyMember) throw new Error('Expected family member fixture');
  await f.memberships.create({
    tenantId: f.group.tenantId,
    userId: f.parentActor.actorUserId,
    roleId: String(familyMember.role_id),
    status: MembershipStatus.ACTIVE,
  });
  const metadataOnly = new GroupSharingService(f.db, async (request) => {
    if (
      request.actorUserId === f.parentActor.actorUserId &&
      !request.guardianRelationships
    )
      return request.action === 'education.group.read';
    return f.authorize(request);
  });
  const asMember = <T>(operation: () => Promise<T>) =>
    withTenant(
      { tenantId: f.group.tenantId, userId: f.parentActor.actorUserId },
      operation,
    );
  expect(
    await asMember(() =>
      metadataOnly.getGroup({ ...f.parentActor, groupId: f.group.id }),
    ),
  ).toEqual(f.group);
  expect(
    await asMember(() => metadataOnly.listMyGroups(f.parentActor)),
  ).toEqual([f.group]);
  await expect(
    asMember(() =>
      metadataOnly.listMemberships({ ...f.parentActor, groupId: f.group.id }),
    ),
  ).rejects.toBeInstanceOf(GroupSharingAuthorizationError);
  await expect(
    asMember(() => metadataOnly.getSharedProgress(f.scope)),
  ).rejects.toBeInstanceOf(GroupSharingAuthorizationError);
  await expect(
    asMember(() => metadataOnly.listSharedWork(f.scope)),
  ).rejects.toBeInstanceOf(GroupSharingAuthorizationError);
  // The same actor's separate family guardian proof remains valid; metadata membership is not that proof.
  expect(
    await f.asParent(() => metadataOnly.listLearnerMemberships(f.scope)),
  ).toHaveLength(1);
}
