/**
 * One resolution of a model's generated surfaces (`api`, `mcp`, `cli`) and
 * `sensitive`, over a lookup the caller supplies.
 *
 * Pure: it reads only what the lookup returns. No registry or other global
 * state, no database, no generator imports, so the manifest generator, the
 * registry and a request-time gate all call the same function.
 *
 * Per surface S, in this order:
 *
 * 0. The node's own config is read with `exclude: ['*']` closed
 *    (`closeWildcardExclusions`), whatever the lookup returns.
 * 1. Parents are resolved first (memoised, cycle-safe: a node met again while
 *    it is being resolved counts as having no parent). A result whose
 *    resolution skipped such an edge anywhere at or below it is not
 *    memoised, so every cycle member is answered from its own edges, with or
 *    without a shared memo.
 *    A parent's operations are the ones it declares or inherits and every
 *    name it excludes, kept per memo and node (a `cap` hook may share one
 *    result object between nodes), so an operation a grandparent declares
 *    and a parent closes stays closed below it.
 * 2. The candidate is the node's own S if it declares one, else the first
 *    `inherit` parent's S (a copy) when some inherit parent sets it. With
 *    several inherit parents an operation is open only if every one that sets
 *    S opens it. Otherwise S is unset.
 * 3. Rulings against every parent that sets S, `inherit` and `restrict`
 *    alike. "Open" is decided per operation by `surfaceOpensOperation`, over
 *    the CRUD verbs, each parent's operations and the node's own. An
 *    operation the candidate opens and some parent closes is:
 *    - allowed when `widenParentExposure[S]` names it (`grantedBeyondAncestor`);
 *    - for an operation no parent declares (the node's own method), closed
 *      only by a whole-surface close (`S: false` on a parent), else open;
 *    - otherwise refused and recorded (`widenedBeyondAncestor`).
 *    Narrowing is never restricted.
 *    A parent whose S came out of a whole-surface close with grants rules as
 *    `false` for its children: they open only what they grant themselves.
 * 4. Refused operations are added to `exclude`. A parent's whole-surface
 *    close makes S `false`, or, when the node grants operations, an
 *    `include` of exactly the granted operations the candidate opens. A
 *    parent whose S is an allowlist (`include` on MCP and REST, or a CLI
 *    `include` naming a method) makes a non-allowlist candidate an `include`
 *    of the operations left open, so an operation the lookup cannot name
 *    stays closed. Every named operation the result would open beyond those
 *    left open is excluded (a CLI `include` of CRUD verbs alone leaves
 *    methods open). Such a CLI value cannot withhold a method the lookup does
 *    not name: callers that clamp pass `operationsOf`.
 * 5. Nothing sets S: `effective` is `undefined`, the generators' open
 *    default.
 * 6. `sensitive`: the node's own value, else the first inherit parent's
 *    `true`; a node dropping a parent's `true` keeps `true` in `config`.
 * 7. `lookup.cap?.(node, resolved)` runs once per node; its result is what is
 *    memoised and what the node's children see.
 *
 * Two values come out per surface. `unclamped` (and `unclampedConfig`)
 * applies steps 2, 5 and 6 over the parents' unclamped values only: it is
 * exactly what the code resolved before this function existed. The manifest
 * generator bakes it, so a widening without a grant still fails the build
 * (`CONFIG_SUBCLASS_EXPOSURE`), and `ObjectRegistry.getConfig()` still serves
 * it. `effective` (and `config`) applies every step over the parents'
 * effective values: the read-time value for gates that clamp.
 * `getConfig()` adopts it once a collection decorator can no longer
 * overwrite its model's registered config.
 */
import type { ExposureSurface } from './collection-exposure';
import {
  closeWildcardExclusions,
  EXPOSURE_SURFACES,
} from './collection-exposure';
import { surfaceOpensOperation } from './subclass-exposure';
import type { SmartObjectConfig } from './types';

