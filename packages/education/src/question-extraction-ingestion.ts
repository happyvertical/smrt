/**
 * Server-only ingestion bridge for question extraction (SMRT #4517): the
 * `extract-questions` catalog handler and the preserve step that validates a
 * completed proposal against retained evidence. Never import from browser code.
 */
import type {
  HandlerContext,
  OperationHandler,
} from '@happyvertical/smrt-ingestion/execution';
import {
  type IngestionService,
  normalizeObservedImageRegions,
} from '@happyvertical/smrt-ingestion/server';
import { getCurrentTenant, withTenant } from '@happyvertical/smrt-tenancy';
import { registerPermissionDefinitions } from '@happyvertical/smrt-users';
import type { CourseAuthoringActor } from './course-authoring-contracts.js';
import { intakeOriginalEvidence } from './intake-original-evidence.js';
import type { WorksheetBundle } from './question-contracts.js';
import { QUESTION_EXTRACTION_ARGS_SCHEMA } from './question-extraction.js';
import {
  type QuestionExtractionGrounding,
  QuestionExtractionPendingError,
  QuestionExtractionValidationError,
  type QuestionExtractionView,
} from './question-extraction-contracts.js';
import {
  type QuestionExtractionService,
  questionExtractionProposalDigest,
} from './question-extraction-service.js';

export const QUESTION_EXTRACTION_HANDLER_ID =
  '@happyvertical/smrt-education:extract-questions';
const QUESTION = '@happyvertical/smrt-education:Question';
const MEDIA_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
];

// Closed model transports generate no operation permissions; declaring this
// server catalog entry grants nothing to any principal or actor.
registerPermissionDefinitions([
  {
    slug: 'questions.create',
    collection: 'questions',
    qualifiedName: QUESTION,
    name: 'Apply reviewed question extractions',
  },
]);

const DESCRIPTION =
  'Extract the printed questions of a scanned worksheet or imported course file as structured data for extraction review. ' +
  'Report every source page in pages with its role (exercise, example, instructions, cover, answer_key, mixed, unknown) and readability; never drop a page. ' +
  'questions holds printed task text only: prompt, numbering exactly as printed, subparts, choices, section, diagram/table/image references and any answer key or rubric printed in the source (origin source). ' +
  'Mark anything you supply yourself origin inferred; never present an inferred key, type or points as printed. ' +
  'Unreadable or unsupported tasks keep their key and numbering with status unreadable/unsupported and prompt null; content you cannot extract goes in omissions. ' +
  'Worked examples use role example. Learner handwriting goes only in studentWork (observed text, or null when illegible), never in prompts or keys; never solve a task and report it as observed work. ' +
  'Keys: printed numbering path (for example 3, 3b), else u:<short printed-task slug>:<occurrence>. ' +
  'worksheetVersionId only when a wsv1- id is printed on the page. Anchors cite original evidenceId, the physical source page (1-based, or null when unknown; printed page numbers are not pages) and regionId only from that evidence observedRegions catalog, else null; never coordinates. ' +
  'Applying needs a human extraction decision; it creates or links question records and never grades or attaches learner work.';

/** Bind a handler call to the authenticated host actor; same rules as education intake. */
function bound<T>(
  request: CourseAuthoringActor,
  context: HandlerContext,
  work: () => Promise<T>,
): Promise<T> {
  if (
    context.scope.tenantId !== request.tenantId ||
    context.scope.actorId !== request.actorUserId ||
    !context.policy.requireReview
  )
    throw new Error('Question extraction scope mismatch');
  if (!context.principal) return work();
  // Ingestion's stable execution principal is not the human requester: keep
  // its tenant permissions, change only the domain actor to the scope actor.
  const tenant = getCurrentTenant();
  if (
    !tenant ||
    tenant.tenantId !== request.tenantId ||
    tenant.userId !== context.principal.context.userId ||
    context.principal.context.tenantId !== request.tenantId
  )
    throw new Error('Question extraction principal tenant mismatch');
  return withTenant(
    {
      ...tenant,
      tenantId: request.tenantId,
      userId: request.actorUserId,
      superAdminBypass: false,
    },
    work,
  );
}

