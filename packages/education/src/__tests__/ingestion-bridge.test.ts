import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@happyvertical/smrt-ingestion/server', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('@happyvertical/smrt-ingestion/server')
  >()),
  extractAnalysis: vi.fn(async () => true),
}));

import {
  captureEducationIntake,
  educationIntakeHandlers,
  processEducationAnalysis,
} from '../ingestion.js';

function fixture() {
  const request = {
    tenantId: 'tenant',
    actorUserId: 'actor',
    learnerId: 'learner',
    enrollmentId: 'enrollment',
    lessonId: 'lesson',
    itemId: 'item',
    kind: 'completed_work' as const,
  };
  const bytes = Buffer.from('page');
  const ingestion = {
    getEvidence: vi.fn(async () => [
      {
        id: 'evidence',
        partId: '1',
        parentEvidenceId: null,
        mediaType: 'image/png',
        byteLength: bytes.length,
        contentHash: createHash('sha256').update(bytes).digest('hex'),
      },
    ]),
    readEvidence: vi.fn(async () => bytes),
  };
  const submissions = {
    assertLessonAssignment: vi.fn(async () => undefined),
    captureSubmission: vi.fn(async (value) => value),
    captureBlankReference: vi.fn(async (value) => value),
    resubmitSubmission: vi.fn(async (value) => value),
  };
  const input = {
    ingestion,
    submissions,
    request,
    scope: {
      tenantId: 'tenant',
      actorId: 'actor',
      confidentialScopeId: 'enrollment',
    },
  };
  return { ...input, input };
}

describe('education ingestion capture boundary', () => {
  it('retains immutable item key and delegates typed blank/completed ownership', async () => {
    const f = fixture();
    const first = await captureEducationIntake(f.input as never);
    const retry = await captureEducationIntake(f.input as never);
    expect(first.requestKey).toBe(retry.requestKey);
    expect(first.intake).toEqual({
      intakeItemId: 'item',
      kind: 'completed_work',
      previousSubmissionId: undefined,
    });
    expect(first.pages[0].data).toEqual(Buffer.from('page'));
    await captureEducationIntake({
      ...f.input,
      request: { ...f.request, kind: 'blank_reference' },
    } as never);
    expect(
      f.submissions.captureBlankReference.mock.lastCall?.[0].intake.kind,
    ).toBe('blank_reference');
  });
  it('routes correction to explicit predecessor API without overwriting history', async () => {
    const f = fixture();
    await captureEducationIntake({
      ...f.input,
      request: { ...f.request, previousSubmissionId: 'previous' },
    } as never);
    expect(f.submissions.captureSubmission).not.toHaveBeenCalled();
    expect(
      f.submissions.resubmitSubmission.mock.lastCall?.[0].previousSubmissionId,
    ).toBe('previous');
  });
  it('denies actor/context mismatch and invalid blank corrections before evidence I/O', async () => {
    const f = fixture();
    for (const patch of [
      { actorUserId: 'other' },
      { tenantId: 'other' },
      { enrollmentId: 'sibling-enrollment' },
      { kind: 'unknown' },
      { kind: 'blank_reference', previousSubmissionId: 'old' },
    ]) {
      await expect(
        captureEducationIntake({
          ...f.input,
          request: { ...f.request, ...patch },
        } as never),
      ).rejects.toThrow();
    }
    expect(f.ingestion.getEvidence).not.toHaveBeenCalled();
    expect(f.submissions.assertLessonAssignment).not.toHaveBeenCalled();
  });
  it('fails closed on tampered bytes and provider errors without capture', async () => {
    const f = fixture();
    f.ingestion.readEvidence.mockResolvedValue(Buffer.from('evil'));
    await expect(captureEducationIntake(f.input as never)).rejects.toThrow(
      'integrity',
    );
    f.ingestion.readEvidence.mockRejectedValue(new Error('unavailable'));
    await expect(captureEducationIntake(f.input as never)).rejects.toThrow(
      'unavailable',
    );
    expect(f.submissions.captureSubmission).not.toHaveBeenCalled();
  });
  it('rejects unsupported/oversized evidence before bytes are read', async () => {
    const f = fixture();
    const original = await f.ingestion.getEvidence();
    for (const patch of [
      { mediaType: 'text/html' },
      { byteLength: 26 * 1024 * 1024 },
    ]) {
      f.ingestion.getEvidence.mockResolvedValue([{ ...original[0], ...patch }]);
      await expect(captureEducationIntake(f.input as never)).rejects.toThrow(
        'Unsupported',
      );
    }
    expect(f.ingestion.readEvidence).not.toHaveBeenCalled();
  });
});

