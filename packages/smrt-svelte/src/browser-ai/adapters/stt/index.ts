/**
 * Speech-to-Text adapters
 */

export {
  type BrowserSpeechError,
  BrowserSpeechSTTAdapter,
} from './browser-speech.js';
export { createSttDictationSource } from './dictation-source.js';
export * from './factory.js';
export {
  LocalSpeechSTTAdapter,
  WhisperLocalSTTAdapter,
  WhisperWasmSTTAdapter,
} from './local-speech.js';
export {
  createLocalSpeechModel,
  createWhisperLocalModel,
  isEnglishOnlyLocalSpeechModel,
  LOCAL_SPEECH_MODELS,
  type LocalSpeechDevice,
  type LocalSpeechLoadOptions,
  LocalSpeechModel,
  type LocalSpeechModelOptions,
  type LocalSpeechModelPreset,
  type LocalSpeechModelState,
  resolveLocalSpeechModelId,
  WHISPER_LOCAL_DEFAULT_MODEL,
  WHISPER_LOCAL_DEFAULT_SIZE_BYTES,
  type WhisperLocalDevice,
  type WhisperLocalLoadOptions,
  WhisperLocalModel,
  type WhisperLocalModelOptions,
  type WhisperLocalModelState,
} from './local-speech-model.js';
export { configureTransformersEnv } from './transformers-env.js';
export * from './types.js';
export { WhisperCppSTTAdapter } from './whisper-cpp.js';
