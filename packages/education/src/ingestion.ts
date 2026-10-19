/** Server-only paper workflow integration. Never import from browser handlers. */
import {
  type ExtractionAdapter,
  type ExtractionLimits,
  extractAnalysis,
  type IngestionService,
} from '@happyvertical/smrt-ingestion/server';

export { requireIngestionMemoryLimit } from './ingestion-isolation.js';

/** Immutable operator configuration; never populated from upload/model metadata. */
export interface EducationExtractionConfiguration {
  configurationRevision: string;
  limits: ExtractionLimits;
}

/** Allocate extraction after a durable receipt. The normal ingestion outbox
 * dispatches this revision to the application's registered job target.
 */
export async function queueEducationExtraction(
  ingestion: IngestionService,
  itemId: string,
  configuration: EducationExtractionConfiguration,
  submissionId?: string,
) {
  return ingestion.analyze(
    itemId,
    { extraction: configuration },
    `education:extract:${configuration.configurationRevision}:${submissionId ?? 'identify'}`,
  );
}

/** A registered job invokes this with its persisted item/revision IDs and an
 * authenticated service scope. Providers execute outside database transactions.
 * Interpretation receives ingestion's immutable extraction pin. Neither stage
 * approves a suggestion, captures a submission, or applies a grade.
 */
export async function processEducationAnalysis(input: {
  ingestion: IngestionService;
  itemId: string;
  revision: number;
  workerId: string;
  adapter: ExtractionAdapter;
  extraction: EducationExtractionConfiguration;
}): Promise<
  | { kind: 'unclaimed' | 'extraction_incomplete' | 'interpreted' }
  | { kind: 'generation_queued'; revision: number }
> {
  const { ingestion, itemId } = input;
  const lease = await ingestion.claimAnalysis(
    itemId,
    input.revision,
    input.workerId,
  );
  if (!lease) return { kind: 'unclaimed' };
  const snapshot = await ingestion.getAnalysisInput(lease);
  if (snapshot.configuration.stage === 'interpret') {
    await ingestion.generateProposals(lease);
    return { kind: 'interpreted' };
  }
  if (!snapshot.configuration.extraction)
    throw new Error('Unsupported education analysis stage');
  const completed = await extractAnalysis(
    ingestion,
    lease,
    input.adapter,
    input.extraction,
  );
  if (!completed) return { kind: 'extraction_incomplete' };
  const result = await ingestion.getCompletedAnalysis(itemId, lease.attemptId);
  if (!['completed', 'partial'].includes(result.result.status))
    return { kind: 'extraction_incomplete' };
  const generation = await ingestion.prepareGeneration(
    itemId,
    result.attemptId,
  );
  const queued = await ingestion.analyze(
    itemId,
    generation,
    `education:interpret:${result.attemptId}`,
  );
  return { kind: 'generation_queued', revision: queued.revision };
}

import { createHash } from 'node:crypto';
import type { IngestionScope } from '@happyvertical/smrt-ingestion/server';
import { getCurrentTenant, withTenant } from '@happyvertical/smrt-tenancy';
import { registerPermissionDefinitions } from '@happyvertical/smrt-users';
import type { LearnerRequest } from './learner-service.js';
import type {
  SubmissionPage,
  SubmissionService,
} from './submission-service.js';

export type EducationIntakeCaptureRequest = LearnerRequest & {
  enrollmentId: string;
  lessonId: string;
  itemId: string;
  kind: 'blank_reference' | 'completed_work';
  previousSubmissionId?: string;
  notes?: string;
};

/** Copy immutable retained originals into education's private ownership only
 * after the host has obtained explicit assignment confirmation. Supply service
 * and scope from the SAME authenticated server factory, never browser values.
 * The owning service persists unique tenant/item binding before allowing retries.
 */
