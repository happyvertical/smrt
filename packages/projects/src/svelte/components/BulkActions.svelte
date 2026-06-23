<script lang="ts">
/**
 * BulkActions - Action bar for bulk operations on selected items
 * Appears when items are selected in a list
 */

import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button } from '@happyvertical/smrt-ui/ui';
import { M } from '../i18n.js';

const { t } = useI18n();

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
        <Button
          variant="ghost"
          size="sm"
          class="clear-action"
          onclick={onclear}
          disabled={loading}
        >
          Clear
        </Button>
      {/if}
    </div>

    <div class="actions">
      {#if onapprove}
        <Button variant="primary" onclick={onapprove} disabled={loading}>
          {t(M['projects.bulk_actions.approve_all'])}
        </Button>
      {/if}

      {#if onreject}
        <Button variant="danger" onclick={onreject} disabled={loading}>
          {t(M['projects.bulk_actions.reject_all'])}
        </Button>
      {/if}

      {#if onexport}
        <Button variant="secondary" onclick={onexport} disabled={loading}>
          Export
        </Button>
      {/if}

      {#if ondelete}
        <Button variant="danger" onclick={ondelete} disabled={loading}>
          Delete
        </Button>
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
    background: var(--smrt-color-secondary-container);
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: var(--smrt-radius-medium, 12px);
    margin-bottom: 1rem;
  }

  .selection-info {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .count {
    font-size: var(--smrt-typography-title-medium-size, 1rem);
    font-weight: var(--smrt-typography-title-medium-weight, 500);
    color: var(--smrt-color-on-secondary-container);
  }

  .label {
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
    color: var(--smrt-color-on-secondary-container);
  }

  /* Keep the bespoke text-link look for the migrated Clear Button. The
     :global() pierces into the Button child's rendered <button>, which carries
     its own scope hash (see #1589 scoping rule). */
  .selection-info :global(.clear-action) {
    padding: 0.25rem 0.5rem;
    font-size: var(--smrt-typography-label-medium-size, 0.75rem);
    text-decoration: underline;
  }

  .actions {
    display: flex;
    gap: 0.5rem;
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

    .actions :global(.button) {
      flex: 1;
      min-width: 100px;
    }
  }
</style>
