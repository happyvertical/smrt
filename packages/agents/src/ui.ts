import type {
  ModuleComponentType,
  ModuleUISlot,
  SmrtModuleMeta,
} from '@happyvertical/smrt-types';

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
 * Svelte component type for agent admin-panel slots.
 *
 * Re-exported from the canonical {@link ModuleComponentType} in
 * `@happyvertical/smrt-types` — the single shared definition that owns the
 * irreducible `any` (see its inline note: the placeholder must be assignable
 * both FROM arbitrary concrete components and TO Svelte's render union, which
 * no non-`any` type satisfies under `strictFunctionTypes`). Aliased here so
 * this package's public UI surface keeps the local `ComponentType` name.
 */
export type ComponentType<Props = unknown> = ModuleComponentType<Props>;

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

export type AgentSettingFieldType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'select'
  | 'textarea'
  | 'json';

export interface AgentSettingOption {
  value: string;
  label: string;
}

/** A non-secret setting that a host app can render without custom UI code. */
export interface AgentSettingField {
  id: string;
  label: string;
  type: AgentSettingFieldType;
  description?: string;
  required?: boolean;
  default?: unknown;
  placeholder?: string;
  options?: AgentSettingOption[];
  min?: number;
  max?: number;
}

/** Versioned contract for a schema-rendered agent settings panel. */
export interface AgentSettingsSchema {
  version: number;
  fields: AgentSettingField[];
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
  /** Whether the slot is currently unavailable in the admin UI */
  disabled?: boolean;
  /** Durable owner for settings written through this slot. */
  scope?: 'agent' | 'persona';
  /** Optional fallback form when the agent does not register a custom panel. */
  settingsSchema?: AgentSettingsSchema;
}

/**
 * Map of slot IDs to their definitions
 * Used as static property on Agent subclasses
 */
export type AgentUISlots = Record<string, AgentUISlot>;

/**
 * A route an agent provides for its admin UI
 *
 * Agents declare these so that host applications or tooling
 * (for example, a Vite plugin) can wire them into a SvelteKit app.
 *
 * @example
 * ```typescript
 * static adminRoutes: AgentAdminRoute[] = [
 *   { path: 'sources', component: 'SourcesPanel', load: 'loadSources' },
 *   { path: 'sources/[sourceId]', component: 'SourceDetail', load: 'loadSourceDetail' },
 * ];
 * ```
 */
export interface AgentAdminRoute {
  /** Route path relative to agent root (e.g., 'sources/[sourceId]') */
  path: string;
  /** Component export name from the agent's admin entry point */
  component: string;
  /** Optional: export name for server load function */
  load?: string;
}

/**
 * When an {@link AgentCreateEntry} is offered. Every condition given must
 * hold; the host supplies the facts through {@link AgentCreateEntryContext}.
 */
export interface AgentCreateEntryAvailability {
  /**
   * An agent manifest permission id (e.g. `manage:sources`) that must be
   * granted for the tenant (`SerializedAgent.permissions`).
   */
  permission?: string;
  /** Host access levels allowed to use it (e.g. `['admin', 'editor']`). */
  accessLevels?: string[];
  /** Host capability flags that must all be on (e.g. `['video']`). */
  requires?: string[];
}

/**
 * A "create" option an agent contributes to the host's create menu, declared
 * with `static createEntries` on the agent class and carried in its manifest.
 * It is plain data: the host decides where the menu lives, groups entries by
 * `type`/`format`, and builds the link from its own base path.
 *
 * @example
 * ```typescript
 * static override createEntries: AgentCreateEntry[] = [
 *   {
 *     id: 'meeting-article',
 *     type: 'news/politics',
 *     format: 'text',
 *     label: 'Write about a meeting',
 *     description: 'Pick a council meeting; its papers are linked for you.',
 *     icon: 'calendar',
 *     route: 'articles/new/source?for=meeting',
 *     availability: { accessLevels: ['admin', 'editor'] },
 *   },
 * ];
 * ```
 */
