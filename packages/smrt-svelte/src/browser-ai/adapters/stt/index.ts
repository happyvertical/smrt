/**
 * Speech-to-Text adapters
 */

export {
  type BrowserSpeechError,
  BrowserSpeechSTTAdapter,
} from './browser-speech.js';
export { createSttDictationSource } from './dictation-source.js';
export * from './factory.js';
export * from './types.js';
export { WhisperCppSTTAdapter } from './whisper-cpp.js';
export {
  WhisperLocalSTTAdapter,
  WhisperWasmSTTAdapter,
} from './whisper-local.js';
export {
  WHISPER_LOCAL_DEFAULT_MODEL,
  WHISPER_LOCAL_DEFAULT_SIZE_BYTES,
  type WhisperLocalDevice,
} from './whisper-local-engine.js';
export {
  createWhisperLocalModel,
  type WhisperLocalLoadOptions,
  WhisperLocalModel,
  type WhisperLocalModelOptions,
  type WhisperLocalModelState,
} from './whisper-local-model.js';
