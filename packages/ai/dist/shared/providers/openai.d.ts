import { AICapabilities, AIInterface, AIMessage, AIModel, AIResponse, ChatOptions, CompletionOptions, EmbeddingOptions, EmbeddingResponse, OpenAIOptions } from '../types';
/**
 * OpenAI provider implementation that handles all interactions with OpenAI's API.
 * Supports GPT models, embeddings, function calling, streaming, and vision capabilities.
 */
export declare class OpenAIProvider implements AIInterface {
    private client;
    private options;
    /**
     * Creates a new OpenAI provider instance
     * @param options - Configuration options for the OpenAI provider
     */
    constructor(options: OpenAIOptions);
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
    chat(messages: AIMessage[], options?: ChatOptions): Promise<AIResponse>;
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
    complete(prompt: string, options?: CompletionOptions): Promise<AIResponse>;
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
    embed(text: string | string[], options?: EmbeddingOptions): Promise<EmbeddingResponse>;
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
    stream(messages: AIMessage[], options?: ChatOptions): AsyncIterable<string>;
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
    countTokens(text: string): Promise<number>;
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
    getModels(): Promise<AIModel[]>;
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
    getCapabilities(): Promise<AICapabilities>;
    /**
     * Maps internal AI messages to OpenAI's message format
     * @param messages - Array of internal AI messages
     * @returns Array of OpenAI-compatible message parameters
     * @private
     */
    private mapMessagesToOpenAI;
    /**
     * Maps internal tool choice format to OpenAI's tool choice format
     * @param toolChoice - Internal tool choice specification
     * @returns OpenAI-compatible tool choice option or undefined
     * @private
     */
    private mapToolChoice;
    /**
     * Maps OpenAI usage information to internal token usage format
     * @param usage - OpenAI usage object from API response
     * @returns Internal token usage object or undefined
     * @private
     */
    private mapUsage;
    /**
     * Maps OpenAI finish reason to internal finish reason format
     * @param reason - OpenAI finish reason from API response
     * @returns Internal finish reason
     * @private
     */
    private mapFinishReason;
    /**
     * Gets the context length for a given OpenAI model
     * @param modelId - The OpenAI model identifier
     * @returns Maximum context length in tokens
     * @private
     */
    private getContextLength;
    /**
     * Gets the capabilities for a given OpenAI model
     * @param modelId - The OpenAI model identifier
     * @returns Array of capability strings
     * @private
     */
    private getModelCapabilities;
    /**
     * Maps OpenAI API errors to internal AI error types
     * @param error - The error object from OpenAI API
     * @returns Appropriate internal AI error instance
     * @private
     */
    private mapError;
}
//# sourceMappingURL=openai.d.ts.map