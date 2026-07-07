/**
 * TenantIntegration model - per-tenant external integration provisioning state.
 *
 * One row per (tenantId, provider) tuple. Stores provider identifiers and
 * health/provisioning metadata only; callers must keep secrets in a dedicated
 * secret store such as @happyvertical/smrt-secrets.
 *
 * @packageDocumentation
 */

import {
  SmrtObject,
  type SmrtObjectOptions,
  smrt,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';

/**
 * Built-in provider names. The string type is intentionally open so apps can
 * add providers without a model migration.
 */
export type TenantIntegrationProvider =
  | 'aws'
  | 'bifrost'
  | 'glitchtip'
  | 'imago'
  | 'matomo'
  | (string & {});

/**
 * Provisioning and health states for a tenant integration.
 *
 * - `unprovisioned`: no external resources have been created yet.
 * - `provisioning`: provisioning is currently queued or running.
 * - `active`: external resources exist and the latest health check passed.
 * - `drifted`: local bookkeeping disagrees with provider state.
 * - `failed`: the latest provisioning attempt or health check failed.
 */
export type TenantIntegrationStatus =
  | 'unprovisioned'
  | 'provisioning'
  | 'active'
  | 'drifted'
  | 'failed';

export interface TenantIntegrationCheckSummary {
  name: string;
  ok: boolean;
  message?: string;
}

export interface TenantIntegrationOptions extends SmrtObjectOptions {
  tenantId?: string;
  provider?: TenantIntegrationProvider;
  externalIds?: Record<string, unknown>;
  status?: TenantIntegrationStatus;
  lastCheckedAt?: Date | null;
  lastCheckSummary?: TenantIntegrationCheckSummary[];
  lastError?: string | null;
}

@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'tenant_integrations',
  conflictColumns: ['tenant_id', 'provider'],
  api: { include: ['list', 'get'] },
  mcp: { include: ['list', 'get'] },
  cli: true,
})
export class TenantIntegration extends SmrtObject {
  /**
   * Tenant this integration belongs to. Combined with `provider`, this is the
   * natural key for the row.
   */
  @tenantId()
  tenantId: string = '';

  /**
   * Provider identifier, such as `aws`, `matomo`, `glitchtip`, or an
   * app-defined provider string.
   */
  provider: TenantIntegrationProvider = 'aws';

  /**
   * Provider-side identifiers. Shape depends on the provider. This must not
   * contain provider credentials or secret material.
   */
  externalIds: Record<string, unknown> = {};

  /**
   * Current provisioning/health status.
   */
  status: TenantIntegrationStatus = 'unprovisioned';

  /**
   * UTC timestamp of the most recent doctor/provisioning check.
   */
  lastCheckedAt: Date | null = null;

  /**
   * Per-check pass/fail summary from the most recent doctor run.
   */
  lastCheckSummary: TenantIntegrationCheckSummary[] = [];

  /**
   * Most recent error message when `status === 'failed'`, or null otherwise.
   */
  lastError: string | null = null;

  constructor(options: TenantIntegrationOptions = {}) {
    super(options);
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.provider !== undefined) this.provider = options.provider;
    if (options.externalIds !== undefined)
      this.externalIds = options.externalIds;
    if (options.status !== undefined) this.status = options.status;
    if (options.lastCheckedAt !== undefined)
      this.lastCheckedAt = options.lastCheckedAt;
    if (options.lastCheckSummary !== undefined)
      this.lastCheckSummary = options.lastCheckSummary;
    if (options.lastError !== undefined) this.lastError = options.lastError;
  }

  getExternalId(key: string): string | undefined {
    const value = this.externalIds[key];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  }

  setExternalId(key: string, value: string | undefined): void {
    if (value === undefined) {
      const { [key]: _, ...rest } = this.externalIds;
      this.externalIds = rest;
    } else {
      this.externalIds = { ...this.externalIds, [key]: value };
    }
  }

  recordDoctorRun(outcome: {
    status: TenantIntegrationStatus;
    summary: TenantIntegrationCheckSummary[];
    error?: string | null;
  }): void {
    this.status = outcome.status;
    this.lastCheckSummary = outcome.summary;
    this.lastCheckedAt = new Date();
    this.lastError = outcome.error ?? null;
  }

  toJSON(): Record<string, unknown> {
    const base = super.toJSON();
    return {
      ...base,
      tenantId: this.tenantId,
      provider: this.provider,
      externalIds: this.externalIds,
      status: this.status,
      lastCheckedAt: this.lastCheckedAt,
      lastCheckSummary: this.lastCheckSummary,
      lastError: this.lastError,
    };
  }
}
