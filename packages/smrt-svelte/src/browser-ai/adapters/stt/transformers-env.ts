/**
 * The transformers.js `env` settings both the page thread and the worker
 * entry use: Cache Storage for downloads, and one WASM thread where the page
 * cannot be cross-origin isolated (static hosts cannot send COOP/COEP, so
 * there is no SharedArrayBuffer).
 */
export function configureTransformersEnv(
  allowLocalModels: boolean,
): (env: Record<string, unknown>) => void {
  return (env) => {
    env.allowLocalModels = allowLocalModels;
    env.useBrowserCache = true;
    const isolated =
      (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated ===
      true;
    const wasm = (
      env.backends as { onnx?: { wasm?: { numThreads?: number } } } | undefined
    )?.onnx?.wasm;
    if (wasm && !isolated) wasm.numThreads = 1;
  };
}
