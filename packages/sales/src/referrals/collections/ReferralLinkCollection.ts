/**
 * ReferralLinkCollection — collection manager for {@link ReferralLink}:
 * crypto-random code minting with collision retry, code lookup, and click
 * recording (link counter + immutable ReferralTouch evidence).
 *
 * @packageDocumentation
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { SmrtCollection } from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/sql';
import { assertHttpTargetUrl, ReferralLink } from '../models/ReferralLink.js';
import type { ReferralTouch } from '../models/ReferralTouch.js';
import { ReferralClickOperationCollection } from './ReferralClickOperationCollection.js';
import { ReferralTouchCollection } from './ReferralTouchCollection.js';

/** Length of generated share codes. */
export const REFERRAL_CODE_LENGTH = 10;

/** Alphabet generated codes draw from (lowercase alphanumeric). */
export const REFERRAL_CODE_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** Attempts before {@link ReferralLinkCollection.createWithUniqueCode} gives up. */
export const MAX_CODE_GENERATION_ATTEMPTS = 5;

/** Default UTF-8 byte ceiling for the exact persisted click evidence JSON. */
export const DEFAULT_REFERRAL_CLICK_EVIDENCE_MAX_BYTES = 4096;

/** Maximum UTF-8 size of a caller-supplied replay key. */
export const MAX_REFERRAL_CLICK_IDEMPOTENCY_KEY_BYTES = 256;

/**
 * Generate a crypto-random share code: {@link REFERRAL_CODE_LENGTH}
 * characters drawn uniformly from {@link REFERRAL_CODE_ALPHABET} via
 * rejection-sampled `crypto.randomBytes` (no modulo bias).
 */
export function generateReferralCode(): string {
  const alphabetSize = REFERRAL_CODE_ALPHABET.length;
  // Largest multiple of the alphabet size below 256 — bytes at or above it
  // are rejected so every character is uniformly likely.
  const rejectionBound = 256 - (256 % alphabetSize);
  let code = '';
  while (code.length < REFERRAL_CODE_LENGTH) {
    const bytes = randomBytes(REFERRAL_CODE_LENGTH * 2);
    for (const byte of bytes) {
      if (byte >= rejectionBound) continue;
      code += REFERRAL_CODE_ALPHABET[byte % alphabetSize];
      if (code.length === REFERRAL_CODE_LENGTH) break;
    }
  }
  return code;
}

/** Input for {@link ReferralLinkCollection.createWithUniqueCode}. */
export interface CreateReferralLinkInput {
  referrerId: string;
  programId: string;
  targetUrl?: string;
  label?: string;
  tenantId?: string | null;
  /**
   * Test seam / customization point: overrides the random code generator.
   * Must return {@link REFERRAL_CODE_LENGTH} lowercase-alphanumeric
   * characters; collisions with existing codes are retried up to
   * {@link MAX_CODE_GENERATION_ATTEMPTS} times.
   */
  generateCode?: () => string;
}

/** Why {@link ReferralLinkCollection.recordClick} refused to record. */
export type RecordClickRefusal = 'unknown_code' | 'link_disabled';

/**
 * Result of {@link ReferralLinkCollection.recordClick}. On success `link`
 * and `touch` are both set and `refused` is absent. On refusal `touch` is
 * `null`, `refused` names the reason, and `link` carries the (disabled) link
 * for `'link_disabled'` / `null` for `'unknown_code'`.
 */
export interface RecordClickResult {
  link: ReferralLink | null;
  touch: ReferralTouch | null;
  refused?: RecordClickRefusal;
  /** Stable key used for a successful click (generated when omitted). */
  idempotencyKey?: string;
  /** `true` when this call returned the already-committed touch. */
  replayed?: boolean;
}

