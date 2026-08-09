import {
  crossPackageRef,
  field,
  SmrtObject,
  type SmrtObjectOptions,
  smrt,
} from '@happyvertical/smrt-core';
import { tenantId } from '@happyvertical/smrt-tenancy';

/**
 * Durable daily receipt for one member's contribution to one field.
 *
 * The counter action creates this before incrementing its aggregate. Its
 * natural key makes the anti-inflation rule durable across requests and
 * replicas: one `(tenant, user, object, field, UTC day)` sample may affect
 * usage evidence. Receipts intentionally retain no submitted value.
 */
@smrt({
  tableName: '_smrt_field_usage_report_receipts',
  conflictColumns: [
    'tenant_id',
    'user_id',
    'object_ref',
    'field_name',
    'period',
  ],
  api: { include: [] },
  cli: false,
  mcp: { include: [] },
})
export class FieldUsageReportReceipt extends SmrtObject {
  @tenantId()
  tenantId?: string;

  @crossPackageRef('@happyvertical/smrt-users:User')
  userId: string = '';

  @field({ required: true })
  objectRef: string = '';

  @field({ required: true })
  fieldName: string = '';

  @field({ required: true })
  period: string = '';

  constructor(options: FieldUsageReportReceiptOptions = {}) {
    super(options);
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.userId !== undefined) this.userId = options.userId;
    if (options.objectRef !== undefined) this.objectRef = options.objectRef;
    if (options.fieldName !== undefined) this.fieldName = options.fieldName;
    if (options.period !== undefined) this.period = options.period;
  }
}

export interface FieldUsageReportReceiptOptions extends SmrtObjectOptions {
  tenantId?: string;
  userId?: string;
  objectRef?: string;
  fieldName?: string;
  period?: string;
}
