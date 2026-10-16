import { createLocalSpeechModel } from '@happyvertical/smrt-svelte/browser-ai';
import SpeechWorker from '@happyvertical/smrt-svelte/browser-ai/whisper-worker?worker';
import type { LocalSpeechModel, SpeechModelId } from './voice.svelte.ts';

export { createHandsFreeCapture } from '@happyvertical/smrt-ui/forms/hands-free';

/**
 * The real speech model: Moonshine or Whisper in a Web Worker, built by this
 * app because the worker is the one module that imports
 * `@huggingface/transformers`, and the engine (`@happyvertical/speech`) is
 * loaded here too, so only this app's bundler pulls those libraries in. Kept
 * apart from the voice logic so tests never load a worker.
 */
export function createSpeechModel(model: SpeechModelId): LocalSpeechModel {
  return createLocalSpeechModel({
    model,
    createWorker: () => new SpeechWorker(),
    loadSpeech: () => import('@happyvertical/speech/local'),
  });
}
