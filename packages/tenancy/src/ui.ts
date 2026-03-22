/**
 * Tenancy Module UI Slot Declarations
 *
 * This file defines the UI extension points for the tenancy module.
 * UI components are implemented in the ./svelte subpath.
 */

import type { ModuleUISlot, SmrtModuleMeta } from '@happyvertical/smrt-types';

/**
 * UI slot definitions for the tenancy module.
 *
 * Keyed by slot ID.  Each entry describes a named extension point where a
 * host application can render a tenancy UI component (e.g., tenant card,
 * tenant switcher).  Components are implemented in the `./svelte` subpath.
 *
 * @see TENANCY_MODULE_META
 */
export const TENANCY_UI_SLOTS: Record<string, ModuleUISlot> = {
  'tenant-card': {
    id: 'tenant-card',
    label: 'Tenant Card',
    description: 'Tenant information and management card',
    icon: 'building',
    category: 'display',
    order: 1,
    propsInterface: 'TenantCardProps',
  },
  'tenant-switcher': {
    id: 'tenant-switcher',
    label: 'Tenant Switcher',
    description: 'Dropdown for switching between tenants',
    icon: 'switch',
    category: 'form',
    order: 2,
    propsInterface: 'TenantSwitcherProps',
  },
};

/**
 * Module metadata for `@happyvertical/smrt-tenancy`.
 *
 * Consumed by the SMRT module system to register this package's display name,
 * description, data models, collections, and UI slots with the host application.
 *
 * @see TENANCY_UI_SLOTS
 */
export const TENANCY_MODULE_META: SmrtModuleMeta = {
  name: '@happyvertical/smrt-tenancy',
  displayName: 'Tenancy',
  description: 'Multi-tenancy framework with automatic tenant isolation',
  uiSlots: TENANCY_UI_SLOTS,
  models: ['Tenant', 'TenantContext'],
  collections: ['TenantCollection'],
};