describe('education analysis job', () => {
  it.each([
    undefined,
    null,
    42,
    'application/pdf',
    'image/png',
  ])('queues interpretation using authoritative extraction pin and optional region MIME hint %s without actions', async (mediaType) => {
    const observedRegions = {
      version: 1,
      coordinateSpace: 'display-oriented',
      regions: [
        { id: 'r1', text: 'Visible answer', rect: [0.2, 0.3, 0.1, 0.1] },
      ],
    };
    const ingestion = {
      claimAnalysis: vi.fn(async () => ({ attemptId: 'attempt' })),
      getAnalysisInput: vi.fn(async () => ({
        configuration: { extraction: {} },
      })),
      getCompletedAnalysis: vi.fn(async () => ({
        attemptId: 'attempt',
        evidence: [
          { id: 'source-image', contentHash: 'a'.repeat(64), mediaType },
        ],
        result: {
          status: 'completed',
          output: {
            results: [
              {
                evidence: { id: 'source-image', contentHash: 'a'.repeat(64) },
                capabilities: [{ location: 'source', boxes: false }],
                segments: [
                  {
                    location: { kind: 'source' },
                    boxes: null,
                    observedRegions,
                  },
                ],
              },
            ],
          },
        },
      })),
      prepareGeneration: vi.fn(async () => ({
        stage: 'interpret',
        pin: 'frozen',
      })),
      analyze: vi.fn(async () => ({ revision: 2 })),
    };
    const result = await processEducationAnalysis({
      ingestion,
      itemId: 'item',
      revision: 1,
      workerId: 'worker',
      adapter: {},
      extraction: {},
    } as never);
    expect(result).toEqual({ kind: 'generation_queued', revision: 2 });
    expect(ingestion.analyze).toHaveBeenCalledWith(
      'item',
      {
        stage: 'interpret',
        pin: 'frozen',
        educationEvidenceGrounding: {
          version: 1,
          extractionAttemptId: 'attempt',
          sources: [
            {
              evidenceId: 'source-image',
              sha256: 'a'.repeat(64),
              pages: [],
              ...(mediaType === 'image/png' ? { observedRegions } : {}),
            },
          ],
        },
      },
      'education:interpret:attempt',
    );
  });
  it('routes interpretation and stale claims without invoking extraction again', async () => {
    const ingestion = {
      claimAnalysis: vi.fn(async () => ({ attemptId: 'attempt' })),
      getAnalysisInput: vi.fn(async () => ({
        configuration: { stage: 'interpret' },
      })),
      generateProposals: vi.fn(),
    };
    const input = {
      ingestion,
      itemId: 'item',
      revision: 2,
      workerId: 'worker',
      adapter: {},
      extraction: {},
    };
    expect(await processEducationAnalysis(input as never)).toEqual({
      kind: 'interpreted',
    });
    ingestion.claimAnalysis.mockResolvedValue(null as never);
    expect(await processEducationAnalysis(input as never)).toEqual({
      kind: 'unclaimed',
    });
    expect(ingestion.generateProposals).toHaveBeenCalledTimes(1);
  });
});

describe('guardian grading handler', () => {
  it('uses exact executor, fixed attempt and database-only authorized review', async () => {
    const db = {};
    const service = {
      getSubmission: vi.fn(async () => ({
        id: 'submission',
        status: 'captured',
        intakeItemId: 'item',
        kind: 'completed_work',
      })),
      applyReviewedSubmission: vi.fn(),
    };
    const submissions = {
      withExecutor: vi.fn(async (executor, work) => {
        expect(executor).toBe(db);
        return work(service);
      }),
    };
    const handlers = educationIntakeHandlers({
      submissions,
      request: {
        tenantId: 'tenant',
        actorUserId: 'actor',
        learnerId: 'learner',
        enrollmentId: 'enrollment',
      },
      submissionId: 'submission',
    } as never);
    const context = {
      db,
      itemId: 'item',
      scope: { tenantId: 'tenant', actorId: 'actor' },
      policy: { requireReview: true },
      assertTarget: vi.fn(),
    };
    const grade = handlers[1];
    if (grade.execution.kind !== 'database')
      throw new Error('Expected database');
    expect(
      await grade.execution.apply(
        { submissionId: 'submission', score: 0, feedback: 'Try again' },
        context as never,
      ),
    ).toEqual({ submissionId: 'submission' });
    expect(service.applyReviewedSubmission.mock.lastCall?.[0]).toMatchObject({
      submissionId: 'submission',
      score: 0,
    });
    await expect(
      grade.execution.apply({ submissionId: 'other' }, context as never),
    ).rejects.toThrow('binding');
    await expect(
      grade.execution.apply({ submissionId: 'submission' }, {
        ...context,
        policy: { requireReview: false },
      } as never),
    ).rejects.toThrow('scope');
    service.applyReviewedSubmission.mockRejectedValue(
      new Error('stale attempt'),
    );
    await expect(
      grade.execution.apply({ submissionId: 'submission' }, context as never),
    ).rejects.toThrow('stale');
  });
});
