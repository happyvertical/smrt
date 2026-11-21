/**
 * The REST half of the served-surface inventory, as a pure function over the
 * resolvers the SvelteKit route emitter itself calls, so the worker and the
 * cross-check test (core
 * `vite-plugin/__tests__/served-surface-crosscheck.spec.ts`) run the same
 * code:
 *
 * - CRUD: models only (`exposedCrudVerbs` on the effective `api`); a
 *   collection class gets no REST CRUD. `path` is the resource's route
 *   directory (its `collection`).
 * - Actions: `resolveApiCustomActions`, the emitter's collection-aware
 *   eligibility (a collection over an abstract item serves none), then
 *   `resolveApiActionRouteConfig` for the verb, scope and route path
 *   (`api.routes[name].path` and `@method({ path })` included), with the
 *   default scope the emitter passes (a collection's actions are
 *   collection-scoped).
 * - `auth`: `open` when `api.public` is `true`, or `'read'` and the verb is
 *   GET, as the generated handler decides. `permission`: the slug a
 *   non-GET handler requires, `<permission collection>.<action or its
 *   operationPermissions alias>` (the item's collection for a collection's
 *   action), or `false` for a GET action or a `public: true` resource
 *   (`requireRoutePermission` returns early there). `crudPermission`: the
 *   permission collection the create/update/delete handlers check
 *   (`<collection>.<verb>`), recorded whenever one of those verbs is served
 *   and the resource is not `public: true`. The tenant-context guard is not
 *   modelled.
 *
 * Nothing here catches: a resolver that throws fails the package's run.
 */

const byCodeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** CRUD verbs whose generated handlers run the operation-permission guard. */
const MUTATING_CRUD = new Set(['create', 'update', 'delete']);

/** `api.public` as the route generator reads it (vite-plugin/route-policy.ts). */
export function publicAccess(api) {
  const value = api && typeof api === 'object' ? api.public : undefined;
  return value === true || value === 'read' ? value : false;
}

/**
 * @param resolvers `{ exposedCrudVerbs, resolveApiCustomActions,
 *   resolveApiActionRouteConfig, resolveCollectionItemObject,
 *   resolvePermissionCollection, resolveOperationPermissionAlias }`, the
 *   functions the route emitter uses.
 * @param options `{ definition, manifest, isCollection, isModelClassName }`:
 *   `definition` is the resource's manifest definition with its effective
 *   config as `decoratorConfig` and its methods as a record; `manifest` holds
 *   every definition of the composition the same way (the item lookup).
 * @returns `false`, or `{ path, crud?, actions?, public?, crudPermission? }`
 */
export function restSurface(
  resolvers,
  { definition, manifest, isCollection, isModelClassName },
) {
  const apiConfig = definition.decoratorConfig?.api;
  if (apiConfig === false) return false;
  const surface = { path: definition.collection };
  if (!isCollection) {
    const crud = resolvers.exposedCrudVerbs(apiConfig).slice().sort(byCodeUnit);
    if (crud.length) surface.crud = crud;
  }
  const isPublic = publicAccess(apiConfig);
  const { exposed } = resolvers.resolveApiCustomActions(
    definition,
    manifest,
    isCollection,
    isModelClassName ? { isModelClassName } : {},
  );
  // A collection's action handlers check the item collection's permission.
  const permissionDefinition = isCollection
    ? (resolvers.resolveCollectionItemObject(manifest, definition) ?? definition)
    : definition;
  const actions = {};
  for (const [name, method] of [...exposed].sort(([a], [b]) => byCodeUnit(a, b))) {
    const route = isCollection
      ? resolvers.resolveApiActionRouteConfig(name, method, apiConfig, {}, 'collection')
      : resolvers.resolveApiActionRouteConfig(name, method, apiConfig, {});
    const verb = route.method;
    const base =
      isCollection || route.scope === 'collection'
        ? [definition.collection]
        : [definition.collection, '[id]'];
    const alias = resolvers.resolveOperationPermissionAlias(
      definition.decoratorConfig,
      name,
    )?.action;
    actions[name] = {
      verb,
      scope: route.scope,
      route: [...base, ...route.pathSegments].join('/'),
      auth:
        isPublic === true || (isPublic === 'read' && verb === 'GET')
          ? 'open'
          : 'required',
      permission:
        verb !== 'GET' && isPublic !== true
          ? `${resolvers.resolvePermissionCollection(permissionDefinition)}.${alias ?? name}`
          : false,
    };
  }
  if (Object.keys(actions).length) surface.actions = actions;
  if (!surface.crud && !surface.actions) return false;
  if (isPublic) surface.public = isPublic;
  // The CRUD write handlers require `<permission collection>.<verb>`; the
  // collection is not always the route's (`permissionCollection`, an
  // explicit `@smrt({ collection })`), so it is recorded on its own.
  if (
    isPublic !== true &&
    surface.crud?.some((verb) => MUTATING_CRUD.has(verb))
  )
    surface.crudPermission = resolvers.resolvePermissionCollection(definition);
  return surface;
}