export async function captureEducationIntake(input: {
  ingestion: IngestionService;
  scope: Readonly<IngestionScope>;
  submissions: SubmissionService;
  request: EducationIntakeCaptureRequest;
}) {
  const { ingestion, submissions, scope, request } = input;
  if (
    request.tenantId !== scope.tenantId ||
    request.actorUserId !== scope.actorId ||
    !['blank_reference', 'completed_work'].includes(request.kind) ||
    (request.kind === 'blank_reference' && request.previousSubmissionId)
  )
    throw new Error('Invalid education intake binding');
  // Authorize learner before consuming potentially expensive retained evidence.
  await submissions.getLearner(request);
  const evidence = (await ingestion.getEvidence(request.itemId)).filter(
    (entry) => entry.parentEvidenceId === null,
  );
  const extensions: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'application/pdf': 'pdf',
  };
  if (
    !evidence.length ||
    evidence.length > 100 ||
    evidence.some(
      (entry) =>
        !extensions[entry.mediaType] ||
        !Number.isSafeInteger(entry.byteLength) ||
        entry.byteLength < 1 ||
        entry.byteLength > 25 * 1024 * 1024,
    ) ||
    evidence.reduce((sum, entry) => sum + entry.byteLength, 0) >
      100 * 1024 * 1024
  )
    throw new Error('Unsupported or oversized education intake');
  evidence.sort((a, b) => a.partId.localeCompare(b.partId));
  const pages: SubmissionPage[] = [];
  for (const entry of evidence) {
    const bytes = await ingestion.readEvidence(request.itemId, entry.id);
    if (
      bytes.byteLength !== entry.byteLength ||
      createHash('sha256').update(bytes).digest('hex') !== entry.contentHash
    )
      throw new Error('Education intake integrity mismatch');
    pages.push({
      name: `${entry.id}.${extensions[entry.mediaType]}`,
      mimeType: entry.mediaType as SubmissionPage['mimeType'],
      data: Buffer.from(bytes),
    });
  }
  const capture = {
    ...request,
    requestKey: `education:intake:${request.itemId}`,
    pages,
    intake: {
      intakeItemId: request.itemId,
      kind: request.kind,
      previousSubmissionId: request.previousSubmissionId,
    },
  };
  if (request.kind === 'blank_reference')
    return submissions.captureBlankReference({
      ...capture,
      intakeItemId: request.itemId,
    });
  return request.previousSubmissionId
    ? submissions.resubmitSubmission({
        intakeItemId: request.itemId,
        ...capture,
        previousSubmissionId: request.previousSubmissionId,
      })
    : submissions.captureSubmission(capture);
}

import type {
  HandlerContext,
  IntakeValues,
  OperationHandler,
} from '@happyvertical/smrt-ingestion/execution';

const LESSON = '@happyvertical/smrt-education:Lesson';
const SUBMISSION = '@happyvertical/smrt-education:Submission';
const GRADE = '@happyvertical/smrt-education:Grade';
const idSchema = { type: 'string', minLength: 1, maxLength: 64 };
// Closed model transports intentionally generate no operation permissions.
// Declaring this server catalog does not grant it to any principal or actor.
registerPermissionDefinitions([
  {
    slug: 'lessons.read',
    collection: 'lessons',
    qualifiedName: LESSON,
    name: 'Identify authorized education assignments',
  },
  {
    slug: 'grades.create',
    collection: 'grades',
    qualifiedName: GRADE,
    name: 'Apply guardian-reviewed education grades',
  },
]);

/** Build the authoritative discovery/review catalog for ONE authenticated
 * learner/enrollment. The application resolves request from its session and
 * assignment; model/browser output can select a lesson but cannot select a user.
 * Keep all ingestion policy layers requireReview=true; no automation opt-in.
 */
