/**
 * The data each core widget renders (#3727), and the pure helpers a loader
 * uses to produce it. The shapes are structural on purpose: a loader can be
 * backed by runtime reports, a collection query or the planner's in-browser
 * source without this package depending on any of them.
 */

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

/** `records`: the rows to list. The loader chooses the title field. */
export interface RecordListWidgetData {
  rows: {
    id: string;
    title: string;
    subtitle?: string;
    meta?: string;
    href?: string;
  }[];
  /** Total matching records, when more than `rows`. */
  total?: number;
  /** Link to the full list. */
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
