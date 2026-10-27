import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getTestDatabase } from '@happyvertical/smrt-core';
import { disableTenancy, enableTenancy } from '@happyvertical/smrt-tenancy';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { LearnerRequest } from '../learner-service.js';
import { WORKBOOK_MATH_VOCABULARY } from '../workbook-contracts.js';
import {
  WorkbookActivityCollection,
  WorkbookCollection,
  WorkbookWorkFilingCollection,
} from '../workbook-models.js';
import { WorkbookPhotoIntakeCollection } from '../workbook-photo-models.js';
import { WorkbookService } from '../workbook-service.js';
import { learnerFixture } from './learner-workflows.js';
import { workbookClasses } from './workbook-workflows.js';

class UnfiledTestService extends WorkbookService {
  resolveUnfiled(request: LearnerRequest & { intakeId: string }) {
    return this.withTransaction((service) =>
      service.resolveUnfiledWorkbookActivityInScope(request),
    );
  }
}
beforeAll(() => enableTenancy());
afterAll(() => disableTenancy());
async function fixture() {
  const db = await getTestDatabase({
    type: 'sqlite',
    url: ':memory:',
    classes: workbookClasses,
  });
  const f = await learnerFixture(db);
  const storage = await mkdtemp(join(tmpdir(), 'unfiled-work-'));
  const service = new UnfiledTestService(
    db,
    ({ own, relationshipTypeId }) =>
      own || relationshipTypeId === f.guardianType.id,
    () => true,
    { storage },
  );
  const receipt = await f.as(f.parent, async () =>
    (await WorkbookPhotoIntakeCollection.create({ db })).create({
      tenantId: f.parent.tenantId,
      learnerId: f.parent.learnerId,
      itemId: 'unfiled-photo',
      actorUserId: f.parent.actorUserId,
      contentDigest: 'a'.repeat(64),
    }),
  );
  const request = { ...f.parent, intakeId: String(receipt.id) };
  return {
    ...f,
    db,
    service,
    receipt,
    request,
    close: async () => {
      await db.close?.();
      await rm(storage, { recursive: true, force: true });
    },
  };
}
it('binds one identity-free work unit to an exact receipt and guards ordinary identity', async () => {
  const f = await fixture();
  try {
    const work = await f.as(f.parent, () =>
      f.service.resolveUnfiled(f.request),
    );
    expect(work).toMatchObject({
      title: '',
      workbookKey: '',
      edition: '',
      pageLabel: 'Captured work',
      reviewRequired: true,
      policyVersion: 1,
      filing: {
        state: 'unfiled',
        workbookId: null,
        canonicalActivityId: null,
        revisionId: null,
      },
    });
    expect(
      await f.db.get('workbooks', { learner_id: f.parent.learnerId }),
    ).toBeFalsy();
    expect(
      await f.as(f.parent, () => f.service.resolveUnfiled(f.request)),
    ).toEqual(work);
    await expect(
      f.as(f.own, () =>
        f.service.resolveUnfiled({ ...f.own, intakeId: String(f.receipt.id) }),
      ),
    ).rejects.toThrow();
    await expect(
      f.as(f.parent, () =>
        f.service.resolveUnfiled({
          ...f.request,
          learnerId: String(f.sibling.id),
        }),
      ),
    ).rejects.toThrow();
    await expect(
      f.as(f.parent, () =>
        f.service.setWorkbookFeedbackPolicy({
          ...f.parent,
          activityId: work.id,
          expectedPolicyVersion: 1,
          reviewRequired: false,
        }),
      ),
    ).rejects.toThrow('no workbook policy');
    await f.as(f.parent, async () => {
      const activities = await WorkbookActivityCollection.create({ db: f.db });
      const row = await activities.get({ id: work.id }, { cache: false });
      if (!row) throw new Error('Missing work unit');
      await expect(row.save()).rejects.toThrow('immutable');
      await expect(
        activities.create({
          tenantId: f.parent.tenantId,
          learnerId: f.parent.learnerId,
          enrollmentId: work.enrollmentId,
          lessonId: work.lessonId,
          pageKey: 'no-book',
          pageLabel: 'Invalid',
        }),
      ).rejects.toThrow('parent ownership');
    });
    expect(
      (
        await f.as(f.parent, () => f.service.listWorkbookActivities(f.parent))
      ).map((a) => a.id),
    ).toContain(work.id);
  } finally {
    await f.close();
  }
});
it('appends guardian filing with exact CAS and preserves source routing, policy and capture history', async () => {
  const f = await fixture();
  try {
    const work = await f.as(f.parent, () =>
      f.service.resolveUnfiled(f.request),
    );
    const canonical = await f.as(f.parent, () =>
      f.service.resolveWorkbookActivity({
        ...f.parent,
        workbookKey: 'real-copy',
        title: 'Real workbook',
        pageKey: 'p7',
        pageLabel: 'Page 7',
      }),
    );
    await f.as(f.parent, () =>
      f.service.setWorkbookFeedbackPolicy({
        ...f.parent,
        activityId: canonical.id,
        expectedPolicyVersion: 1,
        reviewRequired: false,
      }),
    );
    const capture = {
      ...f.parent,
      activityId: work.id,
      requestKey: 'capture',
      intakeItemId: 'unfiled-photo',
      pages: [
        {
          name: 'p.png',
          mimeType: 'image/png' as const,
          data: Buffer.from('unfiled synthetic work'),
        },
      ],
    };
    await expect(
      f.as(f.parent, () =>
        f.service.captureWorkbookWork({
          ...capture,
          intakeItemId: 'other-photo',
        }),
      ),
    ).rejects.toThrow('original photo receipt');
    const attempt = await f.as(f.parent, () =>
      f.service.captureWorkbookWork(capture),
    );
    const evidenceRequest = {
      ...f.parent,
      activityId: work.id,
      submissionId: attempt.submissionId,
    };
    const anchors = await f.as(f.parent, () =>
      f.service.getWorkbookSourceAnchors(evidenceRequest),
    );
    const ai = await f.as(f.parent, () =>
      f.service.recordWorkbookAnalysis({
        ...evidenceRequest,
        requestKey: 'analysis',
        assessment: {
          version: 1,
          feedback: 'Correct',
          vocabulary: structuredClone(WORKBOOK_MATH_VOCABULARY),
          provenance: {
            provider: 'synthetic',
            model: 'test',
            configurationVersion: '1',
            rubricVersion: '1',
            inputHash: anchors[0].sha256,
            analysisId: 'unfiled-analysis',
          },
          questions: [
            {
              id: 'visible:q1',
              prompt: '1+1',
              answer: '2',
              result: 'correct',
              reason: 'none',
              feedback: 'Correct',
              points: null,
              possiblePoints: null,
              anchors: [{ ...anchors[0], page: 1, rect: [0, 0, 1, 1] }],
              conceptIds: ['math.addition'],
            },
          ],
        },
      }),
    );
    const approved = await f.as(f.parent, () =>
      f.service.reviewWorkbookAssessment({
        ...evidenceRequest,
        revisionId: ai.id,
        expectedHeadId: null,
        requestKey: 'review',
      }),
    );
    await f.as(f.parent, () =>
      f.service.releaseWorkbookFeedback({
        ...evidenceRequest,
        revisionId: approved.id,
        expectedHeadId: approved.id,
        requestKey: 'release',
      }),
    );
    const originalTimeline = await f.as(f.parent, () =>
      f.service.getWorkbookTimeline({ ...f.parent, activityId: work.id }),
    );
    const originalSummary = await f.as(f.parent, () =>
      f.service.getConceptEvidenceSummary({ ...f.parent, activityId: work.id }),
    );
    const original = await f.db.get('workbook_activities', { id: work.id });
    const bookId = canonical.filing?.workbookId;
    if (!bookId) throw new Error('Missing canonical workbook');
    const filing = {
      ...f.parent,
      activityId: work.id,
      workbookId: bookId,
      canonicalActivityId: canonical.id,
      expectedRevisionId: null,
      requestKey: 'file-1',
      reason: 'Guardian identified this page',
    };
    const siblingBook = await f.as(f.parent, async () =>
      (await WorkbookCollection.create({ db: f.db })).create({
        tenantId: f.parent.tenantId,
        learnerId: String(f.sibling.id),
        workbookKey: 'sibling-copy',
        title: 'Sibling workbook',
      }),
    );
    await expect(
      f.as(f.parent, () =>
        f.service.fileWorkbookWork({
          ...filing,
          workbookId: String(siblingBook.id),
        }),
      ),
    ).rejects.toThrow();
    await expect(
      f.as(f.parent, () =>
        f.service.fileWorkbookWork({ ...filing, canonicalActivityId: work.id }),
      ),
    ).rejects.toThrow('target mismatch');
    const filed = await f.as(f.parent, () =>
      f.service.fileWorkbookWork(filing),
    );
    expect(filed).toMatchObject({
      id: work.id,
      enrollmentId: work.enrollmentId,
      lessonId: work.lessonId,
      title: 'Real workbook',
      pageLabel: 'Page 7',
      reviewRequired: true,
      policyVersion: 1,
      filing: {
        state: 'filed',
        workbookId: bookId,
        canonicalActivityId: canonical.id,
      },
    });
    expect(
      await f.as(f.parent, () => f.service.fileWorkbookWork(filing)),
    ).toEqual(filed);
    await expect(
      f.as(f.parent, () =>
        f.service.fileWorkbookWork({ ...filing, reason: 'Changed retry' }),
      ),
    ).rejects.toThrow('retry changed');
    await expect(
      f.as(f.parent, () =>
        f.service.fileWorkbookWork({ ...filing, requestKey: 'stale' }),
      ),
    ).rejects.toThrow('head changed');
    await expect(
      f.as(f.own, () => f.service.fileWorkbookWork({ ...filing, ...f.own })),
    ).rejects.toThrow();
    const bookOnly = await f.as(f.parent, () =>
      f.service.fileWorkbookWork({
        ...filing,
        canonicalActivityId: undefined,
        expectedRevisionId: filed.filing?.revisionId ?? null,
        requestKey: 'book-only',
      }),
    );
    expect(
      await f.as(f.parent, () => f.service.fileWorkbookWork(filing)),
    ).toEqual(filed);
    expect(bookOnly.pageLabel).toBe('Captured work');
    expect(bookOnly.filing?.canonicalActivityId).toBeNull();
    expect(await f.db.get('workbook_activities', { id: work.id })).toEqual(
      original,
    );
    expect(
      await f.as(f.parent, () => f.service.captureWorkbookWork(capture)),
    ).toMatchObject({
      id: attempt.id,
      activityId: attempt.activityId,
      submissionId: attempt.submissionId,
      episodeId: attempt.episodeId,
    });
    const timeline = await f.as(f.parent, () =>
      f.service.getWorkbookTimeline({ ...f.parent, activityId: work.id }),
    );
    expect(timeline.attempts[0]).toMatchObject({
      id: attempt.id,
      submissionId: attempt.submissionId,
      reviewRequired: true,
      policyVersion: 1,
    });
    expect(timeline.attempts).toEqual(originalTimeline.attempts);
    expect(
      await f.as(f.parent, () =>
        f.service.getConceptEvidenceSummary({
          ...f.parent,
          activityId: work.id,
        }),
      ),
    ).toEqual(originalSummary);

    await f.as(f.parent, async () => {
      const rows = await (
        await WorkbookWorkFilingCollection.create({ db: f.db })
      ).list({ where: { sourceActivityId: work.id } });
      expect(rows).toHaveLength(2);
      await expect(rows[0].save()).rejects.toThrow('immutable');
      await expect(rows[0].delete()).rejects.toThrow('immutable');
    });
    await expect(
      f.as(f.parent, () =>
        f.service.withTransaction(async (tx) => {
          await tx.fileWorkbookWork({
            ...filing,
            expectedRevisionId: bookOnly.filing?.revisionId ?? null,
            requestKey: 'rollback',
          });
          throw new Error('rollback');
        }),
      ),
    ).rejects.toThrow('rollback');
    expect(
      await f.as(f.parent, () =>
        f.service.getWorkbookActivity({ ...f.parent, activityId: work.id }),
      ),
    ).toEqual(bookOnly);
    await expect(
      f.as(f.parent, () =>
        f.service.fileWorkbookWork({
          ...filing,
          activityId: canonical.id,
          requestKey: 'ordinary',
        }),
      ),
    ).rejects.toThrow('Only unfiled');
    const correction = await f.as(f.parent, () =>
      f.service.captureWorkbookWork({
        ...capture,
        requestKey: 'correction',
        intakeItemId: 'correction-intake',
        previousSubmissionId: attempt.submissionId,
        pages: [{ ...capture.pages[0], data: Buffer.from('corrected work') }],
      }),
    );
    expect(correction).toMatchObject({
      activityId: work.id,
      episodeId: attempt.episodeId,
      previousAttemptId: attempt.id,
      reviewRequired: true,
      policyVersion: 1,
    });
  } finally {
    await f.close();
  }
});

