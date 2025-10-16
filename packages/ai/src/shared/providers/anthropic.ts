/**
 * Anthropic Claude provider implementation
 *
 * Provides a standardized interface for interacting with Anthropic's Claude models,
 * including chat completions, streaming responses, and vision capabilities.
 * Note: Claude models do not support embeddings - use OpenAI or another provider for that.
 */

import type {
  AICapabilities,
  AIInterface,
  AIMessage,
  AIModel,
  AIResponse,
  AnthropicOptions,
  ChatOptions,
  CompletionOptions,
  EmbeddingOptions,
  EmbeddingResponse,
} from '../types';
import {
  AIError,
  AuthenticationError,
  ContextLengthError,
  ModelNotFoundError,
  RateLimitError,
} from '../types';

// Note: This implementation will require @anthropic-ai/sdk package
// For now, this is a placeholder that defines the interface

/**
 * Anthropic Claude provider implementation that handles all interactions with Anthropic's API.
 * Supports Claude models, streaming, vision capabilities, and function calling.
 * Does not support embeddings (use OpenAI or another provider for embeddings).
 */
export class AnthropicProvider implements AIInterface {
  private options: AnthropicOptions;
  private client: any; // Will be Anthropic instance from @anthropic-ai/sdk

  /**
   * Creates a new Anthropic provider instance
   * @param options - Configuration options for the Anthropic provider
   */
  constructor(options: AnthropicOptions) {
    this.options = {
      defaultModel: 'claude-3-5-sonnet-20241022',
      anthropicVersion: '2023-06-01',
      ...options,
    };

    // Initialize Anthropic client
    this.initializeClientSync();
  }

  private initializeClientSync() {
    try {
      // Dynamic import in constructor - this will work if the package is installed
      import('@anthropic-ai/sdk')
        .then(({ Anthropic }) => {
          this.client = new Anthropic({
            apiKey: this.options.apiKey,
            baseURL: this.options.baseUrl,
            timeout: this.options.timeout,
            maxRetries: this.options.maxRetries,
            defaultHeaders: {
              'anthropic-version': this.options.anthropicVersion,
              ...this.options.headers,
            },
          });
        })
        .catch(() => {
          // Client will be null and we'll handle it in methods
        });
    } catch (_error) {
      // Client will be null and we'll handle it in methods
    }
  }

  /**
   * Ensures the Anthropic client is initialized by dynamically importing the SDK
   * @throws {AIError} When the Anthropic SDK cannot be loaded
   * @private
   */
  private async ensureClient() {
    if (!this.client) {
      try {
        const { Anthropic } = await import('@anthropic-ai/sdk');
        this.client = new Anthropic({
          apiKey: this.options.apiKey,
          baseURL: this.options.baseUrl,
          timeout: this.options.timeout,
          maxRetries: this.options.maxRetries,
          defaultHeaders: {
            'anthropic-version': this.options.anthropicVersion,
            ...this.options.headers,
          },
        });
      } catch (_error) {
        throw new AIError(
          'Failed to initialize Anthropic client. Make sure @anthropic-ai/sdk is installed.',
          'INITIALIZATION_ERROR',
          'anthropic',
        );
      }
    }
  }

