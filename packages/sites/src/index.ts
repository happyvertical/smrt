/**
 * @happyvertical/smrt-sites
 *
 * Site lifecycle management for multi-tenant SMRT networks.
 *
 * Provides models, collections, and services for managing deployable
 * websites within a tenant hierarchy, including agent binding and
 * infrastructure provisioning tracking, plus DNS zone / domain /
 * project-domain records.
 *
 * @packageDocumentation
 */

// Self-register this package's manifest before any @smrt() decorator fires
// downstream. Must come first so the side effect runs ahead of the class
// module loads below. See __smrt-register__.ts for issue #1132 context.
import './__smrt-register__.js';

// Export collections
export { DnsZoneCollection } from './collections/DnsZoneCollection';
export { DomainCollection } from './collections/DomainCollection';
export { ProjectDomainCollection } from './collections/ProjectDomainCollection';
export { SiteAgentBindingCollection } from './collections/SiteAgentBindingCollection';
export { SiteCollection } from './collections/SiteCollection';

// Export models
export { DnsZone } from './models/DnsZone';
export { Domain } from './models/Domain';
export { ProjectDomain } from './models/ProjectDomain';
export { Site } from './models/Site';
export { SiteAgentBinding } from './models/SiteAgentBinding';
export type { DomainServiceOptions } from './services/DomainService';
// Export services
export { DomainService } from './services/DomainService';
export type { SiteServiceOptions } from './services/SiteService';
export { SiteService } from './services/SiteService';

// Export types
export type {
  CreateSiteData,
  DnsZoneOptions,
  DomainOptions,
  DomainRole,
  ProjectDomainOptions,
  ProvisioningStatus,
  SiteAgentBindingOptions,
  SiteOptions,
  SitePortalConfig,
  SiteStatus,
  SiteTier,
} from './types';
