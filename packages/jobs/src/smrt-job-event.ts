// Self-register this package's manifest for consumers that import via this
// subpath without the main entry. See src/__smrt-register__.ts (issue #1132).
import './__smrt-register__.js';

import {
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

function usesSqliteDateFunctions(dbUrl: string): boolean {
  const normalized = dbUrl.toLowerCase();
  return !(
    normalized.startsWith('postgres:') || normalized.startsWith('postgresql:')
  );
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
    if (usesSqliteDateFunctions(this.db.url)) {
      return "strftime('%Y-%m-%dT%H:%M:%fZ', created_at)";
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

export default SmrtJobEvent;