/** Input for {@link ReferralLinkCollection.recordClick}. */
export interface RecordClickInput {
  code: string;
  /**
   * Stable caller replay key. Retries must reuse the exact value. When
   * omitted, Sales generates a unique one-shot UUID for backward
   * compatibility and returns it in the successful result. Supplied keys
   * must be well-formed Unicode and at most 256 UTF-8 bytes.
   */
  idempotencyKey?: string;
  /**
   * Extra evidence merged into the touch JSON (UA, IP hash, …). Sales owns
   * and overwrites the reserved `code`, `linkId`, and `targetUrl` keys.
   */
  evidence?: Record<string, unknown>;
  /**
   * Creation-time UTF-8 byte ceiling for the FINAL persisted JSON envelope,
   * including Sales-owned `code`, `linkId`, and `targetUrl`. Defaults to
   * {@link DEFAULT_REFERRAL_CLICK_EVIDENCE_MAX_BYTES}; an exact committed
   * replay does not reapply a later invocation's ceiling.
   */
  maxEvidenceBytes?: number;
  /** When the click occurred; defaults to now. */
  occurredAt?: Date;
  /**
   * Prospect identity when the edge already knows it (e.g. a logged-in
   * visitor or a pre-created lead). Without a subject pair the touch is
   * anonymous and `AttributionService.resolve` cannot gather it by subject —
   * the intake handler must then append a second, identified touch once the
   * prospect materializes (same `occurredAt` preserves credit ordering).
   */
  subjectKind?: string;
  subjectId?: string;
}

export type ReferralClickReplayMismatchField =
  | 'idempotencyKey'
  | 'tenantId'
  | 'code'
  | 'linkId'
  | 'targetUrl'
  | 'referrerId'
  | 'programId'
  | 'subjectKind'
  | 'subjectId'
  | 'occurredAt'
  | 'evidence'
  | 'intent';

/** Typed fail-closed result for a replay key reused with another click. */
export class ReferralClickReplayConflictError extends Error {
  readonly code = 'REFERRAL_CLICK_REPLAY_CONFLICT' as const;

  constructor(
    readonly idempotencyKey: string,
    readonly mismatches: readonly ReferralClickReplayMismatchField[],
  ) {
    super(
      `Referral click idempotency key '${idempotencyKey}' was already used ` +
        `with different ${mismatches.length === 1 ? 'intent field' : 'intent fields'}: ` +
        mismatches.join(', '),
    );
    this.name = 'ReferralClickReplayConflictError';
  }
}

export type ReferralClickValidationReason =
  | 'invalid_idempotency_key'
  | 'invalid_occurred_at'
  | 'invalid_evidence'
  | 'invalid_max_evidence_bytes'
  | 'evidence_too_large'
  | 'transaction_unavailable'
  | 'operation_link_missing'
  | 'operation_touch_missing'
  | 'link_update_conflict';

/** Actionable validation/integrity error raised without a partial click. */
export class ReferralClickValidationError extends Error {
  readonly code = 'REFERRAL_CLICK_VALIDATION_ERROR' as const;

  constructor(
    readonly reason: ReferralClickValidationReason,
    message: string,
    readonly details?: Readonly<Record<string, number | string>>,
  ) {
    super(message);
    this.name = 'ReferralClickValidationError';
  }
}

interface TransactionCapableDatabase extends DatabaseInterface {
  transaction?<T>(fn: (tx: DatabaseInterface) => Promise<T>): Promise<T>;
}

interface RecordClickCollections {
  links: ReferralLinkCollection;
  touches: ReferralTouchCollection;
  operations: ReferralClickOperationCollection;
}

interface CanonicalClickRequest {
  idempotencyKey: string;
  operationId: string;
  keyHash: string;
  normalizedCode: string;
  callerEvidence: Record<string, unknown>;
  callerEvidenceHash: string;
  requestedOccurredAt: string;
  occurredAt: Date | null;
  subjectKind: string;
  subjectId: string;
  maxEvidenceBytes: number;
}

interface ClickIntent {
  finalEvidence: string;
  intentHash: string;
}

export class ReferralLinkCollection extends SmrtCollection<ReferralLink> {
  static readonly _itemClass = ReferralLink;

  /** All links for a referrer, newest first. */
  async findByReferrer(referrerId: string): Promise<ReferralLink[]> {
    return await this.list({
      where: { referrerId },
      orderBy: 'created_at DESC',
    });
  }

  /**
   * Look up a link by its globally unique code (codes are minted lowercase;
   * the lookup normalizes case so shared codes survive re-typing).
   */
  async findByCode(code: string): Promise<ReferralLink | null> {
    const normalized = code.trim().toLowerCase();
    if (!normalized) return null;
    const results = await this.list({
      where: { code: normalized },
      limit: 1,
    });
    return results[0] ?? null;
  }

