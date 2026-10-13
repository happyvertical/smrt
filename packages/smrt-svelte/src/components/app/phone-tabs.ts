import type {
  ShellNavGroup,
  ShellNavItem,
} from '../workspace/admin-shell/types.js';

/** `phoneTabBar` option object. */
export interface PhoneTabBarOptions {
  /** Navigation and dock tabs shown before "More" (default 4). */
  items?: number;
}

/** Default number of navigation and dock tabs. */
export const PHONE_TAB_DEFAULT_ITEMS = 4;

/** One navigation destination eligible for a tab. */
export interface PhoneTabNavEntry {
  id: string;
  label: string;
  href: string;
  icon?: string;
}

/** The tabs a phone bar shows for a navigation and dock configuration. */
export interface PhoneTabPlan {
  /** Navigation tabs, in order. */
  nav: PhoneTabNavEntry[];
  /** True when navigation overflows and a "More" tab opens the drawer. */
  more: boolean;
}

/** Normalise the `phoneTabBar` prop: `null` when off, else the item budget. */
export function resolvePhoneTabBar(
  value: boolean | PhoneTabBarOptions | undefined,
): { items: number } | null {
  if (!value) return null;
  const items = typeof value === 'object' ? value.items : undefined;
  const n = Number.isFinite(items)
    ? Math.floor(items as number)
    : PHONE_TAB_DEFAULT_ITEMS;
  return { items: Math.max(1, n) };
}

/**
 * Top-level navigation destinations in order: the flat items, then either each
 * group's entries (`items` mode) or one entry per group (`sections` modes),
 * the way the left sidebar lists them.
 */
export function phoneTabNavEntries(
  nav: readonly ShellNavItem[],
  groups: readonly ShellNavGroup[],
  navMode: 'items' | 'sections' | 'sections-with-items' = 'items',
  sectionHref?: (sectionId: string) => string | undefined,
): PhoneTabNavEntry[] {
  const out: PhoneTabNavEntry[] = [];
  const add = (entry: PhoneTabNavEntry) => {
    if (!out.some((existing) => existing.id === entry.id)) out.push(entry);
  };
  for (const item of nav) {
    add({
      id: item.id ?? item.href,
      label: item.label,
      href: item.href,
      icon: item.icon,
    });
  }
  for (const group of groups) {
    if (navMode === 'items') {
      for (const item of group.items) {
        add({
          id: item.id ?? item.href,
          label: item.label,
          href: item.href,
          icon: item.icon,
        });
      }
      continue;
    }
    const id = group.id ?? group.heading;
    const href = group.href ?? sectionHref?.(id) ?? group.items[0]?.href;
    if (href) add({ id, label: group.heading, href, icon: group.icon });
  }
  return out;
}

/**
 * Choose the tabs: `budget` counts navigation and dock tabs together (the
 * dock tab takes one place when present); "More" is added on top only when
 * navigation overflows.
 */
export function planPhoneTabs(
  entries: readonly PhoneTabNavEntry[],
  budget: number,
  hasDockTab: boolean,
): PhoneTabPlan {
  const slots = Math.max(0, budget - (hasDockTab ? 1 : 0));
  return {
    nav: entries.slice(0, slots),
    more: entries.length > slots,
  };
}

/** True when `href` is the current page or an ancestor of it. */
export function isTabCurrent(href: string, currentHref: string): boolean {
  return href === currentHref || currentHref.startsWith(`${href}/`);
}
