import type { Snippet } from 'svelte';
import type { SortablePosition } from './controller.svelte.js';

export type { SortablePosition } from './controller.svelte.js';

/** The minimum identity contract for a sortable item. */
export interface SortableItem {
  id: string;
  /** The container the item currently sits in. */
  containerId: string;
  /** Accessible text used in announcements and the move handle's name. */
  label: string;
}

/** A list items are sorted within and moved between. */
export interface SortableContainer {
  id: string;
  label: string;
  /** Items cannot be dropped into a disabled container. */
  disabled?: boolean;
  /**
   * Keeps the container where it is when `reorderContainers` is on: fixed
   * containers render first, in the order given, and have no move handle.
   */
  fixed?: boolean;
}

/** A drop of an item. `target.index` counts after removing it from `source`. */
export interface SortableItemMove<
  Item extends SortableItem = SortableItem,
  Container extends SortableContainer = SortableContainer,
> {
  item: Item;
  source: SortablePosition;
  target: SortablePosition;
  sourceContainer: Container;
  targetContainer: Container;
}

/**
 * A drop of a container. Indices count the movable (non-`fixed`) containers;
 * `target` counts after removing the container from `source`.
 */
export interface SortableContainerMove<
  Container extends SortableContainer = SortableContainer,
> {
  container: Container;
  source: number;
  target: number;
}

export interface SortableItemSnippetProps<
  Item extends SortableItem,
  Container extends SortableContainer,
> {
  item: Item;
  container: Container;
  /** Index within the container. */
  index: number;
  isDragging: boolean;
}

export interface SortableContainerHeaderSnippetProps<
  Container extends SortableContainer,
> {
  container: Container;
  count: number;
  isDragging: boolean;
}

/** Public props for the generic Svelte 5 Sortable component. */
export interface SortableProps<
  Item extends SortableItem,
  Container extends SortableContainer,
> {
  /** Containers in display order. The owner is authoritative. */
  containers: readonly Container[];
  /** Items; order within a container is their order here. */
  items: readonly Item[];
  /** Accessible name for the whole list. */
  label?: string;
  /** Let the user reorder the (non-`fixed`) containers too. */
  reorderContainers?: boolean;
  /**
   * Whether items may be reordered within their container (default true);
   * `false` only allows moving them between containers.
   */
  allowSameContainerReorder?: boolean;
  /** Content beside each item's move handle. */
  item: Snippet<[SortableItemSnippetProps<Item, Container>]>;
  /** Content in a container's header, beside its move handle. */
  containerHeader?: Snippet<[SortableContainerHeaderSnippetProps<Container>]>;
  /**
   * Receives a typed item move. May persist asynchronously; a rejection
   * restores the presentation and is announced. Omit to make items read-only.
   */
  onmove?: (move: SortableItemMove<Item, Container>) => void | Promise<void>;
  /** Receives a container move (requires `reorderContainers`). */
  oncontainermove?: (
    move: SortableContainerMove<Container>,
  ) => void | Promise<void>;
}