  /**
   * Create a link with a freshly minted, uniqueness-checked code.
   *
   * Codes come from `crypto.randomBytes` mapped to
   * {@link REFERRAL_CODE_LENGTH} lowercase-alphanumeric characters. The
   * check-then-insert loop retries on collision up to
   * {@link MAX_CODE_GENERATION_ATTEMPTS} times, then throws — at 36^10
   * possible codes repeated collisions mean the generator is broken (or a
   * test seam returns a constant), not bad luck.
   */
  async createWithUniqueCode(
    input: CreateReferralLinkInput,
  ): Promise<ReferralLink> {
    if (!input.referrerId || !input.programId) {
      throw new Error(
        'ReferralLinkCollection.createWithUniqueCode requires referrerId and programId',
      );
    }
    if (input.targetUrl) {
      // Fail before burning a code attempt on an invalid destination.
      assertHttpTargetUrl(input.targetUrl);
    }
    const generate = input.generateCode ?? generateReferralCode;

    for (let attempt = 0; attempt < MAX_CODE_GENERATION_ATTEMPTS; attempt++) {
      const code = generate();
      const existing = await this.findByCode(code);
      if (existing) continue;
      return await this.create({
        tenantId: input.tenantId,
        referrerId: input.referrerId,
        programId: input.programId,
        code,
        targetUrl: input.targetUrl ?? '',
        label: input.label ?? '',
        status: 'active',
      });
    }
    throw new Error(
      `ReferralLinkCollection.createWithUniqueCode: could not mint a unique code after ${MAX_CODE_GENERATION_ATTEMPTS} attempts — the code generator is returning colliding codes`,
    );
  }

  /**
   * Record a click on a share code. A private operation fence, immutable
   * ReferralTouch, and {@link ReferralLink.clickCount} increment commit in
   * one supported database transaction. An exact `idempotencyKey` replay
   * returns the original touch without another increment; changed immutable
   * intent raises {@link ReferralClickReplayConflictError}.
   *
   * Evidence is canonicalized, Sales-owned `code`/`linkId`/`targetUrl` fields
   * are applied, and the UTF-8 bytes of that exact persisted JSON are checked
   * before any write. The default bound is
   * {@link DEFAULT_REFERRAL_CLICK_EVIDENCE_MAX_BYTES}.
   *
   * Refusals return a typed result instead of throwing (clicks arrive from
   * the edge — an unknown or disabled code is an expected outcome, not an
   * exception): `refused: 'unknown_code'` (no such code; `link: null`) or
   * `refused: 'link_disabled'` (link exists but is disabled; the link is
   * returned, nothing is written).
   */
  async recordClick(input: RecordClickInput): Promise<RecordClickResult> {
    const request = canonicalizeClickRequest(input);
    const db = this.db as TransactionCapableDatabase;
    if (typeof db.transaction !== 'function') {
      throw new ReferralClickValidationError(
        'transaction_unavailable',
        'Referral click recording requires a transaction-capable database adapter',
      );
    }

    const transactionResult = await db.transaction(async (tx) => {
      const deps: RecordClickCollections = {
        links: await ReferralLinkCollection.create({ db: tx }),
        touches: await ReferralTouchCollection.create({ db: tx }),
        operations: await ReferralClickOperationCollection.create({ db: tx }),
      };
      return await this.recordClickInTransaction(deps, request);
    });
    return await this.rehydrateRecordClickResult(transactionResult);
  }

  /** Rebind public result models to the caller's database after commit. */
  private async rehydrateRecordClickResult(
    result: RecordClickResult,
  ): Promise<RecordClickResult> {
    let link: ReferralLink | null = null;
    if (result.link?.id) {
      link = await this.get({ id: result.link.id }, { cache: false });
      if (!link) {
        throw new ReferralClickValidationError(
          'operation_link_missing',
          'Committed referral click result has no visible link',
        );
      }
    }

    let touch: ReferralTouch | null = null;
    if (result.touch?.id) {
      const touches = await ReferralTouchCollection.create({ db: this.db });
      touch = await touches.get({ id: result.touch.id }, { cache: false });
      if (!touch) {
        throw new ReferralClickValidationError(
          'operation_touch_missing',
          'Committed referral click result has no visible touch',
        );
      }
    }

    return { ...result, link, touch };
  }

