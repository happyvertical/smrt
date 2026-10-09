// Self-register this package's manifest for consumers that import via this
// subpath without the main entry. See src/__smrt-register__.ts (issue #1132).
import './__smrt-register__.js';

import {
  detectEngine,
  ensureJobEventsSystemTableCompatibility,
  field,
  foreignKey,
  SmrtCollection,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import {
  getTenantId,
  TenantScoped,
  tenantId,
} from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';

export type SmrtJobEventType = 'status' | 'progress' | 'log' | 'error' | string;

export type SmrtJobEventLevel = 'debug' | 'info' | 'warn' | 'error';

export interface SmrtJobEventData {
  tenantId?: string | null;
  jobId: string;
  type?: SmrtJobEventType;
  level?: SmrtJobEventLevel;
  stage?: string | null;
  progress?: number | null;
  message?: string;
  data?: Record<string, unknown>;
  createdAt?: Date;
}

export interface JobEventCursor {
  createdAt: string | Date;
  id: string;
}

export interface ListJobEventsOptions {
  tenantId?: string | null;
  limit?: number;
  since?: string | Date;
  afterId?: string;
  cursor?: string | JobEventCursor;
}

export type SmrtJobTerminalStatus = 'completed' | 'failed' | 'cancelled';

export interface SmrtJobTerminalOutcome {
  eventId: string;
  jobId: string;
  tenantId: string | null;
  status: SmrtJobTerminalStatus;
  queue: string;
  objectType: string;
  method: string;
  attempts: number;
  failureKind?: 'execution' | 'timeout' | 'stale-recovery';
  completedAt: string;
  cursor: string;
}

export interface ListTerminalOutcomesOptions {
  /** Explicit tenant boundary. Pass null only for global jobs. */
  tenantId: string | null;
  limit?: number;
  since?: string | Date;
  before?: string | JobEventCursor;
  statuses?: SmrtJobTerminalStatus[];
  queues?: string[];
  objectTypes?: string[];
  methods?: string[];
}

export interface SmrtJobTerminalOutcomePage {
  outcomes: SmrtJobTerminalOutcome[];
  limit: number;
  candidateLimit: 1000;
  truncated: boolean;
  nextCursor: string | null;
}

const JOB_EVENT_STORAGE_COLUMNS = [
  'id',
  'slug',
  'context',
  'created_at',
  'updated_at',
  'tenant_id',
  'job_id',
  'type',
  'level',
  'stage',
  'progress',
  'message',
  'data',
].join(', ');
const TERMINAL_OUTCOME_CANDIDATE_LIMIT = 1000 as const;

@smrt({
  tableName: '_smrt_job_events',
  // Fail closed: same reasoning as SmrtJob. `_smrt_job_events` carries job
  // progress/log/error payloads for every tenant; an `optional`-mode generated
  // read reached without tenant context returns UNFILTERED rows. Consumers read
  // events through the collection's tenant-aware methods (listByJob /
  // listSinceCursor, which require an explicit tenantId or ambient context), not
  // through generated routes — so we do not generate a read surface here
  // (S5 audit #1402).
  api: false,
  // In-process operator commands only (http: false). skipApiCheck acknowledges
  // that these CLI reads intentionally have no HTTP/API route now that api is
  // disabled (S5 audit #1402).
  cli: { include: ['list', 'get'], http: false, skipApiCheck: true },
  mcp: false,
})
// Keep the data model tenant-scoped (defense in depth); the @tenantId() field
// alone does not make collection reads filter by tenant. `optional` keeps global
// (NULL tenant) events working (S5 audit #1402).
@TenantScoped({ mode: 'optional' })
export class SmrtJobEvent extends SmrtObject {
  @tenantId({ nullable: true })
  tenantId: string | null | undefined = undefined;

  // Job events intentionally outlive completed job rows (30-day event
  // retention vs 7-day completed-job retention). Keep the typed relationship,
  // index, and retained job identifier, but do not install a physical FK or
  // app-side delete action that would make the documented retention sweep
  // impossible (#2375, #2413).
  @foreignKey('SmrtJob', { required: true, constraint: false })
  jobId: string = '';

  @field({ type: 'text', required: true, default: 'log' })
  type: SmrtJobEventType = 'log';

  @field({ type: 'text', required: true, default: 'info' })
  level: SmrtJobEventLevel = 'info';

  @field({ type: 'text', nullable: true })
  stage: string | null = null;

  @field({ type: 'integer', nullable: true })
  progress: number | null = null;

  @field({ type: 'text', required: true, default: '' })
  message: string = '';

  @field({ type: 'json' })
  data: Record<string, unknown> = {};

  @field({ type: 'datetime', required: true })
  createdAt: Date = new Date();

  toCursor(): string {
    const createdAt =
      this.createdAt instanceof Date
        ? this.createdAt.toISOString()
        : String(this.createdAt);
    return `${createdAt}|${this.id ?? ''}`;
  }
}

function normalizeLimit(limit: number | undefined): number {
  const numeric =
    typeof limit === 'number' && Number.isFinite(limit) ? limit : 250;
  return Math.max(1, Math.min(1000, Math.floor(numeric)));
}

function normalizeProgress(progress: unknown): number | null {
  if (typeof progress !== 'number' || !Number.isFinite(progress)) {
    return null;
  }

  return Math.max(0, Math.min(100, Math.round(progress)));
}

function parseCursor(cursor: string | JobEventCursor): JobEventCursor {
  if (typeof cursor !== 'string') return cursor;
  const separator = cursor.lastIndexOf('|');
  if (separator === -1) {
    return { createdAt: cursor, id: '' };
  }
  return {
    createdAt: cursor.slice(0, separator),
    id: cursor.slice(separator + 1),
  };
}

function normalizeCursorDate(value: string | Date): string {
  if (value instanceof Date) {
    return value.toISOString();
  }

  const parsed = new Date(value);
  if (!Number.isNaN(parsed.getTime())) {
    return parsed.toISOString();
  }

  return value;
}

function databaseEngine(
  db: DatabaseInterface,
): ReturnType<typeof detectEngine> {
  const configured = db as DatabaseInterface & {
    config?: { type?: string; url?: string };
    type?: string;
    client?: { constructor?: { name?: string }; connection?: unknown };
  };
  const engine = detectEngine(
    db.url || configured.config?.url || '',
    configured.type || configured.config?.type,
  );
  const clientName = configured.client?.constructor?.name?.toLowerCase() ?? '';
  if (
    engine === 'sqlite' &&
    (clientName.includes('duckdb') ||
      configured.client?.connection !== undefined)
  ) {
    return 'duckdb';
  }
  return engine;
}

function getQueryRows(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) {
    return result as Record<string, unknown>[];
  }

  return (result as { rows?: Record<string, unknown>[] }).rows ?? [];
}

