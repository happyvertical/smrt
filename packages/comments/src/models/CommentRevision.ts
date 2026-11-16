import {
  crossPackageRef,
  field,
  foreignKey,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';

/** Immutable prior body retained whenever an author edits a comment. */
@TenantScoped({ mode: 'required' })
@smrt({ tableName: 'comment_revisions', api: false, mcp: false, cli: false })
export class CommentRevision extends SmrtObject {
  @tenantId()
  tenantId = '';

  // Retained history is service-owned; keep cross-dialect schema portable.
  @foreignKey('Comment', {
    required: true,
    requiredFor: 'identity',
    constraint: false,
  })
  commentId = '';

  @crossPackageRef('@happyvertical/smrt-users:User', { nullable: true })
  editorUserId: string | null = null;

  @field({ required: true, requiredFor: 'idempotency' })
  body = '';
}
