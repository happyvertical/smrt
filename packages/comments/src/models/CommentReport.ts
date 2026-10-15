import {
  crossPackageRef,
  field,
  foreignKey,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';

/** A tenant-local report; moderation resolution never deletes the report. */
@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'comment_reports',
  api: false,
  mcp: false,
  cli: false,
  indexes: [
    {
      name: 'comment_reports_queue_idx',
      columns: ['tenantId', 'status', 'createdAt'],
    },
  ],
})
export class CommentReport extends SmrtObject {
  @tenantId()
  tenantId = '';

  // Reports outlive comment-state changes and must work on DuckDB.
  @foreignKey('Comment', { required: true, constraint: false })
  commentId = '';

  @crossPackageRef('@happyvertical/smrt-users:User', { required: true })
  reporterUserId = '';

  @field({ required: true })
  reason = '';

  @field({ required: true })
  status: 'open' | 'resolved' | 'dismissed' = 'open';
}
