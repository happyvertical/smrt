/**
 * Generated `_preflight` HTTP route for browser-plane playbook preflight
 * (issue #2590).
 *
 * Handles `GET {basePath}/_preflight?key=<playbook key>` in the REST generator:
 * an advisory, read-effect, idempotent report of what a caller's playbook would
 * be allowed to do — *predicted*, never granted. Every step is authorized again
 * where it executes; this route is capability **selection**, never
 * authorization (epic #2585 invariant 2).
 *
 * ## `authMiddleware` is never invoked here
 *
 * Generated REST authorization is
 * `authMiddleware?: (objectName, action) => (req) => Promise<Request | Response>`
 * — request-bound, `Response`-returning rather than boolean, and free to consult
 * session stores, rate-limit, or audit. It is not a dry-run predicate, and a
 * synthetic-`Request` dry run of it would be a side effect the caller never
 * asked for.
 *
 * That is enforced **structurally**, not by discipline:
 * {@link PlaybookPreflightRouteOptions} has no `authMiddleware` member and no
 * function-valued auth member of any kind. `rest.ts` passes the boolean
 * `appAuthConfigured` and nothing else, so there is no handle in this module to
 * invoke even by mistake. The app-auth layer is consequently reported as
 * `unknown`, which is the honest answer.
 *
 * ## Why the provider is injected
 *
 * Resolution and verdict shaping live in `@happyvertical/smrt-playbooks`, which
 * depends on this package. Core therefore owns the route and the static-layer
 * facts (`ObjectRegistry` is core's), and takes the evaluator as a seam — the
 * dependency stays one-way.
 */

import { ObjectRegistry } from '../registry.js';
import type { MethodDefinition } from '../scanner/types.js';
import { PRIVATE_READ_CACHE_CONTROL } from './conditional-get.js';
import {
  declaresRuntimeRestRoute,
  resolveEffectiveActionMetadata,
} from './custom-action.js';

/** Path segment the preflight route is served at, under the API base path. */
export const PLAYBOOK_PREFLIGHT_ROUTE_SEGMENT = '_preflight';

/**
 * Capability classification of the preflight route: a read, safely repeatable,
 * and closed-world. It is admitted by a default read-only browser exposure
 * policy without an opt-in, because it reports on the system rather than
 * changing it.
 */
export const PLAYBOOK_PREFLIGHT_CAPABILITY = Object.freeze({
  effect: 'read',
  idempotent: true,
  openWorld: false,
} as const);

/**
 * The request handed to a preflight provider. Deliberately carries no request,
 * no headers, and no auth handle — only the caller-scoped facts the static
 * layers need.
 */
export interface PlaybookPreflightRouteRequest {
  /** The requested playbook key. */
  key: string;
  /** Always `'browser'` from this route. */
  plane: 'browser';
  /** The caller's published permission slugs, when the API context has them. */
  permissions?: Iterable<string>;
  /** Whether an app auth middleware is wired. A boolean; never the function. */
  appAuthConfigured: boolean;
  /** The generator's `APIContext.db`. */
  db?: unknown;
}

/**
 * Host-supplied browser-plane preflight evaluator, wired from
 * `@happyvertical/smrt-playbooks`. Returns a JSON-serializable report.
 */
export type PlaybookPreflightProvider = (
  request: PlaybookPreflightRouteRequest,
) => Promise<unknown>;

/**
 * Options for {@link handlePlaybookPreflightRoute}.
 *
 * There is intentionally no `authMiddleware` member — see the module docs.
 */
export interface PlaybookPreflightRouteOptions {
  provider?: PlaybookPreflightProvider;
  permissions?: Iterable<string>;
  appAuthConfigured: boolean;
  db?: unknown;
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': PRIVATE_READ_CACHE_CONTROL,
    },
  });
}

/**
 * Serves `GET {basePath}/_preflight?key=<key>`.
 *
 * Unresolvable keys are the provider's concern: it returns the same uniform
 * "unavailable" body for an unknown key as for an unauthorized one, and this
 * route serves whatever it returns with an unconditional 200, so the HTTP layer
 * adds no way to tell them apart either.
 */
export async function handlePlaybookPreflightRoute(
  req: Request,
  options: PlaybookPreflightRouteOptions,
): Promise<Response> {
  if (!options.provider) {
    // Route not wired for this deployment. Says nothing about any key.
    return jsonResponse({ error: 'Not found' }, 404);
  }

  if (req.method !== 'GET') {
    return jsonResponse({ error: 'Method not allowed' }, 405);
  }

  const key = new URL(req.url).searchParams.get('key');
  if (!key) {
    return jsonResponse({ error: "Query parameter 'key' is required" }, 400);
  }

  const report = await options.provider({
    key,
    plane: 'browser',
    ...(options.permissions ? { permissions: options.permissions } : {}),
    appAuthConfigured: options.appAuthConfigured,
    db: options.db,
  });

  return jsonResponse(report, 200);
}

/**
 * Resolves a qualified model reference (`@happyvertical/smrt-commerce:Order`)
 * to the name the registry and the REST generator key configuration by.
 *
 * Returns `undefined` for anything this build does not register, so the caller
 * fails closed rather than reporting on a model that has no route.
 */
export function resolveRegisteredObjectName(model: string): string | undefined {
  const registered = model.includes(':')
    ? ObjectRegistry.getClassByQualifiedName(model)
    : ObjectRegistry.getClass(model);
  return registered?.name;
}

