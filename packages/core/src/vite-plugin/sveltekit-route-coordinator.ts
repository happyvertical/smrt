import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
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
import { canonicalSvelteKitPath } from './sveltekit-path.js';

export type SvelteKitRouteOwner = 'producer' | 'consumer';

const ROUTE_PARTICIPANT = Symbol('smrt.sveltekit-route-participant');
const coordinators = new WeakMap<object, Map<string, RouteCoordinator>>();

interface RouteContribution {
  owner: SvelteKitRouteOwner;
  /** Keep the caller's lexical artifact root for its resolved output context. */
  projectRoot: string;
  routeManifest: SmartObjectManifest;
  semanticManifest: SmartObjectManifest;
  options: SvelteKitOptions;
  reservedRoutePaths?: ReadonlySet<string>;
  beforeCleanup?: () => void | Promise<void>;
  afterGenerate?: () => void | Promise<void>;
}
type RouteContributionInput = Omit<RouteContribution, 'projectRoot'>;

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
  const participants = await activeSvelteKitRouteParticipants(
    userConfig,
    projectRoot,
    env,
  );
  assertCompatibleSvelteKitRouteTargets(participants);
  const target = canonicalSvelteKitPath(resolve(projectRoot, routesDir));
  const owners = new Set<SvelteKitRouteOwner>();
  for (const participant of participants) {
    if (participant.routesDir === target) owners.add(participant.owner);
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
    const participantRoot = canonicalSvelteKitPath(
      participant.resolveProjectRoot?.(userConfig) ?? projectRoot,
    );
    participants.push({
      owner: participant.owner,
      projectRoot: participantRoot,
      routesDir: canonicalSvelteKitPath(
        resolve(participantRoot, participant.routesDir),
      ),
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
  assertNoSymlinkedSvelteKitRouteTargetConflicts(participants);
}

/**
 * Route generation and SvelteKit both traverse directory symlinks. A lexical
 * disjointness check alone therefore cannot let one active route root recurse
 * into another active root during cleanup.
 */
function assertNoSymlinkedSvelteKitRouteTargetConflicts(
  participants: ActiveSvelteKitRouteParticipant[],
): void {
  for (const participant of participants) {
    const foreignRoots = participants
      .filter(({ routesDir }) => routesDir !== participant.routesDir)
      .map(({ routesDir }) => routesDir);
    if (foreignRoots.length === 0) continue;
    assertRouteTreeDoesNotReachForeignRoot(
      participant.routesDir,
      foreignRoots,
      new Set(),
    );
  }
}

/**
 * A durable consumer ownership record can outlive the route configuration
 * that created it. Reconciliation uses this same guard before it sweeps a
 * former lexical root, so an old child symlink cannot cross into a current
 * active route surface and make the journal's ownership ambiguous.
 */
export function assertNoSvelteKitRouteRootSymlinkConflict(
  routeRoot: string,
  foreignRouteRoots: Iterable<string>,
): void {
  const foreignRoots = [...foreignRouteRoots].filter(
    (candidate) => candidate !== canonicalSvelteKitPath(routeRoot),
  );
  if (foreignRoots.length === 0) return;
  assertRouteTreeDoesNotReachForeignRoot(routeRoot, foreignRoots, new Set());
}

function assertRouteTreeDoesNotReachForeignRoot(
  routeRoot: string,
  foreignRoots: readonly string[],
  visitedRoots: Set<string>,
): void {
  const canonicalRoot = canonicalSvelteKitPath(routeRoot);
  if (visitedRoots.has(canonicalRoot) || !existsSync(routeRoot)) return;
  visitedRoots.add(canonicalRoot);

  for (const entry of readdirSync(routeRoot, { withFileTypes: true })) {
    const entryPath = join(routeRoot, entry.name);
    if (entry.isDirectory()) {
      assertRouteTreeDoesNotReachForeignRoot(
        entryPath,
        foreignRoots,
        visitedRoots,
      );
      continue;
    }
    if (!entry.isSymbolicLink()) continue;
    try {
      if (!statSync(entryPath).isDirectory()) continue;
    } catch {
      continue;
    }
    const canonicalEntry = canonicalSvelteKitPath(entryPath);
    const foreignRoot = foreignRoots.find((candidate) =>
      svelteKitPathsOverlap(canonicalEntry, candidate),
    );
    if (foreignRoot) {
      throw new Error(
        `[smrt] Incompatible SvelteKit routesDir ownership: ${JSON.stringify(routeRoot)} reaches active ${JSON.stringify(foreignRoot)} through directory symlink ${JSON.stringify(entryPath)}. Use one shared routesDir or disjoint physical directories.`,
      );
    }
    assertRouteTreeDoesNotReachForeignRoot(
      entryPath,
      foreignRoots,
      visitedRoots,
    );
  }
}

function svelteKitPathsOverlap(first: string, second: string): boolean {
  return (
    first === second ||
    first.startsWith(`${second}${sep}`) ||
    second.startsWith(`${first}${sep}`)
  );
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
  contribution: RouteContributionInput,
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
  coordinator.contributions.set(contribution.owner, {
    ...contribution,
    projectRoot,
  });

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
): void {
  for (const [target, coordinator] of coordinators.get(lifecycle) ?? []) {
    const missing = [...coordinator.expectedOwners].filter(
      (owner) => !coordinator.contributions.has(owner),
    );
    if (missing.length === 0) continue;
    throw new Error(
      `[smrt] Incomplete SvelteKit route coordination for ${JSON.stringify(target)}; active ${missing.join(', ')} plugin contribution${missing.length === 1 ? '' : 's'} did not run before config resolution.`,
    );
  }
}

/** Current producer-owned knowledge handlers, which may sit outside its API root. */
export function producerKnowledgeRoutePaths(lifecycle: object): Set<string> {
  const paths = new Set<string>();
  for (const coordinator of coordinators.get(lifecycle)?.values() ?? []) {
    const producer = coordinator.contributions.get('producer');
    if (!producer?.options.knowledge?.api?.enabled) continue;
    paths.add(
      canonicalSvelteKitPath(
        knowledgeRoutePath(producer.projectRoot, producer.options),
      ),
    );
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
    if (participant.owner !== 'producer' || !participant.resolveKnowledge)
      continue;
    const knowledge = await participant.resolveKnowledge(
      participant.projectRoot,
    );
    if (!knowledge.api?.enabled) continue;
    paths.add(
      canonicalSvelteKitPath(
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
  _projectRoot: string,
): Promise<void> {
  if (
    [...coordinator.expectedOwners].some(
      (owner) => !coordinator.contributions.has(owner),
    )
  )
    return;

  const contributions = [...coordinator.contributions.values()];
  const primary = primaryContribution(contributions);
  assertNoForeignKnowledgeRouteCollisions(sessions);
  const registrationContributions = [...sessions.values()].flatMap(
    ({ contributions }) =>
      [...contributions.values()].filter(
        (contribution) =>
          configTarget(contribution.projectRoot, contribution.options) ===
          configTarget(primary.projectRoot, primary.options),
      ),
  );
  const registrationPaths = consumerRegistrationPaths(
    registrationContributions,
  );
  const options = {
    ...mergeOptions(contributions),
    ...(registrationPaths.length > 0
      ? { consumerRegistrationPaths: registrationPaths }
      : {}),
  };
  const hooks: SvelteKitGenerationHooks = {
    beforeCleanup: async () => {
      for (const contribution of contributions) {
        await contribution.beforeCleanup?.();
      }
    },
  };
  await generateSvelteKitRoutes(
    primary.projectRoot,
    mergeManifests(contributions.map(({ routeManifest }) => routeManifest)),
    options,
    mergeManifests(
      contributions.map(({ semanticManifest }) => semanticManifest),
    ),
    utilityManifests(
      contributions,
      protectedProducerKnowledgeRoutePaths(sessions, coordinator),
      new Set(
        [...sessions.entries()]
          .filter(
            ([target, candidate]) =>
              target !==
                routeTarget(primary.projectRoot, primary.options.routesDir) &&
              candidate.contributions.size > 0,
          )
          .map(([target]) => target),
      ),
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
  return canonicalSvelteKitPath(resolve(projectRoot, routesDir));
}

function configTarget(projectRoot: string, options: SvelteKitOptions): string {
  return canonicalSvelteKitPath(
    resolve(projectRoot, options.configPath || 'src/lib/server'),
  );
}

function effectiveConfigFileName(options: SvelteKitOptions): string {
  return options.configFileName || 'smrt.ts';
}

function consumerRegistrationPaths(
  contributions: RouteContribution[],
): string[] {
  return [
    ...new Set(
      contributions
        .filter(({ owner }) => owner === 'consumer')
        .map(({ projectRoot }) =>
          canonicalSvelteKitPath(resolve(projectRoot, '.smrt/register.js')),
        ),
    ),
  ].sort();
}

function utilityManifests(
  contributions: RouteContribution[],
  protectedRoutePaths: ReadonlySet<string>,
  protectedRouteRoots: ReadonlySet<string>,
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
    protectedRouteRoots,
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
  current: RouteCoordinator,
): Set<string> {
  const paths = new Set<string>();
  for (const contribution of producerKnowledgeContributions(sessions)) {
    if (current.contributions.get('producer') === contribution) continue;
    paths.add(
      canonicalSvelteKitPath(
        knowledgeRoutePath(contribution.projectRoot, contribution.options),
      ),
    );
  }
  return paths;
}

function currentProducerKnowledgeRoutePaths(
  coordinator: RouteCoordinator,
): Set<string> {
  const producer = coordinator.contributions.get('producer');
  if (!producer?.options.knowledge?.api?.enabled) return new Set();
  return new Set([
    canonicalSvelteKitPath(
      knowledgeRoutePath(producer.projectRoot, producer.options),
    ),
  ]);
}

function protectedProducerKnowledgeRoutePaths(
  sessions: Map<string, RouteCoordinator>,
  current: RouteCoordinator,
): Set<string> {
  const ownPaths = currentProducerKnowledgeRoutePaths(current);
  return new Set([
    ...foreignProducerKnowledgeRoutePaths(sessions, current),
    ...[...current.contributions.values()].flatMap((contribution) =>
      [...(contribution.reservedRoutePaths ?? [])].filter(
        (path) => !ownPaths.has(canonicalSvelteKitPath(path)),
      ),
    ),
  ]);
}

function assertNoForeignKnowledgeRouteCollisions(
  sessions: Map<string, RouteCoordinator>,
): void {
  const knowledgeContributions = producerKnowledgeContributions(sessions);
  for (const routeCoordinator of sessions.values()) {
    const ownPaths = currentProducerKnowledgeRoutePaths(routeCoordinator);
    for (const contribution of routeCoordinator.contributions.values()) {
      if (!contribution.options.rejectRouteCollisions) continue;
      const foreignPaths = new Set(
        knowledgeContributions
          .filter((knowledge) => knowledge !== contribution)
          .map((knowledge) =>
            canonicalSvelteKitPath(
              knowledgeRoutePath(knowledge.projectRoot, knowledge.options),
            ),
          ),
      );
      for (const path of contribution.reservedRoutePaths ?? []) {
        if (!ownPaths.has(canonicalSvelteKitPath(path))) foreignPaths.add(path);
      }
      if (foreignPaths.size === 0) continue;
      assertNoCrossObjectRouteCollisions(
        contribution.projectRoot,
        contribution.routeManifest,
        contribution.options,
        contribution.semanticManifest,
        foreignPaths,
      );
    }
  }
}

function primaryContribution(
  contributions: RouteContribution[],
): RouteContribution {
  const primary =
    contributions.find(({ owner }) => owner === 'producer') ?? contributions[0];
  if (!primary) throw new Error('[smrt] Missing SvelteKit route contribution');
  return primary;
}

function mergeOptions(contributions: RouteContribution[]): SvelteKitOptions {
  const primary = primaryContribution(contributions);
  const merged: SvelteKitOptions = { ...primary.options };
  for (const contribution of contributions) {
    const incompatible =
      routeTarget(contribution.projectRoot, contribution.options.routesDir) !==
        routeTarget(primary.projectRoot, primary.options.routesDir) ||
      canonicalSvelteKitPath(
        resolve(contribution.projectRoot, contribution.options.objectsDir),
      ) !==
        canonicalSvelteKitPath(
          resolve(primary.projectRoot, primary.options.objectsDir),
        ) ||
      configTarget(contribution.projectRoot, contribution.options) !==
        configTarget(primary.projectRoot, primary.options) ||
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
