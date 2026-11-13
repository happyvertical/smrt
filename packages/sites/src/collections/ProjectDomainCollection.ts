/**
 * ProjectDomainCollection - Collection manager for ProjectDomain links
 */

import { SmrtJunction, smrt } from '@happyvertical/smrt-core';
import type { Domain } from '../models/Domain';
import { ProjectDomain } from '../models/ProjectDomain';
import type { DomainRole } from '../types';

// Empty decorator so the scanner detects the collection without clobbering
// the item class's api/mcp/cli config.
@smrt()
export class ProjectDomainCollection extends SmrtJunction<ProjectDomain> {
  static readonly _itemClass = ProjectDomain;
  protected leftField = 'domainId';
  protected rightField = 'projectId';
  // No position column: no ORDER BY and no setLinks index assignment.
  protected sortField: string | null = null;
  protected positionField: string | null = null;

  /** Links for a domain (alias of `byLeft`) */
  async findByDomain(domainId: string): Promise<ProjectDomain[]> {
    return this.byLeft(domainId);
  }

  /** Links for a project (alias of `byRight`) */
  async findByProject(projectId: string): Promise<ProjectDomain[]> {
    return this.byRight(projectId);
  }

  async findByRole(role: DomainRole): Promise<ProjectDomain[]> {
    return this.list({ where: { role } });
  }

  /**
   * Link a domain to a project with a role; idempotent per
   * (domain, project, role). The link's tenant is taken from the domain;
   * an explicit `tenantId` that differs from it is rejected.
   */
  async assign(
    domain: Domain,
    projectId: string,
    role: DomainRole = 'production',
    tenantId?: string,
  ): Promise<ProjectDomain> {
    if (tenantId !== undefined && tenantId !== domain.tenantId) {
      throw new Error(
        `Tenant mismatch: domain ${domain.id} belongs to tenant ${domain.tenantId}, not ${tenantId}`,
      );
    }
    const domainId = domain.id as string;
    const existing = (
      await this.list({
        where: { tenantId: domain.tenantId, domainId, projectId, role },
      })
    )[0];
    if (existing) return existing;
    const link = await this.create({
      tenantId: domain.tenantId,
      domainId,
      projectId,
      role,
    });
    await link.save();
    return link;
  }
}
