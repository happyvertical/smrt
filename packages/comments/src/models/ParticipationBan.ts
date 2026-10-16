import { field, SmrtObject, smrt } from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';

/** Tenant-local, reusable participation ban; a blank target applies tenant-wide. */
@TenantScoped({ mode: 'required' })
@smrt({ tableName: 'participation_bans', api: false, mcp: false, cli: false })
export class ParticipationBan extends SmrtObject {
  @tenantId() tenantId = '';
  @field({ required: true }) actorUserId = '';
  @field() recordType = '';
  @field() recordId = '';
  @field({ required: true }) reason = '';
  @field({ type: 'datetime', nullable: true }) expiresAt: Date | null = null;
  protected override async validateBeforeSave(): Promise<void> {
    for (const identity of [this.tenantId, this.actorUserId, this.recordId]) {
      if (
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          identity,
        ) &&
        identity !== identity.toLowerCase()
      )
        throw new TypeError(
          'Participation administrative UUIDs must be lowercase.',
        );
    }
    if (Boolean(this.recordType) !== Boolean(this.recordId))
      throw new TypeError(
        'Participation target requires both recordType and recordId.',
      );
    await super.validateBeforeSave();
  }
}
