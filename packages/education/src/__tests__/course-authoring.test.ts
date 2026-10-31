import { randomUUID } from 'node:crypto';
import {
  AssetCollection,
  withPrivateAssetAccess,
} from '@happyvertical/smrt-assets';
import {
  getSQLFromDiff,
  getTestDatabase,
  ObjectRegistry,
  SchemaComparer,
} from '@happyvertical/smrt-core';
import {
  createMigrationDefinition,
  MigrationGenerator,
  MigrationTracker,
} from '@happyvertical/smrt-core/migrations';
import { ProfileRelationshipCollection } from '@happyvertical/smrt-profiles';
import {
  disableTenancy,
  enableTenancy,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  CourseArchivedError,
  CourseDiscardedError,
  CourseDiscardRefusedError,
  CourseMaterialCopyError,
  CourseNotFoundError,
  CourseRequestKeyConflictError,
  CourseRevisionAlreadyReleasedError,
  CourseStaleHeadError,
  EnrollmentPinConflictError,
  ReviewGateRequiredError,
  ReviewNotCurrentError,
} from '../course-authoring-contracts.js';
import {
  isAuthoredReleaseGroupShareable,
  mostRestrictiveLicense,
} from '../course-authoring-licence.js';
import { CourseRevisionCollection } from '../course-authoring-models.js';
import type { GroupSharingPolicyV1 } from '../group-sharing-contracts.js';
import { evaluateGroupSharingPolicy } from '../group-sharing-policy.js';
import {
  COURSE_AUTHORING_ACTIONS,
  type CourseAuthoringAction,
  type CourseAuthoringActor,
  CourseAuthoringAuthorizationError,
  type CourseAuthoringAuthorizer,
  CourseAuthoringError,
  CourseAuthoringService,
  type CourseDraftInput,
  type CourseMaterialCopyPort,
  type ReleaseReviewGate,
} from '../index.js';
import { learnerClasses, learnerFixture } from './learner-workflows.js';

const authoringClasses = [
  ...learnerClasses,
  'AuthoredCourse',
  'Reading',
  'Video',
  'Worksheet',
  'Exercise',
  'CourseRevision',
  'LessonRevision',
  'CourseDraftHead',
  'CourseRelease',
  'ReleasedLesson',
  'CourseArchiveDecision',
  'CourseDiscardTombstone',
  'EnrollmentReleasePin',
  'CourseUpgradeChoice',
  'EnrollmentAutoUpgradeSkip',
  'EnrollmentAssignmentRecord',
  'CurriculumCreationRecord',
];
const authoringTables = [
  'CourseRevision',
  'LessonRevision',
  'CourseDraftHead',
  'CourseRelease',
  'ReleasedLesson',
  'CourseArchiveDecision',
  'CourseDiscardTombstone',
  'EnrollmentReleasePin',
  'CourseUpgradeChoice',
  'EnrollmentAutoUpgradeSkip',
  'EnrollmentAssignmentRecord',
  'CurriculumCreationRecord',
];

beforeAll(() => enableTenancy());
afterAll(() => disableTenancy());

const opened: DatabaseInterface[] = [];
afterEach(async () => {
  for (const db of opened.splice(0)) await db.close?.();
});

type Call = Parameters<CourseAuthoringAuthorizer>[0];

async function setup(
  options: {
    gate?: ReleaseReviewGate | null;
    copy?: CourseMaterialCopyPort;
    guard?: boolean;
  } = {},
) {
  const db = await getTestDatabase({
    type: 'sqlite',
    url: ':memory:',
    classes: authoringClasses,
  });
  opened.push(db);
  const f = await learnerFixture(db);
  const guardian: CourseAuthoringActor = {
    tenantId: f.own.tenantId,
    actorUserId: f.parent.actorUserId,
  };
  // An agent: the learner's user id stands in for it, delegated by the guardian.
  const agent: CourseAuthoringActor = {
    tenantId: f.own.tenantId,
    actorUserId: String(f.bob.user.id),
    delegatingGuardianUserId: guardian.actorUserId,
    delegationId: 'delegation-1',
  };
  const outsider: CourseAuthoringActor = {
    tenantId: String(f.foreign.tenantId),
    actorUserId: String(f.stranger.user.id),
  };
  const calls: Call[] = [];
  const grants = new Map<string, CourseAuthoringAction[]>([
    [guardian.actorUserId, [...COURSE_AUTHORING_ACTIONS]],
    [
      agent.actorUserId,
      COURSE_AUTHORING_ACTIONS.filter((a) => a !== 'education.course.archive'),
    ],
    [outsider.actorUserId, [...COURSE_AUTHORING_ACTIONS]],
  ]);
  const denied = new Set<CourseAuthoringAction>();
  const deniedLearners = new Set<string>();
  const deniedActors = new Set<string>();
  const authorizer: CourseAuthoringAuthorizer = (call) => {
    calls.push(call);
    return (
      !denied.has(call.action) &&
      !(call.learnerId && deniedLearners.has(call.learnerId)) &&
      !deniedActors.has(call.actorUserId) &&
      (grants.get(call.actorUserId) ?? []).includes(call.action)
    );
  };
  const gateState: { value: Awaited<ReturnType<ReleaseReviewGate>> } = {
    value: { current: true, reviewId: 'review-1' },
  };
  const gateCalls: unknown[] = [];
  const service = new CourseAuthoringService(db, authorizer, {
    verifyDelegation: () => true,
    ...(options.gate === null
      ? {}
      : {
          releaseReviewGate:
            options.gate ??
            ((executor, request) => {
              gateCalls.push({ executor, request });
              return gateState.value;
            }),
        }),
    ...(options.copy ? { materialCopy: options.copy } : {}),
    ...(options.guard
      ? { referenceGuard: () => ({ referenced: true, kinds: ['review'] }) }
      : {}),
  });
  const as = <T>(actor: CourseAuthoringActor, fn: () => Promise<T>) =>
    withTenant({ tenantId: actor.tenantId, userId: actor.actorUserId }, fn);
  let counter = 0;
  const key = (label = 'k') => `${label}-${++counter}`;
  const lessons = (
    ...titles: Array<[string, string]>
  ): CourseDraftInput['sections'] => [
    {
      sectionKey: 'unit-1',
      title: 'Unit 1',
      lessons: titles.map(([lessonKey, title]) => ({ lessonKey, title })),
    },
  ];
  const draft = (
    sections: CourseDraftInput['sections'],
    extra: Partial<CourseDraftInput> = {},
  ): CourseDraftInput => ({
    title: 'Fractions',
    objectives: ['Add fractions'],
    levelMin: 3,
    levelMax: 4,
    sections,
    provenance: 'supplied',
    ...extra,
  });
  const create = async (actor = guardian) =>
    as(actor, () =>
      service.createCourse({
        ...actor,
        requestKey: key('create'),
        title: 'Fractions',
        levelMin: 3,
        levelMax: 4,
      }),
    );
  const save = async (
    courseId: string,
    expected: string,
    sections: CourseDraftInput['sections'],
    actor = guardian,
    extra: Partial<CourseDraftInput> = {},
  ) =>
    as(actor, () =>
      service.saveDraft({
        ...actor,
        courseId,
        expectedHeadRevisionId: expected,
        requestKey: key('save'),
        draft: draft(sections, extra),
      }),
    );
  const release = (courseId: string, revisionId: string, actor = guardian) =>
    as(actor, () =>
      service.release({
        ...actor,
        courseId,
        revisionId,
        requestKey: key('rel'),
      }),
    );
  /** Course with two lessons, saved and released. */
  async function released() {
    const head = await create();
    const saved = await save(
      head.courseId,
      head.headRevisionId,
      lessons(['a', 'Lesson A'], ['b', 'Lesson B']),
    );
    const rel = await release(head.courseId, saved.revisionId);
    return { head, saved, rel };
  }
  async function enrollOn(releaseCourseId: string) {
    return f.as(f.parent, () =>
      f.service.enroll({
        ...f.parent,
        curriculumId: String(f.curriculum.id),
        courseId: releaseCourseId,
      }),
    );
  }
  const count = async (table: string) => (await db.list(table, {})).length;
  return {
    db,
    f,
    service,
    guardian,
    agent,
    outsider,
    calls,
    denied,
    deniedLearners,
    deniedActors,
    gateState,
    gateCalls,
    as,
    key,
    lessons,
    draft,
    create,
    save,
    release,
    released,
    enrollOn,
    count,
  };
}

