/**
 * The data each core widget renders (#3727), and the pure helpers a loader
 * uses to produce it. The shapes are structural on purpose: a loader can be
 * backed by runtime reports, a collection query or the planner's in-browser
 * source without this package depending on any of them.
 */

import type { FieldRole } from '../../screens/roles.js';
import type { WidgetValueFormat } from '../format.js';
import { safeHref } from '../markdown.js';

/** `metric`: one number. `money` values are integer minor units. */
export interface MetricWidgetData {
  value: number;
  format?: WidgetValueFormat;
  /** ISO 4217 code for `money`. */
  currency?: string;
  /** Caption under the number (default: the widget title only). */
  label?: string;
  /** Percent change against the previous period (12.5 means +12.5%). */
  change?: number | null;
  href?: string;
}

/** `chart`: values grouped by label. Shaped like one measure of a runtime report. */
export interface ChartWidgetData {
  points: { label: string; value: number }[];
  format?: WidgetValueFormat;
  currency?: string;
  href?: string;
}

/** Badge tone of a status value (`statusTone`). */
export type RecordStatusTone =
  | 'default'
  | 'primary'
  | 'success'
  | 'warning'
  | 'error'
  | 'info';

/**
 * One column of a records table: the cell key (a field name of the listed
 * model) and how it renders, by role: `identifier` monospace, `status` a
 * badge, `date` a date without a time, `money` integer minor units as
 * currency, `quantity` a number; anything else as text. `money` and
 * `quantity` columns are right-aligned and summed in the footer.
 */
export interface RecordListColumn {
  key: string;
  label: string;
  role?: FieldRole;
  /**
   * Sum this column in the footer. Defaults to true for `money` and
   * `quantity`; a unit price sets `false` (a sum of unit prices means
   * nothing).
   */
  summarize?: boolean;
}

/** One listed record. `cells` carries the column values, keyed by column key. */
export interface RecordListRow {
  id: string;
  title: string;
  subtitle?: string;
  meta?: string;
  href?: string;
  /**
   * Column values (`columns`), raw: money in integer minor units, dates as
   * ISO strings (or preformatted text), a party as its display label.
   */
  cells?: Record<string, unknown>;
}

/**
 * `records`: the rows to list. The loader chooses the title field. With
 * columns (the widget's `columns` option or `columns` here) the rows render
 * as a table of `cells`; without, as the title list.
 */
export interface RecordListWidgetData {
  rows: RecordListRow[];
  /** Total matching records, when more than `rows`. */
  total?: number;
  /** Link to the full list. */
  href?: string;
  /** Column labels and roles; keys not listed here get a humanized label. */
  columns?: RecordListColumn[];
  /** ISO 4217 code of the money cells (default USD). */
  currency?: string;
  /** Time zone a date cell is shown in (default UTC, so SSR and the browser agree). */
  timeZone?: string;
  /**
   * Footer values over EVERY matching record, keyed by column key (money in
   * minor units). Without them the footer sums the loaded rows, and only
   * when they are all the matching records (`total` absent or not more).
   */
  summaries?: Record<string, number>;
}

/** One tab of the `related` widget: one relation's records table. */
export interface RelatedWidgetTab {
  /** The relation's key (`relationKey`, `Order-customerId`). */
  key: string;
  /** Tab label; the widget appends the count ("Orders 6"). */
  label: string;
  rows: RecordListRow[];
  /** Every matching record; the tab count. Defaults to `rows.length`. */
  total?: number;
  columns: RecordListColumn[];
  /** The tab's one "View all" link. */
  href?: string;
  currency?: string;
  timeZone?: string;
  /** Footer values over every matching record (money in minor units). */
  summaries?: Record<string, number>;
}

/** `related`: one tab per `children` relation; empty relations are hidden. */
export interface RelatedWidgetData {
  tabs: RelatedWidgetTab[];
}

/**
 * `line-items`: a document's lines (item, quantity, unit price, amount)
 * with a footer, then the totals block from the parent record's own
 * subtotal / discount / tax / total (`totals`), computed from the lines
 * where the record has none, and flagged where they disagree.
 */
export interface LineItemsWidgetData {
  rows: RecordListRow[];
  columns: RecordListColumn[];
  /** Every line; more than `rows` means the rows are a page. */
  total?: number;
  /** The parent record's own totals, integer minor units. */
  totals?: {
    subtotal?: number | null;
    discount?: number | null;
    tax?: number | null;
    total?: number | null;
  };
  currency?: string;
  /** Footer values over every line (money in minor units). */
  summaries?: Record<string, number>;
  /** Link to every line. */
  href?: string;
}

/** `shortcuts`: cards that link to pages. */
export interface ShortcutsWidgetData {
  items: {
    id: string;
    label: string;
    href: string;
    icon?: string;
    description?: string;
  }[];
}

/** The part of a shell nav model section `shortcutsFromNav` reads. */
export interface ShortcutNavSection {
  id: string;
  items: readonly {
    id: string;
    label: string;
    hidden?: boolean;
    item: { href: string; icon?: string; description?: string };
  }[];
}

/**
 * Cards for one navigation section: its visible entries with the user's
 * renames, as `resolveShellNavModel(...)` (or `useShellLayout().sections`)
 * reports them. Entries with an unsafe href are skipped. With no
 * `sectionId`, every section's entries are listed.
 */
export function shortcutsFromNav(
  sections: readonly ShortcutNavSection[],
  sectionId?: string,
): ShortcutsWidgetData {
  const items: ShortcutsWidgetData['items'] = [];
  for (const section of sections) {
    if (sectionId && section.id !== sectionId) continue;
    for (const entry of section.items) {
      if (entry.hidden) continue;
      const href = safeHref(entry.item.href);
      if (!href) continue;
      items.push({
        id: entry.id,
        label: entry.label,
        href,
        ...(entry.item.icon ? { icon: entry.item.icon } : {}),
        ...(entry.item.description
          ? { description: entry.item.description }
          : {}),
      });
    }
  }
  return { items };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
