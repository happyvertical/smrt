/**
 * Web Worker entry for on-device speech (`whisper-local`, `moonshine`): runs
 * `@happyvertical/speech/local`'s worker host off the main thread so the
 * page stays responsive while it downloads and transcribes.
 *
 * This is the one module that imports `@huggingface/transformers` (and
 * `@happyvertical/speech/local`) statically, so a bundler resolves (and
 * bundles) them for the app that creates this worker, and for no other app.
 * Create it from the host, where the optional peers are installed:
 *
 * ```ts
 * import SpeechWorker from '@happyvertical/smrt-svelte/browser-ai/whisper-worker?worker';
 * createLocalSpeechModel({
 *   model: 'moonshine-tiny',
 *   createWorker: () => new SpeechWorker(),
 *   loadSpeech: () => import('@happyvertical/speech/local'),
 * });
 * ```
 *
 * The worker runs the quantised (`q8`) model on WebGPU where an adapter
 * exists, else single-thread WASM. The model is chosen per request by the
 * main thread, so one worker serves whichever model the handle names.
 */
import { serveLocalTranscriber } from '@happyvertical/speech/local';
import * as transformers from '@huggingface/transformers';
import { configureTransformersEnv } from './transformers-env.js';

serveLocalTranscriber({
  transformers: transformers as unknown as Record<string, unknown>,
  device: 'auto',
  dtype: 'q8',
  configureEnv: configureTransformersEnv(false),
});
