/**
 * Display components - Read-only presentation components
 */

// Export components
export { default as ConfidenceBadge } from './ConfidenceBadge.svelte';
export { default as CurrencyDisplay } from './CurrencyDisplay.svelte';
export { default as DateDisplay } from './DateDisplay.svelte';
export { default as Icon } from './Icon.svelte';
export { default as StatusBadge } from './StatusBadge.svelte';

// Note: Component prop types (ConfidenceBadgeProps, etc.) are available
// via svelte-package build output but cannot be re-exported here because
// tsc --noEmit cannot resolve type exports from .svelte files.

// Re-export types from types file
export type { StatusType } from './types.js';
