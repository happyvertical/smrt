/**
 * LLM adapter types
 */

import type {
  BaseBrowserAIOptions,
  InitState,
  OnProgress,
} from '../../core/types.js';

/**
 * LLM message structure (matching standard chat format)
 */
export interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * LLM response structure
 */
export interface LLMResponse {
  /** Generated text content */
  content: string;
  /** Token usage statistics */
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  /** Why generation stopped */
  finishReason?: 'stop' | 'length' | 'error';
  /** Model used for generation */
  model?: string;
}

/**
 * LLM model information
 */
export interface LLMModel {
  /** Model identifier */
  id: string;
  /** Human-readable name */
  name: string;
  /** Maximum context length in tokens */
  contextLength: number;
  /** Download size in bytes */
  downloadSize: number;
  /** Quantization method (e.g., 'q4f16_1', 'q4f32_1') */
  quantization?: string;
  /** VRAM required in bytes */
  vramRequired?: number;
}

/**
 * LLM adapter capabilities
 */
export interface LLMCapabilities {
  /** Available models */
  models: LLMModel[];
  /** Whether streaming is supported */
  streaming: boolean;
  /** Maximum context length (of best model) */
  maxContextLength: number;
  /** Whether download is required */
  requiresDownload: boolean;
  /** Whether WebGPU acceleration is available */
  webgpu: boolean;
}

/**
 * Options for LLM chat completion
 */
export interface LLMChatOptions {
  /** Model ID to use */
  model?: string;
  /** Maximum tokens to generate */
  maxTokens?: number;
  /** Sampling temperature (0-2, higher = more creative) */
  temperature?: number;
  /** Top-p (nucleus) sampling */
  topP?: number;
  /** Stop sequences */
  stop?: string[];
  /** Streaming callback for partial results */
  onToken?: (token: string) => void;
}

/**
 * LLM adapter interface - all LLM implementations must implement this
 */
export interface LLMAdapter {
  /** Adapter type identifier */
  readonly type: 'webllm' | 'transformers-llm';

  /** Current initialization state */
  readonly initState: InitState;

  /** Currently loaded model ID */
  readonly currentModel: string | null;

  /**
   * Initialize the adapter with a specific model
   * Downloads model files if not cached
   */
  ensureInitialized(modelId?: string, onProgress?: OnProgress): Promise<void>;

  /**
   * Get adapter capabilities and available models
   */
  getCapabilities(): Promise<LLMCapabilities>;

  /**
   * Generate chat completion
   */
  chat(messages: LLMMessage[], options?: LLMChatOptions): Promise<LLMResponse>;

  /**
   * Generate streaming chat completion
   */
  stream(
    messages: LLMMessage[],
    options?: LLMChatOptions,
  ): AsyncIterable<string>;

  /**
   * Simple message interface - single turn conversation
   */
  message(
    text: string,
    options?: LLMChatOptions & { systemPrompt?: string },
  ): Promise<string>;

  /**
   * Count tokens in text (approximate)
   */
  countTokens?(text: string): Promise<number>;

  /**
   * Unload current model to free VRAM/memory
   */
  unloadModel(): Promise<void>;

  /**
   * Dispose of all resources
   */
  dispose(): Promise<void>;
}

/**
 * WebLLM adapter options
 */
export interface WebLLMOptions extends BaseBrowserAIOptions {
  type?: 'webllm';
  /** Default model to load */
  defaultModel?: string;
  /** App configuration for WebLLM */
  appConfig?: any;
}

/**
 * Transformers.js LLM adapter options
 */
export interface TransformersLLMOptions extends BaseBrowserAIOptions {
  type: 'transformers-llm';
  /** Default model to load */
  defaultModel?: string;
}

/**
 * Union type for LLM factory options
 */
export type GetLLMOptions = WebLLMOptions | TransformersLLMOptions;

/**
 * Common small models suitable for browser use
 */
export const RECOMMENDED_MODELS = {
  // Smallest, fastest
  'smollm2-360m': {
    id: 'SmolLM2-360M-Instruct-q4f16_1-MLC',
    name: 'SmolLM2 360M',
    contextLength: 2048,
    downloadSize: 250 * 1024 * 1024, // ~250MB
  },
  // Good balance
  'smollm2-1.7b': {
    id: 'SmolLM2-1.7B-Instruct-q4f16_1-MLC',
    name: 'SmolLM2 1.7B',
    contextLength: 2048,
    downloadSize: 1.1 * 1024 * 1024 * 1024, // ~1.1GB
  },
  // Larger, more capable
  'qwen2.5-1.5b': {
    id: 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC',
    name: 'Qwen2.5 1.5B',
    contextLength: 32768,
    downloadSize: 1 * 1024 * 1024 * 1024, // ~1GB
  },
  // Phi-3 mini
  'phi-3-mini': {
    id: 'Phi-3-mini-4k-instruct-q4f16_1-MLC',
    name: 'Phi-3 Mini 4K',
    contextLength: 4096,
    downloadSize: 2.3 * 1024 * 1024 * 1024, // ~2.3GB
  },
  // Llama 3.2
  'llama-3.2-1b': {
    id: 'Llama-3.2-1B-Instruct-q4f16_1-MLC',
    name: 'Llama 3.2 1B',
    contextLength: 8192,
    downloadSize: 800 * 1024 * 1024, // ~800MB
  },
} as const;

export type RecommendedModelKey = keyof typeof RECOMMENDED_MODELS;
