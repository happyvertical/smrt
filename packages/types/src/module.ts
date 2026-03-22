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
 * UI slot definition for a SMRT module.
 *
 * Modules declare the slots they support in their `SmrtModuleMeta`. Svelte UI
 * packages then implement those slots by registering components against the
 * same `id` via `ModuleUIRegistryInterface.register()`.
 *
 * @example
 * ```typescript
 * const slot: ModuleUISlot = {
 *   id: 'invoice-card',
 *   label: 'Invoice Card',
 *   description: 'Compact card view for a single invoice',
 *   category: 'display',
 *   order: 10,
 * };
 * ```
 *
 * @see {@link SmrtModuleMeta} for how slots are declared on a module
 * @see {@link ModuleUIRegistryInterface} for registering component implementations
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
  category?:
    | 'display'
    | 'form'
    | 'admin'
    | 'list'
    | 'detail'
    | 'action'
    | 'dashboard'
    | 'navigation';
  /** Required props interface name (for documentation) */
  propsInterface?: string;
}

/**
 * Metadata declaration for a SMRT module.
 *
 * Each module exports a `SmrtModuleMeta` constant describing its package
 * identity, the UI slots it declares, and the model/collection classes it
 * provides. The UI registry uses this to resolve component lookups at runtime.
 *
 * @example
 * ```typescript
 * export const COMMERCE_MODULE_META: SmrtModuleMeta = {
 *   name: '@happyvertical/smrt-commerce',
 *   displayName: 'Commerce',
 *   description: 'Invoicing, contracts, and fulfillment',
 *   models: ['Customer', 'Invoice', 'Contract'],
 *   uiSlots: {
 *     'invoice-card': { id: 'invoice-card', label: 'Invoice Card', category: 'display' },
 *   },
 * };
 * ```
 *
 * @see {@link ModuleUISlot} for the shape of each declared slot
 * @see {@link ModuleUIRegistryInterface} for registering and retrieving module components
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
 * Generic component type for SMRT module UI slots.
 *
 * Intentionally opaque — defined as a loose function signature rather than
 * `import('svelte').ComponentType` to avoid pulling Svelte (and its DOM types)
 * into server-side Node.js builds. The actual Svelte component constructor
 * is assignable to this type at runtime.
 *
 * @typeParam Props - The props interface the component accepts; defaults to `unknown`.
 *
 * @example
 * ```typescript
 * import InvoiceCard from './InvoiceCard.svelte';
 * // InvoiceCard is assignable to ModuleComponentType<InvoiceCardProps>
 * registry.register('@happyvertical/smrt-commerce', 'invoice-card', InvoiceCard);
 * ```
 *
 * @see {@link ModuleUIBaseProps} for the base props all slot components receive
 * @see {@link ModuleUIRegistryInterface} for storing and retrieving components
 */
// biome-ignore lint/suspicious/noExplicitAny: ComponentType needs any for generic component handling
export type ModuleComponentType<Props = unknown> = (...args: any[]) => any;

/**
 * Base props contract for all SMRT module UI slot components.
 *
 * Every component registered against a `ModuleUISlot` should accept at least
 * these props. Individual slot components may extend this interface with
 * slot-specific required props.
 *
 * @typeParam TData   - Shape of the primary data object(s) the component renders.
 * @typeParam TConfig - Shape of the optional configuration/settings object.
 *
 * @example
 * ```typescript
 * interface InvoiceCardProps extends ModuleUIBaseProps<Invoice> {
 *   showLineItems?: boolean;
 * }
 * ```
 *
 * @see {@link ModuleComponentType} for the component type that accepts these props
 * @see {@link ModuleUISlot} for the slot declaration that names the `propsInterface`
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
 * Registry interface for mapping SMRT module slots to Svelte components.
 *
 * Implemented by `ModuleUIRegistry` in `@happyvertical/smrt-svelte`. Consumers
 * call `register()` once per slot at Svelte package initialisation time and
 * `get()` when rendering to retrieve the correct component.
 *
 * @example
 * ```typescript
 * // Registration (in packages/commerce/src/svelte/index.ts)
 * ModuleUIRegistry.registerModule(COMMERCE_MODULE_META);
 * ModuleUIRegistry.register('@happyvertical/smrt-commerce', 'invoice-card', InvoiceCard);
 *
 * // Retrieval (in a host Svelte app)
 * const InvoiceCard = ModuleUIRegistry.get('@happyvertical/smrt-commerce', 'invoice-card');
 * ```
 *
 * @see {@link SmrtModuleMeta} for the module metadata structure passed to `registerModule()`
 * @see {@link ModuleUISlot} for the slot identifiers used as `slotId`
 * @see {@link ModuleComponentType} for the component type stored in the registry
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
