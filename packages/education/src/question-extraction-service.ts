import type { DatabaseInterface } from '@happyvertical/sql';
import {
  type CourseAuthoringActor,
  type CourseAuthoringAuthorizer,
  CourseRequestKeyConflictError,
} from './course-authoring-contracts.js';
import { groupSharingDigest } from './group-sharing-hash.js';
import {
  QuestionAuthoringService,
  type QuestionAuthoringServiceOptions,
} from './question-authoring-service.js';
import type {
  GuardianWorksheetBundle,
  WorksheetBundle,
} from './question-contracts.js';
import {
  extractedQuestionContent,
  matchExtractedQuestions,
  normalizeQuestionExtraction,
  questionExtractionSourceIdentity,
} from './question-extraction.js';
import {
  type ExtractedQuestionOutcome,
  type ExtractedQuestionResult,
  type QuestionExtraction,
  type QuestionExtractionGrounding,
  type QuestionExtractionMatch,
  QuestionExtractionNotFoundError,
  QuestionExtractionValidationError,
  type QuestionExtractionView,
  type QuestionExtractorIdentity,
} from './question-extraction-contracts.js';
import {
  ExtractedQuestionLinkCollection,
  QuestionExtractionRecordCollection,
} from './question-extraction-models.js';
import { canonical } from './question-render.js';

type Row = Record<string, unknown>;
// biome-ignore lint/suspicious/noControlCharactersInRegex: refuse NUL in identities
const IDENTITY = /^[^\u0000]{1,200}$/;

/** Digest of reviewed proposal arguments; binds a preserved extraction to its decision. */
export function questionExtractionProposalDigest(args: unknown): string {
  return `qxp1-${groupSharingDigest(canonical(args)).slice(0, 40)}`;
}

function isUniqueViolation(error: unknown): boolean {
  const e = error as { code?: unknown; message?: unknown } | null;
  return (
    e?.code === '23505' ||
    /unique|duplicate key|constraint failed/i.test(String(e?.message ?? ''))
  );
}
function extractor(
  value: QuestionExtractorIdentity,
): QuestionExtractorIdentity {
  const out: QuestionExtractorIdentity = {
    provider: '',
    model: '',
    version: '',
  };
  for (const name of [
    'provider',
    'model',
    'version',
    'configurationVersion',
    'promptVersion',
  ] as const) {
    const v = value?.[name];
    if (
      v === undefined &&
      (name === 'configurationVersion' || name === 'promptVersion')
    )
      continue;
    if (typeof v !== 'string' || !IDENTITY.test(v) || !v.trim())
      throw new QuestionExtractionValidationError('Invalid extractor identity');
    out[name] = v;
  }
  return out;
}

export interface PreserveQuestionExtractionRequest
  extends CourseAuthoringActor {
  intakeItemId: string;
  /** The ingestion analysis attempt that produced the proposal (one record per attempt). */
  analysisAttemptId: string;
  grounding: QuestionExtractionGrounding;
  extractor: QuestionExtractorIdentity;
  /** The proposal arguments (closed `QUESTION_EXTRACTION_ARGS_SCHEMA`). */
  extraction: unknown;
  /** Host-known worksheet (for example from the assignment); never overrides a printed id. */
  expectedWorksheetVersionId?: string;
  /** Extra candidate worksheets the host already holds; generated printables are found automatically. */
  worksheets?: readonly WorksheetBundle[];
}

/**
 * Preserve, match, review and apply structured questions extracted from scans
 * and imported course files (SMRT #4517). Reuses the course authorizer:
 * preserve/apply need `education.course.author`; reads need `read-draft`.
 * Question records are written only through `createQuestion`, keyed by source
 * identity, so retries and re-ingestion of the same bytes never multiply them.
 */
export class QuestionExtractionService extends QuestionAuthoringService {
  private readonly courseAuthorizer: CourseAuthoringAuthorizer;
  private readonly serviceOptions: QuestionAuthoringServiceOptions;

  constructor(
    db: DatabaseInterface,
    authorizer: CourseAuthoringAuthorizer,
    options: QuestionAuthoringServiceOptions = {},
  ) {
    super(db, authorizer, options);
    this.courseAuthorizer = authorizer;
    this.serviceOptions = options;
  }

