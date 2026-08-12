<script lang="ts" generics="Card extends BoardCard, Column extends BoardColumn">
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { BROWSER } from 'esm-env';
import { tick, untrack } from 'svelte';
import { M } from '../../i18n/strings.board.js';
import type {
  BoardCard,
  BoardColumn,
  BoardMoveIntent,
  BoardPosition,
  BoardProps,
} from './types.js';

interface DragState {
  cardId: string;
  source: BoardPosition;
  target: BoardPosition;
  mode: 'keyboard' | 'pointer';
}

interface PointerSession {
  cardId: string;
  pointerId: number;
  startX: number;
  startY: number;
  active: boolean;
}

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
let drag = $state<DragState | undefined>();
let collapsed = $state<Set<string>>(new Set());
let announcement = $state('');
let focusCardId = $state<string | undefined>();
let suppressedSelectionCardId = $state<string | undefined>();
let movePending = $state(false);
let pointerSession = $state<PointerSession | undefined>();

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
const movable = $derived(
  (cards === undefined || onmove !== undefined) && !movePending,
);

$effect(() => {
  if (!BROWSER) return;
  if (!focusCardId) return;
  const cardId = focusCardId;
  focusCardId = undefined;
  tick().then(() => {
    Array.from(
      root.querySelectorAll<HTMLButtonElement>('[data-smrt-board-card-id]'),
    )
      .find((element) => element.dataset.smrtBoardCardId === cardId)
      ?.focus();
  });
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

function positionFor(cardId: string): BoardPosition | undefined {
  const item = findCard(cardId);
  if (!item) return undefined;
  const columnId = getCardColumnId(item);
  const index = cardsInColumn(columnId).findIndex(
    (candidate) => candidate.id === cardId,
  );
  return index < 0 ? undefined : { columnId, index };
}

function clamp(index: number, max: number): number {
  return Math.max(0, Math.min(index, max));
}

function createIntent(
  state: DragState,
): BoardMoveIntent<Card, Column> | undefined {
  const movingCard = findCard(state.cardId);
  const sourceColumn = findColumn(state.source.columnId);
  const targetColumn = findColumn(state.target.columnId);
  if (!movingCard || !sourceColumn || !targetColumn || targetColumn.disabled)
    return undefined;
  return {
    card: movingCard,
    source: state.source,
    target: state.target,
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

function pickup(cardId: string, mode: DragState['mode']): void {
  if (!movable) return;
  const source = positionFor(cardId);
  const movingCard = findCard(cardId);
  if (!source || !movingCard) return;
  drag = { cardId, source, target: { ...source }, mode };
  announcement = t(M['ui.board.pickup'], {
    card: getCardLabel(movingCard),
    destinations: columns
      .filter((column) => !column.disabled)
      .map((column) => column.label)
      .join(', '),
  });
}

function announcePosition(state: DragState): void {
  const movingCard = findCard(state.cardId);
  const column = findColumn(state.target.columnId);
  if (!movingCard || !column) return;
  const count = cardsInColumn(column.id, state.cardId).length + 1;
  announcement = t(M['ui.board.position'], {
    card: getCardLabel(movingCard),
    column: column.label,
    position: state.target.index + 1,
    count,
  });
}

function moveKeyboardTarget(
  direction: 'horizontal' | 'vertical',
  delta: number,
): void {
  if (drag?.mode !== 'keyboard') return;
  const target = { ...drag.target };
  if (direction === 'vertical') {
    if (!allowSameColumnReorder) return;
    target.index = clamp(
      target.index + delta,
      cardsInColumn(target.columnId, drag.cardId).length,
    );
  } else {
    const currentIndex = columns.findIndex(
      (column) => column.id === target.columnId,
    );
    const candidate = columns[currentIndex + delta];
    if (!candidate) return;
    if (candidate.disabled) {
      announcement = t(M['ui.board.unavailable_column'], {
        column: candidate.label,
      });
      return;
    }
    target.columnId = candidate.id;
    target.index = clamp(
      target.index,
      cardsInColumn(candidate.id, drag.cardId).length,
    );
  }
  drag = { ...drag, target };
  announcePosition(drag);
}

async function drop(): Promise<void> {
  if (!drag) return;
  const state = drag;
  const intent = createIntent(state);
  drag = undefined;
  suppressSelection(state.cardId);
  if (!intent) return;
  const changed =
    intent.source.columnId !== intent.target.columnId ||
    intent.source.index !== intent.target.index;
  if (!changed) {
    focusCardId = intent.card.id;
    return;
  }
  const reordered = moveCards(intent);
  expandColumn(intent.target.columnId);
  if (cards !== undefined && optimistic) optimisticCards = reordered;
  movePending = true;
  try {
    await onmove?.(intent);
  } catch {
    optimisticCards = undefined;
    announcement = t(M['ui.board.move_failed'], {
      card: getCardLabel(intent.card),
    });
    focusCardId = intent.card.id;
    return;
  } finally {
    movePending = false;
  }
  if (cards === undefined) localCards = reordered;
  const count =
    cardsInColumn(intent.target.columnId, intent.card.id).length + 1;
  announcement = t(M['ui.board.drop'], {
    card: getCardLabel(intent.card),
    column: intent.targetColumn.label,
    position: intent.target.index + 1,
    count,
  });
  focusCardId = intent.card.id;
}

function cancel(announce = true): void {
  if (!drag) return;
  const movingCard = findCard(drag.cardId);
  if (movingCard && announce) {
    announcement = t(M['ui.board.cancel'], { card: getCardLabel(movingCard) });
  }
  if (movingCard) {
    focusCardId = movingCard.id;
  }
  suppressSelection(drag.cardId);
  drag = undefined;
}

function suppressSelection(cardId: string): void {
  suppressedSelectionCardId = cardId;
  window.setTimeout(() => {
    if (suppressedSelectionCardId === cardId)
      suppressedSelectionCardId = undefined;
  }, 0);
}

function selectCard(item: Card): void {
  // Keyboard pickup/drop and native drag gestures can both dispatch a click
  // after their key/pointer sequence. Consume it so a move never doubles as
  // an application-level selection.
  if (suppressedSelectionCardId === item.id) {
    suppressedSelectionCardId = undefined;
    return;
  }
  if (!drag) onselect?.(item);
}

function handleCardKeydown(event: KeyboardEvent, cardId: string): void {
  if (!drag) {
    if (event.key === ' ' || event.key === 'Enter') {
      if (!movable) return;
      event.preventDefault();
      pickup(cardId, 'keyboard');
    }
    return;
  }
  if (drag.cardId !== cardId || drag.mode !== 'keyboard') return;
  if (event.key === 'Escape') {
    event.preventDefault();
    cancel();
  } else if (event.key === ' ' || event.key === 'Enter') {
    event.preventDefault();
    void drop();
  } else if (event.key === 'ArrowLeft') {
    event.preventDefault();
    moveKeyboardTarget('horizontal', -1);
  } else if (event.key === 'ArrowRight') {
    event.preventDefault();
    moveKeyboardTarget('horizontal', 1);
  } else if (event.key === 'ArrowUp') {
    event.preventDefault();
    moveKeyboardTarget('vertical', -1);
  } else if (event.key === 'ArrowDown') {
    event.preventDefault();
    moveKeyboardTarget('vertical', 1);
  }
}

function handleDragStart(event: DragEvent, cardId: string): void {
  if (!movable) {
    event.preventDefault();
    return;
  }
  pickup(cardId, 'pointer');
  event.dataTransfer?.setData('text/plain', cardId);
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
}

function handlePointerDown(event: PointerEvent, cardId: string): void {
  if (!movable || event.button !== 0) return;
  pointerSession = {
    cardId,
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    active: false,
  };
  const target = event.currentTarget as HTMLElement;
  target.setPointerCapture?.(event.pointerId);
}

function elementAtPointer(event: PointerEvent): Element | null {
  return (
    document.elementFromPoint?.(event.clientX, event.clientY) ??
    (event.target as Element | null)
  );
}

function setPointerTargetFromElement(
  element: Element | null,
  clientY: number,
): Column | undefined {
  // Column ids belong to the consumer's domain and may repeat in another
  // Board instance. Pointer hit-testing must never escape this Board's root.
  if (!element || !root.contains(element)) return undefined;
  const lane = element?.closest<HTMLElement>('[data-smrt-board-column-id]');
  const columnId = lane?.dataset.smrtBoardColumnId;
  if (!columnId) return undefined;
  const column = findColumn(columnId);
  if (!column || column.disabled) return column;
  const cardElement = element?.closest<HTMLElement>(
    '[data-smrt-board-card-id]',
  );
  if (!cardElement) {
    pointerTarget(columnId, cardsInColumn(columnId, drag?.cardId).length);
    return column;
  }
  const rawIndex = cardsInColumn(columnId).findIndex(
    (item) => item.id === cardElement.dataset.smrtBoardCardId,
  );
  if (rawIndex < 0) return column;
  const rect = cardElement.getBoundingClientRect();
  const before = clientY < rect.top + rect.height / 2;
  let targetIndex = rawIndex + (before ? 0 : 1);
  if (drag?.source.columnId === columnId && targetIndex > drag.source.index) {
    targetIndex -= 1;
  }
  pointerTarget(columnId, targetIndex);
  return column;
}

function finishPointerSession(event: PointerEvent, cancelled = false): void {
  const session = pointerSession;
  pointerSession = undefined;
  const target = event.currentTarget as HTMLElement;
  if (target.hasPointerCapture?.(event.pointerId))
    target.releasePointerCapture(event.pointerId);
  if (!session?.active || drag?.cardId !== session.cardId) return;
  if (cancelled) {
    cancel();
    return;
  }
  const column = setPointerTargetFromElement(
    elementAtPointer(event),
    event.clientY,
  );
  if (column?.disabled) {
    announcement = t(M['ui.board.unavailable_column'], {
      column: column.label,
    });
    cancel(false);
    return;
  }
  if (!column) {
    cancel();
    return;
  }
  void drop();
}

function handlePointerMove(event: PointerEvent): void {
  const session = pointerSession;
  if (!session || session.pointerId !== event.pointerId) return;
  if (!session.active) {
    const distance = Math.hypot(
      event.clientX - session.startX,
      event.clientY - session.startY,
    );
    if (distance < 6) return;
    pickup(session.cardId, 'pointer');
    pointerSession = { ...session, active: true };
  }
  event.preventDefault();
  setPointerTargetFromElement(elementAtPointer(event), event.clientY);
}

function pointerTarget(columnId: string, index: number): void {
  if (drag?.mode !== 'pointer') return;
  if (!allowSameColumnReorder && columnId === drag.source.columnId) {
    drag = { ...drag, target: { ...drag.source } };
    return;
  }
  const max = cardsInColumn(columnId, drag.cardId).length;
  drag = { ...drag, target: { columnId, index: clamp(index, max) } };
}

function handleCardDrop(
  event: DragEvent,
  columnId: string,
  rawIndex: number,
): void {
  event.preventDefault();
  if (drag?.mode !== 'pointer') return;
  const targetColumn = findColumn(columnId);
  if (targetColumn?.disabled) {
    announcement = t(M['ui.board.unavailable_column'], {
      column: targetColumn.label,
    });
    cancel(false);
    return;
  }
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
  const before = event.clientY < rect.top + rect.height / 2;
  let targetIndex = rawIndex + (before ? 0 : 1);
  if (drag.source.columnId === columnId && targetIndex > drag.source.index) {
    targetIndex -= 1;
  }
  pointerTarget(columnId, targetIndex);
  void drop();
}

function handleLaneDrop(event: DragEvent, column: Column): void {
  event.preventDefault();
  if (column.disabled) {
    announcement = t(M['ui.board.unavailable_column'], {
      column: column.label,
    });
    cancel(false);
    return;
  }
  pointerTarget(column.id, cardsInColumn(column.id, drag?.cardId).length);
  void drop();
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
            ondrop={(event) => handleLaneDrop(event, column)}
          >
            {#each items as item, index (item.id)}
              <div role="listitem">
                <!-- raw-primitive-allow: native button owns keyboard pickup and HTML drag/drop -->
                <button
                  type="button"
                  class:smrt-board__card--dragging={drag?.cardId === item.id}
                  class:smrt-board__card--touch-drag={movable}
                  class="smrt-board__card"
                  data-smrt-board-card-id={item.id}
                  draggable={movable && pointerSession === undefined}
                  aria-pressed={drag?.cardId === item.id}
                  aria-describedby={drag?.cardId === item.id ? liveId : undefined}
                  onclick={() => selectCard(item)}
                  onkeydown={(event) => handleCardKeydown(event, item.id)}
                  onpointerdown={(event) => handlePointerDown(event, item.id)}
                  onpointermove={handlePointerMove}
                  onpointerup={(event) => finishPointerSession(event)}
                  onpointercancel={(event) => finishPointerSession(event, true)}
                  ondragstart={(event) => handleDragStart(event, item.id)}
                  ondragend={() => { if (drag?.mode === 'pointer') cancel(); }}
                  ondragover={(event) => event.preventDefault()}
                  ondrop={(event) => handleCardDrop(event, column.id, index)}
                >
                  {@render card({ card: item, column, index, isDragging: drag?.cardId === item.id })}
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
  <div id={liveId} class="smrt-board__live" aria-live="assertive" aria-atomic="true">{announcement}</div>
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
