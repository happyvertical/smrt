/** Server-only paper workflow integration. Never import from browser handlers. */
import {
  type ExtractionAdapter,
  type ExtractionLimits,
  extractAnalysis,
  GenerationSnapshotStaleError,
  type IngestionService,
  normalizeObservedImageRegions,
  ProposalsNotConfiguredError,
} from '@happyvertical/smrt-ingestion/server';
import { normalizeWorkbookAnswerRegions } from './workbook-answer-regions.js';

import { normalizeWorkbookObservedLayout } from './workbook-layout.js';

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
    {
      ...generation,
      educationEvidenceGrounding: educationEvidenceGrounding(result),
    },
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
import {
  aggregateWorkbookQuestions,
  validateWorkbookAssessment,
  WORKBOOK_MATH_VOCABULARY,
  type WorkbookAssessment,
  WorkbookAssessmentValidationError,
  workbookAggregateFeedback,
} from './workbook-contracts.js';
import { WorkbookService } from './workbook-service.js';

export type EducationIntakeCaptureRequest = LearnerRequest & {
  workbookActivityId?: string;
  assistance?: import('./workbook-contracts.js').WorkbookAssistance;
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
    request.enrollmentId !== scope.confidentialScopeId ||
    !['blank_reference', 'completed_work'].includes(request.kind) ||
    (request.kind === 'blank_reference' && request.previousSubmissionId)
  )
    throw new Error('Invalid education intake binding');
  // Prove the exact active learner/enrollment/lesson assignment before reading
  // any family-private retained evidence. Intake scopes are enrollment-bound.
  await submissions.assertLessonAssignment(request);
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
  if (request.workbookActivityId) {
    if (
      !(submissions instanceof WorkbookService) ||
      request.kind !== 'completed_work'
    )
      throw new Error(
        'Workbook intake requires WorkbookService completed work',
      );
    const attempt = await submissions.captureWorkbookWork({
      ...request,
      activityId: request.workbookActivityId,
      intakeItemId: request.itemId,
      requestKey: capture.requestKey,
      pages,
    });
    return attempt.submission;
  }
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
  workbookActivityId?: string;
  workbookVocabulary?: WorkbookAssessment['vocabulary'];
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
  const workbook = input.workbookActivityId;
  if (workbook && !(submissions instanceof WorkbookService))
    throw new Error('Workbook handler requires WorkbookService');
  const vocabulary = input.workbookVocabulary ?? WORKBOOK_MATH_VOCABULARY;
  handlers.push({
    id: '@happyvertical/smrt-education:review-submission',
    version: '1',
    description: workbook
      ? 'Assess visible questions from current captured evidence only. Historical IDs indicate correspondence, never current answers. Prompt is printed task text excluding response; answer is observed learner response only. Printed solved examples/answer keys are not learner answers or learning evidence. Never solve a task and call it the observed response. Matching answers require explicitly observed line endpoints; unreadable connections are unassessed/illegible or missing_context. Missing book/lesson identity never blocks visible work. Use printed number+occurrence/subpart IDs when present. Unnumbered tasks use u:<short printed-task slug>:<occurrence/subpart>, excluding learner answers and solved results. Occurrence identifies visible tasks, never output-array position. Retain exact known IDs on correction; absent/ambiguous correspondence is unassessed/not_present, never guessed or renumbered. Cite original evidence IDs only; no page/rect/coordinate fields, as service retains whole-source grounding. Correct/incorrect/partially_correct use reason none. Unsupported, unanswered, illegible, missing_context and not_present are unassessed, never incorrect, with null points. Judge objectively solvable arithmetic without a printed rubric. Correctness is independent of points: absent evidenced allocation, BOTH points and possiblePoints are null, including incorrect. Never invent weights/rubric or mix null/numeric fields. Only use incorrect points=0 when possiblePoints is known; correct earns that known total. No aggregate score/summary: service computes totals. Concepts are supplied-vocabulary suggestions; no match uses conceptIds [] and still assesses normally. markingCertainty=uncertain requires result=unassessed, reason illegible/missing_context/unsupported/unanswered/not_present, points=null and possiblePoints=null. Never assert correctness with uncertain marking. Mapping certainty is separate. Guardian review is required for authority.'
      : 'Suggest marks and feedback for this captured attempt. Only a current authorized guardian decision may apply a grade.',
    operation: { model: GRADE, action: 'create', version: '1' },
    capability: { effect: 'write', idempotent: false, openWorld: false },
    argsSchema: {
      type: 'object',
      additionalProperties: false,
      required: workbook
        ? ['submissionId', 'questions']
        : ['submissionId', 'score', 'feedback'],
      properties: {
        submissionId: idSchema,
        ...(workbook
          ? {
              answerRegions: {
                description:
                  'Include advisory answer locations when a current observedRegions catalog clearly matches visible learner responses. Omit unknown or uncertain positions. Shape {version:1,regions:[{questionId,evidenceId,observationId}]}. Reference ONLY exact current evidence observedRegions catalog IDs with matching visible learner response/question; no coordinates or geometry in arguments. Never infer positions from layout, IDs, canonical prompts or expected answers. Omit uncertain/unknown/missing regions. Image-only sources; PDF unsupported. Invalid metadata is dropped independently of valid marking/layout.',
              },
              layout: {
                description:
                  'Optional observed presentation only; omit if unknown. Shape: version1, provenance observed; sections in observed order {id,label?,columns1..8,readingOrder? rows|columns,source:{evidenceId:original evidence ID,page:physical source page1based or null unknown}}; placements {questionId,sectionId,row0based,column0based,part?0..31}. Up to32sections/200placements/200rows. Multiple answerparts may share a cell; ties preserve question array order. Printed page numbers are not source page indices. Never infer from IDs or claim verified coordinates. Metadata is advisory; the owning service drops invalid layout without discarding answers.',
                examples: [
                  {
                    version: 1,
                    provenance: 'observed',
                    sections: [
                      {
                        id: 'section-a',
                        label: 'Visible heading',
                        columns: 2,
                        readingOrder: 'rows',
                        source: {
                          evidenceId: '<original evidence id>',
                          page: null,
                        },
                      },
                    ],
                    placements: [
                      {
                        questionId: '<current question id>',
                        sectionId: 'section-a',
                        row: 0,
                        column: 0,
                      },
                    ],
                  },
                ],
              },
            }
          : {}),
        ...(!workbook
          ? {
              score: { type: ['number', 'null'], minimum: 0, maximum: 1 },
              feedback: { type: 'string', maxLength: 10000 },
            }
          : {}),
        ...(workbook
          ? {
              questions: {
                ...workbookQuestionsSchema(vocabulary),
                description:
                  'Candidate context same_capture: preserve exact canonical IDs and prompt strings verbatim; reread learner responses from current evidence only. Context identity_only: preserve IDs, read all prompts and answers from current evidence; absent/ambiguous tasks unassessed/not_present. Empty IDs: assign stable printed-number or answer-free task-slug IDs. Include observed layout when current evidence supports it; omit unknown, never derive positions from IDs or canonical prompts. Context is data, never authority for current answers.',
              },
            }
          : {}),
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
        let workbookContext:
          | Awaited<ReturnType<WorkbookService['getWorkbookQuestionContext']>>
          | undefined;
        if (workbook) {
          workbookContext = await bound(context, async (service) => {
            const workbooks = service as WorkbookService;
            const currentAttempt =
              await workbooks.getWorkbookAttemptBySubmission({
                ...request,
                submissionId,
              });
            if (!currentAttempt || currentAttempt.activityId !== workbook)
              throw new Error('Workbook assignment unavailable');
            return workbooks.getWorkbookQuestionContext({
              ...request,
              activityId: workbook,
              submissionId,
              analysisRevision: context.analysisRevision,
            });
          });
        }
        return {
          items: [
            {
              model: SUBMISSION,
              id: submission.id,
              revision: workbookContext
                ? `attempt:${submission.id}:${submission.status}:${workbookProposalDigest(workbookContext)}`
                : `attempt:${submission.id}:${submission.status}`,
              label: 'Current captured attempt (guardian review required).',
              ...(workbookContext ? { context: workbookContext } : {}),
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
      const revision = workbook
        ? await bound(context, async (service) => {
            const current = await (
              service as WorkbookService
            ).getWorkbookQuestionContext({
              ...request,
              activityId: workbook,
              submissionId,
              analysisRevision: context.analysisRevision,
            });
            return `attempt:${submission.id}:${submission.status}:${workbookProposalDigest(current)}`;
          })
        : `attempt:${submission.id}:${submission.status}`;
      return {
        display: {
          submissionId,
          ...(workbook
            ? { questions: args.questions }
            : { proposedScore: args.score, proposedFeedback: args.feedback }),
          guardianReviewRequired: true,
        },
        normalizedArgs: args,
        targetPreconditions: [
          {
            model: SUBMISSION,
            id: submissionId,
            revision,
          },
        ],
      };
    },
    execution: {
      kind: 'database',
      apply: async (args, context) => {
        await requireSubmission(args, context);
        if (workbook) {
          await bound(context, async (service) => {
            const workbooks = service as WorkbookService;
            const timeline = await workbooks.getWorkbookTimeline({
              ...request,
              activityId: workbook,
            });
            const attempt = timeline.attempts.find(
              (entry) => entry.submissionId === submissionId,
            );
            const proposal = attempt?.revisions.find(
              (revision) =>
                revision.kind === 'ai' &&
                revision.assessment.provenance.proposalDigest ===
                  workbookProposalDigest(args),
            );
            if (!proposal)
              throw new Error(
                'Workbook analysis must be preserved before guardian apply',
              );
            await workbooks.reviewWorkbookAssessment({
              ...request,
              activityId: workbook,
              submissionId,
              revisionId: proposal.id,
              expectedHeadId: null,
              requestKey: `ingestion-review:${proposal.id}`,
            });
          });
          return { submissionId };
        }
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
  return async ({
    db,
    scope,
    itemId,
    analysisRevision,
    model,
    id,
    revision,
  }) => {
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
          if (service instanceof WorkbookService) {
            const attempt = await service.getWorkbookAttemptBySubmission({
              ...request,
              submissionId: id,
            });
            if (attempt) {
              const context = await service.getWorkbookQuestionContext({
                ...request,
                activityId: attempt.activityId,
                submissionId: id,
                analysisRevision,
              });
              return `attempt:${submission.id}:${submission.status}:${workbookProposalDigest(context)}`;
            }
          }
          return `attempt:${submission.id}:${submission.status}`;
        }),
    );
    if (revision !== undefined && revision !== current)
      throw new Error('Education target changed');
    return { revision: current };
  };
}

function workbookProposalDigest(value: unknown): string {
  // Canonical object keys permit DTO/JSON roundtrips without changing identity.
  const canonical = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(canonical)
      : v && typeof v === 'object'
        ? Object.fromEntries(
            Object.entries(v)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, x]) => [k, canonical(x)]),
          )
        : v;
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
}

function workbookQuestionsSchema(vocabulary: WorkbookAssessment['vocabulary']) {
  return {
    type: 'array',
    minItems: 1,
    maxItems: 200,
    items: {
      type: 'object',
      additionalProperties: false,
      required: [
        'id',
        'prompt',
        'answer',
        'result',
        'reason',
        'feedback',
        'points',
        'possiblePoints',
        'anchors',
        'conceptIds',
        'markingCertainty',
        'mappingCertainty',
        'evidenceLimitations',
      ],
      oneOf: [
        {
          properties: {
            result: { enum: ['correct', 'incorrect', 'partially_correct'] },
            markingCertainty: { enum: ['clear', 'unknown'] },
            reason: { const: 'none' },
          },
        },
        {
          properties: {
            result: { const: 'unassessed' },
            reason: {
              enum: [
                'unanswered',
                'illegible',
                'missing_context',
                'unsupported',
                'not_present',
              ],
            },
            points: { type: 'null' },
            possiblePoints: { type: 'null' },
          },
        },
      ],
      properties: {
        id: { type: 'string', minLength: 1, maxLength: 200 },
        prompt: { type: 'string', maxLength: 10000 },
        answer: { type: 'string', maxLength: 10000 },
        result: {
          type: 'string',
          enum: ['correct', 'incorrect', 'partially_correct', 'unassessed'],
        },
        reason: {
          type: 'string',
          enum: [
            'none',
            'unanswered',
            'illegible',
            'missing_context',
            'unsupported',
            'not_present',
          ],
        },
        feedback: { type: 'string', maxLength: 10000 },
        points: { type: ['number', 'null'], minimum: 0 },
        possiblePoints: { type: ['number', 'null'], minimum: 0 },
        markingCertainty: {
          type: 'string',
          enum: ['clear', 'uncertain', 'unknown'],
        },
        mappingCertainty: {
          type: 'string',
          enum: ['clear', 'uncertain', 'unknown'],
        },
        evidenceLimitations: {
          type: 'array',
          maxItems: 20,
          items: { type: 'string', maxLength: 500 },
        },
        conceptIds: {
          type: 'array',
          maxItems: 10,
          items: { type: 'string', enum: vocabulary.concepts.map((c) => c.id) },
        },
        anchors: {
          type: 'array',
          minItems: 1,
          maxItems: 20,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['evidenceId'],
            properties: {
              evidenceId: idSchema,
            },
          },
        },
      },
    },
  };
}

