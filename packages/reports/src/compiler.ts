import { ObjectRegistry, type SmrtObject } from '@happyvertical/smrt-core';
import { toSnakeCase } from '@happyvertical/smrt-core/utils';
import type {
  AggregateExpression,
  SqlAdapterType,
  WhereClause,
} from '@happyvertical/sql';
import { getRuntimeReportOptions } from './decorators.js';
import {
  columnTypeReader,
  compareAsText,
  fieldColumn,
  fieldPolicy,
  tenantColumn,
} from './registry-columns.js';
import type {
  AggregateSelectExpr,
  AggregateSpec,
  ReportDefinition,
  ReportFieldDefinition,
  ReportFieldMetadata,
  ReportJoinDefinition,
  ReportOperand,
  ReportOptions,
  ReportRelatedFieldPolicy,
  ReportSource,
} from './types.js';

/** The report source's alias in a query that joins other tables. */
export const REPORT_SOURCE_ALIAS = 'src';

/** Lower-case, so snake-casing a column reference leaves the alias alone. */
const JOIN_ALIAS = /^[a-z][a-z0-9_]*$/;

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

async function resolveJoins(
  reportName: string,
  sourceName: string,
  joins: ReportOptions['joins'],
): Promise<ReportJoinDefinition[]> {
  const resolved: ReportJoinDefinition[] = [];
  if (!joins) return resolved;
  const sourceTenant = await tenantColumn(sourceName);
  const columnType = columnTypeReader();

  for (const [alias, join] of Object.entries(joins)) {
    if (
      !JOIN_ALIAS.test(alias) ||
      alias === REPORT_SOURCE_ALIAS ||
      alias.length > 32
    ) {
      throw new Error(
        `${reportName} join alias '${alias}' must be lower-case letters, digits and underscores, start with a letter, and not be '${REPORT_SOURCE_ALIAS}'`,
      );
    }
    if (!join?.source || typeof join.on !== 'string') {
      throw new Error(
        `${reportName} join '${alias}' needs a source and an on field`,
      );
    }
    if (
      join.type !== undefined &&
      join.type !== 'inner' &&
      join.type !== 'left'
    ) {
      throw new Error(
        `${reportName} join '${alias}' type must be 'inner' or 'left'`,
      );
    }
    const className = sourceClassName(join.source);
    const table = resolveTableName(className);
    const onColumn = await fieldColumn(sourceName, join.on);
    if (!onColumn) {
      throw new Error(
        `${reportName} join '${alias}': ${sourceName} has no field '${join.on}'`,
      );
    }
    const to = join.to ?? 'id';
    const targetColumn = to === 'id' ? 'id' : await fieldColumn(className, to);
    if (!targetColumn) {
      throw new Error(
        `${reportName} join '${alias}': ${className} has no field '${to}'`,
      );
    }

    // A tenant-scoped related model is matched within the source row's tenant,
    // so ids that collide across tenants never join. A source with no tenant
    // cannot say which tenant's related rows to match.
    const joinedTenant = await tenantColumn(className);
    if (joinedTenant && !sourceTenant) {
      throw new Error(
        `${reportName} join '${alias}': ${className} is tenant-scoped but ${sourceName} has no tenant field to match it with`,
      );
    }
    const softDelete = await fieldColumn(className, 'deletedAt');
    // Keys of different schema types (a text reference to a uuid id) compare
    // as text: Postgres has no text = uuid operator, and a text value that is
    // not a uuid then matches nothing instead of failing the rebuild.
    const keyAsText = compareAsText(
      columnType,
      { className: sourceName, column: onColumn },
      { className, column: targetColumn },
    );
    const tenantAsText =
      joinedTenant && sourceTenant
        ? compareAsText(
            columnType,
            { className: sourceName, column: sourceTenant },
            { className, column: joinedTenant },
          )
        : false;
    resolved.push({
      alias,
      className,
      table,
      type: join.type ?? 'left',
      sourceColumn: onColumn,
      targetColumn,
      ...(keyAsText ? { keyAsText: true } : {}),
      ...(joinedTenant && sourceTenant
        ? {
            tenantColumns: {
              source: sourceTenant,
              joined: joinedTenant,
              ...(tenantAsText ? { asText: true } : {}),
            },
          }
        : {}),
      ...(softDelete ? { softDeleteColumn: softDelete } : {}),
    });
  }
  return resolved;
}

function operandColumns(node: unknown, found: string[] = []): string[] {
  if (!node || typeof node !== 'object') return found;
  const record = node as Record<string, unknown>;
  if (typeof record.col === 'string') found.push(record.col);
  for (const key of ['left', 'right', 'later', 'earlier', 'operand']) {
    operandColumns(record[key], found);
  }
  if (Array.isArray(record.operands)) {
    for (const operand of record.operands) operandColumns(operand, found);
  }
  return found;
}

