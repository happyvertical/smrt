<script lang="ts">
/**
 * ApprovalActions - Status-based action buttons for approval workflow
 * Shows appropriate buttons based on current status
 */

import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button } from '@happyvertical/smrt-ui/ui';
import { M } from '../i18n.js';
import type { ApprovalStatus } from './utils.js';

const { t } = useI18n();

/** Props for ApprovalActions component */
export interface Props {
  status: ApprovalStatus;
  onsubmit?: () => void;
  onapprove?: () => void;
  onreject?: () => void;
  onedit?: () => void;
  ondelete?: () => void;
  loading?: boolean;
  disabled?: boolean;
  layout?: 'horizontal' | 'vertical';
}

let {
  status,
  onsubmit,
  onapprove,
  onreject,
  onedit,
  ondelete,
  loading = false,
  disabled = false,
  layout = 'horizontal',
}: Props = $props();

// Determine which actions are available based on status
const canSubmit = $derived(status === 'draft' && onsubmit);
const canApprove = $derived(status === 'submitted' && onapprove);
const canReject = $derived(status === 'submitted' && onreject);
const canEdit = $derived(
  (status === 'draft' || status === 'rejected') && onedit,
);
const canDelete = $derived(status === 'draft' && ondelete);
</script>

<div class="approval-actions" class:vertical={layout === 'vertical'}>
  {#if canSubmit}
    <Button variant="primary" onclick={onsubmit} disabled={disabled || loading}>
      {loading ? 'Submitting...' : 'Submit for Approval'}
    </Button>
  {/if}

  {#if canApprove}
    <Button variant="primary" onclick={onapprove} disabled={disabled || loading}>
      {loading ? 'Approving...' : 'Approve'}
    </Button>
  {/if}

  {#if canReject}
    <Button variant="danger" onclick={onreject} disabled={disabled || loading}>
      Reject
    </Button>
  {/if}

  {#if canEdit}
    <Button variant="secondary" onclick={onedit} disabled={disabled || loading}>
      Edit
    </Button>
  {/if}

  {#if canDelete}
    <Button variant="danger" onclick={ondelete} disabled={disabled || loading}>
      Delete
    </Button>
  {/if}

  {#if status === 'approved'}
    <span class="status-message success">
      {t(M['projects.approval_actions.approved_message'])}
    </span>
  {/if}

  {#if status === 'rejected'}
    <span class="status-message error">
      {t(M['projects.approval_actions.rejected_message'])}
    </span>
  {/if}
</div>

<style>
  .approval-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem;
    align-items: center;
  }

  .approval-actions.vertical {
    flex-direction: column;
    align-items: stretch;
  }

  .status-message {
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
    font-weight: var(--smrt-typography-label-large-weight, 500);
    padding: 0.5rem 1rem;
    border-radius: var(--smrt-radius-small, 8px);
  }

  .status-message.success {
    background: var(--smrt-color-primary-container);
    color: var(--smrt-color-on-primary-container);
  }

  .status-message.error {
    background: var(--smrt-color-error-container);
    color: var(--smrt-color-on-error-container);
  }
</style>