/** Bounded geometry capability transfer, pinned in the generation configuration. */
function educationEvidenceGrounding(
  snapshot: Awaited<ReturnType<IngestionService['getCompletedAnalysis']>>,
) {
  const results = Array.isArray(snapshot.result.output?.results)
    ? snapshot.result.output.results
    : [];
  const sources = results.slice(0, 100).flatMap((value) => {
    if (!value || typeof value !== 'object') return [];
    const result = value as {
      evidence?: { id?: string; contentHash?: string; mediaType?: string };
      capabilities?: { location?: string }[];
      segments?: {
        location?: { kind?: string; page?: number };
        observedRegions?: unknown;
      }[];
    };
    const evidence = (snapshot.evidence ?? []).find(
      (e) =>
        e.id === result.evidence?.id &&
        e.contentHash === result.evidence?.contentHash,
    );
    if (!evidence) return [];
    const pageCapable =
      Array.isArray(result.capabilities) &&
      result.capabilities.some((c) => c.location === 'page');
    const pages =
      pageCapable && Array.isArray(result.segments)
        ? [
            ...new Set(
              result.segments.flatMap((segment) =>
                segment.location?.kind === 'page' &&
                Number.isSafeInteger(segment.location.page) &&
                (segment.location.page ?? 0) > 0
                  ? [segment.location.page as number]
                  : [],
              ),
            ),
          ].slice(0, 1000)
        : [];
    const catalogs =
      evidence.mediaType.startsWith('image/') && Array.isArray(result.segments)
        ? result.segments
            .filter((s) => s.location?.kind === 'source')
            .map((s) => normalizeObservedImageRegions(s.observedRegions))
            .filter((s) => s !== undefined)
        : [];
    return [
      {
        evidenceId: evidence.id,
        sha256: evidence.contentHash,
        pages,
        ...(catalogs.length === 1 ? { observedRegions: catalogs[0] } : {}),
      },
    ];
  });
  return { version: 1, extractionAttemptId: snapshot.attemptId, sources };
}

