<script lang="ts">
/**
 * BulkActions - Action bar for bulk operations on selected items
 * Appears when items are selected in a list
 */

/** Props for BulkActions component */
export interface Props {
  selectedCount: number;
  onapprove?: () => void;
  onreject?: () => void;
  ondelete?: () => void;
  onexport?: () => void;
  onclear?: () => void;
  loading?: boolean;
}

let {
  selectedCount,
  onapprove,
  onreject,
  ondelete,
  onexport,
  onclear,
  loading = false,
}: Props = $props();

const visible = $derived(selectedCount > 0);
</script>

{#if visible}
  <div class="bulk-actions">
    <div class="selection-info">
      <span class="count">{selectedCount}</span>
      <span class="label">{selectedCount === 1 ? 'item' : 'items'} selected</span>
      {#if onclear}
        <button type="button" class="clear-btn" onclick={onclear} disabled={loading}>
          Clear
        </button>
      {/if}
    </div>

    <div class="actions">
      {#if onapprove}
        <button
          type="button"
          class="btn btn-filled"
          onclick={onapprove}
          disabled={loading}
        >
          Approve All
        </button>
      {/if}

      {#if onreject}
        <button
          type="button"
          class="btn btn-error"
          onclick={onreject}
          disabled={loading}
        >
          Reject All
        </button>
      {/if}

      {#if onexport}
        <button
          type="button"
          class="btn btn-outlined"
          onclick={onexport}
          disabled={loading}
        >
          Export
        </button>
      {/if}

      {#if ondelete}
        <button
          type="button"
          class="btn btn-error-outlined"
          onclick={ondelete}
          disabled={loading}
        >
          Delete
        </button>
      {/if}
    </div>
  </div>
{/if}

<style>
  .bulk-actions {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.75rem 1rem;
    background: var(--md-sys-color-secondary-container);
    border: 1px solid var(--md-sys-color-outline-variant);
    border-radius: var(--md-sys-shape-corner-medium, 12px);
    margin-bottom: 1rem;
  }

  .selection-info {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .count {
    font-size: var(--md-sys-typescale-title-medium-size, 1rem);
    font-weight: var(--md-sys-typescale-title-medium-weight, 500);
    color: var(--md-sys-color-on-secondary-container);
  }

  .label {
    font-size: var(--md-sys-typescale-body-medium-size, 0.875rem);
    color: var(--md-sys-color-on-secondary-container);
  }

  .clear-btn {
    background: none;
    border: none;
    padding: 0.25rem 0.5rem;
    font-size: var(--md-sys-typescale-label-medium-size, 0.75rem);
    color: var(--md-sys-color-primary);
    cursor: pointer;
    text-decoration: underline;
  }

  .clear-btn:hover:not(:disabled) {
    color: var(--md-sys-color-primary);
    opacity: 0.8;
  }

  .clear-btn:disabled {
    opacity: 0.38;
    cursor: not-allowed;
  }

  .actions {
    display: flex;
    gap: 0.5rem;
  }

  .btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
    padding: 0.5rem 1rem;
    font-size: var(--md-sys-typescale-label-large-size, 0.875rem);
    font-weight: var(--md-sys-typescale-label-large-weight, 500);
    letter-spacing: var(--md-sys-typescale-label-large-tracking, 0.1px);
    border-radius: var(--md-sys-shape-corner-full, 9999px);
    border: none;
    cursor: pointer;
    transition: all 0.2s var(--md-sys-motion-easing-standard);
  }

  .btn:disabled {
    opacity: 0.38;
    cursor: not-allowed;
  }

  .btn-filled {
    background: var(--md-sys-color-primary);
    color: var(--md-sys-color-on-primary);
  }

  .btn-filled:hover:not(:disabled) {
    box-shadow: var(--md-sys-elevation-level1);
  }

  .btn-error {
    background: var(--md-sys-color-error);
    color: var(--md-sys-color-on-error);
  }

  .btn-error:hover:not(:disabled) {
    box-shadow: var(--md-sys-elevation-level1);
  }

  .btn-error-outlined {
    background: transparent;
    border: 1px solid var(--md-sys-color-error);
    color: var(--md-sys-color-error);
  }

  .btn-error-outlined:hover:not(:disabled) {
    background: var(--md-sys-color-error-container);
  }

  .btn-outlined {
    background: transparent;
    border: 1px solid var(--md-sys-color-outline);
    color: var(--md-sys-color-on-surface);
  }

  .btn-outlined:hover:not(:disabled) {
    background: var(--md-sys-color-surface-container-highest);
  }

  @media (max-width: 640px) {
    .bulk-actions {
      flex-direction: column;
      gap: 0.75rem;
    }

    .actions {
      width: 100%;
      flex-wrap: wrap;
    }

    .actions .btn {
      flex: 1;
      min-width: 100px;
    }
  }
</style>
