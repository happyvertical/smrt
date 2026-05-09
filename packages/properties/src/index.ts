/**
 * @happyvertical/smrt-properties
 *
 * Digital property and zone management for the SMRT framework.
 *
 * This package provides models for managing digital properties (websites, apps)
 * and their hierarchical zones (pages, sections, slots).
 *
 * @example
 * ```typescript
 * import {
 *   Property,
 *   PropertyCollection,
 *   Zone,
 *   ZoneCollection
 * } from '@happyvertical/smrt-properties';
 *
 * // Create collections
 * const properties = await PropertyCollection.create({
 *   db: { type: 'sqlite', url: 'properties.db' }
 * });
 * const zones = await ZoneCollection.create({
 *   db: { type: 'sqlite', url: 'properties.db' }
 * });
 *
 * // Create a property
 * const site = await properties.create({
 *   name: 'Oak Creek News',
 *   domain: 'oakcreeknews.com',
 *   url: 'https://oakcreeknews.com',
 *   status: 'active'
 * });
 * await site.save();
 *
 * // Create hierarchical zones (IDs are guaranteed after save())
 * const homePage = await zones.create({
 *   propertyId: site.id!,
 *   name: 'Home Page',
 *   type: 'page',
 *   path: '/'
 * });
 * await homePage.save();
 *
 * const headerSlot = await zones.create({
 *   propertyId: site.id!,
 *   parentId: homePage.id!,
 *   name: 'Header Leaderboard',
 *   type: 'slot',
 *   width: 728,
 *   height: 90
 * });
 * await headerSlot.save();
 *
 * // Get zone tree
 * const tree = await zones.getTree(site.id!);
 * ```
 *
 * @packageDocumentation
 */

// Self-register this package's manifest before any @smrt() decorator fires
// downstream. Must come first so the side effect runs ahead of the class
// module loads below. See __smrt-register__.ts for issue #1132 context.
import './__smrt-register__.js';
// Register prompts at module-load time so consumers and tenants can
// override them via `resolvePrompt()` without further plumbing.
import './prompts.js';

// Export collections
export { PropertyCollection } from './collections/Properties';
export { ZoneCollection } from './collections/Zones';

// Export models
export { Property } from './models/Property';
export { Zone } from './models/Zone';

// Export prompt registrations so consumers can reference the key for
// tenant-aware overrides via `@happyvertical/smrt-prompts`.
export {
  promptMessageOptions,
  smrtPropertiesSummarizePrompt,
} from './prompts';

// Export types
export type {
  PropertyOptions,
  PropertyStatus,
  ZoneOptions,
  ZoneTree,
  ZoneTreeNode,
} from './types';
