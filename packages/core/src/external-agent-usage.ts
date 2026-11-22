/** Provider-measured external usage, separate from hosted AI billing. */
import type { DatabaseInterface } from '@happyvertical/sql';
import {
  isEmbeddedDatabase,
  withEmbeddedWriteTransaction,
} from './embedded-write-queue.js';
import { sha256Hex } from './utils/sha256.js';

export const EXTERNAL_AGENT_USAGE_OPERATION = 'external-agent';
export const EXTERNAL_AGENT_COUNTERS = [
  'inputTokens',
  'outputTokens',
  'totalTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'reasoningTokens',
] as const;
export type ExternalAgentCounter = (typeof EXTERNAL_AGENT_COUNTERS)[number];
export type ExternalAgentCounters = Partial<
  Record<ExternalAgentCounter, number | null>
>;
/** Trusted ownership binding supplied by the authenticated application. */
export interface ExternalAgentUsageBinding {
  tenantId: string;
  workspaceId: string;
  projectId: string;
  taskId: string;
  sessionId: string;
  parentSessionId?: string;
  role: string;
}
export interface ExternalAgentUsageReport {
  version: 1;
  binding: ExternalAgentUsageBinding;
  provider: string;
  model: string;
  provenance: { harness: string; source: string; eventId: string };
  observedAt: string;
  sequence: number;
  epoch: number;
  basis: 'delta' | 'cumulative';
  /** First cumulative snapshot of each epoch: known zero origin or unknown baseline. */
  baseline: 'zero' | 'unknown';
  scope: 'exclusive';
  inputIncludesCache: boolean;
  outputIncludesReasoning: boolean;
  counters: ExternalAgentCounters;
}
export interface ExternalAgentUsageReporter {
  reporterId: string;
  reporterType: 'agent' | 'user';
}
export interface ExternalAgentUsageReceipt {
  reporter?: ExternalAgentUsageReporter;
  id: string;
  report: ExternalAgentUsageReport;
  delta: Record<ExternalAgentCounter, number | null>;
}
export interface ExternalAgentUsageSummary {
  binding: ExternalAgentUsageBinding;
  source: 'external-agent';
  reports: number;
  latest: ExternalAgentUsageReport | null;
  counters: Record<ExternalAgentCounter, number | null>;
  complete: boolean;
  coverage: Record<
    ExternalAgentCounter,
    { knownReports: number; unknownReports: number }
  >;
}
export class ExternalAgentUsageError extends Error {
  constructor(
    readonly code: 'invalid_input' | 'conflict',
    message: string,
  ) {
    super(`External agent usage: ${message}`);
    this.name = 'ExternalAgentUsageError';
  }
}
function reject(
  message: string,
  code: 'invalid_input' | 'conflict' = 'invalid_input',
): never {
  throw new ExternalAgentUsageError(code, message);
}
function object(
  value: unknown,
  keys: string[],
): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null) ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    reject('invalid fields');
}
function text(value: unknown): asserts value is string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > 256 ||
    [...value].some((character) => character.charCodeAt(0) < 32)
  )
    reject('invalid identifier');
}
function integer(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    reject('invalid counter or sequence');
}
const bindingKeys = [
  'tenantId',
  'workspaceId',
  'projectId',
  'taskId',
  'sessionId',
  'parentSessionId',
  'role',
];
function binding(value: ExternalAgentUsageBinding): ExternalAgentUsageBinding {
  object(value, bindingKeys);
  const result: Record<string, string> = {};
  for (const key of bindingKeys) {
    const field = value[key as keyof ExternalAgentUsageBinding];
    if (key === 'parentSessionId' && field === undefined) continue;
    text(field);
    result[key] = field;
  }
  if (result.sessionId === result.parentSessionId) reject('self parent');
  return result as unknown as ExternalAgentUsageBinding;
}
/** Validate and copy only the public structured contract; arbitrary tags are refused. */
export function normalizeExternalAgentUsageReport(
  value: ExternalAgentUsageReport,
): ExternalAgentUsageReport {
  object(value, [
    'version',
    'binding',
    'provider',
    'model',
    'provenance',
    'observedAt',
    'sequence',
    'epoch',
    'basis',
    'baseline',
    'scope',
    'inputIncludesCache',
    'outputIncludesReasoning',
    'counters',
  ]);
  if (
    value.version !== 1 ||
    value.scope !== 'exclusive' ||
    !['delta', 'cumulative'].includes(value.basis) ||
    !['zero', 'unknown'].includes(value.baseline)
  )
    reject('unsupported measurement contract');
  text(value.provider);
  text(value.model);
  text(value.observedAt);
  if (!Number.isFinite(Date.parse(value.observedAt)))
    reject('invalid timestamp');
  integer(value.sequence);
  integer(value.epoch);
  if (
    typeof value.inputIncludesCache !== 'boolean' ||
    typeof value.outputIncludesReasoning !== 'boolean'
  )
    reject('missing component semantics');
  object(value.provenance, ['harness', 'source', 'eventId']);
  text(value.provenance.harness);
  text(value.provenance.source);
  text(value.provenance.eventId);
  object(value.counters, [...EXTERNAL_AGENT_COUNTERS]);
  const counters: ExternalAgentCounters = {};
  for (const key of EXTERNAL_AGENT_COUNTERS) {
    const count = value.counters[key];
    if (count !== undefined && count !== null) integer(count);
    counters[key] = count ?? null;
  }
  if (value.inputIncludesCache && counters.inputTokens != null) {
    const components =
      (counters.cacheReadTokens ?? 0) + (counters.cacheWriteTokens ?? 0);
    if (!Number.isSafeInteger(components) || components > counters.inputTokens)
      reject('cache exceeds inclusive input');
  }
  if (
    value.outputIncludesReasoning &&
    counters.outputTokens != null &&
    (counters.reasoningTokens ?? 0) > counters.outputTokens
  )
    reject('reasoning exceeds inclusive output');
  return {
    version: 1,
    binding: binding(value.binding),
    provider: value.provider,
    model: value.model,
    provenance: {
      harness: value.provenance.harness,
      source: value.provenance.source,
      eventId: value.provenance.eventId,
    },
    observedAt: new Date(value.observedAt).toISOString(),
    sequence: value.sequence,
    epoch: value.epoch,
    basis: value.basis,
    baseline: value.baseline,
    scope: 'exclusive',
    inputIncludesCache: value.inputIncludesCache,
    outputIncludesReasoning: value.outputIncludesReasoning,
    counters,
  };
}
function streamId(scope: ExternalAgentUsageBinding): string {
  // A session has one binding, including across project reassignment attempts.
  return `external-agent:${sha256Hex(JSON.stringify([scope.tenantId, scope.sessionId]))}`;
}
function rowId(scope: ExternalAgentUsageBinding, sequence: number): string {
  return `${streamId(scope)}:${sequence}`;
}
async function read(
  db: DatabaseInterface,
  scope: ExternalAgentUsageBinding,
  sequence: number,
): Promise<ExternalAgentUsageReceipt | null> {
  const row = await db.get('_smrt_ai_usage', {
    id: rowId(scope, sequence),
    tenant_id: scope.tenantId,
    operation: EXTERNAL_AGENT_USAGE_OPERATION,
  });
  if (!row) return null;
  return JSON.parse(String(row.tags)) as ExternalAgentUsageReceipt;
}
function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * What the stream checks of {@link ExternalAgentUsageRecorder.record} need
 * from every earlier receipt of a stream: the provider event ids it holds,
 * and, for its last epoch, each counter's latest known cumulative value.
 * Built from the receipts once, then extended by each receipt this process
 * writes, so a report is checked in constant time instead of re-reading the
 * stream. Used only when its last receipt is exactly the stream's current
 * last row (read in the writing transaction); otherwise it is rebuilt.
 */