const CRUD_VERBS = ['list', 'get', 'create', 'update', 'delete'];

type SurfaceValue = SmartObjectConfig[ExposureSurface];

/** Parents of a node, by kind. */
export interface ExposureParents<N> {
  /** Unset surfaces inherit from these (options and `sensitive` from the first). */
  inherit: readonly N[];
  /** These only close operations; they contribute no options and no `sensitive`. */
  restrict: readonly N[];
}

/** What `resolveModelExposure` needs to know about a node. */
export interface ExposureLookup<N> {
  /** The node's own declared config. */
  ownConfig(node: N): SmartObjectConfig;
  /** One parent (an inherit parent), both kinds, or none. */
  parentOf(node: N): N | ExposureParents<N> | undefined;
  /** Method names the node declares or inherits; absent means none. */
  operationsOf?(node: N): Iterable<string>;
  /** Runs once per node after resolution; its result is memoised. */
  cap?(node: N, resolved: ModelExposure): ModelExposure;
}

/** Where a surface's effective value came from. */
export type ExposureSource =
  | 'own'
  | 'inherited'
  | 'clamped'
  | 'unset'
  /** Set only by a `cap` hook; the resolver attaches no behaviour to it. */
  | 'unidentified-ancestor';

/** One surface's resolution. */
export interface SurfaceExposure {
  /** Read-time value, after the rulings. */
  effective: SurfaceValue | undefined;
  /** The node's own declared value. */
  declared: SurfaceValue | undefined;
  /** Own value, else inherited from the parents' unclamped values. */
  unclamped: SurfaceValue | undefined;
  source: ExposureSource;
  /** Operations opened beyond a parent without a grant (closed in `effective`). */
  widenedBeyondAncestor: string[];
  /** Operations opened beyond a parent with a `widenParentExposure` grant. */
  grantedBeyondAncestor: string[];
}

/** A model's resolved exposure. */
export interface ModelExposure {
  /** Own config with each surface's `effective` value and resolved `sensitive`. */
  config: SmartObjectConfig;
  /** Own config with each surface's `unclamped` value: the pre-ruling config. */
  unclampedConfig: SmartObjectConfig;
  surfaces: Record<ExposureSurface, SurfaceExposure>;
}

type ConfigOf = (resolved: ModelExposure) => SmartObjectConfig;
const effectiveOf: ConfigOf = (resolved) => resolved.config;
const unclampedOf: ConfigOf = (resolved) => resolved.unclampedConfig;

const copy = (value: SurfaceValue | undefined): SurfaceValue | undefined =>
  value && typeof value === 'object' ? { ...value } : value;

function normalizeParents<N>(
  value: N | ExposureParents<N> | undefined,
): ExposureParents<N> {
  if (value === undefined || value === null)
    return { inherit: [], restrict: [] };
  if (
    typeof value === 'object' &&
    Array.isArray((value as ExposureParents<N>).inherit) &&
    Array.isArray((value as ExposureParents<N>).restrict)
  ) {
    return value as ExposureParents<N>;
  }
  return { inherit: [value as N], restrict: [] };
}

/** Add operations to a surface value's `exclude`. */
function withExcluded(
  value: SurfaceValue | undefined,
  operations: string[],
): SurfaceValue | undefined {
  if (operations.length === 0) return value;
  if (value === false) return false;
  const base =
    value && typeof value === 'object'
      ? (value as Record<string, unknown>)
      : {};
  const existing = Array.isArray(base.exclude)
    ? (base.exclude as unknown[]).filter(
        (e): e is string => typeof e === 'string',
      )
    : [];
  return {
    ...base,
    exclude: [...new Set([...existing, ...operations])],
  } as SurfaceValue;
}

/**
 * Step 2: the node's own value, else what its inherit parents set (options
 * from the first; an operation open only if every one that sets it opens it).
 */
