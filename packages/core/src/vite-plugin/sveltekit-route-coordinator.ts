import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import type { DomainKnowledgeAgentSurface } from '@happyvertical/smrt-types';
import { BUILD_SCHEMA_MODULE } from '../migrations/build-schema.js';
import type { SmartObjectManifest } from '../scanner/types.js';
import { assertSvelteKitObjectRoutesValid } from './generated-route-preflight.js';
import type { SmrtConfigEnv, SmrtVitePlugin } from './plugin-contract.js';
import {
  assertNoCrossObjectRouteCollisions,
  knowledgeRoutePath,
  materializeBuildSchemaModule,
  type RouteGenerationAttempt,
  runSvelteKitRouteGeneration,
  type SvelteKitManagedGenerationHooks,
  type SvelteKitOptions,
  type SvelteKitUtilityManifests,
} from './sveltekit-generator.js';
import { canonicalSvelteKitPath } from './sveltekit-path.js';

export type SvelteKitRouteOwner = 'producer' | 'consumer';

/**
 * How one submission ended. `accepted`: its generation succeeded or mutated
 * a generator output, and its `settle` published it. `rejected`: generation
 * threw before any generator output changed; nothing was published.
 * `superseded`: a newer submission or publication of the same producer
 * already exists, so no hook or generator code ran for it.
 */
export type SvelteKitSubmissionOutcome = 'accepted' | 'rejected' | 'superseded';
/** A submission whose peers have not all contributed yet is `pending`. */
export type SvelteKitContributionResult =
  | SvelteKitSubmissionOutcome
  | 'pending';

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
  /**
   * Runs under the lifecycle lock after preflight. `mark` records that a
   * generator output changed; call it after the first successful mutation.
   */
  beforeCleanup?: (
    mark: () => void,
    run?: SvelteKitGenerationRunContext,
  ) => void | Promise<void>;
  afterGenerate?: () => void | Promise<void>;
  /** Producer preparation sequence; consumers and revocations carry none. */
  seq?: number;
  /** True once the producer has published a newer prepared result. */
  isStale?: () => boolean;
  /** Awaited under the lock with this submission's outcome. */
  settle?: (outcome: SvelteKitSubmissionOutcome) => void | Promise<void>;
  /**
   * Canonical root under which `settle` publishes the build-schema module.
   * Set only by a writer that will publish it at settlement.
   */
  publishesBuildSchemaFor?: string;
  /** Per-root knowledge module id the managed knowledge route imports. */
  knowledgeModuleId?: string;
}
type RouteContributionInput = Omit<RouteContribution, 'projectRoot'>;

/** What a contribution's `beforeCleanup` learns about the run it is in. */
export interface SvelteKitGenerationRunContext {
  /**
   * The producer manifest this run generates and will publish at settlement.
   * `.smrt/manifest.json` still holds the previous publication while the run
   * is in progress, so registration built in this run reads this instead.
   */
  producerManifest?: SmartObjectManifest;
  /** The producer's project root; its `.smrt` is the one that manifest replaces. */
  producerRoot?: string;
}

interface RouteCoordinator {
  /** Every owner's latest admitted submission, settled or not. */
  latest: Map<SvelteKitRouteOwner, RouteContribution>;
  /** Every owner's last accepted submission. */
  accepted: Map<SvelteKitRouteOwner, RouteContribution>;
  expectedOwners: Set<SvelteKitRouteOwner>;
  afterRevocation: Array<() => void | Promise<void>>;
}

/**
 * A non-reentrant FIFO lock. `acquire()` resolves to a release function bound
 * to this lock object, so a holder always releases the lock it acquired even
 * if its plugin later records another lifecycle.
 */
export interface SvelteKitLifecycleLock {
  acquire(): Promise<() => void>;
}

export function createSvelteKitLifecycleLock(): SvelteKitLifecycleLock {
  let tail: Promise<void> = Promise.resolve();
  return {
    acquire() {
      let releaseNext!: () => void;
      const next = new Promise<void>((resolveNext) => {
        releaseNext = resolveNext;
      });
      const ready = tail.then(() => {
        let released = false;
        return () => {
          if (released) return;
          released = true;
          releaseNext();
        };
      });
      tail = tail.then(() => next);
      return ready;
    },
  };
}

