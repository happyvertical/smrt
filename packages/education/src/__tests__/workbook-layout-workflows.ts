import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseInterface } from '@happyvertical/sql';
import { expect, it } from 'vitest';
import {
  WORKBOOK_MATH_VOCABULARY,
  type WorkbookAssessment,
  type WorkbookAttemptView,
} from '../workbook-contracts.js';
import { WorkbookPhotoService } from '../workbook-photo-service.js';
import { learnerFixture } from './learner-workflows.js';

async function workbookFixture(
  db: DatabaseInterface,
  cleanup: () => Promise<void>,
  guardianCapture = false,
) {
  const f = await learnerFixture(db);
  const storage = await mkdtemp(join(tmpdir(), 'workbook-'));
  const service = new WorkbookPhotoService(
    db,
    ({ own, relationshipTypeId }) =>
      own || relationshipTypeId === f.guardianType.id,
    () => true,
    { storage },
  );
  const create = {
    ...f.parent,
    workbookKey: 'synthetic-copy-v1',
    title: 'Synthetic workbook',
    edition: 'v1',
    pageKey: 'section-a:p7',
    pageLabel: 'Page 7',
  };
  let activity = await f.as(f.parent, () =>
    service.resolveWorkbookActivity(create),
  );
  const captureActor = guardianCapture ? f.parent : f.own;
  const capture = {
    ...captureActor,
    activityId: activity.id,
    requestKey: 'capture-1',
    intakeItemId: 'synthetic-intake',
    pages: [
      {
        name: 'p.png',
        mimeType: 'image/png' as const,
        data: Buffer.from('synthetic-page'),
      },
    ],
    assistance: 'independent' as const,
  };
  let attempt: WorkbookAttemptView;
  if (guardianCapture) {
    const photo = await f.as(f.parent, () =>
      service.retainWorkbookPhotoIntake({
        ...f.parent,
        itemId: 'guardian-photo',
        pages: capture.pages,
      }),
    );
    const req = { ...f.parent, intakeId: photo.id };
    const resolved = await f.as(f.parent, () =>
      service.resolveWorkbookPhotoIntake({
        ...req,
        requestKey: 'guardian-resolve',
        identification: { kind: 'work', workState: 'completed' },
      }),
    );
    if (!resolved.activity) throw new Error('No durable photo work');
    activity = resolved.activity;
    capture.activityId = activity.id;
    attempt = await f.as(f.parent, () =>
      service.captureWorkbookPhotoIntake({
        ...req,
        requestKey: 'guardian-capture',
      }),
    );
  } else {
    attempt = await f.as(captureActor, () =>
      service.captureWorkbookWork(capture),
    );
  }
  const request = {
    ...f.parent,
    activityId: activity.id,
    submissionId: attempt.submissionId,
  };
  const sources = await f.as(f.parent, () =>
    service.getWorkbookSourceAnchors(request),
  );
  const assessment: WorkbookAssessment = {
    version: 1,
    feedback: 'Try adding again',
    provenance: {
      provider: 'synthetic',
      model: 'test',
      configurationVersion: 'v1',
      rubricVersion: 'v1',
      inputHash: sources[0].sha256,
      analysisId: 'test-analysis',
    },
    vocabulary: structuredClone(WORKBOOK_MATH_VOCABULARY),
    questions: [
      {
        id: 'p7:q1',
        prompt: '8+7',
        answer: '14',
        result: 'incorrect',
        reason: 'none',
        feedback: 'Count again',
        points: 0,
        possiblePoints: 1,
        anchors: [{ ...sources[0], page: 1, rect: [0, 0, 1, 1] }],
        conceptIds: ['math.addition'],
      },
    ],
  };
  return {
    ...f,
    service,
    create,
    activity,
    capture,
    attempt,
    request,
    assessment,
    storage,
    close: async () => {
      await cleanup();
      await rm(storage, { recursive: true, force: true });
    },
  };
}
export function workbookLayoutContractTests(
  createDb: () => Promise<{
    db: DatabaseInterface;
    cleanup: () => Promise<void>;
  }>,
) {
  const fixture = async (guardianCapture = false) => {
    const env = await createDb();
    return workbookFixture(env.db, env.cleanup, guardianCapture);
  };
  it('persists observed layout on immutable AI/review bodies and only discloses the exact released body', async () => {
    const f = await fixture();
    try {
      const assetId = f.assessment.questions[0].anchors[0].assetId;
      f.assessment.layout = {
        version: 1,
        provenance: 'observed',
        sections: [
          {
            id: 's',
            label: 'Private heading',
            columns: 2,
            source: { assetId, page: 1 },
          },
        ],
        placements: [
          { questionId: 'p7:q1', sectionId: 's', row: 0, column: 1 },
        ],
      };
      const write = {
        ...f.request,
        requestKey: 'layout-ai',
        assessment: f.assessment,
      };
      const ai = await f.as(f.parent, () =>
        f.service.recordWorkbookAnalysis(write),
      );
      expect(
        (await f.as(f.parent, () => f.service.recordWorkbookAnalysis(write)))
          .id,
      ).toBe(ai.id);
      expect(ai.assessment.layout).toEqual(f.assessment.layout);
      const review = await f.as(f.parent, () =>
        f.service.reviewWorkbookAssessment({
          ...f.request,
          revisionId: ai.id,
          expectedHeadId: null,
          requestKey: 'layout-review',
        }),
      );
      expect(review.assessment.layout).toEqual(f.assessment.layout);
      const hidden = await f.as(f.own, () =>
        f.service.getWorkbookTimeline({ ...f.own, activityId: f.activity.id }),
      );
      expect(JSON.stringify(hidden)).not.toContain('Private heading');
      await f.as(f.parent, () =>
        f.service.releaseWorkbookFeedback({
          ...f.request,
          revisionId: review.id,
          expectedHeadId: review.id,
          requestKey: 'layout-release',
        }),
      );
      const visible = await f.as(f.own, () =>
        f.service.getWorkbookTimeline({ ...f.own, activityId: f.activity.id }),
      );
      expect(JSON.stringify(visible)).toContain('Private heading');
      const correction = await f.as(f.own, () =>
        f.service.captureWorkbookWork({
          ...f.capture,
          requestKey: 'layout-correction',
          intakeItemId: 'layout-correction-intake',
          previousSubmissionId: f.attempt.submissionId,
          pages: [{ ...f.capture.pages[0], data: Buffer.from('new-capture') }],
        }),
      );
      const anchors = await f.as(f.parent, () =>
        f.service.getWorkbookSourceAnchors({
          ...f.request,
          submissionId: correction.submissionId,
        }),
      );
      const corrected = structuredClone(f.assessment);
      corrected.questions[0].anchors = [
        { ...anchors[0], page: 1, rect: [0, 0, 1, 1] },
      ];
      const current = await f.as(f.parent, () =>
        f.service.recordWorkbookAnalysis({
          ...f.request,
          submissionId: correction.submissionId,
          requestKey: 'new-layout',
          assessment: corrected,
        }),
      );
      expect(current.assessment.layout).toBeUndefined();
      expect(current.assessment.layoutOmission).toBe('invalid');
      expect(current.assessment.questions[0].answer).toBe('14');
    } finally {
      await f.close();
    }
  });
  it('withholds guardian-origin layout from learner timeline, raw write and correction ancestry until exact release', async () => {
    const f = await fixture(true);
    try {
      f.assessment.layout = {
        version: 1,
        provenance: 'observed',
        sections: [
          {
            id: 'private',
            label: 'Guardian-only heading',
            columns: 1,
            source: {
              assetId: f.assessment.questions[0].anchors[0].assetId,
              page: 1,
            },
          },
        ],
        placements: [
          { questionId: 'p7:q1', sectionId: 'private', row: 0, column: 0 },
        ],
      };
      const ai = await f.as(f.parent, () =>
        f.service.recordWorkbookAnalysis({
          ...f.request,
          requestKey: 'guardian-ai',
          assessment: f.assessment,
        }),
      );
      const ownRequest = { ...f.request, ...f.own };
      const hidden = await f.as(f.own, () =>
        f.service.getWorkbookTimeline({ ...f.own, activityId: f.activity.id }),
      );
      expect(JSON.stringify(hidden)).not.toContain('Guardian-only heading');
      await expect(
        f.as(f.own, () =>
          f.service.recordWorkbookAnalysis({
            ...ownRequest,
            requestKey: 'probe-layout',
            assessment: f.assessment,
          }),
        ),
      ).rejects.toThrow();
      await expect(
        f.as(f.own, () => f.service.getWorkbookQuestionIdentity(ownRequest)),
      ).rejects.toThrow();
      const correction = {
        ...f.capture,
        ...f.own,
        requestKey: 'private-correction',
        intakeItemId: 'private-correction-intake',
        previousSubmissionId: f.attempt.submissionId,
        pages: [
          { ...f.capture.pages[0], data: Buffer.from('private-correction') },
        ],
      };
      await expect(
        f.as(f.own, () => f.service.captureWorkbookWork(correction)),
      ).rejects.toThrow();
      const reviewed = await f.as(f.parent, () =>
        f.service.reviewWorkbookAssessment({
          ...f.request,
          revisionId: ai.id,
          expectedHeadId: null,
          requestKey: 'guardian-review',
        }),
      );
      await f.as(f.parent, () =>
        f.service.releaseWorkbookFeedback({
          ...f.request,
          revisionId: reviewed.id,
          expectedHeadId: reviewed.id,
          requestKey: 'guardian-release',
        }),
      );
      expect(
        await f.as(f.own, () =>
          f.service.getWorkbookQuestionIdentity(ownRequest),
        ),
      ).toEqual([{ id: 'p7:q1' }]);
      const visible = await f.as(f.own, () =>
        f.service.getWorkbookTimeline({ ...f.own, activityId: f.activity.id }),
      );
      expect(JSON.stringify(visible)).toContain('Guardian-only heading');
    } finally {
      await f.close();
    }
  });
  it('drops raw invalid optional metadata on direct writes and keeps omission through default review', async () => {
    const f = await fixture();
    try {
      Object.assign(f.assessment, {
        layout: { version: 99, secret: 'must-not-persist' },
        layoutOmission: 'unsafe',
      });
      const ai = await f.as(f.parent, () =>
        f.service.recordWorkbookAnalysis({
          ...f.request,
          requestKey: 'invalid-layout',
          assessment: f.assessment,
        }),
      );
      expect(ai.assessment.layout).toBeUndefined();
      expect(ai.assessment.layoutOmission).toBe('invalid');
      expect(ai.assessment.questions[0].answer).toBe('14');
      expect(JSON.stringify(ai)).not.toContain('must-not-persist');
      const review = await f.as(f.parent, () =>
        f.service.reviewWorkbookAssessment({
          ...f.request,
          revisionId: ai.id,
          expectedHeadId: null,
          requestKey: 'omission-review',
        }),
      );
      expect(review.assessment.layoutOmission).toBe('invalid');
      expect(review.assessment.layout).toBeUndefined();
      const explicit = await f.as(f.parent, () =>
        f.service.reviewWorkbookAssessment({
          ...f.request,
          revisionId: ai.id,
          expectedHeadId: review.id,
          requestKey: 'explicit-invalid-review',
          assessment: f.assessment,
        }),
      );
      expect(explicit.assessment.layoutOmission).toBe('invalid');
      expect(explicit.assessment.questions[0].answer).toBe('14');
      expect(JSON.stringify(explicit)).not.toContain('must-not-persist');
    } finally {
      await f.close();
    }
  });
}
