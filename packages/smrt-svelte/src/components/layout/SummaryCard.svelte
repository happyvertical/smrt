<script lang="ts">
/**
 * SummaryCard - Statistic/summary display card
 *
 * Shows a label with a prominent value, optionally with a count badge
 * and link functionality.
 */

interface Props {
  /** Card label */
  label: string;
  /** Primary value to display */
  value: string | number;
  /** Optional count badge */
  count?: number;
  /** Highlight the card */
  highlight?: boolean;
  /** Make card clickable with href */
  href?: string;
  /** Optional icon (SVG string or component) */
  icon?: string;
  /** Value color variant */
  variant?: 'default' | 'success' | 'warning' | 'danger';
}

const {
  label,
  value,
  count,
  highlight = false,
  href,
  icon,
  variant = 'default',
}: Props = $props();

// Value color based on variant
const valueColor = $derived.by(() => {
  switch (variant) {
    case 'success':
      return '#16a34a';
    case 'warning':
      return '#d97706';
    case 'danger':
      return '#dc2626';
    default:
      return '#111827';
  }
});
</script>

{#if href}
  <a class="summary-card" class:highlight {href}>
    {#if icon}
      <span class="card-icon">{@html icon}</span>
    {/if}
    <div class="card-content">
      <span class="card-label">
        {label}
        {#if count !== undefined}
          <span class="card-count">{count}</span>
        {/if}
      </span>
      <span class="card-value" style:color={valueColor}>{value}</span>
    </div>
    <svg class="chevron" width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M8 4l6 6-6 6" />
    </svg>
  </a>
{:else}
  <div class="summary-card" class:highlight>
    {#if icon}
      <span class="card-icon">{@html icon}</span>
    {/if}
    <div class="card-content">
      <span class="card-label">
        {label}
        {#if count !== undefined}
          <span class="card-count">{count}</span>
        {/if}
      </span>
      <span class="card-value" style:color={valueColor}>{value}</span>
    </div>
  </div>
{/if}

<style>
  .summary-card {
    display: flex;
    align-items: center;
    gap: 1rem;
    padding: 1rem 1.25rem;
    background: white;
    border: 1px solid #e5e7eb;
    border-radius: 0.5rem;
    text-decoration: none;
    color: inherit;
    transition: all 0.15s;
  }

  a.summary-card:hover {
    border-color: #3b82f6;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
  }

  .summary-card.highlight {
    border-color: #3b82f6;
    background: #eff6ff;
  }

  .card-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 2.5rem;
    height: 2.5rem;
    background: #f3f4f6;
    border-radius: 0.5rem;
    color: #6b7280;
  }

  .card-content {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
  }

  .card-label {
    font-size: 0.875rem;
    color: #6b7280;
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .card-count {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 1.25rem;
    height: 1.25rem;
    padding: 0 0.375rem;
    font-size: 0.75rem;
    font-weight: 500;
    background: #3b82f6;
    color: white;
    border-radius: 9999px;
  }

  .card-value {
    font-size: 1.5rem;
    font-weight: 600;
    line-height: 1.2;
  }

  .chevron {
    color: #9ca3af;
  }

  a.summary-card:hover .chevron {
    color: #3b82f6;
  }
</style>
