/**
 * Ordered events of an AI run and the trajectory reader (#5005; page
 * sections 2 and 4).
 *
 * `seq` is allocated in the same transaction as the insert, as one more than
 * the run's largest, and `(run_id, seq)` is unique, so two appenders never
 * share a `seq`. On PostgreSQL the transaction locks the run row first, so
 * appenders of one run take turns; SQLite and DuckDB write transactions are
 * exclusive already. An insert that still collides is retried with a fresh
 * `seq` a bounded number of times. No transaction is held across a model
 * call: appending is its own short transaction.
 */

import type { DatabaseInterface } from '@happyvertical/sql';
import {
  type AiTranscriptMessage,
  getTranscriptRedactor,
  redactAiTranscriptMessages,
} from '../ai-transcripts.js';
import {
  AI_RUN_COLUMNS,
  AiRunNotFoundError,
  type AiRunRow,
  type AiRunTx,
  type AiRunTxOptions,
  aiRunQuery,
  dateOrNull,
  forUpdate,
  getRows,
  newAiRunId,
  num,
  text,
  toAiRunRow,
  withAiRunTransaction,
} from './ai-run-model.js';

/** The kinds of event a run records. */
export type AiRunEventType =
  | 'call'
  | 'action'
  | 'observation'
  | 'check'
  | 'approval'
  | 'handoff';

export const AI_RUN_EVENT_TYPES: readonly AiRunEventType[] = Object.freeze([
  'call',
  'action',
  'observation',
  'check',
  'approval',
  'handoff',
]);

/** A call event's reservation state (page section 6.4). */
export type AiRunReservationState =
  | 'reserved'
  | 'settled'
  | 'released'
  | 'abandoned'
  | 'settled_late'
  | 'unreserved';

/** Default cap of one event payload, in bytes of its JSON. */
export const AI_RUN_EVENT_PAYLOAD_MAX_BYTES = 16_384;

/** Collisions on `(run_id, seq)` retried before the append gives up. */
const SEQ_ATTEMPTS = 5;

/** Host redaction of an event payload, before the built-in redactor. */
export type AiRunEventRedactor = (
  payload: unknown,
  context: { runId: string; type: AiRunEventType; name: string | null },
) => unknown | Promise<unknown>;

/** Input of {@link appendAiRunEvent}. */
export interface AiRunEventInput {
  type: AiRunEventType;
  /** Stable id; minted when absent. */
  id?: string;
  parentEventId?: string | null;
  callId?: string | null;
  stepIndex?: number | null;
  name?: string | null;
  status?: string | null;
  duration?: number | null;
  /** JSON-serializable; redacted, then capped (head and tail kept). */
  payload?: unknown;
  /** A pointer at content the host already stores (a chat message, a file). */
  payloadRef?: string | null;
  /** For a `handoff` to a child run. */
  childRunId?: string | null;
}

/** Options of {@link appendAiRunEvent}. */
export interface AppendAiRunEventOptions extends AiRunTxOptions {
  /** Payload cap in bytes; default {@link AI_RUN_EVENT_PAYLOAD_MAX_BYTES}. */
  maxPayloadBytes?: number;
  /** Runs before the built-in redactor (which always runs). */
  redact?: AiRunEventRedactor;
}

/** One stored event. */
export interface AiRunEvent {
  id: string;
  runId: string;
  seq: number;
  parentEventId: string | null;
  type: AiRunEventType;
  callId: string | null;
  stepIndex: number | null;
  name: string | null;
  status: string | null;
  duration: number | null;
  payload: unknown;
  payloadRef: string | null;
  truncated: boolean;
  childRunId: string | null;
  reservation: AiRunReservationState | null;
  reservedTokens: number | null;
  reservedCost: number | null;
  createdAt: Date;
}

const encoder = new TextEncoder();

/**
 * The payload as stored: JSON within `maxBytes`, or, when it is larger, a
 * JSON envelope keeping its head and tail with `truncated` set.
 */
