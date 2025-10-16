/**
 * Core types and interfaces for the AI library
 */

/**
 * AI message structure for chat interactions
 */
export interface AIMessage {
  /**
   * Role of the message sender
   */
  role: 'system' | 'user' | 'assistant' | 'function' | 'tool';

  /**
   * Content of the message
   */
  content: string;

  /**
   * Optional name for the message sender
   */
  name?: string;

  /**
   * Optional tool calls
   */
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: {
      name: string;
      arguments: string;
    };
  }>;
}

/**
 * Options for chat completion requests
 */
export interface ChatOptions {
  /**
   * Model to use for completion
   */
  model?: string;

  /**
   * Maximum number of tokens to generate
   */
  maxTokens?: number;

  /**
   * Sampling temperature (0-2)
   */
  temperature?: number;

  /**
   * Top-p sampling parameter
   */
  topP?: number;

  /**
   * Number of completions to generate
   */
  n?: number;

  /**
   * Sequences that stop generation
   */
  stop?: string | string[];

  /**
   * Whether to stream the response
   */
  stream?: boolean;

  /**
   * Penalty for frequency of tokens
   */
  frequencyPenalty?: number;

  /**
   * Penalty for presence of tokens
   */
  presencePenalty?: number;

  /**
   * User identifier for monitoring
   */
  user?: string;

  /**
   * Available tools/functions
   */
  tools?: AITool[];

  /**
   * Tool choice behavior
   */
  toolChoice?:
    | 'auto'
    | 'none'
    | { type: 'function'; function: { name: string } };

  /**
   * Response format specification
   */
  responseFormat?: { type: 'text' | 'json_object' };

  /**
   * Random seed for deterministic results
   */
  seed?: number;

  /**
   * Callback for streaming responses
   */
  onProgress?: (chunk: string) => void;
}

/**
 * Options for text completion requests (non-chat models)
 */
export interface CompletionOptions {
  /**
   * Model to use for completion
   */
  model?: string;

  /**
   * Maximum number of tokens to generate
   */
  maxTokens?: number;

  /**
   * Sampling temperature
   */
  temperature?: number;

  /**
   * Top-p sampling parameter
   */
  topP?: number;

  /**
   * Number of completions to generate
   */
  n?: number;

  /**
   * Sequences that stop generation
   */
  stop?: string | string[];

  /**
   * Whether to stream the response
   */
  stream?: boolean;

  /**
   * Callback for streaming responses
   */
  onProgress?: (chunk: string) => void;
}

/**
 * Options for embedding generation
 */
export interface EmbeddingOptions {
  /**
   * Model to use for embeddings
   */
  model?: string;

  /**
   * User identifier for monitoring
   */
  user?: string;

  /**
   * Encoding format for embeddings
   */
  encodingFormat?: 'float' | 'base64';

  /**
   * Number of dimensions for the embedding
   */
  dimensions?: number;
}

/**
 * Tool/function definition for AI models
 */
export interface AITool {
  /**
   * Type of tool
   */
  type: 'function';

  /**
   * Function definition
   */
  function: {
    /**
     * Function name
     */
    name: string;

    /**
     * Function description
     */
    description?: string;

    /**
     * JSON schema for function parameters
     */
    parameters?: Record<string, any>;
  };
}

/**
 * Model information structure
 */
export interface AIModel {
  /**
   * Model identifier
   */
  id: string;

  /**
   * Human-readable model name
   */
  name: string;

  /**
   * Model description
   */
  description?: string;

  /**
   * Maximum context length in tokens
   */
  contextLength: number;

  /**
   * Supported capabilities
   */
  capabilities: string[];

  /**
   * Whether the model supports function calling
   */
  supportsFunctions: boolean;

  /**
   * Whether the model supports vision/multimodal input
   */
  supportsVision: boolean;

  /**
   * Cost per input token (if available)
   */
  inputCostPer1k?: number;

  /**
   * Cost per output token (if available)
   */
  outputCostPer1k?: number;
}

/**
 * AI provider capabilities
 */
export interface AICapabilities {
  /**
   * Whether the provider supports chat completions
   */
  chat: boolean;

  /**
   * Whether the provider supports text completions
   */
  completion: boolean;

  /**
   * Whether the provider supports embeddings
   */
  embeddings: boolean;

  /**
   * Whether the provider supports streaming
   */
  streaming: boolean;

  /**
   * Whether the provider supports function calling
   */
  functions: boolean;

  /**
   * Whether the provider supports vision/multimodal
   */
  vision: boolean;

  /**
   * Whether the provider supports fine-tuning
   */
  fineTuning: boolean;

  /**
   * Maximum context length supported
   */
  maxContextLength: number;

  /**
   * Supported operations
   */
  supportedOperations: string[];
}

/**
 * Token usage information
 */
export interface TokenUsage {
  /**
   * Number of prompt tokens
   */
  promptTokens: number;

  /**
   * Number of completion tokens
   */
  completionTokens: number;

  /**
   * Total tokens used
   */
  totalTokens: number;
}

