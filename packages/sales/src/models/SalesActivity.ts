import {
  crossPackageRef,
  foreignKey,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import type {
  ActivityDetails,
  SalesActivityOptions,
  SalesActivityType,
} from '../types.js';

@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'sales_activities',
  api: { include: ['list', 'get', 'create'] },
  cli: true,
  mcp: { include: ['list', 'get', 'create'] },
})
export class SalesActivity extends SmrtObject {
  @tenantId()
  tenantId: string = '';

  @foreignKey('Lead') leadId: string | null = null;
  @foreignKey('Opportunity') opportunityId: string | null = null;
  type: SalesActivityType = 'note';

  @crossPackageRef('@happyvertical/smrt-users:User', { nullable: true })
  actorId: string | null = null;

  summary: string = '';
  details: string = '{}';
  occurredAt: Date = new Date();

  constructor(options: SalesActivityOptions = {}) {
    super(options);
    Object.assign(this, options);
  }

  getDetails(): ActivityDetails {
    try {
      return JSON.parse(this.details) as ActivityDetails;
    } catch {
      return {};
    }
  }

  setDetails(details: ActivityDetails): void {
    this.details = JSON.stringify(details);
  }
}
