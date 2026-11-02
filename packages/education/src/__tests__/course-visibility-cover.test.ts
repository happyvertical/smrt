import { randomUUID } from 'node:crypto';
import {
  AssetCollection,
  withPrivateAssetAccess,
} from '@happyvertical/smrt-assets';
import { getTestDatabase } from '@happyvertical/smrt-core';
import {
  disableTenancy,
  enableTenancy,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  COURSE_AUTHORING_ACTIONS,
  type CourseAuthoringAction,
  type CourseAuthoringActor,
  CourseAuthoringAuthorizationError,
  type CourseAuthoringAuthorizer,
  CourseAuthoringService,
  CourseAuthoringValidationError,
  CourseCoverInvalidError,
  type CourseDraftInput,
  type CourseMaterialCopyPort,
  CourseNotFoundError,
  CourseRequestKeyConflictError,
  CourseVisibilityRefusedError,
} from '../index.js';
import { learnerClasses, learnerFixture } from './learner-workflows.js';

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
  'CurriculumCreationRecord',
  'CourseVisibilityChange',
  'CourseCoverChange',
];

beforeAll(() => enableTenancy());
afterAll(() => disableTenancy());
const opened: DatabaseInterface[] = [];
afterEach(async () => {
  for (const db of opened.splice(0)) await db.close?.();
});

type Call = Parameters<CourseAuthoringAuthorizer>[0];

async function setup() {
  const db = await getTestDatabase({
    type: 'sqlite',
    url: ':memory:',
    classes,
  });
  opened.push(db);
  const f = await learnerFixture(db);
  const guardian: CourseAuthoringActor = {
    tenantId: f.own.tenantId,
    actorUserId: f.parent.actorUserId,
  };
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
  const denied = new Set<CourseAuthoringAction>();
  const grants = new Map<string, CourseAuthoringAction[]>([
    [guardian.actorUserId, [...COURSE_AUTHORING_ACTIONS]],
    [agent.actorUserId, [...COURSE_AUTHORING_ACTIONS]],
    [outsider.actorUserId, [...COURSE_AUTHORING_ACTIONS]],
  ]);
  const authorizer: CourseAuthoringAuthorizer = (call) => {
    calls.push(call);
    return (
      !denied.has(call.action) &&
      (grants.get(call.actorUserId) ?? []).includes(call.action)
    );
  };
  const as = <T>(actor: CourseAuthoringActor, fn: () => Promise<T>) =>
    withTenant({ tenantId: actor.tenantId, userId: actor.actorUserId }, fn);
  /** Ref suffix picks the asset: .png (default image), .pdf, .other-owner.png, .public.png */
  const port: CourseMaterialCopyPort = {
    async copy(executor, request) {
      const user = (await executor.get('users', {
        id: request.actorUserId,
      })) as Record<string, string>;
      const stranger = (await executor.get('users', {
        id: String(f.stranger.user.id),
      })) as Record<string, string>;
      const id = randomUUID();
      const ref = request.source.ref;
      const owner = ref.includes('other-owner')
        ? stranger.profile_id
        : user.profile_id;
      const mimeType = ref.endsWith('.pdf') ? 'application/pdf' : 'image/png';
      const assets = await AssetCollection.create({ db: executor });
      if (ref.includes('public'))
        await assets.create({
          id,
          tenantId: request.tenantId,
          name: ref,
          mimeType,
          sourceUri: `file:///education/${id}`,
        });
      else
        await withPrivateAssetAccess(
          {
            tenantId: request.tenantId,
            actorUserId: request.actorUserId,
            ownerProfileId: owner,
            assetIds: [id],
          },
          async () =>
            assets.create({
              id,
              tenantId: request.tenantId,
              name: ref,
              mimeType,
              accessMode: 'private',
              ownerProfileId: owner,
              sourceUri: `file:///education/${id}`,
            }),
        );
      return { assetId: id };
    },
  };
  const service = new CourseAuthoringService(db, authorizer, {
    verifyDelegation: () => true,
    releaseReviewGate: () => ({ current: true, reviewId: 'review-1' }),
    materialCopy: port,
  });
  let counter = 0;
  const key = (label = 'k') => `${label}-${++counter}`;
  const create = (actor = guardian) =>
    as(actor, () =>
      service.createCourse({
        ...actor,
        requestKey: key('create'),
        title: 'Fractions',
        levelMin: 3,
        levelMax: 4,
      }),
    );
  type Lesson = NonNullable<
    CourseDraftInput['sections'][number]['lessons']
  >[number];
  const save = (
    courseId: string,
    expected: string,
    lessons: Lesson[] = [{ lessonKey: 'a', title: 'A' }],
    actor = guardian,
  ) =>
    as(actor, () =>
      service.saveDraft({
        ...actor,
        courseId,
        expectedHeadRevisionId: expected,
        requestKey: key('save'),
        draft: {
          title: 'Fractions',
          objectives: ['o'],
          levelMin: 3,
          levelMax: 4,
          sections: [{ sectionKey: 'u', title: 'U', lessons }],
          provenance: 'supplied',
        },
      }),
    );
  const release = (courseId: string, revisionId: string) =>
    as(guardian, () =>
      service.release({
        ...guardian,
        courseId,
        revisionId,
        requestKey: key('rel'),
      }),
    );
  const visibility = (
    courseId: string,
    value: 'family' | 'groups' | 'public',
    requestKey = key('vis'),
    actor = guardian,
  ) =>
    as(actor, () =>
      service.setVisibility({
        ...actor,
        courseId,
        visibility: value,
        requestKey,
      }),
    );
  const cover = (
    courseId: string,
    assetId: string | null,
    requestKey = key('cover'),
    actor = guardian,
  ) =>
    as(actor, () =>
      service.setCover({ ...actor, courseId, assetId, requestKey }),
    );
  /** A course whose draft carries one material per entry; returns the asset ids. */
  async function withMaterials(
    materials: Array<{
      ref: string;
      relationship?: 'attachment' | 'printable' | 'answer-key';
      licenseKind?: 'own-work' | 'personal-use-copy';
    }>,
  ) {
    const head = await create();
    const saved = await save(head.courseId, head.headRevisionId, [
      {
        lessonKey: 'a',
        title: 'A',
        lessonType: 'worksheet',
        materials: materials.map((m) => ({
          source: { kind: 'upload', ref: m.ref },
          relationship: m.relationship ?? 'attachment',
          licenseKind: m.licenseKind ?? 'own-work',
        })),
      },
    ]);
    const draft = await as(guardian, () =>
      service.readDraft({ ...guardian, courseId: head.courseId }),
    );
    return {
      head,
      saved,
      assets: draft.revision.sections[0].lessons[0].materials.map(
        (m) => m.assetId,
      ),
    };
  }
  const state = (courseId: string) =>
    as(guardian, () => service.getCourse({ ...guardian, courseId }));
  const rows = (table: string, courseId: string) =>
    db.list(table, { course_id: courseId });
  return {
    db,
    f,
    service,
    guardian,
    agent,
    outsider,
    calls,
    denied,
    as,
    create,
    save,
    release,
    visibility,
    cover,
    withMaterials,
    state,
    rows,
  };
}

