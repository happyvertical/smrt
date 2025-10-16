/**
 * Hugging Face provider implementation
 */

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
  HuggingFaceOptions,
} from '../types';
import {
  AIError,
  AuthenticationError,
  ContextLengthError,
  ModelNotFoundError,
  RateLimitError,
} from '../types';

export class HuggingFaceProvider implements AIInterface {
  private options: HuggingFaceOptions;
  private baseUrl: string;

  constructor(options: HuggingFaceOptions) {
    this.options = {
      defaultModel: 'microsoft/DialoGPT-medium',
      useCache: true,
      waitForModel: true,
      ...options,
    };

    this.baseUrl =
      this.options.endpoint || 'https://api-inference.huggingface.co';
  }

  async chat(
    messages: AIMessage[],
    options: ChatOptions = {},
  ): Promise<AIResponse> {
    try {
      // Convert messages to a single prompt for text generation models
      const prompt = this.messagesToPrompt(messages);

      const response = await this.makeRequest(
        `/models/${options.model || this.options.model || this.options.defaultModel}`,
        {
          inputs: prompt,
          parameters: {
            max_new_tokens: options.maxTokens || 512,
            temperature: options.temperature || 1.0,
            top_p: options.topP || 1.0,
            do_sample:
              (options.temperature && options.temperature > 0) || false,
            stop_sequences: Array.isArray(options.stop)
              ? options.stop
              : options.stop
                ? [options.stop]
                : undefined,
          },
          options: {
            use_cache: this.options.useCache,
            wait_for_model: this.options.waitForModel,
          },
        },
      );

      if (Array.isArray(response) && response[0]?.generated_text) {
        const generatedText = response[0].generated_text;
        // Remove the input prompt from the response
        const content = generatedText.replace(prompt, '').trim();

        return {
          content,
          model:
            options.model || this.options.model || this.options.defaultModel,
          finishReason: 'stop',
        };
      }

      throw new AIError(
        'Invalid response format from Hugging Face',
        'INVALID_RESPONSE',
        'huggingface',
      );
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
    text: string | string[],
    options: EmbeddingOptions = {},
  ): Promise<EmbeddingResponse> {
    try {
      const input = Array.isArray(text) ? text : [text];
      const model = options.model || 'sentence-transformers/all-MiniLM-L6-v2';

      const response = await this.makeRequest(`/models/${model}`, {
        inputs: input,
        options: {
          use_cache: this.options.useCache,
          wait_for_model: this.options.waitForModel,
        },
      });

      // Handle different response formats from different embedding models
      let embeddings: number[][];
      if (Array.isArray(response) && Array.isArray(response[0])) {
        // Direct array of embeddings
        embeddings = Array.isArray(text) ? response : [response[0]];
      } else if (
        response &&
        typeof response === 'object' &&
        response.embeddings
      ) {
        // Response with embeddings property
        embeddings = response.embeddings;
      } else {
        throw new AIError(
          'Invalid embedding response format',
          'INVALID_RESPONSE',
          'huggingface',
        );
      }

      return {
        embeddings,
        model,
      };
    } catch (error) {
      throw this.mapError(error);
    }
  }

  async *stream(
    messages: AIMessage[],
    options: ChatOptions = {},
  ): AsyncIterable<string> {
    // Hugging Face Inference API doesn't support streaming for most models
    // Fall back to regular completion and yield the result
    const response = await this.chat(messages, options);

    // Simulate streaming by yielding chunks
    const content = response.content;
    const chunkSize = 10;

    for (let i = 0; i < content.length; i += chunkSize) {
      const chunk = content.slice(i, i + chunkSize);
      if (options.onProgress) {
        options.onProgress(chunk);
      }
      yield chunk;

      // Add small delay to simulate streaming
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  async countTokens(text: string): Promise<number> {
    // Approximation - Hugging Face models use different tokenizers
    return Math.ceil(text.length / 4);
  }

  async getModels(): Promise<AIModel[]> {
    // Return some popular text generation models available on Hugging Face
    return [
      {
        id: 'microsoft/DialoGPT-medium',
        name: 'DialoGPT Medium',
        description: 'Conversational AI model by Microsoft',
        contextLength: 1024,
        capabilities: ['text', 'chat'],
        supportsFunctions: false,
        supportsVision: false,
      },
      {
        id: 'microsoft/DialoGPT-large',
        name: 'DialoGPT Large',
        description: 'Large conversational AI model by Microsoft',
        contextLength: 1024,
        capabilities: ['text', 'chat'],
        supportsFunctions: false,
        supportsVision: false,
      },
      {
        id: 'facebook/blenderbot-400M-distill',
        name: 'BlenderBot 400M',
        description: 'Conversational AI model by Meta',
        contextLength: 512,
        capabilities: ['text', 'chat'],
        supportsFunctions: false,
        supportsVision: false,
      },
      {
        id: 'gpt2',
        name: 'GPT-2',
        description: 'OpenAI GPT-2 model',
        contextLength: 1024,
        capabilities: ['text', 'completion'],
        supportsFunctions: false,
        supportsVision: false,
      },
      {
        id: 'sentence-transformers/all-MiniLM-L6-v2',
        name: 'All-MiniLM-L6-v2',
        description: 'Sentence embedding model',
        contextLength: 512,
        capabilities: ['embeddings'],
        supportsFunctions: false,
        supportsVision: false,
      },
    ];
  }

  async getCapabilities(): Promise<AICapabilities> {
    return {
      chat: true,
      completion: true,
      embeddings: true,
      streaming: false, // Limited streaming support
      functions: false, // Most HF models don't support function calling
      vision: false, // Limited vision model support
      fineTuning: true, // Via Hugging Face training API
      maxContextLength: 2048,
      supportedOperations: ['chat', 'completion', 'embedding'],
    };
  }

  private messagesToPrompt(messages: AIMessage[]): string {
    // Convert chat messages to a single prompt format
    return `${messages
      .map((message) => {
        switch (message.role) {
          case 'system':
            return `System: ${message.content}`;
          case 'user':
            return `Human: ${message.content}`;
          case 'assistant':
            return `Assistant: ${message.content}`;
          default:
            return message.content;
        }
      })
      .join('\n')}\nAssistant:`;
  }

  private async makeRequest(endpoint: string, data: any): Promise<any> {
    const url = `${this.baseUrl}${endpoint}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.options.apiToken}`,
        'Content-Type': 'application/json',
        ...this.options.headers,
      },
      body: JSON.stringify(data),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`HTTP ${response.status}: ${errorText}`);
    }

    return response.json();
  }

  private mapError(error: unknown): AIError {
    if (error instanceof AIError) {
      return error;
    }

    const message = error instanceof Error ? error.message : 'Unknown error';

    // Map common HTTP status codes
    if (message.includes('401') || message.includes('Unauthorized')) {
      return new AuthenticationError('huggingface');
    }

    if (message.includes('429') || message.includes('rate limit')) {
      return new RateLimitError('huggingface');
    }

    if (message.includes('404') || message.includes('not found')) {
      return new ModelNotFoundError(message, 'huggingface');
    }

    if (message.includes('413') || message.includes('too large')) {
      return new ContextLengthError('huggingface');
    }

    return new AIError(message, 'UNKNOWN_ERROR', 'huggingface');
  }
}
