/**
 * Tenancy Module UI Slot Declarations
 *
 * This file defines the UI extension points for the tenancy module.
 * UI components are implemented in the ./svelte subpath.
 */

import type { ModuleUISlot, SmrtModuleMeta } from '@happyvertical/smrt-types';

/**
 * Tenancy module UI slots
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
    category: 'navigation',
    order: 2,
    propsInterface: 'TenantSwitcherProps',
  },
};

/**
 * Tenancy module metadata
 */
export const TENANCY_MODULE_META: SmrtModuleMeta = {
  name: '@happyvertical/smrt-tenancy',
  displayName: 'Tenancy',
  description: 'Multi-tenancy framework with automatic tenant isolation',
  uiSlots: TENANCY_UI_SLOTS,
  models: ['Tenant', 'TenantContext'],
  collections: ['TenantCollection'],
};
