import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import { Asset, type AssetRuntimeLike } from '@happyvertical/smrt-assets';
import {
  detectEngine,
  isEmbeddedDatabase,
  isTransientDatabaseError,
  withEmbeddedWriteTransaction,
} from '@happyvertical/smrt-core';
import { SmrtJobCollection } from '@happyvertical/smrt-jobs';
import { withTenant } from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import type {
  AnalysisOutput,
  InlineInterpretation,
  InlineInterpretationInput,
  IntakeEvidenceDTO,
  IntakeFailure,
  IntakeItemDTO,
  IntakeLimits,
  OwnProposalsInput,
  ReceiptResult,
} from './dto.js';
import { generationSnapshotRead, listReadGate } from './execution-internal.js';
import { extractAnalysis } from './extraction.js';
import { extractWithProviders } from './extraction-providers.js';

import { ProposalsNotConfiguredError } from './proposal-errors.js';
import { assertProposalLimits } from './proposal-limits.js';
import { redactedCeiling, UNFINISHED_ACTION_STATES } from './redaction.js';
import './models.js';
import type { IntakeExecutionService } from './execution.js';
import type {
  IntakeExecutionOptions,
  PreviewPlanInput,
  PreviewProposalInput,
  ResolveItemInput,
  ReviewInput,
  StartActionInput,
} from './execution-contracts.js';
import type { FeedbackConfiguration } from './feedback-contracts.js';
import type {
  AdoptRuleInput,
  ObserveFeedbackInput,
  ReadRuleInput,
  RecordFeedbackInput,
  RetrieveFeedbackInput,
  SuggestRuleInput,
} from './feedback-dto.js';
import { isStorableFilename, presentedFilename } from './presented-filename.js';
import {
  type ProposalConfiguration,
  type ProposalReadConfiguration,
  proposalReadConfiguration,
} from './proposal-contracts.js';
import type {
  CompletedAnalysisSnapshot,
  PreviewGeneratedInput,
} from './proposal-dto.js';
import { GenerationSourceStaleError } from './proposal-errors.js';
import type {
  InboxState,
  LogicalSplitInput,
  ReviewerInstruction,
  ReviewerInstructionInput,
} from './review-dto.js';
import {
  REVIEWER_INSTRUCTION_MAX_LENGTH,
  ReviewerInstructionInvalidError,
  ReviewerInstructionStaleError,
  reviewerInstructionView,
} from './reviewer-instruction.js';

/** Authenticated host context. Never construct this from transport JSON. */
export interface IngestionScope {
  tenantId: string;
  actorId: string;
  confidentialScopeId: string;
}
/** A source part is already authenticated by the host/source adapter. */
export interface IntakePart {
  partId: string;
  parentPartId?: string;
  mediaType: string;
  bytes: Uint8Array;
  expectedHash?: string;
  sourceReference?: { owner: string; id: string; version: string };
  /** Original name as the source presented it; presentation only, never identity. */
  filename?: string;
}
/** A snapshot received by reference: the lifecycle owner keeps the bytes; no
 * blob copy is preserved. Only the text/structured snapshot a stage needs is
 * retained, redacted by the ordinary deletion path. The reference is identity,
 * never authority. */
export interface IntakeReferencePart {
  partId: string;
  parentPartId?: string;
  /** Host-typed owner record the snapshot was read from (for example `message`). */
  reference: { owner: string; id: string; version?: string };
  snapshot: { text: string } | { structured: Record<string, unknown> };
}
/** Lifecycle owner for owner-bound retention; `kind` is host-typed. */
export interface IntakeOwner {
  kind: string;
  id: string;
}
/** Host-resolved retention. Deadlines are always required: in `owner` mode they
 * are the hard privacy ceiling while `expireOwned` follows the owner's lifecycle. */
export type IntakeRetention =
  | {
      kind?: 'time';
      version: string;
      expiresAt: Date;
      replayUntil: Date;
      acceptAfter: Date;
    }
  | {
      kind: 'owner';
      owner: IntakeOwner;
      version: string;
      expiresAt: Date;
      replayUntil: Date;
      acceptAfter: Date;
    };
/** Host-resolved delivery and retention policy, never untrusted content labels. */
export interface ReceiveInput {
  sourceId: string;
  sourceVersion: string;
  deliveryKey: string;
  deliveredAt: Date;
  parts: Array<IntakePart | IntakeReferencePart>;
  capturedCeiling: Record<string, unknown>;
  retention: IntakeRetention;
  limits: IntakeLimits;
  traceId?: string;
  /** `inline` records no queued work for any revision; the host runs
   * `interpretInline` in-process. Requires text/structured parts only. */
  dispatch?: 'job' | 'inline';
}
/** One inbox page request. Filters apply in the query, before the page is cut. */
export interface ListItemsInput {
  /** Rows per page; defaults to 20 and never exceeds 100. */
  limit?: number;
  /** Opaque continuation returned by the previous page. */
  cursor?: string;
  /** Durable inbox-state projection; see REVIEW.md for how it is derived. */
  state?: InboxState;
  /** Restrict the page to these item IDs (host-side assignment pushdown). */
  itemIds?: string[];
  /**
   * Rows this call may examine, at most ITEM_SCAN_CEILING (the default). A
   * host that scans across several calls passes its remaining budget so the
   * sum never exceeds the ceiling.
   */
  scanLimit?: number;
}
/** Inbox items newest-first by receipt, with their durable state projection. */
export interface IntakeItemPage {
  /** `cursor` continues after that row, so a host may cut a page short of it. */
  items: Array<{ item: IntakeItemDTO; state: InboxState; cursor: string }>;
  /** Rows this call examined, including denied and skipped ones; hosts cap on it. */
  scanned: number;
  nextCursor?: string;
}
/** Durable attempt claim. Its fence and token are verified on every completion. */
export interface AnalysisLease {
  itemId: string;
  analysisId: string;
  attemptId: string;
  revision: number;
  fence: number;
  token: string;
}
/** A server-owned dispatch route, retained independently of source metadata. */
export interface IntakeDispatchTarget {
  version: 1;
  objectType: string;
  method: string;
}
export interface DispatchRouteInspection {
  status: 'bound' | 'unknown' | 'conflict';
  fingerprint: string;
  target: IntakeDispatchTarget | null;
}
/** Trusted integration points; no provider or application-policy implementation. */
export interface IngestionOptions {
  /** Optional server-owned interpretation configuration; independent of execution. */
  proposals?: ProposalConfiguration;
  /** Credential-free persisted proposal reads and previews; cannot generate. */
  proposalRead?: ProposalReadConfiguration;
  /** Explicit scoped learning; never inferred from analysis or execution success. */
  feedback?: FeedbackConfiguration;
  /** Optional application-owned review/execution catalog and live authority. */
  execution?: IntakeExecutionOptions;
  db: DatabaseInterface;
  assets: AssetRuntimeLike;
  scope: IngestionScope;
  /**
   * Optional server secret (at least 32 bytes) that seals inbox page cursors.
   * With it, a page that spends its scan limit on unreadable rows can hand
   * back an opaque position past them; without it, a cursor only ever names
   * the last row the actor can read. Never derive it from request data.
   */
  cursorKey?: string | Uint8Array;
  /** Recheck current access for EVERY boundary, including worker completion. */
  authorize(input: {
    scope: IngestionScope;
    operation: 'receive' | 'read' | 'process' | 'delete';
    capturedCeiling: Record<string, unknown>;
    db: DatabaseInterface;
  }): Promise<boolean>;
  /** Registered job handler supplied by the host; dispatch arguments contain IDs only. */
  jobTarget: { objectType: string; method: string };
  /** Explicit operator authority for provenance-free legacy receipts; closed when omitted.
   * Does not replace the normal current/captured process authorization.
   */
  dispatchRecovery?: {
    authorize(input: {
      scope: IngestionScope;
      itemId: string;
      capturedCeiling: Record<string, unknown>;
      evidenceRef: string;
      db: DatabaseInterface;
    }): Promise<boolean>;
  };
  /** Purge host-owned embeddings/previews/caches; retries must be idempotent. */
  purgeDerived(input: { tenantId: string; itemId: string }): Promise<void>;
  now?: () => Date;
  /** Fault injection/observability; never changes authority or persistence. */
  checkpoint?: (boundary: string) => Promise<void>;
}

type Row = Record<string, unknown>;
const TABLES = [
  'intake_items',
  'intake_evidence',
  'intake_analyses',
  'intake_analysis_attempts',
  'intake_plans',
  'intake_actions',
  'intake_proposals',
  'intake_review_decisions',
  'intake_executions',
  'intake_feedback',
  'intake_dispositions',
  'intake_dispatches',
  'intake_deletions',
] as const;
const failures = new Set([
  'unsupported_type',
  'malformed_output',
  'limit',
  'timeout',
  'unavailable',
  'authentication',
  'cancelled',
  'integrity',
]);
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function object(value: unknown): Record<string, unknown> {
  const parsed: unknown = typeof value === 'string' ? JSON.parse(value) : value;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('Invalid intake payload');
  return parsed as Record<string, unknown>;
}
function canonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value))
    return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (
    value &&
    typeof value === 'object' &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Row)[k])}`)
      .join(',')}}`;
  }
  throw new Error('Invalid canonical intake value');
}
function digest(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}
function bytesHash(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}
function nonempty(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > 512)
    throw new Error('Invalid intake identifier');
}
/** A source-supplied display name: bounded text with no unsafe characters. */
function filename(value: unknown): asserts value is string {
  // Same character set the source adapters strip (presented-filename.ts).
  if (!isStorableFilename(value)) throw new Error('Invalid intake filename');
}
function integer(value: unknown, max = 2_147_483_647): asserts value is number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > max
  )
    throw new Error('Invalid intake limit');
}
const ITEM_PAGE_DEFAULT = 20;
/** The most rows one inbox page returns. */
export const ITEM_PAGE_CEILING = 100;
/**
 * The most rows one `listItemsPage` call examines, whatever its filters.
 * When it is reached the page is returned short with a `nextCursor`, or the
 * call fails with `IntakeScanLimitError` when it found no readable row and may not
 * disclose a position; no single call scans an unbounded scope.
 */
export const ITEM_SCAN_CEILING = 10 * ITEM_PAGE_CEILING;
/** The most ids one page may be restricted to before the host must fall back to scanning. */
export const ITEM_ID_FILTER_CEILING = 1000;
/** True for a value shaped like an intake item id; hosts use it to drop junk before a page query. */
export function isIntakeId(value: unknown): value is string {
  return typeof value === 'string' && uuid.test(value);
}
const INBOX_STATES: readonly InboxState[] = [
  'resolved',
  'processing',
  'unresolved',
  'waiting',
  'failed',
  'deferred',
  'partially_completed',
  'completed',
];
/** Correlated action counters; each uses intake_actions_item_idx for one scanned row. */
function actionCount(where = ''): string {
  return `(SELECT COUNT(*) FROM intake_actions a WHERE a.tenant_id = i.tenant_id AND a.confidential_scope_id = i.confidential_scope_id AND a.item_id = i.id${where ? ` AND ${where}` : ''})`;
}
/**
 * Durable inbox-state projection of the saved action journal plus processing
 * state. It mirrors the host's page-traversal classifier without live handler
 * or target gates, so it filters and labels a list; `load` stays authoritative.
 */
const dispositionWhere =
  'd.tenant_id=i.tenant_id AND d.confidential_scope_id=i.confidential_scope_id AND d.item_id=i.id';
const INBOX_STATE_SQL = `CASE WHEN EXISTS (SELECT 1 FROM intake_dispositions d WHERE ${dispositionWhere}) AND ${actionCount("a.state = 'succeeded'")} = 0 THEN 'resolved' WHEN i.processing_state IN ('queued','running') THEN 'processing' WHEN ${actionCount()} = 0 THEN CASE WHEN i.processing_state = 'needs_attention' THEN 'failed' ELSE 'unresolved' END WHEN ${actionCount("a.state <> 'succeeded'")} = 0 THEN 'completed' WHEN ${actionCount("a.state = 'succeeded'")} > 0 THEN 'partially_completed' WHEN ${actionCount("a.state = 'deferred'")} > 0 THEN 'deferred' WHEN ${actionCount("a.state IN ('failed','outcome_unknown')")} > 0 THEN 'failed' ELSE 'waiting' END`;
/** The only receipt-time text the service writes, and the only cursor form. */
const RECEIPT_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
/**
 * The canonical receipt time of a scanned row, or undefined when the stored
 * value is not one the service writes: on SQLite the raw text must already be
 * the millisecond ISO form (no offset, no space separator, exactly three
 * fractional digits); on PostgreSQL the stored value must have no
 * sub-millisecond part, which the page query reports as `receipt_ms`.
 */
function receiptTime(row: Row): string | undefined {
  const value = row.created_at;
  if (typeof value === 'string')
    return RECEIPT_TIME.test(value) &&
      Number.isFinite(Date.parse(value)) &&
      new Date(value).toISOString() === value
      ? value
      : undefined;
  if (
    value instanceof Date &&
    Number.isFinite(value.getTime()) &&
    (row.receipt_ms === true || Number(row.receipt_ms) === 1)
  )
    return value.toISOString();
  return undefined;
}
/**
 * A page call spent its scan limit without finding a row the actor can read,
 * or would otherwise hand back its own input cursor. Without a `cursorKey`
 * the service may not return a position derived from rows the actor cannot
 * read, so the call fails closed instead; the message names no row. Hosts
 * that already collected rows return them with their cursor.
 */
export class IntakeScanLimitError extends Error {
  constructor() {
    super('Intake scan limit');
    this.name = 'IntakeScanLimitError';
  }
}
/** A scan position: the stored receipt key and the item id. */
interface ItemPosition {
  key: string;
  id: string;
}
/**
 * Sealed cursor plaintext size; every sealed cursor has the same length. The
 * page query admits only receipt values and ids of at most 64 characters
 * (SQLite counts code points). The JSON-encoded UTF-8 position is largest
 * when every character is a control character escaped as `\u00XX` (6 bytes):
 * 2 × 64 × 6 bytes plus 7 bytes of array syntax, which 1024 bytes holds; a
 * 4-byte UTF-8 character such as an emoji costs less.
 */
const SEALED_CURSOR_BYTES = 1024;
/** The longest stored receipt value or id the page query admits on SQLite. */
const SCAN_KEY_CHARS = 64;
function samePosition(a: ItemPosition, b: ItemPosition): boolean {
  return a.key === b.key && a.id === b.id;
}
/** Opaque (received-at, id) continuation; never a bare id, which is not ordered. */
function encodeItemCursor(receivedAt: string, id: string): string {
  return Buffer.from(JSON.stringify([receivedAt, id])).toString('base64url');
}
function decodeItemCursor(cursor: string): { receivedAt: string; id: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new Error('Invalid item page');
  }
  // The receipt time must be the normalised ISO form the service stores, so
  // the bound compares like the stored text on SQLite as well as PostgreSQL.
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 2 ||
    typeof parsed[0] !== 'string' ||
    !Number.isFinite(Date.parse(parsed[0])) ||
    new Date(parsed[0]).toISOString() !== parsed[0] ||
    typeof parsed[1] !== 'string' ||
    !uuid.test(parsed[1])
  )
    throw new Error('Invalid item page');
  return { receivedAt: parsed[0], id: parsed[1] };
}
function persistedDate(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value));
}
const inlineMedia = new Set(['text/plain', 'application/json']);
/** Fixed marker for digests overwritten by privacy redaction. */
const REDACTED = 'redacted';
/** Content- or identity-derived digests; successful result digests are kept as
 * the documented replay tombstone. */
const REDACTED_DIGESTS = [
  ['intake_analyses', 'input_digest'],
  ['intake_analysis_attempts', 'output_digest'],
  ['intake_plans', 'digest'],
  ['intake_proposals', 'binding_hash'],
  ['intake_review_decisions', 'binding_hash'],
  ['intake_executions', 'binding_hash'],
] as const;

function mediaKind(mediaType: string): string {
  return mediaType.split(';')[0].trim().toLowerCase();
}
function ownerKey(owner: IntakeOwner): string {
  nonempty(owner.kind);
  nonempty(owner.id);
  // Distinct owners must never collapse onto one stored key (PostgreSQL would
  // replace unpaired surrogates and reject NUL), so both parts must be storable.
  if (
    owner.kind.includes(':') ||
    !storableText(owner.kind) ||
    !storableText(owner.id)
  )
    throw new Error('Invalid intake owner');
  return `${owner.kind}:${owner.id}`;
}
/** PostgreSQL JSON cannot hold NUL or unpaired surrogates; SQLite can. Reject
 * them at validation so both engines answer `invalid` rather than diverge. */
function storableText(value: string): boolean {
  if (value.includes('\u0000')) return false;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      i++;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}