/** Every model field a report field reads, as written (`status`, `wo.title`). */
function referencedColumns(
  fieldName: string,
  report: ReportFieldMetadata,
): string[] {
  if (report.kind === 'group') {
    return report.expr
      ? operandColumns(report.expr)
      : [report.sourceColumn ?? fieldName];
  }
  if (report.kind === 'bucket') return [report.sourceColumn];
  return [
    ...(report.column ? [report.column] : []),
    ...operandColumns(report.expr),
    ...operandColumns(report.filter),
  ];
}

async function relatedPolicies(
  reportName: string,
  fieldName: string,
  report: ReportFieldMetadata,
  joins: ReportJoinDefinition[],
): Promise<ReportRelatedFieldPolicy[]> {
  const policies: ReportRelatedFieldPolicy[] = [];
  for (const ref of referencedColumns(fieldName, report)) {
    if (!ref.includes('.')) continue;
    const parts = ref.split('.');
    const join =
      parts.length === 2 ? joins.find((j) => j.alias === parts[0]) : undefined;
    if (!join) {
      throw new Error(
        `${reportName}.${fieldName} reads '${ref}', which is not a column of a declared join`,
      );
    }
    const related = parts[1];
    const registryFields = await ObjectRegistry.getAllFields(join.className);
    const key = toSnakeCase(related);
    const found = [...registryFields.entries()].find(
      ([name]) => name === related || toSnakeCase(name) === key,
    );
    if (!found && key !== 'id') {
      throw new Error(
        `${reportName}.${fieldName} reads '${ref}', but ${join.className} has no field '${related}'`,
      );
    }
    const policy = fieldPolicy(found?.[1] as Parameters<typeof fieldPolicy>[0]);
    policies.push({
      alias: join.alias,
      fieldName: related,
      sensitive: policy.sensitive,
      ...(policy.readPermission
        ? { readPermission: policy.readPermission }
        : {}),
    });
  }
  return policies;
}

export async function buildReportDefinition(
  reportCtor: new (...args: any[]) => SmrtObject,
): Promise<ReportDefinition> {
  const options = getReportOptions(reportCtor);
  const reportClassName = getRegisteredClassName(reportCtor);
  const sourceName = sourceClassName(options.source);
  const sourceTable = resolveTableName(sourceName);
  const fields = await ObjectRegistry.getAllFields(reportClassName);
  const joins = await resolveJoins(reportCtor.name, sourceName, options.joins);
  if (joins.length > 0 && options.refresh?.mode === 'incremental') {
    throw new Error(
      `${reportCtor.name} joins ${joins.map((join) => join.className).join(', ')} and cannot refresh incrementally: ` +
        `a change to a joined row does not move the source watermark. Use mode: 'rebuild'.`,
    );
  }

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

    const related = await relatedPolicies(
      reportCtor.name,
      fieldName,
      report,
      joins,
    );
    reportFields.push({
      fieldName,
      columnName: toSnakeCase(fieldName),
      type: field.type,
      report,
      ...(related.length > 0 ? { related } : {}),
    });
  }

  return {
    reportClassName,
    sourceClassName: sourceName,
    sourceTable,
    ...(joins.length > 0 ? { joins } : {}),
    fields: reportFields,
    where: options.where,
    having: options.having,
    refresh: options.refresh,
  };
}

/**
 * A model field as a query column. Without joins it is the bare column, as
 * before. With joins every column is qualified: a bare field by the source
 * alias, `alias.field` by its join, so a column the source and a joined table
 * share (`tenant_id`, `deleted_at`) is never ambiguous.
 */
function columnFor(
  ref: string,
  definition: Pick<ReportDefinition, 'joins'>,
): string {
  const joins = definition.joins ?? [];
  if (!ref.includes('.')) {
    const column = toSnakeCase(ref);
    return joins.length > 0 ? `${REPORT_SOURCE_ALIAS}.${column}` : column;
  }
  const parts = ref.split('.');
  if (parts.length !== 2 || !joins.some((join) => join.alias === parts[0])) {
    throw new Error(
      `Report column '${ref}' is not a column of a declared join`,
    );
  }
  return `${parts[0]}.${toSnakeCase(parts[1])}`;
}

