import { withTenant } from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import {
  type GroupSharingAuthorizer,
  GroupSharingBoundary,
  groupSharingTransaction,
  lockGroupSharingScope,
} from './group-sharing-authorization.js';
import {
  type GroupRevisionCommentView,
  type GroupSharedWorkSelector,
  GroupSharingAuthorizationError,
  GroupSharingConflictError,
  type GroupSharingScope,
} from './group-sharing-contracts.js';
import {
  GroupLearnerMembershipCollection,
  type GroupRevisionComment,
  GroupRevisionCommentCollection,
} from './group-sharing-models.js';
import { readSharedRevisionInScope } from './group-sharing-reader.js';

export type ListRevisionCommentsRequest = GroupSharedWorkSelector & {
  /** Explicit paths prevent failed supervisor checks from falling back to family authority. */
  access?: 'supervisor' | 'guardian' | 'child';
};
export type AddRevisionCommentRequest = GroupSharedWorkSelector & {
  body: string;
};
export type SetCommentChildVisibilityRequest = GroupSharingScope & {
  commentId: string;
  expectedVersion: number;
  visible: boolean;
};
const denied = () => new GroupSharingAuthorizationError();
function view(row: GroupRevisionComment): GroupRevisionCommentView {
  return Object.freeze({
    id: String(row.id),
    familyTenantId: row.tenantId,
    membershipId: row.membershipId,
    learnerId: row.learnerId,
    activityId: row.activityId,
    attemptId: row.attemptId,
    revisionId: row.revisionId,
    authorUserId: row.authorUserId,
    authorProfileId: row.authorProfileId,
    body: row.body,
    recordedAt: new Date(row.recordedAt).toISOString(),
    childVisible: row.childVisible,
    visibilityActorUserId: row.visibilityActorUserId,
    visibilityChangedAt: row.visibilityChangedAt
      ? new Date(row.visibilityChangedAt).toISOString()
      : null,
    visibilityVersion: row.visibilityVersion,
  });
}
/** Validate storage as well as hydrated fields: SQLite boolean hydration maps any
 * numeric value other than 1 to false, which must not become a default grant. */
function requireChildVisibilityState(
  row: GroupRevisionComment,
  persisted: Record<string, unknown> | null,
): void {
  const storedVersion = persisted?.visibility_version;
  const version =
    typeof storedVersion === 'number'
      ? storedVersion
      : typeof storedVersion === 'bigint' ||
          (typeof storedVersion === 'string' &&
            /^(0|[1-9][0-9]*)$/.test(storedVersion))
        ? Number(storedVersion)
        : Number.NaN;
  if (
    !persisted ||
    ![false, true, 0, 1].includes(
      persisted.child_visible as boolean | number,
    ) ||
    typeof row.childVisible !== 'boolean' ||
    !Number.isSafeInteger(version) ||
    version < 0 ||
    version !== row.visibilityVersion ||
    row.childVisible !==
      (persisted.child_visible === true || persisted.child_visible === 1)
  )
    throw denied();
  const storedActor = persisted.visibility_actor_user_id;
  const storedChangedAt = persisted.visibility_changed_at;
  const changedAt =
    storedChangedAt instanceof Date
      ? storedChangedAt.getTime()
      : typeof storedChangedAt === 'string' && storedChangedAt.trim()
        ? Date.parse(storedChangedAt)
        : Number.NaN;
  if (version === 0) {
    if (
      row.childVisible !== false ||
      storedActor !== null ||
      storedChangedAt !== null ||
      row.visibilityActorUserId !== null ||
      row.visibilityChangedAt !== null
    )
      throw denied();
  } else if (
    storedActor !== row.visibilityActorUserId ||
    typeof row.visibilityActorUserId !== 'string' ||
    !row.visibilityActorUserId.trim() ||
    row.visibilityActorUserId.trim() !== row.visibilityActorUserId ||
    row.visibilityActorUserId.length > 200 ||
    !(row.visibilityChangedAt instanceof Date) ||
    !Number.isFinite(changedAt) ||
    changedAt !== row.visibilityChangedAt.getTime()
  )
    throw denied();
}

