/**
 * Module type definitions for SMRT Framework
 *
 * These types allow SMRT modules to declare their capabilities,
 * including models, collections, and optional Svelte UI components.
 *
 * @example Module with UI components
 * ```typescript
 * // In core module: packages/commerce/src/ui.ts
 * import type { SmrtModuleMeta, ModuleUISlot } from '@happyvertical/smrt-types';
 *
 * export const COMMERCE_UI_SLOTS: Record<string, ModuleUISlot> = {
 *   'invoice-card': { id: 'invoice-card', label: 'Invoice Card', category: 'display' },
 * };
 *
 * export const COMMERCE_MODULE_META: SmrtModuleMeta = {
 *   name: '@happyvertical/smrt-commerce',
 *   displayName: 'Commerce',
 *   uiSlots: COMMERCE_UI_SLOTS,
 * };
 *
 * // In svelte subpath: packages/commerce/src/svelte/index.ts
 * import { ModuleUIRegistry } from '@happyvertical/smrt-svelte/registry';
 * import { COMMERCE_MODULE_META } from '../ui.js';
 * import InvoiceCard from './components/InvoiceCard.svelte';
 *
 * ModuleUIRegistry.registerModule(COMMERCE_MODULE_META);
 * ModuleUIRegistry.register('@happyvertical/smrt-commerce', 'invoice-card', InvoiceCard);
 * ```
 */

/**
 * UI slot definition for a module
 *
 * Modules declare slots they support; UI packages implement them.
 */
export interface ModuleUISlot {
  /** Unique identifier (e.g., 'invoice-card', 'customer-form') */
  id: string;
  /** Human-readable label */
  label: string;
  /** Description of the component's purpose */
  description?: string;
  /** Icon identifier (lucide icon names) */
  icon?: string;
  /** Display order (lower first) */
  order?: number;
  /** Component category for grouping */
  category?: 'display' | 'form' | 'admin' | 'list' | 'detail' | 'action';
  /** Required props interface name (for documentation) */
  propsInterface?: string;
}

/**
 * Module metadata declaration
 *
 * Modules export this to declare their UI extension points
 */
export interface SmrtModuleMeta {
  /** Package name (e.g., '@happyvertical/smrt-commerce') */
  name: string;
  /** Human-readable display name */
  displayName: string;
  /** Module description */
  description?: string;
  /** Module version */
  version?: string;
  /** UI slots this module declares */
  uiSlots?: Record<string, ModuleUISlot>;
  /** Model classes this module provides */
  models?: string[];
  /** Collection classes this module provides */
  collections?: string[];
  /** Peer dependencies for UI (e.g., ['@happyvertical/smrt-profiles']) */
  uiDependencies?: string[];
}

/**
 * Generic component type that doesn't require Svelte dependency
 *
 * Using a generic function type to avoid requiring svelte as a dependency
 * and to avoid DOM type references that don't exist in Node.js builds.
 */
// biome-ignore lint/suspicious/noExplicitAny: ComponentType needs any for generic component handling
export type ModuleComponentType<Props = unknown> = (...args: any[]) => any;

/**
 * Base props all module UI components receive
 *
 * Extends the agent pattern but made generic for modules
 */
export interface ModuleUIBaseProps<TData = unknown, TConfig = unknown> {
  /** Primary data object(s) the component operates on */
  data?: TData;
  /** Configuration/settings */
  config?: TConfig;
  /** Callback for data changes */
  onChange?: (data: TData) => void | Promise<void>;
  /** Callback for saving */
  onSave?: (data: TData) => Promise<void>;
  /** Whether component is read-only */
  readonly?: boolean;
  /** CSS class for styling */
  class?: string;
  /** Loading state */
  loading?: boolean;
}

/**
 * Module UI component registry interface
 *
 * Mirrors AgentUIComponentRegistry pattern for consistency
 */
export interface ModuleUIRegistryInterface {
  /** Register a component for a module's slot */
  register<TProps extends ModuleUIBaseProps>(
    moduleName: string,
    slotId: string,
    component: ModuleComponentType<TProps>,
  ): void;

  /** Get a component for a module's slot */
  get<TProps extends ModuleUIBaseProps>(
    moduleName: string,
    slotId: string,
  ): ModuleComponentType<TProps> | undefined;

  /** Check if component is registered */
  has(moduleName: string, slotId: string): boolean;

  /** Get all registered slot IDs for a module */
  getSlots(moduleName: string): string[];

  /** Get all registered module names */
  getModules(): string[];

  /** Get module metadata */
  getModuleMeta(moduleName: string): SmrtModuleMeta | undefined;

  /** Register module metadata */
  registerModule(meta: SmrtModuleMeta): void;

  /** Unregister for testing */
  unregister(moduleName: string, slotId: string): boolean;

  /** Clear all for testing */
  clear(): void;
}
