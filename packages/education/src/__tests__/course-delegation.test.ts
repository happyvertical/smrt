import { randomUUID } from 'node:crypto';
import { getTestDatabase } from '@happyvertical/smrt-core';
import { ProfileRelationshipCollection } from '@happyvertical/smrt-profiles';
import {
  disableTenancy,
  enableTenancy,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { CourseCollection } from '../collections.js';
import {
  COURSE_AUTHORING_ACTIONS,
  type CourseAuthoringActor,
  CourseAuthoringAuthorizationError,
  type CourseAuthoringAuthorizer,
  CourseAuthoringValidationError,
  CourseGenerationReviewService,
  CourseRequestKeyConflictError,
  LearnerAuthorizationError,
  type LearnerAuthorizer,
  LearnerService,
} from '../index.js';
import { learnerClasses, learnerFixture } from './learner-workflows.js';

/*
 * Behavior-to-test matrix (delegated agent actor and delegation id, #4514 item E):
 *  agent enrolls when host allows + guardian relationship live ... 'enrolls for the delegating guardian'
 *  host denies ..................................................... 'refuses when the host denies'
 *  relationship missing/revoked/other learner/agent's own/inactive
 *    guardian/foreign tenant ....................................... 'refuses without a live guardian relationship'
 *  agent == guardian ............................................... 'refuses an agent that is its own guardian'
 *  delegationId without guardian and the reverse, bad shapes ....... 'validates the delegation as a unit'
 *  delegation grants nothing outside enroll ......................... 'never grants other learner authority'
 *  authorizer gets delegationId on every course action, the
 *    per-enrollment auto-upgrade call, and rows record it .......... 'passes and records the delegation id everywhere'
 *  replay with a different delegationId conflicts .................. 'treats a different delegation id as a request-key conflict'
 *  plain guardian actor unchanged ................................. 'enrolls for the delegating guardian', replay test
 *  additive diff ................................................... course-authoring.test.ts additive manifest diff
 */
const classes = [
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
  'LearningObjective',
  'LearningObjectiveRevision',
  'Question',
  'QuestionRevision',
  'QuestionResponse',
  'CourseGenerationJob',
  'CourseGenerationEvent',
  'CourseProposal',
  'CourseProposalDecision',
  'CourseReview',
  'CourseReviewFinding',
  'CourseReviewOutdatedMarker',
  'CourseFindingResolution',
];

beforeAll(() => enableTenancy());
afterAll(() => disableTenancy());
const opened: DatabaseInterface[] = [];
afterEach(async () => {
  for (const db of opened.splice(0)) await db.close?.();
});

type Call = Parameters<CourseAuthoringAuthorizer>[0];
type LearnerCall = Parameters<LearnerAuthorizer>[0];

async function setup() {
  const db = await getTestDatabase({
    type: 'sqlite',
    url: ':memory:',
    classes,
  });
  opened.push(db);
  const f = await learnerFixture(db);
  const tenantId = f.own.tenantId;
  const guardianId = f.parent.actorUserId;
  const agentId = String(f.bob.user.id);
  const learnerCalls: LearnerCall[] = [];
  const deniedAgents = new Set<string>();
  const learners = new LearnerService(
    db,
    (call) => {
      learnerCalls.push(call);
      return (
        !deniedAgents.has(call.actorUserId) &&
        (call.own || call.relationshipTypeId === f.guardianType.id)
      );
    },
    () => true,
  );
  const courses = await CourseCollection.create({ db });
  const catalogCourse = await courses.create({
    tenantId,
    title: 'Delegated catalog course',
  });
  const request = (extra: Record<string, unknown> = {}) => ({
    tenantId,
    actorUserId: agentId,
    learnerId: f.own.learnerId,
    guardianRelationshipId: String(f.relationship.id),
    delegatingGuardianUserId: guardianId,
    delegationId: 'delegation-1',
    ...extra,
  });
  const enroll = (extra: Record<string, unknown> = {}, courseId?: string) => {
    const r = request(extra);
    return withTenant({ tenantId: r.tenantId, userId: r.actorUserId }, () =>
      learners.enroll({
        ...r,
        curriculumId: String(f.curriculum.id),
        courseId: courseId ?? String(catalogCourse.id),
      } as never),
    );
  };
  const count = async (table: string) => (await db.list(table, {})).length;
  return {
    db,
    f,
    tenantId,
    guardianId,
    agentId,
    learners,
    learnerCalls,
    deniedAgents,
    catalogCourse,
    request,
    enroll,
    count,
  };
}

describe('delegated agent enrollment', () => {
  it('enrolls for the delegating guardian and records the delegation', async () => {
    const s = await setup();
    const before = await s.count('enrollments');
    const view = await s.enroll();
    expect(view).toMatchObject({
      learnerId: s.f.own.learnerId,
      courseId: String(s.catalogCourse.id),
    });
    expect(await s.count('enrollments')).toBe(before + 1);
    const rows = await s.db.list('enrollment_assignment_records', {});
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tenant_id: s.tenantId,
      enrollment_id: view.id,
      learner_id: s.f.own.learnerId,
      actor_user_id: s.agentId,
      delegating_guardian_user_id: s.guardianId,
      delegation_id: 'delegation-1',
    });
    const call = s.learnerCalls.at(-1) as LearnerCall;
    expect(call).toMatchObject({
      action: 'education.learner.plan',
      actorUserId: s.agentId,
      own: false,
      relationshipTypeId: String(s.f.guardianType.id),
      delegatingGuardianUserId: s.guardianId,
      delegationId: 'delegation-1',
    });
    // A retry returns the same enrollment and writes no second record.
    expect((await s.enroll()).id).toBe(view.id);
    expect(await s.count('enrollment_assignment_records')).toBe(1);
  });

  it('keeps a plain guardian exactly as before', async () => {
    const s = await setup();
    s.learnerCalls.length = 0;
    const r = s.f.parent;
    const view = await s.f.as(r, () =>
      s.learners.enroll({
        ...r,
        curriculumId: String(s.f.curriculum.id),
        courseId: String(s.catalogCourse.id),
      }),
    );
    expect(view.learnerId).toBe(s.f.own.learnerId);
    expect(await s.count('enrollment_assignment_records')).toBe(0);
    const call = s.learnerCalls.find(
      (c) => c.action === 'education.learner.plan',
    ) as LearnerCall;
    expect(call.own).toBe(false);
    expect(call.delegatingGuardianUserId).toBeUndefined();
    expect(call.delegationId).toBeUndefined();
  });

  it('refuses when the host denies the agent', async () => {
    const s = await setup();
    s.deniedAgents.add(s.agentId);
    const before = await s.count('enrollments');
    await expect(s.enroll()).rejects.toBeInstanceOf(LearnerAuthorizationError);
    expect(await s.count('enrollments')).toBe(before);
    expect(await s.count('enrollment_assignment_records')).toBe(0);
  });

  it('refuses without a live guardian relationship for the delegating guardian', async () => {
    const s = await setup();
    const own = await withTenant({ tenantId: s.tenantId }, async () =>
      (await ProfileRelationshipCollection.create({ db: s.db })).create({
        tenantId: s.tenantId,
        fromProfileId: String(s.f.bob.profile.id),
        toProfileId: String(s.f.alice.profile.id),
        typeId: String(s.f.guardianType.id),
      }),
    );
    const sibling = await withTenant({ tenantId: s.tenantId }, async () =>
      (await ProfileRelationshipCollection.create({ db: s.db })).create({
        tenantId: s.tenantId,
        fromProfileId: String(s.f.guardian.profile.id),
        toProfileId: String(s.f.bob.profile.id),
        typeId: String(s.f.guardianType.id),
      }),
    );
    const cases: Array<[string, Record<string, unknown>]> = [
      ['no relationship id', { guardianRelationshipId: undefined }],
      ['unknown relationship', { guardianRelationshipId: randomUUID() }],
      // The agent's own relationship is never the delegating guardian's.
      ['relationship held by the agent', { guardianRelationshipId: own.id }],
      [
        'relationship for another learner',
        {
          guardianRelationshipId: sibling.id,
        },
      ],
      // A guardian from another tenant has no membership and no relationship here.
      [
        'foreign guardian',
        {
          delegatingGuardianUserId: String(s.f.stranger.user.id),
        },
      ],
      // The relationship belongs to the guardian, not to the learner's sibling.
      [
        'wrong guardian',
        {
          delegatingGuardianUserId: String(s.f.bob.user.id),
          actorUserId: String(s.f.alice.user.id),
        },
      ],
    ];
    for (const [label, extra] of cases) {
      const before = await s.count('enrollments');
      await expect(s.enroll(extra), label).rejects.toBeInstanceOf(
        LearnerAuthorizationError,
      );
      expect(await s.count('enrollments'), label).toBe(before);
    }
    // Inactive delegating guardian membership.
    await s.db.query(
      "UPDATE memberships SET status = 'suspended' WHERE user_id = ?",
      [s.guardianId],
    );
    await expect(s.enroll()).rejects.toBeInstanceOf(LearnerAuthorizationError);
    await s.db.query(
      "UPDATE memberships SET status = 'active' WHERE user_id = ?",
      [s.guardianId],
    );
    // A revoked relationship.
    await s.db.query('DELETE FROM profile_relationships WHERE id = ?', [
      String(s.f.relationship.id),
    ]);
    await expect(s.enroll()).rejects.toBeInstanceOf(LearnerAuthorizationError);
    expect(await s.count('enrollment_assignment_records')).toBe(0);
    // Acting from another tenant's session is refused as well.
    await expect(
      withTenant(
        {
          tenantId: String(s.f.foreign.tenantId),
          userId: String(s.f.stranger.user.id),
        },
        () =>
          s.learners.enroll({
            ...s.request(),
            curriculumId: String(s.f.curriculum.id),
            courseId: String(s.catalogCourse.id),
          } as never),
      ),
    ).rejects.toBeInstanceOf(LearnerAuthorizationError);
  });

  it('refuses an agent that is its own guardian', async () => {
    const s = await setup();
    await expect(
      s.enroll({ delegatingGuardianUserId: s.agentId }),
    ).rejects.toBeInstanceOf(LearnerAuthorizationError);
    // The learner may not delegate or act as their own planner.
    await expect(
      s.enroll({ actorUserId: String(s.f.alice.user.id) }),
    ).rejects.toBeInstanceOf(LearnerAuthorizationError);
    await expect(
      s.enroll({ delegatingGuardianUserId: String(s.f.alice.user.id) }),
    ).rejects.toBeInstanceOf(LearnerAuthorizationError);
    expect(await s.count('enrollment_assignment_records')).toBe(0);
  });

  it('validates the delegation as a unit', async () => {
    const s = await setup();
    for (const extra of [
      { delegatingGuardianUserId: undefined },
      { delegationId: undefined },
      { delegationId: '' },
      { delegationId: 'x'.repeat(201) },
      { delegationId: 'bad\nid' },
      { delegationId: 42 },
    ])
      await expect(s.enroll(extra)).rejects.toBeInstanceOf(
        CourseAuthoringValidationError,
      );
    await expect(
      s.enroll({ delegationId: 'x'.repeat(200) }),
    ).resolves.toBeTruthy();
    expect(await s.count('enrollment_assignment_records')).toBe(1);
  });

  it('never grants other learner authority to a delegated agent', async () => {
    const s = await setup();
    const r = s.request();
    await expect(
      withTenant({ tenantId: s.tenantId, userId: s.agentId }, () =>
        s.learners.getLearner(r as never),
      ),
    ).rejects.toBeInstanceOf(LearnerAuthorizationError);
    expect(s.learnerCalls).toHaveLength(0);
  });
});

