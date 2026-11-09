/**
 * Prompt-version and model comparison over recorded AI usage (#4782):
 * `compareAiPromptRuns()` behind `smrt ai:compare`, and
 * `listAiPromptTemplateHistory()` behind `smrt prompts:history`.
 *
 * Both read `_smrt_ai_usage` rows of one prompt key, tenant-scoped like the
 * transcript read (#4780): a tenant (or global rows) is a query predicate,
 * and a read across tenants needs the reviewed `allowCrossTenant` path. Other
 * tenants' rows are neither read nor counted. Joins to labels, runs and
 * transcripts stay within each usage row's tenant.
 *
 * Within that scope the report's accounting rule holds: a selector chooses
 * what is totalled on a side, never what is accounted for. Rows of the prompt
 * matching neither side are counted in `unmatched`, rows matching both are
 * totalled on both and counted in `inBoth`, hosted-gate blocks count beside
 * calls, and external-agent measurements are counted as excluded.
 *
 * Labels come from `recordAiUsageOutcome()` only; nothing here asks a model
 * to judge anything. Transcript content is not read: a side lists the ids of
 * its stored transcripts, and `listAiTranscripts()` (audited) reads them.
 */

import type { DatabaseInterface } from '@happyvertical/sql';
import { EXTERNAL_AGENT_USAGE_OPERATION } from '../external-agent-usage.js';
import { INFERENCE_BLOCKED_OPERATION } from '../inference-gate.js';
import { AI_USAGE_COST_BASIS } from './ai-usage-observability.js';

// ============================================================================
// Shared helpers
// ============================================================================

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

function parseTags(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function tagString(
  tags: Record<string, unknown> | undefined,
  name: string,
): string | null {
  const value = tags?.[name];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function hasSubstitution(tags: Record<string, unknown> | undefined): boolean {
  const value = tags?.substitutions;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value !== 'string' || value.length === 0) return false;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.length > 0 : false;
  } catch {
    return false;
  }
}

/** A `(tenant, id)` join key: ids are free text another tenant can reuse. */
function tenantKey(tenant: string | null, id: string): string {
  return JSON.stringify([tenant, id]);
}

/** The read was refused before any query ran: no tenant scope was given. */
export class AiUsageScopeError extends Error {
  readonly code = 'AI_USAGE_TENANT_REQUIRED';

  constructor(message: string) {
    super(message);
    this.name = 'AiUsageScopeError';
  }
}

/** The tenant scope every read here takes. */
export interface AiUsageTenantScope {
  /**
   * Tenant whose usage to read; `null` reads global (tenant-less) rows.
   * Required unless `allowCrossTenant` is set.
   */
  tenantId?: string | null;
  /**
   * Reviewed cross-tenant read (operators, the CLI's `--all-tenants`):
   * without `tenantId`, rows of every tenant are read. Joins stay within each
   * row's tenant.
   */
  allowCrossTenant?: boolean;
}

function requireScope(fn: string, scope: AiUsageTenantScope): void {
  if (scope.tenantId === undefined && scope.allowCrossTenant !== true) {
    throw new AiUsageScopeError(
      `${fn}: pass tenantId (null for global rows), or allowCrossTenant: true for a reviewed cross-tenant read`,
    );
  }
  if (scope.tenantId !== undefined && scope.tenantId !== null) {
    if (typeof scope.tenantId !== 'string') {
      throw new TypeError(`${fn}: tenantId must be a string or null`);
    }
  }
}

