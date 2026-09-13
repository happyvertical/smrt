import { relative, resolve, sep } from 'node:path';
import type { ConfigEnv, Plugin } from 'vite';
import type { SmartObjectManifest } from '../scanner/types.js';
import {
  assertNoCrossObjectRouteCollisions,
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
  reservedRoutePaths?: ReadonlySet<string>;
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
  projectRoot: string;
  routesDir: string;
  resolveKnowledge?: ProducerKnowledgeResolver;
}

type ProducerKnowledgeResolver = (projectRoot: string) => Promise<{
  api?: { enabled?: boolean; basePath?: string };
}>;
type ProjectRootResolver = (userConfig: unknown) => string;

/** Marks an enabled plugin instance so only real same-target participants block
 * the initial shared route transaction. The marker is intentionally private to
 * the plugin objects supplied to one Vite config invocation. */
export function markSvelteKitRouteParticipant(
  plugin: Plugin,
  owner: SvelteKitRouteOwner,
  enabled: boolean,
  routesDir: string,
  resolveKnowledge?: ProducerKnowledgeResolver,
  resolveProjectRoot?: ProjectRootResolver,
): void {
  Object.defineProperty(plugin, ROUTE_PARTICIPANT, {
    value: { owner, enabled, routesDir, resolveKnowledge, resolveProjectRoot },
    enumerable: false,
  });
}

export async function expectedSvelteKitRouteOwners(
  userConfig: unknown,
  projectRoot: string,
  routesDir: string,
  env?: ConfigEnv,
): Promise<SvelteKitRouteOwner[]> {
  const targetRoot = resolve(projectRoot);
  const participants = await activeSvelteKitRouteParticipants(
    userConfig,
    targetRoot,
    env,
  );
  assertCompatibleSvelteKitRouteTargets(participants);
  const target = resolve(targetRoot, routesDir);
  const owners = new Set<SvelteKitRouteOwner>();
  for (const participant of participants) {
    if (
      participant.projectRoot === targetRoot &&
      participant.routesDir === target
    )
      owners.add(participant.owner);
  }
  return [...owners];
}

/** Mirrors Vite's supported recursive PluginOption normalization for config hooks. */
async function flattenPluginOptions(value: unknown): Promise<unknown[]> {
  let values = Array.isArray(value) ? value : [];
  do {
    values = (await Promise.all(values)).flat(Infinity);
  } while (
    values.some(
      (entry) =>
        entry && typeof (entry as Promise<unknown>).then === 'function',
    )
  );
  return values.filter(Boolean);
}

/** Applies the same supported `Plugin.apply` gate Vite uses before config hooks. */
function appliesToConfig(
  plugin: Plugin,
  userConfig: unknown,
  env: ConfigEnv | undefined,
): boolean {
  const apply = plugin.apply;
  if (!apply) return true;
  if (!env) return false;
  if (typeof apply === 'function') {
    return apply(
      {
        ...((userConfig as Record<string, unknown> | undefined) ?? {}),
        mode: env.mode,
      },
      env,
    );
  }
  return apply === env.command;
}

/** Active roots are either one shared target or separate directory owners. */
export async function activeSvelteKitRouteParticipants(
  userConfig: unknown,
  projectRoot: string,
  env?: ConfigEnv,
): Promise<ActiveSvelteKitRouteParticipant[]> {
  const plugins = await flattenPluginOptions(
    (userConfig as { plugins?: unknown } | undefined)?.plugins,
  );
  const participants: ActiveSvelteKitRouteParticipant[] = [];
  for (const plugin of plugins) {
    if (!appliesToConfig(plugin as Plugin, userConfig, env)) continue;
    const participant = (
      plugin as
        | {
            [ROUTE_PARTICIPANT]?: {
              owner: SvelteKitRouteOwner;
              enabled: boolean;
              routesDir: string;
              resolveKnowledge?: ProducerKnowledgeResolver;
              resolveProjectRoot?: ProjectRootResolver;
            };
          }
        | undefined
    )?.[ROUTE_PARTICIPANT];
    if (!participant?.enabled) continue;
    const participantRoot = resolve(
      participant.resolveProjectRoot?.(userConfig) ?? projectRoot,
    );
    participants.push({
      owner: participant.owner,
      projectRoot: participantRoot,
      routesDir: resolve(participantRoot, participant.routesDir),
      resolveKnowledge: participant.resolveKnowledge,
    });
  }
  return participants;
}

