/**
 * WebLLM adapter
 *
 * Uses @mlc-ai/web-llm for running LLMs in the browser with WebGPU.
 * Requires downloading model files (100MB - 4GB+ depending on model).
 */

import {
  CapabilityNotAvailableError,
  InitializationError,
  ModelLoadError,
} from '../../core/errors.js';
import type {
  DownloadProgressInfo,
  InitState,
  OnProgress,
} from '../../core/types.js';
import type {
  LLMAdapter,
  LLMCapabilities,
  LLMChatOptions,
  LLMMessage,
  LLMModel,
  LLMResponse,
  WebLLMOptions,
} from './types.js';
import { RECOMMENDED_MODELS } from './types.js';

// Default model - small and fast
const DEFAULT_MODEL = 'SmolLM2-360M-Instruct-q4f16_1-MLC';

/**
 * WebLLM adapter for in-browser LLM inference
 */
export class WebLLMAdapter implements LLMAdapter {
  readonly type = 'webllm' as const;

  private _initState: InitState = 'uninitialized';
  private _currentModel: string | null = null;
  private options: WebLLMOptions;

  // WebLLM engine instance
  private engine: any = null;

  constructor(options: WebLLMOptions = {}) {
    this.options = {
      defaultModel: DEFAULT_MODEL,
      ...options,
    };
  }

  get initState(): InitState {
    return this._initState;
  }

  get currentModel(): string | null {
    return this._currentModel;
  }

  async ensureInitialized(
    modelId?: string,
    onProgress?: OnProgress,
  ): Promise<void> {
    const targetModel = modelId || this.options.defaultModel || DEFAULT_MODEL;

    // Already loaded with the right model
    if (this._initState === 'ready' && this._currentModel === targetModel) {
      return;
    }

    // If we have a different model loaded, unload it first
    if (this._currentModel && this._currentModel !== targetModel) {
      await this.unloadModel();
    }

    if (this._initState === 'initializing') {
      return new Promise((resolve, reject) => {
        const check = () => {
          if (this._initState === 'ready') resolve();
          else if (this._initState === 'error')
            reject(new Error('Initialization failed'));
          else setTimeout(check, 100);
        };
        check();
      });
    }

    this._initState = 'initializing';

    try {
      // Check WebGPU support
      if (!('gpu' in navigator)) {
        throw new CapabilityNotAvailableError('WebGPU', 'webllm');
      }

      // Dynamically import WebLLM
      const webllm = await this.importWebLLM();

      // Create progress callback wrapper
      const progressCallback = (report: any) => {
        if (!onProgress) return;

        const progress: DownloadProgressInfo = {
          state: 'downloading',
          bytesLoaded: 0,
          bytesTotal: 0,
          percent: Math.round(report.progress * 100),
          currentFile: report.text,
        };

        if (report.progress >= 1) {
          progress.state = 'complete';
        }

        onProgress(progress);
      };

      // Create MLCEngine
      this.engine = await webllm.CreateMLCEngine(targetModel, {
        initProgressCallback: progressCallback,
        appConfig: this.options.appConfig,
      });

      this._currentModel = targetModel;
      this._initState = 'ready';

      onProgress?.({
        state: 'complete',
        bytesLoaded: 100,
        bytesTotal: 100,
        percent: 100,
      });
    } catch (error) {
      this._initState = 'error';

      if (error instanceof Error) {
        if (error.message.includes('WebGPU')) {
          throw new CapabilityNotAvailableError('WebGPU', 'webllm');
        }
        throw new ModelLoadError(targetModel, error.message, 'webllm');
      }

      throw new InitializationError('webllm', String(error));
    }
  }

  private async importWebLLM(): Promise<any> {
    try {
      return await import('@mlc-ai/web-llm');
    } catch {
      throw new InitializationError(
        'webllm',
        '@mlc-ai/web-llm not installed. Run: npm install @mlc-ai/web-llm',
      );
    }
  }

  async getCapabilities(): Promise<LLMCapabilities> {
    const webgpu = typeof navigator !== 'undefined' && 'gpu' in navigator;

    // Convert recommended models to LLMModel format
    const models: LLMModel[] = Object.entries(RECOMMENDED_MODELS).map(
      ([_key, model]) => ({
        id: model.id,
        name: model.name,
        contextLength: model.contextLength,
        downloadSize: model.downloadSize,
      }),
    );

    return {
      models,
      streaming: true,
      maxContextLength: 32768, // Qwen2.5 has highest
      requiresDownload: true,
      webgpu,
    };
  }

  async chat(
    messages: LLMMessage[],
    options: LLMChatOptions = {},
  ): Promise<LLMResponse> {
    await this.ensureInitialized(options.model);

    if (!this.engine) {
      throw new Error('Engine not initialized');
    }

    const response = await this.engine.chat.completions.create({
      messages: messages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
      model: this._currentModel,
      max_tokens: options.maxTokens,
      temperature: options.temperature,
      top_p: options.topP,
      stop: options.stop,
      stream: false,
    });

    const choice = response.choices[0];

    return {
      content: choice.message?.content || '',
      usage: response.usage
        ? {
            promptTokens: response.usage.prompt_tokens,
            completionTokens: response.usage.completion_tokens,
            totalTokens: response.usage.total_tokens,
          }
        : undefined,
      finishReason: choice.finish_reason as 'stop' | 'length' | undefined,
      model: this._currentModel || undefined,
    };
  }

  async *stream(
    messages: LLMMessage[],
    options: LLMChatOptions = {},
  ): AsyncIterable<string> {
    await this.ensureInitialized(options.model);

    if (!this.engine) {
      throw new Error('Engine not initialized');
    }

    const stream = await this.engine.chat.completions.create({
      messages: messages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
      model: this._currentModel,
      max_tokens: options.maxTokens,
      temperature: options.temperature,
      top_p: options.topP,
      stop: options.stop,
      stream: true,
    });

    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content;
      if (content) {
        if (options.onToken) {
          options.onToken(content);
        }
        yield content;
      }
    }
  }

  async message(
    text: string,
    options: LLMChatOptions & { systemPrompt?: string } = {},
  ): Promise<string> {
    const messages: LLMMessage[] = [];

    if (options.systemPrompt) {
      messages.push({
        role: 'system',
        content: options.systemPrompt,
      });
    }

    messages.push({
      role: 'user',
      content: text,
    });

    const response = await this.chat(messages, options);
    return response.content;
  }

  async countTokens(text: string): Promise<number> {
    // WebLLM doesn't expose tokenizer directly
    // Use rough estimation: ~4 chars per token for English
    return Math.ceil(text.length / 4);
  }

  async unloadModel(): Promise<void> {
    if (this.engine) {
      try {
        await this.engine.unload();
      } catch {
        // Ignore unload errors
      }
      this.engine = null;
    }
    this._currentModel = null;
    this._initState = 'uninitialized';
  }

  async dispose(): Promise<void> {
    await this.unloadModel();
  }
}
