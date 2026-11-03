import { AsyncResource } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import {
  AssetCollection,
  withPrivateAssetAccess,
} from '@happyvertical/smrt-assets';
import { getTestDatabase } from '@happyvertical/smrt-core';
import { withTenant } from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { expect } from 'vitest';
import {
  type AcceptedCourseBundleMember,
  BUNDLE_COURSE_SOURCE,
  COURSE_AUTHORING_ACTIONS,
  type CourseAuthoringActor,
  CourseAuthoringAuthorizationError,
  CourseBundleImportService,
  CourseBundleMaterialsError,
  CourseBundleRefusedError,
  FakeDocumentConverter,
  type LessonMaterialView,
  parseBundleManifestV2,
  SubmissionService,
} from '../index.js';
import { tinyPdf } from './bundle-zip-writer.js';
import { learnerFixture } from './learner-workflows.js';
import { officeDocx, officePptx } from './office-fixtures.js';
import { submissionClasses } from './submission-workflows.js';

/*
 * SMRT #4632: a manifest v2 bundle (or the parts of a split unit) becomes one
 * family course with lessons, materials, pages and videos.
 *  one bundle -> course, replay ............................ 'attach'
 *  parts in any order, unit identity fails closed ........... 'parts'
 *  audience before attach (choices) and after ............... 'audience'
 *  learner never sees guardian material, view markers ....... 'views'
 *  no converter: nothing rendered, nothing faked ............ 'zero renderings'
 */
export const classes = [
  ...new Set([
    ...submissionClasses,
    'AuthoredCourse',
    'Reading',
    'Video',
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
    'CourseBundleImport',
    'CourseBundleMember',
    'CourseBundleRendering',
    'CourseBundleAttachment',
    'CourseBundleAudienceChoice',
    'CourseBundlePlacement',
  ]),
];

/** SQLite databases opened by `setup`; the suite closes them after each test. */
export const opened: DatabaseInterface[] = [];

export const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48,
]);
export const VIDEO_A = 'dQw4w9WgXcQ';
export const VIDEO_B = 'aaaaaaaaaaa';

export type Lesson = {
  key: string;
  title: string;
  order?: number;
  members: Array<{ path: string; role: string; audience?: string }>;
  pages?: Array<{ member: string; from: number; to: number; label?: string }>;
  videos?: Array<{
    reference: string;
    title: string;
    step: number;
    audience?: string;
  }>;
};
export const lesson1: Lesson = {
  key: 'lesson-1',
  title: 'Lesson 1',
  order: 1,
  members: [
    { path: 'l1/log.docx', role: 'learner-pages' },
    { path: 'l1/deck.pptx', role: 'slides', audience: 'learner' },
    { path: 'l1/guide.pdf', role: 'teacher-guide' },
    { path: 'l1/key.pdf', role: 'assessment-guidance' },
    { path: 'l1/handout.pdf', role: 'handout' },
  ],
  pages: [{ member: 'l1/log.docx', from: 1, to: 2, label: 'Log' }],
  videos: [
    { reference: VIDEO_B, title: 'Build', step: 2 },
    { reference: VIDEO_A, title: 'Intro', step: 1 },
  ],
};
export const lesson2: Lesson = {
  key: 'lesson-2',
  title: 'Lesson 2',
  order: 2,
  members: [{ path: 'l2/handout.pdf', role: 'handout' }],
};
const files: Record<string, () => Uint8Array> = {
  'l1/log.docx': () => officeDocx('mission log'),
  'l1/deck.pptx': () => officePptx('launch deck'),
  'l1/guide.pdf': () => tinyPdf('guide'),
  'l1/key.pdf': () => tinyPdf('key'),
  'l1/handout.pdf': () => tinyPdf('handout 1'),
  'l2/handout.pdf': () => tinyPdf('handout 2'),
  'unit/supplies.pdf': () => tinyPdf('supplies'),
};

