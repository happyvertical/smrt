import { resolve, sep } from 'node:path';
import type { Plugin } from 'vite';
import type { SmartObjectManifest } from '../scanner/types.js';
import {
  generateSvelteKitRoutes,
  knowledgeRoutePath,
  type SvelteKitGenerationHooks,
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
  beforeCleanup?: () => void | Promise<void>;
  afterGenerate?: () => void | Promise<void>;
}

interface RouteCoordinator {
  contributions: Map<SvelteKitRouteOwner, RouteContribution>;
  expectedOwners: Set<SvelteKitRouteOwner>;
  afterRevocation: Array<() => void | Promise<void>>;
}

export interface ActiveSvelteKitRouteParticipant {
  owner: SvelteKitRouteOwner;
  routesDir: string;
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
  projectRoot: string,
  routesDir: string,
): SvelteKitRouteOwner[] {
  const participants = activeSvelteKitRouteParticipants(
    userConfig,
    projectRoot,
  );
  assertCompatibleSvelteKitRouteTargets(participants);
  const owners = new Set<SvelteKitRouteOwner>();
  for (const participant of participants) {
    if (
      routeTarget(projectRoot, participant.routesDir) ===
      routeTarget(projectRoot, routesDir)
    )
      owners.add(participant.owner);
  }
  return [...owners];
}

/** Active roots are either one shared target or separate directory owners. */
export function activeSvelteKitRouteParticipants(
  userConfig: unknown,
  projectRoot: string,
): ActiveSvelteKitRouteParticipant[] {
  const plugins = (userConfig as { plugins?: unknown[] } | undefined)?.plugins;
  if (!Array.isArray(plugins)) return [];
  const participants: ActiveSvelteKitRouteParticipant[] = [];
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
    if (!participant?.enabled) continue;
    participants.push({
      owner: participant.owner,
      routesDir: resolve(projectRoot, participant.routesDir),
    });
  }
  return participants;
}

function assertCompatibleSvelteKitRouteTargets(
  participants: ActiveSvelteKitRouteParticipant[],
): void {
  for (const [index, first] of participants.entries()) {
    for (const second of participants.slice(index + 1)) {
      if (first.routesDir === second.routesDir) continue;
      if (
        second.routesDir.startsWith(`${first.routesDir}${sep}`) ||
        first.routesDir.startsWith(`${second.routesDir}${sep}`)
      ) {
        throw new Error(
          `[smrt] Incompatible nested SvelteKit routesDir ownership: ${JSON.stringify(first.routesDir)} and ${JSON.stringify(second.routesDir)}. Use one shared routesDir or disjoint directories.`,
        );
      }
    }
  }
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
  const target = routeTarget(projectRoot, contribution.options.routesDir);
  const sessions = coordinators.get(lifecycle) ?? new Map();
  coordinators.set(lifecycle, sessions);
  const coordinator =
    sessions.get(target) ??
    ({
      contributions: new Map(),
      expectedOwners: new Set(expectedOwners),
      afterRevocation: [],
    } satisfies RouteCoordinator);
  sessions.set(target, coordinator);
  coordinator.contributions.set(contribution.owner, contribution);

  await generateWhenReady(sessions, coordinator, projectRoot);
}

/**
 * Reconcile a disabled consumer's formerly hosted route root through the
 * active target transaction. This lets a current producer re-emit its own
 * surface rather than a later consumer cleanup deleting it.
 */
export async function revokeSvelteKitRoutes(
  lifecycle: object,
  expectedOwners: Iterable<SvelteKitRouteOwner>,
  projectRoot: string,
  routesDir: string,
  afterGenerate?: () => void | Promise<void>,
): Promise<void> {
  const target = routeTarget(projectRoot, routesDir);
  const sessions = coordinators.get(lifecycle) ?? new Map();
  coordinators.set(lifecycle, sessions);
  const coordinator =
    sessions.get(target) ??
    ({
      contributions: new Map(),
      expectedOwners: new Set(expectedOwners),
      afterRevocation: [],
    } satisfies RouteCoordinator);
  sessions.set(target, coordinator);
  if (afterGenerate) coordinator.afterRevocation.push(afterGenerate);

  await generateWhenReady(sessions, coordinator, projectRoot);
}

/** Current producer-owned knowledge handlers, which may sit outside its API root. */
export function producerKnowledgeRoutePaths(
  lifecycle: object,
  projectRoot: string,
): Set<string> {
  const paths = new Set<string>();
  for (const coordinator of coordinators.get(lifecycle)?.values() ?? []) {
    const producer = coordinator.contributions.get('producer');
    if (!producer?.options.knowledge?.api?.enabled) continue;
    paths.add(resolve(knowledgeRoutePath(projectRoot, producer.options)));
  }
  return paths;
}

async function generateWhenReady(
  sessions: Map<string, RouteCoordinator>,
  coordinator: RouteCoordinator,
  projectRoot: string,
): Promise<void> {
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
  const options = mergeOptions(projectRoot, contributions);
  const hooks: SvelteKitGenerationHooks = {
    beforeCleanup: async () => {
      for (const contribution of contributions) {
        await contribution.beforeCleanup?.();
      }
    },
  };
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
    hooks,
  );
  for (const contribution of contributions) {
    await contribution.afterGenerate?.();
  }
  const afterRevocation = coordinator.afterRevocation.splice(0);
  for (const callback of afterRevocation) await callback();
}

function routeTarget(projectRoot: string, routesDir: string): string {
  return `${resolve(projectRoot)}\0${resolve(projectRoot, routesDir)}`;
}

function configTarget(projectRoot: string, options: SvelteKitOptions): string {
  return resolve(projectRoot, options.configPath || 'src/lib/server');
}

function effectiveConfigFileName(options: SvelteKitOptions): string {
  return options.configFileName || 'smrt.ts';
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
    // Knowledge routes are rooted at the SvelteKit app, rather than an API
    // routesDir. An external consumer must not reconcile a producer-owned
    // knowledge endpoint merely because it emits a separate route target.
    clearKnowledgeRoute: contributions.some(
      ({ options }) => options.knowledge !== undefined,
    ),
  };
}

function mergeOptions(
  projectRoot: string,
  contributions: RouteContribution[],
): SvelteKitOptions {
  const producer = contributions.find(({ owner }) => owner === 'producer');
  const primary = producer ?? contributions[0];
  if (!primary) throw new Error('[smrt] Missing SvelteKit route contribution');
  const merged: SvelteKitOptions = { ...primary.options };
  for (const contribution of contributions) {
    const incompatible =
      routeTarget(projectRoot, contribution.options.routesDir) !==
        routeTarget(projectRoot, primary.options.routesDir) ||
      resolve(projectRoot, contribution.options.objectsDir) !==
        resolve(projectRoot, primary.options.objectsDir) ||
      configTarget(projectRoot, contribution.options) !==
        configTarget(projectRoot, primary.options) ||
      effectiveConfigFileName(contribution.options) !==
        effectiveConfigFileName(primary.options) ||
      contribution.options.kebabRoutes !== primary.options.kebabRoutes;
    if (incompatible) {
      throw new Error(
        `[smrt] Incompatible SvelteKit route settings for shared routesDir ${JSON.stringify(primary.options.routesDir)}`,
      );
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
  // A hosted consumer always requests collision preflight. Preserve that
  // fail-closed policy when the producer provides the primary options.
  merged.rejectRouteCollisions = contributions.some(
    ({ options }) => options.rejectRouteCollisions === true,
  );
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
