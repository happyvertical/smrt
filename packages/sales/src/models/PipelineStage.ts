import { foreignKey, SmrtObject, smrt } from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import type {
  OpportunityOutcome,
  PipelineStageKey,
  PipelineStageOptions,
} from '../types.js';

@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'sales_pipeline_stages',
  api: true,
  cli: true,
  mcp: true,
  conflictColumns: ['tenant_id', 'pipeline_id', 'key'],
})
export class PipelineStage extends SmrtObject {
  @tenantId()
  tenantId: string = '';
  @foreignKey('PipelineDefinition') pipelineId: string = '';
  key: PipelineStageKey = 'new';
  name: string = 'New';
  sortOrder: number = 0;
  terminal: boolean = false;
  outcome: OpportunityOutcome = 'open';
  constructor(options: PipelineStageOptions = {}) {
    super(options);
    Object.assign(this, options);
  }
}
