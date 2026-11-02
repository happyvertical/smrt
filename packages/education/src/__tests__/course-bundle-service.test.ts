import { getTestDatabase } from '@happyvertical/smrt-core';
import {
  disableTenancy,
  enableTenancy,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  type AcceptedCourseBundleMember,
  COURSE_AUTHORING_ACTIONS,
  type CourseAuthoringAction,
  type CourseAuthoringActor,
  CourseAuthoringAuthorizationError,
  type CourseAuthoringAuthorizer,
  type CourseBundleImport,
  CourseBundleImportService,
  type CourseBundleMember,
  CourseBundleNotFoundError,
  type CourseBundleProgress,
  CourseBundleRefusedError,
  CourseRequestKeyConflictError,
} from '../index.js';
import { buildZip, tinyPdf, tinyPng } from './bundle-zip-writer.js';
import { learnerClasses, learnerFixture } from './learner-workflows.js';

/*
 * Course bundle import service (#4578), see docs/test-matrix/4578-course-bundle-import.md:
 *  evidence, counts, handed-off members, no bytes in views ............ 'import'
 *  replay by content identity, re-zipped bundle ....................... 'replay'
 *  authority, tenant isolation, hostile input writes nothing ........... 'authority'
 *  named progress stages ............................................... 'progress'
 *  proposal through CourseGenerationReviewService, unpublished ......... 'proposal'
 *  append-only evidence ................................................ 'immutability'
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
];

beforeAll(() => enableTenancy());
afterAll(() => disableTenancy());
const opened: DatabaseInterface[] = [];
afterEach(async () => {
  for (const db of opened.splice(0)) await db.close?.();
});

const manifest = {
  version: 1,
  course: { subject: 'Math' },
  sections: [
    {
      key: 'unit-1',
      title: 'Unit One',
      lessons: [
        {
          key: 'sums',
          title: 'Sums',
          members: [
            { path: 'sheets/sums.pdf', role: 'exercise' },
            { path: 'keys/sums-key.pdf', role: 'answer_key' },
            { path: 'notes.txt' },
          ],
        },
      ],
    },
  ],
};
const entries = () => [
  { name: 'manifest.json', data: JSON.stringify(manifest) },
  { name: 'sheets/sums.pdf', data: tinyPdf('sums') },
  { name: 'keys/sums-key.pdf', data: tinyPdf('key') },
  { name: 'notes.txt', data: 'Read this first.' },
  { name: 'copy/sums-again.pdf', data: tinyPdf('sums') }, // duplicate content
  { name: 'scan.png', data: tinyPng(9), method: 0 },
  { name: 'worksheet.docx', data: 'PK? no, plain bytes' },
];
const archive = (order = entries()) => ({ archive: buildZip(order) });

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
  const reader: CourseAuthoringActor = {
    tenantId: f.own.tenantId,
    actorUserId: String(f.bob.user.id),
  };
  const outsider: CourseAuthoringActor = {
    tenantId: String(f.foreign.tenantId),
    actorUserId: String(f.stranger.user.id),
  };
  const grants = new Map<string, CourseAuthoringAction[]>([
    [guardian.actorUserId, [...COURSE_AUTHORING_ACTIONS]],
    [reader.actorUserId, ['education.course.read-draft']],
    [outsider.actorUserId, [...COURSE_AUTHORING_ACTIONS]],
  ]);
  const authorizer: CourseAuthoringAuthorizer = (call) =>
    (grants.get(call.actorUserId) ?? []).includes(call.action);
  const service = new CourseBundleImportService(db, authorizer);
  const as = <T>(actor: CourseAuthoringActor, fn: () => Promise<T>) =>
    withTenant({ tenantId: actor.tenantId, userId: actor.actorUserId }, fn);
  let counter = 0;
  const key = (label: string) => `${label}-${++counter}`;
  const importBundle = (
    bundle: Parameters<CourseBundleImportService['importBundle']>[0]['bundle'],
    actor = guardian,
    extra: Record<string, unknown> = {},
  ) => as(actor, () => service.importBundle({ ...actor, bundle, ...extra }));
  async function course() {
    const head = await as(guardian, () =>
      service.createCourse({
        ...guardian,
        requestKey: key('c'),
        title: 'Imported',
      }),
    );
    return { courseId: head.courseId, headRevisionId: head.headRevisionId };
  }
  const count = async (table: string) => (await db.list(table, {})).length;
  return {
    db,
    f,
    service,
    guardian,
    reader,
    outsider,
    as,
    key,
    importBundle,
    course,
    count,
  };
}

describe('course bundle import', () => {
  it('records member evidence and hands accepted members to the host', async () => {
    const s = await setup();
    const received: AcceptedCourseBundleMember[] = [];
    const {
      import: view,
      accepted,
      receipts,
    } = await s.importBundle(archive(), s.guardian, {
      receiveMember: (member: AcceptedCourseBundleMember) => {
        received.push(member);
        return `item-${member.path}`;
      },
    });
    expect(view).toMatchObject({
      format: 'zip',
      readerId: 'manifest-v1',
      manifestVersion: 1,
      replayed: false,
      entryCount: 7,
      acceptedCount: 4,
      duplicateCount: 1,
      unsupportedCount: 1,
      refusedCount: 0,
    });
    const byPath = Object.fromEntries(view.members.map((m) => [m.path, m]));
    expect(byPath['copy/sums-again.pdf']).toMatchObject({
      status: 'duplicate',
      duplicateOfPath: 'sheets/sums.pdf',
    });
    expect(byPath['worksheet.docx']).toMatchObject({
      status: 'unsupported',
      reason: 'unsupported_type',
    });
    expect(byPath['keys/sums-key.pdf']).toMatchObject({
      role: 'answer_key',
      lessonKey: 'sums',
      sectionKey: 'unit-1',
    });
    expect(byPath['manifest.json']?.status).toBe('metadata');
    // Declared order first: the manifest-listed members precede the rest.
    expect(view.members.map((m) => m.path).slice(0, 4)).toEqual([
      'manifest.json',
      'sheets/sums.pdf',
      'keys/sums-key.pdf',
      'notes.txt',
    ]);
    // Only accepted, unique members reach extraction; roles travel with them.
    expect(received.map((m) => m.path)).toEqual(accepted.map((m) => m.path));
    expect(received.map((m) => m.path)).toEqual([
      'sheets/sums.pdf',
      'keys/sums-key.pdf',
      'notes.txt',
      'scan.png',
    ]);
    expect(received[1]).toMatchObject({ role: 'answer_key', kind: 'pdf' });
    expect(Object.keys(receipts)).toHaveLength(4);
    // The view is evidence only: no bytes, no text.
    expect(JSON.stringify(view)).not.toMatch(/Read this first|%PDF/);
    expect(await s.count('course_bundle_members')).toBe(7);
  });

  it('imports a plain file set with deterministic layout', async () => {
    const s = await setup();
    const files = [
      { path: 'unit-2/b.pdf', bytes: tinyPdf('b') },
      { path: 'unit-1/a.pdf', bytes: tinyPdf('a') },
    ];
    const { import: view } = await s.importBundle({ files });
    expect(view).toMatchObject({ format: 'files', readerId: 'plain-files' });
    expect(view.members.map((m) => m.path)).toEqual([
      'unit-1/a.pdf',
      'unit-2/b.pdf',
    ]);
    const again = await s.importBundle({ files: [...files].reverse() });
    expect(again.import.importId).toBe(view.importId);
    expect(again.import.replayed).toBe(true);
  });

  it('replays the same bundle, even re-zipped in another order', async () => {
    const s = await setup();
    const first = await s.importBundle(archive());
    const second = await s.importBundle(archive([...entries()].reverse()));
    expect(second.import.replayed).toBe(true);
    expect(second.import.importId).toBe(first.import.importId);
    expect(second.import.members).toEqual(first.import.members);
    expect(await s.count('course_bundle_imports')).toBe(1);
    expect(await s.count('course_bundle_members')).toBe(7);
    // A replay still hands members over, flagged, so an interrupted run can resume.
    const seen: boolean[] = [];
    await s.importBundle(archive(), s.guardian, {
      receiveMember: (_m: unknown, ctx: { replayed: boolean }) => {
        seen.push(ctx.replayed);
      },
    });
    expect(seen).toEqual([true, true, true, true]);
    // A changed member is a different bundle.
    const changed = entries();
    changed[3] = { name: 'notes.txt', data: 'Different notes.' };
    const third = await s.importBundle(archive(changed));
    expect(third.import.replayed).toBe(false);
    expect(third.import.importId).not.toBe(first.import.importId);
  });

  it('keeps each tenant separate for the same bytes', async () => {
    const s = await setup();
    const mine = await s.importBundle(archive());
    const theirs = await s.importBundle(archive(), s.outsider);
    expect(theirs.import.replayed).toBe(false);
    expect(theirs.import.importId).not.toBe(mine.import.importId);
  });

  it('emits the named stages in order and survives a throwing listener', async () => {
    const s = await setup();
    const events: CourseBundleProgress[] = [];
    await s.importBundle(archive(), s.guardian, {
      onProgress: (e: CourseBundleProgress) => events.push(e),
      receiveMember: () => undefined,
    });
    const stages = events
      .map((e) => e.stage)
      .filter((stage, i, all) => all.indexOf(stage) === i);
    expect(stages).toEqual(['unpack', 'classify', 'extract']);
    for (const stage of stages) {
      const own = events.filter((e) => e.stage === stage);
      expect(own[0]?.completed).toBe(0);
      expect(own.at(-1)?.completed).toBe(own.at(-1)?.total);
    }
    const ok = await s.importBundle(archive(), s.guardian, {
      onProgress: () => {
        throw new Error('listener bug');
      },
    });
    expect(ok.import.replayed).toBe(true);
  });
});

describe('authority and hostile input', () => {
  it('denies import without education.course.author, before parsing anything', async () => {
    const s = await setup();
    let parsed = false;
    await expect(
      s.importBundle(archive(), s.reader, {
        onProgress: () => {
          parsed = true;
        },
      }),
    ).rejects.toBeInstanceOf(CourseAuthoringAuthorizationError);
    expect(parsed).toBe(false);
    // No tenant session at all.
    await expect(
      s.service.importBundle({ ...s.guardian, bundle: archive() }),
    ).rejects.toBeInstanceOf(CourseAuthoringAuthorizationError);
    // A session for another actor than the request.
    await expect(
      s.as(s.outsider, () =>
        s.service.importBundle({ ...s.guardian, bundle: archive() }),
      ),
    ).rejects.toBeInstanceOf(CourseAuthoringAuthorizationError);
    expect(await s.count('course_bundle_imports')).toBe(0);
  });

  it('writes nothing for a hostile bundle', async () => {
    const s = await setup();
    for (const hostile of [
      { archive: buildZip([{ name: '../evil.txt', data: 'x' }]) },
      { archive: Buffer.from('definitely not a zip file') },
      { files: [{ path: '/abs.txt', bytes: Buffer.from('x') }] },
      {
        archive: buildZip([
          { name: 'manifest.json', data: '{"version":1,"sections":[],"x":1}' },
        ]),
      },
    ])
      await expect(s.importBundle(hostile)).rejects.toBeInstanceOf(
        CourseBundleRefusedError,
      );
    expect(await s.count('course_bundle_imports')).toBe(0);
    expect(await s.count('course_bundle_members')).toBe(0);
  });

  it('shows recorded evidence only to an authorized actor of the owning tenant', async () => {
    const s = await setup();
    const { import: view } = await s.importBundle(archive());
    const read = await s.as(s.reader, () =>
      s.service.readImport({ ...s.reader, importId: view.importId }),
    );
    expect(read.members).toEqual(view.members);
    await expect(
      s.as(s.outsider, () =>
        s.service.readImport({ ...s.outsider, importId: view.importId }),
      ),
    ).rejects.toBeInstanceOf(CourseBundleNotFoundError);
    await expect(
      s.as(s.reader, () =>
        s.service.readImport({ ...s.reader, importId: 'nope' }),
      ),
    ).rejects.toBeInstanceOf(CourseBundleNotFoundError);
  });

  it('records an encrypted PDF and an oversize member as visible refusals', async () => {
    const s = await setup();
    const limited = new CourseBundleImportService(s.db, () => true, {
      limits: { maxEntryBytes: 200 },
    });
    const { import: view } = await s.as(s.guardian, () =>
      limited.importBundle({
        ...s.guardian,
        bundle: {
          files: [
            { path: 'locked.pdf', bytes: tinyPdf('locked', true) },
            {
              path: 'huge.pdf',
              bytes: Buffer.concat([tinyPdf('h'), Buffer.alloc(400)]),
            },
            { path: 'ok.pdf', bytes: tinyPdf('ok') },
          ],
        },
      }),
    );
    const by = Object.fromEntries(view.members.map((m) => [m.path, m]));
    expect(by['locked.pdf']).toMatchObject({
      status: 'refused',
      reason: 'encrypted_pdf',
    });
    expect(by['huge.pdf']).toMatchObject({
      status: 'refused',
      reason: 'entry_too_large',
      sha256: null,
    });
    expect(by['ok.pdf']?.status).toBe('accepted');
    expect(view.refusedCount).toBe(2);
  });
});

describe('structure proposal', () => {
  it('proposes sections and lessons for review and publishes nothing', async () => {
    const s = await setup();
    const c = await s.course();
    const { import: view } = await s.importBundle(archive());
    const events: CourseBundleProgress[] = [];
    const generation = await s.as(s.guardian, () =>
      s.service.proposeStructure({
        ...s.guardian,
        importId: view.importId,
        bundle: archive(),
        courseId: c.courseId,
        expectedHeadRevisionId: c.headRevisionId,
        onProgress: (e: CourseBundleProgress) => events.push(e),
      }),
    );
    expect(generation.status).toBe('succeeded');
    expect(generation.provider).toBe('smrt-bundle-import');
    expect(generation.resultRevisionId).toBeTruthy();
    expect(
      events.filter((e) => e.stage === 'propose').map((e) => e.completed),
    ).toEqual([0, 1]);
    const draft = await s.as(s.guardian, () =>
      s.service.readDraft({
        ...s.guardian,
        courseId: c.courseId,
        revisionId: generation.resultRevisionId as string,
      }),
    );
    const lessons = draft.revision.sections.flatMap((x) => x.lessons);
    expect(lessons.map((l) => l.title)).toEqual(['Sums']);
    expect(lessons[0]?.body).toBe('Read this first.');
    expect(draft.revision.sections[0]?.title).toBe('Unit One');
    expect(draft.head.headRevisionId).toBe(generation.resultRevisionId);
    expect(draft.head.state).not.toBe('released');
    // Nothing published or assigned.
    expect(await s.count('course_releases')).toBe(0);
    expect(await s.count('released_lessons')).toBe(0);
    expect(await s.count('enrollment_release_pins')).toBe(0);
  });

  it('never lets answer-key or mixed text members into lesson bodies', async () => {
    const KEY = 'SENTINEL-ANSWER-KEY-7731';
    const MIXED = 'SENTINEL-MIXED-PAGE-2290';
    const keyed = {
      ...manifest,
      sections: [
        {
          key: 'unit-1',
          title: 'Unit One',
          lessons: [
            {
              key: 'sums',
              title: 'Sums',
              members: [
                { path: 'notes.txt', role: 'instructions' },
                { path: 'key.txt', role: 'answer_key' },
                { path: 'mixed.txt', role: 'mixed' },
              ],
            },
            {
              key: 'keyonly',
              title: 'Key only',
              members: [{ path: 'key2.txt', role: 'answer_key' }],
            },
          ],
        },
      ],
    };
    const keyedArchive = () => ({
      archive: buildZip([
        { name: 'manifest.json', data: JSON.stringify(keyed) },
        { name: 'notes.txt', data: 'Read this first.' },
        { name: 'key.txt', data: KEY },
        { name: 'mixed.txt', data: MIXED },
        { name: 'key2.txt', data: `${KEY} again` },
      ]),
    });
    const s = await setup();
    const c = await s.course();
    const { import: view } = await s.importBundle(keyedArchive());
    const generation = await s.as(s.guardian, () =>
      s.service.proposeStructure({
        ...s.guardian,
        importId: view.importId,
        bundle: keyedArchive(),
        courseId: c.courseId,
        expectedHeadRevisionId: c.headRevisionId,
      }),
    );
    const draft = await s.as(s.guardian, () =>
      s.service.readDraft({
        ...s.guardian,
        courseId: c.courseId,
        revisionId: generation.resultRevisionId as string,
      }),
    );
    const lessons = draft.revision.sections.flatMap((x) => x.lessons);
    expect(lessons.map((l) => l.title)).toEqual(['Sums', 'Key only']);
    expect(lessons[0]?.body).toBe('Read this first.');
    const serialized = JSON.stringify({ generation, draft });
    expect(serialized).not.toContain(KEY);
    expect(serialized).not.toContain(MIXED);
    // The members remain recorded evidence.
    expect(await s.count('course_bundle_members')).toBe(5);
  });

  it('replays per course and bundle, and refuses a changed request for the same key', async () => {
    const s = await setup();
    const c = await s.course();
    const { import: view } = await s.importBundle(archive());
    const propose = (expectedHeadRevisionId: string, bundle = archive()) =>
      s.as(s.guardian, () =>
        s.service.proposeStructure({
          ...s.guardian,
          importId: view.importId,
          bundle,
          courseId: c.courseId,
          expectedHeadRevisionId,
        }),
      );
    const first = await propose(c.headRevisionId);
    const second = await propose(
      c.headRevisionId,
      archive([...entries()].reverse()),
    );
    expect(second.jobId).toBe(first.jobId);
    expect(await s.count('course_generation_jobs')).toBe(1);
    await expect(propose('some-other-head')).rejects.toBeInstanceOf(
      CourseRequestKeyConflictError,
    );
  });

  it('refuses a bundle that is not the imported one, and other tenants or readers', async () => {
    const s = await setup();
    const c = await s.course();
    const { import: view } = await s.importBundle(archive());
    const request = (actor: CourseAuthoringActor, bundle = archive()) =>
      s.as(actor, () =>
        s.service.proposeStructure({
          ...actor,
          importId: view.importId,
          bundle,
          courseId: c.courseId,
          expectedHeadRevisionId: c.headRevisionId,
        }),
      );
    await expect(
      request(s.guardian, {
        archive: buildZip([{ name: 'other.txt', data: 'other' }]),
      }),
    ).rejects.toBeInstanceOf(CourseBundleNotFoundError);
    // read-draft only: cannot request a generation.
    await expect(request(s.reader)).rejects.toBeInstanceOf(
      CourseAuthoringAuthorizationError,
    );
    // Another tenant cannot see the import.
    await expect(request(s.outsider)).rejects.toBeInstanceOf(
      CourseBundleNotFoundError,
    );
    expect(await s.count('course_generation_jobs')).toBe(0);
  });
});

describe('immutability', () => {
  it('rejects rewrites and deletes of bundle evidence', async () => {
    const s = await setup();
    await s.importBundle(archive());
    const row = (await s.db.list('course_bundle_imports', {}))[0] as {
      id: string;
    };
    const member = (await s.db.list('course_bundle_members', {}))[0] as {
      id: string;
    };
    await s.as(s.guardian, async () => {
      const imports = await (
        await import('../index.js')
      ).CourseBundleImportCollection.create({ db: s.db });
      const loaded = (await imports.get({ id: row.id })) as CourseBundleImport;
      loaded.totalBytes = 1;
      await expect(loaded.save()).rejects.toThrow(/immutable/);
      await expect(loaded.delete()).rejects.toThrow(/immutable/);
      const members = await (
        await import('../index.js')
      ).CourseBundleMemberCollection.create({ db: s.db });
      const m = (await members.get({ id: member.id })) as CourseBundleMember;
      m.status = 'accepted';
      await expect(m.save()).rejects.toThrow(/immutable/);
      await expect(m.delete()).rejects.toThrow(/immutable/);
    });
  });
});
