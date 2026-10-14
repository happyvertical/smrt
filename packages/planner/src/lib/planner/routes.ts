/**
 * The model pages' paths and how a route under `/m/` reads. One place for the
 * static app (`src/routes/m/`), the mounted `Planner`'s hash router and every
 * link to a record, so they agree:
 *
 * - `/m/<pkg>/<Model>/` the list; `?<fk>=<id>` narrows it to the rows whose
 *   reference field `<fk>` points at the record `<id>` ("View all" on a
 *   record's related panel).
 * - `/m/<pkg>/<Model>/<key>/` a keyed nav entry (a model shown twice in the
 *   menu); the key is known from the recipes.
 * - `/m/<pkg>/<Model>/<id>/` a record's view page, `/<id>/edit/` its edit
 *   page. A segment that is not a known key is a record id.
 */
import type { CatalogModel } from '../catalog/types.ts';
import type { RowScope } from '../recipes/scope.ts';

export type RecordMode = 'view' | 'edit';

export interface ModelRoute {
  packageId: string;
  modelName: string;
  /** The nav entry key, for a keyed entry page. */
  view?: string;
  /** The record the page shows, with how. */
  recordId?: string;
  mode?: RecordMode;
}

const REF_TYPES = new Set(['foreignKey', 'crossPackageRef']);

export function modelPath(packageId: string, modelName: string): string {
  return `/m/${packageId}/${modelName}/`;
}

export function recordPath(
  packageId: string,
  modelName: string,
  id: string,
  mode: RecordMode = 'view',
): string {
  const base = `${modelPath(packageId, modelName)}${encodeURIComponent(id)}/`;
  return mode === 'edit' ? `${base}edit/` : base;
}

/** The list narrowed to the rows whose `field` points at the record `id`. */
export function filteredListPath(
  packageId: string,
  modelName: string,
  field: string,
  id: string,
): string {
  return `${modelPath(packageId, modelName)}?${encodeURIComponent(field)}=${encodeURIComponent(id)}`;
}

/**
 * Read the segments after `m/` (`['commerce', 'Order', <id>, 'edit']`).
 * `isViewKey` says whether a third segment is a keyed nav entry of the model;
 * otherwise it is a record id. `undefined` for a shape that is not a model
 * page (`m/commerce/Order/x/y/` and the like).
 */
export function parseModelRoute(
  parts: readonly string[],
  isViewKey: (packageId: string, modelName: string, key: string) => boolean,
): ModelRoute | undefined {
  const [packageId, modelName, third, fourth, ...rest] = parts;
  if (!packageId || !modelName || rest.length) return undefined;
  if (third === undefined) return { packageId, modelName };
  if (fourth === undefined) {
    if (isViewKey(packageId, modelName, third)) {
      return { packageId, modelName, view: third };
    }
    return { packageId, modelName, recordId: third, mode: 'view' };
  }
  if (fourth !== 'edit' || isViewKey(packageId, modelName, third)) {
    return undefined;
  }
  return { packageId, modelName, recordId: third, mode: 'edit' };
}

/** A fragment route (`/m/commerce/Order/?customerId=x`) split into path and query. */
export function splitRoute(route: string): { path: string; search: string } {
  const at = route.indexOf('?');
  return at < 0
    ? { path: route, search: '' }
    : { path: route.slice(0, at), search: route.slice(at) };
}

/**
 * The `?<fk>=<id>` filter of a list page, when the query names a reference
 * field of the model with a non-empty value. Any other parameter (the package
 * selection, the Planner tab) is not a filter.
 */
export function recordFilter(
  search: string,
  model: Pick<CatalogModel, 'fields'>,
): RowScope | undefined {
  const params = new URLSearchParams(search);
  for (const field of model.fields) {
    if (!REF_TYPES.has(field.type)) continue;
    const value = params.get(field.name);
    if (value) return { field: field.name, equals: value };
  }
  return undefined;
}

/** The `?<fk>=<id>` pair as a query fragment to keep in a list page's URL. */
export function recordFilterQuery(scope: RowScope | undefined): string {
  return scope?.equals !== undefined
    ? `${encodeURIComponent(scope.field)}=${encodeURIComponent(scope.equals)}`
    : '';
}