export interface AgentCreateEntry {
  /** Stable id, unique within the agent. */
  id: string;
  /** Host content type id the entry creates (e.g. `news/politics`). */
  type: string;
  /** Host-defined grouping within a type (e.g. `text`, `video`). */
  format?: string;
  /** Plain action name ("Write about a meeting"). */
  label: string;
  /** One line saying what happens. */
  description?: string;
  /** Icon name the host maps. */
  icon?: string;
  /**
   * Where creation starts, relative to the host's base path (may carry a
   * query string). Absolute and protocol-relative URLs are rejected.
   */
  route: string;
  /** Sort order within its type (lower first). */
  order?: number;
  availability?: AgentCreateEntryAvailability;
}

/** Facts the host supplies to {@link resolveAgentCreateEntries}. */
export interface AgentCreateEntryContext {
  /** Prefix for every entry's `route` (e.g. `/sites/bentley`). */
  basePath: string;
  /** The viewer's access level in the host's terms. */
  accessLevel?: string;
  /** Capability flags that are on (e.g. `video`). */
  capabilities?: Iterable<string>;
}

/** The agent facts `resolveAgentCreateEntries` reads (a `SerializedAgent` fits). */
export interface AgentCreateEntrySource {
  agentType: string;
  agentClass: string;
  createEntries?: AgentCreateEntry[];
  permissions?: Record<string, boolean>;
}

/** An available entry with its link built. */
export interface ResolvedAgentCreateEntry
  extends Omit<AgentCreateEntry, 'route' | 'availability'> {
  /** `<agentType>:<id>`, unique across agents. */
  key: string;
  agentType: string;
  agentClass: string;
  href: string;
}

function isRelativeRoute(route: string): boolean {
  const trimmed = route.trim();
  return (
    trimmed.length > 0 &&
    !trimmed.startsWith('//') &&
    !/^[a-z][a-z0-9+.-]*:/i.test(trimmed)
  );
}

/** Whether an entry is available for these agent permissions and host facts. */
export function isAgentCreateEntryAvailable(
  entry: AgentCreateEntry,
  permissions: Record<string, boolean> | undefined,
  context: Omit<AgentCreateEntryContext, 'basePath'>,
): boolean {
  const availability = entry.availability;
  if (!availability) return true;
  if (
    availability.permission &&
    permissions?.[availability.permission] !== true
  ) {
    return false;
  }
  if (
    availability.accessLevels &&
    (!context.accessLevel ||
      !availability.accessLevels.includes(context.accessLevel))
  ) {
    return false;
  }
  if (availability.requires?.length) {
    const on = new Set(context.capabilities ?? []);
    if (!availability.requires.every((flag) => on.has(flag))) return false;
  }
  return true;
}

/**
 * The create entries a host should offer: every available entry of the given
 * (already tenant-resolved, enabled) agents, with `href` built from
 * `basePath`, sorted by type, then `order`, then label. Entries whose route is
 * not relative are dropped.
 */
export function resolveAgentCreateEntries(
  agents: readonly AgentCreateEntrySource[],
  context: AgentCreateEntryContext,
): ResolvedAgentCreateEntry[] {
  const base = context.basePath.replace(/\/+$/, '');
  const resolved: ResolvedAgentCreateEntry[] = [];
  for (const agent of agents) {
    for (const entry of agent.createEntries ?? []) {
      if (!isRelativeRoute(entry.route)) continue;
      if (!isAgentCreateEntryAvailable(entry, agent.permissions, context)) {
        continue;
      }
      const { route, availability: _availability, ...rest } = entry;
      resolved.push({
        ...rest,
        key: `${agent.agentType}:${entry.id}`,
        agentType: agent.agentType,
        agentClass: agent.agentClass,
        href: `${base}/${route.trim().replace(/^\/+/, '')}`,
      });
    }
  }
  return resolved.sort(
    (a, b) =>
      a.type.localeCompare(b.type) ||
      (a.order ?? 100) - (b.order ?? 100) ||
      a.label.localeCompare(b.label),
  );
}

/**
 * Context passed to agent route load functions
 *
 * A normalized subset of SvelteKit's ServerLoadEvent,
 * so agent load functions don't need a direct SvelteKit dependency.
 */
export interface AgentRouteLoadContext {
  params: Record<string, string>;
  parent: () => Promise<Record<string, unknown>>;
  fetch: typeof fetch;
  url: URL;
}

