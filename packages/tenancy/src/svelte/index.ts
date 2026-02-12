/**
 * Tenancy Module Svelte Components
 *
 * Optional Svelte UI components for tenant management.
 * Auto-registers components with ModuleUIRegistry on import.
 *
 * @packageDocumentation
 */

import { ModuleUIRegistry } from '@happyvertical/smrt-svelte/registry';
import { TENANCY_MODULE_META } from '../ui.js';

// Import components
import TenantCard from './components/TenantCard.svelte';
import TenantSwitcher from './components/TenantSwitcher.svelte';

// Export components
export { TenantCard, TenantSwitcher };

// Export component prop types
export type { Props as TenantCardProps } from './components/TenantCard.svelte';
export type { Props as TenantSwitcherProps } from './components/TenantSwitcher.svelte';

// Auto-register with ModuleUIRegistry
ModuleUIRegistry.registerModule(TENANCY_MODULE_META);
ModuleUIRegistry.register(
  '@happyvertical/smrt-tenancy',
  'tenant-card',
  TenantCard,
);
ModuleUIRegistry.register(
  '@happyvertical/smrt-tenancy',
  'tenant-switcher',
  TenantSwitcher,
);
