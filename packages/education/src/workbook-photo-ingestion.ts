/** Server-only pre-activity intake bridge. Uses public ingestion APIs exclusively. */
import { createHash } from 'node:crypto';
import type { OperationHandler } from '@happyvertical/smrt-ingestion/execution';
import {
  GenerationSnapshotStaleError,
  type IngestionScope,
  type IngestionService,
  ProposalsNotConfiguredError,
  type ReceiveInput,
} from '@happyvertical/smrt-ingestion/server';
import { getCurrentTenant, withTenant } from '@happyvertical/smrt-tenancy';
import { registerPermissionDefinitions } from '@happyvertical/smrt-users';
import { processEducationAnalysis } from './ingestion.js';
import type { LearnerRequest } from './learner-service.js';
import type { SubmissionPage } from './submission-service.js';
import {
  validateWorkbookPhotoIdentification,
  type WorkbookPhotoProposal,
} from './workbook-photo-contracts.js';
import {
  preservePhotoProposal,
  type WorkbookPhotoService,
} from './workbook-photo-service.js';

const MODEL = '@happyvertical/smrt-education:WorkbookPhotoIntake';
export const WORKBOOK_PHOTO_HANDLER =
  '@happyvertical/smrt-education:identify-workbook-photo';
registerPermissionDefinitions([
  {
    slug: 'workbookphotointakes.read',
    collection: 'workbookphotointakes',
    qualifiedName: MODEL,
    name: 'Identify authorized workbook photos',
  },
]);
function assertScope(scope: Readonly<IngestionScope>, request: LearnerRequest) {
  if (
    scope.tenantId !== request.tenantId ||
    scope.actorId !== request.actorUserId ||
    scope.confidentialScopeId !== request.learnerId
  )
    throw new Error('Photo intake scope mismatch');
}
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v).sort(([a], [b]) => a.localeCompare(b)),
        )
      : v,
  );