type ReceivedPart = IntakePart & {
  hash: string;
  retain: 'copy' | 'reference';
  snapshot?: string;
};
/** Normalize a copied or referenced part; referenced snapshots become bytes once. */
function receivedPart(part: IntakePart | IntakeReferencePart): ReceivedPart {
  nonempty(part.partId);
  if (!('reference' in part)) {
    nonempty(part.mediaType);
    if (!(part.bytes instanceof Uint8Array)) throw new Error('Invalid part');
    const bytes = Buffer.from(part.bytes);
    const hash = bytesHash(bytes);
    if (part.expectedHash && part.expectedHash !== hash)
      throw new Error('Invalid hash');
    // #4243: a copied part's presented filename is validated, never identity.
    if (part.filename !== undefined) filename(part.filename);
    return { ...part, bytes, hash, retain: 'copy' };
  }
  const reference = object(part.reference);
  nonempty(reference.owner);
  nonempty(reference.id);
  if (reference.version !== undefined) nonempty(reference.version);
  for (const value of [reference.owner, reference.id, reference.version])
    if (typeof value === 'string' && !storableText(value))
      throw new Error('Invalid reference');
  const snapshot = object(part.snapshot);
  let mediaType: string;
  let value: string;
  if ('text' in snapshot && !('structured' in snapshot)) {
    if (typeof snapshot.text !== 'string' || !storableText(snapshot.text))
      throw new Error('Invalid snapshot');
    mediaType = 'text/plain';
    value = snapshot.text;
  } else if ('structured' in snapshot && !('text' in snapshot)) {
    mediaType = 'application/json';
    value = canonical(object(snapshot.structured));
  } else throw new Error('Invalid snapshot');
  const bytes = Buffer.from(value, 'utf8');
  return {
    partId: part.partId,
    ...(part.parentPartId === undefined
      ? {}
      : { parentPartId: part.parentPartId }),
    mediaType,
    bytes,
    hash: bytesHash(bytes),
    sourceReference: {
      owner: reference.owner,
      id: reference.id,
      version: reference.version ?? '',
    },
    retain: 'reference',
    snapshot: value,
  };
}
function date(value: Date): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime()))
    throw new Error('Invalid intake date');
  return value.toISOString();
}

