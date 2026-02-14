/**
 * Server-side API route resolution for SMRT agents
 *
 * Reads agent package manifests and builds a route map from resource
 * paths (e.g., 'performers', 'video-contents') to SmrtObject class
 * names and allowed CRUD actions. The catch-all API handler uses this
 * to resolve incoming requests.
 *
 * @module @happyvertical/smrt-agents/server
 */

import type { PackageManifest } from './manifest-utils.js';

/**
 * Info about a single API route (one SmrtObject with api.include)
 */
export interface AgentAPIRouteInfo {
  /** SmrtObject class name (e.g., 'Performer') */
  className: string;
  /** Allowed CRUD actions (e.g., ['list', 'get', 'create', 'update', 'delete']) */
  allowedActions: string[];
  /** Package that owns this resource */
  packageName?: string;
}

/**
 * Result of resolving a URL path against the route map
 */
export interface ResolvedAPIRoute {
  /** The matched route info */
  route: AgentAPIRouteInfo;
  /** Resource ID if path includes one (e.g., 'performers/abc-123') */
  id?: string;
  /** Custom action name if path includes one (e.g., 'performers/abc-123/generate-image') */
  action?: string;
}

/**
 * Build a route map from loaded package manifests.
 *
 * Iterates all objects in each manifest, and for any object with a
 * `decoratorConfig.api.include` array, registers a route. The route
 * path is derived from `decoratorConfig.api.path` if set, otherwise
 * from the table name with underscores converted to hyphens.
 *
 * @param manifests - Array of parsed package manifest JSON objects
 * @returns Map of resource path -> route info
 *
 * @example
 * ```typescript
 * const manifests = [histrioManifest, praecoManifest];
 * const routes = buildRouteMap(manifests);
 * // routes.get('performers') => { className: 'Performer', allowedActions: ['list', 'get', 'create', 'update', 'delete'] }
 * // routes.get('video-contents') => { className: 'VideoShot', allowedActions: ['list', 'get', 'create', 'update'] }
 * ```
 */
export function buildRouteMap(
  manifests: PackageManifest[],
): Map<string, AgentAPIRouteInfo> {
  const routes = new Map<string, AgentAPIRouteInfo>();

  for (const manifest of manifests) {
    const packageName = (manifest as Record<string, unknown>).packageName as
      | string
      | undefined;

    for (const obj of Object.values(manifest.objects)) {
      const config = obj.decoratorConfig as Record<string, unknown> | undefined;
      if (!config) continue;

      const api = config.api as
        | { include?: string[]; path?: string }
        | undefined;
      if (!api?.include || api.include.length === 0) continue;

      // Derive the URL path: explicit api.path, or table name with _ -> -
      const tableName = config.tableName as string | undefined;
      const path =
        api.path || (tableName ? tableName.replace(/_/g, '-') : null);
      if (!path) continue;

      routes.set(path, {
        className: obj.className,
        allowedActions: api.include,
        packageName,
      });
    }
  }

  return routes;
}

/**
 * Resolve a URL resource path against a route map.
 *
 * Handles three URL patterns:
 * - `performers` → list/create (no id)
 * - `performers/abc-123` → get/update/delete (with id)
 * - `performers/abc-123/generate-image` → custom action
 *
 * @param urlPath - The resource portion of the URL (after `/api/agents/{agentId}/`)
 * @param routes - Route map from {@link buildRouteMap}
 * @returns Resolved route with optional id/action, or null if no match
 */
export function resolveAPIRoute(
  urlPath: string,
  routes: Map<string, AgentAPIRouteInfo>,
): ResolvedAPIRoute | null {
  // Normalize: strip leading/trailing slashes
  const normalized = urlPath.replace(/^\/+|\/+$/g, '');
  if (!normalized) return null;

  const segments = normalized.split('/');

  // Try 1-segment: "performers"
  if (segments.length === 1) {
    const route = routes.get(segments[0]);
    if (route) return { route };
    return null;
  }

  // Try 2-segment: "performers/{id}"
  if (segments.length === 2) {
    const route = routes.get(segments[0]);
    if (route) return { route, id: segments[1] };
    return null;
  }

  // Try 3-segment: "performers/{id}/{action}"
  if (segments.length === 3) {
    const route = routes.get(segments[0]);
    if (route) return { route, id: segments[1], action: segments[2] };
    return null;
  }

  return null;
}
