<script lang="ts" generics="Card extends BoardCard, Column extends BoardColumn">
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { BROWSER } from 'esm-env';
import { untrack } from 'svelte';
import { M } from '../../i18n/strings.board.js';
import {
  createSortable,
  type SortableAnnouncement,
  type SortableMove,
} from '../sortable/controller.svelte.js';
import type {
  BoardCard,
  BoardColumn,
  BoardMoveIntent,
  BoardProps,
} from './types.js';

let {
  columns,
  cards,
  defaultCards = [],
  getCardColumnId,
  setCardColumnId,
  getCardLabel,
  card,
  columnHeader,
  label,
  collapsible = false,
  allowSameColumnReorder = true,
  optimistic = false,
  onselect,
  onmove,
}: BoardProps<Card, Column> = $props();

const { t } = useI18n();
const instanceId = $props.id();
const liveId = `${instanceId}-live`;
let root: HTMLElement;
let localCards = $state<Card[]>(untrack(() => [...defaultCards]));
let optimisticCards = $state<Card[] | undefined>();
let lastAuthoritativeCards = untrack(() => cards);
let collapsed = $state<Set<string>>(new Set());

// A new owner array is an explicit reconciliation point. Do not clear an
// optimistic move merely because this component has re-rendered.
$effect(() => {
  if (!BROWSER) return;
  if (cards !== lastAuthoritativeCards) {
    lastAuthoritativeCards = cards;
    optimisticCards = undefined;
  }
});

const presentationCards = $derived(
  cards === undefined ? localCards : (optimisticCards ?? cards),
);
const cardsByColumn = $derived.by(() => {
  const next = new Map<string, Card[]>();
  for (const column of columns) next.set(column.id, []);
  for (const item of presentationCards) {
    const columnCards = next.get(getCardColumnId(item));
    if (columnCards) columnCards.push(item);
  }
  return next;
});

function laneListId(index: number): string {
  return `${instanceId}-lane-${index}`;
}

function cardsInColumn(columnId: string, withoutCardId?: string): Card[] {
  const items = cardsByColumn.get(columnId) ?? [];
  return withoutCardId
    ? items.filter((item) => item.id !== withoutCardId)
    : items;
}

function findCard(cardId: string): Card | undefined {
  return presentationCards.find((item) => item.id === cardId);
}

function findColumn(columnId: string): Column | undefined {
  return columns.find((column) => column.id === columnId);
}

function intentFor(
  move: SortableMove,
): BoardMoveIntent<Card, Column> | undefined {
  const movingCard = findCard(move.itemId);
  const sourceColumn = findColumn(move.source.containerId);
  const targetColumn = findColumn(move.target.containerId);
  if (!movingCard || !sourceColumn || !targetColumn) return undefined;
  return {
    card: movingCard,
    source: { columnId: move.source.containerId, index: move.source.index },
    target: { columnId: move.target.containerId, index: move.target.index },
    sourceColumn,
    targetColumn,
  };
}

function moveCards(intent: BoardMoveIntent<Card, Column>): Card[] {
  const remaining = presentationCards.filter(
    (item) => item.id !== intent.card.id,
  );
  const insertAt = (() => {
    if (intent.target.index === 0) {
      return remaining.findIndex(
        (item) => getCardColumnId(item) === intent.target.columnId,
      );
    }
    let seen = 0;
    for (let index = 0; index < remaining.length; index += 1) {
      if (getCardColumnId(remaining[index]) !== intent.target.columnId)
        continue;
      seen += 1;
      if (seen === intent.target.index) return index + 1;
    }
    return remaining.length;
  })();

  const moved = setCardColumnId(intent.card, intent.target.columnId);
  return [
    ...remaining.slice(0, insertAt < 0 ? remaining.length : insertAt),
    moved,
    ...remaining.slice(insertAt < 0 ? remaining.length : insertAt),
  ];
}

