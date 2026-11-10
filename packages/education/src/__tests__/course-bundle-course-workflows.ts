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
    'CourseBundleUnit',
    'CourseBundleSupersession',
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
  members: Array<{
    path: string;
    role: string;
    audience?: string;
    title?: string;
    step?: { key: string; order: number; label?: string };
  }>;
  pages?: Array<{ member: string; from: number; to: number; label?: string }>;
  videos?: Array<{
    reference: string;
    title: string;
    step: number | { key: string; order: number; label?: string };
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
  'l1/worksheet.pdf': () => tinyPdf('worksheet'),
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
    store,
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
 * A service whose write transactions can be held once, right after a call that
 * matches `trigger` (given the table or SQL it touched and what that
 * transaction touched before). Everything goes through the same handle, so on
 * SQLite the embedded write queue applies exactly as in production.
 */
function holdingService(
  s: Awaited<ReturnType<typeof setup>>,
  trigger: (touched: string, before: ReadonlySet<string>) => boolean,
) {
  let reached: () => void = () => {};
  const atHold = new Promise<void>((resolve) => {
    reached = resolve;
  });
  let resume: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    resume = resolve;
  });
  let armed = false;
  const forward = <T extends object>(target: T, key: string | symbol) => {
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  };
  const holdable = (tx: DatabaseInterface) => {
    const before = new Set<string>();
    return new Proxy(tx, {
      get(target, key) {
        const value = Reflect.get(target, key, target);
        if (typeof value !== 'function' || key === 'transaction')
          return forward(target, key);
        return async (...args: unknown[]) => {
          const out = await value.apply(target, args);
          const touched = typeof args[0] === 'string' ? args[0] : '';
          if (armed && touched && trigger(touched, before)) {
            armed = false;
            reached();
            await gate;
          }
          if (touched) before.add(touched);
          return out;
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
          (tx: DatabaseInterface) => operation(holdable(tx)),
          ...rest,
        );
    },
  });
  const service = new CourseBundleImportService(held, s.authorizer, {
    ...(s.converter ? { converter: s.converter } : {}),
  });
  return {
    service,
    atHold,
    resume,
    arm: () => {
      armed = true;
    },
  };
}

/** Run `second` (bound outside the held transaction) and report whether it waited. */
async function raceWhileHeld<T>(
  hold: ReturnType<typeof holdingService>,
  second: () => Promise<T>,
) {
  const settled = second().then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  const early = await Promise.race([
    settled,
    new Promise((resolve) => setTimeout(() => resolve('waiting'), 300)),
  ]);
  hold.resume();
  return { early, settled };
}

/**
 * A review choice made while an attach is between reading the choices and
 * committing must not be lost: it waits for the attach and is then refused
 * (`already-attached`), and the material keeps the audience it was attached
 * with. The choice is started outside the attach's async context, as a second
 * request would be.
 */
