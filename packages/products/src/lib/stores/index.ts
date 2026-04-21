/**
 * SMRT Template Stores
 *
 * Svelte 5 rune-based state management for SMRT objects.
 * These stores integrate with auto-generated SMRT clients.
 */

// Self-register this package's manifest for consumers that import via this
// subpath without the main entry. See src/__smrt-register__.ts (issue #1132).
import '../../__smrt-register__.js';

export { ProductStoreClass, productStore } from './product-store.svelte';