function message(announcement: SortableAnnouncement): string {
  switch (announcement.type) {
    case 'pickup':
      return t(M['ui.board.pickup'], {
        card: announcement.item,
        destinations: announcement.destinations.join(', '),
      });
    case 'position':
      return t(M['ui.board.position'], {
        card: announcement.item,
        column: announcement.container,
        position: announcement.position,
        count: announcement.count,
      });
    case 'drop':
      return t(M['ui.board.drop'], {
        card: announcement.item,
        column: announcement.container,
        position: announcement.position,
        count: announcement.count,
      });
    case 'unavailable':
      return t(M['ui.board.unavailable_column'], {
        column: announcement.container,
      });
    case 'failed':
      return t(M['ui.board.move_failed'], { card: announcement.item });
    case 'cancel':
      return t(M['ui.board.cancel'], { card: announcement.item });
  }
}

const sortable = createSortable({
  root: () => root,
  selectors: {
    container: '[data-smrt-board-column-id]',
    containerKey: 'smrtBoardColumnId',
    item: '[data-smrt-board-card-id]',
    itemKey: 'smrtBoardCardId',
  },
  containers: () => columns,
  itemIds: (columnId) => cardsInColumn(columnId).map((item) => item.id),
  itemLabel: (cardId) => {
    const found = findCard(cardId);
    return found ? getCardLabel(found) : undefined;
  },
  allowSameContainerReorder: () => allowSameColumnReorder,
  enabled: () => cards === undefined || onmove !== undefined,
  announce: message,
  async commit(move) {
    const intent = intentFor(move);
    if (!intent) return;
    const reordered = moveCards(intent);
    expandColumn(intent.target.columnId);
    if (cards !== undefined && optimistic) optimisticCards = reordered;
    try {
      await onmove?.(intent);
    } catch (error) {
      optimisticCards = undefined;
      throw error;
    }
    if (cards === undefined) localCards = reordered;
  },
});

function selectCard(item: Card): void {
  if (sortable.consumeClick(item.id)) return;
  if (!sortable.drag) onselect?.(item);
}

function expandColumn(columnId: string): void {
  if (!collapsed.has(columnId)) return;
  const next = new Set(collapsed);
  next.delete(columnId);
  collapsed = next;
}

function toggleColumn(columnId: string): void {
  const next = new Set(collapsed);
  if (next.has(columnId)) next.delete(columnId);
  else next.add(columnId);
  collapsed = next;
}
</script>

