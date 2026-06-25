import type { SmrtObject } from '@happyvertical/smrt-core';
import type {
  AggregateBuildResult,
  AggregateFunction,
  AggregateSelectExpr,
  AggregateSpec,
  AggregateTimeBucketUnit,
  SqlAdapterType,
  WhereClause,
} from '@happyvertical/sql';

export type ReportTimeBucketUnit = AggregateTimeBucketUnit;
export type ReportAggregateFn = AggregateFunction;
export type { AggregateBuildResult, AggregateSelectExpr, AggregateSpec };

export type ReportRefreshMode = 'rebuild' | 'incremental';

export type ReportRefreshTrigger =
  | 'manual'
  | 'schedule'
  | 'change'
  | 'ttl'
  | 'job';

export type ReportSource =
  | string
  | (new (
      ...args: any[]
    ) => SmrtObject)
  | (abstract new (
      ...args: any[]
    ) => SmrtObject);

export interface ReportRefreshConfig {
  mode?: ReportRefreshMode;
  schedule?: string;
  onChange?: ReportSource[];
  /**
   * Milliseconds before collection reads trigger a synchronous refresh.
   *
   * TTL refresh checks add a read-time MAX(refreshedAt) query, and stale reads
   * perform the refresh before returning list/get results.
   */
  ttl?: number;
  manual?: boolean;
  watermarkColumn?: string;
  softDeleteColumn?: string;
  fullRebuildSchedule?: string;
  tenantFanout?: boolean;
}

export interface ReportOptions {
  source: ReportSource;
  where?: WhereClause;
  having?: WhereClause;
  refresh?: ReportRefreshConfig;
}

export interface ReportGroupFieldMetadata {
  kind: 'group';
  sourceColumn?: string;
}

export interface ReportBucketFieldMetadata {
  kind: 'bucket';
  unit: ReportTimeBucketUnit;
  sourceColumn: string;
}

export interface ReportAggregateFieldMetadata {
  kind: 'aggregate';
  fn: ReportAggregateFn;
  column?: string;
  distinct?: boolean;
}

export type ReportFieldMetadata =
  | ReportGroupFieldMetadata
  | ReportBucketFieldMetadata
  | ReportAggregateFieldMetadata;

export interface ReportFieldDefinition {
  fieldName: string;
  columnName?: string;
  type?: string;
  report?: ReportFieldMetadata;
}

export interface ReportDefinition {
  reportClassName: string;
  sourceClassName: string;
  sourceTable: string;
  fields: ReportFieldDefinition[];
  where?: WhereClause;
  having?: WhereClause;
  refresh?: ReportRefreshConfig;
}

export interface ReportRefreshOptions {
  db?: import('@happyvertical/sql').DatabaseInterface;
  mode?: ReportRefreshMode;
  adapterType?: SqlAdapterType;
  trigger?: ReportRefreshTrigger;
  tenantId?: string | null;
  tenantIds?: string[];
  lock?: boolean;
  lockTtlMs?: number;
  trackRuns?: boolean;
  scheduleId?: string;
  changedRows?: Record<string, unknown>[];
}

export interface ReportRefreshResult {
  rowCount: number;
  refreshedAt: Date;
  mode: ReportRefreshMode;
  tenantId?: string | null;
  runId?: string;
  changedGroupCount?: number;
  skipped?: boolean;
  tenantResults?: ReportRefreshResult[];
}
