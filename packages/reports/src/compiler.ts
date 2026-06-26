import { ObjectRegistry, type SmrtObject } from '@happyvertical/smrt-core';
import { toSnakeCase } from '@happyvertical/smrt-core/utils';
import type { WhereClause } from '@happyvertical/sql';
import { getRuntimeReportOptions } from './decorators.js';
import type {
  AggregateSelectExpr,
  AggregateSpec,
  ReportDefinition,
  ReportFieldDefinition,
  ReportFieldMetadata,
  ReportOptions,
  ReportSource,
} from './types.js';

const REPORT_BASE_FIELDS = new Set([
  'id',
  'slug',
  'context',
  'created_at',
  'updated_at',
  'createdAt',
  'updatedAt',
  'refreshedAt',
]);

function isConstructor(
  value: ReportSource,
): value is new (
  ...args: any[]
) => SmrtObject {
  return typeof value === 'function';
}

function sourceClassName(source: ReportSource): string {
  if (typeof source === 'string') return source;
  return source.name;
}

function reportOptionsFromRegistry(
  reportCtor: new (...args: any[]) => SmrtObject,
): ReportOptions | undefined {
  const registered =
    ObjectRegistry.getClassByConstructor(reportCtor) ??
    ObjectRegistry.getClass(reportCtor.name);
  return (registered?.config as { report?: ReportOptions } | undefined)?.report;
}

function getReportOptions(
  reportCtor: new (...args: any[]) => SmrtObject,
): ReportOptions {
  const options =
    getRuntimeReportOptions(reportCtor) ??
    reportOptionsFromRegistry(reportCtor);
  if (!options?.source) {
    throw new Error(
      `${reportCtor.name} is missing @report({ source }) metadata. ` +
        `Decorate the report class with @report({ source: SourceClass }).`,
    );
  }
  return options;
}

function getRegisteredClassName(
  ctor: new (...args: any[]) => SmrtObject,
): string {
  const registered =
    ObjectRegistry.getClassByConstructor(ctor) ??
    ObjectRegistry.getClass(ctor.name);
  return registered?.qualifiedName ?? registered?.name ?? ctor.name;
}

function resolveTableName(className: string): string {
  const tableName = ObjectRegistry.getTableName(className);
  if (!tableName) {
    throw new Error(
      `No SMRT table registered for ${className}. ` +
        `Ensure the class is decorated with @smrt() and its manifest is loaded.`,
    );
  }
  return tableName;
}

function parseWhereKey(key: string): { field: string; suffix: string } {
  const trimmed = key.trim();
  const operators = [
    ' is not null',
    ' is null',
    ' not in',
    ' like',
    ' in',
    ' !=',
    ' >=',
    ' <=',
    ' >',
    ' <',
    ' =',
  ];
  const lower = trimmed.toLowerCase();
  for (const operator of operators) {
    if (lower.endsWith(operator)) {
      return {
        field: trimmed.slice(0, -operator.length).trim(),
        suffix: operator,
      };
    }
  }
  return { field: trimmed, suffix: '' };
}

function normalizeConditionKey(
  key: string,
  mapField: (field: string) => string,
): string {
  const { field, suffix } = parseWhereKey(key);
  const mapped = mapField(field);
  return suffix ? `${mapped}${suffix}` : mapped;
}

function normalizeWhere(
  where: WhereClause | undefined,
  mapField: (field: string) => string,
): WhereClause | undefined {
  if (!where) return undefined;

  if (Array.isArray(where)) {
    return where.map((andGroup) =>
      andGroup.map((condition: Record<string, any>) =>
        Object.fromEntries(
          Object.entries(condition).map(([key, value]) => [
            normalizeConditionKey(key, mapField),
            value,
          ]),
        ),
      ),
    );
  }

  return Object.fromEntries(
    Object.entries(where).map(([key, value]) => [
      normalizeConditionKey(key, mapField),
      value,
    ]),
  );
}

function readReportMetadata(field: any): ReportFieldMetadata | undefined {
  return field?._meta?.__report ?? field?.__report;
}

