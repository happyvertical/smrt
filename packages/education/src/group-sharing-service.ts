import { isPostgresDatabase } from '@happyvertical/smrt-core';
import { withTenant } from '@happyvertical/smrt-tenancy';
import { TenantService } from '@happyvertical/smrt-users';
import type { DatabaseInterface } from '@happyvertical/sql';
import {
  type GroupSharingAuthorizer,
  GroupSharingBoundary,
  groupSharingTransaction,
  isGroupSharingScopeDenial,
  lockGroupSharingScope,
} from './group-sharing-authorization.js';
import {
  type AddRevisionCommentRequest,
  GroupSharingCommentService,
  type ListRevisionCommentsRequest,
  type SetCommentChildVisibilityRequest,
} from './group-sharing-comments.js';
import type { GroupSharedWorkSelector } from './group-sharing-contracts.js';
import {
  canonicalGroupSharingPolicy,
  type EducationGroupView,
  type GroupLearnerInvitationView,
  type GroupLearnerMembershipSummaryView,
  type GroupLearnerMembershipView,
  type GroupLearnerParentInvitationView,
  type GroupLearnerRosterView,
  type GroupSharingActor,
  GroupSharingAuthorizationError,
  GroupSharingConflictError,
  type GroupSharingPolicyHistoryView,
  type GroupSharingPolicyV1,
  type GroupSharingScope,
} from './group-sharing-contracts.js';
import { groupSharingDigest } from './group-sharing-hash.js';
import {
  type EducationGroup,
  EducationGroupCollection,
  type GroupLearnerInvitation,
  GroupLearnerInvitationCollection,
  type GroupLearnerMembership,
  GroupLearnerMembershipCollection,
  GroupLearnerRosterEntryCollection,
  GroupSharingPolicyCollection,
} from './group-sharing-models.js';
import { GroupSharingReader } from './group-sharing-reader.js';
import type { SubmissionServiceOptions } from './submission-service.js';

function groupView(row: EducationGroup): EducationGroupView {
  return {
    id: String(row.id),
    tenantId: row.tenantId,
    name: row.name,
    active: row.active,
    creatorUserId: row.creatorUserId,
    creatorProfileId: row.creatorProfileId,
  };
}
function invitationView(
  row: GroupLearnerInvitation,
): GroupLearnerInvitationView {
  return {
    id: String(row.id),
    groupId: row.groupId,
    familyTenantId: row.familyTenantId,
    learnerId: row.learnerId,
    invitedParentUserId: row.invitedParentUserId,
    creatorUserId: row.creatorUserId,
    expiresAt: row.expiresAt.toISOString(),
    status: row.status,
    acceptedMembershipId: row.acceptedMembershipId,
    acceptedPolicyDigest: row.acceptedPolicyDigest,
  };
}
function membershipView(
  row: GroupLearnerMembership,
): GroupLearnerMembershipView {
  return {
    id: String(row.id),
    familyTenantId: row.tenantId,
    groupId: row.groupId,
    learnerId: row.learnerId,
    consentParentUserId: row.consentParentUserId,
    status: row.status,
    policyVersion: row.policyVersion,
  };
}

/** Actor-bound lifecycle; all results are data and carry no family collection handles. */
export class GroupSharingService {
  private state: 'active' | 'draining' | 'closed' | undefined;
  private tail: Promise<void> = Promise.resolve();
  private failure: { error: unknown } | undefined;
  constructor(
    private readonly db: DatabaseInterface,
    private readonly authorize: GroupSharingAuthorizer,
    private readonly options?: SubmissionServiceOptions,
  ) {}
  private get boundary() {
    return new GroupSharingBoundary(this.db, this.authorize);
  }

