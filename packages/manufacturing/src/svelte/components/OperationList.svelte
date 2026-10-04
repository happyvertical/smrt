<script lang="ts">
/**
 * OperationList — a table of operations: code, name, category and status,
 * with optional edit, retire and reinstate actions. Presentational: the host
 * loads operations through `OperationService`, adapts them to
 * `OperationView`, and performs the retire or reinstate it is asked for. A
 * retired operation stays in the list so history stays readable; the host
 * decides whether to include retired rows.
 */

import { Button, StatusBadge } from '@happyvertical/smrt-ui';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { M } from '../i18n.js';
import { type OperationView, operationStatusBadgeKey } from '../types.js';

const { t } = useI18n();

export interface OperationListProps {
  /** Operations to show, in the host's order. */
  operations: OperationView[];
  /** Invoked with the operation id when a name is activated (to edit). */
  onselect?: (id: string) => void;
  /** Invoked with the id to retire an active operation; omit to hide the action. */
  onretire?: (id: string) => void;
  /** Invoked with the id to reinstate a retired operation; omit to hide the action. */
  onreinstate?: (id: string) => void;
  /** Message shown when there are no operations. */
  emptyMessage?: string;
}

const {
  operations,
  onselect,
  onretire,
  onreinstate,
  emptyMessage,
}: OperationListProps = $props();

const showActions = $derived(Boolean(onretire || onreinstate));
</script>

{#if operations.length === 0}
  <p class="operation-list-empty">
    {emptyMessage ?? t(M['manufacturing.operation_list.empty'])}
  </p>
{:else}
  <div class="operation-list-scroll">
    <table class="operation-list">
      <caption class="operation-list-caption">{t(M['manufacturing.operation_list.caption'])}</caption>
      <thead>
        <tr>
          <th scope="col">{t(M['manufacturing.operation_list.code'])}</th>
          <th scope="col">{t(M['manufacturing.operation_list.name'])}</th>
          <th scope="col">{t(M['manufacturing.operation_list.category'])}</th>
          <th scope="col">{t(M['manufacturing.operation_list.status'])}</th>
          {#if showActions}
            <th scope="col">{t(M['manufacturing.operation_list.actions'])}</th>
          {/if}
        </tr>
      </thead>
      <tbody>
        {#each operations as operation (operation.id)}
          <tr>
            <th scope="row" class="operation-list-code">{operation.code}</th>
            <td>
              {#if onselect}
                <Button
                  variant="ghost"
                  size="sm"
                  onclick={() => onselect(operation.id)}
                  aria-label={t(M['manufacturing.operation_list.select_aria'], { name: operation.name })}
                >
                  {operation.name}
                </Button>
              {:else}
                {operation.name}
              {/if}
            </td>
            <td>
              {#if operation.category}
                {operation.category}
              {:else}
                <span class="operation-list-none">{t(M['manufacturing.operation_list.none'])}</span>
              {/if}
            </td>
            <td>
              <StatusBadge
                status={operationStatusBadgeKey(operation.isActive)}
                label={operation.isActive
                  ? t(M['manufacturing.operation_list.active'])
                  : t(M['manufacturing.operation_list.retired'])}
                size="sm"
              />
            </td>
            {#if showActions}
              <td>
                {#if operation.isActive && onretire}
                  <Button
                    variant="ghost"
                    size="sm"
                    onclick={() => onretire(operation.id)}
                    aria-label={t(M['manufacturing.operation_list.retire_aria'], { name: operation.name })}
                  >
                    {t(M['manufacturing.operation_list.retire'])}
                  </Button>
                {:else if !operation.isActive && onreinstate}
                  <Button
                    variant="ghost"
                    size="sm"
                    onclick={() => onreinstate(operation.id)}
                    aria-label={t(M['manufacturing.operation_list.reinstate_aria'], { name: operation.name })}
                  >
                    {t(M['manufacturing.operation_list.reinstate'])}
                  </Button>
                {/if}
              </td>
            {/if}
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
{/if}

<style>
  .operation-list-scroll {
    overflow-x: auto;
  }

  .operation-list {
    width: 100%;
    border-collapse: collapse;
  }

  .operation-list-caption {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }

  .operation-list th,
  .operation-list td {
    padding: 0.5rem 0.75rem;
    text-align: left;
    border-bottom: 1px solid var(--smrt-color-outline-variant, transparent);
  }

  .operation-list thead th {
    font-size: var(--smrt-typography-label-small-size, 0.75rem);
    font-weight: var(--smrt-typography-label-small-weight, 500);
    color: var(--smrt-color-on-surface-variant, inherit);
  }

  .operation-list-code {
    font-weight: var(--smrt-typography-title-small-weight, 500);
    font-variant-numeric: tabular-nums;
  }

  .operation-list-none,
  .operation-list-empty {
    color: var(--smrt-color-on-surface-variant, inherit);
  }

  .operation-list-empty {
    padding: 1rem 0;
  }
</style>
