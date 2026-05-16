/**
 * useToolsDock - read the {@link ToolsDockApi} from Svelte context.
 *
 * Tools and arbitrary descendants of `<ToolsDock>` use this to obtain the
 * dock instance that owns them — open/close themselves, push events through
 * the typed bus, react to the current `context`, etc.
 *
 * Throws a clear error if called outside a `<ToolsDock>` provider tree so
 * misuse fails loudly during development rather than producing silent nulls.
 *
 * The returned `dock.context` is the default {@link ToolsDockContext} shape.
 * For typed access from within a tool body, the recommended pattern is to
 * type the component's own `context` prop locally — see the JSDoc on
 * {@link ToolDef.component} for an example. (`ToolDef` deliberately erases
 * its context generic at registration time so the dock can store tools as
 * a single homogeneous `ToolDef[]`.)
 *
 * @example
 * ```svelte
 * <script lang="ts">
 *   import { useToolsDock } from '@happyvertical/smrt-svelte/workspace';
 *   const dock = useToolsDock();
 * </script>
 *
 * <button type="button" onclick={() => dock.close()}>Close</button>
 * ```
 */

import { getContext } from 'svelte';
import type { ToolsDockApi } from '../types.js';
import { TOOLS_DOCK_KEY } from './define-tools-dock.svelte.js';

/**
 * Retrieve the {@link ToolsDockApi} from Svelte context.
 *
 * @throws Error when called outside a `<ToolsDock>` provider tree
 */
export function useToolsDock(): ToolsDockApi {
  const dock = getContext<ToolsDockApi | undefined>(TOOLS_DOCK_KEY);
  if (!dock) {
    throw new Error(
      '[useToolsDock] No ToolsDock instance found on Svelte context. ' +
        'Wrap your tree in <ToolsDock dock={defineToolsDock(...)} /> first.',
    );
  }
  return dock;
}

/**
 * Non-throwing variant — returns `null` outside a provider. Useful for
 * optional integrations where a tool should degrade gracefully if not
 * embedded inside a `<ToolsDock>`.
 */
export function tryUseToolsDock(): ToolsDockApi | null {
  return getContext<ToolsDockApi | undefined>(TOOLS_DOCK_KEY) ?? null;
}