interface StreamState {
  /** The serialized last receipt the state covers. */
  tail: string;
  /** Provider event id to the sequence that recorded it. */
  eventIds: Map<string, number>;
  epoch: number;
  latest: Partial<Record<ExternalAgentCounter, number>>;
}

const STREAM_STATE_LIMIT = 256;
const streamStates = new WeakMap<object, Map<string, StreamState>>();

function stateFrom(receipts: ExternalAgentUsageReceipt[]): StreamState | null {
  const sorted = [...receipts].sort(
    (a, b) => a.report.sequence - b.report.sequence,
  );
  const last = sorted.at(-1);
  if (!last) return null;
  const state: StreamState = {
    tail: JSON.stringify(last),
    eventIds: new Map(),
    epoch: last.report.epoch,
    latest: {},
  };
  for (const receipt of sorted) {
    state.eventIds.set(
      receipt.report.provenance.eventId,
      receipt.report.sequence,
    );
    if (receipt.report.epoch !== state.epoch) continue;
    for (const key of EXTERNAL_AGENT_COUNTERS) {
      const value = receipt.report.counters[key];
      if (value !== null && value !== undefined) state.latest[key] = value;
    }
  }
  return state;
}

function extended(state: StreamState, receipt: ExternalAgentUsageReceipt) {
  const next: StreamState = {
    tail: JSON.stringify(receipt),
    eventIds: state.eventIds,
    epoch: receipt.report.epoch,
    latest: receipt.report.epoch === state.epoch ? { ...state.latest } : {},
  };
  next.eventIds.set(receipt.report.provenance.eventId, receipt.report.sequence);
  for (const key of EXTERNAL_AGENT_COUNTERS) {
    const value = receipt.report.counters[key];
    if (value !== null && value !== undefined) next.latest[key] = value;
  }
  return next;
}