export function capAiRunEventPayload(
  payload: unknown,
  maxBytes = AI_RUN_EVENT_PAYLOAD_MAX_BYTES,
): { payload: string | null; truncated: boolean } {
  if (payload === undefined || payload === null) {
    return { payload: null, truncated: false };
  }
  const json = JSON.stringify(payload);
  const bytes = encoder.encode(json).length;
  if (bytes <= maxBytes) return { payload: json, truncated: false };
  let keep = Math.max(0, Math.floor(maxBytes / 2) - 64);
  for (;;) {
    const envelope = JSON.stringify({
      truncated: true,
      originalBytes: bytes,
      head: json.slice(0, keep),
      tail: keep > 0 ? json.slice(-keep) : '',
    });
    if (encoder.encode(envelope).length <= maxBytes || keep === 0) {
      return { payload: envelope, truncated: true };
    }
    keep = Math.floor(keep * 0.85);
  }
}

async function redactPayload(
  input: AiRunEventInput,
  runId: string,
  redact: AiRunEventRedactor | undefined,
): Promise<unknown> {
  if (input.payload === undefined || input.payload === null) return null;
  const context = {
    runId,
    type: input.type,
    name: input.name ?? null,
  };
  let payload = redact ? await redact(input.payload, context) : input.payload;
  // The transcript host redactor and the built-in one (page section 8: the
  // same redactor transcripts use).
  let messages: AiTranscriptMessage[] = [{ role: 'event', content: payload }];
  const host = getTranscriptRedactor();
  if (host) {
    messages = await host(messages, {
      part: 'tools',
      callId: input.callId ?? runId,
      tenantId: null,
      operation: `run-event:${input.type}`,
    });
  }
  messages = redactAiTranscriptMessages(messages);
  payload = messages[0]?.content ?? null;
  return payload;
}

/**
 * Insert one event inside an open accounting transaction whose caller holds
 * (on PostgreSQL) the run row's lock. Returns the allocated `seq`.
 */
export async function insertAiRunEventTx(
  tx: AiRunTx,
  runId: string,
  event: {
    id: string;
    type: AiRunEventType;
    parentEventId?: string | null;
    callId?: string | null;
    stepIndex?: number | null;
    name?: string | null;
    status?: string | null;
    duration?: number | null;
    payload?: string | null;
    payloadRef?: string | null;
    truncated?: boolean;
    childRunId?: string | null;
    reservation?: AiRunReservationState | null;
    reservedTokens?: number | null;
    reservedCost?: number | null;
  },
): Promise<number> {
  for (let attempt = 1; attempt <= SEQ_ATTEMPTS; attempt++) {
    const rows = getRows(
      await aiRunQuery(
        tx.db,
        `INSERT INTO _smrt_ai_run_events
           (id, run_id, seq, parent_event_id, type, call_id, step_index, name,
            status, duration, payload, payload_ref, truncated, child_run_id,
            reservation, reserved_tokens, reserved_cost, created_at)
         SELECT $1, $2, COALESCE(MAX(seq), 0) + 1, $3, $4, $5, $6, $7, $8, $9,
                $10, $11, $12, $13, $14, $15, $16, $17
           FROM _smrt_ai_run_events
          WHERE run_id = $2
         ON CONFLICT (run_id, seq) DO NOTHING
         RETURNING seq`,
        event.id,
        runId,
        event.parentEventId ?? null,
        event.type,
        event.callId ?? null,
        event.stepIndex ?? null,
        event.name ?? null,
        event.status ?? null,
        event.duration ?? null,
        event.payload ?? null,
        event.payloadRef ?? null,
        event.truncated ? 1 : 0,
        event.childRunId ?? null,
        event.reservation ?? null,
        event.reservedTokens ?? null,
        event.reservedCost ?? null,
        tx.now.toISOString(),
      ),
    );
    if (rows[0]) return num(rows[0].seq);
  }
  throw new Error(
    `AI run ${runId}: no free event seq after ${SEQ_ATTEMPTS} attempts`,
  );
}

