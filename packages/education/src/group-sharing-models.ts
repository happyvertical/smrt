import {
  crossPackageRef,
  field,
  foreignKey,
  SmrtCollection,
  SmrtObject,
  type SmrtSaveOptions,
  smrt,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import {
  canonicalGroupSharingPolicy,
  type GroupLearnerInvitationStatus,
  type GroupLearnerMembershipStatus,
  type GroupSharingPolicyV1,
  validateGroupSharingPolicy,
} from './group-sharing-contracts.js';

const closed = {
  api: false,
  mcp: false,
  cli: false,
  ai: { callable: [] as string[] },
} as const;
function applyOptions(target: object, options: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(options))
    if (Object.hasOwn(target, key))
      (target as Record<string, unknown>)[key] = value;
}
function required(...values: unknown[]): void {
  if (values.some((v) => typeof v !== 'string' || !v.trim()))
    throw new Error('Group sharing requires exact identity');
}
function positive(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error('Invalid group sharing version');
}
function date(value: Date): void {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime()))
    throw new Error('Invalid group sharing timestamp');
}
async function immutable(
  object: SmrtObject & { tenantId: string },
  identity: Record<string, unknown>,
  appendOnly = false,
): Promise<void> {
  required(object.tenantId);
  if (!object.id) return;
  const row = await object.db.get(object.tableName, { id: object.id });
  if (
    row &&
    (appendOnly ||
      !(await object.db.get(object.tableName, {
        id: object.id,
        tenant_id: object.tenantId,
        ...identity,
      })))
  )
    throw new Error('Group sharing identity is immutable');
}
async function parent(
  object: SmrtObject,
  table: string,
  where: Record<string, unknown>,
): Promise<void> {
  if (!(await object.db.get(table, where)))
    throw new Error('Group sharing parent ownership mismatch');
}

/** Independent group tenant metadata; no family authority is implied. */
@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'education_groups',
  conflictColumns: ['tenant_id'],
  ...closed,
})
export class EducationGroup extends SmrtObject {
  @tenantId() tenantId = '';
  name = '';
  active = true;
  @crossPackageRef('@happyvertical/smrt-users:User', { required: true })
  creatorUserId = '';
  @crossPackageRef('@happyvertical/smrt-profiles:Profile', { required: true })
  creatorProfileId = '';
  constructor(options: Record<string, unknown> = {}) {
    super(options);
    applyOptions(this, options);
  }
  override async save(options: SmrtSaveOptions = {}): Promise<this> {
    required(this.name, this.creatorUserId, this.creatorProfileId);
    await immutable(this, {
      creator_user_id: this.creatorUserId,
      creator_profile_id: this.creatorProfileId,
    });
    if (typeof this.active !== 'boolean')
      throw new Error('Invalid group state');
    return super.save(options);
  }
  override async delete(): Promise<void> {
    throw new Error(
      'Group sharing records require an owning retention operation',
    );
  }
}
export class EducationGroupCollection extends SmrtCollection<EducationGroup> {
  static readonly _itemClass = EducationGroup;
}