function body(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > 10000 ||
    [...value].some((character) => {
      const code = character.charCodeAt(0);
      return code === 127 || (code < 32 && ![9, 10, 13].includes(code));
    })
  )
    throw new Error('Invalid revision comment body');
  return value;
}

function identifiers(
  request: GroupSharingScope & {
    activityId?: string;
    attemptId?: string;
    revisionId?: string;
    commentId?: string;
  },
  work: boolean,
): void {
  const required = [
    request.groupId,
    request.familyTenantId,
    request.learnerId,
    ...(work ? [request.activityId, request.attemptId] : [request.commentId]),
  ];
  if (
    [
      ...required,
      ...(request.revisionId === undefined ? [] : [request.revisionId]),
    ].some(
      (value) =>
        typeof value !== 'string' ||
        !value.trim() ||
        value.trim() !== value ||
        value.length > 200,
    )
  )
    throw denied();
}

/** Attributed discussion only: this service never writes assessment, grade or progress. */
export class GroupSharingCommentService {
  constructor(
    private readonly db: DatabaseInterface,
    private readonly authorize: GroupSharingAuthorizer,
    /** @internal Only the queued GroupSharingService transaction may set this. */
    private readonly executorBound = false,
  ) {}
  private run<T>(operation: (db: DatabaseInterface) => Promise<T>): Promise<T> {
    return this.executorBound
      ? operation(this.db)
      : groupSharingTransaction(this.db, operation);
  }

  async addRevisionComment(
    input: AddRevisionCommentRequest,
  ): Promise<GroupRevisionCommentView> {
    const request = Object.freeze({ ...input });
    identifiers(request, true);
    const text = body(request.body);
    return this.run(async (db) => {
      const boundary = new GroupSharingBoundary(db, this.authorize);
      await boundary.requireScope(request, 'education.group.comment');
      await lockGroupSharingScope(db, request);
      const scope = await boundary.requireScope(
        request,
        'education.group.comment',
      );
      const binding = await readSharedRevisionInScope(
        db,
        this.authorize,
        request,
      );
      const author = await boundary.requireIdentity(request);
      const comment = await withTenant(
        { tenantId: request.familyTenantId, userId: request.actorUserId },
        async () =>
          (await GroupRevisionCommentCollection.create({ db })).create({
            tenantId: request.familyTenantId,
            membershipId: String(scope.membership.id),
            learnerId: request.learnerId,
            activityId: binding.activityId,
            attemptId: binding.attemptId,
            revisionId: binding.revisionId,
            authorUserId: author.id,
            authorProfileId: author.profileId,
            body: text,
            recordedAt: new Date(),
            childVisible: false,
            visibilityActorUserId: null,
            visibilityChangedAt: null,
            visibilityVersion: 0,
          }),
      );
      // A failure at this final live authorization check rolls back the inserted row.
      await readSharedRevisionInScope(db, this.authorize, {
        ...request,
        revisionId: binding.revisionId,
      });
      return view(comment);
    });
  }

