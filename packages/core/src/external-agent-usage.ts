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
    return withEmbeddedWriteTransaction(
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
        let snapshots: ExternalAgentUsageReceipt[] = [];
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
          // A provider event is unique within its stream, even at another sequence.
          const candidates = await tx.query(
            'SELECT tags FROM _smrt_ai_usage WHERE tenant_id = ? AND class_name = ?',
            this.binding.tenantId,
            streamId(this.binding),
          );
          snapshots = candidates.rows.map(
            (row) => JSON.parse(String(row.tags)) as ExternalAgentUsageReceipt,
          );
          if (
            snapshots.some(
              (row) =>
                row.report.provenance.eventId === report.provenance.eventId,
            )
          )
            reject('event already recorded', 'conflict');
        }
        const delta = {} as Record<ExternalAgentCounter, number | null>;
        for (const key of EXTERNAL_AGENT_COUNTERS) {
          const current = report.counters[key] ?? null;
          const last = previous?.report;
          const before = last?.counters[key] ?? null;
          if (report.basis === 'cumulative' && current !== null) {
            const latestKnown = snapshots.reduce<
              ExternalAgentUsageReceipt | undefined
            >(
              (latest, row) =>
                row.report.epoch === report.epoch &&
                row.report.sequence < report.sequence &&
                row.report.counters[key] != null &&
                (!latest || row.report.sequence > latest.report.sequence)
                  ? row
                  : latest,
              undefined,
            );
            if (
              latestKnown &&
              current < (latestKnown.report.counters[key] as number)
            )
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
          `INSERT INTO _smrt_ai_usage (id,provider,model,operation,prompt_tokens,completion_tokens,total_tokens,estimated_cost,duration,class_name,tenant_id,tags,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT (id) DO NOTHING RETURNING id`,
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
        if (won.rows.length) return receipt;
        const winner = await read(tx, this.binding, report.sequence);
        if (!winner || !same(winner.report, report))
          reject('conflicting concurrent replay', 'conflict');
        return winner;
      },
      true,
    );
  }
  /** Safe per-session projection; never estimates cost or coalesces unknown to zero. */
  async summarize(): Promise<ExternalAgentUsageSummary> {
    const result = await this.db.query(
      'SELECT tags FROM _smrt_ai_usage WHERE tenant_id = ? AND class_name = ? AND operation = ?',
      this.binding.tenantId,
      streamId(this.binding),
      EXTERNAL_AGENT_USAGE_OPERATION,
    );
    const receipts = result.rows
      .map((row) => JSON.parse(String(row.tags)) as ExternalAgentUsageReceipt)
      .sort((a, b) => a.report.sequence - b.report.sequence);
    if (receipts.some((row) => !same(row.report.binding, this.binding)))
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
      binding: { ...this.binding },
      source: 'external-agent',
      reports: receipts.length,
      latest: receipts.at(-1)?.report ?? null,
      counters,
      complete: EXTERNAL_AGENT_COUNTERS.every((key) => counters[key] !== null),
      coverage,
    };
  }
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
    'SELECT tags FROM _smrt_ai_usage WHERE tenant_id = ? AND operation = ?',
    scope.tenantId,
    EXTERNAL_AGENT_USAGE_OPERATION,
  );
  const sessions = new Map<string, ExternalAgentUsageBinding>();
  for (const row of result.rows) {
    const receipt = JSON.parse(String(row.tags)) as ExternalAgentUsageReceipt;
    const candidate = receipt.report.binding;
    if (candidate.tenantId !== scope.tenantId)
      reject('persisted tenant binding mismatch');
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
      await new ExternalAgentUsageRecorder(db, candidate).summarize(),
    );
  return summaries;
}
