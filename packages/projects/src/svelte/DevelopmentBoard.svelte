<script lang="ts">
import {
  Board,
  type BoardCard,
  type BoardColumn,
} from '@happyvertical/smrt-svelte/board';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import type { DevelopmentRequestView } from './delivery-types.js';
import { M } from './i18n.js';

interface DevelopmentBoardCard extends BoardCard {
  request: DevelopmentRequestView;
  columnId: string;
}

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
const boardColumns = $derived<BoardColumn[]>(
  columns.map((column) => ({
    id: column.toLowerCase(),
    label: column.replaceAll('_', ' '),
  })),
);
const cards = $derived<DevelopmentBoardCard[]>(
  requests.map((request) => ({
    id: request.id,
    request,
    columnId: (request.deliveryStatus || request.status).toLowerCase(),
  })),
);
const cardLabel = (card: DevelopmentBoardCard) =>
  card.request.title ?? card.request.description;
</script>

{#if requests.length === 0}
  <section
    class="empty"
    aria-label={t(M['projects.development_board.aria'])}
  >
    <p>{t(M['projects.development_board.empty'])}</p>
  </section>
{:else}
  <Board
    columns={boardColumns}
    {cards}
    label={t(M['projects.development_board.aria'])}
    getCardColumnId={(card) => card.columnId}
    setCardColumnId={(card, columnId) => ({ ...card, columnId })}
    getCardLabel={cardLabel}
    onselect={(card) => onselect?.(card.request)}
  >
    {#snippet card({ card })}
      <strong>{card.request.title ?? card.request.description}</strong>
      <small>
        {card.request.type}
        {card.request.requesterLabel
          ? ` · ${card.request.requesterLabel}`
          : ''}
      </small>
    {/snippet}
  </Board>
{/if}

<style>
  .empty {
    color: var(--smrt-color-on-surface-variant);
    margin: 0;
    padding: var(--smrt-spacing-5) var(--smrt-spacing-1);
  }
  small {
    color: var(--smrt-color-on-surface-variant);
  }
</style>
