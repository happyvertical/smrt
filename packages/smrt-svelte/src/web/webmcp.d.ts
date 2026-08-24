/**
 * Ambient WebMCP types. Chrome currently exposes this origin-trial API without
 * shipping it in TypeScript's DOM library.
 */

import type { WebMcpToolSpec } from './webmcp.svelte.js';

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

export {};
