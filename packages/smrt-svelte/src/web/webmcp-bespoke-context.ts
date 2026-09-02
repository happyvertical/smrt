import type { WebMcpToolEffect } from '@happyvertical/smrt-web';
import { getContext, setContext } from 'svelte';

const WEBMCP_BESPOKE_CONTEXT_KEY = Symbol('smrt-webmcp-bespoke-context');

/**
 * The `effects` exposure policy `useWebMcpTool` applies to a bespoke
 * component tool (#2586). Provider sets this from the same `webmcp.effects`
 * config it passes to `registerWebMcpTools` for generated tools, so a
 * bespoke and a generated tool share one policy. Absent a Provider ancestor,
 * `useWebMcpTool` falls back to the registrar's own default (read-only).
 */
export interface WebMcpBespokeContext {
  readonly effects?: readonly WebMcpToolEffect[];
}

export function setWebMcpBespokeContext(context: WebMcpBespokeContext): void {
  setContext(WEBMCP_BESPOKE_CONTEXT_KEY, context);
}

export function tryGetWebMcpBespokeContext(): WebMcpBespokeContext | null {
  return getContext<WebMcpBespokeContext>(WEBMCP_BESPOKE_CONTEXT_KEY) ?? null;
}
