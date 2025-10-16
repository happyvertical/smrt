import { ValidationError, ApiError } from "@have/utils";
import OpenAI from "openai";
function isOpenAIClientOptions(options) {
  return options.type === "openai" && "apiKey" in options && !!options.apiKey;
}
function isAIClientInstance(value) {
  return value instanceof AIClient;
}
class AIClient {
  /**
   * Configuration options for this client
   */
  options;
  /**
   * Creates a new AIClient
   *
   * @param options - Client configuration options
   */
  constructor(options) {
    this.options = options;
  }
  /**
   * Sends a message to the AI
   * Base implementation returns a placeholder response
   *
   * @param text - Message text
   * @param options - Message options
   * @returns Promise resolving to a placeholder response
   */
  async message(_text, _options = { role: "user" }) {
    return "not a real ai message, this is the base class!";
  }
  /**
   * Factory method to create appropriate AI client based on options
   *
   * @param options - Client configuration options
   * @returns Promise resolving to an initialized AI client
   * @throws Error if client type is invalid
   */
  static async create(options) {
    if (isAIClientInstance(options)) {
      return options;
    }
    const clientOptions = options;
    if (isOpenAIClientOptions(clientOptions)) {
      return OpenAIClient.create(clientOptions);
    }
    const providedType = clientOptions.type;
    if (providedType && providedType !== "openai") {
      const { getAI: getAI2 } = await Promise.resolve().then(() => factory);
      return await getAI2(clientOptions);
    }
    if (providedType === "openai") {
      throw new ValidationError(
        "OpenAI API key is required but missing or empty",
        {
          supportedTypes: [
            "openai",
            "anthropic",
            "gemini",
            "bedrock",
            "huggingface"
          ],
          providedType,
          hint: "Set OPENAI_API_KEY environment variable or pass apiKey in options"
        }
      );
    }
    throw new ValidationError("Invalid client type specified", {
      supportedTypes: [
        "openai",
        "anthropic",
        "gemini",
        "bedrock",
        "huggingface"
      ],
      providedType
    });
  }
  /**
   * Gets a text completion from the AI
   * In base class, delegates to message method
   *
   * @param text - Input text for completion
   * @param options - Completion options
   * @returns Promise resolving to the completion result
   */
  textCompletion(text, options = {
    role: "user"
  }) {
    return this.message(text, options);
  }
}
async function getOpenAI(options) {
  return new OpenAI({
    apiKey: options.apiKey,
    baseURL: options.baseUrl
  });
}
class OpenAIClient extends AIClient {
  /**
   * OpenAI client instance
   */
  openai;
  /**
   * Configuration options for this client
   */
  options;
  /**
   * Creates a new OpenAIClient
   *
   * @param options - OpenAI client configuration options
   */
  constructor(options) {
    super(options);
    this.options = options;
  }
  /**
   * Sends a message to OpenAI
   *
   * @param text - Message text
   * @param options - Message options
   * @returns Promise resolving to the OpenAI response
   */
  async message(text, options = { role: "user" }) {
    const response = await this.textCompletion(text, options);
    return response;
  }
  /**
   * Factory method to create and initialize an OpenAIClient
   *
   * @param options - OpenAI client configuration options
   * @returns Promise resolving to an initialized OpenAIClient
   */
  static async create(options) {
    const client = new OpenAIClient(options);
    await client.initialize();
    return client;
  }
  /**
   * Initializes the OpenAI client
   */
  async initialize() {
    this.openai = new OpenAI({
      apiKey: this.options.apiKey,
      baseURL: this.options.baseUrl
    });
  }
  /**
   * Sends a text completion request to the OpenAI API
   *
   * @param message - The message to send
   * @param options - Configuration options for the completion request
   * @returns Promise resolving to the completion text
   * @throws Error if the OpenAI API response is invalid
   */
  async textCompletion(message, options = {}) {
    const {
      model = "gpt-4o",
      role = "user",
      history = [],
      name: _name,
      frequencyPenalty: frequency_penalty = 0,
      logitBias: logit_bias,
      logprobs = false,
      topLogprobs: top_logprobs,
      maxTokens: max_tokens,
      n = 1,
      presencePenalty: presence_penalty = 0,
      responseFormat: response_format,
      seed,
      stop,
      stream: _stream = false,
      temperature = 1,
      topProbability: top_p = 1,
      tools,
      toolChoice: tool_choice,
      user,
      onProgress
    } = options;
    const messages = [
      ...history,
      {
        role,
        content: message
      }
    ];
    if (onProgress) {
      const stream = await this.openai.chat.completions.create({
        model,
        messages,
        stream: true,
        frequency_penalty,
        logit_bias,
        logprobs,
        top_logprobs,
        max_tokens,
        n,
        presence_penalty,
        response_format,
        seed,
        stop,
        temperature,
        top_p,
        tools,
        tool_choice,
        user
      });
      let fullContent = "";
      for await (const chunk of stream) {
        const content = chunk.choices[0]?.delta?.content || "";
        fullContent += content;
        onProgress(content);
      }
      return fullContent;
    }
    const response = await this.openai.chat.completions.create({
      model,
      messages,
      frequency_penalty,
      logit_bias,
      logprobs,
      top_logprobs,
      max_tokens,
      n,
      presence_penalty,
      response_format,
      seed,
      stop,
      stream: false,
      temperature,
      top_p,
      tools,
      tool_choice,
      user
    });
    const choice = response.choices[0];
    if (!choice || !choice.message || !choice.message.content) {
      throw new ApiError("Invalid response from OpenAI API: Missing content", {
        model,
        responseId: response.id,
        choices: response.choices?.length || 0,
        hasChoice: !!choice,
        hasMessage: !!choice?.message,
        hasContent: !!choice?.message?.content
      });
    }
    return choice.message.content;
  }
}
async function getAIClient(options) {
  const { getAI: getAI2 } = await Promise.resolve().then(() => factory);
  return await getAI2(options);
}
function isOpenAIOptions(options) {
  return !options.type || options.type === "openai";
}
function isGeminiOptions(options) {
  return options.type === "gemini";
}
function isAnthropicOptions(options) {
  return options.type === "anthropic";
}
function isHuggingFaceOptions(options) {
  return options.type === "huggingface";
}
function isBedrockOptions(options) {
  return options.type === "bedrock";
}
async function getAI(options) {
  if (isOpenAIOptions(options)) {
    const { OpenAIProvider } = await import("./chunks/openai-CpwJar1k.js");
    return new OpenAIProvider(options);
  }
  if (isGeminiOptions(options)) {
    const { GeminiProvider } = await import("./chunks/gemini-BHFsyVy8.js");
    return new GeminiProvider(options);
  }
  if (isAnthropicOptions(options)) {
    const { AnthropicProvider } = await import("./chunks/anthropic-wKObwxfe.js");
    return new AnthropicProvider(options);
  }
  if (isHuggingFaceOptions(options)) {
    const { HuggingFaceProvider } = await import("./chunks/huggingface-B2Zw260O.js");
    return new HuggingFaceProvider(options);
  }
  if (isBedrockOptions(options)) {
    const { BedrockProvider } = await import("./chunks/bedrock-C4FYsLH7.js");
    return new BedrockProvider(options);
  }
  throw new ValidationError("Unsupported AI provider type", {
    supportedTypes: ["openai", "gemini", "anthropic", "huggingface", "bedrock"],
    providedType: options.type
  });
}
async function getAIAuto(options) {
  if (options.apiKey && !options.type) {
    return getAI({ ...options, type: "openai" });
  }
  if (options.apiToken) {
    return getAI({ ...options, type: "huggingface" });
  }
  if (options.region && options.credentials) {
    return getAI({ ...options, type: "bedrock" });
  }
  if (options.projectId || options.anthropicVersion) {
    if (options.anthropicVersion) {
      return getAI({ ...options, type: "anthropic" });
    }
    if (options.projectId) {
      return getAI({ ...options, type: "gemini" });
    }
  }
  throw new ValidationError("Could not auto-detect AI provider from options", {
    hint: 'Please specify a "type" field in options or provide provider-specific credentials',
    supportedTypes: ["openai", "gemini", "anthropic", "huggingface", "bedrock"],
    providedOptions: Object.keys(options)
  });
}
const factory = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  getAI,
  getAIAuto
}, Symbol.toStringTag, { value: "Module" }));
class AIMessage {
  /**
   * Original options used to create this message
   */
  options;
  /**
   * Name of the message sender
   */
  name;
  /**
   * Content of the message
   */
  content;
  /**
   * Role of the message sender in the conversation
   */
  role;
  /**
   * Creates a new AI message
   *
   * @param options - Message configuration
   * @param options.role - Role of the message sender
   * @param options.content - Content of the message
   * @param options.name - Name of the message sender
   */
  constructor(options) {
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
  static async create(options) {
    return new AIMessage(options);
  }
}
class AIThread {
  /**
   * AI client instance for this thread
   */
  ai;
  /**
   * Options used to configure this thread
   */
  options;
  /**
   * Messages in this conversation thread
   */
  messages = [];
  /**
   * Reference materials to include in the conversation context
   */
  references = {};
  /**
   * Creates a new AI thread
   *
   * @param options - Thread configuration options
   */
  constructor(options) {
    this.options = options;
  }
  /**
   * Factory method to create and initialize a new AI thread
   *
   * @param options - Thread configuration options
   * @returns Promise resolving to an initialized AIThread
   */
  static async create(options) {
    const thread = new AIThread(options);
    await thread.initialize();
    return thread;
  }
  /**
   * Initializes the AI client for this thread
   */
  async initialize() {
    this.ai = await AIClient.create(this.options.ai);
  }
  /**
   * Adds a system message to the conversation
   *
   * @param prompt - System message content
   * @returns Promise resolving to the created AIMessage
   */
  async addSystem(prompt) {
    const message = await AIMessage.create({
      thread: this,
      role: "system",
      name: "system",
      content: prompt
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
  async add(options) {
    const message = await AIMessage.create({
      thread: this,
      role: options.role,
      name: options.name || options.role,
      // Default name to role if not provided
      content: options.content
    });
    this.messages.push(message);
    return message;
  }
  /**
   * Gets all messages in this thread
   *
   * @returns Array of AIMessage objects
   */
  get() {
    return this.messages;
  }
  /**
   * Adds a reference to be included in the conversation context
   *
   * @param name - Name of the reference
   * @param body - Content of the reference
   */
  addReference(name, body) {
    this.references[name] = body;
  }
  /**
   * Assembles the conversation history for sending to the AI
   * Properly orders system message, references, and conversation messages
   *
   * @returns Array of message parameters formatted for the OpenAI API
   */
  assembleHistory() {
    const history = [];
    const systemMessage = this.messages.find((m) => m.role === "system");
    if (systemMessage) {
      history.push({
        role: systemMessage.role,
        content: systemMessage.content
      });
    }
    for (const name in this.references) {
      history.push({
        role: "user",
        content: `Reference - ${name}:
${this.references[name]}`
      });
    }
    this.messages.filter((m) => m.role !== "system").forEach((message) => {
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
  async do(prompt, options = {
    responseFormat: "text"
  }) {
    const { responseFormat } = options;
    const history = this.assembleHistory();
    const response = await this.ai.textCompletion(prompt, {
      history,
      responseFormat: {
        type: responseFormat === "json" ? "json_object" : "text"
      }
    });
    return response;
  }
}
class AIError extends Error {
  constructor(message, code, provider, model) {
    super(message);
    this.code = code;
    this.provider = provider;
    this.model = model;
    this.name = "AIError";
  }
}
class AuthenticationError extends AIError {
  constructor(provider) {
    super("Authentication failed", "AUTH_ERROR", provider);
    this.name = "AuthenticationError";
  }
}
class RateLimitError extends AIError {
  constructor(provider, retryAfter) {
    super(
      `Rate limit exceeded${retryAfter ? `, retry after ${retryAfter}s` : ""}`,
      "RATE_LIMIT",
      provider
    );
    this.name = "RateLimitError";
  }
}
class ModelNotFoundError extends AIError {
  constructor(model, provider) {
    super(`Model not found: ${model}`, "MODEL_NOT_FOUND", provider, model);
    this.name = "ModelNotFoundError";
  }
}
class ContextLengthError extends AIError {
  constructor(provider, model) {
    super(
      "Input exceeds maximum context length",
      "CONTEXT_LENGTH_EXCEEDED",
      provider,
      model
    );
    this.name = "ContextLengthError";
  }
}
class ContentFilterError extends AIError {
  constructor(provider, model) {
    super(
      "Content filtered by safety systems",
      "CONTENT_FILTERED",
      provider,
      model
    );
    this.name = "ContentFilterError";
  }
}
export {
  AIClient,
  AIError,
  AIMessage as AIMessageClass,
  AIThread,
  AuthenticationError,
  ContentFilterError,
  ContextLengthError,
  ModelNotFoundError,
  OpenAIClient,
  RateLimitError,
  getAI,
  getAIAuto,
  getAIClient,
  getOpenAI
};
//# sourceMappingURL=index.js.map