/** Group-owned target selectors are opaque until the exact parent accepts. */
@TenantScoped({ mode: 'required' })
@smrt({ tableName: 'group_learner_invitations', ...closed })
export class GroupLearnerInvitation extends SmrtObject {
  @tenantId() tenantId = '';
  @foreignKey('EducationGroup', { required: true, onDelete: 'RESTRICT' })
  groupId = '';
  @crossPackageRef('@happyvertical/smrt-users:Tenant', { required: true })
  familyTenantId = '';
  // Deliberately opaque: no FK/existence check may reveal another family's learner.
  @field({ type: 'text', sqlType: 'UUID', required: true }) learnerId = '';
  @crossPackageRef('@happyvertical/smrt-users:User', { required: true })
  invitedParentUserId = '';
  @crossPackageRef('@happyvertical/smrt-users:User', { required: true })
  creatorUserId = '';
  expiresAt = new Date(0);
  status: GroupLearnerInvitationStatus = 'pending';
  @foreignKey('GroupLearnerMembership', {
    nullable: true,
    onDelete: 'RESTRICT',
  })
  acceptedMembershipId: string | null = null;
  acceptedPolicyDigest = '';
  constructor(options: Record<string, unknown> = {}) {
    super(options);
    applyOptions(this, options);
  }
  override async save(options: SmrtSaveOptions = {}): Promise<this> {
    required(
      this.groupId,
      this.familyTenantId,
      this.learnerId,
      this.invitedParentUserId,
      this.creatorUserId,
    );
    date(this.expiresAt);
    if (
      this.expiresAt.getTime() <= 0 ||
      !['pending', 'accepted', 'revoked', 'declined'].includes(this.status)
    )
      throw new Error('Invalid invitation state');
    await immutable(this, {
      group_id: this.groupId,
      family_tenant_id: this.familyTenantId,
      learner_id: this.learnerId,
      invited_parent_user_id: this.invitedParentUserId,
      creator_user_id: this.creatorUserId,
      expires_at: this.expiresAt,
    });
    await parent(this, 'education_groups', {
      id: this.groupId,
      tenant_id: this.tenantId,
    });
    const stored = this.id
      ? await this.db.get(this.tableName, {
          id: this.id,
          tenant_id: this.tenantId,
        })
      : null;
    if (
      stored &&
      stored.status !== 'pending' &&
      (stored.status !== this.status ||
        stored.accepted_membership_id !== this.acceptedMembershipId ||
        stored.accepted_policy_digest !== this.acceptedPolicyDigest)
    )
      throw new Error('Invitation is terminal');
    if (this.status === 'accepted') {
      if (
        !this.acceptedMembershipId ||
        !/^[a-f0-9]{64}$/.test(this.acceptedPolicyDigest)
      )
        throw new Error('Invalid accepted invitation');
      await parent(this, 'group_learner_memberships', {
        id: this.acceptedMembershipId,
        tenant_id: this.familyTenantId,
        learner_id: this.learnerId,
        group_id: this.groupId,
      });
    } else if (
      this.acceptedMembershipId !== null ||
      this.acceptedPolicyDigest !== ''
    )
      throw new Error('Unaccepted invitation cannot bind membership');
    return super.save(options);
  }
  override async delete(): Promise<void> {
    throw new Error('Invitation history is retained');
  }
}
export class GroupLearnerInvitationCollection extends SmrtCollection<GroupLearnerInvitation> {
  static readonly _itemClass = GroupLearnerInvitation;
}

/** Family-owned per-child consent edge, never a users membership. */
@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'group_learner_memberships',
  conflictColumns: ['tenant_id', 'learner_id', 'group_id'],
  ...closed,
})
export class GroupLearnerMembership extends SmrtObject {
  @tenantId() tenantId = '';
  @foreignKey('EducationGroup', { required: true, onDelete: 'RESTRICT' })
  groupId = '';
  @foreignKey('Learner', { required: true, onDelete: 'RESTRICT' }) learnerId =
    '';
  @crossPackageRef('@happyvertical/smrt-users:User', { required: true })
  consentParentUserId = '';
  status: GroupLearnerMembershipStatus = 'active';
  @field({ min: 1, required: true }) policyVersion = 1;
  constructor(options: Record<string, unknown> = {}) {
    super(options);
    applyOptions(this, options);
  }
  override async save(options: SmrtSaveOptions = {}): Promise<this> {
    required(this.groupId, this.learnerId, this.consentParentUserId);
    positive(this.policyVersion);
    if (!['active', 'revoked'].includes(this.status))
      throw new Error('Invalid membership state');
    await immutable(this, {
      group_id: this.groupId,
      learner_id: this.learnerId,
    });
    await parent(this, 'learners', {
      id: this.learnerId,
      tenant_id: this.tenantId,
    });
    await parent(this, 'education_groups', { id: this.groupId });
    return super.save(options);
  }
  override async delete(): Promise<void> {
    throw new Error('Membership consent history is retained');
  }
}
export class GroupLearnerMembershipCollection extends SmrtCollection<GroupLearnerMembership> {
  static readonly _itemClass = GroupLearnerMembership;
}

