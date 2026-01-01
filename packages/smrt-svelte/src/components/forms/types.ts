/**
 * Types for SMRT Form components
 */

/** Speech-to-text adapter type */
export type STTAdapterType = 'browser' | 'whisper-wasm';

/** LLM model ID for field extraction */
export type LLMModelId =
  | 'none'
  | 'smollm2-360m'
  | 'smollm2-1.7b'
  | 'qwen2.5-1.5b'
  | 'llama-3.2-1b';

/** Option for SMRTSelect component */
export interface SelectOption {
  value: string;
  label: string;
}
