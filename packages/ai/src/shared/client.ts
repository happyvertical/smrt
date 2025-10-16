import { ApiError, ValidationError } from '@have/utils';
import OpenAI from 'openai';

import type { AIMessageOptions } from './message';

/**
 * Common options for AI client configuration
 */
export interface AIClientOptions {
  /**
   * Type of AI client (e.g., 'openai')
   */
  type?: string;

  /**
   * Response format for AI completions
   */
  responseFormat?: string;

  /**
   * API key for authentication
   */
  apiKey?: string;

  /**
   * Base URL for API requests
   */
  baseUrl?: string;
}

/**
 * Interface defining required methods for AI clients
 */
export interface AIClientInterface {
  /**
   * Configuration options for this client
   */
  options: AIClientOptions;

  /**
   * Sends a message to the AI and gets a response
   *
   * @param text - Message text
   * @param options - Message options
   * @returns Promise resolving to the AI response
   */
  message(text: string, options: AIMessageOptions): Promise<unknown>;

  /**
   * Gets a text completion from the AI
   *
   * @param text - Input text for completion
   * @param options - Completion options
   * @returns Promise resolving to the completion result
   */
  textCompletion(text: string, options: AIMessageOptions): Promise<unknown>;
}

/**
 * Type guard to check if options are for OpenAI client
 *
 * @param options - Options to check
 * @returns True if options are valid for OpenAI client
 */
function isOpenAIClientOptions(
  options: AIClientOptions,
): options is OpenAIClientOptions {
  return options.type === 'openai' && 'apiKey' in options && !!options.apiKey;
}

/**
 * Type guard to check if value is an AI client instance
 *
 * @param value - Value to check
 * @returns True if value is an AI client instance
 */
function isAIClientInstance(value: any): value is AIClient {
  return value instanceof AIClient;
}

/**
 * Options for AI text completion requests
 */
export interface AITextCompletionOptions {
  /**
   * Model identifier to use
   */
  model?: string;

  /**
   * Timeout in milliseconds
   */
  timeout?: number;

  /**
   * Role of the message sender
   */
  role?: OpenAI.Chat.ChatCompletionRole;

  /**
   * Previous messages in the conversation
   */
  history?: OpenAI.Chat.ChatCompletionMessageParam[];

  /**
   * Name of the message sender
   */
  name?: string;

  /**
   * Penalty for token frequency
   */
  frequencyPenalty?: number;

  /**
   * Token bias adjustments
   */
  logitBias?: Record<string, number>;

  /**
   * Whether to return log probabilities
   */
  logprobs?: boolean;

  /**
   * Number of top log probabilities to return
   */
  topLogprobs?: number;

  /**
   * Maximum tokens to generate
   */
  maxTokens?: number;

  /**
   * Number of completions to generate
   */
  n?: number;

  /**
   * Penalty for token presence
   */
  presencePenalty?: number;

  /**
   * Format for the response
   */
  responseFormat?: { type: 'text' | 'json_object' };

  /**
   * Random seed for deterministic results
   */
  seed?: number;

  /**
   * Sequences that stop generation
   */
  stop?: string | Array<string>;

  /**
   * Whether to stream responses
   */
  stream?: boolean;

  /**
   * Sampling temperature
   */
  temperature?: number;

  /**
   * Top-p sampling parameter
   */
  topProbability?: number;

  /**
   * Available tools for the model
   */
  tools?: Array<any>; // todo: figure out generic solution - Array<OpenAI.Chat.ChatCompletionTool>;

  /**
   * Tool selection behavior
   */
  toolChoice?:
    | 'none'
    | 'auto'
    | { type: 'function'; function: { name: string } };

  /**
   * User identifier
   */
  user?: string;

  /**
   * Callback for handling streaming responses
   */
  onProgress?: (partialMessage: string) => void;
}

/**
 * Base class for AI clients
 * Provides a common interface for different AI service providers
 */
export class AIClient {
  /**
   * Configuration options for this client
   */
  public options: AIClientOptions;

  /**
   * Creates a new AIClient
   *
   * @param options - Client configuration options
   */
  constructor(options: AIClientOptions) {
    this.options = options;
  }

  /**
   * Sends a message to the AI
   * Base implementation returns a placeholder response
   *
   * @param text - Message text
   * @param options - Message options
   * @returns Promise resolving to a placeholder response
   */
  public async message(
    _text: string,
    _options: AITextCompletionOptions = { role: 'user' },
  ) {
    return 'not a real ai message, this is the base class!';
  }

