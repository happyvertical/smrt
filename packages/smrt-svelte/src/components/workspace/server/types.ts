/**
 * Types for the server-side dock availability gate composer.
 *
 * See `compose-availability.ts` for the runtime utility and
 * happyvertical/smrt#1226 (Phase 4c) / #1235 for design context.
 *
 * This module is intentionally Node-safe — no Svelte component imports,
 * no `window`/`document`, no browser-only APIs — so consumers can call it
 * from server endpoints (`+server.ts`, REST handlers, etc.).
 */

import type { AvailableTool, ToolDef } from '../types.js';

/**
 * Context passed to each gate evaluator. Consumer-defined keys (userId,
 * tenantId, contentId, etc.) carry the data evaluators need to resolve
 * a gate to a boolean. The composer doesn't introspect this — it's a
 * pass-through.
 */
export type GateEvaluationContext = Record<string, unknown>;

/**
 * Resolves a gate ID to a boolean (visible / not visible). May be async
 * (DB query, network call, permission resolver). Sync evaluators that
 * return a plain boolean are also fine.
 *
 * Generic over the caller's context shape so evaluators get typed access
 * to context fields without casting. Defaults to the permissive
 * `GateEvaluationContext` so existing call sites keep compiling.
 *
 * @param gateId Full gate id, including the prefix (e.g. `'permission:articles.publish'`).
 *               Evaluators typically split on `:` to extract the identifier.
 * @param context The caller-supplied context blob (see {@link GateEvaluationContext}).
 */
export type GateEvaluator<
  TCtx extends GateEvaluationContext = GateEvaluationContext,
> = (gateId: string, context: TCtx) => Promise<boolean> | boolean;

/**
 * Tool definition shape required by `composeDockAvailability`. A subset of
 * the full {@link ToolDef} that drops Svelte-specific fields (`component`,
 * `iconComponent`) so the composer stays server-side-safe. Consumers
 * typically derive this from their registered `ToolDef[]` by picking the
 * fields they want to surface in `availableTools`.
 */
export interface GatedToolSummary {
  id: string;
  label?: string;
  badge?: number | string | null;
  gates?: string[];
}

/**
 * Options for {@link composeDockAvailability}.
 *
 * Generic over the caller's context shape (`TCtx`) so evaluators get
 * typed access to context fields without casting. Defaults to the
 * permissive `GateEvaluationContext` so existing call sites keep
 * compiling.
 *
 * @example
 * ```ts
 * interface MyContext extends GateEvaluationContext {
 *   userId: string;
 *   tenantId: string;
 * }
 *
 * await composeDockAvailability<MyContext>({
 *   tools: [...],
 *   context: { userId: 'u-1', tenantId: 't-1' },
 *   evaluators: {
 *     permission: async (gateId, ctx) => {
 *       // ctx.userId and ctx.tenantId are typed `string` — no cast needed
 *       const [, slug] = gateId.split(':', 2);
 *       return resolver.hasPermission(ctx.userId, ctx.tenantId, slug);
 *     },
 *   },
 * });
 * ```
 */
export interface ComposeDockAvailabilityOptions<
  TCtx extends GateEvaluationContext = GateEvaluationContext,
> {
  /** Registered tools (or a subset thereof — typically derived from `ToolDef[]`). */
  tools: ReadonlyArray<GatedToolSummary>;
  /**
   * Caller-supplied context (userId, tenantId, contentId, etc.). Passed
   * through unchanged to each evaluator. The composer doesn't inspect it.
   */
  context: TCtx;
  /**
   * Map of gate-prefix → evaluator. The prefix is the part of the gate ID
   * before the first `:`. e.g., `'permission'`, `'feature'`, `'myapp'`.
   *
   * Tools whose gates reference an unregistered prefix throw at composition
   * time — misconfiguration should fail loudly, not silently leak tools.
   */
  evaluators: Record<string, GateEvaluator<TCtx>>;
}

// Re-export AvailableTool so consumers can pull both the composer
// signature and the return-element type from this server subpath without
// reaching into the Svelte-aware barrel.
export type { AvailableTool };
