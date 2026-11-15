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
  MAX_TUTOR_EXCHANGE_TEXT_CHARS,
  MAX_TUTOR_TOOL_SUMMARY_CHARS,
  TUTOR_AUDIENCES,
  TUTOR_EXCHANGE_MARKERS,
  TUTOR_EXCHANGE_ROLES,
  TUTOR_SESSION_MODES,
  type TutorAudience,
  type TutorExchangeMarker,
  type TutorExchangeRole,
  type TutorSessionMode,
} from './tutor-contracts.js';

const closed = { api: false, mcp: false, cli: false } as const;
const IMMUTABLE = 'Education tutor history is immutable';

function adopt(target: object, options: Record<string, unknown>) {
  for (const [key, value] of Object.entries(options))
    if (Object.hasOwn(target, key))
      (target as Record<string, unknown>)[key] = value;
}
function requireText(value: unknown, message: string, max = 200) {
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    throw new Error(message);
}
function validDate(value: Date) {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime()))
    throw new Error('Invalid education tutor timestamp');
}
/** Tutor rows are insert-only: any rewrite of an existing id fails. */
async function requireInsert(row: SmrtObject & { tenantId: string }) {
  if (!row.tenantId?.trim()) throw new Error('Education requires a tenant');
  if (row.id && (await row.db.get(row.tableName, { id: row.id })))
    throw new Error(IMMUTABLE);
}
function noDelete(): never {
  throw new Error(IMMUTABLE);
}

/**
 * Append-only record that a tutor session was opened for one learner. It holds
 * identifiers and a context digest only: never context text, and never answer
 * material. "Open" is the absence of a `TutorSessionClosure`.
 */
@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'tutor_sessions',
  conflictColumns: ['tenant_id', 'learner_id', 'request_key'],
  ...closed,
})
export class TutorSession extends SmrtObject {
  @tenantId() tenantId = '';
  @foreignKey('Learner', { required: true, requiredFor: 'identity' })
  learnerId = '';
  @field({ type: 'text', nullable: true }) enrollmentId: string | null = null;
  @field({ type: 'text', nullable: true }) lessonId: string | null = null;
  audience: TutorAudience = 'learner';
  mode: TutorSessionMode = 'chat';
  /** Voice consent the host recorded for this learner before a voice session. */
  voiceConsent = false;
  openedByUserId = '';
  /** Idempotency key for `open`, unique per learner. */
  requestKey = '';
  /** Digest of the request, so a changed replay is refused. */
  requestDigest = '';
  /** Digest of the `TutorContext` given to the tutor; never the context itself. */
  @field({ type: 'text', nullable: true }) contextHash: string | null = null;
  openedAt = new Date();
  constructor(options: Record<string, unknown> = {}) {
    super(options);
    adopt(this, options);
  }
  override async delete(): Promise<void> {
    noDelete();
  }
  override async save(options?: SmrtSaveOptions): Promise<this> {
    await requireInsert(this);
    if (
      !(await this.db.get('learners', {
        id: this.learnerId,
        tenant_id: this.tenantId,
      }))
    )
      throw new Error('Tutor session requires its tenant learner');
    if (
      this.enrollmentId !== null &&
      !(await this.db.get('enrollments', {
        id: this.enrollmentId,
        tenant_id: this.tenantId,
        learner_id: this.learnerId,
      }))
    )
      throw new Error('Tutor session requires its tenant enrollment');
    if (this.lessonId !== null && this.enrollmentId === null)
      throw new Error('A tutor session lesson requires an enrollment');
    if (
      !TUTOR_AUDIENCES.includes(this.audience) ||
      !TUTOR_SESSION_MODES.includes(this.mode) ||
      (this.mode === 'voice' && this.voiceConsent !== true)
    )
      throw new Error('Invalid tutor session');
    requireText(this.openedByUserId, 'Tutor session requires an actor');
    requireText(this.requestKey, 'Tutor session requires a request key');
    requireText(this.requestDigest, 'Tutor session requires a digest', 128);
    if (this.contextHash !== null)
      requireText(this.contextHash, 'Invalid tutor context hash', 128);
    validDate(this.openedAt);
    this.requireInsertOnSave();
    return super.save(options);
  }
}
export class TutorSessionCollection extends SmrtCollection<TutorSession> {
  static readonly _itemClass = TutorSession;
}