describe('authored course visibility', () => {
  it('defaults to family and records every change with the actor', async () => {
    const s = await setup();
    const head = await s.create();
    expect((await s.state(head.courseId)).visibility).toBe('family');
    const listed = await s.as(s.guardian, () =>
      s.service.listCourses({ ...s.guardian }),
    );
    expect(listed.items[0]).toMatchObject({
      visibility: 'family',
      coverAssetId: null,
    });

    s.calls.length = 0;
    const next = await s.visibility(head.courseId, 'groups', 'vis-a');
    expect(next.visibility).toBe('groups');
    const call = s.calls.find(
      (c) => c.action === 'education.course.set-visibility',
    );
    expect(call).toMatchObject({
      operation: 'set-visibility',
      courseId: head.courseId,
      actorUserId: s.guardian.actorUserId,
    });
    expect(call?.executor).not.toBe(s.db);
    await s.visibility(head.courseId, 'public');
    await s.visibility(head.courseId, 'family');
    const changes = (await s.rows('course_visibility_changes', head.courseId))
      .map((row) => [
        row.sequence,
        row.previous_visibility,
        row.visibility,
        row.reason,
        row.actor_user_id,
      ])
      .sort((a, b) => Number(a[0]) - Number(b[0]));
    expect(changes).toEqual([
      [1, 'family', 'groups', 'request', s.guardian.actorUserId],
      [2, 'groups', 'public', 'request', s.guardian.actorUserId],
      [3, 'public', 'family', 'request', s.guardian.actorUserId],
    ]);
  });

  it('is idempotent when unchanged and replays request keys', async () => {
    const s = await setup();
    const head = await s.create();
    await s.visibility(head.courseId, 'groups', 'same-key');
    expect(
      await s.rows('course_visibility_changes', head.courseId),
    ).toHaveLength(1);
    // Replay and unchanged value both write nothing.
    await s.visibility(head.courseId, 'groups', 'same-key');
    await s.visibility(head.courseId, 'groups', 'other-key');
    expect(
      await s.rows('course_visibility_changes', head.courseId),
    ).toHaveLength(1);
    // Same key, different payload.
    await expect(
      s.visibility(head.courseId, 'public', 'same-key'),
    ).rejects.toBeInstanceOf(CourseRequestKeyConflictError);
    // A delegated actor cannot replay another actor's key as its own.
    await expect(
      s.visibility(head.courseId, 'groups', 'same-key', s.agent),
    ).rejects.toBeInstanceOf(CourseRequestKeyConflictError);
    // An explicit family request on a never-set course is recorded.
    const other = await s.create();
    await s.visibility(other.courseId, 'family');
    expect(
      await s.rows('course_visibility_changes', other.courseId),
    ).toHaveLength(1);
    await s.visibility(other.courseId, 'family');
    expect(
      await s.rows('course_visibility_changes', other.courseId),
    ).toHaveLength(1);
  });

  it('validates input and records delegation', async () => {
    const s = await setup();
    const head = await s.create();
    await expect(
      s.visibility(head.courseId, 'everyone' as never),
    ).rejects.toBeInstanceOf(CourseAuthoringValidationError);
    await expect(
      s.visibility(head.courseId, 'groups', 'bad key with spaces'),
    ).rejects.toBeInstanceOf(CourseAuthoringValidationError);
    await s.visibility(head.courseId, 'groups', 'by-agent', s.agent);
    const [row] = await s.rows('course_visibility_changes', head.courseId);
    expect(row.actor_user_id).toBe(s.agent.actorUserId);
    expect(row.delegating_guardian_user_id).toBe(s.guardian.actorUserId);
    expect(row.delegation_id).toBe('delegation-1');
  });

  it('denies hosts, outsiders and unknown courses without writing', async () => {
    const s = await setup();
    const head = await s.create();
    s.denied.add('education.course.set-visibility');
    await expect(s.visibility(head.courseId, 'groups')).rejects.toBeInstanceOf(
      CourseAuthoringAuthorizationError,
    );
    s.denied.clear();
    // A foreign tenant's actor cannot see or change this tenant's course.
    await expect(
      s.visibility(head.courseId, 'groups', 'x', s.outsider),
    ).rejects.toBeInstanceOf(CourseNotFoundError);
    await expect(s.visibility(randomUUID(), 'groups')).rejects.toBeInstanceOf(
      CourseNotFoundError,
    );
    // Another actor presenting the tenant's ids under the wrong ambient tenant.
    await expect(
      s.as(s.outsider, () =>
        s.service.setVisibility({
          ...s.guardian,
          courseId: head.courseId,
          visibility: 'groups',
          requestKey: 'spoof',
        }),
      ),
    ).rejects.toBeInstanceOf(CourseAuthoringAuthorizationError);
    expect(
      await s.rows('course_visibility_changes', head.courseId),
    ).toHaveLength(0);
    expect((await s.state(head.courseId)).visibility).toBe('family');
  });

  it('filters listCourses by visibility', async () => {
    const s = await setup();
    const a = await s.create();
    const b = await s.create();
    const c = await s.create();
    await s.visibility(b.courseId, 'groups');
    await s.visibility(c.courseId, 'public');
    const ids = async (visibility?: 'family' | 'groups' | 'public') =>
      (
        await s.as(s.guardian, () =>
          s.service.listCourses({ ...s.guardian, visibility }),
        )
      ).items.map((item) => item.courseId);
    expect(await ids('family')).toEqual([a.courseId]);
    expect(await ids('groups')).toEqual([b.courseId]);
    expect(await ids('public')).toEqual([c.courseId]);
    expect(await ids()).toHaveLength(3);
    await expect(ids('nope' as never)).rejects.toBeInstanceOf(
      CourseAuthoringValidationError,
    );
  });

  it('never lets a personal-use course become groups or public', async () => {
    const s = await setup();
    const head = await s.create();
    await s.save(head.courseId, head.headRevisionId, [
      { lessonKey: 'a', title: 'A', licenseKind: 'personal-use-copy' },
    ]);
    for (const value of ['groups', 'public'] as const)
      await expect(s.visibility(head.courseId, value)).rejects.toBeInstanceOf(
        CourseVisibilityRefusedError,
      );
    expect((await s.state(head.courseId)).visibility).toBe('family');
    // Family stays allowed.
    await s.visibility(head.courseId, 'family');

    // A released personal-use revision keeps the whole course restricted even
    // after the draft is rewritten as own work.
    const p = await s.create();
    const one = await s.save(p.courseId, p.headRevisionId, [
      { lessonKey: 'a', title: 'A', licenseKind: 'personal-use-copy' },
    ]);
    await s.release(p.courseId, one.revisionId);
    await s.save(p.courseId, one.headRevisionId, [
      { lessonKey: 'a2', title: 'Fresh', body: 'Entirely original text' },
    ]);
    await expect(s.visibility(p.courseId, 'public')).rejects.toBeInstanceOf(
      CourseVisibilityRefusedError,
    );
  });

  it('narrows to family, with a recorded row, when a revision turns personal-use', async () => {
    const s = await setup();
    const head = await s.create();
    const one = await s.save(head.courseId, head.headRevisionId);
    await s.visibility(head.courseId, 'public');
    const two = await s.save(head.courseId, one.headRevisionId, [
      { lessonKey: 'a', title: 'A', licenseKind: 'personal-use-copy' },
    ]);
    expect((await s.state(head.courseId)).visibility).toBe('family');
    const reasons = (await s.rows('course_visibility_changes', head.courseId))
      .map((row) => [row.reason, row.previous_visibility, row.visibility])
      .sort();
    expect(reasons).toEqual([
      ['licence', 'public', 'family'],
      ['request', 'family', 'public'],
    ]);
    expect(two.version).toBe(3);
  });

  it('is append-only', async () => {
    const s = await setup();
    const head = await s.create();
    await s.visibility(head.courseId, 'groups');
    const { CourseVisibilityChangeCollection } = await import(
      '../course-authoring-models.js'
    );
    const [row] = await s.as(s.guardian, async () =>
      (await CourseVisibilityChangeCollection.create({ db: s.db })).list({
        where: { courseId: head.courseId },
      }),
    );
    await expect(row.delete()).rejects.toThrow(/immutable/);
    row.visibility = 'public';
    await expect(row.save()).rejects.toThrow(/immutable/);
  });
});