/**
 * Agent route load function signature
 *
 * Returned data is spread into the page's `data` prop.
 */
export type AgentRouteLoadFn = (
  context: AgentRouteLoadContext,
) => Promise<Record<string, unknown>> | Record<string, unknown>;

/**
 * Agent manifest type (re-exported from smrt-core scanner types)
 * Duplicated here to avoid hard dependency on scanner internals
 */
export interface AgentManifestInfo {
  name: string;
  slug: string;
  icon?: string;
  tier: 'free' | 'standard' | 'premium';
  description?: string;
  uiSlots: Record<string, AgentUISlot>;
  adminRoutes?: AgentAdminRoute[];
  /** Create options this agent contributes (`static createEntries`) */
  createEntries?: AgentCreateEntry[];
  /** Default signal subscriptions declared by this agent */
  signalSubscriptions?: string[];
  permissions: Array<{
    id: string;
    label: string;
    category: string;
    defaultGranted?: boolean;
  }>;
  features: Array<{
    id: string;
    label: string;
    description?: string;
    type: string;
  }>;
  menuItems: Array<{
    id: string;
    label: string;
    icon?: string;
    order: number;
    path: string;
    requiredPermission?: string;
  }>;
  components: Array<{ exportPath: string; type: string }>;
}

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

  /** Register a component by composite key (e.g., 'praeco:sources') */
  registerByKey(key: string, component: ComponentType): void;

  /** Get a component by composite key */
  getByKey(key: string): ComponentType | undefined;

  /** Register an agent manifest for runtime access */
  registerManifest(agentClass: string, manifest: AgentManifestInfo): void;

  /** Get a registered agent manifest */
  getManifest(agentClass: string): AgentManifestInfo | undefined;

  /** Get all registered manifests */
  getAllManifests(): Map<string, AgentManifestInfo>;

  /** Register a route component for an agent */
  registerRouteComponent(
    agentClass: string,
    path: string,
    component: ComponentType,
  ): void;

  /** Get a route component for an agent */
  getRouteComponent(
    agentClass: string,
    path: string,
  ): ComponentType | undefined;

  /** Register a route load function for an agent */
  registerRouteLoad(
    agentClass: string,
    path: string,
    loadFn: AgentRouteLoadFn,
  ): void;

  /** Get a route load function for an agent */
  getRouteLoad(agentClass: string, path: string): AgentRouteLoadFn | undefined;
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
  const components = new Map<string, ComponentType>();
  const manifests = new Map<string, AgentManifestInfo>();
  const routeComponents = new Map<string, ComponentType>();
  const routeLoads = new Map<string, AgentRouteLoadFn>();

  const makeKey = (agentClass: string, slotId: string) =>
    `${agentClass}:${slotId}`;

  const makeRouteKey = (agentClass: string, path: string) =>
    `${agentClass}:route:${path}`;

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
      manifests.clear();
      routeComponents.clear();
      routeLoads.clear();
    },

    registerByKey(key, component) {
      components.set(key, component);
    },

    getByKey(key) {
      return components.get(key);
    },

    registerManifest(agentClass, manifest) {
      manifests.set(agentClass, manifest);
    },

    getManifest(agentClass) {
      return manifests.get(agentClass);
    },

    getAllManifests() {
      return new Map(manifests);
    },

    registerRouteComponent(agentClass, path, component) {
      routeComponents.set(makeRouteKey(agentClass, path), component);
    },

    getRouteComponent(agentClass, path) {
      return routeComponents.get(makeRouteKey(agentClass, path));
    },

    registerRouteLoad(agentClass, path, loadFn) {
      routeLoads.set(makeRouteKey(agentClass, path), loadFn);
    },

    getRouteLoad(agentClass, path) {
      return routeLoads.get(makeRouteKey(agentClass, path));
    },
  };
}

