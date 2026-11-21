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
  builtInRedactionStamp,
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

/**
 * Smallest cap accepted: always holds the envelope with an empty head and
 * tail, so a stored envelope never exceeds its cap.
 */
const AI_RUN_EVENT_PAYLOAD_MIN_BYTES = 256;

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
  /**
   * JSON-serializable. Serialized once (`toJSON` honoured), redacted, then
   * capped: a larger payload keeps its head and tail (see
   * {@link AiRunEvent.payload} for what a read returns).
   */
  payload?: unknown;
  /** A pointer at content the host already stores (a chat message, a file). */
  payloadRef?: string | null;
  /** For a `handoff` to a child run. */
  childRunId?: string | null;
}

/** Options of {@link appendAiRunEvent}. */
export interface AppendAiRunEventOptions extends AiRunTxOptions {
  /**
   * Payload cap in bytes of stored JSON; default
   * {@link AI_RUN_EVENT_PAYLOAD_MAX_BYTES}. A safe integer of at least 256,
   * or the append throws `RangeError` before anything is read or written.
   */
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
  /**
   * The stored payload, redacted again by the built-in rules on read (the
   * host redactor runs on the write path only). A `truncated` event's
   * payload is `{ truncated: true, originalBytes, head, tail }`: `head` and
   * `tail` are the start and end of the payload's JSON text as written, when
   * the redacting append stored the event under the current built-in rules.
   * Otherwise (stored by an earlier version, under other rules, or by any
   * other writer) neither fragment is returned: `head` and `tail` are empty,
   * `withheld` is `['head', 'tail']`, and `originalBytes` is `null` unless the
   * stored size is a valid byte count. A row whose stored flag is neither
   * cut nor whole (missing, `2`, unrecognised) is never verified: an
   * envelope-shaped payload reads as withheld, any other as whole.
   */
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

function checkPayloadCap(maxBytes: number, caller: string): void {
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < AI_RUN_EVENT_PAYLOAD_MIN_BYTES
  ) {
    throw new RangeError(
      `${caller}: the payload cap must be an integer of at least ${AI_RUN_EVENT_PAYLOAD_MIN_BYTES} bytes (got ${String(maxBytes)})`,
    );
  }
}

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/** `end`, moved back so a cut there never splits a surrogate pair. */
function wholeCharEnd(text: string, end: number): number {
  return end > 0 && isHighSurrogate(text.charCodeAt(end - 1)) ? end - 1 : end;
}

/** `start`, moved forward so a cut there never splits a surrogate pair. */
function wholeCharStart(text: string, start: number): number {
  return start > 0 &&
    start < text.length &&
    isLowSurrogate(text.charCodeAt(start))
    ? start + 1
    : start;
}

/**
 * JSON text as stored: whole within `maxBytes`, or, when larger, the
 * envelope keeping its head and tail. Only the redacting append passes a
 * `stamp` (the built-in rules it redacted under): it is what lets a read
 * return the fragments as written.
 */
function capJsonText(
  json: string,
  maxBytes: number,
  stamp: number | undefined,
): { payload: string; truncated: boolean } {
  const bytes = encoder.encode(json).length;
  if (bytes <= maxBytes) return { payload: json, truncated: false };
  let keep = Math.max(0, Math.floor(maxBytes / 2) - 64);
  for (;;) {
    const envelope = JSON.stringify({
      truncated: true,
      originalBytes: bytes,
      ...(stamp === undefined ? {} : { redaction: stamp }),
      head: json.slice(0, wholeCharEnd(json, keep)),
      tail:
        keep > 0 ? json.slice(wholeCharStart(json, json.length - keep)) : '',
    });
    // The cap is at least AI_RUN_EVENT_PAYLOAD_MIN_BYTES, which always holds
    // the envelope with empty fragments, so this ends within the cap.
    if (encoder.encode(envelope).length <= maxBytes || keep === 0) {
      return { payload: envelope, truncated: true };
    }
    keep = Math.floor(keep * 0.85);
  }
}

