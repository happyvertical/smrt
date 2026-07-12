<script lang="ts">
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import type { DevelopmentRequestView } from './delivery-types.js';
import { M } from './i18n.js';

export interface Props {
  requests?: DevelopmentRequestView[];
  columns?: string[];
  onselect?: (request: DevelopmentRequestView) => void;
}

let {
  requests = [],
  columns = ['submitted', 'triaged', 'planned', 'in_progress', 'completed'],
  onselect,
}: Props = $props();
const { t } = useI18n();
const inColumn = (column: string) =>
  requests.filter(
    (request) =>
      (request.deliveryStatus || request.status).toLowerCase() ===
      column.toLowerCase(),
  );
</script>

<section class="board" aria-label={t(M['projects.development_board.aria'])}>
  {#if requests.length === 0}
    <p class="empty">{t(M['projects.development_board.empty'])}</p>
  {:else}
    {#each columns as column (column)}
      <div class="lane">
        <header>
          <h3>{column.replaceAll('_', ' ')}</h3>
          <span>{inColumn(column).length}</span>
        </header>
        <div class="lane__items">
          {#each inColumn(column) as request (request.id)}
            <!-- raw-primitive-allow: each board row is a semantic selection control -->
            <button type="button" onclick={() => onselect?.(request)}>
              <strong>{request.title ?? request.description}</strong>
              <small>
                {request.type}
                {request.requesterLabel ? ` · ${request.requesterLabel}` : ''}
              </small>
            </button>
          {/each}
        </div>
      </div>
    {/each}
  {/if}
</section>

<style>
  .board {
    display: grid;
    gap: var(--smrt-spacing-5);
    grid-template-columns: repeat(auto-fit, minmax(13rem, 1fr));
    overflow-x: auto;
  }
  .lane {
    min-width: 0;
  }
  .empty {
    color: var(--smrt-color-on-surface-variant);
    grid-column: 1 / -1;
    margin: 0;
    padding: var(--smrt-spacing-5) var(--smrt-spacing-1);
  }
  .lane header {
    align-items: center;
    border-bottom: 2px solid var(--smrt-color-primary);
    display: flex;
    justify-content: space-between;
    padding: var(--smrt-spacing-2) var(--smrt-spacing-1);
  }
  .lane h3 {
    font-size: var(--smrt-typography-label-medium-size);
    margin: 0;
    text-transform: uppercase;
  }
  .lane__items {
    display: grid;
  }
  .lane__items button {
    background: transparent;
    border: 0;
    border-bottom: 1px solid var(--smrt-color-outline-variant);
    color: inherit;
    cursor: pointer;
    display: grid;
    gap: var(--smrt-spacing-1);
    padding: var(--smrt-spacing-4) var(--smrt-spacing-1);
    text-align: left;
    transition: transform 120ms ease;
  }
  .lane__items button:hover,
  .lane__items button:focus-visible {
    transform: translateX(var(--smrt-spacing-1));
  }
  .lane small {
    color: var(--smrt-color-on-surface-variant);
  }
</style>
