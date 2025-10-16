import { AIError, AuthenticationError, RateLimitError, ModelNotFoundError, ContextLengthError } from "../index.js";
class HuggingFaceProvider {
  options;
  baseUrl;
  constructor(options) {
    this.options = {
      defaultModel: "microsoft/DialoGPT-medium",
      useCache: true,
      waitForModel: true,
      ...options
    };
    this.baseUrl = this.options.endpoint || "https://api-inference.huggingface.co";
  }
  async chat(messages, options = {}) {
    try {
      const prompt = this.messagesToPrompt(messages);
      const response = await this.makeRequest(
        `/models/${options.model || this.options.model || this.options.defaultModel}`,
        {
          inputs: prompt,
          parameters: {
            max_new_tokens: options.maxTokens || 512,
            temperature: options.temperature || 1,
            top_p: options.topP || 1,
            do_sample: options.temperature && options.temperature > 0 || false,
            stop_sequences: Array.isArray(options.stop) ? options.stop : options.stop ? [options.stop] : void 0
          },
          options: {
            use_cache: this.options.useCache,
            wait_for_model: this.options.waitForModel
          }
        }
      );
      if (Array.isArray(response) && response[0]?.generated_text) {
        const generatedText = response[0].generated_text;
        const content = generatedText.replace(prompt, "").trim();
        return {
          content,
          model: options.model || this.options.model || this.options.defaultModel,
          finishReason: "stop"
        };
      }
      throw new AIError(
        "Invalid response format from Hugging Face",
        "INVALID_RESPONSE",
        "huggingface"
      );
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
  async embed(text, options = {}) {
    try {
      const input = Array.isArray(text) ? text : [text];
      const model = options.model || "sentence-transformers/all-MiniLM-L6-v2";
      const response = await this.makeRequest(`/models/${model}`, {
        inputs: input,
        options: {
          use_cache: this.options.useCache,
          wait_for_model: this.options.waitForModel
        }
      });
      let embeddings;
      if (Array.isArray(response) && Array.isArray(response[0])) {
        embeddings = Array.isArray(text) ? response : [response[0]];
      } else if (response && typeof response === "object" && response.embeddings) {
        embeddings = response.embeddings;
      } else {
        throw new AIError(
          "Invalid embedding response format",
          "INVALID_RESPONSE",
          "huggingface"
        );
      }
      return {
        embeddings,
        model
      };
    } catch (error) {
      throw this.mapError(error);
    }
  }
  async *stream(messages, options = {}) {
    const response = await this.chat(messages, options);
    const content = response.content;
    const chunkSize = 10;
    for (let i = 0; i < content.length; i += chunkSize) {
      const chunk = content.slice(i, i + chunkSize);
      if (options.onProgress) {
        options.onProgress(chunk);
      }
      yield chunk;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  async countTokens(text) {
    return Math.ceil(text.length / 4);
  }
  async getModels() {
    return [
      {
        id: "microsoft/DialoGPT-medium",
        name: "DialoGPT Medium",
        description: "Conversational AI model by Microsoft",
        contextLength: 1024,
        capabilities: ["text", "chat"],
        supportsFunctions: false,
        supportsVision: false
      },
      {
        id: "microsoft/DialoGPT-large",
        name: "DialoGPT Large",
        description: "Large conversational AI model by Microsoft",
        contextLength: 1024,
        capabilities: ["text", "chat"],
        supportsFunctions: false,
        supportsVision: false
      },
      {
        id: "facebook/blenderbot-400M-distill",
        name: "BlenderBot 400M",
        description: "Conversational AI model by Meta",
        contextLength: 512,
        capabilities: ["text", "chat"],
        supportsFunctions: false,
        supportsVision: false
      },
      {
        id: "gpt2",
        name: "GPT-2",
        description: "OpenAI GPT-2 model",
        contextLength: 1024,
        capabilities: ["text", "completion"],
        supportsFunctions: false,
        supportsVision: false
      },
      {
        id: "sentence-transformers/all-MiniLM-L6-v2",
        name: "All-MiniLM-L6-v2",
        description: "Sentence embedding model",
        contextLength: 512,
        capabilities: ["embeddings"],
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
      streaming: false,
      // Limited streaming support
      functions: false,
      // Most HF models don't support function calling
      vision: false,
      // Limited vision model support
      fineTuning: true,
      // Via Hugging Face training API
      maxContextLength: 2048,
      supportedOperations: ["chat", "completion", "embedding"]
    };
  }
  messagesToPrompt(messages) {
    return `${messages.map((message) => {
      switch (message.role) {
        case "system":
          return `System: ${message.content}`;
        case "user":
          return `Human: ${message.content}`;
        case "assistant":
          return `Assistant: ${message.content}`;
        default:
          return message.content;
      }
    }).join("\n")}
Assistant:`;
  }
  async makeRequest(endpoint, data) {
    const url = `${this.baseUrl}${endpoint}`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.options.apiToken}`,
        "Content-Type": "application/json",
        ...this.options.headers
      },
      body: JSON.stringify(data)
    });
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`HTTP ${response.status}: ${errorText}`);
    }
    return response.json();
  }
  mapError(error) {
    if (error instanceof AIError) {
      return error;
    }
    const message = error instanceof Error ? error.message : "Unknown error";
    if (message.includes("401") || message.includes("Unauthorized")) {
      return new AuthenticationError("huggingface");
    }
    if (message.includes("429") || message.includes("rate limit")) {
      return new RateLimitError("huggingface");
    }
    if (message.includes("404") || message.includes("not found")) {
      return new ModelNotFoundError(message, "huggingface");
    }
    if (message.includes("413") || message.includes("too large")) {
      return new ContextLengthError("huggingface");
    }
    return new AIError(message, "UNKNOWN_ERROR", "huggingface");
  }
}
export {
  HuggingFaceProvider
};
//# sourceMappingURL=huggingface-B2Zw260O.js.map