function candidate(
  surface: ExposureSurface,
  declared: SurfaceValue | undefined,
  inherit: ModelExposure[],
  configOf: ConfigOf,
  operations: string[],
): { value: SurfaceValue | undefined; source: ExposureSource } {
  if (declared !== undefined) return { value: declared, source: 'own' };
  const setters = inherit
    .map((resolved) => configOf(resolved)[surface])
    .filter((value) => value !== undefined);
  if (setters.length === 0) return { value: undefined, source: 'unset' };
  if (setters.some((value) => value === false))
    return { value: false, source: 'inherited' };
  const first = setters[0];
  const closedByOthers = operations.filter(
    (operation) =>
      surfaceOpensOperation(surface, first, operation) &&
      setters.some(
        (value) => !surfaceOpensOperation(surface, value, operation),
      ),
  );
  return {
    value: withExcluded(copy(first), closedByOthers),
    source: 'inherited',
  };
}

/**
 * Resolve a node's generated surfaces and `sensitive`. See the module
 * comment for the order. `memo` may be shared across calls over the same
 * lookup.
 */
export function resolveModelExposure<N>(
  node: N,
  lookup: ExposureLookup<N>,
  memo: Map<N, ModelExposure> = new Map(),
): ModelExposure {
  return resolveNode(node, lookup, memo, new Set()).resolved;
}

/**
 * What a node's children need beyond its public result, kept per memo and
 * node (never keyed by the result object, which a `cap` hook may share
 * between nodes):
 * - `operations`: every operation it declares or inherits plus every name its
 *   surfaces exclude, so an ancestor's operation is ruled on even when a
 *   parent between them neither declares it nor reports it;
 * - `closedExceptGranted`: surfaces closed by a whole-surface close except
 *   for the operations the node itself granted. A value cannot always say so
 *   (a CLI `include` naming only CRUD verbs leaves methods open), so children
 *   rule against such a surface as against `false`.
 */
interface NodeMeta {
  operations: ReadonlySet<string>;
  closedExceptGranted: ReadonlySet<ExposureSurface>;
}

const metaByMemo = new WeakMap<
  Map<unknown, ModelExposure>,
  Map<unknown, NodeMeta>
>();

function metaStore<N>(memo: Map<N, ModelExposure>): Map<N, NodeMeta> {
  let store = metaByMemo.get(memo as Map<unknown, ModelExposure>);
  if (!store) {
    store = new Map();
    metaByMemo.set(memo as Map<unknown, ModelExposure>, store);
  }
  return store as Map<N, NodeMeta>;
}

/**
 * Whether a surface value opens only what it lists: `false`, or an
 * `include` that is the complete allowlist (always on MCP and REST; on the
 * CLI only when it names a method).
 */
function isStrictValue(surface: ExposureSurface, value: unknown): boolean {
  if (value === false) return true;
  if (!value || typeof value !== 'object') return false;
  const { include } = value as { include?: unknown };
  if (!Array.isArray(include)) return false;
  return (
    surface !== 'cli' ||
    include.some(
      (entry) => typeof entry === 'string' && !CRUD_VERBS.includes(entry),
    )
  );
}

/** Names a surface value withholds through `exclude`. */
function excludedNames(value: unknown): string[] {
  if (!value || typeof value !== 'object') return [];
  const { exclude } = value as { exclude?: unknown };
  return Array.isArray(exclude)
    ? exclude.filter(
        (entry): entry is string => typeof entry === 'string' && entry !== '*',
      )
    : [];
}

interface NodeResult {
  resolved: ModelExposure;
  meta: NodeMeta;
  /**
   * The resolution skipped a cycle edge somewhere at or below this node. Such
   * a result depends on which cycle member the walk entered first, so it is
   * never memoised (the entry node included): every lookup of a cycle member
   * resolves it from its own edges, with or without a shared memo.
   */
  cycleDependent: boolean;
}

