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
  type CookbookShortcutsLoader,
  composeShortcutsLoader,
} from '@happyvertical/smrt-svelte/cookbook';
import {
  type ChartWidgetData,
  type CoreWidgetLoaders,
  createLineItemsLoader,
  createLineItemsWidget,
  createRelatedLoader,
  createRelatedWidget,
  createWidgetRegistry,
  type LineItemsTotals,
  lineItemColumns,
  type MetricWidgetData,
  parseColumnsOption,
  type RecipeExportResolver,
  type RecipeWidgetSource,
  type RecordListColumn,
  type RecordListWidgetData,
  registerCoreWidgets,
  registerRecipeWidgets,
  relatedColumns,
  type ShortcutNavSection,
  type WidgetLoadContext,
} from '@happyvertical/smrt-svelte/overview';
import {
  currencyCodeField,
  deriveFieldRoles,
  type FieldRole,
  type ScreenFieldRoles,
  type ScreenRelation,
} from '@happyvertical/smrt-svelte/screens';
import { getModelByQualifiedName } from '../catalog/index.ts';
import type { CatalogModel } from '../catalog/types.ts';
import { EPOCH, isMoneyField } from '../data/fakes.ts';
import { humanize, labelKey } from '../data/format.ts';
import { recordLabel, relationLabels } from '../data/labels.ts';
import type { DataSource, ModelRecord } from '../data/source.ts';
import { filteredListPath, modelPath, recordPath } from '../planner/routes.ts';
import { recipes } from '../recipes/index.ts';
import { isPlumbing } from '../recipes/plumbing.ts';
import { inScope } from '../recipes/scope.ts';
import { screenDefinition } from '../screens/definition.ts';
import {
  documentTotals,
  type StoredLineItemsTotals,
  storedDocumentTotals,
} from '../screens/totals.ts';
import type { SectionEntry } from '../sections/entries.ts';

/** The capabilities a section page hands its widgets' loaders. */
export interface PlannerWidgetContext {
  /** The in-browser sample data. */
  source: DataSource;
  /** The shell's resolved sections (renames and hides applied). */
  sections: readonly ShortcutNavSection[];
  /**
   * Layout item id -> the model and scope it lists, for the shortcuts' record
   * counts. Its own key: under `CookbookApp` the shell sets `entries` to its
   * own entry map, which knows no scopes.
   */
  entryIndex: ReadonlyMap<string, SectionEntry>;
  /** An in-app path with the app query (`appHref`). */
  href: (path: string) => string;
  /**
   * The record a detail overview is rendered on (smrt#3718 record view): what
   * a widget's `filter: 'parent'` confines its rows to. Absent on a section
   * page.
   */
  record?: { model: string; id: string };
  /**
   * A record page's relations in the visitor's app (`screenRelations`): the
   * tabs of its `related` widget and the lines of its `line-items` widget.
   */
  relations?: readonly ScreenRelation[];
  /** A related tab's "View all" link. */
  viewAllHref?: (relation: ScreenRelation) => string | undefined;
}

/** The registry every planner overview uses. */
export const overviewRegistry = createWidgetRegistry();

/** What every data widget reads: the sample source and the app's links. */
function dataCapabilities(
  ctx: WidgetLoadContext,
): Pick<PlannerWidgetContext, 'source' | 'href'> {
  const { source, href } = ctx as WidgetLoadContext &
    Partial<PlannerWidgetContext>;
  if (!source || !href) {
    throw new Error('the planner widget context is missing');
  }
  return { source, href };
}

function modelOf(qualified: unknown): {
  model: CatalogModel;
  packageId: string;
  path: string;
} {
  const found =
    typeof qualified === 'string'
      ? getModelByQualifiedName(qualified)
      : undefined;
  if (!found) throw new Error(`unknown model ${String(qualified)}`);
  return {
    model: found.model,
    packageId: found.pkg.id,
    path: modelPath(found.pkg.id, found.model.name),
  };
}

const REF_TYPES = new Set(['foreignKey', 'crossPackageRef']);

/**
 * The one named filter the sample data knows: `parent`, with `field` (a
 * metric's `parentField`, when its `field` is the one measured) the
 * reference field on the widget's model that points at the record the
 * overview is rendered on (`ctx.record`, a detail overview). Any other
 * name is an error tile, as is `parent` outside a record view.
 */
