import {
  field,
  foreignKey,
  SmrtCollection,
  SmrtObject,
  type SmrtSaveOptions,
  smrt,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import {
  type ExtractedQuestionOutcome,
  QUESTION_EXTRACTION_SOURCE_KINDS,
  type QuestionExtractionSourceKind,
} from './question-extraction-contracts.js';

const closed = { api: false, mcp: false, cli: false } as const;
const OUTCOMES: readonly ExtractedQuestionOutcome[] = [
  'created',
  'replayed',
  'matched',
  'needs_review',
  'source_changed',
  'invalid_content',
  'unreadable',
  'unsupported',
  'not_an_exercise',
];

function adopt(target: object, options: Record<string, unknown>) {
  for (const [key, value] of Object.entries(options))
    if (Object.hasOwn(target, key))
      (target as Record<string, unknown>)[key] = value;
}
function requireText(value: unknown, message: string, max = 200) {
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    throw new Error(message);
}
function requireJson(value: string, what: string) {
  try {
    JSON.parse(value);
  } catch {
    throw new Error(`${what} must be JSON`);
  }
}
async function requireInsert(row: SmrtObject & { tenantId: string }) {
  if (!row.tenantId?.trim())
    throw new Error('Question extraction records require a tenant');
  if (row.id && (await row.db.get(row.tableName, { id: row.id })))
    throw new Error('Question extraction history is immutable');
}
async function requireOwned(
  row: SmrtObject & { tenantId: string },
  table: string,
  id: string,
) {
  if (!(await row.db.get(table, { id, tenant_id: row.tenantId })))
    throw new Error('Question extraction parent ownership mismatch');
}
function noDelete(): never {
  throw new Error(
    'Question extraction history is immutable; erasure requires an owning retention operation',
  );
}
function validDate(value: Date) {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime()))
    throw new Error('Invalid question extraction timestamp');
}

/**
 * Append-only preserved question extraction: one row per tenant, intake item
 * and ingestion analysis attempt. Holds the validated extraction (anchors
 * resolved against retained evidence), the evidence-only match and the
 * extractor identity. The originals stay in ingestion; this never copies bytes.
 */
@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'question_extractions',
  conflictColumns: ['tenant_id', 'intake_item_id', 'analysis_attempt_id'],
  indexes: [
    {
      name: 'question_extractions_attempt_unique',
      columns: ['tenantId', 'intakeItemId', 'analysisAttemptId'],
      unique: true,
    },
    {
      name: 'question_extractions_source_identity',
      columns: ['tenantId', 'sourceIdentity'],
    },
  ],
  ...closed,
})
export class QuestionExtractionRecord extends SmrtObject {
  @tenantId() tenantId = '';
  /** Ingestion intake item id (an ingestion-owned identity, not a local FK). */
  intakeItemId = '';
  analysisAttemptId = '';
  sourceIdentity = '';
  sourceKind: QuestionExtractionSourceKind = 'worksheet_scan';
  /** Digest of the reviewed proposal arguments; binds the later human decision. */
  proposalDigest = '';
  /** Digest of every preserve input (grounding, extractor, worksheets): same-key replays must match. */
  inputDigest = '';
  @field({ type: 'text' }) extractorJson = '{}';
  @field({ type: 'text' }) extractionJson = '{}';
  @field({ type: 'text' }) matchJson = '{}';
  recordedByUserId = '';
  recordedAt = new Date();
  constructor(options: Record<string, unknown> = {}) {
    super(options);
    adopt(this, options);
  }
  override async delete(): Promise<void> {
    noDelete();
  }
  override async save(options?: SmrtSaveOptions): Promise<this> {
    await requireInsert(this);
    requireText(this.intakeItemId, 'Extraction requires an intake item');
    requireText(this.analysisAttemptId, 'Extraction requires an attempt');
    requireText(this.sourceIdentity, 'Extraction requires a source identity');
    requireText(this.proposalDigest, 'Extraction requires a proposal digest');
    requireText(this.inputDigest, 'Extraction requires an input digest');
    requireText(this.recordedByUserId, 'Extraction requires an actor');
    if (!QUESTION_EXTRACTION_SOURCE_KINDS.includes(this.sourceKind))
      throw new Error('Invalid extraction source kind');
    requireJson(this.extractorJson, 'Extractor');
    requireJson(this.extractionJson, 'Extraction');
    requireJson(this.matchJson, 'Match');
    validDate(this.recordedAt);
    this.requireInsertOnSave();
    return super.save(options);
  }
}
export class QuestionExtractionRecordCollection extends SmrtCollection<QuestionExtractionRecord> {
  static readonly _itemClass = QuestionExtractionRecord;
}

/**
 * Append-only applied outcome of one extracted question: which question record
 * it created or matched (or why none), with its source anchors and media refs.
 * This is the provenance link from a question record back to page and region.
 */
@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'extracted_question_links',
  conflictColumns: ['tenant_id', 'extraction_id', 'question_key'],
  indexes: [
    {
      name: 'extracted_question_links_key_unique',
      columns: ['tenantId', 'extractionId', 'questionKey'],
      unique: true,
    },
    {
      name: 'extracted_question_links_source',
      columns: ['tenantId', 'sourceIdentity', 'questionKey'],
    },
    {
      name: 'extracted_question_links_question',
      columns: ['tenantId', 'questionId'],
    },
  ],
  ...closed,
})
export class ExtractedQuestionLink extends SmrtObject {
  @tenantId() tenantId = '';
  @foreignKey('QuestionExtractionRecord', { required: true }) extractionId = '';
  questionKey = '';
  sourceIdentity = '';
  outcome: ExtractedQuestionOutcome = 'needs_review';
  @foreignKey('Question', { nullable: true }) questionId: string | null = null;
  @foreignKey('QuestionRevision', { nullable: true }) questionRevisionId:
    | string
    | null = null;
  @field({ type: 'text' }) anchorsJson = '[]';
  @field({ type: 'text' }) mediaJson = '[]';
  appliedByUserId = '';
  recordedAt = new Date();
  constructor(options: Record<string, unknown> = {}) {
    super(options);
    adopt(this, options);
  }
  override async delete(): Promise<void> {
    noDelete();
  }
  override async save(options?: SmrtSaveOptions): Promise<this> {
    await requireInsert(this);
    await requireOwned(this, 'question_extractions', this.extractionId);
    if (this.questionId) await requireOwned(this, 'questions', this.questionId);
    if (this.questionRevisionId)
      await requireOwned(this, 'question_revisions', this.questionRevisionId);
    requireText(this.questionKey, 'Link requires a question key');
    requireText(this.sourceIdentity, 'Link requires a source identity');
    requireText(this.appliedByUserId, 'Link requires an actor');
    if (!OUTCOMES.includes(this.outcome))
      throw new Error('Invalid extraction outcome');
    if (
      ['created', 'replayed', 'matched'].includes(this.outcome) !==
      Boolean(this.questionRevisionId)
    )
      throw new Error('Only linked outcomes carry a question revision');
    requireJson(this.anchorsJson, 'Anchors');
    requireJson(this.mediaJson, 'Media');
    validDate(this.recordedAt);
    this.requireInsertOnSave();
    return super.save(options);
  }
}
export class ExtractedQuestionLinkCollection extends SmrtCollection<ExtractedQuestionLink> {
  static readonly _itemClass = ExtractedQuestionLink;
}
