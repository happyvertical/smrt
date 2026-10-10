/**
 * The server half of the overview assistant (#3727 phase 4): one overview, for
 * one principal, as the adapter `@happyvertical/smrt-chat`'s
 * `createOverviewTools()` operates on. The chat package depends on no UI
 * package, so it types this object structurally; this module is the
 * implementation a host returns from its `open(run, pageId)`.
 *
 * Every plan and every restore runs through the phase-1 model and
 * `checkOverviewOverride`, so the assistant can only store an override the
 * save endpoint would accept. Persistence stays the host's (phase 3): the
 * surface calls `persist` with the canonical override and keeps its own copy
 * of the value it last persisted.
 *
 * Svelte-free; on `./overview/server`.
 */

import {
  checkOverviewOverride,
  diffOverview,
  type OverviewOverrideCheck,
  resolveOverview,
} from './model.js';
import {
  type DescribeOverviewInput,
  describeOverview,
  type OverviewDescription,
  type OverviewPlan,
  planOverviewOperations,
} from './operations.js';
import { defaultWidgetRegistry, type WidgetRegistry } from './registry.js';
import type { OverviewDefinition, OverviewOverride } from './types.js';

export interface OverviewAssistantSurfaceOptions {
  /** The page's declaration (allowed set, models, defaults, cap). */
  definition: OverviewDefinition;
  /** Defaults to the shared registry. */
  registry?: WidgetRegistry;
  /**
   * The principal's stored override for this page (untrusted JSON; `null`
   * for none), as the host loaded it for this request.
   */
  override: unknown;
  /**
   * The concurrency token of the stored row the host loaded `override` from
   * (`null` when it loaded no row), echoed back to `persist`. With the
   * phase-3 store this is the tier's `revision`.
   */
  revision: string | null;
  /** Whether this principal may customize this page (the role gate). */
  canCustomize: boolean;
  /**
   * Store the canonical override (`null` = back to the defaults) in the
   * principal's tier, CONDITIONALLY on `expected.revision` still being the
   * stored one: a save that landed since must answer
   * `{ ok: false, reason: 'conflict' }`, never be overwritten. The phase-3
   * store plugs in directly:
   * `(override, { revision }) => store.save(definition, registry, { scope: 'user', override, revision })`.
   */
  persist: (
    override: OverviewOverride | null,
    expected: { revision: string | null },
  ) => OverviewAssistantPersistResult | Promise<OverviewAssistantPersistResult>;
  /** Turns titles and labels that are i18n keys into text. */
  translate?: DescribeOverviewInput['translate'];
  /** Batch cap (default 20). */
  maxOperations?: number;
}

/**
 * A conditional write's outcome. `revision` is the stored row's new token
 * (`null` when the write removed the row); omitted, the surface keeps the
 * token it had. Structurally the phase-3 store's `OverviewSaveResult`.
 */
export type OverviewAssistantPersistResult =
  | { ok: true; revision?: string | null }
  | {
      ok: false;
      reason: 'conflict' | 'not_allowed' | 'invalid';
      issues?: readonly unknown[];
    };

/** One overview for one principal; what `createOverviewTools()` drives. */
export interface OverviewAssistantSurface {
  readonly pageId: string;
  readonly canCustomize: boolean;
  /** Allowed widget types with their option fields, and the arrangement. */
  describe(): OverviewDescription;
  /** The canonical override in effect (`null` = defaults). */
  current(): OverviewOverride | null;
  /** Plan a batch against {@link current}. Applies nothing. */
  plan(operations: unknown): OverviewPlan;
  /** Validate an override (the Undo value) the way a save is validated. */
  check(override: unknown): OverviewOverrideCheck;
  /**
   * Persist a canonical override if the stored row is still the loaded
   * revision; on success {@link current} and the revision follow it.
   */
  persist(
    override: OverviewOverride | null,
  ): Promise<OverviewAssistantPersistResult>;
}

/** Build the assistant adapter for one overview and one principal. */
export function createOverviewAssistantSurface(
  options: OverviewAssistantSurfaceOptions,
): OverviewAssistantSurface {
  const registry = options.registry ?? defaultWidgetRegistry;
  const { definition } = options;
  const initial = checkOverviewOverride(definition, options.override, registry);
  // A stored value the model no longer accepts resolves leniently on load;
  // its canonical form is whatever survives sanitizing.
  let current: OverviewOverride | null = initial.ok
    ? initial.override
    : sanitizedCurrent(definition, registry, options.override);
  let revision = options.revision;
  return {
    pageId: definition.id,
    canCustomize: options.canCustomize,
    describe: () =>
      describeOverview({
        definition,
        registry,
        override: current,
        canCustomize: options.canCustomize,
        translate: options.translate,
        maxOperations: options.maxOperations,
      }),
    current: () => current,
    plan: (operations) =>
      planOverviewOperations({
        definition,
        registry,
        override: current,
        operations,
        maxOperations: options.maxOperations,
      }),
    check: (override) => checkOverviewOverride(definition, override, registry),
    async persist(override) {
      const result = await options.persist(override, { revision });
      if (result.ok) {
        current = override;
        if ('revision' in result && result.revision !== undefined) {
          revision = result.revision;
        }
      }
      return result;
    },
  };
}

function sanitizedCurrent(
  definition: OverviewDefinition,
  registry: WidgetRegistry,
  override: unknown,
): OverviewOverride | null {
  const resolved = resolveOverview(definition, override, registry);
  return diffOverview(resolved.base, resolved.document);
}
