/**
 * SMRT Template Models
 *
 * Domain models that demonstrate SMRT auto-generation capabilities.
 * These classes are decorated with @smrt() and automatically generate:
 * - REST APIs
 * - TypeScript clients
 * - MCP tools for AI
 * - UI components
 */

// Self-register this package's manifest for consumers that import via this
// subpath without the main entry. See src/__smrt-register__.ts (issue #1132).
import '../../__smrt-register__.js';

export type { CategoryOptions } from './Category';
export { Category } from './Category';
export type { MaterialOptions } from './Material';
export { Material } from './Material';
export type { ProductOptions } from './Product';
export { Product } from './Product';
export type { ProductAssetOptions } from './ProductAsset';
export { ProductAsset } from './ProductAsset';
export type { ProductVariantOptions } from './ProductVariant';
export { ProductVariant } from './ProductVariant';
export type { MaterialKind } from './types';
export { ProductType } from './types';