export class SmrtJobEventCollection extends SmrtCollection<SmrtJobEvent> {
  static readonly _itemClass = SmrtJobEvent;

  override async initialize(): Promise<this> {
    await super.initialize();
    await ensureJobEventsSystemTableCompatibility(this.db);
    return this;
  }

  async append(input: SmrtJobEventData): Promise<SmrtJobEvent> {
    return this.create({
      tenantId: input.tenantId,
      jobId: input.jobId,
      type: input.type ?? 'log',
      level: input.level ?? 'info',
      stage: input.stage ?? null,
      progress: normalizeProgress(input.progress),
      message: input.message ?? '',
      data: input.data ?? {},
      createdAt: input.createdAt ?? new Date(),
    });
  }

  async listByJob(
    jobId: string,
    options: ListJobEventsOptions = {},
  ): Promise<SmrtJobEvent[]> {
    return this.listSinceCursor({
      ...options,
      jobId,
    });
  }

  async listSinceCursor(
    options: ListJobEventsOptions & { jobId?: string } = {},
  ): Promise<SmrtJobEvent[]> {
    const where: string[] = [];
    const params: unknown[] = [];

    if (options.jobId) {
      where.push('job_id = ?');
      params.push(options.jobId);
    }

    this.addTenantPredicate(where, params, options);

    if (options.cursor) {
      const cursor = parseCursor(options.cursor);
      const createdAt = await this.resolveCursorCreatedAt(cursor, options);
      const createdAtExpression = this.createdAtComparableExpression();
      where.push(
        `(${createdAtExpression} > ? OR (${createdAtExpression} = ? AND id > ?))`,
      );
      params.push(createdAt, createdAt, cursor.id);
    } else if (options.since) {
      where.push(`${this.createdAtComparableExpression()} > ?`);
      params.push(normalizeCursorDate(options.since));
    }

    if (options.afterId) {
      where.push('id > ?');
      params.push(options.afterId);
    }

    params.push(normalizeLimit(options.limit));

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    return this.query(
      `SELECT ${JOB_EVENT_STORAGE_COLUMNS}
         FROM _smrt_job_events
        ${whereSql}
        ORDER BY ${this.createdAtComparableExpression()} ASC, id ASC
        LIMIT ?`,
      params,
      { allowRawOnTenantScoped: true },
    );
  }

