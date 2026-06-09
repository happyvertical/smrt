<script lang="ts">
/**
 * ModulePanel - Shell component for rendering module UI slots
 *
 * Dynamically renders a module's registered UI component by looking up
 * the component in the ModuleUIRegistry.
 *
 * Usage:
 * 1. Import ModulePanel from '@happyvertical/smrt-svelte'
 * 2. Import the module's svelte package to register components
 * 3. Use ModulePanel with moduleName and slotId props
 */

import type {
  ModuleUIBaseProps,
  SmrtModuleMeta,
} from '@happyvertical/smrt-types';
import { ModuleUIRegistry } from '../../registry/module-registry.js';

interface Props extends ModuleUIBaseProps {
  /** Module name (e.g., '@happyvertical/smrt-commerce') */
  moduleName: string;
  /** Slot ID to render */
  slotId: string;
}

const {
  moduleName,
  slotId,
  data,
  config,
  onChange,
  onSave,
  readonly = false,
  loading = false,
  class: className = '',
}: Props = $props();

// Get the component and slot metadata from registry
const Component = $derived(ModuleUIRegistry.get(moduleName, slotId));
const moduleMeta = $derived(ModuleUIRegistry.getModuleMeta(moduleName));
const slotMeta = $derived(moduleMeta?.uiSlots?.[slotId]);
</script>

{#if Component}
  <Component
    {data}
    {config}
    {onChange}
    {onSave}
    {readonly}
    {loading}
    class={className}
  />
{:else}
  <div class="module-panel-placeholder {className}">
    <div class="module-panel-placeholder__icon">
      <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/>
        <polyline points="3.29 7 12 12 20.71 7"/>
        <line x1="12" y1="22" x2="12" y2="12"/>
      </svg>
    </div>
    <p class="module-panel-placeholder__title">
      Component not registered
    </p>
    <code class="module-panel-placeholder__code">
      {moduleName}/{slotId}
    </code>
    <p class="module-panel-placeholder__hint">
      Import the module's Svelte package to register components.
    </p>
    {#if slotMeta}
      <p class="module-panel-placeholder__meta">
        Expected: <strong>{slotMeta.label}</strong>
        {#if slotMeta.description}
          — {slotMeta.description}
        {/if}
      </p>
    {/if}
  </div>
{/if}

<style>
  .module-panel-placeholder {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 2rem;
    text-align: center;
    background: var(--smrt-color-surface-container-low, #f8fafc);
    border: 1px dashed var(--smrt-color-outline-variant, #e2e8f0);
    border-radius: var(--smrt-radius-medium, 8px);
    min-height: 150px;
    gap: 0.75rem;
  }

  .module-panel-placeholder__icon {
    color: var(--smrt-color-on-surface-variant, #94a3b8);
    opacity: 0.6;
  }

  .module-panel-placeholder__title {
    margin: 0;
    font-size: var(--smrt-typography-title-medium-size, 1rem);
    font-weight: var(--smrt-typography-weight-semibold, 600);
    color: var(--smrt-color-on-surface, #1e293b);
  }

  .module-panel-placeholder__code {
    font-family: var(--smrt-font-family-mono, 'SF Mono', 'Monaco', 'Consolas', monospace);
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
    padding: var(--smrt-spacing-1, 0.25rem) var(--smrt-spacing-2, 0.5rem);
    background: var(--smrt-color-surface-container-high, #e2e8f0);
    border-radius: var(--smrt-radius-small, 4px);
    color: var(--smrt-color-on-surface-variant, #64748b);
  }

  .module-panel-placeholder__hint {
    margin: 0;
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
    color: var(--smrt-color-on-surface-variant, #64748b);
  }

  .module-panel-placeholder__meta {
    margin: 0;
    font-size: var(--smrt-typography-body-small-size, 0.75rem);
    color: var(--smrt-color-on-surface-variant, #94a3b8);
  }
</style>
