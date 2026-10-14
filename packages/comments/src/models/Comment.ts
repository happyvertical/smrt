import {
  crossPackageRef,
  field,
  SmrtPolymorphicAssociation,
  smrt,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import type { CommentOptions } from '../types.js';

const MAX_MENTIONS = 50;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'record_comments',
  api: false,
  mcp: false,
  cli: false,
  indexes: [
    {
      name: 'record_comments_tenant_request_key',
      columns: ['retryTenantId', 'idempotencyKey'],
      unique: true,
    },
    {
      name: 'record_comments_record_created_idx',
      columns: ['tenantId', 'metaType', 'metaId', 'createdAt'],
    },
  ],
})
export class Comment extends SmrtPolymorphicAssociation {
  @tenantId()
  tenantId = '';

  @crossPackageRef('@happyvertical/smrt-users:User', { required: true })
  authorUserId = '';

  @field({ required: true })
  body = '';

  /** JSON array of referenced User UUIDs; use mentionUserIds for validation. */
  mentions = '[]';

  /** Service-owned binding retained after generic runOnce claim retention. */
  @field({ type: 'text', nullable: true, readonly: true })
  idempotencyKey: string | null = null;

  /** Canonical retry namespace; never rewrites stored tenant/user references. */
  @field({ type: 'text', nullable: true, readonly: true })
  retryTenantId: string | null = null;

  /** Digest of the original authenticated author, parent and normalized payload. */
  @field({ type: 'text', nullable: true, readonly: true })
  requestDigest: string | null = null;

  constructor(options: CommentOptions = {}) {
    super(options);
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.authorUserId !== undefined)
      this.authorUserId = options.authorUserId;
    if (options.body !== undefined) this.body = options.body;
    if (options.idempotencyKey !== undefined)
      this.idempotencyKey = options.idempotencyKey;
    if (options.retryTenantId !== undefined)
      this.retryTenantId = options.retryTenantId;
    if (options.requestDigest !== undefined)
      this.requestDigest = options.requestDigest;
    const mentions = options.mentions as unknown;
    if (Array.isArray(mentions)) this.mentionUserIds = mentions;
    else if (typeof mentions === 'string') this.mentions = mentions;
  }

  get mentionUserIds(): string[] {
    try {
      const parsed: unknown = JSON.parse(this.mentions);
      return Array.isArray(parsed) &&
        parsed.every((value) => typeof value === 'string')
        ? parsed
        : [];
    } catch {
      return [];
    }
  }

  set mentionUserIds(value: readonly string[]) {
    const unique = [...new Set(value.map((id) => id.trim()).filter(Boolean))];
    if (unique.length > MAX_MENTIONS || unique.some((id) => !UUID.test(id))) {
      throw new TypeError(
        'Comment mentions must contain at most 50 user UUIDs.',
      );
    }
    this.mentions = JSON.stringify(unique);
  }
}
