import { randomUUID } from 'node:crypto';
import { ProfileRelationshipCollection } from '@happyvertical/smrt-profiles';
import { withTenant } from '@happyvertical/smrt-tenancy';
import {
  MembershipCollection,
  MembershipStatus,
  SessionCollection,
} from '@happyvertical/smrt-users';
import { expect, it } from 'vitest';
import { GroupSharingCommentService } from '../group-sharing-comments.js';
import { GroupSharingService } from '../group-sharing-service.js';
import type { SharingDatabaseFactory } from './group-sharing-concurrency-workflows.js';
import {
  groupSharingLifecycleClasses,
  groupSharingLifecycleFixture,
  sharingPolicy as lifecyclePolicy,
} from './group-sharing-lifecycle-workflows.js';
import {
  groupSharingReadClasses,
  sharingPolicy,
  sharingReadFixture,
} from './group-sharing-read-workflows.js';
export const groupSharingAdversarialClasses = [
  ...new Set([
    ...groupSharingLifecycleClasses,
    ...groupSharingReadClasses,
    'GroupRevisionComment',
  ]),
];

export function groupSharingAdversarialContractTests(
  make: SharingDatabaseFactory,
) {
  for (const revoked of [
    'session',
    'membership',
    'role',
    'group',
    'edge',
  ] as const) {
    it(`rechecks ${revoked} revocation on every bookmarked public read/comment path`, async () => {
      const handle = await make();
      let f: Awaited<ReturnType<typeof sharingReadFixture>> | undefined;
      try {
        f = await sharingReadFixture(handle.db);
        const x = f;
        const comments = new GroupSharingCommentService(
          handle.db,
          async (request) => {
            // A fresh live host proof, followed by the service's independent stored checks.
            const user = await request.executor.get('users', {
              id: request.actorUserId,
              status: 'active',
            });
            return Boolean(user) && request.actorUserId === x.scope.actorUserId;
          },
        );
        const paths: Array<() => Promise<unknown>> = [
          () => x.reader.listSharedWork(x.scope),
          () => x.reader.getSharedWork(x.selector),
          () => x.reader.getSharedRevision(x.selector),
          () => x.reader.getSharedProgress(x.scope),
          () =>
            x.reader.readSharedMedia({
              ...x.selector,
              assetId: x.sources[0].assetId,
            }),
          () =>
            comments.listRevisionComments({
              ...x.selector,
              revisionId: x.revision.id,
            }),
          () =>
            comments.addRevisionComment({
              ...x.selector,
              revisionId: x.revision.id,
              body: 'A retained bookmark',
            }),
        ];
        for (const path of paths) await x.asSupervisor(path);
        const group = await handle.db.get('education_groups', {
          id: x.scope.groupId,
        });
        if (!group) throw new Error('Fixture group missing');
        if (revoked === 'session')
          await handle.db.update(
            'sessions',
            { id: x.scope.sessionId },
            { status: 'revoked' },
          );
        if (revoked === 'membership')
          await handle.db.update(
            'memberships',
            { tenant_id: group.tenant_id, user_id: x.scope.actorUserId },
            { status: 'inactive' },
          );
        if (revoked === 'role') {
          const member = await handle.db.get('memberships', {
            tenant_id: group.tenant_id,
            user_id: x.scope.actorUserId,
          });
          await handle.db.update(
            'roles',
            { id: member?.role_id },
            { tenant_id: x.scope.familyTenantId },
          );
        }
        if (revoked === 'group')
          await handle.db.update(
            'education_groups',
            { id: x.scope.groupId },
            { active: false },
          );
        if (revoked === 'edge')
          await x.as(x.parent, async () => {
            x.edge.status = 'revoked';
            await x.edge.save();
          });
        for (const path of paths)
          await expect(x.asSupervisor(path)).rejects.toThrow();
      } finally {
        await f?.cleanup();
        await handle.cleanup();
      }
    });
  }
  it('rejects sibling, foreign-family and other-group selectors despite valid work bookmarks', async () => {
    const handle = await make();
    let first: Awaited<ReturnType<typeof sharingReadFixture>> | undefined;
    let second: Awaited<ReturnType<typeof sharingReadFixture>> | undefined;
    try {
      first = await sharingReadFixture(handle.db);
      second = await sharingReadFixture(handle.db);
      const f = first;
      const foreign = second;
      expect(second.scope.familyTenantId).not.toBe(f.scope.familyTenantId);
      expect(second.scope.groupId).not.toBe(f.scope.groupId);
      for (const scope of [
        { learnerId: String(f.sibling.id) },
        {
          familyTenantId: second.scope.familyTenantId,
          learnerId: second.scope.learnerId,
        },
        { groupId: second.scope.groupId },
      ]) {
        const selected = { ...f.selector, ...scope };
        await expect(
          f.asSupervisor(() => f.reader.getSharedWork(selected)),
        ).rejects.toThrow();
        await expect(
          f.asSupervisor(() => f.reader.getSharedRevision(selected)),
        ).rejects.toThrow();
        await expect(
          f.asSupervisor(() =>
            f.reader.readSharedMedia({
              ...selected,
              assetId: f.sources[0].assetId,
            }),
          ),
        ).rejects.toThrow();
      }
      await expect(
        f.asSupervisor(() =>
          f.reader.getSharedWork({
            ...f.selector,
            activityId: foreign.activity.id,
            attemptId: foreign.attempt.id,
          }),
        ),
      ).rejects.toThrow();
    } finally {
      await second?.cleanup();
      await first?.cleanup();
      await handle.cleanup();
    }
  });
  it('keeps withheld work out of bounded pages, cursor replay and counts-only progress', async () => {
    const handle = await make();
    let f: Awaited<ReturnType<typeof sharingReadFixture>> | undefined;
    try {
      f = await sharingReadFixture(handle.db);
      const x = f;
      const policy = { ...sharingPolicy(), shareFeedback: false };
      await x.setPolicy(policy);
      const page = await x.asSupervisor(() =>
        x.reader.listSharedWork({ ...x.scope, limit: 1 }),
      );
      expect(page.works.map((work) => work.attemptId)).toEqual([x.attempt.id]);
      expect(page.nextCursor).toBeNull();
      for (const limit of [0, -1, 101, 1.5])
        await expect(
          x.asSupervisor(() => x.reader.listSharedWork({ ...x.scope, limit })),
        ).rejects.toThrow();
      for (const cursor of [randomUUID(), String(x.sibling.id)])
        await expect(
          x.asSupervisor(() =>
            x.reader.listSharedWork({ ...x.scope, cursor, limit: 1 }),
          ),
        ).rejects.toThrow();
      const counts = await x.asSupervisor(() =>
        x.reader.getSharedProgress(x.scope),
      );
      expect(Object.keys(counts).sort()).toEqual([
        'algorithmVersion',
        'concepts',
        'counts',
      ]);
      expect(JSON.stringify([page, counts])).not.toMatch(
        /Withheld|incorrect|math.addition|possiblePoints|"q1"/,
      );
      await x.setPolicy({ ...policy, historyFrom: '2099-01-01T00:00:00.000Z' });
      expect(
        await x.asSupervisor(() =>
          x.reader.listSharedWork({ ...x.scope, limit: 1 }),
        ),
      ).toEqual({ works: [], nextCursor: null });
      await expect(
        x.asSupervisor(() =>
          x.reader.listSharedWork({
            ...x.scope,
            cursor: x.attempt.id,
            limit: 1,
          }),
        ),
      ).rejects.toThrow();
      expect(
        (await x.asSupervisor(() => x.reader.getSharedProgress(x.scope)))
          .counts,
      ).toEqual({
        attempts: 0,
        episodes: 0,
        assistance: { independent: 0, assisted: 0, unknown: 0 },
      });
    } finally {
      await f?.cleanup();
      await handle.cleanup();
    }
  });
  it('accepts two siblings in two independent groups and denies supervisor consent writes', async () => {
    const handle = await make();
    try {
      const f = await groupSharingLifecycleFixture(handle.db);
      await f.asParent(async () =>
        (await ProfileRelationshipCollection.create({ db: handle.db })).create({
          tenantId: f.scope.familyTenantId,
          fromProfileId: String(f.guardian.profile.id),
          toProfileId: String(f.bob.profile.id),
          typeId: String(f.guardianType.id),
        }),
      );
      const service = new GroupSharingService(handle.db, async (request) =>
        request.guardianRelationships
          ? request.actorUserId === f.parentActor.actorUserId &&
            request.guardianRelationships.some(
              (r) => r.typeId === f.guardianType.id,
            )
          : f.authorize(request),
      );
      const group2 = await f.asSupervisor(() =>
        service.createGroup({
          ...f.supervisor,
          name: 'Second independent group',
        }),
      );
      const accepted = [];
      for (const group of [f.group, group2])
        for (const child of [f.learner, f.sibling]) {
          const scope = {
            ...f.scope,
            groupId: group.id,
            learnerId: String(child.id),
          };
          const invitation = await withTenant(
            { tenantId: group.tenantId, userId: f.supervisor.actorUserId },
            () =>
              service.inviteLearner({
                ...scope,
                ...f.supervisor,
                invitedParentUserId: f.parentActor.actorUserId,
                expiresAt: new Date(Date.now() + 60_000),
              }),
          );
          accepted.push(
            await f.asParent(() =>
              service.acceptInvitation({
                ...f.parentActor,
                invitationId: invitation.id,
                policy: lifecyclePolicy,
              }),
            ),
          );
        }
      expect(new Set(accepted.map((edge) => edge.id)).size).toBe(4);
      for (const group of [f.group, group2])
        expect(
          (
            await withTenant(
              { tenantId: group.tenantId, userId: f.supervisor.actorUserId },
              () =>
                service.listMemberships({ ...f.supervisor, groupId: group.id }),
            )
          )
            .map((edge) => edge.learnerId)
            .sort(),
        ).toEqual([String(f.learner.id), String(f.sibling.id)].sort());
      await expect(
        f.asSupervisor(() =>
          service.setSharingPolicy({
            ...f.scope,
            ...f.supervisor,
            expectedVersion: 1,
            policy: lifecyclePolicy,
          }),
        ),
      ).rejects.toThrow();
    } finally {
      await handle.cleanup();
    }
  });
  it('gives a non-guardian supervisor comments without visibility or assessment mutation authority', async () => {
    const handle = await make();
    let f: Awaited<ReturnType<typeof sharingReadFixture>> | undefined;
    try {
      f = await sharingReadFixture(handle.db);
      const x = f;
      const group = await handle.db.get('education_groups', {
        id: x.scope.groupId,
      });
      if (!group) throw new Error('Fixture group missing');
      const existing = await handle.db.get('memberships', {
        tenant_id: group.tenant_id,
        user_id: x.parent.actorUserId,
      });
      if (!existing) throw new Error('Fixture membership missing');
      await (await MembershipCollection.create({ db: handle.db })).create({
        tenantId: String(group.tenant_id),
        userId: String(x.stranger.user.id),
        roleId: String(existing.role_id),
        status: MembershipStatus.ACTIVE,
      });
      const session = await (
        await SessionCollection.create({ db: handle.db })
      ).createSession({ userId: String(x.stranger.user.id) });
      const selector = {
        ...x.selector,
        actorUserId: String(x.stranger.user.id),
        sessionId: String(session.id),
      };
      const comments = new GroupSharingCommentService(
        handle.db,
        async (request) => {
          const membership = await request.executor.get('memberships', {
            tenant_id: group.tenant_id,
            user_id: request.actorUserId,
            status: 'active',
          });
          return (
            Boolean(membership) && request.actorUserId === selector.actorUserId
          );
        },
      );
      const asSupervisor = <T>(operation: () => Promise<T>) =>
        withTenant(
          { tenantId: String(group.tenant_id), userId: selector.actorUserId },
          operation,
        );
      const before = await handle.db.list('workbook_assessment_revisions', {
        tenant_id: x.scope.familyTenantId,
      });
      const comment = await asSupervisor(() =>
        comments.addRevisionComment({
          ...selector,
          revisionId: x.revision.id,
          body: 'Please explain your reasoning.',
        }),
      );
      expect(comment.authorUserId).toBe(selector.actorUserId);
      await expect(
        asSupervisor(() =>
          comments.setCommentChildVisibility({
            ...selector,
            commentId: comment.id,
            expectedVersion: 0,
            visible: true,
          }),
        ),
      ).rejects.toThrow();
      await expect(
        withTenant(
          { tenantId: x.scope.familyTenantId, userId: selector.actorUserId },
          () =>
            x.workbook.reviewWorkbookAssessment({
              ...x.parent,
              actorUserId: selector.actorUserId,
              guardianRelationshipId: undefined,
              activityId: x.activity.id,
              submissionId: x.attempt.submissionId,
              revisionId: x.revision.id,
              expectedHeadId: x.revision.id,
              requestKey: 'supervisor-mark-bypass',
            }),
        ),
      ).rejects.toThrow();
      expect(
        await handle.db.list('workbook_assessment_revisions', {
          tenant_id: x.scope.familyTenantId,
        }),
      ).toEqual(before);
      expect(
        (await asSupervisor(() => comments.listRevisionComments(selector))).map(
          (row) => row.id,
        ),
      ).toEqual([comment.id]);
    } finally {
      await f?.cleanup();
      await handle.cleanup();
    }
  });

  it('fails on missing application schema without recreating it at runtime', async () => {
    const handle = await make();
    try {
      const f = await groupSharingLifecycleFixture(handle.db);
      await handle.db.query('DROP TABLE group_learner_roster_entries');
      await expect(
        f.invite().then((invitation) =>
          f.asParent(() =>
            f.sharingService.acceptInvitation({
              ...f.parentActor,
              invitationId: invitation.id,
              policy: lifecyclePolicy,
            }),
          ),
        ),
      ).rejects.toThrow();
      expect(await handle.db.tableExists('group_learner_roster_entries')).toBe(
        false,
      );
      expect(
        await handle.db.list('group_learner_memberships', {
          group_id: f.group.id,
        }),
      ).toEqual([]);
    } finally {
      await handle.cleanup();
    }
  });
}

export { groupSharingConcurrencyContractTests } from './group-sharing-concurrency-workflows.js';
