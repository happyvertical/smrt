import { SmrtCollection } from '@happyvertical/smrt-core';
import {
  assertTenantReadAllowed,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import { ProjectSpecification } from '../models/ProjectSpecification.js';
import type { ProjectGovernanceScope } from '../project-governance-types.js';

export class ProjectSpecificationCollection extends SmrtCollection<ProjectSpecification> {
  static readonly _itemClass = ProjectSpecification;

  async getForProject(
    scope: ProjectGovernanceScope,
  ): Promise<ProjectSpecification | null> {
    assertTenantReadAllowed(scope.tenantId, 'ProjectSpecificationCollection');
    return withTenant({ tenantId: scope.tenantId }, () =>
      this.findOne({
        where: {
          tenantId: scope.tenantId,
          metaType: scope.projectType,
          metaId: scope.projectId,
        },
      }),
    );
  }
}
