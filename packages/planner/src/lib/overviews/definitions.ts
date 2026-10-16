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
  OVERVIEW_DEFAULT_MAX_WIDGETS,
  OVERVIEW_PAGE_ID_PATTERN,
  type OverviewDefinition,
  type OverviewWidget,
  RECORD_OVERVIEW_MAX_METRICS,
  recordOverview,
  recordOverviewId,
} from '@happyvertical/smrt-svelte/overview';
import type { ShellLayout } from '@happyvertical/smrt-svelte/workspace/layout';
import { catalog, getModel } from '../catalog/index.ts';
import type { CatalogModel } from '../catalog/types.ts';
import { humanize, pluralize } from '../data/format.ts';
import { FEATURE_SECTION } from '../recipes/features.ts';
import { buildNavSections, recipeNav, recipes } from '../recipes/index.ts';
import { screenDefinition } from '../screens/definition.ts';
import { screenRelations } from '../screens/relations.ts';
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
 * A record view's overview id (smrt#3718): `detail:<pkg>.<Model>`, the
 * catalog package id and class name, one per model kind. Spelled by the
 * planner, not `recordOverviewId` (which folds the qualified name), so the
 * key reads like the page's path.
 */
export function detailOverviewId(packageId: string, modelName: string): string {
  return `detail:${packageId}.${modelName}`;
}

/**
 * Exposed models by the framework's own record overview id
 * (`recordOverviewId(objectRef)`: `detail:happyvertical.smrt-commerce.Customer`),
 * so an override keyed the way a generated app keys it is a known page here too.
 */
const BY_FRAMEWORK_ID = new Map(
  catalog.packages.flatMap((pkg) =>
    pkg.models
      .filter((model) => model.exposed)
      .map((model) => [
        recordOverviewId(model.id),
        { packageId: pkg.id, model },
      ]),
  ),
);

/**
 * The catalog model a record overview id names, if any: the planner's
 * `detail:<pkg>.<Model>`, or the framework's `recordOverviewId` form.
 */
export function detailOverviewModel(
  id: string,
): { packageId: string; model: CatalogModel } | undefined {
  const match = /^detail:([A-Za-z0-9_-]+)\.([A-Za-z0-9_]+)$/.exec(id);
  const [, packageId, modelName] = match ?? [];
  const model =
    packageId && modelName ? getModel(packageId, modelName) : undefined;
  if (packageId && model?.exposed) return { packageId, model };
  return BY_FRAMEWORK_ID.get(id);
}

/** Every exposed model: the relations a detail overview's defaults cover. */
const EXPOSED = new Set(
  catalog.packages.flatMap((pkg) =>
    pkg.models.filter((model) => model.exposed).map((model) => model.id),
  ),
);

const detailCache = new Map<string, OverviewDefinition>();

/**
 * The overview a record's view page renders (smrt#3718): the framework's
 * `recordOverview` over the model's definition and its relations: a summary
 * strip of `metric` tiles (a count and a money sum per related model), the
 * `line-items` table and totals when the model has line items, then one
 * tabbed `related` widget. Widget ids come from the relation, so they are the
 * same in the narrowed page. Static per model kind over the whole catalog
 * (every relation's tiles, not only the first four), so a stored override
 * always resolves against the same widget ids whichever recipes are on;
 * {@link detailOverviewFor} is the same definition narrowed to the models in
 * the visitor's app.
 */
export function detailOverview(id: string): OverviewDefinition | undefined {
  let definition = detailCache.get(id);
  if (definition) return definition;
  const found = detailOverviewModel(id);
  if (!found) return undefined;
  const relations = screenRelations(catalog, found.model.id, EXPOSED);
  const base = recordOverview(screenDefinition(found.model), relations, {
    id,
    // Every relation's tiles: the narrowed page keeps the first four in the app.
    maxMetrics: 2 * relations.length,
  });
  // The whole catalog relates more models to a customer than one app ever
  // shows; the defaults must fit, and the visitor still gets room to add.
  definition = defineOverview({
    ...base,
    maxWidgets: Math.max(
      base.maxWidgets ?? OVERVIEW_DEFAULT_MAX_WIDGETS,
      base.defaults.length + OVERVIEW_DEFAULT_MAX_WIDGETS,
    ),
  });
  detailCache.set(id, definition);
  return definition;
}

/**
 * {@link detailOverview} with only the default widgets the app can fill
 * (`inApp`): tiles over its models (the first four), the line items when
 * the app has them, the related tabs when any related model is in it. The
 * ids and the allowed set stay those of the static one.
 */
export function detailOverviewFor(
  id: string,
  inApp: ReadonlySet<string>,
): OverviewDefinition | undefined {
  const full = detailOverview(id);
  const found = detailOverviewModel(id);
  if (!full || !found) return undefined;
  const relations = screenRelations(catalog, found.model.id, inApp);
  let tiles = 0;
  const defaults = full.defaults.filter((widget) => {
    if (widget.type === 'line-items') {
      return relations.some((r) => r.kind === 'items');
    }
    if (widget.type === 'related') {
      return relations.some((r) => r.kind === 'children');
    }
    if (!inApp.has(String(widget.options.model))) return false;
    if (widget.type !== 'metric') return true;
    tiles += 1;
    return tiles <= RECORD_OVERVIEW_MAX_METRICS;
  });
  return defineOverview({ ...full, defaults });
}

/** The definition behind any overview id: a section's or a record view's. */
export function overviewDefinition(id: string): OverviewDefinition | undefined {
  return id.startsWith('detail:') ? detailOverview(id) : sectionOverview(id);
}

/**
 * Whether `id` names an overview in a cookbook with this layout: a section a
 * recipe suggests, More, one of the layout's custom sections, or a record
 * view of a catalog model (`detail:<pkg>.<Model>`). Anything else (a typo, a
 * section from another app) is unknown and its override is dropped.
 */
export function isOverviewId(id: string, layout?: ShellLayout): boolean {
  if (NAV_SECTIONS.has(id) || id === `section:${FEATURE_SECTION.id}`) {
    return true;
  }
  if (id.startsWith('detail:')) return detailOverviewModel(id) !== undefined;
  return (
    id.startsWith('custom:') &&
    OVERVIEW_PAGE_ID_PATTERN.test(id) &&
    (layout?.customSections ?? []).some((section) => section.id === id)
  );
}
