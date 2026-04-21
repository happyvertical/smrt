import type { PromptDefinition, PromptDefinitionInput } from './types.js';
import { normalizePromptDefinitionInput } from './utils.js';

declare global {
  // eslint-disable-next-line no-var
  var __smrtPromptRegistry: Map<string, PromptDefinition> | undefined;
}

function getRegistry(): Map<string, PromptDefinition> {
  if (!globalThis.__smrtPromptRegistry) {
    globalThis.__smrtPromptRegistry = new Map<string, PromptDefinition>();
  }

  return globalThis.__smrtPromptRegistry;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }

  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(
      ([left], [right]) => left.localeCompare(right),
    );
    return `{${entries
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(',')}}`;
  }

  return JSON.stringify(value);
}

export const PromptRegistry = {
  register(input: PromptDefinitionInput): PromptDefinition {
    if (!input.key || input.key.trim() === '') {
      throw new Error('Prompt definitions require a non-empty key');
    }

    const definition = normalizePromptDefinitionInput(input);
    const registry = getRegistry();
    const existing = registry.get(definition.key);

    if (existing) {
      const existingSignature = stableStringify(existing);
      const incomingSignature = stableStringify(definition);

      if (existingSignature !== incomingSignature) {
        throw new Error(
          `Prompt "${definition.key}" is already registered with a different definition`,
        );
      }

      return existing;
    }

    registry.set(definition.key, definition);
    return definition;
  },

  get(key: string): PromptDefinition | undefined {
    return getRegistry().get(key);
  },

  has(key: string): boolean {
    return getRegistry().has(key);
  },

  getAll(): PromptDefinition[] {
    return Array.from(getRegistry().values());
  },

  clear(): void {
    getRegistry().clear();
  },
};

export function definePrompt(input: PromptDefinitionInput): PromptDefinition {
  return PromptRegistry.register(input);
}