it('rechecks current actor membership and exact tenant context on receipt reuse', async () => {
  const f = await fixture();
  try {
    await f.as(f.parent, () => f.service.resolveUnfiled(f.request));
    await expect(
      f.as(f.own, () => f.service.resolveUnfiled(f.request)),
    ).rejects.toThrow();
    await expect(
      f.as(f.parent, () =>
        f.service.resolveUnfiled({
          ...f.request,
          tenantId: String(f.foreign.tenantId),
        }),
      ),
    ).rejects.toThrow();
    await f.db.query(
      'UPDATE memberships SET status=? WHERE tenant_id=? AND user_id=?',
      ['inactive', f.parent.tenantId, f.parent.actorUserId],
    );
    await expect(
      f.as(f.parent, () => f.service.resolveUnfiled(f.request)),
    ).rejects.toThrow();
  } finally {
    await f.close();
  }
});

it('defaults legacy inserts to identified work while retaining the ordinary workbook guard', async () => {
  const f = await fixture();
  try {
    const canonical = await f.as(f.parent, () =>
      f.service.resolveWorkbookActivity({
        ...f.parent,
        workbookKey: 'legacy-book',
        title: 'Legacy workbook',
        pageKey: 'page-1',
        pageLabel: 'Page 1',
      }),
    );
    const id = globalThis.crypto.randomUUID();
    // Legacy writers know no capture_kind column. The database must supply it;
    // a class initializer alone cannot protect migrated historical rows.
    await f.db.query(
      'INSERT INTO workbook_activities (id, slug, tenant_id, learner_id, workbook_id, enrollment_id, lesson_id, page_key, page_label) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        id,
        `legacy-${id}`,
        f.parent.tenantId,
        f.parent.learnerId,
        canonical.filing?.workbookId,
        canonical.enrollmentId,
        canonical.lessonId,
        'page-2',
        'Page 2',
      ],
    );
    expect(await f.db.get('workbook_activities', { id })).toMatchObject({
      capture_kind: 'identified',
      photo_intake_id: null,
    });
    expect(
      await f.as(f.parent, () =>
        f.service.getWorkbookActivity({ ...f.parent, activityId: id }),
      ),
    ).toMatchObject({
      title: 'Legacy workbook',
      pageLabel: 'Page 2',
      filing: { state: 'identified' },
    });
  } finally {
    await f.close();
  }
});