function resolveNode<N>(
  node: N,
  lookup: ExposureLookup<N>,
  memo: Map<N, ModelExposure>,
  visiting: Set<N>,
): NodeResult {
  const metas = metaStore(memo);
  const cached = memo.get(node);
  const cachedMeta = metas.get(node);
  // An entry this function did not memoise has no metadata: resolve again.
  if (cached && cachedMeta)
    return { resolved: cached, meta: cachedMeta, cycleDependent: false };
  visiting.add(node);
  let cycleDependent = false;
  // `exclude: ['*']` is closed here too, so a lookup returning raw declared
  // config gets the same reading as the adapters (#3468).
  const own = closeWildcardExclusions(lookup.ownConfig(node) ?? {});
  const parents = normalizeParents(lookup.parentOf(node));
  const resolveAll = (list: readonly N[]) => {
    const out: Array<{ parent: N; resolved: ModelExposure; meta: NodeMeta }> =
      [];
    for (const parent of list) {
      if (visiting.has(parent)) {
        cycleDependent = true;
        continue;
      }
      const result = resolveNode(parent, lookup, memo, visiting);
      if (result.cycleDependent) cycleDependent = true;
      out.push({ parent, resolved: result.resolved, meta: result.meta });
    }
    return out;
  };
  const inherit = resolveAll(parents.inherit);
  const restrict = resolveAll(parents.restrict);
  const allParents = [...inherit, ...restrict];
  // A parent's operations are what it declares or inherits (its own operation
  // set, which already holds its ancestors') and every name it excludes on
  // any surface: an operation a grandparent declares and a parent closes is
  // ruled on here even when the lookup reports only own methods.
  const parentOperations = new Set<string>();
  for (const { parent, resolved, meta } of allParents) {
    for (const operation of lookup.operationsOf?.(parent) ?? [])
      parentOperations.add(operation);
    for (const operation of meta.operations) parentOperations.add(operation);
    for (const surface of EXPOSURE_SURFACES)
      for (const config of [resolved.config, resolved.unclampedConfig])
        for (const operation of excludedNames(config[surface]))
          parentOperations.add(operation);
  }
  for (const operation of CRUD_VERBS) parentOperations.delete(operation);
  const ownOperations = [...(lookup.operationsOf?.(node) ?? [])];
  const operations = [
    ...new Set([...CRUD_VERBS, ...parentOperations, ...ownOperations]),
  ];
  const inheritResolved = inherit.map(({ resolved }) => resolved);

  const surfaces = {} as Record<ExposureSurface, SurfaceExposure>;
  const config: SmartObjectConfig = { ...own };
  const unclampedConfig: SmartObjectConfig = { ...own };
  const closedSurfaces = new Set<ExposureSurface>();

  for (const surface of EXPOSURE_SURFACES) {
    const declared = own[surface];
    const unclamped = candidate(
      surface,
      declared,
      inheritResolved,
      unclampedOf,
      operations,
    ).value;
    const base = candidate(
      surface,
      declared,
      inheritResolved,
      effectiveOf,
      operations,
    );
    let source = base.source;

    // Step 3: rulings against every parent that sets the surface. A parent
    // whose surface is closed except for its own grants rules as `false`.
    const ruling = allParents
      .map(({ resolved, meta }) =>
        meta.closedExceptGranted.has(surface)
          ? false
          : resolved.config[surface],
      )
      .filter((value) => value !== undefined);
    const wholeClose = ruling.some((value) => value === false);
    const strictParent = ruling.some((value) => isStrictValue(surface, value));
    const granted = new Set(
      Array.isArray(own.widenParentExposure?.[surface])
        ? (own.widenParentExposure?.[surface] as string[])
        : [],
    );
    const widened: string[] = [];
    const grantedBeyond: string[] = [];
    for (const operation of ruling.length > 0 ? operations : []) {
      if (!surfaceOpensOperation(surface, base.value, operation)) continue;
      const closedByParent = ruling.some(
        (value) => !surfaceOpensOperation(surface, value, operation),
      );
      if (!closedByParent) continue;
      const ownOnly =
        !CRUD_VERBS.includes(operation) && !parentOperations.has(operation);
      if (ownOnly && !wholeClose) continue;
      if (granted.has(operation)) grantedBeyond.push(operation);
      else widened.push(operation);
    }

    // Step 4: merge the decisions. The operations left open are those the
    // candidate opens and no ruling refused.
    const refused = new Set(widened);
    const allowed = operations.filter(
      (operation) =>
        surfaceOpensOperation(surface, base.value, operation) &&
        !refused.has(operation),
    );
    let effective: SurfaceValue | undefined = base.value;
    let closedExceptGranted = false;
    const baseObject =
      base.value && typeof base.value === 'object' ? base.value : {};
    if (wholeClose && base.value !== false) {
      // Only the granted operations stay open (`false` without a grant).
      effective =
        grantedBeyond.length === 0
          ? false
          : ({ ...baseObject, include: grantedBeyond } as SurfaceValue);
      closedExceptGranted = grantedBeyond.length > 0;
    } else if (
      strictParent &&
      base.value !== false &&
      !isStrictValue(surface, base.value)
    ) {
      // A parent that opens only what it lists: the result is an allowlist
      // too, so an operation this lookup cannot name (a grandparent method
      // without `operationsOf`) stays closed instead of open by default.
      effective =
        allowed.length === 0
          ? false
          : ({ ...baseObject, include: allowed } as SurfaceValue);
    }
    if (effective !== false) {
      // Every refused operation, and every named operation the rewritten
      // value would open beyond `allowed` (a CLI `include` of CRUD verbs
      // alone opens methods), is excluded.
      const reopened = operations.filter(
        (operation) =>
          surfaceOpensOperation(surface, effective, operation) &&
          !(wholeClose ? grantedBeyond : allowed).includes(operation),
      );
      effective = withExcluded(effective, [
        ...new Set([...widened, ...reopened]),
      ]);
    }
    if (closedExceptGranted) closedSurfaces.add(surface);
    if (widened.length > 0) source = 'clamped';

    surfaces[surface] = {
      effective,
      declared,
      unclamped,
      source,
      widenedBeyondAncestor: widened,
      grantedBeyondAncestor: grantedBeyond,
    };
    // An own key the node declares as `undefined` stays present (the shape
    // `inheritSubclassExposure` kept), so `Object.hasOwn` and spreading the
    // result over defaults behave as before.
    const ownKey = Object.hasOwn(own, surface);
    if (unclamped !== undefined)
      (unclampedConfig as Record<string, unknown>)[surface] = unclamped;
    else if (!ownKey) delete unclampedConfig[surface];
    if (effective !== undefined)
      (config as Record<string, unknown>)[surface] = effective;
    else if (!ownKey) delete config[surface];
  }

  // Step 6: `sensitive` from the first inherit parent; it cannot be dropped
  // at read time.
  if (
    own.sensitive === undefined &&
    inherit[0]?.resolved.unclampedConfig.sensitive === true
  )
    unclampedConfig.sensitive = true;
  if (own.sensitive !== true && inherit[0]?.resolved.config.sensitive === true)
    config.sensitive = true;

  visiting.delete(node);
  let resolved: ModelExposure = { config, unclampedConfig, surfaces };
  if (lookup.cap) resolved = lookup.cap(node, resolved);
  const meta: NodeMeta = {
    operations: new Set(
      operations.filter((operation) => !CRUD_VERBS.includes(operation)),
    ),
    closedExceptGranted: closedSurfaces,
  };
  if (!cycleDependent) {
    memo.set(node, resolved);
    metas.set(node, meta);
  }
  return { resolved, meta, cycleDependent };
}
