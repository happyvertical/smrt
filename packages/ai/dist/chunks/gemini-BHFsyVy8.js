import crypto from "node:crypto";
import { AIError, AuthenticationError, RateLimitError, ModelNotFoundError } from "../index.js";
class GeminiProvider {
  options;
  client;
  // GoogleGenAI instance from @google/genai
  constructor(options) {
    this.options = {
      defaultModel: "gemini-2.5-flash",
      ...options
    };
    this.initializeClientSync();
  }
  initializeClientSync() {
    try {
      import("@google/genai").then(({ GoogleGenAI }) => {
        this.client = new GoogleGenAI({ apiKey: this.options.apiKey });
      }).catch(() => {
      });
    } catch (_error) {
    }
  }
  async ensureClient() {
    if (!this.client) {
      try {
        const { GoogleGenAI } = await import("@google/genai");
        this.client = new GoogleGenAI({ apiKey: this.options.apiKey });
      } catch (_error) {
        throw new AIError(
          "Failed to initialize Gemini client. Make sure @google/genai is installed.",
          "INITIALIZATION_ERROR",
          "gemini"
        );
      }
    }
  }
  async chat(messages, options = {}) {
    try {
      await this.ensureClient();
      const model = options.model || this.options.defaultModel;
      const generationConfig = {
        maxOutputTokens: options.maxTokens,
        temperature: options.temperature,
        topP: options.topP,
        stopSequences: Array.isArray(options.stop) ? options.stop : options.stop ? [options.stop] : void 0,
        // Add response MIME type for JSON output
        responseMimeType: options.responseFormat?.type === "json_object" ? "application/json" : void 0
      };
      const requestConfig = {
        model,
        contents: this.messagesToGeminiFormat(messages),
        generationConfig
      };
      if (options.tools && options.tools.length > 0) {
        requestConfig.tools = [
          {
            functionDeclarations: options.tools.map((tool) => ({
              name: tool.function.name,
              description: tool.function.description || "",
              parameters: tool.function.parameters || { type: "object" }
            }))
          }
        ];
        if (options.toolChoice) {
          requestConfig.toolConfig = this.mapToolChoice(options.toolChoice);
        }
      }
      const result = await this.client.models.generateContent(requestConfig);
      let toolCalls;
      const firstCandidate = result.candidates?.[0];
      if (firstCandidate?.content?.parts) {
        const functionCalls = firstCandidate.content.parts.filter(
          (part) => part.functionCall
        );
        if (functionCalls.length > 0) {
          toolCalls = functionCalls.map((part) => ({
            id: `call_${crypto.randomUUID()}`,
            type: "function",
            function: {
              name: part.functionCall.name,
              arguments: JSON.stringify(part.functionCall.args || {})
            }
          }));
        }
      }
      let content = result.text || "";
      if (options.responseFormat?.type === "json_object") {
        content = this.stripMarkdownCodeBlock(content);
      }
      return {
        content,
        model,
        finishReason: this.mapFinishReason(result),
        usage: {
          promptTokens: result.usageMetadata?.promptTokenCount || 0,
          completionTokens: result.usageMetadata?.candidatesTokenCount || 0,
          totalTokens: result.usageMetadata?.totalTokenCount || 0
        },
        toolCalls: toolCalls && toolCalls.length > 0 ? toolCalls : void 0
      };
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
        "Gemini embeddings not implemented",
        "NOT_IMPLEMENTED",
        "gemini"
      );
    } catch (error) {
      throw this.mapError(error);
    }
  }
  async *stream(_messages, _options = {}) {
    yield* [];
    throw new AIError(
      "Gemini streaming not implemented",
      "NOT_IMPLEMENTED",
      "gemini"
    );
  }
  async countTokens(text) {
    try {
      return Math.ceil(text.length / 4);
    } catch (error) {
      throw this.mapError(error);
    }
  }
  async getModels() {
    return [
      {
        id: "gemini-2.0-flash-001",
        name: "Gemini 2.0 Flash",
        description: "Latest fast and efficient Gemini model with function calling",
        contextLength: 1e6,
        capabilities: ["text", "chat", "vision", "functions"],
        supportsFunctions: true,
        supportsVision: true
      },
      {
        id: "gemini-2.5-flash",
        name: "Gemini 2.5 Flash",
        description: "Experimental next-generation Gemini model",
        contextLength: 1e6,
        capabilities: ["text", "chat", "vision", "functions"],
        supportsFunctions: true,
        supportsVision: true
      },
      {
        id: "gemini-1.5-pro",
        name: "Gemini 1.5 Pro (Legacy)",
        description: "Previous generation model (may not be available)",
        contextLength: 2e6,
        capabilities: ["text", "chat", "vision", "functions"],
        supportsFunctions: true,
        supportsVision: true
      }
    ];
  }
  async getCapabilities() {
    return {
      chat: true,
      completion: true,
      embeddings: false,
      // Gemini may not support embeddings directly
      streaming: true,
      functions: true,
      vision: true,
      fineTuning: false,
      maxContextLength: 2e6,
      supportedOperations: [
        "chat",
        "completion",
        "streaming",
        "functions",
        "vision"
      ]
    };
  }
  mapToolChoice(toolChoice) {
    if (!toolChoice || toolChoice === "auto") {
      return { functionCallingConfig: { mode: "AUTO" } };
    }
    if (toolChoice === "none") {
      return { functionCallingConfig: { mode: "NONE" } };
    }
    if (typeof toolChoice === "object" && toolChoice.type === "function") {
      return {
        functionCallingConfig: {
          mode: "ANY",
          allowedFunctionNames: [toolChoice.function.name]
        }
      };
    }
    return { functionCallingConfig: { mode: "AUTO" } };
  }
  mapFinishReason(response) {
    const firstCandidate = response.candidates?.[0];
    if (firstCandidate?.content?.parts) {
      const hasFunctionCall = firstCandidate.content.parts.some(
        (part) => part.functionCall
      );
      if (hasFunctionCall) {
        return "tool_calls";
      }
    }
    return "stop";
  }
  messagesToGeminiFormat(messages) {
    return messages.map((message) => {
      switch (message.role) {
        case "system":
          return `Instructions: ${message.content}`;
        case "user":
          return `Human: ${message.content}`;
        case "assistant":
          return `Assistant: ${message.content}`;
        default:
          return message.content;
      }
    }).join("\n\n");
  }
  stripMarkdownCodeBlock(text) {
    const codeBlockRegex = /^```(?:json|javascript|typescript)?\s*\n?([\s\S]*?)\n?```\s*$/;
    const match = text.match(codeBlockRegex);
    return match ? match[1].trim() : text.trim();
  }
  mapError(error) {
    if (error instanceof AIError) {
      return error;
    }
    const message = error instanceof Error ? error.message : "Unknown Gemini error occurred";
    if (message.includes("API_KEY_INVALID") || message.includes("401")) {
      return new AuthenticationError("gemini");
    }
    if (message.includes("QUOTA_EXCEEDED") || message.includes("429")) {
      return new RateLimitError("gemini");
    }
    if (message.includes("MODEL_NOT_FOUND") || message.includes("404")) {
      return new ModelNotFoundError(message, "gemini");
    }
    return new AIError(message, "UNKNOWN_ERROR", "gemini");
  }
}
export {
  GeminiProvider
};
//# sourceMappingURL=gemini-BHFsyVy8.js.map
