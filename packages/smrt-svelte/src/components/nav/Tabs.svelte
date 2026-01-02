<script lang="ts">
/**
 * Tabs - Tab navigation component
 *
 * Provides tabbed navigation with optional counts and content slots.
 */

import type { Snippet } from 'svelte';

export interface Tab {
  /** Tab identifier */
  id: string;
  /** Display label */
  label: string;
  /** Optional count badge */
  count?: number;
  /** Disabled state */
  disabled?: boolean;
}

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
  variant?: 'underline' | 'pills';
  /** Tab content slot */
  children?: Snippet;
}

const {
  tabs,
  active,
  onchange,
  size = 'md',
  variant = 'underline',
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
    class:pills={variant === 'pills'}
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
      >
        <span class="tab-label">{tab.label}</span>
        {#if tab.count !== undefined}
          <span class="tab-count">{tab.count}</span>
        {/if}
      </button>
    {/each}
  </div>

  {#if children}
    <div class="tab-content" role="tabpanel" id="tab-panel-{active}">
      {@render children()}
    </div>
  {/if}
</div>

<style>
  .tabs-container {
    display: flex;
    flex-direction: column;
  }

  .tabs-nav {
    display: flex;
    gap: 0;
    border-bottom: 1px solid #e5e7eb;
  }

  .tabs-nav.pills {
    border-bottom: none;
    gap: 0.5rem;
    background: #f3f4f6;
    padding: 0.25rem;
    border-radius: 0.5rem;
  }

  .tab-button {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.75rem 1rem;
    font-size: 0.875rem;
    font-weight: 500;
    color: #6b7280;
    background: transparent;
    border: none;
    border-bottom: 2px solid transparent;
    cursor: pointer;
    transition: all 0.15s;
    margin-bottom: -1px;
    white-space: nowrap;
  }

  .sm .tab-button {
    padding: 0.5rem 0.75rem;
    font-size: 0.75rem;
  }

  .lg .tab-button {
    padding: 1rem 1.5rem;
    font-size: 1rem;
  }

  .tab-button:hover:not(:disabled) {
    color: #3b82f6;
  }

  .tab-button.active {
    color: #3b82f6;
    border-bottom-color: #3b82f6;
  }

  .tab-button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  /* Pills variant */
  .pills .tab-button {
    border-bottom: none;
    border-radius: 0.375rem;
    margin-bottom: 0;
  }

  .pills .tab-button.active {
    background: white;
    color: #111827;
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05);
  }

  .tab-count {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 1.25rem;
    height: 1.25rem;
    padding: 0 0.375rem;
    font-size: 0.75rem;
    font-weight: 500;
    background: #e5e7eb;
    color: #374151;
    border-radius: 9999px;
  }

  .tab-button.active .tab-count {
    background: #dbeafe;
    color: #1e40af;
  }

  .tab-content {
    padding-top: 1rem;
  }
</style>