export function bundleOf(
  lessons: Lesson[],
  options: {
    key?: string;
    part?: { index: number; count: number };
    courseMembers?: boolean;
    sectionTitle?: string;
    /** null leaves the section's order implicit. */
    sectionOrder?: number | null;
  } = {},
) {
  const manifest = {
    version: 2,
    course: {
      subject: 'Science',
      ...(options.key ? { key: options.key, title: 'Carnival' } : {}),
    },
    ...(options.part ? { part: options.part } : {}),
    ...(options.courseMembers
      ? {
          courseMembers: [
            {
              path: 'unit/supplies.pdf',
              role: 'attachment',
              title: 'Supply list',
            },
          ],
        }
      : {}),
    sections: [
      {
        key: 'unit',
        title: options.sectionTitle ?? 'Unit',
        ...(options.sectionOrder === null
          ? {}
          : { order: options.sectionOrder ?? 0 }),
        lessons,
      },
    ],
  };
  const paths = [
    ...lessons.flatMap((l) => l.members.map((m) => m.path)),
    ...(options.courseMembers ? ['unit/supplies.pdf'] : []),
  ];
  return {
    files: [
      { path: 'manifest.json', bytes: Buffer.from(JSON.stringify(manifest)) },
      ...paths.map((path) => ({
        path,
        bytes: (files[path] as () => Uint8Array)(),
      })),
    ],
  };
}
export const single = () =>
  bundleOf([lesson1, lesson2], { courseMembers: true });

export const MIME: Record<string, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  png: 'image/png',
};

export async function setup(
  options: {
    converter?: FakeDocumentConverter | null;
    /** A database to use (PostgreSQL in the optional suite); default SQLite. */
    db?: DatabaseInterface;
  } = {},
) {
  let db = options.db;
  if (!db) {
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:', classes });
    opened.push(db);
  }
  const f = await learnerFixture(db);
  const guardian: CourseAuthoringActor = {
    tenantId: f.own.tenantId,
    actorUserId: f.parent.actorUserId,
  };
  const authorizer = (call: { actorUserId: string }) =>
    call.actorUserId === guardian.actorUserId &&
    COURSE_AUTHORING_ACTIONS.length > 0;
  const converter =
    options.converter === null
      ? undefined
      : (options.converter ?? new FakeDocumentConverter({ thumbnail: PNG }));
  const service = new CourseBundleImportService(db, authorizer, {
    ...(converter ? { converter } : {}),
  });
  const claims: string[] = [];
  const submissions = new SubmissionService(
    db,
    ({ own, relationshipTypeId }) =>
      own || relationshipTypeId === f.guardianType.id,
    () => true,
    {
      storage: { type: 'local', basePath: '/tmp/unused' } as never,
      signAsset: async (claim) => {
        claims.push(claim.assetId);
        return `https://school.test/${claim.assetId}`;
      },
    },
  );
  const as = <T>(actor: CourseAuthoringActor, fn: () => Promise<T>) =>
    withTenant({ tenantId: actor.tenantId, userId: actor.actorUserId }, fn);
  const profile = String(
    (await db.get('users', { id: guardian.actorUserId }))?.profile_id,
  );
  const asset = async (name: string, mimeType: string) => {
    const id = randomUUID();
    await as(guardian, () =>
      withPrivateAssetAccess(
        {
          tenantId: guardian.tenantId,
          actorUserId: guardian.actorUserId,
          ownerProfileId: profile,
          assetIds: [id],
        },
        async () =>
          (await AssetCollection.create({ db })).create({
            id,
            tenantId: guardian.tenantId,
            name,
            mimeType,
            accessMode: 'private',
            ownerProfileId: profile,
            sourceUri: `file:///education/${id}`,
          }),
      ),
    );
    return id;
  };
  /** A host's `receiveMember` + storage: original, rendered PDF, thumbnail. */
  const store = async (accepted: AcceptedCourseBundleMember[]) => {
    const out: Record<
      string,
      { original?: string; rendered?: string; thumbnail?: string }
    > = {};
    for (const m of accepted)
      out[m.path] = {
        original: await asset(m.path, MIME[m.kind] ?? 'application/pdf'),
        ...(m.rendered
          ? { rendered: await asset(`${m.path}.pdf`, MIME.pdf as string) }
          : {}),
        ...(m.rendered?.thumbnail
          ? { thumbnail: await asset(`${m.path}.png`, MIME.png as string) }
          : {}),
      };
    return out;
  };
  const importAndStore = async (bundle: ReturnType<typeof bundleOf>) => {
    const result = await as(guardian, () =>
      service.importBundle({ ...guardian, bundle }),
    );
    return { result, assets: await store(result.accepted) };
  };
  const attach = (
    bundle: ReturnType<typeof bundleOf>,
    importId: string,
    assets: Record<string, { original?: string; rendered?: string }>,
    extra: Record<string, unknown> = {},
  ) =>
    as(guardian, () =>
      service.attachCourse({
        ...guardian,
        importId,
        bundle,
        assets,
        ...extra,
      }),
    );
  const count = async (table: string) => (await db.list(table, {})).length;
  const counts = async () =>
    Object.fromEntries(
      await Promise.all(
        [
          'courses',
          'course_sections',
          'lessons',
          'lesson_assets',
          'course_assets',
          'lesson_pages',
          'lesson_external_videos',
          'course_bundle_attachments',
        ].map(async (t) => [t, await count(t)] as const),
      ),
    );
  return {
    db,
    f,
    guardian,
    service,
    authorizer,
    converter,
    submissions,
    claims,
    as,
    importAndStore,
    attach,
    count,
    counts,
  };
}

