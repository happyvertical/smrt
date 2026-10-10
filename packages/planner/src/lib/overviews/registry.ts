/**
 * The planner's overview widgets (smrt#3727): one registry for every section
 * overview, the core widgets wired to the IN-BROWSER sample data, and the
 * recipes' `widget` surfaces. Validation (`cookbook/validate.ts`) and the
 * section pages share it, so what a cookbook may hold is exactly what a page
 * can render.
 *
 * Loaders receive validated options only. What they read comes from the host
 * capabilities a page passes in the load context ({@link PlannerWidgetContext}),
 * never from option values: an option names a model or field, the loader looks
 * it up in the catalog and asks the `DataSource` for it.
 */
import {
  createWidgetRegistry,
  type MetricWidgetData,
  type RecipeExportResolver,
  type RecipeWidgetSource,
  type RecordListWidgetData,
  registerCoreWidgets,
  registerRecipeWidgets,
  type ShortcutNavSection,
  type ShortcutsWidgetData,
  shortcutsFromNav,
  type WidgetLoadContext,
} from '@happyvertical/smrt-svelte/overview';
import { getModelByQualifiedName } from '../catalog/index.ts';
import type { CatalogModel } from '../catalog/types.ts';
import { isMoneyField } from '../data/fakes.ts';
import { recordCount } from '../data/format.ts';
import { recordLabel } from '../data/labels.ts';
import type { DataSource, ModelRecord } from '../data/source.ts';
import { recipes } from '../recipes/index.ts';
import { inScope } from '../recipes/scope.ts';
import type { SectionEntry } from '../sections/entries.ts';

/** The capabilities a section page hands its widgets' loaders. */
export interface PlannerWidgetContext {
  /** The in-browser sample data. */
  source: DataSource;
  /** The shell's resolved sections (renames and hides applied). */
  sections: readonly ShortcutNavSection[];
  /** Layout item id -> the model and scope it lists, for record counts. */
  entries: ReadonlyMap<string, SectionEntry>;
  /** An in-app path with the app query (`appHref`). */
  href: (path: string) => string;
}

/** The registry every planner overview uses. */
export const overviewRegistry = createWidgetRegistry();

function capabilities(ctx: WidgetLoadContext): PlannerWidgetContext {
  const { source, sections, entries, href } = ctx as WidgetLoadContext &
    Partial<PlannerWidgetContext>;
  if (!source || !sections || !entries || !href) {
    throw new Error('the planner widget context is missing');
  }
  return { source, sections, entries, href };
}

function modelOf(qualified: unknown): {
  model: CatalogModel;
  path: string;
} {
  const found =
    typeof qualified === 'string'
      ? getModelByQualifiedName(qualified)
      : undefined;
  if (!found) throw new Error(`unknown model ${String(qualified)}`);
  return {
    model: found.model,
    path: `/m/${found.pkg.id}/${found.model.name}/`,
  };
}

/** The sample data has no named filters yet: naming one is an error tile. */
function refuseFilter(filter: unknown): void {
  if (typeof filter === 'string' && filter !== '') {
    throw new Error(`unknown filter ${filter}`);
  }
}

const numeric = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

/**
 * `metric`: a count, or the sum / average / min / max of one numeric field,
 * over the model's sample rows. Money fields stay integer minor units.
 */
async function loadMetric(
  options: Record<string, unknown>,
  ctx: WidgetLoadContext,
): Promise<MetricWidgetData> {
  const { source, href } = capabilities(ctx);
  const { model, path } = modelOf(options.model);
  refuseFilter(options.filter);
  const rows = await source.list(model);
  const measure = typeof options.measure === 'string' ? options.measure : '';
  if (measure === 'count' || measure === '') {
    return {
      value: rows.length,
      format: 'integer',
      href: href(path),
    };
  }
  const field = model.fields.find((f) => f.name === options.field);
  if (!field || (field.type !== 'integer' && field.type !== 'decimal')) {
    throw new Error(`${measure} needs a numeric field of ${model.name}`);
  }
  const values = rows.map((row) => row[field.name]).filter(numeric);
  let value = 0;
  if (values.length) {
    if (measure === 'sum' || measure === 'avg') {
      value = values.reduce((total, v) => total + v, 0);
      if (measure === 'avg') value /= values.length;
    } else if (measure === 'min') value = Math.min(...values);
    else if (measure === 'max') value = Math.max(...values);
    else throw new Error(`unknown measure ${measure}`);
  }
  const money = isMoneyField(field);
  return {
    // Money is integer minor units, also for an average.
    value: money ? Math.round(value) : value,
    format: money ? 'money' : field.type === 'integer' ? 'integer' : 'decimal',
    ...(money ? { currency: 'USD' } : {}),
    href: href(path),
  };
}

