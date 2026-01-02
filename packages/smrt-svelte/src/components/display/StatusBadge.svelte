<script lang="ts">
/**
 * StatusBadge - Generic status indicator badge
 *
 * Provides pre-defined color schemes for common status domains (invoice, project, etc.)
 * or allows custom styling via CSS variables.
 */

export type StatusType =
  | 'default'
  | 'invoice'
  | 'project'
  | 'expense'
  | 'time'
  | 'compliance'
  | 'estimate';

interface Props {
  /** The status value to display */
  status: string;
  /** Pre-defined color scheme type */
  type?: StatusType;
  /** Badge size */
  size?: 'sm' | 'md' | 'lg';
  /** Visual variant */
  variant?: 'filled' | 'outline';
  /** Optional custom label (defaults to status value) */
  label?: string;
}

const {
  status,
  type = 'default',
  size = 'md',
  variant = 'filled',
  label,
}: Props = $props();

// Color mappings for different status domains
const colorSchemes: Record<
  StatusType,
  Record<string, { bg: string; text: string; border?: string }>
> = {
  default: {
    active: { bg: '#dcfce7', text: '#166534' },
    inactive: { bg: '#f3f4f6', text: '#6b7280' },
    pending: { bg: '#fef3c7', text: '#92400e' },
    error: { bg: '#fee2e2', text: '#dc2626' },
    success: { bg: '#dcfce7', text: '#166534' },
    warning: { bg: '#fef3c7', text: '#92400e' },
  },
  invoice: {
    draft: { bg: '#f3f4f6', text: '#6b7280' },
    sent: { bg: '#dbeafe', text: '#1e40af' },
    viewed: { bg: '#e0e7ff', text: '#4338ca' },
    paid: { bg: '#dcfce7', text: '#166534' },
    overdue: { bg: '#fee2e2', text: '#dc2626' },
    cancelled: { bg: '#fecaca', text: '#991b1b' },
  },
  project: {
    lead: { bg: '#e0e7ff', text: '#4338ca' },
    quoted: { bg: '#fef3c7', text: '#92400e' },
    active: { bg: '#dbeafe', text: '#1e40af' },
    on_hold: { bg: '#fef3c7', text: '#92400e' },
    completed: { bg: '#dcfce7', text: '#166534' },
    archived: { bg: '#f3f4f6', text: '#6b7280' },
  },
  expense: {
    unbilled: { bg: '#fef3c7', text: '#92400e' },
    billed: { bg: '#dcfce7', text: '#166534' },
    reimbursed: { bg: '#dbeafe', text: '#1e40af' },
    rejected: { bg: '#fee2e2', text: '#dc2626' },
  },
  time: {
    draft: { bg: '#f3f4f6', text: '#6b7280' },
    submitted: { bg: '#dbeafe', text: '#1e40af' },
    approved: { bg: '#dcfce7', text: '#166534' },
    rejected: { bg: '#fee2e2', text: '#dc2626' },
    billed: { bg: '#e0e7ff', text: '#4338ca' },
  },
  compliance: {
    valid: { bg: '#dcfce7', text: '#166534' },
    expiring: { bg: '#fef3c7', text: '#92400e' },
    expired: { bg: '#fee2e2', text: '#dc2626' },
    pending: { bg: '#dbeafe', text: '#1e40af' },
  },
  estimate: {
    draft: { bg: '#f3f4f6', text: '#6b7280' },
    presented: { bg: '#dbeafe', text: '#1e40af' },
    accepted: { bg: '#dcfce7', text: '#166534' },
    declined: { bg: '#fee2e2', text: '#dc2626' },
    expired: { bg: '#fecaca', text: '#991b1b' },
  },
};

// Normalize status for lookup (lowercase, handle spaces/underscores)
const normalizedStatus = $derived(status.toLowerCase().replace(/[\s-]/g, '_'));

// Get colors for current status
const colors = $derived.by(() => {
  const scheme = colorSchemes[type] ?? colorSchemes.default;
  return scheme[normalizedStatus] ?? { bg: '#e5e7eb', text: '#374151' };
});

// Format display label
const displayLabel = $derived(label ?? status.replace(/_/g, ' '));
</script>

<span
  class="status-badge"
  class:sm={size === 'sm'}
  class:lg={size === 'lg'}
  class:outline={variant === 'outline'}
  style:--badge-bg={colors.bg}
  style:--badge-text={colors.text}
>
  {displayLabel}
</span>

<style>
  .status-badge {
    display: inline-flex;
    align-items: center;
    padding: 0.25rem 0.75rem;
    font-size: 0.75rem;
    font-weight: 500;
    border-radius: 9999px;
    white-space: nowrap;
    text-transform: capitalize;
    background-color: var(--badge-bg);
    color: var(--badge-text);
    line-height: 1.25;
  }

  .status-badge.sm {
    padding: 0.125rem 0.5rem;
    font-size: 0.625rem;
  }

  .status-badge.lg {
    padding: 0.375rem 1rem;
    font-size: 0.875rem;
  }

  .status-badge.outline {
    background-color: transparent;
    border: 1px solid var(--badge-text);
  }
</style>
