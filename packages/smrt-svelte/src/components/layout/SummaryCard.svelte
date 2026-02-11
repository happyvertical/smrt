<script lang="ts">
/**
 * SummaryCard - Statistic/summary display card refactored for Material 3
 *
 * Shows a label with a prominent value, optionally with a count badge
 * and link functionality.
 */
import { ripple } from '../../actions/ripple.js';
import { Icon } from '../display/index.js';

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
  /** Optional icon (name for Icon or SVG string) */
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

// Map variant to M3 color roles
const valueColorClass = $derived.by(() => {
  switch (variant) {
    case 'success':
      return 'color-success';
    case 'warning':
      return 'color-warning';
    case 'danger':
      return 'color-error';
    default:
      return 'color-default';
  }
});

const isSvg = $derived(icon?.startsWith('<svg'));
</script>

{#if href}
  <a 
    class="summary-card" 
    class:highlight 
    class:clickable={true}
    {href}
    use:ripple
  >
    {#if icon}
      <span class="card-icon">
        {#if isSvg}
          {@html icon}
        {:else}
          <Icon name={icon} size={24} />
        {/if}
      </span>
    {/if}
    <div class="card-content">
      <span class="card-label">
        {label}
        {#if count !== undefined}
          <span class="card-count">{count}</span>
        {/if}
      </span>
      <span class="card-value {valueColorClass}">{value}</span>
    </div>
    <div class="trailing">
      <Icon name="chevron-right" size={20} />
    </div>
  </a>
{:else}
  <div class="summary-card" class:highlight>
    {#if icon}
      <span class="card-icon">
        {#if isSvg}
          {@html icon}
        {:else}
          <Icon name={icon} size={24} />
        {/if}
      </span>
    {/if}
    <div class="card-content">
      <span class="card-label">
        {label}
        {#if count !== undefined}
          <span class="card-count">{count}</span>
        {/if}
      </span>
      <span class="card-value {valueColorClass}">{value}</span>
    </div>
  </div>
{/if}

<style>
  .summary-card {
    display: flex;
    align-items: center;
    gap: 1rem;
    padding: 1rem 1.25rem;
    background-color: var(--smrt-color-surface-container-low);
    border-radius: 12px;
    text-decoration: none;
    color: var(--smrt-color-on-surface);
    transition: all 200ms cubic-bezier(0.2, 0, 0, 1);
    position: relative;
    overflow: hidden;
    box-shadow: var(--smrt-elevation-level1);
  }

  .clickable:hover {
    background-color: var(--smrt-color-surface-container-high);
    box-shadow: var(--smrt-elevation-level2);
  }

  .summary-card.highlight {
    background-color: var(--smrt-color-secondary-container);
    color: var(--smrt-color-on-secondary-container);
  }

  .card-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 3rem;
    height: 3rem;
    background-color: var(--smrt-color-surface-container-high);
    border-radius: 12px;
    color: var(--smrt-color-primary);
    flex-shrink: 0;
  }

  .highlight .card-icon {
    background-color: var(--smrt-color-on-secondary-container);
    color: var(--smrt-color-secondary-container);
  }

  .card-content {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .card-label {
    font: var(--smrt-typography-label-large-font);
    color: var(--smrt-color-on-surface-variant);
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .highlight .card-label {
    color: var(--smrt-color-on-secondary-container);
    opacity: 0.8;
  }

  .card-count {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 1.25rem;
    height: 1.25rem;
    padding: 0 0.375rem;
    font: var(--smrt-typography-label-small-font);
    background-color: var(--smrt-color-primary);
    color: var(--smrt-color-on-primary);
    border-radius: 9999px;
  }

  .card-value {
    font: var(--smrt-typography-headline-small-font);
    font-weight: 600;
  }

  .color-default { color: var(--smrt-color-on-surface); }
  .color-success { color: var(--smrt-color-primary); }
  .color-warning { color: var(--smrt-color-error-container); } /* M3 Warning is often custom, using error container as proxy */
  .color-error { color: var(--smrt-color-error); }

  .trailing {
    color: var(--smrt-color-on-surface-variant);
    opacity: 0.5;
  }

  .clickable:hover .trailing {
    opacity: 1;
    color: var(--smrt-color-primary);
  }
</style>