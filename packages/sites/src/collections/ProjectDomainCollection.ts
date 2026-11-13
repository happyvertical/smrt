/**
 * ProjectDomainCollection - Collection manager for ProjectDomain links
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import { ProjectDomain } from '../models/ProjectDomain';
import type { DomainRole } from '../types';

export class ProjectDomainCollection extends SmrtCollection<ProjectDomain> {
  static readonly _itemClass = ProjectDomain;

  async findByDomain(domainId: string): Promise<ProjectDomain[]> {
    return this.list({ where: { domainId } });
  }

  async findByProject(projectId: string): Promise<ProjectDomain[]> {
    return this.list({ where: { projectId } });
  }

  async findByRole(role: DomainRole): Promise<ProjectDomain[]> {
    return this.list({ where: { role } });
  }

  /** Link a domain to a project with a role; idempotent per (domain, project, role) */
  async assign(
    tenantId: string,
    domainId: string,
    projectId: string,
    role: DomainRole = 'production',
  ): Promise<ProjectDomain> {
    const existing = (
      await this.list({ where: { domainId, projectId, role } })
    )[0];
    if (existing) return existing;
    const link = await this.create({ tenantId, domainId, projectId, role });
    await link.save();
    return link;
  }
}