  private async recordClickInTransaction(
    deps: RecordClickCollections,
    request: CanonicalClickRequest,
  ): Promise<RecordClickResult> {
    const existingOperation = await deps.operations.findByOperationId(
      request.operationId,
    );
    if (existingOperation) {
      return await this.replayClick(deps, existingOperation, request);
    }

    const link = await deps.links.findByCode(request.normalizedCode);
    if (!link) {
      return { link: null, touch: null, refused: 'unknown_code' };
    }
    if (!link.isActive()) {
      return { link, touch: null, refused: 'link_disabled' };
    }
    if (!link.id) {
      throw new ReferralClickValidationError(
        'link_update_conflict',
        'Referral click link is missing its persisted identifier',
      );
    }

    const intent = buildClickIntent(link, request);
    assertEvidenceBound(intent.finalEvidence, request.maxEvidenceBytes);
    const touchId = randomUUID();
    const claimed = await deps.operations.claim({
      operationId: request.operationId,
      tenantId: link.tenantId,
      keyHash: request.keyHash,
      linkId: link.id,
      touchId,
      intentHash: intent.intentHash,
      callerEvidenceHash: request.callerEvidenceHash,
      requestedOccurredAt: request.requestedOccurredAt,
    });

    if (!claimed.operation) {
      // The deterministic operation id exists outside the visible tenant.
      // Never reveal its link, touch, or evidence payload.
      throw new ReferralClickReplayConflictError(request.idempotencyKey, [
        'tenantId',
      ]);
    }
    if (!claimed.claimed) {
      return await this.replayClick(deps, claimed.operation, request);
    }

    const touch = await deps.touches.create({
      id: touchId,
      tenantId: link.tenantId,
      linkId: link.id,
      code: link.code,
      referrerId: link.referrerId,
      programId: link.programId,
      kind: 'click',
      subjectKind: request.subjectKind,
      subjectId: request.subjectId,
      occurredAt: request.occurredAt ?? new Date(),
      evidence: intent.finalEvidence,
    });

    // Keep the immutable touch and derived counter in this transaction. The
    // tenant/status predicates prevent a stale lookup from mutating a link
    // that changed ownership or was disabled before the increment acquired
    // the row lock.
    const updated = await deps.links.query(
      `UPDATE ${deps.links.tableName}
       SET click_count = click_count + 1
       WHERE id = ?
         AND status = 'active'
         AND COALESCE(CAST(tenant_id AS TEXT), '') = ?
       RETURNING id`,
      [link.id, link.tenantId ?? ''],
      { allowRawOnTenantScoped: true },
    );
    if (updated.length !== 1) {
      throw new ReferralClickValidationError(
        'link_update_conflict',
        'Referral link changed or was disabled while its click was being recorded; the transaction was rolled back',
      );
    }

    const fresh = await deps.links.get({ id: link.id }, { cache: false });
    if (!fresh || !sameClickLinkSnapshot(link, fresh)) {
      throw new ReferralClickValidationError(
        'link_update_conflict',
        'Referral link attribution changed while its click was being recorded; the transaction was rolled back',
      );
    }

    return {
      link: fresh,
      touch,
      idempotencyKey: request.idempotencyKey,
      replayed: false,
    };
  }

  private async replayClick(
    deps: RecordClickCollections,
    operation: {
      keyHash: string;
      linkId: string;
      touchId: string;
      intentHash: string;
      callerEvidenceHash: string;
      requestedOccurredAt: string;
      tenantId: string | null;
    },
    request: CanonicalClickRequest,
  ): Promise<RecordClickResult> {
    if (operation.keyHash !== request.keyHash) {
      throw new ReferralClickReplayConflictError(request.idempotencyKey, [
        'idempotencyKey',
      ]);
    }

    const link = await deps.links.get(
      { id: operation.linkId },
      { cache: false },
    );
    if (!link) {
      throw new ReferralClickValidationError(
        'operation_link_missing',
        `Referral click operation '${request.idempotencyKey}' has no visible link`,
      );
    }
    const touch = await deps.touches.get(
      { id: operation.touchId },
      { cache: false },
    );
    if (!touch) {
      throw new ReferralClickValidationError(
        'operation_touch_missing',
        `Referral click operation '${request.idempotencyKey}' has no visible touch`,
      );
    }

    const mismatches = collectReplayMismatches(operation, link, touch, request);
    if (mismatches.length > 0) {
      throw new ReferralClickReplayConflictError(
        request.idempotencyKey,
        mismatches,
      );
    }

    return {
      link,
      touch,
      idempotencyKey: request.idempotencyKey,
      replayed: true,
    };
  }
}

