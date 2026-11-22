// The permission slugs of an app's definition (#5188): the `<collection>.<action>`
// names core's `operationPermissionOf` reads for the app's runtime models.
// Kept apart from principal.ts, which the worker handle imports on the main
// thread and so must not pull in the definition (and with it the reports package).

import {
  type AppDefinition,
  type ModelDef,
  tableFor,
  toolNamesFor,
} from './definition.ts';

/**
 * The collection segment of a model's slugs: core's `operationPermissionOf`
 * reads a runtime model's registered collection, which is its table (a
 * subclass of a shipped model takes its parent's, which `tableFor` resolves).
 * `principal.test.ts` asserts this against core's own function.
 */
export const collectionOf = (model: string, md: ModelDef) =>
  tableFor(model, md);

/** `<collection>.<action>` of one model. */
export const slugFor = (def: AppDefinition, model: string, action: string) =>
  `${collectionOf(model, def.models[model])}.${action}`;

/** Every slug of the app: list/get/create/update/delete and each method, per model. */
export function appPermissionSlugs(def: AppDefinition): string[] {
  const out: string[] = [];
  for (const [m, md] of Object.entries(def.models))
    for (const a of [
      'list',
      'get',
      'create',
      'update',
      'delete',
      ...Object.keys(md.methods ?? {}),
    ])
      out.push(`${collectionOf(m, md)}.${a}`);
  return out;
}

/** The model and action a generated tool name stands for. */
export function toolTarget(
  def: AppDefinition,
  name: string,
): { model: string; action: string } | null {
  for (const [m, md] of Object.entries(def.models)) {
    const names = toolNamesFor(m, md);
    const i = names.indexOf(name);
    if (i < 0) continue;
    const actions = [
      'list',
      'get',
      'create',
      'update',
      'delete',
      ...Object.keys(md.methods ?? {}),
    ];
    return { model: m, action: actions[i] };
  }
  return null;
}

/** The model whose table is `table`, if the app owns one. */
export function modelOfTable(def: AppDefinition, table: string): string | null {
  for (const [m, md] of Object.entries(def.models))
    if (tableFor(m, md) === table) return m;
  return null;
}
