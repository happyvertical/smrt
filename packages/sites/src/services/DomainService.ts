/**
 * DomainService - Cross-collection domain helpers: domains by zone,
 * by project, and unassigned.
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

  /** All domains under a zone */
  async domainsByZone(zoneId: string): Promise<Domain[]> {
    return this.domains.findByZone(zoneId);
  }

  /** Domains linked to a project, optionally restricted to one role */
  async domainsByProject(
    projectId: string,
    role?: DomainRole,
  ): Promise<Domain[]> {
    const links = (await this.links.findByProject(projectId)).filter(
      (l) => !role || l.role === role,
    );
    const ids = new Set(links.map((l) => l.domainId));
    if (ids.size === 0) return [];
    return (await this.domains.list({})).filter((d) => ids.has(d.id as string));
  }

  /** Domains with no project link */
  async unassignedDomains(): Promise<Domain[]> {
    const linked = new Set((await this.links.list({})).map((l) => l.domainId));
    return (await this.domains.list({})).filter(
      (d) => !linked.has(d.id as string),
    );
  }
}
