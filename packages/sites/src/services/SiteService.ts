/**
 * SiteService - High-level API for site lifecycle management
 *
 * Provides stateless operations for creating, activating, suspending,
 * and archiving sites, as well as managing agent bindings.
 */

import type { SiteAgentBindingCollection } from '../collections/SiteAgentBindingCollection';
import type { SiteCollection } from '../collections/SiteCollection';
import type { Site } from '../models/Site';
import type { SiteAgentBinding } from '../models/SiteAgentBinding';
import type { CreateSiteData } from '../types';

/**
 * Options for creating a SiteService
 */
export interface SiteServiceOptions {
  sites: SiteCollection;
  bindings: SiteAgentBindingCollection;
}

export class SiteService {
  private sites: SiteCollection;
  private bindings: SiteAgentBindingCollection;

  constructor(options: SiteServiceOptions) {
    this.sites = options.sites;
    this.bindings = options.bindings;
  }

  /**
   * Create a new site in draft status
   */
  async createSite(tenantId: string, data: CreateSiteData): Promise<Site> {
    const site = await this.sites.create({
      tenantId,
      name: data.name,
      domain: data.domain,
      status: 'draft',
      tier: data.tier ?? 'free',
      databaseUrl: data.databaseUrl ?? '',
      databaseType: data.databaseType ?? '',
      portalConfig: data.portalConfig ?? {},
      repositoryUrl: data.repositoryUrl ?? '',
      templateName: data.templateName ?? '',
      provisioningStatus: 'pending',
      metadata: data.metadata ?? {},
    });
    await site.save();
    return site;
  }

  /**
   * Activate a site — validates required fields then sets status to active
   */
  async activateSite(siteId: string): Promise<Site> {
    const site = await this.requireSite(siteId);

    if (!site.name) {
      throw new Error('Cannot activate site: name is required');
    }
    if (!site.domain) {
      throw new Error('Cannot activate site: domain is required');
    }

    site.status = 'active';
    site.updatedAt = new Date();
    await site.save();
    return site;
  }

  /**
   * Suspend a site
   */
  async suspendSite(siteId: string): Promise<Site> {
    const site = await this.requireSite(siteId);
    site.status = 'suspended';
    site.updatedAt = new Date();
    await site.save();
    return site;
  }

  /**
   * Archive a site
   */
  async archiveSite(siteId: string): Promise<Site> {
    const site = await this.requireSite(siteId);
    site.status = 'archived';
    site.updatedAt = new Date();
    await site.save();
    return site;
  }

  /**
   * Mark site as provisioned and ready
   */
  async markProvisioned(siteId: string): Promise<Site> {
    const site = await this.requireSite(siteId);
    site.provisioningStatus = 'ready';
    site.provisionedAt = new Date();
    site.provisioningError = '';
    site.updatedAt = new Date();
    await site.save();
    return site;
  }

  /**
   * Mark site provisioning as failed
   */
  async markProvisioningFailed(siteId: string, error: string): Promise<Site> {
    const site = await this.requireSite(siteId);
    site.provisioningStatus = 'failed';
    site.provisioningError = error;
    site.updatedAt = new Date();
    await site.save();
    return site;
  }

  /**
   * Bind an agent to a site
   */
  async bindAgent(
    siteId: string,
    agentClass: string,
    config?: Record<string, unknown>,
  ): Promise<SiteAgentBinding> {
    const site = await this.requireSite(siteId);

    const existing = await this.bindings.findBySiteAndAgent(siteId, agentClass);
    if (existing) {
      existing.enabled = true;
      if (config !== undefined) existing.config = config;
      await existing.save();
      return existing;
    }

    const binding = await this.bindings.create({
      tenantId: site.tenantId,
      siteId,
      agentClass,
      enabled: true,
      config: config ?? null,
    });
    await binding.save();
    return binding;
  }

  /**
   * Unbind an agent from a site
   */
  async unbindAgent(siteId: string, agentClass: string): Promise<void> {
    const binding = await this.bindings.findBySiteAndAgent(siteId, agentClass);
    if (binding) {
      await binding.delete();
    }
  }

  /**
   * Get all enabled agent bindings for a site
   */
  async getEnabledAgents(siteId: string): Promise<SiteAgentBinding[]> {
    return this.bindings.findEnabled(siteId);
  }

  /**
   * Load a site by ID, throwing if not found
   */
  private async requireSite(siteId: string): Promise<Site> {
    const site = await this.sites.get({ id: siteId });
    if (!site) {
      throw new Error(`Site '${siteId}' not found`);
    }
    return site;
  }
}