function mapOperand(
  node: ReportOperand,
  mapColumn: (ref: string) => string,
): ReportOperand {
  if (!node || typeof node !== 'object') return node;
  const record = node as Record<string, unknown>;
  if (typeof record.col === 'string') return { col: mapColumn(record.col) };
  const out: Record<string, unknown> = { ...record };
  for (const key of ['left', 'right', 'later', 'earlier', 'operand']) {
    if (record[key] !== undefined) {
      out[key] = mapOperand(record[key] as ReportOperand, mapColumn);
    }
  }
  if (Array.isArray(record.operands)) {
    out.operands = record.operands.map((operand) =>
      mapOperand(operand as ReportOperand, mapColumn),
    );
  }
  return out as ReportOperand;
}

function sourceColumn(
  field: ReportFieldDefinition,
  definition: Pick<ReportDefinition, 'joins'>,
): string {
  const report = field.report;
  if (!report) {
    throw new Error(`Report field ${field.fieldName} is missing metadata`);
  }
  if (report.kind === 'group') {
    return columnFor(report.sourceColumn ?? field.fieldName, definition);
  }
  if (report.kind === 'bucket') {
    return columnFor(report.sourceColumn, definition);
  }
  if (report.kind === 'aggregate') {
    if (!report.column) return '';
    return columnFor(report.column, definition);
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

/** The join condition: the key, the tenant match, and no soft-deleted related row. */
function joinCondition(
  join: ReportJoinDefinition,
  adapterType: SqlAdapterType | undefined,
): AggregateExpression {
  // SQLite stores a uuid as TEXT, so its keys already compare; a cast there
  // would only stop the joined id's index serving the join.
  const castable = adapterType !== 'sqlite';
  const equal = (
    left: string,
    right: string,
    asText: boolean | undefined,
  ): AggregateExpression =>
    asText && castable
      ? {
          op: 'eq',
          left: { op: 'asText', operand: { col: left } },
          right: { op: 'asText', operand: { col: right } },
        }
      : { op: 'eq', left: { col: left }, right: { col: right } };
  const conditions: AggregateExpression[] = [
    equal(
      `${REPORT_SOURCE_ALIAS}.${join.sourceColumn}`,
      `${join.alias}.${join.targetColumn}`,
      join.keyAsText,
    ),
  ];
  if (join.tenantColumns) {
    conditions.push(
      equal(
        `${REPORT_SOURCE_ALIAS}.${join.tenantColumns.source}`,
        `${join.alias}.${join.tenantColumns.joined}`,
        join.tenantColumns.asText,
      ),
    );
  }
  if (join.softDeleteColumn) {
    conditions.push({
      op: 'isNull',
      operand: { col: `${join.alias}.${join.softDeleteColumn}` },
    });
  }
  return conditions.length === 1
    ? conditions[0]
    : { op: 'and', operands: conditions };
}

/**
 * Compile a report definition to an aggregate spec. `adapterType` is the
 * database the spec will run on: a join whose key columns have different
 * schema types (a text reference to a uuid id) compares them as text, except
 * on SQLite, where both are already TEXT. Omitted, the join casts.
 */
export function compileReportDefinition(
  definition: ReportDefinition,
  adapterType?: SqlAdapterType,
): AggregateSpec {
  const select: AggregateSelectExpr[] = [];
  const groupBy: string[] = [];
  const reportFieldToColumn = new Map<string, string>();
  const mapColumn = (ref: string) => columnFor(ref, definition);

  for (const field of definition.fields) {
    const outputColumn = field.columnName ?? toSnakeCase(field.fieldName);
    reportFieldToColumn.set(field.fieldName, outputColumn);
    reportFieldToColumn.set(outputColumn, outputColumn);

    const report = field.report;
    if (!report) continue;

    if (report.kind === 'group') {
      select.push(
        report.expr
          ? { expr: mapOperand(report.expr, mapColumn), as: outputColumn }
          : { column: sourceColumn(field, definition), as: outputColumn },
      );
      groupBy.push(outputColumn);
      continue;
    }

    if (report.kind === 'bucket') {
      select.push({
        bucket: report.unit,
        column: sourceColumn(field, definition),
        as: outputColumn,
      });
      groupBy.push(outputColumn);
      continue;
    }

    select.push({
      fn: report.fn,
      column: report.column ? sourceColumn(field, definition) : undefined,
      ...(report.expr ? { expr: mapOperand(report.expr, mapColumn) } : {}),
      ...(report.filter
        ? { filter: mapOperand(report.filter, mapColumn) }
        : {}),
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

  const joins = definition.joins ?? [];
  return {
    from: definition.sourceTable,
    ...(joins.length > 0
      ? {
          fromAlias: REPORT_SOURCE_ALIAS,
          joins: joins.map((join) => ({
            table: join.table,
            alias: join.alias,
            type: join.type,
            on: joinCondition(join, adapterType),
          })),
        }
      : {}),
    select,
    groupBy,
    where: normalizeWhere(definition.where, mapColumn),
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