/**
 * The HTTP method a REST action is served by.
 *
 * CRUD actions map to their fixed verbs. A custom action is served under the
 * method its own declaration supplies — `@method({ httpMethod })` first, then
 * `api.routes[action].method`, defaulting to `POST` exactly as
 * `dispatchCustomCollectionAction` does — because guessing `POST` for a
 * declared `GET` action would make preflight report a false `deny` on a
 * `public: 'read'` model, hiding a playbook the caller can actually run, which
 * is the tool-listing case this exists to serve. Without an `objectName` to
 * read the declaration from, the fail-closed `POST` remains.
 */
export function restMethodForApiAction(
  action: string,
  objectName?: string,
): string {
  switch (action) {
    case 'list':
    case 'get':
      return 'GET';
    case 'create':
      return 'POST';
    case 'update':
      return 'PUT';
    case 'delete':
      return 'DELETE';
    default:
      break;
  }

  if (!objectName) {
    return 'POST';
  }

  const apiConfig = ObjectRegistry.getConfig(objectName)?.api;
  if (!apiConfig || typeof apiConfig !== 'object') {
    return 'POST';
  }

  const effective = resolveEffectiveActionMetadata({
    actionName: action,
    ...(readRegisteredMethod(objectName, action)
      ? { method: readRegisteredMethod(objectName, action) }
      : {}),
    apiConfig,
  });
  return (effective.httpMethod ?? 'POST').toUpperCase();
}

/** The manifest method definition backing `action`, when the registry has it. */
function readRegisteredMethod(
  objectName: string,
  action: string,
): MethodDefinition | undefined {
  return ObjectRegistry.getMethods(objectName)?.get(action);
}

/**
 * Whether `@smrt({ api })` exposes `action` on `objectName`.
 *
 * The generator's own action gate, lifted to a module function so preflight and
 * the live route read the same rule from one place. Accepts any action name so
 * a custom action is gated by the same `include`/`exclude` lists.
 *
 * @remarks An absent `objectName` returns `true` — fail-**open**, because the
 * live route reaches this only after it has already resolved a model, and an
 * unnamed object there means "not gated by this rule". A caller *predicting*
 * rather than serving has no such guarantee and must reject an unresolvable
 * model before asking (see `createRestPreflightLayerSource`).
 */
export function isApiActionEnabledForObject(
  objectName: string | undefined,
  action: string,
): boolean {
  if (!objectName) {
    return true;
  }

  const apiConfig = ObjectRegistry.getConfig(objectName).api;

  if (apiConfig === false) {
    return false;
  }

  if (apiConfig && typeof apiConfig === 'object') {
    if (apiConfig.include && !apiConfig.include.includes(action)) {
      return false;
    }

    if (apiConfig.exclude?.includes(action)) {
      return false;
    }
  }

  return true;
}

/**
 * Whether `action` names a route the generated REST surface can actually
 * dispatch on `objectName`.
 *
 * CRUD actions always have a route. A custom action exists only when it is
 * DECLARED — historically an `api.routes` entry, and since #2686 also a
 * `@method()` supplying route-shaping metadata. `dispatchCustomCollectionAction`
 * iterates exactly that union, so an action outside it can never execute no
 * matter what `include`/`exclude` say. Exposure alone would report a typo'd or
 * removed custom action as `allow`, and an agent would then start the earlier
 * steps of a non-atomic playbook before dying on it — the failure preflight
 * exists to prevent. This prediction and that dispatch must stay one rule.
 */
export function isRestActionRoutable(
  objectName: string | undefined,
  action: string,
): boolean {
  if (!objectName) return false;
  if (
    action === 'list' ||
    action === 'get' ||
    action === 'create' ||
    action === 'update' ||
    action === 'delete'
  ) {
    return true;
  }

  const apiConfig = ObjectRegistry.getConfig(objectName)?.api;
  if (!apiConfig || typeof apiConfig !== 'object') {
    return false;
  }

  if (
    apiConfig.routes &&
    Object.hasOwn(apiConfig.routes as Record<string, unknown>, action)
  ) {
    return true;
  }

  // Shared with `APIGenerator.declaredCollectionActions`, which decides the
  // dispatch this predicate exists to predict.
  return declaresRuntimeRestRoute(readRegisteredMethod(objectName, action));
}

/**
 * Fail-closed authorization posture (#1540): true only when the object opts out
 * of auth via `@smrt({ api: { public } })` — `true` for every method, `'read'`
 * for safe (GET) methods only.
 */
export function isRestRoutePublic(
  objectName: string | undefined,
  method: string,
): boolean {
  if (!objectName) return false;
  const apiConfig = ObjectRegistry.getConfig(objectName)?.api;
  if (!apiConfig || typeof apiConfig !== 'object') return false;
  const publicAccess = (apiConfig as { public?: boolean | 'read' }).public;
  if (publicAccess === true) return true;
  if (publicAccess === 'read') return method.toUpperCase() === 'GET';
  return false;
}

/**
 * Field-level read-permission slugs declared by `objectName`.
 *
 * Reads the model's own and inherited fields only — deliberately **not** the
 * STI base-plus-descendants union used for cache policy. That union answers
 * "does any variant carry a read-permission field?"; used here it would report
 * a sibling variant's slugs as required for a step naming this concrete model.
 */
export function restFieldReadPermissions(
  objectName: string | undefined,
): string[] {
  if (!objectName) return [];
  const registered = ObjectRegistry.getClass(objectName);
  const className = registered?.qualifiedName ?? registered?.name ?? objectName;
  const fields =
    registered?.inheritedFields ?? ObjectRegistry.getFields(className);
  const slugs = new Set<string>();
  for (const [, def] of fields) {
    const slug =
      typeof def?.readPermission === 'string'
        ? def.readPermission
        : typeof def?._meta?.readPermission === 'string'
          ? (def._meta.readPermission as string)
          : undefined;
    if (slug) slugs.add(slug);
  }
  return [...slugs].sort();
}
