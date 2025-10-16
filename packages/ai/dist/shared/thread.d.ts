import { default as OpenAI } from 'openai';
import { AIClient, AIClientOptions } from './client';
import { AIMessage } from './message';
/**
 * Options for creating an AI conversation thread
 */
export interface AIThreadOptions {
    /**
     * Options for the AI client to use in this thread
     */
    ai: AIClientOptions;
}
/**
 * Represents a conversation thread with an AI model
 * Manages messages, references, and conversation state
 */
export declare class AIThread {
    /**
     * AI client instance for this thread
     */
    protected ai: AIClient;
    /**
     * Options used to configure this thread
     */
    protected options: AIThreadOptions;
    /**
     * Messages in this conversation thread
     */
    private messages;
    /**
     * Reference materials to include in the conversation context
     */
    private references;
    /**
     * Creates a new AI thread
     *
     * @param options - Thread configuration options
     */
    constructor(options: AIThreadOptions);
    /**
     * Factory method to create and initialize a new AI thread
     *
     * @param options - Thread configuration options
     * @returns Promise resolving to an initialized AIThread
     */
    static create(options: AIThreadOptions): Promise<AIThread>;
    /**
     * Initializes the AI client for this thread
     */
    initialize(): Promise<void>;
    /**
     * Adds a system message to the conversation
     *
     * @param prompt - System message content
     * @returns Promise resolving to the created AIMessage
     */
    addSystem(prompt: string): Promise<AIMessage>;
    /**
     * Adds a message to the conversation
     *
     * @param options - Message options
     * @param options.role - Role of the message sender
     * @param options.name - Optional name of the message sender
     * @param options.content - Content of the message
     * @returns Promise resolving to the created AIMessage
     */
    add(options: {
        role: 'user' | 'assistant' | 'system';
        name?: string;
        content: string;
    }): Promise<AIMessage>;
    /**
     * Gets all messages in this thread
     *
     * @returns Array of AIMessage objects
     */
    get(): AIMessage[];
    /**
     * Adds a reference to be included in the conversation context
     *
     * @param name - Name of the reference
     * @param body - Content of the reference
     */
    addReference(name: string, body: string): void;
    /**
     * Assembles the conversation history for sending to the AI
     * Properly orders system message, references, and conversation messages
     *
     * @returns Array of message parameters formatted for the OpenAI API
     */
    assembleHistory(): OpenAI.Chat.ChatCompletionMessageParam[];
    /**
     * Sends a prompt to the AI and gets a response
     *
     * @param prompt - Prompt message to send
     * @param options - Options for the AI response
     * @param options.responseFormat - Format for the AI to respond with
     * @returns Promise resolving to the AI response
     */
    do(prompt: string, options?: {
        responseFormat?: 'html' | 'text' | 'json';
    }): Promise<string>;
}
//# sourceMappingURL=thread.d.ts.map