  /** The same service bound to a host-owned transaction executor (ingestion apply). */
  withExecutor(executor: DatabaseInterface): QuestionExtractionService {
    return new QuestionExtractionService(
      executor,
      this.courseAuthorizer,
      this.serviceOptions,
    );
  }

  /**
   * Known worksheets carrying this version id: released lessons whose generated
   * printable was attached with it. Keyed bundles; needs `read-draft`.
   */
  async resolveWorksheet(
    request: CourseAuthoringActor & { worksheetVersionId: string },
  ): Promise<GuardianWorksheetBundle | null> {
    const lessons = await this.run(async (tx) => {
      await this.authorize(
        tx,
        request,
        'education.course.read-draft',
        'read-worksheet',
      );
      if (typeof request.worksheetVersionId !== 'string') return [];
      const printables = (await tx.list('generated_printables', {
        tenant_id: request.tenantId,
        worksheet_version_id: request.worksheetVersionId,
      })) as Row[];
      const out: Array<{ releaseId: string; lessonKey: string }> = [];
      for (const lessonId of new Set(
        printables.map((p) => String(p.lesson_id)),
      ))
        for (const released of (await tx.list('released_lessons', {
          tenant_id: request.tenantId,
          lesson_id: lessonId,
        })) as Row[])
          out.push({
            releaseId: String(released.release_id),
            lessonKey: String(released.lesson_key),
          });
      return out.sort((a, b) =>
        `${a.releaseId}:${a.lessonKey}`.localeCompare(
          `${b.releaseId}:${b.lessonKey}`,
        ),
      );
    });
    for (const lesson of lessons) {
      const view = await this.readReleasedLesson({ ...request, ...lesson });
      if (view.worksheet.worksheetVersionId === request.worksheetVersionId)
        return view.worksheet;
    }
    return null;
  }

  /**
   * Validate extractor output against retained evidence, match it to known
   * worksheet revisions and keep it for extraction review. Idempotent per
   * (tenant, intake item, analysis attempt); a different payload for the same
   * attempt is `CourseRequestKeyConflictError`. Writes no question records.
   */
  async preserveExtraction(
    request: PreserveQuestionExtractionRequest,
  ): Promise<QuestionExtractionView> {
    for (const value of [request.intakeItemId, request.analysisAttemptId])
      if (typeof value !== 'string' || !IDENTITY.test(value) || !value.trim())
        throw new QuestionExtractionValidationError('Invalid intake identity');
    const identity = extractor(request.extractor);
    const extraction = normalizeQuestionExtraction(
      request.extraction,
      request.grounding,
    );
    const proposalDigest = questionExtractionProposalDigest(request.extraction);
    const sourceIdentity = questionExtractionSourceIdentity(
      extraction.sourceKind,
      request.grounding,
    );
    // Same intake attempt, different inputs is a conflict, never a silent replay.
    const inputDigest = questionExtractionProposalDigest({
      proposalDigest,
      sourceIdentity,
      grounding: request.grounding,
      extractor: identity,
      expectedWorksheetVersionId: request.expectedWorksheetVersionId ?? null,
      worksheets: (request.worksheets ?? []).map((w) => [
        w.worksheetVersionId,
        w.items.map((i) => [i.ordinal, i.questionRevisionId]),
      ]),
    });
    const worksheets = [...(request.worksheets ?? [])];
    const id =
      extraction.worksheetVersionId ?? request.expectedWorksheetVersionId;
    if (id && !worksheets.some((w) => w.worksheetVersionId === id)) {
      const known = await this.resolveWorksheet({
        ...request,
        worksheetVersionId: id,
      });
      if (known) worksheets.push(known);
    }
    const match = matchExtractedQuestions(extraction, worksheets, {
      ...(request.expectedWorksheetVersionId
        ? { expectedWorksheetVersionId: request.expectedWorksheetVersionId }
        : {}),
    });
    const write = () =>
      this.run(async (tx) => {
        await this.authorize(
          tx,
          request,
          'education.course.author',
          'preserve-question-extraction',
        );
        const existing = (await tx.get('question_extractions', {
          tenant_id: request.tenantId,
          intake_item_id: request.intakeItemId,
          analysis_attempt_id: request.analysisAttemptId,
        })) as Row | null;
        if (existing) {
          if (
            existing.proposal_digest !== proposalDigest ||
            existing.input_digest !== inputDigest
          )
            throw new CourseRequestKeyConflictError();
          return this.view(tx, existing);
        }
        // A host-supplied worksheet must be this tenant's own revisions.
        for (const m of match.questions)
          if (
            m.questionRevisionId &&
            !(await tx.get('question_revisions', {
              id: m.questionRevisionId,
              tenant_id: request.tenantId,
              question_id: m.questionId,
            }))
          )
            throw new QuestionExtractionValidationError(
              'Matched worksheet is not a question revision of this tenant',
            );
        const row = await (
          await QuestionExtractionRecordCollection.create({ db: tx })
        ).create({
          _insertOnly: true,
          tenantId: request.tenantId,
          intakeItemId: request.intakeItemId,
          analysisAttemptId: request.analysisAttemptId,
          sourceIdentity,
          sourceKind: extraction.sourceKind,
          proposalDigest,
          inputDigest,
          extractorJson: JSON.stringify(identity),
          extractionJson: JSON.stringify(extraction),
          matchJson: JSON.stringify(match),
          recordedByUserId: request.actorUserId,
          recordedAt: new Date(),
        });
        return this.view(
          tx,
          (await tx.get('question_extractions', {
            id: String(row.id),
            tenant_id: request.tenantId,
          })) as Row,
        );
      });
    try {
      return await write();
    } catch (error) {
      // A concurrent first preserve lost the unique-index race: replay once.
      if (!isUniqueViolation(error)) throw error;
      return write();
    }
  }

