import {
  crossPackageRef,
  field,
  foreignKey,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import type { PersonaMessageRouteOptions } from '../types.js';

@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'persona_message_routes',
  api: { include: ['list', 'get'] },
  mcp: { include: ['list', 'get'] },
  cli: { include: ['list', 'get'] },
  conflictColumns: [
    'tenant_id',
    'persona_id',
    'account_id',
    'endpoint_id',
    'purpose',
  ],
})
export class PersonaMessageRoute extends SmrtObject {
  @tenantId()
  tenantId = '';

  @crossPackageRef('@happyvertical/smrt-personas:AgentPersona', {
    required: true,
  })
  personaId = '';

  @foreignKey('Account', { required: true })
  accountId = '';

  @foreignKey('MessagingEndpoint', { required: true })
  endpointId = '';

  @field({ required: true })
  purpose = 'default';

  priority = 0;
  enabled = true;
  createdAt = new Date();
  updatedAt = new Date();

  constructor(options: PersonaMessageRouteOptions = {}) {
    super(options);
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.personaId !== undefined) this.personaId = options.personaId;
    if (options.accountId !== undefined) this.accountId = options.accountId;
    if (options.endpointId !== undefined) this.endpointId = options.endpointId;
    if (options.purpose !== undefined) this.purpose = options.purpose;
    if (options.priority !== undefined) this.priority = options.priority;
    if (options.enabled !== undefined) this.enabled = options.enabled;
    if (options.createdAt !== undefined) this.createdAt = options.createdAt;
    if (options.updatedAt !== undefined) this.updatedAt = options.updatedAt;
  }
}
