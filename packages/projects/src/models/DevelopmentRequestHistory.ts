import {
  foreignKey,
  SmrtObject,
  type SmrtObjectOptions,
  smrt,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import type { DevelopmentRequestStatus } from '../types';

export interface DevelopmentRequestHistoryOptions extends SmrtObjectOptions {
  tenantId?: string;
  requestId?: string;
  fromStatus?: string;
  toStatus?: DevelopmentRequestStatus;
  actorType?: 'integration' | 'participant' | 'system';
  actorId?: string;
  note?: string | null;
}

@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'development_request_histories',
  api: false,
  mcp: false,
  cli: false,
})
export class DevelopmentRequestHistory extends SmrtObject {
  @tenantId()
  tenantId: string = '';

  @foreignKey('DevelopmentRequest', { required: true })
  requestId: string = '';

  fromStatus: string = '';

  toStatus: DevelopmentRequestStatus = 'submitted';

  actorType: 'integration' | 'participant' | 'system' = 'system';

  actorId: string = '';

  note: string | null = null;

  constructor(options: DevelopmentRequestHistoryOptions = {}) {
    super(options);
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.requestId !== undefined) this.requestId = options.requestId;
    if (options.fromStatus !== undefined) this.fromStatus = options.fromStatus;
    if (options.toStatus !== undefined) this.toStatus = options.toStatus;
    if (options.actorType !== undefined) this.actorType = options.actorType;
    if (options.actorId !== undefined) this.actorId = options.actorId;
    if (options.note !== undefined) this.note = options.note;
  }
}