describe('authored course cover', () => {
  it('sets, replays, clears and records covers with the actor', async () => {
    const s = await setup();
    const { head, assets } = await s.withMaterials([{ ref: 'cover.png' }]);
    s.calls.length = 0;
    const next = await s.cover(head.courseId, assets[0], 'cover-a');
    expect(next.coverAssetId).toBe(assets[0]);
    expect(
      s.calls.find((c) => c.action === 'education.course.set-cover'),
    ).toMatchObject({
      operation: 'set-cover',
      courseId: head.courseId,
      actorUserId: s.guardian.actorUserId,
    });
    expect(
      (await s.as(s.guardian, () => s.service.listCourses({ ...s.guardian })))
        .items[0].coverAssetId,
    ).toBe(assets[0]);
    // Replay and unchanged are idempotent.
    await s.cover(head.courseId, assets[0], 'cover-a');
    await s.cover(head.courseId, assets[0]);
    expect(await s.rows('course_cover_changes', head.courseId)).toHaveLength(1);
    await expect(
      s.cover(head.courseId, null, 'cover-a'),
    ).rejects.toBeInstanceOf(CourseRequestKeyConflictError);
    const cleared = await s.cover(head.courseId, null);
    expect(cleared.coverAssetId).toBeNull();
    await s.cover(head.courseId, null);
    const history = (await s.rows('course_cover_changes', head.courseId))
      .map((r) => [
        r.sequence,
        r.previous_asset_id,
        r.asset_id,
        r.actor_user_id,
      ])
      .sort((a, b) => Number(a[0]) - Number(b[0]));
    expect(history).toEqual([
      [1, '', assets[0], s.guardian.actorUserId],
      [2, assets[0], '', s.guardian.actorUserId],
    ]);
  });

  it('accepts a public image asset the tenant can read', async () => {
    const s = await setup();
    const { head, assets } = await s.withMaterials([
      { ref: 'shelf.public.png' },
    ]);
    expect((await s.cover(head.courseId, assets[0])).coverAssetId).toBe(
      assets[0],
    );
  });

  it('refuses invalid covers with a typed reason and writes nothing', async () => {
    const s = await setup();
    const { head, assets } = await s.withMaterials([
      { ref: 'doc.pdf' },
      { ref: 'key.png', relationship: 'answer-key' },
      { ref: 'x.other-owner.png' },
      { ref: 'ok.png' },
    ]);
    const reason = async (assetId: string) => {
      try {
        await s.cover(head.courseId, assetId);
      } catch (error) {
        expect(error).toBeInstanceOf(CourseCoverInvalidError);
        return (error as CourseCoverInvalidError).reason;
      }
      return 'accepted';
    };
    expect(await reason(assets[0])).toBe('not-image');
    expect(await reason(assets[1])).toBe('answer-key');
    // Private and owned by another profile: this actor cannot read it.
    expect(await reason(assets[2])).toBe('unreadable');
    expect(await reason(randomUUID())).toBe('missing');

    // An image that is not a material of this course is not education-owned.
    const stray = randomUUID();
    await s.as(s.guardian, async () =>
      (await AssetCollection.create({ db: s.db })).create({
        id: stray,
        tenantId: s.guardian.tenantId,
        name: 'stray',
        mimeType: 'image/png',
        sourceUri: 'file:///stray.png',
      }),
    );
    expect(await reason(stray)).toBe('not-course-material');

    // An asset of a foreign tenant is simply missing.
    const foreign = randomUUID();
    await s.as(s.outsider, async () =>
      (await AssetCollection.create({ db: s.db })).create({
        id: foreign,
        tenantId: s.outsider.tenantId,
        name: 'foreign',
        mimeType: 'image/png',
        sourceUri: 'file:///foreign.png',
      }),
    );
    expect(await reason(foreign)).toBe('missing');
    expect(await s.rows('course_cover_changes', head.courseId)).toHaveLength(0);
    expect((await s.state(head.courseId)).coverAssetId).toBeNull();
    expect(await reason(assets[3])).toBe('accepted');
  });

  it('refuses an asset any lesson of the course also uses as an answer key', async () => {
    const s = await setup();
    const { head, saved, assets } = await s.withMaterials([
      { ref: 'shared.png' },
    ]);
    await s.save(head.courseId, saved.headRevisionId, [
      {
        lessonKey: 'a',
        title: 'A',
        lessonType: 'worksheet',
        materials: [{ assetId: assets[0], relationship: 'attachment' }],
      },
      {
        lessonKey: 'k',
        title: 'K',
        lessonType: 'worksheet',
        materials: [{ assetId: assets[0], relationship: 'answer-key' }],
      },
    ]);
    await expect(s.cover(head.courseId, assets[0])).rejects.toMatchObject({
      reason: 'answer-key',
    });
  });

  it('denies hosts, outsiders and invalid ids', async () => {
    const s = await setup();
    const { head, assets } = await s.withMaterials([{ ref: 'cover.png' }]);
    s.denied.add('education.course.set-cover');
    await expect(s.cover(head.courseId, assets[0])).rejects.toBeInstanceOf(
      CourseAuthoringAuthorizationError,
    );
    s.denied.clear();
    await expect(
      s.cover(head.courseId, assets[0], 'o', s.outsider),
    ).rejects.toBeInstanceOf(CourseNotFoundError);
    await expect(s.cover(head.courseId, '')).rejects.toBeInstanceOf(
      CourseAuthoringValidationError,
    );
    expect(await s.rows('course_cover_changes', head.courseId)).toHaveLength(0);
  });

  it('snapshots the cover onto the release', async () => {
    const s = await setup();
    const { head, saved, assets } = await s.withMaterials([
      { ref: 'one.png' },
      { ref: 'two.png' },
    ]);
    await s.cover(head.courseId, assets[0]);
    const rel = await s.release(head.courseId, saved.revisionId);
    expect(rel.coverAssetId).toBe(assets[0]);
    // A later cover change does not rewrite the immutable release.
    await s.cover(head.courseId, assets[1]);
    const listed = await s.as(s.guardian, () =>
      s.service.listCourses({ ...s.guardian }),
    );
    expect(listed.items[0].coverAssetId).toBe(assets[1]);
    expect(listed.items[0].latestRelease?.coverAssetId).toBe(assets[0]);
    expect(
      (await s.db.get('courses', { id: rel.releaseCourseId }))?.cover_asset_id,
    ).toBe(assets[0]);
    // A release without a cover reports null.
    const bare = await s.create();
    const one = await s.save(bare.courseId, bare.headRevisionId);
    expect(
      (await s.release(bare.courseId, one.revisionId)).coverAssetId,
    ).toBeNull();
  });
});
