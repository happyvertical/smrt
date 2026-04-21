/**
 * SMRT Template UI Components
 *
 * Reusable UI components for product management.
 * These components work with SMRT-generated types and can be:
 * - Imported as NPM package components
 * - Consumed via module federation
 * - Used in the standalone application
 */

// Self-register this package's manifest for consumers that import via this
// subpath without the main entry. See src/__smrt-register__.ts (issue #1132).
import '../../__smrt-register__.js';

export { default as ProductCard } from './ProductCard.svelte';
export { default as ProductForm } from './ProductForm.svelte';
