/**
 * AWS Bedrock provider implementation
 */

import type {
  AICapabilities,
  AIInterface,
  AIMessage,
  AIModel,
  AIResponse,
  BedrockOptions,
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

// Note: This implementation will require @aws-sdk/client-bedrock-runtime package
// For now, this is a placeholder that defines the interface

export class BedrockProvider implements AIInterface {
  private options: BedrockOptions;
  private client: any; // Will be BedrockRuntimeClient instance from @aws-sdk/client-bedrock-runtime

  constructor(options: BedrockOptions) {
    this.options = {
      defaultModel: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
      ...options,
    };

    // Initialize AWS Bedrock client
    this.initializeClientSync();
  }

  private initializeClientSync() {
    try {
      // Dynamic import in constructor - this will work if the package is installed
      import('@aws-sdk/client-bedrock-runtime')
        .then(({ BedrockRuntimeClient }) => {
          this.client = new BedrockRuntimeClient({
            region: this.options.region,
            credentials: this.options.credentials,
            endpoint: this.options.endpoint,
          });
        })
        .catch(() => {
          // Client will be null and we'll handle it in methods
        });
    } catch (_error) {
      // Client will be null and we'll handle it in methods
    }
  }

  private async ensureClient() {
    if (!this.client) {
      try {
        const { BedrockRuntimeClient } = await import(
          '@aws-sdk/client-bedrock-runtime'
        );
        this.client = new BedrockRuntimeClient({
          region: this.options.region,
          credentials: this.options.credentials,
          endpoint: this.options.endpoint,
        });
      } catch (_error) {
        throw new AIError(
          'Failed to initialize Bedrock client. Make sure @aws-sdk/client-bedrock-runtime is installed.',
          'INITIALIZATION_ERROR',
          'bedrock',
        );
      }
    }
  }

  async chat(
    messages: AIMessage[],
    options: ChatOptions = {},
  ): Promise<AIResponse> {
    try {
      await this.ensureClient();

      const modelId = options.model || this.options.defaultModel;

      if (modelId?.includes('anthropic.claude')) {
        return this.chatWithClaude(messages, options);
      }
      if (modelId?.includes('amazon.titan')) {
        return this.chatWithTitan(messages, options);
      }
      if (modelId?.includes('cohere.command')) {
        return this.chatWithCohere(messages, options);
      }
      if (modelId?.includes('meta.llama')) {
        return this.chatWithLlama(messages, options);
      }

      // Default to Claude format for unknown models
      return this.chatWithClaude(messages, options);
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
    try {
      // TODO: Implement Bedrock embeddings with Titan Embeddings
      // const modelId = options.model || 'amazon.titan-embed-text-v1';

      throw new AIError(
        'Bedrock embeddings not implemented',
        'NOT_IMPLEMENTED',
        'bedrock',
      );
    } catch (error) {
      throw this.mapError(error);
    }
  }

  async *stream(
    _messages: AIMessage[],
    _options: ChatOptions = {},
  ): AsyncIterable<string> {
    // TODO: Implement Bedrock streaming
    // For now, yield an empty stream and then throw
    yield* [];
    throw new AIError(
      'Bedrock streaming not implemented',
      'NOT_IMPLEMENTED',
      'bedrock',
    );
  }

  async countTokens(text: string): Promise<number> {
    // AWS Bedrock doesn't provide a direct token counting API
    // Approximation varies by model provider
    return Math.ceil(text.length / 4);
  }

  async getModels(): Promise<AIModel[]> {
    // Return static list of popular Bedrock models
    return [
      // Anthropic Claude models
      {
        id: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
        name: 'Claude 3.5 Sonnet v2',
        description: 'Latest Claude 3.5 Sonnet model on Bedrock',
        contextLength: 200000,
        capabilities: ['text', 'chat', 'vision', 'functions'],
        supportsFunctions: true,
        supportsVision: true,
      },
      {
        id: 'anthropic.claude-3-opus-20240229-v1:0',
        name: 'Claude 3 Opus',
        description: 'Most powerful Claude model on Bedrock',
        contextLength: 200000,
        capabilities: ['text', 'chat', 'vision'],
        supportsFunctions: false,
        supportsVision: true,
      },
      // Amazon Titan models
      {
        id: 'amazon.titan-text-premier-v1:0',
        name: 'Titan Text Premier',
        description: 'Premier Amazon Titan text model',
        contextLength: 32000,
        capabilities: ['text', 'chat'],
        supportsFunctions: false,
        supportsVision: false,
      },
      {
        id: 'amazon.titan-embed-text-v1',
        name: 'Titan Embeddings Text',
        description: 'Amazon Titan text embeddings model',
        contextLength: 8192,
        capabilities: ['embeddings'],
        supportsFunctions: false,
        supportsVision: false,
      },
      // Cohere models
      {
        id: 'cohere.command-r-plus-v1:0',
        name: 'Command R+',
        description: 'Cohere Command R+ model with advanced capabilities',
        contextLength: 128000,
        capabilities: ['text', 'chat', 'functions'],
        supportsFunctions: true,
        supportsVision: false,
      },
      // Meta Llama models
      {
        id: 'meta.llama3-1-405b-instruct-v1:0',
        name: 'Llama 3.1 405B Instruct',
        description: 'Meta Llama 3.1 405B instruction-tuned model',
        contextLength: 128000,
        capabilities: ['text', 'chat'],
        supportsFunctions: false,
        supportsVision: false,
      },
    ];
  }

  async getCapabilities(): Promise<AICapabilities> {
    return {
      chat: true,
      completion: true,
      embeddings: true, // Via Titan Embeddings
      streaming: true,
      functions: true, // Some models support function calling
      vision: true, // Some models support vision
      fineTuning: true, // Via Bedrock fine-tuning
      maxContextLength: 200000,
      supportedOperations: [
        'chat',
        'completion',
        'embedding',
        'streaming',
        'functions',
        'vision',
      ],
    };
  }

  private async chatWithClaude(
    messages: AIMessage[],
    options: ChatOptions,
  ): Promise<AIResponse> {
    const { InvokeModelCommand } = await import(
      '@aws-sdk/client-bedrock-runtime'
    );

    // Convert messages to Claude format for Bedrock
    const { system, anthropicMessages } = this.mapMessagesToClaude(messages);

    const payload = {
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: options.maxTokens || 4096,
      messages: anthropicMessages,
      temperature: options.temperature,
      top_p: options.topP,
      stop_sequences: Array.isArray(options.stop)
        ? options.stop
        : options.stop
          ? [options.stop]
          : undefined,
      system: system || undefined,
    };

    const command = new InvokeModelCommand({
      modelId: options.model || this.options.defaultModel,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify(payload),
    });

    const response = await this.client.send(command);
    const responseBody = JSON.parse(new TextDecoder().decode(response.body));

    return {
      content: responseBody.content?.[0]?.text || '',
      model: options.model || this.options.defaultModel,
      finishReason: this.mapClaudeFinishReason(responseBody.stop_reason),
      usage: {
        promptTokens: responseBody.usage?.input_tokens || 0,
        completionTokens: responseBody.usage?.output_tokens || 0,
        totalTokens:
          (responseBody.usage?.input_tokens || 0) +
          (responseBody.usage?.output_tokens || 0),
      },
    };
  }

  private async chatWithTitan(
    _messages: AIMessage[],
    _options: ChatOptions,
  ): Promise<AIResponse> {
    // TODO: Implement Titan-specific format for Bedrock
    throw new AIError(
      'Titan on Bedrock not implemented',
      'NOT_IMPLEMENTED',
      'bedrock',
    );
  }

  private async chatWithCohere(
    _messages: AIMessage[],
    _options: ChatOptions,
  ): Promise<AIResponse> {
    // TODO: Implement Cohere-specific format for Bedrock
    throw new AIError(
      'Cohere on Bedrock not implemented',
      'NOT_IMPLEMENTED',
      'bedrock',
    );
  }

  private async chatWithLlama(
    _messages: AIMessage[],
    _options: ChatOptions,
  ): Promise<AIResponse> {
    // TODO: Implement Llama-specific format for Bedrock
    throw new AIError(
      'Llama on Bedrock not implemented',
      'NOT_IMPLEMENTED',
      'bedrock',
    );
  }

  private mapMessagesToClaude(messages: AIMessage[]): {
    system?: string;
    anthropicMessages: Array<{ role: 'user' | 'assistant'; content: string }>;
  } {
    // Same as Anthropic provider - separate system messages
    let system: string | undefined;
    const anthropicMessages: Array<{
      role: 'user' | 'assistant';
      content: string;
    }> = [];

    for (const message of messages) {
      if (message.role === 'system') {
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

  private mapClaudeFinishReason(
    reason: string | null,
  ): AIResponse['finishReason'] {
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

    // Map common AWS error codes
    if (typeof error === 'object' && error !== null) {
      const awsError = error as { name?: string; message?: string };

      if (awsError.name === 'AccessDeniedException') {
        return new AuthenticationError('bedrock');
      }

      if (awsError.name === 'ThrottlingException') {
        return new RateLimitError('bedrock');
      }

      if (awsError.name === 'ResourceNotFoundException') {
        return new ModelNotFoundError(
          awsError.message || 'Model not found',
          'bedrock',
        );
      }

      if (
        awsError.name === 'ValidationException' &&
        awsError.message?.includes('input is too long')
      ) {
        return new ContextLengthError('bedrock');
      }
    }

    const errorMessage =
      error instanceof Error ? error.message : 'Unknown Bedrock error occurred';
    return new AIError(errorMessage, 'UNKNOWN_ERROR', 'bedrock');
  }
}