function parentFilter(
  options: Record<string, unknown>,
  ctx: WidgetLoadContext,
  model: CatalogModel,
): { field: string; id: string } | undefined {
  const filter = options.filter;
  if (typeof filter !== 'string' || filter === '') return undefined;
  if (filter !== 'parent') throw new Error(`unknown filter ${filter}`);
  const { record } = ctx as WidgetLoadContext & Partial<PlannerWidgetContext>;
  if (!record?.id) throw new Error('the parent filter needs a record');
  // A metric measuring `field` names the reference as `parentField`.
  const named =
    typeof options.parentField === 'string' && options.parentField
      ? options.parentField
      : options.field;
  const field = typeof named === 'string' ? named : '';
  const target = model.fields.find((f) => f.name === field);
  if (!target || !REF_TYPES.has(target.type)) {
    throw new Error(`${model.name} has no reference field ${field}`);
  }
  return { field, id: record.id };
}

/** The widget's rows: the model's, or those pointing at the record. */
async function rowsOf(
  source: DataSource,
  model: CatalogModel,
  parent: { field: string; id: string } | undefined,
): Promise<ModelRecord[]> {
  return parent
    ? source.listWhere(model, parent.field, parent.id)
    : source.list(model);
}

/** Where the widget's list link goes: the list, narrowed to the record's rows. */
function listHref(
  href: (path: string) => string,
  found: { model: CatalogModel; packageId: string; path: string },
  parent: { field: string; id: string } | undefined,
): string {
  return href(
    parent
      ? filteredListPath(
          found.packageId,
          found.model.name,
          parent.field,
          parent.id,
        )
      : found.path,
  );
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
  const { source, href } = dataCapabilities(ctx);
  const found = modelOf(options.model);
  const { model } = found;
  const parent = parentFilter(options, ctx, model);
  const rows = await rowsOf(source, model, parent);
  const link = listHref(href, found, parent);
  const measure = typeof options.measure === 'string' ? options.measure : '';
  if (measure === 'count' || measure === '') {
    return {
      value: rows.length,
      format: 'integer',
      href: link,
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
    href: link,
  };
}

function compare(a: unknown, b: unknown): number {
  if (numeric(a) && numeric(b)) return a - b;
  return String(a ?? '').localeCompare(String(b ?? ''));
}

/** Framework timestamps the catalog and the samples do not carry. */
const SYSTEM_DATES = new Set(['createdAt', 'updatedAt']);

/** How a table cell renders, by the first of the field's roles a table draws. */
const CELL_ROLES: readonly FieldRole[] = [
  'identifier',
  'status',
  'date',
  'money',
  'quantity',
  'party',
  'title',
];

function cellRole(roles: readonly FieldRole[] = []): FieldRole | undefined {
  return CELL_ROLES.find((role) => roles.includes(role));
}

/**
 * The columns a `records` table shows: the `columns` option's field names
 * when given (unknown names are an error tile), else the framework's
 * `relatedColumns` by role (identifier, status, lead date, a party, the
 * amount: five, as `screenRelations` asks), leaving out the field pointing
 * at the page's record.
 */
function recordColumns(
  model: CatalogModel,
  roles: ScreenFieldRoles,
  option: unknown,
  parentField: string | undefined,
): RecordListColumn[] {
  const definition = screenDefinition(model);
  const exclude = parentField ? [parentField] : [];
  const keys = parseColumnsOption(option);
  if (keys.length === 0) {
    return relatedColumns(definition, roles, { exclude, max: 5 });
  }
  // The framework's own column for a key where it has one (a line's unit
  // price is not summed), else one by the field's roles.
  const known = [
    ...lineItemColumns(definition, roles, { exclude }),
    ...relatedColumns(definition, roles, { exclude, max: keys.length + 8 }),
  ];
  return keys.map((key) => {
    const field = model.fields.find((f) => f.name === key);
    if (!field) throw new Error(`${model.name} has no field ${key}`);
    const framework = known.find((column) => column.key === key);
    if (framework) return framework;
    const role = cellRole(roles[key]);
    return {
      key,
      label: REF_TYPES.has(field.type)
        ? humanize(key.replace(/Id$/, ''))
        : humanize(key),
      ...(role ? { role } : {}),
    };
  });
}

/** The roles a table footer sums. */
const SUMMED: ReadonlySet<FieldRole | undefined> = new Set([
  'money',
  'quantity',
]);

/**
 * Footer sums over EVERY matching row, not only the page shown: the money
 * (integer minor units) and quantity columns, never one marked
 * `summarize: false` (a unit price).
 */
export function recordSummaries(
  columns: readonly RecordListColumn[],
  rows: readonly ModelRecord[],
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const column of columns) {
    if (!(column.summarize ?? SUMMED.has(column.role))) continue;
    out[column.key] = rows.reduce((total, row) => {
      const value = row[column.key];
      return numeric(value) ? total + value : total;
    }, 0);
  }
  return out;
}

