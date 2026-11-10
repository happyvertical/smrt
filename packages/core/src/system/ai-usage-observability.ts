/**
 * Prompt-run observability over `_smrt_ai_usage` (#4751): outcome labels and
 * the grouped usage report behind `smrt ai:usage`.
 *
 * Outcome labels exist because a run cannot rate itself: whether an answer
 * was any good is known later, by a person or a downstream check, and is
 * recorded then against the usage row or run it judges.
 *
 * The report follows one accounting rule: a filter selects what is totalled,
 * never what is accounted for. Rows without a prompt key are reported as
 * unattributed (never dropped), rows without a cost rate are counted beside
 * the cost total (never folded into it as zero), and rows a filter leaves out
 * are counted in `excluded`.
 */

import type { DatabaseInterface } from '@happyvertical/sql';
import { DEFAULT_AI_COST_RATES } from '../adapters/cost-rates.js';
import { EXTERNAL_AGENT_USAGE_OPERATION } from '../external-agent-usage.js';
import { INFERENCE_BLOCKED_OPERATION } from '../inference-gate.js';
import { toSafeInteger } from '../utils/safe-integer.js';

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

function requireText(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(
      `recordAiUsageOutcome: ${name} must be a non-empty string`,
    );
  }
  return value;
}

function optionalId(value: unknown, name: string): string | null {
  if (value === undefined || value === null) return null;
  return requireText(value, name);
}

// ============================================================================
// Outcome labels
// ============================================================================

/** Input for {@link recordAiUsageOutcome}. */
export interface AiUsageOutcomeInput {
  /** The `_smrt_ai_usage.id` this label judges. */
  usageId?: string | null;
  /** The run (`_smrt_ai_usage.run_id`) this label judges as a whole. */
  runId?: string | null;
  /**
   * The call (`_smrt_ai_usage.call_id`, the transcript's `call_id`; #4780)
   * this label judges: every usage row and the transcript of that call.
   */
  callId?: string | null;
  /** The verdict, e.g. `accepted`, `rejected`, `edited`. Free text. */
  label: string;
  /** Optional numeric score; any finite number, the scale is the caller's. */
  score?: number | null;
  /** Optional evidence; objects and arrays are stored as JSON text. */
  evidence?: string | Record<string, unknown> | unknown[] | null;
  /** Who recorded the label: a user id, service or check name. */
  actor: string;
  /**
   * Tenant of the judged usage. Omit it to take the tenant of the usage row
   * or run; when given it must match, or the label is refused.
   */
  tenantId?: string | null;
  /** Defaults to now. */
  createdAt?: Date;
}

/** One persisted `_smrt_ai_usage_outcomes` row. */
export interface AiUsageOutcomeRecord {
  id: string;
  usageId: string | null;
  runId: string | null;
  callId: string | null;
  label: string;
  score: number | null;
  evidence: string | null;
  actor: string;
  tenantId: string | null;
  createdAt: Date;
}

/** Thrown when an outcome label names usage that does not exist or belongs elsewhere. */
export class AiUsageOutcomeTargetError extends Error {
  readonly code:
    | 'AI_USAGE_OUTCOME_UNKNOWN_TARGET'
    | 'AI_USAGE_OUTCOME_TENANT_MISMATCH';

  constructor(code: AiUsageOutcomeTargetError['code'], message: string) {
    super(message);
    this.name = 'AiUsageOutcomeTargetError';
    this.code = code;
  }
}

/**
 * Tenants owning the usage a label targets. `undefined` in the set stands for
 * nothing found.
 */
