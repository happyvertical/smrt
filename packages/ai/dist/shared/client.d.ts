import { default as OpenAI } from 'openai';
import { AIMessageOptions } from './message';
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
    responseFormat?: {
        type: 'text' | 'json_object';
    };
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
    tools?: Array<any>;
    /**
     * Tool selection behavior
     */
    toolChoice?: 'none' | 'auto' | {
        type: 'function';
        function: {
            name: string;
        };
    };
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
export declare class AIClient {
    /**
     * Configuration options for this client
     */
    options: AIClientOptions;
    /**
     * Creates a new AIClient
     *
     * @param options - Client configuration options
     */
    constructor(options: AIClientOptions);
    /**
     * Sends a message to the AI
     * Base implementation returns a placeholder response
     *
     * @param text - Message text
     * @param options - Message options
     * @returns Promise resolving to a placeholder response
     */
    message(_text: string, _options?: AITextCompletionOptions): Promise<string>;
    /**
     * Factory method to create appropriate AI client based on options
     *
     * @param options - Client configuration options
     * @returns Promise resolving to an initialized AI client
     * @throws Error if client type is invalid
     */
    static create(options: AIClientOptions | AIClient): Promise<AIClient | OpenAIClient>;
    /**
     * Gets a text completion from the AI
     * In base class, delegates to message method
     *
     * @param text - Input text for completion
     * @param options - Completion options
     * @returns Promise resolving to the completion result
     */
    textCompletion(text: string, options?: AITextCompletionOptions): Promise<string>;
}
/**
 * Creates an OpenAI client instance
 *
 * @param options - OpenAI configuration options
 * @returns Promise resolving to an OpenAI client
 */
export declare function getOpenAI(options: {
    apiKey?: string;
    baseUrl?: string;
}): Promise<OpenAI>;
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
    responseFormat?: {
        type: 'text' | 'json_object';
    };
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
    toolChoice?: 'none' | 'auto' | {
        type: 'function';
        function: {
            name: string;
        };
    };
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
export declare class OpenAIClient extends AIClient {
    /**
     * OpenAI client instance
     */
    protected openai: OpenAI;
    /**
     * Configuration options for this client
     */
    options: OpenAIClientOptions;
    /**
     * Creates a new OpenAIClient
     *
     * @param options - OpenAI client configuration options
     */
    constructor(options: OpenAIClientOptions);
    /**
     * Sends a message to OpenAI
     *
     * @param text - Message text
     * @param options - Message options
     * @returns Promise resolving to the OpenAI response
     */
    message(text: string, options?: AIMessageOptions): Promise<string>;
    /**
     * Factory method to create and initialize an OpenAIClient
     *
     * @param options - OpenAI client configuration options
     * @returns Promise resolving to an initialized OpenAIClient
     */
    static create(options: OpenAIClientOptions): Promise<OpenAIClient>;
    /**
     * Initializes the OpenAI client
     */
    protected initialize(): Promise<void>;
    /**
     * Sends a text completion request to the OpenAI API
     *
     * @param message - The message to send
     * @param options - Configuration options for the completion request
     * @returns Promise resolving to the completion text
     * @throws Error if the OpenAI API response is invalid
     */
    textCompletion(message: string, options?: OpenAITextCompletionOptions): Promise<string>;
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
export declare function getAIClient(options: GetAIClientOptions): Promise<AIClient>;
export {};
//# sourceMappingURL=client.d.ts.map