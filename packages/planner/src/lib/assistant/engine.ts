import type {
  WebLLMEngineLike,
  WebLLMLoadProgress,
} from '@happyvertical/ai/local';

export type LoadProgress = Pick<WebLLMLoadProgress, 'progress' | 'text'>;

/** A model held in a Web Worker, with a way to stop and free it. */
export interface LoadedModel {
  engine: WebLLMEngineLike;
  /** Free the GPU memory and end the worker. */
  dispose(): void;
}

/** What `loadModel` needs from the browser; swapped out in tests. */
export interface EngineHost {
  createWorker(): Worker;
  createEngine(
    worker: Worker,
    modelId: string,
    onProgress: (report: LoadProgress) => void,
  ): Promise<WebLLMEngineLike>;
}

/** The real host: a module worker running WebLLM. */
export const browserHost: EngineHost = {
  createWorker: () =>
    new Worker(new URL('./llm.worker.ts', import.meta.url), { type: 'module' }),
  createEngine: async (worker, modelId, onProgress) => {
    const { CreateWebWorkerMLCEngine } = await import('@mlc-ai/web-llm');
    return CreateWebWorkerMLCEngine(worker, modelId, {
      initProgressCallback: (report) => onProgress(report),
    }) as Promise<WebLLMEngineLike>;
  },
};

/**
 * Download (or read from the browser cache) and compile a model in a worker.
 * Aborting ends the worker, which stops the download, and rejects.
 */
export async function loadModel(
  modelId: string,
  onProgress: (report: LoadProgress) => void,
  signal?: AbortSignal,
  host: EngineHost = browserHost,
): Promise<LoadedModel> {
  if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
  const worker = host.createWorker();
  const dispose = () => worker.terminate();
  let onAbort: (() => void) | undefined;
  const cancelled = new Promise<never>((_, reject) => {
    onAbort = () => {
      dispose();
      reject(new DOMException('Cancelled', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
  try {
    const engine = await Promise.race([
      host.createEngine(worker, modelId, onProgress),
      cancelled,
    ]);
    return { engine, dispose };
  } catch (error) {
    dispose();
    throw error;
  } finally {
    if (onAbort) signal?.removeEventListener('abort', onAbort);
  }
}