describe('CourseAuthoringService', () => {
  it('creates, saves revisions with stable lesson identity and reads the draft', async () => {
    const s = await setup();
    const head = await s.create();
    expect(head.version).toBe(1);
    const one = await s.save(head.courseId, head.headRevisionId, [
      {
        sectionKey: 'unit-1',
        title: 'Unit 1',
        lessons: [
          { lessonKey: 'a', title: 'Lesson A', provenance: 'supplied' },
          { lessonKey: 'b', title: 'Lesson B', provenance: 'supplied' },
        ],
      },
    ]);
    const two = await s.save(
      head.courseId,
      one.revisionId,
      [
        {
          sectionKey: 'unit-1',
          title: 'Unit 1',
          lessons: [
            { lessonKey: 'a', title: 'Lesson A', provenance: 'supplied' },
            { lessonKey: 'b', title: 'Lesson B edited', provenance: 'edited' },
          ],
        },
      ],
      s.guardian,
      { provenance: 'edited' },
    );
    expect(two.version).toBe(3);
    const read = await s.as(s.guardian, () =>
      s.service.readDraft({ ...s.guardian, courseId: head.courseId }),
    );
    expect(read.head.headRevisionId).toBe(two.revisionId);
    expect(read.revision.parentRevisionId).toBe(one.revisionId);
    expect(read.revision.sequence).toBe(3);
    expect(read.revision.provenance).toBe('edited');
    const first = (
      await s.as(s.guardian, () =>
        s.service.readDraft({
          ...s.guardian,
          courseId: head.courseId,
          revisionId: one.revisionId,
        }),
      )
    ).revision;
    const [a1, b1] = first.sections[0].lessons;
    const [a2, b2] = read.revision.sections[0].lessons;
    // Unchanged lesson content reuses its immutable revision; an edit appends one.
    expect(a2.id).toBe(a1.id);
    expect(b2.id).not.toBe(b1.id);
    expect(b2.lessonKey).toBe('b');
    expect(b2.parentRevisionId).toBe(b1.id);
    // Revisions are append-only.
    const rows = await s.db.list('course_revisions', {});
    expect(rows).toHaveLength(3);
    await expect(
      s.as(s.guardian, async () => {
        const revisions = await CourseRevisionCollection.create({ db: s.db });
        const row = await revisions.get(
          { id: one.revisionId },
          { cache: false },
        );
        if (!row) throw new Error('missing revision');
        row.title = 'Rewritten';
        return row.save();
      }),
    ).rejects.toThrow('immutable');
  });

  it('denies cross-tenant reads and writes without leaking existence', async () => {
    const s = await setup();
    const head = await s.create();
    // Actor of another tenant, in their own tenant context, naming this course.
    await expect(
      s.as(s.outsider, () =>
        s.service.readDraft({ ...s.outsider, courseId: head.courseId }),
      ),
    ).rejects.toBeInstanceOf(CourseNotFoundError);
    await expect(
      s.as(s.outsider, () =>
        s.service.saveDraft({
          ...s.outsider,
          courseId: head.courseId,
          expectedHeadRevisionId: head.headRevisionId,
          requestKey: 'x',
          draft: s.draft(s.lessons(['a', 'A'])),
        }),
      ),
    ).rejects.toBeInstanceOf(CourseNotFoundError);
    // Claiming this tenant while in another tenant's context is denied outright.
    await expect(
      s.as(s.outsider, () =>
        s.service.readDraft({ ...s.guardian, courseId: head.courseId }),
      ),
    ).rejects.toBeInstanceOf(CourseAuthoringAuthorizationError);
    await expect(
      s.as(s.guardian, () =>
        s.service.readDraft({ ...s.outsider, courseId: head.courseId }),
      ),
    ).rejects.toBeInstanceOf(CourseAuthoringAuthorizationError);
    // No ambient tenant context.
    await expect(
      s.service.readDraft({ ...s.guardian, courseId: head.courseId }),
    ).rejects.toBeInstanceOf(CourseAuthoringAuthorizationError);
    // A user without an active membership in the claimed tenant.
    await expect(
      s.as({ ...s.guardian, actorUserId: s.outsider.actorUserId }, () =>
        s.service.readDraft({
          ...s.guardian,
          actorUserId: s.outsider.actorUserId,
          courseId: head.courseId,
        }),
      ),
    ).rejects.toBeInstanceOf(CourseAuthoringAuthorizationError);
    // The same request key in two tenants yields two unrelated courses.
    const theirs = await s.create(s.outsider);
    expect(theirs.courseId).not.toBe(head.courseId);
  });

  it('authorizes every operation with the matching action and the active executor', async () => {
    const s = await setup();
    const head = await s.create();
    const saved = await s.save(
      head.courseId,
      head.headRevisionId,
      s.lessons(['a', 'A']),
    );
    const rel = await s.release(head.courseId, saved.revisionId);
    const enrollment = await s.enrollOn(rel.releaseCourseId);
    const ops: Array<[CourseAuthoringAction, () => Promise<unknown>]> = [
      [
        'education.course.author',
        () =>
          s.service.saveDraft({
            ...s.guardian,
            courseId: head.courseId,
            expectedHeadRevisionId: saved.headRevisionId,
            requestKey: s.key(),
            draft: s.draft(s.lessons(['a', 'A'])),
          }),
      ],
      [
        'education.course.read-draft',
        () => s.service.readDraft({ ...s.guardian, courseId: head.courseId }),
      ],
      [
        'education.course.assign',
        () =>
          s.service.pinEnrollment({
            ...s.guardian,
            enrollmentId: String(enrollment.id),
            releaseId: rel.id,
            requestKey: s.key(),
            policyBasis: 'guardians-only',
          }),
      ],
      [
        'education.course.archive',
        () =>
          s.service.archive({
            ...s.guardian,
            courseId: head.courseId,
            requestKey: s.key(),
          }),
      ],
    ];
    for (const [action, op] of ops) {
      s.denied.add(action);
      await expect(s.as(s.guardian, op)).rejects.toBeInstanceOf(
        CourseAuthoringAuthorizationError,
      );
      s.denied.delete(action);
    }
    // generated content additionally needs the generate action.
    s.denied.add('education.course.generate');
    await expect(
      s.save(
        head.courseId,
        saved.headRevisionId,
        s.lessons(['a', 'A']),
        s.guardian,
        {
          provenance: 'generated',
        },
      ),
    ).rejects.toBeInstanceOf(CourseAuthoringAuthorizationError);
    s.denied.clear();
    // The agent may author, generate and release but never archive.
    const agentSave = await s.save(
      head.courseId,
      saved.headRevisionId,
      s.lessons(['a', 'A'], ['c', 'C']),
      s.agent,
      { provenance: 'generated' },
    );
    const view = (
      await s.as(s.guardian, () =>
        s.service.readDraft({
          ...s.guardian,
          courseId: head.courseId,
          revisionId: agentSave.revisionId,
        }),
      )
    ).revision;
    expect(view.authorUserId).toBe(s.agent.actorUserId);
    expect(view.delegatingGuardianUserId).toBe(s.guardian.actorUserId);
    expect(view.delegationId).toBe('delegation-1');
    await expect(
      s.as(s.agent, () =>
        s.service.archive({
          ...s.agent,
          courseId: head.courseId,
          requestKey: s.key(),
        }),
      ),
    ).rejects.toBeInstanceOf(CourseAuthoringAuthorizationError);
    // Delegation to a user outside the tenant is rejected before the host is asked.
    const before = s.calls.length;
    await expect(
      s.as(s.agent, () =>
        s.service.readDraft({
          ...s.agent,
          delegatingGuardianUserId: s.outsider.actorUserId,
          courseId: head.courseId,
        }),
      ),
    ).rejects.toBeInstanceOf(CourseAuthoringAuthorizationError);
    expect(s.calls.length).toBe(before);
    // Every authorizer call carried the transaction executor, not the root handle.
    expect(s.calls.length).toBeGreaterThan(5);
    for (const call of s.calls) {
      expect(call.executor).toBeDefined();
      expect(call.executor).not.toBe(s.db);
      expect(COURSE_AUTHORING_ACTIONS).toContain(call.action);
    }
    const delegated = s.calls.find((c) => c.delegatingGuardianUserId);
    expect(delegated?.delegatingGuardianUserId).toBe(s.guardian.actorUserId);
    for (const call of s.calls.filter((c) => c.delegatingGuardianUserId))
      expect(call.delegationId).toBe('delegation-1');
    for (const call of s.calls.filter((c) => !c.delegatingGuardianUserId))
      expect(call.delegationId).toBeUndefined();
    expect(new Set(s.calls.map((c) => c.operation))).toContain(
      'pin-enrollment',
    );
  });

  it('moves the head by compare and swap and replays request keys', async () => {
    const s = await setup();
    const head = await s.create();
    const request = {
      ...s.guardian,
      courseId: head.courseId,
      expectedHeadRevisionId: head.headRevisionId,
      requestKey: 'save-1',
      draft: s.draft(s.lessons(['a', 'A'])),
    };
    const first = await s.as(s.guardian, () => s.service.saveDraft(request));
    // Identical retry replays even though the head already moved.
    const replay = await s.as(s.guardian, () => s.service.saveDraft(request));
    expect(replay).toEqual(first);
    expect(await s.count('course_revisions')).toBe(2);
    // Same key, different payload.
    await expect(
      s.as(s.guardian, () =>
        s.service.saveDraft({
          ...request,
          draft: s.draft(s.lessons(['a', 'Different'])),
        }),
      ),
    ).rejects.toBeInstanceOf(CourseRequestKeyConflictError);
    // Stale head, with the current head reported by typed error.
    const stale = await s
      .as(s.guardian, () =>
        s.service.saveDraft({
          ...request,
          requestKey: 'save-2',
          draft: s.draft(s.lessons(['a', 'A'], ['b', 'B'])),
        }),
      )
      .catch((error) => error);
    expect(stale).toBeInstanceOf(CourseStaleHeadError);
    expect(stale.code).toBe('stale-head');
    expect(stale.currentHeadRevisionId).toBe(first.revisionId);
    expect(await s.count('course_revisions')).toBe(2);
    // Concurrent writers from the same head: exactly one wins.
    const results = await Promise.allSettled(
      ['x', 'y'].map((label) =>
        s.as(s.guardian, () =>
          s.service.saveDraft({
            ...request,
            expectedHeadRevisionId: first.revisionId,
            requestKey: `race-${label}`,
            draft: s.draft(s.lessons(['a', label])),
          }),
        ),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const lost = results.find(
      (r) => r.status === 'rejected',
    ) as PromiseRejectedResult;
    expect(lost.reason).toBeInstanceOf(CourseStaleHeadError);
    // Missing/invalid keys fail with a typed validation error.
    const invalid = await s
      .as(s.guardian, () => s.service.saveDraft({ ...request, requestKey: '' }))
      .catch((error) => error);
    expect(invalid).toBeInstanceOf(CourseAuthoringError);
    expect(invalid.code).toBe('invalid-request');
    // createCourse replays too.
    const created = await s.as(s.guardian, () =>
      s.service.createCourse({
        ...s.guardian,
        requestKey: 'create-fixed',
        title: 'T',
      }),
    );
    expect(
      await s.as(s.guardian, () =>
        s.service.createCourse({
          ...s.guardian,
          requestKey: 'create-fixed',
          title: 'T',
        }),
      ),
    ).toEqual(created);
    await expect(
      s.as(s.guardian, () =>
        s.service.createCourse({
          ...s.guardian,
          requestKey: 'create-fixed',
          title: 'Other',
        }),
      ),
    ).rejects.toBeInstanceOf(CourseRequestKeyConflictError);
  });

  it('requires a current review of the exact revision to release', async () => {
    const none = await setup({ gate: null });
    const head = await none.create();
    const saved = await none.save(
      head.courseId,
      head.headRevisionId,
      none.lessons(['a', 'A']),
    );
    const missing = await none
      .release(head.courseId, saved.revisionId)
      .catch((error) => error);
    expect(missing).toBeInstanceOf(ReviewGateRequiredError);
    expect(missing.code).toBe('review-gate-required');
    expect(await none.count('course_releases')).toBe(0);

    const s = await setup();
    const h = await s.create();
    const revision = await s.save(
      h.courseId,
      h.headRevisionId,
      s.lessons(['a', 'A']),
    );
    s.gateState.value = { current: false, reason: 'outdated' };
    const outdated = await s
      .release(h.courseId, revision.revisionId)
      .catch((error) => error);
    expect(outdated).toBeInstanceOf(ReviewNotCurrentError);
    expect(outdated.reason).toBe('outdated');
    expect(outdated.code).toBe('review-not-current');
    expect(await s.count('course_releases')).toBe(0);
  });

  it('records the release, its review and materializes per-release immutable lessons', async () => {
    const s = await setup();
    const head = await s.create();
    const one = await s.save(
      head.courseId,
      head.headRevisionId,
      s.lessons(['a', 'Lesson A'], ['b', 'Lesson B']),
    );
    const rel1 = await s.as(s.agent, () =>
      s.service.release({
        ...s.agent,
        courseId: head.courseId,
        revisionId: one.revisionId,
        requestKey: 'rel-1',
      }),
    );
    expect(s.gateCalls).toHaveLength(1);
    const call = s.gateCalls[0] as { executor: unknown; request: unknown };
    expect(call.executor).not.toBe(s.db);
    expect(call.request).toEqual({
      tenantId: s.guardian.tenantId,
      courseId: head.courseId,
      revisionId: one.revisionId,
    });
    expect(rel1).toMatchObject({
      releaseNumber: 1,
      reviewId: 'review-1',
      actorUserId: s.agent.actorUserId,
      delegatingGuardianUserId: s.guardian.actorUserId,
      delegationId: 'delegation-1',
      revisionId: one.revisionId,
    });
    expect(rel1.lessons.map((l) => l.lessonKey)).toEqual(['a', 'b']);
    // Replaying the key returns the same ids; a new key for the same revision conflicts.
    expect(
      await s.as(s.agent, () =>
        s.service.release({
          ...s.agent,
          courseId: head.courseId,
          revisionId: one.revisionId,
          requestKey: 'rel-1',
        }),
      ),
    ).toEqual(rel1);
    await expect(
      s.release(head.courseId, one.revisionId),
    ).rejects.toBeInstanceOf(CourseRevisionAlreadyReleasedError);
    await expect(
      s.as(s.agent, () =>
        s.service.release({
          ...s.agent,
          courseId: head.courseId,
          revisionId: randomUUID(),
          requestKey: 'rel-1',
        }),
      ),
    ).rejects.toBeInstanceOf(CourseRequestKeyConflictError);

    const two = await s.save(
      head.courseId,
      one.headRevisionId,
      s.lessons(['a', 'Lesson A'], ['b', 'Lesson B v2'], ['c', 'Lesson C']),
    );
    const rel2 = await s.release(head.courseId, two.revisionId);
    expect(rel2.releaseNumber).toBe(2);
    // Release rows: distinct courses, sections and lessons per release.
    expect(rel2.releaseCourseId).not.toBe(rel1.releaseCourseId);
    const ids1 = new Map(rel1.lessons.map((l) => [l.lessonKey, l]));
    const ids2 = new Map(rel2.lessons.map((l) => [l.lessonKey, l]));
    for (const key of ['a', 'b'])
      expect(ids2.get(key)?.lessonId).not.toBe(ids1.get(key)?.lessonId);
    expect(ids2.get('c')).toBeDefined();
    for (const lesson of [...rel1.lessons, ...rel2.lessons])
      expect(lesson.lessonId).toMatch(/^[0-9a-f-]{36}$/);
    const lessonRow = async (id: string) =>
      (await s.db.get('lessons', { id })) as Record<string, unknown>;
    expect((await lessonRow(ids1.get('b')?.lessonId)).title).toBe('Lesson B');
    expect((await lessonRow(ids2.get('b')?.lessonId)).title).toBe(
      'Lesson B v2',
    );
    expect((await lessonRow(ids1.get('b')?.lessonId)).external_ref).toContain(
      'authored:b@',
    );
    // Stable identity across versions is retained for progress/reporting.
    const mapping = await s.db.list('released_lessons', { lesson_key: 'b' });
    expect(mapping).toHaveLength(2);
    const section = (await s.db.get('course_sections', {
      id: ids1.get('a')?.sectionId,
    })) as Record<string, unknown>;
    expect(section.course_id).toBe(rel1.releaseCourseId);
    const course = (await s.db.get('courses', {
      id: rel1.releaseCourseId,
    })) as Record<string, unknown>;
    expect(course).toMatchObject({
      source_key: 'authored-release',
      status: 'published',
      license_kind: 'own-work',
      tenant_id: s.guardian.tenantId,
    });
    // Existing LearnerService flows work unchanged on a release.
    const enrollment = await s.enrollOn(rel1.releaseCourseId);
    const lessonsFor = await s.f.as(s.f.parent, () =>
      s.f.service.assignmentLessons({
        ...s.f.parent,
        enrollmentId: String(enrollment.id),
      }),
    );
    expect(lessonsFor.map((l) => l.lesson.title).sort()).toEqual([
      'Lesson A',
      'Lesson B',
    ]);
    // An empty revision cannot be released.
    const empty = await s.create();
    await expect(
      s.release(empty.courseId, empty.headRevisionId),
    ).rejects.toMatchObject({ code: 'invalid-request' });
  });

  it('pins enrollments, upgrades explicitly and auto-upgrades only unstarted lessons', async () => {
    const s = await setup();
    const { head, saved, rel } = await s.released();
    const enrollment = await s.enrollOn(rel.releaseCourseId);
    const enrollmentId = String(enrollment.id);
    const pin = (releaseId: string, key = s.key()) =>
      s.as(s.guardian, () =>
        s.service.pinEnrollment({
          ...s.guardian,
          enrollmentId,
          releaseId,
          requestKey: key,
          policyBasis: 'guardians-only',
        }),
      );
    const upgrade = (releaseId: string, key = s.key()) =>
      s.as(s.guardian, () =>
        s.service.upgradeEnrollment({
          ...s.guardian,
          enrollmentId,
          releaseId,
          requestKey: key,
          policyBasis: 'guardians-only',
        }),
      );
    // Upgrading before pinning, and pinning a foreign enrollment, are rejected.
    await expect(upgrade(rel.id)).rejects.toBeInstanceOf(
      EnrollmentPinConflictError,
    );
    const pinned = await pin(rel.id, 'pin-1');
    expect(pinned).toMatchObject({
      releaseId: rel.id,
      releaseNumber: 1,
      kind: 'initial',
      autoUpgrade: false,
    });
    expect(await pin(rel.id, 'pin-1')).toEqual(pinned);
    await expect(pin(rel.id)).rejects.toBeInstanceOf(
      EnrollmentPinConflictError,
    );
    await expect(
      s.as(s.outsider, () =>
        s.service.pinEnrollment({
          ...s.outsider,
          enrollmentId,
          releaseId: rel.id,
          requestKey: s.key(),
          policyBasis: 'guardians-only',
        }),
      ),
    ).rejects.toBeInstanceOf(CourseAuthoringAuthorizationError);

    // The learner starts lesson A on release 1.
    const lessonA = rel.lessons[0];
    expect(lessonA.lessonKey).toBe('a');
    await s.f.as(s.f.own, () =>
      s.f.service.startLesson({
        ...s.f.own,
        enrollmentId,
        lessonId: lessonA.lessonId,
      }),
    );
    // Release 2 does not move an enrollment that has not opted in.
    const two = await s.save(
      head.courseId,
      saved.headRevisionId,
      s.lessons(['a', 'Lesson A v2'], ['b', 'Lesson B v2'], ['c', 'Lesson C']),
    );
    const rel2 = await s.release(head.courseId, two.revisionId);
    let current = (
      await s.as(s.guardian, () =>
        s.service.getEnrollmentRelease({ ...s.guardian, enrollmentId }),
      )
    ).pin;
    expect(current.releaseId).toBe(rel.id);
    expect(current.history).toHaveLength(1);

    // Opt-in at enrollment level is recorded and applies to future releases.
    const optIn = await s.as(s.guardian, () =>
      s.service.setAutoUpgrade({
        ...s.guardian,
        courseId: head.courseId,
        enrollmentId,
        enabled: true,
        requestKey: 'opt-in',
        policyBasis: 'guardians-only',
      }),
    );
    expect(optIn).toEqual({
      courseId: head.courseId,
      enrollmentId,
      enabled: true,
      policyBasis: 'guardians-only',
    });
    const choices = await s.db.list('course_upgrade_choices', {});
    expect(choices).toHaveLength(1);
    expect(Number(choices[0].enabled)).toBe(1);
    expect(choices[0]).toMatchObject({
      actor_user_id: s.guardian.actorUserId,
      enrollment_id: enrollmentId,
    });
    await expect(
      s.as(s.guardian, () =>
        s.service.setAutoUpgrade({
          ...s.guardian,
          courseId: head.courseId,
          enrollmentId,
          enabled: false,
          requestKey: 'opt-in',
          policyBasis: 'guardians-only',
        }),
      ),
    ).rejects.toBeInstanceOf(CourseRequestKeyConflictError);

    const three = await s.save(
      head.courseId,
      two.headRevisionId,
      s.lessons(
        ['a', 'Lesson A v3'],
        ['b', 'Lesson B v3'],
        ['c', 'Lesson C v3'],
      ),
    );
    const rel3 = await s.release(head.courseId, three.revisionId);
    const auto = await s.as(s.guardian, () =>
      s.service.getEnrollmentRelease({ ...s.guardian, enrollmentId }),
    );
    expect(auto.pin).toMatchObject({
      releaseId: rel3.id,
      releaseNumber: 3,
      kind: 'auto',
      autoUpgrade: true,
    });
    // Each automatic move is recorded with no actor.
    const autoPins = (await s.db.list('enrollment_release_pins', {})).filter(
      (p) => p.kind === 'auto',
    );
    expect(autoPins).toHaveLength(1);
    expect(autoPins[0]).toMatchObject({
      release_id: rel3.id,
      previous_release_id: rel.id,
      actor_user_id: '',
    });
    const by = new Map(auto.lessons.map((l) => [l.lessonKey, l]));
    // Started lesson A stays pinned to release 1; unstarted B and C follow release 3.
    expect(by.get('a')).toMatchObject({
      lessonId: lessonA.lessonId,
      releaseId: rel.id,
      pinnedToOlderRelease: true,
    });
    expect(by.get('b')).toMatchObject({
      releaseId: rel3.id,
      pinnedToOlderRelease: false,
    });
    expect(by.get('c')?.releaseId).toBe(rel3.id);
    // The started lesson's row and the learner's progress are untouched.
    expect(
      (
        (await s.db.get('lessons', { id: lessonA.lessonId })) as Record<
          string,
          unknown
        >
      ).title,
    ).toBe('Lesson A');
    expect(await s.count('lesson_progress')).toBe(1);

    // Explicit upgrade must target a newer release; it moves every lesson.
    await expect(upgrade(rel.id)).rejects.toBeInstanceOf(
      EnrollmentPinConflictError,
    );
    await expect(upgrade(rel3.id)).rejects.toBeInstanceOf(
      EnrollmentPinConflictError,
    );
    // Opting out at enrollment level stops automatic moves.
    await s.as(s.guardian, () =>
      s.service.setAutoUpgrade({
        ...s.guardian,
        courseId: head.courseId,
        enrollmentId,
        enabled: false,
        requestKey: 'opt-out',
        policyBasis: 'guardians-only',
      }),
    );
    const four = await s.save(
      head.courseId,
      three.headRevisionId,
      s.lessons(['a', 'A4'], ['b', 'B4']),
    );
    const rel4 = await s.release(head.courseId, four.revisionId);
    current = (
      await s.as(s.guardian, () =>
        s.service.getEnrollmentRelease({ ...s.guardian, enrollmentId }),
      )
    ).pin;
    expect(current.releaseId).toBe(rel3.id);
    const moved = await upgrade(rel4.id, 'up-1');
    expect(moved).toMatchObject({ releaseId: rel4.id, kind: 'explicit' });
    expect(await upgrade(rel4.id, 'up-1')).toEqual(moved);
    expect(moved.history.map((h) => h.kind)).toEqual([
      'initial',
      'auto',
      'explicit',
    ]);
    const final = await s.as(s.guardian, () =>
      s.service.getEnrollmentRelease({ ...s.guardian, enrollmentId }),
    );
    // The explicit move follows release 4, but started lesson A keeps its row.
    expect(
      Object.fromEntries(final.lessons.map((l) => [l.lessonKey, l.releaseId])),
    ).toEqual({ a: rel.id, b: rel4.id });
    expect(rel2.releaseNumber).toBe(2);
    // The enrollment row itself was never mutated.
    expect(
      (
        (await s.db.get('enrollments', { id: enrollmentId })) as Record<
          string,
          unknown
        >
      ).course_id,
    ).toBe(rel.releaseCourseId);
  });

  it('applies a course-level auto-upgrade opt-in to pinned enrollments', async () => {
    const s = await setup();
    const { head, saved, rel } = await s.released();
    const enrollment = await s.enrollOn(rel.releaseCourseId);
    await s.as(s.guardian, () =>
      s.service.pinEnrollment({
        ...s.guardian,
        enrollmentId: String(enrollment.id),
        releaseId: rel.id,
        requestKey: s.key(),
        policyBasis: 'guardians-only',
      }),
    );
    await s.as(s.guardian, () =>
      s.service.setAutoUpgrade({
        ...s.guardian,
        courseId: head.courseId,
        enabled: true,
        requestKey: 'course-opt-in',
        policyBasis: 'guardians-only',
      }),
    );
    const next = await s.save(
      head.courseId,
      saved.headRevisionId,
      s.lessons(['a', 'A2'], ['b', 'B2']),
    );
    const rel2 = await s.release(head.courseId, next.revisionId);
    const view = await s.as(s.guardian, () =>
      s.service.getEnrollmentRelease({
        ...s.guardian,
        enrollmentId: String(enrollment.id),
      }),
    );
    expect(view.pin.releaseId).toBe(rel2.id);
    expect(view.pin.autoUpgrade).toBe(true);
    // Course-level opt-in cannot be enrollment-targeted at a foreign course.
    await expect(
      s.as(s.guardian, () =>
        s.service.setAutoUpgrade({
          ...s.guardian,
          courseId: String(s.f.course.id),
          enrollmentId: String(enrollment.id),
          enabled: true,
          requestKey: s.key(),
          policyBasis: 'guardians-only',
        }),
      ),
    ).rejects.toBeInstanceOf(CourseNotFoundError);
  });

  describe('automatic upgrades are authorized per learner', () => {
    async function twoLearners() {
      const s = await setup();
      const { head, saved, rel } = await s.released();
      const a = String((await s.enrollOn(rel.releaseCourseId)).id);
      const relB = await withTenant({ tenantId: s.f.own.tenantId }, async () =>
        (await ProfileRelationshipCollection.create({ db: s.db })).create({
          tenantId: s.f.own.tenantId,
          fromProfileId: String(s.f.guardian.profile.id),
          toProfileId: String(s.f.bob.profile.id),
          typeId: String(s.f.guardianType.id),
        }),
      );
      const bobReq = {
        ...s.f.parent,
        learnerId: String(s.f.sibling.id),
        guardianRelationshipId: String(relB.id),
      };
      const bobCurriculum = await s.f.as(bobReq, () =>
        s.f.service.createCurriculum({ ...bobReq, title: 'Bob 2026' }),
      );
      const b = String(
        (
          await s.f.as(bobReq, () =>
            s.f.service.enroll({
              ...bobReq,
              curriculumId: String(bobCurriculum.id),
              courseId: rel.releaseCourseId,
            }),
          )
        ).id,
      );
      const learnerB = String(s.f.sibling.id);
      for (const enrollmentId of [a, b])
        await s.as(s.guardian, () =>
          s.service.pinEnrollment({
            ...s.guardian,
            enrollmentId,
            releaseId: rel.id,
            requestKey: s.key(),
            policyBasis: 'guardians-only',
          }),
        );
      const optIn = (
        actor: CourseAuthoringActor,
        enrollmentId?: string,
        basis = 'guardians-and-agents',
      ) =>
        s.as(actor, () =>
          s.service.setAutoUpgrade({
            ...actor,
            courseId: head.courseId,
            ...(enrollmentId ? { enrollmentId } : {}),
            enabled: true,
            requestKey: s.key(),
            policyBasis: basis,
          }),
        );
      const releaseNext = async () => {
        const next = await s.save(
          head.courseId,
          saved.headRevisionId,
          s.lessons(['a', 'A2'], ['b', 'B2']),
        );
        return s.release(head.courseId, next.revisionId);
      };
      const pinOf = async (enrollmentId: string) => {
        // Reads are not the subject here; lift per-learner denials meanwhile.
        const held = [...s.deniedLearners];
        s.deniedLearners.clear();
        try {
          return (
            await s.as(s.guardian, () =>
              s.service.getEnrollmentRelease({ ...s.guardian, enrollmentId }),
            )
          ).pin;
        } finally {
          for (const id of held) s.deniedLearners.add(id);
        }
      };
      return { s, a, b, learnerB, rel, optIn, releaseNext, pinOf };
    }

    it('skips and records a learner the opt-in actor may not assign, still releasing', async () => {
      const { s, a, b, learnerB, rel, optIn, releaseNext, pinOf } =
        await twoLearners();
      await optIn(s.agent);
      s.deniedLearners.add(learnerB);
      s.calls.length = 0;
      const rel2 = await releaseNext();
      expect((await pinOf(a)).releaseId).toBe(rel2.id);
      const moved = await pinOf(a);
      expect(moved).toMatchObject({
        kind: 'auto',
        policyBasis: 'guardians-and-agents',
      });
      expect(moved.history.at(-1)).toMatchObject({
        optInScope: 'course',
        optInDelegationId: 'delegation-1',
      });
      expect((await pinOf(b)).releaseId).toBe(rel.id);
      const skips = await s.db.list('enrollment_auto_upgrade_skips', {});
      expect(skips).toHaveLength(1);
      expect(skips[0]).toMatchObject({
        enrollment_id: b,
        learner_id: learnerB,
        release_id: rel2.id,
        reason: 'not-authorized',
        policy_basis: 'guardians-and-agents',
        opt_in_actor_user_id: s.agent.actorUserId,
        opt_in_delegating_guardian_user_id: s.guardian.actorUserId,
        opt_in_delegation_id: 'delegation-1',
        opt_in_scope: 'course',
      });
      const autoCalls = s.calls.filter((c) => c.operation === 'auto-upgrade');
      expect(autoCalls).toHaveLength(2);
      for (const call of autoCalls) {
        expect(call.action).toBe('education.course.assign');
        expect(call.actorUserId).toBe(s.agent.actorUserId);
        expect(call.delegatingGuardianUserId).toBe(s.guardian.actorUserId);
        expect(call.delegationId).toBe('delegation-1');
        expect(call.executor).not.toBe(s.db);
      }
      expect(autoCalls.map((c) => c.enrollmentId).sort()).toEqual(
        [a, b].sort(),
      );
    });

    it('skips when the recorded delegation is no longer valid', async () => {
      const { s, a, rel, optIn, releaseNext, pinOf } = await twoLearners();
      await optIn(s.agent, a);
      // The host re-evaluates the delegation: the agent is no longer allowed.
      s.deniedActors.add(s.agent.actorUserId);
      await releaseNext();
      expect((await pinOf(a)).releaseId).toBe(rel.id);
      const skips = await s.db.list('enrollment_auto_upgrade_skips', {});
      expect(skips).toHaveLength(1);
      expect(skips[0]).toMatchObject({
        enrollment_id: a,
        opt_in_scope: 'enrollment',
      });
    });

    it('skips when the authorizer throws and does not block other enrollments', async () => {
      const { s, a, b, rel, optIn, releaseNext, pinOf } = await twoLearners();
      await optIn(s.guardian, a);
      await optIn(s.guardian, b);
      const real = s.service as unknown as { authorizer: unknown };
      const original = real.authorizer as (c: {
        enrollmentId?: string;
        operation: string;
      }) => unknown;
      real.authorizer = (c: { enrollmentId?: string; operation: string }) => {
        if (c.operation === 'auto-upgrade' && c.enrollmentId === a)
          throw new Error('policy store down');
        return original(c);
      };
      const rel2 = await releaseNext();
      expect((await pinOf(a)).releaseId).toBe(rel.id);
      expect((await pinOf(b)).releaseId).toBe(rel2.id);
      expect(await s.count('enrollment_auto_upgrade_skips')).toBe(1);
    });
  });

  describe('assign action and policy basis', () => {
    async function pinned() {
      const s = await setup();
      const { head, saved, rel } = await s.released();
      const enrollmentId = String((await s.enrollOn(rel.releaseCourseId)).id);
      const actors = { guardian: s.guardian, agent: s.agent };
      const pin = (
        actor: CourseAuthoringActor,
        releaseId: string,
        extra: Record<string, unknown> = {},
        key = s.key(),
      ) =>
        s.as(actor, () =>
          s.service.pinEnrollment({
            ...actor,
            enrollmentId,
            releaseId,
            requestKey: key,
            policyBasis: 'guardians-and-agents',
            ...extra,
          }),
        );
      const upgrade = (
        actor: CourseAuthoringActor,
        releaseId: string,
        extra: Record<string, unknown> = {},
        key = s.key(),
      ) =>
        s.as(actor, () =>
          s.service.upgradeEnrollment({
            ...actor,
            enrollmentId,
            releaseId,
            requestKey: key,
            policyBasis: 'guardians-and-agents',
            ...extra,
          }),
        );
      const auto = (
        actor: CourseAuthoringActor,
        extra: Record<string, unknown> = {},
        key = s.key(),
      ) =>
        s.as(actor, () =>
          s.service.setAutoUpgrade({
            ...actor,
            courseId: head.courseId,
            enabled: true,
            requestKey: key,
            policyBasis: 'guardians-and-agents',
            ...extra,
          }),
        );
      const newer = async (from = saved.headRevisionId, title = 'A2') => {
        const next = await s.save(
          head.courseId,
          from,
          s.lessons(['a', title], ['b', 'B2']),
        );
        const made = await s.release(head.courseId, next.revisionId);
        return Object.assign(made, { nextHead: next.headRevisionId });
      };
      return {
        s,
        head,
        saved,
        rel,
        enrollmentId,
        pin,
        upgrade,
        auto,
        newer,
        actors,
      };
    }

    it('keeps release and assign independent grants in both directions', async () => {
      const { s, head, saved, rel, pin, upgrade, auto } = await pinned();
      // Without assign: release still works, every assignment operation is denied.
      s.denied.add('education.course.assign');
      const next = await s.save(
        head.courseId,
        saved.headRevisionId,
        s.lessons(['a', 'A2'], ['b', 'B2']),
      );
      const rel2 = await s.release(head.courseId, next.revisionId);
      await expect(pin(s.guardian, rel.id)).rejects.toBeInstanceOf(
        CourseAuthoringAuthorizationError,
      );
      await expect(auto(s.guardian)).rejects.toBeInstanceOf(
        CourseAuthoringAuthorizationError,
      );
      s.denied.clear();
      await pin(s.guardian, rel.id);
      s.denied.add('education.course.assign');
      await expect(upgrade(s.guardian, rel2.id)).rejects.toBeInstanceOf(
        CourseAuthoringAuthorizationError,
      );
      // Without release: pin/upgrade/auto still work, release is denied.
      s.denied.clear();
      s.denied.add('education.course.release');
      expect((await upgrade(s.guardian, rel2.id)).releaseId).toBe(rel2.id);
      expect((await auto(s.guardian)).enabled).toBe(true);
      const third = await s.save(
        head.courseId,
        next.headRevisionId,
        s.lessons(['a', 'A3']),
      );
      await expect(
        s.release(head.courseId, third.revisionId),
      ).rejects.toBeInstanceOf(CourseAuthoringAuthorizationError);
    });

    it('asks the authorizer for assign with operation, executor and delegating guardian', async () => {
      const { s, head, rel, enrollmentId, pin, upgrade, auto, newer } =
        await pinned();
      const rel2 = await newer();
      s.calls.length = 0;
      await pin(s.agent, rel.id);
      await upgrade(s.agent, rel2.id);
      await auto(s.agent, { enrollmentId });
      const byOperation = new Map(s.calls.map((c) => [c.operation, c]));
      for (const operation of [
        'pin-enrollment',
        'upgrade-enrollment',
        'set-auto-upgrade',
      ] as const) {
        const call = byOperation.get(operation);
        expect(call?.action).toBe('education.course.assign');
        expect(call?.executor).toBeDefined();
        expect(call?.executor).not.toBe(s.db);
        expect(call?.delegatingGuardianUserId).toBe(s.guardian.actorUserId);
        expect(call?.delegationId).toBe('delegation-1');
        expect(call?.actorUserId).toBe(s.agent.actorUserId);
      }
      expect(
        s.calls.some(
          (c) =>
            c.operation !== 'release' &&
            c.action === 'education.course.release' &&
            [
              'pin-enrollment',
              'upgrade-enrollment',
              'set-auto-upgrade',
            ].includes(c.operation),
        ),
      ).toBe(false);
      expect(head.courseId).toBeTruthy();
    });

    it('requires a bounded policy basis on pin, upgrade and auto-upgrade', async () => {
      const { s, rel, enrollmentId, pin, upgrade, auto, newer } =
        await pinned();
      const rel2 = await newer();
      for (const bad of [undefined, '', '   ', 'x'.repeat(201), 5]) {
        await expect(
          pin(s.guardian, rel.id, { policyBasis: bad }),
        ).rejects.toMatchObject({ code: 'invalid-request' });
        await expect(
          auto(s.guardian, { policyBasis: bad }),
        ).rejects.toMatchObject({ code: 'invalid-request' });
        await expect(
          auto(s.guardian, { enrollmentId, policyBasis: bad }),
        ).rejects.toMatchObject({ code: 'invalid-request' });
      }
      await pin(s.guardian, rel.id);
      for (const bad of [undefined, '', 'x'.repeat(201)])
        await expect(
          upgrade(s.guardian, rel2.id, { policyBasis: bad }),
        ).rejects.toMatchObject({ code: 'invalid-request' });
      expect(await s.count('enrollment_release_pins')).toBe(1);
      expect(await s.count('course_upgrade_choices')).toBe(0);
    });

    it('records the basis on rows, views and automatic moves, with replay semantics', async () => {
      const { s, head, rel, enrollmentId, pin, upgrade, auto, newer } =
        await pinned();
      const first = await pin(
        s.agent,
        rel.id,
        { policyBasis: 'learner-may-ask' },
        'pin-key',
      );
      expect(first.policyBasis).toBe('learner-may-ask');
      expect(first.history[0]).toMatchObject({
        policyBasis: 'learner-may-ask',
        actorUserId: s.agent.actorUserId,
        delegatingGuardianUserId: s.guardian.actorUserId,
        delegationId: 'delegation-1',
      });
      // Same basis replays to the same result; a changed basis is a conflict.
      expect(
        await pin(
          s.agent,
          rel.id,
          { policyBasis: 'learner-may-ask' },
          'pin-key',
        ),
      ).toEqual(first);
      await expect(
        pin(s.agent, rel.id, { policyBasis: 'guardians-only' }, 'pin-key'),
      ).rejects.toBeInstanceOf(CourseRequestKeyConflictError);
      // The same key under a different delegation is a conflict, never a replay.
      await expect(
        pin(
          { ...s.agent, delegationId: 'delegation-2' },
          rel.id,
          { policyBasis: 'learner-may-ask' },
          'pin-key',
        ),
      ).rejects.toBeInstanceOf(CourseRequestKeyConflictError);
      expect(await s.count('enrollment_release_pins')).toBe(1);

      // Enrollment-level opt-in records its basis and the automatic move copies it.
      const opt = await auto(
        s.agent,
        { enrollmentId, policyBasis: 'guardians-and-agents' },
        'opt-key',
      );
      expect(opt.policyBasis).toBe('guardians-and-agents');
      expect(
        await auto(
          s.agent,
          { enrollmentId, policyBasis: 'guardians-and-agents' },
          'opt-key',
        ),
      ).toEqual(opt);
      await expect(
        auto(
          s.agent,
          { enrollmentId, policyBasis: 'guardians-only' },
          'opt-key',
        ),
      ).rejects.toBeInstanceOf(CourseRequestKeyConflictError);
      const choice = (await s.db.list('course_upgrade_choices', {}))[0];
      expect(choice).toMatchObject({
        policy_basis: 'guardians-and-agents',
        delegating_guardian_user_id: s.guardian.actorUserId,
      });
      const rel2 = await newer();
      const moved = await s.as(s.guardian, () =>
        s.service.getEnrollmentRelease({ ...s.guardian, enrollmentId }),
      );
      expect(moved.pin).toMatchObject({
        releaseId: rel2.id,
        kind: 'auto',
        policyBasis: 'guardians-and-agents',
      });
      expect(moved.pin.history.at(-1)).toMatchObject({
        kind: 'auto',
        actorUserId: null,
        policyBasis: 'guardians-and-agents',
      });
    });

    it('records the basis on explicit upgrades and course-level automatic moves', async () => {
      const { s, enrollmentId, rel, pin, upgrade, auto, newer } =
        await pinned();
      await pin(s.guardian, rel.id, { policyBasis: 'guardians-only' });
      const rel2 = await newer();
      const up = await upgrade(
        s.agent,
        rel2.id,
        { policyBasis: 'learner-may-ask' },
        'up-key',
      );
      expect(up).toMatchObject({
        kind: 'explicit',
        policyBasis: 'learner-may-ask',
      });
      expect(up.history.map((h) => h.policyBasis)).toEqual([
        'guardians-only',
        'learner-may-ask',
      ]);
      expect(
        await upgrade(
          s.agent,
          rel2.id,
          { policyBasis: 'learner-may-ask' },
          'up-key',
        ),
      ).toEqual(up);
      await expect(
        upgrade(s.agent, rel2.id, { policyBasis: 'guardians-only' }, 'up-key'),
      ).rejects.toBeInstanceOf(CourseRequestKeyConflictError);
      // A course-level opt-in governs the next automatic move with its basis.
      const courseOpt = await auto(s.guardian, {
        policyBasis: 'learner-may-ask',
      });
      expect(courseOpt.policyBasis).toBe('learner-may-ask');
      const rel3 = await newer(rel2.nextHead, 'A3');
      const moved = await s.as(s.guardian, () =>
        s.service.getEnrollmentRelease({ ...s.guardian, enrollmentId }),
      );
      expect(moved.pin).toMatchObject({
        releaseId: rel3.id,
        kind: 'auto',
        policyBasis: 'learner-may-ask',
      });
    });
  });

  it('archives and unarchives reversibly without cascading', async () => {
    const s = await setup();
    const { head, saved, rel } = await s.released();
    const enrollment = await s.enrollOn(rel.releaseCourseId);
    const enrollmentId = String(enrollment.id);
    await s.as(s.guardian, () =>
      s.service.pinEnrollment({
        ...s.guardian,
        enrollmentId,
        releaseId: rel.id,
        requestKey: s.key(),
        policyBasis: 'guardians-only',
      }),
    );
    const lessonA = rel.lessons[0];
    await s.f.as(s.f.own, () =>
      s.f.service.startLesson({
        ...s.f.own,
        enrollmentId,
        lessonId: lessonA.lessonId,
      }),
    );
    const snapshot = async () => ({
      enrollments: await s.db.list('enrollments', {}),
      progress: await s.db.list('lesson_progress', {}),
      pins: await s.count('enrollment_release_pins'),
      lessons: await s.db.list('lessons', {}),
    });
    const before = await snapshot();
    const archive = () =>
      s.as(s.guardian, () =>
        s.service.archive({
          ...s.guardian,
          courseId: head.courseId,
          requestKey: 'arch-1',
        }),
      );
    const archived = await archive();
    expect(archived.state).toBe('archived');
    expect(await archive()).toEqual(archived);
    expect(await snapshot()).toEqual(before);
    expect(
      (
        (await s.db.get('courses', { id: rel.releaseCourseId })) as Record<
          string,
          unknown
        >
      ).status,
    ).toBe('archived');
    // No new assignments or releases while archived; existing learners continue.
    const other = await s
      .release(head.courseId, saved.revisionId)
      .catch((e) => e);
    expect(other).toBeInstanceOf(CourseAuthoringError);
    await expect(
      s
        .save(head.courseId, saved.headRevisionId, s.lessons(['a', 'A2']))
        .then(() => s.release(head.courseId, saved.revisionId)),
    ).rejects.toBeInstanceOf(CourseArchivedError);
    await expect(
      s.as(s.guardian, () =>
        s.service.upgradeEnrollment({
          ...s.guardian,
          enrollmentId,
          releaseId: rel.id,
          requestKey: s.key(),
          policyBasis: 'guardians-only',
        }),
      ),
    ).rejects.toBeInstanceOf(CourseArchivedError);
    expect(
      await s.f.as(s.f.own, () =>
        s.f.service.assignmentLessons({ ...s.f.own, enrollmentId }),
      ),
    ).toHaveLength(2);
    const restored = await s.as(s.guardian, () =>
      s.service.unarchive({
        ...s.guardian,
        courseId: head.courseId,
        requestKey: 'unarch-1',
      }),
    );
    expect(restored.state).toBe('released');
    expect(
      (
        (await s.db.get('courses', { id: rel.releaseCourseId })) as Record<
          string,
          unknown
        >
      ).status,
    ).toBe('published');
    expect((await snapshot()).progress).toEqual(before.progress);
    expect(await s.count('course_archive_decisions')).toBe(2);
    // Archive keys replay; reusing a key for the opposite action conflicts.
    await expect(
      s.as(s.guardian, () =>
        s.service.archive({
          ...s.guardian,
          courseId: head.courseId,
          requestKey: 'unarch-1',
        }),
      ),
    ).rejects.toBeInstanceOf(CourseRequestKeyConflictError);
  });

  it('discards only unreferenced drafts and leaves a tombstone', async () => {
    const s = await setup();
    const head = await s.create();
    const one = await s.save(
      head.courseId,
      head.headRevisionId,
      s.lessons(['a', 'A']),
    );
    const discard = (courseId: string, requestKey = s.key()) =>
      s.as(s.guardian, () =>
        s.service.discardDraft({
          ...s.guardian,
          courseId,
          requestKey,
          reason: 'oops',
        }),
      );
    const state = await discard(head.courseId, 'discard-1');
    expect(state.state).toBe('discarded');
    expect(await discard(head.courseId, 'discard-1')).toEqual(state);
    const tombstone = await s.db.get('course_discard_tombstones', {
      course_id: head.courseId,
    });
    expect(tombstone).toMatchObject({
      reason: 'oops',
      head_revision_id: one.revisionId,
      revision_count: 2,
      actor_user_id: s.guardian.actorUserId,
    });
    await expect(
      s.save(head.courseId, one.headRevisionId, s.lessons(['a', 'A'])),
    ).rejects.toBeInstanceOf(CourseDiscardedError);
    await expect(
      s.as(s.guardian, () =>
        s.service.readDraft({ ...s.guardian, courseId: head.courseId }),
      ),
    ).rejects.toBeInstanceOf(CourseDiscardedError);
    // History is retained for the retention operation.
    expect(await s.count('course_revisions')).toBe(2);

    // Released course: refused.
    const { head: releasedHead } = await s.released();
    const refused = await discard(releasedHead.courseId).catch((e) => e);
    expect(refused).toBeInstanceOf(CourseDiscardRefusedError);
    expect(refused.references).toContain('release');
    expect(refused.code).toBe('discard-refused');
    // Enrollment directly on the identity course: refused.
    const enrolled = await s.create();
    await s.enrollOn(enrolled.courseId);
    const byEnrollment = await discard(enrolled.courseId).catch((e) => e);
    expect(byEnrollment.references).toEqual(['enrollment']);
    // A review/variant guard: refused.
    const g = await setup({ guard: true });
    const gh = await g.create();
    const guarded = await g
      .as(g.guardian, () =>
        g.service.discardDraft({
          ...g.guardian,
          courseId: gh.courseId,
          requestKey: g.key(),
        }),
      )
      .catch((e) => e);
    expect(guarded).toBeInstanceOf(CourseDiscardRefusedError);
    expect(guarded.references).toEqual(['review']);
    expect(await g.count('course_discard_tombstones')).toBe(0);
  });

  it('applies the most restrictive licence and excludes personal-use courses from group sharing', async () => {
    expect(mostRestrictiveLicense([])).toBe('own-work');
    expect(
      mostRestrictiveLicense([
        'own-work',
        'open-license',
        'licensed-for-sharing',
      ]),
    ).toBe('licensed-for-sharing');
    expect(
      mostRestrictiveLicense([
        'licensed-for-sharing',
        'personal-use-copy',
        'own-work',
      ]),
    ).toBe('personal-use-copy');
    const s = await setup();
    const head = await s.create();
    const withLicences = (personal: boolean) => [
      {
        sectionKey: 'u',
        title: 'U',
        lessons: [
          { lessonKey: 'a', title: 'A', licenseKind: 'open-license' as const },
          {
            lessonKey: 'b',
            title: 'B',
            licenseKind: personal
              ? ('personal-use-copy' as const)
              : ('own-work' as const),
          },
        ],
      },
    ];
    const open = await s.save(
      head.courseId,
      head.headRevisionId,
      withLicences(false),
    );
    let state = await s.as(s.guardian, () =>
      s.service.getCourse({ ...s.guardian, courseId: head.courseId }),
    );
    expect(state).toMatchObject({
      licenseKind: 'open-license',
      groupShareable: true,
    });
    const personal = await s.save(
      head.courseId,
      open.headRevisionId,
      withLicences(true),
    );
    state = await s.as(s.guardian, () =>
      s.service.getCourse({ ...s.guardian, courseId: head.courseId }),
    );
    expect(state).toMatchObject({
      licenseKind: 'personal-use-copy',
      groupShareable: false,
    });
    const rel = await s.release(head.courseId, personal.revisionId);
    const row = (await s.db.get('courses', {
      id: rel.releaseCourseId,
    })) as Record<string, unknown>;
    // The existing personal-use rule still holds: never published.
    expect(row).toMatchObject({
      license_kind: 'personal-use-copy',
      status: 'draft',
    });
    expect(
      isAuthoredReleaseGroupShareable({
        sourceKey: 'authored-release',
        licenseKind: 'personal-use-copy',
      }),
    ).toBe(false);
    // Group sharing policy excludes it; ordinary courses and workbook scaffolds are untouched.
    const policy: GroupSharingPolicyV1 = {
      schemaVersion: 1,
      historyFrom: '2000-01-01T00:00:00.000Z',
      courseIds: { mode: 'all' },
      subjects: { mode: 'all' },
      parentReviewedOnly: false,
      commentVisibility: 'parent-only',
      shareWork: true,
      shareMedia: true,
      shareFeedback: true,
      shareProgress: true,
    };
    const facts = {
      capturedAt: '2026-01-01T00:00:00.000Z',
      courseId: rel.releaseCourseId,
      subject: null,
      parentReviewed: true,
    };
    expect(
      evaluateGroupSharingPolicy(policy, { ...facts, courseShareable: false }),
    ).toMatchObject({
      eligible: false,
      work: false,
      progress: false,
      reasons: ['course-private'],
    });
    expect(evaluateGroupSharingPolicy(policy, facts).eligible).toBe(true);
    // Removing the personal-use material and releasing again restores shareability.
    // A restated looser licence on the same lessonKey does not lift it.
    const restated = await s.save(
      head.courseId,
      personal.headRevisionId,
      withLicences(false),
    );
    expect(
      (
        await s.as(s.guardian, () =>
          s.service.getCourse({ ...s.guardian, courseId: head.courseId }),
        )
      ).licenseKind,
    ).toBe('personal-use-copy');
    // Removing the restricted lesson is what lifts it.
    const cleaned = await s.save(head.courseId, restated.headRevisionId, [
      {
        sectionKey: 'u',
        title: 'U',
        lessons: [
          { lessonKey: 'a', title: 'A', licenseKind: 'open-license' as const },
        ],
      },
    ]);
    const rel2 = await s.release(head.courseId, cleaned.revisionId);
    expect(
      (
        (await s.db.get('courses', { id: rel2.releaseCourseId })) as Record<
          string,
          unknown
        >
      ).license_kind,
    ).toBe('open-license');
  });

  it('keeps a lesson licence across revisions of the same lessonKey', async () => {
    const s = await setup();
    const head = await s.create();
    const lessonsWith = (licenseKind?: 'own-work' | 'personal-use-copy') => [
      {
        sectionKey: 'u',
        title: 'U',
        lessons: [
          {
            lessonKey: 'a',
            title: 'A',
            body: 'Purchased workbook text',
            ...(licenseKind ? { licenseKind } : {}),
          },
          { lessonKey: 'b', title: 'B' },
        ],
      },
    ];
    const state = async () =>
      s.as(s.guardian, () =>
        s.service.getCourse({ ...s.guardian, courseId: head.courseId }),
      );
    const one = await s.save(
      head.courseId,
      head.headRevisionId,
      lessonsWith('personal-use-copy'),
    );
    // Omitting the licence on a re-save inherits it; the default is for new keys only.
    const two = await s.save(head.courseId, one.headRevisionId, lessonsWith());
    expect(await state()).toMatchObject({
      licenseKind: 'personal-use-copy',
      groupShareable: false,
    });
    // Explicitly stating a looser licence does not loosen it.
    const three = await s.save(
      head.courseId,
      two.headRevisionId,
      lessonsWith('own-work'),
    );
    expect(await state()).toMatchObject({ licenseKind: 'personal-use-copy' });
    const rel = await s.release(head.courseId, three.revisionId);
    expect(
      await s.db.get('courses', { id: rel.releaseCourseId }),
    ).toMatchObject({ license_kind: 'personal-use-copy', status: 'draft' });
    // Removing the lesson lifts it.
    await s.save(head.courseId, three.headRevisionId, s.lessons(['b', 'B']));
    expect(await state()).toMatchObject({
      licenseKind: 'own-work',
      groupShareable: true,
    });
  });

  it('keeps a restricted lesson licence across rename, omitted key and remove-then-re-add', async () => {
    const s = await setup();
    const head = await s.create();
    const body = 'Purchased workbook text';
    const state = (courseId: string) =>
      s.as(s.guardian, () => s.service.getCourse({ ...s.guardian, courseId }));
    const one = await s.save(head.courseId, head.headRevisionId, [
      {
        sectionKey: 'u',
        title: 'U',
        lessons: [
          {
            lessonKey: 'a',
            title: 'A',
            body,
            licenseKind: 'personal-use-copy',
          },
        ],
      },
    ] as never);
    // Rename the key with identical content and no licence.
    const renamed = await s.save(head.courseId, one.headRevisionId, [
      {
        sectionKey: 'u',
        title: 'U',
        lessons: [{ lessonKey: 'z', title: 'A', body }],
      },
    ] as never);
    expect((await state(head.courseId)).licenseKind).toBe('personal-use-copy');
    // An omitted (auto-derived) key.
    const derived = await s.save(head.courseId, renamed.headRevisionId, [
      { sectionKey: 'u', title: 'U', lessons: [{ title: 'A', body }] },
    ] as never);
    expect((await state(head.courseId)).licenseKind).toBe('personal-use-copy');
    // Remove in one revision, then re-add under the same key later.
    const removed = await s.save(
      head.courseId,
      derived.headRevisionId,
      s.lessons(['b', 'B']),
    );
    expect(await state(head.courseId)).toMatchObject({
      licenseKind: 'own-work',
    });
    await s.save(head.courseId, removed.headRevisionId, [
      {
        sectionKey: 'u',
        title: 'U',
        lessons: [
          { lessonKey: 'a', title: 'A again' },
          { lessonKey: 'z', title: 'Different title', body },
        ],
      },
    ] as never);
    expect(await state(head.courseId)).toMatchObject({
      licenseKind: 'personal-use-copy',
      groupShareable: false,
    });
    // A novel lesson with new content still defaults to own-work.
    const fresh = await s.create();
    await s.save(fresh.courseId, fresh.headRevisionId, [
      {
        sectionKey: 'u',
        title: 'U',
        lessons: [
          { lessonKey: 'n', title: 'N', body: 'Entirely original text' },
        ],
      },
    ] as never);
    expect((await state(fresh.courseId)).licenseKind).toBe('own-work');
  });

  it('folds a reused asset licence across every revision regardless of row order', async () => {
    const port: CourseMaterialCopyPort = {
      async copy(executor, request) {
        const user = (await executor.get('users', {
          id: request.actorUserId,
        })) as Record<string, string>;
        const id = randomUUID();
        await withPrivateAssetAccess(
          {
            tenantId: request.tenantId,
            actorUserId: request.actorUserId,
            ownerProfileId: user.profile_id,
            assetIds: [id],
          },
          async () =>
            (await AssetCollection.create({ db: executor })).create({
              id,
              tenantId: request.tenantId,
              name: 'copy',
              accessMode: 'private',
              ownerProfileId: user.profile_id,
              sourceUri: `file:///education/${id}.pdf`,
            }),
        );
        return { assetId: id };
      },
    };
    for (const reverse of [false, true]) {
      const s = await setup({ copy: port });
      if (reverse) {
        const list = s.db.list.bind(s.db);
        s.db.list = (async (table: string, ...rest: unknown[]) => {
          const rows = await (list as (...a: unknown[]) => Promise<unknown[]>)(
            table,
            ...rest,
          );
          return table === 'lesson_revisions' ? [...rows].reverse() : rows;
        }) as typeof s.db.list;
      }
      const head = await s.create();
      const withMaterial = (material: Record<string, unknown>) =>
        [
          {
            sectionKey: 'u',
            title: 'U',
            lessons: [
              {
                lessonKey: 'a',
                title: 'Worksheet',
                lessonType: 'worksheet' as const,
                materials: [material],
              },
            ],
          },
        ] as CourseDraftInput['sections'];
      // Older, looser: uploaded and explicitly stated own-work.
      const one = await s.save(
        head.courseId,
        head.headRevisionId,
        withMaterial({
          source: { kind: 'ingestion-item', ref: 'i' },
          relationship: 'printable',
          licenseKind: 'own-work',
        }),
      );
      const assetId = (
        await s.as(s.guardian, () =>
          s.service.readDraft({ ...s.guardian, courseId: head.courseId }),
        )
      ).revision.sections[0].lessons[0].materials[0].assetId;
      // Tightened later, then reused with the licence omitted.
      const two = await s.save(
        head.courseId,
        one.headRevisionId,
        withMaterial({
          assetId,
          relationship: 'printable',
          licenseKind: 'personal-use-copy',
        }),
      );
      const three = await s.save(
        head.courseId,
        two.headRevisionId,
        withMaterial({ assetId, relationship: 'printable' }),
      );
      const revision = (
        await s.as(s.guardian, () =>
          s.service.readDraft({
            ...s.guardian,
            courseId: head.courseId,
            revisionId: three.revisionId,
          }),
        )
      ).revision;
      expect(revision.sections[0].lessons[0].materials[0].licenseKind).toBe(
        'personal-use-copy',
      );
      expect(revision.licenseKind).toBe('personal-use-copy');
    }
  });

  it('copies uploaded materials to education-owned assets with provenance', async () => {
    const copies: unknown[] = [];
    let sourceExpired = false;
    const port: CourseMaterialCopyPort = {
      async copy(executor, request) {
        copies.push({ executor, request });
        if (sourceExpired) throw new Error('source expired');
        const user = (await executor.get('users', {
          id: request.actorUserId,
        })) as Record<string, string>;
        const id = randomUUID();
        const scope = {
          tenantId: request.tenantId,
          actorUserId: request.actorUserId,
          ownerProfileId: user.profile_id,
          assetIds: [id],
        };
        await withPrivateAssetAccess(scope, async () =>
          (await AssetCollection.create({ db: executor })).create({
            id,
            tenantId: request.tenantId,
            name: `copy of ${request.source.ref}`,
            accessMode: 'private',
            ownerProfileId: user.profile_id,
            sourceUri: `file:///education/${id}.pdf`,
          }),
        );
        return { assetId: id };
      },
    };
    const s = await setup({ copy: port });
    const head = await s.create();
    const withMaterial = (material: Record<string, unknown>) => [
      {
        sectionKey: 'u',
        title: 'U',
        lessons: [
          {
            lessonKey: 'a',
            title: 'Worksheet',
            lessonType: 'worksheet' as const,
            materials: [material],
          },
        ],
      },
    ];
    const request = {
      ...s.guardian,
      courseId: head.courseId,
      expectedHeadRevisionId: head.headRevisionId,
      requestKey: 'with-material',
      draft: s.draft(
        withMaterial({
          source: { kind: 'ingestion-item', ref: 'item-1' },
          relationship: 'printable',
        }) as CourseDraftInput['sections'],
      ),
    };
    const one = await s.as(s.guardian, () => s.service.saveDraft(request));
    expect(copies).toHaveLength(1);
    expect((copies[0] as { executor: unknown }).executor).not.toBe(s.db);
    // A replay never copies again.
    await s.as(s.guardian, () => s.service.saveDraft(request));
    expect(copies).toHaveLength(1);
    const revision = (
      await s.as(s.guardian, () =>
        s.service.readDraft({ ...s.guardian, courseId: head.courseId }),
      )
    ).revision;
    const [material] = revision.sections[0].lessons[0].materials;
    expect(material.provenance.source).toEqual({
      kind: 'ingestion-item',
      ref: 'item-1',
    });
    expect(material.provenance.copiedByUserId).toBe(s.guardian.actorUserId);
    // An uploaded original defaults to the most restrictive licence.
    expect(material.licenseKind).toBe('personal-use-copy');
    expect(revision.licenseKind).toBe('personal-use-copy');
    const asset = (await s.db.get('assets', {
      id: material.assetId,
    })) as Record<string, unknown>;
    expect(asset.tenant_id).toBe(s.guardian.tenantId);
    // The original expires; the owned copy and a later revision remain usable.
    sourceExpired = true;
    const two = await s.save(
      head.courseId,
      one.headRevisionId,
      withMaterial({
        assetId: material.assetId,
        relationship: 'printable',
      }) as CourseDraftInput['sections'],
    );
    expect(two.version).toBe(3);
    // Reusing an asset id the course does not own is refused.
    await expect(
      s.save(
        head.courseId,
        two.headRevisionId,
        withMaterial({
          assetId: randomUUID(),
          relationship: 'printable',
        }) as CourseDraftInput['sections'],
      ),
    ).rejects.toBeInstanceOf(CourseMaterialCopyError);
    // The release links the owned private asset to its immutable lesson.
    const rel = await s.release(head.courseId, two.revisionId);
    const links = await s.db.list('lesson_assets', {});
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      asset_id: material.assetId,
      lesson_id: rel.lessons[0].lessonId,
      relationship: 'printable',
    });
    // Re-saving by asset id without restating a licence keeps personal-use.
    const reused = (
      await s.as(s.guardian, () =>
        s.service.readDraft({
          ...s.guardian,
          courseId: head.courseId,
          revisionId: two.revisionId,
        }),
      )
    ).revision;
    expect(reused.sections[0].lessons[0].materials[0].licenseKind).toBe(
      'personal-use-copy',
    );
    expect(reused.sections[0].lessons[0].licenseKind).toBe('personal-use-copy');
    expect(reused.licenseKind).toBe('personal-use-copy');
    expect(
      (await s.db.get('courses', { id: rel.releaseCourseId }))?.status,
    ).toBe('draft');
    expect(
      (
        await s.as(s.guardian, () =>
          s.service.getCourse({ ...s.guardian, courseId: head.courseId }),
        )
      ).groupShareable,
    ).toBe(false);
    expect(
      (await s.db.get('assets', { id: material.assetId }))?.access_mode,
    ).toBe('private');
    // Explicitly stating a looser licence on reuse does not loosen it.
    const stated = await s.save(
      head.courseId,
      two.headRevisionId,
      withMaterial({
        assetId: material.assetId,
        relationship: 'printable',
        licenseKind: 'own-work',
      }) as CourseDraftInput['sections'],
    );
    const statedRevision = (
      await s.as(s.guardian, () =>
        s.service.readDraft({
          ...s.guardian,
          courseId: head.courseId,
          revisionId: stated.revisionId,
        }),
      )
    ).revision;
    expect(statedRevision.licenseKind).toBe('personal-use-copy');
    expect(statedRevision.sections[0].lessons[0].materials[0].licenseKind).toBe(
      'personal-use-copy',
    );
    // Removing the material is the way to lift the restriction.
    const removed = await s.save(
      head.courseId,
      stated.headRevisionId,
      s.lessons(['a', 'Worksheet']),
    );
    expect(
      (
        await s.as(s.guardian, () =>
          s.service.readDraft({
            ...s.guardian,
            courseId: head.courseId,
            revisionId: removed.revisionId,
          }),
        )
      ).revision.licenseKind,
    ).toBe('own-work');
    // Without a configured port, uploaded sources cannot be accepted.
    const bare = await setup();
    const bareHead = await bare.create();
    await expect(
      bare.save(
        bareHead.courseId,
        bareHead.headRevisionId,
        withMaterial({
          source: { kind: 'ingestion-item', ref: 'x' },
          relationship: 'printable',
        }) as CourseDraftInput['sections'],
      ),
    ).rejects.toBeInstanceOf(CourseMaterialCopyError);
    // A port returning a foreign or missing asset is refused.
    const bad = await setup({
      copy: { copy: async () => ({ assetId: randomUUID() }) },
    });
    const badHead = await bad.create();
    await expect(
      bad.save(
        badHead.courseId,
        badHead.headRevisionId,
        withMaterial({
          source: { kind: 'ingestion-item', ref: 'x' },
          relationship: 'printable',
        }) as CourseDraftInput['sections'],
      ),
    ).rejects.toBeInstanceOf(CourseMaterialCopyError);
    expect(await bad.count('course_revisions')).toBe(1);
  });

  it('ships the new models as an additive manifest diff', async () => {
    const db = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      classes: learnerClasses,
    });
    opened.push(db);
    const schemas = Object.fromEntries(
      authoringTables.map((name) => {
        const schema = ObjectRegistry.getSchema(name);
        if (!schema) throw new Error(`Missing schema ${name}`);
        return [schema.tableName, schema];
      }),
    );
    const diff = await new SchemaComparer(db, { engineHint: 'sqlite' }).compare(
      schemas,
    );
    expect(diff.added_tables.map((t) => t.tableName).sort()).toEqual(
      Object.keys(schemas).sort(),
    );
    expect(diff.modified_tables ?? []).toEqual([]);
    const generated = new MigrationGenerator({
      engine: 'sqlite',
    }).generateFromDiff(diff, { name: 'course_authoring' });
    const migration = createMigrationDefinition(
      '20261030_course_authoring',
      generated.up,
      generated.down,
      { packageName: '@happyvertical/smrt-education', version: '0.57.42' },
    );
    const applied = await new MigrationTracker({
      db,
      engineHint: 'sqlite',
      useConcurrentIndexes: false,
    }).applyAll([migration], { postgresSafe: false });
    expect(applied.every((r) => r.success)).toBe(true);
    const second = await new SchemaComparer(db, {
      engineHint: 'sqlite',
    }).compare(schemas);
    expect(second.added_tables).toEqual([]);
    expect(
      getSQLFromDiff(second).filter((value) => !value.startsWith('--')),
    ).toEqual([]);
    // Existing tables are not altered by the additive migration.
    expect(JSON.stringify(generated.up)).not.toMatch(
      /ALTER TABLE "?(enrollments|lessons|courses)/i,
    );
  });
});