function summary(view: QuestionExtractionView) {
  const count = (outcome: string) =>
    view.match.questions.filter((m) => m.outcome === outcome).length;
  return {
    extractionId: view.extractionId,
    sourceKind: view.extraction.sourceKind,
    worksheetVersionId: view.match.worksheetVersionId,
    worksheetKnown: view.match.worksheetKnown,
    questions: view.extraction.questions.length,
    matched: count('matched'),
    ambiguous: count('ambiguous'),
    unmatched: count('unmatched'),
    unreadable: view.extraction.questions.filter(
      (q) => q.status === 'unreadable' || q.status === 'unsupported',
    ).length,
    studentWork: view.studentWork.length,
    omissions: view.extraction.omissions.length,
    extractionReviewRequired: true,
  };
}

/**
 * The `extract-questions` handler for ONE authenticated actor (guardian or a
 * delegated agent). The application resolves `request` from its session. Keep
 * every ingestion policy layer `requireReview: true`; there is no automation.
 * Apply requires `preserveQuestionExtractionAnalysis` to have kept the exact
 * proposal first.
 */
export function educationQuestionExtractionHandler(input: {
  extractions: QuestionExtractionService;
  request: CourseAuthoringActor;
}): OperationHandler {
  const { extractions, request } = input;
  const preserved = async (
    args: Record<string, unknown>,
    context: HandlerContext,
  ) => {
    const view = await bound(request, context, () =>
      extractions.withExecutor(context.db).findExtraction({
        ...request,
        intakeItemId: context.itemId,
        proposalDigest: questionExtractionProposalDigest(args),
      }),
    );
    if (!view)
      throw new Error('Question extraction must be preserved before review');
    return view;
  };
  return {
    id: QUESTION_EXTRACTION_HANDLER_ID,
    version: '1',
    label: 'Extract questions',
    description: DESCRIPTION,
    operation: { model: QUESTION, action: 'create', version: '1' },
    capability: { effect: 'write', idempotent: true, openWorld: false },
    argsSchema: QUESTION_EXTRACTION_ARGS_SCHEMA as unknown as Record<
      string,
      unknown
    >,
    resultSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['extractionId'],
      properties: {
        extractionId: { type: 'string', minLength: 1, maxLength: 64 },
      },
    },
    resultModels: {},
    discovery: { mediaTypes: MEDIA_TYPES, references: {} },
    validate: async (args, context) => {
      await preserved(args, context);
      return { ok: true };
    },
    preview: async (args, context) => ({
      display: summary(await preserved(args, context)),
      normalizedArgs: args,
      targetPreconditions: [],
    }),
    execution: {
      kind: 'database',
      apply: async (args, context) => {
        const view = await preserved(args, context);
        await bound(request, context, () =>
          extractions
            .withExecutor(context.db)
            .applyExtraction({ ...request, extractionId: view.extractionId }),
        );
        return { extractionId: view.extractionId };
      },
    },
  };
}

type Snapshot = Awaited<ReturnType<IngestionService['getCompletedAnalysis']>>;

