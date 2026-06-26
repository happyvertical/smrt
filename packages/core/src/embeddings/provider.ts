/**
 * Embedding Provider
 *
 * Unified interface for generating embeddings using local models or AI APIs.
 * Supports transformers.js packages for local inference and @happyvertical/ai
 * for cloud embeddings.
 */

import type { EmbeddingProviderType, ProjectEmbeddingConfig } from './types';

/**
 * Dynamically import an optional dependency.
 * Uses a variable to prevent TypeScript from statically analyzing the import.
 *
 * The resolved value is the imported module namespace; callers narrow it to a
 * concrete shape (e.g. {@link TransformersModule}) at the point of use.
 */
async function importOptional(moduleName: string): Promise<unknown> {
  // Using a variable prevents TypeScript from trying to resolve the module at compile time
  const name = moduleName;
  return import(/* @vite-ignore */ name);
}

export type OptionalModuleImporter = (moduleName: string) => Promise<unknown>;

export const LOCAL_TRANSFORMERS_PACKAGES = [
  '@huggingface/transformers',
  '@xenova/transformers',
] as const;

export type LocalTransformersPackage =
  (typeof LOCAL_TRANSFORMERS_PACKAGES)[number];

/**
 * Minimal surface of a transformers.js package used for local embeddings.
 * Only the `pipeline` factory is consumed; its result is narrowed to a
 * {@link FeatureExtractionPipeline} at the call site.
 */
export interface TransformersModule {
  pipeline: (task: string, model: string) => Promise<unknown>;
}

export interface TransformersModuleResolution {
  /**
   * The imported module namespace. Typed as `unknown` because the importer may
   * resolve arbitrary modules; consumers cast to {@link TransformersModule}.
   */
  module: unknown;
  packageName: LocalTransformersPackage;
}

function isModuleNotFoundError(error: unknown, moduleName: string): boolean {
  return (
    error instanceof Error &&
    (error.message.includes(`Cannot find module '${moduleName}'`) ||
      error.message.includes(`Cannot find package '${moduleName}'`))
  );
}

function formatTransformersResolutionError(
  attemptedPackages: readonly string[],
): Error {
  return new Error(
    `Local embeddings require one of: ${attemptedPackages.join(', ')}. ` +
      `Install one of them to use provider: "local", or switch to provider: "ai".`,
  );
}

export async function resolveLocalTransformersModule(
  importModule: OptionalModuleImporter = importOptional,
): Promise<TransformersModuleResolution> {
  for (const packageName of LOCAL_TRANSFORMERS_PACKAGES) {
    try {
      const module = await importModule(packageName);
      return { module, packageName };
    } catch (error) {
      if (!isModuleNotFoundError(error, packageName)) {
        throw error;
      }
    }
  }

  throw formatTransformersResolutionError(LOCAL_TRANSFORMERS_PACKAGES);
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
 * Pipeline type for local transformers packages
 */
type FeatureExtractionPipeline = (
  texts: string[],
  options?: { pooling?: string; normalize?: boolean },
) => Promise<{ tolist: () => number[][] }>;

/**
 * Embedding provider that supports both local and AI-based embedding generation.
 *
 * The "auto" provider prefers an already-configured AI embedding client.
 * Local transformer models are still available via provider: "local", but should
 * be an explicit choice for server workloads because model initialization can be
 * CPU and memory intensive.
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
    if (
      typeof ai === 'object' &&
      ai !== null &&
      typeof (ai as { embed?: unknown }).embed === 'function'
    ) {
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

    // 'auto' - use the configured AI client when present. This avoids
    // unexpectedly loading a large local transformer model inside app workers.
    // Local embeddings remain the explicit no-AI fallback for callers that
    // invoke embedding generation without an AI client.
    if (this.ai) {
      return this.embedWithAI(texts);
    }

    return this.embedLocal(texts);
  }

  /**
   * Generate embeddings using a local transformers model
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
    const { module } = await resolveLocalTransformersModule();
    // The resolved module is the transformers.js namespace; narrow to the
    // minimal surface we consume.
    const { pipeline } = module as TransformersModule;

    const model = this.config.localModel || 'Xenova/bge-base-en-v1.5';

    // Initialize the feature extraction pipeline
    const pipe = await pipeline('feature-extraction', model);

    return pipe as unknown as FeatureExtractionPipeline;
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
    if (
      this.config.provider === 'ai' ||
      (this.config.provider === 'auto' && this.ai)
    ) {
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
      await resolveLocalTransformersModule();
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
};