  /**
   * Factory method to create appropriate AI client based on options
   *
   * @param options - Client configuration options
   * @returns Promise resolving to an initialized AI client
   * @throws Error if client type is invalid
   */
  public static async create(
    options: AIClientOptions | AIClient,
  ): Promise<AIClient | OpenAIClient> {
    // If an AI client instance is passed, return it directly
    if (isAIClientInstance(options)) {
      return options;
    }

    // Cast to options since we know it's not an instance
    const clientOptions = options as AIClientOptions;

    if (isOpenAIClientOptions(clientOptions)) {
      return OpenAIClient.create(clientOptions);
    }

    // Delegate to modern factory for non-OpenAI providers
    const providedType = (clientOptions as any).type;
    if (providedType && providedType !== 'openai') {
      const { getAI } = await import('./factory.js');
      return (await getAI(clientOptions as any)) as any;
    }

    // Provide specific error messages for common issues
    if (providedType === 'openai') {
      throw new ValidationError(
        'OpenAI API key is required but missing or empty',
        {
          supportedTypes: [
            'openai',
            'anthropic',
            'gemini',
            'bedrock',
            'huggingface',
          ],
          providedType,
          hint: 'Set OPENAI_API_KEY environment variable or pass apiKey in options',
        },
      );
    }

    throw new ValidationError('Invalid client type specified', {
      supportedTypes: [
        'openai',
        'anthropic',
        'gemini',
        'bedrock',
        'huggingface',
      ],
      providedType,
    });
  }

  /**
   * Gets a text completion from the AI
   * In base class, delegates to message method
   *
   * @param text - Input text for completion
   * @param options - Completion options
   * @returns Promise resolving to the completion result
   */
  public textCompletion(
    text: string,
    options: AITextCompletionOptions = {
      role: 'user',
    },
  ) {
    return this.message(text, options);
  }
}

/**
 * Creates an OpenAI client instance
 *
 * @param options - OpenAI configuration options
 * @returns Promise resolving to an OpenAI client
 */
export async function getOpenAI(options: {
  apiKey?: string;
  baseUrl?: string;
}) {
  return new OpenAI({
    apiKey: options.apiKey,
    baseURL: options.baseUrl,
  });
}

/**
 * Options specific to OpenAI text completion requests
 */
export interface OpenAITextCompletionOptions {
  /**
   * Model identifier to use
   */
  model?: string;

  /**
   * Timeout in milliseconds
   */
  timeout?: number;

  /**
   * Role of the message sender
   */
  role?: OpenAI.Chat.ChatCompletionRole;

  /**
   * Previous messages in the conversation
   */
  history?: Array<OpenAI.Chat.ChatCompletionMessageParam>;

  /**
   * Name of the message sender
   */
  name?: string;

  /**
   * Penalty for token frequency
   */
  frequencyPenalty?: number;

  /**
   * Token bias adjustments
   */
  logitBias?: Record<string, number>;

  /**
   * Whether to return log probabilities
   */
  logprobs?: boolean;

  /**
   * Number of top log probabilities to return
   */
  topLogprobs?: number;

  /**
   * Maximum tokens to generate
   */
  maxTokens?: number;

  /**
   * Number of completions to generate
   */
  n?: number;

  /**
   * Penalty for token presence
   */
  presencePenalty?: number;

  /**
   * Format for the response
   */
  responseFormat?: { type: 'text' | 'json_object' };

  /**
   * Random seed for deterministic results
   */
  seed?: number;

  /**
   * Sequences that stop generation
   */
  stop?: string | Array<string>;

  /**
   * Whether to stream responses
   */
  stream?: boolean;

  /**
   * Sampling temperature
   */
  temperature?: number;

  /**
   * Top-p sampling parameter
   */
  topProbability?: number;

  /**
   * Available tools for the model
   */
  tools?: Array<OpenAI.Chat.ChatCompletionTool>;

  /**
   * Tool selection behavior
   */
  toolChoice?:
    | 'none'
    | 'auto'
    | { type: 'function'; function: { name: string } };

  /**
   * User identifier
   */
  user?: string;

  /**
   * Callback for handling streaming responses
   */
  onProgress?: (partialMessage: string) => void;
}

/**
 * Configuration options specific to OpenAI client
 */
export interface OpenAIClientOptions extends AIClientOptions {
  /**
   * OpenAI API key
   */
  apiKey?: string;

  /**
   * OpenAI API base URL
   */
  baseUrl?: string;
}