export type WorkbookPreservationResult =
  | { kind: 'pending' }
  | { kind: 'unavailable' }
  | { kind: 'retained'; revisionId: string }
  | { kind: 'preserved'; revisionId: string }
  | {
      kind: 'needs_review';
      reason:
        | 'invalid_assessment'
        | 'ungrounded_source'
        | 'ambiguous_proposal'
        | 'stale_analysis';
    };

/** Preserve validated question evidence; invalid model output is reviewable status,
 * never an educational mark or a generic server error. Education authorization,
 * integrity and DB errors throw; unavailable scratch never grants raw access.
 */
export async function preserveWorkbookIntakeAnalysis(input: {
  ingestion: IngestionService;
  workbooks: WorkbookService;
  request: LearnerRequest & { enrollmentId: string };
  activityId: string;
  submissionId: string;
  workbookVocabulary?: WorkbookAssessment['vocabulary'];
}): Promise<WorkbookPreservationResult> {
  const { ingestion, workbooks, request, activityId, submissionId } = input;
  const attempt = await workbooks.getWorkbookAttemptBySubmission({
    ...request,
    submissionId,
  });
  if (
    !attempt ||
    attempt.activityId !== activityId ||
    !attempt.submission.intakeItemId
  )
    throw new Error('Workbook intake binding unavailable');
  const itemId = attempt.submission.intakeItemId;
  const state = await workbooks.getWorkbookPreservationState({
    ...request,
    activityId,
    submissionId,
  });
  const latestRetained = state.retainedAnalyses.at(-1);
  const legacyRetained = state.retainedAnalyses.every(
    (entry) => entry.analysisRevision === null,
  )
    ? latestRetained
    : undefined;
  let currentRevision: number;
  try {
    currentRevision = (await ingestion.getItem(itemId)).analysisRevision;
  } catch (error) {
    if (error instanceof Error && error.message === 'Intake unavailable')
      return latestRetained
        ? { kind: 'retained', revisionId: latestRetained.assessmentRevisionId }
        : { kind: 'unavailable' };
    throw error;
  }
  const exact = state.retainedAnalyses.find(
    (entry) => entry.analysisRevision === currentRevision,
  );
  if (exact)
    return { kind: 'retained', revisionId: exact.assessmentRevisionId };
  let snapshot: Awaited<ReturnType<IngestionService['getCompletedAnalysis']>>;
  try {
    snapshot = await ingestion.getCompletedAnalysis(itemId);
  } catch (error) {
    if (error instanceof ProposalsNotConfiguredError)
      return legacyRetained
        ? { kind: 'retained', revisionId: legacyRetained.assessmentRevisionId }
        : { kind: 'unavailable' };
    if (error instanceof GenerationSnapshotStaleError)
      return legacyRetained
        ? { kind: 'retained', revisionId: legacyRetained.assessmentRevisionId }
        : { kind: 'needs_review', reason: 'stale_analysis' };
    if (error instanceof Error && error.message === 'Intake unavailable')
      return latestRetained
        ? { kind: 'retained', revisionId: latestRetained.assessmentRevisionId }
        : { kind: 'unavailable' };
    if (error instanceof Error && error.message === 'Analysis unavailable')
      return latestRetained
        ? { kind: 'retained', revisionId: latestRetained.assessmentRevisionId }
        : { kind: 'pending' };
    throw error;
  }
  if (
    snapshot.configuration.stage !== 'interpret' ||
    !['completed', 'partial'].includes(snapshot.result.status)
  )
    return { kind: 'pending' };
  const importedAttempt = state.retainedAnalyses.find(
    (entry) => entry.analysisAttemptId === snapshot.attemptId,
  );
  if (importedAttempt)
    return {
      kind: 'retained',
      revisionId: importedAttempt.assessmentRevisionId,
    };
  const sources = await workbooks.getWorkbookSourceAnchors({
    ...request,
    activityId,
    submissionId,
  });
  const originals = snapshot.evidence
    .filter((e) => e.parentEvidenceId === null)
    .sort((a, b) => a.partId.localeCompare(b.partId));
  if (
    originals.length !== sources.length ||
    originals.some((e, i) => e.contentHash !== sources[i].sha256)
  )
    throw new Error('Workbook retained source mismatch');
  let assessment: WorkbookAssessment;
  try {
    const generation = (
      snapshot.result.output as unknown as {
        proposals?: import('@happyvertical/smrt-ingestion').GenerationOutput;
      }
    ).proposals;
    if (
      !generation ||
      generation.version !== 1 ||
      !Array.isArray(generation.suggestions)
    )
      throw new WorkbookAssessmentValidationError(
        'Malformed workbook generation',
      );
    if (!['proposals', 'needs_review'].includes(generation.outcome))
      return {
        kind: 'needs_review',
        reason:
          generation.outcome === 'ambiguous'
            ? 'ambiguous_proposal'
            : 'invalid_assessment',
      };
    const suggestions = generation.suggestions.filter(
      (s) => s.handlerId === '@happyvertical/smrt-education:review-submission',
    );
    if (suggestions.length !== 1)
      throw new WorkbookAssessmentValidationError(
        'Expected one workbook proposal',
        'ambiguous_proposal',
      );
    const suggestion = suggestions[0];
    if (
      suggestion.args.submissionId !== submissionId ||
      !Array.isArray(suggestion.args.questions) ||
      suggestion.missingFields.length
    )
      throw new WorkbookAssessmentValidationError(
        'Incomplete workbook question proposal',
      );
    const offered = generation.offered.find(
      (entry) => entry.handler.id === suggestion.handlerId,
    );
    const questionSchema = (
      offered?.handler.argsSchema.properties as
        | Record<string, unknown>
        | undefined
    )?.questions as
      | { items: { properties: { conceptIds: { items: { enum: string[] } } } } }
      | undefined;
    if (!questionSchema)
      throw new WorkbookAssessmentValidationError(
        'Generation did not use workbook question contract',
      );
    const curated = input.workbookVocabulary ?? WORKBOOK_MATH_VOCABULARY;
    if (
      JSON.stringify(questionSchema.items.properties.conceptIds.items.enum) !==
      JSON.stringify(curated.concepts.map((c) => c.id))
    )
      throw new WorkbookAssessmentValidationError(
        'Unsupported workbook vocabulary',
      );
    const grounding = snapshot.configuration.educationEvidenceGrounding as
      | {
          version?: number;
          extractionAttemptId?: string;
          sources?: {
            evidenceId: string;
            sha256: string;
            pages: number[];
            observedRegions?: unknown;
          }[];
        }
      | undefined;
    const trustedGrounding =
      grounding?.version === 1 &&
      grounding.extractionAttemptId === generation.source?.attemptId
        ? grounding
        : undefined;
    const questions = suggestion.args.questions.map((value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new WorkbookAssessmentValidationError(
          'Invalid workbook question',
        );
      const q = value as Record<string, unknown>;
      if (!Array.isArray(q.anchors))
        throw new WorkbookAssessmentValidationError(
          'Missing workbook source anchors',
          'ungrounded_source',
        );
      const limitations = new Set(
        Array.isArray(q.evidenceLimitations)
          ? (q.evidenceLimitations as string[])
          : [],
      );
      const anchors = q.anchors.map((value) => {
        const anchor = value as { evidenceId?: string };
        const index = originals.findIndex((e) => e.id === anchor?.evidenceId);
        if (index < 0)
          throw new WorkbookAssessmentValidationError(
            'Question must cite a captured original',
            'ungrounded_source',
          );
        const original = originals[index];
        const page = original.mediaType?.startsWith('image/') ? 1 : null;
        const level = 'source' as const;
        limitations.add(
          'Source-level evidence only; no verified question page or region was supplied by extraction.',
        );
        return {
          assetId: sources[index].assetId,
          sha256: sources[index].sha256,
          page,
          rect: [0, 0, 1, 1] as [number, number, number, number],
          grounding: level,
          ...(trustedGrounding?.extractionAttemptId
            ? { extractionAttemptId: trustedGrounding.extractionAttemptId }
            : {}),
        };
      });
      return {
        ...q,
        anchors,
        evidenceLimitations: [...limitations],
      } as unknown as WorkbookAssessment['questions'][number];
    });
    let observedLayout: unknown = suggestion.args.layout;
    if (
      observedLayout &&
      typeof observedLayout === 'object' &&
      !Array.isArray(observedLayout)
    ) {
      const candidate = observedLayout as Record<string, unknown>;
      if (
        Array.isArray(candidate.sections) &&
        candidate.sections.length <= 32
      ) {
        observedLayout = {
          ...candidate,
          sections: candidate.sections.map((section: unknown) => {
            if (
              !section ||
              typeof section !== 'object' ||
              Array.isArray(section)
            )
              return section;
            const row = section as Record<string, unknown>;
            const source = row.source as
              | { evidenceId?: unknown; page?: unknown }
              | undefined;
            const index = originals.findIndex(
              (e) => e.id === source?.evidenceId,
            );
            return {
              ...row,
              source: {
                assetId: index >= 0 ? sources[index].assetId : '',
                page: source?.page,
              },
            };
          }),
        };
      }
    }
    let mappedRegions: unknown = suggestion.args.answerRegions;
    if (
      mappedRegions &&
      typeof mappedRegions === 'object' &&
      !Array.isArray(mappedRegions)
    ) {
      const proposed = mappedRegions as Record<string, unknown>;
      if (proposed.version === 1 && Array.isArray(proposed.regions)) {
        mappedRegions = {
          version: 1,
          provenance: 'observed',
          coordinateSpace: 'display-oriented',
          regions: proposed.regions.map((entry: unknown) => {
            if (!entry || typeof entry !== 'object' || Array.isArray(entry))
              return {};
            const r = entry as Record<string, unknown>;
            if (
              Object.keys(r).some(
                (key) =>
                  !['questionId', 'evidenceId', 'observationId'].includes(key),
              )
            )
              return {};
            const index = originals.findIndex(
              (e) => e.id === r.evidenceId && e.mediaType.startsWith('image/'),
            );
            const catalogSource = trustedGrounding?.sources?.find(
              (source) =>
                source.evidenceId === r.evidenceId &&
                source.sha256 === originals[index]?.contentHash,
            );
            const catalog = normalizeObservedImageRegions(
              catalogSource?.observedRegions,
            );
            const observed = catalog?.regions.find(
              (region) => region.id === r.observationId,
            );
            return {
              questionId: r.questionId,
              source: {
                assetId: index >= 0 ? sources[index].assetId : '',
                page: 1,
              },
              observationId: r.observationId,
              rect: observed?.rect,
            };
          }),
        };
      }
    }
    assessment = {
      version: 1,
      feedback: '',
      questions,
      ...normalizeWorkbookObservedLayout(observedLayout, questions, sources),
      ...normalizeWorkbookAnswerRegions(mappedRegions, questions, sources),
      vocabulary: structuredClone(curated),
      provenance: {
        provider: generation.provenance.generative.provider,
        model:
          generation.provenance.generativeResponseModel ??
          generation.provenance.generative.model,
        configurationVersion: generation.provenance.configurationVersion,
        rubricVersion: generation.provenance.promptVersion,
        inputHash: snapshot.inputDigest,
        analysisId: snapshot.attemptId,
        analysisRevision: snapshot.revision,
        proposalDigest: workbookProposalDigest(suggestion.args),
        providerVersion: generation.provenance.generative.version,
        sourceAnalysis: generation.source,
        catalogDigest: generation.provenance.catalogDigest,
        policyVersions: generation.provenance.policyVersions,
      },
    };
    validateWorkbookAssessment(assessment);
    assessment.aggregate = aggregateWorkbookQuestions(assessment.questions);
    assessment.feedback = workbookAggregateFeedback(assessment.aggregate);
  } catch (error) {
    if (error instanceof WorkbookAssessmentValidationError)
      return { kind: 'needs_review', reason: error.reason };
    if (error instanceof TypeError)
      return { kind: 'needs_review', reason: 'invalid_assessment' };
    throw error;
  }
  try {
    const revision = await workbooks.recordWorkbookAnalysis({
      ...request,
      activityId,
      submissionId,
      requestKey: `ingestion:${snapshot.attemptId}`,
      assessment,
    });
    return { kind: 'preserved', revisionId: revision.id };
  } catch (error) {
    if (error instanceof WorkbookAssessmentValidationError)
      return { kind: 'needs_review', reason: error.reason };
    throw error;
  }
}

export {
  preserveWorkbookPhotoIdentification,
  processWorkbookPhotoAnalysis,
  receiveWorkbookPhotoIntake,
  retainWorkbookPhotoReceipt,
  WORKBOOK_PHOTO_HANDLER,
  workbookPhotoIntakeHandlers,
  workbookPhotoIntakeTargetResolver,
} from './workbook-photo-ingestion.js';
