/**
 * Opt-in AI call transcripts (`_smrt_ai_transcripts`, #4780): persistence and
 * the tenant-scoped, audited read path.
 *
 * `_smrt_ai_usage` stores metrics, never content. A transcript is the readable
 * part of one call (request messages, response, tool events) for prompt
 * tuning, written only when the app enables `inference.transcripts` (capture:
 * `../ai-transcripts.ts`). Its `call_id` is the entry call's id, which the
 * call's usage rows carry in `entry_call_id`; it shares `run_id` with its
 * fusion run and is judged by evaluations of its calls and run. None of these
 * are foreign keys, so each table is pruned on its own schedule.
 *
 * Tenant content at rest: every read names a tenant (or global rows) unless
 * the caller takes the reviewed `allowCrossTenant` path, and every read
 * writes an audit event.
 */

import { createLogger } from '@happyvertical/logger';
import type { DatabaseInterface } from '@happyvertical/sql';
import type { AuditWriter, CollectionAuditOptions } from '../audit.js';
import { toSafeInteger } from '../utils/safe-integer.js';
import type {
  AiEvaluationRecord,
  AiEvaluationUsageRow,
} from './ai-usage-observability.js';

const logger = createLogger({ level: 'info' });

/**
 * The active audit context (`withAuditContext()`), read through the same
 * `globalThis` slot as `getActiveAuditOptions()` in `../audit.ts`. Importing
 * that module here would load the registry into the system-table graph.
 */
function getActiveAuditOptions(): CollectionAuditOptions | undefined {
  const resolver = (globalThis as unknown as Record<symbol, unknown>)[
    Symbol.for('smrt.audit.context')
  ];
  return typeof resolver === 'function'
    ? (resolver as () => CollectionAuditOptions | undefined)()
    : undefined;
}

/** The transcript table. */
export const AI_TRANSCRIPTS_TABLE = '_smrt_ai_transcripts';

