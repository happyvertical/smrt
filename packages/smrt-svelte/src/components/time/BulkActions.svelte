<script lang="ts">
/**
 * BulkActions - Action bar for bulk operations on selected items
 * Appears when items are selected in a list
 */

interface Props {
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
          class="btn btn-success"
          onclick={onapprove}
          disabled={loading}
        >
          Approve All
        </button>
      {/if}

      {#if onreject}
        <button
          type="button"
          class="btn btn-danger"
          onclick={onreject}
          disabled={loading}
        >
          Reject All
        </button>
      {/if}

      {#if onexport}
        <button
          type="button"
          class="btn btn-secondary"
          onclick={onexport}
          disabled={loading}
        >
          Export
        </button>
      {/if}

      {#if ondelete}
        <button
          type="button"
          class="btn btn-danger-outline"
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
    background: var(--color-primary-bg, #eff6ff);
    border: 1px solid var(--color-primary-border, #bfdbfe);
    border-radius: var(--radius-md, 8px);
    margin-bottom: 1rem;
  }

  .selection-info {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .count {
    font-size: 1.25rem;
    font-weight: 700;
    color: var(--color-primary, #3b82f6);
  }

  .label {
    font-size: 0.875rem;
    color: var(--color-text-muted, #6b7280);
  }

  .clear-btn {
    background: none;
    border: none;
    padding: 0.25rem 0.5rem;
    font-size: 0.75rem;
    color: var(--color-primary, #3b82f6);
    cursor: pointer;
    text-decoration: underline;
  }

  .clear-btn:hover:not(:disabled) {
    color: var(--color-primary-dark, #2563eb);
  }

  .clear-btn:disabled {
    opacity: 0.5;
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
    font-size: 0.8125rem;
    font-weight: 500;
    border-radius: var(--radius-md, 8px);
    border: 2px solid transparent;
    cursor: pointer;
    transition: all 0.15s;
  }

  .btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .btn-success {
    background: var(--color-success, #10b981);
    color: white;
  }

  .btn-success:hover:not(:disabled) {
    background: var(--color-success-dark, #059669);
  }

  .btn-danger {
    background: var(--color-error, #ef4444);
    color: white;
  }

  .btn-danger:hover:not(:disabled) {
    background: var(--color-error-dark, #dc2626);
  }

  .btn-danger-outline {
    background: transparent;
    border-color: var(--color-error, #ef4444);
    color: var(--color-error, #ef4444);
  }

  .btn-danger-outline:hover:not(:disabled) {
    background: var(--color-error, #ef4444);
    color: white;
  }

  .btn-secondary {
    background: white;
    border-color: var(--color-border, #e5e7eb);
    color: var(--color-text, #1f2937);
  }

  .btn-secondary:hover:not(:disabled) {
    background: var(--color-surface-hover, #f9fafb);
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