async function targetTenants(
  db: DatabaseInterface,
  usageId: string | null,
  runId: string | null,
  callId: string | null,
): Promise<Set<string | null>> {
  const tenants = new Set<string | null>();
  if (usageId) {
    const rows = getRows(
      await db.query(
        'SELECT tenant_id FROM _smrt_ai_usage WHERE id = $1',
        usageId,
      ),
    );
    if (rows.length === 0) {
      throw new AiUsageOutcomeTargetError(
        'AI_USAGE_OUTCOME_UNKNOWN_TARGET',
        `recordAiUsageOutcome: no _smrt_ai_usage row has id "${usageId}"`,
      );
    }
    for (const row of rows) tenants.add(nullableString(row.tenant_id));
  }
  if (runId) {
    const rows = getRows(
      await db.query(
        'SELECT DISTINCT tenant_id FROM _smrt_ai_usage WHERE run_id = $1',
        runId,
      ),
    );
    if (rows.length === 0) {
      throw new AiUsageOutcomeTargetError(
        'AI_USAGE_OUTCOME_UNKNOWN_TARGET',
        `recordAiUsageOutcome: no _smrt_ai_usage row has run_id "${runId}"`,
      );
    }
    for (const row of rows) tenants.add(nullableString(row.tenant_id));
  }
  if (callId) {
    let rows = getRows(
      await db.query(
        'SELECT DISTINCT tenant_id FROM _smrt_ai_usage WHERE call_id = $1',
        callId,
      ),
    );
    if (rows.length === 0) {
      // Usage persistence may be off while transcripts are on (#4780): the
      // transcript row then names the call's tenant.
      try {
        rows = getRows(
          await db.query(
            'SELECT DISTINCT tenant_id FROM _smrt_ai_transcripts WHERE call_id = $1',
            callId,
          ),
        );
      } catch {
        rows = [];
      }
    }
    if (rows.length === 0) {
      throw new AiUsageOutcomeTargetError(
        'AI_USAGE_OUTCOME_UNKNOWN_TARGET',
        `recordAiUsageOutcome: no _smrt_ai_usage or _smrt_ai_transcripts row has call_id "${callId}"`,
      );
    }
    for (const row of rows) tenants.add(nullableString(row.tenant_id));
  }
  return tenants;
}

/**
 * Record an outcome label against one usage row, one run, one call (#4780),
 * or a combination.
 *
 * The target must exist in `_smrt_ai_usage` and the label inherits (or must
 * match) its tenant, so a label can never attach one tenant's verdict to
 * another tenant's usage. A run whose rows span tenants needs an explicit
 * `tenantId` that every row shares, which in practice means it is refused.
 */
