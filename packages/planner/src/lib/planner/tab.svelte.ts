import { TAB_PARAM } from './query.ts';

export const PLANNER_TABS = [
  'cookbooks',
  'recipes',
  'features',
  'layout',
  'theme',
  'settings',
  'export',
] as const;
export type PlannerTab = (typeof PLANNER_TABS)[number];

/** `fallback` (Cookbooks) unless the query names another known tab. */
export function parseTab(
  search: string,
  fallback: PlannerTab = 'cookbooks',
): PlannerTab {
  const value = new URLSearchParams(search).get(TAB_PARAM);
  return PLANNER_TABS.find((tab) => tab === value) ?? fallback;
}

/** The Planner page's active tab; the address bar mirrors it (`?tab=`). */
class PlannerTabState {
  active = $state<PlannerTab>('cookbooks');

  fromSearch(search: string, fallback: PlannerTab = 'cookbooks') {
    this.active = parseTab(search, fallback);
  }
}

export const plannerTab = new PlannerTabState();