/** Run `operation` while holding `lock`; the lock is released on every path. */
export async function withSvelteKitLifecycleLock<T>(
  lock: SvelteKitLifecycleLock,
  operation: () => T | Promise<T>,
): Promise<T> {
  const release = await lock.acquire();
  try {
    return await operation();
  } finally {
    release();
  }
}

/** What a producer exposes to a companion consumer in the same lifecycle. */
export interface SvelteKitProducerEntry {
  /** The producer's public API (knowledge config resolution). */
  api: {
    resolveKnowledgeConfig(
      manifest: SmartObjectManifest,
    ): Promise<import('@happyvertical/smrt-types').DomainKnowledgeConfig>;
    resolveKnowledgeAgentSurface(): Promise<
      DomainKnowledgeAgentSurface | undefined
    >;
  };
  /** Wait for the producer's in-flight operation; never rejects. Call outside the lock. */
  awaitOperation(): Promise<void>;
  /** The producer's published state; read synchronously under the lock. */
  readPublished(): {
    seq: number;
    surface: DomainKnowledgeAgentSurface | undefined;
    root: string | undefined;
  };
}

interface LifecycleRegistry {
  lock: SvelteKitLifecycleLock;
  /** Producer entries by canonical committed root. */
  producers: Map<string, SvelteKitProducerEntry>;
}

/** Module-private: keyed by the Vite lifecycle object, then by canonical root. */
const lifecycleRegistries = new WeakMap<object, LifecycleRegistry>();
/** Module-private: producer entries by plugin object, for hook-less callers. */
const producerEntriesByPlugin = new WeakMap<
  object,
  { root: () => string; entry: SvelteKitProducerEntry }
>();

function lifecycleRegistry(lifecycle: object): LifecycleRegistry {
  let registry = lifecycleRegistries.get(lifecycle);
  if (!registry) {
    registry = { lock: createSvelteKitLifecycleLock(), producers: new Map() };
    lifecycleRegistries.set(lifecycle, registry);
  }
  return registry;
}

/** The one coordination lock of a Vite lifecycle (`env ?? userConfig`). */
export function svelteKitLifecycleLock(
  lifecycle: object,
): SvelteKitLifecycleLock {
  return lifecycleRegistry(lifecycle).lock;
}

/** Record a producer under its canonical committed root in one lifecycle. */
export function registerSvelteKitProducer(
  lifecycle: object,
  projectRoot: string,
  entry: SvelteKitProducerEntry,
): void {
  const producers = lifecycleRegistry(lifecycle).producers;
  for (const [root, existing] of producers) {
    if (existing === entry) producers.delete(root);
  }
  producers.set(canonicalSvelteKitPath(projectRoot), entry);
}

/** Record a producer plugin object for callers that never ran a config hook. */
export function registerSvelteKitProducerPlugin(
  plugin: object,
  root: () => string,
  entry: SvelteKitProducerEntry,
): void {
  producerEntriesByPlugin.set(plugin, { root, entry });
}

/**
 * The producer whose canonical committed root equals `projectRoot`: first in
 * the lifecycle registry, then among `plugins` (resolved plugins of a caller
 * that never ran a config hook). No match means no producer.
 */
export function findSvelteKitProducer(
  lifecycle: object | undefined,
  projectRoot: string,
  plugins: readonly unknown[] = [],
): SvelteKitProducerEntry | undefined {
  const root = canonicalSvelteKitPath(projectRoot);
  const registered = lifecycle
    ? lifecycleRegistries.get(lifecycle)?.producers.get(root)
    : undefined;
  if (registered) return registered;
  for (const plugin of plugins) {
    if (!plugin || typeof plugin !== 'object') continue;
    const candidate = producerEntriesByPlugin.get(plugin);
    if (candidate && canonicalSvelteKitPath(candidate.root()) === root) {
      return candidate.entry;
    }
  }
  return undefined;
}

/** Points at which tests may pause a run to order concurrent operations. */
export type SvelteKitCoordinatorPausePoint =
  | 'afterAdmission'
  | 'afterRegistrationInputs'
  | 'beforeMark'
  | 'beforeSettle';

