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
  DocumentConversionError,
  type DocumentConversionRequest,
  type DocumentConverter,
  FakeDocumentConverter,
  type OfficeTextReader,
} from '../index.js';
import { buildZip, tinyPdf } from './bundle-zip-writer.js';
import { learnerClasses, learnerFixture } from './learner-workflows.js';
import { officeDocx, officePptx } from './office-fixtures.js';

/*
 * Word and PowerPoint bundle members (#4615), see docs/test-matrix/4615-bundle-office-members.md:
 *  accepted with rendered PDF, text and original kept ................ 'render'
 *  converter failure / limits fail closed, member unsupported ........ 'fail closed'
 *  replay, duplicates, proposal consistency ........................ 'replay'
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

const files = (extra: Array<{ path: string; bytes: Uint8Array }> = []) => ({
  files: [
    { path: 'sheets/sums.pdf', bytes: tinyPdf('sums') },
    { path: 'guide/teacher.docx', bytes: officeDocx('teacher guide') },
    { path: 'slides/unit.pptx', bytes: officePptx('unit deck') },
    ...extra,
  ],
});
const textReader: OfficeTextReader = {
  async read({ kind, bytes }) {
    return kind === 'pptx'
      ? {
          text: 'Slide one',
          slides: [{ index: 1, text: 'Slide one', notes: 'Say hello' }],
        }
      : { text: `docx ${bytes.byteLength}` };
  },
};
const withConverter = async (
  converter: DocumentConverter | undefined,
  options: Record<string, unknown> = {},
) => {
  const s = await setup();
  const service = new CourseBundleImportService(
    s.db,
    (call) => call.actorUserId === s.guardian.actorUserId,
    { converter, ...options },
  );
  const run = (
    bundle: Parameters<CourseBundleImportService['importBundle']>[0]['bundle'],
    extra: Record<string, unknown> = {},
  ) =>
    s.as(s.guardian, () =>
      service.importBundle({ ...s.guardian, bundle, ...extra }),
    );
  return { ...s, service, run };
};

describe('Word and PowerPoint bundle members', () => {
  it('renders each Office member, keeps the original and hands both to the host', async () => {
    const converter = new FakeDocumentConverter();
    const s = await withConverter(converter, { officeTextReader: textReader });
    const received: AcceptedCourseBundleMember[] = [];
    const { import: view, accepted } = await s.run(files(), {
      receiveMember: (m: AcceptedCourseBundleMember) => void received.push(m),
    });
    expect(view).toMatchObject({
      acceptedCount: 3,
      unsupportedCount: 0,
      refusedCount: 0,
    });
    const byPath = Object.fromEntries(view.members.map((m) => [m.path, m]));
    expect(byPath['guide/teacher.docx']).toMatchObject({
      kind: 'docx',
      status: 'accepted',
      mediaType:
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });
    expect(byPath['slides/unit.pptx']).toMatchObject({
      kind: 'pptx',
      status: 'accepted',
    });
    expect(byPath['sheets/sums.pdf']).toMatchObject({
      renderedSha256: null,
      renderedSizeBytes: 0,
    });
    const deck = accepted.find((m) => m.path === 'slides/unit.pptx');
    expect(deck?.bytes.byteLength).toBeGreaterThan(0);
    expect(deck?.rendered?.mediaType).toBe('application/pdf');
    expect(Buffer.from(deck?.rendered?.bytes ?? []).toString()).toContain(
      '%PDF-',
    );
    expect(deck?.rendered?.converterId).toBe('fake');
    expect(byPath['slides/unit.pptx']?.renderedSha256).toBe(
      deck?.rendered?.sha256,
    );
    expect(byPath['slides/unit.pptx']?.renderedSizeBytes).toBe(
      deck?.rendered?.bytes.byteLength,
    );
    expect(deck?.officeText?.slides).toEqual([
      { index: 1, text: 'Slide one', notes: 'Say hello' },
    ]);
    expect(
      accepted.find((m) => m.path === 'guide/teacher.docx')?.officeText?.text,
    ).toMatch(/^docx /);
    expect(
      accepted.find((m) => m.path === 'sheets/sums.pdf')?.rendered,
    ).toBeNull();
    expect(received.map((m) => m.path)).toEqual(accepted.map((m) => m.path));
    // The converter sees a neutral name, never the bundle path.
    expect(converter.calls.map((c) => c.fileName).sort()).toEqual([
      'document.docx',
      'document.pptx',
    ]);
    // No bytes in the view.
    expect(JSON.stringify(view)).not.toContain('PK');
  });

  it('emits a render stage only when there are Office members', async () => {
    const s = await withConverter(new FakeDocumentConverter());
    const events: CourseBundleProgress[] = [];
    await s.run(files(), {
      onProgress: (e: CourseBundleProgress) => events.push(e),
    });
    expect(
      events.filter((e) => e.stage === 'render').map((e) => e.completed),
    ).toEqual([0, 1, 2]);
    const none: CourseBundleProgress[] = [];
    await s.run(
      { files: [{ path: 'a.pdf', bytes: tinyPdf('a') }] },
      { onProgress: (e: CourseBundleProgress) => none.push(e) },
    );
    expect(none.some((e) => e.stage === 'render')).toBe(false);
  });

  it('reads text on a best-effort basis: a failing reader never costs the member its pages', async () => {
    const s = await withConverter(new FakeDocumentConverter(), {
      officeTextReader: {
        read: async () => {
          throw new Error('engine crashed');
        },
      },
    });
    const { accepted } = await s.run(files());
    const docx = accepted.find((m) => m.kind === 'docx');
    expect(docx?.rendered).not.toBeNull();
    expect(docx?.officeText).toBeNull();
  });

  it('never puts Office text into a proposed lesson body', async () => {
    const s = await withConverter(new FakeDocumentConverter(), {
      officeTextReader: textReader,
    });
    const { import: view } = await s.run(files());
    const c = await s.course();
    const generation = await s.as(s.guardian, () =>
      s.service.proposeStructure({
        ...s.guardian,
        importId: view.importId,
        bundle: files(),
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
    expect(lessons.map((l) => l.title).sort()).toEqual([
      'sums',
      'teacher',
      'unit',
    ]);
    expect(JSON.stringify(draft)).not.toContain('Say hello');
    expect(JSON.stringify(draft)).not.toContain('Slide one');
  });

  describe('fail closed', () => {
    it('records every Office member unsupported when no converter is configured', async () => {
      const s = await withConverter(undefined);
      const { import: view, accepted } = await s.run(files());
      expect(view).toMatchObject({ acceptedCount: 1, unsupportedCount: 2 });
      for (const path of ['guide/teacher.docx', 'slides/unit.pptx'])
        expect(view.members.find((m) => m.path === path)).toMatchObject({
          status: 'unsupported',
          reason: 'converter_unavailable',
          renderedSha256: null,
        });
      expect(accepted.map((m) => m.path)).toEqual(['sheets/sums.pdf']);
    });

    it.each([
      ['unavailable', 'converter_failed'],
      ['timeout', 'converter_timeout'],
      ['too_large', 'converter_too_large'],
      ['rejected', 'converter_rejected'],
      ['invalid_output', 'converter_rejected'],
    ] as const)('maps converter failure %s to %s without losing the other members', async (failWith, reason) => {
      const s = await withConverter(new FakeDocumentConverter({ failWith }));
      const { import: view, accepted } = await s.run(files());
      expect(view.acceptedCount).toBe(1);
      expect(
        view.members
          .filter((m) => m.status === 'unsupported')
          .map((m) => m.reason),
      ).toEqual([reason, reason]);
      expect(accepted.map((m) => m.kind)).toEqual(['pdf']);
    });

    it('fails only the files the converter rejects', async () => {
      const s = await withConverter(
        new FakeDocumentConverter({ failWhen: (r) => r.kind === 'pptx' }),
      );
      const { import: view } = await s.run(files());
      expect(view.members.find((m) => m.kind === 'docx')?.status).toBe(
        'accepted',
      );
      expect(view.members.find((m) => m.kind === 'pptx')).toMatchObject({
        status: 'unsupported',
        reason: 'converter_rejected',
      });
    });

    it('treats a thrown non-conversion error as an unavailable service', async () => {
      const s = await withConverter({
        id: 'boom',
        convertToPdf: async () => {
          throw new Error('socket hang up');
        },
      });
      const { import: view } = await s.run(files());
      expect(view.members.find((m) => m.kind === 'docx')).toMatchObject({
        status: 'unsupported',
        reason: 'converter_failed',
      });
    });

    it('enforces the output byte limit itself, whatever the adapter does', async () => {
      const s = await withConverter(new FakeDocumentConverter());
      const { import: view } = await s.run(files(), {
        limits: { maxRenderedBytes: 8 },
      });
      expect(view.members.find((m) => m.kind === 'docx')).toMatchObject({
        status: 'unsupported',
        reason: 'converter_too_large',
      });
    });

    it.each([
      ['not a PDF', Buffer.from('<html>error page</html>')],
      ['an encrypted PDF', Buffer.from('%PDF-1.7\n/Encrypt 5 0 R\n%%EOF')],
      ['an empty answer', new Uint8Array()],
    ])('refuses %s from the converter', async (_label, output) => {
      const s = await withConverter(new FakeDocumentConverter({ output }));
      const { import: view } = await s.run(files());
      expect(view.members.find((m) => m.kind === 'docx')).toMatchObject({
        status: 'unsupported',
        reason: 'converter_rejected',
      });
    });

    it('enforces the time limit even when the adapter ignores the abort signal', async () => {
      const seen: DocumentConversionRequest[] = [];
      const s = await withConverter({
        id: 'stuck',
        convertToPdf: (request) => {
          seen.push(request);
          return new Promise(() => undefined);
        },
      });
      const { import: view } = await s.run(files(), {
        limits: { conversionTimeoutMs: 20 },
      });
      expect(view.members.find((m) => m.kind === 'pptx')).toMatchObject({
        status: 'unsupported',
        reason: 'converter_timeout',
      });
      expect(seen.every((r) => r.signal.aborted)).toBe(true);
      expect(seen[0]?.limits).toMatchObject({
        timeoutMs: 20,
        maxInputBytes: 50 * 1024 * 1024,
      });
    });

    it('stops rendering beyond the Office member limit', async () => {
      const converter = new FakeDocumentConverter();
      const s = await withConverter(converter);
      const { import: view, accepted } = await s.run(files(), {
        limits: { maxOfficeMembers: 1 },
      });
      expect(converter.calls).toHaveLength(1);
      expect(
        view.members.find((m) => m.path === 'slides/unit.pptx'),
      ).toMatchObject({ status: 'unsupported', reason: 'office_limit' });
      expect(accepted.map((m) => m.path)).toEqual([
        'guide/teacher.docx',
        'sheets/sums.pdf',
      ]);
    });

    it('refuses an Office package that fails the zip bounds, before any converter sees it', async () => {
      const converter = new FakeDocumentConverter();
      const s = await withConverter(converter);
      const bomb = officeDocx('x', [
        { name: 'word/media/huge.bin', data: Buffer.alloc(8 * 1024 * 1024) },
      ]);
      const { import: view } = await s.run({
        files: [
          { path: 'bomb.docx', bytes: bomb },
          { path: 'a.pdf', bytes: tinyPdf('a') },
        ],
      });
      expect(view.members.find((m) => m.path === 'bomb.docx')).toMatchObject({
        status: 'refused',
        reason: 'unsafe_office',
      });
      expect(converter.calls).toHaveLength(0);
    });

    it('keeps ordinary files that merely end in .docx or .pptx visible as unsupported', async () => {
      const converter = new FakeDocumentConverter();
      const s = await withConverter(converter);
      const noMain = Buffer.from(
        buildZip([{ name: '[Content_Types].xml', data: '<Types/>' }]),
      );
      const { import: view } = await s.run({
        files: [
          { path: 'plain.docx', bytes: Buffer.from('not a zip at all') },
          { path: 'empty.pptx', bytes: noMain },
          { path: 'a.pdf', bytes: tinyPdf('a') },
        ],
      });
      expect(
        view.members
          .filter((m) => m.status === 'unsupported')
          .map((m) => m.path)
          .sort(),
      ).toEqual(['empty.pptx', 'plain.docx']);
      expect(converter.calls).toHaveLength(0);
    });

    it('leaves a member that failed out of the proposed structure', async () => {
      const s = await withConverter(
        new FakeDocumentConverter({ failWhen: (r) => r.kind === 'pptx' }),
      );
      const { import: view } = await s.run(files());
      const c = await s.course();
      const generation = await s.as(s.guardian, () =>
        s.service.proposeStructure({
          ...s.guardian,
          importId: view.importId,
          bundle: files(),
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
      expect(
        draft.revision.sections
          .flatMap((x) => x.lessons)
          .map((l) => l.title)
          .sort(),
      ).toEqual(['sums', 'teacher']);
    });

    it('does not call the converter for an unauthorized actor', async () => {
      const converter = new FakeDocumentConverter();
      const s = await withConverter(converter);
      await expect(
        s.as(s.reader, () =>
          s.service.importBundle({ ...s.reader, bundle: files() }),
        ),
      ).rejects.toBeInstanceOf(CourseAuthoringAuthorizationError);
      expect(converter.calls).toHaveLength(0);
    });
  });

  describe('replay and duplicates', () => {
    it('renders identical documents once and records the second as a duplicate', async () => {
      const converter = new FakeDocumentConverter();
      const s = await withConverter(converter);
      const same = officeDocx('same');
      const { import: view, accepted } = await s.run({
        files: [
          { path: 'a/one.docx', bytes: same },
          { path: 'b/two.docx', bytes: same },
        ],
      });
      expect(converter.calls).toHaveLength(1);
      expect(view.members.find((m) => m.path === 'b/two.docx')).toMatchObject({
        status: 'duplicate',
        duplicateOfPath: 'a/one.docx',
        renderedSha256: null,
      });
      expect(accepted.map((m) => m.path)).toEqual(['a/one.docx']);
    });

    it('a failed original makes its identical copies fail the same way, not duplicates of nothing', async () => {
      const s = await withConverter(
        new FakeDocumentConverter({ failWith: 'rejected' }),
      );
      const same = officeDocx('same');
      const { import: view } = await s.run({
        files: [
          { path: 'a.docx', bytes: same },
          { path: 'b.docx', bytes: same },
          { path: 'c.pdf', bytes: tinyPdf('c') },
        ],
      });
      expect(view.duplicateCount).toBe(0);
      expect(
        view.members.filter((m) => m.reason === 'converter_rejected'),
      ).toHaveLength(2);
    });

    it('replays recorded outcomes: failures are not retried, accepted members are re-rendered for the host', async () => {
      const first = new FakeDocumentConverter({
        failWhen: (r) => r.kind === 'pptx',
      });
      const s = await withConverter(first);
      await s.run(files());
      expect(first.calls).toHaveLength(2);
      // A healthy converter on the replay: the recorded failure stands.
      const healthy = new FakeDocumentConverter();
      const replayService = new CourseBundleImportService(
        s.db,
        (call) => call.actorUserId === s.guardian.actorUserId,
        { converter: healthy },
      );
      const replay = await s.as(s.guardian, () =>
        replayService.importBundle({ ...s.guardian, bundle: files() }),
      );
      expect(replay.import.replayed).toBe(true);
      expect(healthy.calls.map((c) => c.kind)).toEqual(['docx']);
      expect(
        replay.import.members.find((m) => m.kind === 'pptx'),
      ).toMatchObject({ status: 'unsupported', reason: 'converter_rejected' });
      expect(replay.accepted.map((m) => m.kind).sort()).toEqual([
        'docx',
        'pdf',
      ]);
      expect(
        replay.accepted.find((m) => m.kind === 'docx')?.rendered,
      ).not.toBeNull();
      expect(await s.count('course_bundle_members')).toBe(3);
    });

    it('reconciles two concurrent first imports whose conversions disagreed', async () => {
      const s = await withConverter(new FakeDocumentConverter());
      const authorize = (call: { actorUserId: string }) =>
        call.actorUserId === s.guardian.actorUserId;
      const make = (converter: DocumentConverter) =>
        new CourseBundleImportService(s.db, authorize, { converter });
      const run = (service: CourseBundleImportService) =>
        s.as(s.guardian, () =>
          service.importBundle({ ...s.guardian, bundle: files() }),
        );
      // The healthy import wins the write; the slower failing one must not hand
      // a recorded-accepted member's absence over silently.
      const winner = run(make(new FakeDocumentConverter()));
      const loser = run(
        make(new FakeDocumentConverter({ delayMs: 40, failWith: 'rejected' })),
      );
      expect((await winner).accepted.map((m) => m.kind).sort()).toEqual([
        'docx',
        'pdf',
        'pptx',
      ]);
      await expect(loser).rejects.toBeInstanceOf(DocumentConversionError);
      expect(await s.count('course_bundle_members')).toBe(3);
    });

    it('does not hand a member to the host that the winning concurrent import recorded unsupported', async () => {
      const s = await withConverter(new FakeDocumentConverter());
      const authorize = (call: { actorUserId: string }) =>
        call.actorUserId === s.guardian.actorUserId;
      const make = (converter: DocumentConverter) =>
        new CourseBundleImportService(s.db, authorize, { converter });
      const run = (service: CourseBundleImportService, received: string[]) =>
        s.as(s.guardian, () =>
          service.importBundle({
            ...s.guardian,
            bundle: files(),
            receiveMember: (m: AcceptedCourseBundleMember) =>
              void received.push(m.path),
          }),
        );
      const winnerSeen: string[] = [];
      const loserSeen: string[] = [];
      const winner = run(
        make(new FakeDocumentConverter({ failWith: 'rejected' })),
        winnerSeen,
      );
      const loser = run(
        make(new FakeDocumentConverter({ delayMs: 40 })),
        loserSeen,
      );
      await winner;
      const result = await loser;
      expect(result.import.replayed).toBe(true);
      expect(result.accepted.map((m) => m.path)).toEqual(['sheets/sums.pdf']);
      expect(loserSeen).toEqual(['sheets/sums.pdf']);
    });

    it('a replay that can no longer render a recorded-accepted member fails instead of dropping it', async () => {
      const s = await withConverter(new FakeDocumentConverter());
      await s.run(files());
      const down = new CourseBundleImportService(
        s.db,
        (call) => call.actorUserId === s.guardian.actorUserId,
        {
          converter: new FakeDocumentConverter({ failWith: 'unavailable' }),
        },
      );
      await expect(
        s.as(s.guardian, () =>
          down.importBundle({ ...s.guardian, bundle: files() }),
        ),
      ).rejects.toBeInstanceOf(DocumentConversionError);
      const none = new CourseBundleImportService(
        s.db,
        (call) => call.actorUserId === s.guardian.actorUserId,
      );
      await expect(
        s.as(s.guardian, () =>
          none.importBundle({ ...s.guardian, bundle: files() }),
        ),
      ).rejects.toBeInstanceOf(DocumentConversionError);
      expect(await s.count('course_bundle_imports')).toBe(1);
    });
  });
});