/** Enroll the fixture learner in `courseId`, as the guardian. */
export async function enroll(
  s: Awaited<ReturnType<typeof setup>>,
  courseId: string,
) {
  const { f } = s;
  const enrollment = await f.as(f.parent, () =>
    f.service.enroll({
      ...f.parent,
      curriculumId: String(f.curriculum.id),
      courseId,
    }),
  );
  return String(enrollment.id);
}

/**
 * A review choice made while an attach is between reading the choices and
 * committing must not be lost: it waits for the attach and is then refused
 * (`already-attached`), and the material keeps the audience it was attached
 * with. The attach is held right after it reads the choices; the choice is
 * started outside the attach's async context, as a second request would be.
 */
export async function assertChooseDuringAttach(db?: DatabaseInterface) {
  const s = await setup(db ? { db } : {});
  const bundle = single();
  const { result, assets } = await s.importAndStore(bundle);
  const importId = result.import.importId;
  let reached: () => void = () => {};
  const atChoices = new Promise<void>((resolve) => {
    reached = resolve;
  });
  let resume: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    resume = resolve;
  });
  let armed = true;
  const forward = <T extends object>(target: T, key: string | symbol) => {
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  };
  // Hold only the attach write: the transaction that lists the course's
  // attachments and then the import's choices (an evidence read lists choices too).
  const holdAfterChoices = (tx: DatabaseInterface) => {
    let attachWrite = false;
    return new Proxy(tx, {
      get(target, key) {
        if (key !== 'list') return forward(target, key);
        return async (table: string, ...rest: unknown[]) => {
          const rows = await (
            target.list as (...args: unknown[]) => Promise<unknown>
          ).call(target, table, ...rest);
          if (table === 'course_bundle_attachments') attachWrite = true;
          if (
            armed &&
            attachWrite &&
            table === 'course_bundle_audience_choices'
          ) {
            armed = false;
            reached();
            await gate;
          }
          return rows;
        };
      },
    });
  };
  const held = new Proxy(s.db, {
    get(target, key) {
      if (key !== 'transaction') return forward(target, key);
      return (
        operation: (tx: DatabaseInterface) => Promise<unknown>,
        ...rest: unknown[]
      ) =>
        (target.transaction as (...args: unknown[]) => Promise<unknown>).call(
          target,
          (tx: DatabaseInterface) => operation(holdAfterChoices(tx)),
          ...rest,
        );
    },
  });
  const service = new CourseBundleImportService(held, s.authorizer, {
    ...(s.converter ? { converter: s.converter } : {}),
  });
  // Bound before the attach starts: the choice is a separate request, never
  // inside the attach's async context (which would make it a nested write).
  const choose = AsyncResource.bind(() =>
    s.as(s.guardian, () =>
      service.chooseMaterialAudience({
        ...s.guardian,
        importId,
        path: 'l1/handout.pdf',
        audience: 'guardian',
      }),
    ),
  );
  const attaching = s.as(s.guardian, () =>
    service.attachCourse({ ...s.guardian, importId, bundle, assets }),
  );
  await atChoices;
  const choosing = choose().then(
    () => 'chosen' as const,
    (error: unknown) => error,
  );
  const early = await Promise.race([
    choosing,
    new Promise((resolve) => setTimeout(() => resolve('waiting'), 300)),
  ]);
  resume();
  const attached = await attaching;
  const outcome = await choosing;
  // The choice could not commit while the attach held the import.
  expect(early).toBe('waiting');
  expect(outcome).toBeInstanceOf(CourseBundleMaterialsError);
  expect(outcome).toMatchObject({ reason: 'already-attached' });
  const handout = (
    await s.db.list('lesson_assets', {
      lesson_id: attached.lessons['lesson-1'],
    })
  ).find((r) => r.asset_id === assets['l1/handout.pdf']?.original);
  expect(handout?.audience).toBe('learner');
  expect(
    await s.db.list('course_bundle_audience_choices', { import_id: importId }),
  ).toEqual([]);
}
