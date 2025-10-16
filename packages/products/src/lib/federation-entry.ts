/**
 * Federation Entry Point
 *
 * This file provides clean, browser-compatible exports for module federation
 * without any server-side dependencies or SMRT virtual modules.
 */

// Re-export browser-compatible UI components
export { default as ProductCard } from './components/ProductCard.svelte';
export { default as ProductForm } from './components/ProductForm.svelte';
export { default as CategoryManager } from './features/CategoryManager.svelte';

// Re-export standalone types
export type { CategoryData, ProductData } from './types';
