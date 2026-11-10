<script lang="ts">
/**
 * SummaryCard - Statistic/summary display card refactored for Material 3
 *
 * Shows a label with a prominent value, optionally with a count badge
 * and link functionality.
 */
import type { Snippet } from 'svelte';
import { ripple } from '../../actions/ripple.js';
import { Icon } from '../display/index.js';

export interface Props {
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
  /** Optional icon name, rendered via the {@link Icon} component. */
  icon?: string;
  /**
   * Optional custom icon content, rendered as a Svelte snippet. Use this
   * escape hatch for bespoke icon markup. It replaces the former raw-SVG
   * **string** support, removed in #1591: SummaryCard no longer renders any
   * consumer-supplied value via `{@html}` (an XSS sink). `iconContent` is
   * rendered as a snippet, so the trust boundary moves to the consumer — the
   * snippet's contents are whatever the consumer authors. When both
   * `iconContent` and `icon` are provided, `iconContent` wins.
   */
  iconContent?: Snippet;
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
  iconContent,
  variant = 'default',
}: Props = $props();

// Map variant to M3 color roles
const valueColorClass = $derived.by(() => {
  switch (variant) {
    case 'success':
      return 'smrt-summary-card__color-success';
    case 'warning':
      return 'smrt-summary-card__color-warning';
    case 'danger':
      return 'smrt-summary-card__color-error';
    default:
      return 'smrt-summary-card__color-default';
  }
});
</script>

{#snippet cardIcon()}
  {#if iconContent}
    <span class="smrt-summary-card__icon" data-smrt-part="icon">{@render iconContent()}</span>
  {:else if icon}
    <span class="smrt-summary-card__icon" data-smrt-part="icon"><Icon name={icon} size={24} /></span>
  {/if}
{/snippet}

{#if href}
  <a 
    class="smrt-summary-card__root" 
    class:smrt-summary-card__highlight={highlight}
    class:smrt-summary-card__clickable={true}
    {href}
    use:ripple data-smrt-component="SummaryCard"
  >
    {@render cardIcon()}
    <div class="smrt-summary-card__content" data-smrt-part="body">
      <span class="smrt-summary-card__label" data-smrt-part="label">
        {label}
        {#if count !== undefined}
          <span class="smrt-summary-card__count" data-smrt-part="count">{count}</span>
        {/if}
      </span>
      <span class="smrt-summary-card__value {valueColorClass}" data-smrt-part="value">{value}</span>
    </div>
    <div class="smrt-summary-card__trailing" data-smrt-part="indicator">
      <Icon name="chevron-right" size={20} />
    </div>
  </a>
{:else}
  <div class="smrt-summary-card__root" class:smrt-summary-card__highlight={highlight} data-smrt-component="SummaryCard">
    {@render cardIcon()}
    <div class="smrt-summary-card__content" data-smrt-part="body">
      <span class="smrt-summary-card__label" data-smrt-part="label">
        {label}
        {#if count !== undefined}
          <span class="smrt-summary-card__count" data-smrt-part="count">{count}</span>
        {/if}
      </span>
      <span class="smrt-summary-card__value {valueColorClass}" data-smrt-part="value">{value}</span>
    </div>
  </div>
{/if}

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-summary-card__root {
    display: flex;
    align-items: center;
    gap: 1rem;
    padding: 1rem 1.25rem;
    position: relative;
    overflow: hidden;
  }
  .smrt-summary-card__icon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 3rem;
    height: 3rem;
    flex-shrink: 0;
  }
  .smrt-summary-card__content {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-1);
  }
  .smrt-summary-card__label {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .smrt-summary-card__count {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 1.25rem;
    height: 1.25rem;
    padding: 0 0.375rem;
  }
}

@layer smrt.theme {
  .smrt-summary-card__root {
    background-color: var(--smrt-color-surface-container-low);
    border-radius: var(--smrt-radius-lg);
    text-decoration: none;
    color: var(--smrt-color-on-surface);
    transition: all 200ms cubic-bezier(0.2, 0, 0, 1);
    box-shadow: var(--smrt-elevation-1);
  }
  .smrt-summary-card__clickable:hover {
    background-color: var(--smrt-color-surface-container-high);
    box-shadow: var(--smrt-elevation-2);
  }
  .smrt-summary-card__root.smrt-summary-card__highlight {
    background-color: var(--smrt-color-secondary-container);
    color: var(--smrt-color-on-secondary-container);
  }
  .smrt-summary-card__icon {
    background-color: var(--smrt-color-surface-container-high);
    border-radius: var(--smrt-radius-lg);
    color: var(--smrt-color-primary);
  }
  .smrt-summary-card__highlight .smrt-summary-card__icon {
    background-color: var(--smrt-color-on-secondary-container);
    color: var(--smrt-color-secondary-container);
  }
  .smrt-summary-card__label {
    font: var(--smrt-typography-label-large-font);
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-summary-card__highlight .smrt-summary-card__label {
    color: var(--smrt-color-on-secondary-container);
    opacity: 0.8;
  }
  .smrt-summary-card__count {
    font: var(--smrt-typography-label-small-font);
    background-color: var(--smrt-color-primary);
    color: var(--smrt-color-on-primary);
    border-radius: var(--smrt-radius-full);
  }
  .smrt-summary-card__value {
    font: var(--smrt-typography-headline-small-font);
    font-weight: var(--smrt-typography-weight-semibold, 600);
  }
  .smrt-summary-card__color-default {
    color: var(--smrt-color-on-surface);
  }
  .smrt-summary-card__color-success {
    color: var(--smrt-color-primary);
  }
  .smrt-summary-card__color-warning {
    color: var(--smrt-color-error-container);
  }
  /* M3 Warning is often custom, using error container as proxy */
  .smrt-summary-card__color-error {
    color: var(--smrt-color-error);
  }
  .smrt-summary-card__trailing {
    color: var(--smrt-color-on-surface-variant);
    opacity: 0.5;
  }
  .smrt-summary-card__clickable:hover .smrt-summary-card__trailing {
    opacity: 1;
    color: var(--smrt-color-primary);
  }
}

</style>