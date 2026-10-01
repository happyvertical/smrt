/**
 * Navigation component types
 */

export interface FilterOption {
  /** Option value */
  value: string;
  /** Display label */
  label: string;
  /** Optional count badge */
  count?: number;
  /** Disabled state */
  disabled?: boolean;
}

export interface Tab {
  /** Tab identifier */
  id: string;
  /** Display label */
  label: string;
  /** Optional count badge */
  count?: number;
  /** Disabled state */
  disabled?: boolean;
  /**
   * Makes this a link tab: the tab row renders as navigation (`<nav>` of
   * links, `aria-current="page"` on the active one) instead of a tablist.
   * Give every tab an `href` or none.
   */
  href?: string;
  /** Short attention badge (e.g. `3` pending, `!`); `null`/absent shows none. */
  badge?: string | number | null;
}