/** Retained original evidence of one completed analysis, as extraction grounding. */
export function questionExtractionGrounding(
  snapshot: Snapshot,
): QuestionExtractionGrounding {
  const results = Array.isArray(snapshot.result.output?.results)
    ? (snapshot.result.output.results as unknown[])
    : [];
  const originals = intakeOriginalEvidence(snapshot.evidence ?? []).filter(
    (e) => e.mediaType !== 'application/json',
  );
  const sources = originals.flatMap((evidence) => {
    const result = results.find(
      (value) =>
        !!value &&
        typeof value === 'object' &&
        (value as { evidence?: { id?: string; contentHash?: string } }).evidence
          ?.id === evidence.id &&
        (value as { evidence?: { contentHash?: string } }).evidence
          ?.contentHash === evidence.contentHash,
    ) as
      | {
          capabilities?: { location?: string }[];
          segments?: {
            location?: { kind?: string; page?: number };
            observedRegions?: unknown;
          }[];
        }
      | undefined;
    if (!result) return [];
    const segments = Array.isArray(result.segments) ? result.segments : [];
    const pageCapable =
      Array.isArray(result.capabilities) &&
      result.capabilities.some((c) => c.location === 'page');
    const pages = pageCapable
      ? [
          ...new Set(
            segments.flatMap((s) =>
              s.location?.kind === 'page' &&
              Number.isSafeInteger(s.location.page) &&
              (s.location.page ?? 0) > 0
                ? [s.location.page as number]
                : [],
            ),
          ),
        ]
          .sort((a, b) => a - b)
          .slice(0, 1000)
      : [];
    const catalogs = evidence.mediaType.startsWith('image/')
      ? segments
          .filter((s) => s.location?.kind === 'source')
          .map((s) => normalizeObservedImageRegions(s.observedRegions))
          .filter((c) => c !== undefined)
      : [];
    return [
      {
        evidenceId: evidence.id,
        sha256: evidence.contentHash,
        mediaType: evidence.mediaType,
        pages,
        ...(catalogs.length === 1 ? { observedRegions: catalogs[0] } : {}),
      },
    ];
  });
  return { version: 1, extractionAttemptId: snapshot.attemptId, sources };
}

/**
 * Preserve the current completed `extract-questions` proposal of one intake
 * item for extraction review: validates it against retained evidence, matches
 * it to known worksheets and records it (idempotent per analysis attempt).
 * Not ready, no proposal or competing proposals throw
 * `QuestionExtractionPendingError`; invalid output throws
 * `QuestionExtractionValidationError`. Writes no question records.
 */
export async function preserveQuestionExtractionAnalysis(input: {
  ingestion: IngestionService;
  extractions: QuestionExtractionService;
  request: CourseAuthoringActor;
  itemId: string;
  expectedWorksheetVersionId?: string;
  worksheets?: readonly WorksheetBundle[];
}): Promise<QuestionExtractionView> {
  let snapshot: Snapshot;
  try {
    snapshot = await input.ingestion.getCompletedAnalysis(input.itemId);
  } catch (error) {
    if (error instanceof Error && error.message === 'Analysis unavailable')
      throw new QuestionExtractionPendingError('pending');
    throw error;
  }
  if (
    snapshot.configuration.stage !== 'interpret' ||
    !['completed', 'partial'].includes(snapshot.result.status)
  )
    throw new QuestionExtractionPendingError('pending');
  const generation = (
    snapshot.result.output as unknown as {
      proposals?: import('@happyvertical/smrt-ingestion').GenerationOutput;
    }
  ).proposals;
  if (generation?.version !== 1 || !Array.isArray(generation.suggestions))
    throw new QuestionExtractionValidationError('Malformed generation output');
  if (generation.outcome === 'ambiguous')
    throw new QuestionExtractionPendingError('ambiguous');
  if (!['proposals', 'needs_review'].includes(generation.outcome))
    throw new QuestionExtractionPendingError('no_proposal');
  const suggestions = generation.suggestions.filter(
    (s) => s.handlerId === QUESTION_EXTRACTION_HANDLER_ID,
  );
  if (!suggestions.length)
    throw new QuestionExtractionPendingError('no_proposal');
  if (suggestions.length > 1)
    throw new QuestionExtractionPendingError('ambiguous');
  const suggestion = suggestions[0];
  if (suggestion.missingFields.length)
    throw new QuestionExtractionValidationError(
      'Incomplete question extraction',
    );
  const generative = generation.provenance.generative;
  return input.extractions.preserveExtraction({
    ...input.request,
    intakeItemId: input.itemId,
    analysisAttemptId: snapshot.attemptId,
    grounding: questionExtractionGrounding(snapshot),
    extractor: {
      provider: generative.provider,
      model: generative.model,
      version: generative.version,
      configurationVersion: generation.provenance.configurationVersion,
      promptVersion: generation.provenance.promptVersion,
    },
    extraction: suggestion.args,
    ...(input.expectedWorksheetVersionId
      ? { expectedWorksheetVersionId: input.expectedWorksheetVersionId }
      : {}),
    ...(input.worksheets ? { worksheets: input.worksheets } : {}),
  });
}
