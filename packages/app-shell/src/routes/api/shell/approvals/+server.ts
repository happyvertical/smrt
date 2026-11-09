/**
 * `GET /api/shell/approvals?status=pending|approved|denied|failed` (default:
 * all, newest first)
 * -> { approvals: { id, status, summary, preview, action, requestedBy,
 *      decidedBy, decidedAt, result, createdAt }[], pending: number }
 * `action` is { kind: 'command', command } | { kind: 'tool', name, args } |
 * { kind: 'rest', method, url } | { kind: 'record-delete', model, id }.
 */

import { listApprovalViews, pendingApprovalCount } from '$lib/server/approvals';
import { guarded, HttpError, json, ownerOf } from '$lib/server/http';
import type { RequestHandler } from './$types';

const STATUSES = ['pending', 'approved', 'denied', 'failed'] as const;

export const GET: RequestHandler = guarded(async (event) => {
  await ownerOf(event);
  const status = event.url.searchParams.get('status');
  if (status !== null && !(STATUSES as readonly string[]).includes(status))
    throw new HttpError(400, 'invalid status');
  return json({
    approvals: await listApprovalViews(
      status ? { status: status as (typeof STATUSES)[number] } : {},
    ),
    pending: await pendingApprovalCount(),
  });
});
