import { SmrtCollection } from '@happyvertical/smrt-core';
import {
  assertTenantReadAllowed,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import { ProjectGovernanceEvent } from '../models/ProjectGovernanceEvent.js';

export class ProjectGovernanceEventCollection extends SmrtCollection<ProjectGovernanceEvent> {
  static readonly _itemClass = ProjectGovernanceEvent;

  async listForRecord(input: {
    tenantId: string;
    recordType: string;
    recordId: string;
  }): Promise<ProjectGovernanceEvent[]> {
    assertTenantReadAllowed(input.tenantId, 'ProjectGovernanceEventCollection');
    return withTenant({ tenantId: input.tenantId }, () =>
      this.list({
        where: {
          tenantId: input.tenantId,
          metaType: input.recordType,
          metaId: input.recordId,
        },
        orderBy: 'revision ASC',
      }),
    );
  }
}
