/**
 * SiteAgentBindingCollection - Collection manager for SiteAgentBinding objects
 *
 * Provides queries for agent bindings by site, agent class, and enabled state.
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import { SiteAgentBinding } from '../models/SiteAgentBinding';

export class SiteAgentBindingCollection extends SmrtCollection<SiteAgentBinding> {
  static readonly _itemClass = SiteAgentBinding;

  /**
   * Find all agent bindings for a site
   */
  async findBySite(siteId: string): Promise<SiteAgentBinding[]> {
    return this.list({ where: { siteId } });
  }

  /**
   * Find all sites using a specific agent class
   */
  async findByAgent(agentClass: string): Promise<SiteAgentBinding[]> {
    return this.list({ where: { agentClass } });
  }

  /**
   * Find enabled bindings for a site, ordered by priority descending
   */
  async findEnabled(siteId: string): Promise<SiteAgentBinding[]> {
    const bindings = await this.list({
      where: { siteId, enabled: true },
    });
    return bindings.sort((a, b) => b.priority - a.priority);
  }

  /**
   * Find a specific site-agent binding
   */
  async findBySiteAndAgent(
    siteId: string,
    agentClass: string,
  ): Promise<SiteAgentBinding | null> {
    const results = await this.list({
      where: { siteId, agentClass },
    });
    return results[0] ?? null;
  }
}
