import { AICapabilities, AIInterface, AIMessage, AIModel, AIResponse, AnthropicOptions, ChatOptions, CompletionOptions, EmbeddingOptions, EmbeddingResponse } from '../types';
/**
 * Anthropic Claude provider implementation that handles all interactions with Anthropic's API.
 * Supports Claude models, streaming, vision capabilities, and function calling.
 * Does not support embeddings (use OpenAI or another provider for embeddings).
 */
export declare class AnthropicProvider implements AIInterface {
    private options;
    private client;
    /**
     * Creates a new Anthropic provider instance
     * @param options - Configuration options for the Anthropic provider
     */
    constructor(options: AnthropicOptions);
    private initializeClientSync;
    /**
     * Ensures the Anthropic client is initialized by dynamically importing the SDK
     * @throws {AIError} When the Anthropic SDK cannot be loaded
     * @private
     */
    private ensureClient;
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
    chat(messages: AIMessage[], options?: ChatOptions): Promise<AIResponse>;
    complete(prompt: string, options?: CompletionOptions): Promise<AIResponse>;
    embed(_text: string | string[], _options?: EmbeddingOptions): Promise<EmbeddingResponse>;
    stream(messages: AIMessage[], options?: ChatOptions): AsyncIterable<string>;
    countTokens(text: string): Promise<number>;
    getModels(): Promise<AIModel[]>;
    getCapabilities(): Promise<AICapabilities>;
    private mapMessagesToAnthropic;
    private mapToolChoice;
    private mapFinishReason;
    private mapError;
}
//# sourceMappingURL=anthropic.d.ts.map