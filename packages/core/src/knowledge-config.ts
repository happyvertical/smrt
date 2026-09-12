import type { DomainKnowledgeConfig } from '@happyvertical/smrt-types';

export const DEFAULT_KNOWLEDGE_CONFIG: DomainKnowledgeConfig = {
  enabled: true,
  api: {
    enabled: false,
    basePath: '/__smrt/knowledge',
    requireAdmin: true,
    includeDocs: false,
    includePrompts: false,
  },
  includeDocs: true,
  includePrompts: true,
};

/** Resolve the file and package portions of the documented knowledge precedence. */
export async function resolveFileKnowledgeConfig(
  rootDir: string,
  packageName: string | undefined,
): Promise<DomainKnowledgeConfig> {
  let fileKnowledge: DomainKnowledgeConfig = {};
  let packageKnowledge: DomainKnowledgeConfig = {};
  try {
    const { loadConfig } = await import('@happyvertical/smrt-config');
    const config = await loadConfig({ cache: false, searchFrom: rootDir });
    fileKnowledge = (config.knowledge ?? {}) as DomainKnowledgeConfig;
    packageKnowledge = (
      packageName ? (config.packages?.[packageName]?.knowledge ?? {}) : {}
    ) as DomainKnowledgeConfig;
  } catch {
    fileKnowledge = {};
    packageKnowledge = {};
  }

  return mergeKnowledgeConfig(
    DEFAULT_KNOWLEDGE_CONFIG,
    fileKnowledge,
    packageKnowledge,
  );
}

export function mergeKnowledgeConfig(
  ...configs: Array<DomainKnowledgeConfig | undefined | null | false>
): DomainKnowledgeConfig {
  const merged: DomainKnowledgeConfig = {};
  for (const next of configs) {
    if (!next) continue;
    const hasApi = Boolean(merged.api || next.api);
    const api = hasApi
      ? { ...(merged.api ?? {}), ...(next.api ?? {}) }
      : undefined;
    Object.assign(merged, next);
    if (api) merged.api = api;
  }
  return merged;
}