function canonicalizeClickRequest(
  input: RecordClickInput,
): CanonicalClickRequest {
  const idempotencyKey = input.idempotencyKey ?? randomUUID();
  if (
    typeof idempotencyKey !== 'string' ||
    idempotencyKey.length === 0 ||
    idempotencyKey.trim() !== idempotencyKey ||
    !isWellFormedUnicode(idempotencyKey) ||
    utf8ByteLength(idempotencyKey) > MAX_REFERRAL_CLICK_IDEMPOTENCY_KEY_BYTES
  ) {
    throw new ReferralClickValidationError(
      'invalid_idempotency_key',
      `Referral click idempotencyKey must be non-empty, unpadded, well-formed Unicode, and at most ${MAX_REFERRAL_CLICK_IDEMPOTENCY_KEY_BYTES} UTF-8 bytes`,
    );
  }

  const maxEvidenceBytes =
    input.maxEvidenceBytes ?? DEFAULT_REFERRAL_CLICK_EVIDENCE_MAX_BYTES;
  if (!Number.isSafeInteger(maxEvidenceBytes) || maxEvidenceBytes <= 0) {
    throw new ReferralClickValidationError(
      'invalid_max_evidence_bytes',
      'Referral click maxEvidenceBytes must be a positive safe integer',
    );
  }

  let requestedOccurredAt = '';
  let occurredAt: Date | null = null;
  if (input.occurredAt !== undefined) {
    if (
      !(input.occurredAt instanceof Date) ||
      Number.isNaN(input.occurredAt.getTime())
    ) {
      throw new ReferralClickValidationError(
        'invalid_occurred_at',
        'Referral click occurredAt must be a valid Date',
      );
    }
    occurredAt = new Date(input.occurredAt.getTime());
    requestedOccurredAt = occurredAt.toISOString();
  }

  const callerEvidence = canonicalizeCallerEvidence(input.evidence ?? {});
  const callerEvidenceJson = stableJson(callerEvidence);
  const keyDigest = createHash('sha256')
    .update(idempotencyKey, 'utf8')
    .digest();

  return {
    idempotencyKey,
    operationId: uuidFromDigest(keyDigest),
    keyHash: keyDigest.toString('hex'),
    normalizedCode: String(input.code ?? '')
      .trim()
      .toLowerCase(),
    callerEvidence,
    callerEvidenceHash: hashText(callerEvidenceJson),
    requestedOccurredAt,
    occurredAt,
    subjectKind: input.subjectKind ?? '',
    subjectId: input.subjectId ?? '',
    maxEvidenceBytes,
  };
}