const string = {
  type: 'string',
  maxLength: 2000,
  pattern: '^[^\\u0000-\\u001F\\u007F]*$',
};
const schema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'identification',
    'confidence',
    'identityEvidence',
    'lessonEvidence',
  ],
  properties: {
    workbookId: {
      type: 'string',
      maxLength: 64,
      description:
        'Exact existing candidate id. Also copy its workbookKey, title and edition into the required identification.workbook object; this selects existing identity, not a new workbook.',
    },
    confidence: { type: 'string', enum: ['confident', 'uncertain'] },
    identityEvidence: {
      type: 'array',
      maxItems: 20,
      items: { ...string, minLength: 1 },
    },
    lessonEvidence: string,
    identification: {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'workState'],
      properties: {
        kind: {
          type: 'string',
          enum: ['lesson', 'cover', 'reference', 'uncertain'],
        },
        workState: { type: 'string', enum: ['blank', 'completed', 'unknown'] },
        notes: string,
        workbook: {
          type: 'object',
          additionalProperties: false,
          required: ['workbookKey', 'title'],
          properties: {
            workbookKey: string,
            title: string,
            edition: string,
            publisher: string,
            isbn: string,
          },
        },
        activity: {
          type: 'object',
          additionalProperties: false,
          required: ['pageKey', 'pageLabel'],
          properties: { pageKey: string, pageLabel: string },
        },
      },
    },
  },
};
/** Generation proposes material identity only; execution never writes educational outcomes. */
export function workbookPhotoIntakeHandlers(input: {
  workbooks: WorkbookPhotoService;
  request: LearnerRequest;
}): OperationHandler[] {
  const bound = async <T>(
    context: Parameters<OperationHandler['validate']>[1],
    work: (service: WorkbookPhotoService) => Promise<T>,
  ): Promise<T> => {
    assertScope(context.scope, input.request);
    if (!context.policy.requireReview)
      throw new Error('Photo intake requires review policy');
    if (!context.principal)
      return input.workbooks.withExecutor(context.db, work);
    const tenant = getCurrentTenant();
    if (
      !tenant ||
      tenant.tenantId !== input.request.tenantId ||
      tenant.userId !== context.principal.context.userId ||
      context.principal.context.tenantId !== input.request.tenantId
    )
      throw new Error('Photo principal tenant mismatch');
    return withTenant(
      {
        ...tenant,
        tenantId: input.request.tenantId,
        userId: input.request.actorUserId,
        superAdminBypass: false,
      },
      () => input.workbooks.withExecutor(context.db, work),
    );
  };
  const authorize = async (
    context: Parameters<OperationHandler['validate']>[1],
  ) =>
    bound(context, async (service) => {
      await service.authorizePhotoIntake(input.request);
      await service.getWorkbookPhotoIntakeByItem({
        ...input.request,
        itemId: context.itemId,
      });
    });
  return [
    {
      id: WORKBOOK_PHOTO_HANDLER,
      version: '1',
      description:
        'Classify current photos as lesson, cover, reference (including contents/answer keys), or uncertain; no marks or learning observations. args has exactly identification, confidence, identityEvidence, lessonEvidence, optional workbookId. identification has kind, workState, optional workbook, activity, notes. workbook has workbookKey, title, optional edition, publisher, isbn; activity has pageKey and pageLabel. Existing book: choose exact candidate id as workbookId AND copy its workbookKey, title and edition into required identification.workbook. This is existing identity, not a new book. A unique current title+edition can match retained publisher context; publisher/ISBN need not reappear. Do not copy candidate context into identityEvidence: quote only current photos. Conflicting identity, duplicate candidates, title-only or page-only matches stay uncertain; never choose the first candidate. For a new book transcribe current visible ISBN or publisher/title/edition; workbookKey is a proposed hint, never merge authority. Lesson activity requires a printed lesson identifier: pageKey=lesson:<identifier>, lessonEvidence quotes it; page number alone is insufficient. Multiple pages may share one lesson. Distinguish blank, completed and unknown work; only completed learner work is an attempt. Cover/reference omit activity and use empty lessonEvidence. identityEvidence items are nonempty single-line exact visible quotes. Plain text only, no control sentinels. Omit absent optional fields, never null/placeholders or extra fields. If identity/classification is ambiguous use uncertain confidence; omit unknown workbook.',
      operation: { model: MODEL, action: 'get', version: '1' },
      capability: { effect: 'read', idempotent: true, openWorld: false },
      argsSchema: schema,
      resultSchema: schema,
      resultModels: {},
      discovery: {
        mediaTypes: [
          'image/jpeg',
          'image/png',
          'image/webp',
          'application/pdf',
        ],
        references: {
          workbookId: {
            kind: 'candidate',
            model: '@happyvertical/smrt-education:Workbook',
          },
        },
        candidates: async (query, context, page) => {
          await authorize(context);
          const books = await bound(context, (service) =>
            service.listWorkbookPhotoWorkbooks(input.request),
          );
          const needle = query.toLowerCase();
          const ordered = [...books].sort(
            (a, b) =>
              Number(b.title.toLowerCase().includes(needle)) -
                Number(a.title.toLowerCase().includes(needle)) ||
              a.id.localeCompare(b.id),
          );
          return {
            items: ordered.slice(0, page.limit).map((book) => ({
              model: '@happyvertical/smrt-education:Workbook',
              id: book.id,
              revision: workbookRevision(book),
              label: JSON.stringify(book),
            })),
            hasMore: ordered.length > page.limit,
          };
        },
      },
      validate: async (args, context) => {
        await authorize(context);
        validateWorkbookPhotoIdentification(
          (args as unknown as WorkbookPhotoProposal).identification,
        );
        return { ok: true };
      },
      preview: async (args, context) => {
        await authorize(context);
        return {
          display: { classification: args.identification, gradeApplied: false },
          normalizedArgs: args,
          targetPreconditions: [],
        };
      },
      execution: {
        kind: 'database',
        apply: async (args, context) => {
          await authorize(context);
          return args;
        },
      },
    },
  ];
}
function workbookRevision(book: unknown) {
  return `workbook:${createHash('sha256').update(canonical(book)).digest('hex')}`;
}
/** Candidate freshness and authorization on ingestion's supplied executor. */
export function workbookPhotoIntakeTargetResolver(input: {
  workbooks: WorkbookPhotoService;
  request: LearnerRequest;
}): import('@happyvertical/smrt-ingestion/execution').IntakeExecutionOptions['assertTarget'] {
  return async ({ db, scope, model, id, revision }) => {
    assertScope(scope, input.request);
    if (model !== '@happyvertical/smrt-education:Workbook')
      throw new Error('Photo target unavailable');
    const books = await withTenant(
      {
        ...getCurrentTenant(),
        tenantId: input.request.tenantId,
        userId: input.request.actorUserId,
        superAdminBypass: false,
      },
      () =>
        input.workbooks.withExecutor(db, (service) =>
          service.listWorkbookPhotoWorkbooks(input.request),
        ),
    );
    const book = books.find((book) => book.id === id);
    if (!book) throw new Error('Photo target unavailable');
    const current = workbookRevision(book);
    if (revision !== undefined && revision !== current)
      throw new Error('Photo target changed');
    return { revision: current };
  };
}
/** Receive before asking for workbook selection; duplicate receipts repair interrupted copying. */
export async function receiveWorkbookPhotoIntake(input: {
  ingestion: IngestionService;
  scope: Readonly<IngestionScope>;
  workbooks: WorkbookPhotoService;
  request: LearnerRequest;
  receive: ReceiveInput;
}) {
  assertScope(input.scope, input.request);
  await input.workbooks.authorizePhotoIntake(input.request);
  const receipt = await input.ingestion.receive(input.receive);
  if (!('itemId' in receipt) || !receipt.itemId)
    return { receipt, intake: null };
  const intake = await retainWorkbookPhotoReceipt({
    ...input,
    itemId: receipt.itemId,
  });
  return { receipt, intake };
}
/** Recovery after a receive succeeded but the private education copy was interrupted. */
export async function retainWorkbookPhotoReceipt(input: {
  ingestion: IngestionService;
  scope: Readonly<IngestionScope>;
  workbooks: WorkbookPhotoService;
  request: LearnerRequest;
  itemId: string;
}) {
  assertScope(input.scope, input.request);
  await input.workbooks.authorizePhotoIntake(input.request);
  const extensions: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
    'application/pdf': 'pdf',
  };
  const originals = (await input.ingestion.getEvidence(input.itemId))
    .filter((e) => e.parentEvidenceId === null)
    .sort((a, b) => a.partId.localeCompare(b.partId));
  if (
    !originals.length ||
    originals.length > 100 ||
    originals.some(
      (e) =>
        !extensions[e.mediaType] ||
        e.byteLength < 1 ||
        e.byteLength > 25 * 1024 * 1024,
    ) ||
    originals.reduce((n, e) => n + e.byteLength, 0) > 100 * 1024 * 1024
  )
    throw new Error('Unsupported or oversized photo intake');
  const pages: SubmissionPage[] = [];
  for (const original of originals) {
    const data = await input.ingestion.readEvidence(input.itemId, original.id);
    if (
      data.length !== original.byteLength ||
      createHash('sha256').update(data).digest('hex') !== original.contentHash
    )
      throw new Error('Photo receipt integrity mismatch');
    pages.push({
      name: `${original.id}.${extensions[original.mediaType]}`,
      mimeType: original.mediaType as SubmissionPage['mimeType'],
      data: Buffer.from(data),
    });
  }
  return input.workbooks.retainWorkbookPhotoIntake({
    ...input.request,
    itemId: input.itemId,
    pages,
  });
}
/** Transfer immutable provider provenance; malformed/ambiguous/failed results stay pending. */
export async function preserveWorkbookPhotoIdentification(input: {
  ingestion: IngestionService;
  scope: Readonly<IngestionScope>;
  workbooks: WorkbookPhotoService;
  request: LearnerRequest & { intakeId: string };
}) {
  assertScope(input.scope, input.request);
  const view = await input.workbooks.getWorkbookPhotoIntake(input.request);
  let snapshot: Awaited<ReturnType<IngestionService['getCompletedAnalysis']>>;
  try {
    snapshot = await input.ingestion.getCompletedAnalysis(view.itemId);
  } catch (error) {
    if (
      error instanceof ProposalsNotConfiguredError ||
      error instanceof GenerationSnapshotStaleError ||
      (error instanceof Error &&
        ['Analysis unavailable', 'Intake unavailable'].includes(error.message))
    )
      return view;
    throw error;
  }
  if (
    snapshot.itemId !== view.itemId ||
    snapshot.configuration.stage !== 'interpret' ||
    !['completed', 'partial'].includes(snapshot.result.status)
  )
    return view;
  const generation = (
    snapshot.result.output as unknown as {
      proposals?: import('@happyvertical/smrt-ingestion').GenerationOutput;
    }
  ).proposals;
  if (
    generation?.version !== 1 ||
    !['proposals', 'needs_review'].includes(generation.outcome)
  )
    return view;
  const suggestions = generation.suggestions.filter(
    (s) => s.handlerId === WORKBOOK_PHOTO_HANDLER,
  );
  const offered = generation.offered.find(
    (o) => o.handler.id === WORKBOOK_PHOTO_HANDLER,
  );
  if (
    suggestions.length !== 1 ||
    suggestions[0].missingFields.length ||
    !offered ||
    canonical(offered.handler.argsSchema) !== canonical(schema)
  )
    return view;
  const proposal = suggestions[0].args as unknown as WorkbookPhotoProposal;
  try {
    validateWorkbookPhotoIdentification(proposal.identification);
    if (
      !['confident', 'uncertain'].includes(proposal.confidence) ||
      !Array.isArray(proposal.identityEvidence) ||
      proposal.identityEvidence.length > 20 ||
      proposal.identityEvidence.some(
        (e) => typeof e !== 'string' || e.length > 2000,
      ) ||
      typeof proposal.lessonEvidence !== 'string' ||
      proposal.lessonEvidence.length > 200
    )
      return view;
  } catch {
    return view;
  }
  return input.workbooks[preservePhotoProposal]({
    ...input.request,
    requestKey: `analysis:${snapshot.attemptId}`,
    proposal,
    allowAutomaticResolution:
      generation.outcome === 'proposals' &&
      generation.suggestions.length === 1 &&
      suggestions[0].alternatives.length === 0 &&
      generation.splits.length === 0,
    sourceHashes: snapshot.evidence
      .filter((e) => e.parentEvidenceId === null)
      .sort((a, b) => a.partId.localeCompare(b.partId))
      .map((e) => e.contentHash),
    provenance: {
      attemptId: snapshot.attemptId,
      revision: snapshot.revision,
      inputDigest: snapshot.inputDigest,
      outputDigest: snapshot.outputDigest,
      evidenceDigest: snapshot.evidenceDigest,
      configuration: snapshot.configuration,
      provider: snapshot.result.provider,
      model: snapshot.result.model,
    },
  });
}
/** Existing durable extraction/interpretation dispatcher, followed by preservation. */
export async function processWorkbookPhotoAnalysis(
  input: Parameters<typeof processEducationAnalysis>[0] & {
    scope: Readonly<IngestionScope>;
    workbooks: WorkbookPhotoService;
    request: LearnerRequest & { intakeId: string };
  },
) {
  assertScope(input.scope, input.request);
  const view = await input.workbooks.getWorkbookPhotoIntake(input.request);
  if (view.itemId !== input.itemId)
    throw new Error('Photo worker receipt mismatch');
  const processing = await processEducationAnalysis(input);
  const intake = await preserveWorkbookPhotoIdentification(input);
  const capture =
    intake.status === 'resolved' &&
    intake.identification?.kind === 'lesson' &&
    intake.identification.workState === 'completed'
      ? await input.workbooks.captureWorkbookPhotoIntake({
          ...input.request,
          requestKey: `photo:${intake.itemId}`,
        })
      : null;
  const current = capture
    ? await input.workbooks.getWorkbookPhotoIntake(input.request)
    : intake;
  return {
    processing,
    intake: current,
    capture,
    assessmentRequired: current.status === 'captured',
  };
}
