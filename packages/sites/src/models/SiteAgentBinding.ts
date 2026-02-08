/**
 * SiteAgentBinding - Junction between sites and agents
 *
 * Represents which agents are bound to a specific site,
 * with optional per-site agent configuration overrides.
 *
 * Each row binds an agent class to a site. The absence of a row
 * means the agent is not enabled for that site.
 */

import { SmrtObject, smrt } from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import type { SiteAgentBindingOptions } from '../types';

@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'site_agent_bindings',
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
  cli: { include: ['list', 'get'] },
  mcp: { include: ['list', 'get'] },
  conflictColumns: ['site_id', 'agent_class'],
})
export class SiteAgentBinding extends SmrtObject {
  @tenantId()
  tenantId: string = '';

  /** FK to sites table */
  siteId: string = '';

  /** Agent class name, e.g. "Praeco" */
  agentClass: string = '';

  /** Whether this agent is enabled for the site */
  enabled: boolean = true;

  /** Per-site agent configuration overrides (JSON) */
  config: Record<string, unknown> | null = null;

  /** Sort priority (higher = first) */
  priority: number = 0;

  constructor(options: SiteAgentBindingOptions = {}) {
    super(options);

    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.siteId !== undefined) this.siteId = options.siteId;
    if (options.agentClass !== undefined) this.agentClass = options.agentClass;
    if (options.enabled !== undefined) this.enabled = options.enabled;
    if (options.priority !== undefined) this.priority = options.priority;

    // Handle config — can be object, JSON string, or null
    if (options.config !== undefined) {
      if (typeof options.config === 'string') {
        try {
          this.config = JSON.parse(options.config);
        } catch {
          this.config = null;
        }
      } else {
        this.config = options.config;
      }
    }
  }
}
