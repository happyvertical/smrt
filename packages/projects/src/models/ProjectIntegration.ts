import {
  field,
  SmrtObject,
  type SmrtObjectOptions,
  smrt,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import type {
  ProjectIntegrationCapability,
  ProjectIntegrationStatus,
} from '../types';

export interface ProjectIntegrationOptions extends SmrtObjectOptions {
  tenantId?: string;
  projectId?: string;
  name?: string;
  credentialHash?: string;
  capabilities?: ProjectIntegrationCapability[];
  status?: ProjectIntegrationStatus;
  revokedAt?: Date | null;
}

@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'project_integrations',
  api: { include: ['list', 'get'] },
  mcp: { include: ['list', 'get'] },
  cli: { include: ['list', 'get'] },
})
export class ProjectIntegration extends SmrtObject {
  @tenantId()
  tenantId: string = '';

  projectId: string = '';

  name: string = '';

  @field({ sensitive: true })
  credentialHash: string = '';

  capabilities: ProjectIntegrationCapability[] = [];

  status: ProjectIntegrationStatus = 'active';

  revokedAt: Date | null = null;

  constructor(options: ProjectIntegrationOptions = {}) {
    super(options);
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.projectId !== undefined) this.projectId = options.projectId;
    if (options.name !== undefined) this.name = options.name;
    if (options.credentialHash !== undefined)
      this.credentialHash = options.credentialHash;
    if (options.capabilities !== undefined)
      this.capabilities = [...options.capabilities];
    if (options.status !== undefined) this.status = options.status;
    if (options.revokedAt !== undefined) this.revokedAt = options.revokedAt;
  }

  hasCapability(capability: ProjectIntegrationCapability): boolean {
    return this.capabilities.includes(capability);
  }

  isActive(): boolean {
    return this.status === 'active' && this.revokedAt === null;
  }
}
