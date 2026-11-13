// Shell outcome adapter over chat's observation-only durable hold bridge.
import { observeAssistantApproval } from '@happyvertical/smrt-chat/assistant-approvals';
import { shellApprovalAuthority } from '../approval-store.ts';

export type HoldOutcome =
  | { status: 'approved'; result: unknown }
  | { status: 'failed'; error: string }
  | { status: 'denied' }
  | { status: 'timeout' }
  | { status: 'aborted' };

export async function holdForUser(
  approvalId: string,
  options: { signal: AbortSignal; timeoutMs: number },
): Promise<HoldOutcome> {
  if (options.signal.aborted) return { status: 'aborted' };
  const { authority, tenantId } = await shellApprovalAuthority();
  const row = await observeAssistantApproval({
    authority,
    tenantId,
    id: approvalId,
    ...options,
  });
  if (options.signal.aborted) return { status: 'aborted' };
  if (!row || row.status === 'expired') return { status: 'timeout' };
  if (row.status === 'denied') return { status: 'denied' };
  if (row.status === 'failed')
    return {
      status: 'failed',
      error: String(
        (row.result as { error?: unknown } | null)?.error ??
          'the change failed',
      ),
    };
  if (row.status === 'succeeded')
    return { status: 'approved', result: row.result };
  return { status: 'timeout' };
}