  async latestProgressByJobIds(
    jobIds: string[],
    options: { tenantId?: string | null } = {},
  ): Promise<Map<string, SmrtJobEvent>> {
    const uniqueJobIds = [...new Set(jobIds.filter(Boolean))];
    const latestByJobId = new Map<string, SmrtJobEvent>();
    if (uniqueJobIds.length === 0) return latestByJobId;

    const placeholders = uniqueJobIds.map(() => '?').join(', ');
    const where: string[] = [
      `job_id IN (${placeholders})`,
      "type = 'progress'",
    ];
    const params: unknown[] = [...uniqueJobIds];

    this.addTenantPredicate(where, params, options);
    const createdAtExpression = this.createdAtComparableExpression();

    const events = await this.query(
      `SELECT ${JOB_EVENT_STORAGE_COLUMNS}
         FROM (
           SELECT ${JOB_EVENT_STORAGE_COLUMNS},
                  ${createdAtExpression} AS smrt_created_at_sort,
                  ROW_NUMBER() OVER (
                    PARTITION BY job_id
                    ORDER BY ${createdAtExpression} DESC, id DESC
                  ) AS smrt_rank
             FROM _smrt_job_events
            WHERE ${where.join(' AND ')}
         ) ranked
        WHERE smrt_rank = 1
        ORDER BY smrt_created_at_sort DESC, id DESC`,
      params,
      { allowRawOnTenantScoped: true },
    );

    for (const event of events) {
      latestByJobId.set(event.jobId, event);
    }

    return latestByJobId;
  }