  /**
   * Generate a chat completion using Claude models
   * @param messages - Array of conversation messages
   * @param options - Optional configuration for the chat completion
   * @returns Promise resolving to the AI response with content and metadata
   * @throws {AIError} When the API request fails or SDK is not available
   *
   * @example
   * ```typescript
   * const response = await provider.chat([
   *   { role: 'system', content: 'You are a helpful assistant.' },
   *   { role: 'user', content: 'Explain quantum computing' }
   * ], {
   *   model: 'claude-3-5-sonnet-20241022',
   *   maxTokens: 1000
   * });
   * ```
   */
  async chat(
    messages: AIMessage[],
    options: ChatOptions = {},
  ): Promise<AIResponse> {
    try {
      await this.ensureClient();

      const { system, anthropicMessages } =
        this.mapMessagesToAnthropic(messages);

      // Build request parameters
      const requestParams: Record<string, any> = {
        model: options.model || this.options.defaultModel,
        messages: anthropicMessages,
        max_tokens: options.maxTokens || 4096,
        temperature: options.temperature,
        top_p: options.topP,
        stop_sequences: Array.isArray(options.stop)
          ? options.stop
          : options.stop
            ? [options.stop]
            : undefined,
        system: system || undefined,
        tools:
          options.tools && options.tools.length > 0
            ? options.tools.map((tool) => ({
                name: tool.function.name,
                description: tool.function.description || '',
                input_schema: tool.function.parameters || { type: 'object' },
              }))
            : undefined,
        tool_choice: this.mapToolChoice(options.toolChoice),
        stream: false,
      };

      // Add response format if specified
      // NOTE: Anthropic doesn't have native JSON mode like OpenAI. This is a prompt-based
      // approach that instructs the model to output JSON, but doesn't guarantee valid JSON.
      // For critical use cases, validate and parse the response with error handling.
      if (options.responseFormat?.type === 'json_object') {
        const jsonInstruction =
          '\n\nIMPORTANT: You must respond with valid JSON only. Do not include any explanatory text outside the JSON object.';
        requestParams.system = requestParams.system
          ? requestParams.system + jsonInstruction
          : jsonInstruction.trim();
      }

      const response = await this.client.messages.create(requestParams);

      // Extract text content and tool calls from response
      const textContent = response.content
        .filter((block: any) => block.type === 'text')
        .map((block: any) => block.text)
        .join('');

      const toolCalls = response.content
        .filter((block: any) => block.type === 'tool_use')
        .map((block: any) => ({
          id: block.id,
          type: 'function' as const,
          function: {
            name: block.name,
            arguments: JSON.stringify(block.input),
          },
        }));

      return {
        content: textContent,
        model: response.model,
        finishReason: this.mapFinishReason(response.stop_reason),
        usage: {
          promptTokens: response.usage.input_tokens,
          completionTokens: response.usage.output_tokens,
          totalTokens:
            response.usage.input_tokens + response.usage.output_tokens,
        },
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      };
    } catch (error) {
      throw this.mapError(error);
    }
  }

  async complete(
    prompt: string,
    options: CompletionOptions = {},
  ): Promise<AIResponse> {
    return this.chat([{ role: 'user', content: prompt }], {
      model: options.model,
      maxTokens: options.maxTokens,
      temperature: options.temperature,
      topP: options.topP,
      n: options.n,
      stop: options.stop,
      stream: options.stream,
      onProgress: options.onProgress,
    });
  }

  async embed(
    _text: string | string[],
    _options: EmbeddingOptions = {},
  ): Promise<EmbeddingResponse> {
    // Anthropic Claude doesn't provide embeddings API
    throw new AIError(
      'Anthropic Claude does not support embeddings. Use OpenAI or another provider for embeddings.',
      'NOT_SUPPORTED',
      'anthropic',
    );
  }

  async *stream(
    messages: AIMessage[],
    options: ChatOptions = {},
  ): AsyncIterable<string> {
    try {
      await this.ensureClient();

      const { system, anthropicMessages } =
        this.mapMessagesToAnthropic(messages);

      const stream = await this.client.messages.create({
        model: options.model || this.options.defaultModel,
        messages: anthropicMessages,
        max_tokens: options.maxTokens || 4096,
        temperature: options.temperature,
        top_p: options.topP,
        stop_sequences: Array.isArray(options.stop)
          ? options.stop
          : options.stop
            ? [options.stop]
            : undefined,
        system: system || undefined,
        stream: true,
      });

      for await (const chunk of stream) {
        if (
          chunk.type === 'content_block_delta' &&
          chunk.delta.type === 'text_delta'
        ) {
          if (options.onProgress) {
            options.onProgress(chunk.delta.text);
          }
          yield chunk.delta.text;
        }
      }
    } catch (error) {
      throw this.mapError(error);
    }
  }

  async countTokens(text: string): Promise<number> {
    // Anthropic doesn't provide a direct token counting API
    // This is an approximation - Claude uses a different tokenizer than OpenAI
    return Math.ceil(text.length / 3.5); // Slightly different ratio for Claude
  }

