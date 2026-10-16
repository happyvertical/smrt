import type { OverviewOverride } from '@happyvertical/smrt-svelte/overview/server';
import type { ShellLayout } from '@happyvertical/smrt-svelte/workspace/layout';
import { type PlanData, planFields } from '../recipes/plan-data.ts';
import { compactTheme, type ThemeSetting } from '../theme/theme.ts';
import { COOKBOOK_SCHEMA, COOKBOOK_VERSION, type Cookbook } from './types.ts';

/**
 * The cookbook a plan and its layout, theme and page customisations make, in
 * the stable order every export uses. Pure: no runes, no browser.
 */
export function assembleCookbook(
  plan: PlanData,
  extras: {
    layout?: ShellLayout;
    theme?: ThemeSetting;
    overviews?: Record<string, OverviewOverride>;
    name?: string;
    description?: string;
  } = {},
): Cookbook {
  const cookbook: Cookbook = {
    $schema: COOKBOOK_SCHEMA,
    version: COOKBOOK_VERSION,
    ...planFields(plan),
  };
  if (extras.name) cookbook.name = extras.name;
  if (extras.description) cookbook.description = extras.description;
  if (extras.layout) cookbook.layout = extras.layout;
  const theme = compactTheme(extras.theme);
  if (theme) cookbook.theme = theme;
  const overviews = extras.overviews ?? {};
  const ids = Object.keys(overviews).sort();
  if (ids.length) {
    cookbook.overviews = Object.fromEntries(
      ids.map((id) => [id, overviews[id]]),
    );
  }
  return cookbook;
}
