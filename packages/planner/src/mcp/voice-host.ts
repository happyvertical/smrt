import { createLocalSpeechModel } from '@happyvertical/smrt-svelte/browser-ai';
import type {
  LocalSpeechModel,
  SpeechModelId,
} from '../lib/assistant/voice.svelte.ts';
import { NO_LOCAL_MODELS } from './no-local-models.ts';

export { createHandsFreeCapture } from '@happyvertical/smrt-ui/forms/hands-free';

/**
 * Replaces `lib/assistant/voice-host.ts` in the MCP widget build
 * (`scripts/build-mcp.ts`): the speech worker and `@happyvertical/speech`
 * each inline the ONNX Runtime WebAssembly into the one self-contained file,
 * and the model they run cannot be downloaded there.
 */
export function createSpeechModel(model: SpeechModelId): LocalSpeechModel {
  return createLocalSpeechModel({
    model,
    loadSpeech: async () => ({}),
    createWorker: () => {
      throw new Error(NO_LOCAL_MODELS);
    },
  });
}
