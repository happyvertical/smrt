import type { PlaybookDefinition, PlaybookDefinitionInput } from './types.js';
import { normalizePlaybookDefinitionInput } from './utils.js';

declare global {
  // eslint-disable-next-line no-var
  var __smrtPlaybookRegistry: Map<string, PlaybookDefinition> | undefined;
}

function getRegistry(): Map<string, PlaybookDefinition> {
  if (!globalThis.__smrtPlaybookRegistry) {
    globalThis.__smrtPlaybookRegistry = new Map<string, PlaybookDefinition>();
  }

  return globalThis.__smrtPlaybookRegistry;
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

/**
 * Global process registry of code-default playbooks, keyed by namespaced key.
 *
 * Held on `globalThis` so it survives HMR, mirroring `PromptRegistry`.
 */
export const PlaybookRegistry = {
  register(input: PlaybookDefinitionInput): PlaybookDefinition {
    const definition = normalizePlaybookDefinitionInput(input);
    const registry = getRegistry();
    const existing = registry.get(definition.key);

    if (existing) {
      const existingSignature = stableStringify(existing);
      const incomingSignature = stableStringify(definition);

      if (existingSignature !== incomingSignature) {
        throw new Error(
          `Playbook "${definition.key}" is already registered with a different definition`,
        );
      }

      return existing;
    }

    registry.set(definition.key, definition);
    return definition;
  },

  get(key: string): PlaybookDefinition | undefined {
    return getRegistry().get(key);
  },

  has(key: string): boolean {
    return getRegistry().has(key);
  },

  getAll(): PlaybookDefinition[] {
    return Array.from(getRegistry().values());
  },

  clear(): void {
    getRegistry().clear();
  },
};

/**
 * Registers a code-default playbook. Packages call this at import time so a
 * bundled playbook resolves without any application registration.
 */
export function definePlaybook(
  input: PlaybookDefinitionInput,
): PlaybookDefinition {
  return PlaybookRegistry.register(input);
}