/** Immutable explicit policy snapshot. */
@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'group_sharing_policies',
  conflictColumns: ['tenant_id', 'membership_id', 'version'],
  ...closed,
})
export class GroupSharingPolicy extends SmrtObject {
  @tenantId() tenantId = '';
  @foreignKey('GroupLearnerMembership', {
    required: true,
    onDelete: 'RESTRICT',
  })
  membershipId = '';
  @field({ min: 1, required: true }) version = 1;
  @field({ min: 1, max: 1, required: true }) schemaVersion = 1;
  @field({ type: 'text', required: true }) policyJson = '{}';
  @crossPackageRef('@happyvertical/smrt-users:User', { required: true })
  actorUserId = '';
  recordedAt = new Date();
  constructor(options: Record<string, unknown> = {}) {
    super(options);
    applyOptions(this, options);
  }
  getPolicy(): GroupSharingPolicyV1 {
    const value: unknown = JSON.parse(this.policyJson);
    validateGroupSharingPolicy(value);
    return value;
  }
  setPolicy(value: unknown): void {
    this.policyJson = canonicalGroupSharingPolicy(value);
  }
  override async save(options: SmrtSaveOptions = {}): Promise<this> {
    required(this.membershipId, this.actorUserId);
    positive(this.version);
    date(this.recordedAt);
    if (this.schemaVersion !== 1)
      throw new Error('Unsupported sharing policy schema');
    this.setPolicy(this.getPolicy());
    await immutable(this, {}, true);
    await parent(this, 'group_learner_memberships', {
      id: this.membershipId,
      tenant_id: this.tenantId,
    });
    return super.save(options);
  }
  override async delete(): Promise<void> {
    throw new Error('Policy snapshots are immutable');
  }
}
export class GroupSharingPolicyCollection extends SmrtCollection<GroupSharingPolicy> {
  static readonly _itemClass = GroupSharingPolicy;
}

