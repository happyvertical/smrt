import type { DataSurfaceRegistry } from '@happyvertical/smrt-ui/data';
import type { ControlInteractionRegistry } from '@happyvertical/smrt-ui/forms';
import type {
  ViewIntent,
  ViewIntentBinding,
  ViewIntentDataSurfaceKind,
  WebMcpToolEffect,
} from '@happyvertical/smrt-web';
// The dependency-free intent entry, NOT the package root: it pulls no
// client-data engine, so a component binding an intent pays only for the
// declaration contract. The registrar itself is still loaded lazily, by
// `useWebMcpTool`.
import { compileViewIntentToolSpec } from '@happyvertical/smrt-web/intents';
import { useWebMcpTool } from './webmcp.svelte.js';
import { tryGetWebMcpUiContext } from './webmcp-ui-context.js';

/** The mounted registry identity an intent addresses. */
export type ViewIntentIdentity =
  | { formId: string; controlId: string }
  | { surfaceId: string; kind: ViewIntentDataSurfaceKind };

export interface UseViewIntentOptions {
  /**
   * The mounted identity this intent is bound to for the component's
   * lifetime. Shape must match the intent's declared target registry:
   * `{ formId, controlId }` for a control intent, `{ surfaceId, kind }` for a
   * data-surface intent.
   */
  identity: ViewIntentIdentity;
  /**
   * `effects` exposure-policy fallback, used only when no Provider ancestor
   * supplies an explicit `webmcp.effects` policy — see
   * {@link useWebMcpTool}. A Provider's explicit policy always wins.
   */
  effects?: readonly WebMcpToolEffect[];
  /** Override the Provider's control registry (tests, nested hosts). */
  controlRegistry?: ControlInteractionRegistry;
  /** Override the Provider's data-surface registry. */
  dataSurfaceRegistry?: DataSurfaceRegistry;
}

/**
 * Bind a declared view intent (#2588) to this component's mounted registry
 * identity, for exactly this component's lifetime.
 *
 * Svelte is the FIRST binding, not the only one: the declaration contract,
 * the registry, and the compilation to a browser tool all live in
 * `@happyvertical/smrt-web` with no Svelte dependency. This file is the thin
 * part — it resolves the mounted registries from the nearest Provider and
 * hands the compiled spec to {@link useWebMcpTool}, which already owns the
 * WebMCP lifecycle: the synchronous Provider policy read, the `options.effects`
 * fallback, serialized same-name re-registration across effect reruns, and
 * the lazy `@happyvertical/smrt-web` import.
 *
 * Registration therefore goes through `registerWebMcpBespokeTool`, so an
 * intent is subject to the same fail-closed exposure policy as a generated
 * model tool. Execution dispatches exactly one registry command with
 * `source: 'agent'` — `StagedControlReview` stays on the path, agent-staged
 * values remain proposals, and there is no path to REST.
 *
 * Declare the intent itself at module scope in a `.ts` sidecar
 * (`Foo.intents.ts`) so #2591's scanner can emit it; import it here.
 *
 * With no Provider ancestor and no explicit registry override, this is a
 * silent no-op — an intent with nothing mounted to dispatch to registers
 * nothing, the same way every WebMCP entry point no-ops off-WebMCP.
 *
 * @throws if `identity` does not match the intent's declared target registry,
 * or contradicts an identity the declaration pinned — both are author errors,
 * not environment differences.
 */
export function useViewIntent(
  intent: ViewIntent,
  options: UseViewIntentOptions,
): void {
  // `getContext` is only valid during component initialization, so this must
  // run here rather than inside the effect `useWebMcpTool` opens.
  const uiContext = tryGetWebMcpUiContext();
  const controlRegistry =
    options.controlRegistry ??
    (uiContext?.enabled ? uiContext.controlRegistry : undefined);
  const dataSurfaceRegistry =
    options.dataSurfaceRegistry ??
    (uiContext?.enabled ? uiContext.dataSurfaceRegistry : undefined);
  const binding = resolveBinding(
    intent,
    options.identity,
    controlRegistry,
    dataSurfaceRegistry,
  );

  useWebMcpTool(
    () => (binding ? compileViewIntentToolSpec(intent, binding) : null),
    options.effects ? { effects: options.effects } : {},
  );
}

function resolveBinding(
  intent: ViewIntent,
  identity: ViewIntentIdentity,
  controlRegistry: ControlInteractionRegistry | undefined,
  dataSurfaceRegistry: DataSurfaceRegistry | undefined,
): ViewIntentBinding | null {
  if (intent.target.registry === 'control') {
    if (!('formId' in identity)) {
      throw new Error(
        `[smrt-svelte] intent '${intent.id}' targets the control registry and needs a { formId, controlId } identity`,
      );
    }
    if (!controlRegistry) return null;
    return {
      registry: 'control',
      registryPort: controlRegistry,
      identity,
    };
  }

  if (!('surfaceId' in identity)) {
    throw new Error(
      `[smrt-svelte] intent '${intent.id}' targets the dataSurface registry and needs a { surfaceId, kind } identity`,
    );
  }
  if (!dataSurfaceRegistry) return null;
  return {
    registry: 'dataSurface',
    registryPort: dataSurfaceRegistry,
    identity,
  };
}