function assertCompatibleSvelteKitRouteTargets(
  participants: ActiveSvelteKitRouteParticipant[],
): void {
  for (const [index, first] of participants.entries()) {
    for (const second of participants.slice(index + 1)) {
      if (
        first.projectRoot !== second.projectRoot ||
        first.routesDir === second.routesDir
      )
        continue;
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

/**
 * Config hooks are the primary synchronization point because SvelteKit reads
 * its route inventory immediately afterwards. This is a fail-closed backstop
 * for Vite configurations where a marked, active peer never ran its hook.
 */
export function assertSvelteKitRouteCoordinationComplete(
  lifecycle: object,
  projectRoot: string,
): void {
  const targetPrefix = `${resolve(projectRoot)}\0`;
  for (const [target, coordinator] of coordinators.get(lifecycle) ?? []) {
    if (!target.startsWith(targetPrefix)) continue;
    const missing = [...coordinator.expectedOwners].filter(
      (owner) => !coordinator.contributions.has(owner),
    );
    if (missing.length === 0) continue;
    const routesDir = target.slice(targetPrefix.length);
    throw new Error(
      `[smrt] Incomplete SvelteKit route coordination for ${JSON.stringify(routesDir)}; active ${missing.join(', ')} plugin contribution${missing.length === 1 ? '' : 's'} did not run before config resolution.`,
    );
  }
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

/** Resolve active producer knowledge claims before consumer route mutation. */
export async function activeProducerKnowledgeRoutePaths(
  userConfig: unknown,
  projectRoot: string,
  env?: ConfigEnv,
): Promise<Set<string>> {
  const paths = new Set<string>();
  for (const participant of await activeSvelteKitRouteParticipants(
    userConfig,
    projectRoot,
    env,
  )) {
    if (
      participant.projectRoot !== resolve(projectRoot) ||
      participant.owner !== 'producer' ||
      !participant.resolveKnowledge
    )
      continue;
    const knowledge = await participant.resolveKnowledge(
      participant.projectRoot,
    );
    if (!knowledge.api?.enabled) continue;
    paths.add(
      resolve(
        knowledgeRoutePath(participant.projectRoot, {
          enabled: true,
          routesDir: relative(participant.projectRoot, participant.routesDir),
          objectsDir: '',
          knowledge,
        }),
      ),
    );
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
  assertNoForeignKnowledgeRouteCollisions(sessions, projectRoot);
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
    utilityManifests(
      contributions,
      protectedProducerKnowledgeRoutePaths(sessions, projectRoot, coordinator),
    ),
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
  protectedRoutePaths: ReadonlySet<string>,
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
    protectedRoutePaths,
  };
}

function producerKnowledgeContributions(
  sessions: Map<string, RouteCoordinator>,
): RouteContribution[] {
  return [...sessions.values()].flatMap(({ contributions }) =>
    [...contributions.values()].filter(
      (contribution) =>
        contribution.owner === 'producer' &&
        contribution.options.knowledge?.api?.enabled === true,
    ),
  );
}

function foreignProducerKnowledgeRoutePaths(
  sessions: Map<string, RouteCoordinator>,
  projectRoot: string,
  current: RouteCoordinator,
): Set<string> {
  const paths = new Set<string>();
  for (const contribution of producerKnowledgeContributions(sessions)) {
    if (current.contributions.get('producer') === contribution) continue;
    paths.add(resolve(knowledgeRoutePath(projectRoot, contribution.options)));
  }
  return paths;
}

function currentProducerKnowledgeRoutePaths(
  coordinator: RouteCoordinator,
  projectRoot: string,
): Set<string> {
  const producer = coordinator.contributions.get('producer');
  if (!producer?.options.knowledge?.api?.enabled) return new Set();
  return new Set([resolve(knowledgeRoutePath(projectRoot, producer.options))]);
}

function protectedProducerKnowledgeRoutePaths(
  sessions: Map<string, RouteCoordinator>,
  projectRoot: string,
  current: RouteCoordinator,
): Set<string> {
  const ownPaths = currentProducerKnowledgeRoutePaths(current, projectRoot);
  return new Set([
    ...foreignProducerKnowledgeRoutePaths(sessions, projectRoot, current),
    ...[...current.contributions.values()].flatMap((contribution) =>
      [...(contribution.reservedRoutePaths ?? [])].filter(
        (path) => !ownPaths.has(resolve(path)),
      ),
    ),
  ]);
}

function assertNoForeignKnowledgeRouteCollisions(
  sessions: Map<string, RouteCoordinator>,
  projectRoot: string,
): void {
  const knowledgeContributions = producerKnowledgeContributions(sessions);
  for (const routeCoordinator of sessions.values()) {
    const ownPaths = currentProducerKnowledgeRoutePaths(
      routeCoordinator,
      projectRoot,
    );
    for (const contribution of routeCoordinator.contributions.values()) {
      if (!contribution.options.rejectRouteCollisions) continue;
      const foreignPaths = new Set(
        knowledgeContributions
          .filter((knowledge) => knowledge !== contribution)
          .map((knowledge) =>
            resolve(knowledgeRoutePath(projectRoot, knowledge.options)),
          ),
      );
      for (const path of contribution.reservedRoutePaths ?? []) {
        if (!ownPaths.has(resolve(path))) foreignPaths.add(path);
      }
      if (foreignPaths.size === 0) continue;
      assertNoCrossObjectRouteCollisions(
        projectRoot,
        contribution.routeManifest,
        contribution.options,
        contribution.semanticManifest,
        foreignPaths,
      );
    }
  }
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