<section bind:this={root} class="smrt-board" aria-label={label ?? t(M['ui.board.label'])} aria-roledescription="board">
  <div class="smrt-board__lanes">
    {#each columns as column, columnIndex (column.id)}
      {@const items = cardsInColumn(column.id)}
      {@const isCollapsed = collapsed.has(column.id)}
      <section
        class:smrt-board__lane--disabled={column.disabled}
        class="smrt-board__lane"
        aria-label={t(M['ui.board.column'], { label: column.label, count: items.length })}
      >
        <header class="smrt-board__header">
          {#if collapsible}
            <!-- raw-primitive-allow: native button owns collapsible-lane ARIA state -->
            <button
              type="button"
              class="smrt-board__collapse"
              aria-expanded={!isCollapsed}
              aria-controls={laneListId(columnIndex)}
              aria-label={t(isCollapsed ? M['ui.board.expand_column'] : M['ui.board.collapse_column'], { label: column.label })}
              onclick={() => toggleColumn(column.id)}
            >
              <span>{column.label}</span><span aria-hidden="true">{items.length}</span>
            </button>
          {:else}
            <div class="smrt-board__title"><span>{column.label}</span><span>{items.length}</span></div>
          {/if}
          {#if columnHeader}
            {@render columnHeader({ column, count: items.length, collapsed: isCollapsed })}
          {/if}
        </header>
        {#if !isCollapsed}
          <div
            id={laneListId(columnIndex)}
            class="smrt-board__cards"
            role="list"
            data-smrt-board-column-id={column.id}
            ondragover={(event) => event.preventDefault()}
            ondrop={(event) => sortable.dropOnContainer(event, column.id)}
          >
            {#each items as item, index (item.id)}
              <div role="listitem">
                <!-- raw-primitive-allow: native button owns keyboard pickup and HTML drag/drop -->
                <button
                  type="button"
                  class:smrt-board__card--dragging={sortable.drag?.itemId === item.id}
                  class:smrt-board__card--touch-drag={sortable.movable}
                  class="smrt-board__card"
                  data-smrt-board-card-id={item.id}
                  draggable={sortable.nativeDraggable}
                  aria-pressed={sortable.drag?.itemId === item.id}
                  aria-describedby={sortable.drag?.itemId === item.id ? liveId : undefined}
                  onclick={() => selectCard(item)}
                  onkeydown={(event) => sortable.keydown(event, item.id)}
                  onpointerdown={(event) => sortable.pointerDown(event, item.id)}
                  onpointermove={(event) => sortable.pointerMove(event)}
                  onpointerup={(event) => sortable.pointerUp(event)}
                  onpointercancel={(event) => sortable.pointerCancel(event)}
                  ondragstart={(event) => sortable.dragStart(event, item.id)}
                  ondragend={() => sortable.dragEnd()}
                  ondragover={(event) => event.preventDefault()}
                  ondrop={(event) => sortable.dropOnItem(event, column.id, index)}
                >
                  {@render card({ card: item, column, index, isDragging: sortable.drag?.itemId === item.id })}
                </button>
              </div>
            {:else}
              <div role="listitem" class="smrt-board__empty">
                {t(M['ui.board.empty_column'], { column: column.label })}
              </div>
            {/each}
          </div>
        {/if}
      </section>
    {/each}
  </div>
  <div id={liveId} class="smrt-board__live" aria-live="assertive" aria-atomic="true">{sortable.announcement}</div>
</section>

<style>
  .smrt-board { min-width: 0; }
  .smrt-board__lanes { display: flex; gap: var(--smrt-spacing-4); overflow-x: auto; overscroll-behavior-x: contain; padding-block-end: var(--smrt-spacing-2); }
  .smrt-board__lane { display: grid; grid-template-rows: auto minmax(0, 1fr); flex: 0 0 min(18rem, 82vw); min-block-size: 12rem; max-block-size: min(42rem, 70vh); border: 1px solid var(--smrt-color-outline-variant); border-radius: var(--smrt-radius-md); background: var(--smrt-color-surface-container); overflow: hidden; }
  .smrt-board__lane--disabled { opacity: 0.6; }
  .smrt-board__header { display: flex; align-items: center; justify-content: space-between; gap: var(--smrt-spacing-2); min-block-size: 2.75rem; padding: 0 var(--smrt-spacing-3); border-block-end: 1px solid var(--smrt-color-outline-variant); }
  .smrt-board__title, .smrt-board__collapse { display: flex; align-items: center; justify-content: space-between; gap: var(--smrt-spacing-2); inline-size: 100%; color: inherit; font: var(--smrt-typography-label-large-font); }
  .smrt-board__collapse { padding: 0; border: 0; background: transparent; cursor: pointer; text-align: start; }
  .smrt-board__collapse:focus-visible, .smrt-board__card:focus-visible { outline: 2px solid var(--smrt-color-primary); outline-offset: 2px; }
  .smrt-board__cards { display: grid; align-content: start; gap: var(--smrt-spacing-2); min-block-size: 0; overflow-y: auto; overscroll-behavior-y: contain; padding: var(--smrt-spacing-3); }
  .smrt-board__card { display: block; inline-size: 100%; padding: var(--smrt-spacing-3); border: 1px solid var(--smrt-color-outline-variant); border-radius: var(--smrt-radius-sm); background: var(--smrt-color-surface); color: inherit; cursor: grab; text-align: start; }
  .smrt-board__card--touch-drag { touch-action: none; }
  .smrt-board__card:active { cursor: grabbing; }
  .smrt-board__card--dragging { opacity: 0.55; }
  .smrt-board__empty { margin: 0; color: var(--smrt-color-on-surface-variant); font: var(--smrt-typography-body-small-font); }
  .smrt-board__live { position: absolute; inline-size: 1px; block-size: 1px; overflow: hidden; clip: rect(0 0 0 0); clip-path: inset(50%); white-space: nowrap; }
  @media (prefers-reduced-motion: reduce) { .smrt-board__card { scroll-behavior: auto; } }
</style>
