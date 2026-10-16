import { field, SmrtObject, smrt } from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';

/** A generic tenant default or exact-record override for participation actions. */
@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'participation_policies',
  api: false,
  mcp: false,
  cli: false,
})
export class ParticipationPolicy extends SmrtObject {
  @tenantId() tenantId = '';
  @field() recordType = '';
  @field() recordId = '';
  @field({ required: true }) action = 'comment';
  @field({ required: true }) moderationMode:
    | 'open'
    | 'pre_moderated'
    | 'members_only'
    | 'closed' = 'open';
  @field({ required: true }) maxActions = 0;
  @field({ required: true }) windowSeconds = 0;
  protected override async validateBeforeSave(): Promise<void> {
    for (const identity of [this.tenantId, this.recordId]) {
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
    if (
      !['comment', 'react', 'vote'].includes(this.action) ||
      !['open', 'pre_moderated', 'members_only', 'closed'].includes(
        this.moderationMode,
      ) ||
      !Number.isSafeInteger(this.maxActions) ||
      this.maxActions < 0 ||
      !Number.isSafeInteger(this.windowSeconds) ||
      this.windowSeconds < 0 ||
      (this.maxActions > 0 && this.windowSeconds === 0)
    )
      throw new TypeError('Invalid participation policy.');
    await super.validateBeforeSave();
  }
}
