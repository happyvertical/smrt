import type { DataSurfaceRegistry } from '@happyvertical/smrt-ui/data';
import type { ControlInteractionRegistry } from '@happyvertical/smrt-ui/forms';
import { getContext, setContext } from 'svelte';

const WEBMCP_UI_CONTEXT_KEY = Symbol('smrt-webmcp-ui-context');

export interface WebMcpUiContext {
  readonly enabled: boolean;
  readonly controlRegistry: ControlInteractionRegistry;
  readonly dataSurfaceRegistry: DataSurfaceRegistry;
}

export function setWebMcpUiContext(context: WebMcpUiContext): void {
  setContext(WEBMCP_UI_CONTEXT_KEY, context);
}

export function tryGetWebMcpUiContext(): WebMcpUiContext | null {
  return getContext<WebMcpUiContext>(WEBMCP_UI_CONTEXT_KEY) ?? null;
}

/** Return the mounted-UI registries owned by the nearest SMRT Provider. */
export function useWebMcpUi(): WebMcpUiContext {
  const context = tryGetWebMcpUiContext();
  if (!context?.enabled) {
    throw new Error(
      'WebMCP UI context not found. Wrap this component with <Provider>.',
    );
  }
  return context;
}