  async listRevisionComments(
    input: ListRevisionCommentsRequest,
  ): Promise<ReadonlyArray<GroupRevisionCommentView>> {
    const request = Object.freeze({ ...input });
    identifiers(request, true);
    if (
      request.access !== undefined &&
      !['supervisor', 'guardian', 'child'].includes(request.access)
    )
      throw denied();
    return this.run(async (db) => {
      const boundary = new GroupSharingBoundary(db, this.authorize);
      const access = request.access ?? 'supervisor';
      const authorize = async () => {
        if (access === 'guardian') {
          // Deliberately independent of group, participation status and current policy.
          await boundary.requireGuardian(request, 'education.group.review');
          return withTenant(
            { tenantId: request.familyTenantId, userId: request.actorUserId },
            async () => {
              const membership = await (
                await GroupLearnerMembershipCollection.create({ db })
              ).get(
                {
                  tenantId: request.familyTenantId,
                  learnerId: request.learnerId,
                  groupId: request.groupId,
                },
                { cache: false },
              );
              if (!membership) throw denied();
              return { membership, policy: null };
            },
          );
        }
        return boundary.requireScope(
          request,
          access === 'child'
            ? 'education.group.child-comments'
            : 'education.group.comment',
          access,
        );
      };
      await authorize();
      await lockGroupSharingScope(db, request);
      const scope = await authorize();
      let revisionId = request.revisionId;
      if (access === 'supervisor')
        revisionId = (
          await readSharedRevisionInScope(db, this.authorize, request)
        ).revisionId;
      const rows = await withTenant(
        { tenantId: request.familyTenantId, userId: request.actorUserId },
        async () =>
          (await GroupRevisionCommentCollection.create({ db })).list({
            where: {
              tenantId: request.familyTenantId,
              membershipId: String(scope.membership.id),
              learnerId: request.learnerId,
              activityId: request.activityId,
              attemptId: request.attemptId,
              ...(revisionId ? { revisionId } : {}),
            },
          }),
      );
      if (access === 'child') {
        for (const row of rows) {
          const persisted = await db.get('group_revision_comments', {
            id: String(row.id),
            tenant_id: request.familyTenantId,
            membership_id: String(scope.membership.id),
            learner_id: request.learnerId,
            activity_id: request.activityId,
            attempt_id: request.attemptId,
            revision_id: row.revisionId,
          });
          requireChildVisibilityState(row, persisted);
        }
      }
      rows.sort(
        (a, b) =>
          new Date(a.recordedAt).getTime() - new Date(b.recordedAt).getTime() ||
          String(a.id).localeCompare(String(b.id)),
      );
      const final = await authorize();
      if (access === 'supervisor')
        await readSharedRevisionInScope(db, this.authorize, {
          ...request,
          revisionId,
        });
      return rows
        .filter(
          (row) =>
            access !== 'child' ||
            (final.policy?.commentVisibility === 'learner-visible' &&
              (row.visibilityVersion === 0 || row.childVisible === true)),
        )
        .map(view);
    });
  }

  async setCommentChildVisibility(
    input: SetCommentChildVisibilityRequest,
  ): Promise<GroupRevisionCommentView> {
    const request = Object.freeze({ ...input });
    identifiers(request, false);
    if (
      typeof request.visible !== 'boolean' ||
      !Number.isSafeInteger(request.expectedVersion) ||
      request.expectedVersion < 0 ||
      !request.commentId
    )
      throw new Error('Invalid comment visibility change');
    return this.run(async (db) => {
      const boundary = new GroupSharingBoundary(db, this.authorize);
      await boundary.requireGuardian(request, 'education.group.share');
      await lockGroupSharingScope(db, request);
      await boundary.requireGuardian(request, 'education.group.share');
      return withTenant(
        { tenantId: request.familyTenantId, userId: request.actorUserId },
        async () => {
          const membership = await (
            await GroupLearnerMembershipCollection.create({ db })
          ).get(
            {
              tenantId: request.familyTenantId,
              learnerId: request.learnerId,
              groupId: request.groupId,
            },
            { cache: false },
          );
          if (!membership) throw denied();
          const comments = await GroupRevisionCommentCollection.create({ db });
          const where = {
            id: request.commentId,
            tenantId: request.familyTenantId,
            learnerId: request.learnerId,
            membershipId: String(membership.id),
          };
          const comment = await comments.get(where, { cache: false });
          if (!comment) throw denied();
          if (comment.visibilityVersion !== request.expectedVersion)
            throw new GroupSharingConflictError();
          const changed = await db.query(
            'UPDATE group_revision_comments SET child_visible = ?, visibility_actor_user_id = ?, visibility_changed_at = ?, visibility_version = visibility_version + 1 WHERE id = ? AND tenant_id = ? AND learner_id = ? AND membership_id = ? AND visibility_version = ? RETURNING id',
            [
              request.visible,
              request.actorUserId,
              new Date().toISOString(),
              request.commentId,
              request.familyTenantId,
              request.learnerId,
              String(membership.id),
              request.expectedVersion,
            ],
          );
          if (changed.rows.length !== 1) throw new GroupSharingConflictError();
          const updated = await comments.get(where, { cache: false });
          if (!updated) throw denied();
          await boundary.requireGuardian(request, 'education.group.share');
          return view(updated);
        },
      );
    });
  }
}