/** The one currency of the rows' currency field, else USD. */
function currencyOf(model: CatalogModel, rows: readonly ModelRecord[]): string {
  const field = currencyCodeField(screenDefinition(model));
  const codes = new Set(
    rows
      .map((row) => (field ? row[field] : undefined))
      .filter((v): v is string => typeof v === 'string' && v !== ''),
  );
  return codes.size === 1 ? ([...codes][0] ?? 'USD') : 'USD';
}

/**
 * `records`: the first `limit` sample rows, optionally sorted by a field;
 * each row links to its record page and carries `cells` for the table's
 * columns (raw: money in integer minor units, dates as ISO strings, a
 * reference as its record's label). `summaries` sum the money and quantity
 * columns over every matching row and `total` counts them, so a footer
 * under a page of five orders still totals all of them. A sort by a
 * framework timestamp the samples do not carry (`createdAt`, the record
 * view's default) falls back to the model's lead date, so "newest" still
 * means newest.
 */
async function loadRecords(
  options: Record<string, unknown>,
  ctx: WidgetLoadContext,
): Promise<RecordListWidgetData> {
  const { source, href } = dataCapabilities(ctx);
  const found = modelOf(options.model);
  const { model } = found;
  const parent = parentFilter(options, ctx, model);
  let rows: ModelRecord[] = await rowsOf(source, model, parent);
  if (typeof options.sort === 'string' && options.sort) {
    const named = model.fields.find((f) => f.name === options.sort);
    if (!named && !SYSTEM_DATES.has(options.sort)) {
      throw new Error(`${model.name} has no field ${options.sort}`);
    }
    const carried = rows.some(
      (row) => row[options.sort as string] !== undefined,
    );
    const sort = carried ? options.sort : leadDateField(model)?.name;
    if (sort) {
      const sign = options.direction === 'asc' ? 1 : -1;
      rows = [...rows].sort((a, b) => sign * compare(a[sort], b[sort]));
    }
  }
  const roles = deriveFieldRoles(screenDefinition(model));
  const columns = recordColumns(model, roles, options.columns, parent?.field);
  const limit = numeric(options.limit) ? options.limit : 5;
  const shown = rows.slice(0, limit);
  const refFields = model.fields.filter(
    (f) => REF_TYPES.has(f.type) && columns.some((c) => c.key === f.name),
  );
  const labels = await relationLabels(source, refFields, shown);
  const cellsOf = (row: ModelRecord): Record<string, unknown> =>
    Object.fromEntries(
      columns.map((column) => {
        const value = row[column.key];
        const ref = refFields.find((f) => f.name === column.key);
        if (ref?.related && typeof value === 'string' && value) {
          return [column.key, labels.get(labelKey(ref.related, value)) ?? ''];
        }
        return [column.key, value ?? null];
      }),
    );
  const summaries = recordSummaries(columns, rows);
  // A line item, link row or the like lives inside its parent: no page of
  // its own to link a row or "View all" to.
  const linked = !isPlumbing(model);
  return {
    rows: await Promise.all(
      shown.map(async (row) => ({
        id: String(row.id),
        // On a record's page the parent is the page: leave its name out.
        title: await recordLabel(source, model, row, 0, parent?.field),
        ...(linked
          ? {
              href: href(
                recordPath(found.packageId, model.name, String(row.id)),
              ),
            }
          : {}),
        cells: cellsOf(row),
      })),
    ),
    total: rows.length,
    ...(linked ? { href: listHref(href, found, parent) } : {}),
    columns,
    currency: currencyOf(model, rows),
    ...(Object.keys(summaries).length ? { summaries } : {}),
  };
}