  /** The preserved extraction with its match and, once applied, its outcomes. */
  async readExtraction(
    request: CourseAuthoringActor & { extractionId: string },
  ): Promise<QuestionExtractionView> {
    return this.run(async (tx) => {
      await this.authorize(
        tx,
        request,
        'education.course.read-draft',
        'read-question-extraction',
      );
      return this.view(tx, await this.record(tx, request));
    });
  }

  /** The preserved extraction for one intake item and reviewed proposal, if any. */
  async findExtraction(
    request: CourseAuthoringActor & {
      intakeItemId: string;
      proposalDigest: string;
    },
  ): Promise<QuestionExtractionView | null> {
    return this.run(async (tx) => {
      await this.authorize(
        tx,
        request,
        'education.course.read-draft',
        'read-question-extraction',
      );
      const rows = (await tx.list('question_extractions', {
        tenant_id: request.tenantId,
        intake_item_id: request.intakeItemId,
        proposal_digest: request.proposalDigest,
      })) as Row[];
      const latest = rows.sort((a, b) =>
        String(b.recorded_at).localeCompare(String(a.recorded_at)),
      )[0];
      return latest ? this.view(tx, latest) : null;
    });
  }

  /**
   * Apply a reviewed extraction in one transaction. Matched questions link to
   * their existing revision; readable unmatched exercises become question
   * records (`extracted`/`inferred` provenance) keyed by source identity and
   * question key; ambiguous, unreadable, unsupported and example items are
   * recorded without a question. A repeated apply replays the stored outcomes.
   */
  async applyExtraction(
    request: CourseAuthoringActor & { extractionId: string },
  ): Promise<ExtractedQuestionResult[]> {
    const apply = () =>
      this.run(async (tx) => {
        await this.authorize(
          tx,
          request,
          'education.course.author',
          'apply-question-extraction',
        );
        const record = await this.record(tx, request);
        const stored = await this.links(
          tx,
          request.tenantId,
          String(record.id),
        );
        if (stored) return stored;
        const extraction = JSON.parse(
          String(record.extraction_json),
        ) as QuestionExtraction;
        const match = JSON.parse(
          String(record.match_json),
        ) as QuestionExtractionMatch;
        const sourceIdentity = String(record.source_identity);
        const questions = new QuestionAuthoringService(
          tx,
          this.courseAuthorizer,
          this.serviceOptions,
        );
        const links = await ExtractedQuestionLinkCollection.create({ db: tx });
        const results: ExtractedQuestionResult[] = [];
        for (const question of extraction.questions) {
          const matched = match.questions.find((m) => m.key === question.key);
          let outcome: ExtractedQuestionOutcome;
          let questionId: string | null = null;
          let questionRevisionId: string | null = null;
          const content = extractedQuestionContent(question);
          if (question.role === 'example') outcome = 'not_an_exercise';
          else if (matched?.outcome === 'matched') {
            outcome = 'matched';
            questionId = matched.questionId;
            questionRevisionId = matched.questionRevisionId;
          } else if (matched?.outcome === 'ambiguous') outcome = 'needs_review';
          else if (question.status === 'unsupported') outcome = 'unsupported';
          else if (!content) outcome = 'unreadable';
          else {
            const prior = (
              (await tx.list('extracted_question_links', {
                tenant_id: request.tenantId,
                source_identity: sourceIdentity,
                question_key: question.key,
              })) as Row[]
            ).find(
              // Only an earlier creation from this source replays; a match does not.
              (row) =>
                row.question_id &&
                (row.outcome === 'created' || row.outcome === 'replayed'),
            );
            try {
              const head = await questions.createQuestion({
                ...request,
                requestKey: `qx:${sourceIdentity}:${question.key}`,
                content,
              });
              outcome = prior ? 'replayed' : 'created';
              questionId = head.questionId;
              questionRevisionId = head.headRevisionId;
            } catch (error) {
              if (error instanceof CourseRequestKeyConflictError) {
                // Same source, different extraction: never overwrite; review it.
                outcome = 'source_changed';
                questionId = prior ? String(prior.question_id) : null;
              } else if (
                error instanceof Error &&
                (error as { code?: string }).code === 'invalid-request'
              )
                outcome = 'invalid_content';
              else throw error;
            }
          }
          await links.create({
            _insertOnly: true,
            tenantId: request.tenantId,
            extractionId: String(record.id),
            questionKey: question.key,
            sourceIdentity,
            outcome,
            questionId,
            questionRevisionId,
            anchorsJson: JSON.stringify(question.anchors),
            mediaJson: JSON.stringify(question.media),
            appliedByUserId: request.actorUserId,
            recordedAt: new Date(),
          });
          results.push({
            key: question.key,
            outcome,
            questionId,
            questionRevisionId,
          });
        }
        return results;
      });
    try {
      return await apply();
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      return apply();
    }
  }