function canonicalizeCallerEvidence(
  evidence: Record<string, unknown>,
): Record<string, unknown> {
  try {
    const serialized = JSON.stringify(evidence);
    if (serialized === undefined) throw new TypeError('evidence is undefined');
    const parsed = JSON.parse(serialized) as unknown;
    if (!isPlainObject(parsed)) {
      throw new TypeError('evidence must be a JSON object');
    }
    return JSON.parse(stableJson(parsed)) as Record<string, unknown>;
  } catch (error) {
    throw new ReferralClickValidationError(
      'invalid_evidence',
      `Referral click evidence must be a JSON-serializable object: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function buildClickIntent(
  link: ReferralLink,
  request: CanonicalClickRequest,
): ClickIntent {
  const envelope = Object.assign(Object.create(null), request.callerEvidence, {
    code: link.code,
    linkId: link.id ?? '',
    targetUrl: link.targetUrl,
  }) as Record<string, unknown>;
  const finalEvidence = stableJson(envelope);
  const intentHash = hashText(
    stableJson({
      tenantId: link.tenantId,
      linkId: link.id ?? '',
      code: link.code,
      targetUrl: link.targetUrl,
      referrerId: link.referrerId,
      programId: link.programId,
      subjectKind: request.subjectKind,
      subjectId: request.subjectId,
      requestedOccurredAt: request.requestedOccurredAt,
      callerEvidenceHash: request.callerEvidenceHash,
      finalEvidence,
    }),
  );
  return { finalEvidence, intentHash };
}

function collectReplayMismatches(
  operation: {
    linkId: string;
    touchId: string;
    intentHash: string;
    callerEvidenceHash: string;
    requestedOccurredAt: string;
    tenantId: string | null;
  },
  link: ReferralLink,
  touch: ReferralTouch,
  request: CanonicalClickRequest,
): ReferralClickReplayMismatchField[] {
  const mismatches = new Set<ReferralClickReplayMismatchField>();
  if (request.normalizedCode !== touch.code) mismatches.add('code');
  if (
    operation.linkId !== link.id ||
    touch.linkId !== link.id ||
    operation.touchId !== touch.id
  )
    mismatches.add('linkId');
  if (operation.tenantId !== touch.tenantId) mismatches.add('tenantId');
  if (touch.subjectKind !== request.subjectKind) mismatches.add('subjectKind');
  if (touch.subjectId !== request.subjectId) mismatches.add('subjectId');
  if (
    normalizePersistedInstant(operation.requestedOccurredAt) !==
    request.requestedOccurredAt
  )
    mismatches.add('occurredAt');
  if (operation.callerEvidenceHash !== request.callerEvidenceHash)
    mismatches.add('evidence');
  const persisted = touch.getEvidence();
  if (persisted.code !== touch.code) mismatches.add('code');
  if (persisted.linkId !== touch.linkId) mismatches.add('linkId');
  if (
    operation.intentHash !==
      hashPersistedClickIntent(operation, touch, persisted.targetUrl) &&
    mismatches.size === 0
  )
    mismatches.add('intent');
  return [...mismatches];
}

/**
 * Rebuild the original intent exclusively from immutable operation/touch
 * state. Mutable ReferralLink fields must not turn an exact committed retry
 * into a conflict after the link is edited.
 */
function hashPersistedClickIntent(
  operation: {
    callerEvidenceHash: string;
    requestedOccurredAt: string;
  },
  touch: ReferralTouch,
  targetUrl: unknown,
): string {
  return hashText(
    stableJson({
      tenantId: touch.tenantId,
      linkId: touch.linkId,
      code: touch.code,
      targetUrl,
      referrerId: touch.referrerId,
      programId: touch.programId,
      subjectKind: touch.subjectKind,
      subjectId: touch.subjectId,
      requestedOccurredAt: normalizePersistedInstant(
        operation.requestedOccurredAt,
      ),
      callerEvidenceHash: operation.callerEvidenceHash,
      finalEvidence: touch.evidence,
    }),
  );
}

function assertEvidenceBound(evidence: string, maxBytes: number): void {
  const actualBytes = utf8ByteLength(evidence);
  if (actualBytes > maxBytes) {
    throw new ReferralClickValidationError(
      'evidence_too_large',
      `Referral click final evidence is ${actualBytes} UTF-8 bytes and exceeds the ${maxBytes}-byte limit`,
      { actualBytes, maxBytes },
    );
  }
}

function sameClickLinkSnapshot(
  left: ReferralLink,
  right: ReferralLink,
): boolean {
  return (
    left.id === right.id &&
    left.tenantId === right.tenantId &&
    left.code === right.code &&
    left.targetUrl === right.targetUrl &&
    left.referrerId === right.referrerId &&
    left.programId === right.programId
  );
}

function hashText(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function normalizePersistedInstant(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return typeof value === 'string' ? value : String(value ?? '');
}

function uuidFromDigest(digest: Buffer): string {
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (index + 1 >= value.length) return false;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJsonValue(value));
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (isPlainObject(value)) {
    const sorted = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortJsonValue(value[key]);
    }
    return sorted;
  }
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export default ReferralLinkCollection;
