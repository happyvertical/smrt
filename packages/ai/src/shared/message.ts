import type { AIThread } from './thread';

/**
 * Options for creating AI messages
 */
export interface AIMessageOptions {
  /**
   * Role of the message sender
   */
  role?: 'user' | 'assistant' | 'system';

  /**
   * Format for the AI response
   */
  responseFormat?: { type: 'text' | 'json_object' };
}

/**
 * Represents a message in an AI conversation
 */
export class AIMessage {
  /**
   * Original options used to create this message
   */
  protected options;

  /**
   * Name of the message sender
   */
  public name: string;

  /**
   * Content of the message
   */
  public content: string;

  /**
   * Role of the message sender in the conversation
   */
  public role: 'user' | 'assistant' | 'system';

  /**
   * Creates a new AI message
   *
   * @param options - Message configuration
   * @param options.role - Role of the message sender
   * @param options.content - Content of the message
   * @param options.name - Name of the message sender
   */
  constructor(options: {
    role: 'user' | 'assistant' | 'system';
    content: string;
    name: string;
  }) {
    this.options = options;
    this.role = options.role;
    this.content = options.content;
    this.name = options.name;
  }

  /**
   * Factory method to create a new AI message
   *
   * @param options - Message configuration
   * @param options.thread - Thread this message belongs to
   * @param options.role - Role of the message sender
   * @param options.content - Content of the message
   * @param options.name - Name of the message sender
   * @returns Promise resolving to a new AIMessage instance
   */
  static async create(options: {
    thread: AIThread;
    role: 'user' | 'assistant' | 'system';
    content: string;
    name: string;
  }) {
    return new AIMessage(options);
  }
}
