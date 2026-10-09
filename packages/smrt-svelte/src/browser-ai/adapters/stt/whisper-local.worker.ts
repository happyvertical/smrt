/**
 * Web Worker entry for `whisper-local`: runs the Whisper engine off the main
 * thread so the page stays responsive while it downloads and transcribes.
 *
 * This is the one module that imports `@huggingface/transformers` statically,
 * so a bundler resolves (and bundles) it for the app that creates this
 * worker, and for no other app. Create it from the host, where the optional
 * peer is installed:
 *
 * ```ts
 * import WhisperWorker from '@happyvertical/smrt-svelte/browser-ai/whisper-worker?worker';
 * createSttDictationSource({
 *   type: 'whisper-local',
 *   createWorker: () => new WhisperWorker(),
 * });
 * ```
 */
import * as transformers from '@huggingface/transformers';
import {
  serveWhisperLocalEngine,
  type WhisperTransformersModule,
  type WhisperWorkerScope,
} from './whisper-local-engine.js';

serveWhisperLocalEngine(
  self as unknown as WhisperWorkerScope,
  async () => transformers as unknown as WhisperTransformersModule,
);