/** The chart's `period` option: how far back from the sample clock it looks. */
const PERIOD_DAYS: Record<string, number | null> = {
  '7d': 7,
  '30d': 30,
  '90d': 90,
  '12m': 365,
  all: null,
};

const DAY = 24 * 60 * 60 * 1000;

/** The bucket a period's date axis uses; coarser as the window widens. */
function bucketOf(period: string): 'day' | 'week' | 'month' {
  if (period === '7d' || period === '30d') return 'day';
  if (period === '90d') return 'week';
  return 'month';
}

/** The start of `date`'s bucket, as a UTC timestamp. */
function bucketStart(ms: number, bucket: 'day' | 'week' | 'month'): number {
  const date = new Date(ms);
  if (bucket === 'month') {
    return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
  }
  const day = Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
  );
  // ISO weeks start on Monday.
  return bucket === 'week' ? day - ((date.getUTCDay() + 6) % 7) * DAY : day;
}

function nextBucket(ms: number, bucket: 'day' | 'week' | 'month'): number {
  if (bucket === 'month') {
    const date = new Date(ms);
    return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
  }
  return ms + (bucket === 'week' ? 7 : 1) * DAY;
}

/** A deterministic, locale-free axis label: `2025-11` or `2025-11-03`. */
function bucketLabel(ms: number, bucket: 'day' | 'week' | 'month'): string {
  const iso = new Date(ms).toISOString();
  return bucket === 'month' ? iso.slice(0, 7) : iso.slice(0, 10);
}

const isDateField = (field: { type: string; system?: boolean }) =>
  field.type === 'datetime' && !field.system;

/** The model's lead date, for the period window: `issueDate`-like names first. */
function leadDateField(model: CatalogModel) {
  const dated = model.fields.filter(isDateField);
  return (
    dated.find((f) => /^(issue|order|start|created)/i.test(f.name)) ?? dated[0]
  );
}

function dateOf(value: unknown): number | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : undefined;
}

/**
 * `chart`: one measure of the model's sample rows grouped by a field. This is
 * the IN-BROWSER STAND-IN for a runtime report: a generated app's chart
 * loader hands these same options to the runtime report compiler and renders
 * what it returns; the planner groups the seeded rows itself so the widget
 * can be tried before a server exists.
 *
 * `groupBy` names a field: a date field is bucketed (days for `7d`/`30d`,
 * weeks for `90d`, months for `12m`/`all`) with empty buckets kept so a line
 * stays continuous; any other field groups by value, largest first. Absent,
 * the model's lead date field is used. `period` is a window back from the
 * sample clock (`EPOCH`, the fixed "now" of the seeded data) over the
 * grouped date field, else the lead date field; a model with no date field
 * ignores it. `measure` is `count`, or `sum` / `avg` of a numeric `field`;
 * money stays integer minor units. The widget's `style` (bar, line, table,
 * pie or stat) is rendered by the widget itself from these points: `stat`
 * headlines the last point against the one before, which on a date axis is
 * the latest bucket.
 */
