import { SmrtCollection } from '@happyvertical/smrt-core';
import {
  assertTenantReadAllowed,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import { ProjectQuestion } from '../models/ProjectQuestion.js';
import type {
  ProjectGovernanceScope,
  ProjectGovernanceVisibility,
  ProjectQuestionStatus,
} from '../project-governance-types.js';

export class ProjectQuestionCollection extends SmrtCollection<ProjectQuestion> {
  static readonly _itemClass = ProjectQuestion;

  async listForProject(
    scope: ProjectGovernanceScope,
    status?: ProjectQuestionStatus,
    visibility?: ProjectGovernanceVisibility,
  ): Promise<ProjectQuestion[]> {
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
  ): Promise<ProjectQuestion | null> {
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
