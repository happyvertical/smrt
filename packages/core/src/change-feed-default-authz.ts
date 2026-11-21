/**
 * Default change-feed table policy (#5446): with no table authorizer
 * registered, the feed serves what a list/get of each table's model would
 * serve on the same transport. See `change-feed-authz.ts`'s module docs for
 * the full rule; this module evaluates it.
 *
 * Interim internal-model rule (replaced by the shared internal-model rule
 * the T-exposure work states for every transport):
 * - framework tables (`CHANGE_FEED_EXCLUDED_TABLES`), sensitive tables,
 *   tables no registered model owns, and tables whose registrations are all
 *   abstract are never served. A registered domain model is decided by its
 *   own rules even when its table name starts with `_smrt_` (#2376);
 * - every registration is first resolved to the model that serves its rows
 *   (`ObjectRegistry.getExposureModel`, as the REST routes resolve a
 *   collection registration to its item), so a collection never decides its
 *   item's table on its own terms;
 * - an STI table is decided by its base model alone, so a subtype is served
 *   only through its base's table. Feed entries of subtype rows the caller
 *   could not list are still served once the base passes (interim; REST
 *   list filters subtype rows per caller);
 * - a junction row model (the item class of a `SmrtJunction` /
 *   `SmrtJunctionBase` collection) is served only when its own
 *   `@smrt({ api })` is declared and opens `list`;
 * - when several models decide one table, every one of them must pass.
 */

import { isApiActionEnabledForObject } from './api-action-gate.js';
import { isChangeFeedObservableTable } from './change-feed.js';
import type { ChangeFeedRequestContext } from './change-feed-authz.js';
import { resolveDispatchTenantScope } from './dispatch/tenant-resolver.js';
import type { RegisteredClass } from './registry/types.js';
import { ObjectRegistry } from './registry.js';
import { isRuntimeModelEnabled } from './runtime-exposure.js';

function registryKeyOf(info: RegisteredClass): string {
  return info.qualifiedName || info.name;
}

/** Whether the model is the row class of a junction collection. */
function isJunctionRowModel(info: RegisteredClass): boolean {
  const collection = info.collectionConstructor as
    | { _isJunctionBase?: boolean }
    | undefined;
  return collection?._isJunctionBase === true;
}

/**
 * The deciding models of every served-candidate table: each registration is
 * resolved to the model serving its rows, then an STI subtype to its base.
 * Tables whose registrations are all abstract are left out.
 */
function tableDeciders(): Map<string, RegisteredClass[]> {
  const byTable = new Map<
    string,
    { deciders: Map<string, RegisteredClass>; concrete: boolean }
  >();
  const seen = new Set<RegisteredClass>();
  for (const [key, info] of ObjectRegistry.getAllClasses()) {
    if (seen.has(info)) continue;
    seen.add(info);
    const name = registryKeyOf(info) || key;
    const table = ObjectRegistry.getTableName(name);
    // Framework and sensitive tables are never served, whatever registers them.
    if (!table || !isChangeFeedObservableTable(table)) continue;
    const rowModel = ObjectRegistry.getExposureModel(name) ?? info;
    const stiBase = ObjectRegistry.getSTIBase(registryKeyOf(rowModel));
    const decider = stiBase ? ObjectRegistry.getClass(stiBase) : rowModel;
    if (!decider) continue;
    let entry = byTable.get(table);
    if (!entry) {
      entry = { deciders: new Map(), concrete: false };
      byTable.set(table, entry);
    }
    entry.deciders.set(registryKeyOf(decider), decider);
    if (!info.config?.abstract) entry.concrete = true;
  }
  const result = new Map<string, RegisteredClass[]>();
  for (const [table, entry] of byTable) {
    if (entry.concrete) result.set(table, [...entry.deciders.values()]);
  }
  return result;
}

/** Middleware answers per request and object name (#5446 D2). */
const middlewareDecisions = new WeakMap<
  Request,
  Map<string, Promise<boolean>>
>();