export async function assertChooseDuringAttach(db?: DatabaseInterface) {
  const s = await setup(db ? { db } : {});
  const bundle = single();
  const { result, assets } = await s.importAndStore(bundle);
  const importId = result.import.importId;
  // Only the attach write lists the course's attachments before the choices.
  const hold = holdingService(
    s,
    (touched, before) =>
      touched === 'course_bundle_audience_choices' &&
      before.has('course_bundle_attachments'),
  );
  const choose = AsyncResource.bind(() =>
    s.as(s.guardian, () =>
      hold.service.chooseMaterialAudience({
        ...s.guardian,
        importId,
        path: 'l1/handout.pdf',
        audience: 'guardian',
      }),
    ),
  );
  hold.arm();
  const attaching = s.as(s.guardian, () =>
    hold.service.attachCourse({ ...s.guardian, importId, bundle, assets }),
  );
  await hold.atHold;
  const { early, settled } = await raceWhileHeld(hold, choose);
  const attached = await attaching;
  const outcome = await settled;
  // The choice could not commit while the attach held the import.
  expect(early).toBe('waiting');
  expect(outcome.ok).toBe(false);
  const error = outcome.ok ? null : outcome.error;
  expect(error).toBeInstanceOf(CourseBundleMaterialsError);
  expect(error).toMatchObject({ reason: 'already-attached' });
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

/**
 * Two parts settling the same implicit placement at once (part 3 already
 * attached) must not let the last saver win: part 2 is held right after it
 * reads the shared placement, part 1 must wait for it, and the lowest part
 * (1) decides the position whatever the timing.
 */
export async function assertConcurrentPartsSettlePlacement(
  db?: DatabaseInterface,
) {
  const s = await setup(db ? { db } : {});
  const KEY = `race:${randomUUID()}`;
  const shared: Lesson = { key: 'shared', title: 'Shared', members: [] };
  const filler = (n: number): Lesson => ({
    key: `filler-${n}`,
    title: `Filler ${n}`,
    members: [],
  });
  const part = (index: number, lessons: Lesson[]) =>
    bundleOf(lessons, { key: KEY, part: { index, count: 3 } });
  // The shared lesson sits at 0 in part 1, 1 in part 2 and 2 in part 3.
  const bundles = [
    part(1, [shared, lesson1]),
    part(2, [lesson2, shared]),
    part(3, [filler(1), filler(2), shared]),
  ];
  const stored = [];
  for (const b of bundles) stored.push({ b, ...(await s.importAndStore(b)) });
  const [p1, p2, p3] = stored;
  if (!p1 || !p2 || !p3) throw new Error('three parts');
  const hold = holdingService(s, (touched) =>
    touched.includes('course_bundle_placements'),
  );
  const attach = (p: typeof p1) =>
    s.as(s.guardian, () =>
      hold.service.attachCourse({
        ...s.guardian,
        importId: p.result.import.importId,
        bundle: p.b,
        assets: p.assets,
      }),
    );
  const third = await attach(p3);
  const first = AsyncResource.bind(() => attach(p1));
  hold.arm();
  const second = attach(p2);
  await hold.atHold;
  const { early, settled } = await raceWhileHeld(hold, first);
  await second;
  const outcome = await settled;
  expect(early).toBe('waiting');
  expect(outcome.ok).toBe(true);
  const row = await s.db.get('lessons', { id: third.lessons.shared });
  expect(Number(row?.sort_order)).toBe(0);
  const placement = await s.db.get('course_bundle_placements', {
    course_id: third.courseId,
    kind: 'lesson',
    key: 'shared',
  });
  expect(Number(placement?.part_index)).toBe(1);
}

/**
 * Two first attaches of one unit that disagree (another part count, or the
 * same part from another import) never both commit. Part B is paused either
 * at the earliest point of its attach transaction (right after the import
 * lock, before the unit lock) or right after its decision reads (under the
 * unit lock); part A runs meanwhile. Exactly one attach wins and the other
 * fails with `reason`; when B holds the unit lock, A must wait for it.
 */
export async function assertFirstAttachRace(
  reason: 'unit-mismatch' | 'part-conflict',
  pause: 'before-lock' | 'after-reads',
  db?: DatabaseInterface,
) {
  const s = await setup(db ? { db } : {});
  const KEY = `first:${randomUUID()}`;
  const b = bundleOf([lesson1], { key: KEY, part: { index: 1, count: 2 } });
  const a =
    reason === 'unit-mismatch'
      ? bundleOf([lesson2], { key: KEY, part: { index: 2, count: 3 } })
      : bundleOf([lesson2], { key: KEY, part: { index: 1, count: 2 } });
  const pb = await s.importAndStore(b);
  const pa = await s.importAndStore(a);
  const hold = holdingService(s, (touched, before) =>
    pause === 'before-lock'
      ? touched.startsWith('UPDATE course_bundle_imports')
      : touched === 'course_bundle_attachments' &&
        [...before].some((t) => t.startsWith('UPDATE course_bundle_units')),
  );
  const attach = (
    bundle: typeof b,
    stored: Awaited<ReturnType<typeof s.importAndStore>>,
  ) =>
    s.as(s.guardian, () =>
      hold.service.attachCourse({
        ...s.guardian,
        importId: stored.result.import.importId,
        bundle,
        assets: stored.assets,
      }),
    );
  const runA = AsyncResource.bind(() => attach(a, pa));
  hold.arm();
  const runB = attach(b, pb).then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  await hold.atHold;
  const { early, settled } = await raceWhileHeld(hold, runA);
  const [outB, outA] = [await runB, await settled];
  if (pause === 'after-reads') {
    // B decided under the unit lock: A could not run until B committed.
    expect(early).toBe('waiting');
    expect(outB.ok).toBe(true);
  }
  const outcomes = [outA, outB];
  expect(outcomes.filter((o) => o.ok)).toHaveLength(1);
  const loser = outcomes.find((o) => !o.ok);
  expect(loser && !loser.ok ? loser.error : null).toMatchObject({ reason });
  const winner = outcomes.find((o) => o.ok);
  const courseId = winner?.ok ? winner.value.courseId : '';
  const attached = await s.db.list('course_bundle_attachments', {
    course_id: courseId,
  });
  expect(attached).toHaveLength(1);
}