/**
 * Append-only close record, at most one per session. A session is closed once
 * this row exists; the session row itself is never rewritten.
 */
@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'tutor_session_closures',
  conflictColumns: ['tenant_id', 'session_id'],
  ...closed,
})
export class TutorSessionClosure extends SmrtObject {
  @tenantId() tenantId = '';
  @foreignKey('TutorSession', { required: true, requiredFor: 'identity' })
  sessionId = '';
  @foreignKey('Learner', { required: true, requiredFor: 'identity' })
  learnerId = '';
  actorUserId = '';
  closedAt = new Date();
  constructor(options: Record<string, unknown> = {}) {
    super(options);
    adopt(this, options);
  }
  override async delete(): Promise<void> {
    noDelete();
  }
  override async save(options?: SmrtSaveOptions): Promise<this> {
    await requireInsert(this);
    if (
      !(await this.db.get('tutor_sessions', {
        id: this.sessionId,
        tenant_id: this.tenantId,
        learner_id: this.learnerId,
      }))
    )
      throw new Error('Tutor closure requires its tenant session');
    requireText(this.actorUserId, 'Tutor closure requires an actor');
    validDate(this.closedAt);
    this.requireInsertOnSave();
    return super.save(options);
  }
}
export class TutorSessionClosureCollection extends SmrtCollection<TutorSessionClosure> {
  static readonly _itemClass = TutorSessionClosure;
}

/** Append-only message in a tutor session, ordered by `sequence` from 1. */
@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'tutor_exchanges',
  conflictColumns: ['tenant_id', 'session_id', 'request_key'],
  indexes: [
    {
      name: 'tutor_exchanges_sequence_unique',
      columns: ['tenantId', 'sessionId', 'sequence'],
      unique: true,
    },
  ],
  ...closed,
})
export class TutorExchange extends SmrtObject {
  @tenantId() tenantId = '';
  @foreignKey('TutorSession', { required: true, requiredFor: 'identity' })
  sessionId = '';
  @foreignKey('Learner', { required: true, requiredFor: 'identity' })
  learnerId = '';
  sequence = 1;
  role: TutorExchangeRole = 'learner';
  @field({ type: 'text' }) text = '';
  actorUserId = '';
  /** Optional context reference: ids only. */
  @field({ type: 'text', nullable: true }) lessonId: string | null = null;
  @field({ type: 'text', nullable: true }) questionRevisionId: string | null =
    null;
  /** Host content/safety classification of this text. */
  marker: TutorExchangeMarker = 'none';
  /** Short host-written summary of tool calls; never raw arguments. */
  @field({ type: 'text' }) toolSummary = '';
  inputTokens = 0;
  outputTokens = 0;
  requestKey = '';
  requestDigest = '';
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
    if (
      !(await this.db.get('tutor_sessions', {
        id: this.sessionId,
        tenant_id: this.tenantId,
        learner_id: this.learnerId,
      }))
    )
      throw new Error('Tutor exchange requires its tenant session');
    if (!Number.isSafeInteger(this.sequence) || this.sequence < 1)
      throw new Error('Invalid tutor exchange sequence');
    if (
      !TUTOR_EXCHANGE_ROLES.includes(this.role) ||
      !TUTOR_EXCHANGE_MARKERS.includes(this.marker)
    )
      throw new Error('Invalid tutor exchange');
    requireText(
      this.text,
      'Tutor exchange text is required',
      MAX_TUTOR_EXCHANGE_TEXT_CHARS,
    );
    if (
      typeof this.toolSummary !== 'string' ||
      this.toolSummary.length > MAX_TUTOR_TOOL_SUMMARY_CHARS
    )
      throw new Error('Invalid tutor tool summary');
    for (const value of [this.inputTokens, this.outputTokens])
      if (!Number.isSafeInteger(value) || value < 0)
        throw new Error('Invalid tutor usage');
    requireText(this.actorUserId, 'Tutor exchange requires an actor');
    requireText(this.requestKey, 'Tutor exchange requires a request key');
    requireText(this.requestDigest, 'Tutor exchange requires a digest', 128);
    validDate(this.recordedAt);
    this.requireInsertOnSave();
    return super.save(options);
  }
}
export class TutorExchangeCollection extends SmrtCollection<TutorExchange> {
  static readonly _itemClass = TutorExchange;
}