export function educationIntakeHandlers(input: {
  submissions: SubmissionService;
  request: LearnerRequest & { enrollmentId: string };
  /** After capture, bind a new grading stage to this exact immutable attempt. */
  submissionId?: string;
}): OperationHandler[] {
  const { submissions, request } = input;
  const bound = async <T>(
    context: HandlerContext,
    work: (service: SubmissionService) => Promise<T>,
  ): Promise<T> => {
    if (
      context.scope.tenantId !== request.tenantId ||
      context.scope.actorId !== request.actorUserId ||
      !context.policy.requireReview
    )
      throw new Error('Education intake scope mismatch');
    // Ingestion's stable execution principal is not the human requester.
    // Preserve tenant permissions and the separate PrincipalRun runtime; only
    // the domain actor changes to the already-authenticated scope actor.
    if (!context.principal) return submissions.withExecutor(context.db, work);
    const tenant = getCurrentTenant();
    if (
      !tenant ||
      tenant.tenantId !== request.tenantId ||
      tenant.userId !== context.principal.context.userId ||
      context.principal.context.tenantId !== request.tenantId
    )
      throw new Error('Education principal tenant mismatch');
    return withTenant(
      {
        ...tenant,
        tenantId: request.tenantId,
        userId: request.actorUserId,
        superAdminBypass: false,
      },
      () => submissions.withExecutor(context.db, work),
    );
  };
  const lessons = (context: HandlerContext) =>
    bound(context, (service) => service.assignmentLessons(request));
  const requireLesson = async (args: IntakeValues, context: HandlerContext) => {
    const found = (await lessons(context)).find(
      (entry) => entry.lesson.id === args.lessonId,
    );
    if (!found) throw new Error('Education assignment unavailable');
    await context.assertTarget(LESSON, found.lesson.id);
    return found;
  };
  const handlers: OperationHandler[] = [
    {
      id: '@happyvertical/smrt-education:identify-assignment',
      version: '1',
      description:
        'Identify an assigned lesson from a blank or completed scan. Ambiguity requires guardian correction; this action does not grade or capture.',
      operation: { model: LESSON, action: 'get', version: '1' },
      capability: { effect: 'read', idempotent: true, openWorld: false },
      argsSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['lessonId'],
        properties: { lessonId: idSchema },
      },
      resultSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['lessonId'],
        properties: { lessonId: idSchema },
      },
      resultModels: { lessonId: LESSON },
      discovery: {
        mediaTypes: [
          'image/jpeg',
          'image/png',
          'image/webp',
          'application/pdf',
        ],
        references: { lessonId: { kind: 'candidate', model: LESSON } },
        candidates: async (query, context, page) => {
          // Authorize/filter exact enrollment FIRST; text only ranks that set.
          const visible = await lessons(context);
          const needle = query.toLocaleLowerCase();
          const ordered = [...visible].sort(
            (a, b) =>
              Number(b.lesson.title.toLocaleLowerCase().includes(needle)) -
                Number(a.lesson.title.toLocaleLowerCase().includes(needle)) ||
              a.lesson.id.localeCompare(b.lesson.id),
          );
          return {
            items: ordered.slice(0, page.limit).map((entry) => ({
              model: LESSON,
              id: entry.lesson.id,
              // Version binds immutable assignment identity; the host target
              // resolver must use this same format and reauthorize the plan.
              revision: `assignment:${request.enrollmentId}:${entry.lesson.id}`,
              label: entry.lesson.title,
            })),
            hasMore: ordered.length > page.limit,
          };
        },
      },
      validate: async (args, context) => {
        await requireLesson(args, context);
        return { ok: true };
      },
      preview: async (args, context) => {
        const found = await requireLesson(args, context);
        return {
          display: { lesson: found.lesson.title, gradeApplied: false },
          normalizedArgs: args,
          targetPreconditions: [
            {
              model: LESSON,
              id: found.lesson.id,
              revision: `assignment:${request.enrollmentId}:${found.lesson.id}`,
            },
          ],
        };
      },
      execution: {
        kind: 'database',
        apply: async (args, context) => {
          const found = await requireLesson(args, context);
          return { lessonId: found.lesson.id };
        },
      },
    },
  ];
  if (!input.submissionId) return handlers;
  const submissionId = input.submissionId;
  const current = (context: HandlerContext) =>
    bound(context, (service) =>
      service.getSubmission({ ...request, submissionId }),
    );
  const requireSubmission = async (
    args: IntakeValues,
    context: HandlerContext,
  ) => {
    if (args.submissionId !== submissionId)
      throw new Error('Education attempt binding mismatch');
    const submission = await current(context);
    if (
      submission.intakeItemId !== context.itemId ||
      submission.kind !== 'completed_work'
    )
      throw new Error('Education intake/attempt binding mismatch');
    await context.assertTarget(SUBMISSION, submissionId);
    return submission;
  };
  handlers.push({
    id: '@happyvertical/smrt-education:review-submission',
    version: '1',
    description:
      'Suggest marks and feedback for this captured attempt. Only a current authorized guardian decision may apply a grade.',
    operation: { model: GRADE, action: 'create', version: '1' },
    capability: { effect: 'write', idempotent: false, openWorld: false },
    argsSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['submissionId', 'score', 'feedback'],
      properties: {
        submissionId: idSchema,
        score: { type: ['number', 'null'], minimum: 0, maximum: 1 },
        feedback: { type: 'string', maxLength: 10000 },
      },
    },
    resultSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['submissionId'],
      properties: { submissionId: idSchema },
    },
    resultModels: { submissionId: SUBMISSION },
    discovery: {
      mediaTypes: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'],
      references: { submissionId: { kind: 'candidate', model: SUBMISSION } },
      candidates: async (_query, context) => {
        const submission = await current(context);
        return {
          items: [
            {
              model: SUBMISSION,
              id: submission.id,
              revision: `attempt:${submission.id}:${submission.status}`,
              label: 'Current captured attempt (guardian review required)',
            },
          ],
          hasMore: false,
        };
      },
    },
    validate: async (args, context) => {
      await requireSubmission(args, context);
      return { ok: true };
    },
    preview: async (args, context) => {
      const submission = await requireSubmission(args, context);
      return {
        display: {
          submissionId,
          proposedScore: args.score,
          proposedFeedback: args.feedback,
          guardianReviewRequired: true,
        },
        normalizedArgs: args,
        targetPreconditions: [
          {
            model: SUBMISSION,
            id: submissionId,
            revision: `attempt:${submission.id}:${submission.status}`,
          },
        ],
      };
    },
    execution: {
      kind: 'database',
      apply: async (args, context) => {
        await requireSubmission(args, context);
        await bound(context, (service) =>
          service.applyReviewedSubmission({
            ...request,
            submissionId,
            score: args.score as number | null,
            feedback: String(args.feedback),
          }),
        );
        return { submissionId };
      },
    },
  });
  return handlers;
}

