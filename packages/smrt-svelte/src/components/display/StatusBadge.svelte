<script lang="ts">
/**
 * StatusBadge - Generic status indicator badge
 *
 * Provides pre-defined color schemes for common status domains (invoice, project, etc.)
 * or allows custom styling via CSS variables.
 */

import type { StatusType } from './types.js';

/** Props for StatusBadge component */
export interface Props {
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

// Color mappings for different status domains - uses CSS variables with fallbacks
const colorSchemes: Record<
  StatusType,
  Record<string, { bg: string; text: string; border?: string }>
> = {
  default: {
    active: {
      bg: 'var(--smrt-color-primary-container, #dcfce7)',
      text: 'var(--smrt-color-on-primary-container, #166534)',
    },
    inactive: {
      bg: 'var(--smrt-color-surface-container-highest, #f3f4f6)',
      text: 'var(--smrt-color-on-surface-variant, #6b7280)',
    },
    pending: {
      bg: 'var(--smrt-color-secondary-container, #fef3c7)',
      text: 'var(--smrt-color-on-secondary-container, #92400e)',
    },
    error: {
      bg: 'var(--smrt-color-error-container, #fee2e2)',
      text: 'var(--smrt-color-on-error-container, #dc2626)',
    },
    success: {
      bg: 'var(--smrt-color-primary-container, #dcfce7)',
      text: 'var(--smrt-color-on-primary-container, #166534)',
    },
    warning: {
      bg: 'var(--smrt-color-secondary-container, #fef3c7)',
      text: 'var(--smrt-color-on-secondary-container, #92400e)',
    },
  },
  invoice: {
    draft: {
      bg: 'var(--smrt-color-surface-container-highest, #f3f4f6)',
      text: 'var(--smrt-color-on-surface-variant, #6b7280)',
    },
    sent: {
      bg: 'var(--smrt-color-tertiary-container, #dbeafe)',
      text: 'var(--smrt-color-on-tertiary-container, #1e40af)',
    },
    viewed: {
      bg: 'var(--smrt-color-primary-container, #e0e7ff)',
      text: 'var(--smrt-color-on-primary-container, #4338ca)',
    },
    paid: {
      bg: 'var(--smrt-color-primary-container, #dcfce7)',
      text: 'var(--smrt-color-on-primary-container, #166534)',
    },
    overdue: {
      bg: 'var(--smrt-color-error-container, #fee2e2)',
      text: 'var(--smrt-color-on-error-container, #dc2626)',
    },
    cancelled: {
      bg: 'var(--smrt-color-error-container, #fecaca)',
      text: 'var(--smrt-color-on-error-container, #991b1b)',
    },
  },
  project: {
    lead: {
      bg: 'var(--smrt-color-primary-container, #e0e7ff)',
      text: 'var(--smrt-color-on-primary-container, #4338ca)',
    },
    quoted: {
      bg: 'var(--smrt-color-secondary-container, #fef3c7)',
      text: 'var(--smrt-color-on-secondary-container, #92400e)',
    },
    active: {
      bg: 'var(--smrt-color-tertiary-container, #dbeafe)',
      text: 'var(--smrt-color-on-tertiary-container, #1e40af)',
    },
    on_hold: {
      bg: 'var(--smrt-color-secondary-container, #fef3c7)',
      text: 'var(--smrt-color-on-secondary-container, #92400e)',
    },
    completed: {
      bg: 'var(--smrt-color-primary-container, #dcfce7)',
      text: 'var(--smrt-color-on-primary-container, #166534)',
    },
    archived: {
      bg: 'var(--smrt-color-surface-container-highest, #f3f4f6)',
      text: 'var(--smrt-color-on-surface-variant, #6b7280)',
    },
  },
  expense: {
    unbilled: {
      bg: 'var(--smrt-color-secondary-container, #fef3c7)',
      text: 'var(--smrt-color-on-secondary-container, #92400e)',
    },
    billed: {
      bg: 'var(--smrt-color-primary-container, #dcfce7)',
      text: 'var(--smrt-color-on-primary-container, #166534)',
    },
    reimbursed: {
      bg: 'var(--smrt-color-tertiary-container, #dbeafe)',
      text: 'var(--smrt-color-on-tertiary-container, #1e40af)',
    },
    rejected: {
      bg: 'var(--smrt-color-error-container, #fee2e2)',
      text: 'var(--smrt-color-on-error-container, #dc2626)',
    },
  },
  time: {
    draft: {
      bg: 'var(--smrt-color-surface-container-highest, #f3f4f6)',
      text: 'var(--smrt-color-on-surface-variant, #6b7280)',
    },
    submitted: {
      bg: 'var(--smrt-color-tertiary-container, #dbeafe)',
      text: 'var(--smrt-color-on-tertiary-container, #1e40af)',
    },
    approved: {
      bg: 'var(--smrt-color-primary-container, #dcfce7)',
      text: 'var(--smrt-color-on-primary-container, #166534)',
    },
    rejected: {
      bg: 'var(--smrt-color-error-container, #fee2e2)',
      text: 'var(--smrt-color-on-error-container, #dc2626)',
    },
    billed: {
      bg: 'var(--smrt-color-primary-container, #e0e7ff)',
      text: 'var(--smrt-color-on-primary-container, #4338ca)',
    },
  },
  compliance: {
    valid: {
      bg: 'var(--smrt-color-primary-container, #dcfce7)',
      text: 'var(--smrt-color-on-primary-container, #166534)',
    },
    expiring: {
      bg: 'var(--smrt-color-secondary-container, #fef3c7)',
      text: 'var(--smrt-color-on-secondary-container, #92400e)',
    },
    expired: {
      bg: 'var(--smrt-color-error-container, #fee2e2)',
      text: 'var(--smrt-color-on-error-container, #dc2626)',
    },
    pending: {
      bg: 'var(--smrt-color-tertiary-container, #dbeafe)',
      text: 'var(--smrt-color-on-tertiary-container, #1e40af)',
    },
  },
  estimate: {
    draft: {
      bg: 'var(--smrt-color-surface-container-highest, #f3f4f6)',
      text: 'var(--smrt-color-on-surface-variant, #6b7280)',
    },
    presented: {
      bg: 'var(--smrt-color-tertiary-container, #dbeafe)',
      text: 'var(--smrt-color-on-tertiary-container, #1e40af)',
    },
    accepted: {
      bg: 'var(--smrt-color-primary-container, #dcfce7)',
      text: 'var(--smrt-color-on-primary-container, #166534)',
    },
    declined: {
      bg: 'var(--smrt-color-error-container, #fee2e2)',
      text: 'var(--smrt-color-on-error-container, #dc2626)',
    },
    expired: {
      bg: 'var(--smrt-color-error-container, #fecaca)',
      text: 'var(--smrt-color-on-error-container, #991b1b)',
    },
  },
};

// Normalize status for lookup (lowercase, handle spaces/underscores)
const normalizedStatus = $derived(status.toLowerCase().replace(/[\s-]/g, '_'));

// Get colors for current status
const colors = $derived.by(() => {
  const scheme = colorSchemes[type] ?? colorSchemes.default;
  return (
    scheme[normalizedStatus] ?? {
      bg: 'var(--smrt-color-surface-container-highest, #e5e7eb)',
      text: 'var(--smrt-color-on-surface-variant, #374151)',
    }
  );
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
    font-size: var(--smrt-typography-label-medium-size, 0.75rem);
    font-weight: var(--smrt-typography-label-medium-weight, 500);
    border-radius: var(--smrt-radius-full, 9999px);
    white-space: nowrap;
    text-transform: capitalize;
    background-color: var(--badge-bg);
    color: var(--badge-text);
    line-height: 1.25;
  }

  .status-badge.sm {
    padding: 0.125rem 0.5rem;
    font-size: var(--smrt-typography-label-small-size, 0.625rem);
  }

  .status-badge.lg {
    padding: 0.375rem 1rem;
    font-size: var(--smrt-typography-label-large-size, 0.875rem);
  }

  .status-badge.outline {
    background-color: transparent;
    border: 1px solid var(--badge-text);
  }
</style>
