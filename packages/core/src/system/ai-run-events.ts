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
  maskSecretFieldsInJsonText,
  redactAiTranscriptMessages,
  redactAiTranscriptPart,
} from '../ai-transcripts.js';
import {
  AI_RUN_COLUMNS,
  AiRunNotFoundError,
  type AiRunRow,
  type AiRunTx,
  type AiRunTxOptions,
  aiRunQuery,
  assertAiRunFence,
  dateOrNull,
  forUpdate,
  getAiRun,
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

/** A `check` event's status: the host check passed or failed. */
export const AI_RUN_CHECK_STATUSES = Object.freeze([
  'passed',
  'failed',
] as const);

/**
 * An `approval` event's status (page section 2): the request is `requested`;
 * the decision is `approved` or `refused` and its `parent_event_id` is the
 * request (which may be in another run, the earlier chat turn, and may no
 * longer resolve).
 */
export const AI_RUN_APPROVAL_STATUSES = Object.freeze([
  'requested',
  'approved',
  'refused',
] as const);

/**
 * A `handoff` event's status: `running` while its child runs, then the
 * child's end: `done`, `stopped`, `cancelled` or `failed`.
 */
export const AI_RUN_HANDOFF_STATUSES = Object.freeze([
  'running',
  'done',
  'stopped',
  'cancelled',
  'failed',
] as const);

function checkEventStatus(type: AiRunEventType, status: string | null): void {
  const allowed: readonly string[] | null =
    type === 'check'
      ? AI_RUN_CHECK_STATUSES
      : type === 'approval'
        ? AI_RUN_APPROVAL_STATUSES
        : type === 'handoff'
          ? AI_RUN_HANDOFF_STATUSES
          : null;
  if (allowed && (status === null || !allowed.includes(status))) {
    throw new TypeError(
      `A ${type} event's status must be one of ${allowed.join(', ')}, got ${String(status)}`,
    );
  }
}

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
  tenantId: string | null,
  options: AppendAiRunEventOptions,
): Promise<unknown> {
  if (input.payload === undefined || input.payload === null) return null;
  const context = {
    runId,
    type: input.type,
    name: input.name ?? null,
  };
  const payload = options.redact
    ? await options.redact(input.payload, context)
    : input.payload;
  // The transcripts' redaction path (page section 8): the host redactor with
  // the run's tenant, then the built-in one.
  const messages = await redactAiTranscriptPart(
    [{ role: 'event', content: payload }],
    {
      part: 'tools',
      callId: input.callId ?? runId,
      tenantId,
      operation: `run-event:${input.type}`,
    },
    {},
  );
  return messages[0]?.content ?? null;
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
            call_state, reserved_tokens, reserved_cost, created_at)
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
 * transaction opens. Appending does not write the run row. With
 * `options.fence`, a worker whose job claim was taken over is refused
 * (`AiRunClaimLostError`) before it appends.
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
  checkEventStatus(input.type, input.status ?? null);
  // The tenant the payload was redacted for; the final lock is taken in it.
  let tenantId: string | null | undefined;
  if (input.payload !== undefined && input.payload !== null) {
    // The host redactor applies the run's tenant rules, so it needs the
    // run's tenant before anything is stored. Read behind the claim fence,
    // like every other step of an append: a worker whose claim was taken
    // over gets AiRunClaimLostError before the run is read or redacted.
    tenantId = await withAiRunTransaction(
      db,
      async (tx) => {
        await assertAiRunFence(tx, runId, options.fence);
        const run = await getAiRun(tx.db, runId);
        if (!run) throw new AiRunNotFoundError(runId);
        return run.tenantId ?? null;
      },
      options,
    );
  }
  const redacted = await redactPayload(input, runId, tenantId ?? null, options);
  const capped = capAiRunEventPayload(redacted, options.maxPayloadBytes);
  const id = input.id ?? newAiRunId();
  const seq = await withAiRunTransaction(
    db,
    async (tx) => {
      await assertAiRunFence(tx, runId, options.fence);
      // Locked in the tenant the payload was redacted for: a run whose id
      // was pruned and reused by another tenant while the redactor ran is
      // not found, and the payload is never written into its trajectory.
      const scoped =
        tenantId === undefined
          ? { sql: '', params: [] as unknown[] }
          : tenantId === null
            ? { sql: ' AND tenant_id IS NULL', params: [] as unknown[] }
            : { sql: ' AND tenant_id = $2', params: [tenantId] };
      const locked = getRows(
        await aiRunQuery(
          tx.db,
          `SELECT id FROM _smrt_ai_runs WHERE id = $1${scoped.sql}${forUpdate(tx)}`,
          runId,
          ...scoped.params,
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
    reservation: text(row.call_state) as AiRunReservationState | null,
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
  completion_tokens, total_tokens, estimated_cost, duration_ms AS duration, step_index,
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
  return readTrajectory(db, target, undefined);
}

/** SQL predicate on `tenant_id` (null-safe) at parameter `index`. */
function tenantPredicate(
  tenant: string | null,
  index: number,
  column = 'tenant_id',
): { sql: string; params: unknown[] } {
  return tenant === null
    ? { sql: `${column} IS NULL`, params: [] }
    : { sql: `${column} = $${index}`, params: [tenant] };
}

/**
 * {@link getRunTrajectory}, with the run read in `tenant` when one is given:
 * the tenant is a predicate of the run's lookup and of every event page, so
 * the run (and its events) can never be another tenant's, even if the id was
 * pruned and reused between statements.
 */
/** The read-time redaction of one stored payload (built-in rules only). */
function redactStoredPayload(payload: unknown): unknown {
  const envelope = payload as {
    truncated?: unknown;
    head?: unknown;
    tail?: unknown;
  } | null;
  const fragment = (value: unknown) =>
    typeof value === 'string'
      ? String(
          redactAiTranscriptMessages([
            { role: 'event', content: maskSecretFieldsInJsonText(value) },
          ])[0]?.content ?? '',
        )
      : value;
  if (
    envelope &&
    typeof envelope === 'object' &&
    envelope.truncated === true &&
    ('head' in envelope || 'tail' in envelope)
  ) {
    return {
      ...envelope,
      head: fragment(envelope.head),
      tail: fragment(envelope.tail),
    };
  }
  return (
    redactAiTranscriptMessages([{ role: 'event', content: payload }])[0]
      ?.content ?? null
  );
}

async function readTrajectory(
  db: DatabaseInterface,
  target: string | { runId: string } | { callId: string },
  expectedTenant: string | null | undefined,
): Promise<AiRunTrajectory | null> {
  if (typeof target === 'object' && 'callId' in target) {
    const usage = getRows(
      await aiRunQuery(
        db,
        `SELECT ${USAGE_COLUMNS}, run_id, tenant_id FROM _smrt_ai_usage WHERE id = $1`,
        target.callId,
      ),
    );
    if (!usage[0]) return null;
    const runId = text(usage[0].run_id);
    const usageTenant = text(usage[0].tenant_id) ?? null;
    if (runId) {
      // A usage row leads only to a run of its own tenant: `run_id` is not a
      // foreign key, so a row naming another tenant's run is read as a call
      // on its own. The run is read in the row's tenant (one query, a SQL
      // predicate), never checked first and read after.
      const inRun = await readTrajectory(db, runId, usageTenant);
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
                WHERE call_id = $1 AND ${
                  usageTenant === null ? 'tenant_id IS NULL' : 'tenant_id = $2'
                } ORDER BY created_at, id`,
              target.callId,
              ...(usageTenant === null ? [] : [usageTenant]),
            ),
          ).map(toEvaluation),
        },
      ],
      pruned: null,
    };
  }
  const runId = typeof target === 'string' ? target : target.runId;
  const expected =
    expectedTenant === undefined
      ? { sql: '', params: [] as unknown[] }
      : (() => {
          const predicate = tenantPredicate(expectedTenant, 2, 'r.tenant_id');
          return { sql: ` AND ${predicate.sql}`, params: predicate.params };
        })();
  const runRows = getRows(
    await aiRunQuery(
      db,
      `SELECT ${AI_RUN_COLUMNS} FROM _smrt_ai_runs r WHERE r.id = $1${expected.sql}`,
      runId,
      ...expected.params,
    ),
  );
  if (!runRows[0]) return null;
  const run = toAiRunRow(runRows[0]);
  const runEvaluations = getRows(
    await aiRunQuery(
      db,
      `SELECT ${EVALUATION_COLUMNS} FROM _smrt_ai_evaluations
        WHERE run_id = $1 AND ${
          run.tenantId === null ? 'tenant_id IS NULL' : 'tenant_id = $2'
        } ORDER BY created_at, id`,
      runId,
      ...(run.tenantId === null ? [] : [run.tenantId]),
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
        // Events of this run only while the run with this id is the one
        // read above (its tenant), page after page.
        `SELECT * FROM _smrt_ai_run_events e
          WHERE e.run_id = $1 AND e.seq > $2
            AND EXISTS (SELECT 1 FROM _smrt_ai_runs r
                         WHERE r.id = e.run_id AND ${
                           tenantPredicate(run.tenantId, 4, 'r.tenant_id').sql
})
          ORDER BY e.seq LIMIT $3`,
        runId,
        lastSeq,
        PAGE,
        ...tenantPredicate(run.tenantId, 4).params,
      ),
    ).map(toAiRunEvent);
    if (page.length === 0) break;
    // Stored payloads go through the built-in redactor again on read (the
    // host redactor runs on the write path only): a payload stored under an
    // earlier version is masked by today's built-in rules. A truncated
    // payload's `head` and `tail` are fragments of JSON text that field
    // rules cannot parse, so they are masked at string level (credential
    // fields and token shapes), never returned as stored.
    for (const event of page) {
      if (event.payload === null || event.payload === undefined) continue;
      event.payload = redactStoredPayload(event.payload);
    }
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
    // Usage rows and evaluations join only within the run's tenant.
    const tenantParams = run.tenantId === null ? [] : [run.tenantId];
    const tenantSql = (index: number) =>
      run.tenantId === null ? 'tenant_id IS NULL' : `tenant_id = $${index}`;
    if (callIds.length > 0) {
      const marks = callIds.map((_, i) => `$${i + 1}`).join(', ');
      for (const row of getRows(
        await aiRunQuery(
          db,
          // A call's own row only: its id, this run, the run's tenant.
          `SELECT ${USAGE_COLUMNS} FROM _smrt_ai_usage
            WHERE id IN (${marks}) AND run_id = $${callIds.length + 1}
              AND ${tenantSql(callIds.length + 2)}`,
          ...callIds,
          runId,
          ...tenantParams,
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
            WHERE call_id IN (${marks}) AND ${tenantSql(callIds.length + 1)}
            ORDER BY created_at, id`,
          ...callIds,
          ...tenantParams,
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

/**
 * Move a `handoff` event to the end of its child run (page section 2): from
 * `running` to `done`, `stopped`, `cancelled` or `failed`. Guarded on
 * `running`, so it is written once; returns whether it was. The parent's row
 * is locked first on PostgreSQL, as for any write of its events.
 */
export async function closeAiRunHandoff(
  db: DatabaseInterface,
  runId: string,
  eventId: string,
  status: Exclude<(typeof AI_RUN_HANDOFF_STATUSES)[number], 'running'>,
  options: AiRunTxOptions = {},
): Promise<boolean> {
  checkEventStatus('handoff', status);
  return withAiRunTransaction(
    db,
    async (tx) => {
      const locked = getRows(
        await aiRunQuery(
          tx.db,
          `SELECT id FROM _smrt_ai_runs WHERE id = $1${forUpdate(tx)}`,
          runId,
        ),
      );
      if (!locked[0]) return false;
      const rows = getRows(
        await aiRunQuery(
          tx.db,
          `UPDATE _smrt_ai_run_events SET status = $3
            WHERE run_id = $1 AND id = $2 AND type = 'handoff'
              AND status = 'running'
            RETURNING id`,
          runId,
          eventId,
          status,
        ),
      );
      return rows.length > 0;
    },
    options,
  );
}

/** A run's check and approval counts (page sections 2 and 8). */
export interface AiRunEventCounts {
  checksPassed: number;
  checksFailed: number;
  /** Decisions `approved` recorded in this run. */
  approvalsGiven: number;
  /** Decisions `refused` recorded in this run. */
  approvalsRefused: number;
  /** Requests recorded in this run; never a decision. */
  approvalsRequested: number;
}

/**
 * Count a run's checks and approvals from its events, by the page's rules: a
 * decision counts once, in the run that recorded it, whether or not its
 * request is in the same run or still exists; a request counts only as
 * requested. The approval rate is `approvalsGiven / (approvalsGiven +
 * approvalsRefused)`. A pruned trajectory returns its saved counts
 * (`approvalsRequested` is then not known and is 0).
 */
export async function countAiRunEvents(
  db: DatabaseInterface,
  runId: string,
): Promise<AiRunEventCounts> {
  const run = getRows(
    await aiRunQuery(
      db,
      `SELECT trajectory_pruned, checks_passed, checks_failed, approvals_given,
              approvals_refused
         FROM _smrt_ai_runs WHERE id = $1`,
      runId,
    ),
  )[0];
  if (
    run &&
    (num(run.trajectory_pruned) !== 0 || run.trajectory_pruned === true)
  ) {
    return {
      checksPassed: num(run.checks_passed),
      checksFailed: num(run.checks_failed),
      approvalsGiven: num(run.approvals_given),
      approvalsRefused: num(run.approvals_refused),
      approvalsRequested: 0,
    };
  }
  const counts: AiRunEventCounts = {
    checksPassed: 0,
    checksFailed: 0,
    approvalsGiven: 0,
    approvalsRefused: 0,
    approvalsRequested: 0,
  };
  for (const row of getRows(
    await aiRunQuery(
      db,
      `SELECT type, status, COUNT(*) AS n FROM _smrt_ai_run_events
        WHERE run_id = $1 AND type IN ('check', 'approval')
        GROUP BY type, status`,
      runId,
    ),
  )) {
    const n = num(row.n);
    const key = `${String(row.type)}:${String(row.status)}`;
    if (key === 'check:passed') counts.checksPassed += n;
    else if (key === 'check:failed') counts.checksFailed += n;
    else if (key === 'approval:approved') counts.approvalsGiven += n;
    else if (key === 'approval:refused') counts.approvalsRefused += n;
    else if (key === 'approval:requested') counts.approvalsRequested += n;
  }
  return counts;
}

/** `approved / (approved + refused)`, or null when nothing was decided. */
export function aiRunApprovalRate(counts: {
  approvalsGiven: number;
  approvalsRefused: number;
}): number | null {
  const decided = counts.approvalsGiven + counts.approvalsRefused;
  return decided > 0 ? counts.approvalsGiven / decided : null;
}
