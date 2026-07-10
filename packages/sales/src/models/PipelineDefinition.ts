import { SmrtObject, smrt } from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import type { PipelineDefinitionOptions } from '../types.js';

@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'sales_pipelines',
  api: true,
  cli: true,
  mcp: true,
  conflictColumns: ['tenant_id', 'key'],
})
export class PipelineDefinition extends SmrtObject {
  @tenantId()
  tenantId: string = '';
  key: string = 'default';
  name: string = 'Default Sales Pipeline';
  description: string = '';
  active: boolean = true;
  isDefault: boolean = false;
  constructor(options: PipelineDefinitionOptions = {}) {
    super(options);
    Object.assign(this, options);
  }
}
