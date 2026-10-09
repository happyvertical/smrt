<script lang="ts" generics="Item extends SortableItem, Container extends SortableContainer">
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { M } from '../../i18n/strings.sortable.js';
import { formatSortableAnnouncement } from './announce.js';
import {
  createSortable,
  type SortableAnnouncement,
} from './controller.svelte.js';
import type {
  SortableContainer,
  SortableItem,
  SortableProps,
} from './types.js';

let {
  containers,
  items,
  label,
  reorderContainers = false,
  allowSameContainerReorder = true,
  item: itemSnippet,
  containerHeader,
  onmove,
  oncontainermove,
}: SortableProps<Item, Container> = $props();

const { t } = useI18n();
const instanceId = $props.id();
const itemLiveId = `${instanceId}-item-live`;
const containerLiveId = `${instanceId}-container-live`;
const LIST_ID = '__smrt-sortable-containers__';
let root: HTMLElement;

// Fixed containers lead (in the order given); the rest follow. With
// reordering off, the owner's order is used as is.
const fixed = $derived(
  reorderContainers ? containers.filter((container) => container.fixed) : [],
);
const movable = $derived(
  reorderContainers
    ? containers.filter((container) => !container.fixed)
    : containers,
);
const ordered = $derived([...fixed, ...movable]);
const itemsByContainer = $derived.by(() => {
  const next = new Map<string, Item[]>();
  for (const container of containers) next.set(container.id, []);
  for (const entry of items) next.get(entry.containerId)?.push(entry);
  return next;
});
const itemsById = $derived(new Map(items.map((entry) => [entry.id, entry])));
const containersById = $derived(
  new Map(containers.map((container) => [container.id, container])),
);

function itemMessage(announcement: SortableAnnouncement): string {
  return formatSortableAnnouncement(t, announcement);
}

const itemSortable = createSortable({
  root: () => root,
  selectors: {
    container: '[data-smrt-sortable-container-id]',
    containerKey: 'smrtSortableContainerId',
    item: '[data-smrt-sortable-item-id]',
    itemKey: 'smrtSortableItemId',
  },
  containers: () => ordered,
  itemIds: (containerId) =>
    (itemsByContainer.get(containerId) ?? []).map((entry) => entry.id),
  itemLabel: (itemId) => itemsById.get(itemId)?.label,
  allowSameContainerReorder: () => allowSameContainerReorder,
  enabled: () => onmove !== undefined,
  orientation: () => 'vertical',
  announce: itemMessage,
  focusTarget: (element) =>
    element.querySelector<HTMLElement>('[data-smrt-sortable-handle="item"]'),
  async commit(move) {
    const moving = itemsById.get(move.itemId);
    const sourceContainer = containersById.get(move.source.containerId);
    const targetContainer = containersById.get(move.target.containerId);
    if (!moving || !sourceContainer || !targetContainer) return;
    await onmove?.({
      item: moving,
      source: move.source,
      target: move.target,
      sourceContainer,
      targetContainer,
    });
  },
});

// Containers are sorted by a second engine whose single "container" is the
// list of movable containers and whose "items" are those containers.
const containerSortable = createSortable({
  root: () => root,
  selectors: {
    container: '[data-smrt-sortable-container-list]',
    containerKey: 'smrtSortableContainerList',
    item: '[data-smrt-sortable-container-item]',
    itemKey: 'smrtSortableContainerItem',
  },
  containers: () => [
    { id: LIST_ID, label: label ?? t(M['ui.sortable.label']) },
  ],
  itemIds: () => movable.map((container) => container.id),
  itemLabel: (id) => containersById.get(id)?.label,
  allowSameContainerReorder: () => true,
  enabled: () => reorderContainers && oncontainermove !== undefined,
  orientation: () => 'vertical',
  announce: itemMessage,
  focusTarget: (element) =>
    Array.from(element.children)
      .find((child) => child.tagName === 'HEADER')
      ?.querySelector<HTMLElement>('[data-smrt-sortable-handle="container"]') ??
    null,
  async commit(move) {
    const moving = containersById.get(move.itemId);
    if (!moving) return;
    await oncontainermove?.({
      container: moving,
      source: move.source.index,
      target: move.target.index,
    });
  },
});

/** Items of `containerId` with the drop marker's slot, for rendering. */
function markerBefore(containerId: string, rank: number): boolean {
  const target = itemSortable.drag?.target;
  return target?.containerId === containerId && target.index === rank;
}

function nonDraggedRank(list: readonly Item[], index: number): number {
  const dragged = itemSortable.drag?.itemId;
  let rank = 0;
  for (let i = 0; i < index; i += 1) if (list[i].id !== dragged) rank += 1;
  return rank;
}

function containerMarkerBefore(rank: number): boolean {
  return containerSortable.drag?.target.index === rank;
}