/** The REST route middleware's `get` decision, asked once per request and name. */
function middlewareAdmits(
  ctx: ChangeFeedRequestContext,
  request: Request,
  objectName: string,
): Promise<boolean> {
  const middleware = ctx.authMiddleware;
  if (!middleware) return Promise.resolve(true);
  let byName = middlewareDecisions.get(request);
  if (!byName) {
    byName = new Map();
    middlewareDecisions.set(request, byName);
  }
  let decision = byName.get(objectName);
  if (!decision) {
    decision = Promise.resolve()
      .then(() => middleware(objectName, 'get')(request))
      .then(
        (answer) => !(answer instanceof Response),
        () => false,
      );
    byName.set(objectName, decision);
  }
  return decision;
}

/** Whether `model`'s list would be served to this request on its transport. */
async function servesModel(
  model: RegisteredClass,
  ctx: ChangeFeedRequestContext,
  tenantId: string | null | undefined,
): Promise<boolean> {
  const key = registryKeyOf(model);
  // A REST server serves only its own models, under the object name its
  // routes use for them (`getCollectionObjectName(collection) || segment`
  // for an explicitly registered collection, the registry key otherwise).
  let objectName = key;
  if (ctx.servedModels) {
    const served = ctx.servedModels.get(key);
    if (served === undefined) return false;
    objectName = served;
  }
  if (!isApiActionEnabledForObject(objectName, 'list')) return false;
  if (isJunctionRowModel(model)) {
    const api = ObjectRegistry.getConfig(key).api;
    if (api === undefined || api === false) return false;
  }
  if (
    !isRuntimeModelEnabled(ObjectRegistry.getExposureModel(key) ?? key, {
      surface: 'rest',
      tenantId: tenantId ?? undefined,
      request: ctx.request,
      locals: ctx.locals,
    })
  ) {
    return false;
  }
  if (ctx.authMiddleware) {
    if (!ctx.request) return false;
    if (!(await middlewareAdmits(ctx, ctx.request, objectName))) return false;
  }
  return true;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * The tenant a generated SvelteKit list route acts for, from `locals`
 * (`tenantId`, `user`, `session`, `tenantContext`, in that order), mirroring
 * the route's own `requestTenantOf(locals)`.
 */
function tenantFromLocals(locals: unknown): string | undefined {
  const l = record(locals);
  const tenant =
    l.tenantId ??
    record(l.user).tenantId ??
    record(l.session).tenantId ??
    record(l.tenantContext).tenantId;
  return typeof tenant === 'string' && tenant ? tenant : undefined;
}

/**
 * The tenant for the runtime exposure check: the tenant the transport's list
 * route resolved (`ctx.exposureTenantId`, REST's
 * `requestTenant().effectiveTenantId`),
 * else the one `locals` names (SvelteKit), else the captured or active
 * tenant scope.
 */
function exposureTenant(ctx: ChangeFeedRequestContext): string | null {
  if (ctx.exposureTenantId !== undefined) return ctx.exposureTenantId;
  const fromLocals = tenantFromLocals(ctx.locals);
  if (fromLocals) return fromLocals;
  if (ctx.ambientTenantId !== undefined) return ctx.ambientTenantId;
  return resolveDispatchTenantScope().tenantId;
}

/**
 * The tables the default policy serves to this request. A check that throws
 * for a model refuses that model's table.
 */
export async function defaultChangeFeedTables(
  ctx: ChangeFeedRequestContext,
): Promise<string[]> {
  const tenantId = exposureTenant(ctx);
  const served: string[] = [];
  for (const [table, deciders] of tableDeciders()) {
    // On a REST server, only its own models decide; a table none of them
    // owns is not served there.
    const candidates = ctx.servedModels
      ? deciders.filter((model) => ctx.servedModels?.has(registryKeyOf(model)))
      : deciders;
    if (candidates.length === 0) continue;
    let all = true;
    for (const decider of candidates) {
      let ok = false;
      try {
        ok = await servesModel(decider, ctx, tenantId);
      } catch {
        ok = false;
      }
      if (!ok) {
        all = false;
        break;
      }
    }
    if (all) served.push(table);
  }
  return served;
}
