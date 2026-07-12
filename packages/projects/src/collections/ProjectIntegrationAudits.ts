import { SmrtCollection } from '@happyvertical/smrt-core';
import { withTenant } from '@happyvertical/smrt-tenancy';
import { ProjectIntegrationAudit } from '../models/ProjectIntegrationAudit';

export class ProjectIntegrationAuditCollection extends SmrtCollection<ProjectIntegrationAudit> {
  static readonly _itemClass = ProjectIntegrationAudit;

  async listForIntegration(
    tenantId: string,
    integrationId: string,
  ): Promise<ProjectIntegrationAudit[]> {
    return withTenant({ tenantId }, () =>
      this.list({
        where: { tenantId, integrationId },
        orderBy: 'createdAt ASC',
      }),
    );
  }
}
