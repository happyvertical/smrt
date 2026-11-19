import type { SmrtObjectOptions } from '@happyvertical/smrt-core';
// Register the package manifest before this module's @smrt() decorator
// runs, whichever chunk the library build places it in (#3098).
import '../__smrt-register__.js';
import {
  crossPackageRef,
  field,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy/decorators';

export interface CorrespondentOptions extends SmrtObjectOptions {
  tenantId?: string;
  ownerUserId?: string;
  address?: string;
  displayName?: string;
  messageCount?: number;
  sentCount?: number;
  receivedCount?: number;
  firstContactAt?: Date | null;
  lastContactAt?: Date | null;
  accountIds?: string;
  accountBreakdown?: string;
  profileId?: string | null;
}

/**
 * Someone one person writes to or hears from, derived from that person's
 * synced mail (#5132). Private to its owner: every row belongs to one
 * `ownerUserId`, is never shared across the tenant, and is read and changed
 * only through `CorrespondentService`, which filters on the acting user. The
 * generated REST/MCP/CLI surfaces are off for that reason.
 *
 * Everything but the address is optional: a correspondent has no name until
 * mail carries one, and no `profileId` until the owner links a smrt-profiles
 * `Profile` on purpose. Deriving never creates or links a `Profile`.
 * `accountIds` (JSON array) records which of the owner's readable mail
 * accounts the address was seen in, so the service can hide a correspondent
 * once the owner loses read access to every one of them.
 */
@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'correspondents',
  api: false,
  mcp: false,
  cli: false,
  conflictColumns: ['tenant_id', 'owner_user_id', 'address'],
  indexes: [
    {
      name: 'correspondents_owner_last_contact_idx',
      columns: ['tenantId', 'ownerUserId', 'lastContactAt'],
    },
  ],
})
export class Correspondent extends SmrtObject {
  @tenantId()
  tenantId = '';

  /** The one person this row is private to (`smrt-users:User`, uuid). */
  @crossPackageRef('@happyvertical/smrt-users:User', {
    required: true,
    requiredFor: 'identity',
  })
  ownerUserId = '';

  /** Lower-cased email address. */
  @field({ required: true, requiredFor: 'identity' })
  address = '';

  /** The most recent name mail used for this address; may be empty. */
  displayName = '';

  /** Messages the owner can read that mention this address. */
  messageCount = 0;
  /** Of those, messages sent by this address. */
  sentCount = 0;
  /** Of those, messages sent to or copied to this address. */
  receivedCount = 0;

  firstContactAt: Date | null = null;
  lastContactAt: Date | null = null;

  /** JSON array of mail account ids the address was seen in. */
  accountIds = '[]';

  /**
   * JSON object keyed by mail account id with that account's own sent and
   * received counts, first/last contact, and latest name. The service builds
   * every view from the accounts the viewer can read only; the top-level
   * counts above are totals kept for storage and are never shown on their own.
   */
  accountBreakdown = '{}';

  /** Optional link to a smrt-profiles `Profile`, set only by the owner. */
  @crossPackageRef('@happyvertical/smrt-profiles:Profile', { nullable: true })
  profileId: string | null = null;

  constructor(options: CorrespondentOptions = {}) {
    super(options);
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.ownerUserId !== undefined)
      this.ownerUserId = options.ownerUserId;
    if (options.address !== undefined) this.address = options.address;
    if (options.displayName !== undefined)
      this.displayName = options.displayName;
    if (options.messageCount !== undefined)
      this.messageCount = options.messageCount;
    if (options.sentCount !== undefined) this.sentCount = options.sentCount;
    if (options.receivedCount !== undefined)
      this.receivedCount = options.receivedCount;
    if (options.firstContactAt !== undefined)
      this.firstContactAt = options.firstContactAt;
    if (options.lastContactAt !== undefined)
      this.lastContactAt = options.lastContactAt;
    if (options.accountIds !== undefined) this.accountIds = options.accountIds;
    if (options.accountBreakdown !== undefined)
      this.accountBreakdown = options.accountBreakdown;
    if (options.profileId !== undefined) this.profileId = options.profileId;
  }

  /** Account ids this address was seen in (empty on unreadable JSON). */
  get seenInAccountIds(): string[] {
    try {
      const parsed = JSON.parse(this.accountIds || '[]');
      return Array.isArray(parsed)
        ? parsed.filter((id): id is string => typeof id === 'string')
        : [];
    } catch {
      return [];
    }
  }
}
