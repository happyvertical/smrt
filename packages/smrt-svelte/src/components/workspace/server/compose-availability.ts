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
import type { ComposeDockAvailabilityOptions } from './types.js';

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
 * import { composeDockAvailability } from '@happyvertical/smrt-svelte/workspace/server';
 * import { PermissionResolver } from '@happyvertical/smrt-users';
 * import { FeatureResolver } from '@happyvertical/smrt-features';
 *
 * const available = await composeDockAvailability({
 *   tools: [
 *     { id: 'governance', label: 'Claim Audit', gates: ['permission:content.governance.view'] },
 *     { id: 'video-gen',  label: 'Video',       gates: ['feature:video-tools'] },
 *     { id: 'chat',       label: 'Chat' }, // no gates → always visible
 *   ],
 *   context: { userId: 'user-1', tenantId: 'tenant-1' },
 *   evaluators: {
 *     permission: async (gateId, ctx) => {
 *       const [, slug] = gateId.split(':', 2);
 *       return permissionResolver.hasPermission(
 *         ctx.userId as string,
 *         ctx.tenantId as string,
 *         slug,
 *       );
 *     },
 *     feature: async (gateId, ctx) => {
 *       const [, key] = gateId.split(':', 2);
 *       return featureResolver.isEnabled(key, { tenantId: ctx.tenantId as string });
 *     },
 *   },
 * });
 * // → AvailableTool[] filtered by gates
 * ```
 */
export async function composeDockAvailability(
  options: ComposeDockAvailabilityOptions,
): Promise<AvailableTool[]> {
  const { tools, context, evaluators } = options;

  const evaluations = await Promise.all(
    tools.map(async (tool) => {
      if (!tool.gates || tool.gates.length === 0) {
        return tool; // no gates → visible
      }

      const gateResults = await Promise.all(
        tool.gates.map(async (gateId) => {
          const prefix = gateId.split(':', 1)[0];
          const evaluator = evaluators[prefix];
          if (!evaluator) {
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

      return gateResults.every(Boolean) ? tool : null;
    }),
  );

  return evaluations
    .filter((t): t is NonNullable<typeof t> => t !== null)
    .map((tool) => ({
      id: tool.id,
      label: tool.label ?? '',
      badge: tool.badge ?? null,
    }));
}
