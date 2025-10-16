import OpenAI from "openai";
import { AIError, ContentFilterError, ContextLengthError, ModelNotFoundError, RateLimitError, AuthenticationError } from "../index.js";
class OpenAIProvider {
  client;
  options;
  /**
   * Creates a new OpenAI provider instance
   * @param options - Configuration options for the OpenAI provider
   */
  constructor(options) {
    this.options = {
      defaultModel: "gpt-4o",
      ...options
    };
    this.client = new OpenAI({
      apiKey: this.options.apiKey,
      baseURL: this.options.baseUrl,
      organization: this.options.organization,
      timeout: this.options.timeout,
      maxRetries: this.options.maxRetries,
      defaultHeaders: this.options.headers
    });
  }
  /**
   * Generate a chat completion using OpenAI's chat models
   * @param messages - Array of conversation messages
   * @param options - Optional configuration for the chat completion
   * @returns Promise resolving to the AI response with content and metadata
   * @throws {AIError} When the API request fails or returns invalid data
   *
   * @example
   * ```typescript
   * const response = await provider.chat([
   *   { role: 'system', content: 'You are a helpful assistant.' },
   *   { role: 'user', content: 'What is the capital of France?' }
   * ], {
   *   model: 'gpt-4o',
   *   temperature: 0.7,
   *   maxTokens: 150
   * });
   * console.log(response.content); // "Paris is the capital of France."
   * ```
   */
  async chat(messages, options = {}) {
    try {
      const response = await this.client.chat.completions.create({
        model: options.model || this.options.defaultModel || "gpt-4o",
        messages: this.mapMessagesToOpenAI(messages),
        max_tokens: options.maxTokens,
        temperature: options.temperature,
        top_p: options.topP,
        n: options.n,
        stop: options.stop,
        frequency_penalty: options.frequencyPenalty,
        presence_penalty: options.presencePenalty,
        user: options.user,
        tools: options.tools?.map((tool) => ({
          type: "function",
          function: {
            name: tool.function.name,
            description: tool.function.description,
            parameters: tool.function.parameters
          }
        })),
        tool_choice: this.mapToolChoice(options.toolChoice),
        response_format: options.responseFormat,
        seed: options.seed,
        stream: false
      });
      const choice = response.choices[0];
      if (!choice) {
        throw new AIError(
          "No choices returned from OpenAI",
          "NO_CHOICES",
          "openai"
        );
      }
      return {
        content: choice.message.content || "",
        usage: this.mapUsage(response.usage),
        model: response.model,
        finishReason: this.mapFinishReason(choice.finish_reason),
        toolCalls: choice.message.tool_calls?.filter((call) => call.type === "function").map((call) => ({
          id: call.id,
          type: "function",
          function: {
            name: call.function.name,
            arguments: call.function.arguments
          }
        }))
      };
    } catch (error) {
      throw this.mapError(error);
    }
  }
  /**
   * Generate a text completion for a given prompt
   * @param prompt - The text prompt to complete
   * @param options - Optional configuration for the completion
   * @returns Promise resolving to the AI response
   * @throws {AIError} When the API request fails
   *
   * @example
   * ```typescript
   * const response = await provider.complete('The weather today is', {
   *   model: 'gpt-4o',
   *   maxTokens: 50,
   *   temperature: 0.5
   * });
   * ```
   */
  async complete(prompt, options = {}) {
    return this.chat([{ role: "user", content: prompt }], {
      model: options.model,
      maxTokens: options.maxTokens,
      temperature: options.temperature,
      topP: options.topP,
      n: options.n,
      stop: options.stop,
      stream: options.stream,
      onProgress: options.onProgress
    });
  }
  /**
   * Generate embeddings for the given text(s)
   * @param text - Single text string or array of texts to embed
   * @param options - Optional configuration for embeddings
   * @returns Promise resolving to embeddings response with vector arrays
   * @throws {AIError} When the API request fails
   *
   * @example
   * ```typescript
   * // Single text embedding
   * const response1 = await provider.embed('Hello world');
   * console.log(response1.embeddings[0]); // Array of numbers
   *
   * // Multiple text embeddings
   * const response2 = await provider.embed(['Text 1', 'Text 2']);
   * console.log(response2.embeddings.length); // 2
   * ```
   */
  async embed(text, options = {}) {
    try {
      const input = Array.isArray(text) ? text : [text];
      const response = await this.client.embeddings.create({
        model: options.model || "text-embedding-3-small",
        input,
        encoding_format: options.encodingFormat,
        dimensions: options.dimensions,
        user: options.user
      });
      return {
        embeddings: response.data.map((item) => item.embedding),
        usage: this.mapUsage(response.usage),
        model: response.model
      };
    } catch (error) {
      throw this.mapError(error);
    }
  }
  /**
   * Stream a chat completion response in real-time
   * @param messages - Array of conversation messages
   * @param options - Optional configuration for the chat completion
   * @yields Individual content chunks as they arrive
   * @throws {AIError} When the streaming request fails
   *
   * @example
   * ```typescript
   * for await (const chunk of provider.stream([
   *   { role: 'user', content: 'Write a story about AI' }
   * ])) {
   *   process.stdout.write(chunk);
   * }
   * ```
   */
  async *stream(messages, options = {}) {
    try {
      const stream = await this.client.chat.completions.create({
        model: options.model || this.options.defaultModel || "gpt-4o",
        messages: this.mapMessagesToOpenAI(messages),
        max_tokens: options.maxTokens,
        temperature: options.temperature,
        top_p: options.topP,
        stop: options.stop,
        frequency_penalty: options.frequencyPenalty,
        presence_penalty: options.presencePenalty,
        user: options.user,
        stream: true
      });
      for await (const chunk of stream) {
        const content = chunk.choices[0]?.delta?.content;
        if (content) {
          if (options.onProgress) {
            options.onProgress(content);
          }
          yield content;
        }
      }
    } catch (error) {
      throw this.mapError(error);
    }
  }
  /**
   * Count the number of tokens in the given text
   * @param text - The text to count tokens for
   * @returns Promise resolving to the estimated token count
   *
   * @remarks
   * OpenAI doesn't provide a direct token counting API, so this is an approximation
   * based on the general rule of ~4 characters per token. For precise counting,
   * consider using a dedicated tokenizer library.
   *
   * @example
   * ```typescript
   * const count = await provider.countTokens('Hello, world!');
   * console.log(count); // Approximately 4 tokens
   * ```
   */
  async countTokens(text) {
    return Math.ceil(text.length / 4);
  }
  /**
   * Get a list of available OpenAI models
   * @returns Promise resolving to an array of model information
   * @throws {AIError} When the API request fails
   *
   * @example
   * ```typescript
   * const models = await provider.getModels();
   * const gptModels = models.filter(m => m.id.includes('gpt'));
   * ```
   */
  async getModels() {
    try {
      const response = await this.client.models.list();
      return response.data.filter(
        (model) => model.id.includes("gpt") || model.id.includes("text-embedding")
      ).map((model) => ({
        id: model.id,
        name: model.id,
        description: `OpenAI model: ${model.id}`,
        contextLength: this.getContextLength(model.id),
        capabilities: this.getModelCapabilities(model.id),
        supportsFunctions: model.id.includes("gpt-4") || model.id.includes("gpt-3.5"),
        supportsVision: model.id.includes("vision") || model.id === "gpt-4o"
      }));
    } catch (error) {
      throw this.mapError(error);
    }
  }
  /**
   * Get the capabilities supported by this OpenAI provider
   * @returns Promise resolving to provider capabilities
   *
   * @example
   * ```typescript
   * const caps = await provider.getCapabilities();
   * if (caps.functions) {
   *   // Provider supports function calling
   * }
   * ```
   */
  async getCapabilities() {
    return {
      chat: true,
      completion: true,
      embeddings: true,
      streaming: true,
      functions: true,
      vision: true,
      fineTuning: true,
      maxContextLength: 128e3,
      supportedOperations: [
        "chat",
        "completion",
        "embedding",
        "streaming",
        "functions",
        "vision"
      ]
    };
  }
  /**
   * Maps internal AI messages to OpenAI's message format
   * @param messages - Array of internal AI messages
   * @returns Array of OpenAI-compatible message parameters
   * @private
   */
  mapMessagesToOpenAI(messages) {
    return messages.map((message) => {
      const baseMessage = {
        role: message.role,
        content: message.content
      };
      if (message.name && (message.role === "system" || message.role === "user" || message.role === "function")) {
        baseMessage.name = message.name;
      }
      if (message.tool_calls && message.role === "assistant") {
        baseMessage.tool_calls = message.tool_calls;
      }
      return baseMessage;
    });
  }
  /**
   * Maps internal tool choice format to OpenAI's tool choice format
   * @param toolChoice - Internal tool choice specification
   * @returns OpenAI-compatible tool choice option or undefined
   * @private
   */
  mapToolChoice(toolChoice) {
    if (!toolChoice) return void 0;
    if (typeof toolChoice === "string") return toolChoice;
    return {
      type: "function",
      function: { name: toolChoice.function.name }
    };
  }
  /**
   * Maps OpenAI usage information to internal token usage format
   * @param usage - OpenAI usage object from API response
   * @returns Internal token usage object or undefined
   * @private
   */
  mapUsage(usage) {
    if (!usage) return void 0;
    return {
      promptTokens: usage.prompt_tokens || 0,
      completionTokens: usage.completion_tokens || 0,
      totalTokens: usage.total_tokens || 0
    };
  }
  /**
   * Maps OpenAI finish reason to internal finish reason format
   * @param reason - OpenAI finish reason from API response
   * @returns Internal finish reason
   * @private
   */
  mapFinishReason(reason) {
    switch (reason) {
      case "stop":
        return "stop";
      case "length":
        return "length";
      case "tool_calls":
        return "tool_calls";
      case "content_filter":
        return "content_filter";
      default:
        return "stop";
    }
  }
  /**
   * Gets the context length for a given OpenAI model
   * @param modelId - The OpenAI model identifier
   * @returns Maximum context length in tokens
   * @private
   */
  getContextLength(modelId) {
    if (modelId.includes("gpt-4o")) return 128e3;
    if (modelId.includes("gpt-4-turbo")) return 128e3;
    if (modelId.includes("gpt-4")) return 8192;
    if (modelId.includes("gpt-3.5-turbo")) return 16385;
    return 4096;
  }
  /**
   * Gets the capabilities for a given OpenAI model
   * @param modelId - The OpenAI model identifier
   * @returns Array of capability strings
   * @private
   */
  getModelCapabilities(modelId) {
    const capabilities = ["text"];
    if (modelId.includes("gpt")) {
      capabilities.push("chat", "functions");
    }
    if (modelId.includes("vision") || modelId === "gpt-4o") {
      capabilities.push("vision");
    }
    if (modelId.includes("embedding")) {
      capabilities.push("embeddings");
    }
    return capabilities;
  }
  /**
   * Maps OpenAI API errors to internal AI error types
   * @param error - The error object from OpenAI API
   * @returns Appropriate internal AI error instance
   * @private
   */
  mapError(error) {
    if (error instanceof OpenAI.APIError) {
      switch (error.status) {
        case 401:
          return new AuthenticationError("openai");
        case 429: {
          const retryAfter = error.headers?.["retry-after"];
          const retryAfterSeconds = retryAfter ? Number.parseInt(retryAfter, 10) : void 0;
          return new RateLimitError("openai", retryAfterSeconds);
        }
        case 404:
          return new ModelNotFoundError(error.message, "openai");
        case 413:
          return new ContextLengthError("openai");
        default:
          if (error.message.includes("content_filter")) {
            return new ContentFilterError("openai");
          }
          return new AIError(error.message, "API_ERROR", "openai");
      }
    }
    if (error instanceof AIError) {
      return error;
    }
    const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
    return new AIError(errorMessage, "UNKNOWN_ERROR", "openai");
  }
}
export {
  OpenAIProvider
};
//# sourceMappingURL=openai-CpwJar1k.js.map