function rememberState(
  db: DatabaseInterface,
  stream: string,
  state: StreamState,
): void {
  let states = streamStates.get(db as object);
  if (!states) {
    states = new Map();
    streamStates.set(db as object, states);
  }
  states.delete(stream);
  states.set(stream, state);
  if (states.size > STREAM_STATE_LIMIT) {
    const oldest = states.keys().next().value;
    if (oldest !== undefined) states.delete(oldest);
  }
}

function receiptsOf(rows: Array<Record<string, unknown>>) {
  return rows.map(
    (row) => JSON.parse(String(row.tags)) as ExternalAgentUsageReceipt,
  );
}
/**
 * Recorder accepts a trusted scope separately from an untrusted report. Caller
 * authorizes scope ownership before construction. No ambient tenant inference.
 * Existing system tables must be bootstrapped before opening a transaction.
 */
export class ExternalAgentUsageRecorder {
  private readonly binding: ExternalAgentUsageBinding;
  private readonly reporter?: ExternalAgentUsageReporter;
  constructor(
    private readonly db: DatabaseInterface,
    trustedBinding: ExternalAgentUsageBinding,
    reporter?: ExternalAgentUsageReporter,
  ) {
    this.binding = binding(trustedBinding);
    if (reporter !== undefined) {
      object(reporter, ['reporterId', 'reporterType']);
      text(reporter.reporterId);
      if (!['agent', 'user'].includes(reporter.reporterType))
        reject('invalid reporter type');
      this.reporter = {
        reporterId: reporter.reporterId,
        reporterType: reporter.reporterType,
      };
    }
  }
  async record(
    input: ExternalAgentUsageReport,
  ): Promise<ExternalAgentUsageReceipt> {
    const report = normalizeExternalAgentUsageReport(input);
    if (!same(report.binding, this.binding))
      reject('ownership binding mismatch');
    // The stream state after this write, kept once the transaction is done.
    let written: {
      state: StreamState | null;
      receipt: ExternalAgentUsageReceipt;
    } | null = null;
    const result = await withEmbeddedWriteTransaction(
      this.db,
      isEmbeddedDatabase(this.db),
      async (tx) => {
        const existing = await read(tx, this.binding, report.sequence);
        if (existing) {
          if (!same(existing.report, report))
            reject('conflicting replay', 'conflict');
          return existing;
        }
        const previous =
          report.sequence === 0
            ? null
            : await read(tx, this.binding, report.sequence - 1);
        if (report.sequence === 0 ? report.epoch !== 0 : !previous)
          reject('out of order sequence', 'conflict');
        const stream = streamId(this.binding);
        let state: StreamState | null = null;
        if (previous) {
          const last = previous.report;
          if (
            !same(last.binding, report.binding) ||
            last.provider !== report.provider ||
            last.model !== report.model ||
            last.basis !== report.basis ||
            last.inputIncludesCache !== report.inputIncludesCache ||
            last.outputIncludesReasoning !== report.outputIncludesReasoning ||
            last.provenance.harness !== report.provenance.harness ||
            last.provenance.source !== report.provenance.source
          )
            reject('stream attribution changed', 'conflict');
          if (report.epoch !== last.epoch && report.epoch !== last.epoch + 1)
            reject('invalid reset epoch', 'conflict');
          if (report.epoch === last.epoch && report.baseline !== last.baseline)
            reject('baseline changed without reset', 'conflict');
          if (Date.parse(report.observedAt) < Date.parse(last.observedAt))
            reject('timestamp reordered', 'conflict');
          // The stream's earlier receipts, summarized: kept from this
          // process's last write when its tail is still the stream's last
          // row (rows are insert-only, sequences contiguous), else read once.
          const known = streamStates.get(this.db as object)?.get(stream);
          state =
            known && known.tail === JSON.stringify(previous)
              ? known
              : stateFrom(
                  // Only the receipts before this one: a receipt written
                  // concurrently at this sequence is the insert's to settle.
                  receiptsOf(
                    (
                      await tx.query(
                        "SELECT tags FROM _smrt_ai_usage WHERE tenant_id = ? AND class_name = ? AND operation = 'external-agent' AND id LIKE 'external-agent:%'",
                        this.binding.tenantId,
                        stream,
                      )
                    ).rows,
                  ).filter((row) => row.report.sequence < report.sequence),
                );
          // A provider event is unique within its stream, even at another sequence.
          // (A receipt at this very sequence, written concurrently, is
          // arbitrated by the insert below.)
          const recordedAt = state?.eventIds.get(report.provenance.eventId);
          if (recordedAt !== undefined && recordedAt !== report.sequence)
            reject('event already recorded', 'conflict');
        }
        const delta = {} as Record<ExternalAgentCounter, number | null>;
        for (const key of EXTERNAL_AGENT_COUNTERS) {
          const current = report.counters[key] ?? null;
          const last = previous?.report;
          const before = last?.counters[key] ?? null;
          if (report.basis === 'cumulative' && current !== null) {
            // Every earlier receipt passed this check, so the latest known
            // value of the epoch is its largest.
            const latestKnown =
              state && state.epoch === report.epoch
                ? state.latest[key]
                : undefined;
            if (latestKnown !== undefined && current < latestKnown)
              reject('counter decreased without reset', 'conflict');
          }
          if (report.basis === 'delta') delta[key] = current;
          else if (!last || report.epoch !== last.epoch)
            delta[key] = report.baseline === 'zero' ? current : null;
          else {
            delta[key] =
              current !== null && before !== null ? current - before : null;
          }
        }
        const receipt: ExternalAgentUsageReceipt = {
          id: rowId(this.binding, report.sequence),
          report,
          delta,
          ...(this.reporter ? { reporter: { ...this.reporter } } : {}),
        };
        const won = await tx.query(
          // `call_id` and `entry_call_id` are the row's own id, as for every
          // usage row (#5005).
          `INSERT INTO _smrt_ai_usage (id,call_id,entry_call_id,provider,model,operation,prompt_tokens,completion_tokens,total_tokens,estimated_cost,duration_ms,class_name,tenant_id,tags,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT (id) DO NOTHING RETURNING id`,
          receipt.id,
          receipt.id,
          receipt.id,
          report.provider,
          report.model,
          EXTERNAL_AGENT_USAGE_OPERATION,
          delta.inputTokens,
          delta.outputTokens,
          delta.totalTokens,
          null,
          0,
          streamId(this.binding),
          this.binding.tenantId,
          JSON.stringify(receipt),
          report.observedAt,
        );
        if (won.rows.length) {
          written = { state, receipt };
          return receipt;
        }
        const winner = await read(tx, this.binding, report.sequence);
        if (!winner || !same(winner.report, report))
          reject('conflicting concurrent replay', 'conflict');
        return winner;
      },
      true,
    );
    // Extended only after the transaction succeeded: a rolled-back write
    // never reaches the kept state.
    const done = written as {
      state: StreamState | null;
      receipt: ExternalAgentUsageReceipt;
    } | null;
    if (done) {
      const next = done.state
        ? extended(done.state, done.receipt)
        : stateFrom([done.receipt]);
      if (next) rememberState(this.db, streamId(this.binding), next);
    }
    return result;
  }
  /** Safe per-session projection; never estimates cost or coalesces unknown to zero. */
  async summarize(): Promise<ExternalAgentUsageSummary> {
    const result = await this.db.query(
      "SELECT tags FROM _smrt_ai_usage WHERE tenant_id = ? AND class_name = ? AND operation = ? AND id LIKE 'external-agent:%'",
      this.binding.tenantId,
      streamId(this.binding),
      EXTERNAL_AGENT_USAGE_OPERATION,
    );
    return summarizeReceipts(this.binding, receiptsOf(result.rows));
  }
}