  /**
   * Read the newest safe, authoritative terminal outcomes for one tenant.
   *
   * The projection is built only from versioned terminal events written in the
   * same transaction as their job status. It never returns job arguments,
   * object ids, results, raw errors, or stack traces. Events follow the package
   * retention policy (30 days by default), independently of job-row cleanup.
   */
  async listTerminalOutcomes(
    options: ListTerminalOutcomesOptions,
  ): Promise<SmrtJobTerminalOutcomePage> {
    if (!Object.hasOwn(options, 'tenantId') || options.tenantId === undefined) {
      throw new Error(
        'Terminal outcome queries require tenantId or tenantId: null',
      );
    }
    const limit = normalizeLimit(options.limit ?? 100);
    const where = [
      "stage IN ('completed', 'failed', 'cancelled', 'stale-recovery')",
    ];
    const params: unknown[] = [];
    this.addTenantPredicate(where, params, options);

    if (options.statuses?.length) {
      const stages = options.statuses.flatMap((status) =>
        status === 'failed' ? ['failed', 'stale-recovery'] : [status],
      );
      where.push(`stage IN (${stages.map(() => '?').join(', ')})`);
      params.push(...stages);
    }
    if (options.since) {
      where.push(`${this.createdAtComparableExpression()} > ?`);
      params.push(normalizeCursorDate(options.since));
    }
    if (options.before) {
      const cursor = parseCursor(options.before);
      const createdAt = await this.resolveCursorCreatedAt(cursor, options);
      const expression = this.createdAtComparableExpression();
      where.push(`(${expression} < ? OR (${expression} = ? AND id < ?))`);
      params.push(createdAt, createdAt, cursor.id);
    }

    params.push(TERMINAL_OUTCOME_CANDIDATE_LIMIT);
    const expression = this.createdAtComparableExpression();
    const candidates = await this.query(
      `SELECT ${JOB_EVENT_STORAGE_COLUMNS}
         FROM _smrt_job_events
        WHERE ${where.join(' AND ')}
        ORDER BY ${expression} DESC, id DESC
        LIMIT ?`,
      params,
      { allowRawOnTenantScoped: true },
    );

    const outcomes: SmrtJobTerminalOutcome[] = [];
    let scanned: SmrtJobEvent | undefined;
    for (const event of candidates) {
      scanned = event;
      const outcome = terminalOutcome(event);
      if (!outcome || !matchesTerminalOutcome(outcome, options)) continue;
      outcomes.push(outcome);
      if (outcomes.length === limit) break;
    }
    const stoppedAtLimit = outcomes.length === limit;
    const candidateBoundReached =
      candidates.length === TERMINAL_OUTCOME_CANDIDATE_LIMIT;

    return {
      outcomes,
      limit,
      candidateLimit: TERMINAL_OUTCOME_CANDIDATE_LIMIT,
      truncated: stoppedAtLimit || candidateBoundReached,
      nextCursor:
        (stoppedAtLimit || candidateBoundReached) && scanned
          ? scanned.toCursor()
          : null,
    };
  }

  private addTenantPredicate(
    where: string[],
    params: unknown[],
    options: { tenantId?: string | null },
  ): void {
    if (options.tenantId === null) {
      where.push('tenant_id IS NULL');
      return;
    }

    const tenantId =
      typeof options.tenantId === 'string' ? options.tenantId : getTenantId();

    if (tenantId) {
      where.push('tenant_id = ?');
      params.push(tenantId);
      return;
    }

    throw new Error(
      'Tenant-scoped job event queries require tenantId, tenantId: null, or an ambient tenant context.',
    );
  }

  /**
   * Delete job events recorded before a cutoff (#2375).
   *
   * `_smrt_job_events` is append-only — every log line, progress tick and
   * lifecycle transition of every job — so it outgrows `_smrt_jobs` by an
   * order of magnitude and had no prune path at all. Events are pruned on
   * their own clock rather than by following job deletion: a long-running job
   * accumulates events for as long as it runs.
   *
   * The cutoff uses the same engine-normalized `created_at` expression the
   * cursor reads use. On PostgreSQL that is the bare column, so
   * `idx_smrt_job_events_created_at` serves it; on SQLite the `strftime()`
   * wrapper makes the comparison non-sargable and the prune is a scan. That is
   * acceptable for a periodic maintenance pass and is preferable to comparing
   * two differently-formatted timestamps, which is what the wrapper exists to
   * prevent.
   *
   * @param options.before - Delete events created strictly before this time.
   * @param options.dryRun - Count matching events without deleting them.
   * @returns Number of events deleted (or, under `dryRun`, matched).
   */
  async cleanup(options: { before: Date; dryRun?: boolean }): Promise<number> {
    const expression = this.createdAtComparableExpression();
    const where = `${expression} < ?`;
    const cutoff = options.before.toISOString();

    const counted = await this.db.query(
      `SELECT COUNT(*) AS total FROM _smrt_job_events WHERE ${where}`,
      cutoff,
    );
    const total = Number(counted.rows?.[0]?.total ?? 0);
    if (!Number.isFinite(total) || total <= 0) return 0;

    if (!options.dryRun) {
      await this.db.query(
        `DELETE FROM _smrt_job_events WHERE ${where}`,
        cutoff,
      );
    }

    return total;
  }

