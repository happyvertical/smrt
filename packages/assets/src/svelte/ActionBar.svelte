<script lang="ts">
/**
 * ActionBar - Bulk action bar for selected assets
 *
 * Appears when one or more assets are selected. Shows selection count,
 * default actions (delete), and any custom actions passed by the consumer.
 */

import { ConfirmDialog } from '@happyvertical/smrt-ui/feedback';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { M } from './i18n.js';
import type { ActionBarProps } from './types';

const { t } = useI18n();

let {
  selectedAssets,
  customActions = [],
  onclearselection,
  onClearSelection,
  ondelete,
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
    await (ondelete ?? onDelete)(selectedAssets);
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
      <button
        type="button"
        class="action-bar__clear"
        onclick={() => (onclearselection ?? onClearSelection)()}
      >
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

  <!-- Delete confirmation — library ConfirmDialog (S10 #1415) -->
  <ConfirmDialog
    open={showDeleteConfirm}
    title={t(M['assets.action_bar.delete_confirm_title'], {
      count,
      plural: count > 1 ? 's' : '',
    })}
    message={count > 1
      ? t(M['assets.action_bar.delete_confirm_message_other'])
      : t(M['assets.action_bar.delete_confirm_message_one'])}
    confirmLabel={t(M['assets.action_bar.delete'])}
    cancelLabel={t(M['assets.action_bar.cancel'])}
    destructive
    loading={isDeleting}
    onconfirm={confirmDelete}
    oncancel={cancelDelete}
  />
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
    font-weight: var(--smrt-typography-weight-semibold, 600);
    color: var(--smrt-color-on-primary-container, #002d6c);
  }

  .action-bar__clear {
    padding: var(--smrt-spacing-1, 4px) var(--smrt-spacing-2, 8px);
    border: none;
    background: transparent;
    font-family: inherit;
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
    color: var(--smrt-color-primary, #005ac1);
    cursor: pointer;
    border-radius: var(--smrt-radius-small, 0.25rem);
  }

  .action-bar__clear:hover {
    background: color-mix(in srgb, var(--smrt-color-shadow) 5%, transparent);
  }

  .action-bar__actions {
    display: flex;
    align-items: center;
    gap: var(--smrt-spacing-2, 0.5rem);
  }

  .action-btn {
    display: inline-flex;
    align-items: center;
    gap: var(--smrt-spacing-1, 4px);
    height: 32px;
    padding: 0 var(--smrt-spacing-3, 0.75rem);
    font-family: inherit;
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
    font-weight: var(--smrt-typography-weight-medium, 500);
    border: 1px solid var(--smrt-color-outline-variant, #e5e7eb);
    background: var(--smrt-color-surface, #ffffff);
    color: var(--smrt-color-on-surface, #111827);
    border-radius: var(--smrt-radius-medium, 0.5rem);
    cursor: pointer;
    transition: all 150ms ease;
  }

  .action-btn:hover {
    box-shadow: var(--smrt-elevation-1, 0 1px 2px rgba(0,0,0,0.05));
  }

  .action-btn--destructive {
    border-color: var(--smrt-color-error, #dc2626);
    color: var(--smrt-color-error, #dc2626);
  }

  .action-btn--destructive:hover {
    background: var(--smrt-color-error-container, #fef2f2);
  }

  @media (prefers-reduced-motion: reduce) {
    .action-bar {
      animation: none;
    }
  }
</style>
