import { resolve } from 'node:path';
import type { Plugin } from 'vite';
import type { SmartObjectManifest } from '../scanner/types.js';
import {
  generateSvelteKitRoutes,
  type SvelteKitOptions,
  type SvelteKitUtilityManifests,
} from './sveltekit-generator.js';

export type SvelteKitRouteOwner = 'producer' | 'consumer';

const ROUTE_PARTICIPANT = Symbol('smrt.sveltekit-route-participant');
const coordinators = new WeakMap<object, Map<string, RouteCoordinator>>();

interface RouteContribution {
  owner: SvelteKitRouteOwner;
  routeManifest: SmartObjectManifest;
  semanticManifest: SmartObjectManifest;
  options: SvelteKitOptions;
}

interface RouteCoordinator {
  contributions: Map<SvelteKitRouteOwner, RouteContribution>;
  expectedOwners: Set<SvelteKitRouteOwner>;
}

/** Marks an enabled plugin instance so only real same-target participants block
 * the initial shared route transaction. The marker is intentionally private to
 * the plugin objects supplied to one Vite config invocation. */
export function markSvelteKitRouteParticipant(
  plugin: Plugin,
  owner: SvelteKitRouteOwner,
  enabled: boolean,
  routesDir: string,
): void {
  Object.defineProperty(plugin, ROUTE_PARTICIPANT, {
    value: { owner, enabled, routesDir },
    enumerable: false,
  });
}

export function expectedSvelteKitRouteOwners(
  userConfig: unknown,
  routesDir: string,
): SvelteKitRouteOwner[] {
  const plugins = (userConfig as { plugins?: unknown[] } | undefined)?.plugins;
  if (!Array.isArray(plugins)) return [];
  const owners = new Set<SvelteKitRouteOwner>();
  for (const plugin of plugins) {
    const participant = (
      plugin as
        | {
            [ROUTE_PARTICIPANT]?: {
              owner: SvelteKitRouteOwner;
              enabled: boolean;
              routesDir: string;
            };
          }
        | undefined
    )?.[ROUTE_PARTICIPANT];
    if (participant?.enabled && participant.routesDir === routesDir) {
      owners.add(participant.owner);
    }
  }
  return [...owners];
}

/**
 * Bind generated route ownership to one Vite configuration lifecycle. Both
 * SMRT plugins run pre-config hooks, so the later hook regenerates the complete
 * current plan rather than deleting the earlier plugin's route files.
 */
export async function contributeSvelteKitRoutes(
  lifecycle: object,
  expectedOwners: Iterable<SvelteKitRouteOwner>,
  projectRoot: string,
  contribution: RouteContribution,
): Promise<void> {
  const target = `${resolve(projectRoot)}\0${contribution.options.routesDir}`;
  const sessions = coordinators.get(lifecycle) ?? new Map();
  coordinators.set(lifecycle, sessions);
  const coordinator =
    sessions.get(target) ??
    ({
      contributions: new Map(),
      expectedOwners: new Set(expectedOwners),
    } satisfies RouteCoordinator);
  sessions.set(target, coordinator);
  coordinator.contributions.set(contribution.owner, contribution);

  if (
    [...coordinator.expectedOwners].some(
      (owner) => !coordinator.contributions.has(owner),
    )
  )
    return;

  const contributions = [...coordinator.contributions.values()];
  const registrationContributions = [...sessions.values()].flatMap(
    ({ contributions }) => [...contributions.values()],
  );
  const options = mergeOptions(contributions);
  await generateSvelteKitRoutes(
    resolve(projectRoot),
    mergeManifests(contributions.map(({ routeManifest }) => routeManifest)),
    options,
    mergeManifests(
      contributions.map(({ semanticManifest }) => semanticManifest),
    ),
    utilityManifests(contributions),
    mergeManifests(
      registrationContributions.map(({ routeManifest }) => routeManifest),
    ),
  );
}

function utilityManifests(
  contributions: RouteContribution[],
): SvelteKitUtilityManifests {
  const selected = (key: 'changesRoute' | 'eventsRoute') =>
    contributions.find(({ options }) => options[key]?.enabled !== false) ??
    contributions[0]!;
  const changes = selected('changesRoute');
  const events = selected('eventsRoute');
  return {
    // sync/apply deliberately composes selected targets from every contributor.
    sync: mergeManifests(
      contributions.map(({ routeManifest }) => routeManifest),
    ),
    changes: changes.routeManifest,
    events: events.routeManifest,
    eventsSemantic: events.semanticManifest,
  };
}

function mergeOptions(contributions: RouteContribution[]): SvelteKitOptions {
  const producer = contributions.find(({ owner }) => owner === 'producer');
  const primary = producer ?? contributions[0];
  if (!primary) throw new Error('[smrt] Missing SvelteKit route contribution');
  const merged: SvelteKitOptions = { ...primary.options };
  for (const contribution of contributions) {
    for (const key of [
      'routesDir',
      'objectsDir',
      'configPath',
      'configFileName',
      'kebabRoutes',
    ] as const) {
      if (contribution.options[key] !== primary.options[key]) {
        throw new Error(
          `[smrt] Incompatible SvelteKit route settings for shared routesDir ${JSON.stringify(primary.options.routesDir)}: ${key} must match`,
        );
      }
    }
  }
  for (const key of [
    'changesRoute',
    'eventsRoute',
    'resourcesRoute',
  ] as const) {
    const owners = contributions.filter(
      ({ options }) => options[key]?.enabled !== false,
    );
    if (owners.length > 1) {
      throw new Error(
        `[smrt] Conflicting SvelteKit utility route owner for ${key} in shared routesDir ${JSON.stringify(primary.options.routesDir)}`,
      );
    }
    if (owners.length === 1) merged[key] = owners[0]?.options[key];
  }
  return merged;
}

function mergeManifests(manifests: SmartObjectManifest[]): SmartObjectManifest {
  const first = manifests[0];
  if (!first) throw new Error('[smrt] Missing SvelteKit route manifest');
  const objects: SmartObjectManifest['objects'] = {};
  const dependencies = new Set<string>();
  for (const manifest of manifests) {
    for (const dependency of manifest.smrtDependencies ?? [])
      dependencies.add(dependency);
    for (const [key, objectDef] of Object.entries(manifest.objects)) {
      const existing = objects[key];
      if (existing && JSON.stringify(existing) !== JSON.stringify(objectDef)) {
        throw new Error(
          `[smrt] Conflicting SvelteKit route object definition for ${JSON.stringify(key)}`,
        );
      }
      objects[key] = objectDef;
    }
  }
  return { ...first, objects, smrtDependencies: [...dependencies].sort() };
}
