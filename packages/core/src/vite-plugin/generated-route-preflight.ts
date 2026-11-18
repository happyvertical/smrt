/**
 * Validation that runs before SvelteKit route generation changes the route
 * tree: per-object route validation and route-file ownership.
 *
 * `generateSvelteKitRoutes()` sweeps every header-owned route file before it
 * renders the first object's routes, and a per-object failure (two methods
 * resolving to one custom route, or handlers with mixed hosts) is detected
 * while rendering. Without this check, a bad edit in a producer-only app
 * leaves the route tree half deleted. Callers run it first, so a failure
 * leaves the previous generated routes in place.
 */

import { dirname, join } from 'node:path';
import type {
  SmartObjectDefinition,
  SmartObjectManifest,
} from '../scanner/types.js';
import { willGenerateChangesRoute } from './changes-route.js';
import { willGenerateDevPlaneRoute } from './dev-plane-route.js';
import { willGenerateEventsRoute } from './events-route.js';
import {
  ApplicationRouteConflictError,
  assertGeneratedRouteDestination,
  collectApplicationServerModules,
} from './generated-route-ownership.js';
import {
  assertNoCrossObjectRouteCollisions,
  knowledgeRoutePath,
  type SvelteKitOptions,
} from './sveltekit-generator.js';
import { canonicalSvelteKitPath } from './sveltekit-path.js';
import { findManifestObjectByName } from './web-collections.js';

/**
 * The generator's own claim pass, restricted to object routes: utility routes
 * are claimed once by the generator and are not per-object.
 */
function objectRouteOptions(options: SvelteKitOptions): SvelteKitOptions {
  return {
    ...options,
    changesRoute: { ...options.changesRoute, enabled: false },
    eventsRoute: { ...options.eventsRoute, enabled: false },
    resourcesRoute: { ...options.resourcesRoute, enabled: false },
    devPlaneRoute: undefined,
    knowledge: undefined,
  };
}

/** A manifest entry that keeps its identity and ancestry but claims no route. */
function withoutRoutes(
  definition: SmartObjectDefinition,
): SmartObjectDefinition {
  return {
    ...definition,
    methods: {},
    decoratorConfig: { ...(definition.decoratorConfig ?? {}), api: false },
  };
}

/**
 * The single object plus its ancestors (claiming nothing), so the claim pass
 * still classifies a collection that extends another collection without a
 * type argument.
 */
function isolateObject(
  key: string,
  definition: SmartObjectDefinition,
  routeManifest: SmartObjectManifest,
  semanticManifest: SmartObjectManifest,
): SmartObjectManifest {
  const objects: SmartObjectManifest['objects'] = { [key]: definition };
  const keys = new Map<SmartObjectDefinition, string>();
  for (const manifest of [semanticManifest, routeManifest]) {
    for (const [candidateKey, candidate] of Object.entries(manifest.objects)) {
      if (!keys.has(candidate)) keys.set(candidate, candidateKey);
    }
  }
  const seen = new Set<string>([key]);
  let current: SmartObjectDefinition | undefined = definition;
  while (current) {
    const parentName: string | undefined =
      current.extendsQualified || current.extends;
    if (!parentName) break;
    const parent: SmartObjectDefinition | undefined =
      findManifestObjectByName(semanticManifest, parentName, current) ??
      findManifestObjectByName(routeManifest, parentName, current);
    const parentKey = parent ? keys.get(parent) : undefined;
    if (!parent || !parentKey || seen.has(parentKey)) break;
    seen.add(parentKey);
    objects[parentKey] = withoutRoutes(parent);
    current = parent;
  }
  return { ...routeManifest, objects };
}

/** Utility manifests, when they differ from the route manifest (coordinator). */
export interface SvelteKitPreflightUtilityManifests {
  changes: SmartObjectManifest;
  events: SmartObjectManifest;
}

/**
 * Validate a generation before it changes the route tree:
 *
 * 1. Every object's routes pass the generator's own per-object validation
 *    (the claim pass), without the cross-object collision rule: a
 *    producer-only app still writes STI siblings that share a collection to
 *    one file, and a hosted consumer asks the generator for that rule itself.
 * 2. No path the generator will write is occupied by application code (the
 *    ownership rule in `generated-route-ownership.ts`). `_resources` and
 *    `sync/apply` are excluded: their writers deliberately preserve an
 *    application handler and skip generating that one route.
 *
 * @throws The generator's validation error, or an
 *   {@link ApplicationRouteConflictError} naming the application file.
 */
export function preflightSvelteKitRouteGeneration(
  projectRoot: string,
  routeManifest: SmartObjectManifest,
  semanticManifest: SmartObjectManifest,
  options: SvelteKitOptions,
  utilityManifests: SvelteKitPreflightUtilityManifests = {
    changes: routeManifest,
    events: routeManifest,
  },
  protectedRouteRoots: ReadonlySet<string> = new Set(),
): void {
  if (!options.enabled) return;
  const routesRoot = join(projectRoot, options.routesDir);
  const applicationFiles = collectApplicationServerModules(
    routesRoot,
    protectedRouteRoots,
  );
  for (const preserved of [
    join(routesRoot, '_resources', '+server.ts'),
    join(routesRoot, 'sync', 'apply', '+server.ts'),
  ]) {
    applicationFiles.delete(canonicalSvelteKitPath(preserved));
  }

  const claimOptions = objectRouteOptions(options);
  const reserved = new Set(applicationFiles.keys());
  for (const [key, definition] of Object.entries(routeManifest.objects)) {
    const isolated = isolateObject(
      key,
      definition,
      routeManifest,
      semanticManifest,
    );
    const claim = (paths: ReadonlySet<string>) =>
      assertNoCrossObjectRouteCollisions(
        projectRoot,
        isolated,
        claimOptions,
        semanticManifest,
        paths,
      );
    try {
      claim(reserved);
    } catch (error) {
      if (reserved.size === 0) throw error;
      // A genuine validation error wins over an ownership conflict.
      claim(new Set());
      for (const [claimPath, file] of applicationFiles) {
        try {
          claim(new Set([claimPath]));
        } catch (cause) {
          throw new ApplicationRouteConflictError(
            file,
            `the routes of ${key}`,
            { cause },
          );
        }
      }
      throw error;
    }
  }

  const utilityRoutes: Array<[boolean, string, string]> = [
    [
      willGenerateChangesRoute(utilityManifests.changes, options),
      join(routesRoot, '_changes'),
      'the _changes route',
    ],
    [
      willGenerateEventsRoute(utilityManifests.events, options),
      join(routesRoot, '_events'),
      'the _events route',
    ],
    [
      willGenerateDevPlaneRoute(projectRoot, options),
      join(routesRoot, '_dev', '[...tool]'),
      'the _dev route',
    ],
    [
      options.knowledge?.api?.enabled === true,
      dirname(knowledgeRoutePath(projectRoot, options)),
      'the knowledge route',
    ],
  ];
  for (const [generated, routeDir, route] of utilityRoutes) {
    if (generated) assertGeneratedRouteDestination(routeDir, route);
  }
}
