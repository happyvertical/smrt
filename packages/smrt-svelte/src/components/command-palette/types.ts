/**
 * Command palette contracts (#3713).
 *
 * The palette is a thin shell over a *provider* contract: anything that wants
 * to appear in "find anything" registers a {@link PaletteProvider}. The shell
 * ships two (see `providers.ts`): navigation from the shell nav model, and a
 * model-driven pair derived from the SMRT manifest. Packages and recipes add
 * their own through the same contract.
 */

/** What an item does when chosen, for grouping hints and screen readers. */
export type PaletteItemKind =
  | 'command'
  | 'navigation'
  | 'create'
  | 'record'
  | (string & {});

/** Passed to {@link PaletteItem.run}. */
export interface PaletteRunContext {
  /** The text typed when the item was chosen. */
  query: string;
  /** The provider that owns the item. */
  providerId: string;
  /** Navigate with the palette's `navigate` seam (same as an `href` item). */
  navigate: (href: string) => void | Promise<void>;
}

/** One selectable row. */
export interface PaletteItem {
  /** Stable id, unique within its provider. */
  id: string;
  /** Primary text; matched against the query and highlighted. */
  title: string;
  /** Secondary line, e.g. the model an item belongs to. Matched at lower weight. */
  subtitle?: string;
  /** Extra match terms that are not shown ("invoice" for "Billing"). */
  keywords?: readonly string[];
  /** Overrides the provider's group heading for this item. */
  group?: string;
  /** A shell icon name (`SHELL_ICON_PATHS`); unknown names draw no icon. */
  icon?: string;
  /** Free-form tag, exposed as `data-kind` and read by assistants. */
  kind?: PaletteItemKind;
  /** Navigates here when chosen and no `run` is set. */
  href?: string;
  /** Runs when chosen. Takes precedence over `href`. */
  run?: (context: PaletteRunContext) => void | Promise<void>;
  /** A hotkey hint shown at the end of the row (display only), e.g. `Mod+N`. */
  shortcut?: string;
  /**
   * Shown but not selectable. A string is the reason, announced and shown as
   * the row tooltip.
   */
  disabled?: boolean | string;
  /** Static ranking bias added to the match score (default 0). */
  boost?: number;
}

/** Passed to {@link PaletteProvider.items}. */
export interface PaletteItemsContext {
  /** Aborted when the palette closes before the items arrive. */
  signal: AbortSignal;
}

/** Passed to {@link PaletteProvider.search}. */
export interface PaletteSearchContext {
  /** Aborted when the query changes or the palette closes. */
  signal: AbortSignal;
  /** The most rows the palette will show for this provider. */
  limit: number;
}

/**
 * A source of palette rows. A provider offers either or both of:
 *
 * - `items` - a set the palette matches locally (commands, navigation). Read
 *   every time the palette opens, so it can follow app state.
 * - `search` - results for a typed query, fetched by the provider (records).
 *   Called after a short debounce, with a signal that aborts on the next
 *   keystroke. Results are shown as returned; the palette does not re-filter.
 *
 * Authorization stays with the provider: return only what the user may see.
 * The palette is not a security boundary.
 */
export interface PaletteProvider {
  /** Stable id; registering the same id again replaces the earlier provider. */
  id: string;
  /** Group heading for this provider's rows. */
  label: string;
  /** Lower sorts first (default 0); ties keep registration order. */
  order?: number;
  items?(
    context: PaletteItemsContext,
  ): readonly PaletteItem[] | Promise<readonly PaletteItem[]>;
  search?(
    query: string,
    context: PaletteSearchContext,
  ): readonly PaletteItem[] | Promise<readonly PaletteItem[]>;
  /** Shortest trimmed query `search` is called with (default 2). */
  minQueryLength?: number;
  /** Rows shown for this provider (default: the palette's `maxPerGroup`). */
  limit?: number;
}

/** A character range `[start, end)` in a string. */
export type MatchRange = readonly [start: number, end: number];

/** A row the palette renders. */
export interface PaletteResult {
  /** `${providerId}:${item.id}`; unique in the palette. */
  key: string;
  providerId: string;
  /** Group heading the row sits under. */
  group: string;
  item: PaletteItem;
  /** Match score; higher is better. 0 for rows that were not text-matched. */
  score: number;
  /** Ranges of `item.title` that matched the query. */
  titleRanges: readonly MatchRange[];
  /** Whether the row can be chosen. */
  selectable: boolean;
}

/** A heading and its rows. */
export interface PaletteSection {
  /** Stable: the group heading. */
  id: string;
  label: string;
  results: readonly PaletteResult[];
}

/** Where an error came from. */
export interface PaletteErrorContext {
  providerId: string;
  phase: 'items' | 'search' | 'run';
  item?: PaletteItem;
}
