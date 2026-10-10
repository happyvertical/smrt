/**
 * Which overviews exist and what each declares (smrt#3727). Every navigation
 * section page is an editable overview whose id is the section's layout id
 * (`section:sales`, `custom:shop-2`), so a cookbook's `overviews` key names the
 * page it customises and stays valid when the section is renamed.
 *
 * Definitions are static per section (they never depend on which recipes are
 * on), so a saved override always resolves against the same defaults: the
 * cookbook loader, the import and the page agree on what is canonical.
 */
import {
  defineOverview,
  OVERVIEW_PAGE_ID_PATTERN,
  type OverviewDefinition,
  type OverviewWidget,
} from '@happyvertical/smrt-svelte/overview';
import type { ShellLayout } from '@happyvertical/smrt-svelte/workspace/layout';
import { catalog } from '../catalog/index.ts';
import { humanize, pluralize } from '../data/format.ts';
import { FEATURE_SECTION } from '../recipes/features.ts';
import { buildNavSections, recipeNav, recipes } from '../recipes/index.ts';
import { CORE_WIDGET_TYPES, RECIPE_WIDGET_TYPES } from './registry.ts';

const NAV_SECTIONS = new Map(
  buildNavSections(recipes).map((section) => [
    `section:${section.id}`,
    section,
  ]),
);

/** Every model a widget may read: the catalog's, the data the sample source holds. */
const MODELS: readonly string[] = catalog.packages.flatMap((pkg) =>
  pkg.models.map((model) => model.id),
);

const ALLOWED: readonly string[] = [
  ...CORE_WIDGET_TYPES,
  ...RECIPE_WIDGET_TYPES,
];

/**
 * The section's lead model: the first menu entry of the first recipe that
 * suggests the section. Its count and records follow the shortcuts.
 */
function leadModel(
  sectionId: string,
): { id: string; name: string } | undefined {
  const section = NAV_SECTIONS.get(sectionId);
  for (const recipe of section?.recipes ?? []) {
    const entry = recipeNav(recipe)[0];
    if (entry) return { id: entry.model.id, name: humanize(entry.model.name) };
  }
  return undefined;
}

function defaults(sectionId: string): OverviewWidget[] {
  const widgets: OverviewWidget[] = [
    { id: 'shortcuts', type: 'shortcuts', span: 4, options: {} },
  ];
  const lead = leadModel(sectionId);
  if (lead) {
    widgets.push(
      {
        id: 'count',
        type: 'metric',
        span: 1,
        options: {
          title: pluralize(lead.name),
          model: lead.id,
          measure: 'count',
        },
      },
      {
        id: 'latest',
        type: 'records',
        span: 3,
        options: { title: `${lead.name} records`, model: lead.id, limit: 5 },
      },
    );
  }
  return widgets;
}

const cache = new Map<string, OverviewDefinition>();

/**
 * The overview a section page renders; one frozen definition per id.
 * `undefined` for an id no overview can have (a hand-edited layout's custom
 * section id outside the overview id pattern): the page then shows its menu.
 */
export function sectionOverview(
  sectionId: string,
): OverviewDefinition | undefined {
  if (!OVERVIEW_PAGE_ID_PATTERN.test(sectionId)) return undefined;
  let definition = cache.get(sectionId);
  if (!definition) {
    definition = defineOverview({
      id: sectionId,
      allowed: ALLOWED,
      models: MODELS,
      defaults: defaults(sectionId),
    });
    cache.set(sectionId, definition);
  }
  return definition;
}

/**
 * Whether `id` names an overview in a cookbook with this layout: a section a
 * recipe suggests, More, or one of the layout's custom sections. Anything else
 * (a typo, a section from another app) is unknown and its override is dropped.
 */
export function isOverviewId(id: string, layout?: ShellLayout): boolean {
  if (NAV_SECTIONS.has(id) || id === `section:${FEATURE_SECTION.id}`) {
    return true;
  }
  return (
    id.startsWith('custom:') &&
    OVERVIEW_PAGE_ID_PATTERN.test(id) &&
    (layout?.customSections ?? []).some((section) => section.id === id)
  );
}
