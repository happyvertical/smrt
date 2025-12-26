/**
 * Embedding Provider
 *
 * Unified interface for generating embeddings using local models or AI APIs.
 * Supports @xenova/transformers for local inference and @happyvertical/ai for cloud.
 */

import type { EmbeddingProviderType, ProjectEmbeddingConfig } from './types';

/**
 * Dynamically import an optional dependency.
 * Uses a variable to prevent TypeScript from statically analyzing the import.
 */
async function importOptional(moduleName: string): Promise<any> {
  // Using a variable prevents TypeScript from trying to resolve the module at compile time
  const name = moduleName;
  return import(/* @vite-ignore */ name);
}

/**
 * Interface for AI client that can generate embeddings
 */
interface EmbeddingCapableAI {
  embed(
    text: string | string[],
    options?: { model?: string; dimensions?: number },
  ): Promise<{ embeddings: number[][] }>;
}

/**
 * Pipeline type for @xenova/transformers
 */
type FeatureExtractionPipeline = (
  texts: string[],
  options?: { pooling?: string; normalize?: boolean },
) => Promise<{ tolist: () => number[][] }>;

/**
 * Embedding provider that supports both local and AI-based embedding generation
 */
export class EmbeddingProvider {
  private localPipeline: FeatureExtractionPipeline | null = null;
  private localPipelineLoading: Promise<FeatureExtractionPipeline> | null =
    null;
  private config: ProjectEmbeddingConfig;
  private ai: EmbeddingCapableAI | null;

  /**
   * Create an embedding provider
   *
   * @param config - Project embedding configuration
   * @param ai - Optional AI client for cloud embeddings (must have embed method)
   */
  constructor(config: ProjectEmbeddingConfig, ai?: unknown) {
    this.config = config;
    // Cast to EmbeddingCapableAI if it has an embed method
    if (ai && typeof (ai as any).embed === 'function') {
      this.ai = ai as EmbeddingCapableAI;
    } else {
      this.ai = null;
    }
  }

  /**
   * Generate embeddings for text(s)
   *
   * @param text - Single string or array of strings to embed
   * @param providerOverride - Override the configured provider
   * @returns Array of embedding vectors
   */
  async embed(
    text: string | string[],
    providerOverride?: EmbeddingProviderType,
  ): Promise<number[][]> {
    const provider = providerOverride || this.config.provider;
    const texts = Array.isArray(text) ? text : [text];

    if (provider === 'local') {
      return this.embedLocal(texts);
    }

    if (provider === 'ai') {
      return this.embedWithAI(texts);
    }

    // 'auto' - try local first, fallback to AI
    try {
      return await this.embedLocal(texts);
    } catch (error) {
      if (this.config.fallbackToAI && this.ai) {
        console.warn(
          `Local embedding failed, falling back to AI: ${error instanceof Error ? error.message : error}`,
        );
        return this.embedWithAI(texts);
      }
      throw error;
    }
  }

  /**
   * Generate embeddings using local model (@xenova/transformers)
   */
  private async embedLocal(texts: string[]): Promise<number[][]> {
    const pipeline = await this.getLocalPipeline();
    const results = await pipeline(texts, { pooling: 'mean', normalize: true });
    return results.tolist();
  }

  /**
   * Get or initialize the local embedding pipeline
   */
  private async getLocalPipeline(): Promise<FeatureExtractionPipeline> {
    if (this.localPipeline) {
      return this.localPipeline;
    }

    // Prevent multiple concurrent initializations
    if (this.localPipelineLoading) {
      return this.localPipelineLoading;
    }

    this.localPipelineLoading = this.initLocalPipeline();

    try {
      this.localPipeline = await this.localPipelineLoading;
      return this.localPipeline;
    } finally {
      this.localPipelineLoading = null;
    }
  }

  /**
   * Initialize the local embedding pipeline
   */
  private async initLocalPipeline(): Promise<FeatureExtractionPipeline> {
    try {
      // Dynamic import for optional dependency
      const transformers = await importOptional('@xenova/transformers');
      const { pipeline } = transformers;

      const model = this.config.localModel || 'Xenova/bge-base-en-v1.5';

      // Initialize the feature extraction pipeline
      const pipe = await pipeline('feature-extraction', model);

      return pipe as unknown as FeatureExtractionPipeline;
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes("Cannot find module '@xenova/transformers'")
      ) {
        throw new Error(
          'Local embeddings require @xenova/transformers. ' +
            'Install it with: pnpm add @xenova/transformers\n' +
            'Or use provider: "ai" in your embedding configuration.',
        );
      }
      throw error;
    }
  }

  /**
   * Generate embeddings using AI API
   */
  private async embedWithAI(texts: string[]): Promise<number[][]> {
    if (!this.ai) {
      throw new Error(
        'AI client not available for embeddings. ' +
          'Either configure an AI client or use provider: "local".',
      );
    }

    const model = this.config.aiModel || 'text-embedding-3-small';
    const response = await this.ai.embed(texts, {
      model,
      dimensions: this.config.dimensions,
    });

    return response.embeddings;
  }

  /**
   * Get the model name being used
   */
  getModelName(): string {
    if (this.config.provider === 'ai') {
      return this.config.aiModel || 'text-embedding-3-small';
    }
    return this.config.localModel || 'Xenova/bge-base-en-v1.5';
  }

  /**
   * Get the configured dimensions
   */
  getDimensions(): number {
    return this.config.dimensions;
  }

  /**
   * Check if local embeddings are available
   */
  async isLocalAvailable(): Promise<boolean> {
    try {
      await importOptional('@xenova/transformers');
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Check if AI embeddings are available
   */
  isAIAvailable(): boolean {
    return this.ai !== null;
  }
}

/**
 * Default project embedding configuration
 */
export const DEFAULT_EMBEDDING_CONFIG: ProjectEmbeddingConfig = {
  dimensions: 768,
  provider: 'local',
  localModel: 'Xenova/bge-base-en-v1.5',
  aiModel: 'text-embedding-3-small',
  fallbackToAI: true,
};
