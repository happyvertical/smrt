import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AssetCollection,
  createAssetRuntime,
} from '@happyvertical/smrt-assets';
import { withTenant } from '@happyvertical/smrt-tenancy';
import { PDFDocument } from 'pdf-lib';
import { expect } from 'vitest';
import {
  CourseCollection,
  CourseSectionCollection,
  GradeCollection,
  LessonProgressCollection,
  ScannedSubmissionCollection,
  SubmissionAssetCollection,
  SubmissionIntakeBindingCollection,
  WorksheetCollection,
} from '../collections.js';
import type { LearnerAuthorizer, LearnerRequest } from '../learner-service.js';
import {
  type SubmissionAssetClaim,
  SubmissionService,
  type SubmissionServiceOptions,
  SubmissionStorageCleanupError,
} from '../submission-service.js';
import { learnerClasses, type learnerFixture } from './learner-workflows.js';
export const submissionClasses = [
  ...learnerClasses,
  'Submission',
  'SubmissionIntakeBinding',
  'ScannedSubmission',
  'ExternalCompletion',
  'Attestation',
  'SubmissionAsset',
  'Grade',
  'Worksheet',
  'AssetAssociation',
];
type Fixture = Awaited<ReturnType<typeof learnerFixture>>;
const page = {
  name: 'page.png',
  mimeType: 'image/png' as const,
  data: Buffer.from('uploaded page'),
};
async function environment(
  f: Fixture,
  override: Partial<SubmissionServiceOptions> = {},
  authorize?: LearnerAuthorizer,
) {
  const storage = await mkdtemp(join(tmpdir(), 'education-submission-'));
  const claims: Readonly<SubmissionAssetClaim>[] = [];
  const service = new SubmissionService(
    f.db,
    authorize ??
      (({ own, relationshipTypeId }) =>
        own || relationshipTypeId === f.guardianType.id),
    () => true,
    {
      storage,
      signAsset: async (claim) => {
        claims.push(claim);
        return `https://school.test/assets/${claim.assetId}?signed=true`;
      },
      ...override,
    },
  );
  const request = {
    ...f.own,
    enrollmentId: f.enrollment.id,
    lessonId: String(f.lesson.id),
    requestKey: 'capture-one',
    pages: [page],
  };
  return {
    service,
    storage,
    claims,
    request,
    cleanup: () => rm(storage, { recursive: true, force: true }),
  };
}
export async function assertCapture(f: Fixture) {
  expect(f.course.tenantId).toBe(f.own.tenantId);
  expect(f.lesson.tenantId).toBe(f.own.tenantId);
  const e = await environment(f);
  try {
    const prior = await f.as(f.own, () =>
      f.service.startLesson({
        ...e.request,
        lessonId: String(f.secondLesson.id),
      }),
    );
    const submitted = await f.as(f.own, () =>
      e.service.captureSubmission({
        ...e.request,
        score: 1,
        status: 'complete',
        graderKind: 'guardian',
      } as typeof e.request),
    );
    expect(submitted.pages).toHaveLength(1);
    expect(submitted.grade).toBeNull();
    expect(submitted.status).toBe('captured');
    const progress = await f.db.get('lesson_progress', {
      id: submitted.progressId,
    });
    if (!progress) throw new Error('Missing progress');
    expect(progress.status).toBe('submitted');
    expect(Number(progress.attempts)).toBe(1);
    expect(progress.best_score).toBeNull();
    expect((await f.db.get('lesson_progress', { id: prior.id }))?.status).toBe(
      'in_progress',
    );
    const asset = await f.db.get('assets', { id: submitted.pages[0].assetId });
    if (!asset) throw new Error('Missing asset');
    expect(asset.access_mode).toBe('private');
    const ordinaryAssets = await AssetCollection.create({ db: f.db });
    expect(
      await f.as(f.own, () => ordinaryAssets.get(submitted.pages[0].assetId)),
    ).toBeNull();
    expect(
      await f.as(f.own, () =>
        ordinaryAssets.count({ where: { id: submitted.pages[0].assetId } }),
      ),
    ).toBe(0);
    expect(asset.tenant_id).toBe(f.own.tenantId);
    expect(asset.owner_profile_id).toBe(f.alice.profile.id);
    expect(await readFile(new URL(String(asset.source_uri)))).toEqual(
      page.data,
    );
    const retries = await f.as(f.own, () =>
      Promise.all([
        e.service.captureSubmission(e.request),
        e.service.captureSubmission(e.request),
      ]),
    );
    expect(retries.map((row) => row.id)).toEqual([submitted.id, submitted.id]);
    await expect(
      f.as(f.own, () =>
        e.service.captureSubmission({
          ...e.request,
          pages: [{ ...page, data: Buffer.from('changed') }],
        }),
      ),
    ).rejects.toThrow('changed');
    await expect(
      f.as(f.own, () =>
        e.service.captureSubmission({ ...e.request, requestKey: 'another' }),
      ),
    ).rejects.toThrow('another capture');
    const readRequest = {
      ...f.own,
      enrollmentId: f.enrollment.id,
      submissionId: submitted.id,
    };
    const signed = await f.as(f.own, () =>
      e.service.signSubmissionAsset({
        ...readRequest,
        assetId: submitted.pages[0].assetId,
      }),
    );
    expect(signed.url).toContain('signed=true');
    expect(e.claims[0]).toMatchObject({
      ...readRequest,
      assetId: submitted.pages[0].assetId,
    });
    expect(e.claims[0].expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(
      300000,
    );
    const sibling = {
      ...f.own,
      actorUserId: String(f.bob.user.id),
      learnerId: String(f.sibling.id),
    };
    const stranger = {
      tenantId: f.foreign.tenantId,
      actorUserId: String(f.stranger.user.id),
      learnerId: String(f.foreign.id),
    };
    for (const denied of [sibling, stranger]) {
      await expect(
        f.as(denied, () =>
          e.service.captureSubmission({ ...e.request, ...denied }),
        ),
      ).rejects.toThrow();
      await expect(
        f.as(denied, () =>
          e.service.getSubmission({ ...readRequest, ...denied }),
        ),
      ).rejects.toThrow();
      await expect(
        f.as(denied, () =>
          e.service.signSubmissionAsset({
            ...readRequest,
            ...denied,
            assetId: submitted.pages[0].assetId,
          }),
        ),
      ).rejects.toThrow();
    }
    await expect(e.service.captureSubmission(e.request)).rejects.toThrow();
    await expect(
      withTenant(
        { tenantId: f.own.tenantId, userId: f.parent.actorUserId },
        () => e.service.captureSubmission(e.request),
      ),
    ).rejects.toThrow();
    await expect(
      f.as(f.own, () =>
        e.service.captureSubmission({
          ...e.request,
          lessonId: String(f.wrongLesson.id),
        }),
      ),
    ).rejects.toThrow();
    await f.db.update(
      'assets',
      { id: asset.id },
      { tenant_id: f.foreign.tenantId },
    );
    await expect(
      f.as(f.own, () =>
        e.service.signSubmissionAsset({ ...readRequest, assetId: asset.id }),
      ),
    ).rejects.toThrow();
    await f.db.update(
      'assets',
      { id: asset.id },
      { tenant_id: f.own.tenantId, owner_profile_id: f.bob.profile.id },
    );
    await expect(
      f.as(f.own, () =>
        e.service.signSubmissionAsset({ ...readRequest, assetId: asset.id }),
      ),
    ).rejects.toThrow();
    expect(e.claims).toHaveLength(1);
  } finally {
    await e.cleanup();
  }
}

function captureDigest(input: {
  pages: readonly { name: string; mimeType: string; data: Buffer }[];
  notes?: string;
  intake: unknown;
}): string {
  const digest = createHash('sha256');
  for (const page of input.pages)
    digest
      .update(JSON.stringify([page.name, page.mimeType, page.data.length]))
      .update(page.data);
  digest.update(JSON.stringify(input.notes ?? ''));
  digest.update(JSON.stringify(input.intake));
  return digest.digest('hex');
}

/** Legacy receipts predate the durable intake binding table. */
export async function assertLegacyIntakeFallback(f: Fixture) {
  const e = await environment(f);
  const scans = await ScannedSubmissionCollection.create({ db: f.db });
  const bindings = await SubmissionIntakeBindingCollection.create({ db: f.db });
  const request = (intakeItemId: string, lessonId = String(f.lesson.id)) => ({
    ...e.request,
    lessonId,
    intake: { intakeItemId, kind: 'blank_reference' as const },
  });
  const bindingsFor = (intakeItemId: string) =>
    f.as(f.own, () =>
      bindings.list({
        where: { tenantId: f.own.tenantId, intakeItemId },
      }),
    );
  const seed = async (input: ReturnType<typeof request>) => {
    const progress = await f.as(f.own, () =>
      f.service.startLesson({
        ...f.own,
        enrollmentId: f.enrollment.id,
        lessonId: input.lessonId,
      }),
    );
    return f.as(f.own, () =>
      scans.create({
        tenantId: f.own.tenantId,
        learnerId: f.own.learnerId,
        lessonId: input.lessonId,
        progressId: String(progress.id),
        pageCount: input.pages.length,
        captureKey: `legacy-${input.intake.intakeItemId}-${Math.random()}`,
        captureDigest: captureDigest(input),
        kind: input.intake.kind,
        intakeItemId: input.intake.intakeItemId,
      }),
    );
  };
  try {
    const sameAssignment = request('legacy-same');
    const original = await seed(sameAssignment);
    const retried = await f.as(f.own, () =>
      e.service.captureSubmission(sameAssignment),
    );
    expect(retried.id).toBe(String(original.id));
    expect(await bindingsFor('legacy-same')).toHaveLength(1);

    const wrongLesson = request('legacy-wrong', String(f.lesson.id));
    await seed(wrongLesson);
    await expect(
      f.as(f.own, () =>
        e.service.captureSubmission({
          ...wrongLesson,
          lessonId: String(f.secondLesson.id),
        }),
      ),
    ).rejects.toThrow('another assignment');
    expect(await bindingsFor('legacy-wrong')).toEqual([]);

    const concurrent = request('legacy-concurrent');
    const concurrentOriginal = await seed(concurrent);
    const retries = await f.as(f.own, () =>
      Promise.all([
        e.service.captureSubmission(concurrent),
        e.service.captureSubmission(concurrent),
      ]),
    );
    expect(retries.map((row) => row.id)).toEqual([
      String(concurrentOriginal.id),
      String(concurrentOriginal.id),
    ]);
    expect(await bindingsFor('legacy-concurrent')).toHaveLength(1);

    const duplicate = request('legacy-duplicate');
    await seed(duplicate);
    await seed(duplicate);
    await expect(
      f.as(f.own, () => e.service.captureSubmission(duplicate)),
    ).rejects.toThrow('ambiguous');
    expect(await bindingsFor('legacy-duplicate')).toEqual([]);
  } finally {
    await e.cleanup();
  }
}
export async function assertGrading(f: Fixture) {
  const e = await environment(f);
  try {
    const captured = await f.as(f.own, () =>
      e.service.captureSubmission(e.request),
    );
    const request = {
      ...f.parent,
      enrollmentId: f.enrollment.id,
      submissionId: captured.id,
    };
    await expect(
      f.as(f.own, () =>
        e.service.reviewSubmission({ ...request, ...f.own, score: 1 }),
      ),
    ).rejects.toThrow();
    await expect(
      f.as(f.own, () => e.service.attestLesson({ ...e.request, score: 1 })),
    ).rejects.toThrow();
    for (const score of [-0.1, 1.1, NaN, Infinity, '1'])
      await expect(
        f.as(f.parent, () =>
          e.service.reviewSubmission({ ...request, score: score as number }),
        ),
      ).rejects.toThrow('Score');
    const graded = await f.as(f.parent, () =>
      e.service.reviewSubmission(request),
    );
    expect(graded.grade).toMatchObject({ graderKind: 'guardian', score: null });
    expect(
      (await f.db.get('lesson_progress', { id: captured.progressId }))
        ?.best_score,
    ).toBeNull();
    expect(
      (await f.db.get('lesson_progress', { id: captured.progressId }))?.status,
    ).toBe('complete');
    const zero = await f.as(f.parent, () =>
      e.service.reviewSubmission({ ...request, score: 0 }),
    );
    expect(zero.grade?.score).toBe(0);
    await f.as(f.parent, async () =>
      (await GradeCollection.create({ db: f.db })).create({
        tenantId: f.own.tenantId,
        submissionId: captured.id,
        graderKind: 'ai',
        score: 1,
        gradedAt: new Date(Date.now() + 1000),
      }),
    );
    expect(
      (
        await f.as(f.own, () =>
          e.service.getSubmission({ ...request, ...f.own }),
        )
      ).grade?.score,
    ).toBe(0);
    const attestation = await f.as(f.parent, () =>
      e.service.attestLesson({
        ...e.request,
        ...f.parent,
        lessonId: String(f.secondLesson.id),
      }),
    );
    expect(attestation.grade?.score).toBeNull();
    expect(
      (await f.db.get('lesson_progress', { id: attestation.progressId }))
        ?.status,
    ).toBe('complete');
    const zeroAttestation = await f.as(f.parent, () =>
      e.service.attestLesson({
        ...e.request,
        ...f.parent,
        lessonId: String(f.secondLesson.id),
        score: 0,
      }),
    );
    expect(zeroAttestation.id).toBe(attestation.id);
    expect(zeroAttestation.grade?.score).toBe(0);
    await f.db.update(
      'profile_relationships',
      { id: f.relationship.id },
      { tenant_id: f.foreign.tenantId },
    );
    await expect(
      f.as(f.parent, () => e.service.reviewSubmission(request)),
    ).rejects.toThrow();
  } finally {
    await e.cleanup();
  }
}
export async function assertCaptureRollback(f: Fixture) {
  let writes = 0;
  const e = await environment(f, {
    storeOptions: {
      resolver: (request) => {
        if (request.operation !== 'write') return;
        return {
          filesystem: {
            ...request.defaultFilesystem,
            write: async (
              ...args: Parameters<typeof request.defaultFilesystem.write>
            ) => {
              await request.defaultFilesystem.write(...args);
              if (++writes === 2)
                throw new Error('Storage failed after partial write');
            },
          },
          sourceUri: request.sourceUri,
        };
      },
    },
  });
  try {
    const request = {
      ...e.request,
      pages: [page, { ...page, name: 'second.png' }],
    };
    await expect(
      f.as(f.own, () => e.service.captureSubmission(request)),
    ).rejects.toThrow('partial write');
    for (const table of [
      'submissions',
      'submission_assets',
      'assets',
      'lesson_progress',
    ])
      expect(
        await f.db.list(table, { tenant_id: f.own.tenantId }),
      ).toHaveLength(0);
    expect(await readdir(join(e.storage, 'education-page'))).toEqual([]);
    const retried = await f.as(f.own, () =>
      e.service.captureSubmission(request),
    );
    expect(retried.pages).toHaveLength(2);
    let retained: SubmissionService | undefined;
    await expect(
      f.as(f.parent, () =>
        e.service.withTransaction(async (bound) => {
          retained = bound;
          await bound.attestLesson({
            ...e.request,
            ...f.parent,
            lessonId: String(f.secondLesson.id),
          });
          throw new Error('Abort composed grading');
        }),
      ),
    ).rejects.toThrow('Abort composed grading');
    if (!retained) throw new Error('Missing retained service');
    const closed = retained;
    await expect(
      f.as(f.parent, () => closed.attestLesson({ ...e.request, ...f.parent })),
    ).rejects.toThrow('closed');
    expect(
      await f.db.list('grades', { tenant_id: f.own.tenantId }),
    ).toHaveLength(0);
  } finally {
    await e.cleanup();
  }
}
export async function assertCleanupFailure(f: Fixture) {
  const e = await environment(f, {
    storeOptions: {
      resolver: (request) => {
        if (request.operation === 'delete')
          throw new Error('Delete unavailable');
        if (request.operation === 'write')
          return {
            filesystem: {
              ...request.defaultFilesystem,
              write: async (
                ...args: Parameters<typeof request.defaultFilesystem.write>
              ) => {
                await request.defaultFilesystem.write(...args);
                throw new Error('Partial write');
              },
            },
            sourceUri: request.sourceUri,
          };
      },
    },
  });
  try {
    const error = await f
      .as(f.own, () => e.service.captureSubmission(e.request))
      .catch((error) => error);
    expect(error).toBeInstanceOf(SubmissionStorageCleanupError);
    expect(error.assetIds).toHaveLength(1);
    expect(error.cause.message).toBe('Partial write');
    expect(
      await f.db.list('submissions', { tenant_id: f.own.tenantId }),
    ).toHaveLength(0);
    expect(
      await f.db.list('assets', { tenant_id: f.own.tenantId }),
    ).toHaveLength(0);
  } finally {
    await e.cleanup();
  }
}
export async function assertSubmissionHostDenial(f: Fixture) {
  for (const authorize of [
    () => false,
    () => {
      throw new Error('Host down');
    },
  ]) {
    const e = await environment(f, {}, authorize);
    try {
      await expect(
        f.as(f.own, () => e.service.captureSubmission(e.request)),
      ).rejects.toThrow();
      await expect(
        f.as(f.parent, () =>
          e.service.attestLesson({ ...e.request, ...f.parent }),
        ),
      ).rejects.toThrow();
      expect(
        await f.db.list('assets', { tenant_id: f.own.tenantId }),
      ).toHaveLength(0);
    } finally {
      await e.cleanup();
    }
  }
}
export async function assertPackets(f: Fixture) {
  const e = await environment(f);
  try {
    const { course, lessons } = await f.as(f.parent, async () => {
      const course = await (await CourseCollection.create({ db: f.db })).create(
        {
          tenantId: f.own.tenantId,
          title: 'Personal packet',
          licenseKind: 'personal-use-copy',
        },
      );
      const section = await (
        await CourseSectionCollection.create({ db: f.db })
      ).create({
        tenantId: f.own.tenantId,
        courseId: String(course.id),
        title: 'Worksheets',
      });
      const worksheets = await WorksheetCollection.create({ db: f.db });
      const lessons = await Promise.all([
        worksheets.create({
          tenantId: f.own.tenantId,
          sectionId: String(section.id),
          title: 'First',
        }),
        worksheets.create({
          tenantId: f.own.tenantId,
          sectionId: String(section.id),
          title: 'Second',
        }),
      ]);
      return { course, lessons };
    });
    const pdf = await PDFDocument.create();
    for (const width of [100, 200, 300]) pdf.addPage([width, 400]);
    const request = {
      ...f.parent,
      courseId: String(course.id),
      data: Buffer.from(await pdf.save()),
      ranges: [
        { lessonId: String(lessons[0].id), firstPage: 1, lastPage: 2 },
        { lessonId: String(lessons[1].id), firstPage: 3, lastPage: 3 },
      ],
    };
    await expect(
      f.as(f.own, () =>
        e.service.splitWorksheetPacket({ ...request, ...f.own }),
      ),
    ).rejects.toThrow();
    await expect(
      f.as(f.parent, () =>
        e.service.splitWorksheetPacket({
          ...request,
          courseId: String(f.course.id),
        }),
      ),
    ).rejects.toThrow();
    for (const ranges of [
      [],
      [{ ...request.ranges[0], firstPage: 0 }],
      [{ ...request.ranges[0], lastPage: 4 }],
      [request.ranges[0], { ...request.ranges[1], firstPage: 2 }],
      [request.ranges[0], request.ranges[0]],
      [{ ...request.ranges[0], lessonId: String(f.lesson.id) }],
    ])
      await expect(
        f.as(f.parent, () =>
          e.service.splitWorksheetPacket({ ...request, ranges }),
        ),
      ).rejects.toThrow();
    await expect(
      f.as(f.parent, () =>
        e.service.splitWorksheetPacket({
          ...request,
          data: Buffer.from('malformed'),
        }),
      ),
    ).rejects.toThrow();
    let writes = 0;
    const failing = await environment(f, {
      storeOptions: {
        resolver: (resolution) => {
          if (resolution.operation !== 'write') return;
          return {
            sourceUri: resolution.sourceUri,
            filesystem: {
              ...resolution.defaultFilesystem,
              write: async (
                ...args: Parameters<typeof resolution.defaultFilesystem.write>
              ) => {
                await resolution.defaultFilesystem.write(...args);
                if (++writes === 2) throw new Error('Packet partial write');
              },
            },
          };
        },
      },
    });
    try {
      await expect(
        f.as(f.parent, () => failing.service.splitWorksheetPacket(request)),
      ).rejects.toThrow('Packet partial write');
      expect(
        await f.db.list('lesson_assets', { tenant_id: f.own.tenantId }),
      ).toHaveLength(0);
      expect(
        await f.db.list('assets', { tenant_id: f.own.tenantId }),
      ).toHaveLength(0);
      expect(await readdir(join(failing.storage, 'education-page'))).toEqual(
        [],
      );
    } finally {
      await failing.cleanup();
    }
    const result = await f.as(f.parent, () =>
      e.service.splitWorksheetPacket(request),
    );
    expect(result.map((row) => row.lessonId)).toEqual(
      lessons.map((row) => row.id),
    );
    for (const [index, row] of result.entries()) {
      const asset = await f.db.get('assets', { id: row.assetId });
      if (!asset) throw new Error('Missing asset');
      expect(asset.access_mode).toBe('private');
      const ordinaryAssets = await AssetCollection.create({ db: f.db });
      expect(
        await f.as(f.own, () => ordinaryAssets.get(row.assetId)),
      ).toBeNull();
      expect(
        await f.as(f.own, () =>
          ordinaryAssets.count({ where: { id: row.assetId } }),
        ),
      ).toBe(0);
      expect(asset.tenant_id).toBe(f.own.tenantId);
      expect(asset.owner_profile_id).toBe(f.alice.profile.id);
      const extracted = await PDFDocument.load(
        await readFile(new URL(String(asset.source_uri))),
      );
      expect(extracted.getPages().map((page) => page.getWidth())).toEqual(
        index === 0 ? [100, 200] : [300],
      );
      expect(
        await f.db.get('lesson_assets', {
          lesson_id: row.lessonId,
          asset_id: row.assetId,
          relationship: 'printable',
          tenant_id: f.own.tenantId,
        }),
      ).toBeTruthy();
    }
  } finally {
    await e.cleanup();
  }
}

export async function assertSubmissionQueue(f: Fixture) {
  const e = await environment(f);
  try {
    let queued: Promise<unknown>[] = [];
    await expect(
      f.as(f.own, () =>
        e.service.withTransaction(async (bound) => {
          queued = [
            bound.captureSubmission({ ...e.request, pages: [] }),
            bound.captureSubmission(e.request),
          ];
          return Promise.all(queued);
        }),
      ),
    ).rejects.toThrow('pages');
    expect(
      (await Promise.allSettled(queued)).map((result) => result.status),
    ).toEqual(['rejected', 'rejected']);
    expect(await f.db.list('assets', { tenant_id: f.own.tenantId })).toEqual(
      [],
    );
    await expect(
      f.as(f.own, () =>
        e.service.withTransaction(async (bound) => {
          await bound.captureSubmission(e.request);
          await bound
            .captureSubmission({ ...e.request, pages: [] })
            .catch(() => undefined);
        }),
      ),
    ).rejects.toThrow('pages');
    expect(await f.db.list('assets', { tenant_id: f.own.tenantId })).toEqual(
      [],
    );
    expect(await readdir(join(e.storage, 'education-page'))).toEqual([]);
    await f.as(f.own, () =>
      e.service.withTransaction(async (bound) => {
        queued = [
          bound.captureSubmission(e.request),
          bound.captureSubmission(e.request),
        ];
      }),
    );
    const results = (await Promise.all(queued)) as Array<{ id: string }>;
    expect(results[0].id).toBe(results[1].id);
    expect(
      await f.db.list('submissions', { tenant_id: f.own.tenantId }),
    ).toHaveLength(1);
  } finally {
    await e.cleanup();
  }
}

export async function assertUncertainCommit(f: Fixture) {
  const e = await environment(f);
  const transaction = f.db.transaction;
  if (!transaction) throw new Error('Transaction support required');
  try {
    f.db.transaction = (async (
      operation: (db: typeof f.db) => Promise<unknown>,
    ) => {
      await transaction.call(f.db, operation);
      throw new Error('Connection lost after commit');
    }) as typeof transaction;
    await expect(
      f.as(f.own, () => e.service.captureSubmission(e.request)),
    ).rejects.toThrow('Connection lost after commit');
    f.db.transaction = transaction;
    const retry = await f.as(f.own, () =>
      e.service.captureSubmission(e.request),
    );
    expect(retry.pages).toHaveLength(1);
    const asset = await f.db.get('assets', { id: retry.pages[0].assetId });
    if (!asset) throw new Error('Committed owner missing');
    expect(await readFile(new URL(String(asset.source_uri)))).toEqual(
      page.data,
    );
  } finally {
    f.db.transaction = transaction;
    await e.cleanup();
  }
}

export async function assertSharedStorageDenial(f: Fixture) {
  let sharedUri = '';
  const e = await environment(f, {
    storeOptions: {
      resolver: (request) =>
        request.operation === 'write' ? { sourceUri: sharedUri } : undefined,
    },
  });
  try {
    const runtime = await createAssetRuntime({ db: f.db, storage: e.storage });
    const shared = await f.as(f.own, () =>
      runtime.storeSourceAsset('existing.png', page.data, {
        mimeType: 'image/png',
        typeSlug: 'education-page',
        tenantId: f.own.tenantId,
        ownerProfileId: String(f.alice.profile.id),
      }),
    );
    sharedUri = shared.sourceUri;
    const error = await f
      .as(f.own, () =>
        e.service.withTransaction(async (bound) => {
          await bound.captureSubmission(e.request);
          throw new Error('Abort shared locator');
        }),
      )
      .catch((error) => error);
    expect.soft(error.message).toContain('fresh asset filename');
    await expect(runtime.store.read(shared)).resolves.toEqual(page.data);
    expect(await f.db.get('assets', { id: shared.id })).toBeTruthy();
    expect(
      await f.db.list('submissions', { tenant_id: f.own.tenantId }),
    ).toEqual([]);
    expect(
      await f.db.list('assets', { tenant_id: f.own.tenantId }),
    ).toHaveLength(1);
  } finally {
    await e.cleanup();
  }
}

/** Shared SQLite/PostgreSQL contract for the bounded retained-work read. */
export async function assertLatestLessonSubmission(f: Fixture) {
  let allowed = true;
  const e = await environment(
    f,
    {},
    ({ own, relationshipTypeId }) =>
      allowed && (own || relationshipTypeId === f.guardianType.id),
  );
  const read = (patch = {}) =>
    f.as(f.own, () =>
      e.service.getLatestLessonSubmission({ ...e.request, ...patch }),
    );
  try {
    expect(await read()).toBeNull();
    expect(
      await f.db.list('lesson_progress', {
        tenant_id: f.own.tenantId,
        enrollment_id: f.enrollment.id,
        learner_id: f.own.learnerId,
      }),
    ).toHaveLength(0);
    const captured = await f.as(f.own, () =>
      e.service.captureSubmission(e.request),
    );
    expect(await read()).toEqual(
      await f.as(f.own, () =>
        e.service.getSubmission({
          ...e.request,
          submissionId: captured.id,
        }),
      ),
    );
    const submissions = await ScannedSubmissionCollection.create({ db: f.db });
    const time = new Date('2030-01-01T00:00:00Z');
    const make = (options = {}) =>
      f.as(f.own, () =>
        submissions.create({
          tenantId: f.own.tenantId,
          learnerId: f.own.learnerId,
          lessonId: String(f.lesson.id),
          progressId: captured.progressId,
          submittedAt: time,
          ...options,
        }),
      );
    const first = await make();
    const second = await make({ status: 'needs_review' });
    const winner = [String(first.id), String(second.id)].sort().at(-1);
    expect((await read())?.id).toBe(winner);
    await make({ status: 'extracting', submittedAt: new Date('2031-01-01') });
    await make({ status: 'rejected', submittedAt: new Date('2032-01-01') });
    await make({
      kind: 'blank_reference',
      submittedAt: new Date('2033-01-01'),
    });
    expect((await read())?.id).toBe(winner);
    expect((await read())?.pages).toEqual([]);
    const latest = await make({
      status: 'graded',
      submittedAt: new Date('2034-01-01'),
    });
    expect((await read())?.id).toBe(latest.id);
    expect(await read({ lessonId: String(f.secondLesson.id) })).toBeNull();
    for (const patch of [
      { tenantId: f.foreign.tenantId },
      { learnerId: String(f.sibling.id) },
      { enrollmentId: 'missing-enrollment' },
      { lessonId: String(f.wrongLesson.id) },
      { actorUserId: String(f.bob.user.id) },
    ])
      await expect(read(patch)).rejects.toThrow();
    const foreign = {
      tenantId: f.foreign.tenantId,
      actorUserId: String(f.stranger.user.id),
      learnerId: String(f.foreign.id),
    };
    await expect(
      f.as(foreign, () =>
        e.service.getLatestLessonSubmission({ ...e.request, ...foreign }),
      ),
    ).rejects.toThrow();
    expect(
      (
        await f.as(f.parent, () =>
          e.service.getLatestLessonSubmission({
            ...e.request,
            ...f.parent,
          }),
        )
      )?.id,
    ).toBe(latest.id);
    allowed = false;
    await expect(read()).rejects.toThrow();
    allowed = true;
    await f.db.update(
      'profile_relationships',
      { id: f.relationship.id },
      {
        tenant_id: f.foreign.tenantId,
      },
    );
    await expect(
      f.as(f.parent, () =>
        e.service.getLatestLessonSubmission({
          ...e.request,
          ...f.parent,
        }),
      ),
    ).rejects.toThrow();
    const encoded = JSON.stringify(captured);
    expect(encoded).not.toContain('source_uri');
    expect(encoded).not.toContain('uploaded page');
    expect(encoded).not.toContain('extracted');
  } finally {
    await e.cleanup();
  }
}