function requireText(value: unknown, name: string, fn: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${fn}: ${name} must be a non-empty string`);
  }
  return value;
}

/**
 * Append the tenant predicate for `column` to `conditions`/`params`. Every
 * supplied string filters, `''` included; with neither a tenant nor `null`
 * the caller has passed `allowCrossTenant` and no predicate is added.
 */
function addTenantPredicate(
  column: string,
  scope: AiUsageTenantScope,
  conditions: string[],
  params: unknown[],
): void {
  if (scope.tenantId === null) {
    conditions.push(`${column} IS NULL`);
  } else if (scope.tenantId !== undefined) {
    params.push(scope.tenantId);
    conditions.push(`${column} = $${params.length}`);
  }
}

const PAGE_SIZE = 1000;
const IN_CHUNK = 500;

/**
 * Read `_smrt_ai_usage` rows of one prompt in a window and scope, in bounded
 * keyset pages on `id` (never one unbounded result set).
 */
async function* promptUsagePages(
  db: DatabaseInterface,
  columns: string,
  promptKey: string,
  scope: AiUsageTenantScope,
  since: Date | undefined,
  until: Date | undefined,
): AsyncGenerator<Record<string, unknown>[]> {
  let lastId: string | null = null;
  for (;;) {
    const params: unknown[] = [promptKey];
    const conditions = ['prompt_key = $1'];
    addTenantPredicate('tenant_id', scope, conditions, params);
    if (since) {
      params.push(since.toISOString());
      conditions.push(`created_at >= $${params.length}`);
    }
    if (until) {
      params.push(until.toISOString());
      conditions.push(`created_at <= $${params.length}`);
    }
    if (lastId !== null) {
      params.push(lastId);
      conditions.push(`id > $${params.length}`);
    }
    params.push(PAGE_SIZE);
    const page = getRows(
      await db.query(
        `SELECT ${columns}
           FROM _smrt_ai_usage
          WHERE ${conditions.join(' AND ')}
          ORDER BY id ASC
          LIMIT $${params.length}`,
        ...params,
      ),
    );
    if (page.length === 0) return;
    yield page;
    if (page.length < PAGE_SIZE) return;
    lastId = String(page[page.length - 1]?.id);
  }
}

function isExternalAgentRow(row: Record<string, unknown>): boolean {
  return (
    row.operation === EXTERNAL_AGENT_USAGE_OPERATION &&
    String(row.id).startsWith(`${EXTERNAL_AGENT_USAGE_OPERATION}:`)
  );
}

/**
 * Run `query` for `ids` in chunks of at most {@link IN_CHUNK} values, each
 * with the tenant predicate, and concatenate the rows.
 */
async function inChunks(
  db: DatabaseInterface,
  ids: string[],
  scope: AiUsageTenantScope,
  build: (inList: string, tenantWhere: string) => string,
  tenantColumn: string,
): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  for (let start = 0; start < ids.length; start += IN_CHUNK) {
    const chunk = ids.slice(start, start + IN_CHUNK);
    const params: unknown[] = [];
    const inList = chunk
      .map((id) => {
        params.push(id);
        return `$${params.length}`;
      })
      .join(', ');
    const conditions: string[] = [];
    addTenantPredicate(tenantColumn, scope, conditions, params);
    const tenantWhere =
      conditions.length > 0 ? ` AND ${conditions.join(' AND ')}` : '';
    out.push(...getRows(await db.query(build(inList, tenantWhere), ...params)));
  }
  return out;
}

// ============================================================================
// Compare
// ============================================================================

/**
 * One side of a comparison: exactly one of a template hash (the prompt
 * version, the `templateHash` usage tag), a model, or a tier.
 *
 * - `templateHash` matches the tag exactly.
 * - `model` matches `provider:model` or the bare model id (so `gpt-4o`,
 *   `openai:gpt-4o` and `ollama:llama3:8b` all work).
 * - `tier` matches the tier the call resolved to (`tier_resolved`), or the
 *   requested tier when no resolved tier was recorded.
 */
export type AiPromptCompareSelector =
  | { templateHash: string; model?: never; tier?: never }
  | { model: string; templateHash?: never; tier?: never }
  | { tier: string; templateHash?: never; model?: never };

/** Options for {@link compareAiPromptRuns}. */
export interface AiPromptCompareOptions extends AiUsageTenantScope {
  /** The prompt key both sides ran (`_smrt_ai_usage.prompt_key`). */
  promptKey: string;
  a: AiPromptCompareSelector;
  b: AiPromptCompareSelector;
  since?: Date;
  until?: Date;
  /**
   * Most transcript references listed per side, worst-labelled first.
   * Default 50, at most 500.
   */
  transcriptLimit?: number;
}

/** Duration percentiles in ms (nearest rank), `null` with no calls. */
export interface AiPromptCompareLatency {
  p50: number | null;
  p90: number | null;
  p95: number | null;
  p99: number | null;
}

/** A stored transcript of one of a side's calls (ids only, no content). */
export interface AiPromptCompareTranscriptRef {
  /** `_smrt_ai_transcripts.id`. */
  id: string;
  callId: string;
  tenantId: string | null;
  createdAt: Date;
  /** Labels on the call, its run or its usage rows (same tenant). */
  labels: string[];
  /** Lowest score among those labels; `null` when none is scored. */
  worstScore: number | null;
}

/** Totals for one side. Rates are per usage row, the unit `ai:usage` counts. */
export interface AiPromptCompareSide {
  selector: AiPromptCompareSelector;
  /** Usage rows totalled (hosted-gate blocks excluded, see `blocked`). */
  calls: number;
  /** Hosted-gate refusals matching the side, beside `calls`, never in it. */
  blocked: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** Sum of recorded `estimated_cost` over `costedCalls`, in USD. */
  estimatedCost: number;
  costedCalls: number;
  /** Calls with no rate: counted here, never priced as zero. */
  uncostedCalls: number;
  /** `estimatedCost / costedCalls`; `null` without a costed call. */
  meanCost: number | null;
  latencyMs: AiPromptCompareLatency;
  /** Calls whose `substitutions` tag records a fallback (#4752). */
  fallbackCalls: number;
  fallbackRate: number | null;
  /** Calls whose fusion run (#4753) ended `degraded` or `failed`. */
  degradedCalls: number;
  degradedRate: number | null;
  /**
   * Label distribution. A label on a usage row counts on that row; a run or
   * call label counts once per side holding the run or call (the
   * `reportAiUsage()` rule).
   */
  outcomes: Record<string, number>;
  /** Labels counted in `outcomes`. */
  labels: number;
  /** Counted labels that carry a score. */
  scoredLabels: number;
  /** Mean score of `scoredLabels`; `null` when none. */
  meanScore: number | null;
  /** Distinct call ids (`call_id`, #4780) among the side's calls. */
  callIds: number;
  /** Stored transcripts of the side's calls (total, before the limit). */
  transcriptCount: number;
  /**
   * Up to `transcriptLimit` transcripts, worst-labelled first: lowest
   * score, then labelled without a score, then unlabelled; newest first
   * within each.
   */
  transcripts: AiPromptCompareTranscriptRef[];
}

/** The result of {@link compareAiPromptRuns}. */
export interface AiPromptComparison {
  promptKey: string;
  since: Date | null;
  until: Date | null;
  /** The tenant scope, or `undefined` for a cross-tenant read. */
  tenantId?: string | null;
  crossTenant: boolean;
  costBasis: string;
  a: AiPromptCompareSide;
  b: AiPromptCompareSide;
  /** Every row of the prompt in scope, matched or not. */
  rows: number;
  /** Rows matching neither side: accounted for, not totalled. */
  unmatched: number;
  /** Rows matching both sides, totalled on each. */
  inBoth: number;
  excluded: {
    /** External-agent measurements, which have their own summary contract. */
    externalAgent: number;
  };
}

type SelectorKind = 'templateHash' | 'model' | 'tier';

function normalizeSelector(
  value: unknown,
  side: 'a' | 'b',
): { kind: SelectorKind; value: string; selector: AiPromptCompareSelector } {
  const fn = 'compareAiPromptRuns';
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(
      `${fn}: ${side} must be { templateHash } | { model } | { tier }`,
    );
  }
  const record = value as Record<string, unknown>;
  const kinds = (['templateHash', 'model', 'tier'] as const).filter(
    (kind) => record[kind] !== undefined,
  );
  if (kinds.length !== 1) {
    throw new TypeError(
      `${fn}: ${side} must name exactly one of templateHash, model, tier`,
    );
  }
  const kind = kinds[0] as SelectorKind;
  const text = requireText(record[kind], `${side}.${kind}`, fn).trim();
  return {
    kind,
    value: text,
    selector:
      kind === 'templateHash'
        ? { templateHash: text }
        : kind === 'model'
          ? { model: text }
          : { tier: text },
  };
}

function matchesSelector(
  kind: SelectorKind,
  value: string,
  row: Record<string, unknown>,
  tags: Record<string, unknown> | undefined,
): boolean {
  switch (kind) {
    case 'templateHash':
      return tagString(tags, 'templateHash') === value;
    case 'model': {
      const model = String(row.model);
      return model === value || `${String(row.provider)}:${model}` === value;
    }
    case 'tier':
      return (
        (nullableString(row.tier_resolved) ??
          nullableString(row.tier_requested)) === value
      );
  }
}

/** Nearest-rank percentile of an ascending array. */
function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.max(1, Math.ceil(p * sorted.length));
  return sorted[rank - 1] ?? null;
}

interface SideAccumulator {
  kind: SelectorKind;
  value: string;
  side: AiPromptCompareSide;
  durations: number[];
  scoreSum: number;
  /** `(tenant, run)` and `(tenant, call)` keys whose labels were counted. */
  countedTargets: Set<string>;
  /** `(tenant, callId)` of the side's calls. */
  calls: Set<string>;
}

function emptySide(
  kind: SelectorKind,
  value: string,
  selector: AiPromptCompareSelector,
): SideAccumulator {
  return {
    kind,
    value,
    side: {
      selector,
      calls: 0,
      blocked: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      estimatedCost: 0,
      costedCalls: 0,
      uncostedCalls: 0,
      meanCost: null,
      latencyMs: { p50: null, p90: null, p95: null, p99: null },
      fallbackCalls: 0,
      fallbackRate: null,
      degradedCalls: 0,
      degradedRate: null,
      // Null prototype: labels are free text, and `constructor` or
      // `__proto__` must count like any other label.
      outcomes: Object.create(null) as Record<string, number>,
      labels: 0,
      scoredLabels: 0,
      meanScore: null,
      callIds: 0,
      transcriptCount: 0,
      transcripts: [],
    },
    durations: [],
    scoreSum: 0,
    countedTargets: new Set(),
    calls: new Set(),
  };
}

interface LabelRow {
  id: string;
  label: string;
  score: number | null;
}

function countLabels(acc: SideAccumulator, labels: LabelRow[]): void {
  const side = acc.side;
  for (const label of labels) {
    side.outcomes[label.label] =
      (Object.hasOwn(side.outcomes, label.label)
        ? (side.outcomes[label.label] ?? 0)
        : 0) + 1;
    side.labels++;
    if (label.score !== null) {
      side.scoredLabels++;
      acc.scoreSum += label.score;
    }
  }
}

const DEFAULT_TRANSCRIPT_LIMIT = 50;
const MAX_TRANSCRIPT_LIMIT = 500;

const USAGE_COLUMNS = `id, provider, model, operation, tenant_id, tier_requested,
       tier_resolved, run_id, call_id, prompt_tokens, completion_tokens,
       total_tokens, estimated_cost, duration, tags`;

/**
 * Compare two versions of a prompt, or two models or tiers on it, over the
 * recorded usage of one prompt key: per side calls, tokens, cost, latency
 * percentiles, fallback and degraded rates, the outcome label distribution
 * with its mean score, and the side's stored transcripts (ids only).
 *
 * Tenant-scoped: pass `tenantId` (`null` for global rows) or
 * `allowCrossTenant: true`. Reads usage, labels, runs and transcript ids;
 * never transcript content, so it writes no audit event.
 */
export async function compareAiPromptRuns(
  db: DatabaseInterface,
  options: AiPromptCompareOptions,
): Promise<AiPromptComparison> {
  const fn = 'compareAiPromptRuns';
  requireScope(fn, options ?? {});
  const promptKey = requireText(options.promptKey, 'promptKey', fn);
  const a = normalizeSelector(options.a, 'a');
  const b = normalizeSelector(options.b, 'b');
  const requested = options.transcriptLimit ?? DEFAULT_TRANSCRIPT_LIMIT;
  if (!Number.isSafeInteger(requested) || requested < 0) {
    throw new TypeError(
      `${fn}: transcriptLimit must be a non-negative integer`,
    );
  }
  const transcriptLimit = Math.min(requested, MAX_TRANSCRIPT_LIMIT);
  const scope: AiUsageTenantScope =
    options.tenantId !== undefined
      ? { tenantId: options.tenantId }
      : { allowCrossTenant: true };

  const sides = [
    emptySide(a.kind, a.value, a.selector),
    emptySide(b.kind, b.value, b.selector),
  ] as const;
  let rows = 0;
  let unmatched = 0;
  let inBoth = 0;
  const excluded = { externalAgent: 0 };

  // Per matched row, what later joins need: its tenant, id, run, call and
  // which sides it landed on.
  interface Matched {
    tenant: string | null;
    id: string;
    runId: string | null;
    callId: string | null;
    on: SideAccumulator[];
    blocked: boolean;
  }
  const matched: Matched[] = [];

  for await (const page of promptUsagePages(
    db,
    USAGE_COLUMNS,
    promptKey,
    scope,
    options.since,
    options.until,
  )) {
    for (const row of page) {
      if (isExternalAgentRow(row)) {
        excluded.externalAgent++;
        continue;
      }
      rows++;
      const tags = parseTags(row.tags);
      const on = sides.filter((acc) =>
        matchesSelector(acc.kind, acc.value, row, tags),
      );
      if (on.length === 0) {
        unmatched++;
        continue;
      }
      if (on.length === 2) inBoth++;
      const blocked = row.operation === INFERENCE_BLOCKED_OPERATION;
      const entry: Matched = {
        tenant: nullableString(row.tenant_id),
        id: String(row.id),
        runId: nullableString(row.run_id),
        callId: nullableString(row.call_id),
        on,
        blocked,
      };
      matched.push(entry);
      for (const acc of on) {
        const side = acc.side;
        if (blocked) {
          side.blocked++;
          continue;
        }
        side.calls++;
        side.promptTokens += Number(row.prompt_tokens ?? 0);
        side.completionTokens += Number(row.completion_tokens ?? 0);
        side.totalTokens += Number(row.total_tokens ?? 0);
        const cost = nullableNumber(row.estimated_cost);
        if (cost === null) side.uncostedCalls++;
        else {
          side.costedCalls++;
          side.estimatedCost += cost;
        }
        acc.durations.push(Number(row.duration ?? 0));
        if (hasSubstitution(tags)) side.fallbackCalls++;
        if (entry.callId) acc.calls.add(tenantKey(entry.tenant, entry.callId));
      }
    }
  }

  const totalled = matched.filter((entry) => !entry.blocked);
  const unique = (values: Array<string | null>) => [
    ...new Set(values.filter((value): value is string => value !== null)),
  ];
  const usageIds = unique(totalled.map((entry) => entry.id));
  const runIds = unique(totalled.map((entry) => entry.runId));
  const callIds = unique(totalled.map((entry) => entry.callId));

  // Degraded runs (#4753), joined by (tenant, run id).
  const degradedRuns = new Set<string>();
  for (const row of await inChunks(
    db,
    runIds,
    scope,
    (inList, tenantWhere) =>
      `SELECT id, tenant_id FROM _smrt_ai_runs
        WHERE id IN (${inList}) AND status IN ('degraded', 'failed')${tenantWhere}`,
    'tenant_id',
  )) {
    degradedRuns.add(tenantKey(nullableString(row.tenant_id), String(row.id)));
  }

  // Labels naming the totalled rows, their runs or their calls, joined by
  // (tenant, target). A label naming several targets judges the narrowest
  // (usage row, then run, then call), as in reportAiUsage().
  const labelsByUsage = new Map<string, LabelRow[]>();
  const labelsByRun = new Map<string, LabelRow[]>();
  const labelsByCall = new Map<string, LabelRow[]>();
  {
    const seen = new Set<string>();
    const outcomeQuery = (column: string) => (inList: string, where: string) =>
      `SELECT id, usage_id, run_id, call_id, label, score, tenant_id
         FROM _smrt_ai_usage_outcomes
        WHERE ${column} IN (${inList})${where}`;
    const labelRows = [
      ...(await inChunks(
        db,
        usageIds,
        scope,
        outcomeQuery('usage_id'),
        'tenant_id',
      )),
      ...(await inChunks(
        db,
        runIds,
        scope,
        outcomeQuery('run_id'),
        'tenant_id',
      )),
      ...(await inChunks(
        db,
        callIds,
        scope,
        outcomeQuery('call_id'),
        'tenant_id',
      )),
    ];
    for (const row of labelRows) {
      const id = String(row.id);
      if (seen.has(id)) continue;
      seen.add(id);
      const tenant = nullableString(row.tenant_id);
      const usageId = nullableString(row.usage_id);
      const runId = nullableString(row.run_id);
      const callId = nullableString(row.call_id);
      const [map, target] = usageId
        ? [labelsByUsage, usageId]
        : runId
          ? [labelsByRun, runId]
          : callId
            ? [labelsByCall, callId]
            : [null, ''];
      if (!map) continue;
      const key = tenantKey(tenant, target);
      const list = map.get(key) ?? [];
      list.push({
        id,
        label: String(row.label),
        score: nullableNumber(row.score),
      });
      map.set(key, list);
    }
  }

  for (const entry of totalled) {
    const usageLabels =
      labelsByUsage.get(tenantKey(entry.tenant, entry.id)) ?? [];
    const runKey = entry.runId ? tenantKey(entry.tenant, entry.runId) : null;
    const callKey = entry.callId ? tenantKey(entry.tenant, entry.callId) : null;
    const degraded = runKey !== null && degradedRuns.has(runKey);
    for (const acc of entry.on) {
      if (degraded) acc.side.degradedCalls++;
      countLabels(acc, usageLabels);
      if (runKey && !acc.countedTargets.has(`r${runKey}`)) {
        acc.countedTargets.add(`r${runKey}`);
        countLabels(acc, labelsByRun.get(runKey) ?? []);
      }
      if (callKey && !acc.countedTargets.has(`c${callKey}`)) {
        acc.countedTargets.add(`c${callKey}`);
        countLabels(acc, labelsByCall.get(callKey) ?? []);
      }
    }
  }

  // Stored transcripts of the totalled calls (ids, never content), joined
  // by (tenant, call id).
  const transcriptsByCall = new Map<string, AiPromptCompareTranscriptRef[]>();
  if (callIds.length > 0) {
    // Labels for a call: its own, its run's, and its usage rows'.
    const callLabels = new Map<string, LabelRow[]>();
    for (const entry of totalled) {
      if (!entry.callId) continue;
      const key = tenantKey(entry.tenant, entry.callId);
      const list = callLabels.get(key) ?? [...(labelsByCall.get(key) ?? [])];
      const add = (rows: LabelRow[] | undefined) => {
        for (const row of rows ?? []) {
          if (!list.some((existing) => existing.id === row.id)) list.push(row);
        }
      };
      add(labelsByUsage.get(tenantKey(entry.tenant, entry.id)));
      if (entry.runId)
        add(labelsByRun.get(tenantKey(entry.tenant, entry.runId)));
      callLabels.set(key, list);
    }
    for (const row of await inChunks(
      db,
      callIds,
      scope,
      (inList, tenantWhere) =>
        `SELECT id, call_id, tenant_id, created_at FROM _smrt_ai_transcripts
          WHERE call_id IN (${inList})${tenantWhere}`,
      'tenant_id',
    )) {
      const tenant = nullableString(row.tenant_id);
      const callId = String(row.call_id);
      const key = tenantKey(tenant, callId);
      const labels = callLabels.get(key) ?? [];
      const scores = labels
        .map((label) => label.score)
        .filter((score): score is number => score !== null);
      const ref: AiPromptCompareTranscriptRef = {
        id: String(row.id),
        callId,
        tenantId: tenant,
        createdAt: toDate(row.created_at),
        labels: [...new Set(labels.map((label) => label.label))],
        worstScore: scores.length > 0 ? Math.min(...scores) : null,
      };
      transcriptsByCall.set(key, [...(transcriptsByCall.get(key) ?? []), ref]);
    }
  }

  const rank = (ref: AiPromptCompareTranscriptRef) =>
    ref.worstScore !== null ? 0 : ref.labels.length > 0 ? 1 : 2;
  const finish = (acc: SideAccumulator): AiPromptCompareSide => {
    const side = acc.side;
    const sorted = [...acc.durations].sort((x, y) => x - y);
    const rate = (count: number) =>
      side.calls > 0 ? count / side.calls : null;
    const transcripts = [...acc.calls].flatMap(
      (key) => transcriptsByCall.get(key) ?? [],
    );
    transcripts.sort(
      (x, y) =>
        rank(x) - rank(y) ||
        (x.worstScore ?? 0) - (y.worstScore ?? 0) ||
        y.createdAt.getTime() - x.createdAt.getTime() ||
        (x.id < y.id ? -1 : x.id > y.id ? 1 : 0),
    );
    return {
      ...side,
      meanCost:
        side.costedCalls > 0 ? side.estimatedCost / side.costedCalls : null,
      latencyMs: {
        p50: percentile(sorted, 0.5),
        p90: percentile(sorted, 0.9),
        p95: percentile(sorted, 0.95),
        p99: percentile(sorted, 0.99),
      },
      fallbackRate: rate(side.fallbackCalls),
      degradedRate: rate(side.degradedCalls),
      meanScore:
        side.scoredLabels > 0 ? acc.scoreSum / side.scoredLabels : null,
      callIds: acc.calls.size,
      transcriptCount: transcripts.length,
      transcripts: transcripts.slice(0, transcriptLimit),
    };
  };

  const comparison: AiPromptComparison = {
    promptKey,
    since: options.since ?? null,
    until: options.until ?? null,
    crossTenant: options.tenantId === undefined,
    costBasis: AI_USAGE_COST_BASIS,
    a: finish(sides[0]),
    b: finish(sides[1]),
    rows,
    unmatched,
    inBoth,
    excluded,
  };
  if (options.tenantId !== undefined) comparison.tenantId = options.tenantId;
  return comparison;
}

// ============================================================================
// Template history
// ============================================================================

/** Options for {@link listAiPromptTemplateHistory}. */
export interface AiPromptTemplateHistoryOptions extends AiUsageTenantScope {
  promptKey: string;
  since?: Date;
  until?: Date;
}

/** One template hash seen for a prompt. */
export interface AiPromptTemplateHistoryEntry {
  /** The `templateHash` usage tag; `null` for calls recorded without one. */
  templateHash: string | null;
  /** `promptLayer` tags seen with it (`global`, `tenant`, …), sorted. */
  layers: string[];
  /** `provider:model` values seen with it, sorted. */
  models: string[];
  firstSeen: Date;
  lastSeen: Date;
  /** Usage rows (hosted-gate blocks excluded, see `blocked`). */
  calls: number;
  blocked: number;
}

/** The result of {@link listAiPromptTemplateHistory}. */
export interface AiPromptTemplateHistory {
  promptKey: string;
  since: Date | null;
  until: Date | null;
  tenantId?: string | null;
  crossTenant: boolean;
  /** Newest `lastSeen` first. */
  hashes: AiPromptTemplateHistoryEntry[];
  excluded: { externalAgent: number };
}

/**
 * The template hashes one prompt key ran with in a window, with first and
 * last seen and call counts, so `compareAiPromptRuns()` / `smrt ai:compare`
 * can pick a version without reading the table. Calls recorded without a
 * hash are their own entry (`templateHash: null`), never dropped.
 *
 * Tenant-scoped like {@link compareAiPromptRuns}.
 */
export async function listAiPromptTemplateHistory(
  db: DatabaseInterface,
  options: AiPromptTemplateHistoryOptions,
): Promise<AiPromptTemplateHistory> {
  const fn = 'listAiPromptTemplateHistory';
  requireScope(fn, options ?? {});
  const promptKey = requireText(options.promptKey, 'promptKey', fn);
  const scope: AiUsageTenantScope =
    options.tenantId !== undefined
      ? { tenantId: options.tenantId }
      : { allowCrossTenant: true };

  interface Bucket {
    entry: AiPromptTemplateHistoryEntry;
    layers: Set<string>;
    models: Set<string>;
  }
  const buckets = new Map<string, Bucket>();
  const excluded = { externalAgent: 0 };

  for await (const page of promptUsagePages(
    db,
    'id, provider, model, operation, tags, created_at',
    promptKey,
    scope,
    options.since,
    options.until,
  )) {
    for (const row of page) {
      if (isExternalAgentRow(row)) {
        excluded.externalAgent++;
        continue;
      }
      const tags = parseTags(row.tags);
      const hash = tagString(tags, 'templateHash');
      const createdAt = toDate(row.created_at);
      const key = JSON.stringify([hash]);
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = {
          entry: {
            templateHash: hash,
            layers: [],
            models: [],
            firstSeen: createdAt,
            lastSeen: createdAt,
            calls: 0,
            blocked: 0,
          },
          layers: new Set(),
          models: new Set(),
        };
        buckets.set(key, bucket);
      }
      const entry = bucket.entry;
      if (createdAt < entry.firstSeen) entry.firstSeen = createdAt;
      if (createdAt > entry.lastSeen) entry.lastSeen = createdAt;
      if (row.operation === INFERENCE_BLOCKED_OPERATION) entry.blocked++;
      else entry.calls++;
      const layer = tagString(tags, 'promptLayer');
      if (layer) bucket.layers.add(layer);
      bucket.models.add(`${String(row.provider)}:${String(row.model)}`);
    }
  }

  const history: AiPromptTemplateHistory = {
    promptKey,
    since: options.since ?? null,
    until: options.until ?? null,
    crossTenant: options.tenantId === undefined,
    hashes: [...buckets.values()]
      .map(({ entry, layers, models }) => ({
        ...entry,
        layers: [...layers].sort(),
        models: [...models].sort(),
      }))
      .sort(
        (x, y) =>
          y.lastSeen.getTime() - x.lastSeen.getTime() ||
          y.calls - x.calls ||
          String(x.templateHash).localeCompare(String(y.templateHash)),
      ),
    excluded,
  };
  if (options.tenantId !== undefined) history.tenantId = options.tenantId;
  return history;
}
