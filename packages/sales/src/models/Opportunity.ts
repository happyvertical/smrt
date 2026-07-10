import {
  crossPackageRef,
  foreignKey,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import type { OpportunityOptions, OpportunityOutcome } from '../types.js';

@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'sales_opportunities',
  api: true,
  cli: true,
  mcp: true,
  conflictColumns: ['tenant_id', 'lead_id'],
})
export class Opportunity extends SmrtObject {
  @tenantId()
  tenantId: string = '';

  @foreignKey('Lead') leadId: string = '';
  @foreignKey('PipelineDefinition') pipelineId: string = '';
  @foreignKey('PipelineStage') stageId: string = '';

  @crossPackageRef('@happyvertical/smrt-users:User', { nullable: true })
  ownerId: string | null = null;

  name: string = '';
  expectedValue: number = 0.0;
  currency: string = 'USD';
  nextAction: string = '';
  outcome: OpportunityOutcome = 'open';
  closedAt: Date | null = null;
  lastStageChangeAt: Date | null = null;

  constructor(options: OpportunityOptions = {}) {
    super(options);
    Object.assign(this, options);
  }

  assign(ownerId: string): void {
    const normalized = ownerId.trim();
    if (!normalized) {
      throw new Error('A sales representative id is required');
    }
    this.ownerId = normalized;
  }

  setExpectedValue(value: number): void {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error('Expected value must be a non-negative number');
    }
    this.expectedValue = value;
  }

  moveTo(stage: PipelineStage): void {
    if (!stage.id) throw new Error('Pipeline stage must be saved before use');
    if (stage.pipelineId !== this.pipelineId)
      throw new Error('Pipeline stage belongs to a different pipeline');
    this.stageId = stage.id;
    this.outcome = stage.outcome;
    this.lastStageChangeAt = new Date();
    this.closedAt = stage.terminal ? new Date() : null;
  }
}

import type { PipelineStage } from './PipelineStage.js';
