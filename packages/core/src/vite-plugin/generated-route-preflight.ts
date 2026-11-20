/**
 * Validation that runs before SvelteKit route generation changes the route
 * tree.
 *
 * `generateSvelteKitRoutes()` sweeps every header-owned route file before it
 * renders the first object's routes, and a per-object failure (two methods
 * resolving to one custom route, or handlers with mixed hosts) is detected
 * while rendering. Without this check, a bad edit in a producer-only app
 * leaves the route tree half deleted. Callers run it first, so a failure
 * leaves the previous generated routes in place.
 */

import type {
  SmartObjectDefinition,
  SmartObjectManifest,
} from '../scanner/types.js';
import {
  assertNoCrossObjectRouteCollisions,
  type SvelteKitOptions,
} from './sveltekit-generator.js';
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

/**
 * The claim pass also reports two claims on one handler file (`Conflicting
 * SvelteKit route`). Generation of an object never enforced that rule (it
 * wrote the later handler over the earlier one), and a hosted consumer asks
 * the generator for it before cleanup itself; so this preflight leaves it out
 * and every configuration that generated before still generates.
 */
const UNENFORCED_CLAIM_CONFLICT = /^Conflicting SvelteKit route /;

/**
 * Run, for every object in the route manifest, the per-object route checks
 * generation already performs while rendering (two methods resolving to one
 * custom route handler; handlers sharing a route with mixed hosts or scopes),
 * so they fail before the route tree is swept.
 *
 * @throws The generator's validation error for the first invalid object.
 */
export function assertSvelteKitObjectRoutesValid(
  projectRoot: string,
  routeManifest: SmartObjectManifest,
  semanticManifest: SmartObjectManifest,
  options: SvelteKitOptions,
): void {
  if (!options.enabled) return;
  const claimOptions = objectRouteOptions(options);
  for (const [key, definition] of Object.entries(routeManifest.objects)) {
    try {
      assertNoCrossObjectRouteCollisions(
        projectRoot,
        isolateObject(key, definition, routeManifest, semanticManifest),
        claimOptions,
        semanticManifest,
      );
    } catch (error) {
      // Custom-action grouping runs before an object's handler claims, so an
      // unenforced claim conflict is only ever reached after the checks this
      // preflight exists for have passed.
      if (
        error instanceof Error &&
        UNENFORCED_CLAIM_CONFLICT.test(error.message)
      ) {
        continue;
      }
      throw error;
    }
  }
}
