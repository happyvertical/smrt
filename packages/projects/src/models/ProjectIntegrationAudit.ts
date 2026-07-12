import {
  foreignKey,
  SmrtObject,
  type SmrtObjectOptions,
  smrt,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import type { ProjectIntegrationAuditAction } from '../types';

export interface ProjectIntegrationAuditOptions extends SmrtObjectOptions {
  tenantId?: string;
  integrationId?: string;
  action?: ProjectIntegrationAuditAction;
  note?: string | null;
}

@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'project_integration_audits',
  api: false,
  mcp: false,
  cli: false,
})
export class ProjectIntegrationAudit extends SmrtObject {
  @tenantId()
  tenantId: string = '';

  @foreignKey('ProjectIntegration', { required: true })
  integrationId: string = '';

  action: ProjectIntegrationAuditAction = 'created';

  note: string | null = null;

  constructor(options: ProjectIntegrationAuditOptions = {}) {
    super(options);
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.integrationId !== undefined)
      this.integrationId = options.integrationId;
    if (options.action !== undefined) this.action = options.action;
    if (options.note !== undefined) this.note = options.note;
  }
}