  async getModels(): Promise<AIModel[]> {
    // Return static list of known Claude models
    return [
      {
        id: 'claude-3-5-sonnet-20241022',
        name: 'Claude 3.5 Sonnet',
        description: 'Most intelligent Claude model with balanced performance',
        contextLength: 200000,
        capabilities: ['text', 'chat', 'vision', 'functions'],
        supportsFunctions: true,
        supportsVision: true,
      },
      {
        id: 'claude-3-5-haiku-20241022',
        name: 'Claude 3.5 Haiku',
        description: 'Fastest Claude model for simple tasks',
        contextLength: 200000,
        capabilities: ['text', 'chat', 'vision'],
        supportsFunctions: true,
        supportsVision: true,
      },
      {
        id: 'claude-3-opus-20240229',
        name: 'Claude 3 Opus',
        description: 'Most powerful Claude model for complex tasks',
        contextLength: 200000,
        capabilities: ['text', 'chat', 'vision', 'functions'],
        supportsFunctions: true,
        supportsVision: true,
      },
      {
        id: 'claude-3-sonnet-20240229',
        name: 'Claude 3 Sonnet',
        description: 'Balanced Claude model for most tasks',
        contextLength: 200000,
        capabilities: ['text', 'chat', 'vision'],
        supportsFunctions: true,
        supportsVision: true,
      },
      {
        id: 'claude-3-haiku-20240307',
        name: 'Claude 3 Haiku',
        description: 'Fast Claude model for simple tasks',
        contextLength: 200000,
        capabilities: ['text', 'chat', 'vision'],
        supportsFunctions: false,
        supportsVision: true,
      },
    ];
  }

  async getCapabilities(): Promise<AICapabilities> {
    return {
      chat: true,
      completion: true,
      embeddings: false, // Claude doesn't support embeddings
      streaming: true,
      functions: true,
      vision: true,
      fineTuning: false,
      maxContextLength: 200000,
      supportedOperations: [
        'chat',
        'completion',
        'streaming',
        'functions',
        'vision',
      ],
    };
  }

  private mapMessagesToAnthropic(messages: AIMessage[]): {
    system?: string;
    anthropicMessages: Array<{ role: 'user' | 'assistant'; content: string }>;
  } {
    // Anthropic handles system messages separately
    let system: string | undefined;
    const anthropicMessages: Array<{
      role: 'user' | 'assistant';
      content: string;
    }> = [];

    for (const message of messages) {
      if (message.role === 'system') {
        // Combine multiple system messages
        system = system ? `${system}\n\n${message.content}` : message.content;
      } else {
        anthropicMessages.push({
          role: message.role === 'assistant' ? 'assistant' : 'user',
          content: message.content,
        });
      }
    }

    return { system, anthropicMessages };
  }

  private mapToolChoice(
    toolChoice?: 'auto' | 'none' | { type: 'function'; function: { name: string } },
  ): any {
    if (!toolChoice || toolChoice === 'auto') {
      return { type: 'auto' };
    }

    if (toolChoice === 'none') {
      return undefined; // Anthropic doesn't have explicit 'none', just omit tools
    }

    if (typeof toolChoice === 'object' && toolChoice.type === 'function') {
      return {
        type: 'tool',
        name: toolChoice.function.name,
      };
    }

    return { type: 'auto' };
  }

  private mapFinishReason(reason: string | null): AIResponse['finishReason'] {
    switch (reason) {
      case 'end_turn':
        return 'stop';
      case 'max_tokens':
        return 'length';
      case 'stop_sequence':
        return 'stop';
      case 'tool_use':
        return 'tool_calls';
      default:
        return 'stop';
    }
  }

  private mapError(error: unknown): AIError {
    if (error instanceof AIError) {
      return error;
    }

    // Map common HTTP status codes from Anthropic API
    if (typeof error === 'object' && error !== null && 'status' in error) {
      const apiError = error as { status: number; message?: string };
      switch (apiError.status) {
        case 401:
          return new AuthenticationError('anthropic');
        case 429:
          return new RateLimitError('anthropic');
        case 404:
          return new ModelNotFoundError(
            apiError.message || 'Model not found',
            'anthropic',
          );
        case 413:
          return new ContextLengthError('anthropic');
      }
    }

    const errorMessage =
      error instanceof Error
        ? error.message
        : 'Unknown Anthropic error occurred';
    return new AIError(errorMessage, 'UNKNOWN_ERROR', 'anthropic');
  }
}