describe('delegation id across course services', () => {
  async function authoring() {
    const s = await setup();
    const calls: Call[] = [];
    const deny = new Set<string>();
    const service = new CourseGenerationReviewService(s.db, (call) => {
      calls.push(call);
      return (
        COURSE_AUTHORING_ACTIONS.includes(call.action) &&
        !deny.has(call.operation)
      );
    });
    const guardian: CourseAuthoringActor = {
      tenantId: s.tenantId,
      actorUserId: s.guardianId,
    };
    const agent: CourseAuthoringActor = {
      tenantId: s.tenantId,
      actorUserId: s.agentId,
      delegatingGuardianUserId: s.guardianId,
      delegationId: 'delegation-1',
    };
    const as = <T>(actor: CourseAuthoringActor, fn: () => Promise<T>) =>
      withTenant({ tenantId: actor.tenantId, userId: actor.actorUserId }, fn);
    let n = 0;
    const key = (label = 'k') => `${label}-${++n}`;
    const draft = (title: string, provenance: 'supplied' | 'generated') => ({
      title: 'Delegated',
      objectives: ['o'],
      levelMin: 3,
      levelMax: 4,
      sections: [
        {
          sectionKey: 'u',
          title: 'U',
          lessons: [{ lessonKey: 'a', title }],
        },
      ],
      provenance,
    });
    return { ...s, calls, deny, service, guardian, agent, as, key, draft };
  }

  it('passes and records the delegation id everywhere', async () => {
    const s = await authoring();
    const { service, agent, as, key } = s;
    const head = await as(agent, () =>
      service.createCourse({
        ...agent,
        requestKey: key(),
        title: 'Delegated',
        levelMin: 3,
        levelMax: 4,
      }),
    );
    let expected = head.headRevisionId;
    const save = async (
      title: string,
      provenance: 'supplied' | 'generated',
    ) => {
      const saved = await as(agent, () =>
        service.saveDraft({
          ...agent,
          courseId: head.courseId,
          expectedHeadRevisionId: expected,
          requestKey: key(),
          draft: s.draft(title, provenance),
        }),
      );
      expected = saved.headRevisionId;
      return saved;
    };
    const releaseNew = async (title: string) => {
      const saved = await save(title, 'supplied');
      await as(agent, () =>
        service.recordReview({
          ...agent,
          courseId: head.courseId,
          revisionId: saved.revisionId,
          requestKey: key(),
          generalSummary: 'Suitable for the level overall in these respects.',
          findings: [],
        }),
      );
      return as(agent, () =>
        service.release({
          ...agent,
          courseId: head.courseId,
          revisionId: saved.revisionId,
          requestKey: key(),
        }),
      );
    };
    await save('Generated', 'generated');
    await as(agent, () =>
      service.readDraft({ ...agent, courseId: head.courseId }),
    );
    const rel1 = await releaseNew('A');
    expect(rel1).toMatchObject({
      actorUserId: s.agentId,
      delegatingGuardianUserId: s.guardianId,
      delegationId: 'delegation-1',
    });
    // The delegated agent assigns the released course to the learner.
    const enrollment = await s.enroll({}, rel1.releaseCourseId);
    const pinned = await as(agent, () =>
      service.pinEnrollment({
        ...agent,
        enrollmentId: enrollment.id,
        releaseId: rel1.id,
        requestKey: key(),
        policyBasis: 'guardians-and-agents',
      }),
    );
    expect(pinned.history[0]).toMatchObject({
      kind: 'initial',
      delegationId: 'delegation-1',
      optInDelegationId: null,
    });
    await as(agent, () =>
      service.setAutoUpgrade({
        ...agent,
        courseId: head.courseId,
        enrollmentId: enrollment.id,
        enabled: true,
        requestKey: key(),
        policyBasis: 'guardians-and-agents',
      }),
    );
    // Automatic move, then a denied per-enrollment check records a skip.
    const rel2 = await releaseNew('A2');
    s.deny.add('auto-upgrade');
    const rel3 = await releaseNew('A3');
    s.deny.delete('auto-upgrade');
    const current = await as(agent, () =>
      service.getEnrollmentRelease({ ...agent, enrollmentId: enrollment.id }),
    );
    expect(current.pin.releaseId).toBe(rel2.id);
    expect(current.pin.history.at(-1)).toMatchObject({
      kind: 'auto',
      delegationId: null,
      optInDelegationId: 'delegation-1',
    });
    const upgraded = await as(agent, () =>
      service.upgradeEnrollment({
        ...agent,
        enrollmentId: enrollment.id,
        releaseId: rel3.id,
        requestKey: key(),
        policyBasis: 'guardians-and-agents',
      }),
    );
    expect(upgraded.history.at(-1)).toMatchObject({
      kind: 'explicit',
      delegationId: 'delegation-1',
    });
    await as(agent, () =>
      service.archive({ ...agent, courseId: head.courseId, requestKey: key() }),
    );

    // Every course action reached the host with the delegation id.
    const delegated = s.calls.filter((c) => c.actorUserId === s.agentId);
    expect(new Set(delegated.map((c) => c.action))).toEqual(
      new Set(COURSE_AUTHORING_ACTIONS),
    );
    for (const call of delegated) {
      expect(call.delegatingGuardianUserId, call.operation).toBe(s.guardianId);
      expect(call.delegationId, call.operation).toBe('delegation-1');
    }
    const auto = s.calls.filter((c) => c.operation === 'auto-upgrade');
    expect(auto).toHaveLength(2);
    for (const call of auto) {
      expect(call.delegatingGuardianUserId).toBe(s.guardianId);
      expect(call.delegationId).toBe('delegation-1');
    }

    // Every decision record carries it.
    for (const table of [
      'course_revisions',
      'lesson_revisions',
      'course_releases',
      'course_archive_decisions',
      'enrollment_release_pins',
      'course_upgrade_choices',
      'course_reviews',
    ]) {
      const rows = await s.db.list(table, {});
      expect(rows.length, table).toBeGreaterThan(0);
      for (const row of rows) {
        if (table === 'enrollment_release_pins' && row.kind === 'auto') {
          expect(row.delegation_id).toBe('');
          expect(row.opt_in_delegation_id).toBe('delegation-1');
          continue;
        }
        expect(row.delegation_id, table).toBe('delegation-1');
        expect(row.delegating_guardian_user_id, table).toBe(s.guardianId);
      }
    }
    const skips = await s.db.list('enrollment_auto_upgrade_skips', {});
    expect(skips).toHaveLength(1);
    expect(skips[0]).toMatchObject({
      opt_in_delegating_guardian_user_id: s.guardianId,
      opt_in_delegation_id: 'delegation-1',
    });
    const assignment = await s.db.list('enrollment_assignment_records', {});
    expect(assignment).toHaveLength(1);
    expect(assignment[0].delegation_id).toBe('delegation-1');
  });

  it('records no delegation for a plain guardian and omits it from the authorizer', async () => {
    const s = await authoring();
    const head = await s.as(s.guardian, () =>
      s.service.createCourse({
        ...s.guardian,
        requestKey: s.key(),
        title: 'Plain',
        levelMin: 3,
        levelMax: 4,
      }),
    );
    const saved = await s.as(s.guardian, () =>
      s.service.saveDraft({
        ...s.guardian,
        courseId: head.courseId,
        expectedHeadRevisionId: head.headRevisionId,
        requestKey: s.key(),
        draft: s.draft('A', 'supplied'),
      }),
    );
    const view = (
      await s.as(s.guardian, () =>
        s.service.readDraft({
          ...s.guardian,
          courseId: head.courseId,
          revisionId: saved.revisionId,
        }),
      )
    ).revision;
    expect(view.delegatingGuardianUserId).toBeNull();
    expect(view.delegationId).toBeNull();
    for (const call of s.calls) {
      expect('delegationId' in call).toBe(false);
      expect('delegatingGuardianUserId' in call).toBe(false);
    }
  });

  it('validates the delegation as a unit on every course operation', async () => {
    const s = await authoring();
    const before = s.calls.length;
    for (const bad of [
      { delegationId: undefined },
      { delegatingGuardianUserId: undefined },
      { delegationId: '' },
      { delegationId: 'x'.repeat(201) },
    ])
      await expect(
        s.as(s.agent, () =>
          s.service.createCourse({
            ...s.agent,
            ...bad,
            requestKey: s.key(),
            title: 'x',
            levelMin: 3,
            levelMax: 4,
          }),
        ),
      ).rejects.toBeInstanceOf(CourseAuthoringValidationError);
    await expect(
      s.as(s.agent, () =>
        s.service.createCourse({
          ...s.agent,
          delegatingGuardianUserId: s.agentId,
          requestKey: s.key(),
          title: 'x',
          levelMin: 3,
          levelMax: 4,
        }),
      ),
    ).rejects.toBeInstanceOf(CourseAuthoringAuthorizationError);
    expect(s.calls.length).toBe(before);
    expect(await s.count('course_revisions')).toBe(0);
  });

  it('treats a different delegation id as a request-key conflict', async () => {
    const s = await authoring();
    const { service, agent, as } = s;
    const other = { ...agent, delegationId: 'delegation-2' };
    const create = (actor: CourseAuthoringActor, requestKey: string) =>
      as(actor, () =>
        service.createCourse({
          ...actor,
          requestKey,
          title: 'Replay',
          levelMin: 3,
          levelMax: 4,
        }),
      );
    const head = await create(agent, 'create-1');
    expect(await create(agent, 'create-1')).toEqual(head);
    await expect(create(other, 'create-1')).rejects.toBeInstanceOf(
      CourseRequestKeyConflictError,
    );
    await expect(create(s.guardian, 'create-1')).rejects.toBeInstanceOf(
      CourseRequestKeyConflictError,
    );

    const save = (actor: CourseAuthoringActor) =>
      as(actor, () =>
        service.saveDraft({
          ...actor,
          courseId: head.courseId,
          expectedHeadRevisionId: head.headRevisionId,
          requestKey: 'save-1',
          draft: s.draft('A', 'supplied'),
        }),
      );
    const saved = await save(agent);
    await expect(save(agent)).resolves.toMatchObject({
      revisionId: saved.revisionId,
    });
    await expect(save(other)).rejects.toBeInstanceOf(
      CourseRequestKeyConflictError,
    );

    const archive = (actor: CourseAuthoringActor) =>
      as(actor, () =>
        service.archive({
          ...actor,
          courseId: head.courseId,
          requestKey: 'archive-1',
        }),
      );
    await archive(agent);
    await expect(archive(agent)).resolves.toBeTruthy();
    await expect(archive(other)).rejects.toBeInstanceOf(
      CourseRequestKeyConflictError,
    );
    expect(await s.count('course_archive_decisions')).toBe(1);

    const question = (actor: CourseAuthoringActor) =>
      as(actor, () =>
        service.createQuestion({
          ...actor,
          requestKey: 'question-1',
          content: {
            prompt: 'What is 1/2 + 1/4?',
            responseType: 'short-answer',
            answerKey: { acceptedAnswers: ['3/4'] },
            provenance: 'supplied',
          },
        }),
      );
    const q = await question(agent);
    expect(await question(agent)).toEqual(q);
    await expect(question(other)).rejects.toBeInstanceOf(
      CourseRequestKeyConflictError,
    );
    const rows = await s.db.list('question_revisions', {});
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      delegating_guardian_user_id: s.guardianId,
      delegation_id: 'delegation-1',
    });
  });
});