async function loadChart(
  options: Record<string, unknown>,
  ctx: WidgetLoadContext,
): Promise<ChartWidgetData> {
  const { source, href } = dataCapabilities(ctx);
  const found = modelOf(options.model);
  const { model } = found;
  const parent = parentFilter(options, ctx, model);
  const groupName = typeof options.groupBy === 'string' ? options.groupBy : '';
  const groupField = groupName
    ? model.fields.find((f) => f.name === groupName)
    : leadDateField(model);
  if (!groupField) {
    throw new Error(
      groupName
        ? `${model.name} has no field ${groupName}`
        : `${model.name} has no date field to chart; choose a group-by field`,
    );
  }
  const measure = typeof options.measure === 'string' ? options.measure : '';
  let valueField: CatalogModel['fields'][number] | undefined;
  if (measure && measure !== 'count') {
    if (measure !== 'sum' && measure !== 'avg') {
      throw new Error(`unknown measure ${measure}`);
    }
    valueField = model.fields.find((f) => f.name === options.field);
    if (
      !valueField ||
      (valueField.type !== 'integer' && valueField.type !== 'decimal')
    ) {
      throw new Error(`${measure} needs a numeric field of ${model.name}`);
    }
  }
  const period = typeof options.period === 'string' ? options.period : '30d';
  if (!Object.hasOwn(PERIOD_DAYS, period)) {
    throw new Error(`unknown period ${period}`);
  }
  const days = PERIOD_DAYS[period];
  const byDate = isDateField(groupField);
  const windowField = byDate ? groupField : leadDateField(model);
  const since =
    days !== null && windowField
      ? EPOCH - days * DAY
      : Number.NEGATIVE_INFINITY;

  let rows = await rowsOf(source, model, parent);
  if (windowField && since !== Number.NEGATIVE_INFINITY) {
    rows = rows.filter((row) => {
      const at = dateOf(row[windowField.name]);
      return at !== undefined && at >= since && at <= EPOCH;
    });
  }

  // Group: each bucket keeps the count and the sum, so `avg` is sum / count.
  const groups = new Map<
    string,
    { key: number | string; sum: number; n: number }
  >();
  const add = (label: string, key: number | string, row: ModelRecord) => {
    const group = groups.get(label) ?? { key, sum: 0, n: 0 };
    if (valueField) {
      const value = row[valueField.name];
      if (!numeric(value)) return;
      group.sum += value;
    }
    group.n += 1;
    groups.set(label, group);
  };
  const bucket = bucketOf(period);
  if (byDate) {
    // Every bucket of the window, in order, empty ones included.
    const start =
      since !== Number.NEGATIVE_INFINITY
        ? since
        : Math.min(
            ...rows.map((row) => dateOf(row[groupField.name]) ?? EPOCH),
            EPOCH,
          );
    for (
      let at = bucketStart(start, bucket);
      at <= EPOCH;
      at = nextBucket(at, bucket)
    ) {
      groups.set(bucketLabel(at, bucket), { key: at, sum: 0, n: 0 });
    }
    for (const row of rows) {
      const at = dateOf(row[groupField.name]);
      if (at === undefined) continue;
      const startOfBucket = bucketStart(at, bucket);
      add(bucketLabel(startOfBucket, bucket), startOfBucket, row);
    }
  } else {
    for (const row of rows) {
      const value = row[groupField.name];
      const label =
        value === null || value === undefined || value === ''
          ? '(none)'
          : String(value);
      add(label, label, row);
    }
  }

  const money = valueField ? isMoneyField(valueField) : false;
  const measureOf = (group: { sum: number; n: number }): number => {
    if (!valueField) return group.n;
    const value =
      measure === 'avg' && group.n ? group.sum / group.n : group.sum;
    return money ? Math.round(value) : value;
  };
  let points = [...groups.entries()].map(([label, group]) => ({
    label,
    value: measureOf(group),
    key: group.key,
  }));
  points = byDate
    ? points.sort((a, b) => Number(a.key) - Number(b.key))
    : points.sort(
        (a, b) => b.value - a.value || a.label.localeCompare(b.label),
      );
  return {
    points: points.map(({ label, value }) => ({ label, value })),
    format: !valueField
      ? 'integer'
      : money
        ? 'money'
        : valueField.type === 'integer'
          ? 'integer'
          : 'decimal',
    ...(money ? { currency: 'USD' } : {}),
    href: listHref(href, found, parent),
  };
}

/**
 * The shortcuts' record counts: a `CookbookShortcutsLoader` that gives each of
 * the shell's default entries (the section's menu as resolved: renames, hides,
 * moves) its count of sample rows, in the entry's own scope. The framework
 * composes it with its entries (`composeShortcutsLoader`): under the mounted
 * `Planner`'s `CookbookApp` as `loaders.shortcuts`, on the static app's
 * section pages through {@link overviewRegistry}. An entry the index does not
 * know (no model) keeps no count.
 */
