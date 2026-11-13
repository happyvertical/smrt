/**
 * DomainService - Cross-collection domain helpers: domains by zone,
 * by project, and unassigned. Every helper is scoped to one tenant.
 */

import type { DomainCollection } from '../collections/DomainCollection';
import type { ProjectDomainCollection } from '../collections/ProjectDomainCollection';
import type { Domain } from '../models/Domain';
import type { DomainRole } from '../types';

export interface DomainServiceOptions {
  domains: DomainCollection;
  links: ProjectDomainCollection;
}

export class DomainService {
  private domains: DomainCollection;
  private links: ProjectDomainCollection;

  constructor(options: DomainServiceOptions) {
    this.domains = options.domains;
    this.links = options.links;
  }

  /** All of a tenant's domains under a zone */
  async domainsByZone(tenantId: string, zoneId: string): Promise<Domain[]> {
    return this.domains.list({ where: { tenantId, zoneId } });
  }

  /** A tenant's domains linked to a project, optionally for one role */
  async domainsByProject(
    tenantId: string,
    projectId: string,
    role?: DomainRole,
  ): Promise<Domain[]> {
    const links = await this.links.list({
      where: role ? { tenantId, projectId, role } : { tenantId, projectId },
    });
    const ids = [...new Set(links.map((l) => l.domainId))];
    if (ids.length === 0) return [];
    return this.domains.list({ where: { tenantId, id: ids } });
  }

  /** A tenant's domains with no project link */
  async unassignedDomains(tenantId: string): Promise<Domain[]> {
    const linked = [
      ...new Set(
        (await this.links.list({ where: { tenantId } })).map((l) => l.domainId),
      ),
    ];
    if (linked.length === 0) return this.domains.list({ where: { tenantId } });
    return this.domains.list({
      where: { tenantId, 'id not in': linked },
    });
  }
}
