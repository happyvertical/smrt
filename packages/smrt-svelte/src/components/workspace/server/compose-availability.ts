/**
 * Server-side dock availability gate composer.
 *
 * Consumer's `fetchAvailability` endpoint calls `composeDockAvailability`
 * with the registered tools, a caller-supplied context, and a map of
 * gate evaluators (typically wrapping `PermissionResolver` from
 * smrt-users and `FeatureResolver` from smrt-features). It returns the
 * filtered `AvailableTool[]` the dock's client-side `fetchAvailability`
 * resolves to.
 *
 * Server-side by design: no Svelte / DOM imports, no client-only state.
 * See happyvertical/smrt#1226 (Phase 4c) and #1235 for the registry
 * audit that motivated this server-first pattern.
 */

import type { AvailableTool } from '../types.js';
import type {
  ComposeDockAvailabilityOptions,
  GateEvaluationContext,
} from './types.js';

/**
 * Compose the `availableTools` list for a tools dock by evaluating each
 * tool's `gates` against the provided evaluators. Tools where ALL gates
 * resolve to `true` are included (AND semantics).
 *
 * Tools without `gates` (or with an empty `gates` array) are
 * unconditionally included — gating is opt-in, existing tool definitions
 * keep working.
 *
 * Throws if a gate's prefix doesn't match any registered evaluator —
 * misconfiguration should fail loudly, not silently leak tools to users
 * who shouldn't see them.
 *
 * Gate evaluation is parallel within a tool and across tools (`Promise.all`
 * fan-out), so a slow evaluator on one gate doesn't block unrelated tools.
 *
 * @example
 * ```ts
 * import {
 *   composeDockAvailability,
 *   type GateEvaluationContext,
 * } from '@happyvertical/smrt-svelte/workspace/server';
 * import { PermissionResolver } from '@happyvertical/smrt-users';
 * import { FeatureResolver } from '@happyvertical/smrt-features';
 *
 * // Caller narrows the context shape so evaluators get typed access
 * // without casts:
 * interface MyContext extends GateEvaluationContext {
 *   userId: string;
 *   tenantId: string;
 * }
 *
 * const available = await composeDockAvailability<MyContext>({
 *   tools: [
 *     { id: 'governance', label: 'Claim Audit', gates: ['permission:content.governance.view'] },
 *     { id: 'video-gen',  label: 'Video',       gates: ['feature:video-tools'] },
 *     { id: 'chat',       label: 'Chat' }, // no gates → always visible
 *   ],
 *   context: { userId: 'user-1', tenantId: 'tenant-1' },
 *   evaluators: {
 *     permission: async (gateId, ctx) => {
 *       const [, slug] = gateId.split(':', 2);
 *       return permissionResolver.hasPermission(ctx.userId, ctx.tenantId, slug);
 *     },
 *     feature: async (gateId, ctx) => {
 *       const [, key] = gateId.split(':', 2);
 *       return featureResolver.isEnabled(key, { tenantId: ctx.tenantId });
 *     },
 *   },
 * });
 * // → AvailableTool[] filtered by gates
 * ```
 */
export async function composeDockAvailability<
  TCtx extends { [K in keyof TCtx]: unknown } = GateEvaluationContext,
>(options: ComposeDockAvailabilityOptions<TCtx>): Promise<AvailableTool[]> {
  const { tools, context, evaluators } = options;

  const evaluations = await Promise.all(
    tools.map(async (tool) => {
      if (!tool.gates || tool.gates.length === 0) {
        return tool; // no gates → visible
      }

      const gateResults = await Promise.all(
        tool.gates.map(async (gateId) => {
          const prefix = gateId.split(':', 1)[0];
          // Use Object.hasOwn() + a function-type guard so a gate like
          // `constructor:foo` or `toString:foo` doesn't resolve to an
          // inherited `Object.prototype` property and silently pass — the
          // contract is fail-loud on unknown prefix. The function-type
          // check is belt-and-suspenders: a consumer that accidentally
          // wires a non-function evaluator should also throw here.
          const evaluator = Object.hasOwn(evaluators, prefix)
            ? evaluators[prefix]
            : undefined;
          if (typeof evaluator !== 'function') {
            const availablePrefixes =
              Object.keys(evaluators).join(', ') || '(none)';
            throw new Error(
              `[composeDockAvailability] No evaluator registered for gate prefix "${prefix}" ` +
                `(tool "${tool.id}", gate "${gateId}"). Available prefixes: ${availablePrefixes}.`,
            );
          }
          return evaluator(gateId, context);
        }),
      );

      // Strict equality: only literal `true` passes a gate. Any non-boolean
      // return value (string, object, undefined, etc.) fails-closed —
      // defensive against untyped evaluators that return wrapped objects or
      // sentinel strings instead of plain booleans. `Boolean(...)` would
      // pass `'false'`, `{}`, `[]`, and any truthy garbage, fail-OPEN.
      return gateResults.every((result) => result === true) ? tool : null;
    }),
  );

  return evaluations
    .filter((t): t is NonNullable<typeof t> => t !== null)
    .map((tool) => {
      // Preserve absence: omitting `label` / `badge` here lets
      // `defineToolsDock.applyAvailability` fall back to the registered
      // `ToolDef` metadata. Materializing `label: ''` would blank the rail
      // button, and `badge: null` would explicitly clear any registered
      // default badge.
      const out: AvailableTool = { id: tool.id };
      if (tool.label !== undefined) out.label = tool.label;
      if (tool.badge !== undefined) out.badge = tool.badge;
      return out;
    });
}