function containerRank(id: string): number {
  const dragged = containerSortable.drag?.itemId;
  let rank = 0;
  for (const container of movable) {
    if (container.id === id) break;
    if (container.id !== dragged) rank += 1;
  }
  return rank;
}
</script>

{#snippet containerBody(container: Container)}
  {@const list = itemsByContainer.get(container.id) ?? []}
  {@const dragged = itemSortable.drag?.itemId}
  {@const count = list.length}
  <div
    class="smrt-sortable__items"
    role="list"
    aria-label={t(M['ui.sortable.group'], { label: container.label, count })}
  >
    {#each list as entry, index (entry.id)}
      {#if markerBefore(container.id, nonDraggedRank(list, index)) && entry.id !== dragged}
        <div class="smrt-sortable__marker" aria-hidden="true"></div>
      {/if}
      <div
        role="listitem"
        class="smrt-sortable__item"
        class:smrt-sortable__item--dragging={dragged === entry.id}
        data-smrt-sortable-item-id={entry.id}
        ondragover={(event) => event.preventDefault()}
        ondrop={(event) => {
          if (!itemSortable.drag) return;
          event.stopPropagation();
          itemSortable.dropOnItem(event, container.id, index);
        }}
      >
        <!-- raw-primitive-allow: native button owns keyboard pickup and HTML drag/drop -->
        <button
          type="button"
          class="smrt-sortable__handle"
          data-smrt-sortable-handle="item"
          draggable={itemSortable.nativeDraggable}
          aria-label={t(M['ui.sortable.move'], { item: entry.label })}
          aria-pressed={dragged === entry.id}
          aria-describedby={dragged === entry.id ? itemLiveId : undefined}
          onclick={() => itemSortable.consumeClick(entry.id)}
          onkeydown={(event) => itemSortable.keydown(event, entry.id)}
          onblur={(event) => itemSortable.blur(event, entry.id)}
          onpointerdown={(event) => itemSortable.pointerDown(event, entry.id)}
          onpointermove={(event) => itemSortable.pointerMove(event)}
          onpointerup={(event) => itemSortable.pointerUp(event)}
          onpointercancel={(event) => itemSortable.pointerCancel(event)}
          ondragstart={(event) => itemSortable.dragStart(event, entry.id)}
          ondragend={() => itemSortable.dragEnd()}
        ><span aria-hidden="true">⠿</span></button>
        <div class="smrt-sortable__content">
          {@render itemSnippet({
            item: entry,
            container,
            index,
            isDragging: dragged === entry.id,
          })}
        </div>
      </div>
    {:else}
      <div role="listitem" class="smrt-sortable__empty">
        {t(M['ui.sortable.empty'], { container: container.label })}
      </div>
    {/each}
    {#if markerBefore(container.id, list.filter((entry) => entry.id !== dragged).length)}
      <div class="smrt-sortable__marker" aria-hidden="true"></div>
    {/if}
  </div>
{/snippet}

{#snippet containerBlock(container: Container, sortableContainer: boolean)}
  {@const count = (itemsByContainer.get(container.id) ?? []).length}
  {@const draggingContainer = containerSortable.drag?.itemId === container.id}
  <section
    class="smrt-sortable__container"
    class:smrt-sortable__container--disabled={container.disabled}
    class:smrt-sortable__container--dragging={draggingContainer}
    data-smrt-sortable-container-id={container.id}
    data-smrt-sortable-container-item={sortableContainer ? container.id : undefined}
    aria-label={container.label}
    ondragover={(event) => event.preventDefault()}
    ondrop={(event) => {
      if (itemSortable.drag) {
        itemSortable.dropOnContainer(event, container.id);
      } else if (sortableContainer) {
        containerSortable.dropOnItem(
          event,
          LIST_ID,
          movable.findIndex((candidate) => candidate.id === container.id),
        );
      }
    }}
  >
    <header class="smrt-sortable__header">
      {#if sortableContainer}
        <!-- raw-primitive-allow: native button owns keyboard pickup and HTML drag/drop -->
        <button
          type="button"
          class="smrt-sortable__handle"
          data-smrt-sortable-handle="container"
          draggable={containerSortable.nativeDraggable}
          aria-label={t(M['ui.sortable.move'], { item: container.label })}
          aria-pressed={draggingContainer}
          aria-describedby={draggingContainer ? containerLiveId : undefined}
          onclick={() => containerSortable.consumeClick(container.id)}
          onkeydown={(event) => containerSortable.keydown(event, container.id)}
          onblur={(event) => containerSortable.blur(event, container.id)}
          onpointerdown={(event) => containerSortable.pointerDown(event, container.id)}
          onpointermove={(event) => containerSortable.pointerMove(event)}
          onpointerup={(event) => containerSortable.pointerUp(event)}
          onpointercancel={(event) => containerSortable.pointerCancel(event)}
          ondragstart={(event) => containerSortable.dragStart(event, container.id)}
          ondragend={() => containerSortable.dragEnd()}
        ><span aria-hidden="true">⠿</span></button>
      {/if}
      <div class="smrt-sortable__content">
        {#if containerHeader}
          {@render containerHeader({ container, count, isDragging: draggingContainer })}
        {:else}
          <strong>{container.label}</strong>
        {/if}
      </div>
    </header>
    {@render containerBody(container)}
  </section>
{/snippet}

<div
  bind:this={root}
  class="smrt-sortable"
  role="group"
  aria-label={label ?? t(M['ui.sortable.label'])}
>
  {#each fixed as container (container.id)}
    {@render containerBlock(container, false)}
  {/each}
  {#if reorderContainers}
    <div
      class="smrt-sortable__containers"
      role="list"
      data-smrt-sortable-container-list={LIST_ID}
    >
      {#each movable as container (container.id)}
        {#if containerMarkerBefore(containerRank(container.id)) && containerSortable.drag?.itemId !== container.id}
          <div class="smrt-sortable__marker" aria-hidden="true"></div>
        {/if}
        <div role="listitem" class="smrt-sortable__container-slot">
          {@render containerBlock(container, true)}
        </div>
      {/each}
      {#if containerMarkerBefore(movable.filter((c) => c.id !== containerSortable.drag?.itemId).length)}
        <div class="smrt-sortable__marker" aria-hidden="true"></div>
      {/if}
    </div>
  {:else}
    {#each movable as container (container.id)}
      {@render containerBlock(container, false)}
    {/each}
  {/if}
  <div id={itemLiveId} class="smrt-sortable__live" aria-live="assertive" aria-atomic="true">{itemSortable.announcement}</div>
  <div id={containerLiveId} class="smrt-sortable__live" aria-live="assertive" aria-atomic="true">{containerSortable.announcement}</div>
</div>

<style>
  .smrt-sortable { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--smrt-spacing-3); min-width: 0; position: relative; }
  .smrt-sortable__containers { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--smrt-spacing-3); min-width: 0; }
  .smrt-sortable__container { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--smrt-spacing-2); padding: var(--smrt-spacing-3); border: 1px solid var(--smrt-color-outline-variant); border-radius: var(--smrt-radius-md); background: var(--smrt-color-surface-container); min-width: 0; }
  .smrt-sortable__container--disabled { opacity: 0.6; }
  .smrt-sortable__container--dragging { opacity: 0.55; }
  .smrt-sortable__header { display: flex; align-items: center; gap: var(--smrt-spacing-2); min-block-size: 2.25rem; }
  .smrt-sortable__content { flex: 1 1 auto; min-width: 0; display: flex; align-items: center; gap: var(--smrt-spacing-2); }
  .smrt-sortable__items { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--smrt-spacing-1); min-block-size: 2.25rem; min-width: 0; }
  .smrt-sortable__item { display: flex; align-items: center; gap: var(--smrt-spacing-2); padding: var(--smrt-spacing-1) var(--smrt-spacing-2); border: 1px solid var(--smrt-color-outline-variant); border-radius: var(--smrt-radius-sm); background: var(--smrt-color-surface); min-width: 0; }
  .smrt-sortable__item--dragging { opacity: 0.55; }
  .smrt-sortable__handle { display: inline-grid; place-items: center; flex: 0 0 auto; inline-size: 2rem; block-size: 2rem; padding: 0; border: 0; border-radius: var(--smrt-radius-sm); background: transparent; color: var(--smrt-color-on-surface-variant); cursor: grab; touch-action: none; }
  .smrt-sortable__handle:active { cursor: grabbing; }
  .smrt-sortable__handle:hover { background: var(--smrt-color-surface-container-high); }
  .smrt-sortable__handle:focus-visible { outline: 2px solid var(--smrt-color-primary); outline-offset: 2px; }
  .smrt-sortable__handle[aria-pressed='true'] { background: var(--smrt-color-primary-container, var(--smrt-color-surface-container-high)); color: var(--smrt-color-on-primary-container, inherit); }
  .smrt-sortable__marker { block-size: 0.1875rem; border-radius: var(--smrt-radius-full); background: var(--smrt-color-primary); }
  .smrt-sortable__empty { margin: 0; padding: var(--smrt-spacing-2); color: var(--smrt-color-on-surface-variant); font: var(--smrt-typography-body-small-font); }
  .smrt-sortable__live { position: absolute; inline-size: 1px; block-size: 1px; overflow: hidden; clip: rect(0 0 0 0); clip-path: inset(50%); white-space: nowrap; }
</style>