  private async record(
    tx: DatabaseInterface,
    request: CourseAuthoringActor & { extractionId: string },
  ): Promise<Row> {
    const row =
      typeof request.extractionId === 'string' && request.extractionId
        ? ((await tx.get('question_extractions', {
            id: request.extractionId,
            tenant_id: request.tenantId,
          })) as Row | null)
        : null;
    if (!row) throw new QuestionExtractionNotFoundError();
    return row;
  }

  private async links(
    tx: DatabaseInterface,
    tenantId: string,
    extractionId: string,
  ): Promise<ExtractedQuestionResult[] | null> {
    const rows = (await tx.list('extracted_question_links', {
      tenant_id: tenantId,
      extraction_id: extractionId,
    })) as Row[];
    if (!rows.length) return null;
    const byKey = new Map(rows.map((r) => [String(r.question_key), r]));
    const extraction = (await tx.get('question_extractions', {
      id: extractionId,
      tenant_id: tenantId,
    })) as Row;
    const order = (
      JSON.parse(String(extraction.extraction_json)) as QuestionExtraction
    ).questions;
    return order.flatMap((q) => {
      const r = byKey.get(q.key);
      return r
        ? [
            {
              key: q.key,
              outcome: String(r.outcome) as ExtractedQuestionOutcome,
              questionId: r.question_id ? String(r.question_id) : null,
              questionRevisionId: r.question_revision_id
                ? String(r.question_revision_id)
                : null,
            },
          ]
        : [];
    });
  }

  private async view(
    tx: DatabaseInterface,
    row: Row,
  ): Promise<QuestionExtractionView> {
    const extraction = JSON.parse(
      String(row.extraction_json),
    ) as QuestionExtraction;
    const match = JSON.parse(String(row.match_json)) as QuestionExtractionMatch;
    const matchedRevision = (key: string | null) => {
      const m = key ? match.questions.find((q) => q.key === key) : undefined;
      return m?.outcome === 'matched' ? m.questionRevisionId : null;
    };
    return {
      extractionId: String(row.id),
      intakeItemId: String(row.intake_item_id),
      analysisAttemptId: String(row.analysis_attempt_id),
      sourceIdentity: String(row.source_identity),
      extractor: JSON.parse(String(row.extractor_json)),
      extraction,
      match,
      studentWork: extraction.studentWork.map((w) => ({
        ...w,
        questionRevisionId: matchedRevision(w.questionKey),
      })),
      applied: await this.links(tx, String(row.tenant_id), String(row.id)),
    };
  }
}
