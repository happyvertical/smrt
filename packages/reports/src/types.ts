import type { SmrtObject } from '@happyvertical/smrt-core';
import type {
  AggregateBuildResult,
  AggregateFunction,
  AggregateOperand,
  AggregateSelectExpr,
  AggregateSpec,
  AggregateTimeBucketUnit,
  SqlAdapterType,
  WhereClause,
} from '@happyvertical/sql';

export type ReportTimeBucketUnit = AggregateTimeBucketUnit;
export type ReportAggregateFn = AggregateFunction;
export type { AggregateBuildResult, AggregateSelectExpr, AggregateSpec };

/**
 * A row expression written as plain data: `{ col }`, `{ value }` or an
 * operator node (`add`, `sub`, `mul`, `div`, `secondsBetween`, `eq`..`gte`,
 * `and`, `or`, `not`, `isNull`, `isNotNull`, `coalesce`). It is a literal, not a
 * builder call, because the manifest scanner reads decorator arguments
 * statically. A `col` names a model field (`claimedAt`), or a field of a joined
 * model qualified by its alias (`wo.estimatedHours`); it is never a SQL column.
 */
export type ReportOperand = AggregateOperand;

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
  /** Static per-tenant schedules, or one global schedule discovering source tenants at execution. */
  tenantFanout?: boolean | 'discover';
}

/** A many-to-one join from the report's source to a related model. */
export interface ReportJoinOptions {
  /** The related model. */
  source: ReportSource;
  /** The source field holding the related row's key. */
  on: string;
  /**
   * The related field `on` points at. Defaults to `id`. It must identify at
   * most one related row per tenant, or the join repeats source rows.
   */
  to?: string;
  /** `left` (default) keeps source rows whose related row is gone. */
  type?: 'inner' | 'left';
}

export interface ReportOptions {
  source: ReportSource;
  /**
   * Related models by alias. Reference a joined field as `alias.field` in
   * `@groupBy`, the aggregate decorators, bucket decorators, row expressions
   * and `where`. The alias is a plain identifier and not `src`.
   */
  joins?: Record<string, ReportJoinOptions>;
  where?: WhereClause;
  having?: WhereClause;
  refresh?: ReportRefreshConfig;
}

export interface ReportGroupFieldMetadata {
  kind: 'group';
  sourceColumn?: string;
  /** Group by a computed value of each row instead of a column. */
  expr?: ReportOperand;
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
  /** Aggregate a computed value of each row in place of `column`. */
  expr?: ReportOperand;
  /** Aggregate only the rows this predicate holds for. */
  filter?: ReportOperand;
  distinct?: boolean;
}

export type ReportFieldMetadata =
  | ReportGroupFieldMetadata
  | ReportBucketFieldMetadata
  | ReportAggregateFieldMetadata;

/** A joined model's field a report field reads, with that field's read policy. */
export interface ReportRelatedFieldPolicy {
  alias: string;
  fieldName: string;
  sensitive: boolean;
  readPermission?: string;
}

export interface ReportFieldDefinition {
  fieldName: string;
  columnName?: string;
  type?: string;
  report?: ReportFieldMetadata;
  /** Joined fields this field reads; the report column inherits their policy. */
  related?: ReportRelatedFieldPolicy[];
}

/** A join resolved against the registry: tables, columns and tenant/soft-delete guards. */
export interface ReportJoinDefinition {
  alias: string;
  className: string;
  table: string;
  type: 'inner' | 'left';
  /** Column on the report source. */
  sourceColumn: string;
  /** Column on the joined table. */
  targetColumn: string;
  /** Tenant columns to equate, when the joined model is tenant-scoped. */
  tenantColumns?: { source: string; joined: string };
  /** Soft-delete column of the joined model; deleted rows never match. */
  softDeleteColumn?: string;
}

export interface ReportDefinition {
  reportClassName: string;
  sourceClassName: string;
  sourceTable: string;
  joins?: ReportJoinDefinition[];
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
