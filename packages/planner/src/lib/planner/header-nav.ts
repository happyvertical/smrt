import type { PlannerTabId } from './commands/types.ts';

/**
 * The labelled header navigation (`headerNav: 'labelled'`): four buttons, each
 * opening one group of the planner's configure tabs. Specs and Build are a
 * single tab; Features and Styles keep their siblings together.
 */
export const NAV_GROUPS = ['specs', 'features', 'styles', 'build'] as const;
export type NavGroup = (typeof NAV_GROUPS)[number];

/** The tabs each group shows in the tab strip, in order. */
export const NAV_GROUP_TABS: Record<NavGroup, readonly PlannerTabId[]> = {
  specs: ['specs'],
  features: ['cookbooks', 'recipes', 'features'],
  styles: ['theme', 'settings'],
  build: ['export'],
};

/** The tab each button opens. */
export const NAV_GROUP_HREF: Record<NavGroup, string> = {
  specs: '#/configure/specs/',
  features: '#/configure/recipes/',
  styles: '#/configure/theme/',
  build: '#/configure/export/',
};

const GROUP_ENTRY: Record<NavGroup, PlannerTabId> = {
  specs: 'specs',
  features: 'recipes',
  styles: 'theme',
  build: 'export',
};

/** The group an active tab belongs to; the unlisted Layout tab sits with Features. */
export function navGroupOf(tab: PlannerTabId): NavGroup {
  for (const group of NAV_GROUPS) {
    if (NAV_GROUP_TABS[group].includes(tab)) return group;
  }
  return 'features';
}

/** The tab a click on a group's button lands on: the current one if already inside the group. */
export function navEntryTab(
  group: NavGroup,
  active: PlannerTabId,
): PlannerTabId {
  return navGroupOf(active) === group &&
    (NAV_GROUP_TABS[group].includes(active) || group === 'features')
    ? active
    : GROUP_ENTRY[group];
}
