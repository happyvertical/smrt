<script lang="ts">
/**
 * Tabs - Tab navigation component
 * refactored for Material 3
 *
 * Provides tabbed navigation with optional counts and content slots.
 */
import type { Snippet } from 'svelte';
import { ripple } from '../../actions/ripple.js';
import type { Tab } from './types.js';

interface Props {
  /** Available tabs */
  tabs: Tab[];
  /** Currently active tab id */
  active: string;
  /** Called when tab changes */
  onchange?: (id: string) => void;
  /** Size variant */
  size?: 'sm' | 'md' | 'lg';
  /** Visual variant */
  variant?: 'primary' | 'secondary';
  /** Tab content slot */
  children?: Snippet;
}

const {
  tabs,
  active,
  onchange,
  size = 'md',
  variant = 'primary',
  children,
}: Props = $props();

function handleClick(id: string) {
  if (id !== active) {
    onchange?.(id);
  }
}
</script>

<div class="tabs-container">
  <div
    class="tabs-nav"
    class:sm={size === 'sm'}
    class:lg={size === 'lg'}
    class:secondary={variant === 'secondary'}
    role="tablist"
  >
    {#each tabs as tab (tab.id)}
      <button
        type="button"
        class="tab-button"
        class:active={tab.id === active}
        disabled={tab.disabled}
        role="tab"
        aria-selected={tab.id === active}
        aria-controls="tab-panel-{tab.id}"
        onclick={() => handleClick(tab.id)}
        use:ripple
      >
        <span class="tab-content-wrapper">
          <span class="tab-label">{tab.label}</span>
          {#if tab.count !== undefined}
            <span class="tab-count">{tab.count}</span>
          {/if}
        </span>
        <div class="active-indicator"></div>
      </button>
    {/each}
  </div>

  {#if children}
    <div class="tab-panel" role="tabpanel" id="tab-panel-{active}">
      {@render children()}
    </div>
  {/if}
</div>

<style>
  .tabs-container {
    display: flex;
    flex-direction: column;
    width: 100%;
  }

  .tabs-nav {
    display: flex;
    border-bottom: 1px solid var(--md-sys-color-surface-variant);
    width: 100%;
  }

  .tab-button {
    flex: 1;
    display: inline-flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 0 16px;
    height: 48px;
    font: var(--md-sys-typescale-title-small-font);
    font-weight: 500;
    color: var(--md-sys-color-on-surface-variant);
    background: transparent;
    border: none;
    cursor: pointer;
    transition: all 200ms cubic-bezier(0.2, 0, 0, 1);
    position: relative;
    overflow: hidden;
    min-width: 90px;
  }

  .sm .tab-button {
    height: 40px;
    font: var(--md-sys-typescale-label-large-font);
  }

  .lg .tab-button {
    height: 56px;
    font: var(--md-sys-typescale-title-medium-font);
  }

  .tab-button:hover:not(:disabled) {
    background-color: var(--md-sys-color-surface-container-high);
    color: var(--md-sys-color-on-surface);
  }

  .tab-button.active {
    color: var(--md-sys-color-primary);
  }

  .tab-button:disabled {
    opacity: 0.38;
    cursor: not-allowed;
  }

  .tab-content-wrapper {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 100%;
  }

  .tab-count {
    font: var(--md-sys-typescale-label-small-font);
    opacity: 0.7;
  }

  .active-indicator {
    position: absolute;
    bottom: 0;
    height: 3px;
    background-color: var(--md-sys-color-primary);
    border-radius: 3px 3px 0 0;
    transition: width 200ms, opacity 200ms;
    width: 0;
    opacity: 0;
  }

  .active .active-indicator {
    width: 40px; /* Primary variant indicator width */
    opacity: 1;
  }

  /* Secondary variant - full width indicator */
  .secondary .active .active-indicator {
    width: 100%;
    height: 2px;
  }

  .tab-panel {
    padding-top: 1.5rem;
  }
</style>