/** One session's summary from all its receipts. */
function summarizeReceipts(
  sessionBinding: ExternalAgentUsageBinding,
  rows: ExternalAgentUsageReceipt[],
): ExternalAgentUsageSummary {
  const receipts = [...rows].sort(
    (a, b) => a.report.sequence - b.report.sequence,
  );
  if (receipts.some((row) => !same(row.report.binding, sessionBinding)))
    reject('ownership binding mismatch');
  const counters = {} as Record<ExternalAgentCounter, number | null>;
  for (const key of EXTERNAL_AGENT_COUNTERS) {
    let total: number | null = receipts.length ? 0 : null;
    for (const row of receipts) {
      const count = row.delta[key];
      if (count === null || total === null) total = null;
      else {
        total += count;
        if (!Number.isSafeInteger(total))
          reject('summary exceeds safe integer');
      }
    }
    counters[key] = total;
  }
  const coverage = {} as ExternalAgentUsageSummary['coverage'];
  for (const key of EXTERNAL_AGENT_COUNTERS) {
    const knownReports = receipts.filter(
      (row) => row.delta[key] !== null,
    ).length;
    coverage[key] = {
      knownReports,
      unknownReports: receipts.length - knownReports,
    };
  }
  return {
    binding: { ...sessionBinding },
    source: 'external-agent',
    reports: receipts.length,
    latest: receipts.at(-1)?.report ?? null,
    counters,
    complete: EXTERNAL_AGENT_COUNTERS.every((key) => counters[key] !== null),
    coverage,
  };
}

