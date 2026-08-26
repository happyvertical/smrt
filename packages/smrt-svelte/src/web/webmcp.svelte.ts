/** A tool exposed to the browser's WebMCP model context. */
export interface WebMcpToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
    untrustedContentHint?: boolean;
  };
  execute: (args: Record<string, unknown>) => string | Promise<string>;
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
    ): void;
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
 */
export function useWebMcpTool(
  factory: () => WebMcpToolSpec | null | undefined,
): void {
  $effect(() => {
    const context = getModelContext();
    if (!context) return;

    const spec = factory();
    if (!spec) return;
    const controller = new AbortController();
    context.registerTool(spec, { signal: controller.signal });

    return () => controller.abort();
  });
}
