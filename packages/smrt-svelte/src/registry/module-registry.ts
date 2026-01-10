/**
 * ModuleUIRegistry - Global registry for module UI components
 *
 * This mirrors the AgentUIRegistry pattern from @happyvertical/smrt-agents
 * but for general SMRT modules that want to provide Svelte UI components.
 *
 * @example Registering components (in module's svelte subpath)
 * ```typescript
 * // packages/commerce/src/svelte/index.ts
 * import { ModuleUIRegistry } from '@happyvertical/smrt-svelte/registry';
 * import { COMMERCE_MODULE_META } from '../ui.js';
 * import InvoiceCard from './components/InvoiceCard.svelte';
 *
 * ModuleUIRegistry.registerModule(COMMERCE_MODULE_META);
 * ModuleUIRegistry.register('@happyvertical/smrt-commerce', 'invoice-card', InvoiceCard);
 *
 * export { InvoiceCard };
 * ```
 *
 * @example Using components (in host app)
 * ```typescript
 * // SvelteKit app
 * import { ModuleUIRegistry } from '@happyvertical/smrt-svelte/registry';
 * import '@happyvertical/smrt-commerce/svelte'; // Auto-registers components
 *
 * const InvoiceCard = ModuleUIRegistry.get('@happyvertical/smrt-commerce', 'invoice-card');
 * ```
 */

import type {
  ModuleComponentType,
  ModuleUIRegistryInterface,
  SmrtModuleMeta,
} from '@happyvertical/smrt-types';

/**
 * Create a new module UI registry
 *
 * Follows the same pattern as createUIRegistry() in smrt-agents.
 */
export function createModuleUIRegistry(): ModuleUIRegistryInterface {
  // biome-ignore lint/suspicious/noExplicitAny: ComponentType needs any
  const components = new Map<string, ModuleComponentType<any>>();
  const modules = new Map<string, SmrtModuleMeta>();

  const makeKey = (moduleName: string, slotId: string) =>
    `${moduleName}:${slotId}`;

  return {
    register(moduleName, slotId, component) {
      components.set(makeKey(moduleName, slotId), component);
    },

    get(moduleName, slotId) {
      return components.get(makeKey(moduleName, slotId));
    },

    has(moduleName, slotId) {
      return components.has(makeKey(moduleName, slotId));
    },

    getSlots(moduleName) {
      const prefix = `${moduleName}:`;
      return Array.from(components.keys())
        .filter((k) => k.startsWith(prefix))
        .map((k) => k.slice(prefix.length));
    },

    getModules() {
      return Array.from(modules.keys());
    },

    getModuleMeta(moduleName) {
      return modules.get(moduleName);
    },

    registerModule(meta) {
      modules.set(meta.name, meta);
    },

    unregister(moduleName, slotId) {
      return components.delete(makeKey(moduleName, slotId));
    },

    clear() {
      components.clear();
      modules.clear();
    },
  };
}

/**
 * Global ModuleUIRegistry singleton
 *
 * Module UI packages register their components here at import time,
 * enabling discovery by host applications.
 *
 * @example
 * ```typescript
 * // In module svelte package (e.g., @happyvertical/smrt-commerce/svelte)
 * import { ModuleUIRegistry } from '@happyvertical/smrt-svelte/registry';
 * import InvoiceCard from './InvoiceCard.svelte';
 *
 * ModuleUIRegistry.register('@happyvertical/smrt-commerce', 'invoice-card', InvoiceCard);
 *
 * // In host SvelteKit app
 * import { ModuleUIRegistry } from '@happyvertical/smrt-svelte/registry';
 * import '@happyvertical/smrt-commerce/svelte'; // Registers components
 *
 * const Component = ModuleUIRegistry.get('@happyvertical/smrt-commerce', 'invoice-card');
 * ```
 */
export const ModuleUIRegistry: ModuleUIRegistryInterface =
  createModuleUIRegistry();