function compare(a: unknown, b: unknown): number {
  if (numeric(a) && numeric(b)) return a - b;
  return String(a ?? '').localeCompare(String(b ?? ''));
}

/** `records`: the first `limit` sample rows, optionally sorted by a field. */
async function loadRecords(
  options: Record<string, unknown>,
  ctx: WidgetLoadContext,
): Promise<RecordListWidgetData> {
  const { source, href } = capabilities(ctx);
  const { model, path } = modelOf(options.model);
  refuseFilter(options.filter);
  let rows: ModelRecord[] = await source.list(model);
  if (typeof options.sort === 'string' && options.sort) {
    const sort = options.sort;
    if (!model.fields.some((f) => f.name === sort)) {
      throw new Error(`${model.name} has no field ${sort}`);
    }
    const sign = options.direction === 'asc' ? 1 : -1;
    rows = [...rows].sort((a, b) => sign * compare(a[sort], b[sort]));
  }
  const limit = numeric(options.limit) ? options.limit : 5;
  const shown = rows.slice(0, limit);
  return {
    rows: await Promise.all(
      shown.map(async (row) => ({
        id: String(row.id),
        title: await recordLabel(source, model, row),
      })),
    ),
    ...(rows.length > shown.length ? { total: rows.length } : {}),
    href: href(path),
  };
}

/**
 * `shortcuts`: the section's menu entries as cards, as the shell resolves them
 * (renames, hides, moves), each with its record count. `section` names another
 * section by its id without the `section:` / `custom:` prefix; absent, the
 * overview's own section.
 */
async function loadShortcuts(
  options: Record<string, unknown>,
  ctx: WidgetLoadContext,
): Promise<ShortcutsWidgetData> {
  const { source, sections, entries } = capabilities(ctx);
  const named = typeof options.section === 'string' ? options.section : '';
  const sectionId = named
    ? sections.find(
        (s) => s.id === `section:${named}` || s.id === `custom:${named}`,
      )?.id
    : ctx.overviewId;
  if (!sectionId) throw new Error(`unknown section ${named}`);
  const data = shortcutsFromNav(sections, sectionId);
  const items = await Promise.all(
    data.items.map(async (item) => {
      const entry = entries.get(item.id);
      if (!entry) return item;
      const rows = await source.list(entry.model);
      const count = recordCount(
        rows.filter((row) => inScope(entry.scope, row)).length,
      );
      return {
        ...item,
        // The count first: a long description is clipped.
        description: item.description
          ? `${count} · ${item.description}`
          : count,
      };
    }),
  );
  return { items };
}

registerCoreWidgets(overviewRegistry, {
  metric: loadMetric,
  records: loadRecords,
  shortcuts: loadShortcuts,
});

/** The core widget types a section overview offers. */
export const CORE_WIDGET_TYPES = [
  'shortcuts',
  'metric',
  'records',
  'note',
] as const;

/**
 * How a recipe widget's `'<specifier>#<Export>'` becomes a module: a static map
 * of dynamic imports, one entry per package that ships widgets. No published
 * recipe declares a `widget` surface yet, so it is empty and every lookup is
 * `undefined` (the widget then renders as unavailable).
 */
const RECIPE_WIDGET_MODULES: Record<string, () => Promise<unknown>> = {};

export const resolveRecipeExport: RecipeExportResolver = async (
  specifier,
  exportName,
) => {
  const load = RECIPE_WIDGET_MODULES[specifier];
  if (!load) return undefined;
  const module = (await load()) as Record<string, unknown>;
  return module[exportName];
};

/** Recipes that declare at least one `widget` surface. */
export const widgetRecipes: readonly RecipeWidgetSource[] = recipes.filter(
  (recipe) => recipe.surfaces?.some((surface) => surface.kind === 'widget'),
  // The planner's local `Recipe` carries the manifest's widget surface as
  // authored; `registerRecipeWidgets` re-validates every field it reads.
) as unknown as RecipeWidgetSource[];

/**
 * Widget types the recipes contribute, allowed on every section overview. A
 * widget's own `allowedIn` still confines it.
 */
export const RECIPE_WIDGET_TYPES: readonly string[] = widgetRecipes.flatMap(
  (recipe) =>
    (recipe.surfaces ?? []).flatMap((surface) =>
      surface.kind === 'widget' ? [surface.type] : [],
    ),
);

/**
 * Register the recipes' widgets. Surfaces without a `migrate` register
 * synchronously inside this call (the helper awaits only `migrate` exports), so
 * validation at load sees them; the promise reports what was skipped.
 */
export const recipeWidgets = registerRecipeWidgets(
  overviewRegistry,
  widgetRecipes,
  resolveRecipeExport,
);
