import { isPostgresDatabase } from '@happyvertical/smrt-core';
import { withTenant } from '@happyvertical/smrt-tenancy';
import { SessionCollection } from '@happyvertical/smrt-users';
import type { DatabaseInterface } from '@happyvertical/sql';
import { expect, it } from 'vitest';
import { GroupSharingCommentService } from '../group-sharing-comments.js';
import { GroupSharingConflictError } from '../group-sharing-contracts.js';
import {
  groupSharingReadClasses,
  sharingPolicy,
  sharingReadFixture,
} from './group-sharing-read-workflows.js';

export const groupSharingCommentClasses = [
  ...groupSharingReadClasses,
  'GroupRevisionComment',
];
async function commentsFixture(db: DatabaseInterface) {
  const f = await sharingReadFixture(db);
  const childSession = await (
    await SessionCollection.create({ db })
  ).createSession({ userId: f.own.actorUserId });
  const siblingSession = await (
    await SessionCollection.create({ db })
  ).createSession({ userId: String(f.bob.user.id) });
  const child = {
    ...f.selector,
    actorUserId: f.own.actorUserId,
    sessionId: String(childSession.id),
    access: 'child' as const,
  };
  const sibling = {
    ...child,
    actorUserId: String(f.bob.user.id),
    sessionId: String(siblingSession.id),
  };
  let supervisorAllowed = true;
  let failAfterInsert = false;
  const executors: DatabaseInterface[] = [];
  const comments = new GroupSharingCommentService(db, async (request) => {
    executors.push(request.executor);
    if (request.guardianRelationships)
      return (
        request.actorUserId === f.parent.actorUserId &&
        request.guardianRelationships.some(
          (r) => r.typeId === f.guardianType.id,
        )
      );
    if (request.action === 'education.group.child-comments')
      return request.actorUserId === f.own.actorUserId;
    if (
      failAfterInsert &&
      (
        await request.executor.list('group_revision_comments', {
          tenant_id: f.scope.familyTenantId,
        })
      ).length
    )
      return false;
    return supervisorAllowed && request.actorUserId === f.parent.actorUserId;
  });
  const add = (body = 'Please explain this step.') =>
    f.asSupervisor(() =>
      comments.addRevisionComment({
        ...f.selector,
        revisionId: f.revision.id,
        body,
      }),
    );
  const asChild = <T>(operation: () => Promise<T>) =>
    withTenant(
      { tenantId: f.scope.familyTenantId, userId: child.actorUserId },
      operation,
    );
  return {
    ...f,
    comments,
    child,
    sibling,
    childSession,
    add,
    asChild,
    executors,
    denySupervisor: () => {
      supervisorAllowed = false;
    },
    failAfterInsert: () => {
      failAfterInsert = true;
    },
  };
}
export function groupSharingCommentContractTests(
  make: () => Promise<{ db: DatabaseInterface; cleanup: () => Promise<void> }>,
) {
  const fixture = async () => {
    const handle = await make();
    try {
      const f = await commentsFixture(handle.db);
      return {
        ...f,
        close: async () => {
          await f.cleanup();
          await handle.cleanup();
        },
      };
    } catch (error) {
      await handle.cleanup();
      throw error;
    }
  };
  it('retains immutable revision and current author attribution without changing learning evidence', async () => {
    const f = await fixture();
    try {
      const before = await Promise.all(
        ['grades', 'workbook_assessment_revisions', 'lesson_progress'].map(
          (table) => f.db.list(table, { tenant_id: f.scope.familyTenantId }),
        ),
      );
      const comment = await f.asSupervisor(() =>
        f.comments.addRevisionComment({
          ...f.selector,
          revisionId: f.revision.id,
          body: 'A useful question',
          authorUserId: f.own.actorUserId,
        } as Parameters<typeof f.comments.addRevisionComment>[0]),
      );
      expect(comment).toMatchObject({
        authorUserId: f.parent.actorUserId,
        authorProfileId: String(f.guardian.profile.id),
        activityId: f.activity.id,
        attemptId: f.attempt.id,
        revisionId: f.revision.id,
        childVisible: false,
        visibilityVersion: 0,
      });
      expect(Number.isFinite(Date.parse(comment.recordedAt))).toBe(true);
      const rows = await f.asSupervisor(() =>
        f.comments.listRevisionComments({
          ...f.selector,
          revisionId: f.revision.id,
        }),
      );
      expect(rows).toEqual([comment]);
      const after = await Promise.all(
        ['grades', 'workbook_assessment_revisions', 'lesson_progress'].map(
          (table) => f.db.list(table, { tenant_id: f.scope.familyTenantId }),
        ),
      );
      expect(after).toEqual(before);
      expect(f.executors.length).toBeGreaterThan(0);
      expect(f.executors.every((executor) => executor !== f.db)).toBe(true);
    } finally {
      await f.close();
    }
  });
  it('uses saved parent visibility and explicit per-comment restrictions with optimistic concurrency', async () => {
    const f = await fixture();
    try {
      const comment = await f.add();
      const list = () =>
        f.asChild(() => f.comments.listRevisionComments(f.child));
      expect(await list()).toEqual([]);
      await f.setPolicy({
        ...sharingPolicy(),
        commentVisibility: 'learner-visible',
      });
      expect((await list()).map((row) => row.id)).toEqual([comment.id]);
      const toggle = {
        ...f.scope,
        commentId: comment.id,
        expectedVersion: 0,
        visible: false,
      };
      const results = await f.as(f.parent, () =>
        Promise.allSettled([
          f.comments.setCommentChildVisibility(toggle),
          f.comments.setCommentChildVisibility(toggle),
        ]),
      );
      expect(
        results.filter((result) => result.status === 'fulfilled'),
      ).toHaveLength(1);
      const rejected = results.find(
        (result) => result.status === 'rejected',
      ) as PromiseRejectedResult;
      expect(rejected.reason).toBeInstanceOf(GroupSharingConflictError);
      expect(await list()).toEqual([]);
      const enabled = await f.as(f.parent, () =>
        f.comments.setCommentChildVisibility({
          ...toggle,
          expectedVersion: 1,
          visible: true,
        }),
      );
      expect(enabled).toMatchObject({
        visibilityVersion: 2,
        visibilityActorUserId: f.parent.actorUserId,
      });
      expect((await list()).map((row) => row.id)).toEqual([comment.id]);
      await f.setPolicy(sharingPolicy());
      expect(await list()).toEqual([]);
      await expect(
        f.asSupervisor(() =>
          f.comments.setCommentChildVisibility({
            ...toggle,
            expectedVersion: 2,
            visible: true,
          }),
        ),
      ).rejects.toThrow();
      await expect(
        withTenant(
          { tenantId: f.scope.familyTenantId, userId: f.sibling.actorUserId },
          () => f.comments.listRevisionComments(f.sibling),
        ),
      ).rejects.toThrow();
    } finally {
      await f.close();
    }
  });
  it('rejects corrupted persisted visibility before returning any child comment body', async () => {
    const f = await fixture();
    try {
      const comment = await f.add(
        'Private body must not escape corrupted consent',
      );
      await f.setPolicy({
        ...sharingPolicy(),
        commentVisibility: 'learner-visible',
      });
      const list = () =>
        f.asChild(() => f.comments.listRevisionComments(f.child));
      expect((await list()).map((row) => row.id)).toEqual([comment.id]);
      const changedAt = new Date().toISOString();
      const corruptions = [
        { version: -1, visible: true, actor: f.parent.actorUserId, changedAt },
        { version: 1, visible: true, actor: null, changedAt },
        {
          version: 1,
          visible: true,
          actor: f.parent.actorUserId,
          changedAt: null,
        },
        { version: 0, visible: true, actor: null, changedAt: null },
        {
          version: 0,
          visible: false,
          actor: f.parent.actorUserId,
          changedAt: null,
        },
        { version: 0, visible: false, actor: null, changedAt },
      ];
      for (const state of corruptions) {
        await f.db.query(
          'UPDATE group_revision_comments SET visibility_version = ?, child_visible = ?, visibility_actor_user_id = ?, visibility_changed_at = ? WHERE id = ? AND tenant_id = ?',
          [
            state.version,
            state.visible,
            state.actor,
            state.changedAt,
            comment.id,
            f.scope.familyTenantId,
          ],
        );
        await expect(list()).rejects.toThrow('Group sharing');
      }
      // PostgreSQL enforces BOOLEAN storage. SQLite hydration would otherwise
      // normalize this malformed number to false and grant version-0 inheritance.
      if (!isPostgresDatabase(f.db)) {
        await f.db.query(
          'UPDATE group_revision_comments SET visibility_version = 0, child_visible = 2, visibility_actor_user_id = NULL, visibility_changed_at = NULL WHERE id = ? AND tenant_id = ?',
          [comment.id, f.scope.familyTenantId],
        );
        await expect(list()).rejects.toThrow('Group sharing');
      }
      await f.db.query(
        'UPDATE group_revision_comments SET visibility_version = 1, child_visible = ?, visibility_actor_user_id = ?, visibility_changed_at = ? WHERE id = ? AND tenant_id = ?',
        [
          true,
          f.parent.actorUserId,
          changedAt,
          comment.id,
          f.scope.familyTenantId,
        ],
      );
      expect((await list()).map((row) => row.id)).toEqual([comment.id]);
      // Attribution is historical; later loss of this parent's relationship
      // does not invalidate an otherwise well-formed visibility decision.
      await f.db.query(
        'DELETE FROM profile_relationships WHERE id = ? AND tenant_id = ?',
        [String(f.relationship.id), f.scope.familyTenantId],
      );
      expect((await list()).map((row) => row.id)).toEqual([comment.id]);
    } finally {
      await f.close();
    }
  });
  it('retains family comments after departure while blocking stale supervisor and child reads', async () => {
    const f = await fixture();
    try {
      const comment = await f.add();
      await f.as(f.parent, async () => {
        f.edge.status = 'revoked';
        await f.edge.save();
      });
      await expect(
        f.asSupervisor(() => f.comments.listRevisionComments(f.selector)),
      ).rejects.toThrow();
      await expect(f.add('stale')).rejects.toThrow();
      await expect(
        f.asChild(() => f.comments.listRevisionComments(f.child)),
      ).rejects.toThrow();
      const retained = await f.as(f.parent, () =>
        f.comments.listRevisionComments({ ...f.selector, access: 'guardian' }),
      );
      expect(retained).toEqual([comment]);
      const changed = await f.as(f.parent, () =>
        f.comments.setCommentChildVisibility({
          ...f.scope,
          commentId: comment.id,
          expectedVersion: 0,
          visible: true,
        }),
      );
      expect(changed.authorUserId).toBe(comment.authorUserId);
      expect(changed.recordedAt).toBe(comment.recordedAt);
    } finally {
      await f.close();
    }
  });
  it('rejects malformed bodies, hidden or foreign revisions, stale permissions and missing sessions', async () => {
    const f = await fixture();
    try {
      for (const invalid of [
        { activityId: '' },
        { attemptId: '' },
        { revisionId: '' },
      ]) {
        await expect(
          f.as(f.parent, () =>
            f.comments.listRevisionComments({
              ...f.selector,
              ...invalid,
              access: 'guardian',
            }),
          ),
        ).rejects.toThrow();
      }
      for (const body of [
        '',
        '   ',
        'x'.repeat(10001),
        '\u0000',
        null,
        { text: 'forged' },
      ])
        await expect(f.add(body as string)).rejects.toThrow();
      await expect(
        f.asSupervisor(() =>
          f.comments.addRevisionComment({
            ...f.selector,
            revisionId: f.learner.id as string,
            body: 'foreign',
          }),
        ),
      ).rejects.toThrow();
      await f.setPolicy({ ...sharingPolicy(), shareWork: false });
      await expect(f.add('hidden')).rejects.toThrow();
      await f.setPolicy(sharingPolicy());
      const comment = await f.add();
      f.denySupervisor();
      await expect(
        f.asSupervisor(() => f.comments.listRevisionComments(f.selector)),
      ).rejects.toThrow();
      await expect(f.add('role removed')).rejects.toThrow();
      await expect(
        f.as(f.parent, () =>
          f.comments.listRevisionComments({
            ...f.selector,
            sessionId: 'missing',
            access: 'guardian',
          }),
        ),
      ).rejects.toThrow();
      expect(
        (
          await f.as(f.parent, () =>
            f.comments.listRevisionComments({
              ...f.selector,
              access: 'guardian',
            }),
          )
        )[0].id,
      ).toBe(comment.id);
    } finally {
      await f.close();
    }
  });
  it('rolls back an inserted comment when the final live authorization fails', async () => {
    const f = await fixture();
    try {
      f.failAfterInsert();
      await expect(f.add()).rejects.toThrow();
      expect(
        await f.db.list('group_revision_comments', {
          tenant_id: f.scope.familyTenantId,
        }),
      ).toEqual([]);
    } finally {
      await f.close();
    }
  });
}
