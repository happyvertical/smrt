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
  /** Whether this principal may customize this page (the role gate). */
  canCustomize: boolean;
  /**
   * Store the canonical override (`null` = back to the defaults) in the
   * principal's tier. Throw to fail the operation.
   */
  persist: (override: OverviewOverride | null) => void | Promise<void>;
  /** Turns titles and labels that are i18n keys into text. */
  translate?: DescribeOverviewInput['translate'];
  /** Batch cap (default 20). */
  maxOperations?: number;
}

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
  /** Persist a canonical override; {@link current} follows it. */
  persist(override: OverviewOverride | null): Promise<void>;
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
      await options.persist(override);
      current = override;
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
