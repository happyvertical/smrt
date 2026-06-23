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

// Color mappings for different status domains, referencing the canonical
// `--smrt-color-*` tokens directly. smrt-ui owns the theme system, so every
// preset (material/glass/studio) always defines these tokens. Literal hex
// fallbacks are intentionally omitted: a fallback only belongs here if it equals
// the token's real light value, and the previous hardcoded greens/blues did not
// (e.g. primary-container fell back to green #dcfce7, real material light is the
// blue #d3e3fd) — see #1586.
const colorSchemes: Record<
  StatusType,
  Record<string, { bg: string; text: string; border?: string }>
> = {
  default: {
    active: {
      bg: 'var(--smrt-color-primary-container)',
      text: 'var(--smrt-color-on-primary-container)',
    },
    inactive: {
      bg: 'var(--smrt-color-surface-container-highest)',
      text: 'var(--smrt-color-on-surface-variant)',
    },
    pending: {
      bg: 'var(--smrt-color-secondary-container)',
      text: 'var(--smrt-color-on-secondary-container)',
    },
    error: {
      bg: 'var(--smrt-color-error-container)',
      text: 'var(--smrt-color-on-error-container)',
    },
    success: {
      bg: 'var(--smrt-color-primary-container)',
      text: 'var(--smrt-color-on-primary-container)',
    },
    warning: {
      bg: 'var(--smrt-color-secondary-container)',
      text: 'var(--smrt-color-on-secondary-container)',
    },
  },
  invoice: {
    draft: {
      bg: 'var(--smrt-color-surface-container-highest)',
      text: 'var(--smrt-color-on-surface-variant)',
    },
    sent: {
      bg: 'var(--smrt-color-tertiary-container)',
      text: 'var(--smrt-color-on-tertiary-container)',
    },
    viewed: {
      bg: 'var(--smrt-color-primary-container)',
      text: 'var(--smrt-color-on-primary-container)',
    },
    paid: {
      bg: 'var(--smrt-color-primary-container)',
      text: 'var(--smrt-color-on-primary-container)',
    },
    overdue: {
      bg: 'var(--smrt-color-error-container)',
      text: 'var(--smrt-color-on-error-container)',
    },
    cancelled: {
      bg: 'var(--smrt-color-error-container)',
      text: 'var(--smrt-color-on-error-container)',
    },
  },
  project: {
    lead: {
      bg: 'var(--smrt-color-primary-container)',
      text: 'var(--smrt-color-on-primary-container)',
    },
    quoted: {
      bg: 'var(--smrt-color-secondary-container)',
      text: 'var(--smrt-color-on-secondary-container)',
    },
    active: {
      bg: 'var(--smrt-color-tertiary-container)',
      text: 'var(--smrt-color-on-tertiary-container)',
    },
    on_hold: {
      bg: 'var(--smrt-color-secondary-container)',
      text: 'var(--smrt-color-on-secondary-container)',
    },
    completed: {
      bg: 'var(--smrt-color-primary-container)',
      text: 'var(--smrt-color-on-primary-container)',
    },
    archived: {
      bg: 'var(--smrt-color-surface-container-highest)',
      text: 'var(--smrt-color-on-surface-variant)',
    },
  },
  expense: {
    unbilled: {
      bg: 'var(--smrt-color-secondary-container)',
      text: 'var(--smrt-color-on-secondary-container)',
    },
    billed: {
      bg: 'var(--smrt-color-primary-container)',
      text: 'var(--smrt-color-on-primary-container)',
    },
    reimbursed: {
      bg: 'var(--smrt-color-tertiary-container)',
      text: 'var(--smrt-color-on-tertiary-container)',
    },
    rejected: {
      bg: 'var(--smrt-color-error-container)',
      text: 'var(--smrt-color-on-error-container)',
    },
  },
  time: {
    draft: {
      bg: 'var(--smrt-color-surface-container-highest)',
      text: 'var(--smrt-color-on-surface-variant)',
    },
    submitted: {
      bg: 'var(--smrt-color-tertiary-container)',
      text: 'var(--smrt-color-on-tertiary-container)',
    },
    approved: {
      bg: 'var(--smrt-color-primary-container)',
      text: 'var(--smrt-color-on-primary-container)',
    },
    rejected: {
      bg: 'var(--smrt-color-error-container)',
      text: 'var(--smrt-color-on-error-container)',
    },
    billed: {
      bg: 'var(--smrt-color-primary-container)',
      text: 'var(--smrt-color-on-primary-container)',
    },
  },
  compliance: {
    valid: {
      bg: 'var(--smrt-color-primary-container)',
      text: 'var(--smrt-color-on-primary-container)',
    },
    expiring: {
      bg: 'var(--smrt-color-secondary-container)',
      text: 'var(--smrt-color-on-secondary-container)',
    },
    expired: {
      bg: 'var(--smrt-color-error-container)',
      text: 'var(--smrt-color-on-error-container)',
    },
    pending: {
      bg: 'var(--smrt-color-tertiary-container)',
      text: 'var(--smrt-color-on-tertiary-container)',
    },
  },
  estimate: {
    draft: {
      bg: 'var(--smrt-color-surface-container-highest)',
      text: 'var(--smrt-color-on-surface-variant)',
    },
    presented: {
      bg: 'var(--smrt-color-tertiary-container)',
      text: 'var(--smrt-color-on-tertiary-container)',
    },
    accepted: {
      bg: 'var(--smrt-color-primary-container)',
      text: 'var(--smrt-color-on-primary-container)',
    },
    declined: {
      bg: 'var(--smrt-color-error-container)',
      text: 'var(--smrt-color-on-error-container)',
    },
    expired: {
      bg: 'var(--smrt-color-error-container)',
      text: 'var(--smrt-color-on-error-container)',
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
      bg: 'var(--smrt-color-surface-container-highest)',
      text: 'var(--smrt-color-on-surface-variant)',
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
