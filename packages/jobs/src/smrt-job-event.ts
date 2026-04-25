// Self-register this package's manifest for consumers that import via this
// subpath without the main entry. See src/__smrt-register__.ts (issue #1132).
import './__smrt-register__.js';

import {
  ensureJobEventsSystemTableCompatibility,
  field,
  SmrtCollection,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { getTenantId, tenantId } from '@happyvertical/smrt-tenancy';

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

@smrt({
  tableName: '_smrt_job_events',
  api: { include: ['list', 'get'] },
  cli: { include: ['list', 'get'] },
  mcp: { include: ['list', 'get'] },
})
export class SmrtJobEvent extends SmrtObject {
  @tenantId({ nullable: true })
  tenantId: string | null | undefined = undefined;

  @field({ type: 'text', required: true })
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

    if ('tenantId' in options) {
      if (options.tenantId === null) {
        where.push('tenant_id IS NULL');
      } else if (typeof options.tenantId === 'string') {
        where.push('tenant_id = ?');
        params.push(options.tenantId);
      }
    } else {
      const contextTenantId = getTenantId();
      if (contextTenantId) {
        where.push('tenant_id = ?');
        params.push(contextTenantId);
      }
    }

    if (options.cursor) {
      const cursor = parseCursor(options.cursor);
      const createdAt =
        cursor.createdAt instanceof Date
          ? cursor.createdAt.toISOString()
          : String(cursor.createdAt);
      where.push('(created_at > ? OR (created_at = ? AND id > ?))');
      params.push(createdAt, createdAt, cursor.id);
    } else if (options.since) {
      where.push('created_at > ?');
      params.push(
        options.since instanceof Date
          ? options.since.toISOString()
          : String(options.since),
      );
    }

    if (options.afterId) {
      where.push('id > ?');
      params.push(options.afterId);
    }

    params.push(normalizeLimit(options.limit));

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    return this.query(
      `SELECT *
         FROM _smrt_job_events
        ${whereSql}
        ORDER BY created_at ASC, id ASC
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

    if ('tenantId' in options) {
      if (options.tenantId === null) {
        where.push('tenant_id IS NULL');
      } else if (typeof options.tenantId === 'string') {
        where.push('tenant_id = ?');
        params.push(options.tenantId);
      }
    } else {
      const contextTenantId = getTenantId();
      if (contextTenantId) {
        where.push('tenant_id = ?');
        params.push(contextTenantId);
      }
    }

    const events = await this.query(
      `SELECT *
         FROM _smrt_job_events
        WHERE ${where.join(' AND ')}
        ORDER BY created_at DESC, id DESC`,
      params,
      { allowRawOnTenantScoped: true },
    );

    for (const event of events) {
      if (!latestByJobId.has(event.jobId)) {
        latestByJobId.set(event.jobId, event);
      }
    }

    return latestByJobId;
  }
}

export default SmrtJobEvent;
