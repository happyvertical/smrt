/**
 * Registry exports for SMRT module UI components
 */

// Re-export types for convenience
export type {
  ModuleComponentType,
  ModuleUIBaseProps,
  ModuleUIRegistryInterface,
  ModuleUISlot,
  SmrtModuleMeta,
} from '@happyvertical/smrt-types';
export { createModuleUIRegistry, ModuleUIRegistry } from './module-registry.js';
