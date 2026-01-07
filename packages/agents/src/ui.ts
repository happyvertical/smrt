/**
 * UI type definitions for SMRT Agents
 *
 * These types allow agents to declare admin panel UI slots
 * that can be implemented as Svelte components in agent packages.
 *
 * @example
 * ```typescript
 * import { AgentUIRegistry, type AdminPanelBaseProps } from '@happyvertical/smrt-agents/ui';
 *
 * // In agent package: register components at import time
 * AgentUIRegistry.register('MyAgent', 'settings', SettingsPanel);
 *
 * // In host app: use registered components
 * const Component = AgentUIRegistry.get('MyAgent', 'settings');
 * ```
 */

/**
 * Svelte component type (compatible with svelte's ComponentType)
 *
 * Using a generic function type to avoid requiring svelte as a dependency
 * and to avoid DOM type references that don't exist in Node.js builds.
 *
 * In practice, the actual Svelte component will be passed and used
 * with `<svelte:component this={Component} />` in SvelteKit apps.
 */
// biome-ignore lint/suspicious/noExplicitAny: ComponentType needs any for generic component handling
export type ComponentType<Props = any> = (
  // biome-ignore lint/suspicious/noExplicitAny: Component constructor signature
  ...args: any[]
  // biome-ignore lint/suspicious/noExplicitAny: Component instance type
) => any;

/**
 * Base props that all admin panel components receive
 */
export interface AdminPanelBaseProps<TConfig = unknown> {
  /** Current configuration from the agent (merged file + db) */
  config: TConfig;
  /** Callback to save configuration changes */
  onSave: (config: TConfig) => Promise<void>;
  /** Whether the panel is in read-only mode */
  readonly?: boolean;
  /** CSS class for styling integration */
  class?: string;
  /**
   * Read-only file-based configuration defaults (from smrt.config.js)
   * Use this to display which values come from the config file
   */
  fileConfig?: TConfig;
  /**
   * Editable database-persisted configuration overrides
   * Use this to display which values have been customized in the DB
   */
  dbConfig?: TConfig;
}

/**
 * Definition of a UI slot that an agent declares
 *
 * Agents define slots they support; UI packages implement them.
 */
export interface AgentUISlot {
  /** Unique identifier for this slot (e.g., 'sources', 'reports', 'settings') */
  id: string;
  /** Human-readable label for the slot */
  label: string;
  /** Description of what this panel configures */
  description?: string;
  /** Icon identifier (e.g., 'settings', 'database', 'users') */
  icon?: string;
  /** Display order (lower numbers first) */
  order?: number;
}

/**
 * Map of slot IDs to their definitions
 * Used as static property on Agent subclasses
 */
export type AgentUISlots = Record<string, AgentUISlot>;

/**
 * Registry of UI component implementations
 * Maps agent class name + slot ID to Svelte component
 */
export interface AgentUIComponentRegistry {
  /** Register a component for an agent's slot */
  register<TProps extends AdminPanelBaseProps>(
    agentClass: string,
    slotId: string,
    component: ComponentType<TProps>,
  ): void;

  /** Get a component for an agent's slot */
  get<TProps extends AdminPanelBaseProps>(
    agentClass: string,
    slotId: string,
  ): ComponentType<TProps> | undefined;

  /** Get all registered slot IDs for an agent */
  getSlots(agentClass: string): string[];

  /** Check if a component is registered */
  has(agentClass: string, slotId: string): boolean;

  /** Get all registered agent class names */
  getAgents(): string[];

  /** Unregister a component (useful for testing) */
  unregister(agentClass: string, slotId: string): boolean;

  /** Clear all registrations (useful for testing) */
  clear(): void;
}

/**
 * Create a new UI component registry
 *
 * @example
 * ```typescript
 * const registry = createUIRegistry();
 * registry.register('MyAgent', 'settings', SettingsPanel);
 *
 * const Component = registry.get('MyAgent', 'settings');
 * if (Component) {
 *   // Render component
 * }
 * ```
 */
export function createUIRegistry(): AgentUIComponentRegistry {
  // biome-ignore lint/suspicious/noExplicitAny: ComponentType needs any
  const components = new Map<string, ComponentType<any>>();

  const makeKey = (agentClass: string, slotId: string) =>
    `${agentClass}:${slotId}`;

  return {
    register(agentClass, slotId, component) {
      components.set(makeKey(agentClass, slotId), component);
    },

    get(agentClass, slotId) {
      return components.get(makeKey(agentClass, slotId));
    },

    getSlots(agentClass) {
      const prefix = `${agentClass}:`;
      return Array.from(components.keys())
        .filter((k) => k.startsWith(prefix))
        .map((k) => k.slice(prefix.length));
    },

    has(agentClass, slotId) {
      return components.has(makeKey(agentClass, slotId));
    },

    getAgents() {
      const agents = new Set<string>();
      for (const key of components.keys()) {
        const agentClass = key.split(':')[0];
        agents.add(agentClass);
      }
      return Array.from(agents);
    },

    unregister(agentClass, slotId) {
      return components.delete(makeKey(agentClass, slotId));
    },

    clear() {
      components.clear();
    },
  };
}

/**
 * Global UI registry singleton
 *
 * Agent UI packages register their components here at import time,
 * enabling discovery by host applications.
 *
 * @example
 * ```typescript
 * // In agent package (e.g., @happyvertical/praeco/admin)
 * import { AgentUIRegistry } from '@happyvertical/smrt-agents/ui';
 * import SourcesPanel from './SourcesPanel.svelte';
 *
 * AgentUIRegistry.register('Praeco', 'sources', SourcesPanel);
 *
 * // In host SvelteKit app
 * import { AgentUIRegistry } from '@happyvertical/smrt-agents/ui';
 * import '@happyvertical/praeco/admin'; // Registers components
 *
 * const Component = AgentUIRegistry.get('Praeco', 'sources');
 * ```
 */
export const AgentUIRegistry: AgentUIComponentRegistry = createUIRegistry();