/** Server-only durable lifecycle. Domain approval/execution remains a later layer. */
export class IngestionService {
  private readonly db: DatabaseInterface;
  private readonly scope: IngestionScope;
  private readonly engine: 'sqlite' | 'postgres';
  private readonly cursorKey?: Buffer;
  private readonly dispatchTarget: IntakeDispatchTarget;
  constructor(private readonly options: IngestionOptions) {
    if (options.proposals) assertProposalLimits(options.proposals.limits);
    if (options.proposalRead) {
      assertProposalLimits(options.proposalRead.limits);
      if (
        options.proposals &&
        JSON.stringify(proposalReadConfiguration(options.proposals)) !==
          JSON.stringify(proposalReadConfiguration(options.proposalRead))
      )
        throw new Error('Proposal read configuration mismatch');
    }
    this.db = options.db;
    this.scope = Object.freeze({ ...options.scope });
    if (options.cursorKey !== undefined) {
      const secret =
        typeof options.cursorKey === 'string'
          ? Buffer.from(options.cursorKey, 'utf8')
          : Buffer.from(options.cursorKey);
      if (secret.length < 32)
        throw new Error('Cursor key must be at least 32 bytes');
      this.cursorKey = createHash('sha256')
        .update('smrt-ingestion:list-cursor:v1')
        .update(secret)
        .digest();
    }
    if (!uuid.test(this.scope.tenantId))
      throw new Error('Required tenant UUID');
    nonempty(this.scope.actorId);
    nonempty(this.scope.confidentialScopeId);
    const configured = this.db as DatabaseInterface & {
      type?: string;
      config?: { type?: string; url?: string };
    };
    const engine = detectEngine(
      this.db.url || configured.config?.url || '',
      configured.type || configured.config?.type,
    );
    if (!['sqlite', 'postgres'].includes(engine) || !this.db.transaction)
      throw new Error('Ingestion requires transactional SQLite or PostgreSQL');
    this.engine = engine as 'sqlite' | 'postgres';
    nonempty(options.jobTarget.objectType);
    nonempty(options.jobTarget.method);
    this.dispatchTarget = Object.freeze({
      version: 1,
      objectType: options.jobTarget.objectType,
      method: options.jobTarget.method,
    });
  }
  private async execution() {
    if (!this.options.execution)
      throw new Error('Intake execution is not configured');
    const { IntakeExecutionService } = await import('./execution.js');
    return new IntakeExecutionService(this.options, this.options.execution);
  }
  async previewProposal(input: PreviewProposalInput) {
    return (await this.execution()).previewProposal(input);
  }
  async submitDecision(input: ReviewInput) {
    return (await this.execution()).submitDecision(input);
  }
  async applyAction(actionId: string) {
    return (await this.execution()).applyAction(actionId);
  }
  async reconcileAction(actionId: string) {
    return (await this.execution()).reconcileAction(actionId);
  }
  async listReviews(
    itemId: string,
    input: { cursor?: string; limit?: number } = {},
  ) {
    return (await this.execution()).listReviews(itemId, input);
  }
  async getAction(actionId: string) {
    return (await this.execution()).getAction(actionId);
  }
  /** Own-submission review surface; see execution for its authority gate. */
  async listOwnProposals(input: OwnProposalsInput = {}) {
    return (await this.execution()).listOwnProposals(input);
  }
  async submitOwnDecision(input: ReviewInput) {
    return (await this.execution()).submitOwnDecision(input);
  }
  async authorizeAutomatic(actionId: string) {
    return (await this.execution()).authorizeAutomatic(actionId);
  }
  /** Reviewer-chosen handler for any item; same preview/approval path, never automatic. */
  async startReviewerAction(input: StartActionInput) {
    return (await this.execution()).startAction(input);
  }
  /** Terminal "handled, no action" disposition; distinct from rejecting a proposal. */
  async resolveItem(input: ResolveItemInput) {
    return (await this.execution()).resolveItem(input);
  }
  /** Reviewer and reason of a resolved item; requires reviewer authority. */
  async getItemDisposition(itemId: string) {
    return (await this.execution()).getItemDisposition(itemId);
  }
  async previewPlan(input: PreviewPlanInput) {
    return (await this.execution()).previewPlan(input);
  }
  async applyPlan(planId: string) {
    return (await this.execution()).applyPlan(planId);
  }
  private async proposals() {
    if (!this.options.proposals) throw new ProposalsNotConfiguredError();
    const { IngestionProposalService } = await import('./proposals.js');
    return new IngestionProposalService(
      this,
      this.options,
      this.options.proposals,
    );
  }
  private async proposalReader() {
    const config = this.options.proposals ?? this.options.proposalRead;
    if (!config) throw new ProposalsNotConfiguredError();
    const { IngestionProposalService } = await import('./proposals.js');
    return new IngestionProposalService(this, this.options, config);
  }
  /** Currently offered reviewer catalog; needs no generation credentials. */
  async listHandlers(itemId: string) {
    return (await this.proposalReader()).listHandlers(itemId);
  }
  async findCandidates(input: {
    itemId: string;
    handlerId: string;
    handlerVersion: string;
    query: string;
    limit?: number;
  }) {
    return (await this.proposals()).findCandidates(input);
  }
  async prepareGeneration(itemId: string, attemptId: string) {
    return (await this.proposals()).prepareGeneration(itemId, attemptId);
  }
  async generateProposals(lease: AnalysisLease) {
    return (await this.proposals()).generate(lease);
  }
  async previewGeneratedProposals(input: PreviewGeneratedInput) {
    return (await this.proposalReader()).preview(input);
  }
  private async feedback() {
    const { IntakeFeedbackService } = await import('./feedback.js');
    return new IntakeFeedbackService(this.options);
  }
  async recordFeedback(input: RecordFeedbackInput) {
    return (await this.feedback()).record(input);
  }
  async observeFeedback(input: ObserveFeedbackInput) {
    return (await this.feedback()).observe(input);
  }
  async retrieveFeedback(input: RetrieveFeedbackInput) {
    return (await this.proposals()).retrieveFeedback(input);
  }
  async suggestRoutingRule(input: SuggestRuleInput) {
    return (await this.feedback()).suggest(input);
  }
  async getRoutingRule(input: ReadRuleInput) {
    return (await this.feedback()).readRule(input);
  }
  async adoptRoutingRule(input: AdoptRuleInput) {
    return (await this.feedback()).adopt(input);
  }
  private now(): Date {
    return this.options.now?.() ?? new Date();
  }
  private async point(name: string): Promise<void> {
    await this.options.checkpoint?.(name);
  }
  private async authorize(
    operation: 'receive' | 'read' | 'process' | 'delete',
    data: Row,
    db = this.db,
  ): Promise<void> {
    if (
      !(await this.options.authorize({
        scope: this.scope,
        operation,
        capturedCeiling: object(data.capturedCeiling ?? {}),
        db,
      }))
    )
      throw new Error('Intake unavailable');
  }
  private async rows(
    db: DatabaseInterface,
    table: (typeof TABLES)[number],
    where = '',
    params: unknown[] = [],
  ): Promise<Row[]> {
    return (
      await db.query(
        `SELECT * FROM ${table} WHERE tenant_id = ? AND confidential_scope_id = ?${where ? ` AND ${where}` : ''}`,
        this.scope.tenantId,
        this.scope.confidentialScopeId,
        ...params,
      )
    ).rows as Row[];
  }
  private async item(
    id: string,
    operation: 'read' | 'process' | 'delete',
    db = this.db,
    allowExpired = false,
  ): Promise<Row> {
    const [item] = await this.rows(db, 'intake_items', 'id = ?', [id]);
    if (!item) throw new Error('Intake unavailable');
    await this.authorize(operation, object(item.data), db);
    if (
      !allowExpired &&
      (item.visibility !== 'active' ||
        persistedDate(item.expires_at).getTime() <= this.now().getTime())
    )
      throw new Error('Intake unavailable');
    return item;
  }
  private async tx<T>(work: (db: DatabaseInterface) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await withEmbeddedWriteTransaction(
          this.db,
          isEmbeddedDatabase(this.db),
          work,
        );
      } catch (error) {
        if (attempt >= 3 || !isTransientDatabaseError(error)) throw error;
        await new Promise((resolve) => setTimeout(resolve, 10 * 2 ** attempt));
      }
    }
  }
  /** Refuse under the caller's item lock when a terminal disposition exists. */
  private async assertUnresolved(
    db: DatabaseInterface,
    itemId: string,
  ): Promise<void> {
    if (
      (await this.rows(db, 'intake_dispositions', 'item_id=?', [itemId])).length
    )
      throw new Error('Item resolved');
  }
  private async lock(db: DatabaseInterface, itemId: string): Promise<void> {
    const result = await db.query(
      'UPDATE intake_items SET analysis_revision = analysis_revision WHERE tenant_id = ? AND confidential_scope_id = ? AND id = ? RETURNING id',
      this.scope.tenantId,
      this.scope.confidentialScopeId,
      itemId,
    );
    if (!result.rows.length) throw new Error('Intake unavailable');
  }
  private async insert(
    db: DatabaseInterface,
    table: (typeof TABLES)[number],
    values: Row,
    conflict?: string,
  ): Promise<Row[]> {
    const now = this.now().toISOString();
    const row = {
      id: randomUUID(),
      slug: randomUUID(),
      context: '',
      created_at: now,
      updated_at: now,
      tenant_id: this.scope.tenantId,
      confidential_scope_id: this.scope.confidentialScopeId,
      ...values,
    };
    const keys = Object.keys(row);
    return (
      await db.query(
        `INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})${conflict ? ` ON CONFLICT (${conflict}) DO NOTHING` : ''} RETURNING *`,
        ...Object.values(row),
      )
    ).rows as Row[];
  }
  /** Diagnostic only: deploy manifest migrations before starting ingestion. */
  async assertReady(): Promise<void> {
    for (const table of TABLES)
      await this.db.query(`SELECT id FROM ${table} WHERE 1 = 0`);
  }
  /** Preserve every original before acknowledgment; retries retain receipt identity. */
  async receive(input: ReceiveInput): Promise<ReceiptResult> {
    await this.authorize('receive', { capturedCeiling: input.capturedCeiling });
    const now = this.now();
    let parts: ReceivedPart[];
    let owner: IntakeOwner | null = null;
    const inline = input.dispatch === 'inline';
    try {
      for (const value of [
        input.sourceId,
        input.sourceVersion,
        input.deliveryKey,
        input.retention.version,
      ])
        nonempty(value);
      if (
        input.dispatch !== undefined &&
        !['job', 'inline'].includes(input.dispatch)
      )
        throw new Error('Invalid dispatch mode');
      const retention = input.retention;
      if (
        retention.kind !== undefined &&
        !['time', 'owner'].includes(retention.kind)
      )
        throw new Error('Invalid retention mode');
      if (retention.kind === 'owner') {
        ownerKey(retention.owner);
        owner = { kind: retention.owner.kind, id: retention.owner.id };
      }
      for (const value of Object.values(input.limits)) integer(value);
      date(input.deliveredAt);
      date(input.retention.expiresAt);
      date(input.retention.replayUntil);
      date(input.retention.acceptAfter);
      if (
        input.deliveredAt < input.retention.acceptAfter ||
        input.retention.expiresAt <= now ||
        input.retention.replayUntil < input.retention.expiresAt
      )
        return { kind: 'rejected', category: 'expired' };
      if (!input.parts.length || input.parts.length > input.limits.maxParts)
        return { kind: 'rejected', category: 'limit' };
      const ids = new Set<string>();
      let total = 0;
      parts = input.parts.map((part) => {
        const received = receivedPart(part);
        if (ids.has(received.partId)) throw new Error('Invalid part');
        ids.add(received.partId);
        total += received.bytes.byteLength;
        return received;
      });
      if (total > input.limits.maxBytes)
        return { kind: 'rejected', category: 'limit' };
      // Inline receipts never queue work, so every part must be stage-ready text.
      if (inline && parts.some((p) => !inlineMedia.has(mediaKind(p.mediaType))))
        throw new Error('Inline receipt requires text or structured parts');
      for (const part of parts)
        if (
          part.parentPartId &&
          (!ids.has(part.parentPartId) || part.parentPartId === part.partId)
        )
          throw new Error('Invalid parent');
      for (const part of parts) {
        const seen = new Set([part.partId]);
        let parent = part.parentPartId;
        while (parent) {
          if (seen.has(parent)) throw new Error('Cyclic evidence');
          seen.add(parent);
          parent = parts.find((p) => p.partId === parent)?.parentPartId;
        }
      }
    } catch {
      return { kind: 'rejected', category: 'invalid' };
    }
    // Existing copied receipts keep their exact identity; new modes extend it.
    const identity = parts
      .map((p) => ({
        partId: p.partId,
        parentPartId: p.parentPartId ?? null,
        mediaType: p.mediaType,
        hash: p.hash,
        length: p.bytes.byteLength,
        sourceReference: p.sourceReference ?? null,
        ...(p.retain === 'reference' ? { retain: 'reference' } : {}),
      }))
      .sort((a, b) => a.partId.localeCompare(b.partId));
    const payloadDigest = digest(identity);
    const scopeDigest = digest({
      scope: this.scope,
      ceiling: input.capturedCeiling,
      sourceVersion: input.sourceVersion,
      ...(inline ? { dispatch: 'inline' } : {}),
      ...(owner ? { owner } : {}),
    });
    const reservation = await this.tx(async (db) => {
      await this.authorize(
        'receive',
        { capturedCeiling: input.capturedCeiling },
        db,
      );
      const inserted = await this.insert(
        db,
        'intake_items',
        {
          source_id: input.sourceId,
          source_version: input.sourceVersion,
          delivery_key: input.deliveryKey,
          payload_digest: payloadDigest,
          scope_digest: scopeDigest,
          receipt_state: 'reserved',
          processing_state: 'queued',
          visibility: 'active',
          receipt_version: 1,
          analysis_revision: 0,
          fence: 0,
          lease_token: '',
          lease_until: null,
          expires_at: date(input.retention.expiresAt),
          replay_until: date(input.retention.replayUntil),
          cancelled: false,
          trace_id: input.traceId ?? randomUUID(),
          // The submitter is the authenticated actor of this service, recorded
          // server-side; payload or source metadata never supplies it.
          submitter_id: this.scope.actorId,
          owner_key: owner ? ownerKey(owner) : '',
          data: canonical({
            capturedCeiling: input.capturedCeiling,
            limits: input.limits,
            retentionVersion: input.retention.version,
            deliveredAt: date(input.deliveredAt),
            dispatchTarget: this.dispatchTarget,
            ...(inline ? { dispatch: 'inline' } : {}),
            ...(owner ? { retentionOwner: owner } : {}),
          }),
        },
        'tenant_id,source_id,delivery_key',
      );
      const matches = await db.query(
        'SELECT * FROM intake_items WHERE tenant_id = ? AND source_id = ? AND delivery_key = ?',
        this.scope.tenantId,
        input.sourceId,
        input.deliveryKey,
      );
      const item = matches.rows[0] as Row;
      if (
        item.scope_digest !== scopeDigest ||
        item.payload_digest !== payloadDigest ||
        !(await this.matchesDispatchRoute(db, item))
      )
        return { kind: 'conflict' as const };
      if (
        item.visibility !== 'active' ||
        persistedDate(item.replay_until) <= now ||
        persistedDate(item.expires_at) <= now
      )
        return { kind: 'expired' as const };
      if (inserted.length) {
        const evidenceIds = new Map(parts.map((p) => [p.partId, randomUUID()]));
        const ordered = [...parts].sort((a, b) => {
          const depth = (p: IntakePart): number =>
            p.parentPartId
              ? 1 + depth(parts.find((x) => x.partId === p.parentPartId)!)
              : 0;
          return depth(a) - depth(b);
        });
        for (const part of ordered)
          await this.insert(db, 'intake_evidence', {
            id: evidenceIds.get(part.partId),
            item_id: item.id,
            part_id: part.partId,
            parent_evidence_id: part.parentPartId
              ? evidenceIds.get(part.parentPartId)
              : null,
            // A referenced snapshot owns no asset: it is durable in the ledger
            // row itself and leaves with the row's ordinary redaction.
            asset_id: part.retain === 'reference' ? null : randomUUID(),
            state: part.retain === 'reference' ? 'durable' : 'intent',
            content_hash: part.hash,
            byte_length: part.bytes.byteLength,
            media_type: part.mediaType,
            source_uri: '',
            data: canonical({
              sourceReference: part.sourceReference ?? null,
              ...(part.filename === undefined
                ? {}
                : { filename: part.filename }),
              ...(part.retain === 'reference'
                ? { retain: 'reference', snapshot: part.snapshot }
                : {}),
            }),
          });
      }
      return { kind: 'reserved' as const, item, created: !!inserted.length };
    });
    if (reservation.kind !== 'reserved')
      return { kind: 'rejected', category: reservation.kind };
    const item = reservation.item;
    const itemId = String(item.id);
    await this.point('reserved');
    if (item.receipt_state === 'ready') {
      if (await this.revokedBeforeAck(itemId))
        return { kind: 'rejected', category: 'expired' };
      try {
        if (!inline) await this.repairDispatches();
      } catch {
        return { kind: 'retry', category: 'unavailable' };
      }
      return {
        kind: 'duplicate',
        itemId,
        receiptVersion: Number(item.receipt_version),
      };
    }
    const token = randomUUID();
    const claimed = await this.tx((db) =>
      db.query(
        `UPDATE intake_items SET receipt_state = 'preserving', fence = fence + 1, lease_token = ?, lease_until = ? WHERE tenant_id = ? AND confidential_scope_id = ? AND id = ? AND visibility = 'active' AND receipt_state <> 'ready' AND (lease_until IS NULL OR lease_until <= ?) RETURNING fence`,
        token,
        new Date(now.getTime() + input.limits.leaseMs).toISOString(),
        this.scope.tenantId,
        this.scope.confidentialScopeId,
        itemId,
        now.toISOString(),
      ),
    );
    if (!claimed.rows.length)
      return (await this.revokedBeforeAck(itemId))
        ? { kind: 'rejected', category: 'expired' }
        : { kind: 'retry', category: 'busy' };
    try {
      for (const part of parts)
        if (part.retain === 'copy') await this.preserve(itemId, part, token);
      await this.point('evidence');
      await this.tx(async (db) => {
        await this.lock(db, itemId);
        await this.item(itemId, 'process', db);
        const evidence = await this.rows(db, 'intake_evidence', 'item_id = ?', [
          itemId,
        ]);
        if (
          evidence.length !== parts.length ||
          evidence.some((e) => e.state !== 'durable')
        )
          throw new Error('Incomplete evidence');
        const updated = await db.query(
          `UPDATE intake_items SET receipt_state='ready',lease_token='',lease_until=NULL WHERE tenant_id=? AND confidential_scope_id=? AND id=? AND lease_token=? AND lease_until>? AND visibility='active' RETURNING id`,
          this.scope.tenantId,
          this.scope.confidentialScopeId,
          itemId,
          token,
          this.now().toISOString(),
        );
        if (!updated.rows.length) throw new Error('Lease lost');
        // An inline receipt retains its route provenance but no deliverable intent.
        await this.insert(
          db,
          'intake_dispatches',
          {
            item_id: itemId,
            stage: 'analyze',
            revision: 1,
            state: inline ? 'completed' : 'pending',
            job_id: '',
            deliveries: 0,
            data: canonical({ dispatchTarget: this.dispatchTarget }),
          },
          'tenant_id,item_id,stage,revision',
        );
      });
      await this.point('ready');
      if (!inline) await this.repairDispatches();
      await this.point('ack');
      if (await this.revokedBeforeAck(itemId))
        return { kind: 'rejected', category: 'expired' };
      return {
        kind: reservation.created ? 'accepted' : 'duplicate',
        itemId,
        receiptVersion: 1,
      };
    } catch {
      await this.tx((db) =>
        db.query(
          `UPDATE intake_items SET receipt_state='needs_attention',lease_token='',lease_until=NULL WHERE tenant_id=? AND confidential_scope_id=? AND id=? AND lease_token=? AND receipt_state<>'ready'`,
          this.scope.tenantId,
          this.scope.confidentialScopeId,
          itemId,
          token,
        ),
      );
      // An owner deletion that won the race is final, not a retryable fault.
      if (await this.revokedBeforeAck(itemId))
        return { kind: 'rejected', category: 'expired' };
      return { kind: 'retry', category: 'unavailable' };
    }
  }
  private async revokedBeforeAck(itemId: string): Promise<boolean> {
    const [row] = await this.rows(this.db, 'intake_items', 'id=?', [itemId]);
    return !row || row.visibility !== 'active';
  }
  private async preserve(
    itemId: string,
    part: IntakePart & { hash: string },
    token: string,
  ): Promise<void> {
    const [evidence] = await this.rows(
      this.db,
      'intake_evidence',
      'item_id=? AND part_id=?',
      [itemId, part.partId],
    );
    if (!evidence) throw new Error('Missing storage intent');
    await this.item(itemId, 'process');
    const asset = await withTenant(
      { tenantId: this.scope.tenantId },
      async () => {
        let asset = await this.options.assets.collection.get({
          id: String(evidence.asset_id),
        });
        if (!asset)
          asset = await this.options.assets.collection.create({
            id: String(evidence.asset_id),
            tenantId: this.scope.tenantId,
            name: String(evidence.id),
            mimeType: part.mediaType,
            typeSlug: 'intake',
            statusSlug: 'active',
            sourceUri: '',
          });
        if (asset.tenantId !== this.scope.tenantId)
          throw new Error('Asset unavailable');
        return asset;
      },
    );
    const uri = await this.options.assets.store.planFile(asset, {
      mimeType: part.mediaType,
      typeSlug: 'intake',
    });
    if (evidence.source_uri && evidence.source_uri !== uri)
      throw new Error('Storage plan changed');
    await this.tx(async (db) => {
      await this.lock(db, itemId);
      const item = await this.item(itemId, 'process', db);
      if (
        item.lease_token !== token ||
        persistedDate(item.lease_until) <= this.now()
      )
        throw new Error('Lease lost');
      await db.query(
        'UPDATE intake_evidence SET source_uri=? WHERE tenant_id=? AND confidential_scope_id=? AND id=?',
        uri,
        this.scope.tenantId,
        this.scope.confidentialScopeId,
        evidence.id,
      );
    });
    asset.sourceUri = uri;
    await asset.save();
    await this.point('storage_intent');
    await this.options.assets.store.preserveFile(
      asset,
      Buffer.from(part.bytes),
      { mimeType: part.mediaType, typeSlug: 'intake' },
    );
    await this.point('storage');
    const actual = await this.options.assets.store.read(asset);
    if (
      actual.length !== Number(evidence.byte_length) ||
      bytesHash(actual) !== evidence.content_hash
    )
      throw new Error('Storage integrity');
    await this.tx(async (db) => {
      await this.lock(db, itemId);
      const item = await this.item(itemId, 'process', db);
      if (
        item.lease_token !== token ||
        persistedDate(item.lease_until) <= this.now()
      )
        throw new Error('Lease lost');
      await db.query(
        "UPDATE intake_evidence SET state='durable' WHERE tenant_id=? AND confidential_scope_id=? AND id=?",
        this.scope.tenantId,
        this.scope.confidentialScopeId,
        evidence.id,
      );
    });
  }
  /** Inspect retained route provenance without changing state or enqueuing work. */
  async inspectDispatchRoute(itemId: string): Promise<DispatchRouteInspection> {
    const item = await this.item(itemId, 'read');
    return this.dispatchRouteState(this.db, item);
  }

  /** Explicitly bind a provenance-free legacy receipt to this trusted host's route.
   * Never accepts a route from the caller, rewrites original authority, or enqueues.
   */
  async recoverDispatchRoute(input: {
    itemId: string;
    expectedFingerprint: string;
    evidenceRef: string;
  }): Promise<DispatchRouteInspection> {
    nonempty(input.evidenceRef);
    if (!/^[a-f0-9]{64}$/.test(input.expectedFingerprint))
      throw new Error('Invalid dispatch recovery fingerprint');
    if (!this.options.dispatchRecovery)
      throw new Error('Dispatch recovery unavailable');
    return this.tx(async (db) => {
      await this.lock(db, input.itemId);
      const item = await this.item(input.itemId, 'process', db);
      const data = object(item.data);
      if (
        !(await this.options.dispatchRecovery!.authorize({
          scope: this.scope,
          itemId: input.itemId,
          capturedCeiling: object(data.capturedCeiling),
          evidenceRef: input.evidenceRef,
          db,
        }))
      )
        throw new Error('Dispatch recovery unavailable');
      const current = await this.dispatchRouteState(db, item);
      const recovery =
        data.dispatchRecovery === undefined
          ? null
          : object(data.dispatchRecovery);
      if (
        recovery &&
        recovery.expectedFingerprint === input.expectedFingerprint &&
        recovery.evidenceRef === input.evidenceRef &&
        current.status === 'bound' &&
        canonical(current.target) === canonical(this.dispatchTarget)
      ) {
        return current;
      }
      if (
        current.status !== 'unknown' ||
        current.fingerprint !== input.expectedFingerprint
      )
        throw new Error('Dispatch recovery conflict');
      data.dispatchRecovery = {
        version: 1,
        expectedFingerprint: input.expectedFingerprint,
        evidenceRef: input.evidenceRef,
        actorId: this.scope.actorId,
        recordedAt: date(this.now()),
        target: this.dispatchTarget,
      };
      item.data = canonical(data);
      await this.bindDispatchRoute(db, item);
      await this.point('dispatch:recovered');
      const [updated] = await this.rows(db, 'intake_items', 'id=?', [item.id]);
      return this.dispatchRouteState(db, updated);
    });
  }

  private async matchesDispatchRoute(
    db: DatabaseInterface,
    item: Row,
  ): Promise<boolean> {
    const route = await this.dispatchRouteState(db, item);
    return (
      route.status === 'bound' &&
      canonical(route.target) === canonical(this.dispatchTarget)
    );
  }

  private async bindDispatchRoute(
    db: DatabaseInterface,
    item: Row,
  ): Promise<void> {
    const data = object(item.data);
    if (data.dispatchTarget === undefined) {
      await db.query(
        'UPDATE intake_items SET data=? WHERE tenant_id=? AND confidential_scope_id=? AND id=?',
        canonical({ ...data, dispatchTarget: this.dispatchTarget }),
        this.scope.tenantId,
        this.scope.confidentialScopeId,
        item.id,
      );
    }
    const intents = await this.rows(db, 'intake_dispatches', 'item_id=?', [
      item.id,
    ]);
    for (const intent of intents) {
      const retained = object(intent.data);
      if (retained.dispatchTarget === undefined)
        await db.query(
          'UPDATE intake_dispatches SET data=? WHERE tenant_id=? AND confidential_scope_id=? AND id=?',
          canonical({ ...retained, dispatchTarget: this.dispatchTarget }),
          this.scope.tenantId,
          this.scope.confidentialScopeId,
          intent.id,
        );
    }
  }

  private async dispatchRouteState(
    db: DatabaseInterface,
    item: Row,
  ): Promise<DispatchRouteInspection> {
    let invalid = false;
    const malformed: string[] = [];
    const payload = (value: unknown): Row => {
      try {
        return object(value);
      } catch {
        invalid = true;
        malformed.push(digest(value));
        return {};
      }
    };
    const data = payload(item.data);
    const intents = (
      await this.rows(db, 'intake_dispatches', 'item_id=?', [item.id])
    ).sort((a, b) => String(a.id).localeCompare(String(b.id)));
    const targets: IntakeDispatchTarget[] = [];
    const lineage: unknown[] = [];
    const retain = (value: unknown) => {
      if (value === undefined) return;
      try {
        const target = object(value);
        nonempty(target.objectType);
        nonempty(target.method);
        if (target.version !== 1) throw new Error('Unsupported dispatch route');
        targets.push({
          version: 1,
          objectType: target.objectType,
          method: target.method,
        });
      } catch {
        invalid = true;
      }
    };
    retain(data.dispatchTarget);
    if (data.dispatchRecovery !== undefined) {
      const recovery = payload(data.dispatchRecovery);
      if (recovery.version !== 1 || recovery.target === undefined)
        invalid = true;
      retain(recovery.target);
    }
    const jobs = await SmrtJobCollection.create({ db });
    for (const intent of intents) {
      retain(payload(intent.data).dispatchTarget);
      if (!intent.job_id) continue;
      const job = await withTenant({ tenantId: this.scope.tenantId }, () =>
        jobs.get({ id: String(intent.job_id) }),
      );
      // Missing jobs are absent provenance, not affirmative conflicting authority.
      // A retained route survives job retention; otherwise explicit recovery is required.
      if (!job) {
        lineage.push({ id: intent.job_id, missing: true });
        continue;
      }
      const args = payload(job.args);
      if (
        job.tenantId !== this.scope.tenantId ||
        job.queue !== 'ingestion' ||
        job.objectId ||
        args.itemId !== item.id ||
        args.dispatchId !== intent.id ||
        args.revision !== Number(intent.revision)
      ) {
        invalid = true;
        lineage.push({ id: intent.job_id, valid: false });
        continue;
      }
      const target = {
        version: 1,
        objectType: job.objectType,
        method: job.method,
      };
      retain(target);
      lineage.push({ id: job.id, target, args });
    }
    if (targets.some((target) => canonical(target) !== canonical(targets[0])))
      invalid = true;
    const status = invalid ? 'conflict' : targets.length ? 'bound' : 'unknown';
    return {
      status,
      target: status === 'bound' ? targets[0] : null,
      fingerprint: digest({
        itemId: item.id,
        tenantId: item.tenant_id,
        confidentialScopeId: item.confidential_scope_id,
        sourceId: item.source_id,
        sourceVersion: item.source_version,
        payloadDigest: item.payload_digest,
        scopeDigest: item.scope_digest,
        revision: item.analysis_revision,
        data,
        intents: intents.map((intent) => ({
          id: intent.id,
          revision: intent.revision,
          data: payload(intent.data),
          jobId: intent.job_id,
        })),
        lineage,
        malformed,
      }),
    };
  }

  /** Repair lost enqueue/mark writes and deleted/failed jobs. Duplicate jobs are safe. */
  async repairDispatches(): Promise<number> {
    let repaired = 0;
    const intents = await this.rows(
      this.db,
      'intake_dispatches',
      "state <> 'completed'",
    );
    const jobs = await SmrtJobCollection.create({ db: this.db });
    for (const intent of intents) {
      // Scope and protected route are checked before this host's authorization:
      // unrelated hosts must not spend budgets or block one another's receipt.
      const [candidate] = await this.rows(this.db, 'intake_items', 'id=?', [
        intent.item_id,
      ]);
      if (!candidate || !(await this.matchesDispatchRoute(this.db, candidate)))
        continue;
      const item = await this.item(
        String(intent.item_id),
        'process',
        this.db,
        true,
      );
      if (
        item.visibility !== 'active' ||
        item.cancelled ||
        persistedDate(item.expires_at) <= this.now()
      )
        continue;
      const allocation = await this.tx(async (db) => {
        await this.lock(db, String(item.id));
        const [routedItem] = await this.rows(db, 'intake_items', 'id=?', [
          item.id,
        ]);
        if (!routedItem || !(await this.matchesDispatchRoute(db, routedItem)))
          return false;
        await this.bindDispatchRoute(db, routedItem);
        const currentItem = await this.item(String(item.id), 'process', db);
        const [currentIntent] = await this.rows(
          db,
          'intake_dispatches',
          'id=? AND item_id=?',
          [intent.id, item.id],
        );
        if (!currentIntent || currentIntent.state === 'completed') return false;
        if (
          currentIntent.job_id &&
          Number(currentIntent.revision) ===
            Math.max(1, Number(currentItem.analysis_revision))
        ) {
          const currentJobs = await SmrtJobCollection.create({ db });
          const job = await withTenant({ tenantId: this.scope.tenantId }, () =>
            currentJobs.get({ id: String(currentIntent.job_id) }),
          );
          if (job && ['pending', 'running'].includes(job.status)) return false;
        }
        // Revision 1 is queued at receipt, before the first analysis exists.
        if (
          currentItem.cancelled ||
          Number(currentIntent.revision) !==
            Math.max(1, Number(currentItem.analysis_revision))
        ) {
          await db.query(
            "UPDATE intake_dispatches SET state='completed' WHERE tenant_id=? AND confidential_scope_id=? AND id=?",
            this.scope.tenantId,
            this.scope.confidentialScopeId,
            currentIntent.id,
          );
          return false;
        }
        const limits = object(
          object(currentItem.data).limits,
        ) as unknown as IntakeLimits;
        if (Number(currentIntent.deliveries) >= limits.maxAttempts) {
          await db.query(
            "UPDATE intake_items SET processing_state='needs_attention' WHERE tenant_id=? AND confidential_scope_id=? AND id=?",
            this.scope.tenantId,
            this.scope.confidentialScopeId,
            item.id,
          );
          await db.query(
            "UPDATE intake_dispatches SET state='completed' WHERE tenant_id=? AND confidential_scope_id=? AND id=?",
            this.scope.tenantId,
            this.scope.confidentialScopeId,
            intent.id,
          );
          return false;
        }
        const result = await db.query(
          "UPDATE intake_dispatches SET deliveries=deliveries+1 WHERE tenant_id=? AND confidential_scope_id=? AND id=? AND state<>'completed' AND deliveries<? RETURNING id",
          this.scope.tenantId,
          this.scope.confidentialScopeId,
          currentIntent.id,
          limits.maxAttempts,
        );
        return result.rows.length === 1;
      });
      if (!allocation) continue;
      const job = await withTenant({ tenantId: this.scope.tenantId }, () =>
        jobs.enqueueJob({
          tenantId: this.scope.tenantId,
          objectType: this.dispatchTarget.objectType,
          method: this.dispatchTarget.method,
          args: {
            itemId: intent.item_id,
            revision: Number(intent.revision),
            dispatchId: intent.id,
          },
          queue: 'ingestion',
          maxAttempts: 1,
        }),
      );
      await this.point('enqueued');
      await this.tx((db) =>
        db.query(
          "UPDATE intake_dispatches SET state='delivered',job_id=? WHERE tenant_id=? AND confidential_scope_id=? AND id=? AND state<>'completed'",
          job.id,
          this.scope.tenantId,
          this.scope.confidentialScopeId,
          intent.id,
        ),
      );
      repaired++;
    }
    return repaired;
  }
  /**
   * One authorized inbox page, newest receipt first with the id as tiebreak.
   * Tenant, confidential scope, retention and the id restriction run in the
   * query; rows are authorized before the `state` filter is applied to the
   * fetched batch, so every filter is bounded by the scan limit (default
   * ITEM_SCAN_CEILING). Authority is rechecked at two levels: the host
   * `authorize('read')` once per distinct captured ceiling, and the execution
   * read gate once per distinct (item, handler) bound by a scanned row that
   * passed the first. Without a `cursorKey` every cursor names a row the
   * actor can read; with one, all cursors are sealed and a budget-stopped
   * page may resume past rows the actor cannot read. `scanned` is for trusted
   * host accounting and must not be sent to clients.
   */
  async listItemsPage(input: ListItemsInput = {}): Promise<IntakeItemPage> {
    const limit = input.limit ?? ITEM_PAGE_DEFAULT;
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > ITEM_PAGE_CEILING ||
      (input.state !== undefined && !INBOX_STATES.includes(input.state)) ||
      (input.itemIds !== undefined &&
        (!Array.isArray(input.itemIds) ||
          input.itemIds.length > ITEM_ID_FILTER_CEILING ||
          !input.itemIds.every(isIntakeId))) ||
      (input.scanLimit !== undefined &&
        (!Number.isSafeInteger(input.scanLimit) ||
          input.scanLimit < 1 ||
          input.scanLimit > ITEM_SCAN_CEILING))
    )
      throw new Error('Invalid item page');
    if (input.itemIds && !input.itemIds.length)
      return { items: [], scanned: 0 };
    const start = input.cursor ? this.decodeCursor(input.cursor) : undefined;
    const scan = await this.scanItems(
      input,
      limit,
      input.scanLimit ?? ITEM_SCAN_CEILING,
      start,
    );
    const items = scan.items.map(({ item, state, position }) => ({
      item,
      state,
      cursor: this.encodeCursor(position),
    }));
    if (scan.done) return { items, scanned: scan.scanned };
    const last = scan.items.at(-1)?.position;
    if (scan.full && last)
      return {
        items,
        scanned: scan.scanned,
        nextCursor: this.encodeCursor(last),
      };
    // The budget ran out before the page filled. A sealed cursor may resume
    // past rows the actor cannot read; an unsealed one may only name a row
    // the actor can read. With no such position, or none past the input, the
    // call fails closed rather than return a cursor that cannot progress.
    const position = this.cursorKey ? scan.scanFrom : scan.lastReadable;
    if (!position || (start && samePosition(position, start)))
      throw new IntakeScanLimitError();
    return {
      items,
      scanned: scan.scanned,
      nextCursor: this.encodeCursor(position),
    };
  }
  /**
   * The bounded page scan behind `listItemsPage` and `listItems`. It returns
   * the rows to list with their positions, the exact scan position reached
   * (`scanFrom`, which may be a row the actor cannot read and must never
   * leave the service unsealed), and the last row the actor can read
   * (`lastReadable`, which may not match the `state` filter).
   */
  private async scanItems(
    input: Pick<ListItemsInput, 'state' | 'itemIds'>,
    limit: number,
    scanCeiling: number,
    start: ItemPosition | undefined,
  ): Promise<{
    items: Array<{
      item: IntakeItemDTO;
      state: InboxState;
      position: ItemPosition;
    }>;
    scanned: number;
    done: boolean;
    full: boolean;
    scanFrom?: ItemPosition;
    lastReadable?: ItemPosition;
  }> {
    let scanFrom = start;
    let lastReadable: ItemPosition | undefined;
    const now = this.now().toISOString();
    const allowed = this.ceilingGate();
    const handlers = this.handlerGate();
    const items: Array<{
      item: IntakeItemDTO;
      state: InboxState;
      position: ItemPosition;
    }> = [];
    let examined = 0;
    // SQLite without planner statistics prefers the expiry index plus a sort,
    // which reads the whole scope per page; pin the ordering index. An id
    // restriction is left to the planner, which then looks ids up directly.
    // A non-text receipt value (an integer, say) sorts after every text value
    // on SQLite and always satisfies `created_at < ?`, so the scan could
    // never move past it; an over-long receipt value or id could not be
    // carried by any cursor; and an embedded NUL makes SQLite's `length()`
    // stop early and the driver return truncated text, so such a row would
    // look canonical and sort above a legitimate row at the truncated value.
    // Such rows are service-foreign and excluded.
    // PostgreSQL types both columns, so neither case arises there.
    const sqlite = this.engine === 'sqlite';
    const pinned =
      sqlite && !input.itemIds ? ' INDEXED BY intake_items_received_idx' : '';
    const textOnly = sqlite
      ? ` AND typeof(i.created_at) = 'text' AND length(i.created_at) <= ${SCAN_KEY_CHARS} AND length(i.id) <= ${SCAN_KEY_CHARS} AND instr(i.created_at, char(0)) = 0 AND instr(i.id, char(0)) = 0`
      : '';
    // The exact stored receipt value (for the scan anchor) and, on
    // PostgreSQL, whether it has a sub-millisecond part a cursor cannot carry.
    const receipt = sqlite
      ? 'i.created_at AS receipt_raw, 1 AS receipt_ms'
      : "i.created_at::text AS receipt_raw, (i.created_at = date_trunc('milliseconds', i.created_at)) AS receipt_ms";
    for (;;) {
      const params: unknown[] = [
        this.scope.tenantId,
        this.scope.confidentialScopeId,
        now,
      ];
      let where = textOnly;
      if (scanFrom) {
        where += ' AND (i.created_at < ? OR (i.created_at = ? AND i.id < ?))';
        params.push(scanFrom.key, scanFrom.key, scanFrom.id);
      }
      if (input.itemIds) {
        where += ` AND i.id IN (${input.itemIds.map(() => '?').join(',')})`;
        params.push(...input.itemIds);
      }
      // The first read fetches exactly the page. Refills after skipped rows
      // grow with what has already been examined, from the page size up to
      // 100 rows, and never past the scan limit.
      const wanted = limit - items.length;
      const batch = Math.min(
        scanCeiling - examined,
        Math.max(wanted, Math.min(ITEM_PAGE_CEILING, examined)),
      );
      // The state expression is evaluated once per fetched row.
      // MIN over canonical UUID text preserves getItem's first-id choice
      // without a per-item sort; both probes use the scoped item index.
      const rows = (
        await this.db.query(
          `SELECT i.*, (SELECT first_d.created_at FROM intake_dispositions first_d WHERE first_d.tenant_id=i.tenant_id AND first_d.confidential_scope_id=i.confidential_scope_id AND first_d.item_id=i.id AND CAST(first_d.id AS TEXT)=(SELECT MIN(CAST(d.id AS TEXT)) FROM intake_dispositions d WHERE ${dispositionWhere})) AS disposition_at, ${INBOX_STATE_SQL} AS inbox_state, ${actionCount()} AS action_count, ${receipt} FROM intake_items i${pinned} WHERE i.tenant_id = ? AND i.confidential_scope_id = ? AND i.visibility = 'active' AND i.expires_at > ?${where} ORDER BY i.created_at DESC, i.id DESC LIMIT ?`,
          ...params,
          batch + 1,
        )
      ).rows as Row[];
      const more = rows.length > batch;
      const candidates = rows.slice(0, batch);
      // Authority first, for every fetched row, so that a readable row the
      // state filter excludes may still anchor the cursor. Item-level
      // authority runs once per distinct ceiling. A row whose payload cannot
      // be parsed is skipped and counted; a host authorization that throws
      // rejects the whole page, as `load` does, so a transient failure can
      // never let paging move past rows the actor may be allowed to read.
      const passed = new Set<Row>();
      for (const row of candidates) {
        let data: Row;
        try {
          data = object(row.data);
        } catch {
          continue;
        }
        if (await allowed(data)) passed.add(row);
      }
      // Handler bindings once per batch, for every row that passed and binds
      // actions: one read per batch, bounded by rows scanned.
      await handlers.resolve(
        candidates.filter(
          (row) => passed.has(row) && Number(row.action_count) > 0,
        ),
      );
      let consumed = 0;
      for (const row of candidates) {
        consumed++;
        examined++;
        // A receipt time the service did not write is not listed; the scan
        // position moves past it by its exact stored value so it is neither
        // re-read nor allowed to shift the order of its neighbours.
        // A row whose id is not a UUID is likewise service-foreign: it is
        // passed by its raw id and never listed or named by an unsealed
        // cursor, which only ever carries UUIDs.
        const id = String(row.id);
        const receivedAt = receiptTime(row);
        if (receivedAt !== undefined) scanFrom = { key: receivedAt, id };
        else if (typeof row.receipt_raw === 'string')
          scanFrom = { key: row.receipt_raw, id };
        if (receivedAt === undefined || !isIntakeId(id) || !passed.has(row))
          continue;
        if (Number(row.action_count) > 0 && !(await handlers.readable(row)))
          continue;
        const position = { key: receivedAt, id };
        lastReadable = position;
        if (input.state && row.inbox_state !== input.state) continue;
        items.push({
          item: this.itemDTO(row, row.disposition_at),
          state: String(row.inbox_state) as InboxState,
          position,
        });
        if (items.length === limit) break;
      }
      const remaining = more || consumed < candidates.length;
      const full = items.length === limit;
      if (!remaining || full || examined >= scanCeiling)
        return {
          items,
          scanned: examined,
          done: !remaining,
          full,
          scanFrom,
          lastReadable,
        };
    }
  }
  /** Associated data that binds a sealed cursor to this authenticated scope. */
  private cursorScope(): Buffer {
    return Buffer.from(
      canonical({
        tenantId: this.scope.tenantId,
        confidentialScopeId: this.scope.confidentialScopeId,
        actorId: this.scope.actorId,
      }),
    );
  }
  private encodeCursor(position: ItemPosition): string {
    if (!this.cursorKey) return encodeItemCursor(position.key, position.id);
    // A fixed-size plaintext, so a sealed cursor's length says nothing about
    // whether it stopped on a canonical or a service-foreign row.
    const body = Buffer.alloc(SEALED_CURSOR_BYTES, 0x20);
    const json = Buffer.from(JSON.stringify([position.key, position.id]));
    if (json.length > SEALED_CURSOR_BYTES)
      throw new Error('Cursor position too long');
    json.copy(body);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.cursorKey, iv);
    cipher.setAAD(this.cursorScope());
    const sealed = Buffer.concat([cipher.update(body), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), sealed]).toString(
      'base64url',
    );
  }
  private decodeCursor(cursor: string): ItemPosition {
    if (!this.cursorKey) {
      const { receivedAt, id } = decodeItemCursor(cursor);
      return { key: receivedAt, id };
    }
    try {
      const bytes = Buffer.from(cursor, 'base64url');
      if (bytes.length !== 28 + SEALED_CURSOR_BYTES) throw new Error('size');
      const decipher = createDecipheriv(
        'aes-256-gcm',
        this.cursorKey,
        bytes.subarray(0, 12),
      );
      decipher.setAAD(this.cursorScope());
      decipher.setAuthTag(bytes.subarray(12, 28));
      const parsed: unknown = JSON.parse(
        Buffer.concat([
          decipher.update(bytes.subarray(28)),
          decipher.final(),
        ]).toString('utf8'),
      );
      if (
        !Array.isArray(parsed) ||
        parsed.length !== 2 ||
        typeof parsed[0] !== 'string' ||
        !parsed[0] ||
        typeof parsed[1] !== 'string' ||
        !parsed[1]
      )
        throw new Error('shape');
      return { key: parsed[0], id: parsed[1] };
    } catch {
      throw new Error('Invalid item page');
    }
  }
  /**
   * Every authorized active item, newest receipt first.
   * @deprecated Use `listItemsPage`. Kept so callers of the array-returning
   * API keep working. It walks every page, so its cost grows with the scope,
   * including one execution authorization per (item, handler) across the
   * whole scope. It follows the internal scan position, which never leaves
   * the service, so runs of rows the actor cannot read never stop it. Items
   * are gated exactly as on a page.
   */
  async listItems(): Promise<IntakeItemDTO[]> {
    const all: IntakeItemDTO[] = [];
    let from: ItemPosition | undefined;
    for (;;) {
      const scan = await this.scanItems(
        {},
        ITEM_PAGE_CEILING,
        ITEM_SCAN_CEILING,
        from,
      );
      all.push(...scan.items.map(({ item }) => item));
      if (scan.done) return all;
      if (!scan.scanFrom || (from && samePosition(scan.scanFrom, from)))
        throw new Error('Intake list made no progress');
      from = scan.scanFrom;
    }
  }
  /**
   * One read authorization per distinct captured ceiling for a page of rows.
   * A refusal hides the rows; a malformed ceiling hides its row; a host
   * callback that throws rejects the page with that error.
   */
  private ceilingGate(): (data: Row) => Promise<boolean> {
    const ceilings = new Map<string, Promise<boolean>>();
    return (data) => {
      let ceiling: Record<string, unknown>;
      try {
        ceiling = object(data.capturedCeiling ?? {});
      } catch {
        return Promise.resolve(false);
      }
      const key = canonical(ceiling);
      let decision = ceilings.get(key);
      if (!decision) {
        decision = Promise.resolve(
          this.options.authorize({
            scope: this.scope,
            operation: 'read',
            capturedCeiling: ceiling,
            db: this.db,
          }),
        ).then((granted) => granted === true);
        ceilings.set(key, decision);
      }
      return decision;
    };
  }
  /**
   * The handler checks `listReviews` applies per action, batched for a page:
   * the bindings of the rows' current proposals are projected in SQL
   * (handler id, version, operation and capability; distinct per item) once
   * per fetched batch, then the execution list read gate runs once per distinct
   * (item, handler) of a row that passed the item-level gate. An item whose
   * bound handler the actor cannot currently read, whose binding drifted
   * from the configured handler, or whose bindings cannot be resolved, is
   * not listed. Actions without a proposal carry no handler and are not
   * gated, as in `listReviews`.
   */
  private handlerGate() {
    type Bound = {
      handlerId: string;
      handlerVersion: string;
      operation: unknown;
      capability: unknown;
    };
    const bound = new Map<string, Bound[]>();
    // Created only when a listed row actually binds a handler; a failure to
    // construct the execution service reads as "not readable", never as an
    // unhandled rejection.
    let execution: Promise<IntakeExecutionService | undefined> | undefined;
    const service = () => {
      execution ??= (
        this.options.execution
          ? this.execution()
          : Promise.resolve<IntakeExecutionService | undefined>(undefined)
      ).catch(() => undefined);
      return execution;
    };
    // The explicit cast keeps the projection valid where a deployment stores
    // the declared JSON column as json or text rather than jsonb.
    const field = (name: string, text: boolean) =>
      this.engine === 'sqlite'
        ? `json_extract(p.data, '$.binding.${name}')`
        : `(p.data::jsonb)->'binding'${text ? '->>' : '->'}'${name}'`;
    const parsed = (value: unknown): unknown => {
      if (typeof value !== 'string') return value;
      try {
        return JSON.parse(value);
      } catch {
        return undefined;
      }
    };
    return {
      resolve: async (rows: Row[]): Promise<void> => {
        const pending = rows.filter((row) => !bound.has(String(row.id)));
        if (!pending.length) return;
        for (const row of pending) bound.set(String(row.id), []);
        const found = (
          await this.db.query(
            `SELECT DISTINCT p.item_id, ${field('handlerId', true)} AS handler_id, ${field('handlerVersion', true)} AS handler_version, ${field('operation', false)} AS operation, ${field('capability', false)} AS capability FROM intake_proposals p JOIN intake_actions a ON a.tenant_id = p.tenant_id AND a.confidential_scope_id = p.confidential_scope_id AND a.id = p.action_id AND a.proposal_revision = p.revision WHERE p.tenant_id = ? AND p.confidential_scope_id = ? AND p.item_id IN (${pending.map(() => '?').join(',')})`,
            this.scope.tenantId,
            this.scope.confidentialScopeId,
            ...pending.map((row) => String(row.id)),
          )
        ).rows as Row[];
        for (const row of found)
          bound.get(String(row.item_id))?.push({
            handlerId: row.handler_id == null ? '' : String(row.handler_id),
            handlerVersion:
              row.handler_version == null ? '' : String(row.handler_version),
            operation: parsed(row.operation),
            capability: parsed(row.capability),
          });
      },
      readable: async (row: Row): Promise<boolean> => {
        for (const binding of bound.get(String(row.id)) ?? []) {
          const gate = await service();
          if (!gate || !(await gate[listReadGate](row, binding))) return false;
        }
        return true;
      },
    };
  }
  /** Only the disposition state and time; reviewer and reason need review authority. */
  private itemDTO(row: Row, dispositionAt?: unknown): IntakeItemDTO {
    return {
      id: String(row.id),
      receiptState: String(row.receipt_state),
      processingState: String(row.processing_state),
      analysisRevision: Number(row.analysis_revision),
      cancelled: !!row.cancelled,
      traceId: String(row.trace_id),
      ...(dispositionAt !== undefined && dispositionAt !== null
        ? {
            disposition: {
              state: 'resolved' as const,
              at: persistedDate(dispositionAt).toISOString(),
            },
          }
        : {}),
    };
  }
  async getItem(id: string): Promise<IntakeItemDTO> {
    const item = await this.item(id, 'read');
    const [disposition] = await this.rows(
      this.db,
      'intake_dispositions',
      'item_id=? ORDER BY id LIMIT 1',
      [item.id],
    );
    return this.itemDTO(item, disposition?.created_at);
  }
  async getEvidence(itemId: string): Promise<IntakeEvidenceDTO[]> {
    await this.item(itemId, 'read');
    return (
      await this.rows(
        this.db,
        'intake_evidence',
        "item_id=? AND state='durable'",
        [itemId],
      )
    ).map((e) => this.evidenceDTO(e));
  }
  /**
   * Durable evidence for one inbox page in a single query, keyed by item id.
   * Items that are not active, retained and readable are omitted (no
   * existence disclosure); the host authorize callback runs once per distinct
   * captured ceiling rather than once per item, through the same gate as
   * `listItemsPage`: a refusal or a malformed ceiling hides the item, and a
   * host callback that throws rejects the read.
   */
  async listEvidence(
    itemIds: string[],
  ): Promise<Map<string, IntakeEvidenceDTO[]>> {
    if (
      !Array.isArray(itemIds) ||
      itemIds.length > ITEM_PAGE_CEILING ||
      !itemIds.every(isIntakeId)
    )
      throw new Error('Invalid item page');
    const result = new Map<string, IntakeEvidenceDTO[]>();
    if (!itemIds.length) return result;
    const rows = (
      await this.db.query(
        `SELECT e.*, i.data AS item_data FROM intake_evidence e JOIN intake_items i ON i.tenant_id = e.tenant_id AND i.confidential_scope_id = e.confidential_scope_id AND i.id = e.item_id WHERE e.tenant_id = ? AND e.confidential_scope_id = ? AND e.state = 'durable' AND i.visibility = 'active' AND i.expires_at > ? AND e.item_id IN (${itemIds.map(() => '?').join(',')}) ORDER BY e.item_id, e.part_id`,
        this.scope.tenantId,
        this.scope.confidentialScopeId,
        this.now().toISOString(),
        ...itemIds,
      )
    ).rows as Row[];
    const allowed = this.ceilingGate();
    for (const row of rows) {
      let data: Row;
      try {
        data = object(row.item_data);
      } catch {
        continue;
      }
      if (!(await allowed(data))) continue;
      const itemId = String(row.item_id);
      const parts = result.get(itemId) ?? [];
      parts.push(this.evidenceDTO(row));
      result.set(itemId, parts);
    }
    return result;
  }
  private evidenceDTO(e: Row): IntakeEvidenceDTO {
    // Only the cleaned name is exposed. `sourceReference` stays in storage:
    // its ids are upstream locators (mailbox paths, raw folder names), not
    // display text, and no host needs them on the DTO.
    const filename = presentedFilename(object(e.data).filename);
    return {
      id: String(e.id),
      partId: String(e.part_id),
      parentEvidenceId: e.parent_evidence_id
        ? String(e.parent_evidence_id)
        : null,
      mediaType: String(e.media_type),
      contentHash: String(e.content_hash),
      byteLength: Number(e.byte_length),
      ...(filename ? { filename } : {}),
    };
  }
  async readEvidence(itemId: string, evidenceId: string): Promise<Uint8Array> {
    await this.item(itemId, 'read');
    const [e] = await this.rows(
      this.db,
      'intake_evidence',
      "item_id=? AND id=? AND state='durable'",
      [itemId, evidenceId],
    );
    if (!e) throw new Error('Intake unavailable');
    const bytes = await this.evidenceBytes(e);
    if (
      bytes.length !== Number(e.byte_length) ||
      bytesHash(bytes) !== e.content_hash
    )
      throw new Error('Intake integrity');
    await this.item(itemId, 'read');
    return bytes;
  }
  private async evidenceBytes(e: Row): Promise<Uint8Array> {
    const data = object(e.data);
    if (data.retain === 'reference') {
      // A referenced snapshot never owns an asset; one that does is corrupt.
      if (e.asset_id) throw new Error('Intake integrity');
      if (typeof data.snapshot !== 'string')
        throw new Error('Intake unavailable');
      return Buffer.from(data.snapshot, 'utf8');
    }
    // An asset-less row without its snapshot marker is corrupt; never look up
    // a null asset identifier (PostgreSQL rejects it as an invalid UUID).
    if (!e.asset_id) throw new Error('Intake unavailable');
    const asset = await withTenant({ tenantId: this.scope.tenantId }, () =>
      this.options.assets.collection.get({ id: String(e.asset_id) }),
    );
    if (
      !asset ||
      asset.tenantId !== this.scope.tenantId ||
      asset.sourceUri !== e.source_uri
    )
      throw new Error('Intake unavailable');
    return this.options.assets.store.read(asset);
  }
  /** Append an immutable input revision. Reprocessing never creates actions. */
  async analyze(
    itemId: string,
    configuration: Record<string, unknown>,
    requestKey: string,
  ): Promise<{ id: string; revision: number }> {
    const frozen = structuredClone(configuration);
    if (
      Object.hasOwn(frozen, 'humanCorrection') &&
      frozen.stage !== 'interpret'
    )
      throw new Error('Human corrections require authenticated split revision');
    // Interpretation copies are verified against the pinned extraction source
    // before any provider disclosure (getGenerationInput).
    if (
      Object.hasOwn(frozen, 'reviewerInstruction') &&
      frozen.stage !== 'interpret'
    )
      throw new Error(
        'Reviewer instructions require authenticated instruction revision',
      );
    return this.tx((db) => this.appendAnalysis(db, itemId, frozen, requestKey));
  }
  private async appendAnalysis(
    db: DatabaseInterface,
    itemId: string,
    configuration: Record<string, unknown>,
    requestKey: string,
    /** Inline only: the extraction attempt the interpretation pins. */
    pinnedSourceAttemptId?: string,
  ): Promise<{ id: string; revision: number }> {
    nonempty(requestKey);
    const configDigest = digest(configuration);
    await this.lock(db, itemId);
    const item = await this.item(itemId, 'process', db);
    // A resolved item is terminal: no reanalysis or split re-extraction.
    await this.assertUnresolved(db, itemId);
    if (!(await this.matchesDispatchRoute(db, item)))
      throw new Error('Intake dispatch route unavailable');
    await this.bindDispatchRoute(db, item);
    if (item.receipt_state !== 'ready' || item.cancelled)
      throw new Error('Intake not processable');
    const previous = await this.rows(db, 'intake_analyses', 'item_id=?', [
      itemId,
    ]);
    const replay = previous.find(
      (a) => object(a.data).requestKey === requestKey,
    );
    if (replay) {
      if (object(replay.data).configDigest !== configDigest)
        throw new Error('Analysis request conflict');
      return { id: String(replay.id), revision: Number(replay.revision) };
    }
    // An interpretation must pin the item's latest extraction. Checked under
    // the item lock before anything is superseded, so a slow host appending a
    // late interpretation cannot clobber a newer extraction (for example a
    // reviewer's retry): it is refused and nothing is appended.
    if (configuration.stage === 'interpret') {
      const pinned = Number(
        object(object(configuration.proposals).source).revision,
      );
      const latestExtraction = previous
        .filter(
          (row) => object(object(row.data).configuration).stage !== 'interpret',
        )
        .reduce(
          (max, row) => Math.max(max, Number(row.revision)),
          Number.NEGATIVE_INFINITY,
        );
      if (pinned !== latestExtraction) throw new GenerationSourceStaleError();
    }
    // Inline only, after #4228's general check: the pinned extraction must
    // also be the latest revision of any stage and its current attempt.
    if (pinnedSourceAttemptId !== undefined) {
      const latest = previous.find(
        (a) => Number(a.revision) === Number(item.analysis_revision),
      );
      if (!latest || latest.current_attempt_id !== pinnedSourceAttemptId)
        throw new Error('Generation source changed');
    }
    const evidence = await this.rows(
      db,
      'intake_evidence',
      "item_id=? AND state='durable'",
      [itemId],
    );
    await db.query(
      "UPDATE intake_analysis_attempts SET state='superseded' WHERE tenant_id=? AND confidential_scope_id=? AND item_id=? AND state IN ('queued','running')",
      this.scope.tenantId,
      this.scope.confidentialScopeId,
      itemId,
    );
    await db.query(
      "UPDATE intake_analyses SET state='superseded' WHERE tenant_id=? AND confidential_scope_id=? AND item_id=? AND state IN ('queued','running')",
      this.scope.tenantId,
      this.scope.confidentialScopeId,
      itemId,
    );
    const revision = Number(item.analysis_revision) + 1;
    await db.query(
      "UPDATE intake_dispatches SET state='completed' WHERE tenant_id=? AND confidential_scope_id=? AND item_id=? AND revision<? AND state<>'completed'",
      this.scope.tenantId,
      this.scope.confidentialScopeId,
      itemId,
      revision,
    );
    const inputs = evidence
      .map((e) => ({ id: e.id, hash: e.content_hash }))
      .sort((a, b) => String(a.id).localeCompare(String(b.id)));
    const [analysis] = await this.insert(db, 'intake_analyses', {
      item_id: itemId,
      revision,
      fence: 0,
      attempt_number: 0,
      current_attempt_id: null,
      state: 'queued',
      input_digest: digest({ inputs, configuration }),
      data: canonical({ inputs, configuration, requestKey, configDigest }),
    });
    await db.query(
      "UPDATE intake_items SET analysis_revision=?,processing_state='queued' WHERE tenant_id=? AND confidential_scope_id=? AND id=?",
      revision,
      this.scope.tenantId,
      this.scope.confidentialScopeId,
      itemId,
    );
    await this.insert(
      db,
      'intake_dispatches',
      {
        item_id: itemId,
        stage: 'analyze',
        revision,
        state:
          object(item.data).dispatch === 'inline' ? 'completed' : 'pending',
        job_id: '',
        deliveries: 0,
        data: canonical({ dispatchTarget: this.dispatchTarget }),
      },
      'tenant_id,item_id,stage,revision',
    );
    return { id: String(analysis.id), revision };
  }
  /** Run one fenced stage in-process and reload its terminal projection. */
  private async inlineStage(
    itemId: string,
    revision: number,
    work: (lease: AnalysisLease) => Promise<unknown>,
  ): Promise<InlineInterpretation['extraction']> {
    const lease = await this.claimAnalysis(itemId, revision, 'inline');
    if (lease) await work(lease);
    return this.tx(async (db) => {
      await this.lock(db, itemId);
      await this.item(itemId, 'process', db);
      const [analysis] = await this.rows(
        db,
        'intake_analyses',
        'item_id=? AND revision=?',
        [itemId, revision],
      );
      if (!analysis) throw new Error('Analysis unavailable');
      const [attempt] = analysis.current_attempt_id
        ? await this.rows(
            db,
            'intake_analysis_attempts',
            'id=? AND item_id=?',
            [analysis.current_attempt_id, itemId],
          )
        : [];
      if (
        !attempt ||
        !['completed', 'partial', 'needs_attention', 'failed'].includes(
          String(attempt.state),
        )
      )
        throw new Error('Inline interpretation busy');
      return {
        analysisId: String(analysis.id),
        revision,
        attemptId: String(attempt.id),
        state: String(
          attempt.state,
        ) as InlineInterpretation['extraction']['state'],
        error: attempt.safe_error
          ? (String(attempt.safe_error) as IntakeFailure)
          : null,
      };
    });
  }
  /** Documented in-process receive-to-proposals path for `dispatch: 'inline'`
   * receipts. Extraction (UTF-8 text/structured only) and interpretation use the
   * same immutable revisions, fenced leases, catalog-live checks, provenance and
   * failure categories as the job path; no queue intent is created or delivered. */
  async interpretInline(
    itemId: string,
    input: InlineInterpretationInput,
  ): Promise<InlineInterpretation> {
    nonempty(input.requestId);
    if (!storableText(input.requestId))
      throw new Error('Invalid intake identifier');
    if (
      typeof input.extraction?.configurationRevision !== 'string' ||
      !input.extraction.configurationRevision ||
      !storableText(input.extraction.configurationRevision)
    )
      throw new Error('Invalid extraction configuration');
    const item = await this.item(itemId, 'process');
    if (object(item.data).dispatch !== 'inline')
      throw new Error('Inline interpretation requires an inline receipt');
    const extraction = {
      configurationRevision: input.extraction.configurationRevision,
      limits: structuredClone(input.extraction.limits),
    };
    const requested = await this.analyze(
      itemId,
      { stage: 'extract', extraction },
      `inline:extract:${input.requestId}`,
    );
    const extracted = await this.inlineStage(
      itemId,
      requested.revision,
      (lease) =>
        extractAnalysis(
          this,
          lease,
          { extract: (request) => extractWithProviders(request, {}) },
          extraction,
        ),
    );
    if (!['completed', 'partial'].includes(extracted.state))
      return { itemId, extraction: extracted };
    const interpretKey = `inline:interpret:${input.requestId}`;
    // A retried request replays its immutable interpretation revision instead
    // of preparing against a source that is no longer the current revision.
    const interpretation =
      (await this.analysisByRequest(itemId, interpretKey)) ??
      (await this.appendInterpretation(
        itemId,
        extracted.attemptId,
        interpretKey,
      ));
    const generation = await this.inlineStage(
      itemId,
      interpretation.revision,
      (lease) => this.generateProposals(lease),
    );
    if (!['completed', 'partial'].includes(generation.state))
      return { itemId, extraction: extracted, generation };
    return {
      itemId,
      extraction: extracted,
      generation,
      analysis: await this.getCompletedAnalysis(itemId, generation.attemptId),
    };
  }
  /** Prepare outside the lock (it reads catalog and analysis), then append
   * under it with the source pin rechecked. A concurrent identical request
   * that appended first makes preparation fail; its revision is the replay. */
  private async appendInterpretation(
    itemId: string,
    sourceAttemptId: string,
    requestKey: string,
  ): Promise<{ id: string; revision: number }> {
    await this.point('inline:replay-miss');
    let configuration: Record<string, unknown>;
    try {
      configuration = structuredClone(
        await this.prepareGeneration(itemId, sourceAttemptId),
      );
    } catch (error) {
      const replay = await this.analysisByRequest(itemId, requestKey);
      if (replay) return replay;
      throw error;
    }
    await this.point('inline:prepared');
    return this.tx((db) =>
      this.appendAnalysis(
        db,
        itemId,
        configuration,
        requestKey,
        sourceAttemptId,
      ),
    );
  }
  private async analysisByRequest(
    itemId: string,
    requestKey: string,
  ): Promise<{ id: string; revision: number } | null> {
    const found = (
      await this.rows(this.db, 'intake_analyses', 'item_id=?', [itemId])
    ).find((row) => object(row.data).requestKey === requestKey);
    return found
      ? { id: String(found.id), revision: Number(found.revision) }
      : null;
  }
  /** Owner-lifecycle hook: expire every active receipt bound to a deleted owner
   * through the ordinary revoke-then-delete path. Returns the number scheduled. */
  async expireOwned(owner: IntakeOwner): Promise<number> {
    const key = ownerKey(owner);
    const items = await this.rows(
      this.db,
      'intake_items',
      "owner_key=? AND visibility='active'",
      [key],
    );
    try {
      for (const item of items) await this.scheduleExpiry(String(item.id));
    } catch (error) {
      try {
        await this.repairDeletions();
      } catch {
        // Durable intents remain available to the next authorized repair.
      }
      throw error;
    }
    await this.repairDeletions();
    return items.length;
  }

  /** Record an authenticated split correction and queue fresh extraction, never copy model output. */
  async reviseLogicalSplit(
    input: LogicalSplitInput,
  ): Promise<{ id: string; revision: number }> {
    const frozen = structuredClone(input);
    nonempty(frozen.requestId);
    integer(frozen.expectedRevision);
    if (
      !Array.isArray(frozen.groups) ||
      !frozen.groups.length ||
      frozen.groups.length > 100 ||
      frozen.groups.some(
        (group) =>
          !Array.isArray(group) ||
          !group.length ||
          group.length > 1000 ||
          group.some((page) => !Number.isSafeInteger(page) || page < 1),
      )
    )
      throw new Error('Invalid logical split');
    const pages = frozen.groups.flat();
    if (pages.length > 1000 || new Set(pages).size !== pages.length)
      throw new Error('Invalid logical split');
    const requestKey = `split:${frozen.requestId}`;
    const correction = {
      ...frozen,
      actorId: this.scope.actorId,
      kind: 'logical_split',
    };
    const replay = await this.tx(async (db) => {
      await this.lock(db, frozen.itemId);
      await this.item(frozen.itemId, 'process', db);
      await this.assertUnresolved(db, frozen.itemId);
      const found = (
        await this.rows(db, 'intake_analyses', 'item_id=?', [frozen.itemId])
      ).find((row) => object(row.data).requestKey === requestKey);
      if (!found) return null;
      if (
        digest(object(object(found.data).configuration).humanCorrection) !==
        digest(correction)
      )
        throw new Error('Split request conflict');
      return { id: String(found.id), revision: Number(found.revision) };
    });
    if (replay) {
      // Idempotency acknowledges only an intent the current reviewer may still access.
      await (await this.proposalReader())[generationSnapshotRead](
        frozen.itemId,
        (work) => this.tx(work),
        (db) =>
          this.completedAnalysisSnapshot(
            db,
            frozen.itemId,
            frozen.attemptId,
            false,
          ),
        undefined,
        true,
      );
      return replay;
    }
    await this.point('split:checked');
    let result: { id: string; revision: number } | undefined;
    await (await this.proposalReader())[generationSnapshotRead](
      frozen.itemId,
      (work) => this.tx(work),
      // Read the anchor without requiring it to be current: a concurrent
      // duplicate must reach the locked replay check below instead of failing
      // the read. Currency is enforced under the lock instead.
      (db) =>
        this.completedAnalysisSnapshot(
          db,
          frozen.itemId,
          frozen.attemptId,
          false,
        ),
      async (db, current) => {
        // Every guard read and the append run under the item lock in this one
        // transaction (the snapshot read above already took it; re-asserting it
        // keeps the invariant local to this step).
        await this.lock(db, frozen.itemId);
        await this.point('split:locked');
        const [found] = (
          await this.rows(db, 'intake_analyses', 'item_id=?', [frozen.itemId])
        ).filter((row) => object(row.data).requestKey === requestKey);
        if (found) {
          // A duplicate that committed after our unlocked replay check.
          if (
            digest(object(object(found.data).configuration).humanCorrection) !==
            digest(correction)
          )
            throw new Error('Split request conflict');
          result = { id: String(found.id), revision: Number(found.revision) };
          return;
        }
        const item = await this.item(frozen.itemId, 'process', db);
        if (
          current.revision !== frozen.expectedRevision ||
          Number(item.analysis_revision) !== frozen.expectedRevision
        )
          throw new Error('Stale logical split');
        const pin = object(object(current.configuration.proposals).source);
        const source = await this.completedAnalysisSnapshot(
          db,
          frozen.itemId,
          String(pin.attemptId),
          false,
        );
        for (const key of [
          'attemptId',
          'revision',
          'inputDigest',
          'outputDigest',
          'evidenceDigest',
        ] as const)
          if (pin[key] !== source[key]) throw new Error('Split source changed');
        const extraction = source.result.output.results;
        if (!Array.isArray(extraction))
          throw new Error('Split source unavailable');
        const evidence = extraction.find(
          (value) => object(object(value).evidence).id === frozen.evidenceId,
        );
        if (!evidence) throw new Error('Split evidence unavailable');
        const observed = new Set<number>();
        for (const value of object(evidence).segments as unknown[]) {
          const location = object(object(value).location);
          if (location.kind === 'page') observed.add(Number(location.page));
          if (location.kind === 'pages') {
            const from = Number(location.startPage),
              to = Number(location.endPage);
            if (
              !Number.isSafeInteger(from) ||
              !Number.isSafeInteger(to) ||
              to - from > 1000
            )
              throw new Error('Invalid source range');
            for (let page = from; page <= to; page++) observed.add(page);
          }
        }
        if (
          !observed.size ||
          pages.length !== observed.size ||
          pages.some((page) => !observed.has(page))
        )
          throw new Error('Split must cover observed pages exactly');
        await this.point('split:guarded');
        // Re-extraction retains the supported immediate-predecessor interpretation pin.
        result = await this.appendAnalysis(
          db,
          frozen.itemId,
          { ...source.configuration, humanCorrection: correction },
          requestKey,
        );
      },
      true,
    );
    if (!result) throw new Error('Split unavailable');
    return result;
  }
  /**
   * Record an authenticated reviewer instruction as an immutable human correction
   * and queue a fresh extraction plus interpretation that carries it as trusted
   * guidance. The text steers the model only; it never changes the catalog,
   * candidates, schemas, permissions or automation eligibility.
   */
  async recordReviewerInstruction(input: ReviewerInstructionInput): Promise<{
    id: string;
    revision: number;
    instruction: ReviewerInstruction;
  }> {
    const frozen = structuredClone(input);
    nonempty(frozen.requestId);
    nonempty(frozen.attemptId);
    integer(frozen.expectedRevision);
    if (
      typeof frozen.text !== 'string' ||
      !frozen.text.trim() ||
      frozen.text.length > REVIEWER_INSTRUCTION_MAX_LENGTH
    )
      throw new ReviewerInstructionInvalidError();
    const requestKey = `instruction:${frozen.requestId}`;
    const intent = {
      kind: 'reviewer_instruction',
      itemId: frozen.itemId,
      attemptId: frozen.attemptId,
      expectedRevision: frozen.expectedRevision,
      requestId: frozen.requestId,
      actorId: this.scope.actorId,
      text: frozen.text,
    };
    const replayIntent = (record: Record<string, unknown>) => {
      const {
        id: _id,
        recordedAt: _recordedAt,
        supersedesId: _supersedesId,
        digest: _digest,
        ...rest
      } = record;
      return rest;
    };
    const replay = await this.tx(async (db) => {
      await this.lock(db, frozen.itemId);
      await this.item(frozen.itemId, 'process', db);
      const found = (
        await this.rows(db, 'intake_analyses', 'item_id=?', [frozen.itemId])
      ).find((row) => object(row.data).requestKey === requestKey);
      if (!found) return null;
      const record = object(
        object(object(found.data).configuration).reviewerInstruction,
      );
      if (digest(replayIntent(record)) !== digest(intent))
        throw new Error('Reviewer instruction request conflict');
      return {
        id: String(found.id),
        revision: Number(found.revision),
        instruction: reviewerInstructionView(record),
      };
    });
    if (replay) {
      // Idempotency acknowledges only an intent the current reviewer may still access.
      await (await this.proposalReader())[generationSnapshotRead](
        frozen.itemId,
        (work) => this.tx(work),
        (db) =>
          this.completedAnalysisSnapshot(
            db,
            frozen.itemId,
            frozen.attemptId,
            false,
          ),
        undefined,
        true,
      );
      return replay;
    }
    await this.point('instruction:checked');
    let result:
      | { id: string; revision: number; instruction: ReviewerInstruction }
      | undefined;
    await (await this.proposalReader())[generationSnapshotRead](
      frozen.itemId,
      (work) => this.tx(work),
      // The anchor may be historical: after a failed reinterpretation the
      // reviewer retries against the latest completed generation.
      (db) =>
        this.completedAnalysisSnapshot(
          db,
          frozen.itemId,
          frozen.attemptId,
          false,
        ),
      async (db, current) => {
        // Every guard read, the history read for supersedesId and the append
        // run under the item lock in this one transaction (the snapshot read
        // above already took it; re-asserting it keeps the invariant local).
        await this.lock(db, frozen.itemId);
        await this.point('instruction:locked');
        const [found] = (
          await this.rows(db, 'intake_analyses', 'item_id=?', [frozen.itemId])
        ).filter((row) => object(row.data).requestKey === requestKey);
        if (found) {
          // A duplicate (double-click) that committed after our unlocked
          // replay check: replay it rather than refusing.
          const record = object(
            object(object(found.data).configuration).reviewerInstruction,
          );
          if (digest(replayIntent(record)) !== digest(intent))
            throw new Error('Reviewer instruction request conflict');
          result = {
            id: String(found.id),
            revision: Number(found.revision),
            instruction: reviewerInstructionView(record),
          };
          return;
        }
        const item = await this.item(frozen.itemId, 'process', db);
        if (Number(item.analysis_revision) !== frozen.expectedRevision)
          throw new ReviewerInstructionStaleError();
        let carriedConfiguration: Record<string, unknown> | undefined;
        if (current.revision !== frozen.expectedRevision) {
          // The same predicate drives getReinterpretationState, so the review
          // UI and this guard always agree on "in flight".
          const later = await this.laterWork(db, item, current.revision);
          if (later.phase === 'in_flight' || later.phase === 'superseded')
            throw new ReviewerInstructionStaleError();
          carriedConfiguration = later.configuration;
        }
        const pin = object(object(current.configuration.proposals).source);
        const source = await this.completedAnalysisSnapshot(
          db,
          frozen.itemId,
          String(pin.attemptId),
          false,
        );
        for (const key of [
          'attemptId',
          'revision',
          'inputDigest',
          'outputDigest',
          'evidenceDigest',
        ] as const)
          if (pin[key] !== source[key])
            throw new Error('Instruction source changed');
        // Supersede the latest recorded instruction, even one whose
        // reinterpretation never completed; the ledger, not the anchor, is history.
        const [previous] = await this.recordedInstructions(db, frozen.itemId);
        const body = {
          ...intent,
          id: randomUUID(),
          recordedAt: date(this.now()),
          supersedesId: previous?.id ?? null,
        };
        const record = { ...body, digest: digest(body) };
        await this.point('instruction:guarded');
        // Re-extraction retains the supported immediate-predecessor interpretation pin
        // and any existing split correction; the instruction travels beside it.
        const appended = await this.appendAnalysis(
          db,
          frozen.itemId,
          {
            ...(carriedConfiguration ?? source.configuration),
            reviewerInstruction: record,
          },
          requestKey,
        );
        result = { ...appended, instruction: reviewerInstructionView(record) };
      },
      true,
    );
    if (!result) throw new Error('Reviewer instruction unavailable');
    return result;
  }
  /**
   * How the revisions after an anchor generation relate to it. Shared by the
   * retry guard and getReinterpretationState so they cannot disagree.
   * A completed extraction with no interpretation appended is in flight until
   * its attempt's completion plus the item's analysis lease duration
   * (`limits.leaseMs`, the same lease claimAnalysis grants); after that it is
   * treated as a reinterpretation that did not start.
   */
  private async laterWork(
    db: DatabaseInterface,
    item: Row,
    anchorRevision: number,
  ): Promise<{
    phase: 'none' | 'in_flight' | 'superseded' | 'failed';
    failure: IntakeFailure | 'not_started' | null;
    configuration: Record<string, unknown> | undefined;
  }> {
    const later = (
      await this.rows(db, 'intake_analyses', 'item_id=? AND revision>?', [
        String(item.id),
        anchorRevision,
      ])
    ).sort((a, b) => Number(b.revision) - Number(a.revision));
    const stage = (row: Row) => object(object(row.data).configuration).stage;
    // The newest later extraction's configuration is the item's current one:
    // corrections chain forward through it, and a host reprocess replaces it
    // (dropping corrections). A retry from an older anchor builds on it so it
    // neither reverts a reprocess nor drops or resurrects a split.
    const newestExtraction = later.find((row) => stage(row) !== 'interpret');
    const configuration = newestExtraction
      ? object(object(newestExtraction.data).configuration)
      : undefined;
    const [latest] = later;
    if (!latest) return { phase: 'none', failure: null, configuration };
    if (
      later.some(
        (row) =>
          ['completed', 'partial'].includes(String(row.state)) &&
          stage(row) === 'interpret',
      )
    )
      return { phase: 'superseded', failure: null, configuration };
    if (later.some((row) => ['queued', 'running'].includes(String(row.state))))
      return { phase: 'in_flight', failure: null, configuration };
    const [attempt] = latest.current_attempt_id
      ? await this.rows(db, 'intake_analysis_attempts', 'id=? AND item_id=?', [
          latest.current_attempt_id,
          String(item.id),
        ])
      : [];
    if (['completed', 'partial'].includes(String(latest.state))) {
      // Extraction done, interpretation not appended: between stages.
      const completedAt = attempt
        ? object(attempt.data).completedAt
        : undefined;
      const leaseMs = Number(object(object(item.data).limits).leaseMs);
      // Missing or malformed timing cannot hold retries forever: it counts as
      // already expired, which is safe because a late append is refused.
      const started =
        typeof completedAt === 'string'
          ? persistedDate(completedAt).getTime()
          : Number.NaN;
      const deadline =
        Number.isFinite(started) && Number.isFinite(leaseMs)
          ? started + leaseMs
          : Number.NEGATIVE_INFINITY;
      return this.now().getTime() <= deadline
        ? { phase: 'in_flight', failure: null, configuration }
        : { phase: 'failed', failure: 'not_started', configuration };
    }
    const safe = attempt?.safe_error ? String(attempt.safe_error) : '';
    return {
      phase: 'failed',
      failure: failures.has(safe) ? (safe as IntakeFailure) : null,
      configuration,
    };
  }
  /** Pollable reinterpretation state: current revision, safe failure and the retry anchor. */
  async getReinterpretationState(itemId: string): Promise<{
    revision: number;
    processingState: string;
    /** Safe category, or `not_started` when the interpretation was never appended in time. */
    failure: IntakeFailure | 'not_started' | null;
    /** True while work after the latest completed generation is in flight, including between stages. */
    reinterpreting: boolean;
    /** Latest completed generation attempt; absent when none has completed. */
    generationAttemptId: string | null;
    /**
     * Id of the instruction carried by the item's newest extraction (verified
     * by digest), or null. A host reprocess builds its own configuration and
     * cannot carry human corrections, so it drops the instruction exactly as
     * it drops a split.
     */
    instructionInEffect: string | null;
  }> {
    const item = await this.item(itemId, 'read');
    const analyses = (
      await this.rows(this.db, 'intake_analyses', 'item_id=?', [itemId])
    ).sort((a, b) => Number(b.revision) - Number(a.revision));
    const generation = analyses.find(
      (row) =>
        ['completed', 'partial'].includes(String(row.state)) &&
        row.current_attempt_id &&
        object(object(row.data).configuration).stage === 'interpret',
    );
    let failure: IntakeFailure | 'not_started' | null = null;
    let reinterpreting = false;
    if (generation) {
      const later = await this.laterWork(
        this.db,
        item,
        Number(generation.revision),
      );
      failure = later.failure;
      reinterpreting = later.phase === 'in_flight';
    } else {
      const latest = analyses[0];
      reinterpreting = ['queued', 'running'].includes(String(latest?.state));
      if (
        latest &&
        String(latest.state) === 'needs_attention' &&
        latest.current_attempt_id
      ) {
        const [attempt] = await this.rows(
          this.db,
          'intake_analysis_attempts',
          'id=? AND item_id=?',
          [latest.current_attempt_id, itemId],
        );
        if (attempt?.safe_error && failures.has(String(attempt.safe_error)))
          failure = String(attempt.safe_error) as IntakeFailure;
      }
    }
    const newestExtraction = analyses.find(
      (row) => object(object(row.data).configuration).stage !== 'interpret',
    );
    const carried = newestExtraction
      ? object(object(newestExtraction.data).configuration).reviewerInstruction
      : undefined;
    const instructionInEffect = carried
      ? reviewerInstructionView(carried).id
      : null;
    await this.item(itemId, 'read');
    return {
      revision: Number(item.analysis_revision),
      processingState: String(item.processing_state),
      failure,
      reinterpreting,
      instructionInEffect,
      generationAttemptId: generation
        ? String(generation.current_attempt_id)
        : null,
    };
  }
  /** Immutable instruction history, newest first. History is never deleted. */
  async listReviewerInstructions(
    itemId: string,
  ): Promise<ReviewerInstruction[]> {
    await this.item(itemId, 'read');
    const history = await this.recordedInstructions(this.db, itemId);
    await this.item(itemId, 'read');
    return history;
  }
  private async recordedInstructions(
    db: DatabaseInterface,
    itemId: string,
  ): Promise<ReviewerInstruction[]> {
    const rows = await this.rows(db, 'intake_analyses', 'item_id=?', [itemId]);
    const seen = new Set<string>();
    const history: ReviewerInstruction[] = [];
    for (const row of rows.sort(
      (a, b) => Number(b.revision) - Number(a.revision),
    )) {
      const configuration = object(object(row.data).configuration);
      // Only the authenticated mint writes an extraction-stage record; interpret
      // copies are verified against it separately and never define history.
      if (
        configuration.stage === 'interpret' ||
        !configuration.reviewerInstruction
      )
        continue;
      const instruction = reviewerInstructionView(
        configuration.reviewerInstruction,
      );
      if (seen.has(instruction.id)) continue;
      seen.add(instruction.id);
      history.push(instruction);
    }
    return history;
  }
  /** Allocate a fenced attempt; active leases cannot be stolen before expiry. */
  async claimAnalysis(
    itemId: string,
    revision: number,
    workerId: string,
  ): Promise<AnalysisLease | null> {
    integer(revision);
    nonempty(workerId);
    return this.tx(async (db) => {
      await this.lock(db, itemId);
      const item = await this.item(itemId, 'process', db);
      if (
        item.cancelled ||
        item.receipt_state !== 'ready' ||
        Number(item.analysis_revision) !== revision ||
        // A resolved item is terminal; its provider is never called again.
        (await this.rows(db, 'intake_dispositions', 'item_id=?', [itemId]))
          .length
      )
        return null;
      const [analysis] = await this.rows(
        db,
        'intake_analyses',
        'item_id=? AND revision=?',
        [itemId, revision],
      );
      if (
        !analysis ||
        ['completed', 'partial'].includes(String(analysis.state))
      )
        return null;
      const limits = object(
        object(item.data).limits,
      ) as unknown as IntakeLimits;
      const attempts = await this.rows(
        db,
        'intake_analysis_attempts',
        'analysis_id=?',
        [analysis.id],
      );
      const prior = attempts.find((a) => a.id === analysis.current_attempt_id);
      if (
        prior?.state === 'running' &&
        persistedDate(prior.lease_until) > this.now()
      )
        return null;
      if (Number(analysis.attempt_number) >= limits.maxAttempts) {
        if (prior?.state === 'running')
          await db.query(
            "UPDATE intake_analysis_attempts SET state='needs_attention',safe_error='limit' WHERE tenant_id=? AND confidential_scope_id=? AND id=?",
            this.scope.tenantId,
            this.scope.confidentialScopeId,
            prior.id,
          );
        await db.query(
          "UPDATE intake_analyses SET state='needs_attention' WHERE tenant_id=? AND confidential_scope_id=? AND id=?",
          this.scope.tenantId,
          this.scope.confidentialScopeId,
          analysis.id,
        );
        await db.query(
          "UPDATE intake_items SET processing_state='needs_attention' WHERE tenant_id=? AND confidential_scope_id=? AND id=? AND analysis_revision=?",
          this.scope.tenantId,
          this.scope.confidentialScopeId,
          itemId,
          revision,
        );
        await db.query(
          "UPDATE intake_dispatches SET state='completed' WHERE tenant_id=? AND confidential_scope_id=? AND item_id=? AND revision=?",
          this.scope.tenantId,
          this.scope.confidentialScopeId,
          itemId,
          revision,
        );
        return null;
      }
      if (prior && ['running', 'queued'].includes(String(prior.state)))
        await db.query(
          "UPDATE intake_analysis_attempts SET state='superseded' WHERE tenant_id=? AND confidential_scope_id=? AND id=?",
          this.scope.tenantId,
          this.scope.confidentialScopeId,
          prior.id,
        );
      const fence = Number(analysis.fence) + 1;
      const attempt = Number(analysis.attempt_number) + 1;
      const token = randomUUID();
      const [row] = await this.insert(db, 'intake_analysis_attempts', {
        item_id: itemId,
        analysis_id: analysis.id,
        attempt_number: attempt,
        fence,
        state: 'running',
        lease_token: token,
        lease_until: new Date(
          this.now().getTime() + limits.leaseMs,
        ).toISOString(),
        output_digest: '',
        safe_error: '',
        confidence: null,
        data: canonical({
          workerId,
          startedAt: this.now().toISOString(),
          limits,
        }),
      });
      await db.query(
        "UPDATE intake_analyses SET fence=?,attempt_number=?,current_attempt_id=?,state='running' WHERE tenant_id=? AND confidential_scope_id=? AND id=?",
        fence,
        attempt,
        row.id,
        this.scope.tenantId,
        this.scope.confidentialScopeId,
        analysis.id,
      );
      await db.query(
        "UPDATE intake_items SET processing_state='running' WHERE tenant_id=? AND confidential_scope_id=? AND id=?",
        this.scope.tenantId,
        this.scope.confidentialScopeId,
        itemId,
      );
      return {
        itemId,
        analysisId: String(analysis.id),
        attemptId: String(row.id),
        revision,
        fence,
        token,
      };
    });
  }
  private async completedAnalysisSnapshot(
    db: DatabaseInterface,
    itemId: string,
    attemptId: string | undefined,
    current: boolean,
  ): Promise<CompletedAnalysisSnapshot> {
    await this.lock(db, itemId);
    const item = await this.item(itemId, 'process', db);
    if (item.cancelled) throw new Error('Analysis unavailable');
    if (attemptId === undefined) {
      if (!current) throw new Error('Historical attempt required');
      const [latest] = await this.rows(
        db,
        'intake_analyses',
        'item_id=? AND revision=?',
        [itemId, item.analysis_revision],
      );
      if (!latest?.current_attempt_id) throw new Error('Analysis unavailable');
      attemptId = String(latest.current_attempt_id);
    }

    const [attempt] = await this.rows(
      db,
      'intake_analysis_attempts',
      'item_id=? AND id=?',
      [itemId, attemptId],
    );
    if (
      !attempt ||
      !['completed', 'partial'].includes(String(attempt.state)) ||
      !attempt.output_digest
    )
      throw new Error('Analysis unavailable');
    const [analysis] = await this.rows(
      db,
      'intake_analyses',
      'item_id=? AND id=?',
      [itemId, attempt.analysis_id],
    );
    if (
      !analysis ||
      analysis.current_attempt_id !== attemptId ||
      (current && Number(item.analysis_revision) !== Number(analysis.revision))
    )
      throw new Error('Analysis unavailable');
    const data = object(analysis.data);
    const configuration = object(data.configuration);
    if (
      !Array.isArray(data.inputs) ||
      !data.inputs.length ||
      digest({ inputs: data.inputs, configuration }) !==
        analysis.input_digest ||
      digest(configuration) !== data.configDigest
    )
      throw new Error('Analysis input integrity');
    const resultData = object(attempt.data);
    const result = {
      status: resultData.status,
      provider: resultData.provider,
      model: resultData.model,
      version: resultData.version,
      output: resultData.output,
      usage: resultData.usage,
      ...(Object.hasOwn(resultData, 'error')
        ? { error: resultData.error }
        : {}),
      ...(Object.hasOwn(resultData, 'confidence')
        ? { confidence: resultData.confidence }
        : {}),
    } as AnalysisOutput;
    if (
      result.status !== attempt.state ||
      digest(result) !== attempt.output_digest
    )
      throw new Error('Analysis output integrity');
    const evidence: IntakeEvidenceDTO[] = [];
    for (const input of data.inputs) {
      const frozen = object(input);
      const [row] = await this.rows(
        db,
        'intake_evidence',
        "item_id=? AND id=? AND state='durable'",
        [itemId, frozen.id],
      );
      if (!row || row.content_hash !== frozen.hash)
        throw new Error('Analysis input integrity');
      evidence.push({
        id: String(row.id),
        partId: String(row.part_id),
        parentEvidenceId: row.parent_evidence_id
          ? String(row.parent_evidence_id)
          : null,
        mediaType: String(row.media_type),
        contentHash: String(row.content_hash),
        byteLength: Number(row.byte_length),
      });
    }
    if (new Set(evidence.map((entry) => entry.id)).size !== evidence.length)
      throw new Error('Analysis input integrity');
    await this.item(itemId, 'process', db);
    return structuredClone({
      itemId,
      attemptId,
      revision: Number(analysis.revision),
      inputDigest: String(analysis.input_digest),
      outputDigest: String(attempt.output_digest),
      evidenceDigest: digest(data.inputs),
      configuration,
      evidence,
      result,
    });
  }
  /** Detached successful current revision; always current-scope/process authorized. */
  async getCompletedAnalysis(
    itemId: string,
    attemptId?: string,
  ): Promise<CompletedAnalysisSnapshot> {
    const snapshot = await this.tx((db) =>
      this.completedAnalysisSnapshot(db, itemId, attemptId, true),
    );
    await this.point('analysis:snapshot-read');
    const read = async (db: DatabaseInterface) => {
      const current = await this.completedAnalysisSnapshot(
        db,
        itemId,
        snapshot.attemptId,
        true,
      );
      if (
        current.inputDigest !== snapshot.inputDigest ||
        current.outputDigest !== snapshot.outputDigest
      )
        throw new Error('Analysis changed');
      return current;
    };
    if (snapshot.configuration.stage === 'interpret')
      return (await this.proposalReader())[generationSnapshotRead](
        itemId,
        (work) => this.tx(work),
        read,
      );
    return this.tx(read);
  }
  /** Historical source is readable only through its frozen pin on a live generation lease. */
  async getGenerationInput(lease: AnalysisLease) {
    const generation = await this.getAnalysisInput(lease);
    const configuration = generation.configuration;
    const pin = object(object(configuration.proposals).source);
    if (
      configuration.stage !== 'interpret' ||
      typeof pin.attemptId !== 'string'
    )
      throw new Error('Invalid generation source');
    const source = await this.tx((db) =>
      this.completedAnalysisSnapshot(
        db,
        lease.itemId,
        String(pin.attemptId),
        false,
      ),
    );
    for (const key of [
      'attemptId',
      'revision',
      'inputDigest',
      'outputDigest',
      'evidenceDigest',
    ] as const)
      if (pin[key] !== source[key])
        throw new Error('Generation source changed');
    if (
      source.result.provider !== 'smrt-ingestion-extraction' ||
      source.configuration.stage === 'interpret' ||
      source.revision !== generation.revision - 1 ||
      digest(configuration.humanCorrection ?? null) !==
        digest(source.configuration.humanCorrection ?? null) ||
      digest(configuration.reviewerInstruction ?? null) !==
        digest(source.configuration.reviewerInstruction ?? null) ||
      digest(
        generation.evidence.map((entry) => ({
          id: entry.id,
          hash: entry.contentHash,
        })),
      ) !== source.evidenceDigest
    )
      throw new Error('Generation evidence changed');
    await this.getAnalysisInput(lease);
    return { generation, source };
  }
  /** Reload immutable inputs only through the current live processing lease. */
  async getAnalysisInput(lease: AnalysisLease): Promise<{
    revision: number;
    attemptId: string;
    fence: number;
    inputDigest: string;
    maxOutputBytes: number;
    configuration: Record<string, unknown>;
    evidence: IntakeEvidenceDTO[];
  }> {
    return this.tx(async (db) => {
      await this.lock(db, lease.itemId);
      const item = await this.item(lease.itemId, 'process', db);
      if (item.cancelled || Number(item.analysis_revision) !== lease.revision)
        throw new Error('Analysis lease unavailable');
      const [analysis] = await this.rows(
        db,
        'intake_analyses',
        'id=? AND item_id=?',
        [lease.analysisId, lease.itemId],
      );
      const [attempt] = await this.rows(
        db,
        'intake_analysis_attempts',
        'id=? AND analysis_id=? AND item_id=?',
        [lease.attemptId, lease.analysisId, lease.itemId],
      );
      if (
        !analysis ||
        !attempt ||
        Number(analysis.revision) !== lease.revision ||
        analysis.current_attempt_id !== lease.attemptId ||
        Number(analysis.fence) !== lease.fence ||
        Number(attempt.fence) !== lease.fence ||
        attempt.state !== 'running' ||
        attempt.lease_token !== lease.token ||
        persistedDate(attempt.lease_until) <= this.now()
      )
        throw new Error('Analysis lease unavailable');
      const data = object(analysis.data);
      const configuration = object(data.configuration);
      if (
        !Array.isArray(data.inputs) ||
        !data.inputs.length ||
        digest({ inputs: data.inputs, configuration }) !==
          analysis.input_digest ||
        digest(configuration) !== data.configDigest
      )
        throw new Error('Analysis input integrity');
      const evidence: IntakeEvidenceDTO[] = [];
      for (const input of data.inputs) {
        const frozen = object(input);
        const [row] = await this.rows(
          db,
          'intake_evidence',
          "item_id=? AND id=? AND state='durable'",
          [lease.itemId, frozen.id],
        );
        if (!row || row.content_hash !== frozen.hash)
          throw new Error('Analysis input integrity');
        evidence.push({
          id: String(row.id),
          partId: String(row.part_id),
          parentEvidenceId: row.parent_evidence_id
            ? String(row.parent_evidence_id)
            : null,
          mediaType: String(row.media_type),
          contentHash: String(row.content_hash),
          byteLength: Number(row.byte_length),
        });
      }
      if (new Set(evidence.map((entry) => entry.id)).size !== evidence.length)
        throw new Error('Analysis input integrity');
      return {
        revision: lease.revision,
        attemptId: lease.attemptId,
        fence: lease.fence,
        inputDigest: String(analysis.input_digest),
        maxOutputBytes: Number(object(object(item.data).limits).maxOutputBytes),
        configuration,
        evidence,
      };
    });
  }
  /** Publish once, only through the current unexpired fence and captured scope. */
  async completeAnalysis(
    lease: AnalysisLease,
    output: AnalysisOutput,
  ): Promise<boolean> {
    if (
      !['completed', 'partial', 'failed', 'needs_attention'].includes(
        output.status,
      ) ||
      !output.provider ||
      !output.model ||
      !output.version ||
      (output.error && !failures.has(output.error))
    )
      throw new Error('Invalid analysis output');
    if (
      output.confidence !== undefined &&
      (!Number.isFinite(output.confidence) ||
        output.confidence < 0 ||
        output.confidence > 1)
    )
      throw new Error('Invalid confidence');
    for (const value of Object.values(output.usage))
      if (!Number.isFinite(value) || value < 0)
        throw new Error('Invalid usage');
    const serialized = canonical(output);
    const outputDigest = digest(output);
    return this.tx(async (db) => {
      await this.lock(db, lease.itemId);
      const item = await this.item(lease.itemId, 'process', db);
      if (item.cancelled || Number(item.analysis_revision) !== lease.revision)
        return false;
      const limits = object(
        object(item.data).limits,
      ) as unknown as IntakeLimits;
      if (Buffer.byteLength(serialized) > limits.maxOutputBytes)
        throw new Error('Analysis output budget exceeded');
      const [analysis] = await this.rows(
        db,
        'intake_analyses',
        'id=? AND item_id=?',
        [lease.analysisId, lease.itemId],
      );
      if (
        !analysis ||
        analysis.current_attempt_id !== lease.attemptId ||
        Number(analysis.fence) !== lease.fence
      )
        return false;
      const [attempt] = await this.rows(
        db,
        'intake_analysis_attempts',
        'id=? AND analysis_id=?',
        [lease.attemptId, lease.analysisId],
      );
      if (
        !attempt ||
        attempt.state !== 'running' ||
        attempt.lease_token !== lease.token ||
        persistedDate(attempt.lease_until) <= this.now()
      )
        return false;
      const attemptData = {
        ...object(attempt.data),
        ...output,
        completedAt: this.now().toISOString(),
      };
      await db.query(
        'UPDATE intake_analysis_attempts SET state=?,output_digest=?,safe_error=?,confidence=?,data=? WHERE tenant_id=? AND confidential_scope_id=? AND id=?',
        output.status,
        outputDigest,
        output.error ?? '',
        output.confidence ?? null,
        canonical(attemptData),
        this.scope.tenantId,
        this.scope.confidentialScopeId,
        lease.attemptId,
      );
      await db.query(
        'UPDATE intake_analyses SET state=? WHERE tenant_id=? AND confidential_scope_id=? AND id=?',
        output.status,
        this.scope.tenantId,
        this.scope.confidentialScopeId,
        lease.analysisId,
      );
      await db.query(
        'UPDATE intake_items SET processing_state=? WHERE tenant_id=? AND confidential_scope_id=? AND id=?',
        output.status,
        this.scope.tenantId,
        this.scope.confidentialScopeId,
        lease.itemId,
      );
      if (['completed', 'partial', 'needs_attention'].includes(output.status))
        await db.query(
          "UPDATE intake_dispatches SET state='completed' WHERE tenant_id=? AND confidential_scope_id=? AND item_id=? AND revision=?",
          this.scope.tenantId,
          this.scope.confidentialScopeId,
          lease.itemId,
          lease.revision,
        );
      return true;
    });
  }
  /** Terminal failure accounting without a provider payload. The fixed safe error
   * and lifecycle metadata are not charged to the provider-output byte ceiling. */
  async failAnalysis(
    lease: AnalysisLease,
    category: IntakeFailure,
  ): Promise<boolean> {
    if (!failures.has(category)) throw new Error('Invalid analysis failure');
    return this.tx(async (db) => {
      await this.lock(db, lease.itemId);
      const item = await this.item(lease.itemId, 'process', db);
      if (item.cancelled || Number(item.analysis_revision) !== lease.revision)
        return false;
      const [analysis] = await this.rows(
        db,
        'intake_analyses',
        'id=? AND item_id=?',
        [lease.analysisId, lease.itemId],
      );
      const [attempt] = await this.rows(
        db,
        'intake_analysis_attempts',
        'id=? AND analysis_id=? AND item_id=?',
        [lease.attemptId, lease.analysisId, lease.itemId],
      );
      if (
        !analysis ||
        !attempt ||
        Number(analysis.revision) !== lease.revision ||
        analysis.current_attempt_id !== lease.attemptId ||
        Number(analysis.fence) !== lease.fence ||
        Number(attempt.fence) !== lease.fence ||
        attempt.state !== 'running' ||
        attempt.lease_token !== lease.token ||
        persistedDate(attempt.lease_until) <= this.now()
      )
        return false;
      await db.query(
        "UPDATE intake_analysis_attempts SET state='needs_attention',safe_error=?,data=? WHERE tenant_id=? AND confidential_scope_id=? AND id=?",
        category,
        canonical({
          ...object(attempt.data),
          completedAt: this.now().toISOString(),
        }),
        this.scope.tenantId,
        this.scope.confidentialScopeId,
        lease.attemptId,
      );
      await db.query(
        "UPDATE intake_analyses SET state='needs_attention' WHERE tenant_id=? AND confidential_scope_id=? AND id=?",
        this.scope.tenantId,
        this.scope.confidentialScopeId,
        lease.analysisId,
      );
      await db.query(
        "UPDATE intake_items SET processing_state='needs_attention' WHERE tenant_id=? AND confidential_scope_id=? AND id=?",
        this.scope.tenantId,
        this.scope.confidentialScopeId,
        lease.itemId,
      );
      await db.query(
        "UPDATE intake_dispatches SET state='completed' WHERE tenant_id=? AND confidential_scope_id=? AND item_id=? AND revision=?",
        this.scope.tenantId,
        this.scope.confidentialScopeId,
        lease.itemId,
        lease.revision,
      );
      return true;
    });
  }
  /** Cancel pending processing immediately; original receipt remains ready. */
  async cancel(itemId: string): Promise<void> {
    await this.tx(async (db) => {
      await this.lock(db, itemId);
      await this.item(itemId, 'process', db);
      await db.query(
        "UPDATE intake_items SET cancelled=?,processing_state='cancelled' WHERE tenant_id=? AND confidential_scope_id=? AND id=?",
        true,
        this.scope.tenantId,
        this.scope.confidentialScopeId,
        itemId,
      );
      await db.query(
        "UPDATE intake_analyses SET state='superseded' WHERE tenant_id=? AND confidential_scope_id=? AND item_id=? AND state IN ('queued','running')",
        this.scope.tenantId,
        this.scope.confidentialScopeId,
        itemId,
      );
      await db.query(
        "UPDATE intake_analysis_attempts SET state='superseded',safe_error='cancelled' WHERE tenant_id=? AND confidential_scope_id=? AND item_id=? AND state IN ('queued','running')",
        this.scope.tenantId,
        this.scope.confidentialScopeId,
        itemId,
      );
      await db.query(
        "UPDATE intake_dispatches SET state='completed' WHERE tenant_id=? AND confidential_scope_id=? AND item_id=?",
        this.scope.tenantId,
        this.scope.confidentialScopeId,
        itemId,
      );
    });
  }
  /** Mint an action only on an explicit host intention, never during reanalysis. */
  async createAction(
    itemId: string,
    actionKey: string,
    provenance: Record<string, unknown>,
  ): Promise<string> {
    nonempty(actionKey);
    // Reviewer-selected actions are minted only by `startReviewerAction` under
    // reviewer authority; process authority must not forge routing provenance.
    if (
      actionKey.startsWith('reviewer:') ||
      (provenance as { origin?: unknown }).origin === 'reviewer-selected'
    )
      throw new Error('Reserved action provenance');
    const payload = canonical(provenance);
    return this.tx(async (db) => {
      await this.lock(db, itemId);
      const item = await this.item(itemId, 'process', db);
      if (item.cancelled) throw new Error('Intake cancelled');
      await this.assertUnresolved(db, itemId);
      const [existing] = await this.rows(
        db,
        'intake_actions',
        'item_id=? AND action_key=?',
        [itemId, actionKey],
      );
      if (existing) {
        if (canonical(object(existing.data)) !== payload)
          throw new Error('Action identity conflict');
        return String(existing.id);
      }
      const [action] = await this.insert(db, 'intake_actions', {
        item_id: itemId,
        action_key: actionKey,
        state: 'proposed',
        proposal_revision: 0,
        review_version: 0,
        execution_attempt: 0,
        fence: 0,
        result_digest: '',
        data: payload,
      });
      return String(action.id);
    });
  }
  /** Append a proposal pinned to a completed attempt. Policy/preview is host-owned. */
  async publishProposal(input: {
    itemId: string;
    actionId: string;
    attemptId: string;
    expectedRevision: number;
    binding: Record<string, unknown>;
  }): Promise<{ id: string; revision: number; bindingHash: string }> {
    canonical(input.binding);
    return this.tx(async (db) => {
      await this.lock(db, input.itemId);
      const item = await this.item(input.itemId, 'process', db);
      if (item.cancelled) throw new Error('Intake cancelled');
      await this.assertUnresolved(db, input.itemId);
      const [action] = await this.rows(
        db,
        'intake_actions',
        'item_id=? AND id=?',
        [input.itemId, input.actionId],
      );
      // A reviewer-selected action is revised only through the reviewer path
      // (`previewProposal`/`submitDecision`); process authority cannot rewrite it.
      if (action && object(action.data).origin === 'reviewer-selected')
        throw new Error('Reviewer-selected action requires review');
      const [attempt] = await this.rows(
        db,
        'intake_analysis_attempts',
        'item_id=? AND id=?',
        [input.itemId, input.attemptId],
      );
      if (
        !action ||
        !attempt ||
        !['completed', 'partial'].includes(String(attempt.state)) ||
        !attempt.output_digest
      )
        throw new Error('Invalid proposal evidence');
      if (
        Number(action.proposal_revision) !== input.expectedRevision ||
        ['succeeded', 'executing', 'outcome_unknown'].includes(
          String(action.state),
        )
      )
        throw new Error('Proposal conflict');
      const [analysis] = await this.rows(
        db,
        'intake_analyses',
        'id=? AND item_id=?',
        [attempt.analysis_id, input.itemId],
      );
      if (
        !analysis ||
        Number(analysis.revision) !== Number(item.analysis_revision)
      )
        throw new Error('Proposal conflict');
      const bindingHash = digest({
        binding: input.binding,
        attemptId: attempt.id,
        attemptDigest: attempt.output_digest,
        inputDigest: analysis.input_digest,
      });
      const revision = input.expectedRevision + 1;
      const [proposal] = await this.insert(db, 'intake_proposals', {
        item_id: input.itemId,
        action_id: input.actionId,
        analysis_id: attempt.analysis_id,
        analysis_attempt_id: attempt.id,
        revision,
        binding_hash: bindingHash,
        data: canonical({
          binding: input.binding,
          attemptDigest: attempt.output_digest,
        }),
      });
      await db.query(
        "UPDATE intake_actions SET proposal_revision=?,state='waiting_review',review_version=review_version+1 WHERE tenant_id=? AND confidential_scope_id=? AND id=?",
        revision,
        this.scope.tenantId,
        this.scope.confidentialScopeId,
        input.actionId,
      );
      return { id: String(proposal.id), revision, bindingHash };
    });
  }
  /** Persist frozen plan structure; no expansion or apply authority is implied. */
  async appendPlan(
    itemId: string,
    planKey: string,
    revision: number,
    steps: Array<{ actionId: string; proposalRevision: number }>,
    definition: Record<string, unknown>,
  ): Promise<string> {
    nonempty(planKey);
    integer(revision);
    return this.tx(async (db) => {
      await this.lock(db, itemId);
      await this.item(itemId, 'process', db);
      if (
        !steps.length ||
        new Set(steps.map((s) => s.actionId)).size !== steps.length
      )
        throw new Error('Invalid plan');
      for (const step of steps) {
        const [proposal] = await this.rows(
          db,
          'intake_proposals',
          'item_id=? AND action_id=? AND revision=?',
          [itemId, step.actionId, step.proposalRevision],
        );
        if (!proposal) throw new Error('Invalid plan binding');
      }
      const data = canonical({ steps, definition });
      const hash = digest({ steps, definition });
      const previous = await this.rows(
        db,
        'intake_plans',
        'item_id=? AND plan_key=?',
        [itemId, planKey],
      );
      const replay = previous.find((p) => Number(p.revision) === revision);
      if (replay) {
        if (replay.digest !== hash) throw new Error('Plan conflict');
        return String(replay.id);
      }
      if (
        revision !==
        Math.max(0, ...previous.map((p) => Number(p.revision))) + 1
      )
        throw new Error('Plan revision conflict');
      const [plan] = await this.insert(db, 'intake_plans', {
        item_id: itemId,
        plan_key: planKey,
        revision,
        digest: hash,
        data,
      });
      return String(plan.id);
    });
  }
  /** Revoke immediately and durably schedule deletion before external I/O. */
  async expire(itemId: string): Promise<void> {
    await this.scheduleExpiry(itemId);
    await this.repairDeletions();
  }
  private async scheduleExpiry(itemId: string): Promise<void> {
    await this.tx(async (db) => {
      await this.lock(db, itemId);
      await this.item(itemId, 'delete', db, true);
      await db.query(
        "UPDATE intake_items SET visibility='expired',processing_state='expired',cancelled=?,lease_token='',lease_until=NULL WHERE tenant_id=? AND confidential_scope_id=? AND id=?",
        true,
        this.scope.tenantId,
        this.scope.confidentialScopeId,
        itemId,
      );
      await db.query(
        "UPDATE intake_evidence SET state='revoked' WHERE tenant_id=? AND confidential_scope_id=? AND item_id=?",
        this.scope.tenantId,
        this.scope.confidentialScopeId,
        itemId,
      );
      await db.query(
        "UPDATE intake_dispatches SET state='completed' WHERE tenant_id=? AND confidential_scope_id=? AND item_id=?",
        this.scope.tenantId,
        this.scope.confidentialScopeId,
        itemId,
      );
      await db.query(
        "UPDATE intake_analyses SET state='superseded' WHERE tenant_id=? AND confidential_scope_id=? AND item_id=? AND state IN ('queued','running')",
        this.scope.tenantId,
        this.scope.confidentialScopeId,
        itemId,
      );
      await db.query(
        "UPDATE intake_analysis_attempts SET state='superseded' WHERE tenant_id=? AND confidential_scope_id=? AND item_id=? AND state IN ('queued','running')",
        this.scope.tenantId,
        this.scope.confidentialScopeId,
        itemId,
      );
      const originals = await this.rows(db, 'intake_evidence', 'item_id=?', [
        itemId,
      ]);
      const cleanup = originals
        .filter((e) => e.asset_id && e.source_uri)
        .map((e) => ({ assetId: e.asset_id, sourceUri: e.source_uri }));
      await this.insert(
        db,
        'intake_deletions',
        { item_id: itemId, state: 'pending', data: canonical({ cleanup }) },
        'tenant_id,item_id',
      );
    });
  }
  /** Retry privacy propagation. Minimal receipt/action identities remain replay-safe. */
  async repairDeletions(): Promise<number> {
    let completed = 0;
    const pending = await this.rows(this.db, 'intake_deletions');
    for (const intent of pending) {
      const itemId = String(intent.item_id);
      await this.item(itemId, 'delete', this.db, true);
      const evidence = await this.rows(
        this.db,
        'intake_evidence',
        'item_id=?',
        [itemId],
      );
      for (const row of evidence) {
        if (!row.asset_id) continue;
        const asset = await withTenant({ tenantId: this.scope.tenantId }, () =>
          this.options.assets.collection.get({ id: String(row.asset_id) }),
        );
        if (asset) {
          if (asset.tenantId !== this.scope.tenantId)
            throw new Error('Asset unavailable');
          await this.options.assets.store.remove(asset);
        }
      }
      // Retain cleanup locators after revocation: a killed stale writer may finish
      // storage I/O after owner deletion. Repeated sweeps remove those bytes too.
      const cleanup = object(intent.data).cleanup;
      if (Array.isArray(cleanup))
        for (const entry of cleanup) {
          const locator = object(entry);
          const asset = new Asset({ db: this.db });
          asset.id = String(locator.assetId);
          asset.tenantId = this.scope.tenantId;
          asset.sourceUri = String(locator.sourceUri);
          // Remove the object directly through the public store, even when its
          // database record has already been pruned.
          await this.options.assets.store.removeFile(asset);
        }
      if (intent.state === 'completed') {
        await this.releaseRedactedPrincipal(itemId);
        continue;
      }
      await this.options.purgeDerived({
        tenantId: this.scope.tenantId,
        itemId,
      });
      await this.point('deleted');
      await this.tx(async (db) => {
        await this.lock(db, itemId);
        const item = await this.item(itemId, 'delete', db, true);
        for (const table of TABLES.filter(
          (t) => t !== 'intake_items' && t !== 'intake_deletions',
        ))
          await db.query(
            `UPDATE ${table} SET data='{}' WHERE tenant_id=? AND confidential_scope_id=? AND item_id=?`,
            this.scope.tenantId,
            this.scope.confidentialScopeId,
            itemId,
          );
        await db.query(
          "UPDATE intake_evidence SET source_uri='',content_hash='',media_type='',byte_length=0 WHERE tenant_id=? AND confidential_scope_id=? AND item_id=?",
          this.scope.tenantId,
          this.scope.confidentialScopeId,
          itemId,
        );
        // The owner and submitter links are payload provenance, not replay
        // identity: deletion severs them together with every other payload.
        // Digests over actor, owner, text or arguments would let a deleted
        // receipt be linked to its sender or a guessed text be confirmed.
        // Replay after redaction is already refused, so none are needed.
        for (const [table, column] of REDACTED_DIGESTS)
          await db.query(
            `UPDATE ${table} SET ${column}=? WHERE tenant_id=? AND confidential_scope_id=? AND item_id=?`,
            REDACTED,
            this.scope.tenantId,
            this.scope.confidentialScopeId,
            itemId,
          );
        await db.query(
          "UPDATE intake_items SET data=?,trace_id='',submitter_id='',owner_key='',payload_digest=?,scope_digest=? WHERE tenant_id=? AND confidential_scope_id=? AND id=?",
          // The ceiling stays for later delete sweeps' host authorization;
          // execution.principalId stays only while an external action may
          // still be reconciled under it, and is released once it finishes.
          canonical({
            capturedCeiling: redactedCeiling(
              object(object(item.data).capturedCeiling ?? {}),
              await this.hasUnfinishedActions(db, itemId),
            ),
          }),
          REDACTED,
          REDACTED,
          this.scope.tenantId,
          this.scope.confidentialScopeId,
          itemId,
        );
        await db.query(
          "UPDATE intake_deletions SET state='completed' WHERE tenant_id=? AND confidential_scope_id=? AND id=?",
          this.scope.tenantId,
          this.scope.confidentialScopeId,
          intent.id,
        );
      });
      completed++;
    }
    return completed;
  }
  private async hasUnfinishedActions(
    db: DatabaseInterface,
    itemId: string,
  ): Promise<boolean> {
    return (
      (
        await this.rows(
          db,
          'intake_actions',
          `item_id=? AND state IN (${UNFINISHED_ACTION_STATES.map(() => '?').join(',')})`,
          [itemId, ...UNFINISHED_ACTION_STATES],
        )
      ).length > 0
    );
  }
  /** Later sweeps drop a principal retained for a reconciliation that has
   * since reached a final state. */
  private async releaseRedactedPrincipal(itemId: string): Promise<void> {
    await this.tx(async (db) => {
      await this.lock(db, itemId);
      const [item] = await this.rows(db, 'intake_items', 'id=?', [itemId]);
      if (!item || item.visibility === 'active') return;
      if (await this.hasUnfinishedActions(db, itemId)) return;
      const data = object(item.data);
      const ceiling = object(data.capturedCeiling ?? {});
      const released = redactedCeiling(ceiling, false);
      if (canonical(released) === canonical(ceiling)) return;
      await db.query(
        'UPDATE intake_items SET data=? WHERE tenant_id=? AND confidential_scope_id=? AND id=?',
        canonical({ ...data, capturedCeiling: released }),
        this.scope.tenantId,
        this.scope.confidentialScopeId,
        itemId,
      );
    });
  }
  /** Run host-configured expiry policy and retry interrupted deletion propagation. */
  async sweepRetention(): Promise<number> {
    const expired = await this.rows(
      this.db,
      'intake_items',
      "visibility='active' AND expires_at<=?",
      [this.now().toISOString()],
    );
    try {
      for (const item of expired) await this.scheduleExpiry(String(item.id));
    } catch (error) {
      // A later denial must not strand already committed deletion intents.
      // Preserve the scheduling failure even if cleanup also needs a retry.
      try {
        await this.repairDeletions();
      } catch {
        // Durable intents remain available to the next authorized repair.
      }
      throw error;
    }
    await this.repairDeletions();
    return expired.length;
  }
}

export {
  HANDLER_ARGUMENT_ISSUE_LIMIT,
  HANDLER_ARGUMENT_PATH_LIMIT,
} from './argument-issues.js';
export * from './extraction.js';
export type * from './feedback-contracts.js';
export {
  GenerationSnapshotStaleError,
  GenerationSourceStaleError,
  HandlerArgumentsInvalidError,
  ProposalsNotConfiguredError,
} from './proposal-errors.js';
export type { HandlerArgumentIssue } from './review-dto.js';
export {
  createIntakeReviewHost,
  type IntakeReviewHostOptions,
  type RowEvidenceRequest,
  type RowEvidenceView,
} from './review-host.js';
export {
  REVIEWER_INSTRUCTION_MAX_LENGTH,
  ReviewerInstructionInvalidError,
  ReviewerInstructionStaleError,
  reviewerInstructionView,
} from './reviewer-instruction.js';
export * from './sources/index.js';
