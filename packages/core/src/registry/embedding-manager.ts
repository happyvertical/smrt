/**
 * Embedding configuration management for the SMRT ObjectRegistry.
 *
 * Handles class-level and project-level embedding config resolution.
 *
 * Extracted from registry.ts as part of issue #1006.
 * @see https://github.com/happyvertical/smrt/issues/1006
 */

import {
  getSmrtModuleConfig,
  type SmrtGlobalConfig,
} from '../config/global-config.js';
import type {
  ClassEmbeddingConfig,
  ProjectEmbeddingConfig,
  ResolvedEmbeddingConfig,
} from '../embeddings/types';
import { findClass } from './name-resolver';
import { getClasses } from './shared-state';

/**
 * Get embedding configuration for a class.
 */
export function getEmbeddingConfig(
  className: string,
): ClassEmbeddingConfig | undefined {
  const registered = findClass(className);
  if (!registered?.config?.embeddings) {
    return undefined;
  }
  return registered.config.embeddings as ClassEmbeddingConfig;
}

/**
 * Check if a class has embeddings enabled.
 */
export function hasEmbeddings(className: string): boolean {
  const config = getEmbeddingConfig(className);
  return config !== undefined && config.fields.length > 0;
}

/**
 * Get all registered classes that have embeddings enabled.
 */
export function getEmbeddingClasses(): string[] {
  const embeddingClasses: string[] = [];
  for (const [_key, entry] of getClasses()) {
    const simpleName = entry.name || _key;
    if (hasEmbeddings(simpleName)) {
      embeddingClasses.push(simpleName);
    }
  }
  return embeddingClasses;
}

/**
 * Get project-level embedding configuration with defaults applied.
 */
export function getProjectEmbeddingConfig(): ProjectEmbeddingConfig {
  const globalConfig = getSmrtModuleConfig<SmrtGlobalConfig>('smrt', {});
  const embeddingConfig = globalConfig?.embeddings;

  return {
    dimensions: embeddingConfig?.dimensions ?? 768,
    provider: embeddingConfig?.provider ?? 'local',
    localModel: embeddingConfig?.localModel ?? 'Xenova/bge-base-en-v1.5',
    aiModel: embeddingConfig?.aiModel ?? 'text-embedding-3-small',
    fallbackToAI: embeddingConfig?.fallbackToAI ?? false,
    storage: embeddingConfig?.storage ?? 'json',
  };
}

/**
 * Resolve complete embedding configuration for a class.
 * Merges project-level config with class-level overrides.
 */
export function resolveEmbeddingConfig(
  className: string,
): ResolvedEmbeddingConfig | undefined {
  const classConfig = getEmbeddingConfig(className);
  if (!classConfig) {
    return undefined;
  }

  const projectConfig = getProjectEmbeddingConfig();

  return {
    fields: classConfig.fields,
    combinedField: classConfig.combinedField,
    dimensions: projectConfig.dimensions,
    provider: classConfig.provider ?? projectConfig.provider,
    localModel: projectConfig.localModel ?? 'Xenova/bge-base-en-v1.5',
    aiModel: projectConfig.aiModel ?? 'text-embedding-3-small',
    fallbackToAI: projectConfig.fallbackToAI ?? false,
    autoGenerate: classConfig.autoGenerate ?? true,
    regenerateOnChange: classConfig.regenerateOnChange ?? true,
  };
}
