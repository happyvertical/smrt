# @happyvertical/smrt-sites

Site lifecycle management for multi-tenant SMRT networks. Manages deployable websites with provisioning status, tier classification, portal configuration, and agent bindings with priority ordering.

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
