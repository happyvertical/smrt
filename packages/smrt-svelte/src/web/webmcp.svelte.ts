import type { WebMcpBespokeToolSpec } from '@happyvertical/smrt-web';
import { tryGetWebMcpBespokeContext } from './webmcp-bespoke-context.js';

/** A tool exposed to the browser's WebMCP model context. */
export type WebMcpToolSpec = WebMcpBespokeToolSpec;

// Keep the ambient contract on the public hook declaration too, so consumers
// importing only the package root still receive `document.modelContext` types.
declare global {
  interface Document {
    modelContext?: WebMcpModelContext;
  }

  interface WebMcpModelContext {
    registerTool(
      tool: WebMcpToolSpec,
      options?: { signal?: AbortSignal },
    ): Promise<void>;
  }
}

function getModelContext(): WebMcpModelContext | undefined {
  // Do not read `document` at module evaluation time: this module is imported
  // by SSR bundles and by browsers without the WebMCP origin trial.
  const documentLike = (globalThis as { document?: Document }).document;
  const context = documentLike?.modelContext;
  return context && typeof context.registerTool === 'function'
    ? context
    : undefined;
}

/**
 * Register a component-owned WebMCP intent for exactly that component's
 * lifetime. The factory runs inside the effect so rune dependencies used by a
 * bespoke intent cause the tool to be replaced when its spec changes.
 *
 * Routes through `@happyvertical/smrt-web`'s `registerWebMcpBespokeTool` so a
 * bespoke tool is subject to the same fail-closed `effects` exposure policy
 * as generated model tools (#2586): a spec with no `annotations`, or with
 * annotations that leave its effect undeclared, classifies destructive,
 * non-idempotent, open-world, and is excluded unless policy allows
 * `destructive`. The policy is the nearest Provider's `webmcp.effects` (read
 * from context so a bespoke and a generated tool share one policy); absent a
 * Provider ancestor, it falls back to the registrar's own read-only default.
 * `namespace` and `maxTools` deliberately do not apply to a bespoke tool.
 *
 * `@happyvertical/smrt-web` loads lazily, on first use, so a page that only
 * calls `useWebMcpTool` never bundles the client-data engine.
 */
export function useWebMcpTool(
  factory: () => WebMcpToolSpec | null | undefined,
): void {
  const bespokeContext = tryGetWebMcpBespokeContext();

  $effect(() => {
    if (typeof window === 'undefined') return;
    // Feature-detect locally first so a browser without WebMCP never pays for
    // the dynamic import below.
    if (!getModelContext()) return;

    const spec = factory();
    if (!spec) return;

    let cancelled = false;
    let dispose: () => void = () => {};

    void import('@happyvertical/smrt-web')
      .then(({ registerWebMcpBespokeTool }) => {
        if (cancelled) return;
        dispose = registerWebMcpBespokeTool(spec, {
          effects: bespokeContext?.effects,
        });
      })
      .catch(() => {
        // No registrar available in this bundle profile — treat like WebMCP
        // being unavailable and no-op.
      });

    return () => {
      cancelled = true;
      dispose();
    };
  });
}