/**
 * Global UI registry singleton
 *
 * Agent UI packages register their components here at import time,
 * enabling discovery by host applications.
 *
 * Uses a `globalThis.__smrtAgentUIRegistry` property to guarantee a
 * single registry instance per JavaScript runtime, even when bundlers
 * (Vite, webpack) duplicate this module across optimized dependency
 * chunks or package versions.
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
declare global {
  // eslint-disable-next-line no-var
  var __smrtAgentUIRegistry: AgentUIComponentRegistry | undefined;
}

if (!globalThis.__smrtAgentUIRegistry) {
  globalThis.__smrtAgentUIRegistry = createUIRegistry();
}
export const AgentUIRegistry: AgentUIComponentRegistry =
  globalThis.__smrtAgentUIRegistry;

/**
 * What an agent's `./admin` entry point must export.
 *
 * This is the contract between agent packages and host apps.
 * Instead of registering individual slot components, agents export
 * a single root component that handles its own sub-navigation.
 *
 * @example
 * ```typescript
 * // In agent package: histrio/src/ui/admin/index.ts
 * export { default } from './AdminRoot.svelte';
 * export { createAPIClient } from '../types.js';
 * export const navItems: AgentAdminNavItem[] = [
 *   { id: 'characters', label: 'Characters', icon: 'users', order: 1 },
 *   { id: 'performers', label: 'Performers', icon: 'mic', order: 2 },
 * ];
 * ```
 */
export interface AgentAdminExport {
  /** Root admin component — renders all panels, handles its own sub-navigation */
  default?: ComponentType;
  /** Create a typed API client for this agent */
  createAPIClient?: (baseUrl: string) => unknown;
  /** Navigation items for tabs/sidebar within the agent admin */
  navItems?: AgentAdminNavItem[];
}

/**
 * Props passed to the root admin component
 */
export interface AgentAdminRootProps {
  /** Typed API client created by the agent's own factory */
  apiClient: unknown;
  /** Which panel to show (from URL hash, e.g., 'sources') */
  activePanel?: string;
  /** Called when user navigates within the agent */
  onNavigate?: (panelId: string) => void;
  /** Whether admin is in read-only mode */
  readonly?: boolean;
}

/**
 * Navigation item within an agent's admin UI
 */
export interface AgentAdminNavItem {
  /** Matches hash fragment and panel ID */
  id: string;
  /** Display label */
  label: string;
  /** Icon identifier */
  icon?: string;
  /** Display order (lower numbers first) */
  order?: number;
}

/**
 * Agents module UI slots (for ModuleUIRegistry)
 */
export const AGENTS_UI_SLOTS: Record<string, ModuleUISlot> = {
  'agent-dashboard': {
    id: 'agent-dashboard',
    label: 'Agent Dashboard',
    description: 'Combined overview panel for agent schedules',
    icon: 'activity',
    category: 'admin',
    order: 1,
    propsInterface: 'AgentDashboardProps',
  },
  'agent-schedule-list': {
    id: 'agent-schedule-list',
    label: 'Agent Schedule List',
    description: 'List of scheduled agents',
    icon: 'calendar',
    category: 'list',
    order: 2,
    propsInterface: 'AgentScheduleListProps',
  },
  'agent-schedule-form': {
    id: 'agent-schedule-form',
    label: 'Agent Schedule Form',
    description: 'Form for creating or editing agent schedules',
    icon: 'edit',
    category: 'form',
    order: 3,
    propsInterface: 'AgentScheduleFormProps',
  },
  'agent-run-history': {
    id: 'agent-run-history',
    label: 'Agent Run History',
    description: 'History of agent runs',
    icon: 'clock',
    category: 'list',
    order: 4,
    propsInterface: 'AgentRunHistoryProps',
  },
  'schedule-status-badge': {
    id: 'schedule-status-badge',
    label: 'Schedule Status Badge',
    description: 'Status indicator for schedule states',
    icon: 'tag',
    category: 'display',
    order: 5,
    propsInterface: 'ScheduleStatusBadgeProps',
  },
};

/**
 * Agents module metadata
 */
export const AGENTS_MODULE_META: SmrtModuleMeta = {
  name: '@happyvertical/smrt-agents',
  displayName: 'Agents',
  description: 'Agent framework for building autonomous actors',
  uiSlots: AGENTS_UI_SLOTS,
  models: ['Agent', 'AgentConfig', 'AgentSchedule', 'TenantAgent'],
  collections: [
    'AgentConfigCollection',
    'AgentScheduleCollection',
    'TenantAgentCollection',
  ],
};
