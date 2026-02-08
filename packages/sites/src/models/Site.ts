/**
 * Site model - Represents a deployable website within a multi-tenant network
 *
 * Manages site lifecycle from draft through active/suspended/archived states,
 * with infrastructure provisioning tracking and portal configuration.
 *
 * Tenancy: Sites are tenant-scoped with required mode — every site
 * belongs to exactly one tenant.
 */

import { SmrtObject, smrt } from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import type {
  ProvisioningStatus,
  SiteOptions,
  SitePortalConfig,
  SiteStatus,
  SiteTier,
} from '../types';

@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'sites',
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
  mcp: { include: ['list', 'get', 'create', 'update'] },
  cli: true,
  conflictColumns: ['tenant_id', 'domain'],
})
export class Site extends SmrtObject {
  @tenantId()
  tenantId: string = '';

  /** Display name, e.g. "Bentley Alberta" */
  name: string = '';

  /** Primary domain, e.g. "bentleyalberta.com" */
  domain: string = '';

  /** Lifecycle status */
  status: SiteStatus = 'draft';

  /** Pricing/feature tier */
  tier: SiteTier = 'free';

  /** Site-specific database connection URL */
  databaseUrl: string = '';

  /** Database type: sqlite, postgres, libsql */
  databaseType: string = '';

  /** Theme, branding, navigation settings (JSON) */
  portalConfig: string = '';

  /** Git repository URL */
  repositoryUrl: string = '';

  /** Starter template name */
  templateName: string = '';

  /** Infrastructure provisioning status */
  provisioningStatus: ProvisioningStatus | '' = '';

  /** When provisioning completed */
  provisionedAt: Date | null = null;

  /** Last provisioning error message */
  provisioningError: string = '';

  /** Extensible key-value metadata (JSON) */
  metadata: string = '';

  createdAt: Date = new Date();
  updatedAt: Date = new Date();

  constructor(options: SiteOptions = {}) {
    super(options);

    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.name !== undefined) this.name = options.name;
    if (options.domain !== undefined) this.domain = options.domain;
    if (options.status !== undefined) this.status = options.status;
    if (options.tier !== undefined) this.tier = options.tier;
    if (options.databaseUrl !== undefined)
      this.databaseUrl = options.databaseUrl;
    if (options.databaseType !== undefined)
      this.databaseType = options.databaseType;
    if (options.repositoryUrl !== undefined)
      this.repositoryUrl = options.repositoryUrl;
    if (options.templateName !== undefined)
      this.templateName = options.templateName;
    if (options.provisioningStatus !== undefined)
      this.provisioningStatus = options.provisioningStatus;
    if (options.provisionedAt !== undefined)
      this.provisionedAt = options.provisionedAt;
    if (options.provisioningError !== undefined)
      this.provisioningError = options.provisioningError;

    // Handle portalConfig — can be object or JSON string
    if (options.portalConfig !== undefined) {
      if (typeof options.portalConfig === 'string') {
        this.portalConfig = options.portalConfig;
      } else {
        this.portalConfig = JSON.stringify(options.portalConfig);
      }
    }

    // Handle metadata — can be object or JSON string
    if (options.metadata !== undefined) {
      if (typeof options.metadata === 'string') {
        this.metadata = options.metadata;
      } else {
        this.metadata = JSON.stringify(options.metadata);
      }
    }

    if (options.createdAt) this.createdAt = options.createdAt;
    if (options.updatedAt) this.updatedAt = options.updatedAt;
  }

  /**
   * Check if the site is active
   */
  isActive(): boolean {
    return this.status === 'active';
  }

  /**
   * Check if the site is provisioned and ready
   */
  isReady(): boolean {
    return this.provisioningStatus === 'ready';
  }

  /**
   * Get portal config as parsed object
   */
  getPortalConfig(): SitePortalConfig {
    if (!this.portalConfig) return {};
    try {
      return JSON.parse(this.portalConfig);
    } catch {
      return {};
    }
  }

  /**
   * Set portal config from object
   */
  setPortalConfig(config: SitePortalConfig): void {
    this.portalConfig = JSON.stringify(config);
  }

  /**
   * Get metadata as parsed object
   */
  getMetadata(): Record<string, unknown> {
    if (!this.metadata) return {};
    try {
      return JSON.parse(this.metadata);
    } catch {
      return {};
    }
  }

  /**
   * Set metadata from object
   */
  setMetadata(data: Record<string, unknown>): void {
    this.metadata = JSON.stringify(data);
  }

  /**
   * Update metadata by merging with existing values
   */
  updateMetadata(updates: Record<string, unknown>): void {
    const current = this.getMetadata();
    this.setMetadata({ ...current, ...updates });
  }
}
