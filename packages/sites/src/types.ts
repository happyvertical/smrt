/**
 * Types for smrt-sites package
 */

/**
 * Site lifecycle status
 */
export type SiteStatus = 'draft' | 'active' | 'suspended' | 'archived';

/**
 * Site pricing/feature tier
 */
export type SiteTier = 'free' | 'standard' | 'premium';

/**
 * Infrastructure provisioning status
 */
export type ProvisioningStatus =
  | 'pending'
  | 'provisioning'
  | 'ready'
  | 'failed';

/**
 * Portal configuration for theming, branding, and navigation
 */
export interface SitePortalConfig {
  theme?: string;
  branding?: Record<string, unknown>;
  navigation?: Array<{ label: string; path: string; icon?: string }>;
}

/**
 * Data required to create a new site
 */
export interface CreateSiteData {
  name: string;
  domain: string;
  tier?: SiteTier;
  databaseUrl?: string;
  databaseType?: string;
  portalConfig?: SitePortalConfig;
  repositoryUrl?: string;
  templateName?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Options for constructing a Site instance
 */
export interface SiteOptions {
  id?: string;
  tenantId?: string;
  name?: string;
  domain?: string;
  status?: SiteStatus;
  tier?: SiteTier;
  databaseUrl?: string;
  databaseType?: string;
  portalConfig?: SitePortalConfig | string;
  repositoryUrl?: string;
  templateName?: string;
  provisioningStatus?: ProvisioningStatus;
  provisionedAt?: Date | null;
  provisioningError?: string;
  metadata?: Record<string, unknown> | string;
  createdAt?: Date;
  updatedAt?: Date;
}

/**
 * Options for constructing a SiteAgentBinding instance
 */
export interface SiteAgentBindingOptions {
  id?: string;
  tenantId?: string;
  siteId?: string;
  agentClass?: string;
  enabled?: boolean;
  config?: Record<string, unknown> | string | null;
  priority?: number;
  createdAt?: Date;
  updatedAt?: Date;
}

/**
 * Role a domain plays for a project
 */
export type DomainRole =
  | 'production'
  | 'staging'
  | 'preview'
  | 'mail'
  | 'redirect'
  | 'other';

/** Options for constructing a DnsZone instance */
export interface DnsZoneOptions {
  id?: string;
  tenantId?: string;
  /** Apex name, e.g. "happyvertical.com" */
  name?: string;
  notes?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

/** Options for constructing a Domain instance */
export interface DomainOptions {
  id?: string;
  tenantId?: string;
  zoneId?: string;
  /** Fully qualified hostname, e.g. "work.happyvertical.com" */
  hostname?: string;
  notes?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

/** Options for constructing a ProjectDomain instance */
export interface ProjectDomainOptions {
  id?: string;
  tenantId?: string;
  domainId?: string;
  projectId?: string;
  role?: DomainRole;
  createdAt?: Date;
  updatedAt?: Date;
}