/**
 * The payload as stored: JSON within `maxBytes`, or, when it is larger, a
 * JSON envelope keeping its head and tail with `truncated` set. It redacts
 * nothing and does not stamp the envelope, so a row stored from its result
 * reads with both fragments withheld (see {@link AiRunEvent.payload}).
 * `maxBytes` must be a safe integer of at least 256 (`RangeError`).
 */
export function capAiRunEventPayload(
  payload: unknown,
  maxBytes = AI_RUN_EVENT_PAYLOAD_MAX_BYTES,
): { payload: string | null; truncated: boolean } {
  checkPayloadCap(maxBytes, 'capAiRunEventPayload');
  if (payload === undefined || payload === null) {
    return { payload: null, truncated: false };
  }
  return capJsonText(JSON.stringify(payload), maxBytes, undefined);
}

const isBinary = (value: unknown) =>
  ArrayBuffer.isView(value) || value instanceof ArrayBuffer;

/**
 * A value's JSON form as inert data (plain objects and arrays, strings,
 * finite numbers, booleans, null), computed once with JSON's rules: every
 * property is read exactly once, and `toJSON` (own or inherited) runs on
 * that one read and nowhere later. Binary values become `'[binary]'` and an
 * object met again becomes `'[Circular]'` (as the built-in redactor does).
 * What the redactor then sees is exactly what is serialized. `BigInt`
 * throws, as `JSON.stringify` does.
 */
