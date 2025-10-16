import type OpenAI from 'openai';
import { AIClient, type AIClientOptions } from './client';
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
export class AIThread {
  /**
   * AI client instance for this thread
   */
  protected ai!: AIClient;

  /**
   * Options used to configure this thread
   */
  protected options: AIThreadOptions;

  /**
   * Messages in this conversation thread
   */
  private messages: AIMessage[] = [];

  /**
   * Reference materials to include in the conversation context
   */
  private references: { [name: string]: string } = {};

  /**
   * Creates a new AI thread
   *
   * @param options - Thread configuration options
   */
  constructor(options: AIThreadOptions) {
    this.options = options;
  }

  /**
   * Factory method to create and initialize a new AI thread
   *
   * @param options - Thread configuration options
   * @returns Promise resolving to an initialized AIThread
   */
  static async create(options: AIThreadOptions) {
    const thread = new AIThread(options);
    await thread.initialize();
    return thread; // No need to add system message here, do it in addSystem
  }

  /**
   * Initializes the AI client for this thread
   */
  public async initialize() {
    this.ai = await AIClient.create(this.options.ai);
  }

  /**
   * Adds a system message to the conversation
   *
   * @param prompt - System message content
   * @returns Promise resolving to the created AIMessage
   */
  public async addSystem(prompt: string) {
    const message = await AIMessage.create({
      thread: this,
      role: 'system',
      name: 'system',
      content: prompt,
    });

    this.messages.push(message);
    return message;
  }

  /**
   * Adds a message to the conversation
   *
   * @param options - Message options
   * @param options.role - Role of the message sender
   * @param options.name - Optional name of the message sender
   * @param options.content - Content of the message
   * @returns Promise resolving to the created AIMessage
   */
  public async add(options: {
    role: 'user' | 'assistant' | 'system';
    name?: string;
    content: string;
  }) {
    const message = await AIMessage.create({
      thread: this,
      role: options.role,
      name: options.name || options.role, // Default name to role if not provided
      content: options.content,
    });

    this.messages.push(message);
    return message;
  }

  /**
   * Gets all messages in this thread
   *
   * @returns Array of AIMessage objects
   */
  public get(): AIMessage[] {
    return this.messages;
  }

  /**
   * Adds a reference to be included in the conversation context
   *
   * @param name - Name of the reference
   * @param body - Content of the reference
   */
  public addReference(name: string, body: string): void {
    this.references[name] = body;
  }

  /**
   * Assembles the conversation history for sending to the AI
   * Properly orders system message, references, and conversation messages
   *
   * @returns Array of message parameters formatted for the OpenAI API
   */
  public assembleHistory(): OpenAI.Chat.ChatCompletionMessageParam[] {
    const history: OpenAI.Chat.ChatCompletionMessageParam[] = [];

    // Add system message first
    const systemMessage = this.messages.find((m) => m.role === 'system');
    if (systemMessage) {
      history.push({
        role: systemMessage.role,
        content: systemMessage.content,
      });
    }

    // Add references as user messages (before other user/assistant messages)
    for (const name in this.references) {
      history.push({
        role: 'user',
        content: `Reference - ${name}:\n${this.references[name]}`,
      });
    }

    // Add other messages
    this.messages
      .filter((m) => m.role !== 'system')
      .forEach((message) => {
        history.push({ role: message.role, content: message.content });
      });

    return history;
  }

  /**
   * Sends a prompt to the AI and gets a response
   *
   * @param prompt - Prompt message to send
   * @param options - Options for the AI response
   * @param options.responseFormat - Format for the AI to respond with
   * @returns Promise resolving to the AI response
   */
  public async do(
    prompt: string,
    options: {
      responseFormat?: 'html' | 'text' | 'json';
    } = {
      responseFormat: 'text',
    },
  ) {
    const { responseFormat } = options;
    const history = this.assembleHistory();

    // Get completion from AI with assembled history
    const response = await this.ai.textCompletion(prompt, {
      history,
      responseFormat: {
        type: responseFormat === 'json' ? 'json_object' : 'text',
      },
    });
    return response;
  }
}