type CoordinatorPauseHook = (
  point: SvelteKitCoordinatorPausePoint,
  info: { owners: SvelteKitRouteOwner[]; projectRoot: string },
) => void | Promise<void>;

let coordinatorPauseHook: CoordinatorPauseHook | undefined;

/** Test seam (not a package export): awaited at the named points of every run. */
export function setSvelteKitCoordinatorPauseHookForTesting(
  hook: CoordinatorPauseHook | undefined,
): void {
  coordinatorPauseHook = hook;
}

export async function pauseSvelteKitCoordinator(
  point: SvelteKitCoordinatorPausePoint,
  info: { owners: SvelteKitRouteOwner[]; projectRoot: string },
): Promise<void> {
  await coordinatorPauseHook?.(point, info);
}

/** Settle one submission; a throwing `settle` is logged, never rethrown. */
export async function settleSvelteKitSubmission(
  settle: RouteContribution['settle'],
  outcome: SvelteKitSubmissionOutcome,
): Promise<void> {
  if (!settle) return;
  try {
    await settle(outcome);
  } catch (error) {
    console.error(
      `[smrt] Publishing a ${outcome} route generation failed:`,
      error,
    );
  }
}

/**
 * After a settlement that deferred the build-schema module to its writer,
 * materialise it if that writer did not (a publish skipped by the sequence
 * guard, or a failed manifest write), so the registration import resolves.
 */
export function ensureSvelteKitBuildSchemaModule(
  projectRoot: string,
  manifest: SmartObjectManifest,
): void {
  if (existsSync(join(projectRoot, '.smrt', BUILD_SCHEMA_MODULE))) return;
  materializeBuildSchemaModule(projectRoot, manifest);
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
  plugin: object,
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
  env?: SmrtConfigEnv,
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
  plugin: SmrtVitePlugin<unknown>,
  userConfig: unknown,
  env: SmrtConfigEnv | undefined,
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
  env?: SmrtConfigEnv,
): Promise<ActiveSvelteKitRouteParticipant[]> {
  const plugins = await flattenPluginOptions(
    (userConfig as { plugins?: unknown } | undefined)?.plugins,
  );
  const participants: ActiveSvelteKitRouteParticipant[] = [];
  for (const plugin of plugins) {
    if (!appliesToConfig(plugin as SmrtVitePlugin<unknown>, userConfig, env))
      continue;
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
): Promise<SvelteKitContributionResult> {
  const target = routeTarget(projectRoot, contribution.options.routesDir);
  const sessions = coordinators.get(lifecycle) ?? new Map();
  coordinators.set(lifecycle, sessions);
  const coordinator =
    sessions.get(target) ??
    ({
      latest: new Map(),
      accepted: new Map(),
      expectedOwners: new Set(expectedOwners),
      afterRevocation: [],
    } satisfies RouteCoordinator);
  sessions.set(target, coordinator);
  const submission: RouteContribution = { ...contribution, projectRoot };
  const result = await runCoordinated(
    lifecycle,
    sessions,
    coordinator,
    submission,
  );
  return result ?? 'pending';
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
      latest: new Map(),
      accepted: new Map(),
      expectedOwners: new Set(expectedOwners),
      afterRevocation: [],
    } satisfies RouteCoordinator);
  sessions.set(target, coordinator);

  // A revocation is not a submission: it is exempt from the sequence rule.
  // Its callback is queued only once this run holds the lock, so an earlier
  // holder's generation can never dispatch it.
  await runCoordinated(
    lifecycle,
    sessions,
    coordinator,
    undefined,
    afterGenerate,
  );
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
    // Reads `latest`: a pending submission counts as contributed.
    const missing = [...coordinator.expectedOwners].filter(
      (owner) => !coordinator.latest.has(owner),
    );
    if (missing.length === 0) continue;
    throw new Error(
      `[smrt] Incomplete SvelteKit route coordination for ${JSON.stringify(target)}; active ${missing.join(', ')} plugin contribution${missing.length === 1 ? '' : 's'} did not run before config resolution.`,
    );
  }
}

/**
 * Current producer-owned knowledge handlers, which may sit outside its API
 * root. Reads every target's `latest` submission, so a pending producer's
 * handler stays protected.
 */
