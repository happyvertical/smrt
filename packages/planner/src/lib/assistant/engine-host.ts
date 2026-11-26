import type { WebLLMEngineLike } from '@happyvertical/ai/local';
import type { EngineHost } from './engine.ts';

/**
 * The real host: a module worker running WebLLM. Kept in its own module so a
 * build that cannot run a local model (the MCP widget, `src/mcp/`) can replace
 * it without bundling WebLLM.
 */
export const browserHost: EngineHost = {
  createWorker: () =>
    // Extensionless on purpose: Vite resolves it to `.ts` here and to the
    // `.js` svelte-package emits in `dist/`, so a host bundling the package
    // finds the worker (`./llm.worker.ts` broke the host's build).
    new Worker(new URL('./llm.worker', import.meta.url), { type: 'module' }),
  createEngine: async (worker, modelId, onProgress) => {
    const { CreateWebWorkerMLCEngine } = await import('@mlc-ai/web-llm');
    return CreateWebWorkerMLCEngine(worker, modelId, {
      initProgressCallback: (report) => onProgress(report),
    }) as Promise<WebLLMEngineLike>;
  },
};
