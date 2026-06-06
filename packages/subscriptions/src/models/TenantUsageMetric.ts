import { SmrtObject, smrt } from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import type { JsonObject } from '../types.js';
import { parseJsonObject, stringifyJson } from '../utils.js';

@TenantScoped({ mode: 'required' })
@smrt({
  tableName: '_smrt_tenant_usage_metrics',
  api: { include: ['list', 'get', 'create'] },
  cli: true,
  mcp: { include: ['list', 'get'] },
})
export class TenantUsageMetric extends SmrtObject {
  @tenantId()
  tenantId: string = '';

  metricKey: string = '';
  quantity: number = 0.0;
  windowStart: Date = new Date();
  windowEnd: Date = new Date();
  source: string = '';
  sourceId: string = '';
  dimensions: string = '{}';

  constructor(options: any = {}) {
    super(options);
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.metricKey !== undefined) this.metricKey = options.metricKey;
    if (options.quantity !== undefined) this.quantity = options.quantity;
    if (options.windowStart !== undefined)
      this.windowStart = options.windowStart;
    if (options.windowEnd !== undefined) this.windowEnd = options.windowEnd;
    if (options.source !== undefined) this.source = options.source;
    if (options.sourceId !== undefined) this.sourceId = options.sourceId;
    if (options.dimensions !== undefined) this.dimensions = options.dimensions;
  }

  getDimensions(): JsonObject {
    return parseJsonObject(this.dimensions, {});
  }

  setDimensions(dimensions: JsonObject): void {
    this.dimensions = stringifyJson(dimensions);
  }
}

export default TenantUsageMetric;