export const loadShortcutCounts: CookbookShortcutsLoader = async (
  ctx,
  defaults,
) => {
  const { source, entryIndex } = ctx as WidgetLoadContext &
    Partial<PlannerWidgetContext>;
  if (!source || !entryIndex) {
    throw new Error('the planner widget context is missing');
  }
  return Promise.all(
    defaults.map(async (item) => {
      const entry = entryIndex.get((item as { id?: string }).id ?? '');
      if (!entry) return item;
      const rows = await source.list(entry.model);
      return {
        ...item,
        count: rows.filter((row) => inScope(entry.scope, row)).length,
      };
    }),
  );
};

/**
 * The data loaders over the sample source and the shortcuts' counts, for the
 * mounted `Planner`'s `CookbookApp`, whose registry composes `shortcuts` with
 * the shell's entries.
 */
export const plannerLoaders = {
  metric: loadMetric,
  records: loadRecords,
  chart: loadChart,
  shortcuts: loadShortcutCounts,
} satisfies Omit<CoreWidgetLoaders, 'shortcuts'> & {
  shortcuts: CookbookShortcutsLoader;
};

registerCoreWidgets(overviewRegistry, {
  ...plannerLoaders,
  shortcuts: composeShortcutsLoader(loadShortcutCounts),
});

/**
 * The record page's own widgets (smrt#3718), registered once on the shared
 * registry so a cookbook's stored record overview validates like a
 * section's. The framework builds them from one record view's relations;
 * the planner hands those over in the load context (`relations`,
 * `viewAllHref`), and every tab or line list is one call of
 * {@link loadRecords} with the parent filter.
 */
function recordWidgetOptions(ctx: WidgetLoadContext) {
  const { relations, viewAllHref } = ctx as WidgetLoadContext &
    Partial<PlannerWidgetContext>;
  if (!relations) throw new Error('the record page context is missing');
  return { relations, records: loadRecords, viewAllHref };
}

/**
 * The page's record, read fresh at load time, for the line-items totals
 * block: an issued document's frozen money (`storedDocumentTotals`, shown as
 * stored with a row per tax component), else a draft's own totals by role
 * (`documentTotals`, read against its lines); and its currency code.
 */
async function recordFigures(
  ctx: WidgetLoadContext,
  relations: readonly ScreenRelation[],
): Promise<{
  totals?: LineItemsTotals;
  storedTotals?: StoredLineItemsTotals;
  currency?: string;
}> {
  const { source } = dataCapabilities(ctx);
  const ref = ctx.record;
  if (!ref?.id) throw new Error('line items need a record');
  const { model } = modelOf(ref.model);
  const record = await source.get(model, ref.id);
  if (!record) return {};
  const items = relations.find((r) => r.kind === 'items');
  const lineModel = items
    ? getModelByQualifiedName(items.model)?.model
    : undefined;
  const lines =
    items && lineModel
      ? await source.listWhere(lineModel, items.field, ref.id)
      : [];
  const storedTotals = storedDocumentTotals(model, record, lines);
  const totals = storedTotals ? undefined : documentTotals(model, record);
  const code = currencyCodeField(screenDefinition(model));
  const currency = code ? record[code] : undefined;
  return {
    ...(storedTotals ? { storedTotals } : {}),
    ...(totals ? { totals } : {}),
    ...(typeof currency === 'string' && currency ? { currency } : {}),
  };
}

overviewRegistry.register(
  createRelatedWidget((options, ctx) =>
    createRelatedLoader(recordWidgetOptions(ctx))(options, ctx),
  ),
);
overviewRegistry.register(
  createLineItemsWidget(async (options, ctx) => {
    const base = recordWidgetOptions(ctx);
    const { totals, storedTotals, currency } = await recordFigures(
      ctx,
      base.relations,
    );
    return createLineItemsLoader({
      ...base,
      totals: () => totals,
      storedTotals: () => storedTotals,
      currency: () => currency,
    })(options, ctx);
  }),
);

/** The core widget types a section overview offers. */
export const CORE_WIDGET_TYPES = [
  'shortcuts',
  'metric',
  'records',
  'chart',
  'note',
] as const;

/**
 * How a recipe widget's `'<specifier>#<Export>'` becomes a module: a static map
 * of dynamic imports, one entry per package that ships widgets. The only
 * published widget surface (smrt-reports' `runtime-report-chart`) needs a
 * server, so the map is empty and every lookup is `undefined` (the widget then
 * renders as unavailable).
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