/**
 * Client implementation for the OpenAI API
 */
export class OpenAIClient extends AIClient {
  /**
   * OpenAI client instance
   */
  protected openai!: OpenAI;

  /**
   * Configuration options for this client
   */
  public options: OpenAIClientOptions;

  /**
   * Creates a new OpenAIClient
   *
   * @param options - OpenAI client configuration options
   */
  constructor(options: OpenAIClientOptions) {
    super(options);
    this.options = options;
  }

  /**
   * Sends a message to OpenAI
   *
   * @param text - Message text
   * @param options - Message options
   * @returns Promise resolving to the OpenAI response
   */
  public async message(
    text: string,
    options: AIMessageOptions = { role: 'user' },
  ) {
    const response = await this.textCompletion(text, options);
    return response;
  }

  /**
   * Factory method to create and initialize an OpenAIClient
   *
   * @param options - OpenAI client configuration options
   * @returns Promise resolving to an initialized OpenAIClient
   */
  public static async create(
    options: OpenAIClientOptions,
  ): Promise<OpenAIClient> {
    const client = new OpenAIClient(options);
    await client.initialize();
    return client;
  }

  /**
   * Initializes the OpenAI client
   */
  protected async initialize() {
    this.openai = new OpenAI({
      apiKey: this.options.apiKey,
      baseURL: this.options.baseUrl,
    });
  }

  /**
   * Sends a text completion request to the OpenAI API
   *
   * @param message - The message to send
   * @param options - Configuration options for the completion request
   * @returns Promise resolving to the completion text
   * @throws Error if the OpenAI API response is invalid
   */
  public async textCompletion(
    message: string,
    options: OpenAITextCompletionOptions = {},
  ): Promise<string> {
    const {
      model = 'gpt-4o',
      role = 'user',
      history = [],
      name: _name,
      frequencyPenalty: frequency_penalty = 0,
      logitBias: logit_bias,
      logprobs = false,
      topLogprobs: top_logprobs,
      maxTokens: max_tokens,
      n = 1,
      presencePenalty: presence_penalty = 0,
      responseFormat: response_format,
      seed,
      stop,
      stream: _stream = false,
      temperature = 1,
      topProbability: top_p = 1,
      tools,
      toolChoice: tool_choice,
      user,
      onProgress,
    } = options;

    const messages = [
      ...history,
      {
        role: role as OpenAI.Chat.ChatCompletionRole,
        content: message,
      } as OpenAI.Chat.ChatCompletionSystemMessageParam,
    ];

    if (onProgress) {
      const stream = await this.openai.chat.completions.create({
        model,
        messages,
        stream: true,
        frequency_penalty,
        logit_bias,
        logprobs,
        top_logprobs,
        max_tokens,
        n,
        presence_penalty,
        response_format,
        seed,
        stop,
        temperature,
        top_p,
        tools,
        tool_choice,
        user,
      });

      let fullContent = '';
      for await (const chunk of stream) {
        const content = chunk.choices[0]?.delta?.content || '';
        fullContent += content;
        onProgress(content);
      }

      return fullContent;
    }
    const response = await this.openai.chat.completions.create({
      model,
      messages,
      frequency_penalty,
      logit_bias,
      logprobs,
      top_logprobs,
      max_tokens,
      n,
      presence_penalty,
      response_format,
      seed,
      stop,
      stream: false,
      temperature,
      top_p,
      tools,
      tool_choice,
      user,
    });

    const choice = response.choices[0];
    if (!choice || !choice.message || !choice.message.content) {
      throw new ApiError('Invalid response from OpenAI API: Missing content', {
        model,
        responseId: response.id,
        choices: response.choices?.length || 0,
        hasChoice: !!choice,
        hasMessage: !!choice?.message,
        hasContent: !!choice?.message?.content,
      });
    }
    return choice.message.content;
  }
}

/**
 * Options for getting an AI client with type information
 */
type GetAIClientOptions = AIClientOptions & {
  type?: 'openai' | 'anthropic' | 'gemini' | 'bedrock' | 'huggingface';
};

/**
 * Factory function to create and initialize an appropriate AI client
 * Delegates to the modern getAI() factory for all provider types
 *
 * @param options - Client configuration options
 * @returns Promise resolving to an initialized AI client
 * @throws Error if client type is invalid
 */
export async function getAIClient(
  options: GetAIClientOptions,
): Promise<AIClient> {
  // Delegate to modern factory for all providers
  const { getAI } = await import('./factory.js');
  return (await getAI(options as any)) as any;
}