function getRows(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  if (result && typeof result === 'object' && 'rows' in result) {
    const rows = (result as { rows?: unknown }).rows;
    if (Array.isArray(rows)) return rows as Record<string, unknown>[];
  }
  return [];
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function toDate(value: unknown): Date {
  if (value instanceof Date) return value;
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? new Date(0) : date;
}

function toFlag(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value !== 0n;
  if (typeof value === 'string') return value === '1' || value === 'true';
  return Number(value) === 1;
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string' || value.length === 0) return null;
  try {
    return JSON.parse(value);
  } catch {
    // A stored payload is always JSON; anything else is returned as text.
    return value;
  }
}

function requireText(value: unknown, name: string, fn: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${fn}: ${name} must be a non-empty string`);
  }
  return value;
}

function optionalText(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

// ============================================================================
// Write
// ============================================================================

/** Input for {@link recordAiTranscript}: payloads already redacted and capped. */
export interface AiTranscriptInput {
  callId: string;
  runId?: string | null;
  tenantId?: string | null;
  promptKey?: string | null;
  templateHash?: string | null;
  provider?: string | null;
  model?: string | null;
  /** `message`, `chat`, `complete`, `stream`, `decision`, … */
  operation: string;
  className?: string | null;
  /** JSON text of the request part (`{ messages, options }`). */
  request: string | null;
  /** JSON text of the response part (`{ messages, finishReason? }`). */
  response: string | null;
  /** JSON text of the tool events (an array), or `null` for none. */
  toolEvents: string | null;
  truncated: boolean;
  /** Stored size of request + response + tool events, in UTF-8 bytes. */
  bytes: number;
  createdAt?: Date;
}

/**
 * Insert one transcript row. Callers pass payloads that are already redacted
 * and within the byte cap; this function stores them as given.
 */
export async function recordAiTranscript(
  db: DatabaseInterface,
  input: AiTranscriptInput,
): Promise<{ id: string }> {
  const id = crypto.randomUUID();
  const callId = requireText(input.callId, 'callId', 'recordAiTranscript');
  const operation = requireText(
    input.operation,
    'operation',
    'recordAiTranscript',
  );
  if (!Number.isSafeInteger(input.bytes) || input.bytes < 0) {
    throw new TypeError(
      'recordAiTranscript: bytes must be a non-negative integer',
    );
  }
  await db.query(
    `INSERT INTO ${AI_TRANSCRIPTS_TABLE}
      (id, call_id, run_id, tenant_id, prompt_key, template_hash, provider,
       model, operation, class_name, request, response, tool_events,
       truncated, bytes, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
    id,
    callId,
    optionalText(input.runId),
    optionalText(input.tenantId),
    optionalText(input.promptKey),
    optionalText(input.templateHash),
    optionalText(input.provider),
    optionalText(input.model),
    operation,
    optionalText(input.className),
    input.request,
    input.response,
    input.toolEvents,
    input.truncated ? 1 : 0,
    input.bytes,
    (input.createdAt ?? new Date()).toISOString(),
  );
  return { id };
}

// ============================================================================
// Read
// ============================================================================

/** Filters for {@link listAiTranscripts}. */
export interface AiTranscriptListOptions {
  /**
   * Who reads: a user id, service or CLI operator. Required; it is written
   * to the audit event of the read.
   */
  actor: string;
  /** Why (audit `reason`). */
  reason?: string;
  /**
   * Tenant whose transcripts to read; `null` reads global (tenant-less)
   * rows. Required unless `allowCrossTenant` is set.
   */
  tenantId?: string | null;
  /**
   * Reviewed cross-tenant read (operators, the CLI): without `tenantId`,
   * rows of every tenant are returned. Joins stay within each row's tenant.
   */
  allowCrossTenant?: boolean;
  callId?: string;
  runId?: string;
  promptKey?: string;
  templateHash?: string;
  /** Only transcripts with an evaluation labelled with this name. */
  label?: string;
  /** Only transcripts with at least one evaluation label. */
  labelled?: boolean;
  since?: Date;
  until?: Date;
  /** Default 50, at most 500. */
  limit?: number;
  /**
   * Audit writer for the read. Default: the active audit context's writer
   * (`withAuditContext()`), else a structured `info` log line.
   */
  audit?: AuditWriter;
}

/** One stored transcript, payloads parsed. */
export interface AiTranscriptRecord {
  id: string;
  callId: string;
  runId: string | null;
  tenantId: string | null;
  promptKey: string | null;
  templateHash: string | null;
  provider: string | null;
  model: string | null;
  operation: string;
  className: string | null;
  request: unknown;
  response: unknown;
  toolEvents: unknown;
  truncated: boolean;
  bytes: number;
  createdAt: Date;
}

/** A transcript with the usage rows of its call and their labels. */
export interface AiTranscriptWithUsage extends AiTranscriptRecord {
  /** `_smrt_ai_usage` rows sharing `entry_call_id` (same tenant), oldest first. */
  usage: AiEvaluationUsageRow[];
  /**
   * Evaluations naming one of its calls (`call_id`) or its run (`run_id`)
   * (same tenant), newest first.
   */
  evaluations: AiEvaluationRecord[];
}

/** The transcript read was refused before any query ran. */
export class AiTranscriptScopeError extends Error {
  readonly code = 'AI_TRANSCRIPT_TENANT_REQUIRED';

  constructor(message: string) {
    super(message);
    this.name = 'AiTranscriptScopeError';
  }
}

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 500;

function hydrateTranscript(row: Record<string, unknown>): AiTranscriptRecord {
  return {
    id: String(row.id),
    callId: String(row.call_id),
    runId: nullableString(row.run_id),
    tenantId: nullableString(row.tenant_id),
    promptKey: nullableString(row.prompt_key),
    templateHash: nullableString(row.template_hash),
    provider: nullableString(row.provider),
    model: nullableString(row.model),
    operation: String(row.operation),
    className: nullableString(row.class_name),
    request: parseJson(row.request),
    response: parseJson(row.response),
    toolEvents: parseJson(row.tool_events),
    truncated: toFlag(row.truncated),
    bytes: toSafeInteger(row.bytes ?? 0, 'AI transcript bytes'),
    createdAt: toDate(row.created_at),
  };
}

function hydrateUsage(row: Record<string, unknown>): AiEvaluationUsageRow {
  return {
    id: String(row.id),
    provider: String(row.provider),
    model: String(row.model),
    operation: String(row.operation),
    className: nullableString(row.class_name),
    tenantId: nullableString(row.tenant_id),
    promptKey: nullableString(row.prompt_key),
    tierRequested: nullableString(row.tier_requested),
    tierResolved: nullableString(row.tier_resolved),
    runId: nullableString(row.run_id),
    callId: nullableString(row.call_id),
    entryCallId: nullableString(row.entry_call_id),
    totalTokens:
      row.total_tokens === null || row.total_tokens === undefined
        ? null
        : toSafeInteger(row.total_tokens, 'AI usage total tokens'),
    estimatedCost: nullableNumber(row.estimated_cost),
    duration: toSafeInteger(row.duration ?? 0, 'AI usage duration'),
    createdAt: toDate(row.created_at),
  };
}

function hydrateEvaluation(row: Record<string, unknown>): AiEvaluationRecord {
  const valueType = String(row.value_type) as AiEvaluationRecord['valueType'];
  const stored = row.value;
  return {
    id: String(row.id),
    callId: nullableString(row.call_id),
    runId: nullableString(row.run_id),
    metric: String(row.metric),
    value:
      stored === null || stored === undefined
        ? null
        : valueType === 'number'
          ? nullableNumber(stored)
          : valueType === 'boolean'
            ? String(stored) === 'true'
            : String(stored),
    valueType,
    scale: nullableString(row.scale),
    label: nullableString(row.label),
    evidence: nullableString(row.evidence),
    evaluator: String(row.evaluator),
    tenantId: nullableString(row.tenant_id),
    createdAt: toDate(row.created_at),
  };
}

/** Same tenant, `null` matching `null`. */
function sameTenant(a: string | null, b: string | null): boolean {
  return a === b;
}

async function auditTranscriptRead(
  db: DatabaseInterface,
  options: AiTranscriptListOptions,
  rows: AiTranscriptRecord[],
): Promise<void> {
  const writer = options.audit ?? getActiveAuditOptions()?.writer;
  const source = getActiveAuditOptions()?.source;
  if (!writer) {
    // No audit writer in scope: the read still leaves a structured record.
    // Content never reaches the log, only identities.
    logger.info('[smrt] AI transcript read', {
      actor: options.actor,
      ...(options.reason ? { reason: options.reason } : {}),
      tenantId:
        options.tenantId === undefined ? '(cross-tenant)' : options.tenantId,
      callId: options.callId,
      runId: options.runId,
      promptKey: options.promptKey,
      rows: rows.length,
      ids: rows.map((row) => row.id).join(','),
    });
    return;
  }
  // One event per transcript returned, attributed to that row's tenant, so a
  // tenant's audit trail shows every read of its content. A failing writer
  // fails the read: content is never returned unaudited.
  for (const row of rows) {
    await writer(
      {
        actorId: options.actor,
        ...(options.reason ? { reason: options.reason } : {}),
        ...(source ? { source } : {}),
        action: 'read',
        resourceType: AI_TRANSCRIPTS_TABLE,
        resourceId: row.id,
        tenantId: row.tenantId,
        changes: {},
      },
      db,
    );
  }
}

/**
 * Read transcripts, newest first, each joined to the usage rows of its call
 * and their evaluations (joins never cross the transcript's tenant).
 *
 * Tenant-scoped: pass `tenantId` (or `null` for global rows); a read of every
 * tenant needs `allowCrossTenant: true`. `actor` is required and every read
 * writes an audit event (see {@link AiTranscriptListOptions.audit}).
 */
export async function listAiTranscripts(
  db: DatabaseInterface,
  options: AiTranscriptListOptions,
): Promise<AiTranscriptWithUsage[]> {
  requireText(options?.actor, 'actor', 'listAiTranscripts');
  if (options.tenantId === undefined && options.allowCrossTenant !== true) {
    throw new AiTranscriptScopeError(
      'listAiTranscripts: pass tenantId (null for global rows), or allowCrossTenant: true for a reviewed cross-tenant read',
    );
  }
  const requested = options.limit ?? DEFAULT_LIST_LIMIT;
  if (!Number.isSafeInteger(requested) || requested < 1) {
    throw new TypeError('listAiTranscripts: limit must be a positive integer');
  }
  const limit = Math.min(requested, MAX_LIST_LIMIT);

  const conditions: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, value: unknown) => {
    params.push(value);
    conditions.push(sql.replace('?', `$${params.length}`));
  };
  if (options.tenantId === null) conditions.push('t.tenant_id IS NULL');
  else if (options.tenantId !== undefined) {
    add('t.tenant_id = ?', options.tenantId);
  }
  if (options.callId !== undefined) add('t.call_id = ?', options.callId);
  if (options.runId !== undefined) add('t.run_id = ?', options.runId);
  if (options.promptKey !== undefined) {
    add('t.prompt_key = ?', options.promptKey);
  }
  if (options.templateHash !== undefined) {
    add('t.template_hash = ?', options.templateHash);
  }
  if (options.since) add('t.created_at >= ?', options.since.toISOString());
  if (options.until) add('t.created_at <= ?', options.until.toISOString());
  if (options.label !== undefined || options.labelled === true) {
    let label = '';
    if (options.label !== undefined) {
      params.push(options.label);
      label = `o.label = $${params.length} AND `;
    }
    // Served by the evaluation indexes on call_id / run_id and by
    // idx_smrt_ai_usage_entry_call; the tenant equality keeps the join
    // in-tenant.
    conditions.push(`EXISTS (
      SELECT 1 FROM _smrt_ai_evaluations o
       WHERE ${label}o.label IS NOT NULL
         AND (o.tenant_id = t.tenant_id OR (o.tenant_id IS NULL AND t.tenant_id IS NULL))
         AND ((t.run_id IS NOT NULL AND o.run_id = t.run_id)
              OR o.call_id IN (SELECT u.id FROM _smrt_ai_usage u WHERE u.entry_call_id = t.call_id
                AND (u.tenant_id = t.tenant_id OR (u.tenant_id IS NULL AND t.tenant_id IS NULL)))))`);
  }
  params.push(limit);

  const transcripts = getRows(
    await db.query(
      `SELECT t.id, t.call_id, t.run_id, t.tenant_id, t.prompt_key, t.template_hash,
              t.provider, t.model, t.operation, t.class_name, t.request, t.response,
              t.tool_events, t.truncated, t.bytes, t.created_at
         FROM ${AI_TRANSCRIPTS_TABLE} t
        ${conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''}
        ORDER BY t.created_at DESC, t.id DESC
        LIMIT $${params.length}`,
      ...params,
    ),
  ).map(hydrateTranscript);

  await auditTranscriptRead(db, options, transcripts);
  if (transcripts.length === 0) return [];

  const callIds = [...new Set(transcripts.map((row) => row.callId))];
  const runIds = [
    ...new Set(transcripts.flatMap((row) => (row.runId ? [row.runId] : []))),
  ];
  const usageParams: unknown[] = [];
  const list = (target: unknown[], values: string[]) =>
    values
      .map((value) => {
        target.push(value);
        return `$${target.length}`;
      })
      .join(', ');
  // A scoped read joins only its own tenant's rows (null: global rows).
  const scoped = (target: unknown[]) =>
    options.tenantId === undefined
      ? ''
      : options.tenantId === null
        ? ' AND tenant_id IS NULL'
        : ` AND tenant_id = $${target.push(options.tenantId)}`;
  const usage = getRows(
    await db.query(
      `SELECT id, provider, model, operation, class_name, tenant_id, prompt_key,
              tier_requested, tier_resolved, run_id, call_id, entry_call_id,
              total_tokens, estimated_cost, duration_ms AS duration, created_at
         FROM _smrt_ai_usage
        WHERE entry_call_id IN (${list(usageParams, callIds)})${scoped(usageParams)}
        ORDER BY created_at ASC, id ASC`,
      ...usageParams,
    ),
  ).map(hydrateUsage);

  const usageIds = [...new Set(usage.map((row) => row.id))];
  const evaluationParams: unknown[] = [];
  const predicates: string[] = [];
  if (runIds.length > 0) {
    predicates.push(`run_id IN (${list(evaluationParams, runIds)})`);
  }
  if (usageIds.length > 0) {
    predicates.push(`call_id IN (${list(evaluationParams, usageIds)})`);
  }
  const evaluations =
    predicates.length === 0
      ? []
      : getRows(
          await db.query(
            `SELECT id, call_id, run_id, metric, value, value_type, scale, label,
                    evidence, evaluator, tenant_id, created_at
               FROM _smrt_ai_evaluations
              WHERE (${predicates.join(' OR ')})${scoped(evaluationParams)}
              ORDER BY created_at DESC, id DESC`,
            ...evaluationParams,
          ),
        ).map(hydrateEvaluation);

  return transcripts.map((transcript) => {
    const rows = usage.filter(
      (row) =>
        row.entryCallId === transcript.callId &&
        sameTenant(row.tenantId, transcript.tenantId),
    );
    const ids = new Set(rows.map((row) => row.id));
    return {
      ...transcript,
      usage: rows,
      evaluations: evaluations.filter(
        (evaluation) =>
          sameTenant(evaluation.tenantId, transcript.tenantId) &&
          ((transcript.runId !== null &&
            evaluation.runId === transcript.runId) ||
            (evaluation.callId !== null && ids.has(evaluation.callId))),
      ),
    };
  });
}
