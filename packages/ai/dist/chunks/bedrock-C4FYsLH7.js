import { AIError, AuthenticationError, RateLimitError, ModelNotFoundError, ContextLengthError } from "../index.js";
class BedrockProvider {
  options;
  client;
  // Will be BedrockRuntimeClient instance from @aws-sdk/client-bedrock-runtime
  constructor(options) {
    this.options = {
      defaultModel: "anthropic.claude-3-5-sonnet-20241022-v2:0",
      ...options
    };
    this.initializeClientSync();
  }
  initializeClientSync() {
    try {
      import("@aws-sdk/client-bedrock-runtime").then(({ BedrockRuntimeClient }) => {
        this.client = new BedrockRuntimeClient({
          region: this.options.region,
          credentials: this.options.credentials,
          endpoint: this.options.endpoint
        });
      }).catch(() => {
      });
    } catch (_error) {
    }
  }
  async ensureClient() {
    if (!this.client) {
      try {
        const { BedrockRuntimeClient } = await import("@aws-sdk/client-bedrock-runtime");
        this.client = new BedrockRuntimeClient({
          region: this.options.region,
          credentials: this.options.credentials,
          endpoint: this.options.endpoint
        });
      } catch (_error) {
        throw new AIError(
          "Failed to initialize Bedrock client. Make sure @aws-sdk/client-bedrock-runtime is installed.",
          "INITIALIZATION_ERROR",
          "bedrock"
        );
      }
    }
  }
  async chat(messages, options = {}) {
    try {
      await this.ensureClient();
      const modelId = options.model || this.options.defaultModel;
      if (modelId?.includes("anthropic.claude")) {
        return this.chatWithClaude(messages, options);
      }
      if (modelId?.includes("amazon.titan")) {
        return this.chatWithTitan(messages, options);
      }
      if (modelId?.includes("cohere.command")) {
        return this.chatWithCohere(messages, options);
      }
      if (modelId?.includes("meta.llama")) {
        return this.chatWithLlama(messages, options);
      }
      return this.chatWithClaude(messages, options);
    } catch (error) {
      throw this.mapError(error);
    }
  }
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
  async embed(_text, _options = {}) {
    try {
      throw new AIError(
        "Bedrock embeddings not implemented",
        "NOT_IMPLEMENTED",
        "bedrock"
      );
    } catch (error) {
      throw this.mapError(error);
    }
  }
  async *stream(_messages, _options = {}) {
    yield* [];
    throw new AIError(
      "Bedrock streaming not implemented",
      "NOT_IMPLEMENTED",
      "bedrock"
    );
  }
  async countTokens(text) {
    return Math.ceil(text.length / 4);
  }
  async getModels() {
    return [
      // Anthropic Claude models
      {
        id: "anthropic.claude-3-5-sonnet-20241022-v2:0",
        name: "Claude 3.5 Sonnet v2",
        description: "Latest Claude 3.5 Sonnet model on Bedrock",
        contextLength: 2e5,
        capabilities: ["text", "chat", "vision", "functions"],
        supportsFunctions: true,
        supportsVision: true
      },
      {
        id: "anthropic.claude-3-opus-20240229-v1:0",
        name: "Claude 3 Opus",
        description: "Most powerful Claude model on Bedrock",
        contextLength: 2e5,
        capabilities: ["text", "chat", "vision"],
        supportsFunctions: false,
        supportsVision: true
      },
      // Amazon Titan models
      {
        id: "amazon.titan-text-premier-v1:0",
        name: "Titan Text Premier",
        description: "Premier Amazon Titan text model",
        contextLength: 32e3,
        capabilities: ["text", "chat"],
        supportsFunctions: false,
        supportsVision: false
      },
      {
        id: "amazon.titan-embed-text-v1",
        name: "Titan Embeddings Text",
        description: "Amazon Titan text embeddings model",
        contextLength: 8192,
        capabilities: ["embeddings"],
        supportsFunctions: false,
        supportsVision: false
      },
      // Cohere models
      {
        id: "cohere.command-r-plus-v1:0",
        name: "Command R+",
        description: "Cohere Command R+ model with advanced capabilities",
        contextLength: 128e3,
        capabilities: ["text", "chat", "functions"],
        supportsFunctions: true,
        supportsVision: false
      },
      // Meta Llama models
      {
        id: "meta.llama3-1-405b-instruct-v1:0",
        name: "Llama 3.1 405B Instruct",
        description: "Meta Llama 3.1 405B instruction-tuned model",
        contextLength: 128e3,
        capabilities: ["text", "chat"],
        supportsFunctions: false,
        supportsVision: false
      }
    ];
  }
  async getCapabilities() {
    return {
      chat: true,
      completion: true,
      embeddings: true,
      // Via Titan Embeddings
      streaming: true,
      functions: true,
      // Some models support function calling
      vision: true,
      // Some models support vision
      fineTuning: true,
      // Via Bedrock fine-tuning
      maxContextLength: 2e5,
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
  async chatWithClaude(messages, options) {
    const { InvokeModelCommand } = await import("@aws-sdk/client-bedrock-runtime");
    const { system, anthropicMessages } = this.mapMessagesToClaude(messages);
    const payload = {
      anthropic_version: "bedrock-2023-05-31",
      max_tokens: options.maxTokens || 4096,
      messages: anthropicMessages,
      temperature: options.temperature,
      top_p: options.topP,
      stop_sequences: Array.isArray(options.stop) ? options.stop : options.stop ? [options.stop] : void 0,
      system: system || void 0
    };
    const command = new InvokeModelCommand({
      modelId: options.model || this.options.defaultModel,
      contentType: "application/json",
      accept: "application/json",
      body: JSON.stringify(payload)
    });
    const response = await this.client.send(command);
    const responseBody = JSON.parse(new TextDecoder().decode(response.body));
    return {
      content: responseBody.content?.[0]?.text || "",
      model: options.model || this.options.defaultModel,
      finishReason: this.mapClaudeFinishReason(responseBody.stop_reason),
      usage: {
        promptTokens: responseBody.usage?.input_tokens || 0,
        completionTokens: responseBody.usage?.output_tokens || 0,
        totalTokens: (responseBody.usage?.input_tokens || 0) + (responseBody.usage?.output_tokens || 0)
      }
    };
  }
  async chatWithTitan(_messages, _options) {
    throw new AIError(
      "Titan on Bedrock not implemented",
      "NOT_IMPLEMENTED",
      "bedrock"
    );
  }
  async chatWithCohere(_messages, _options) {
    throw new AIError(
      "Cohere on Bedrock not implemented",
      "NOT_IMPLEMENTED",
      "bedrock"
    );
  }
  async chatWithLlama(_messages, _options) {
    throw new AIError(
      "Llama on Bedrock not implemented",
      "NOT_IMPLEMENTED",
      "bedrock"
    );
  }
  mapMessagesToClaude(messages) {
    let system;
    const anthropicMessages = [];
    for (const message of messages) {
      if (message.role === "system") {
        system = system ? `${system}

${message.content}` : message.content;
      } else {
        anthropicMessages.push({
          role: message.role === "assistant" ? "assistant" : "user",
          content: message.content
        });
      }
    }
    return { system, anthropicMessages };
  }
  mapClaudeFinishReason(reason) {
    switch (reason) {
      case "end_turn":
        return "stop";
      case "max_tokens":
        return "length";
      case "stop_sequence":
        return "stop";
      case "tool_use":
        return "tool_calls";
      default:
        return "stop";
    }
  }
  mapError(error) {
    if (error instanceof AIError) {
      return error;
    }
    if (typeof error === "object" && error !== null) {
      const awsError = error;
      if (awsError.name === "AccessDeniedException") {
        return new AuthenticationError("bedrock");
      }
      if (awsError.name === "ThrottlingException") {
        return new RateLimitError("bedrock");
      }
      if (awsError.name === "ResourceNotFoundException") {
        return new ModelNotFoundError(
          awsError.message || "Model not found",
          "bedrock"
        );
      }
      if (awsError.name === "ValidationException" && awsError.message?.includes("input is too long")) {
        return new ContextLengthError("bedrock");
      }
    }
    const errorMessage = error instanceof Error ? error.message : "Unknown Bedrock error occurred";
    return new AIError(errorMessage, "UNKNOWN_ERROR", "bedrock");
  }
}
export {
  BedrockProvider
};
//# sourceMappingURL=bedrock-C4FYsLH7.js.map