/** Owning education target resolver for ingestion's transactional host hook.
 * Serializes with education enrollment mutations, then performs public service
 * authorization on the supplied executor. The host still owns live principal
 * grant/revocation serialization in its execution authorize callback.
 */
export function educationIntakeTargetResolver(input: {
  submissions: SubmissionService;
  request: LearnerRequest & { enrollmentId: string };
  submissionId?: string;
}): import('@happyvertical/smrt-ingestion/execution').IntakeExecutionOptions['assertTarget'] {
  return async ({ db, scope, itemId, model, id, revision }) => {
    const { request, submissions } = input;
    if (
      scope.tenantId !== request.tenantId ||
      scope.actorId !== request.actorUserId
    )
      throw new Error('Education intake scope mismatch');
    await db.query(
      'UPDATE enrollments SET id=id WHERE id=? AND tenant_id=?',
      request.enrollmentId,
      request.tenantId,
    );
    const current = await withTenant(
      {
        ...getCurrentTenant(),
        tenantId: request.tenantId,
        userId: request.actorUserId,
        superAdminBypass: false,
      },
      () =>
        submissions.withExecutor(db, async (service) => {
          if (model === LESSON) {
            const available = await service.assignmentLessons(request);
            if (!available.some((entry) => entry.lesson.id === id))
              throw new Error('Education assignment unavailable');
            return `assignment:${request.enrollmentId}:${id}`;
          }
          if (model !== SUBMISSION || id !== input.submissionId)
            throw new Error('Education target unavailable');
          const submission = await service.getSubmission({
            ...request,
            submissionId: id,
          });
          if (
            submission.intakeItemId !== itemId ||
            submission.kind !== 'completed_work'
          )
            throw new Error('Education intake/attempt binding mismatch');
          return `attempt:${submission.id}:${submission.status}`;
        }),
    );
    if (revision !== undefined && revision !== current)
      throw new Error('Education target changed');
    return { revision: current };
  };
}
