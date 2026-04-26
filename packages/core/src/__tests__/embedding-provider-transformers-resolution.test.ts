import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_EMBEDDING_CONFIG,
  EmbeddingProvider,
  resolveLocalTransformersModule,
} from '../embeddings/provider';

describe('EmbeddingProvider transformer resolution', () => {
  it('prefers @huggingface/transformers when both packages are available', async () => {
    const importModule = vi.fn(async (moduleName: string) => ({
      packageName: moduleName,
    }));

    const resolution = await resolveLocalTransformersModule(importModule);

    expect(resolution.packageName).toBe('@huggingface/transformers');
    expect(importModule).toHaveBeenCalledTimes(1);
    expect(importModule).toHaveBeenCalledWith('@huggingface/transformers');
  });

  it('falls back to @xenova/transformers when Hugging Face transformers is not installed', async () => {
    const importModule = vi.fn(async (moduleName: string) => {
      if (moduleName === '@huggingface/transformers') {
        throw new Error(
          "Cannot find package '@huggingface/transformers' imported from test",
        );
      }

      return { packageName: moduleName };
    });

    const resolution = await resolveLocalTransformersModule(importModule);

    expect(resolution.packageName).toBe('@xenova/transformers');
    expect(importModule).toHaveBeenNthCalledWith(
      1,
      '@huggingface/transformers',
    );
    expect(importModule).toHaveBeenNthCalledWith(2, '@xenova/transformers');
  });

  it('returns a helpful error when neither transformers package is installed', async () => {
    const importModule = vi.fn(async (moduleName: string) => {
      throw new Error(`Cannot find package '${moduleName}' imported from test`);
    });

    await expect(resolveLocalTransformersModule(importModule)).rejects.toThrow(
      'Local embeddings require one of: @huggingface/transformers, @xenova/transformers.',
    );
  });

  it('does not hide non-module runtime errors from the preferred package', async () => {
    const importModule = vi.fn(async () => {
      throw new Error('sharp native module failed to load');
    });

    await expect(resolveLocalTransformersModule(importModule)).rejects.toThrow(
      'sharp native module failed to load',
    );
  });
});

describe('EmbeddingProvider auto provider', () => {
  it('uses configured AI embeddings before local transformers', async () => {
    const ai = {
      embed: vi.fn(async () => ({ embeddings: [[1, 2, 3]] })),
    };
    const provider = new EmbeddingProvider(
      {
        ...DEFAULT_EMBEDDING_CONFIG,
        provider: 'auto',
        aiModel: 'test-ai-model',
        localModel: 'test-local-model',
        dimensions: 3,
      },
      ai,
    );

    await expect(provider.embed('hello')).resolves.toEqual([[1, 2, 3]]);
    expect(ai.embed).toHaveBeenCalledWith(['hello'], {
      model: 'test-ai-model',
      dimensions: 3,
    });
    expect(provider.getModelName()).toBe('test-ai-model');
  });

  it('keeps local model naming when auto has no AI client', () => {
    const provider = new EmbeddingProvider({
      ...DEFAULT_EMBEDDING_CONFIG,
      provider: 'auto',
      aiModel: 'test-ai-model',
      localModel: 'test-local-model',
    });

    expect(provider.getModelName()).toBe('test-local-model');
  });
});
