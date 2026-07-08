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
  externalIds?: Record<string, string> | string;
  status?: TenantIntegrationStatus;
  lastCheckedAt?: Date | null;
  lastCheckSummary?: TenantIntegrationCheckSummary[] | string;
  lastError?: string | null;
}

function parseExternalIds(raw: unknown): Record<string, string> {
  if (!raw) return {};

  if (typeof raw === 'object' && !Array.isArray(raw)) {
    return Object.fromEntries(
      Object.entries(raw).filter(([, value]) => typeof value === 'string'),
    ) as Record<string, string>;
  }

  if (typeof raw !== 'string') {
    return {};
  }

  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }

    return Object.fromEntries(
      Object.entries(parsed).filter(([, value]) => typeof value === 'string'),
    ) as Record<string, string>;
  } catch {
    return {};
  }
}

function stringifyExternalIds(externalIds: Record<string, string>): string {
  for (const [key, value] of Object.entries(
    externalIds as Record<string, unknown>,
  )) {
    if (typeof value !== 'string') {
      throw new TypeError(
        `TenantIntegration external id '${key}' must be a string`,
      );
    }
  }

  return JSON.stringify(externalIds);
}

function parseCheckSummary(raw: unknown): TenantIntegrationCheckSummary[] {
  if (!raw) return [];

  if (Array.isArray(raw)) {
    return normalizeCheckSummary(raw);
  }

  if (typeof raw !== 'string') {
    return [];
  }

  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? normalizeCheckSummary(parsed) : [];
  } catch {
    return [];
  }
}

function normalizeCheckSummary(
  raw: unknown[],
): TenantIntegrationCheckSummary[] {
  return raw
    .filter(
      (entry): entry is Record<string, unknown> =>
        !!entry && typeof entry === 'object' && !Array.isArray(entry),
    )
    .map((entry) => ({
      name: typeof entry.name === 'string' ? entry.name : '',
      ok: entry.ok === true,
      ...(typeof entry.message === 'string' ? { message: entry.message } : {}),
    }))
    .filter((entry) => entry.name.length > 0);
}

function stringifyCheckSummary(
  summary: TenantIntegrationCheckSummary[],
): string {
  return JSON.stringify(summary);
}

// TenantIntegration rows are always tenant-owned provider state; system-wide
// provider defaults belong in app config or a secret store, not this table.
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
  externalIds = '{}';

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
  lastCheckSummary = '[]';

  /**
   * Most recent error message when `status === 'failed'`, or null otherwise.
   */
  lastError: string | null = null;

  constructor(options: TenantIntegrationOptions = {}) {
    super(options);
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.provider !== undefined) this.provider = options.provider;
    if (options.externalIds !== undefined) {
      this.setExternalIds(options.externalIds);
    }
    if (options.status !== undefined) this.status = options.status;
    if (options.lastCheckedAt !== undefined)
      this.lastCheckedAt = options.lastCheckedAt;
    if (options.lastCheckSummary !== undefined) {
      this.setLastCheckSummary(options.lastCheckSummary);
    }
    if (options.lastError !== undefined) this.lastError = options.lastError;
  }

  public override async initialize(): Promise<this> {
    await super.initialize();
    this.normalizeJsonFields();
    return this;
  }

  private normalizeJsonFields(): void {
    const fields = this as unknown as {
      externalIds: unknown;
      lastCheckSummary: unknown;
    };

    if (fields.externalIds == null) {
      this.externalIds = '{}';
    } else if (typeof fields.externalIds !== 'string') {
      this.setExternalIds(fields.externalIds as Record<string, string>);
    }

    if (fields.lastCheckSummary == null) {
      this.lastCheckSummary = '[]';
    } else if (typeof fields.lastCheckSummary !== 'string') {
      this.setLastCheckSummary(
        fields.lastCheckSummary as TenantIntegrationCheckSummary[],
      );
    }
  }

  getExternalIds(): Record<string, string> {
    return parseExternalIds(this.externalIds);
  }

  setExternalIds(externalIds: Record<string, string> | string): void {
    this.externalIds =
      typeof externalIds === 'string'
        ? externalIds
        : stringifyExternalIds(externalIds);
  }

  getExternalId(key: string): string | undefined {
    const value = this.getExternalIds()[key];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  }

  setExternalId(key: string, value: string | undefined): void {
    const externalIds = this.getExternalIds();
    if (value === undefined) {
      delete externalIds[key];
    } else {
      externalIds[key] = value;
    }

    this.setExternalIds(externalIds);
  }

  getLastCheckSummary(): TenantIntegrationCheckSummary[] {
    return parseCheckSummary(this.lastCheckSummary);
  }

  setLastCheckSummary(summary: TenantIntegrationCheckSummary[] | string): void {
    this.lastCheckSummary =
      typeof summary === 'string' ? summary : stringifyCheckSummary(summary);
  }

  recordDoctorRun(outcome: {
    status: TenantIntegrationStatus;
    summary: TenantIntegrationCheckSummary[];
    error?: string | null;
  }): void {
    this.status = outcome.status;
    this.setLastCheckSummary(outcome.summary);
    this.lastCheckedAt = new Date();
    this.lastError = outcome.error ?? null;
  }
}