  async withTransaction<T>(
    operation: (service: GroupSharingService) => Promise<T>,
  ): Promise<T> {
    if (this.state) {
      if (this.state !== 'active')
        throw new Error('Group sharing transaction scope is closed');
      try {
        return await operation(this);
      } catch (error) {
        this.failure ??= { error };
        throw error;
      }
    }
    return groupSharingTransaction(this.db, async (db) => {
      const service = new GroupSharingService(db, this.authorize, this.options);
      service.state = 'active';
      try {
        const result = await operation(service);
        service.state = 'draining';
        await service.tail;
        if (service.failure) throw service.failure.error;
        return result;
      } catch (error) {
        service.failure ??= { error };
        await service.tail;
        throw error;
      } finally {
        service.state = 'closed';
      }
    });
  }

  private run<T>(
    operation: (service: GroupSharingService) => Promise<T>,
  ): Promise<T> {
    if (!this.state)
      return this.withTransaction((service) => service.run(operation));
    if (this.state !== 'active')
      return Promise.reject(
        new Error('Group sharing transaction scope is closed'),
      );
    const task = this.tail.then(async () => {
      if (this.failure) throw this.failure.error;
      try {
        return await operation(this);
      } catch (error) {
        this.failure ??= { error };
        throw error;
      }
    });
    this.tail = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  async createGroup(
    request: GroupSharingActor & { name: string },
  ): Promise<EducationGroupView> {
    return this.run(async (service) => {
      const creator = await service.boundary.requireIdentity(request);
      if (
        typeof request.name !== 'string' ||
        !request.name.trim() ||
        request.name.length > 200
      )
        throw new Error('Group name is required and limited to 200 characters');
      await service.boundary.check(request, 'education.group.create');
      const tenants = new TenantService({ db: service.db });
      await tenants.initialize();
      const { tenant, membership } = await tenants.createTenantWithOwnership(
        request.actorUserId,
        request.name.trim(),
      );
      if (
        !tenant.id ||
        membership.tenantId !== tenant.id ||
        membership.userId !== request.actorUserId ||
        membership.status !== 'active'
      )
        throw new GroupSharingConflictError('Incomplete group provisioning');
      const row = await withTenant(
        { tenantId: String(tenant.id), userId: request.actorUserId },
        async () =>
          (await EducationGroupCollection.create({ db: service.db })).create({
            _insertOnly: true,
            tenantId: String(tenant.id),
            name: request.name.trim(),
            active: true,
            creatorUserId: request.actorUserId,
            creatorProfileId: creator.profileId,
          }),
      );
      await service.boundary.check(request, 'education.group.create');
      return groupView(row);
    });
  }

  async getGroup(
    request: GroupSharingActor & { groupId: string },
  ): Promise<EducationGroupView> {
    return this.run(async (service) =>
      groupView(await service.boundary.requireGroup(request)),
    );
  }

  /** Disable retains consent and history; only current group administrators may reactivate. */
  async updateGroup(
    request: GroupSharingActor & {
      groupId: string;
      name?: string;
      active?: boolean;
    },
  ): Promise<EducationGroupView> {
    return this.run(async (service) => {
      await service.boundary.requireGroup(request, 'education.group.manage');
      if (request.name === undefined && request.active === undefined)
        throw new Error('Group update is empty');
      if (
        request.name !== undefined &&
        (typeof request.name !== 'string' ||
          !request.name.trim() ||
          request.name.length > 200)
      )
        throw new Error('Group name is required and limited to 200 characters');
      if (request.active !== undefined && typeof request.active !== 'boolean')
        throw new Error('Group active must be boolean');
      if (isPostgresDatabase(service.db))
        await service.db.query(
          'SELECT id FROM education_groups WHERE id = ? FOR UPDATE',
          [request.groupId],
        );
      const group = await service.boundary.requireGroup(
        request,
        'education.group.manage',
      );
      if (request.name !== undefined) group.name = request.name.trim();
      if (request.active !== undefined) group.active = request.active;
      await group.save();
      return groupView(group);
    });
  }

  async inviteLearner(
    request: GroupSharingScope & {
      invitedParentUserId: string;
      expiresAt: string | Date;
    },
  ): Promise<GroupLearnerInvitationView> {
    return this.run(async (service) => {
      const group = await service.boundary.requireGroup(
        request,
        'education.group.invite',
      );
      const expiry = new Date(request.expiresAt);
      if (
        !Number.isFinite(expiry.getTime()) ||
        expiry.getTime() <= Date.now() ||
        !request.invitedParentUserId ||
        !request.familyTenantId ||
        !request.learnerId
      )
        throw new Error(
          'Invitation requires exact opaque selectors and a future expiry',
        );
      // Deliberately no family, learner, or parent identity lookup here.
      const row = await (
        await GroupLearnerInvitationCollection.create({ db: service.db })
      ).create({
        tenantId: group.tenantId,
        groupId: String(group.id),
        familyTenantId: request.familyTenantId,
        learnerId: request.learnerId,
        invitedParentUserId: request.invitedParentUserId,
        creatorUserId: request.actorUserId,
        expiresAt: expiry,
        status: 'pending',
      });
      await service.boundary.requireGroup(request, 'education.group.invite');
      return invitationView(row);
    });
  }

  private async invitation(
    request: GroupSharingActor & { invitationId: string },
    allowInactiveGroup = false,
  ) {
    await this.boundary.requireIdentity(request);
    // This exact identifier retrieves only group-owned submitted selectors.
    const raw = await this.db.get('group_learner_invitations', {
      id: request.invitationId,
    });
    if (!raw) throw new GroupSharingAuthorizationError();
    const group = await this.boundary.loadGroup(
      String(raw.group_id),
      allowInactiveGroup,
    );
    const row = await withTenant(
      { tenantId: group.tenantId, userId: request.actorUserId },
      async () =>
        (await GroupLearnerInvitationCollection.create({ db: this.db })).get(
          {
            id: request.invitationId,
            tenantId: group.tenantId,
            groupId: String(group.id),
          },
          { cache: false },
        ),
    );
    if (
      !row ||
      !['pending', 'accepted', 'revoked', 'declined'].includes(row.status) ||
      !(row.expiresAt instanceof Date) ||
      !Number.isFinite(row.expiresAt.getTime())
    )
      throw new GroupSharingAuthorizationError();
    return {
      row,
      group,
      scope: {
        actorUserId: request.actorUserId,
        sessionId: request.sessionId,
        groupId: String(group.id),
        familyTenantId: row.familyTenantId,
        learnerId: row.learnerId,
      },
    };
  }

  getInvitation(
    request: GroupSharingActor & { invitationId: string; access: 'parent' },
  ): Promise<GroupLearnerParentInvitationView>;
  getInvitation(
    request: GroupSharingActor & { invitationId: string; access: 'staff' },
  ): Promise<GroupLearnerInvitationView>;
  getInvitation(
    request: GroupSharingActor & {
      invitationId: string;
      access: 'parent' | 'staff';
    },
  ): Promise<GroupLearnerParentInvitationView | GroupLearnerInvitationView>;
  async getInvitation(
    request: GroupSharingActor & {
      invitationId: string;
      access: 'parent' | 'staff';
    },
  ): Promise<GroupLearnerParentInvitationView | GroupLearnerInvitationView> {
    return this.run(async (service) => {
      if (request.access !== 'parent' && request.access !== 'staff')
        throw new GroupSharingAuthorizationError();
      const { row, group, scope } = await service.invitation(
        request,
        request.access === 'parent',
      );
      if (request.access === 'staff') {
        await service.boundary.requireGroup(
          { ...request, groupId: scope.groupId },
          'education.group.invite',
        );
        return invitationView(row);
      }
      if (row.invitedParentUserId !== request.actorUserId)
        throw new GroupSharingAuthorizationError();
      const learner = await service.boundary.requireGuardian(scope);
      const result = {
        ...invitationView(row),
        groupName: group.name,
        learnerDisplayName: learner.displayName,
      };
      await service.boundary.requireGuardian(scope);
      return result;
    });
  }

  async listInvitations(
    request: GroupSharingActor & { groupId: string },
  ): Promise<ReadonlyArray<GroupLearnerInvitationView>> {
    return this.run(async (service) => {
      const group = await service.boundary.requireGroup(
        request,
        'education.group.invite',
      );
      const rows = await (
        await GroupLearnerInvitationCollection.create({ db: service.db })
      ).list({
        where: { tenantId: group.tenantId, groupId: request.groupId },
        orderBy: ['createdAt ASC', 'id ASC'],
        limit: 1000,
      });
      const result = rows.map((row) => {
        if (
          !['pending', 'accepted', 'revoked', 'declined'].includes(
            row.status,
          ) ||
          !(row.expiresAt instanceof Date) ||
          !Number.isFinite(row.expiresAt.getTime())
        )
          throw new GroupSharingAuthorizationError();
        return invitationView(row);
      });
      await service.boundary.requireGroup(request, 'education.group.invite');
      return result;
    });
  }

  private async lockInvitation(id: string): Promise<void> {
    if (isPostgresDatabase(this.db))
      await this.db.query(
        'SELECT id FROM group_learner_invitations WHERE id = ? FOR UPDATE',
        [id],
      );
  }

  async acceptInvitation(
    request: GroupSharingActor & {
      invitationId: string;
      policy: GroupSharingPolicyV1;
    },
  ): Promise<GroupLearnerMembershipView> {
    return this.run(async (service) => {
      const canonical = canonicalGroupSharingPolicy(request.policy);
      const digest = groupSharingDigest(canonical);
      const selected = await service.invitation(request);
      if (selected.row.invitedParentUserId !== request.actorUserId)
        throw new GroupSharingAuthorizationError();
      await service.boundary.requireGuardian(selected.scope);
      await lockGroupSharingScope(service.db, selected.scope);
      await service.lockInvitation(request.invitationId);
      const { row, scope } = await service.invitation(request);
      await service.boundary.requireGuardian(scope);
      if (row.invitedParentUserId !== request.actorUserId)
        throw new GroupSharingAuthorizationError();
      return withTenant(
        { tenantId: scope.familyTenantId, userId: request.actorUserId },
        async () => {
          const members = await GroupLearnerMembershipCollection.create({
            db: service.db,
          });
          let edge = await members.get(
            {
              tenantId: scope.familyTenantId,
              learnerId: scope.learnerId,
              groupId: scope.groupId,
            },
            { cache: false },
          );
          if (edge) membershipView(edge);
          if (row.status === 'accepted') {
            if (
              edge?.status !== 'active' ||
              row.acceptedMembershipId !== edge.id ||
              row.acceptedPolicyDigest !== digest
            )
              throw new GroupSharingConflictError(
                'Accepted invitation cannot change consent or reactivate membership',
              );
            await service.boundary.requireScope(
              scope,
              'education.group.share',
              'guardian',
            );
            return membershipView(edge);
          }
          if (row.status !== 'pending' || row.expiresAt.getTime() <= Date.now())
            throw new GroupSharingConflictError(
              'Invitation is no longer pending',
            );
          if (edge?.status === 'active')
            throw new GroupSharingConflictError(
              'Learner already participates in this group',
            );
          if (!edge)
            edge = await members.create({
              _insertOnly: true,
              tenantId: scope.familyTenantId,
              learnerId: scope.learnerId,
              groupId: scope.groupId,
              consentParentUserId: request.actorUserId,
              status: 'active',
              policyVersion: 1,
            });
          else {
            edge.status = 'active';
            edge.consentParentUserId = request.actorUserId;
            edge.policyVersion += 1;
            await edge.save();
          }
          await (
            await GroupSharingPolicyCollection.create({ db: service.db })
          ).create({
            _insertOnly: true,
            tenantId: scope.familyTenantId,
            membershipId: String(edge.id),
            version: edge.policyVersion,
            schemaVersion: 1,
            policyJson: canonical,
            actorUserId: request.actorUserId,
            recordedAt: new Date(),
          });
          const roster = await withTenant(
            { tenantId: row.tenantId, userId: request.actorUserId },
            async () => {
              const entries = await GroupLearnerRosterEntryCollection.create({
                db: service.db,
              });
              const existing = await entries.get(
                {
                  tenantId: row.tenantId,
                  groupId: scope.groupId,
                  membershipId: String(edge.id),
                },
                { cache: false },
              );
              return (
                existing ??
                entries.create({
                  _insertOnly: true,
                  tenantId: row.tenantId,
                  groupId: scope.groupId,
                  familyTenantId: scope.familyTenantId,
                  learnerId: scope.learnerId,
                  membershipId: String(edge.id),
                })
              );
            },
          );
          if (
            roster.familyTenantId !== scope.familyTenantId ||
            roster.learnerId !== scope.learnerId
          )
            throw new GroupSharingConflictError();
          // Recheck host authority and expiration immediately before the guarded terminal write.
          await service.boundary.requireGuardian(scope);
          await service.boundary.loadGroup(scope.groupId);
          if (row.expiresAt.getTime() <= Date.now())
            throw new GroupSharingConflictError(
              'Invitation expired during acceptance',
            );
          row.status = 'accepted';
          row.acceptedMembershipId = String(edge.id);
          row.acceptedPolicyDigest = digest;
          await withTenant(
            { tenantId: row.tenantId, userId: request.actorUserId },
            () => row.save(),
          );
          return membershipView(edge);
        },
      );
    });
  }

  async revokeInvitation(
    request: GroupSharingActor & { invitationId: string },
  ): Promise<GroupLearnerInvitationView> {
    return this.run(async (service) => {
      const selected = await service.invitation(request);
      await service.boundary.requireGroup(
        { ...request, groupId: selected.scope.groupId },
        'education.group.invite',
      );
      await lockGroupSharingScope(service.db, selected.scope);
      await service.lockInvitation(request.invitationId);
      const { row } = await service.invitation(request);
      if (row.status !== 'pending' && row.status !== 'revoked')
        throw new GroupSharingConflictError();
      await service.boundary.requireGroup(
        { ...request, groupId: selected.scope.groupId },
        'education.group.invite',
      );
      row.status = 'revoked';
      await withTenant(
        { tenantId: row.tenantId, userId: request.actorUserId },
        () => row.save(),
      );
      return invitationView(row);
    });
  }

  async declineInvitation(
    request: GroupSharingActor & { invitationId: string },
  ): Promise<GroupLearnerInvitationView> {
    return this.run(async (service) => {
      const selected = await service.invitation(request);
      if (selected.row.invitedParentUserId !== request.actorUserId)
        throw new GroupSharingAuthorizationError();
      // Declining requires identity, never a family-data lookup or guardian disclosure.
      await service.boundary.check(selected.scope, 'education.group.share');
      await lockGroupSharingScope(service.db, selected.scope);
      await service.lockInvitation(request.invitationId);
      const { row } = await service.invitation(request);
      if (row.status !== 'pending' && row.status !== 'declined')
        throw new GroupSharingConflictError();
      await service.boundary.check(selected.scope, 'education.group.share');
      row.status = 'declined';
      await withTenant(
        { tenantId: row.tenantId, userId: request.actorUserId },
        () => row.save(),
      );
      return invitationView(row);
    });
  }

  async setSharingPolicy(
    request: GroupSharingScope & {
      policy: GroupSharingPolicyV1;
      expectedVersion: number;
    },
  ): Promise<GroupLearnerMembershipView> {
    return this.run(async (service) => {
      const canonical = canonicalGroupSharingPolicy(request.policy);
      await service.boundary.requireGuardian(request);
      await lockGroupSharingScope(service.db, request);
      const { membership } = await service.boundary.requireScope(
        request,
        'education.group.share',
        'guardian',
      );
      if (membership.policyVersion !== request.expectedVersion)
        throw new GroupSharingConflictError('Stale sharing policy version');
      return withTenant(
        { tenantId: request.familyTenantId, userId: request.actorUserId },
        async () => {
          await (
            await GroupSharingPolicyCollection.create({ db: service.db })
          ).create({
            _insertOnly: true,
            tenantId: request.familyTenantId,
            membershipId: String(membership.id),
            version: membership.policyVersion + 1,
            schemaVersion: 1,
            policyJson: canonical,
            actorUserId: request.actorUserId,
            recordedAt: new Date(),
          });
          await service.boundary.requireGuardian(request);
          membership.policyVersion += 1;
          await membership.save();
          return membershipView(membership);
        },
      );
    });
  }

  async revokeMembership(
    request: GroupSharingScope,
  ): Promise<GroupLearnerMembershipView> {
    return this.endMembership(request, false);
  }
  async leaveGroup(
    request: GroupSharingScope,
  ): Promise<GroupLearnerMembershipView> {
    return this.endMembership(request, false);
  }
  async removeLearner(
    request: GroupSharingScope,
  ): Promise<GroupLearnerMembershipView> {
    return this.endMembership(request, true);
  }
  private async endMembership(
    request: GroupSharingScope,
    supervisor: boolean,
  ): Promise<GroupLearnerMembershipView> {
    return this.run(async (service) => {
      if (supervisor)
        await service.boundary.requireGroup(request, 'education.group.manage');
      else await service.boundary.requireGuardian(request);
      await lockGroupSharingScope(service.db, request);
      return withTenant(
        { tenantId: request.familyTenantId, userId: request.actorUserId },
        async () => {
          const row = await (
            await GroupLearnerMembershipCollection.create({ db: service.db })
          ).get(
            {
              tenantId: request.familyTenantId,
              learnerId: request.learnerId,
              groupId: request.groupId,
            },
            { cache: false },
          );
          if (!row) throw new GroupSharingAuthorizationError();
          membershipView(row);
          if (supervisor)
            await withTenant(
              {
                tenantId: (await service.boundary.loadGroup(request.groupId))
                  .tenantId,
                userId: request.actorUserId,
              },
              () =>
                service.boundary.requireGroup(
                  request,
                  'education.group.manage',
                ),
            );
          else await service.boundary.requireGuardian(request);
          row.status = 'revoked';
          await row.save();
          return membershipView(row);
        },
      );
    });
  }

  async listMyGroups(
    request: GroupSharingActor,
  ): Promise<ReadonlyArray<EducationGroupView>> {
    return this.run(async (service) => {
      await service.boundary.requireIdentity(request);
      const memberships = await service.db.list('memberships', {
        user_id: request.actorUserId,
        status: 'active',
      });
      const groups: EducationGroupView[] = [];
      for (const membership of memberships) {
        const row = await service.db.get('education_groups', {
          tenant_id: membership.tenant_id,
        });
        if (!row) continue;
        const group = await service.boundary.discoverGroup({
          ...request,
          groupId: String(row.id),
        });
        if (group) groups.push(groupView(group));
      }
      await service.boundary.requireIdentity(request);
      return groups.sort((left, right) => left.id.localeCompare(right.id));
    });
  }

  /** Exact retained edge metadata is family-authorized, independent of group tenant availability. */
  private async retainedGroupSummary(
    groupId: string,
  ): Promise<{ groupName: string; groupActive: boolean }> {
    const raw = await this.db.get('education_groups', { id: groupId });
    if (!raw) throw new GroupSharingAuthorizationError();
    const group = await withTenant(
      { tenantId: String(raw.tenant_id) },
      async () =>
        (await EducationGroupCollection.create({ db: this.db })).get(
          { id: groupId, tenantId: String(raw.tenant_id) },
          { cache: false },
        ),
    );
    if (!group || typeof group.active !== 'boolean')
      throw new GroupSharingAuthorizationError();
    const tenant = await this.db.get('tenants', {
      id: group.tenantId,
      status: 'active',
    });
    return { groupName: group.name, groupActive: group.active && !!tenant };
  }

  async listMemberships(
    request: GroupSharingActor & { groupId: string },
  ): Promise<ReadonlyArray<GroupLearnerRosterView>> {
    return this.run(async (service) => {
      const group = await service.boundary.requireGroup(
        request,
        'education.group.review',
      );
      const roster = await (
        await GroupLearnerRosterEntryCollection.create({ db: service.db })
      ).list({
        where: { tenantId: group.tenantId, groupId: String(group.id) },
        limit: 1000,
      });
      const result: GroupLearnerRosterView[] = [];
      for (const entry of roster) {
        const scope = {
          ...request,
          familyTenantId: entry.familyTenantId,
          learnerId: entry.learnerId,
        };
        try {
          const edge = await withTenant(
            { tenantId: entry.familyTenantId, userId: request.actorUserId },
            async () =>
              (
                await GroupLearnerMembershipCollection.create({
                  db: service.db,
                })
              ).get(
                {
                  id: entry.membershipId,
                  tenantId: entry.familyTenantId,
                  groupId: request.groupId,
                  learnerId: entry.learnerId,
                },
                { cache: false },
              ),
          );
          if (edge?.status !== 'active') continue;
          const authorized = await service.boundary.requireScope(
            scope,
            'education.group.review',
          );
          if (String(authorized.membership.id) !== entry.membershipId)
            throw new GroupSharingAuthorizationError();
          result.push({
            ...membershipView(authorized.membership),
            learnerDisplayName: authorized.learner.displayName,
          });
        } catch (error) {
          if (!isGroupSharingScopeDenial(error)) throw error;
        }
      }
      await service.boundary.requireGroup(request, 'education.group.review');
      return result;
    });
  }

  async listLearnerMemberships(
    request: Omit<GroupSharingScope, 'groupId'> & {
      access?: 'guardian' | 'child';
    },
  ): Promise<ReadonlyArray<GroupLearnerMembershipSummaryView>> {
    return this.run(async (service) => {
      if (
        request.access !== undefined &&
        request.access !== 'guardian' &&
        request.access !== 'child'
      )
        throw new GroupSharingAuthorizationError();
      const child = request.access === 'child';
      if (child) await service.boundary.requireOwnLearner(request);
      else await service.boundary.requireGuardian({ ...request, groupId: '' });
      const rows = await (
        await GroupLearnerMembershipCollection.create({ db: service.db })
      ).list({
        where: {
          tenantId: request.familyTenantId,
          learnerId: request.learnerId,
          ...(child ? { status: 'active' } : {}),
        },
        limit: 1000,
      });
      const result: GroupLearnerMembershipSummaryView[] = [];
      for (const row of rows) {
        if (!child) {
          result.push({
            ...membershipView(row),
            ...(await service.retainedGroupSummary(row.groupId)),
          });
          continue;
        }
        try {
          await lockGroupSharingScope(service.db, {
            ...request,
            groupId: row.groupId,
          });
          const current = await service.boundary.requireScope(
            { ...request, groupId: row.groupId },
            'education.group.child-comments',
            'child',
          );
          if (String(current.membership.id) !== row.id)
            throw new GroupSharingAuthorizationError();
          result.push({
            ...membershipView(current.membership),
            groupName: current.group.name,
            groupActive: true,
          });
        } catch (error) {
          if (!isGroupSharingScopeDenial(error)) throw error;
        }
      }

      if (child) await service.boundary.requireOwnLearner(request);
      else await service.boundary.requireGuardian({ ...request, groupId: '' });
      return result;
    });
  }
  async getSharingPolicyHistory(
    request: GroupSharingScope & { afterVersion?: number; limit?: number },
  ): Promise<GroupSharingPolicyHistoryView> {
    return this.run(async (service) => {
      const afterVersion = request.afterVersion ?? 0;
      const limit = request.limit ?? 50;
      if (
        !Number.isSafeInteger(afterVersion) ||
        afterVersion < 0 ||
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > 100
      )
        throw new Error('Invalid policy history pagination');
      await service.boundary.requireGuardian(request);
      await lockGroupSharingScope(service.db, request);
      const edge = await (
        await GroupLearnerMembershipCollection.create({ db: service.db })
      ).get(
        {
          tenantId: request.familyTenantId,
          learnerId: request.learnerId,
          groupId: request.groupId,
        },
        { cache: false },
      );
      if (!edge) throw new GroupSharingAuthorizationError();
      membershipView(edge);
      const rows = await (
        await GroupSharingPolicyCollection.create({ db: service.db })
      ).list({
        where: {
          tenantId: request.familyTenantId,
          membershipId: String(edge.id),
          'version >': afterVersion,
        },
        orderBy: 'version ASC',
        limit: limit + 1,
      });
      const policies = rows.slice(0, limit).map((row) => {
        if (
          !Number.isSafeInteger(row.version) ||
          row.version < 1 ||
          row.version > edge.policyVersion ||
          row.schemaVersion !== 1 ||
          !(row.recordedAt instanceof Date) ||
          !Number.isFinite(row.recordedAt.getTime())
        )
          throw new GroupSharingAuthorizationError();
        return {
          id: String(row.id),
          membershipId: String(edge.id),
          familyTenantId: request.familyTenantId,
          version: row.version,
          schemaVersion: 1 as const,
          policy: row.getPolicy(),
          actorUserId: row.actorUserId,
          recordedAt: row.recordedAt.toISOString(),
        };
      });
      await service.boundary.requireGuardian(request);
      return {
        policies,
        nextAfterVersion:
          rows.length > limit ? policies[policies.length - 1].version : null,
      };
    });
  }

  getSharingPolicyOptions(request: Omit<GroupSharingScope, 'groupId'>) {
    return this.run((service) =>
      new GroupSharingReader(
        service.db,
        service.authorize,
        service.options,
        true,
      ).getSharingPolicyOptions(request),
    );
  }

  previewSharing(
    request: GroupSharingScope & { policy?: GroupSharingPolicyV1 },
  ) {
    return this.run((service) =>
      new GroupSharingReader(
        service.db,
        service.authorize,
        service.options,
        true,
      ).previewSharing(request),
    );
  }
  listSharedWork(
    request: GroupSharingScope & { cursor?: string; limit?: number },
  ) {
    return this.run((service) =>
      new GroupSharingReader(
        service.db,
        service.authorize,
        service.options,
        true,
      ).listSharedWork(request),
    );
  }
  getSharedWork(request: GroupSharedWorkSelector) {
    return this.run((service) =>
      new GroupSharingReader(
        service.db,
        service.authorize,
        service.options,
        true,
      ).getSharedWork(request),
    );
  }
  getSharedRevision(request: GroupSharedWorkSelector) {
    return this.run((service) =>
      new GroupSharingReader(
        service.db,
        service.authorize,
        service.options,
        true,
      ).getSharedRevision(request),
    );
  }
  getSharedProgress(request: GroupSharingScope) {
    return this.run((service) =>
      new GroupSharingReader(
        service.db,
        service.authorize,
        service.options,
        true,
      ).getSharedProgress(request),
    );
  }
  readSharedMedia(request: GroupSharedWorkSelector & { assetId: string }) {
    return this.run((service) =>
      new GroupSharingReader(
        service.db,
        service.authorize,
        service.options,
        true,
      ).readSharedMedia(request),
    );
  }
  addRevisionComment(request: AddRevisionCommentRequest) {
    return this.run((service) =>
      new GroupSharingCommentService(
        service.db,
        service.authorize,
        true,
      ).addRevisionComment(request),
    );
  }
  listRevisionComments(request: ListRevisionCommentsRequest) {
    return this.run((service) =>
      new GroupSharingCommentService(
        service.db,
        service.authorize,
        true,
      ).listRevisionComments(request),
    );
  }
  setCommentChildVisibility(request: SetCommentChildVisibilityRequest) {
    return this.run((service) =>
      new GroupSharingCommentService(
        service.db,
        service.authorize,
        true,
      ).setCommentChildVisibility(request),
    );
  }
}