/**
 * Append one event to a run (not a `call` event's reservation: reserving
 * inserts those). The payload is redacted and capped before the
 * transaction opens. Appending does not write the run row.
 */
export async function appendAiRunEvent(
  db: DatabaseInterface,
  runId: string,
  input: AiRunEventInput,
  options: AppendAiRunEventOptions = {},
): Promise<{ id: string; seq: number }> {
  if (!AI_RUN_EVENT_TYPES.includes(input.type)) {
    throw new TypeError(`appendAiRunEvent: unknown event type ${input.type}`);
  }
  const redacted = await redactPayload(input, runId, options.redact);
  const capped = capAiRunEventPayload(redacted, options.maxPayloadBytes);
  const id = input.id ?? newAiRunId();
  const seq = await withAiRunTransaction(
    db,
    async (tx) => {
      const locked = getRows(
        await aiRunQuery(
          tx.db,
          `SELECT id FROM _smrt_ai_runs WHERE id = $1${forUpdate(tx)}`,
          runId,
        ),
      );
      if (!locked[0]) throw new AiRunNotFoundError(runId);
      // A retried transaction may find its own earlier insert committed.
      const existing = getRows(
        await aiRunQuery(
          tx.db,
          'SELECT seq FROM _smrt_ai_run_events WHERE id = $1',
          id,
        ),
      );
      if (existing[0]) return num(existing[0].seq);
      return insertAiRunEventTx(tx, runId, {
        id,
        type: input.type,
        parentEventId: input.parentEventId ?? null,
        callId: input.callId ?? null,
        stepIndex: input.stepIndex ?? null,
        name: input.name ?? null,
        status: input.status ?? null,
        duration: input.duration ?? null,
        payload: capped.payload,
        payloadRef: input.payloadRef ?? null,
        truncated: capped.truncated,
        childRunId: input.childRunId ?? null,
      });
    },
    options,
  );
  return { id, seq };
}

function parsePayload(value: unknown): unknown {
  if (typeof value !== 'string') return value ?? null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export function toAiRunEvent(row: Record<string, unknown>): AiRunEvent {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    seq: num(row.seq),
    parentEventId: text(row.parent_event_id),
    type: String(row.type) as AiRunEventType,
    callId: text(row.call_id),
    stepIndex:
      row.step_index === null || row.step_index === undefined
        ? null
        : num(row.step_index),
    name: text(row.name),
    status: text(row.status),
    duration:
      row.duration === null || row.duration === undefined
        ? null
        : num(row.duration),
    payload: parsePayload(row.payload),
    payloadRef: text(row.payload_ref),
    truncated: num(row.truncated) !== 0 || row.truncated === true,
    childRunId: text(row.child_run_id),
    reservation: text(row.reservation) as AiRunReservationState | null,
    reservedTokens:
      row.reserved_tokens === null || row.reserved_tokens === undefined
        ? null
        : num(row.reserved_tokens),
    reservedCost:
      row.reserved_cost === null || row.reserved_cost === undefined
        ? null
        : num(row.reserved_cost),
    createdAt: dateOrNull(row.created_at) ?? new Date(0),
  };
}

/** A call's usage row, as a trajectory shows it. */
export interface AiRunTrajectoryUsage {
  callId: string;
  entryCallId: string | null;
  provider: string;
  model: string;
  operation: string;
  promptKey: string | null;
  templateHash: string | null;
  tierRequested: string | null;
  tierResolved: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  /** NULL for an uncosted call, never zero. */
  estimatedCost: number | null;
  /** Latency, ms. */
  duration: number;
  stepIndex: number | null;
  stepName: string | null;
  stepInstanceId: string | null;
  attempt: number | null;
  createdAt: Date;
}

