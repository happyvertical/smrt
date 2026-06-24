import {
  ObjectRegistry,
  registerCompatibleFieldDecorator,
} from '@happyvertical/smrt-core';
import type {
  ReportAggregateFieldMetadata,
  ReportAggregateFn,
  ReportBucketFieldMetadata,
  ReportFieldMetadata,
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
      (className, propertyKey) => {
        ObjectRegistry.registerFieldDecorator(className, propertyKey, {
          __report: metadata,
        });
      },
    );
  }) as PropertyDecorator;
}

export function groupBy(sourceColumn?: string): PropertyDecorator {
  return registerReportField({ kind: 'group', sourceColumn });
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

export interface AggregateDecoratorOptions {
  fn: ReportAggregateFn;
  column?: string;
  distinct?: boolean;
}

export function aggregate(
  options: AggregateDecoratorOptions,
): PropertyDecorator {
  return registerReportField({
    kind: 'aggregate',
    fn: options.fn,
    column: options.column,
    distinct: options.distinct,
  } satisfies ReportAggregateFieldMetadata);
}

function aggregateDecorator(fn: ReportAggregateFn) {
  return (column?: string, options: { distinct?: boolean } = {}) =>
    aggregate({ fn, column, distinct: options.distinct });
}

export const sum = aggregateDecorator('sum');
export const avg = aggregateDecorator('avg');
export const min = aggregateDecorator('min');
export const max = aggregateDecorator('max');

export function count(): PropertyDecorator;
export function count(
  column: string,
  options?: { distinct?: boolean },
): PropertyDecorator;
export function count(options: { distinct?: boolean }): PropertyDecorator;
export function count(
  columnOrOptions?: string | { distinct?: boolean },
  options: { distinct?: boolean } = {},
): PropertyDecorator {
  const column =
    typeof columnOrOptions === 'string' ? columnOrOptions : undefined;
  const resolvedOptions =
    typeof columnOrOptions === 'object' ? columnOrOptions : options;
  return aggregate({
    fn: 'count',
    column,
    distinct: resolvedOptions.distinct,
  });
}
