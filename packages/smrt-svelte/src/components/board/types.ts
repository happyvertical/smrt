import type { Snippet } from 'svelte';

/** The minimum identity contract for a Board card. */
export interface BoardCard {
  id: string;
}

/** A Board lane. Labels are deliberately presentation-only; ids drive moves. */
export interface BoardColumn {
  id: string;
  label: string;
  /** Prevents cards from being moved into this lane. */
  disabled?: boolean;
}

/** A card's position in a board. */
export interface BoardPosition {
  columnId: string;
  /** Zero-based insertion position. */
  index: number;
}

/**
 * The complete, domain-agnostic instruction emitted when a card is dropped.
 *
 * `target.index` is calculated after removing the card from `source`, making
 * it directly usable with an immutable list update.
 */
export interface BoardMoveIntent<
  Card extends BoardCard = BoardCard,
  Column extends BoardColumn = BoardColumn,
> {
  card: Card;
  source: BoardPosition;
  target: BoardPosition;
  sourceColumn: Column;
  targetColumn: Column;
}

export interface BoardCardSnippetProps<
  Card extends BoardCard,
  Column extends BoardColumn,
> {
  card: Card;
  column: Column;
  index: number;
  isDragging: boolean;
}

export interface BoardColumnHeaderSnippetProps<Column extends BoardColumn> {
  column: Column;
  count: number;
  collapsed: boolean;
}

/** Public props for the generic Svelte 5 Board component. */
export interface BoardProps<
  Card extends BoardCard,
  Column extends BoardColumn,
> {
  /** Ordered lanes. The Board does not impose statuses or workflow names. */
  columns: readonly Column[];
  /** Authoritative controlled cards. Omit to use `defaultCards`. */
  cards?: readonly Card[];
  /** Initial cards for an uncontrolled Board. */
  defaultCards?: readonly Card[];
  /** Resolves the lane containing a card. */
  getCardColumnId: (card: Card) => string;
  /** Returns a copy of a card assigned to `columnId`; keeps Board domain-free. */
  setCardColumnId: (card: Card, columnId: string) => Card;
  /** Accessible text announced while a card is moved. */
  getCardLabel: (card: Card) => string;
  /** Required visual content for each card. */
  card: Snippet<[BoardCardSnippetProps<Card, Column>]>;
  /** Optional lane-header content, rendered beside the built-in count. */
  columnHeader?: Snippet<[BoardColumnHeaderSnippetProps<Column>]>;
  /** Accessible name for the board. */
  label?: string;
  /** Makes lane headers collapse their card lists. */
  collapsible?: boolean;
  /**
   * In controlled mode, retain the locally reordered presentation until the
   * owner supplies a new `cards` array. The owner remains authoritative.
   */
  optimistic?: boolean;
  /** Called when a card is activated without starting a move. */
  onselect?: (card: Card) => void;
  /**
   * Receives a typed move intent. It may persist asynchronously; a rejection
   * restores the existing presentation and is announced to assistive tech.
   */
  onmove?: (intent: BoardMoveIntent<Card, Column>) => void | Promise<void>;
}
