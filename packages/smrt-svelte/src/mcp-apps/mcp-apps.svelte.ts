import type {
  McpAppBridgeOptions,
  McpAppSnapshot,
} from '@happyvertical/smrt-mcp-apps';
import { McpAppBridge } from '@happyvertical/smrt-mcp-apps';
import type {
  ViewIntent,
  ViewIntentBinding,
} from '@happyvertical/smrt-web/intents';
import { compileViewIntentToolSpec } from '@happyvertical/smrt-web/intents';
import { onMount } from 'svelte';

export interface McpAppState {
  readonly bridge: McpAppBridge | undefined;
  readonly snapshot: McpAppSnapshot | undefined;
  readonly error: string | undefined;
}
/** Mount-owned bridge. Options factory runs only in the browser; SSR stays inert. */
export function useMcpApp(options: () => McpAppBridgeOptions): McpAppState {
  let bridge = $state<McpAppBridge>();
  let snapshot = $state<McpAppSnapshot>();
  let error = $state<string>();
  onMount(() => {
    let active = true;
    const current = new McpAppBridge(options());
    bridge = current;
    const unsubscribe = current.subscribe((next) => {
      if (active) snapshot = next;
    });
    void current.connect().catch((failure: unknown) => {
      if (active)
        error = failure instanceof Error ? failure.message : 'Host unavailable';
    });
    return () => {
      active = false;
      unsubscribe();
      current.dispose();
      bridge = undefined;
    };
  });
  return {
    get bridge() {
      return bridge;
    },
    get snapshot() {
      return snapshot;
    },
    get error() {
      return error;
    },
  };
}
/**
 * Component-local intent; never advertised to the remote host. The public compiler
 * dispatches to ControlInteractionRegistry/DataSurfaceRegistry. Control commands
 * retain source=agent, so staged edits require the existing trusted human review.
 * Explicit bindings also work without Provider or document.modelContext.
 */
export function useMcpAppIntent(
  intent: ViewIntent,
  binding: ViewIntentBinding,
): (args?: Record<string, unknown>) => Promise<string> {
  const spec = compileViewIntentToolSpec(intent, binding);
  let active = false;
  onMount(() => {
    active = true;
    return () => {
      active = false;
    };
  });
  return async (args = {}) => {
    if (!active) throw new Error('MCP App intent is not mounted');
    const result = await spec.execute(args);
    if (!active) throw new Error('MCP App intent was unmounted');
    return result;
  };
}
