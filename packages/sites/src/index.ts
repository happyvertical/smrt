/**
 * @happyvertical/smrt-sites
 *
 * Site lifecycle management for multi-tenant SMRT networks.
 *
 * Provides models, collections, and services for managing deployable
 * websites within a tenant hierarchy, including agent binding and
 * infrastructure provisioning tracking.
 *
 * @packageDocumentation
 */

// Self-register this package's manifest before any @smrt() decorator fires
// downstream. Must come first so the side effect runs ahead of the class
// module loads below. See __smrt-register__.ts for issue #1132 context.
import './__smrt-register__';

// Export collections
export { SiteAgentBindingCollection } from './collections/SiteAgentBindingCollection';
export { SiteCollection } from './collections/SiteCollection';

// Export models
export { Site } from './models/Site';
export { SiteAgentBinding } from './models/SiteAgentBinding';
export type { SiteServiceOptions } from './services/SiteService';
// Export services
export { SiteService } from './services/SiteService';

// Export types
export type {
  CreateSiteData,
  ProvisioningStatus,
  SiteAgentBindingOptions,
  SiteOptions,
  SitePortalConfig,
  SiteStatus,
  SiteTier,
} from './types';
