import {
  ObjectRegistry,
  registerCompatibleFieldDecorator,
} from '@happyvertical/smrt-core';
import type {
  ReportAggregateFieldMetadata,
  ReportAggregateFn,
  ReportBucketFieldMetadata,
  ReportFieldMetadata,
  ReportOperand,
  ReportOptions,
  ReportTimeBucketUnit,
} from './types.js';

const reportOptionsByConstructor = new WeakMap<Function, ReportOptions>();

export function report(options: ReportOptions) {
  return <T extends abstract new (...args: any[]) => any>(ctor: T): T => {
    reportOptionsByConstructor.set(ctor, options);
    return ctor;
  };
}

export function getRuntimeReportOptions(
  ctor: Function,
): ReportOptions | undefined {
  return reportOptionsByConstructor.get(ctor);
}

function registerReportField(metadata: ReportFieldMetadata) {
  return ((targetOrValue: any, propertyKeyOrContext: any) => {
    registerCompatibleFieldDecorator(
      targetOrValue,
      propertyKeyOrContext,
      (className, propertyKey, ctor) => {
        const options = {
          __report: metadata,
        };
        ObjectRegistry.registerFieldDecorator(
          className,
          propertyKey,
          options,
          ctor,
        );
      },
    );
  }) as PropertyDecorator;
}

/**
 * Group by a source column (`'status'`), a joined model's column
 * (`'wo.title'`), or a value computed from each row (`{ expr }`).
 */
export function groupBy(
  sourceColumnOrExpr?: string | { expr: ReportOperand },
): PropertyDecorator {
  if (typeof sourceColumnOrExpr === 'object' && sourceColumnOrExpr !== null) {
    return registerReportField({
      kind: 'group',
      expr: sourceColumnOrExpr.expr,
    });
  }
  return registerReportField({
    kind: 'group',
    sourceColumn: sourceColumnOrExpr,
  });
}

function bucket(
  unit: ReportTimeBucketUnit,
  sourceColumn: string,
): PropertyDecorator {
  return registerReportField({
    kind: 'bucket',
    unit,
    sourceColumn,
  } satisfies ReportBucketFieldMetadata);
}

export const minute = (sourceColumn: string) => bucket('minute', sourceColumn);
export const hour = (sourceColumn: string) => bucket('hour', sourceColumn);
export const day = (sourceColumn: string) => bucket('day', sourceColumn);
export const week = (sourceColumn: string) => bucket('week', sourceColumn);
export const month = (sourceColumn: string) => bucket('month', sourceColumn);
export const quarter = (sourceColumn: string) =>
  bucket('quarter', sourceColumn);
export const year = (sourceColumn: string) => bucket('year', sourceColumn);

export interface AggregateMeasureOptions {
  distinct?: boolean;
  /** Aggregate a computed value of each row instead of a column. */
  expr?: ReportOperand;
  /** Aggregate only the rows this predicate holds for (a filtered count or sum). */
  filter?: ReportOperand;
}

export interface AggregateDecoratorOptions extends AggregateMeasureOptions {
  fn: ReportAggregateFn;
  column?: string;
}

export function aggregate(
  options: AggregateDecoratorOptions,
): PropertyDecorator {
  return registerReportField({
    kind: 'aggregate',
    fn: options.fn,
    column: options.column,
    ...(options.expr ? { expr: options.expr } : {}),
    ...(options.filter ? { filter: options.filter } : {}),
    distinct: options.distinct,
  } satisfies ReportAggregateFieldMetadata);
}

function aggregateDecorator(fn: ReportAggregateFn) {
  return (
    columnOrOptions?: string | AggregateMeasureOptions,
    options: AggregateMeasureOptions = {},
  ) => {
    const column =
      typeof columnOrOptions === 'string' ? columnOrOptions : undefined;
    const resolved =
      typeof columnOrOptions === 'object' ? columnOrOptions : options;
    return aggregate({ fn, column, ...resolved });
  };
}

export const sum = aggregateDecorator('sum');
export const avg = aggregateDecorator('avg');
export const min = aggregateDecorator('min');
export const max = aggregateDecorator('max');

export function count(): PropertyDecorator;
export function count(
  column: string,
  options?: AggregateMeasureOptions,
): PropertyDecorator;
export function count(options: AggregateMeasureOptions): PropertyDecorator;
export function count(
  columnOrOptions?: string | AggregateMeasureOptions,
  options: AggregateMeasureOptions = {},
): PropertyDecorator {
  const column =
    typeof columnOrOptions === 'string' ? columnOrOptions : undefined;
  const resolvedOptions =
    typeof columnOrOptions === 'object' ? columnOrOptions : options;
  return aggregate({ fn: 'count', column, ...resolvedOptions });
}