function toInertJson(value: unknown): unknown {
  const seen = new WeakSet<object>();
  const visit = (raw: unknown, key: string): unknown => {
    if (isBinary(raw)) return '[binary]';
    let item = raw;
    if (
      item !== null &&
      (typeof item === 'object' || typeof item === 'bigint')
    ) {
      const toJSON = (item as { toJSON?: unknown }).toJSON;
      if (typeof toJSON === 'function') item = toJSON.call(item, key);
      if (isBinary(item)) return '[binary]';
    }
    if (
      item instanceof Number ||
      item instanceof String ||
      item instanceof Boolean
    ) {
      item = item.valueOf();
    }
    switch (typeof item) {
      case 'string':
      case 'boolean':
        return item;
      case 'number':
        return Number.isFinite(item) ? item : null;
      case 'bigint':
        throw new TypeError('Do not know how to serialize a BigInt');
      case 'undefined':
      case 'function':
      case 'symbol':
        return undefined;
    }
    if (item === null) return null;
    const node = item as object;
    if (seen.has(node)) return '[Circular]';
    seen.add(node);
    if (Array.isArray(node)) {
      const out: unknown[] = [];
      const length = node.length;
      for (let i = 0; i < length; i++) {
        const element = visit(node[i], String(i));
        out.push(element === undefined ? null : element);
      }
      return out;
    }
    const out: Record<string, unknown> = {};
    for (const name of Object.keys(node)) {
      const child = visit((node as Record<string, unknown>)[name], name);
      if (child === undefined) continue;
      // defineProperty: a `__proto__` key stays data, as JSON.parse keeps it.
      Object.defineProperty(out, name, {
        value: child,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return out;
  };
  const result = visit(value, '');
  return result === undefined ? null : result;
}

/**
 * The payload's stored JSON text: the event redactor and the host redactor
 * (with the run's tenant) see the caller's value; it is then materialized
 * once and the built-in redactor runs on that inert value, whose JSON is
 * the text measured and stored.
 */
async function redactPayloadJson(
  input: AiRunEventInput,
  captured: unknown,
  runId: string,
  tenantId: string | null,
  options: AppendAiRunEventOptions,
): Promise<string | null> {
  if (captured === undefined || captured === null) return null;
  const context = {
    runId,
    type: input.type,
    name: input.name ?? null,
  };
  const payload = options.redact
    ? await options.redact(captured, context)
    : captured;
  // The transcripts' redaction path (page section 8): the host redactor with
  // the run's tenant, then the built-in one, here on the materialized value.
  const host = getTranscriptRedactor();
  const messages = [{ role: 'event', content: payload }];
  const hosted = host
    ? await host(messages, {
        part: 'tools',
        callId: input.callId ?? runId,
        tenantId,
        operation: `run-event:${input.type}`,
      })
    : messages;
  const inert = toInertJson(
    Array.isArray(hosted) ? (hosted[0]?.content ?? null) : null,
  );
  const redacted =
    redactAiTranscriptMessages([{ role: 'event', content: inert }])[0]
      ?.content ?? null;
  return redacted === null ? null : JSON.stringify(redacted);
}

/** One event row as {@link insertAiRunEventTx} takes it. */
interface AiRunEventRowInput {
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
}

/**
 * A cut payload handed to the public insert, without a redaction stamp: the
 * stamp says the redacting append produced the text, which no other caller
 * can attest, so such a row reads with its fragments withheld.
 */
function withoutRedactionStamp(
  payload: string | null | undefined,
  truncated: boolean | undefined,
): string | null {
  if (payload === undefined || payload === null || !truncated) {
    return payload ?? null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return payload;
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    !Object.hasOwn(parsed, 'redaction')
  ) {
    return payload;
  }
  const { redaction: _dropped, ...rest } = parsed as Record<string, unknown>;
  return JSON.stringify(rest);
}

/**
 * Insert one event inside an open accounting transaction whose caller holds
 * (on PostgreSQL) the run row's lock. Returns the allocated `seq`. Stores
 * the payload as given, except that a `truncated` payload loses any
 * `redaction` stamp: only {@link appendAiRunEvent} stamps what it redacted,
 * so a cut payload stored here reads with its head and tail withheld.
 */
export async function insertAiRunEventTx(
  tx: AiRunTx,
  runId: string,
  event: AiRunEventRowInput,
): Promise<number> {
  // One read of each declared field (prototype getters included); the stamp
  // strip and the insert use these same values.
  const snapshot: AiRunEventRowInput = {
    id: event.id,
    type: event.type,
    parentEventId: event.parentEventId,
    callId: event.callId,
    stepIndex: event.stepIndex,
    name: event.name,
    status: event.status,
    duration: event.duration,
    payload: event.payload,
    payloadRef: event.payloadRef,
    truncated: event.truncated,
    childRunId: event.childRunId,
    reservation: event.reservation,
    reservedTokens: event.reservedTokens,
    reservedCost: event.reservedCost,
  };
  return insertEventRow(tx, runId, {
    ...snapshot,
    payload: withoutRedactionStamp(snapshot.payload, snapshot.truncated),
  });
}

/** The insert itself; the redacting append's stamped rows go through here. */
async function insertEventRow(
  tx: AiRunTx,
  runId: string,
  event: AiRunEventRowInput,
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
  // Only an omitted cap means the default; null is an invalid cap.
  const maxPayloadBytes =
    options.maxPayloadBytes === undefined
      ? AI_RUN_EVENT_PAYLOAD_MAX_BYTES
      : options.maxPayloadBytes;
  checkPayloadCap(maxPayloadBytes, 'appendAiRunEvent');
  // Read once: the tenant decision and the redaction see the same value.
  const payload = input.payload;
  // The tenant the payload was redacted for; the final lock is taken in it.
  let tenantId: string | null | undefined;
  if (payload !== undefined && payload !== null) {
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
  const json = await redactPayloadJson(
    input,
    payload,
    runId,
    tenantId ?? null,
    options,
  );
  // Only this writer stamps a cut envelope: it redacted the whole value
  // under the built-in rules the stamp names.
  const capped =
    json === null
      ? { payload: null, truncated: false }
      : capJsonText(json, maxPayloadBytes, builtInRedactionStamp());
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
      return insertEventRow(tx, runId, {
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

/**
 * A row's payload as inert data, read once: stored text is parsed; any other
 * value (a host converting rows it built itself) is turned into its JSON
 * form, so no `toJSON` or accessor runs after it is checked. A value that
 * has no JSON form reads as no payload.
 */
function parsePayload(value: unknown): unknown {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  if (value === undefined || value === null) return null;
  try {
    return toInertJson(value);
  } catch {
    return null;
  }
}

/**
 * A row's `truncated` flag, in three states: `'cut'` (`1`, `1n`, `'1'`,
 * `true`, as the writer stores it), `'whole'` (`0`, `0n`, `'0'`, `false`),
 * and `'unclear'` for anything else (a missing column, `2`, an unrecognised
 * value). Only `'cut'` lets an envelope be verified.
 */
type RowFlag = 'cut' | 'whole' | 'unclear';

function rowFlag(value: unknown): RowFlag {
  if (value === 1 || value === 1n || value === '1' || value === true) {
    return 'cut';
  }
  if (value === 0 || value === 0n || value === '0' || value === false) {
    return 'whole';
  }
  return 'unclear';
}

/** A payload that looks like a cut envelope: `truncated: true` with a head or tail. */
function envelopeShaped(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return false;
  }
  const fields = payload as Record<string, unknown>;
  return (
    fields.truncated === true &&
    (Object.hasOwn(fields, 'head') || Object.hasOwn(fields, 'tail'))
  );
}

/** Whether a row reads as cut: always for `'cut'`, for an envelope when unclear. */
function readsAsCut(flag: RowFlag, payload: unknown): boolean {
  return flag === 'cut' || (flag === 'unclear' && envelopeShaped(payload));
}

const ENVELOPE_KEYS = 'head,originalBytes,redaction,tail,truncated';

const byteCount = (value: unknown): number | null =>
  Number.isSafeInteger(value) && (value as number) >= 0
    ? (value as number)
    : null;

/**
 * What a read returns of one stored payload (built-in rules only; the host
 * redactor is never called by a read).
 *
 * - A row flagged whole holds a whole payload: it is redacted as a
 *   structured value, whatever its fields (a payload shaped like an envelope
 *   is caller data). So is a row whose flag is unclear, unless its payload is
 *   shaped like an envelope.
 * - A row flagged cut is returned as written only when it holds exactly the
 *   envelope the redacting append writes, stamped with the current built-in
 *   rules; the stamp is dropped. Any other cut row (no stamp, an older or
 *   newer or malformed one, other fields), and an envelope-shaped row whose
 *   flag is unclear, returns no stored text: its head and tail cannot be
 *   checked against today's rules, and a cut can fall before the delimiter a
 *   rule needs.
 */
function readStoredPayload(payload: unknown, flag: RowFlag): unknown {
  if (!readsAsCut(flag, payload)) {
    if (payload === null || payload === undefined) return null;
    return (
      redactAiTranscriptMessages([{ role: 'event', content: payload }])[0]
        ?.content ?? null
    );
  }
  const fields =
    payload && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : null;
  const originalBytes = byteCount(fields?.originalBytes);
  if (
    flag === 'cut' &&
    fields &&
    Object.keys(fields).sort().join(',') === ENVELOPE_KEYS &&
    fields.truncated === true &&
    originalBytes !== null &&
    typeof fields.head === 'string' &&
    typeof fields.tail === 'string' &&
    Number.isSafeInteger(fields.redaction) &&
    fields.redaction === builtInRedactionStamp()
  ) {
    return {
      truncated: true,
      originalBytes,
      head: fields.head,
      tail: fields.tail,
    };
  }
  return {
    truncated: true,
    originalBytes,
    head: '',
    tail: '',
    withheld: ['head', 'tail'],
  };
}

/**
 * One stored event row as an {@link AiRunEvent}, its payload read under the
 * read-time rule ({@link AiRunEvent.payload}).
 */
export function toAiRunEvent(row: Record<string, unknown>): AiRunEvent {
  const flag = rowFlag(row.truncated);
  const stored = parsePayload(row.payload);
  const truncated = readsAsCut(flag, stored);
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
    payload: readStoredPayload(stored, flag),
    payloadRef: text(row.payload_ref),
    truncated,
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
    // `toAiRunEvent` applies the read-time rule to every payload: whole
    // payloads through the built-in redactor again, cut ones as written only
    // under the current stamp (AiRunEvent.payload).
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
