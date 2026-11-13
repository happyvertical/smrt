# @happyvertical/smrt-sites

Site lifecycle management for multi-tenant s-m-r-t networks. Manages deployable websites with provisioning status, tier classification, portal configuration, and agent bindings with priority ordering.

## Installation

```bash
pnpm add @happyvertical/smrt-sites
```

## Usage

```typescript
import {
  Site, SiteCollection,
  SiteAgentBinding, SiteAgentBindingCollection,
  SiteService
} from '@happyvertical/smrt-sites';

// Create collections
const sites = await SiteCollection.create({ db });
const bindings = await SiteAgentBindingCollection.create({ db });

// Use SiteService for lifecycle operations
const service = new SiteService({ sites, bindings });

// Create a site (starts in draft status)
const site = await service.createSite('tenant-123', {
  name: 'Community Hub',
  domain: 'hub.example.com',
  tier: 'standard',
});

// Activate after validation (requires name + domain)
await service.activateSite(site.id);

// Mark infrastructure as provisioned
await service.markProvisioned(site.id);

// Bind agents with priority ordering (higher = first)
await service.bindAgent(site.id, 'Praeco', { schedule: '0 * * * *' });
await service.bindAgent(site.id, 'Caelus', { maxArticles: 50 });

// Get enabled agents sorted by priority descending
const agents = await service.getEnabledAgents(site.id);

// Suspend or archive a site
await service.suspendSite(site.id);
await service.archiveSite(site.id);
```

### Site lifecycle

Sites progress through four statuses: `draft` -> `active` -> `suspended` -> `archived`. The `SiteService` enforces validation on activation (name and domain required) and tracks provisioning state separately via `provisioningStatus` (pending/provisioning/ready/failed). Sites are uniquely identified by `(tenant_id, domain)`.

### Agent bindings

`SiteAgentBinding` is a junction table linking sites to agent classes. Each binding has a `priority` (higher values execute first), an `enabled` flag, and optional per-site `config` overrides stored as JSON. The `bindAgent()` method upserts -- updating config if a binding already exists, creating one if not. `findEnabled()` returns bindings sorted by priority descending.

### Zones, domains, and project links

`DnsZone` is an apex (`example.com`); `Domain` is one hostname under a zone (`work.example.com`, FK `zoneId`); `ProjectDomain` links a domain to a project with a `role` (`production`, `staging`, `preview`, `mail`, `redirect`, `other`). One zone hosts many projects. `projectId` is a `@crossPackageRef` to `@happyvertical/smrt-projects:Project` (no package dependency). The zone model is `DnsZone`, not `Zone`, because `@happyvertical/smrt-properties` already registers a `Zone`.

```typescript
const service = new DomainService({ domains, links });
await links.assign(domain, projectId, 'production'); // idempotent; tenant from the domain
await service.domainsByZone(tenantId, zone.id);
await service.domainsByProject(tenantId, projectId, 'staging'); // role optional
await service.unassignedDomains(tenantId); // domains with no project link
```

`Site.domain` remains a plain string; it is not yet linked to `Domain`.

### Portal configuration

Sites store theme, branding, and navigation settings in `portalConfig` as JSON. Use `getPortalConfig()`/`setPortalConfig()` for type-safe access. Both models require tenant context (`@TenantScoped({ mode: 'required' })`).

## API

### Models

| Export | Description |
|--------|------------|
| `Site` | Site record with domain, status, tier, provisioning tracking, and portal config |
| `SiteAgentBinding` | Junction binding an agent class to a site with priority and config overrides |

### Collections

| Export | Description |
|--------|------------|
| `SiteCollection` | CRUD and queries for Site records |
| `SiteAgentBindingCollection` | Queries by site, agent class, and enabled state with priority sorting |

### Services

| Export | Description |
|--------|------------|
| `SiteService` | High-level lifecycle ops: create, activate, suspend, archive, bind/unbind agents |

### Key Types

`SiteOptions`, `SiteStatus`, `SiteTier`, `ProvisioningStatus`, `SitePortalConfig`, `SiteServiceOptions`, `SiteAgentBindingOptions`, `CreateSiteData`

## Dependencies

- `@happyvertical/smrt-core` -- ORM and code generation
- `@happyvertical/smrt-tenancy` -- required multi-tenant scoping
- Peer: `@happyvertical/smrt-agents` (optional)
