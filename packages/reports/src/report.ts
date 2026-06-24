import {
  ObjectRegistry,
  SmrtCollection,
  SmrtObject,
  type SmrtObjectOptions,
} from '@happyvertical/smrt-core';
import { getTenantId } from '@happyvertical/smrt-tenancy';
import { buildReportDefinition } from './compiler.js';
import { refreshReport } from './refresh.js';
import type { ReportRefreshOptions, ReportRefreshResult } from './types.js';

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

    const fields = await ObjectRegistry.getAllFields(reportClass);
    const tenantField = [...fields.entries()].find(
      ([fieldName, field]) =>
        fieldName === 'tenantId' || field?._meta?.__tenancy?.isTenantIdField,
    );
    const tenantColumn = tenantField ? 'tenant_id' : null;
    const tenantId = getTenantId() ?? null;
    const result = tenantColumn
      ? await this.db.query(
          `SELECT MAX(refreshed_at) AS refreshed_at FROM ${tableName} WHERE ${tenantColumn} ${tenantId ? '= ?' : 'IS NULL'}`,
          ...(tenantId ? [tenantId] : []),
        )
      : await this.db.query(
          `SELECT MAX(refreshed_at) AS refreshed_at FROM ${tableName}`,
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
