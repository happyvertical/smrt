<script lang="ts">
/**
 * ActionBar - Bulk action bar for selected assets
 *
 * Appears when one or more assets are selected. Shows selection count,
 * default actions (delete), and any custom actions passed by the consumer.
 */

import type { ActionBarProps } from './types';

let {
  selectedAssets,
  customActions = [],
  onClearSelection,
  onDelete,
}: ActionBarProps = $props();

let isDeleting = $state(false);
let showDeleteConfirm = $state(false);

function handleDelete() {
  showDeleteConfirm = true;
}

async function confirmDelete() {
  isDeleting = true;
  try {
    await onDelete(selectedAssets);
  } finally {
    isDeleting = false;
    showDeleteConfirm = false;
  }
}

function cancelDelete() {
  showDeleteConfirm = false;
}

async function handleCustomAction(
  action: (selected: typeof selectedAssets) => void | Promise<void>,
) {
  await action(selectedAssets);
}

const count = $derived(selectedAssets.length);
</script>

{#if count > 0}
  <div class="action-bar">
    <div class="action-bar__left">
      <span class="action-bar__count">{count} selected</span>
      <button type="button" class="action-bar__clear" onclick={onClearSelection}>
        Clear
      </button>
    </div>

    <div class="action-bar__actions">
      {#each customActions as ca (ca.label)}
        {#if ca.multi !== false || count === 1}
          <button
            type="button"
            class="action-btn"
            class:action-btn--destructive={ca.destructive}
            onclick={() => handleCustomAction(ca.action)}
          >
            {#if ca.icon}
              {@render ca.icon()}
            {/if}
            {ca.label}
          </button>
        {/if}
      {/each}

      <!-- Default: Delete -->
      <button type="button" class="action-btn action-btn--destructive" onclick={handleDelete}>
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="3 6 5 6 21 6"></polyline>
          <path d="M19 6l-2 14H7L5 6"></path>
          <path d="M10 11v6"></path>
          <path d="M14 11v6"></path>
          <path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2"></path>
        </svg>
        Delete
      </button>
    </div>
  </div>

  <!-- Delete confirmation inline dialog -->
  {#if showDeleteConfirm}
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <div
      class="confirm-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Confirm delete"
      tabindex="-1"
      onclick={(e) => { if (e.target === e.currentTarget) cancelDelete(); }}
      onkeydown={(e) => { if (e.key === 'Escape') cancelDelete(); }}
    >
      <div class="confirm-card">
        <h3 class="confirm-title">Delete {count} asset{count > 1 ? 's' : ''}?</h3>
        <p class="confirm-message">This action cannot be undone. The asset{count > 1 ? 's' : ''} and {count > 1 ? 'their' : 'its'} file data will be permanently removed.</p>
        <div class="confirm-actions">
          <button type="button" class="confirm-btn confirm-btn--cancel" onclick={cancelDelete} disabled={isDeleting}>
            Cancel
          </button>
          <button type="button" class="confirm-btn confirm-btn--delete" onclick={confirmDelete} disabled={isDeleting}>
            {#if isDeleting}
              <span class="spinner"></span>
            {/if}
            Delete
          </button>
        </div>
      </div>
    </div>
  {/if}
{/if}

<style>
  .action-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--smrt-spacing-3, 0.75rem);
    padding: var(--smrt-spacing-2, 0.5rem) var(--smrt-spacing-4, 1rem);
    background: var(--smrt-color-primary-container, #dbeafe);
    border-bottom: 1px solid var(--smrt-color-outline-variant, #e5e7eb);
    animation: slideDown 200ms ease;
  }

  @keyframes slideDown {
    from { transform: translateY(-100%); opacity: 0; }
    to { transform: translateY(0); opacity: 1; }
  }

  .action-bar__left {
    display: flex;
    align-items: center;
    gap: var(--smrt-spacing-2, 0.5rem);
  }

  .action-bar__count {
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
    font-weight: 600;
    color: var(--smrt-color-on-primary-container, #002d6c);
  }

  .action-bar__clear {
    padding: 2px 8px;
    border: none;
    background: transparent;
    font-family: inherit;
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
    color: var(--smrt-color-primary, #005ac1);
    cursor: pointer;
    border-radius: var(--smrt-radius-small, 0.25rem);
  }

  .action-bar__clear:hover {
    background: rgba(0, 0, 0, 0.05);
  }

  .action-bar__actions {
    display: flex;
    align-items: center;
    gap: var(--smrt-spacing-2, 0.5rem);
  }

  .action-btn {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    height: 32px;
    padding: 0 var(--smrt-spacing-3, 0.75rem);
    font-family: inherit;
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
    font-weight: 500;
    border: 1px solid var(--smrt-color-outline-variant, #e5e7eb);
    background: var(--smrt-color-surface, #ffffff);
    color: var(--smrt-color-on-surface, #111827);
    border-radius: var(--smrt-radius-medium, 0.5rem);
    cursor: pointer;
    transition: all 150ms ease;
  }

  .action-btn:hover {
    box-shadow: var(--smrt-elevation-level1, 0 1px 2px rgba(0,0,0,0.05));
  }

  .action-btn--destructive {
    border-color: var(--smrt-color-error, #dc2626);
    color: var(--smrt-color-error, #dc2626);
  }

  .action-btn--destructive:hover {
    background: var(--smrt-color-error-container, #fef2f2);
  }

  /* Confirm overlay */
  .confirm-overlay {
    position: fixed;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(0, 0, 0, 0.4);
    backdrop-filter: blur(2px);
    z-index: var(--smrt-z-index-dialog, 1000);
    padding: 1rem;
  }

  .confirm-card {
    background: var(--smrt-color-surface-container-high, #ffffff);
    border-radius: 28px;
    padding: 24px;
    max-width: 400px;
    width: 100%;
    box-shadow: var(--smrt-elevation-level3);
    animation: dialogEnter 300ms cubic-bezier(0.2, 0, 0, 1);
  }

  @keyframes dialogEnter {
    from { opacity: 0; transform: translateY(20px) scale(0.9); }
    to { opacity: 1; transform: translateY(0) scale(1); }
  }

  .confirm-title {
    margin: 0 0 16px;
    font-size: 1.125rem;
    font-weight: 600;
    color: var(--smrt-color-on-surface, #111827);
  }

  .confirm-message {
    margin: 0 0 24px;
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
    color: var(--smrt-color-on-surface-variant, #6b7280);
    line-height: 1.5;
  }

  .confirm-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }

  .confirm-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 40px;
    padding: 0 24px;
    font-family: inherit;
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
    font-weight: 500;
    border-radius: 20px;
    cursor: pointer;
    border: none;
    transition: all 200ms ease;
  }

  .confirm-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .confirm-btn--cancel {
    background: transparent;
    color: var(--smrt-color-primary, #005ac1);
  }

  .confirm-btn--cancel:hover:not(:disabled) {
    background: var(--smrt-color-surface-container-highest, #e0e2ec);
  }

  .confirm-btn--delete {
    background: var(--smrt-color-error, #dc2626);
    color: var(--smrt-color-on-error, #ffffff);
    box-shadow: var(--smrt-elevation-level1);
  }

  .confirm-btn--delete:hover:not(:disabled) {
    box-shadow: var(--smrt-elevation-level2);
  }

  .spinner {
    width: 16px;
    height: 16px;
    border: 2px solid transparent;
    border-top-color: currentColor;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  @media (prefers-reduced-motion: reduce) {
    .action-bar, .confirm-card {
      animation: none;
    }
    .spinner {
      animation: none;
    }
  }
</style>
