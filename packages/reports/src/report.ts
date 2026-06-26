import {
  ObjectRegistry,
  SmrtCollection,
  SmrtObject,
  type SmrtObjectOptions,
} from '@happyvertical/smrt-core';
import { toSnakeCase } from '@happyvertical/smrt-core/utils';
import { getTenantId } from '@happyvertical/smrt-tenancy';
import { validateColumnName } from '@happyvertical/sql';
import { buildReportDefinition } from './compiler.js';
import { refreshReport } from './refresh.js';
import type { ReportRefreshOptions, ReportRefreshResult } from './types.js';

type RegistryField = {
  columnName?: string;
  _meta?: {
    columnName?: string;
    __tenancy?: { isTenantIdField?: boolean };
  };
};

function registryColumnName(fieldName: string, field?: RegistryField): string {
  return validateColumnName(
    field?.columnName ?? field?._meta?.columnName ?? toSnakeCase(fieldName),
  );
}

function findFieldColumn(
  fields: Map<string, RegistryField>,
  fieldName: string,
): string {
  const direct = fields.get(fieldName);
  if (direct) return registryColumnName(fieldName, direct);
  const requestedColumn = toSnakeCase(fieldName);
  for (const [name, field] of fields.entries()) {
    if (toSnakeCase(name) === requestedColumn) {
      return registryColumnName(name, field);
    }
  }
  return validateColumnName(requestedColumn);
}

function findTenantColumn(
  fields: Map<string, RegistryField>,
  configuredField?: string,
): string | null {
  if (configuredField) {
    return registryColumnName(configuredField, fields.get(configuredField));
  }
  for (const [fieldName, field] of fields.entries()) {
    if (fieldName === 'tenantId' || field?._meta?.__tenancy?.isTenantIdField) {
      return registryColumnName(fieldName, field);
    }
  }
  return null;
}

export class SmrtReport extends SmrtObject {
  static readonly _isReportBase = true as const;

  refreshedAt: Date | null = null;

  constructor(options: SmrtObjectOptions = {}) {
    super(options);
    if (options.refreshedAt !== undefined) {
      this.refreshedAt =
        options.refreshedAt instanceof Date
          ? options.refreshedAt
          : options.refreshedAt
            ? new Date(options.refreshedAt)
            : null;
    }
  }

  isStale(ttlMs?: number): boolean {
    if (!this.refreshedAt) return true;
    if (ttlMs === undefined) return false;
    return Date.now() - this.refreshedAt.getTime() > ttlMs;
  }

  async refresh(
    options: Omit<ReportRefreshOptions, 'db'> = {},
  ): Promise<ReportRefreshResult> {
    const result = await refreshReport(this.constructor as typeof SmrtReport, {
      ...options,
      db: this.db,
    });
    this.refreshedAt = result.refreshedAt;
    return result;
  }
}

export class SmrtReportCollection<
  ModelType extends SmrtReport,
> extends SmrtCollection<ModelType> {
  private async refreshIfStale(): Promise<void> {
    const reportCtor = this.getItemClass();
    const definition = await buildReportDefinition(reportCtor);
    const refresh = definition.refresh;
    if (!refresh?.ttl || refresh.manual) return;

    const registered =
      ObjectRegistry.getClassByConstructor(reportCtor) ??
      ObjectRegistry.getClass(reportCtor.name);
    const reportClass =
      registered?.qualifiedName ?? registered?.name ?? reportCtor.name;
    const tableName = ObjectRegistry.getTableName(reportClass);
    if (!tableName) return;

    const fields = (await ObjectRegistry.getAllFields(reportClass)) as Map<
      string,
      RegistryField
    >;
    const safeTableName = validateColumnName(tableName);
    const refreshedAtColumn = findFieldColumn(fields, 'refreshedAt');
    const tenantColumn = findTenantColumn(
      fields,
      registered?.tenantScopedConfig?.field,
    );
    const tenantId = getTenantId() ?? null;
    const result = tenantColumn
      ? await this.db.query(
          `SELECT MAX(${refreshedAtColumn}) AS refreshed_at FROM ${safeTableName} WHERE ${tenantColumn} ${tenantId ? '= ?' : 'IS NULL'}`,
          ...(tenantId ? [tenantId] : []),
        )
      : await this.db.query(
          `SELECT MAX(${refreshedAtColumn}) AS refreshed_at FROM ${safeTableName}`,
        );
    const refreshedAt = result.rows[0]?.refreshed_at
      ? new Date(result.rows[0].refreshed_at as string)
      : null;
    const stale =
      !refreshedAt || Date.now() - refreshedAt.getTime() > refresh.ttl;
    if (!stale) return;

    await refreshReport(reportCtor, {
      db: this.db,
      mode: refresh.mode ?? 'rebuild',
      trigger: 'ttl',
      tenantId,
    });
  }

  async refresh(
    options: Omit<ReportRefreshOptions, 'db'> = {},
  ): Promise<ReportRefreshResult> {
    return refreshReport(this.getItemClass(), {
      ...options,
      db: this.db,
    });
  }

  override async list(
    options: Parameters<SmrtCollection<ModelType>['list']>[0] = {},
  ): Promise<ModelType[]> {
    await this.refreshIfStale();
    return super.list(options);
  }

  override async get(
    filter: Parameters<SmrtCollection<ModelType>['get']>[0],
    options: Parameters<SmrtCollection<ModelType>['get']>[1] = {},
  ): Promise<ModelType | null> {
    await this.refreshIfStale();
    return super.get(filter, options);
  }
}
