import { field, SmrtObject, smrt } from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';

/** Service-owned fixed-window counter. Never delete a currently active bucket. */
@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'participation_rate_buckets',
  api: false,
  mcp: false,
  cli: false,
  indexes: [
    {
      name: 'participation_rate_bucket_unique',
      columns: ['tenantId', 'bucketKey'],
      unique: true,
    },
  ],
})
export class ParticipationRateBucket extends SmrtObject {
  @tenantId() tenantId = '';
  @field({ required: true }) bucketKey = '';
  @field({ required: true }) actionCount = 0;
}