export async function recordAiUsageOutcome(
  db: DatabaseInterface,
  input: AiUsageOutcomeInput,
): Promise<AiUsageOutcomeRecord> {
  const usageId = optionalId(input.usageId, 'usageId');
  const runId = optionalId(input.runId, 'runId');
  const callId = optionalId(input.callId, 'callId');
  if (!usageId && !runId && !callId) {
    throw new TypeError(
      'recordAiUsageOutcome: usageId, runId or callId is required',
    );
  }
  const label = requireText(input.label, 'label').trim();
  const actor = requireText(input.actor, 'actor');
  const score = input.score ?? null;
  if (
    score !== null &&
    (typeof score !== 'number' || !Number.isFinite(score))
  ) {
    throw new TypeError('recordAiUsageOutcome: score must be a finite number');
  }
  const evidence =
    input.evidence === undefined || input.evidence === null
      ? null
      : typeof input.evidence === 'string'
        ? input.evidence
        : JSON.stringify(input.evidence);

  const tenants = await targetTenants(db, usageId, runId, callId);
  let tenantId: string | null;
  if (input.tenantId !== undefined) {
    tenantId = input.tenantId;
    if (tenants.size !== 1 || !tenants.has(tenantId)) {
      throw new AiUsageOutcomeTargetError(
        'AI_USAGE_OUTCOME_TENANT_MISMATCH',
        'recordAiUsageOutcome: the target usage does not belong to the given tenant',
      );
    }
  } else {
    if (tenants.size !== 1) {
      throw new AiUsageOutcomeTargetError(
        'AI_USAGE_OUTCOME_TENANT_MISMATCH',
        'recordAiUsageOutcome: the target usage spans tenants; pass tenantId',
      );
    }
    tenantId = [...tenants][0] ?? null;
  }

  const record: AiUsageOutcomeRecord = {
    id: crypto.randomUUID(),
    usageId,
    runId,
    callId,
    label,
    score,
    evidence,
    actor,
    tenantId,
    createdAt: input.createdAt ?? new Date(),
  };

  await db.query(
    `INSERT INTO _smrt_ai_usage_outcomes
      (id, usage_id, run_id, call_id, label, score, evidence, actor, tenant_id, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    record.id,
    record.usageId,
    record.runId,
    record.callId,
    record.label,
    record.score,
    record.evidence,
    record.actor,
    record.tenantId,
    record.createdAt.toISOString(),
  );

  return record;
}

/** Filters for {@link listAiUsageOutcomes}. */
export interface AiUsageOutcomeListOptions {
  usageId?: string;
  runId?: string;
  callId?: string;
  label?: string;
  /** `null` selects global (tenant-less) labels; omit for every tenant. */
  tenantId?: string | null;
  since?: Date;
  until?: Date;
  /** Default 100. */
  limit?: number;
}

/** The usage columns an outcome read returns beside each label. */
export interface AiUsageOutcomeUsageRow {
  id: string;
  provider: string;
  model: string;
  operation: string;
  className: string | null;
  tenantId: string | null;
  promptKey: string | null;
  tierRequested: string | null;
  tierResolved: string | null;
  runId: string | null;
  callId: string | null;
  totalTokens: number | null;
  estimatedCost: number | null;
  duration: number;
  createdAt: Date;
}

/** An outcome label with the usage rows it judges. */
export interface AiUsageOutcomeWithUsage extends AiUsageOutcomeRecord {
  /**
   * The judged rows: the `usage_id` row and/or every row of `run_id` or
   * `call_id`, oldest first. Empty once retention has pruned them; the label itself survives.
   */
  usage: AiUsageOutcomeUsageRow[];
}

function hydrateOutcome(row: Record<string, unknown>): AiUsageOutcomeRecord {
  return {
    id: String(row.id),
    usageId: nullableString(row.usage_id),
    runId: nullableString(row.run_id),
    callId: nullableString(row.call_id),
    label: String(row.label),
    score: nullableNumber(row.score),
    evidence: nullableString(row.evidence),
    actor: String(row.actor),
    tenantId: nullableString(row.tenant_id),
    createdAt: toDate(row.created_at),
  };
}

function hydrateUsageRow(row: Record<string, unknown>): AiUsageOutcomeUsageRow {
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
    totalTokens:
      row.total_tokens === null || row.total_tokens === undefined
        ? null
        : toSafeInteger(row.total_tokens, 'AI usage total tokens'),
    estimatedCost: nullableNumber(row.estimated_cost),
    duration: toSafeInteger(row.duration ?? 0, 'AI usage duration'),
    createdAt: toDate(row.created_at),
  };
}

/**
 * Read outcome labels, newest first, each joined to the usage rows it judges.
 */
export async function listAiUsageOutcomes(
  db: DatabaseInterface,
  options: AiUsageOutcomeListOptions = {},
): Promise<AiUsageOutcomeWithUsage[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, value: unknown) => {
    params.push(value);
    conditions.push(sql.replace('?', `$${params.length}`));
  };
  if (options.usageId) add('usage_id = ?', options.usageId);
  if (options.runId) add('run_id = ?', options.runId);
  if (options.callId) add('call_id = ?', options.callId);
  if (options.label) add('label = ?', options.label);
  // Every supplied string filters, '' included: a falsy check would drop the
  // predicate and return every tenant's labels.
  if (options.tenantId === null) conditions.push('tenant_id IS NULL');
  else if (options.tenantId !== undefined) {
    add('tenant_id = ?', options.tenantId);
  }
  if (options.since) add('created_at >= ?', options.since.toISOString());
  if (options.until) add('created_at <= ?', options.until.toISOString());
  params.push(options.limit ?? 100);

  const outcomes = getRows(
    await db.query(
      `SELECT id, usage_id, run_id, call_id, label, score, evidence, actor, tenant_id, created_at
         FROM _smrt_ai_usage_outcomes
        ${conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''}
        ORDER BY created_at DESC, id DESC
        LIMIT $${params.length}`,
      ...params,
    ),
  ).map(hydrateOutcome);

  if (outcomes.length === 0) return [];

  const usageIds = [
    ...new Set(outcomes.flatMap((o) => (o.usageId ? [o.usageId] : []))),
  ];
  const runIds = [
    ...new Set(outcomes.flatMap((o) => (o.runId ? [o.runId] : []))),
  ];
  const callIds = [
    ...new Set(outcomes.flatMap((o) => (o.callId ? [o.callId] : []))),
  ];
  const usageParams: unknown[] = [];
  const placeholders = (values: string[]) =>
    values
      .map((value) => {
        usageParams.push(value);
        return `$${usageParams.length}`;
      })
      .join(', ');
  const predicates: string[] = [];
  if (usageIds.length > 0) predicates.push(`id IN (${placeholders(usageIds)})`);
  if (runIds.length > 0) predicates.push(`run_id IN (${placeholders(runIds)})`);
  if (callIds.length > 0) {
    predicates.push(`call_id IN (${placeholders(callIds)})`);
  }

  const usageRows = getRows(
    await db.query(
      `SELECT id, provider, model, operation, class_name, tenant_id, prompt_key,
              tier_requested, tier_resolved, run_id, call_id, total_tokens,
              estimated_cost, duration, created_at
         FROM _smrt_ai_usage
        WHERE ${predicates.join(' OR ')}
        ORDER BY created_at ASC, id ASC`,
      ...usageParams,
    ),
  ).map(hydrateUsageRow);

  return outcomes.map((outcome) => ({
    ...outcome,
    usage: usageRows.filter(
      (row) =>
        // A label never joins usage of another tenant.
        row.tenantId === outcome.tenantId &&
        ((outcome.usageId !== null && row.id === outcome.usageId) ||
          (outcome.runId !== null && row.runId === outcome.runId) ||
          (outcome.callId !== null && row.callId === outcome.callId)),
    ),
  }));
}

// ============================================================================
// Report
// ============================================================================

/** Dimensions `reportAiUsage()` can group by. */
export const AI_USAGE_REPORT_DIMENSIONS = [
  'prompt',
  'model',
  'tier',
  'class',
  'tenant',
  'fusion',
  'source',
  'template',
] as const;

export type AiUsageReportDimension =
  (typeof AI_USAGE_REPORT_DIMENSIONS)[number];

/** Options for {@link reportAiUsage}. */
export interface AiUsageReportOptions {
  /** Grouping dimensions, in order. Default `['prompt']`. */
  by?: AiUsageReportDimension[];
  since?: Date;
  until?: Date;
  /** Total only this tenant; `null` totals only global rows. */
  tenantId?: string | null;
  /**
   * Also count, per bucket and in the totals, the calls that have a stored
   * transcript (#4781): distinct `call_id`s with a `_smrt_ai_transcripts`
   * row of the same tenant. A count only; no transcript content is read.
   */
  transcripts?: boolean;
}

/** Totals for one bucket (or the whole report). */
export interface AiUsageReportStats {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** Sum of `estimated_cost` over `costedCalls` only, in USD. */
  estimatedCost: number;
  /** Calls with a recorded cost estimate. */
  costedCalls: number;
  /** Calls with no rate for their model: counted here, never priced as zero. */
  uncostedCalls: number;
  /** Median duration in ms (lower median), or null with no calls. */
  p50DurationMs: number | null;
  /** Calls whose `substitutions` tag records at least one fallback (#4752). */
  substitutions: number;
  /** Outcome labels per label name. */
  outcomes: Record<string, number>;
  /**
   * Calls the hosted gate refused (#4760): zero-usage rows with
   * `operation: 'blocked'`. Counted here, beside `calls`, never in it: a
   * blocked call ran nothing, so it adds no tokens, cost or duration.
   */
  blocked: number;
  /**
   * Calls with a stored transcript (#4781), counted once per call. Present
   * only when the report was asked for `transcripts: true`.
   */
  transcripts?: number;
}

/** One group of the report. */
export interface AiUsageReportBucket extends AiUsageReportStats {
  /** Value per requested dimension; `null` means the row carried none. */
  key: Partial<Record<AiUsageReportDimension, string | null>>;
}

/** The result of {@link reportAiUsage}. */
export interface AiUsageReport {
  by: AiUsageReportDimension[];
  since: Date | null;
  until: Date | null;
  /** The tenant filter, when one was given. */
  tenantId?: string | null;
  /** How `estimatedCost` was derived, stated so a reader can judge it. */
  costBasis: string;
  totals: AiUsageReportStats;
  buckets: AiUsageReportBucket[];
  /** Totalled calls recorded without a prompt key. */
  unattributedCalls: number;
  /** Rows in the window that were not totalled, and why. */
  excluded: {
    /** Rows of another tenant (or of a tenant, under `tenantId: null`). */
    otherTenants: number;
    /** External-agent measurements, which have their own summary contract. */
    externalAgent: number;
  };
}

/** Value written for a NULL dimension in rendered output. */
export const AI_USAGE_UNATTRIBUTED = '(unattributed)';

export const AI_USAGE_COST_BASIS =
  'estimated_cost as recorded at call time: provider:model rates in USD per 1K tokens ' +
  `from DEFAULT_AI_COST_RATES (snapshot 2026-03-12, ${Object.keys(DEFAULT_AI_COST_RATES).length} models) ` +
  'merged with any configured ai usage costRates; calls with no matching rate are counted as uncosted, not priced at zero';

interface StatsAccumulator {
  stats: AiUsageReportStats;
  durations: number[];
  runIds: Set<string>;
  /** Calls already counted in `stats.transcripts`. */
  transcriptCalls: Set<string>;
}

function emptyAccumulator(transcripts = false): StatsAccumulator {
  return {
    stats: {
      calls: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      estimatedCost: 0,
      costedCalls: 0,
      uncostedCalls: 0,
      p50DurationMs: null,
      substitutions: 0,
      // Null prototype: labels are free text, and `constructor` or
      // `__proto__` must count like any other label.
      outcomes: Object.create(null) as Record<string, number>,
      blocked: 0,
      ...(transcripts ? { transcripts: 0 } : {}),
    },
    durations: [],
    runIds: new Set(),
    transcriptCalls: new Set(),
  };
}

function countOutcome(outcomes: Record<string, number>, label: string): void {
  outcomes[label] =
    (Object.hasOwn(outcomes, label) ? (outcomes[label] ?? 0) : 0) + 1;
}

function lowerMedian(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)] ?? null;
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

function dimensionValue(
  dimension: AiUsageReportDimension,
  row: Record<string, unknown>,
  tags: Record<string, unknown> | undefined,
): string | null {
  switch (dimension) {
    case 'prompt':
      return nullableString(row.prompt_key);
    case 'model':
      return `${String(row.provider)}:${String(row.model)}`;
    case 'tier': {
      const requested = nullableString(row.tier_requested);
      const resolved = nullableString(row.tier_resolved);
      // `requested->resolved` only when both are known and differ (an `auto`
      // resolution or a recorded fallback); otherwise the one tier known.
      if (requested === null || resolved === null || requested === resolved) {
        return resolved ?? requested;
      }
      return `${requested}->${resolved}`;
    }
    case 'class':
      return nullableString(row.class_name);
    case 'tenant':
      return nullableString(row.tenant_id);
    case 'fusion': {
      const fusion = tags?.fusionKey;
      return typeof fusion === 'string' && fusion.length > 0 ? fusion : null;
    }
    case 'source': {
      // Binding origin from the `source` tag (#4756): byo, local, hosted, app.
      const source = tags?.source;
      return typeof source === 'string' && source.length > 0 ? source : null;
    }
    case 'template': {
      // The rendered template's hash from the `templateHash` tag (#4751).
      const hash = tags?.templateHash;
      return typeof hash === 'string' && hash.length > 0 ? hash : null;
    }
  }
}

const REPORT_PAGE_SIZE = 1000;

/**
 * The `(tenant, call id)` keys of a page's calls that have a stored
 * transcript (#4781). Reads ids only, never content, and only rows of the
 * report's tenant filter; a transcript counts only for usage rows of its own
 * tenant (the caller compares the keys).
 */
async function transcribedCalls(
  db: DatabaseInterface,
  page: Record<string, unknown>[],
  tenantId: string | null | undefined,
  targetKey: (tenant: string | null, id: string) => string,
): Promise<Set<string>> {
  const callIds = [
    ...new Set(
      page
        .map((row) => nullableString(row.call_id))
        .filter((id): id is string => id !== null),
    ),
  ];
  const found = new Set<string>();
  if (callIds.length === 0) return found;
  const params: unknown[] = [...callIds];
  const conditions = [
    `call_id IN (${callIds.map((_, index) => `$${index + 1}`).join(', ')})`,
  ];
  if (tenantId === null) conditions.push('tenant_id IS NULL');
  else if (tenantId !== undefined) {
    params.push(tenantId);
    conditions.push(`tenant_id = $${params.length}`);
  }
  const rows = getRows(
    await db.query(
      `SELECT DISTINCT call_id, tenant_id FROM _smrt_ai_transcripts
        WHERE ${conditions.join(' AND ')}`,
      ...params,
    ),
  );
  for (const row of rows) {
    const callId = nullableString(row.call_id);
    if (callId) found.add(targetKey(nullableString(row.tenant_id), callId));
  }
  return found;
}

/**
 * Group persisted AI usage by prompt, model, tier, class, tenant, fusion or
 * binding source.
 *
 * Rows are read in bounded keyset pages (never one unbounded result set) and
 * aggregated in memory, which keeps the median and the tag-derived
 * dimensions portable across SQLite, PostgreSQL and DuckDB.
 */
export async function reportAiUsage(
  db: DatabaseInterface,
  options: AiUsageReportOptions = {},
): Promise<AiUsageReport> {
  const by: AiUsageReportDimension[] =
    options.by && options.by.length > 0 ? [...new Set(options.by)] : ['prompt'];
  for (const dimension of by) {
    if (!AI_USAGE_REPORT_DIMENSIONS.includes(dimension)) {
      throw new TypeError(
        `reportAiUsage: unknown dimension "${dimension}" (expected ${AI_USAGE_REPORT_DIMENSIONS.join(', ')})`,
      );
    }
  }

  const windowConditions: string[] = [];
  const windowParams: unknown[] = [];
  if (options.since) {
    windowParams.push(options.since.toISOString());
    windowConditions.push(`created_at >= $${windowParams.length}`);
  }
  if (options.until) {
    windowParams.push(options.until.toISOString());
    windowConditions.push(`created_at <= $${windowParams.length}`);
  }

  const tenantFiltered = options.tenantId !== undefined;
  const tenantMatches = (tenant: string | null) =>
    !tenantFiltered || tenant === options.tenantId;

  // Outcome labels in scope, indexed by (tenant, target) so a label only ever
  // counts on rows of its own tenant, the rule listAiUsageOutcomes() applies:
  // a run id is a free-form tag another tenant can reuse after the label was
  // recorded. Labels are far fewer than usage rows.
  const targetKey = (tenant: string | null, id: string) =>
    JSON.stringify([tenant, id]);
  const outcomesByUsage = new Map<string, string[]>();
  const outcomesByRun = new Map<string, string[]>();
  const outcomesByCall = new Map<string, string[]>();
  {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (options.tenantId === null) conditions.push('tenant_id IS NULL');
    else if (options.tenantId !== undefined) {
      params.push(options.tenantId);
      conditions.push(`tenant_id = $${params.length}`);
    }
    const rows = getRows(
      await db.query(
        `SELECT usage_id, run_id, call_id, label, tenant_id FROM _smrt_ai_usage_outcomes
          ${conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''}`,
        ...params,
      ),
    );
    for (const row of rows) {
      const label = String(row.label);
      const tenant = nullableString(row.tenant_id);
      const usageId = nullableString(row.usage_id);
      const runId = nullableString(row.run_id);
      const callId = nullableString(row.call_id);
      // A label naming several targets judges the narrowest: the usage row,
      // else the run, else the call (#4780); the others are context.
      const [map, key] = usageId
        ? [outcomesByUsage, targetKey(tenant, usageId)]
        : runId
          ? [outcomesByRun, targetKey(tenant, runId)]
          : callId
            ? [outcomesByCall, targetKey(tenant, callId)]
            : [null, ''];
      if (map) map.set(key, [...(map.get(key) ?? []), label]);
    }
  }

  const withTranscripts = options.transcripts === true;
  const totals = emptyAccumulator(withTranscripts);
  const buckets = new Map<
    string,
    { key: AiUsageReportBucket['key']; acc: StatsAccumulator }
  >();
  const runLabelsCounted = new Set<string>();
  let unattributedCalls = 0;
  const excluded = { otherTenants: 0, externalAgent: 0 };

  let lastId: string | null = null;
  for (;;) {
    const params = [...windowParams];
    const conditions = [...windowConditions];
    if (lastId !== null) {
      params.push(lastId);
      conditions.push(`id > $${params.length}`);
    }
    params.push(REPORT_PAGE_SIZE);
    const page = getRows(
      await db.query(
        `SELECT id, provider, model, operation, class_name, tenant_id, prompt_key,
                tier_requested, tier_resolved, run_id, call_id, prompt_tokens,
                completion_tokens, total_tokens, estimated_cost, duration, tags
           FROM _smrt_ai_usage
          ${conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''}
          ORDER BY id ASC
          LIMIT $${params.length}`,
        ...params,
      ),
    );
    if (page.length === 0) break;
    lastId = String(page[page.length - 1]?.id);
    const transcribed = withTranscripts
      ? await transcribedCalls(db, page, options.tenantId, targetKey)
      : null;

    for (const row of page) {
      const id = String(row.id);
      if (
        row.operation === EXTERNAL_AGENT_USAGE_OPERATION &&
        id.startsWith(`${EXTERNAL_AGENT_USAGE_OPERATION}:`)
      ) {
        excluded.externalAgent++;
        continue;
      }
      if (!tenantMatches(nullableString(row.tenant_id))) {
        excluded.otherTenants++;
        continue;
      }

      const tags = parseTags(row.tags);
      const key: AiUsageReportBucket['key'] = {};
      for (const dimension of by)
        key[dimension] = dimensionValue(dimension, row, tags);
      const bucketId = JSON.stringify(by.map((dimension) => key[dimension]));
      let bucket = buckets.get(bucketId);
      if (!bucket) {
        bucket = { key, acc: emptyAccumulator(withTranscripts) };
        buckets.set(bucketId, bucket);
      }

      if (row.operation === INFERENCE_BLOCKED_OPERATION) {
        totals.stats.blocked++;
        bucket.acc.stats.blocked++;
        continue;
      }

      if (row.prompt_key === null || row.prompt_key === undefined) {
        unattributedCalls++;
      }

      const rowTenant = nullableString(row.tenant_id);
      const usageLabels = outcomesByUsage.get(targetKey(rowTenant, id)) ?? [];
      const runId = nullableString(row.run_id);
      const runKey = runId ? targetKey(rowTenant, runId) : null;
      const runLabels = runKey ? (outcomesByRun.get(runKey) ?? []) : [];
      const callId = nullableString(row.call_id);
      const callKey = callId ? targetKey(rowTenant, callId) : null;
      const callLabels = callKey ? (outcomesByCall.get(callKey) ?? []) : [];

      for (const acc of [totals, bucket.acc]) {
        const stats = acc.stats;
        stats.calls++;
        stats.promptTokens += Number(row.prompt_tokens ?? 0);
        stats.completionTokens += Number(row.completion_tokens ?? 0);
        stats.totalTokens += Number(row.total_tokens ?? 0);
        const cost = nullableNumber(row.estimated_cost);
        if (cost === null) {
          stats.uncostedCalls++;
        } else {
          stats.costedCalls++;
          stats.estimatedCost += cost;
        }
        acc.durations.push(Number(row.duration ?? 0));
        if (hasSubstitution(tags)) stats.substitutions++;
        if (
          callKey &&
          transcribed?.has(callKey) &&
          !acc.transcriptCalls.has(callKey)
        ) {
          acc.transcriptCalls.add(callKey);
          stats.transcripts = (stats.transcripts ?? 0) + 1;
        }
        for (const label of usageLabels) countOutcome(stats.outcomes, label);
        // A run label counts once per bucket containing the run, and once in
        // the totals, however many rows the run has.
        if (runKey && runLabels.length > 0) {
          const seenKey = `${acc === totals ? '*' : bucketId}\u0000${runKey}`;
          if (!runLabelsCounted.has(seenKey)) {
            runLabelsCounted.add(seenKey);
            for (const label of runLabels) countOutcome(stats.outcomes, label);
          }
        }
        // A call label (#4780) counts the same way: once per bucket holding
        // the call, once in the totals.
        if (callKey && callLabels.length > 0) {
          const seenKey = `${acc === totals ? '*' : bucketId}\u0001${callKey}`;
          if (!runLabelsCounted.has(seenKey)) {
            runLabelsCounted.add(seenKey);
            for (const label of callLabels) {
              countOutcome(stats.outcomes, label);
            }
          }
        }
      }
    }

    if (page.length < REPORT_PAGE_SIZE) break;
  }

  const finish = (acc: StatsAccumulator): AiUsageReportStats => ({
    ...acc.stats,
    p50DurationMs: lowerMedian(acc.durations),
  });

  const report: AiUsageReport = {
    by,
    since: options.since ?? null,
    until: options.until ?? null,
    costBasis: AI_USAGE_COST_BASIS,
    totals: finish(totals),
    buckets: [...buckets.values()]
      .map(({ key, acc }) => ({ key, ...finish(acc) }))
      .sort((a, b) => b.calls - a.calls || b.blocked - a.blocked),
    unattributedCalls,
    excluded,
  };
  if (tenantFiltered) report.tenantId = options.tenantId;
  return report;
}
