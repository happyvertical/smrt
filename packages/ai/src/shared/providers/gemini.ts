/**
 * Google Gemini provider implementation
 */

import crypto from 'node:crypto';

import type {
  AICapabilities,
  AIInterface,
  AIMessage,
  AIModel,
  AIResponse,
  ChatOptions,
  CompletionOptions,
  EmbeddingOptions,
  EmbeddingResponse,
  GeminiOptions,
} from '../types';
import {
  AIError,
  AuthenticationError,
  ModelNotFoundError,
  RateLimitError,
} from '../types';

// Note: This implementation uses the new @google/genai package
// @google/generative-ai is deprecated - migrated to @google/genai

export class GeminiProvider implements AIInterface {
  private options: GeminiOptions;
  private client: any; // GoogleGenAI instance from @google/genai

  constructor(options: GeminiOptions) {
    this.options = {
      defaultModel: 'gemini-2.5-flash',
      ...options,
    };

    // Initialize Google Generative AI client
    this.initializeClientSync();
  }

  private initializeClientSync() {
    try {
      // Dynamic import in constructor - this will work if the package is installed
      import('@google/genai')
        .then(({ GoogleGenAI }) => {
          this.client = new GoogleGenAI({ apiKey: this.options.apiKey });
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
        const { GoogleGenAI } = await import('@google/genai');
        this.client = new GoogleGenAI({ apiKey: this.options.apiKey });
      } catch (_error) {
        throw new AIError(
          'Failed to initialize Gemini client. Make sure @google/genai is installed.',
          'INITIALIZATION_ERROR',
          'gemini',
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

      const model = options.model || this.options.defaultModel;
      const generationConfig: Record<string, any> = {
        maxOutputTokens: options.maxTokens,
        temperature: options.temperature,
        topP: options.topP,
        stopSequences: Array.isArray(options.stop)
          ? options.stop
          : options.stop
            ? [options.stop]
            : undefined,
        // Add response MIME type for JSON output
        responseMimeType:
          options.responseFormat?.type === 'json_object'
            ? 'application/json'
            : undefined,
      };

      // Build request config
      const requestConfig: Record<string, any> = {
        model,
        contents: this.messagesToGeminiFormat(messages),
        generationConfig,
      };

      // Add tools if provided
      if (options.tools && options.tools.length > 0) {
        requestConfig.tools = [
          {
            functionDeclarations: options.tools.map((tool) => ({
              name: tool.function.name,
              description: tool.function.description || '',
              parameters: tool.function.parameters || { type: 'object' },
            })),
          },
        ];

        // Map tool choice
        if (options.toolChoice) {
          requestConfig.toolConfig = this.mapToolChoice(options.toolChoice);
        }
      }

      // Call new SDK API: ai.models.generateContent()
      const result = await this.client.models.generateContent(requestConfig);

      // Extract tool calls from response
      // NOTE: Gemini 2.5 doesn't seem to reliably return functionCall objects
      // even when tools are provided. The model often describes tool calls in text
      // instead of using the structured function calling API.
      let toolCalls: AIResponse['toolCalls'];
      const firstCandidate = result.candidates?.[0];
      if (firstCandidate?.content?.parts) {
        const functionCalls = firstCandidate.content.parts.filter(
          (part: any) => part.functionCall,
        );
        if (functionCalls.length > 0) {
          toolCalls = functionCalls.map((part: any) => ({
            id: `call_${crypto.randomUUID()}`,
            type: 'function' as const,
            function: {
              name: part.functionCall.name,
              arguments: JSON.stringify(part.functionCall.args || {}),
            },
          }));
        }
      }

      // Clean content - remove markdown code blocks if JSON mode was requested
      let content = result.text || '';
      if (options.responseFormat?.type === 'json_object') {
        content = this.stripMarkdownCodeBlock(content);
      }

      return {
        content,
        model,
        finishReason: this.mapFinishReason(result),
        usage: {
          promptTokens: result.usageMetadata?.promptTokenCount || 0,
          completionTokens: result.usageMetadata?.candidatesTokenCount || 0,
          totalTokens: result.usageMetadata?.totalTokenCount || 0,
        },
        toolCalls: toolCalls && toolCalls.length > 0 ? toolCalls : undefined,
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
    try {
      // TODO: Implement Gemini embeddings
      // Note: Gemini may not support embeddings directly
      throw new AIError(
        'Gemini embeddings not implemented',
        'NOT_IMPLEMENTED',
        'gemini',
      );
    } catch (error) {
      throw this.mapError(error);
    }
  }

  async *stream(
    _messages: AIMessage[],
    _options: ChatOptions = {},
  ): AsyncIterable<string> {
    // TODO: Implement Gemini streaming
    // For now, yield an empty stream and then throw
    yield* [];
    throw new AIError(
      'Gemini streaming not implemented',
      'NOT_IMPLEMENTED',
      'gemini',
    );
  }

  async countTokens(text: string): Promise<number> {
    try {
      // TODO: Implement Gemini token counting
      // const model = this.client.getGenerativeModel({ model: 'gemini-1.5-pro' });
      // const { totalTokens } = await model.countTokens(text);
      // return totalTokens;

      // Approximation for now
      return Math.ceil(text.length / 4);
    } catch (error) {
      throw this.mapError(error);
    }
  }

  async getModels(): Promise<AIModel[]> {
    // Return static list of known Gemini models
    return [
      {
        id: 'gemini-2.0-flash-001',
        name: 'Gemini 2.0 Flash',
        description: 'Latest fast and efficient Gemini model with function calling',
        contextLength: 1000000,
        capabilities: ['text', 'chat', 'vision', 'functions'],
        supportsFunctions: true,
        supportsVision: true,
      },
      {
        id: 'gemini-2.5-flash',
        name: 'Gemini 2.5 Flash',
        description: 'Experimental next-generation Gemini model',
        contextLength: 1000000,
        capabilities: ['text', 'chat', 'vision', 'functions'],
        supportsFunctions: true,
        supportsVision: true,
      },
      {
        id: 'gemini-1.5-pro',
        name: 'Gemini 1.5 Pro (Legacy)',
        description: 'Previous generation model (may not be available)',
        contextLength: 2000000,
        capabilities: ['text', 'chat', 'vision', 'functions'],
        supportsFunctions: true,
        supportsVision: true,
      },
    ];
  }

  async getCapabilities(): Promise<AICapabilities> {
    return {
      chat: true,
      completion: true,
      embeddings: false, // Gemini may not support embeddings directly
      streaming: true,
      functions: true,
      vision: true,
      fineTuning: false,
      maxContextLength: 2000000,
      supportedOperations: [
        'chat',
        'completion',
        'streaming',
        'functions',
        'vision',
      ],
    };
  }

  private mapToolChoice(
    toolChoice?: 'auto' | 'none' | { type: 'function'; function: { name: string } },
  ): any {
    if (!toolChoice || toolChoice === 'auto') {
      return { functionCallingConfig: { mode: 'AUTO' } };
    }

    if (toolChoice === 'none') {
      return { functionCallingConfig: { mode: 'NONE' } };
    }

    if (typeof toolChoice === 'object' && toolChoice.type === 'function') {
      return {
        functionCallingConfig: {
          mode: 'ANY',
          allowedFunctionNames: [toolChoice.function.name],
        },
      };
    }

    return { functionCallingConfig: { mode: 'AUTO' } };
  }

  private mapFinishReason(response: any): AIResponse['finishReason'] {
    // Check if response has function calls in any candidate
    const firstCandidate = response.candidates?.[0];
    if (firstCandidate?.content?.parts) {
      const hasFunctionCall = firstCandidate.content.parts.some(
        (part: any) => part.functionCall,
      );
      if (hasFunctionCall) {
        return 'tool_calls';
      }
    }

    // Gemini doesn't provide detailed finish reasons, default to 'stop'
    return 'stop';
  }

  private messagesToGeminiFormat(messages: AIMessage[]): string {
    // Convert messages to a simple text prompt
    // The new SDK expects a string for the contents field
    return messages
      .map((message) => {
        switch (message.role) {
          case 'system':
            return `Instructions: ${message.content}`;
          case 'user':
            return `Human: ${message.content}`;
          case 'assistant':
            return `Assistant: ${message.content}`;
          default:
            return message.content;
        }
      })
      .join('\n\n');
  }

  private stripMarkdownCodeBlock(text: string): string {
    // Remove markdown code blocks like ```json\n...\n```
    const codeBlockRegex = /^```(?:json|javascript|typescript)?\s*\n?([\s\S]*?)\n?```\s*$/;
    const match = text.match(codeBlockRegex);
    return match ? match[1].trim() : text.trim();
  }

  private mapError(error: unknown): AIError {
    if (error instanceof AIError) {
      return error;
    }

    // Map common Gemini error patterns
    const message =
      error instanceof Error ? error.message : 'Unknown Gemini error occurred';

    if (message.includes('API_KEY_INVALID') || message.includes('401')) {
      return new AuthenticationError('gemini');
    }

    if (message.includes('QUOTA_EXCEEDED') || message.includes('429')) {
      return new RateLimitError('gemini');
    }

    if (message.includes('MODEL_NOT_FOUND') || message.includes('404')) {
      return new ModelNotFoundError(message, 'gemini');
    }

    return new AIError(message, 'UNKNOWN_ERROR', 'gemini');
  }
}