/** Trusted project ownership scope, authorized by the application before reading. */
export interface ExternalAgentUsageQuery {
  tenantId: string;
  workspaceId: string;
  projectId: string;
  taskId?: string;
  sessionId?: string;
}
/** Per-session summaries only: inclusive parent totals are never added to children. */
export async function summarizeExternalAgentUsage(
  db: DatabaseInterface,
  scope: ExternalAgentUsageQuery,
): Promise<ExternalAgentUsageSummary[]> {
  object(scope, [
    'tenantId',
    'workspaceId',
    'projectId',
    'taskId',
    'sessionId',
  ]);
  text(scope.tenantId);
  text(scope.workspaceId);
  text(scope.projectId);
  if (scope.taskId !== undefined) text(scope.taskId);
  if (scope.sessionId !== undefined) text(scope.sessionId);
  const result = await db.query(
    "SELECT tags, class_name FROM _smrt_ai_usage WHERE tenant_id = ? AND operation = ? AND id LIKE 'external-agent:%'",
    scope.tenantId,
    EXTERNAL_AGENT_USAGE_OPERATION,
  );
  // One read: the summaries are computed from the same receipts, grouped
  // by stream, instead of one more query per session.
  const sessions = new Map<string, ExternalAgentUsageBinding>();
  const byStream = new Map<string, ExternalAgentUsageReceipt[]>();
  for (const row of result.rows) {
    const receipt = JSON.parse(String(row.tags)) as ExternalAgentUsageReceipt;
    const candidate = receipt.report.binding;
    if (candidate.tenantId !== scope.tenantId)
      reject('persisted tenant binding mismatch');
    // Grouped by the row's stream column, as the per-session read keys it.
    const stream = String(row.class_name);
    const list = byStream.get(stream);
    if (list) list.push(receipt);
    else byStream.set(stream, [receipt]);
    if (
      candidate.workspaceId !== scope.workspaceId ||
      candidate.projectId !== scope.projectId ||
      (scope.taskId !== undefined && candidate.taskId !== scope.taskId) ||
      (scope.sessionId !== undefined && candidate.sessionId !== scope.sessionId)
    )
      continue;
    sessions.set(candidate.sessionId, candidate);
  }
  const summaries: ExternalAgentUsageSummary[] = [];
  for (const candidate of sessions.values())
    summaries.push(
      summarizeReceipts(
        binding(candidate),
        byStream.get(streamId(candidate)) ?? [],
      ),
    );
  return summaries;
}