export function producerKnowledgeRoutePaths(lifecycle: object): Set<string> {
  const paths = new Set<string>();
  for (const coordinator of coordinators.get(lifecycle)?.values() ?? []) {
    const producer = coordinator.latest.get('producer');
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
  env?: SmrtConfigEnv,
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

/** Errors thrown by `afterGenerate`/`afterRevocation` after the lock was released. */
const postReleaseErrors = new WeakSet<object>();

/**
 * Whether `error` came from reconciliation that ran after its run settled and
 * released the lock, rather than from inside the locked generation.
 */
export function isSvelteKitPostReleaseError(error: unknown): boolean {
  return !!error && typeof error === 'object' && postReleaseErrors.has(error);
}

/** Submissions whose outcome has been delivered to their `settle`. */
const settledSubmissions = new WeakSet<RouteContribution>();

async function settleOnce(
  submission: RouteContribution,
  outcome: SvelteKitSubmissionOutcome,
): Promise<void> {
  if (settledSubmissions.has(submission)) return;
  settledSubmissions.add(submission);
  await settleSvelteKitSubmission(submission.settle, outcome);
}

/** Whether a producer submission is older than one already admitted or published. */
function isSupersededProducerSubmission(
  coordinator: RouteCoordinator,
  submission: RouteContribution,
): boolean {
  if (submission.owner !== 'producer' || submission.seq === undefined) {
    return false;
  }
  const latestSeq = coordinator.latest.get('producer')?.seq;
  const acceptedSeq = coordinator.accepted.get('producer')?.seq;
  if (latestSeq !== undefined && submission.seq <= latestSeq) return true;
  if (acceptedSeq !== undefined && submission.seq <= acceptedSeq) return true;
  return submission.isStale?.() === true;
}

/**
 * Admission, generation and settlement of one target, under the lifecycle
 * lock. The lock is released on every path before `afterGenerate` and
 * `afterRevocation` run; those run only after a fully successful generation.
 */
async function runCoordinated(
  lifecycle: object,
  sessions: Map<string, RouteCoordinator>,
  coordinator: RouteCoordinator,
  submission?: RouteContribution,
  revocationCallback?: () => void | Promise<void>,
): Promise<SvelteKitContributionResult | undefined> {
  let afterSuccess: Array<() => void | Promise<void>> = [];
  let result: SvelteKitContributionResult | undefined;
  // The handle is captured here and released below, never re-resolved.
  const release = await svelteKitLifecycleLock(lifecycle).acquire();
  try {
    if (revocationCallback) {
      coordinator.afterRevocation.push(revocationCallback);
    }
    if (submission) {
      // Admission: a stale producer submission never reaches a hook or the
      // generator. Consumer submissions carry no sequence and are exempt.
      if (isSupersededProducerSubmission(coordinator, submission)) {
        await settleOnce(submission, 'superseded');
        return 'superseded';
      }
      const replaced = coordinator.latest.get(submission.owner);
      coordinator.latest.set(submission.owner, submission);
      if (replaced && replaced !== submission) {
        await settleOnce(replaced, 'superseded');
      }
      await pauseSvelteKitCoordinator('afterAdmission', {
        owners: [submission.owner],
        projectRoot: submission.projectRoot,
      });
    }
    // A producer submission that waited for its peers may have been
    // overtaken by a newer publication of the same producer meanwhile (a
    // `load()` self-preparation): it must not generate. The run then needs
    // a current producer contribution.
    const pendingProducer = coordinator.latest.get('producer');
    if (pendingProducer?.isStale?.() === true) {
      await settleOnce(pendingProducer, 'superseded');
      const accepted = coordinator.accepted.get('producer');
      if (accepted && accepted !== pendingProducer && !accepted.isStale?.()) {
        coordinator.latest.set('producer', accepted);
      } else {
        coordinator.latest.delete('producer');
      }
    }
    if (
      [...coordinator.expectedOwners].some(
        (owner) => !coordinator.latest.has(owner),
      )
    ) {
      return 'pending';
    }
    const after = await generateLocked(sessions, coordinator);
    afterSuccess = after;
    result = submission ? 'accepted' : undefined;
  } finally {
    release();
  }
  try {
    for (const callback of afterSuccess) await callback();
  } catch (error) {
    // Thrown after the run settled and released the lock (reconciliation):
    // it says nothing about this run's own generation.
    if (error && typeof error === 'object') postReleaseErrors.add(error);
    throw error;
  }
  return result;
}

/** One coordinated generation. Runs only while the lifecycle lock is held. */
async function generateLocked(
  sessions: Map<string, RouteCoordinator>,
  coordinator: RouteCoordinator,
): Promise<Array<() => void | Promise<void>>> {
  const used = [...coordinator.latest.entries()];
  const contributions = used.map(([, contribution]) => contribution);
  const attempt: RouteGenerationAttempt = { changed: false };
  const mark = () => {
    attempt.changed = true;
  };
  let deferredBuildSchema:
    | { projectRoot: string; manifest: SmartObjectManifest }
    | undefined;
  try {
    const primary = primaryContribution(contributions);
    assertNoForeignKnowledgeRouteCollisions(sessions);
    const primaryConfigTarget = configTarget(
      primary.projectRoot,
      primary.options,
    );
    // This target's own submissions, plus every other target's accepted
    // state: target runs are serialised, so nothing else is in flight.
    const registrationContributions = [
      ...contributions,
      ...[...sessions.values()]
        .filter((candidate) => candidate !== coordinator)
        .flatMap(({ accepted }) => [...accepted.values()]),
    ].filter(
      (contribution) =>
        configTarget(contribution.projectRoot, contribution.options) ===
        primaryConfigTarget,
    );
    await pauseSvelteKitCoordinator('afterRegistrationInputs', {
      owners: used.map(([owner]) => owner),
      projectRoot: primary.projectRoot,
    });
    const registrationPaths = consumerRegistrationPaths(
      registrationContributions,
    );
    if (
      new Set(
        registrationContributions.map(
          ({ options }) => !!options.lazyActivation,
        ),
      ).size > 1
    ) {
      throw new Error(
        'SMRT producer and consumer must agree on lazyActivation',
      );
    }
    const options = {
      ...mergeOptions(contributions),
      ...(registrationPaths.length > 0
        ? { consumerRegistrationPaths: registrationPaths }
        : {}),
    };
    const runProducer = contributions.find(({ owner }) => owner === 'producer');
    const runContext: SvelteKitGenerationRunContext = {
      producerManifest: runProducer?.routeManifest,
      producerRoot: runProducer?.projectRoot,
    };
    const hooks: SvelteKitManagedGenerationHooks = {
      beforeCleanup: async () => {
        for (const contribution of contributions) {
          await contribution.beforeCleanup?.(mark, runContext);
        }
        // A contribution rooted elsewhere than the generation root (a
        // consumer at the repository root beside a producer at app/) has
        // its own `.smrt/register.js` importing its own build-schema module.
        // Settlement publishes that module only for a settling writer's
        // root, so materialise it for every other root, as a change.
        const settlingRoots = new Set(
          contributions.flatMap(({ settle, publishesBuildSchemaFor }) =>
            settle && publishesBuildSchemaFor ? [publishesBuildSchemaFor] : [],
          ),
        );
        const generationRoot = canonicalSvelteKitPath(primary.projectRoot);
        for (const contribution of contributions) {
          const root = canonicalSvelteKitPath(contribution.projectRoot);
          if (root === generationRoot || settlingRoots.has(root)) continue;
          if (existsSync(join(root, '.smrt', BUILD_SCHEMA_MODULE))) continue;
          materializeBuildSchemaModule(
            contribution.projectRoot,
            contribution.semanticManifest,
            mark,
          );
        }
      },
    };
    const routeManifest = mergeManifests(
      contributions.map(({ routeManifest }) => routeManifest),
    );
    const semanticManifest = mergeManifests(
      contributions.map(({ semanticManifest }) => semanticManifest),
    );
    const registrationManifest = mergeManifests(
      registrationContributions.map(
        ({ routeManifest, semanticManifest, options }) =>
          options.lazyActivation ? semanticManifest : routeManifest,
      ),
    );
    // Validate every object's routes before generation sweeps the route tree.
    assertSvelteKitObjectRoutesValid(
      primary.projectRoot,
      routeManifest,
      semanticManifest,
      options,
    );
    // Defer the build-schema module only to a writer that publishes it for
    // this exact root at settlement.
    const generationRoot = canonicalSvelteKitPath(primary.projectRoot);
    const deferBuildSchema = contributions.some(
      (contribution) =>
        contribution.owner === 'producer' &&
        contribution.settle !== undefined &&
        contribution.publishesBuildSchemaFor === generationRoot,
    );
    if (deferBuildSchema) {
      deferredBuildSchema = {
        projectRoot: primary.projectRoot,
        manifest: registrationManifest,
      };
    }
    await pauseSvelteKitCoordinator('beforeMark', {
      owners: used.map(([owner]) => owner),
      projectRoot: primary.projectRoot,
    });
    await runSvelteKitRouteGeneration(
      {
        projectRoot: primary.projectRoot,
        routeManifest,
        options,
        semanticManifest,
        utilityManifests: utilityManifests(
          contributions,
          protectedProducerKnowledgeRoutePaths(sessions, coordinator),
          new Set(
            [...sessions.entries()]
              .filter(
                ([target, candidate]) =>
                  target !==
                    routeTarget(
                      primary.projectRoot,
                      primary.options.routesDir,
                    ) && candidate.latest.size > 0,
              )
              .map(([target]) => target),
          ),
        ),
        registrationManifest,
        hooks,
      },
      attempt,
      {
        deferBuildSchema,
        knowledgeModule: primary.knowledgeModuleId,
      },
    );
  } catch (error) {
    if (attempt.changed) {
      // A generator output already changed: publish, consistent with disk,
      // and skip reconciliation (the caller sees the error).
      await acceptUsed(coordinator, used, deferredBuildSchema, true);
      throw error;
    }
    for (const [owner] of used) {
      const accepted = coordinator.accepted.get(owner);
      if (accepted) coordinator.latest.set(owner, accepted);
      else coordinator.latest.delete(owner);
    }
    for (const [, contribution] of used) {
      await settleOnce(contribution, 'rejected');
    }
    throw error;
  }
  await acceptUsed(coordinator, used, deferredBuildSchema);
  const afterRevocation = coordinator.afterRevocation.splice(0);
  return [
    ...contributions.flatMap((contribution) =>
      contribution.afterGenerate ? [contribution.afterGenerate] : [],
    ),
    ...afterRevocation,
  ];
}

async function acceptUsed(
  coordinator: RouteCoordinator,
  used: Array<[SvelteKitRouteOwner, RouteContribution]>,
  deferredBuildSchema:
    | { projectRoot: string; manifest: SmartObjectManifest }
    | undefined,
  partialCommit = false,
): Promise<void> {
  await pauseSvelteKitCoordinator('beforeSettle', {
    owners: used.map(([owner]) => owner),
    projectRoot: used[0]?.[1].projectRoot ?? '',
  });
  for (const [owner, contribution] of used) {
    coordinator.accepted.set(owner, contribution);
  }
  for (const [, contribution] of used) {
    await settleOnce(contribution, 'accepted');
  }
  if (!deferredBuildSchema) return;
  try {
    ensureSvelteKitBuildSchemaModule(
      deferredBuildSchema.projectRoot,
      deferredBuildSchema.manifest,
    );
  } catch (error) {
    // The registration imports this module. On a fully successful run the
    // failure propagates, so no reconciliation runs beside an unresolved
    // import; after a partial commit the generation error is the one the
    // caller sees, and reconciliation is already skipped.
    if (!partialCommit) throw error;
    console.error('[smrt] Error writing the build-schema module:', error);
  }
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

/**
 * Protections and collision checks read every target's `latest` submission,
 * pending ones included, so they err toward protecting unsettled routes.
 */
function producerKnowledgeContributions(
  sessions: Map<string, RouteCoordinator>,
): RouteContribution[] {
  return [...sessions.values()].flatMap(({ latest }) =>
    [...latest.values()].filter(
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
    if (current.latest.get('producer') === contribution) continue;
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
  const producer = coordinator.latest.get('producer');
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
    ...[...current.latest.values()].flatMap((contribution) =>
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
    for (const contribution of routeCoordinator.latest.values()) {
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