/** One evaluation, as a trajectory shows it. */
export interface AiRunTrajectoryEvaluation {
  id: string;
  metric: string;
  value: string | null;
  valueType: string;
  scale: string | null;
  label: string | null;
  evaluator: string;
  createdAt: Date;
}

/** One trajectory entry: an event with its usage row and evaluations. */
export interface AiRunTrajectoryEntry {
  event: AiRunEvent | null;
  /** The usage row of a `call` event; absent once usage was pruned. */
  usage: AiRunTrajectoryUsage | null;
  evaluations: AiRunTrajectoryEvaluation[];
}

/** What {@link getRunTrajectory} returns. */
export interface AiRunTrajectory {
  /** NULL for a call on its own. */
  run: AiRunRow | null;
  /** Evaluations of the run itself. */
  evaluations: AiRunTrajectoryEvaluation[];
  /** Events in `seq` order; empty once the trajectory was pruned. */
  entries: AiRunTrajectoryEntry[];
  /** The saved counts of a pruned trajectory. */
  pruned: null | {
    checksPassed: number;
    checksFailed: number;
    approvalsGiven: number;
    approvalsRefused: number;
  };
}

function toUsage(row: Record<string, unknown>): AiRunTrajectoryUsage {
  const nullableNum = (value: unknown) =>
    value === null || value === undefined ? null : num(value);
  return {
    callId: String(row.id),
    entryCallId: text(row.entry_call_id),
    provider: String(row.provider),
    model: String(row.model),
    operation: String(row.operation),
    promptKey: text(row.prompt_key),
    templateHash: text(row.template_hash),
    tierRequested: text(row.tier_requested),
    tierResolved: text(row.tier_resolved),
    promptTokens: nullableNum(row.prompt_tokens),
    completionTokens: nullableNum(row.completion_tokens),
    totalTokens: nullableNum(row.total_tokens),
    estimatedCost: nullableNum(row.estimated_cost),
    duration: num(row.duration),
    stepIndex: nullableNum(row.step_index),
    stepName: text(row.step_name),
    stepInstanceId: text(row.step_instance_id),
    attempt: nullableNum(row.attempt),
    createdAt: dateOrNull(row.created_at) ?? new Date(0),
  };
}

function toEvaluation(row: Record<string, unknown>): AiRunTrajectoryEvaluation {
  return {
    id: String(row.id),
    metric: String(row.metric),
    value: text(row.value),
    valueType: String(row.value_type ?? 'number'),
    scale: text(row.scale),
    label: text(row.label),
    evaluator: String(row.evaluator),
    createdAt: dateOrNull(row.created_at) ?? new Date(0),
  };
}

const USAGE_COLUMNS = `id, entry_call_id, provider, model, operation, prompt_key,
  template_hash, tier_requested, tier_resolved, prompt_tokens,
  completion_tokens, total_tokens, estimated_cost, duration, step_index,
  step_name, step_instance_id, attempt, created_at`;

const EVALUATION_COLUMNS =
  'id, call_id, run_id, metric, value, value_type, scale, label, evaluator, created_at';

/** Events read per page. */
const PAGE = 500;

/**
 * The run row and its events in `seq` order, each `call` event joined to
 * its usage row (tokens, cost, model, tier, latency) and to its evaluations
 * (page section 4). Pass `{ callId }` for a call on its own: a one-entry
 * trajectory with no run. A pruned trajectory returns the row, its saved
 * counts and no events; a call event whose usage row was pruned comes back
 * without it.
 */
