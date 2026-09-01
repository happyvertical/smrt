import type {
  WebMcpBespokeToolSpec,
  WebMcpToolEffect,
} from '@happyvertical/smrt-web';
import { tryGetWebMcpBespokeContext } from './webmcp-bespoke-context.js';

/** A tool exposed to the browser's WebMCP model context. */
export type WebMcpToolSpec = WebMcpBespokeToolSpec;

export interface UseWebMcpToolOptions {
  /**
   * This tool's own `effects` exposure-policy fallback, used only when no
   * Provider ancestor supplies an explicit `webmcp.effects` policy. A
   * Provider's explicit policy always wins over this default — even a
   * narrower one — so a component cannot use its own default to grant
   * itself more than an ancestor Provider allows (#2586). Omit to keep the
   * registrar's own read-only default as the no-Provider fallback.
   */
  effects?: readonly WebMcpToolEffect[];
}

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
 *
 * @param options.effects a fallback exposure policy applied only when no
 * Provider ancestor declares one — see {@link UseWebMcpToolOptions}.
 */
export function useWebMcpTool(
  factory: () => WebMcpToolSpec | null | undefined,
  options: UseWebMcpToolOptions = {},
): void {
  const bespokeContext = tryGetWebMcpBespokeContext();

  $effect(() => {
    if (typeof window === 'undefined') return;
    // Feature-detect locally first so a browser without WebMCP never pays for
    // the dynamic import below.
    if (!getModelContext()) return;

    const spec = factory();
    if (!spec) return;

    // Read the Provider's effects policy synchronously, inside this effect's
    // tracking window — `bespokeContext.effects` is a reactive getter, and a
    // read from inside the dynamic import's `.then()` below happens after
    // the effect has already finished its synchronous run, so it would never
    // register as a dependency. Capturing it here means a later change to
    // the Provider's policy re-runs this effect, tearing down and
    // re-registering the tool under the new policy. A Provider's explicit
    // policy always wins; this call's own `options.effects` is only the
    // no-Provider fallback.
    const effects = bespokeContext?.effects ?? options.effects;

    let cancelled = false;
    let dispose: () => void = () => {};

    // Two-argument `.then(onFulfilled, onRejected)` — NOT `.then().catch()` —
    // so `onRejected` only observes the dynamic import itself failing to
    // load (expected in bundle profiles without `@happyvertical/smrt-web`,
    // so it stays silent). A synchronous throw from
    // `registerWebMcpBespokeTool` (e.g. an invalid `effects` policy) happens
    // inside `onFulfilled` and is deliberately left uncaught here so it
    // propagates instead of being silently swallowed alongside the
    // load-failure case. Async registration failure is a separate case,
    // observed below via the returned disposer's `.ready` rejection.
    void import('@happyvertical/smrt-web').then(
      ({ registerWebMcpBespokeTool }) => {
        if (cancelled) return;
        const registration = registerWebMcpBespokeTool(spec, { effects });
        dispose = registration;
        void registration.ready.catch((error: unknown) => {
          if (!cancelled) {
            console.warn(
              '[smrt-svelte] bespoke WebMCP tool registration failed',
              spec.name,
              error,
            );
          }
        });
      },
      () => {
        // No registrar available in this bundle profile — treat like WebMCP
        // being unavailable and no-op.
      },
    );

    return () => {
      cancelled = true;
      dispose();
    };
  });
}
