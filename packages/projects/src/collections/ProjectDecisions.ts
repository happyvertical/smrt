import { SmrtCollection } from '@happyvertical/smrt-core';
import {
  assertTenantReadAllowed,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import { ProjectDecision } from '../models/ProjectDecision.js';
import type {
  ProjectDecisionStatus,
  ProjectGovernanceScope,
  ProjectGovernanceVisibility,
} from '../project-governance-types.js';

export class ProjectDecisionCollection extends SmrtCollection<ProjectDecision> {
  static readonly _itemClass = ProjectDecision;

  async listForProject(
    scope: ProjectGovernanceScope,
    status?: ProjectDecisionStatus,
    visibility?: ProjectGovernanceVisibility,
  ): Promise<ProjectDecision[]> {
    assertTenantReadAllowed(scope.tenantId, 'ProjectGovernanceCollection');
    return withTenant({ tenantId: scope.tenantId }, () =>
      this.list({
        where: {
          tenantId: scope.tenantId,
          metaType: scope.projectType,
          metaId: scope.projectId,
          ...(status ? { status } : {}),
          ...(visibility ? { visibility } : {}),
        },
        orderBy: 'createdAt ASC',
      }),
    );
  }

  async getForProject(
    scope: ProjectGovernanceScope,
    id: string,
  ): Promise<ProjectDecision | null> {
    assertTenantReadAllowed(scope.tenantId, 'ProjectGovernanceCollection');
    return withTenant({ tenantId: scope.tenantId }, () =>
      this.findOne({
        where: {
          id,
          tenantId: scope.tenantId,
          metaType: scope.projectType,
          metaId: scope.projectId,
        },
      }),
    );
  }
}