/** Attributed revision comment, separate from grading and evidence. */
@TenantScoped({ mode: 'required' })
@smrt({ tableName: 'group_revision_comments', ...closed })
export class GroupRevisionComment extends SmrtObject {
  @tenantId() tenantId = '';
  @foreignKey('GroupLearnerMembership', {
    required: true,
    onDelete: 'RESTRICT',
  })
  membershipId = '';
  @foreignKey('Learner', { required: true, onDelete: 'RESTRICT' }) learnerId =
    '';
  @foreignKey('WorkbookActivity', { required: true, onDelete: 'RESTRICT' })
  activityId = '';
  @foreignKey('WorkbookAttempt', { required: true, onDelete: 'RESTRICT' })
  attemptId = '';
  @foreignKey('WorkbookAssessmentRevision', {
    required: true,
    onDelete: 'RESTRICT',
  })
  revisionId = '';
  @crossPackageRef('@happyvertical/smrt-users:User', { required: true })
  authorUserId = '';
  @crossPackageRef('@happyvertical/smrt-profiles:Profile', { required: true })
  authorProfileId = '';
  body = '';
  recordedAt = new Date();
  childVisible = false;
  @crossPackageRef('@happyvertical/smrt-users:User', { nullable: true })
  visibilityActorUserId: string | null = null;
  visibilityChangedAt: Date | null = null;
  @field({ min: 0, required: true }) visibilityVersion = 0;
  constructor(options: Record<string, unknown> = {}) {
    super(options);
    applyOptions(this, options);
  }
  override async save(options: SmrtSaveOptions = {}): Promise<this> {
    required(
      this.membershipId,
      this.learnerId,
      this.activityId,
      this.attemptId,
      this.revisionId,
      this.authorUserId,
      this.authorProfileId,
      this.body,
    );
    date(this.recordedAt);
    if (
      this.body.length > 10000 ||
      typeof this.childVisible !== 'boolean' ||
      !Number.isSafeInteger(this.visibilityVersion) ||
      this.visibilityVersion < 0
    )
      throw new Error('Invalid comment');
    if (
      this.visibilityVersion === 0
        ? this.childVisible ||
          this.visibilityActorUserId !== null ||
          this.visibilityChangedAt !== null
        : !this.visibilityActorUserId || !this.visibilityChangedAt
    )
      throw new Error('Invalid comment visibility attribution');
    if (this.visibilityChangedAt) date(this.visibilityChangedAt);
    await immutable(this, {
      membership_id: this.membershipId,
      learner_id: this.learnerId,
      activity_id: this.activityId,
      attempt_id: this.attemptId,
      revision_id: this.revisionId,
      author_user_id: this.authorUserId,
      author_profile_id: this.authorProfileId,
      body: this.body,
      recorded_at: this.recordedAt,
    });
    const owner = { tenant_id: this.tenantId, learner_id: this.learnerId };
    await parent(this, 'group_learner_memberships', {
      ...owner,
      id: this.membershipId,
    });
    await parent(this, 'workbook_activities', {
      ...owner,
      id: this.activityId,
    });
    await parent(this, 'workbook_attempts', {
      ...owner,
      id: this.attemptId,
      activity_id: this.activityId,
    });
    await parent(this, 'workbook_assessment_revisions', {
      ...owner,
      id: this.revisionId,
      attempt_id: this.attemptId,
    });
    return super.save(options);
  }
  override async delete(): Promise<void> {
    throw new Error('Comment attribution is retained');
  }
}
export class GroupRevisionCommentCollection extends SmrtCollection<GroupRevisionComment> {
  static readonly _itemClass = GroupRevisionComment;
}

/** Group-owned opaque roster index; authoritative consent remains family-owned. */
@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'group_learner_roster_entries',
  conflictColumns: ['tenant_id', 'group_id', 'membership_id'],
  ...closed,
})
export class GroupLearnerRosterEntry extends SmrtObject {
  @tenantId() tenantId = '';
  @foreignKey('EducationGroup', { required: true, onDelete: 'RESTRICT' })
  groupId = '';
  @crossPackageRef('@happyvertical/smrt-users:Tenant', { required: true })
  familyTenantId = '';
  @field({ type: 'text', sqlType: 'UUID', required: true }) learnerId = '';
  @foreignKey('GroupLearnerMembership', {
    required: true,
    onDelete: 'RESTRICT',
  })
  membershipId = '';
  constructor(options: Record<string, unknown> = {}) {
    super(options);
    applyOptions(this, options);
  }
  override async save(options: SmrtSaveOptions = {}): Promise<this> {
    required(
      this.groupId,
      this.familyTenantId,
      this.learnerId,
      this.membershipId,
    );
    await immutable(
      this,
      {
        group_id: this.groupId,
        family_tenant_id: this.familyTenantId,
        learner_id: this.learnerId,
        membership_id: this.membershipId,
      },
      true,
    );
    await parent(this, 'education_groups', {
      id: this.groupId,
      tenant_id: this.tenantId,
    });
    await parent(this, 'group_learner_memberships', {
      id: this.membershipId,
      tenant_id: this.familyTenantId,
      group_id: this.groupId,
      learner_id: this.learnerId,
    });
    return super.save(options);
  }
  override async delete(): Promise<void> {
    throw new Error('Group roster history is retained');
  }
}
export class GroupLearnerRosterEntryCollection extends SmrtCollection<GroupLearnerRosterEntry> {
  static readonly _itemClass = GroupLearnerRosterEntry;
}