  private createdAtComparableExpression(): string {
    const engine = databaseEngine(this.db);
    if (engine === 'sqlite') {
      return "strftime('%Y-%m-%dT%H:%M:%fZ', created_at)";
    }
    if (engine === 'duckdb') {
      return "strftime(created_at, '%Y-%m-%dT%H:%M:%S.%gZ')";
    }

    return 'created_at';
  }

  private async resolveCursorCreatedAt(
    cursor: JobEventCursor,
    options: ListJobEventsOptions & { jobId?: string },
  ): Promise<string> {
    if (!cursor.id) {
      return normalizeCursorDate(cursor.createdAt);
    }

    const where = ['id = ?'];
    const params: unknown[] = [cursor.id];
    if (options.jobId) {
      where.push('job_id = ?');
      params.push(options.jobId);
    }
    this.addTenantPredicate(where, params, options);

    const result = await this.db.query(
      `SELECT ${this.createdAtComparableExpression()} AS cursor_created_at
         FROM _smrt_job_events
        WHERE ${where.join(' AND ')}
        LIMIT 1`,
      ...params,
    );
    const cursorCreatedAt = getQueryRows(result)[0]?.cursor_created_at;

    return typeof cursorCreatedAt === 'string' && cursorCreatedAt.trim()
      ? cursorCreatedAt
      : normalizeCursorDate(cursor.createdAt);
  }
}

function terminalOutcome(event: SmrtJobEvent): SmrtJobTerminalOutcome | null {
  const data = event.data;
  if (
    data?.version !== 1 ||
    data.terminal !== true ||
    !isTerminalStatus(data.status) ||
    !matchesTerminalStage(data.status, data.failureKind, event.stage) ||
    typeof data.queue !== 'string' ||
    typeof data.objectType !== 'string' ||
    typeof data.method !== 'string' ||
    typeof data.attempts !== 'number' ||
    !Number.isSafeInteger(data.attempts) ||
    data.attempts < 0 ||
    typeof data.completedAt !== 'string' ||
    Number.isNaN(Date.parse(data.completedAt)) ||
    (data.status === 'failed'
      ? !isFailureKind(data.failureKind)
      : data.failureKind !== undefined) ||
    !event.id
  ) {
    return null;
  }
  const failureKind =
    data.status === 'failed'
      ? (data.failureKind as SmrtJobTerminalOutcome['failureKind'])
      : undefined;

  return {
    eventId: event.id,
    jobId: event.jobId,
    tenantId: event.tenantId ?? null,
    status: data.status,
    queue: data.queue,
    objectType: data.objectType,
    method: data.method,
    attempts: data.attempts,
    ...(failureKind ? { failureKind } : {}),
    completedAt: new Date(data.completedAt).toISOString(),
    cursor: event.toCursor(),
  };
}

function isFailureKind(
  value: unknown,
): value is 'execution' | 'timeout' | 'stale-recovery' {
  return (
    value === 'execution' || value === 'timeout' || value === 'stale-recovery'
  );
}

function isTerminalStatus(value: unknown): value is SmrtJobTerminalStatus {
  return value === 'completed' || value === 'failed' || value === 'cancelled';
}

function matchesTerminalStage(
  status: SmrtJobTerminalStatus,
  failureKind: unknown,
  stage: string | null,
): boolean {
  return (
    stage === status ||
    (status === 'failed' &&
      failureKind === 'stale-recovery' &&
      stage === 'stale-recovery')
  );
}

function matchesTerminalOutcome(
  outcome: SmrtJobTerminalOutcome,
  options: ListTerminalOutcomesOptions,
): boolean {
  return (
    (!options.queues?.length || options.queues.includes(outcome.queue)) &&
    (!options.objectTypes?.length ||
      options.objectTypes.includes(outcome.objectType)) &&
    (!options.methods?.length || options.methods.includes(outcome.method))
  );
}

export default SmrtJobEvent;