export async function getRunTrajectory(
  db: DatabaseInterface,
  target: string | { runId: string } | { callId: string },
): Promise<AiRunTrajectory | null> {
  if (typeof target === 'object' && 'callId' in target) {
    const usage = getRows(
      await aiRunQuery(
        db,
        `SELECT ${USAGE_COLUMNS}, run_id FROM _smrt_ai_usage WHERE id = $1`,
        target.callId,
      ),
    );
    if (!usage[0]) return null;
    const runId = text(usage[0].run_id);
    if (runId) {
      const inRun = await getRunTrajectory(db, runId);
      if (inRun) return inRun;
    }
    return {
      run: null,
      evaluations: [],
      entries: [
        {
          event: null,
          usage: toUsage(usage[0]),
          evaluations: getRows(
            await aiRunQuery(
              db,
              `SELECT ${EVALUATION_COLUMNS} FROM _smrt_ai_evaluations
                WHERE call_id = $1 ORDER BY created_at, id`,
              target.callId,
            ),
          ).map(toEvaluation),
        },
      ],
      pruned: null,
    };
  }
  const runId = typeof target === 'string' ? target : target.runId;
  const runRows = getRows(
    await aiRunQuery(
      db,
      `SELECT ${AI_RUN_COLUMNS} FROM _smrt_ai_runs r WHERE r.id = $1`,
      runId,
    ),
  );
  if (!runRows[0]) return null;
  const run = toAiRunRow(runRows[0]);
  const runEvaluations = getRows(
    await aiRunQuery(
      db,
      `SELECT ${EVALUATION_COLUMNS} FROM _smrt_ai_evaluations
        WHERE run_id = $1 ORDER BY created_at, id`,
      runId,
    ),
  ).map(toEvaluation);
  if (run.trajectoryPruned) {
    return {
      run,
      evaluations: runEvaluations,
      entries: [],
      pruned: {
        checksPassed: run.checksPassed,
        checksFailed: run.checksFailed,
        approvalsGiven: run.approvalsGiven,
        approvalsRefused: run.approvalsRefused,
      },
    };
  }

  const entries: AiRunTrajectoryEntry[] = [];
  let lastSeq = 0;
  for (;;) {
    const page = getRows(
      await aiRunQuery(
        db,
        `SELECT * FROM _smrt_ai_run_events
          WHERE run_id = $1 AND seq > $2 ORDER BY seq LIMIT $3`,
        runId,
        lastSeq,
        PAGE,
      ),
    ).map(toAiRunEvent);
    if (page.length === 0) break;
    lastSeq = page[page.length - 1]?.seq ?? lastSeq;
    const callIds = [
      ...new Set(
        page
          .filter((event) => event.type === 'call' && event.callId)
          .map((event) => event.callId as string),
      ),
    ];
    const usageById = new Map<string, AiRunTrajectoryUsage>();
    const evaluationsBy = new Map<string, AiRunTrajectoryEvaluation[]>();
    if (callIds.length > 0) {
      const marks = callIds.map((_, i) => `$${i + 1}`).join(', ');
      for (const row of getRows(
        await aiRunQuery(
          db,
          `SELECT ${USAGE_COLUMNS} FROM _smrt_ai_usage WHERE id IN (${marks})`,
          ...callIds,
        ),
      )) {
        usageById.set(String(row.id), toUsage(row));
      }
    }
    if (callIds.length > 0) {
      const marks = callIds.map((_, i) => `$${i + 1}`).join(', ');
      for (const row of getRows(
        await aiRunQuery(
          db,
          `SELECT ${EVALUATION_COLUMNS} FROM _smrt_ai_evaluations
            WHERE call_id IN (${marks}) ORDER BY created_at, id`,
          ...callIds,
        ),
      )) {
        const key = String(row.call_id);
        const list = evaluationsBy.get(key) ?? [];
        list.push(toEvaluation(row));
        evaluationsBy.set(key, list);
      }
    }
    for (const event of page) {
      const key = event.type === 'call' ? event.callId : null;
      entries.push({
        event,
        usage: key ? (usageById.get(key) ?? null) : null,
        evaluations: key ? (evaluationsBy.get(key) ?? []) : [],
      });
    }
    if (page.length < PAGE) break;
  }
  return { run, evaluations: runEvaluations, entries, pruned: null };
}