function isReportSystemField(fieldName: string, field: any): boolean {
  return (
    REPORT_BASE_FIELDS.has(fieldName) ||
    field?._meta?.__smrtSystemField ||
    field?._meta?.__tenancy?.isTenantIdField
  );
}

export async function buildReportDefinition(
  reportCtor: new (...args: any[]) => SmrtObject,
): Promise<ReportDefinition> {
  const options = getReportOptions(reportCtor);
  const reportClassName = getRegisteredClassName(reportCtor);
  const sourceName = sourceClassName(options.source);
  const sourceTable = resolveTableName(sourceName);
  const fields = await ObjectRegistry.getAllFields(reportClassName);

  const reportFields: ReportFieldDefinition[] = [];
  for (const [fieldName, field] of fields.entries()) {
    const report = readReportMetadata(field);
    if (!report) {
      if (!isReportSystemField(fieldName, field) && !field?.transient) {
        throw new Error(
          `Report field ${reportCtor.name}.${fieldName} is neither a grouping key nor an aggregate. ` +
            `Add @groupBy(), a time-bucket decorator, or an aggregate decorator.`,
        );
      }
      continue;
    }

    reportFields.push({
      fieldName,
      columnName: toSnakeCase(fieldName),
      type: field.type,
      report,
    });
  }

  return {
    reportClassName,
    sourceClassName: sourceName,
    sourceTable,
    fields: reportFields,
    where: options.where,
    having: options.having,
    refresh: options.refresh,
  };
}

function sourceColumn(field: ReportFieldDefinition): string {
  const report = field.report;
  if (!report) {
    throw new Error(`Report field ${field.fieldName} is missing metadata`);
  }
  if (report.kind === 'group') {
    return toSnakeCase(report.sourceColumn ?? field.fieldName);
  }
  if (report.kind === 'bucket') {
    return toSnakeCase(report.sourceColumn);
  }
  if (report.kind === 'aggregate') {
    if (!report.column) return '';
    return toSnakeCase(report.column);
  }
  return '';
}

export function getReportGroupingColumns(
  definition: Pick<ReportDefinition, 'fields'>,
): string[] {
  const columns = definition.fields
    .filter(
      (field) =>
        field.report?.kind === 'group' || field.report?.kind === 'bucket',
    )
    .map((field) => field.columnName ?? toSnakeCase(field.fieldName));
  return columns.length > 0 ? columns : ['id'];
}

export function compileReportDefinition(
  definition: ReportDefinition,
): AggregateSpec {
  const select: AggregateSelectExpr[] = [];
  const groupBy: string[] = [];
  const reportFieldToColumn = new Map<string, string>();

  for (const field of definition.fields) {
    const outputColumn = field.columnName ?? toSnakeCase(field.fieldName);
    reportFieldToColumn.set(field.fieldName, outputColumn);
    reportFieldToColumn.set(outputColumn, outputColumn);

    const report = field.report;
    if (!report) continue;

    if (report.kind === 'group') {
      select.push({
        column: sourceColumn(field),
        as: outputColumn,
      });
      groupBy.push(outputColumn);
      continue;
    }

    if (report.kind === 'bucket') {
      select.push({
        bucket: report.unit,
        column: sourceColumn(field),
        as: outputColumn,
      });
      groupBy.push(outputColumn);
      continue;
    }

    select.push({
      fn: report.fn,
      column: report.column ? sourceColumn(field) : undefined,
      as: outputColumn,
      distinct: report.distinct,
    });
  }

  if (select.length === 0) {
    throw new Error(
      `${definition.reportClassName} has no report fields. ` +
        `Add @groupBy(), a time-bucket decorator, or an aggregate decorator.`,
    );
  }

  return {
    from: definition.sourceTable,
    select,
    groupBy,
    where: normalizeWhere(definition.where, (field) => toSnakeCase(field)),
    having: normalizeWhere(
      definition.having,
      (field) => reportFieldToColumn.get(field) ?? toSnakeCase(field),
    ),
  };
}

export async function compileReportSpec(
  reportCtor: new (...args: any[]) => SmrtObject,
): Promise<AggregateSpec> {
  return compileReportDefinition(await buildReportDefinition(reportCtor));
}
