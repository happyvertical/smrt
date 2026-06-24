import {
  field,
  SmrtCollection,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import type { ReportRefreshMode, ReportRefreshTrigger } from './types.js';

export const REPORT_RUNS_TABLE = '_smrt_report_runs';
export const REPORT_WATERMARKS_TABLE = '_smrt_report_watermarks';
export const REPORT_LOCKS_TABLE = '_smrt_report_locks';
export const REPORT_SCHEDULES_TABLE = '_smrt_report_schedules';
export const REPORT_REFRESH_TASKS_TABLE = '_smrt_report_refresh_tasks';

export const REPORT_RUNTIME_TABLES = [
  REPORT_RUNS_TABLE,
  REPORT_WATERMARKS_TABLE,
  REPORT_LOCKS_TABLE,
] as const;

export const REPORT_SCHEDULER_TABLES = [
  REPORT_SCHEDULES_TABLE,
  REPORT_REFRESH_TASKS_TABLE,
] as const;

export type ReportRunStatus = 'running' | 'success' | 'failed' | 'skipped';
export type ReportScheduleStatus = 'active' | 'paused' | 'disabled' | 'error';

export function scopeKeyForTenant(tenantId: string | null | undefined): string {
  return tenantId ? `tenant:${tenantId}` : 'global';
}

export async function assertReportTablesReady(
  db: DatabaseInterface,
  tables: readonly string[] = REPORT_RUNTIME_TABLES,
): Promise<void> {
  for (const table of tables) {
    const ready = await db.tableExists(table);
    if (!ready) {
      throw new Error(
        `Report runtime table '${table}' does not exist. ` +
          'Run smrt db:migrate before refreshing reports.',
      );
    }
  }
}

const INTERNAL_SURFACE = {
  api: false,
  cli: {
    include: ['list', 'get'],
    skipApiCheck: true,
    http: false,
  },
  mcp: false,
};

@TenantScoped({ mode: 'optional' })
@smrt({
  tableName: '_smrt_report_runs',
  ...INTERNAL_SURFACE,
})
export class SmrtReportRun extends SmrtObject {
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  @field({ type: 'text', required: true })
  scopeKey: string = 'global';

  @field({ type: 'text', required: true })
  reportClass: string = '';

  @field({ type: 'text', required: true })
  sourceClass: string = '';

  @field({ type: 'text', required: true })
  mode: ReportRefreshMode = 'rebuild';

  @field({ type: 'text', required: true })
  trigger: ReportRefreshTrigger = 'manual';

  @field({ type: 'text', required: true })
  status: ReportRunStatus = 'running';

  @field({ type: 'datetime', required: true })
  startedAt: Date = new Date();

  @field({ type: 'datetime', nullable: true })
  completedAt: Date | null = null;

  @field({ type: 'integer', required: true })
  rowCount: number = 0;

  @field({ type: 'integer', required: true })
  changedGroupCount: number = 0;

  @field({ type: 'text', nullable: true })
  watermarkBefore: string | null = null;

  @field({ type: 'text', nullable: true })
  watermarkAfter: string | null = null;

  @field({ type: 'text', nullable: true })
  error: string | null = null;

  @field({ type: 'json' })
  metadata: Record<string, unknown> = {};
}

export class SmrtReportRunCollection extends SmrtCollection<SmrtReportRun> {
  static readonly _itemClass = SmrtReportRun;
}

@TenantScoped({ mode: 'optional' })
@smrt({
  tableName: '_smrt_report_watermarks',
  conflictColumns: [
    'report_class',
    'scope_key',
    'source_class',
    'watermark_column',
  ],
  ...INTERNAL_SURFACE,
})
export class SmrtReportWatermark extends SmrtObject {
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  @field({ type: 'text', required: true })
  scopeKey: string = 'global';

  @field({ type: 'text', required: true })
  reportClass: string = '';

  @field({ type: 'text', required: true })
  sourceClass: string = '';

  @field({ type: 'text', required: true })
  watermarkColumn: string = '';

  @field({ type: 'text', nullable: true })
  watermarkValue: string | null = null;

  @field({ type: 'text', nullable: true })
  lastRunId: string | null = null;
}

export class SmrtReportWatermarkCollection extends SmrtCollection<SmrtReportWatermark> {
  static readonly _itemClass = SmrtReportWatermark;
}

@TenantScoped({ mode: 'optional' })
@smrt({
  tableName: '_smrt_report_locks',
  conflictColumns: ['report_class', 'scope_key'],
  ...INTERNAL_SURFACE,
})
export class SmrtReportLock extends SmrtObject {
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  @field({ type: 'text', required: true })
  scopeKey: string = 'global';

  @field({ type: 'text', required: true })
  reportClass: string = '';

  @field({ type: 'text', nullable: true })
  ownerId: string | null = null;

  @field({ type: 'datetime', nullable: true })
  acquiredAt: Date | null = null;

  @field({ type: 'datetime', nullable: true })
  heartbeatAt: Date | null = null;

  @field({ type: 'datetime', nullable: true })
  expiresAt: Date | null = null;
}

export class SmrtReportLockCollection extends SmrtCollection<SmrtReportLock> {
  static readonly _itemClass = SmrtReportLock;
}

@TenantScoped({ mode: 'optional' })
@smrt({
  tableName: '_smrt_report_schedules',
  conflictColumns: ['report_class', 'scope_key', 'cron', 'mode'],
  ...INTERNAL_SURFACE,
})
export class SmrtReportSchedule extends SmrtObject {
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  @field({ type: 'text', required: true })
  scopeKey: string = 'global';

  @field({ type: 'text', required: true })
  reportClass: string = '';

  @field({ type: 'text', required: true })
  cron: string = '';

  @field({ type: 'text', required: true })
  trigger: ReportRefreshTrigger = 'schedule';

  @field({ type: 'text', required: true })
  mode: ReportRefreshMode = 'incremental';

  @field({ type: 'boolean', required: true })
  enabled: boolean = true;

  @field({ type: 'text', required: true })
  status: ReportScheduleStatus = 'active';

  @field({ type: 'datetime', nullable: true })
  nextRun: Date | null = null;

  @field({ type: 'datetime', nullable: true })
  lastRun: Date | null = null;

  @field({ type: 'text', nullable: true })
  lastStatus: 'success' | 'failed' | null = null;

  @field({ type: 'text', nullable: true })
  lastError: string | null = null;

  @field({ type: 'integer', required: true })
  runCount: number = 0;

  @field({ type: 'integer', required: true })
  successCount: number = 0;

  @field({ type: 'integer', required: true })
  failureCount: number = 0;

  @field({ type: 'integer', required: true })
  runningCount: number = 0;

  @field({ type: 'integer', required: true })
  maxConcurrent: number = 1;

  @field({ type: 'text', required: true })
  queue: string = 'reports';

  @field({ type: 'integer', required: true })
  priority: number = 70;

  @field({ type: 'integer', required: true })
  timeout: number = 3600000;
}

export class SmrtReportScheduleCollection extends SmrtCollection<SmrtReportSchedule> {
  static readonly _itemClass = SmrtReportSchedule;
}