/**
 * AI response structure
 */
export interface AIResponse {
  /**
   * Generated content
   */
  content: string;

  /**
   * Token usage information
   */
  usage?: TokenUsage;

  /**
   * Model used for generation
   */
  model?: string;

  /**
   * Finish reason
   */
  finishReason?: 'stop' | 'length' | 'tool_calls' | 'content_filter';

  /**
   * Tool calls made by the model
   */
  toolCalls?: Array<{
    id: string;
    type: 'function';
    function: {
      name: string;
      arguments: string;
    };
  }>;
}

/**
 * Embedding response structure
 */
export interface EmbeddingResponse {
  /**
   * Generated embeddings
   */
  embeddings: number[][];

  /**
   * Token usage information
   */
  usage?: TokenUsage;

  /**
   * Model used for embeddings
   */
  model?: string;
}

/**
 * Core AI interface that all providers must implement
 */
export interface AIInterface {
  /**
   * Generate chat completion
   */
  chat(messages: AIMessage[], options?: ChatOptions): Promise<AIResponse>;

  /**
   * Generate text completion (for non-chat models)
   */
  complete(prompt: string, options?: CompletionOptions): Promise<AIResponse>;

  /**
   * Generate embeddings for text
   */
  embed(
    text: string | string[],
    options?: EmbeddingOptions,
  ): Promise<EmbeddingResponse>;

  /**
   * Stream chat completion
   */
  stream(messages: AIMessage[], options?: ChatOptions): AsyncIterable<string>;

  /**
   * Count tokens in text
   */
  countTokens(text: string): Promise<number>;

  /**
   * Get available models
   */
  getModels(): Promise<AIModel[]>;

  /**
   * Get provider capabilities
   */
  getCapabilities(): Promise<AICapabilities>;
}

/**
 * Base configuration options for all providers
 */
export interface BaseAIOptions {
  /**
   * API timeout in milliseconds
   */
  timeout?: number;

  /**
   * Maximum number of retries
   */
  maxRetries?: number;

  /**
   * Custom headers
   */
  headers?: Record<string, string>;

  /**
   * Default model to use
   */
  defaultModel?: string;
}

/**
 * OpenAI provider options
 */
export interface OpenAIOptions extends BaseAIOptions {
  type?: 'openai';
  apiKey: string;
  baseUrl?: string;
  organization?: string;
}

/**
 * Gemini provider options
 */
export interface GeminiOptions extends BaseAIOptions {
  type: 'gemini';
  apiKey: string;
  baseUrl?: string;
  projectId?: string;
  location?: string;
}

/**
 * Anthropic provider options
 */
export interface AnthropicOptions extends BaseAIOptions {
  type: 'anthropic';
  apiKey: string;
  baseUrl?: string;
  anthropicVersion?: string;
}

/**
 * Hugging Face provider options
 */
export interface HuggingFaceOptions extends BaseAIOptions {
  type: 'huggingface';
  apiToken: string;
  endpoint?: string;
  model?: string;
  useCache?: boolean;
  waitForModel?: boolean;
}

/**
 * AWS Bedrock provider options
 */
export interface BedrockOptions extends BaseAIOptions {
  type: 'bedrock';
  region: string;
  credentials?: {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
  };
  endpoint?: string;
}

/**
 * Union type for all provider options
 */
export type GetAIOptions =
  | OpenAIOptions
  | GeminiOptions
  | AnthropicOptions
  | HuggingFaceOptions
  | BedrockOptions;

/**
 * Error types for AI operations
 */
export class AIError extends Error {
  constructor(
    message: string,
    public code: string,
    public provider?: string,
    public model?: string,
  ) {
    super(message);
    this.name = 'AIError';
  }
}

export class AuthenticationError extends AIError {
  constructor(provider?: string) {
    super('Authentication failed', 'AUTH_ERROR', provider);
    this.name = 'AuthenticationError';
  }
}

export class RateLimitError extends AIError {
  constructor(provider?: string, retryAfter?: number) {
    super(
      `Rate limit exceeded${retryAfter ? `, retry after ${retryAfter}s` : ''}`,
      'RATE_LIMIT',
      provider,
    );
    this.name = 'RateLimitError';
  }
}

export class ModelNotFoundError extends AIError {
  constructor(model: string, provider?: string) {
    super(`Model not found: ${model}`, 'MODEL_NOT_FOUND', provider, model);
    this.name = 'ModelNotFoundError';
  }
}

export class ContextLengthError extends AIError {
  constructor(provider?: string, model?: string) {
    super(
      'Input exceeds maximum context length',
      'CONTEXT_LENGTH_EXCEEDED',
      provider,
      model,
    );
    this.name = 'ContextLengthError';
  }
}

export class ContentFilterError extends AIError {
  constructor(provider?: string, model?: string) {
    super(
      'Content filtered by safety systems',
      'CONTENT_FILTERED',
      provider,
      model,
    );
    this.name = 'ContentFilterError';
  }
}
